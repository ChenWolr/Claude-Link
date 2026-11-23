// scripts/cdp-translate-probe-smoke.mjs
// p9 真网终态验证 smoke（2026-11-22 扩容批次；计划 00 §实现标准 1 + 评审 P2-8；用例 SM-1/SM-2）：
//   隔离 --user-data-dir 冷启动 out/ 产物 electron（E2E 铁律：禁碰用户真实配置，用后删 profile）
//   → 预置存量 legacy 四种子 translation 配置（google/bing/youdao/baidu + youdao V1 脏端点 + 旧
//     customTemplates 键；只写隔离 profile）——SM-2「存量升级终态」场景：读路径 sanitize 归一
//   → CDP 打开设置页→行为 Tab→翻译引擎节：
//     A. 终态断言（P2-8）：引擎表恰五行且为 legacy 归一序 [bing,youdao,alibaba,qq,sogou]
//        （序即分辨力护栏：证明确实消费的是预置 legacy 配置而非出厂默认序 [bing,alibaba,qq,sogou,youdao]）、
//        无凭据/模板/代理/添加引擎残留控件（元素普查 + 文本反扫）、endpoint 输入仅 bing 行；
//     B. 真网一键探测（「检查连通性」按钮）：五引擎行全 ok=true（bing 偶发 429 允许整轮重试一次，
//        仍红 = 判不过；每引擎 8s 上限 × 5 串行 + youdao 引导链 → 单轮总超时 120s）；
//     C. 探测表数据（kind/名/ok/latency/error）stdout JSON 输出供实施报告留档（[p9-probe-data] 行）。
// 启动形态照 cdp-file-preview-smoke.mjs 先例（node_modules electron.exe + out/ 产物 +
//   ELECTRON_RENDERER_URL='' 生产式冷启动）；产物新鲜度预检 + 陈旧自动 npm run build 照
//   cdp-real-window-e2e.mjs 先例（src 最新 mtime > out/renderer → build）。
// 前置：node_modules 已装（electron.exe / tsx 不需要）；无真网时不判环境（失败按 plan-tdd §5 三分流人工定性）。
// 退出码：0=全过；1=断言/真网失败；2=前置不满足。
// 用法：node scripts/cdp-translate-probe-smoke.mjs
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const CDP_PORT = 9336;
const EXE = path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe');
const OUT_MAIN = path.join(process.cwd(), 'out', 'main', 'index.js');
const OUT_RENDERER = path.join(process.cwd(), 'out', 'renderer');
const SRC_DIR = path.join(process.cwd(), 'src');
const TOTAL_TIMEOUT_MS = 600_000; // 指令闸门：timeoutMs 上限 10 分钟
const PROBE_ROUND_TIMEOUT_MS = 120_000; // 单轮探测总超时（5 引擎串行各 ≤8s + 引导链开销）
// R3 先例（cdp-update-e2e）：隔离 userData 根可经 CLAUDE_LINK_CACHE_ROOT 覆盖；缺省落 os.tmpdir()。
const CACHE_ROOT = process.env.CLAUDE_LINK_CACHE_ROOT ?? path.join(os.tmpdir(), 'claude-link-cache');
let isoDir = null;

let pass = 0, fail = 0;
const log = (m) => console.log(`[translate-probe-smoke] ${m}`);
async function check(name, fn) {
  try { await fn(); pass++; log(`  ✅ ${name}`); }
  catch (e) { fail++; log(`  ❌ ${name} — ${e.message}`); try { await shot(`fail-${pass + fail}.png`); } catch {} }
}
class PreconditionError extends Error {}

// ── CDP 驱动（照 cdp-update-e2e.mjs 手法） ──
let ws = null, appProc = null;
async function cdpCall(wsConn, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        wsConn.removeEventListener('message', handler);
        if (msg.error) reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    wsConn.addEventListener('message', handler);
    wsConn.send(JSON.stringify({ id, method, params }));
  });
}
async function evalExpr(wsConn, expr) {
  const r = await cdpCall(wsConn, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}
async function shot(file) {
  if (!ws) return;
  const r = await cdpCall(ws, 'Page.captureScreenshot', { format: 'png' });
  const dir = path.join(process.cwd(), '.plan-loop', '00-行为契约与实施计划-1122-1755', 'round-001', 'logs');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, file), Buffer.from(r.data, 'base64'));
}
async function waitFor(fn, timeoutMs, everyMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await sleep(everyMs);
  }
  throw new Error(`等待超时（${timeoutMs}ms）`);
}

