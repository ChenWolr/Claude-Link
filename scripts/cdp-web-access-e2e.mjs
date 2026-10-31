// scripts/cdp-web-access-e2e.mjs
// 「网页访问」浏览器图形级 E2E（P0-6b / 计划 §3-6b，B1-B8；2026-10-26 增 W-changes-panel：web 端改动面板；
// 2026-10-30 增 W-mcp-settings：web 端设置 → MCP tab 渲染 + 协议级双探针，只读不写配置）。
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
//   - exit 0：B1-B7 全 PASS + B8 PASS 或 SKIP（SKIP 必须带原因，单独汇总列出）+ W-changes-panel PASS + W-mcp-settings PASS。
//   - exit 1：任一 B1-B8 / W-changes-panel / W-mcp-settings 断言失败 / 截图失败（*-shot 记账）/ 出现渲染层异常（exceptionThrown 或 console error）。
//   - exit 2：前置条件不满足（Chrome 9224 / 应用 8790 / 配置 token 不可用）。--config 未指定时读 %APPDATA%/claude-link/claude-link-config.json。
//
// 技术纪律（用户约束）：纯 CDP 原生（Input/Runtime/Network/Page），不依赖 computer-use 等 skill。
// 证据落盘：docs/reports/web-e2e-screenshots/B*.png、W-changes-panel.png、W-mcp-settings.png + 同目录 run-B1-B8.log。
// 敏感纪律：token 从 %APPDATA%/claude-link/claude-link-config.json 顶层键 webAccessToken 读取
// （--config 指定时为该路径，隔离 profile 用），一切输出（含 URL 日志）掩码为前 4 后 4。

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

// ── 主流程 ──
async function main() {
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
    b3SessionName = await evalExpr(ws, `document.querySelector('.session-link.active .session-link__name')?.innerText ?? ''`) || '';
    record('B3', 'PASS', `发送→流式 DOM 增长 ${growths} 次、text_delta 帧 ${textDeltaCount} 条、chat:event 回帧 ${chatEventCount} 条(≥2)→终态含 42；工作空间=${wsPicked ? '菜单选择' : 'pinia兜底'}；口径:增长≥1+text_delta≥1+chat:event≥2(计数稳定性裁定见报告)`);
    // F5（截图顺序修正）：断言通过、终态（含 42 的回合完成态）在屏即截——B3.png 必须对应
    // 回合完成态，先于下方善后 deleteSession。
    await screenshot(ws, 'B3');
    // 善后：删除本用例物化的测试会话（经 store deleteSession，避免污染真实会话列表）
    try {
      await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const st = pinia && pinia._s ? pinia._s.get('session') : null;
        const id = st?.activeSession?.id;
        if (st && id) { void st.deleteSession(id); return true; }
        return false;
      })()`);
      log('  B3 测试会话已请求删除（善后）');
    } catch { log('  B3 测试会话删除失败（不影响断言，遗留人工清理）'); }
    // 善后删除后的界面状态（可选留证，非 B3 主证据）。
    await screenshot(ws, 'B3-cleaned');
  } catch (e) { record('B3', 'FAIL', e.message); await screenshot(ws, 'B3-failed'); }

  // ── B4：切换历史会话 → 历史消息渲染（迭代若干候选，找到有消息的会话）──
  currentCase = 'B4';
  try {
    let switched = '';
    const candidates = await evalExpr(ws, `[...document.querySelectorAll('.session-link')].filter((l) => !l.classList.contains('active')).slice(0, 10).map((l) => l.querySelector('.session-link__name')?.innerText ?? '')`);
    if (!Array.isArray(candidates) || candidates.length === 0) throw new Error('侧栏无可切换的历史会话');
    for (const name of candidates) {
      await evalExpr(ws, `[...document.querySelectorAll('.session-link')].find((l) => l.querySelector('.session-link__name')?.innerText === ${JSON.stringify(name)})?.click(), true`);
      const activated = await waitFor(`切换到「${name}」激活`, () => evalOk(ws, `document.querySelector('.session-link.active .session-link__name')?.innerText === ${JSON.stringify(name)}`), 10).then(() => true).catch(() => false);
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
    await waitFor('刷新后 active 会话恢复', () => evalOk(ws, `document.querySelector('.session-link.active .session-link__name')?.innerText === ${JSON.stringify(b3SessionName)}`), 20);
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
          const link = [...document.querySelectorAll('.session-link')].find((l) => l.querySelector('.session-link__name')?.innerText === hit.name);
          if (link) link.click();
        }
        return hit.name;
      }
      return '';
    })()`);
    if (targetSessionName) {
      await waitFor(`W 前置：会话「${targetSessionName}」激活`, () => evalOk(ws, `document.querySelector('.session-link.active .session-link__name')?.innerText === ${JSON.stringify(targetSessionName)}`), 10)
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
  log('==== B1-B8 + W-changes-panel + W-mcp-settings 汇总 ====');
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
