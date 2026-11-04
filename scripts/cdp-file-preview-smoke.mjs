// scripts/cdp-file-preview-smoke.mjs
// 文件预览面板真实 UI 冒烟（2026-11-04 计划 round-001 p11/T4）：
//   mkdtemp 生成全套 fixture（txt/md/html/svg/mmd/png/wav/pdf/docx/xlsx/pptx + oversize/binary/empty）
//   → 冷启动 electron（out/ 产物，--user-data-dir 隔离 profile + --remote-debugging-port=9335）
//   → CDP Runtime.evaluate 经 pinia 注册表拿 preview store（id 'filePreview'）逐格式 openPreview
//   → 断言抽屉 DOM 渲染态（B1/B3/B5/B6/B8/B9/B11/B16/B17/B20/B22/B25 + 各格式组件真实渲染
//     + P2 快速翻页竞态：多页 PDF 连点下一页不误报损坏，round-001 p2
//     + p4 xlsx 宽表列钳制：120 列表注记「仅显示前 100 列」+ 每行恰好渲染 100 列
//     + P3-G（round-001 p11）：Target.setAutoAttach(flatten) 自动附加页面派生的 worker 子会话
//       （pdfjs worker 等），其 Runtime.exceptionThrown / console.error(level=error) 并入与页面
//       会话相同的异常池——X 用例终审因此覆盖「最易出错的 PDF 解析面」，不再只看页面会话）。
//
// 关键事实（源码已核，2026-11-04）：
//   - preview-store id = 'filePreview'（src/renderer/stores/preview-store.ts defineStore 字面）；
//     构建产物（out/renderer）下无 /src/**.ts 源路径可动态 import，故选型 pinia 注册表直取：
//     document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('filePreview')
//     （同 scripts/cdp-web-access-e2e.mjs B3/W-changes-panel 已验证的 _s.get('session') 手法）。
//   - fs:readPreview 允许集 = 全局配置 workingDirectory ∪ 会话库全部 workingDir
//     （src/main/ipc-handlers.ts collectPreviewRoots）。本脚本经 window.claudeLink.saveConfig
//     把 fixture 工作目录注册进隔离 profile 的全局配置（profile 用后即删，不碰真实配置）；
//     B6（非工作区路径拒绝）在注册前先断 handler 层 {ok:false,'路径不在工作区内'} + 抽屉层
//     .fpreview-empty 同文案，另以从未注册的 outside 目录音再断一次 handler 层。
//   - B9 = iframe[sandbox=""]（attribute 恒为空串）；B25 = svg 双模式（preview img blob:/source 源码）；
//     B16 = 抽屉复用换内容（连续 openPreview 不关抽屉，头部文件名跟随切换）；B8 = open 大文件后
//     立即 open 小文件的竞态守卫（终态只落最后一次请求内容）。
//
// 用法：node scripts/cdp-file-preview-smoke.mjs
// 前置：npm run build 已跑（out/main/index.js 含 fs:readPreview 通道，脚本内有新鲜度预检）；
//   dev 实例建议关闭（单实例锁按 userData 已隔离，仅为减少干扰）。
// 退出码：0 = 全 PASS（用例只有 PASS/FAIL 两态、无 SKIP 概念，退出判定只看 FAIL）；1 = 有 FAIL / 渲染层异常；
//   2 = 前置不满足（out/ 缺失或不新鲜）。
// 隔离纪律（仓库 AGENTS.md）：实例带独立 --user-data-dir（mkdtemp，跑后连同 fixture 一并删除），
//   不写用户真实配置；进程清理按 PID 树 taskkill（同 cdp-update-e2e.mjs，不误杀同名实例）。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { PNG } from 'pngjs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';

// ── 常量 ──
const CDP_PORT = 9335;
const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const MAIN_OUT = path.join(REPO_ROOT, 'out', 'main', 'index.js');
const ELECTRON_EXE = path.join(REPO_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const CACHE_ROOT = 'D:/software/Cache'; // 全局指令：临时文件一律 D:\software\Cache
const ISO_PARENT = path.join(CACHE_ROOT, 'claude-link-fpreview-smoke-tmp');
const SHOT_DIR = path.join(REPO_ROOT, 'docs', 'reports', 'file-preview-smoke');
const APP_READY_TIMEOUT_MS = 60_000;
const OPEN_TIMEOUT_MS = 10_000;
const HEAVY_TIMEOUT_MS = 30_000; // pdf/docx/xlsx/pptx：首次动态 import chunk + 解析渲染
const MERMAID_TIMEOUT_MS = 20_000; // mermaid 懒加载（chunk import + 渲染管线）
const TOTAL_TIMEOUT_MS = 600_000; // 总看门狗（对齐 cdp-web-access-e2e 手法，防无声挂死）

const DOCX_WORD = 'CLAUDELINK_E2E_DOCX';
const PPTX_WORD = 'CLAUDELINK_E2E_PPTX';
const PDF_WORD = 'CLAUDELINK_E2E_PDF';
const MD_H2_MARK = 'CLAUDELINK_E2E_MD_H2';
const HTML_H1_MARK = 'CLAUDELINK_E2E_HTML_H1';
const HELLO_MARK = 'CLAUDELINK_E2E_HELLO';

// ── 结果记账（用例只有 PASS/FAIL 两态）──
let pass = 0, fail = 0;
const consoleErrors = [];
const exceptions = [];
// p11（P3-G）：已跟踪的 worker 子会话表（sessionId → targetType）。flatten 模式下子会话
// 与页面会话共用同一条 WebSocket，靠消息顶层 sessionId 区分；只有此表中的会话事件才入池。
const childSessions = new Map();
let currentCase = '(pre)';
const log = (m) => console.log(`[fpreview-smoke] ${m}`);
async function check(name, fn) {
  currentCase = name;
  try { await fn(); pass++; log(`  ✅ ${name}`); return true; }
  catch (e) { fail++; log(`  ❌ ${name} — ${String(e.message).slice(0, 300)}`); return false; }
}

// ── CDP 基础（写法对齐 cdp-update-e2e.mjs / cdp-web-access-e2e.mjs）──
let msgId = 0;
const pending = new Map();
const CDP_CALL_TIMEOUT_MS = 30_000;
// p11（P3-G）：仅采集 worker 型 target（dedicated/service/shared worker——pdfjs 解析 worker
// 属 dedicated）；iframe/page/browser 等类型被 attachedToTarget 过滤掉（见消息处理注释）。
const WORKER_TARGET_TYPES = new Set(['worker', 'service_worker', 'shared_worker']);
let ws = null;
let wsDead = false;
/** CDP 调用。sessionId 仅 flatten 子会话消息需要（顶层字段，见 p11 注）；pending 里记下
 *  sessionId 供 detachedFromTarget 时精确拒绝该会话上的未决调用（不拖到 30s 超时）。 */
function cdpSend(method, params = {}, sessionId = null) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    if (wsDead) { reject(new Error('CDP WebSocket 已断开')); return; }
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP 调用超时（${CDP_CALL_TIMEOUT_MS / 1000}s）：${method}`)); }, CDP_CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, sessionId });
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    ws.send(JSON.stringify(payload));
  });
}
function killAllPending(reason) {
  wsDead = true;
  for (const [, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); }
  pending.clear();
}
async function evalExpr(expr) {
  const r = await cdpSend('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || JSON.stringify(r.exceptionDetails)).slice(0, 300));
  return r.result?.value;
}
async function waitFor(label, expr, timeoutMs, everyMs = 300) {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const v = await evalExpr(expr);
      if (v) return v;
      last = `falsy=${JSON.stringify(v)?.slice(0, 120)}`;
    } catch (e) { last = String(e.message).slice(0, 160); }
    await sleep(everyMs);
  }
  throw new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）：${label}；最后状态 ${last}`);
}
async function screenshot(name) {
  try {
    const r = await cdpSend('Page.captureScreenshot', { format: 'png' });
    mkdirSync(SHOT_DIR, { recursive: true });
    writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
    log(`  失败截图落盘 ${name}.png`);
  } catch { /* 尽力而为 */ }
}