// ── 清理：按 PID 树杀实例（禁 taskkill /IM 误杀用户实例，R3 先例）+ 删隔离目录 3×重试（EBUSY 先例） ──
let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  try { ws?.close(); } catch {}
  if (appProc && appProc.exitCode === null) {
    try { spawnSync('taskkill', ['/PID', String(appProc.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true }); } catch {}
  }
  if (!isoDir) return;
  let rmErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { rmSync(isoDir, { recursive: true, force: true }); rmErr = null; break; }
    catch (e) { rmErr = e; Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
  }
  if (rmErr) log(`[cleanup] 隔离目录删除失败（3 次重试后仍败，申报留人工清理）：${isoDir} — ${String(rmErr.message).slice(0, 120)}`);
  else log(`[cleanup] 隔离目录已删除：${isoDir}`);
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });
process.on('SIGTERM', () => { cleanup(); process.exit(143); });
const totalTimer = setTimeout(() => {
  log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，清理后退出（防挂死）`);
  cleanup();
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

// ── 产物新鲜度（real-window-e2e 先例：src 最新 mtime > out/renderer → 自动 build） ──
function newestMtimeUnder(dir) {
  let newest = 0;
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = path.join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.mtimeMs > newest) newest = st.mtimeMs;
    }
  };
  walk(dir);
  return newest;
}

// ── 预置 legacy 存量配置（SM-2 场景夹具；只写隔离 profile）：老四种子 + youdao V1 脏端点 +
//    google useProxy + 旧 customTemplates 键。真实本机 config 的 translation 节同款形态
//    （p9 实施时只读探测实证），读路径 sanitize 应归一恰五引擎。 ──
function seedLegacyConfig(profileDir) {
  const legacy = {
    translation: {
      engines: [
        { id: 'seed-google-gtx', kind: 'google-gtx', enabled: true, order: 0, useProxy: true },
        { id: 'seed-bing-web', kind: 'bing-web', enabled: true, order: 1 },
        { id: 'seed-youdao-web', kind: 'youdao-web', enabled: true, order: 2, endpoint: 'https://fanyi.youdao.com/translate_o?client=desktop&oldsign=1' },
        { id: 'seed-baidu-web', kind: 'baidu-web', enabled: true, order: 3 },
      ],
      customTemplates: [],
    },
  };
  writeFileSync(path.join(profileDir, 'claude-link-config.json'), JSON.stringify(legacy, null, 2));
}

// ── 页面取数（.tr-eng-section 单节作用域） ──
const ENGINE_SECTION_STATE = `(() => {
  const sec = document.querySelector('.tr-eng-section');
  if (!sec || sec.offsetParent === null) return null;
  const rows = [...sec.querySelectorAll('.tr-eng-row')].map((r) => ({
    name: r.querySelector('.tr-eng-name')?.textContent?.trim() ?? '',
    enabled: r.querySelector('input[type=checkbox]')?.checked ?? null,
    hasEndpoint: !!r.querySelector('.tr-eng-endpoint'),
    endpointValue: r.querySelector('.tr-eng-endpoint')?.value ?? null,
  }));
  const text = sec.textContent || '';
  return {
    rowCount: sec.querySelectorAll('.tr-eng-row').length,
    rows,
    inputs: {
      total: sec.querySelectorAll('input').length,
      checkbox: sec.querySelectorAll('input[type=checkbox]').length,
      text: sec.querySelectorAll('input[type=text]').length,
    },
    selects: sec.querySelectorAll('select').length,
    textareas: sec.querySelectorAll('textarea').length,
    buttons: sec.querySelectorAll('button').length,
    endpointInputCount: sec.querySelectorAll('.tr-eng-endpoint').length,
    residueHits: ['添加引擎', '凭据', '模板', '代理'].filter((w) => text.includes(w)),
  };
})()`;

const PROBE_STATE = `(() => {
  const sec = document.querySelector('.tr-eng-section');
  if (!sec || sec.offsetParent === null) return null;
  const btns = [...sec.querySelectorAll('button')];
  const probeBtn = btns.find((b) => (b.textContent || '').includes('检测中') || (b.textContent || '').includes('检查连通性'));
  const res = sec.querySelector('[data-testid="translate-probe-result"]');
  const rows = res
    ? [...res.querySelectorAll('.tr-probe-line')].map((r) => ({
        name: r.querySelector('.tr-probe-name')?.textContent?.trim() ?? '',
        ok: !!r.querySelector('.tr-probe-dot.ok'),
        latency: r.querySelector('.tr-probe-latency')?.textContent?.trim() ?? null,
        error: r.querySelector('.tr-probe-error')?.textContent?.trim() ?? null,
      }))
    : null;
  return { pending: probeBtn?.disabled === true, rows };
})()`;

const NAME_TO_KIND = {
  'Bing（免费）': 'bing-web',
  '阿里翻译': 'alibaba-web',
  '腾讯交互翻译': 'qq-transmart',
  '搜狗翻译': 'sogou-web',
  '有道（免费）': 'youdao-web',
};

// 单轮探测：点击「检查连通性」→ 等 pending 窗口（错过不致命）→ 等完成（5 行 + 不再 pending）→ 返回行数据。
async function probeOnce(round) {
  const pre = await evalExpr(ws, PROBE_STATE);
  await evalExpr(ws, `(() => { const b = [...document.querySelectorAll('.tr-eng-section button')].find((x) => (x.textContent || '').includes('检查连通性')); if (!b) throw new Error('检查连通性按钮不存在'); b.click(); return true; })()`);
  let observedPending = false;
  const deadline = Date.now() + PROBE_ROUND_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const st = await evalExpr(ws, PROBE_STATE);
    if (!st) throw new Error('翻译引擎节不可见（探测轮询中）');
    if (st.pending) observedPending = true;
    if (!st.pending && Array.isArray(st.rows) && st.rows.length === 5 && (observedPending || JSON.stringify(st.rows) !== JSON.stringify(pre?.rows ?? null))) {
      return st.rows;
    }
    await sleep(500);
  }
  throw new Error(`第 ${round} 轮探测 ${PROBE_ROUND_TIMEOUT_MS / 1000}s 未出全表（pending 观测=${observedPending}）`);
}

// ── 主流程 ──
async function main() {
  // 前置①：electron.exe + out/ 产物存在。
  if (!existsSync(EXE)) throw new PreconditionError(`缺 ${EXE}（先 npm install）`);
  if (!existsSync(OUT_MAIN) || !existsSync(OUT_RENDERER)) throw new PreconditionError('缺 out/ 产物（先 npm run build）');
  // 前置②：产物新鲜度（src 有更新 → 自动 build，real-window-e2e 先例）。
  if (newestMtimeUnder(SRC_DIR) > statSync(OUT_RENDERER).mtimeMs) {
    log('[iso-build] out/renderer 落后于 src 最新 → npm run build');
    const r = spawnSync('npm run build', { shell: true, stdio: 'inherit', windowsHide: true, timeout: 600_000, cwd: process.cwd() });
    if (r.status !== 0) throw new PreconditionError(`npm run build 失败（exit=${r.status}）`);
  }
  // 前置③：CDP 端口空闲（netstat 预检，real-window-e2e 先例）。
  {
    const out = spawnSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stdout ?? '';
    if (out.split(/\r?\n/).some((l) => l.includes(`:${CDP_PORT} `) && l.toUpperCase().includes('LISTENING'))) {
      throw new PreconditionError(`CDP 端口 ${CDP_PORT} 已被占用`);
    }
  }
  // 前置④：隔离 profile（mkdtemp，用后整删）+ 预置 legacy 存量配置（SM-2）。
  const parent = path.join(CACHE_ROOT, 'claude-link-translate-probe-iso');
  mkdirSync(parent, { recursive: true });
  isoDir = mkdtempSync(path.join(parent, 'run-'));
  const profileDir = isoDir;
  seedLegacyConfig(profileDir);
  log(`隔离 profile=${profileDir}（已预置 legacy 四种子 translation 配置）`);

  // 启动：生产式冷启动（ELECTRON_RENDERER_URL='' → file:// 加载 out/renderer）。
  appProc = spawn(EXE, ['.', `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${profileDir}`], {
    cwd: process.cwd(),
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
    stdio: 'ignore',
    detached: true,
  });
  appProc.unref();
  const target = await (async () => {
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
        const ts = await resp.json();
        const hit = ts.find((t) => t.type === 'page' && /index\.html/i.test(t.url || ''))
          ?? ts.find((t) => t.type === 'page' && !String(t.url || '').startsWith('devtools'));
        if (hit) return hit;
      } catch { /* 未就绪继续轮询 */ }
      if (appProc.exitCode !== null) throw new Error(`应用进程提前退出（code=${appProc.exitCode}）`);
      await sleep(500);
    }
    throw new Error(`CDP ${CDP_PORT} 90s 内未就绪`);
  })();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('WS 连接超时')), 10_000);
    ws.addEventListener('open', () => { clearTimeout(t); resolve(); });
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('WS 连接失败')); });
  });
  log('实例 CDP 已连接');
  await sleep(1500); // 等首屏稳定（更新检查/首渲染）

  // 防御：启动更新弹窗若在场则点掉（无 feed 覆盖时一般不弹）。
  await evalExpr(ws, `(() => { const d = document.querySelector('[data-testid="update-dialog"]'); if (d && d.offsetParent !== null) document.querySelector('[data-testid="update-dialog-dismiss"]')?.click(); return true; })()`).catch(() => {});

  // 导航：设置页 → 行为 Tab（翻译引擎节所在）。
  await evalExpr(ws, `window.location.hash = '/config?tab=behavior'`);
  await waitFor(async () => evalExpr(ws, ENGINE_SECTION_STATE), 15_000);

  // ── A. 设置页终态断言（评审 P2-8；探测前做——探测结果错误文本可能含残留词，避免误判） ──
  await check('A1 引擎表恰五行且为 legacy 归一序 [bing,youdao,alibaba,qq,sogou]（SM-2 分辨力护栏：序异于出厂默认序）', async () => {
    const st = await evalExpr(ws, ENGINE_SECTION_STATE);
    if (!st) throw new Error('翻译引擎节不可见');
    if (st.rowCount !== 5) throw new Error(`引擎表行数=${st.rowCount}（期望恰五行）`);
    const expected = ['Bing（免费）', '有道（免费）', '阿里翻译', '腾讯交互翻译', '搜狗翻译'];
    const actual = st.rows.map((r) => r.name);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`归一序不符：${actual.join(',')}（期望 ${expected.join(',')}；出厂默认序为 bing,alibaba,qq,sogou,youdao——若等于默认序说明预置 legacy 配置未被消费）`);
    }
    const notEnabled = st.rows.filter((r) => r.enabled !== true);
    if (notEnabled.length > 0) throw new Error(`存在非启用行：${notEnabled.map((r) => r.name).join(',')}`);
  });

  await check('A2 endpoint 输入仅 bing 行（恰一个，且该行名为 Bing（免费）；评审 P1-5 收窄面）', async () => {
    const st = await evalExpr(ws, ENGINE_SECTION_STATE);
    if (st.endpointInputCount !== 1) throw new Error(`endpoint 输入数=${st.endpointInputCount}（期望仅 bing 行 1 个）`);
    const epRows = st.rows.filter((r) => r.hasEndpoint);
    if (epRows.length !== 1 || epRows[0].name !== 'Bing（免费）') {
      throw new Error(`endpoint 行错位：${JSON.stringify(epRows)}`);
    }
  });

  await check('A3 无凭据/模板/代理/添加引擎残留控件（元素普查：0 select/0 textarea/6 input/5 checkbox/1 文本输入/12 按钮；文本反扫四词零命中）', async () => {
    const st = await evalExpr(ws, ENGINE_SECTION_STATE);
    if (st.selects !== 0) throw new Error(`残留 select=${st.selects}（添加引擎下拉应整块删除）`);
    if (st.textareas !== 0) throw new Error(`残留 textarea=${st.textareas}（模板编辑区应整块删除）`);
    if (st.inputs.checkbox !== 5) throw new Error(`启用开关 checkbox=${st.inputs.checkbox}（期望 5）`);
    if (st.inputs.text !== 1) throw new Error(`文本输入=${st.inputs.text}（期望仅 endpoint 1 个）`);
    if (st.inputs.total !== 6) throw new Error(`input 总数=${st.inputs.total}（期望 5 checkbox + 1 endpoint = 6）`);
    if (st.buttons !== 12) throw new Error(`button 总数=${st.buttons}（期望 5 行×上移下移 10 + 探测 2 = 12）`);
    if (st.residueHits.length > 0) throw new Error(`文本残留命中：${st.residueHits.join('、')}`);
  });

  // ── B. 真网一键探测（SM-1）：五引擎行全 ok=true；整轮重试一次（bing 偶发 429 属预期）。 ──
  let finalRows = null;
  await check('B1 真网一键探测：五引擎行齐且全部 ok=true（bing 429 允许整轮重试一次）', async () => {
    let rows = await probeOnce(1);
    log(`  第 1 轮探测：${rows.map((r) => `${r.name}=${r.ok ? 'ok' : `fail(${r.error ?? ''})`}`).join(' / ')}`);
    if (!rows.every((r) => r.ok)) {
      log('  存在红行 → 5s 后整轮重试一次（bing 偶发 429 属预期）');
      await sleep(5000);
      rows = await probeOnce(2);
      log(`  第 2 轮探测：${rows.map((r) => `${r.name}=${r.ok ? 'ok' : `fail(${r.error ?? ''})`}`).join(' / ')}`);
    }
    const bad = rows.filter((r) => !r.ok);
    if (bad.length > 0) throw new Error(`重试后仍红：${bad.map((r) => `${r.name}:${r.error ?? ''}`).join(' / ')}`);
    finalRows = rows;
  });

  await check('B2 探测表行集恰五引擎（名集与五 kind 全映射）', async () => {
    if (!finalRows) throw new Error('探测结果缺失（B1 未产出）');
    const kinds = finalRows.map((r) => NAME_TO_KIND[r.name] ?? null);
    const missing = Object.entries(NAME_TO_KIND).filter(([, k]) => !kinds.includes(k));
    const unmapped = kinds.filter((k) => k === null);
    if (unmapped.length > 0) throw new Error(`未知名：${finalRows.filter((_, i) => kinds[i] === null).map((r) => r.name).join(',')}`);
    if (missing.length > 0) throw new Error(`缺引擎：${missing.map(([n]) => n).join(',')}`);
    if (kinds.length !== 5) throw new Error(`行数=${kinds.length}（期望 5）`);
  });

  // ── C. 探测表数据留档（stdout JSON，供实施报告） ──
  if (finalRows) {
    const data = finalRows.map((r) => ({
      kind: NAME_TO_KIND[r.name] ?? null,
      name: r.name,
      ok: r.ok,
      latency: r.latency,
      error: r.error,
    }));
    console.log(`[p9-probe-data] ${JSON.stringify(data)}`);
    log('探测数据已输出（[p9-probe-data] 行，供实施报告留档）');
  }
}

try {
  await main();
} catch (e) {
  if (e instanceof PreconditionError) { log(`前置不满足：${e.message}`); cleanup(); process.exit(2); }
  log(`异常：${e.message}`);
  try { await shot('fail-main.png'); } catch {}
  cleanup();
  process.exit(1);
}
cleanup();
log(`结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
