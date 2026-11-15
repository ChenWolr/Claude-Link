// scripts/cdp-web-access-e2e.mjs
// 「网页访问」浏览器图形级 E2E（P0-6b / 计划 §3-6b，B1-B8；2026-10-26 增 W-changes-panel：web 端改动面板；
// 2026-10-30 增 W-mcp-settings：web 端设置 → MCP tab 渲染 + 协议级双探针，只读不写配置；
// 2026-11-14 UI13-P12 增四个 W 用例：W-queue-panel（队列面板 + getQueueOverview 回包形状 + tasks_changed
// 帧级证据含 T12-H 帧时序）/ W-sidebar-actions（卡片置顶→取消→删除收尾）/ W-sidebar-collapse（侧栏折叠展开
// DOM 断言）/ W-user-timestamp（用户气泡「你 · 发送于」caption 两向断言）。
//
// 用法（编排器/复现者手动准备环境，脚本只做断言）：
//   1. npm run build && npx electron . --remote-debugging-port=9223   （应用运行，8790 监听）
//   2. 启动 Chrome headless（Chrome 可执行路径按本机安装位置准备，或自行为命令赋值；
//      user-data-dir 自选临时目录）：
//      "<Chrome 可执行路径>" --headless=new --remote-debugging-port=9224 ^
//        --user-data-dir=<自选临时目录> --no-first-run --no-default-browser-check about:blank
//   3. npm run test:cdp:web-access
//
//   隔离跑（推荐，符合仓库 AGENTS.md：不得写用户真实配置）：
//     npx electron . --user-data-dir=<临时目录> --remote-debugging-port=9223
//     node scripts/cdp-web-access-e2e.mjs --config <临时目录>/claude-link-config.json
//
// 退出协议：
//   - exit 0：B1-B7 全 PASS + B8 PASS 或 SKIP（SKIP 必须带原因，单独汇总列出）+ W-changes-panel PASS + W-mcp-settings PASS
//             + W-queue-panel PASS + W-sidebar-actions PASS + W-sidebar-collapse PASS + W-user-timestamp PASS。
//   - exit 1：任一 B1-B8 / W-changes-panel / W-mcp-settings / W-queue-panel / W-sidebar-actions / W-sidebar-collapse /
//             W-user-timestamp 断言失败 / 截图失败（*-shot 记账）/ 出现渲染层异常（exceptionThrown 或 console error）。
//   - exit 2：前置条件不满足（Chrome 9224 / 应用 8790 / 配置 token 不可用），或实例新鲜度校验不通过
//             （P3-B：未构建 / 实例未起 / 监听进程启动时间不可读 / 实例过旧——8790 逐个校验全部 LISTENING
//             PID，任一 PID 启动时间 ≥ out/renderer mtime 即放行，全部 PID 过旧（或启动时间均不可读）
//             即判不通过，防「遗留实例 × 重建后 hash 轮换」缓存投毒假红；脚本只校验+指引，
//             不自动重启任何实例）。--config 未指定时读 %APPDATA%/claude-link/claude-link-config.json。
//
// 技术纪律（用户约束）：纯 CDP 原生（Input/Runtime/Network/Page），不依赖 computer-use 等 skill。
// 证据落盘：docs/reports/web-e2e-screenshots/B*.png、W-changes-panel.png、W-mcp-settings.png、
//           W-queue-panel*.png、W-sidebar-actions*.png、W-sidebar-collapse*.png、W-user-timestamp*.png + 同目录 run-B1-B8.log。
// 敏感纪律：token 从 %APPDATA%/claude-link/claude-link-config.json 顶层键 webAccessToken 读取
// （--config 指定时为该路径，隔离 profile 用），一切输出（含 URL 日志）掩码为前 4 后 4。

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// CLI 参数读取（--k v）——必须在 CONFIG_PATH 之前定义：CONFIG_PATH 经 argOf('--config') 求值，
// 而 const 箭头函数不提升（原先定义在文件靠下，移到此处以满足求值顺序；调用形态不变）。
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const CHROME_CDP_PORT = 9224;
// 配置路径可覆盖（--config）：E2E 必须在隔离 --user-data-dir 上跑（仓库 AGENTS.md：不得写用户
// 真实配置），隔离实例的配置与 token 都在隔离目录里，故需能把配置路径指过去。
// 未指定 --config 时仍读 %APPDATA%/claude-link/claude-link-config.json（默认行为不变）。
const DEFAULT_CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
const CONFIG_PATH = argOf('--config', DEFAULT_CONFIG_PATH);
const SHOT_DIR = path.resolve('docs/reports/web-e2e-screenshots');
const LOG_PATH = path.join(SHOT_DIR, 'run-B1-B8.log');
const E2E_MESSAGE_TEXT = '请只回复数字 42,不要使用任何工具';

// 本机网卡事实程序派生（F10 脱敏：源码不硬编码任何本机 IP；--lan-ip/--ts-ip 覆盖优先不变）：
//   LAN 默认 = node:os networkInterfaces() 首个非 internal 且非 CGNAT 段的 IPv4（常规私网，
//             与计划「主战场=局域网 IP」一致；100.64/10 段留给 TS）；
//   TS  默认 = 100.64.0.0/10 CGNAT 段内的 IPv4（Tailscale 网卡地址段），无则 null
//             （null 且无 --ts-ip 时 B8 记 SKIP「未发现 Tailscale 网卡」）。
// argOf 已上移至文件顶部（CONFIG_PATH 求值前，见上）。
function deriveLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === 'IPv4' && net.isIP(iface.address) === 4) {
        const p = iface.address.split('.').map(Number);
        if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) continue;
        return iface.address;
      }
    }
  }
  return null;
}
function deriveTsIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      const p = iface.address.split('.').map(Number);
      // 100.64.0.0/10：首字节 100，次字节 64-127（CGNAT/Tailscale 段）。
      if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) return iface.address;
    }
  }
  return null;
}
const LAN_IP = argOf('--lan-ip', deriveLanIp());
const TS_IP = argOf('--ts-ip', deriveTsIp());

// ── 配置与掩码 ──
let rawConfig;
try { rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawConfig = null; }
const PORT = rawConfig?.webAccess?.port ?? 8790;
const TOKEN = typeof rawConfig?.webAccessToken === 'string' ? rawConfig.webAccessToken : '';
const maskTok = () => (TOKEN ? `${TOKEN.slice(0, 4)}****${TOKEN.slice(-4)}` : '(无)');
const sanitize = (text) => (TOKEN ? String(text).split(TOKEN).join(maskTok()) : String(text));

const logLines = [];
function log(msg) {
  const line = sanitize(`[${new Date().toISOString()}] ${msg}`);
  console.log(line);
  logLines.push(line);
}
function flushLog() { try { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.writeFileSync(LOG_PATH, logLines.join('\n') + '\n'); } catch { /* 落盘尽力而为 */ } }

// ── 结果记账 ──
const results = []; // {id, status: PASS|FAIL|SKIP, note}
let envFail = null;
function record(id, status, note) { results.push({ id, status, note: sanitize(note) }); log(`  [${id}] ${status} ${note}`); }
const consoleErrors = []; // 全程：任何 console error / exception = FAIL
const exceptions = [];
let currentCase = '(pre)';

class PreconditionError extends Error {}
function precondition(cond, msg) { if (!cond) throw new PreconditionError(msg); }

// V1：脚本级总超时兜底（对齐 scripts/web-access-e2e-probe.ts 的 TOTAL_TIMEOUT_MS 做法），
// 超时打印已完成用例汇总后 exit 1，绝不无声挂死。
const TOTAL_TIMEOUT_MS = 600_000;
const totalTimer = setTimeout(() => {
  log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，脚本自杀退出（防挂死）`);
  log('==== 超时时刻已完成的用例汇总 ====');
  for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
  flushLog();
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

// ── CDP 基础（连接写法对齐 scripts/cdp-real-window-e2e.mjs）──
async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json`);
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
}
// N3：连接阶段独立 10s 超时（与下方 30s 调用超时同风格），超时即 reject，不依赖总看门狗回收。
const WS_CONNECT_TIMEOUT_MS = 10_000;
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 尽力而为 */ }
      reject(new Error(`WebSocket 连接超时（${WS_CONNECT_TIMEOUT_MS / 1000}s）：${url}`));
    }, WS_CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket 连接失败：${url}`)); });
  });
}
let msgId = 0;
const pending = new Map();
const CDP_CALL_TIMEOUT_MS = 30_000;
let wsDead = false;
function cdpSend(ws, method, params = {}) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    if (wsDead) { reject(new Error('CDP WebSocket 已断开，拒绝新调用')); return; }
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP 调用超时（${CDP_CALL_TIMEOUT_MS / 1000}s）：${method}`));
    }, CDP_CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