// ── p11 自证动作：向存活的 worker 子会话注入一条未捕获假异常 → 验证它经子会话
//    Runtime.exceptionThrown 进入收集池 → 随后按内容过滤剔除自证条目（复原，不落盘、
//    不计用例）。尽力而为：无存活 worker / 注入未达 / 任何异常都只记日志并如实申报，
//    绝不影响用例结论（调用点须在抽屉仍打开、worker 尚存活时）。 ──
// 假异常标记（round-002 fix-2）：自证注入与复原剔除共用同一字面，保证「只剔除自证
// 自己产生的条目」判据精确唯一——脚本注入的就是本字面（grep 确认无其他变体）。
const FAKE_WORKER_EXCEPTION_MARK = 'CLAUDELINK_E2E_FAKE_WORKER_EXCEPTION';
const isFakeWorkerEntry = (x) => String(x.text).includes(FAKE_WORKER_EXCEPTION_MARK);
async function proveWorkerExceptionChannel() {
  try {
    const entries = [...childSessions.entries()];
    if (entries.length === 0) { log('自证跳过：此刻无存活的 worker 子会话（如实申报）'); return; }
    const [sid, type] = entries[0];
    await cdpSend('Runtime.evaluate', { expression: `setTimeout(() => { throw new Error('${FAKE_WORKER_EXCEPTION_MARK}'); }); 'scheduled'` }, sid);
    await sleep(1000);
    const injected = exceptions.some(isFakeWorkerEntry);
    // 复原：按内容过滤剔除——只从 exceptions / consoleErrors 两池移除 text 含自证标记的
    // 条目（自证前两池必无该标记条目：它是脚本内唯一产生源且每次自证后即剔除），其余
    // 条目全部保留给 X 用例终审。不再用「截回注入前水位」复原：那会把自证 1s 窗口内
    // 偶发进入池中的真实异常 / console.error 一并抹掉，使 X 终审对自证窗口失明
    // （round-002 fix-2，B-P3-1）。
    for (let i = exceptions.length - 1; i >= 0; i--) { if (isFakeWorkerEntry(exceptions[i])) exceptions.splice(i, 1); }
    for (let i = consoleErrors.length - 1; i >= 0; i--) { if (isFakeWorkerEntry(consoleErrors[i])) consoleErrors.splice(i, 1); }
    if (injected) log(`自证成功：worker 子会话（${type}）假异常已捕获入池并按内容剔除复原——子会话收集链路通`);
    else log(`自证失败：假异常未在收集池观测到（worker=${type}，如实申报）`);
  } catch (e) {
    log(`自证失败（尽力而为，不影响用例）：${String(e.message).slice(0, 160)}`);
  }
}

// ── pinia store 表达式（选型依据见文件头注释）──
const STORE_GET = '(document.querySelector("#app").__vue_app__.config.globalProperties.$pinia._s.get("filePreview"))';
function storeExpr(body) { return `(() => { const st = ${STORE_GET}; if (!st) return null; ${body} })()`; }
/** 打开文件（store.openPreview）并等抽屉 .open（B16 复用：不 close 直换）。 */
async function openPreview(filePath) {
  const ok = await evalExpr(storeExpr(`st.openPreview(${JSON.stringify(filePath)}); return true;`));
  if (ok !== true) throw new Error('preview store 不可用（pinia._s 无 filePreview）');
  await waitFor('抽屉打开（.fpreview-drawer.open）', `(() => { const d = document.querySelector('.fpreview-drawer.open'); return !!d; })()`, OPEN_TIMEOUT_MS);
}
async function setMode(mode) {
  const ok = await evalExpr(storeExpr(`st.setMode(${JSON.stringify(mode)}); return st.mode;`));
  if (ok !== mode) throw new Error(`setMode(${mode}) 失败：当前 mode=${ok}`);
}
async function closeDrawer() {
  await evalExpr(storeExpr(`st.close(); return true;`));
  await waitFor('抽屉关闭（.fpreview-drawer.open 移除）', `!document.querySelector('.fpreview-drawer.open')`, 5000);
}
/** 重组件失败诊断：抽屉内四重组件的空态文案（「文件损坏或格式异常」等）随手超时一并抛出。 */
async function heavyStateText() {
  try {
    return await evalExpr(`(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const pick = (sel) => d && d.querySelector(sel) ? d.querySelector(sel).textContent : null;
      return JSON.stringify({
        empty: pick('.fpreview-empty__text'),
        pdf: pick('.pdf-preview__state-text'),
        docx: pick('.docx-preview__state-text'),
        xlsx: pick('.xlsx-preview__state-text'),
        pptx: pick('.pptx-preview__state-text'),
      });
    })()`);
  } catch { return '(诊断取态失败)'; }
}
async function waitForHeavy(label, expr) {
  try {
    return await waitFor(label, expr, HEAVY_TIMEOUT_MS, 500);
  } catch (e) {
    const state = await heavyStateText();
    throw new Error(`${e.message}；重组件态=${state}`);
  }
}

