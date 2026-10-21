// scripts/cdp-web-access-e2e.mjs
// 「网页访问」浏览器图形级 E2E（P0-6b / 计划 §3-6b，B1-B8）。
//
// 用法（编排器/复现者手动准备环境，脚本只做断言）：
//   1. npm run build && npx electron . --remote-debugging-port=9223   （应用运行，8790 监听）
//   2. 启动 Chrome headless（Chrome 可执行路径按本机安装位置准备，或自行为命令赋值；
//      user-data-dir 自选临时目录）：
//      "<Chrome 可执行路径>" --headless=new --remote-debugging-port=9224 ^
//        --user-data-dir=<自选临时目录> --no-first-run --no-default-browser-check about:blank
//   3. npm run test:cdp:web-access
//
// 退出协议：
//   - exit 0：B1-B7 全 PASS + B8 PASS 或 SKIP（SKIP 必须带原因，单独汇总列出）。
//   - exit 1：任一 B1-B8 断言失败 / 截图失败（*-shot 记账）/ 出现渲染层异常（exceptionThrown 或 console error）。
//   - exit 2：前置条件不满足（Chrome 9224 / 应用 8790 / 配置 token 不可用）。
//
// 技术纪律（用户约束）：纯 CDP 原生（Input/Runtime/Network/Page），不依赖 computer-use 等 skill。
// 证据落盘：docs/reports/web-e2e-screenshots/B*.png + 同目录 run-B1-B8.log。
// 敏感纪律：token 从 %APPDATA%/claude-link/claude-link-config.json 顶层键 webAccessToken 读取，
// 一切输出（含 URL 日志）掩码为前 4 后 4。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHROME_CDP_PORT = 9224;
const CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
const SHOT_DIR = path.resolve('docs/reports/web-e2e-screenshots');
const LOG_PATH = path.join(SHOT_DIR, 'run-B1-B8.log');
const E2E_MESSAGE_TEXT = '请只回复数字 42,不要使用任何工具';

// 本机网卡事实程序派生（F10 脱敏：源码不硬编码任何本机 IP；--lan-ip/--ts-ip 覆盖优先不变）：
//   LAN 默认 = node:os networkInterfaces() 首个非 internal 且非 CGNAT 段的 IPv4（常规私网，
//             与计划「主战场=局域网 IP」一致；100.64/10 段留给 TS）；
//   TS  默认 = 100.64.0.0/10 CGNAT 段内的 IPv4（Tailscale 网卡地址段），无则 null
//             （null 且无 --ts-ip 时 B8 记 SKIP「未发现 Tailscale 网卡」）。
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
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
  log('==== B1-B8 汇总 ====');
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