function killAllPending(reason) {
  wsDead = true;
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(`${reason}（未完成调用 id=${id}）`)); }
  pending.clear();
}
async function evalExpr(ws, expr) {
  const r = await cdpSend(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}
async function evalOk(ws, expr) { return (await evalExpr(ws, expr)) === true; }
async function waitFor(label, fn, timeoutS = 60, intervalMs = 200) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}${lastErr ? `；最后错误：${lastErr}` : ''}`);
}
async function screenshot(ws, name) {
  try {
    const r = await cdpSend(ws, 'Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
    log(`  截图落盘 ${name}.png`);
  } catch (e) {
    // V4：截图失败 = 证据链缺失，记入当前用例 FAIL（对齐 cdp-desktop-webaccess-verify.mjs 的 stepFail 做法）。
    record(`${currentCase}-shot`, 'FAIL', `截图失败（用例 ${currentCase}，截图名 ${name}）：${e.message}`);
  }
}
async function navigate(ws, url) {
  log(`  导航 ${sanitize(url)}`);
  await cdpSend(ws, 'Page.navigate', { url });
}

// ── WS 帧证据收集（Network.webSocketFrameSent / Received）──
const frameEvidence = { sent: [], received: [] };
function resetFrameEvidence() { frameEvidence.sent.length = 0; frameEvidence.received.length = 0; }

// ── 页面就绪探针 ──
const connectedExpr = `(() => {
  const app = document.querySelector('#app');
  return !!(app && app.childElementCount > 0) && !!window.claudeLink;
})()`;
const overlayVisibleExpr = `(() => {
  const input = document.querySelector('input[placeholder="访问令牌"]');
  if (!input) return false;
  // V7：重连浮层与登录浮层共用 root（input 隐藏但仍在 DOM）——必须叠加输入框真实可见判定，
  // 否则网络闪断时 B1/B2 会把重连浮层误判为登录浮层（假失败）。offsetParent 对 position:fixed
  // 祖先恒为 null，故以 offsetParent !== null 或 getClientRects().length > 0 任一成立即视为可见。
  if (input.offsetParent === null && input.getClientRects().length === 0) return false;
  let el = input;
  while (el && el !== document.body) {
    if (el.style && el.style.display === 'flex' && el.style.position === 'fixed') return true;
    el = el.parentElement;
  }
  return false;
})()`;

// ── UI13-P12 W 用例共用辅助 ──
// 帧解析：把 baseline 之后的 queue:event/tasks_changed 回帧解析为 {sessionId,type,data} 数组
// （帧线格式 web-access-server.broadcastEvent：{v:1,kind:'event',channel:'queue:event',args:[payload]}）。
function queueChangedFramesSince(baseline) {
  return frameEvidence.received.slice(baseline)
    .map((p) => { try { return JSON.parse(p); } catch { return null; } })
    .filter((f) => f && f.kind === 'event' && f.channel === 'queue:event'
      && f.args && Array.isArray(f.args) && f.args[0] && f.args[0].type === 'tasks_changed')
    .map((f) => f.args[0]);
}
// 前置：确保在局域网 origin + 桥连接（W-changes-panel 同款步骤 0，提炼复用）。
// 注意：不引用 main() 内的 urls 局部变量，lan URL 就地构造（同一形态）。
async function ensureLanBridge(ws, label) {
  if ((await evalExpr(ws, 'location.host')) !== `${LAN_IP}:${PORT}`) {
    await navigate(ws, `http://${LAN_IP}:${PORT}/#token=${TOKEN}`);
    await waitFor(`${label} 前置：页面渲染+桥连接（局域网）`, () => evalOk(ws, connectedExpr), 30);
  }
}
// 会话物化链（B3 同款路径提炼：新建会话 → 选工作空间（菜单优先/pinia 兜底）→ 发送 → 等回合终态）。
// 返回物化后的会话名（侧栏 active 卡名）。B3 本体不动（已绿链最小影响面），仅 W 用例复用。
const W_WAKE_TEXT = '请只回复数字 42,不要使用任何工具';
async function materializeSession(ws, label, messageText) {
  const WS_TARGET = path.resolve(process.cwd());
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor(`${label}：新会话输入框出现`, () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  // 工作空间：先走真实菜单路径（SessionToolbar 第一个 .ctl → 「最近使用」中指向本仓库根的条目），
  // 失败退化为 pinia 直设 activeSession.workingDir（与 chooseRecent→setActiveSessionWorkingDir 同一状态位）。
  let wsPicked = false;
  await evalExpr(ws, `document.querySelector('.ctl .ctl__btn')?.click(), true`);
  const menuRow = await waitFor(`${label}：工作空间菜单出现`, () => evalOk(ws, `!!document.querySelector('.menu__item--dir')`), 5, 200)
    .then(() => evalExpr(ws, `[...document.querySelectorAll('.menu__item--dir')].find((b) => b.title === ${JSON.stringify(WS_TARGET)})?.click(), true`))
    .catch(() => false);
  if (menuRow === true) {
    wsPicked = await waitFor(`${label}：工作空间已选中`, () => evalOk(ws, `(() => {
      const btn = document.querySelector('.ctl .ctl__btn');
      const t = btn?.title ?? '';
      return t.length > 0 && !t.includes('未选择');
    })()`), 8).then(() => true).catch(() => false);
  }
  if (!wsPicked) {
    log(`  ${label}：工作空间菜单无仓库目录项，pinia 直设 workingDir（兜底路径）`);
    await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      if (st && st.activeSession) { st.activeSession.workingDir = ${JSON.stringify(WS_TARGET)}; return true; }
      return false;
    })()`);
    await new Promise((r) => setTimeout(r, 300));
  }
  // 输入并发送。
  await evalExpr(ws, `(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    ta.value = ${JSON.stringify(messageText)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
  // 物化证据：侧栏出现 active 卡（user 消息落库 → 会话持久化）。落库瞬间会话会被自动重命名
  // （transient 默认名「会话 N」→ 首条消息文本截断），故读两次（间隔 800ms）一致才算稳定，
  // 防止拿到重命名窗口前的旧名导致后续按名定位失配。
  const sessionName = await waitFor(`${label}：会话物化（侧栏 active 卡稳定出现）`, async () => {
    const n1 = await evalExpr(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText ?? ''`);
    if (!n1) return false;
    await new Promise((r) => setTimeout(r, 800));
    const n2 = await evalExpr(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText ?? ''`);
    return n2 && n1 === n2 ? n2 : false;
  }, 20);
  // 回合终态：assistant 终态含 42 且流式组退场（≤120s，B3 同款轮询）。
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) break;
    const done = await evalExpr(ws, `(() => {
      const bubbles = document.querySelectorAll('.bubble--assistant');
      const last = bubbles[bubbles.length - 1];
      return !!(last && (last.innerText || '').includes('42')) && !document.querySelector('.stream-group');
    })()`);
    if (done === true) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const finalText = await evalExpr(ws, `(() => {
    const b = document.querySelectorAll('.bubble--assistant');
    return b.length ? (b[b.length - 1].innerText || '') : '';
  })()`);
  if (!finalText.includes('42')) throw new Error(`${label}：assistant 终态不含「42」（text=${finalText.slice(0, 80)}）`);
  return { sessionName, wsPicked };
}
// 善后：经 store deleteSession 删当前活动会话（B3 善后同款，避免污染真实会话列表）。
async function deleteActiveSessionViaStore(ws) {
  try {
    await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      const id = st?.activeSession?.id;
      if (st && id) { void st.deleteSession(id); return true; }
      return false;
    })()`);
    return true;
  } catch { return false; }
}

// ── 实例新鲜度校验（P3-B：防「遗留实例 × 重建后 hash 轮换」缓存投毒假红）──
// 背景（评审 §4 根因链）：本脚本不自起实例，依赖手工预起 app（8790）+ headless Chrome（9224）。
// 已复现事故形态：遗留实例（启动时间早于最后一次构建）内存里的 index.html 引用旧 hash 的
// immutable 资产，重建后 hash 轮换/旧资产被清 → dynamic fetch web-bridge-*.js 失败 → B 链 0/11 级联假红。
// 规则（只校验 + 指引，FAIL-fast；不做任何「自动重启实例」的越界行为；逐个校验全部 LISTENING PID）：
//   out/renderer 不存在                              → 未构建（exit 2）
//   PORT 无 LISTENING 进程                           → 实例未起（exit 2）
//   全部监听 PID 启动时间均不可读                    → 校验不通过（exit 2）
//   全部监听 PID 启动时间均 < out/renderer mtime     → 实例过旧 = 旧构建产物（缓存投毒风险）（exit 2）
//   任一监听 PID 启动时间 ≥ out/renderer mtime       → 通过（fail-safe：不可读/过旧 PID 被其余新鲜 PID
//                                                      覆盖放行），继续既有流程。
// 实现注记：Windows-only（netstat -ano / PowerShell Get-CimInstance）；netstat 多行匹配只取
// State=LISTENING 的 TCP 行（UDP 行无 State 列，列序不同，须跳过），收集全部唯一 PID（electron 单实例
// 以同一 PID 绑定 v4/v6 双栈，通常仅 1 个；多 PID 时逐个取启动时间判定，任一新鲜即放行）；时间比较统一
// 毫秒时间戳（PowerShell ToFileTime() 100ns → BigInt/10000 − 1601→1970 纪元差，BigInt 防 >2^53 失精度）。
const BUILD_DIR = path.resolve('out/renderer');
const WIN_EPOCH_DIFF_MS = 11_644_473_600_000; // 1601-01-01 → 1970-01-01 的毫秒差

function findListenerPids(port) {
  let out;
  try {
    out = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  } catch {
    return null; // netstat 执行失败（非 Windows / 权限异常）→ 调用方按校验不通过处理
  }
  const pids = [];
  for (const lineRaw of out.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line.toUpperCase().startsWith('TCP')) continue; // 只看 TCP 行；UDP 行无 State 列
    const parts = line.split(/\s+/);
    // TCP 行列序：Proto / LocalAddress / ForeignAddress / State / PID
    if (parts.length < 5 || parts[3].toUpperCase() !== 'LISTENING') continue;
    const m = parts[1].match(/:(\d+)$/); // IPv4（0.0.0.0:8790）与 IPv6（[::]:8790）均以 :port 结尾
    if (!m || Number(m[1]) !== port) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function getProcessStartMs(pid) {
  try {
    const out = execFileSync('powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CreationDate.ToFileTime()`],
      { encoding: 'utf8', windowsHide: true, timeout: 20_000 }).trim();
    // 进程已退出 / CreationDate 为空时 PowerShell 报错（非零退出）或输出非纯数字 → 视为不可读。
    if (!/^\d{10,}$/.test(out)) return null;
    return Number(BigInt(out) / 10000n - BigInt(WIN_EPOCH_DIFF_MS)); // fileTime(100ns) → Unix epoch ms
  } catch {
    return null;
  }
}

function assertFreshInstances() {
  const fail = (reason, detail) => {
    log(`实例新鲜度校验不通过：${reason}${detail}`);
    throw new PreconditionError(
      `实例新鲜度校验不通过（${reason}）${detail}——存在缓存投毒风险，拒绝继续。`
      + `修复（一行）：如刚改过前端代码先 npm run build，再重启 Electron app（npx electron . --remote-debugging-port=9223）与 headless Chrome（9224），然后重跑本脚本。`);
  };
  // ② 构建产物在位（目录不存在 = 未构建，实例新鲜度无从谈起）。
  let buildMs;
  try { buildMs = fs.statSync(BUILD_DIR).mtimeMs; }
  catch { fail('未构建', `：${BUILD_DIR} 不存在，请先 npm run build`); }
  // ① PORT 监听进程定位（netstat -ano 多行匹配取 LISTENING 行）。
  const pids = findListenerPids(PORT);
  if (pids === null) fail('校验手段不可用', '：netstat 执行失败（本校验仅支持 Windows）');
  if (pids.length === 0) fail('实例未起', `：端口 ${PORT} 无 LISTENING 进程（应用实例未启动）`);
  // ①' 监听进程启动时间（PowerShell Win32_Process CreationDate）——逐 PID 取，覆盖端口上多个
  //     LISTENING PID 的理论形态；不可读记 null（fail-safe：有任一新鲜即放行）。
  const startByPid = pids.map((pid) => ({ pid, startMs: getProcessStartMs(pid) }));
  const describe = (pid, startMs) => startMs === null
    ? `PID ${pid} 启动时间不可读`
    : `PID ${pid} 启动 ${new Date(startMs).toISOString()}${startMs >= buildMs ? '（新鲜）' : '（过旧）'}`;
  // ③ 判定：任一监听 PID 启动 ≥ 最新构建即放行；全部 PID 过旧或启动时间均不可读才 FAIL-fast
  //     （fail-safe 方向与单 PID 版一致，§4 事故形态）。
  const anyFresh = startByPid.some((e) => e.startMs !== null && e.startMs >= buildMs);
  if (!anyFresh) {
    const all = startByPid.map((e) => describe(e.pid, e.startMs)).join('、');
    if (startByPid.some((e) => e.startMs !== null)) {
      fail('实例过旧', `：${all}——无一监听 PID 达到最新构建 ${new Date(buildMs).toISOString()}（${BUILD_DIR} mtime），按旧构建产物实例处理（缓存投毒风险）`);
    }
    fail('监听进程启动时间不可读', `：${all}（进程可能刚退出或权限不足，无一可判定新鲜）`);
  }
  log(`实例新鲜度校验通过：${startByPid.map((e) => describe(e.pid, e.startMs)).join('、')}；最新构建 ${new Date(buildMs).toISOString()}（${BUILD_DIR} mtime）`);
}