// ── fixture 生成 ──
function buildMinimalPdf(text, pages = 1) {
  // 经典最小 PDF（1..N 页）：逐对象拼接并计算 xref 偏移（pdfjs 对 xref 宽容，但给准值零成本）。
  // D-F3：stream 体先拼装再程序化计 /Length（原 text.length + 24 硬编码偏移在文本含转义/换行时短计）。
  // 多页（p2 快速翻页竞态用例）：每页独立内容流，文本 `${text} P<k>`，页与页字形宽度不同
  // ——位图暗像素计数可区分页面真实切换渲染。
  const pageBodies = Array.from({ length: pages }, (_, i) => {
    const t = pages === 1 ? text : `${text} P${i + 1}`;
    return `BT /F1 24 Tf 72 720 Td (${t}) Tj ET\n`;
  });
  const fontNum = 3 + pages * 2; // 1=Catalog 2=Pages，之后每页 Page+Contents 各一号，Font 收尾
  const kids = pageBodies.map((_, i) => 3 + i * 2);
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    `2 0 obj\n<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${pages} >>\nendobj\n`,
  ];
  pageBodies.forEach((body, i) => {
    const pageObjNum = 3 + i * 2;
    objs.push(`${pageObjNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${pageObjNum + 1} 0 R >>\nendobj\n`);
    objs.push(`${pageObjNum + 1} 0 obj\n<< /Length ${body.length} >>\nstream\n${body}endstream\nendobj\n`);
  });
  objs.push(`${fontNum} 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`);
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (const o of objs) { offsets.push(out.length); out += o; }
  const xrefStart = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function buildMinimalWav() {
  // 44 字节 RIFF 头 + 0.1s 8bit/8kHz 静音 PCM（0x80 = 无声电平）。
  const sampleRate = 8000, seconds = 0.1;
  const dataLen = Math.round(sampleRate * seconds);
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + dataLen, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate, 28); buf.writeUInt16LE(1, 32); buf.writeUInt16LE(8, 34);
  buf.write('data', 36); buf.writeUInt32LE(dataLen, 40);
  buf.fill(0x80, 44);
  return buf;
}
async function buildMinimalDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"/>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${text}</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function buildMinimalPptx(text) {
  // 最小 OOXML presentation 包（成员集实核 @aiden0z/pptx-renderer 解析面：
  // presentation.xml sldIdLst → slides/slideN + rels + slideLayouts + slideMasters + theme）。
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>`);
  zip.file('ppt/presentation.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst><p:sldId id="256" r:id="rId2"/></p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="theme/theme1.xml"/></Relationships>`);
  zip.file('ppt/slides/slide1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="838200" y="365125"/><a:ext cx="7466000" cy="1325563"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3200"/><a:t>${text}</a:t></a:r><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`);
  zip.file('ppt/slides/_rels/slide1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/></Relationships>`);
  zip.file('ppt/slideLayouts/slideLayout1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`);
  zip.file('ppt/slideLayouts/_rels/slideLayout1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>`);
  zip.file('ppt/slideMasters/slideMaster1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap><a:masterClrMapping/></p:clrMap><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst></p:sldMaster>`);
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>`);
  // 紧凑但结构完整的 theme（clrScheme/fontScheme/fmtScheme 四表齐全，避免下游 fillRef/lnRef 解析踩空）。
  zip.file('ppt/theme/theme1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="E2E"><a:themeElements><a:clrScheme name="E2E"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F3F4F6"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="10B981"/></a:accent2><a:accent3><a:srgbClr val="F59E0B"/></a:accent3><a:accent4><a:srgbClr val="EF4444"/></a:accent4><a:accent5><a:srgbClr val="8B5CF6"/></a:accent5><a:accent6><a:srgbClr val="06B6D4"/></a:accent6><a:hlink><a:srgbClr val="2563EB"/></a:hlink><a:folHlink><a:srgbClr val="7C3AED"/></a:folHlink></a:clrScheme><a:fontScheme name="E2E"><a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="E2E"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="50000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="28575"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst><a:outerShdw blurRad="40000" dist="20000" dir="5400000" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="38000"/></a:srgbClr></a:outerShdw></a:effectLst></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="95000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="95000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
function buildXlsxBuffer() {
  // 表1 Big（600 行 > 500 → B20 注记）、表2 Small（3 行）；首表默认选中，注记必然在屏。
  const big = [['key', 'value']];
  for (let i = 1; i <= 599; i++) big.push([`row-${i}`, i]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(big), 'Big');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a', 'b'], ['x', 'y'], ['p', 'q']]), 'Small');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
function buildWideXlsxBuffer() {
  // 宽表（round-001 p4 列钳制 MAX_COLS=100）：120 列 × 10 行——>100 列触发列钳制注记，
  // 行数远低于行上限（不触发 B20 行注记，两条注记互不干扰）；单元格文本 r{行}c{列}
  // 可精确断言钳制边界（r1c0 在前 100 列内必现，r1c119 越界必被钳掉），少量行控制生成与解析成本。
  const header = Array.from({ length: 120 }, (_, c) => `col-${c}`);
  const rows = [header];
  for (let r = 1; r <= 9; r++) rows.push(Array.from({ length: 120 }, (_, c) => `r${r}c${c}`));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Wide');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function writeFixtures(wsDir, outsideDir) {
  const f = (name) => path.join(wsDir, name);
  const outsideFile = path.join(outsideDir, 'secret-outside.txt');
  writeFileSync(f('hello.txt'), `${HELLO_MARK}\n第一行\n第二行\n`, 'utf8');
  writeFileSync(f('report.md'), `# 一级标题\n\n正文段落。\n\n## ${MD_H2_MARK}\n\n- 列表项 A\n- 列表项 B\n`, 'utf8');
  // B9 探针说明：opaque origin（sandbox=""）下父页面不可读 contentDocument，脚本不执行由
  // sandbox 属性与浏览器强制语义保证，dataset.scriptRan 仅留作人工 DevTools 检查
  // （自动化运行时断言走父页面侧 iframe load 事件，见主流程 html 用例）。
  writeFileSync(f('page.html'), `<!doctype html>\n<html><head><meta charset="utf-8"><title>e2e</title></head>\n<body><h1>${HTML_H1_MARK}</h1>\n<script>document.documentElement.dataset.scriptRan='1'</script>\n</body></html>\n`, 'utf8');
  writeFileSync(f('icon.svg'), `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64"><path d="M8 56 L32 8 L56 56 Z" fill="#e74c3c"/></svg>\n`, 'utf8');
  writeFileSync(f('flow.mmd'), 'graph TD\n  A[开始] --> B[结束]\n', 'utf8');
  const png = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < png.data.length; i += 4) { png.data[i] = 255; png.data[i + 1] = 96; png.data[i + 2] = 0; png.data[i + 3] = 255; }
  writeFileSync(f('pic.png'), PNG.sync.write(png));
  writeFileSync(f('tone.wav'), buildMinimalWav());
  writeFileSync(f('sample.pdf'), buildMinimalPdf(PDF_WORD));
  // p2 快速翻页竞态用例夹具：5 页（页 1 连点下一页 4 次到页 5，翻页控件全程可点）。
  writeFileSync(f('sample-multipage.pdf'), buildMinimalPdf(PDF_WORD, 5));
  writeFileSync(f('sample.docx'), await buildMinimalDocx(DOCX_WORD));
  writeFileSync(f('sample.pptx'), await buildMinimalPptx(PPTX_WORD));
  writeFileSync(f('sample.xlsx'), buildXlsxBuffer());
  writeFileSync(f('sample-wide.xlsx'), buildWideXlsxBuffer());
  writeFileSync(f('binary.txt'), Buffer.concat([Buffer.from('A'.repeat(32), 'utf8'), Buffer.alloc(32, 0x00)]));
  writeFileSync(f('empty.txt'), '', 'utf8');
  // T4 抽验集补充（round-001 D-F1）：B22 伪扩展损坏件（主进程分类按扩展名直进重组件，
  // 组件内部 catch 落「文件损坏或格式异常」）与 B11 大文本（70KB：> 64KB 高亮阈值、
  // < 256KB 截断阈值，双边界夹逼——只断无高亮 + 内容渲染，不断截断 banner）。
  writeFileSync(f('corrupt.docx'), Buffer.from('not-a-zip-contents'), 'utf8');
  writeFileSync(f('broken.pdf'), 'this is not a pdf', 'utf8');
  writeFileSync(f('big.txt'), 'x'.repeat(70 * 1024), 'utf8');
  writeFileSync(outsideFile, 'outside-secret', 'utf8');
  return {
    outsideFile,
    hello: f('hello.txt'),
    md: f('report.md'),
    html: f('page.html'),
    svg: f('icon.svg'),
    mmd: f('flow.mmd'),
    png: f('pic.png'),
    wav: f('tone.wav'),
    pdf: f('sample.pdf'),
    pdfMulti: f('sample-multipage.pdf'),
    docx: f('sample.docx'),
    pptx: f('sample.pptx'),
    xlsx: f('sample.xlsx'),
    xlsxWide: f('sample-wide.xlsx'),
    corruptDocx: f('corrupt.docx'),
    brokenPdf: f('broken.pdf'),
    bigTxt: f('big.txt'),
    binary: f('binary.txt'),
    empty: f('empty.txt'),
    missing: f('no-such-file.txt'),
    oversizePdf: f('oversize.pdf'),
  };
}

// ── 进程与清理 ──
let appProc = null;
let isoDir = null;
/** Windows 句柄释放延迟兜底：taskkill 同步返回后文件句柄仍可能短暂存活，rmSync 间歇 EBUSY——
 *  有限次重试删透；最终失败显式 log 残留路径（不静默，便于人工清理）。 */
async function rmWithRetry(p, tries = 6, gapMs = 500) {
  for (let i = 0; i < tries; i++) {
    try { rmSync(p, { recursive: true, force: true }); return true; } catch { await sleep(gapMs); }
  }
  return false;
}
async function cleanup() {
  try { ws?.close(); } catch { /* 尽力而为 */ }
  if (appProc && appProc.exitCode === null) {
    try { spawnSync('taskkill', ['/PID', String(appProc.pid), '/T', '/F'], { encoding: 'utf8' }); } catch { /* 尽力而为 */ }
  }
  if (isoDir) {
    const removed = await rmWithRetry(isoDir);
    if (!removed) log(`警告：隔离目录未能删除（残留：${isoDir}），请人工清理`);
  }
  // 本脚本用固定 CDP 端口（9335），并发运行在设计上不可能，删空壳父目录无竞态。
  await rmWithRetry(ISO_PARENT, 2, 300);
}

class PreconditionError extends Error {}
const totalTimer = setTimeout(() => {
  log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，清理后自杀退出（防挂死）`);
  void cleanup().then(() => process.exit(1));
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

// ── 主流程 ──
async function main() {
  // 前置①：out/ 产物存在且含本次主进程新通道（新鲜度钉：fs:readPreview 字面必须已编进产物）。
  if (!existsSync(ELECTRON_EXE) || !existsSync(MAIN_OUT)) {
    throw new PreconditionError(`缺 ${path.relative(REPO_ROOT, ELECTRON_EXE)} 或 ${path.relative(REPO_ROOT, MAIN_OUT)}（先 npm install / npm run build）`);
  }
  const mainSrc = readFileSync(MAIN_OUT, 'utf8');
  if (!mainSrc.includes('fs:readPreview')) {
    throw new PreconditionError('out/main/index.js 不含 fs:readPreview 通道（产物陈旧，先 npm run build）');
  }
  // 前置②：隔离目录（mkdtemp，含 profile / ws / outside 三个子目录，跑后整体删除）。
  mkdirSync(ISO_PARENT, { recursive: true }); // recursive 自带 CACHE_ROOT 层级
  isoDir = mkdtempSync(path.join(ISO_PARENT, 'run-'));
  const profileDir = path.join(isoDir, 'profile');
  const wsDir = path.join(isoDir, 'ws');
  const outsideDir = path.join(isoDir, 'outside');
  mkdirSync(profileDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const F = await writeFixtures(wsDir, outsideDir);
  log(`fixture 就绪：${wsDir}（隔离 profile=${profileDir}）`);

  // 启动：spawn electron（out/ 产物，生产式冷启动，主进程改动完整生效）。
  appProc = spawn(ELECTRON_EXE, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`], {
    cwd: REPO_ROOT,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    stdio: 'ignore',
    detached: true,
  });
  appProc.unref();
  const target = await (async () => {
    const deadline = Date.now() + APP_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const ts = await resp.json();
        // 主窗口 = file:// 加载的 out/renderer/index.html 页（排除 devtools:// 等）。
        const hit = ts.find((t) => t.type === 'page' && /index\.html/i.test(t.url || '')) ?? ts.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
        if (hit) return hit;
      } catch { /* 未就绪继续轮询 */ }
      if (appProc.exitCode !== null) throw new Error(`应用进程提前退出（code=${appProc.exitCode}）`);
      await sleep(500);
    }
    throw new Error(`CDP ${CDP_PORT} ${APP_READY_TIMEOUT_MS / 1000}s 内未就绪`);
  })();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS 连接失败')); });
  });
  ws.addEventListener('close', () => killAllPending('CDP WebSocket 已关闭'));
  ws.addEventListener('message', (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error('CDP: ' + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    // ── p11（P3-G）worker 子会话生命周期（Target.setAutoAttach flatten 模式）──
    // 过滤：只收 worker 型子会话（dedicated/service/shared，pdfjs 解析 worker 属 dedicated）。
    // iframe（OOPIF）/page/browser 等类型要么与本次「渲染层异常面」无关、要么属浏览器级
    // target，接进异常池只会引入噪音，故不 enable、不入表、其事件也不采集。
    if (msg.method === 'Target.attachedToTarget') {
      const sid = msg.params.sessionId;
      const type = msg.params.targetInfo?.type || '(unknown)';
      if (WORKER_TARGET_TYPES.has(type)) {
        childSessions.set(sid, type);
        // 子会话开 Runtime（必须：不开收不到 exceptionThrown）。失败仅记录不抛——
        // worker 竞态销毁属正常路径（detachedFromTarget 会先拒掉本调用）。
        cdpSend('Runtime.enable', {}, sid).catch((e) => {
          if (childSessions.has(sid)) log(`警告：worker 子会话（${type}）Runtime.enable 失败：${String(e.message).slice(0, 120)}`);
        });
      }
      return;
    }
    if (msg.method === 'Target.detachedFromTarget') {
      const sid = msg.params.sessionId;
      childSessions.delete(sid); // 妥善清理：迟到的子会话事件因不在表内被忽略（不误报）
      // 该子会话上的未决调用立即以明确原因拒绝（典型：Runtime.enable 未返回 worker 已销毁）。
      for (const [id, p] of pending) {
        if (p.sessionId === sid) { clearTimeout(p.timer); pending.delete(id); p.reject(new Error('worker 子会话已销毁（detachedFromTarget）')); }
      }
      return;
    }
    // ── 渲染层异常收集：页面会话（无顶层 sessionId）与已跟踪 worker 子会话入同一池；
    //    已分离子会话的迟到事件（sessionId 不在表内）忽略，防止会话关闭竞态误报。 ──
    if (msg.method === 'Runtime.exceptionThrown') {
      if (msg.sessionId && !childSessions.has(msg.sessionId)) return;
      const tag = msg.sessionId ? `[worker:${childSessions.get(msg.sessionId)}] ` : '';
      exceptions.push({ case: currentCase, text: tag + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '(no desc)') });
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      if (msg.sessionId && !childSessions.has(msg.sessionId)) return;
      const tag = msg.sessionId ? `[worker:${childSessions.get(msg.sessionId)}] ` : '';
      consoleErrors.push({ case: currentCase, text: tag + (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
    }
  });
  await cdpSend('Runtime.enable');
  await cdpSend('Page.enable');
  // p11（P3-G）：在页面会话上开 autoAttach——页面派生的 worker（pdfjs 解析 worker 等）
  // 一创建即自动附加（flatten：子会话消息复用本条 WS，靠顶层 sessionId 路由）；
  // waitForDebuggerOnStart=false 保证 worker 照常启动、不因附加被挂起。
  await cdpSend('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true });
  // 等渲染层就绪：#app 有内容 + 桥 + preview store 注册在 pinia。
  await waitFor('应用渲染就绪（#app + claudeLink 桥 + filePreview store）', `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    return !!(app && app.childElementCount > 0 && window.claudeLink && pinia && pinia._s && pinia._s.get('filePreview'));
  })()`, APP_READY_TIMEOUT_MS);
  log('应用就绪，CDP 已连接（选型：pinia 注册表直取 filePreview store）');

  // ── P0 store 可用性 ──
  await check('P0 pinia filePreview store 就绪 + openPreview/close/setMode 动作在位', async () => {
    const shape = await evalExpr(storeExpr(`return { open: st.open, path: st.path, hasOpen: typeof st.openPreview === 'function', hasClose: typeof st.close === 'function', hasSetMode: typeof st.setMode === 'function' };`));
    if (!shape || shape.hasOpen !== true || shape.hasClose !== true || shape.hasSetMode !== true) throw new Error(`store 形状不符：${JSON.stringify(shape)}`);
    if (shape.open !== false) throw new Error(`初始 open=${shape.open}（期望 false）`);
  });

  // ── B6（先断拒绝，再注册根）handler 层：fixture 未注册前读其文件必被拒 ──
  await check('B6a handler 层：fixture 未注册为工作区时 readFilePreview 拒绝（路径不在工作区内）', async () => {
    const r = await evalExpr(`window.claudeLink.readFilePreview(${JSON.stringify(F.hello)}).then((x) => JSON.stringify({ ok: x.ok, message: x.message ?? null }))`);
    const v = JSON.parse(String(r));
    if (v.ok !== false || !String(v.message).includes('路径不在工作区内')) throw new Error(`未拒绝：${JSON.stringify(v)}`);
  });
  // ── B6b 抽屉层：open 非工作区文件 → .fpreview-empty「路径不在工作区内」 ──
  await check('B6b 抽屉层：open 非工作区文件 → .fpreview-empty 显示「路径不在工作区内」', async () => {
    await openPreview(F.hello);
    await waitFor('.fpreview-empty 出现「路径不在工作区内」', `(() => {
      const e = document.querySelector('.fpreview-empty');
      return !!e && (e.textContent || '').includes('路径不在工作区内');
    })()`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });
  // ── B6c handler 层（注册根之后）：从未注册的 outside 目录读文件仍拒绝 ──
  await check('B6c handler 层：注册根后 outside 目录文件仍拒绝（fail-closed 边界）', async () => {
    const saved = await evalExpr(`window.claudeLink.saveConfig({ workingDirectory: ${JSON.stringify(wsDir)} }).then((c) => JSON.stringify({ wd: c && c.workingDirectory }))`);
    const wd = JSON.parse(String(saved)).wd;
    if (wd !== wsDir) throw new Error(`saveConfig 未落 workingDirectory：${wd}`);
    const r = await evalExpr(`window.claudeLink.readFilePreview(${JSON.stringify(F.outsideFile)}).then((x) => JSON.stringify({ ok: x.ok, message: x.message ?? null }))`);
    const v = JSON.parse(String(r));
    if (v.ok !== false || !String(v.message).includes('路径不在工作区内')) throw new Error(`outside 未拒绝：${JSON.stringify(v)}`);
  });

  // ── B1 不存在路径（missing 分支）──
  await check('B1 不存在路径 → .fpreview-empty「文件不存在」', async () => {
    await openPreview(F.missing);
    await waitFor('.fpreview-empty 出现「文件不存在」', `(() => {
      const e = document.querySelector('.fpreview-empty');
      return !!e && (e.textContent || '').includes('文件不存在');
    })()`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── hello.txt 源码视图 + 行号列 ──
  await check('txt：hello.txt → .fpreview-code + 行号列（≥1 行，含测试词）', async () => {
    await openPreview(F.hello);
    await waitFor('.fpreview-code 渲染', `!!document.querySelector('.fpreview-drawer.open .fpreview-code')`, OPEN_TIMEOUT_MS);
    const probe = await evalExpr(`(() => {
      const d = document.querySelector('.fpreview-drawer');
      const gutter = d.querySelector('.fpreview-gutter');
      const src = d.querySelector('.fpreview-src');
      return JSON.stringify({ gutterLines: gutter ? gutter.textContent.split('\\n').filter((s) => s.trim()).length : 0, srcText: src ? src.textContent : '' });
    })()`);
    const v = JSON.parse(String(probe));
    if (!(v.gutterLines >= 1)) throw new Error(`行号列行数 ${v.gutterLines} < 1`);
    if (!v.srcText.includes(HELLO_MARK)) throw new Error(`源码内容缺测试词 ${HELLO_MARK}：${v.srcText.slice(0, 80)}`);
  });

  // ── md：默认 preview → .markdown-body h2；B16 复用换内容（头部文件名跟随）；切 source → 源码 ──
  await check('md：report.md 默认 preview → .markdown-body h2（B16 复用抽屉：头部文件名已换）', async () => {
    // 不 close，直接从 hello.txt 换 open report.md（复用同一抽屉 = B16）。
    await openPreview(F.md);
    await waitFor('.markdown-body h2 出现', `(() => {
      const b = document.querySelector('.fpreview-drawer.open .markdown-body');
      const h2 = b && b.querySelector('h2');
      return !!h2 && (h2.textContent || '').includes(${JSON.stringify(MD_H2_MARK)});
    })()`, OPEN_TIMEOUT_MS);
    const name = await evalExpr(`document.querySelector('.fpreview-drawer.open .fpreview-name__text')?.textContent?.trim()`);
    if (name !== 'report.md') throw new Error(`B16 头部文件名未跟随换内容：${name}`);
  });
  await check('md：setMode(source) → .fpreview-code（markdown 源码态）', async () => {
    await setMode('source');
    await waitFor('md 源码视图出现', `!!document.querySelector('.fpreview-drawer.open .fpreview-code') && !document.querySelector('.fpreview-drawer.open .markdown-body')`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── html：默认 web → iframe[sandbox=""]（B9：属性值为空串 + load 事件运行时触发）；切 code → 源码 ──
  await check('html：page.html 默认 web → iframe[sandbox=""]（B9：属性值空串 + load 事件触发）', async () => {
    await openPreview(F.html);
    const probe = await waitFor('sandbox iframe 出现', `(() => {
      const fr = document.querySelector('.fpreview-drawer.open iframe.fpreview-frame');
      if (!fr) return null;
      return JSON.stringify({ sandbox: fr.getAttribute('sandbox'), src: (fr.getAttribute('src') || '').slice(0, 12) });
    })()`, OPEN_TIMEOUT_MS);
    const v = JSON.parse(String(probe));
    if (v.sandbox !== '') throw new Error(`sandbox 属性值非空串：${JSON.stringify(v.sandbox)}（B9）`);
    if (!v.src.startsWith('blob:')) throw new Error(`iframe src 非 blob:：${v.src}`);
    // B9 运行时断言（D-F6）：sandbox="" 为 opaque origin，父页面读不到 contentDocument，
    // load 事件是父页面侧唯一合法观测面。首载可能在挂监听前已完成，故用经典 iframe.src
    // 重赋法重放一次可观测的 load（armed 前的既有 load 不误计）。
    const loadProbe = await evalExpr(`(() => new Promise((resolve) => {
      const fr = document.querySelector('.fpreview-drawer.open iframe.fpreview-frame');
      if (!fr) { resolve(JSON.stringify({ fired: false, why: 'no-frame', sandbox: null })); return; }
      let armed = false;
      const finish = (why) => resolve(JSON.stringify({ fired: armed, why, sandbox: fr.getAttribute('sandbox') }));
      fr.addEventListener('load', () => { if (armed) finish('load-event'); });
      setTimeout(() => { armed = true; fr.src = fr.src; }, 30);
      setTimeout(() => finish('timeout'), 5000);
    }))()`);
    const lv = JSON.parse(String(loadProbe));
    if (lv.sandbox !== '') throw new Error(`load 时 sandbox 属性非空串：${JSON.stringify(lv.sandbox)}（B9）`);
    if (lv.fired !== true) throw new Error(`iframe load 事件未触发：${lv.why}（B9 运行时断言）`);
  });
  await check('html：setMode(code) → 源码视图（html H1 测试词在源码中）', async () => {
    await setMode('code');
    await waitFor('html 源码视图出现', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      return !!d.querySelector('.fpreview-code') && (d.querySelector('.fpreview-src')?.textContent || '').includes(${JSON.stringify(HTML_H1_MARK)});
    })()`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── svg：默认 preview → img blob:（B25 双模式）；切 source → 源码 ──
  await check('svg：icon.svg 默认 preview → img src 以 blob: 开头（B25 双模式·preview 态）', async () => {
    await openPreview(F.svg);
    await waitFor('svg img 出现且 src 为 blob:', `(() => {
      const img = document.querySelector('.fpreview-drawer.open img.fpreview-image');
      return !!img && (img.getAttribute('src') || '').startsWith('blob:');
    })()`, OPEN_TIMEOUT_MS);
  });
  await check('svg：setMode(source) → 源码视图含 <path>（B25 双模式·source 态）', async () => {
    await setMode('source');
    await waitFor('svg 源码视图出现', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      return !!d.querySelector('.fpreview-code') && (d.querySelector('.fpreview-src')?.textContent || '').includes('<path');
    })()`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── mmd：默认 graph → mermaid 真渲染出 svg ──
  await check('mmd：flow.mmd 默认 graph → .mermaid-block 内真实渲染出 svg', async () => {
    await openPreview(F.mmd);
    await waitFor('mermaid svg 渲染', `(() => {
      const blk = document.querySelector('.fpreview-drawer.open .mermaid-block');
      return !!blk && !!blk.querySelector('svg');
    })()`, MERMAID_TIMEOUT_MS, 500);
    await closeDrawer();
  });

  // ── blob 类：png / wav ──
  await check('png：pic.png → img.fpreview-image（blob: src）', async () => {
    await openPreview(F.png);
    await waitFor('png img 出现', `(() => {
      const img = document.querySelector('.fpreview-drawer.open img.fpreview-image');
      return !!img && (img.getAttribute('src') || '').startsWith('blob:');
    })()`, HEAVY_TIMEOUT_MS);
    await closeDrawer();
  });
  await check('wav：tone.wav → audio[controls]（blob: src）', async () => {
    await openPreview(F.wav);
    await waitFor('audio[controls] 出现', `(() => {
      const a = document.querySelector('.fpreview-drawer.open audio.fpreview-media-audio');
      return !!a && a.hasAttribute('controls') && (a.getAttribute('src') || '').startsWith('blob:');
    })()`, HEAVY_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── pdf：canvas + 分页按钮 ──
  // R1 已落 legacy 构建，本用例当前绿（2026-11-04 round-002 复审两跑实证）。
  await check('pdf：sample.pdf → canvas 渲染 + 上一页/下一页按钮 + 共 1 页', async () => {
    await openPreview(F.pdf);
    await waitForHeavy('pdf canvas 就绪（第 1 页 / 共 1 页，canvas 有尺寸）', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const canvas = d && d.querySelector('.pdf-preview canvas');
      const pageno = d && d.querySelector('.pdf-preview__pageno');
      return !!canvas && canvas.width > 0 && !!pageno && (pageno.textContent || '').includes('共 1 页');
    })()`);
    const btns = await evalExpr(`JSON.stringify([...document.querySelectorAll('.fpreview-drawer.open .pdf-preview__bar button')].map((b) => (b.textContent || '').trim()))`);
    const arr = JSON.parse(String(btns));
    if (!arr.includes('上一页') || !arr.includes('下一页')) throw new Error(`分页按钮缺失：${btns}`);
    // p11 注：closeDrawer 移至下方 worker 链路自证之后（抽屉打开期间 pdfjs worker 存活，
    // 正是自证窗口）；断言集与本用例语义不变。
  });
  await proveWorkerExceptionChannel(); // p11 自证：注入假异常→验证入池→复原（尽力而为，不计用例）
  await closeDrawer().catch(() => { /* pdf 抽屉收尾关闭失败不影响结论 */ });

  // ── P2 快速翻页竞态（round-001 p2）：连点下一页 → 旧渲染链作废，好文件不误报损坏 ──
  // 竞态复现原理：背靠背 click 的多条 jumpTo 链在 await doc.getPage 窗口内必然交错
  // （worker 往返 ≥ 数 ms，click 间隔 < 1ms）；旧实现两链都过 loadToken 检查 → 同一 canvas
  // 双 render() 并发 → pdfjs #canvasInUse 守卫抛普通 Error → 被误判「文件损坏或格式异常」。
  await check('P2 快速翻页竞态：multipage.pdf 连点下一页×4 → 无「文件损坏或格式异常」+ canvas 正常渲染态', async () => {
    await openPreview(F.pdfMulti);
    await waitForHeavy('多页 pdf canvas 就绪（第 1 页 / 共 5 页）', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const canvas = d && d.querySelector('.pdf-preview canvas');
      const pageno = d && d.querySelector('.pdf-preview__pageno');
      return !!canvas && canvas.width > 0 && !!pageno && (pageno.textContent || '').includes('共 5 页') && (pageno.textContent || '').includes('第 1 页');
    })()`);
    // 连点 4 次（1→5），点与点之间不等渲染完成：同一 eval 内同步 click 背靠背。
    const clicked = await evalExpr(`(() => {
      const btn = [...document.querySelectorAll('.fpreview-drawer.open .pdf-preview__bar button')].find((b) => (b.textContent || '').trim() === '下一页');
      if (!btn) return 0;
      let n = 0;
      for (let i = 0; i < 4; i++) { if (!btn.disabled) { btn.click(); n++; } }
      return n;
    })()`);
    if (clicked < 3) throw new Error(`下一页有效连点次数 ${clicked} < 3（翻页控件不可点？）`);
    // 稳定窗口：页码为同步更新（第 5 页立即出现）而渲染完成晚于它，先等页码终态 + 无错误卡，
    // 再给 1200ms 稳定期（竞态错误卡在 getPage 往返后数 ms 内即现，1200ms 足以暴露），随后终审。
    await waitFor('翻页终态（第 5 页 + 无错误卡）', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const pageno = d && d.querySelector('.pdf-preview__pageno');
      const err = d && d.querySelector('.pdf-preview__state-text');
      const canvas = d && d.querySelector('.pdf-preview canvas');
      return !!pageno && (pageno.textContent || '').includes('第 5 页') && !err && !!canvas && canvas.width > 0;
    })()`, HEAVY_TIMEOUT_MS);
    await sleep(1200);
    const probe = await evalExpr(`(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const pageno = d && d.querySelector('.pdf-preview__pageno');
      const err = d && d.querySelector('.pdf-preview__state-text');
      const canvas = d && d.querySelector('.pdf-preview canvas');
      if (!canvas || !(canvas.width > 0)) return JSON.stringify({ ok: false, why: 'no-canvas' });
      const ctx = canvas.getContext('2d');
      if (!ctx) return JSON.stringify({ ok: false, why: 'no-2d-ctx' });
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let dark = 0;
      for (let i = 0; i < img.length; i += 20) { if (img[i] < 100) dark++; } // r<100，每 5 像素采样
      return JSON.stringify({ ok: true, pageno: pageno ? pageno.textContent : null, hasErr: !!err, w: canvas.width, h: canvas.height, dark });
    })()`);
    const v = JSON.parse(String(probe));
    if (!v.ok) throw new Error(`canvas 态异常：${v.why}`);
    if (v.hasErr) throw new Error(`出现错误卡（快速翻页被误判「文件损坏或格式异常」）：${v.pageno}`);
    if (!(v.pageno || '').includes('第 5 页')) throw new Error(`终态页码漂移：${JSON.stringify(v.pageno)}`);
    if (v.dark < 20) throw new Error(`canvas 位图近空白（暗像素采样 ${v.dark} < 20）：非正常渲染态`);
    await closeDrawer();
  });

  // ── B22-b 损坏 pdf：伪扩展纯文本 → pdfjs 解析异常 →「文件损坏或格式异常」 ──
  await check('B22-b broken.pdf（伪扩展纯文本）→ .pdf-preview__state-text「文件损坏或格式异常」', async () => {
    await openPreview(F.brokenPdf);
    await waitForHeavy('pdf 损坏态文案出现', `(() => {
      const t = document.querySelector('.fpreview-drawer.open .pdf-preview__state-text');
      return !!t && (t.textContent || '').includes('文件损坏或格式异常');
    })()`);
    await closeDrawer();
  });
  // 注（B23）：加密分支经代码审读核验（PdfPreview load() catch 按 PasswordException 分流
  // 「加密文件不支持预览」，src/renderer/components/preview/PdfPreview.vue），真实加密文件
  // 冒烟因本机无加密 PDF 构造工具留计划后续池（编排器裁定 D 案(b)）。

  // ── docx：.docx-preview__body 内出现测试词 ──
  await check('docx：sample.docx → .docx-preview__body 渲染出测试词', async () => {
    await openPreview(F.docx);
    await waitForHeavy('docx 文本渲染', `(() => {
      const body = document.querySelector('.fpreview-drawer.open .docx-preview__body');
      return !!body && body.childElementCount > 0 && (body.textContent || '').includes(${JSON.stringify(DOCX_WORD)});
    })()`);
    await closeDrawer();
  });

  // ── B22-a 损坏 docx：伪扩展垃圾字节 → DocxPreview 内部 catch（JSZip 解析失败）落「文件损坏或格式异常」 ──
  await check('B22-a corrupt.docx（伪扩展垃圾字节）→ .docx-preview__state-text「文件损坏或格式异常」', async () => {
    await openPreview(F.corruptDocx);
    await waitForHeavy('docx 损坏态文案出现', `(() => {
      const t = document.querySelector('.fpreview-drawer.open .docx-preview__state-text');
      return !!t && (t.textContent || '').includes('文件损坏或格式异常');
    })()`);
    await closeDrawer();
  });

  // ── xlsx：table + B20 注记（首表 600 行 > 500）──
  await check('xlsx：sample.xlsx → table 渲染 + B20 注记「仅显示前 500 行（共 600 行）」', async () => {
    await openPreview(F.xlsx);
    await waitForHeavy('xlsx table + 注记出现', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const table = d && d.querySelector('.xlsx-preview__table');
      const note = d && d.querySelector('.xlsx-preview__note');
      const tabs = d ? d.querySelectorAll('.xlsx-preview__tab').length : 0;
      return !!table && !!note && (note.textContent || '').includes('仅显示前 500 行') && (note.textContent || '').includes('共 600 行') && tabs >= 2;
    })()`);
    const rowCount = await evalExpr(`document.querySelectorAll('.fpreview-drawer.open .xlsx-preview__table tr').length`);
    if (rowCount !== 500) throw new Error(`渲染行数 ${rowCount} ≠ 500（B20 上限）`);
    await closeDrawer();
  });

  // ── p4 列维度钳制（MAX_COLS=100）：宽表 120 列 → 注记「仅显示前 100 列」+ 渲染不卡死 ──
  // 断言钳制边界：每行恰好渲染 100 个 td；前 100 列内容（r1c0）可见；越界列内容（r1c119）不出现。
  await check('xlsx 宽表：sample-wide.xlsx（120 列）→ 注记「仅显示前 100 列」+ 每行恰好渲染 100 列', async () => {
    await openPreview(F.xlsxWide);
    await waitForHeavy('xlsx 宽表 table + 列注记出现', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const table = d && d.querySelector('.xlsx-preview__table');
      const note = d && d.querySelector('.xlsx-preview__note');
      return !!table && !!note && (note.textContent || '').includes('仅显示前 100 列') && (note.textContent || '').includes('共 120 列');
    })()`);
    const probe = await evalExpr(`(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const table = d.querySelector('.xlsx-preview__table');
      return JSON.stringify({
        firstRowTds: table.querySelectorAll('tr:first-child td').length,
        cellCount: table.querySelectorAll('td').length,
        hasEarly: (table.textContent || '').includes('r1c0'),
        hasBeyond: (table.textContent || '').includes('r1c119'),
      });
    })()`);
    const v = JSON.parse(String(probe));
    if (v.firstRowTds !== 100) throw new Error(`首行渲染列数 ${v.firstRowTds} ≠ 100（MAX_COLS 钳制未生效）`);
    if (v.hasEarly !== true) throw new Error('前 100 列内容未渲染（r1c0 缺失，表格无可见内容）');
    if (v.hasBeyond) throw new Error('越界列内容仍渲染（r1c119 应被钳制在前 100 列之外）');
    if (v.cellCount !== 1000) throw new Error(`总单元格数 ${v.cellCount} ≠ 1000（10 行 × 100 列）`);
    await closeDrawer();
  });

  // ── pptx：.pptx-preview 容器内出现幻灯片内容（测试词）──
  await check('pptx：sample.pptx → .pptx-preview__body 渲染出幻灯片测试词', async () => {
    await openPreview(F.pptx);
    await waitForHeavy('pptx 幻灯片文本渲染', `(() => {
      const body = document.querySelector('.fpreview-drawer.open .pptx-preview__body');
      return !!body && body.childElementCount > 0 && (body.textContent || '').includes(${JSON.stringify(PPTX_WORD)});
    })()`);
    await closeDrawer();
  });

  // ── B17 超限拒绝：>24MB pdf → 「过大」 ──
  await check('B17 oversize.pdf（>24MB 零值填充）→ .fpreview-empty「过大」', async () => {
    writeFileSync(F.oversizePdf, Buffer.alloc(24 * 1024 * 1024 + 1, 0));
    await openPreview(F.oversizePdf);
    await waitFor('.fpreview-empty 出现「过大」', `(() => {
      const e = document.querySelector('.fpreview-empty');
      return !!e && (e.textContent || '').includes('过大');
    })()`, OPEN_TIMEOUT_MS);
    await closeDrawer();
  });

  // ── B5 二进制拒绝 + empty 文本 ──
  await check('B5 binary.txt（前 64 字节含 0x00）→ .fpreview-empty「二进制」', async () => {
    await openPreview(F.binary);
    await waitFor('.fpreview-empty 出现「二进制」', `(() => {
      const e = document.querySelector('.fpreview-empty');
      return !!e && (e.textContent || '').includes('二进制');
    })()`, OPEN_TIMEOUT_MS);
  });
  // ── B3 空文件子条件分流：0 字节文本 → 空态卡「（空文件）」，不再渲染空源码视图 ──
  await check('B3 empty.txt（0 字节）→ 空态卡「（空文件）」（不再渲染空源码视图）', async () => {
    await openPreview(F.empty);
    await waitFor('.fpreview-empty 出现「（空文件）」', `(() => {
      const e = document.querySelector('.fpreview-empty');
      return !!e && (e.textContent || '').includes('（空文件）');
    })()`, OPEN_TIMEOUT_MS);
    const stale = await evalExpr(`!!document.querySelector('.fpreview-drawer.open .fpreview-code')`);
    if (stale === true) throw new Error('空态卡渲染的同时仍出现空源码视图（.fpreview-code 应不渲染）');
  });

  // ── B11 大文本无高亮：70KB（>64KB 高亮阈值、<256KB 截断阈值）→ 纯转义渲染、零 hljs 标记 ──
  await check('B11 big.txt（70KB 纯 x）→ .fpreview-src 渲染完整且无任何 hljs 标记', async () => {
    await openPreview(F.bigTxt);
    await waitFor('.fpreview-src 出现', `!!document.querySelector('.fpreview-drawer.open .fpreview-src')`, OPEN_TIMEOUT_MS);
    const probe = await evalExpr(`(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const src = d.querySelector('.fpreview-src');
      return JSON.stringify({ hljs: src.querySelectorAll('[class*="hljs"]').length, len: src.textContent.length });
    })()`);
    const v = JSON.parse(String(probe));
    if (v.hljs !== 0) throw new Error(`发现 ${v.hljs} 个 hljs 标记（B11：>64KB 纯文本应无高亮）`);
    if (v.len !== 70 * 1024) throw new Error(`内容渲染不完整：${v.len} ≠ ${70 * 1024}`);
  });

  // ── B8 竞态守卫：open 大文件后立即 open 小文件 → 终态只落小文件 ──
  await check('B8 竞态守卫：立即连开 oversize.pdf → hello.txt，终态只显示 hello.txt', async () => {
    const ok = await evalExpr(storeExpr(`st.openPreview(${JSON.stringify(F.oversizePdf)}); st.openPreview(${JSON.stringify(F.hello)}); return true;`));
    if (ok !== true) throw new Error('store 调用失败');
    await waitFor('终态为 hello.txt 源码（且无「过大」空态）', `(() => {
      const d = document.querySelector('.fpreview-drawer.open');
      const code = d && d.querySelector('.fpreview-code .fpreview-src');
      const empty = d && d.querySelector('.fpreview-empty');
      return !!code && (code.textContent || '').includes(${JSON.stringify(HELLO_MARK)}) && !empty;
    })()`, OPEN_TIMEOUT_MS);
    const path0 = await evalExpr(storeExpr(`return st.path;`));
    if (!path0.endsWith('hello.txt')) throw new Error(`终态 path=${path0}`);
  });

  // ── 渲染层异常终审（exceptionThrown / console error 即 FAIL，对齐仓库先例）──
  await check('X 渲染层全程无 exceptionThrown / console.error', async () => {
    if (exceptions.length > 0) throw new Error(`exceptionThrown ${exceptions.length} 条：` + exceptions.map((x) => `[${x.case}] ${String(x.text).slice(0, 120)}`).join(' | '));
    if (consoleErrors.length > 0) throw new Error(`console.error ${consoleErrors.length} 条：` + consoleErrors.map((x) => `[${x.case}] ${String(x.text).slice(0, 120)}`).join(' | '));
  });

  await closeDrawer().catch(() => { /* 收尾关闭失败不影响结论 */ });
}

// ── 结果汇总与退出门：fail===0 才放行 0（用例只有 PASS/FAIL 两态，核心集 txt/md/pdf/xlsx/docx/pptx/
//   B1/B5/B6/B17/B8 任一失败即 fail++，天然挡在 fail===0 门上；round-001 p10 已删除零调用的死代码 skip 机制）。 ──
main()
  .then(async () => {
    log('==== 文件预览面板冒烟汇总 ====');
    log(`PASS ${pass} / FAIL ${fail}`);
    if (exceptions.length) log(`exceptionThrown：${exceptions.length} 条`);
    if (consoleErrors.length) log(`console.error：${consoleErrors.length} 条`);
    await cleanup();
    process.exit(fail === 0 ? 0 : 1);
  })
  .catch(async (e) => {
    if (e instanceof PreconditionError) {
      log(`前置不满足：${e.message}`);
      await cleanup();
      process.exit(2);
    }
    log(`异常：${String(e?.stack || e).slice(0, 600)}`);
    try { await screenshot('smoke-crash'); } catch { /* 尽力而为 */ }
    await cleanup();
    process.exit(1);
  });