// ── 主流程 ──
async function main() {
  // P3-B：连接既有实例之前先做新鲜度校验（遗留实例 × 重建 = 缓存投毒假红根因，见上方注记）。
  assertFreshInstances();
  precondition(TOKEN.length > 0, `配置 ${CONFIG_PATH} 顶层键 webAccessToken 缺失或为空`);
  precondition(LAN_IP && net.isIP(LAN_IP), `LAN IP 不可用：网卡未发现非 internal IPv4 且未提供合法 --lan-ip（当前=${LAN_IP}）`);
  if (TS_IP) precondition(net.isIP(TS_IP), `--ts-ip 非法：${TS_IP}`);
  const target = await getPageTarget();
  precondition(target, `Chrome CDP ${CHROME_CDP_PORT} 无 page target（请先按脚本头注释启动 Chrome headless）`);
  const ws = await connectWS(target.webSocketDebuggerUrl);
  log(`已连接 Chrome CDP（target=${target.url}）；端口=${PORT} token=${maskTok()} LAN=${LAN_IP} TS=${TS_IP ?? '(未发现 Tailscale 网卡，B8 将 SKIP)'}`);

  // V1：通道一断全部 pending 立即 reject，并拒绝后续新调用（防 CDP 中断后脚本永挂）。
  ws.addEventListener('close', () => killAllPending('CDP WebSocket 已关闭'));
  ws.addEventListener('error', () => killAllPending('CDP WebSocket 错误'));

  // 全程监听：异常与 console error（启用先于一切导航）
  ws.addEventListener('message', (event) => {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id); pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error('CDP: ' + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      exceptions.push({ case: currentCase, text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '(no desc)' });
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push({ case: currentCase, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
    } else if (msg.method === 'Network.webSocketFrameSent') {
      frameEvidence.sent.push(msg.params.response?.payloadData ?? '');
    } else if (msg.method === 'Network.webSocketFrameReceived') {
      frameEvidence.received.push(msg.params.response?.payloadData ?? '');
    }
  });
  await cdpSend(ws, 'Runtime.enable');
  await cdpSend(ws, 'Network.enable');
  await cdpSend(ws, 'Page.enable');

  const urls = {
    local: `http://127.0.0.1:${PORT}/#token=${TOKEN}`,
    lan: `http://${LAN_IP}:${PORT}/#token=${TOKEN}`,
    lanBad: `http://${LAN_IP}:${PORT}/#token=e2e-wrong-token-000000000000`,
    ts: `http://${TS_IP}:${PORT}/#token=${TOKEN}`,
  };

  // ── B1：127.0.0.1（安全上下文）对照 ──
  currentCase = 'B1';
  try {
    await navigate(ws, urls.local);
    await waitFor('页面渲染+桥连接（127.0.0.1）', () => evalOk(ws, connectedExpr), 30);
    const overlay = await evalExpr(ws, overlayVisibleExpr);
    if (overlay === true) throw new Error('登录浮层不应出现（hash 令牌有效）');
    // N1：note 内写入 location.host（Runtime.evaluate 取回），让日志本身可区分访问入口。
    record('B1', 'PASS', `127.0.0.1 渲染+连接成功，无浮层（location.host=${await evalExpr(ws, 'location.host')}，typeof crypto.randomUUID=${await evalExpr(ws, 'typeof crypto.randomUUID')}）`);
  } catch (e) { record('B1', 'FAIL', e.message); }
  // N1：截图前 300ms 延迟——B1/B8 曾因抓拍过快出现字节级相同截图（页面像素相同 + PNG 确定性编码）。
  await new Promise((r) => setTimeout(r, 300));
  await screenshot(ws, 'B1');

  // ── B2：局域网 IP（非安全上下文，R1 主证据）──
  currentCase = 'B2';
  try {
    await navigate(ws, urls.lan);
    await waitFor('页面渲染+桥连接（局域网 IP）', () => evalOk(ws, connectedExpr), 30);
    const overlay = await evalExpr(ws, overlayVisibleExpr);
    if (overlay === true) throw new Error('登录浮层不应出现');
    const uuidType = await evalExpr(ws, 'typeof crypto.randomUUID');
    if (uuidType !== 'function') throw new Error(`typeof crypto.randomUUID = ${uuidType}（polyfill 未生效）`);
    record('B2', 'PASS', `${LAN_IP} 渲染+连接成功；typeof crypto.randomUUID === 'function'（P0-1 生效）`);
  } catch (e) { record('B2', 'FAIL', e.message); }
  await screenshot(ws, 'B2');

  // ── B3：主战场（局域网 IP）：新建会话 → 选工作空间 → 发消息 → 流式增长 ≥2 → 42 → 帧级证据 ──
  // 事实（2026-10-21 实测）：新会话是 renderer-only 暂态，workingDir=null；handleSend 的
  // ensureWorkspace() 在未选工作空间时弹提示并静默 return（无 WS 帧）——与桌面端真实用户
  // 行为一致，必须先经 SessionToolbar 工作空间菜单选「最近使用」目录。
  currentCase = 'B3';
  let b3SessionName = '';
  let b3SessionId = ''; // P12 增：B3 物化会话权威 id（终审前清理块按 id 删，防名字漂移/重名误删）。
  try {
    await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
    await waitFor('新会话输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
    // 选工作空间：打开 SessionToolbar 第一个 .ctl（工作空间）下拉 → 点「最近使用」中
    // **指向本仓库根目录**的那条（2026-10-21 实测：盲点第一条可能选中已失效目录「111」，
    // CLI 因 cwd 不存在 spawn 失败 → SDK 执行出错横幅 → 无流式回复）。
    // F10 脱敏：目标工作空间取当前工作目录（npm run 在仓库根执行，语义等同仓库根）。
    const WS_TARGET = path.resolve(process.cwd());
    let wsPicked = false;
    await evalExpr(ws, `document.querySelector('.ctl .ctl__btn')?.click(), true`);
    const repoRow = await waitFor('工作空间菜单出现', () => evalOk(ws, `!!document.querySelector('.menu__item--dir')`), 5, 200)
      .then(() => evalExpr(ws, `[...document.querySelectorAll('.menu__item--dir')].find((b) => b.title === ${JSON.stringify(WS_TARGET)})?.click(), true`))
      .catch(() => false);
    if (repoRow === true) {
      wsPicked = await waitFor('工作空间已选中（按钮 title 变为目录）', () => evalOk(ws, `(() => {
        const btn = document.querySelector('.ctl .ctl__btn');
        const t = btn?.title ?? '';
        return t.length > 0 && !t.includes('未选择');
      })()`), 8).then(() => true).catch(() => false);
    }
    if (!wsPicked) {
      // 兜底：最近列表无仓库目录时经 pinia 直设（与 chooseRecent→setActiveSessionWorkingDir 同一状态位）
      log('  工作空间菜单无仓库目录项，改经 pinia 直设 workingDir（兜底路径）');
      await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        if (st && st.activeSession) { st.activeSession.workingDir = ${JSON.stringify(WS_TARGET)}; return true; }
        return false;
      })()`);
      await new Promise((r) => setTimeout(r, 300));
    }
    // 增长计数：MutationObserver 以 DOM 突变粒度记录 assistant 可见文本长度严格递增次数
    await evalExpr(ws, `(() => {
      window.__e2eGrowths = 0; window.__e2eLastLen = -1;
      const target = document.querySelector('.message-list__inner') || document.body;
      const measure = () => {
        const nodes = document.querySelectorAll('.stream-group, .bubble--assistant');
        let n = 0; nodes.forEach((el) => { n += (el.innerText || '').length; });
        if (n > window.__e2eLastLen) { if (window.__e2eLastLen >= 0) window.__e2eGrowths += 1; window.__e2eLastLen = n; }
      };
      window.__e2eObs = new MutationObserver(measure);
      window.__e2eObs.observe(target, { childList: true, subtree: true, characterData: true });
      return true;
    })()`);
    // 输入（evaluate 赋值 + input 事件，驱动 v-model）
    await evalExpr(ws, `(() => {
      const ta = document.querySelector('[data-testid="chat-input-textarea"]');
      ta.value = ${JSON.stringify(E2E_MESSAGE_TEXT)};
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    resetFrameEvidence();
    await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
    // 帧级证据：chat:send invoke 帧（发出）+ ≥2 条 chat:event 回帧
    await waitFor('WS 发出 chat:send invoke 帧', () =>
      frameEvidence.sent.some((p) => p.includes('"channel":"chat:send"')), 20, 100);
    await waitFor('WS 收到 ≥2 条 chat:event 帧', () =>
      frameEvidence.received.filter((p) => p.includes('"channel":"chat:event"')).length >= 2, 30, 100);
    // 回合终态：assistant 终态 bubble 含 42 且流式组已退场（轮询 50ms，≤120s）
    const deadline = Date.now() + 120_000;
    for (;;) {
      if (Date.now() > deadline) break;
      const done = await evalExpr(ws, `(() => {
        const bubbles = document.querySelectorAll('.bubble--assistant');
        const last = bubbles[bubbles.length - 1];
        const has42 = !!(last && (last.innerText || '').includes('42'));
        return has42 && !document.querySelector('.stream-group');
      })()`);
      if (done === true) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const growths = await evalExpr(ws, `window.__e2eGrowths ?? -1`);
    const finalText = await evalExpr(ws, `(() => {
      const bubbles = document.querySelectorAll('.bubble--assistant');
      const last = bubbles[bubbles.length - 1];
      return last ? (last.innerText || '') : '';
    })()`);
    const chatEventCount = frameEvidence.received.filter((p) => p.includes('"channel":"chat:event"')).length;
    const textDeltaCount = frameEvidence.received.filter((p) => p.includes('"text_delta"')).length;
    await evalExpr(ws, `window.__e2eObs?.disconnect(), true`);
    if (!finalText.includes('42')) throw new Error(`assistant 终态不含「42」（growth=${growths}，text=${finalText.slice(0, 80)}）`);
    // 断言口径（F2 修正，如实表述）：上游 text_delta 条数在 1-2 间波动 + stream→bubble
    // 结构切换使 DOM 增长计数不稳定（同脚本两轮实测分别为 1 与 2），固定 ≥2 会间歇性
    // 误报；故采用 DOM 增长 ≥1 + 帧层 text_delta ≥1 + chat:event ≥2 的确定性组合。
    if ((growths ?? -1) < 1) throw new Error(`流式 DOM 文本增长次数 ${growths} < 1（流式未逐帧上 DOM）`);
    if (textDeltaCount < 1) throw new Error(`chat:event 帧中未见 text_delta 文本增量帧（count=${textDeltaCount}）`);
    b3SessionName = await evalExpr(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText ?? ''`) || '';
    // P12 增：记 b3 会话权威 id（名字会因落库重命名漂移；终审前清理按 id 删，不按名）。
    b3SessionId = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st?.activeSession?.id ?? '';
    })()`) || '';
    record('B3', 'PASS', `发送→流式 DOM 增长 ${growths} 次、text_delta 帧 ${textDeltaCount} 条、chat:event 回帧 ${chatEventCount} 条(≥2)→终态含 42；工作空间=${wsPicked ? '菜单选择' : 'pinia兜底'}；口径:增长≥1+text_delta≥1+chat:event≥2(计数稳定性裁定见报告)`);
    // F5（截图顺序修正）：断言通过、终态（含 42 的回合完成态）在屏即截——B3.png 必须对应
    // 回合完成态，先于下方善后 deleteSession。
    await screenshot(ws, 'B3');
    // 善后（P12 条件化）：删除本用例物化的测试会话，避免污染真实会话列表；但干净 profile
    // （列表除本会话外无其他持久会话）时保留——B4「切换历史会话」需要非 active 历史会话、
    // B5/B6/W-changes-panel 依赖其消息与 workingDir，保留会话由终审前清理块按 id 删除收尾。
    // 真实 profile（已有用户会话）行为与旧版完全一致（删自己）。
    try {
      const deleted = await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        const id = st?.activeSession?.id;
        if (!st || !id) return 'no-session';
        const others = (st.sessions || []).filter((s) => s.id !== id).length;
        if (others > 0) { void st.deleteSession(id); return 'deleted'; }
        return 'kept';
      })()`);
      if (deleted === 'deleted') log('  B3 测试会话已请求删除（善后；列表存在其他持久会话）');
      else if (deleted === 'kept') log('  B3 测试会话保留（干净 profile：列表无其他持久会话，供 B4-B6/W-changes-panel 消费；终审前按 id 清理）');
      else log('  B3 无活动会话可删（善后 no-op）');
    } catch { log('  B3 测试会话删除失败（不影响断言，遗留人工清理）'); }
    // 善后删除后的界面状态（可选留证，非 B3 主证据）。
    await screenshot(ws, 'B3-cleaned');
  } catch (e) { record('B3', 'FAIL', e.message); await screenshot(ws, 'B3-failed'); }

  // ── B4：切换历史会话 → 历史消息渲染（迭代若干候选，找到有消息的会话）──
  currentCase = 'B4';
  try {
    let switched = '';
    // UI13-P3 侧栏卡片化适配：.session-link/.session-link__name → .session-card/.session-card__name
    // （P3 点报告 §5 只收编了契约钉，E2E 选择器适配落在本点 P12 验收门内）。
    let candidates = await evalExpr(ws, `[...document.querySelectorAll('.session-card')].filter((l) => !l.classList.contains('active')).slice(0, 10).map((l) => l.querySelector('.session-card__name')?.innerText ?? '')`);
    // P12 干净 profile 兜底：B3 条件保留时唯一历史会话可能正是 active 卡（B3 刚物化完）——
    // 经 new-button 新建 transient（真实用户「新建再切回」同路径）使原会话转为非 active 历史卡
    // 后重取候选。transient 不落库不进列表，原会话卡成为唯一候选。
    if (!Array.isArray(candidates) || candidates.length === 0) {
      log('  B4 兜底：无非 active 历史卡（干净 profile，B3 会话为 active），新建 transient 后重取候选');
      await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
      await waitFor('B4 兜底：原会话转为非 active 历史卡', () => evalOk(ws, `(() => {
        const cards = [...document.querySelectorAll('.session-card')];
        return cards.length >= 1 && cards.some((c) => !c.classList.contains('active'));
      })()`), 10);
      candidates = await evalExpr(ws, `[...document.querySelectorAll('.session-card')].filter((l) => !l.classList.contains('active')).slice(0, 10).map((l) => l.querySelector('.session-card__name')?.innerText ?? '')`);
    }
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('侧栏无可切换的历史会话');
    for (const name of candidates) {
      await evalExpr(ws, `[...document.querySelectorAll('.session-card')].find((l) => (l.querySelector('.session-card__name')?.innerText ?? '') === ${JSON.stringify(name)})?.click(), true`);
      const activated = await waitFor(`切换到「${name}」激活`, () => evalOk(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText === ${JSON.stringify(name)}`), 10).then(() => true).catch(() => false);
      if (!activated) continue;
      const hasBubbles = await waitFor(`「${name}」历史消息渲染`, () => evalOk(ws, `document.querySelectorAll('.bubble').length >= 1`), 8).then(() => true).catch(() => false);
      if (hasBubbles) { switched = name; break; }
    }
    if (!switched) throw new Error(`前 ${candidates.length} 个候选会话均无消息（candidates=${candidates.join('/')}）`);
    b3SessionName = switched;
    record('B4', 'PASS', `切换到「${switched}」，消息节点 ≥1`);
  } catch (e) { record('B4', 'FAIL', e.message); }
  await screenshot(ws, 'B4');

  // ── B5：刷新 → active 会话恢复（P1-5）──
  currentCase = 'B5';
  try {
    if (!b3SessionName) throw new Error('前置 B4 未取得会话名，无法断言恢复');
    await cdpSend(ws, 'Page.reload');
    await waitFor('刷新后桥连接恢复', () => evalOk(ws, connectedExpr), 30);
    await waitFor('刷新后 active 会话恢复', () => evalOk(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText === ${JSON.stringify(b3SessionName)}`), 20);
    await waitFor('刷新后消息可见', () => evalOk(ws, `document.querySelectorAll('.bubble').length >= 1`), 20);
    record('B5', 'PASS', `刷新后 active 会话仍为「${b3SessionName}」且消息可见（P1-5 生效）`);
  } catch (e) { record('B5', 'FAIL', e.message); }
  await screenshot(ws, 'B5');

  // ── B6：消息复制按钮 → 无 exceptionThrown ──
  currentCase = 'B6';
  const exceptionsBeforeB6 = exceptions.length;
  try {
    const clicked = await evalExpr(ws, `(() => {
      const btn = document.querySelector('.bubble__copy');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (clicked !== true) throw new Error('未找到 .bubble__copy 复制按钮');
    await new Promise((r) => setTimeout(r, 400));
    if (exceptions.length > exceptionsBeforeB6) throw new Error('点击复制后出现 exceptionThrown');
    const title = await evalExpr(ws, `document.querySelector('.bubble__copy')?.title ?? ''`);
    record('B6', 'PASS', `复制按钮点击无异常（title=${title}）`);
  } catch (e) { record('B6', 'FAIL', e.message); }
  await screenshot(ws, 'B6');

  // ── B7：错误 token → 浮层；手输正确 token → 进入；刷新免输入（P0-3）──
  // 事实（2026-10-21 实测）：同源 URL 仅 hash 变化是同文档导航，页面不重载（旧连接带着好
  // token 存活，浮层永不出现）——必须先跳 about:blank 强制下一跳为完整加载。
  currentCase = 'B7';
  try {
    await navigate(ws, 'about:blank');
    await new Promise((r) => setTimeout(r, 500));
    await navigate(ws, urls.lanBad);
    await waitFor('错误 token → 登录浮层出现', () => evalOk(ws, overlayVisibleExpr), 30);
    await screenshot(ws, 'B7-overlay');
    await evalExpr(ws, `(() => {
      const input = document.querySelector('input[placeholder="访问令牌"]');
      input.value = ${JSON.stringify(TOKEN)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evalExpr(ws, `([...document.querySelectorAll('button')].find((b) => b.textContent === '连接') || document.querySelector('input[placeholder="访问令牌"]')).click(), true`);
    await waitFor('手输正确 token 后连接成功', () => evalOk(ws, connectedExpr), 30);
    const overlayAfter = await evalExpr(ws, overlayVisibleExpr);
    if (overlayAfter === true) throw new Error('连接成功后浮层应收起');
    await screenshot(ws, 'B7-reconnected');
    await cdpSend(ws, 'Page.reload');
    await waitFor('刷新后重连', () => evalOk(ws, connectedExpr), 30);
    await new Promise((r) => setTimeout(r, 800));
    const overlayReload = await evalExpr(ws, overlayVisibleExpr);
    if (overlayReload === true) throw new Error('刷新后浮层再次出现（P0-3 未生效：手输 token 未持久化）');
    record('B7', 'PASS', '错误 token→浮层；手输正确 token→进入；刷新免输入（P0-3 生效）');
  } catch (e) { record('B7', 'FAIL', e.message); }
  await screenshot(ws, 'B7-after-reload');

  // ── B8：Tailscale IP（P0-4 防火墙放行后）──
  currentCase = 'B8';
  const probeTcp = (host) => new Promise((resolve) => {
    const sock = net.connect({ host, port: PORT, timeout: 4000 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
  if (!TS_IP) {
    // V3：本机无 CGNAT 网卡（100.64.0.0/10 段无 IPv4）且未提供 --ts-ip——唯一合法 SKIP 场景。
    record('B8', 'SKIP', '未发现 Tailscale 网卡（100.64.0.0/10 CGNAT 段内无 IPv4，且未提供 --ts-ip）——本机无 CGNAT 网卡，按计划记 SKIP，不算 PASS；补救：启动 Tailscale 或以 --ts-ip 显式指定后重跑');
  } else {
    // V3：先对照探测 127.0.0.1——本地可达而 TS IP 不可达 = 防火墙回归（P0-4 要验的恰是它），判 FAIL 不再 SKIP。
    const localReachable = await probeTcp('127.0.0.1');
    const tsReachable = await probeTcp(TS_IP);
    if (!localReachable) {
      record('B8', 'FAIL', `127.0.0.1:${PORT} 亦 TCP 不可达——网页访问服务疑似未运行（B1 应已失败，此处不 SKIP、如实记 FAIL）`);
    } else if (!tsReachable) {
      record('B8', 'FAIL', `${TS_IP}:${PORT} TCP 不可达，但 127.0.0.1:${PORT} 可达且 Tailscale 网卡在位（TS IP=${TS_IP}）——疑似防火墙拦截；请检查 Windows 防火墙入站规则「Claude Link Web Access 8790」（排查：netsh advfirewall firewall show rule name="Claude Link Web Access"）`);
    } else {
      try {
        await navigate(ws, urls.ts);
        await waitFor('Tailscale IP 页面渲染+桥连接', () => evalOk(ws, connectedExpr), 30);
        const uuidType = await evalExpr(ws, 'typeof crypto.randomUUID');
        if (uuidType !== 'function') throw new Error(`typeof crypto.randomUUID = ${uuidType}`);
        // N1：note 内写入 location.host，与 B1 note 对照即可从日志区分访问入口。
        record('B8', 'PASS', `${TS_IP}（Tailscale）渲染+连接成功 + polyfill 生效（防火墙放行后；location.host=${await evalExpr(ws, 'location.host')}）`);
      } catch (e) { record('B8', 'FAIL', e.message); }
      // N1：截图前 300ms 延迟（与 B1 同因）。
      await new Promise((r) => setTimeout(r, 300));
      await screenshot(ws, 'B8');
    }
  }

  // ── W-changes-panel：web 端选中带 git 改动 workingDir 的会话 → 右侧「改动」面板出现文件行 ──
  // 放 B8 之后：不干扰 B1-B8 的导航/会话流。B7 结束时页面已在局域网 origin（B8 PASS 被导航到
  // TS IP 时由步骤 0 拉回）。用例自造 untracked 探针文件为载体，干净树可复跑：在 workingDir
  // （npm run 执行 cwd）写入 .e2e-changes-probe.tmp（untracked → git status 可见 → 面板出行），
  // finally 必清不残留；写入失败（只读挂载等）退化为面板挂载 + listChanges ok:true 兜底断言。
  currentCase = 'W-changes-panel';
  try {
    const exceptionsBeforeW = exceptions.length;
    const WS_TARGET = path.resolve(process.cwd());
    // 0) 确保在局域网 origin + 桥连接。
    if ((await evalExpr(ws, 'location.host')) !== `${LAN_IP}:${PORT}`) {
      await navigate(ws, urls.lan);
      await waitFor('W 前置：页面渲染+桥连接（局域网）', () => evalOk(ws, connectedExpr), 30);
    }
    // 1) 确保右侧活动面板展开（AppLayout 关闭态下只有 .reopen-task-panel「队列」按钮；已开时为 null，no-op）。
    await evalExpr(ws, `document.querySelector('.reopen-task-panel')?.click(), true`);
    await waitFor('W 前置：右侧活动面板展开（图标轨在位）', () => evalOk(ws, `!!document.querySelector('.rail')`), 10);
    // 2) 选中 workingDir 指向仓库根的会话：优先在会话列表中找现成的点选（真实用户路径）；
    //    列表无此类会话时，按 B3 既有兜底语义经 pinia 直设 activeSession.workingDir
    //    （与 chooseRecent→setActiveSessionWorkingDir 同一状态位，用例内注明退化原因）。
    const targetSessionName = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      if (!st) return '';
      const hit = (st.sessions || []).find((s) => s.workingDir === ${JSON.stringify(WS_TARGET)});
      if (hit) {
        if (!st.activeSession || st.activeSession.id !== hit.id) {
          // UI13-P3 侧栏卡片化适配：点选入口 .session-link → .session-card。
          const link = [...document.querySelectorAll('.session-card')].find((l) => (l.querySelector('.session-card__name')?.innerText ?? '') === hit.name);
          if (link) link.click();
        }
        return hit.name;
      }
      return '';
    })()`);
    if (targetSessionName) {
      await waitFor(`W 前置：会话「${targetSessionName}」激活`, () => evalOk(ws, `document.querySelector('.session-card.active .session-card__name')?.innerText === ${JSON.stringify(targetSessionName)}`), 10)
        .catch(() => { throw new Error(`点选带改动会话「${targetSessionName}」未激活`); });
    } else {
      log('  会话列表无 workingDir=仓库根的会话，按 B3 兜底语义直设 activeSession.workingDir（环境退化注明）');
      const set = await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        if (st && st.activeSession) { st.activeSession.workingDir = ${JSON.stringify(WS_TARGET)}; return true; }
        return false;
      })()`);
      if (set !== true) throw new Error('无活动会话且列表无带改动会话，无法建立改动载体');
      await new Promise((r) => setTimeout(r, 300));
    }
    // 2.5) 自造脏载体（干净树可复跑）：在 workingDir 写 untracked 探针文件（.gitignore 未忽略、
    //      git status --untracked-files=all 可见 → 面板出行）。写入失败（只读挂载等）置
    //      probeWritten=false 走退化断言；finally 必清探针，任何断言失败也不残留。
    const PROBE_PATH = path.join(WS_TARGET, '.e2e-changes-probe.tmp');
    let probeWritten = false;
    try {
      fs.writeFileSync(PROBE_PATH, 'probe');
      probeWritten = true;
    } catch (e) {
      log(`  探针文件写入失败（${String(e.message).slice(0, 120)}）→ 退化断言：面板挂载 + listChanges ok:true，不校验文件行`);
    }
    try {
      // 3) 切「改动」Tab：rightTab 每次加载重置为 'all'，仅当尚未在 changes 时点图标轨按钮
      //    （再点当前激活同类会回 all，故不可盲点）。→ ChangesPanel 挂载（onMounted 即 refresh）。
      const needClick = await evalOk(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        return st ? st.rightTab !== 'changes' : false;
      })()`);
      if (needClick === true) {
        const railClicked = await evalExpr(ws, `(() => {
          const btn = document.querySelector('button[aria-label="改动"]');
          if (!btn) return false;
          btn.click();
          return true;
        })()`);
        if (railClicked !== true) throw new Error('未找到右侧活动栏「改动」按钮（button[aria-label="改动"]）');
      }
      if (probeWritten) {
        // 4) 断言（探针在位）：面板文件行非空（DOM 列表项选择器非空）+ 文件行列表含探针行（见下方加强说明）。
        //    挂载 onMounted→refresh；若撞 F-5 同源守卫（同 id+wd 刚拉过）或挂载早于切会话的 watch
        //    收口而列表暂空，经 pinia 触发 changesStore.refresh(true)（面板「重试」同参，invalidateDiffs
        //    绕过守卫强制重拉）后复验——补拉是用户可达操作，不算放宽断言。
        const rowExpr = `document.querySelectorAll('.changes__list .changes__row').length >= 1`;
        const rowsShown = await waitFor('改动面板文件行渲染', () => evalOk(ws, rowExpr), 20, 300).then(() => true).catch(() => false);
        if (!rowsShown) {
          const nudged = await evalExpr(ws, `(() => {
            const app = document.querySelector('#app');
            const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
            const st = pinia && pinia._s ? pinia._s.get('changes') : null;
            if (st) { void st.refresh(true); return true; }
            return false;
          })()`);
          log(`  面板首拉未出行，changesStore.refresh(true) 补拉（nudged=${nudged}）`);
          await waitFor('改动面板文件行渲染（补拉后）', () => evalOk(ws, rowExpr), 20, 300);
        }
        // 断言加强（2026-10-27）：由「首行路径非空」升级为「文件行列表含探针行」——遍历全部
        // .changes__path 的 innerText，至少一条含 .e2e-changes-probe.tmp（面板路径可能按字母序
        // 排列，探针未必在首行，故不能只看首行）。JSON 往返对 Windows 反斜杠路径安全。
        const PROBE_NAME = '.e2e-changes-probe.tmp';
        const pathTextsRaw = await evalExpr(ws, `JSON.stringify([...document.querySelectorAll('.changes__list .changes__row .changes__path')].map((n) => String(n.innerText)))`);
        let pathTexts = [];
        try { pathTexts = JSON.parse(String(pathTextsRaw)); } catch { pathTexts = []; }
        const probeHit = Array.isArray(pathTexts) ? pathTexts.find((t) => t.includes(PROBE_NAME)) : undefined;
        if (!probeHit) throw new Error(`改动面板文件行不含探针 ${PROBE_NAME}（共 ${Array.isArray(pathTexts) ? pathTexts.length : 0} 行：${(Array.isArray(pathTexts) ? pathTexts : []).join(' | ').slice(0, 160)}）`);
        if (exceptions.length > exceptionsBeforeW) throw new Error('W 用例期间出现 exceptionThrown');
        record('W-changes-panel', 'PASS', `改动面板文件行 ≥1 且含探针行（${PROBE_NAME} 命中=${String(probeHit).slice(0, 60)}；行数=${pathTexts.length}；workingDir=…${path.sep}${path.basename(WS_TARGET)}；会话来源=${targetSessionName ? '列表点选' : 'pinia兜底'}）`);
      } else {
        // 4') 退化断言（探针写入失败，见 2.5 log）：面板组件挂载 + listChanges 返回 ok:true，
        //     不依赖文件行数 ≥1（干净树下面板可能合法为空）。
        await waitFor('改动面板挂载（.changes__header 在位）', () => evalOk(ws, `!!document.querySelector('.changes__header')`), 10);
        const listOk = await evalOk(ws, `window.claudeLink.listChanges(${JSON.stringify(WS_TARGET)}, []).then((r) => r && r.ok === true)`);
        if (listOk !== true) throw new Error('退化断言失败：listChanges 未返回 ok:true');
        if (exceptions.length > exceptionsBeforeW) throw new Error('W 用例期间出现 exceptionThrown');
        record('W-changes-panel', 'PASS', `退化断言 PASS：面板挂载 + listChanges ok:true（探针写入失败，未校验文件行；workingDir=…${path.sep}${path.basename(WS_TARGET)}；会话来源=${targetSessionName ? '列表点选' : 'pinia兜底'}）`);
      }
    } finally {
      // 无条件清理（不设 probeWritten 守卫）：写中途失败残留的半创建探针文件也必清；
      // force: true 对不存在的路径是安全 no-op。
      fs.rmSync(PROBE_PATH, { force: true });
    }
  } catch (e) { record('W-changes-panel', 'FAIL', e.message); }
  await screenshot(ws, 'W-changes-panel');

  // ── W-mcp-settings：web 端设置 → MCP tab 渲染 + 协议级双探针（只读，不写任何配置）──
  // 证明「MCP 探活/测试连接在网页版可用」：DOM 侧 rail/卡片容器在位，协议侧经真实网页上下文
  // 走一遍 getMcpSnapshot / probeMcpServers(target:'scoped', scope:'user')。
  // 只读纪律：不调 saveManaged/writeMcpScoped/setMcpOverride，不写用户配置。
  currentCase = 'W-mcp-settings';
  try {
    const exceptionsBeforeM = exceptions.length;
    // 0) 确保在局域网 origin + 桥连接。
    if ((await evalExpr(ws, 'location.host')) !== `${LAN_IP}:${PORT}`) {
      await navigate(ws, urls.lan);
      await waitFor('W-mcp 前置：页面渲染+桥连接（局域网）', () => evalOk(ws, connectedExpr), 30);
    }
    // 1) 设置页 → MCP tab（hash 路由：#/config?tab=mcp 由 ConfigPage onMounted 读 query）。
    await evalExpr(ws, `(location.hash = '#/config?tab=mcp'), true`);
    await waitFor('设置页 MCP tab 就绪（作用域 rail 在位）', () => evalOk(ws, `!!document.querySelector('.mcp-rail')`), 20);
    await waitFor('MCP 卡片容器在位（.mcp-main）', () => evalOk(ws, `!!document.querySelector('.mcp-main')`), 10);
    // 1.5) 等列表加载收口（快照首拍「正在读取 MCP 服务器清单…」退场）：卡片计数与「测试连接」
    //      按钮存在性都依赖本栏卡片已渲染，加载态下量到 0 卡会误判；settling 等待失败不致命（仅提示）。
    await waitFor('MCP 列表加载收口（退出「正在读取」占位）', () => evalOk(ws, `(() => {
      return ![...document.querySelectorAll('.mcp-empty')].some((el) => (el.textContent || '').includes('正在读取'));
    })()`), 15).catch(() => { log('  MCP 列表加载态 15s 未收口（按当前 DOM 继续断言）'); });
    // 2) rail 三作用域条目 + 「测试连接」按钮在位（c70809b 三作用域能力的存在性证据）。
    //    DOM 事实（2026-10-30 核实 src/renderer/components/config/McpSettings.vue L1911-1917）：
    //    「测试连接」是纯图标按钮（class=mcp-iconbtn，按钮内只有 SVG），文字只存在于
    //    aria-label/title（`测试连接 ${card.name}`），textContent 恒为空——按按钮文字匹配必然
    //    取不到，故以 aria-label 前缀选择器为准；卡片数以 .grp__row 计（卡片存在才有该按钮）。
    const railInfo = await evalExpr(ws, `(() => {
      const items = [...document.querySelectorAll('.mcp-rail-item')];
      const names = items.map((el) => el.querySelector('.mcp-rail-item__name')?.textContent?.trim() ?? '');
      const btns = [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim());
      const probeBtns = [...document.querySelectorAll('button[aria-label^="测试连接"]')];
      const cardCount = document.querySelectorAll('.grp__row').length;
      return JSON.stringify({ railCount: items.length, names, cardCount, hasProbeBtn: probeBtns.length > 0, hasExportBtn: btns.some((t) => t.includes('导出 JSON')) });
    })()`);
    const rail = JSON.parse(String(railInfo));
    if (!(rail.railCount >= 2)) throw new Error(`作用域 rail 条目数 ${rail.railCount} < 2（期望 ≥2：Claude Link 管理 / 用户级 / 项目目录）`);
    // 仅当本栏有卡片时才要求「测试连接」按钮在位（空作用域合法无按钮，隔离 profile 常见）。
    if (rail.cardCount > 0 && rail.hasProbeBtn !== true) throw new Error(`MCP tab 有 ${rail.cardCount} 张卡片但未见「测试连接」按钮（三作用域测试入口缺失）`);
    // 3) 协议级双探针（同一网页上下文、只读）。
    const snap = await evalExpr(ws, `window.claudeLink.getMcpSnapshot().then((r) => JSON.stringify({
      isObj: !!r && typeof r === 'object',
      hasUserServers: !!r && Array.isArray(r.userServers),
      hasProjectDirs: !!r && Array.isArray(r.projectDirs),
      userServerCount: r && Array.isArray(r.userServers) ? r.userServers.length : -1,
      projectDirCount: r && Array.isArray(r.projectDirs) ? r.projectDirs.length : -1,
    }))`);
    const snapObj = JSON.parse(String(snap));
    if (!snapObj.isObj || !snapObj.hasUserServers || !snapObj.hasProjectDirs) {
      throw new Error(`getMcpSnapshot 返回形状不符（${String(snap).slice(0, 200)}）`);
    }
    const probe = await evalExpr(ws, `window.claudeLink.probeMcpServers({ target: 'scoped', scope: 'user' }).then((r) => JSON.stringify({
      isArr: Array.isArray(r),
      len: Array.isArray(r) ? r.length : -1,
      okCount: Array.isArray(r) ? r.filter((x) => x && x.status === 'ok').length : -1,
      shapeOk: Array.isArray(r) ? r.every((x) => x && typeof x.key === 'string' && (x.status === 'ok' || x.status === 'fail') && typeof x.toolCount === 'number') : false,
    }))`);
    const probeObj = JSON.parse(String(probe));
    if (!probeObj.isArr || !probeObj.shapeOk) throw new Error(`probeMcpServers(scoped,user) 回包形状不符（${String(probe).slice(0, 200)}）`);
    if (exceptions.length > exceptionsBeforeM) throw new Error('W-mcp-settings 用例期间出现 exceptionThrown');
    record('W-mcp-settings', 'PASS', `MCP tab 渲染（rail ${rail.railCount} 条：${rail.names.join('/')}；卡片 ${rail.cardCount} 台；测试连接按钮=${String(rail.hasProbeBtn)}；导出按钮=${String(rail.hasExportBtn)}）+ 双探针 OK（snapshot userServers=${snapObj.userServerCount} projectDirs=${snapObj.projectDirCount}；probe scoped/user 回数组 len=${probeObj.len} ok=${probeObj.okCount}；只读未写配置）`);
  } catch (e) { record('W-mcp-settings', 'FAIL', e.message); }
  await screenshot(ws, 'W-mcp-settings');

  // ── W-queue-panel：web 端队列面板 + getQueueOverview 回包形状 + tasks_changed 帧级证据（UI13-P12；T12-A/B/H）──
  // 物化一个专用会话（materializeSession，B3 同款链路）作为队列挂载点：transient 未物化会话 addTask
  // 会落库孤儿任务（会话删除后无主），物化后 addTask 安全；收尾 removeTask ×2 删净任务，会话本体
  // 留给 W-sidebar-actions 做 pin/unpin/删除收尾（该会话为用例自建，删除不触用户数据）。
  currentCase = 'W-queue-panel';
  let wqpSessionName = '';
  let wqpSessionId = ''; // 会话权威标识（名字会因落库自动重命名漂移，id 不变）——留给 W-sidebar-actions。
  try {
    const exceptionsBeforeQ = exceptions.length;
    await ensureLanBridge(ws, 'W-queue-panel');
    // 0) 回 chat 路由（W-mcp-settings 结束时停在 #/config?tab=mcp）。
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-queue-panel：chat 路由就绪（新会话按钮在位）', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    // 1) 物化会话（发送 42 式消息 → 会话落库 → 回合终态）。
    const mat = await materializeSession(ws, 'W-queue-panel', W_WAKE_TEXT);
    wqpSessionName = mat.sessionName;
    // 2) 右侧活动面板展开（AppLayout 关闭态下只有 .reopen-task-panel；已开时为 null，no-op）。
    await evalExpr(ws, `document.querySelector('.reopen-task-panel')?.click(), true`);
    await waitFor('W-queue-panel：右侧活动面板展开（.rail 在位）', () => evalOk(ws, `!!document.querySelector('.rail')`), 10);
    // 3) 切 queue Tab（rightTab==='queue' 才渲染 .queue-bar；已在 queue 时不可盲点——再点同类回 all）。
    const needQueueClick = await evalOk(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st ? st.rightTab !== 'queue' : false;
    })()`);
    if (needQueueClick === true) {
      const qClicked = await evalExpr(ws, `(() => {
        const btn = document.querySelector('button[aria-label="排队任务"]');
        if (!btn) return false;
        btn.click();
        return true;
      })()`);
      if (qClicked !== true) throw new Error('未找到图标轨「排队任务」按钮（button[aria-label="排队任务"]）');
    }
    await waitFor('W-queue-panel：.queue-bar 排队状态条渲染', () => evalOk(ws, `!!document.querySelector('.queue-bar')`), 10);
    // 4) getQueueOverview 回包形状断言（对任意 sessionId 空态也成立：state.standby + 空数组）。
    const sid = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st?.activeSession?.id ?? '';
    })()`);
    if (!sid) throw new Error('无法取得 activeSession id（物化会话未激活？）');
    const ov = await evalExpr(ws, `window.claudeLink.getQueueOverview(${JSON.stringify(sid)}).then((r) => JSON.stringify({
      hasState: !!r.state && typeof r.state === 'object',
      statusOk: ['standby', 'countdown', 'running'].includes(r.state && r.state.status),
      tasksArr: Array.isArray(r.tasks),
      executedArr: Array.isArray(r.executed),
    }))`);
    const ovObj = JSON.parse(String(ov));
    if (!ovObj.hasState || !ovObj.statusOk || !ovObj.tasksArr || !ovObj.executedArr) {
      throw new Error(`getQueueOverview 回包形状不符（${String(ov).slice(0, 200)}）`);
    }
    // 5) addTask#1：回包形状（T12-B）+ tasks_changed 帧#1（T12-A：含新任务 id/status、sessionId 会话匹配）+ DOM 卡出现。
    const frameBaseline1 = frameEvidence.received.length;
    const add1 = await evalExpr(ws, `window.claudeLink.addTask(${JSON.stringify(sid)}, { text: 'e2e-p1-sync-1', attachmentIds: [], clientMessageId: crypto.randomUUID() }).then((r) => JSON.stringify({
      hasTask: !!r.task && typeof r.task.id === 'string' && r.task.id.length > 0,
      taskPending: r.task && r.task.status === 'pending',
      tasksArr: Array.isArray(r.tasks),
      taskId: (r.task && r.task.id) || '',
    }))`);
    const add1Obj = JSON.parse(String(add1));
    if (!add1Obj.hasTask || add1Obj.taskPending !== true || add1Obj.tasksArr !== true) {
      throw new Error(`addTask 回包形状不符（期望 {task:{id,status:'pending'},tasks[]}，实际 ${String(add1).slice(0, 200)}）`);
    }
    const frame1 = await waitFor('W-queue-panel：tasks_changed 帧#1 到达', () => queueChangedFramesSince(frameBaseline1).length >= 1, 10, 100)
      .then(() => queueChangedFramesSince(frameBaseline1)[0]);
    const f1Tasks = Array.isArray(frame1.data && frame1.data.tasks) ? frame1.data.tasks : [];
    if (frame1.sessionId !== sid) throw new Error(`帧#1 sessionId 不符（帧=${frame1.sessionId} 期望=${sid}）`);
    if (!f1Tasks.some((t) => t && t.id === add1Obj.taskId && t.status === 'pending')) {
      throw new Error(`帧#1 tasks 不含新任务 ${add1Obj.taskId}（帧 tasks=${JSON.stringify(f1Tasks).slice(0, 200)}）`);
    }
    await waitFor('W-queue-panel：任务卡#1 渲染（e2e-p1-sync-1）', () => evalOk(ws, `[...document.querySelectorAll('.task-item .task-item__prompt')].some((n) => (n.textContent || '').includes('e2e-p1-sync-1'))`), 10);
    // 面板/会话不被重开/切换（T12-A）：active 会话（按权威 id 比对——名字会因落库重命名漂移）仍为物化会话。
    wqpSessionId = sid;
    const activeIdAfter = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st?.activeSession?.id ?? '';
    })()`);
    if (activeIdAfter !== sid) throw new Error(`addTask 后 active 会话被切换（当前 id=${activeIdAfter} 期望=${sid}）`);
    // 6) addTask#2（T12-H 帧时序：末次 tasks_changed 帧 tasks 长度=2、顺序与末次回包一致——帧不乱序/不携带陈旧列表）。
    const frameBaseline2 = frameEvidence.received.length;
    const add2 = await evalExpr(ws, `window.claudeLink.addTask(${JSON.stringify(sid)}, { text: 'e2e-p1-sync-2', attachmentIds: [], clientMessageId: crypto.randomUUID() }).then((r) => JSON.stringify({
      taskId: (r.task && r.task.id) || '',
      order: Array.isArray(r.tasks) ? r.tasks.map((t) => t.id) : [],
    }))`);
    const add2Obj = JSON.parse(String(add2));
    const frame2 = await waitFor('W-queue-panel：tasks_changed 帧#2 到达', () => queueChangedFramesSince(frameBaseline2).length >= 1, 10, 100)
      .then(() => { const arr = queueChangedFramesSince(frameBaseline2); return arr[arr.length - 1]; });
    const f2Tasks = Array.isArray(frame2.data && frame2.data.tasks) ? frame2.data.tasks : [];
    if (f2Tasks.length !== 2) throw new Error(`帧#2 tasks 长度 ${f2Tasks.length} ≠ 2（T12-H：帧携带陈旧列表）`);
    if (JSON.stringify(f2Tasks.map((t) => t.id)) !== JSON.stringify(add2Obj.order)) {
      throw new Error(`帧#2 tasks 顺序与末次回包不一致（帧=${JSON.stringify(f2Tasks.map((t) => t.id))} 回包=${JSON.stringify(add2Obj.order)}）`);
    }
    // 7) 收尾：removeTask ×2（删除后 tasks_changed 帧到达 + 卡消失，善后不残留）。
    const frameBaseline3 = frameEvidence.received.length;
    const rm1 = await evalExpr(ws, `window.claudeLink.removeTask(${JSON.stringify(add2Obj.taskId)}).then((r) => Array.isArray(r))`);
    if (rm1 !== true) throw new Error('removeTask#1 回包非数组');
    const rm2 = await evalExpr(ws, `window.claudeLink.removeTask(${JSON.stringify(add1Obj.taskId)}).then((r) => Array.isArray(r) && r.length === 0)`);
    if (rm2 !== true) throw new Error('removeTask#2 回包非空数组（任务未删净）');
    await waitFor('W-queue-panel：删除后 tasks_changed 帧到达', () => queueChangedFramesSince(frameBaseline3).length >= 1, 10, 100);
    await waitFor('W-queue-panel：任务卡已消失', () => evalOk(ws, `![...document.querySelectorAll('.task-item .task-item__prompt')].some((n) => (n.textContent || '').includes('e2e-p1-sync'))`), 10);
    if (exceptions.length > exceptionsBeforeQ) throw new Error('W-queue-panel 用例期间出现 exceptionThrown');
    record('W-queue-panel', 'PASS', `队列面板（.queue-bar 在位）+ getQueueOverview 形状 OK（state/statusOk/tasks/executed）+ addTask 回包 {task:{id,status:'pending'},tasks[]} + tasks_changed 帧×3（帧#1 含新任务 id/status 且 sessionId 匹配、帧#2 len=2 且顺序=回包【T12-H】、删除收尾帧）+ DOM 卡出现/消失 + 会话未被切换；物化会话=${wqpSessionName}（留给 W-sidebar-actions）`);
  } catch (e) { record('W-queue-panel', 'FAIL', e.message); }
  await screenshot(ws, 'W-queue-panel');

  // ── W-sidebar-actions：web 端卡片置顶 → 取消置顶 → 删除收尾（UI13-P12；T12-C）──
  // 用 W-queue-panel 物化的会话（wqpSessionId 权威标识，用例自建——删除收尾不触用户数据）；若其未
  // 取得（W-queue-panel 失败/被跳），直接 FAIL 前置缺失，不拿既有用户会话冒险。
  // 定位锚 = active 卡（.session-card.active）+ 前置 id 校验：会话名会因落库自动重命名漂移，且隔离
  // profile 可能残留上一轮同名测试卡（按名字定位有歧义），id 是唯一权威；置顶/取消置顶只改排序
  // 不改 activeSession.id，active 类随 id 走，全程定位稳定。
  // 视图固定「全部」（日期视图）：置顶组跨组浮顶在项目视图的形态由 P3 单元契约背书，E2E 不重复。
  currentCase = 'W-sidebar-actions';
  let wsaDeletedName = '';
  try {
    const exceptionsBeforeS = exceptions.length;
    await ensureLanBridge(ws, 'W-sidebar-actions');
    if (!wqpSessionId) throw new Error('前置 W-queue-panel 未取得物化会话 id（该用例未 PASS 或未执行），无自建会话可操作');
    // 0) 前置校验：active 会话即物化会话（id 比对）。
    const activeIdPre = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st?.activeSession?.id ?? '';
    })()`);
    if (activeIdPre !== wqpSessionId) throw new Error(`active 会话非 W-queue-panel 物化会话（id=${activeIdPre} 期望=${wqpSessionId}）`);
    // 0.5) 确保「全部」tab 激活（groupByProject 默认 false；被前序用例改动时点回）。
    const tabAllExpr = `(() => {
      const tabs = [...document.querySelectorAll('.sidebar__tab')];
      const allTab = tabs.find((t) => (t.textContent || '').trim() === '全部');
      return !!(allTab && allTab.classList.contains('sidebar__tab--active'));
    })()`;
    if ((await evalOk(ws, tabAllExpr)) !== true) {
      const clicked = await evalExpr(ws, `[...document.querySelectorAll('.sidebar__tab')].find((t) => (t.textContent || '').trim() === '全部')?.click(), true`);
      if (clicked !== true) throw new Error('未找到「全部」分组 tab');
      await waitFor('W-sidebar-actions：全部视图生效', () => evalOk(ws, tabAllExpr), 5);
    }
    const activeCardFound = await waitFor('W-sidebar-actions：active 物化卡在列表', () => evalOk(ws, `!!document.querySelector('.session-card.active .session-card__name')`), 10);
    if (!activeCardFound) throw new Error('列表未找到 active 会话卡');
    // 1) 置顶：点 active 卡 pin 钮（.session-card__pinbtn，title=置顶会话）。
    const pinClicked = await evalExpr(ws, `(() => {
      const card = document.querySelector('.session-card.active');
      const btn = card && card.querySelector('.session-card__pinbtn');
      if (!btn || btn.getAttribute('title') !== '置顶会话') return false;
      btn.click();
      return true;
    })()`);
    if (pinClicked !== true) throw new Error('未点到卡片 pin 钮（.session-card__pinbtn title=置顶会话）');
    // 2) 断言：首分组头「置顶」出现 + 该卡为全列表首卡（首分组首卡且带 active 类，active 类随 id 走）+ pin 标识在位。
    // DOM 结构事实（AppSidebar.vue 模板）：template v-for 平铺——组头 div.sidebar__group 与该组卡片
    // div.session-card 是平级兄弟（组头不是卡的父级），首卡 = 首个组头节点的 nextElementSibling。
    const firstCardExpr = `(document.querySelector('.sidebar__group')?.nextElementSibling ?? null)`;
    await waitFor('W-sidebar-actions：置顶组头出现', () => evalOk(ws, `(() => {
      const g = document.querySelector('.sidebar__group .sidebar__group__label');
      return !!g && (g.textContent || '').trim() === '置顶';
    })()`), 10);
    const pinState = await waitFor('W-sidebar-actions：置顶组首卡渲染', () => evalOk(ws, `!!(${firstCardExpr} && (${firstCardExpr}).classList.contains('active'))`), 10)
      .then(() => evalExpr(ws, `(() => {
        const firstCard = ${firstCardExpr};
        return JSON.stringify({
          firstCardActive: !!(firstCard && firstCard.classList.contains('active')),
          firstCardName: firstCard ? ((firstCard.querySelector('.session-card__name')?.innerText ?? '').trim()) : '',
          pinMark: !!(firstCard && firstCard.querySelector('.session-card__pin-mark')),
        });
      })()`));
    const pinObj = JSON.parse(String(pinState));
    if (pinObj.firstCardActive !== true) throw new Error(`置顶组首卡非 active 卡（目标会话未浮到列表第一位，首卡名=${pinObj.firstCardName}）`);
    if (pinObj.pinMark !== true) throw new Error('置顶组首卡缺 pin 标识（.session-card__pin-mark）');
    await screenshot(ws, 'W-sidebar-actions-pinned');
    // 3) 取消置顶：同卡 pin 钮（title 已变「取消置顶」）→「置顶」组头退场 + pin 标识退场。
    const unpinClicked = await evalExpr(ws, `(() => {
      const card = document.querySelector('.session-card.active');
      const btn = card && card.querySelector('.session-card__pinbtn');
      if (!btn || btn.getAttribute('title') !== '取消置顶') return false;
      btn.click();
      return true;
    })()`);
    if (unpinClicked !== true) throw new Error('未点到取消置顶钮（title=取消置顶）');
    await waitFor('W-sidebar-actions：置顶组头退场', () => evalOk(ws, `[...document.querySelectorAll('.sidebar__group .sidebar__group__label')].every((l) => (l.textContent || '').trim() !== '置顶')`), 10);
    await waitFor('W-sidebar-actions：pin 标识退场', () => evalOk(ws, `!(document.querySelector('.session-card.active')?.querySelector('.session-card__pin-mark'))`), 10);
    // 3.5) P3-10：卡回原日期组——「今天」组内含该卡名。组头与卡片是平级兄弟（见上方 DOM 结构事实），
    //      组内卡 = 组头之后至下一组头之间的兄弟 session-card；会话为本用例运行当日物化，取消置顶
    //      后应回到「今天」日期组（卡名取置顶态捕获的 firstCardName，与列表实际渲染名一致）。
    await waitFor('W-sidebar-actions：卡回原日期组（「今天」组内含该卡名）', () => evalOk(ws, `(() => {
      const todayGroup = [...document.querySelectorAll('.sidebar__group')].find((g) => (g.querySelector('.sidebar__group__label')?.textContent || '').trim() === '今天');
      if (!todayGroup) return false;
      let el = todayGroup.nextElementSibling;
      while (el && !el.classList.contains('sidebar__group')) {
        if (el.classList.contains('session-card') && ((el.querySelector('.session-card__name')?.innerText ?? '').trim() === ${JSON.stringify(pinObj.firstCardName)})) return true;
        el = el.nextElementSibling;
      }
      return false;
    })()`), 10);
    // 4) 删除收尾：点卡删除 × → InteractionPrompt confirm（kind='confirm'，danger 选项「删除」）
    //    → 程序化 dblclick 提交（InteractionOptionList @dblclick emit submit——单选形态双击直提路径）。
    //    删除成功判定走权威状态位：pinia sessions 不再含 wqpSessionId。
    wsaDeletedName = wqpSessionName;
    const delClicked = await evalExpr(ws, `(() => {
      const card = document.querySelector('.session-card.active');
      const btn = card && card.querySelector('.session-card__delete');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (delClicked !== true) throw new Error('未点到卡片删除钮（.session-card__delete）');
    await waitFor('W-sidebar-actions：删除确认弹窗出现', () => evalOk(ws, `!!document.querySelector('.interaction-option--danger')`), 10);
    const optText = await evalExpr(ws, `document.querySelector('.interaction-option--danger')?.textContent ?? ''`);
    if (!(String(optText) || '').includes('删除')) throw new Error(`danger 选项非「删除」（text=${String(optText).slice(0, 40)}）`);
    const submitted = await evalExpr(ws, `(() => {
      const opt = document.querySelector('.interaction-option--danger');
      opt.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      return true;
    })()`);
    if (submitted !== true) throw new Error('双击「删除」danger 选项提交失败');
    await waitFor('W-sidebar-actions：会话从列表移除（pinia sessions 无该 id）', () => evalOk(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st ? !(st.sessions || []).some((s) => s.id === ${JSON.stringify(wqpSessionId)}) : false;
    })()`), 15);
    await waitFor('W-sidebar-actions：置顶组无残留', () => evalOk(ws, `[...document.querySelectorAll('.sidebar__group .sidebar__group__label')].every((l) => (l.textContent || '').trim() !== '置顶')`), 10);
    wqpSessionId = '';
    wqpSessionName = '';
    if (exceptions.length > exceptionsBeforeS) throw new Error('W-sidebar-actions 用例期间出现 exceptionThrown');
    record('W-sidebar-actions', 'PASS', `卡片置顶（首分组头「置顶」+ 组内首卡=active 卡 ${pinObj.firstCardName} + pin-mark）→ 取消置顶（组头/pin-mark 退场，卡回「今天」日期组）→ 删除收尾（InteractionPrompt「删除」danger 双击提交，pinia sessions 无该 id、置顶组无残留）；删除会话=${wsaDeletedName}（用例自建物化卡）`);
  } catch (e) { record('W-sidebar-actions', 'FAIL', e.message); }
  await screenshot(ws, 'W-sidebar-actions');

  // ── W-sidebar-collapse：侧栏折叠/展开 DOM 断言（UI13-P12；T12-D）──
  // P4 实现事实（AppSidebar.vue/AppLayout.vue）：折叠钮 button[title="折叠侧栏"] → 根类 .sidebar--collapsed
  // + 窄轨 .sidebar__rail（48px，含展开钮/新建会话入口）v-if 顶替展开态主体；拖宽手柄
  // .resize-handle--sidebar 为 AppLayout v-if 门控——折叠态从 DOM 移除（比 01 设想的
  // display:none 更强，断言「手柄不在 DOM」等价且严格）。
  currentCase = 'W-sidebar-collapse';
  try {
    const exceptionsBeforeC = exceptions.length;
    await ensureLanBridge(ws, 'W-sidebar-collapse');
    // 1) 折叠。
    const collapseClicked = await evalExpr(ws, `(() => {
      const btn = document.querySelector('button[title="折叠侧栏"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (collapseClicked !== true) throw new Error('未找到侧栏折叠钮（button[title="折叠侧栏"]）');
    await waitFor('W-sidebar-collapse：折叠态根类在位', () => evalOk(ws, `!!document.querySelector('.sidebar--collapsed')`), 10);
    const collapsedState = await evalExpr(ws, `(() => {
      const aside = document.querySelector('.sidebar');
      return JSON.stringify({
        width: aside ? aside.offsetWidth : -1,
        hasRail: !!document.querySelector('.sidebar__rail'),
        hasExpand: !!document.querySelector('.sidebar__rail__expand'),
        hasNew: !!document.querySelector('.sidebar__rail__new'),
        handleGone: !document.querySelector('.resize-handle--sidebar'),
      });
    })()`);
    const cObj = JSON.parse(String(collapsedState));
    if (cObj.width < 0 || cObj.width > 80) throw new Error(`折叠态侧栏宽度 ${cObj.width}px 超出窄轨阈值（≤80px，实现 48px）`);
    if (cObj.hasRail !== true || cObj.hasExpand !== true || cObj.hasNew !== true) {
      throw new Error(`折叠窄轨组件缺失（rail=${cObj.hasRail} 展开钮=${cObj.hasExpand} 新建入口=${cObj.hasNew}）`);
    }
    if (cObj.handleGone !== true) throw new Error('折叠态拖宽手柄 .resize-handle--sidebar 仍在 DOM（P4 v-if 门控失效）');
    await screenshot(ws, 'W-sidebar-collapse-collapsed');
    // 2) 展开：窄轨「»」展开钮 → .sidebar 恢复全宽 + 手柄回归 DOM。
    const expandClicked = await evalExpr(ws, `(() => {
      const btn = document.querySelector('.sidebar__rail__expand');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (expandClicked !== true) throw new Error('未找到窄轨展开钮（.sidebar__rail__expand）');
    await waitFor('W-sidebar-collapse：展开态恢复', () => evalOk(ws, `!document.querySelector('.sidebar--collapsed') && !!document.querySelector('.sidebar__footer')`), 10);
    const expandedState = await evalExpr(ws, `(() => {
      const aside = document.querySelector('.sidebar');
      return JSON.stringify({ width: aside ? aside.offsetWidth : -1, handleBack: !!document.querySelector('.resize-handle--sidebar') });
    })()`);
    const eObj = JSON.parse(String(expandedState));
    if (eObj.width <= 100) throw new Error(`展开态侧栏宽度 ${eObj.width}px 未恢复全宽`);
    if (eObj.handleBack !== true) throw new Error('展开后拖宽手柄未回归 DOM');
    if (exceptions.length > exceptionsBeforeC) throw new Error('W-sidebar-collapse 用例期间出现 exceptionThrown');
    record('W-sidebar-collapse', 'PASS', `折叠（.sidebar--collapsed + 窄轨 ${cObj.width}px + 展开钮/新建入口在位 + 手柄 v-if 移除）→ 展开（全宽 ${eObj.width}px 恢复 + 手柄回归）`);
  } catch (e) { record('W-sidebar-collapse', 'FAIL', e.message); }
  await screenshot(ws, 'W-sidebar-collapse');

  // ── W-user-timestamp：用户气泡「你 · 发送于」caption 两向断言（UI13-P12；T12-E）──
  // 物化路径：materializeSession 复用（新会话发 e2e-p5-timestamp 前缀消息——发送即渲染 user 气泡，
  // helper 内已完成 assistant 终态等待）；断言最后一张 user wrap 的 caption 形态 + 气泡内无「发送于」
  // 脚本（双向）；收尾删除自建物化会话。
  currentCase = 'W-user-timestamp';
  try {
    const exceptionsBeforeT = exceptions.length;
    await ensureLanBridge(ws, 'W-user-timestamp');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    const msgText = 'e2e-p5-timestamp：请只回复数字 42,不要使用任何工具';
    const mat = await materializeSession(ws, 'W-user-timestamp', msgText);
    const capState = await evalExpr(ws, `(() => {
      const wraps = [...document.querySelectorAll('.bubble-wrap--user')];
      const last = wraps[wraps.length - 1];
      if (!last) return JSON.stringify({ hasWrap: false });
      const cap = last.querySelector('.bubble-caption');
      const bubble = last.querySelector('.bubble');
      return JSON.stringify({
        hasWrap: true,
        hasCaption: !!cap,
        capText: cap ? (cap.textContent || '').trim() : '',
        bubbleHasFootnote: bubble ? (bubble.textContent || '').includes('发送于') : null,
      });
    })()`);
    const capObj = JSON.parse(String(capState));
    if (capObj.hasWrap !== true) throw new Error('页面无 .bubble-wrap--user（物化消息未渲染 user 气泡）');
    if (capObj.hasCaption !== true) throw new Error('user 气泡下方无 .bubble-caption（P5 caption 未渲染）');
    if (!/你 · 发送于 \d{1,2}:\d{2}/.test(String(capObj.capText))) {
      throw new Error(`caption 文本不符（期望「你 · 发送于 HH:mm」，实际「${String(capObj.capText).slice(0, 60)}」）`);
    }
    if (capObj.bubbleHasFootnote !== false) {
      throw new Error(`气泡内仍含「发送于」脚注（双向断言负向失败，bubbleHasFootnote=${capObj.bubbleHasFootnote}）`);
    }
    if (exceptions.length > exceptionsBeforeT) throw new Error('W-user-timestamp 用例期间出现 exceptionThrown');
    record('W-user-timestamp', 'PASS', `caption 两向断言 OK（「${capObj.capText}」匹配 /你 · 发送于 \\d{1,2}:\\d{2}/；气泡内无「发送于」）；会话=${mat.sessionName}`);
    await screenshot(ws, 'W-user-timestamp');
    // 善后：删除自建物化会话（不污染真实会话列表）。
    const cleaned = await deleteActiveSessionViaStore(ws);
    log(`  W-user-timestamp 测试会话删除请求${cleaned ? '已发（善后）' : '失败（遗留人工清理）'}`);
    await screenshot(ws, 'W-user-timestamp-cleaned');
  } catch (e) { record('W-user-timestamp', 'FAIL', e.message); await screenshot(ws, 'W-user-timestamp-failed'); }

  // ── 终审前清理块（P12 增）：B3 条件保留的会话（干净 profile 时供 B4-B6/W-changes-panel 消费）
  // 在此按 id 删除收尾——E2E 不留垃圾会话（隔离/真实 profile 同纪律）。保留前提消失（已删/不在
  // 列表）时为 no-op。不 record（非断言用例，仅善后）；清理失败只 log 不影响退出码。
  currentCase = '(cleanup)';
  if (b3SessionId) {
    try {
      const exists = await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        return st ? (st.sessions || []).some((s) => s.id === ${JSON.stringify(b3SessionId)}) : false;
      })()`);
      if (exists === true) {
        await evalExpr(ws, `(() => {
          const app = document.querySelector('#app');
          const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
          const st = pinia && pinia._s ? pinia._s.get('session') : null;
          if (st) { void st.deleteSession(${JSON.stringify(b3SessionId)}); return true; }
          return false;
        })()`);
        await waitFor('清理：B3 保留会话从列表移除', () => evalOk(ws, `(() => {
          const app = document.querySelector('#app');
          const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
          const st = pinia && pinia._s ? pinia._s.get('session') : null;
          return st ? !(st.sessions || []).some((s) => s.id === ${JSON.stringify(b3SessionId)}) : true;
        })()`), 10);
        log('  终审前清理：B3 保留会话已按 id 删除');
      } else {
        log('  终审前清理：B3 保留会话已不在列表（B3 善后已删，no-op）');
      }
    } catch (e) { log(`  终审前清理失败（遗留人工清理）：${String(e.message).slice(0, 120)}`); }
  }
  await screenshot(ws, 'cleanup-final');

  // ── 全程异常终审（console error 即 FAIL；exceptionThrown 即 FAIL）──
  currentCase = '(final)';
  if (exceptions.length > 0) {
    record('X-exception', 'FAIL', `全程 exceptionThrown ${exceptions.length} 条：` + exceptions.map((x) => `[${x.case}] ${String(x.text).slice(0, 160)}`).join(' | '));
  }
  if (consoleErrors.length > 0) {
    record('X-console-error', 'FAIL', `全程 console.error ${consoleErrors.length} 条：` + consoleErrors.map((x) => `[${x.case}] ${String(x.text).slice(0, 160)}`).join(' | '));
  }

  // ── 汇总 ──
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  log('==== B1-B8 + W-changes-panel + W-mcp-settings + W-queue-panel + W-sidebar-actions + W-sidebar-collapse + W-user-timestamp 汇总 ====');
  for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
  log(`PASS ${results.filter((r) => r.status === 'PASS').length} / FAIL ${failCount} / SKIP ${skipCount}（证据目录 ${SHOT_DIR}）`);
  flushLog();
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`[前置条件不满足] ${sanitize(e.message)}`);
    console.error('请按脚本头注释准备环境：应用（8790）+ Chrome headless（9224）。');
    flushLog();
    process.exit(2);
  }
  console.error(`[运行错误] ${sanitize(e?.stack || e)}`);
  flushLog();
  process.exit(1);
});
