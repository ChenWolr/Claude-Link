// scripts/cdp-web-access-e2e.mjs
// 「网页访问」浏览器图形级 E2E（P0-6b / 计划 §3-6b，B1-B8；2026-10-26 增 W-changes-panel：web 端改动面板；
// 2026-10-30 增 W-mcp-settings：web 端设置 → MCP tab 渲染 + 协议级双探针，只读不写配置；
// 2026-11-14 UI13-P12 增四个 W 用例：W-queue-panel（队列面板 + getQueueOverview 回包形状 + tasks_changed
// 帧级证据含 T12-H 帧时序）/ W-sidebar-actions（卡片置顶→取消→删除收尾）/ W-sidebar-collapse（侧栏折叠展开
// DOM 断言）/ W-user-timestamp（用户气泡「你 · 发送于」caption 两向断言）。
// 2026-11-16 八问题批次 T1B 增 13 个 W 场景（03b §1/§4/§7/§8/§11/§12/§13 + 03 §5 E2-06）：
//   W-dev-stale-banner（D2-3 dev 横幅五步）/ W-mcp-scan（E1-5 扫描钮+零写入只读纪律）/
//   W-skill-refresh-web（E5-2 全局刷新 busy→复位）/ W-mcp-external-change（E2-06 外部改 .mcp.json →
//   MCP tab 重拉可见）/ W-collapse-persist（D1-4 折叠+宽度 localStorage 持久化三步）/
//   W-queue-restore-countdown（T1R-1 倒计时刷新→恢复门→发送=入队，含 A2-3/A2-4/A3-3）/
//   W-queue-restore-running（T1R-2 running 刷新→发送=入队 + A2-4）/ W-queue-restore-standby（T1R-3
//   standby 发送=直发）/ W-turn-footnote（F1-2a 成功正文+F1-2b 工具结尾+F1-3 仅最新回合）/
//   W-question-sidenav / W-question-guard / W-question-submit / W-question-single（C1-14 四场景；
//   夹具=interaction store 注入真实 AskUserQuestion payload 形状 + respondInteraction 页内 stub，
//   见各场景头注与 t1b 点报告降级申报）。
//
// 用法（两种模式，2026-11-16 T1B 闸门修复重构）：
//
//   ① 裸跑（默认，闸门形态 `npm run test:cdp:web-access` / `node scripts/cdp-web-access-e2e.mjs`）：
//      自举隔离环境（ISO 模式）——脚本自行完成：构建新鲜度检查（src 比 out/renderer 新才重建）→
//      隔离 profile seed（读 %APPDATA% 真实配置为底稿，只改 webAccess.port=空闲端口(8791+)、
//      workingDirectory=<ISO 夹具目录>、permissionMode=bypassPermissions 三项，落 <ISO>/app/claude-link-config.json，
//      全程不写真实配置）→ 拉起 electron（--user-data-dir=<ISO>/app，electron-store 随 userData 隔离，
//      单实例锁按 userData 不与真实实例冲突）→ 拉起 headless Chrome（9224，--user-data-dir=<ISO>/chrome）→
//      跑套件 → 按 PID taskkill /T /F 收口 + rmSync <ISO> 整目录（用后删除，AGENTS.md 隔离纪律）。
//      先例：scripts/cdp-update-e2e.mjs 的 ISO_DIR 自举做法（仓库 AGENTS.md 认可）。
//
//   ② 外部备环境跑（--config 指定时，行为与旧版完全一致，脚本只做断言不做拉起）：
//      1. npm run build && npx electron . --remote-debugging-port=9223   （应用运行，8790 监听）
//      2. 启动 Chrome headless（Chrome 可执行路径按本机安装位置准备，或自行为命令赋值；
//         user-data-dir 自选临时目录）：
//         "<Chrome 可执行路径>" --headless=new --remote-debugging-port=9224 ^
//           --user-data-dir=<自选临时目录> --no-first-run --no-default-browser-check about:blank
//      3. node scripts/cdp-web-access-e2e.mjs --config <临时目录>/claude-link-config.json
//
// 退出协议：
//   - exit 0：B1-B7 全 PASS + B8 PASS 或 SKIP（SKIP 必须带原因，单独汇总列出）+ W-changes-panel PASS + W-mcp-settings PASS
//             + W-queue-panel PASS + W-sidebar-actions PASS + W-sidebar-collapse PASS + W-user-timestamp PASS
//             + W-file-context-menu PASS（P6-B 2026-11-21 增：md-file-link 右键菜单 web 同款）
//             + 八问题批次 T1B 的 13 个 W 场景（W-dev-stale-banner / W-mcp-scan / W-skill-refresh-web /
//             W-mcp-external-change / W-collapse-persist / W-queue-restore-{countdown,running,standby} /
//             W-turn-footnote / W-question-{sidenav,guard,submit,single}）全 PASS 或带理由 SKIP
//             （W-queue-restore-countdown-gate-sample / W-turn-footnote-tooltail 为采样降级/夹具降级的
//             附属记账条目，SKIP 必须带原因；SKIP 汇总单独列出）。
//   - exit 1：任一 B1-B8 / W-* / 上述 13 个 T1B 场景断言失败 / 截图失败（*-shot 记账）/ 出现渲染层异常
//             （exceptionThrown 或 console error）。
//   - exit 2：前置条件不满足。外部备环境跑（--config）下同旧版：Chrome 9224 / 应用 8790 / 配置 token
//             不可用，或实例新鲜度校验不通过（P3-B：未构建 / 实例未起 / 监听进程启动时间不可读 / 实例过旧
//             ——PORT 逐个校验全部 LISTENING PID，任一 PID 启动时间 ≥ out/renderer mtime 即放行，全部 PID
//             过旧（或启动时间均不可读）即判不通过，防「遗留实例 × 重建后 hash 轮换」缓存投毒假红）。
//             裸跑（ISO 模式）下 exit 2 仅剩：真实配置缺 webAccessToken / 构建失败 / electron 或 Chrome
//             拉起后端口迟迟不监听 / 9224 已被外部进程占用（防复用污染）——实例由脚本自行拉起，
//             新鲜度校验对自举实例恒真（启动时间晚于构建）。
//             --config 未指定时真实配置底稿读 %APPDATA%/claude-link/claude-link-config.json（只读，
//             写入全部落在 ISO 目录）。
//
// 技术纪律（用户约束）：纯 CDP 原生（Input/Runtime/Network/Page），不依赖 computer-use 等 skill。
// 证据落盘：docs/reports/web-e2e-screenshots/B*.png、W-changes-panel.png、W-mcp-settings.png、
//           W-queue-panel*.png、W-sidebar-actions*.png、W-sidebar-collapse*.png、W-user-timestamp*.png、
//           T1B 新场景同目录 W-dev-stale-banner*.png / W-mcp-scan*.png / W-skill-refresh-web*.png /
//           W-mcp-external-change*.png / W-collapse-persist*.png / W-queue-restore-*.png /
//           W-turn-footnote*.png / W-question-*.png + 同目录 run-B1-B8.log。
// 敏感纪律：token 从 %APPDATA%/claude-link/claude-link-config.json 顶层键 webAccessToken 读取
// （--config 指定时为该路径，隔离 profile 用），一切输出（含 URL 日志）掩码为前 4 后 4。

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

// CLI 参数读取（--k v）——必须在 CONFIG_PATH 之前定义：CONFIG_PATH 经 argOf('--config') 求值，
// 而 const 箭头函数不提升（原先定义在文件靠下，移到此处以满足求值顺序；调用形态不变）。
const argOf = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };

const CHROME_CDP_PORT = 9224;
// 配置路径可覆盖（--config）：E2E 必须在隔离 --user-data-dir 上跑（仓库 AGENTS.md：不得写用户
// 真实配置），隔离实例的配置与 token 都在隔离目录里，故需能把配置路径指过去。
// 未指定 --config 时仍读 %APPDATA%/claude-link/claude-link-config.json（默认行为不变）。
const DEFAULT_CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
// ISO 模式（裸跑默认）：未指定 --config 时自举隔离环境（拉实例+seed 配置）；--config 指定时保持旧版
// 「外部备环境、脚本只断言」行为（2026-11-16 T1B 闸门修复，见头注释用法①）。
const ISO_MODE = !process.argv.includes('--config');
let CONFIG_PATH = argOf('--config', DEFAULT_CONFIG_PATH);
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
// ISO 模式下这三个值先按真实配置读出（仅作缺 token 早探），自举 seed 落盘后在 ensureIsoEnvironment()
// 内整体重派生指向 ISO seed（CONFIG_PATH/rawConfig/PORT/TOKEN 三者必须同源同轮更新，防半新半旧）。
let rawConfig;
try { rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawConfig = null; }
let PORT = rawConfig?.webAccess?.port ?? 8790;
let TOKEN = typeof rawConfig?.webAccessToken === 'string' ? rawConfig.webAccessToken : '';
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
// T1B（2026-11-16）：套件增至 13 个 W 场景后含 3 次真实队列倒计时窗（taskDelayMinutes=1 → 60s/窗）
// 与多个真实回合，600s 预算不够——提高到 1200s（申报见 t1b 点报告）。
const TOTAL_TIMEOUT_MS = 1_200_000;
// T1B 闸门修复（2026-11-16）：ISO 自举可能含一次构建（分钟级），不应挤占套件预算——总看门狗改为
// armSuiteWatchdog() 延迟武装（ISO 模式在 ensureIsoEnvironment() 成功后、外部备环境模式维持模块加载即武装，
// 与旧版行为一致）；自举自身由 BOOTSTRAP_TIMEOUT_MS 独立兜底（挂死 exit 2，见 ensureIsoEnvironment）。
function armSuiteWatchdog() {
  const totalTimer = setTimeout(() => {
    log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，脚本自杀退出（防挂死）`);
    log('==== 超时时刻已完成的用例汇总 ====');
    for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
    flushLog();
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);
  totalTimer.unref();
}
const BOOTSTRAP_TIMEOUT_MS = 900_000; // 自举（含可选构建）上限 15 分钟，超时 exit 2（前置条件不满足）
if (!ISO_MODE) armSuiteWatchdog();

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
// ── Page.loadEventFired 计数（P24 修复的刷新完成事件源；Page.enable 于主 ws 连接后即启用，
// reload/导航每次完成加载各递增一次——waitReloadComplete 以「计数越过发送前基线」判定刷新完成）──
const pageLoadTicks = { count: 0 };

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
// 唤醒回合终态等待·上游瞬态单次重试包装（p5c r6c 门禁 a2-4 假红根因处置）：唤醒回合落入
// 「上游服务暂时不可达，正在自动重试」梯（失败截图证据：第 3/10 次·连接异常、正在回复 2:01），
// 120s 终态截止在重试梯内到期 → 终态空文本假红；紧随其后的 standby 场景 24s 即绿（上游已恢复）。
// 处置=flaky 换稳定断言（断言语义零变化：终态仍须 assistant 含「42」+ 流式组退场），仅对
// 「唤醒回合未达终态」这一上游瞬态形态重试一次（同 W-turn-footnote「首试未达 → 重发一次」先例），
// 重试前中断在飞回合 + 删除失败会话（防残留重试梯污染后续场景）；其余失败（会话卡超时等）
// 原样上抛不重试。
async function materializeSession(ws, label, messageText) {
  try {
    return await materializeSessionOnce(ws, label, messageText);
  } catch (e) {
    if (!String((e && e.message) || '').includes('assistant 终态不含「42」')) throw e;
    log(`  ${label}：唤醒回合首试未达终态（${String((e && e.message) || '').slice(0, 72)}）——按上游瞬态不可达处置：中断+删会话后重试一次`);
    try {
      const sid = await activeSessionId(ws);
      if (sid) {
        await evalExpr(ws, `window.claudeLink.abortChat(${JSON.stringify(sid)}).then(() => true)`).catch(() => {});
        await waitTurnSettled(ws, `${label} 重试前善后`, 30);
      }
    } catch { /* 善后尽力而为：中断失败不阻塞重试路径 */ }
    await deleteActiveSessionViaStore(ws);
    return await materializeSessionOnce(ws, label, messageText);
  }
}
async function materializeSessionOnce(ws, label, messageText) {
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
  // F-r1-8（flow P2-2，2026-11-22）根修：终态口径补②落账——「末 assistant 气泡含 .bubble__meta
  // （②在场，result 落账渲染）」。原口径「42 文本 + 无 .stream-group」可先于 result 落账满足
  // （DOM 先至），紧随其后的 W-user-timestamp 断言在 ② 渲染前取态即假红（审查岗截图证实其时
  // ② 0:10 时钟格式正确在场——取态过早而非渲染缺陷）。影响面核对（materializeSession 全部
  // 7 调用点逐一核对，结论：无任何场景刻意在 ② 落账前取态，根修零反向破坏——
  //   · W-queue-panel(:1662)：其后仅读 getQueueOverview 回包形状，与 ② 无关；
  //   · W-user-timestamp(:1947)：本发现修复目标，直接受益；
  //   · W-queue-restore-countdown(:2376)：其后自带 pollOverview(standby) 30s 轮询收口（本就为
  //     消化 DOM-vs-主进程竞态），根修使取态更贴近 result 落账，轮询断言语义不变；
  //   · W-queue-restore-running(:2519)：其后 pollOverview(running)，同上；
  //   · W-queue-restore-running-a2-4(:2609)：其后 waitTurnSettled 收口，同上；
  //   · W-queue-restore-standby(:2680)：其后 pollOverview(standby) 收口，同上；
  //   · W-turn-footnote(:2754)：其后自带 sleep(1200)+②在场断言（同族竞态防护），根修只提前
  //     ② 在场时刻，断言语义不变）。
  // 备选最小修（仅 W-user-timestamp 场景内 waitFor ②在场）未采用——根修消除的是共享夹具的
  // 口径缺口，姊妹场景同受益，且无调用点需要旧行为。超时兜底复核见循环后 metaOk 检查。
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (Date.now() > deadline) break;
    const done = await evalExpr(ws, `(() => {
      const bubbles = document.querySelectorAll('.bubble--assistant');
      const last = bubbles[bubbles.length - 1];
      return !!(last && (last.innerText || '').includes('42') && last.querySelector('.bubble__meta')) && !document.querySelector('.stream-group');
    })()`);
    if (done === true) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  const finalText = await evalExpr(ws, `(() => {
    const b = document.querySelectorAll('.bubble--assistant');
    return b.length ? (b[b.length - 1].innerText || '') : '';
  })()`);
  if (!finalText.includes('42')) throw new Error(`${label}：assistant 终态不含「42」（text=${finalText.slice(0, 80)}）`);
  // F-r1-8：终态口径含②落账——超时兜底复核（42 在而 ② 缺 = result 落账未完成，如实上抛；
  // 错误文案不含「42」子串，不入上游瞬态重试包装——②缺非上游不可达形态）。
  const metaOk = await evalExpr(ws, `(() => {
    const b = document.querySelectorAll('.bubble--assistant');
    const last = b[b.length - 1];
    return !!(last && last.querySelector('.bubble__meta'));
  })()`);
  if (metaOk !== true) throw new Error(`${label}：assistant 终态 ② 未落账（末气泡缺 .bubble__meta——result 落账未完成，F-r1-8 终态口径）`);
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

// ── 八问题批次 T1B W 用例共用辅助（2026-11-16；形态沿用既有 W 辅助与 pinia 直读惯例）──
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// pinia session store 直读权威状态位（既有用例同款形态，提炼复用）。
async function activeSessionId(ws) {
  return evalExpr(ws, `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    const st = pinia && pinia._s ? pinia._s.get('session') : null;
    return st?.activeSession?.id ?? '';
  })()`);
}
// 队列权威快照（A2/A3 状态源=主进程权威快照；经 web 桥真实通道取回）。
async function queueOverview(ws, sid) {
  const raw = await evalExpr(ws, `window.claudeLink.getQueueOverview(${JSON.stringify(sid)}).then((r) => JSON.stringify(r))`);
  return JSON.parse(String(raw));
}
// 轮询主进程权威快照至谓词成立（返回首份满足的快照；超时抛 waitFor 风格错误）。
async function pollOverview(ws, sid, label, pred, timeoutS = 90, intervalMs = 400) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await queueOverview(ws, sid);
    try { if (pred(last)) return last; } catch { /* 谓词内部异常按未满足继续轮询 */ }
    await sleep(intervalMs);
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}；末次快照 status=${last?.state?.status} tasks=${(last?.tasks ?? []).length}`);
}
// ChatInput 门态（A3 恢复门断言面：textarea/send 按钮 disabled 权威反射）。
async function chatInputGate(ws) {
  const raw = await evalExpr(ws, `(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    const btn = document.querySelector('[data-testid="chat-send-button"]');
    return JSON.stringify({ hasInput: !!ta, textareaDisabled: ta ? ta.disabled : null, sendDisabled: btn ? btn.disabled : null });
  })()`);
  return JSON.parse(String(raw));
}
// A3 队列状态轻量指示条（queue-status-strip + 文本）。
async function queueStripState(ws) {
  const raw = await evalExpr(ws, `(() => {
    const el = document.querySelector('[data-testid="queue-status-strip"]');
    return JSON.stringify({ present: !!el, text: el ? ((el.querySelector('.queue-strip__text')?.textContent ?? el.textContent) || '').trim() : '' });
  })()`);
  return JSON.parse(String(raw));
}
// ChatPage 即时 notice 横条（入队「已加入队列」反馈；4s 自动消失，须发送后立即轮询）。
async function noticeState(ws) {
  const raw = await evalExpr(ws, `(() => {
    const el = document.querySelector('.notice');
    return JSON.stringify({ present: !!el, text: el ? (el.textContent || '').trim() : '' });
  })()`);
  return JSON.parse(String(raw));
}
async function assistantBubbleCount(ws) {
  return evalExpr(ws, `document.querySelectorAll('.bubble--assistant').length`);
}
async function userBubbleTexts(ws) {
  const raw = await evalExpr(ws, `JSON.stringify([...document.querySelectorAll('.bubble-wrap--user .bubble')].map((b) => (b.innerText || '')))`);
  try { return JSON.parse(String(raw)); } catch { return []; }
}
// ChatInput 填字 + 发送（既有 B3 同款两步，提炼复用）。
async function setChatInput(ws, text) {
  await evalExpr(ws, `(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}
async function clickSend(ws) {
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
}
// 右侧活动面板展开 + 切 queue Tab（W-queue-panel 同款步骤，提炼复用；reload 后 rightTab 重置
// 'all'，任务卡 .task-item 仅在 queue tab 渲染——T1B 队列场景断言任务卡前必走）。
async function openQueuePanelTab(ws, label) {
  await evalExpr(ws, `document.querySelector('.reopen-task-panel')?.click(), true`);
  await waitFor(`${label}：右侧活动面板展开（.rail 在位）`, () => evalOk(ws, `!!document.querySelector('.rail')`), 10);
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
  await waitFor(`${label}：.queue-bar 排队状态条渲染`, () => evalOk(ws, `!!document.querySelector('.queue-bar')`), 10);
}
// 整页刷新完成等待（P24 修复，round-002）：Page.reload 发出后等「本命令引发的
// Page.loadEventFired」（计数越过发送前基线 = 新文档加载完成）再继续——旧实现 reload 发出即返回，
// 导航提交前旧页仍存活，connectedExpr 在预刷新旧页瞬时满足，恢复后断言可能整段落旧页
//（round-001 审查 P24）。导航中 Runtime.evaluate 失败由 waitFor 按未满足继续轮询消化。
async function waitReloadComplete(ws, label) {
  const before = pageLoadTicks.count;
  await cdpSend(ws, 'Page.reload');
  await waitFor(`${label}：刷新完成（Page.loadEventFired）`, () => pageLoadTicks.count > before, 20, 50);
}
// 整页刷新（等刷新完成）+ 桥重连 + chat 路由就绪（B5 同款，提炼复用；hash 路由刷新后保持）。
async function reloadAndReconnect(ws, label) {
  await waitReloadComplete(ws, label);
  await waitFor(`${label}：刷新后桥连接恢复`, () => evalOk(ws, connectedExpr), 30);
  // 路由就绪判定兼容折叠态：折叠持久化（cl.sidebarCollapsed='1'）时展开态 new-button 被
  // v-if 卸载，窄轨 .sidebar__rail__new 是等价的「新建会话」入口（W-collapse-persist 的
  // 折叠保持断言正是走折叠态 reload）。
  await waitFor(`${label}：chat 路由就绪（新建会话入口在位）`, () => evalOk(ws, `!!document.querySelector('button.new-button') || !!document.querySelector('.sidebar__rail__new')`), 15);
}
// 回合收口等待：先等 stream-group 出现（回合真正开跑，≤15s），再等其退场（≤timeoutS），再 500ms 沉降。
async function waitTurnSettled(ws, label, timeoutS = 150) {
  // 起点清零：上一回合的 stream-group 残留在场时先等其退场（防第一段「出现」等待被残留短路、
  // 双段瞬时通过误判终态——run-4 W-turn-footnote 假红根因）。
  await waitFor(`${label}：前序流式组退场（若在场）`, () => evalOk(ws, `!document.querySelector('.stream-group')`), 15);
  // 「回合开跑」等待容忍零流式（单 token 回复整回合可能不渲染 stream-group——run-6 实测）：
  // 15s 内未出现按「无流式回合」继续，终态由退场等待（立即通过）收口。
  await waitFor(`${label}：回合开跑（stream-group 在场）`, () => evalOk(ws, `!!document.querySelector('.stream-group')`), 15)
    .catch(() => log(`  ${label}：15s 未见 stream-group（容忍零流式回合），按退场检测收口`));
  await waitFor(`${label}：回合终态（stream-group 退场）`, () => evalOk(ws, `!document.querySelector('.stream-group')`), timeoutS);
  await sleep(500);
}
// C1-14 夹具注入：interaction store 注入真实 AskUserQuestion payload 形状
//（镜像 sdk-interactions.buildWizardAskUserQuestionPayload / buildAskUserQuestionInteractionPayload
// 的字段形态：kind form、q0..qN、option-N + __other__ 尾部、allowOther/otherLabel），
// 并以页内 stub 接管 window.claudeLink.respondInteraction（记录回包形状、不触主进程——
// store 注入的请求主进程无对应挂起，真实回包会落 unknown-id 路径）。降级申报见 t1b 点报告。
let wizardSeq = 0;
async function injectWizardFixture(ws, { single = false } = {}) {
  // 注入前等旧 overlay 完全退场（上一夹具 cleanup 后 Vue 卸载是异步 patch；旧 overlay 残留时
  // 点击命中的是已卸载组件的 DOM → no-op → 场景假红）。
  await waitFor('注入前旧弹窗退场', () => evalOk(ws, `!document.querySelector('.interaction-overlay')`), 3)
    .catch(() => { /* 无旧弹窗或退场超时（3s）不阻塞——继续注入 */ });
  wizardSeq += 1;
  const rawQ = [
    { title: `e2e-wizard-q${wizardSeq}-a：部署目标环境是？`, options: [{ label: '开发环境' }, { label: '生产环境' }] },
    { title: `e2e-wizard-q${wizardSeq}-b：启用哪些模块？（多选）`, options: [{ label: '认证' }, { label: '日志' }, { label: '缓存' }], multiSelect: true },
    { title: `e2e-wizard-q${wizardSeq}-c：实例名称？`, options: [{ label: '默认实例' }, { label: '自定义实例' }] },
  ];
  const id = `e2e-wizard-${wizardSeq}-${Date.now()}`;
  const payload = single
    ? {
        id, sessionId: '', kind: 'single-choice', source: 'E2E', toolName: 'AskUserQuestion', toolUseId: `e2e-tooluse-${wizardSeq}`,
        title: rawQ[0].title, description: '请选择一个选项，按 Enter 提交。', multiSelect: false, allowOther: true, otherLabel: 'Other', defaultOptionIds: [],
        input: { questionIndex: 0, question: { question: rawQ[0].title, header: 'E2E', options: rawQ[0].options, multiSelect: false } },
        options: [...rawQ[0].options.map((o, j) => ({ id: `option-${j}`, label: o.label, description: '' })), { id: '__other__', label: 'Other', description: '输入自定义答案。' }],
      }
    : {
        id, sessionId: '', kind: 'form', source: 'AskUserQuestion', toolName: 'AskUserQuestion', toolUseId: `e2e-tooluse-${wizardSeq}`,
        title: 'Claude Code 需要你回答 3 个问题', description: '逐题选择，可返回上一步修改答案，最后一次性提交。',
        input: { questions: rawQ.map((x) => ({ question: x.title, header: 'E2E', options: x.options, multiSelect: !!x.multiSelect })) },
        questions: rawQ.map((x, i) => ({
          id: `q${i}`, title: x.title, source: `Q${i + 1}`,
          options: [...x.options.map((o, j) => ({ id: `option-${j}`, label: o.label, description: '' })), { id: '__other__', label: 'Other', description: '输入自定义答案。' }],
          multiSelect: !!x.multiSelect, allowOther: true, otherLabel: 'Other', defaultOptionIds: [],
        })),
      };
  const enqueued = await evalExpr(ws, `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    const ist = pinia && pinia._s ? pinia._s.get('interaction') : null;
    if (!ist) return 'no-store';
    window.__e2eRespondLog = [];
    window.__e2eRespondOrig = window.claudeLink.respondInteraction;
    window.claudeLink.respondInteraction = async (r) => { window.__e2eRespondLog.push(JSON.parse(JSON.stringify(r || {}))); return true; };
    // 夹具对账自洽（run-r6b W-question-sidenav 假红根因）：hb10-PERM-03 的 30s reconcile
    // （InteractionPrompt onMounted setInterval）会把「主进程 getPendingInteractions 不知道的」
    // 非本地请求摘除——而本夹具是 pinia 直注入、绕过 IPC，主进程 pending 列表没有它；tick 恰好
    // 落在场景断言窗内（机器负载大、场景拉长时概率上升）→ 夹具被摘 → overlay 空/nav 缺 →
    // 「wizard 左右分栏缺失」假红。此处登记在注夹具并 stub getPendingInteractions 返回之，
    // reconcile 的 remove/add 两分支均自洽（夹具 id 在 pendingIds → 保留；localIds 已含 → 不重挂）。
    // 善后见 cleanupWizardFixture（登记表清空后还原原实现）。断言语义零变化。
    window.__e2eFixtures = (window.__e2eFixtures || []).filter((p) => p && p.id !== ${JSON.stringify(payload.id)});
    window.__e2eFixtures.push(${JSON.stringify(payload)});
    if (!window.__e2ePendingOrig) {
      window.__e2ePendingOrig = window.claudeLink.getPendingInteractions;
      window.claudeLink.getPendingInteractions = async () => (window.__e2eFixtures || []).slice();
    }
    return ist.enqueueRemote(${JSON.stringify(payload)}) === true ? 'ok' : 'dup';
  })()`);
  if (enqueued !== 'ok') throw new Error(`夹具注入失败（${enqueued}）`);
  await waitFor('wizard/单题弹窗渲染', () => evalOk(ws, `!!document.querySelector('.interaction-overlay')`), 10);
  // 300ms 直提守卫消隐（C2）：上一场景/上一轮点击的 lastDirectSubmitAt 窗口内，紧随的选项点击
  // 会被 wizardToggleOption 吞掉（run-3/4 W-question-guard 假红根因）——注入后统一垫 400ms。
  await sleep(400);
  return payload;
}
// 夹具善后：移除注入请求 + 还原 respondInteraction/getPendingInteractions（幂等；弹窗未关时强制摘除）。
// 对账 stub 的还原以登记表清空为准（多夹具并存时后者仍需对账自洽，见 injectWizardFixture 注）。
async function cleanupWizardFixture(ws, payloadId) {
  try {
    await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const ist = pinia && pinia._s ? pinia._s.get('interaction') : null;
      if (ist) {
        ist.requests = (ist.requests || []).filter((r) => r.id !== ${JSON.stringify(payloadId)});
        if (ist.meta && typeof ist.meta.delete === 'function') ist.meta.delete(${JSON.stringify(payloadId)});
      }
      window.__e2eFixtures = (window.__e2eFixtures || []).filter((p) => p && p.id !== ${JSON.stringify(payloadId)});
      if (window.__e2ePendingOrig && (window.__e2eFixtures || []).length === 0) { window.claudeLink.getPendingInteractions = window.__e2ePendingOrig; window.__e2ePendingOrig = null; }
      if (window.__e2eRespondOrig) { window.claudeLink.respondInteraction = window.__e2eRespondOrig; window.__e2eRespondOrig = null; }
      window.__e2eRespondLog = [];
      return true;
    })()`);
  } catch { /* 善后尽力而为（页面可能已重载，stub 随之消失） */ }
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

// ── ISO 自举（裸跑默认；--config 外部备环境模式不走此路径，2026-11-16 T1B 闸门修复）──
// 背景：闸门命令为裸 `node scripts/cdp-web-access-e2e.mjs`，旧版在此形态下只会校验前置条件（实例未起
// → exit 2），环境靠人工预先准备——闸门环境无人备环境，必红。修复：裸跑时脚本自举隔离环境，
// 先例 = scripts/cdp-update-e2e.mjs 的 ISO_DIR 做法（仓库 AGENTS.md 认可）：自建 userData、按 PID 收口、
// 用后 rmSync。隔离纪律（仓库 AGENTS.md）：真实配置只读不改，一切写入落 ISO 目录。
const ISO_APP_CDP_PORT = 9223; // 套件不直连应用 CDP（只经 Chrome 9224→web 页面→WS 驱动），按惯例仍传给 electron 便于人工排查
// CACHE_ROOT：env 覆盖惯例对齐 cdp-update-e2e.mjs；默认优先 D:\software\Cache（用户级临时文件约定，
// 全局指令：临时文件一律放该目录），目录不存在回落 os.tmpdir()。
const CACHE_ROOT = process.env.CLAUDE_LINK_CACHE_ROOT
  ?? (fs.existsSync('D:/software/Cache') ? 'D:/software/Cache/claude-link-cache' : path.join(os.tmpdir(), 'claude-link-cache'));
const ISO_DIR = path.join(CACHE_ROOT, 'claude-link-web-e2e-iso');
const ISO_APP_DIR = path.join(ISO_DIR, 'app'); // electron --user-data-dir：electron-store 配置随 userData 隔离（config-manager.ts name='claude-link-config'）
const ISO_CHROME_DIR = path.join(ISO_DIR, 'chrome');
const ISO_FIXTURE_DIR = path.join(ISO_DIR, 'fixture'); // seed workingDirectory：E2-06 夹具目录不可知问题的答案（1717 行前置的满足形态）
const ISO_CONFIG_PATH = path.join(ISO_APP_DIR, 'claude-link-config.json');
// p5c（2026-11-20）：翻译上游 stub 日志路径（launchIsoElectron 注入给 electron 子进程；
// W-translate 场景按行数核对请求计数）。--config 外部备环境模式无 stub 注入 → null（W-translate SKIP）。
const TRANSLATE_STUB_LOG = ISO_MODE ? path.join(ISO_DIR, 'translate-stub.jsonl') : null;

let isoElectronProc = null;
let isoChromeProc = null;
let isoCleaned = false;
function isoTeardown() {
  if (isoCleaned) return;
  isoCleaned = true;
  // 按 PID 精确收口（禁按映像名，防误伤用户日常实例——cdp-update-e2e.mjs 同款纪律）。
  for (const [name, proc] of [['electron', isoElectronProc], ['chrome', isoChromeProc]]) {
    if (proc?.pid) {
      try { spawnSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }); log(`  [iso-teardown] ${name} PID ${proc.pid} 已 taskkill /T /F`); } catch { /* 尽力而为 */ }
    }
  }
  try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); log(`  [iso-teardown] 隔离目录已删除：${ISO_DIR}`); } catch (e) { log(`  [iso-teardown] 隔离目录删除失败（申报留人工清理）：${String(e.message).slice(0, 120)}`); }
  try { flushLog(); } catch { /* 尽力而为 */ }
}
if (ISO_MODE) {
  process.on('exit', isoTeardown);
  process.on('SIGINT', () => { isoTeardown(); process.exit(130); });
  process.on('SIGTERM', () => { isoTeardown(); process.exit(143); });
}

function pickFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    const pids = findListenerPids(p);
    if (pids === null) throw new PreconditionError('netstat 校验手段不可用——ISO 自举端口选择无法进行');
    if (pids.length === 0) return p;
  }
  return null;
}

// ── W-translate 夹具落库（p5c，2026-11-20）：ISO 库直插会话 + 三条消息（user/assistant 正文/thinking）──
// 时机：ensureIsoEnvironment 之后、网页驱动之前——app 已完成迁移建表（web 监听已就绪），页面首次
// 拉取会话列表/消息时尚未发生，夹具天然进列表。WAL 多进程写（app 侧 journal_mode=WAL）+ busy_timeout
// 兜底；失败重试 1 次（间隔 300ms）。夹具仅落 ISO 隔离库（随 ISO 目录用后删除）。
async function seedTranslateFixtureDb() {
  const dbPath = path.join(ISO_APP_DIR, 'claude-link.db');
  if (!fs.existsSync(dbPath)) throw new PreconditionError(`W-translate 夹具前置不满足：ISO 库不存在（${dbPath}）——app 迁移未完成？`);
  // better-sqlite3 为 Electron ABI 编译（宿主 Node 直载崩溃）——经 ELECTRON_RUN_AS_NODE + electron
  // 二进制执行插入脚本（与 launchIsoElectron 同一二进制解析）。
  const electronBin = createRequire(import.meta.url)('electron');
  const now = Date.now();
  const sid = `w-translate-fixture-${now}`;
  const script = `
    const Database = require('better-sqlite3');
    const db = new Database(${JSON.stringify(dbPath)});
    db.pragma('busy_timeout = 3000');
    const tx = db.transaction(() => {
      // provider_override → seed 里的 stub 供应商档案（e2e-translate-stub，plain 测试密钥）：
      // 翻译链 resolveTranslationContext 对本会话取该档案密钥过 fail-fast（ISO 实例解不出真实
      // 用户 safeStorage 密钥——二跑修正，详见 seedIsoConfig 注记）；stub transport 拦截 HTTP，
      // 密钥/端点不触任何真实上游。模型不指定（model_override NULL，stub 不消费 model）。
      // working_dir = 仓库根（四跑修正，2026-11-20）：本夹具自 bootstrap 起即在会话列表 → B3
      // 善后「干净 profile」分支失效（列表存在其他持久会话）→ B3 删除自己物化的
      // workingDir=仓库根会话（11-18 r1/r2 era 该会话被保留、W-changes-panel 靠它「列表点选」过
      // isBoundWorkingDir 守卫）→ W-changes-panel 退化 pinia 兜底（渲染层直设，主进程库无绑定）
      // → 改动面板「刷新失败：工作目录不在允许列表」确定性红（run1~4 四跑复现）。夹具会话自带
      // working_dir=仓库根后，B3 删除行为不变，但仓库根绑定由本夹具会话承接（W-changes-panel
      // 「列表点选」路径恢复原样——11-18 PASS 记录同款「会话来源=列表点选」）；本场景自身按名
      // 点卡不受影响，翻译路由仍走 provider_override。
      db.prepare('INSERT INTO sessions (id, name, provider_override, working_dir) VALUES (?, ?, ?, ?)').run(${JSON.stringify(sid)}, 'W-translate-fixture', 'e2e-translate-stub', path.resolve(process.cwd()));
      const ins = db.prepare('INSERT INTO messages (id, session_id, role, content, event_type, cost_usd, duration_ms, ended_at, process_kind, parent_agent_id, tool_use_id, title, is_error, created_at) VALUES (?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, NULL, NULL, 0, ?)');
      ins.run(${JSON.stringify(`wt-u-${now}`)}, ${JSON.stringify(sid)}, 'user', 'W-translate 夹具用户消息', 'message', null, ${JSON.stringify(new Date(now - 2000).toISOString())});
      ins.run(${JSON.stringify(`wt-a-${now}`)}, ${JSON.stringify(sid)}, 'assistant', ${JSON.stringify('W-translate fixture assistant body for the web translation check. '.repeat(12).trim())}, 'message', null, ${JSON.stringify(new Date(now - 1000).toISOString())});
      ins.run(${JSON.stringify(`wt-t-${now}`)}, ${JSON.stringify(sid)}, 'assistant', ${JSON.stringify('W-translate fixture thinking content for the on-demand check. '.repeat(8).trim())}, 'thinking', 'thinking', ${JSON.stringify(new Date(now).toISOString())});
    });
    tx();
    db.close();
    console.log('insert-ok');
  `;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = spawnSync(electronBin, ['-e', script], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true });
    if (r.status === 0 && String(r.stdout).includes('insert-ok')) {
      log(`  [w-translate-fixture] 夹具落库 OK（sid=${sid}，user/assistant/thinking 三条）`);
      return sid;
    }
    const detail = `status=${r.status} out=${String(r.stdout).slice(-160)} err=${String(r.stderr).slice(-160)}`;
    if (attempt === 1) {
      log(`  [w-translate-fixture] 落库首次失败（重试 1 次）：${detail}`);
      await sleep(300);
      continue;
    }
    throw new PreconditionError(`W-translate 夹具落库失败（重试耗尽）：${detail}`);
  }
  return sid;
}

function ensureBuildFresh() {
  let buildMs = 0;
  try { buildMs = fs.statSync(BUILD_DIR).mtimeMs; } catch { buildMs = 0; }
  let newestSrc = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const m = fs.statSync(p).mtimeMs; if (m > newestSrc) newestSrc = m; } catch { /* 尽力而为 */ } }
    }
  };
  try { walk(path.resolve('src')); } catch { /* src 不可读：交由构建失败路径报错 */ }
  if (buildMs === 0 || newestSrc > buildMs) {
    log(`  [iso-build] out/renderer ${buildMs ? new Date(buildMs).toISOString() : '不存在'} 落后于 src 最新 ${new Date(newestSrc).toISOString()} → npm run build`);
    // shell:true 单命令串形态：Node ≥18.20 对 .cmd 直接 spawnSync 抛 EINVAL（CVE-2024-27980），shell 形态规避。
    const r = spawnSync('npm run build', { shell: true, stdio: 'inherit', windowsHide: true, timeout: 600_000 });
    if (r.error || r.status !== 0) throw new PreconditionError(`npm run build 失败（status=${r.status ?? 'N/A'}${r.error ? ` error=${r.error}` : ''}）——ISO 自举中止`);
  } else {
    log(`  [iso-build] 产物新鲜（out/renderer ${new Date(buildMs).toISOString()} ≥ src 最新 ${new Date(newestSrc).toISOString()}），跳过重建`);
  }
}

function seedIsoConfig(port) {
  const base = rawConfig;
  if (!base || typeof base.webAccessToken !== 'string' || base.webAccessToken.length === 0) {
    throw new PreconditionError(`ISO 自举需真实配置 ${DEFAULT_CONFIG_PATH} 含非空 webAccessToken 作底稿（只读不改）——或改用 --config 外部备环境模式`);
  }
  fs.mkdirSync(ISO_APP_DIR, { recursive: true });
  fs.mkdirSync(ISO_FIXTURE_DIR, { recursive: true });
  // seed = 真实配置浅拷贝 + 三项覆盖（port=空闲端口防撞真实实例；workingDirectory=ISO 夹具；
  // permissionMode=bypassPermissions=回合类场景前置，经隔离配置注入 = AGENTS.md 认可的等效注入形态）。
  // + 翻译凭据注入（p5c，2026-11-20）：顶层 plain 编码测试密钥——W-translate 的 START 在
  // resolveTranslationContext 的凭据 fail-fast 处被拒（首跑截图证据：错误横条「未配置 API 密钥，
  // 无法翻译」）。config.apiKey 现值为空且回合类场景本就不消费它，新增为惰性字段。stub
  // transport 拦截 HTTP 层，密钥只用于过 fail-fast，零真实计费。
  // + 二跑修正（p5c，2026-11-20）：真实用户配置 lastUsed 指向的供应商密钥是 safeStorage 密文，
  //   ISO 实例（独立 --user-data-dir，Chromium os_crypt 密钥随目录轮换）跨实例解密必失败
  //   （safestorage-probe 本机实测 decryptString 报错）→ getProviderModelSources 得空串 →
  //   翻译链走供应商路由仍 fail-fast「未配置 API 密钥」（W-translate-failed.png 证据）。顶层
  //   测试密钥只在「库为空回落老字段」时被读到，对带 lastUsed 的真实配置不生效。处置：seed 追加
  //   一个专用 stub 供应商档案（plain 编码测试密钥），仅由 W-translate 夹具会话经 DB
  //   provider_override 引用（见 seedTranslateFixtureDb）——lastUsed/providerProfiles 原序保留，
  //   B3-B6 真实回合的供应商路由零变化；stub 档案不被任何 lastUsed/defaults 路由命中
  //   （resolveSessionModel 仅按 override/lastUsed/providers[0] 选——providers[0] 仍是原首档）。
  const seed = { ...base };
  seed.webAccess = { ...(base.webAccess ?? {}), enabled: true, port };
  seed.workingDirectory = ISO_FIXTURE_DIR;
  seed.permissionMode = 'bypassPermissions';
  seed.encryptedApiKey = 'sk-e2e-translate-stub-not-a-real-key';
  seed.apiKeyEncoding = 'plain';
  seed.providerProfiles = [
    ...(base.providerProfiles ?? []),
    {
      id: 'e2e-translate-stub',
      name: 'E2E Translate Stub',
      note: 'p5c W-translate 夹具专用（plain 测试密钥；stub transport 拦截 HTTP，零真实计费）',
      apiBaseUrl: 'https://translation-stub.invalid',
      models: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      encryptedApiKey: 'sk-e2e-translate-stub-not-a-real-key',
      apiKeyEncoding: 'plain',
    },
  ];
  fs.writeFileSync(ISO_CONFIG_PATH, JSON.stringify(seed, null, 2), 'utf8');
  return seed;
}

function launchIsoElectron() {
  const electronBin = createRequire(import.meta.url)('electron');
  if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
    throw new PreconditionError(`electron 二进制不可解析（require('electron')=${String(electronBin)}）——node_modules 未安装？`);
  }
  // UI 五点批次 p5c（2026-11-20）：翻译上游 stub 纪律（02 §0 + 03 R3 延伸，硬约束）——ISO 实例
  // 注入 CLAUDE_LINK_TRANSLATE_STUB=1（translation-service 启动期挂确定性 stub transport）+
  // CLAUDE_LINK_TRANSLATE_STUB_LOG（逐请求一行 JSON 落 ISO 目录，W-translate 场景按行数核对请求
  // 计数）。W-translate 场景禁发真实翻译计费请求；其余场景不触翻译链路，env 零行为变化。
  return spawn(electronBin, ['.', `--user-data-dir=${ISO_APP_DIR}`, `--remote-debugging-port=${ISO_APP_CDP_PORT}`],
    {
      cwd: process.cwd(), stdio: 'ignore', windowsHide: true,
      env: { ...process.env, CLAUDE_LINK_TRANSLATE_STUB: '1', CLAUDE_LINK_TRANSLATE_STUB_LOG: TRANSLATE_STUB_LOG },
    });
}

function findChromiumBinary() {
  const candidates = [
    process.env.CLAUDE_LINK_E2E_CHROME,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', // Chromium 系回落（CDP 兼容）
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch { /* 尽力而为 */ } }
  return null;
}

function launchIsoChrome(chromeBin) {
  // --window-size=1440,900：headless 默认 800x600 会破 W-collapse-persist 的 ≥1100px 视口前提
  //（该场景另用 Emulation 覆盖双保险，见 1785 行一带）。
  return spawn(chromeBin, [
    '--headless=new', `--remote-debugging-port=${CHROME_CDP_PORT}`, `--user-data-dir=${ISO_CHROME_DIR}`,
    '--no-first-run', '--no-default-browser-check', '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
}

async function waitForListener(port, timeoutMs, what, proc) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const pids = findListenerPids(port);
    if (pids && pids.length > 0) return;
    if (proc && proc.exitCode !== null) {
      throw new PreconditionError(`${what}：进程已退出（code=${proc.exitCode}）但端口 ${port} 未监听——启动失败`);
    }
    if (Date.now() > deadline) {
      throw new PreconditionError(`${what}：端口 ${port} 在 ${timeoutMs}ms 内未进入 LISTENING——启动超时`);
    }
    await sleep(500);
  }
}

async function waitForChromeTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const t = await getPageTarget(); if (t) return t; } catch { /* 未就绪，继续轮询 */ }
    if (Date.now() > deadline) throw new PreconditionError(`Chrome CDP ${CHROME_CDP_PORT} 在 ${timeoutMs}ms 内无 page target——headless Chrome 可能启动失败`);
    await sleep(500);
  }
}

async function ensureIsoEnvironment() {
  // 自举独立看门狗（构建+拉起上限 15 分钟；超时 exit 2，绝不无声挂死）。
  const guard = setTimeout(() => {
    console.error(`[自举超时] ${BOOTSTRAP_TIMEOUT_MS}ms 未完成——exit 2`);
    isoTeardown();
    process.exit(2);
  }, BOOTSTRAP_TIMEOUT_MS);
  guard.unref();
  try {
    log(`ISO 自举开始（裸跑模式：脚本自建隔离环境；真实配置 ${DEFAULT_CONFIG_PATH} 只读，写入全部落 ${ISO_DIR}）`);
    // 0. Chrome 调试端口占用预检：外部 debug 实例复用 = 跨轮 profile 污染（先例：折叠键/横幅会话记忆
    //    跨轮残留），拒绝复用、fail-fast 指引释放。
    const chromePids = findListenerPids(CHROME_CDP_PORT);
    precondition(chromePids !== null, 'netstat 校验手段不可用——ISO 自举无法进行');
    precondition(chromePids.length === 0, `端口 ${CHROME_CDP_PORT} 已被占用（PID ${chromePids.join(',')}，疑似外部 headless Chrome）——ISO 模式拒绝复用（防跨轮 profile 污染），请先释放该端口`);
    // 1. 构建新鲜度（src 比 out/renderer 新才重建；自举实例启动晚于构建 → assertFreshInstances 恒真）。
    ensureBuildFresh();
    // 2. 空闲 web access 端口（8791 起，避开真实实例 8790 与单实例锁冲突）。
    const port = pickFreePort(8791);
    precondition(port !== null, '8791-8810 无空闲端口——ISO 自举无法选口');
    // 3. seed 配置 + 模块级配置三元组同轮重派生（CONFIG_PATH/rawConfig/PORT/TOKEN 必须同源，防半新半旧）。
    const seed = seedIsoConfig(port);
    CONFIG_PATH = ISO_CONFIG_PATH;
    rawConfig = seed;
    PORT = port;
    TOKEN = seed.webAccessToken;
    // 4. electron（--user-data-dir 隔离；electron-store 配置随 userData；单实例锁按 userData 不与真实实例冲突）。
    isoElectronProc = launchIsoElectron();
    await waitForListener(port, 90_000, 'electron web access', isoElectronProc);
    // 5. headless Chrome。
    const chromeBin = findChromiumBinary();
    precondition(chromeBin, `未发现 Chrome/Edge 可执行文件（搜索过 Program Files/LOCALAPPDATA 标准路径；可用 CLAUDE_LINK_E2E_CHROME 显式指定）`);
    isoChromeProc = launchIsoChrome(chromeBin);
    await waitForChromeTarget(30_000);
    log(`ISO 自举完成：web access 端口=${port}，electron PID=${isoElectronProc?.pid}，chrome PID=${isoChromeProc?.pid}（${chromeBin}），ISO 目录用后删除`);
  } finally {
    clearTimeout(guard);
  }
}

// ── 主流程 ──
async function main() {
  // ISO 自举（裸跑默认）：先拉起隔离实例再校验——自举实例启动晚于构建，新鲜度校验恒真。
  // 外部备环境跑（--config）不走此路径，保持旧版「只校验+指引」行为。
  if (ISO_MODE) {
    await ensureIsoEnvironment();
    armSuiteWatchdog();
    // p5c：W-translate 夹具落库（stub env 已注入 electron；失败 = 前置不满足 exit 2）。
    if (TRANSLATE_STUB_LOG) await seedTranslateFixtureDb();
  }
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
    } else if (msg.method === 'Page.loadEventFired') {
      pageLoadTicks.count += 1;
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

  // ── T1B 前置复位（2026-11-16）：上一轮运行可能遗留两类会话级状态污染本轮——
  // ①折叠持久化键 cl.sidebarCollapsed='1'（折叠态下 button.new-button 被 v-if 卸载，B3 起全部
  //   场景连锁假红——run-2 事故根因）；②dev 横幅关闭记忆 sessionStorage clWebDevModeWarnDismissed
  //  （跨轮残留 → W-dev-stale-banner 步骤①假红）。在 LAN origin（B3+ 与全部 W 用例的工作 origin）
  //  清键 + 整页刷新一次；B1 的 127.0.0.1 origin 无侧栏/横幅断言，无需复位。
  currentCase = '(t1b-reset)';
  try {
    await navigate(ws, urls.lan);
    await waitFor('T1B 前置复位：桥连接', () => evalOk(ws, connectedExpr), 20);
    await evalExpr(ws, `localStorage.removeItem('cl.sidebarCollapsed'); localStorage.removeItem('cl.sidebarWidth'); sessionStorage.clear(); true`);
    await cdpSend(ws, 'Page.reload');
    await waitFor('T1B 前置复位：刷新后桥连接', () => evalOk(ws, connectedExpr), 20);
    log('  T1B 前置复位完成（折叠键/横幅会话记忆清零 + 整页刷新）');
  } catch (e) { log(`T1B 前置复位失败（申报，不阻塞）：${String(e.message).slice(0, 120)}`); }

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
  // R2-F-9（复审 flow 备忘，2026-11-22）flake 兜底留痕：run2 FAIL growth=0 / run1 PASS——上游
  // LLM 偶发空回复（终态不含 42），非用例可控行。终态等待加一次容错重发（W-turn-footnote
  // F1-2b 容错重发先例）：每次尝试独立取气泡基线 + 重装增长观测；「终态不含 42」空回复形态 →
  // 重发一次 → 取新基线断言。断言口径零变化（42 终态 + 增长≥1 + text_delta≥1 + chat:event≥2）。
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
    // R2-F-9（2026-11-22）：发送→帧证据→终态等待→42 判定包进两次尝试循环（容错重发一次，
    // 见场景头注）；断言口径零变化，帧证据按尝试独立采集（取末次尝试）。
    let growths = -1;
    let finalText = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      // 每次尝试独立取气泡基线：终态判据要求 assistant 气泡数越过本尝试基线，防第 2 次尝试
      // 的终态检测被第 1 次产出瞬时满足（F1-2b run-7 假红根因同款）。
      const beforeThis = Number(await assistantBubbleCount(ws));
      // 增长计数：MutationObserver 以 DOM 突变粒度记录 assistant 可见文本长度严格递增次数
      // （每次尝试重装：断开上一尝试 observer、计数清零——增长≥1 判据落在本次尝试的流式上）。
      await evalExpr(ws, `(() => {
        window.__e2eObs?.disconnect?.();
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
      // 帧级证据：chat:send invoke 帧（发出）+ ≥2 条 chat:event 回帧（本尝试独立采集）
      await waitFor('WS 发出 chat:send invoke 帧', () =>
        frameEvidence.sent.some((p) => p.includes('"channel":"chat:send"')), 20, 100);
      await waitFor('WS 收到 ≥2 条 chat:event 帧', () =>
        frameEvidence.received.filter((p) => p.includes('"channel":"chat:event"')).length >= 2, 30, 100);
      // 回合终态：assistant 终态 bubble 含 42 且流式组已退场且气泡数越过本尝试基线
      // （轮询 50ms，≤120s；超时不断言——交由下方空回复形态判定进入重发）
      const deadline = Date.now() + 120_000;
      let terminal42 = false;
      for (;;) {
        if (Date.now() > deadline) break;
        const done = await evalExpr(ws, `(() => {
          const bubbles = document.querySelectorAll('.bubble--assistant');
          const last = bubbles[bubbles.length - 1];
          const has42 = !!(last && (last.innerText || '').includes('42'));
          return has42 && !document.querySelector('.stream-group') && bubbles.length > ${beforeThis};
        })()`);
        if (done === true) { terminal42 = true; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      growths = await evalExpr(ws, `window.__e2eGrowths ?? -1`);
      finalText = await evalExpr(ws, `(() => {
        const bubbles = document.querySelectorAll('.bubble--assistant');
        const last = bubbles[bubbles.length - 1];
        return last ? (last.innerText || '') : '';
      })()`);
      if (terminal42 && String(finalText).includes('42')) break;
      if (attempt === 1) log(`  B3 首试回合终态不含「42」（上游偶发空回复形态，growth=${growths}）→ 容错重发一次（F1-2b 先例）`);
    }
    const chatEventCount = frameEvidence.received.filter((p) => p.includes('"channel":"chat:event"')).length;
    const textDeltaCount = frameEvidence.received.filter((p) => p.includes('"text_delta"')).length;
    await evalExpr(ws, `window.__e2eObs?.disconnect(), true`);
    if (!String(finalText).includes('42')) throw new Error(`assistant 终态不含「42」（含一次容错重发，growth=${growths}，text=${String(finalText).slice(0, 80)}）`);
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
        //    挂载 onMounted→refresh；若撞 F-5 同源守卫（同 id+wd 刚拉过——本轮 run 的前序场景已对
        //    同 id/wd 拉过，onMounted refresh() 非 force 会被守卫短路出陈旧列表）或挂载早于切会话的
        //    watch 收口而列表暂空/不含探针行，经 pinia 触发 changesStore.refresh(true)（面板「重试」
        //    同参，invalidateDiffs 绕过守卫强制重拉）后复验——补拉是用户可达操作，不算放宽断言。
        //    （2026-11-16 T1B 同步面：补拉条件由「列表空」扩为「列表空或不含探针行」——同源守卫
        //    短路出的是非空陈旧列表，原条件对第二轮起必假红；见 t1b 点报告申报。）
        const PROBE_NAME = '.e2e-changes-probe.tmp';
        const probeRowExpr = `[...document.querySelectorAll('.changes__list .changes__row .changes__path')].some((n) => String(n.innerText).includes('${PROBE_NAME}'))`;
        const rowsShown = await waitFor('改动面板文件行渲染（含探针行）', () => evalOk(ws, probeRowExpr), 20, 300).then(() => true).catch(() => false);
        if (!rowsShown) {
          const nudged = await evalExpr(ws, `(() => {
            const app = document.querySelector('#app');
            const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
            const st = pinia && pinia._s ? pinia._s.get('changes') : null;
            if (st) { void st.refresh(true); return true; }
            return false;
          })()`);
          log(`  面板首拉未含探针行，changesStore.refresh(true) 补拉（nudged=${nudged}）`);
          await waitFor('改动面板文件行渲染（补拉后含探针行）', () => evalOk(ws, probeRowExpr), 20, 300);
        }
        // 断言加强（2026-10-27）：由「首行路径非空」升级为「文件行列表含探针行」——遍历全部
        // .changes__path 的 innerText，至少一条含 .e2e-changes-probe.tmp（面板路径可能按字母序
        // 排列，探针未必在首行，故不能只看首行）。JSON 往返对 Windows 反斜杠路径安全。
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

  // ── W-file-context-menu：P6-B（2026-11-21）md-file-link 右键上下文菜单的 web 端同款验证 ──
  // R2-F-8（复审 flow 备忘，2026-11-22）flake 兜底留痕：run1 FAIL 截图示注入消息暂态未上屏、
  // 菜单态瞬时不稳定（run2 同代码 PASS）——注入后右键前补「链接元素在场且稳定」等待（首见后
  // 间隔 300ms 复测仍在场）；三条右键链（活链首开/死链/活链复现）统一 f1 修复组同款一次重试
  // 兜底（首断言失败 → Esc 关菜单→重新右键→重新断言，重试仍败才判红；同 smoke
  // contextMenuWithRetry 先例，菜单弹开瞬间可能被自动滚底 scroll-close 吃掉或元素重渲染换元）。
  // 契约：左键零动作；右键出 5 项菜单（预览/用系统默认程序打开/选择打开方式…/在文件夹中显示/
  // 复制路径）；fs:stat 预检（死链/不存在 → 菜单「文件不存在」+ 1-4 禁用）；复制路径走非安全
  // 上下文 execCommand 降级；预览项 → 预览抽屉（远控语义：动作作用于桌面主机）。零新 IPC
  // （fs:stat / fs:openPath / fs:showInExplorer web-bridge 既有注册）。
  // 注入纪律（W-mcp-settings 只读同源）：pinia 暂态会话 + st.messages.push 纯内存注入，禁写
  // 真实配置/DB；夹具文件落隔离配置 workingDirectory（ISO_MODE=ISO_FIXTURE_DIR，teardown 全删；
  // 预览允许集 = seed workingDirectory → fs:readPreview 可读，路径先例 = W-mcp-external-change）。
  currentCase = 'W-file-context-menu';
  {
    const exceptionsBeforeF = exceptions.length;
    const fixtureMd = path.join(String(rawConfig?.workingDirectory ?? ''), 'w-file-context-menu.md');
    const FIXTURE_MARK = 'W_FILE_CONTEXT_MENU_MARK';
    try {
      if (!rawConfig?.workingDirectory || !fs.existsSync(String(rawConfig.workingDirectory))) {
        throw new PreconditionError('配置缺 workingDirectory（默认 profile 形态）——W-file-context-menu 夹具目录不可知，本场景需隔离配置');
      }
      fs.writeFileSync(fixtureMd, `# ${FIXTURE_MARK}\n\nP6-B 右键菜单 web 端同款验证夹具（用后删除）。\n`, 'utf8');
      await ensureLanBridge(ws, 'W-file-context-menu');
      // 0) chat 路由 + 暂态会话 + 消息注入（活链=夹具绝对路径反引号形态；死链=未设根相对链接）。
      // R3-F-1（复审 P2-1，2026-11-22）：注入块整包两次尝试循环（F1-2b / R2-F-9 同款形态）——
      // 既有产品竞态（refreshActiveSession await 后无 activeSession.id 复核守卫，ChatPage 重挂载
      // 触发）会把注入视图晚到覆写/未上屏，R2-F-8 收稳面全部位于失败点下游从未执行；每次尝试
      // 重走 hash 路由 → 路由就绪 → 注入前视图沉降（连续两采样 activeSession id 不变 + assistant
      // 气泡数稳定，直击晚到 IPC 覆写窗）→ startTransientSession+push → 两条渲染 waitFor（15s
      // 不变）；attempt 1 失败留痕后整块重试一次，attempt 2 仍败才判红。断言集/菜单链/截图点
      // 零变化，三条右键链重试兜底保留原位（产品级根修=refreshActiveSession 补 resolve-time
      // 守卫，属 src 改动超授权面，由编排器登记台账）。
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          await evalExpr(ws, `(location.hash = '#/'), true`);
          await waitFor('W-file-context-menu：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
          // R3-F-1：push 前补「视图沉降」前置——连续两采样（间隔 500ms）activeSession.id 不变且
          // .bubble--assistant 数稳定后才注入（晚到 refreshActiveSession 覆写会表现为 id 翻转或
          // 气泡数跳变，沉降等待把它挡在 push 之前）。
          await waitFor('W-file-context-menu：注入前视图沉降（连续两采样 id/气泡数稳定）', async () => {
            const sample = `(() => {
              const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
              return JSON.stringify({ id: st?.activeSession?.id ?? null, bubbles: document.querySelectorAll('.bubble--assistant').length });
            })()`;
            const s1 = JSON.parse(String(await evalExpr(ws, sample)));
            await new Promise((r) => setTimeout(r, 500));
            const s2 = JSON.parse(String(await evalExpr(ws, sample)));
            return s1.id === s2.id && s1.bubbles === s2.bubbles;
          }, 15);
          await evalExpr(ws, `(() => {
            const st = document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('session');
            if (!st) return null;
            st.startTransientSession();
            st.messages.push({ id: 'w-fcm-a', role: 'assistant', eventType: 'message', processKind: null, rawEvent: null, parentTaskId: null,
              content: '夹具已生成 \`${JSON.stringify(fixtureMd).slice(1, -1)}\`（${FIXTURE_MARK}）；手册见 [缺失手册](rel/no-such-guide.md)。' });
            return true;
          })()`);
          await waitFor('W-file-context-menu：活链渲染（data-clip-path=夹具路径）', () => evalOk(ws, `(() => {
            const p = ${JSON.stringify(fixtureMd)};
            return [...document.querySelectorAll('.bubble__content .md-file-link')]
              .some((a) => a.getAttribute('data-clip-path') === p && !a.classList.contains('md-file-link--dead'));
          })()`), 15);
          await waitFor('W-file-context-menu：死链渲染（md-file-link--dead，clip=相对路径）', () => evalOk(ws, `(() => {
            return [...document.querySelectorAll('.bubble__content .md-file-link')]
              .some((a) => a.classList.contains('md-file-link--dead') && a.getAttribute('data-clip-path') === 'rel/no-such-guide.md');
          })()`), 15);
          break; // 注入块整链成功 → 跳出尝试循环（后续稳定等待与三条右键链照旧）
        } catch (e) {
          if (attempt >= 2) throw e; // attempt 2 仍败 → 上抛判红（record FAIL 由场景外层 catch 统一）
          log(`  [R3-F-1 收稳] W-file-context-menu 注入块第 1 次失败（${String(e.message).slice(0, 120)}）——注入视图被晚到覆写/未上屏，整块重试一次`);
        }
      }
      // R2-F-8：注入后、右键前补「链接元素在场且稳定」等待（复用场景既有 waitFor 手法）——
      // 首见后间隔 300ms 复测两条链接仍在场且全部 isConnected，防「暂态未上屏/列表重渲染换元」
      // 瞬时竞态（run1 FAIL 根因形态）。
      await waitFor('W-file-context-menu：链接元素在场且稳定（首见 300ms 复测仍在场）', async () => {
        if (!(await evalOk(ws, `document.querySelectorAll('.bubble__content .md-file-link').length >= 2`))) return false;
        await new Promise((r) => setTimeout(r, 300));
        return evalOk(ws, `(() => {
          const ls = [...document.querySelectorAll('.bubble__content .md-file-link')];
          return ls.length >= 2 && ls.every((a) => a.isConnected);
        })()`);
      }, 15);
      // R2-F-8：三条右键链（活链首开/死链/活链复现）统一一次重试兜底（f1 修复组
      // contextMenuWithRetry 同款）：首断言失败 → Esc 关菜单（已被 scroll-close 吃掉时幂等无害）
      // → 重新右键 → 重新断言（action 重跑），重试仍败才上抛判红。pickExpr = 页面内求值表达式，
      // 返回待右键的 .md-file-link 元素。
      const rightClickMenuWithRetry = async (pickExpr, label, action) => {
        const attempt = async () => {
          const opened = await evalExpr(ws, `(() => {
            const el = ${pickExpr};
            if (!el) return false;
            const r = el.getBoundingClientRect();
            el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: Math.round(r.left + 8), clientY: Math.round(r.top + 8) }));
            return true;
          })()`);
          if (opened !== true) throw new Error('右键目标链接不在场（元素被重渲染移除）');
          await action();
        };
        try {
          await attempt();
        } catch (firstErr) {
          log(`  [R2-F-8 收稳] W-file-context-menu ${label}：首次失败（${String(firstErr.message).slice(0, 120)}）→ Esc 关菜单重新右键重试一次`);
          await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`).catch(() => { /* Esc 兜底尽力而为 */ });
          await new Promise((r) => setTimeout(r, 200));
          await attempt(); // 重试仍失败 → 异常上抛判红
        }
      };
      const LIVE_LINK_PICK = `[...document.querySelectorAll('.bubble__content .md-file-link:not(.md-file-link--dead)')][0]`;
      const DEAD_LINK_PICK = `[...document.querySelectorAll('.bubble__content .md-file-link--dead')][0]`;
      // 1) 左键零动作：原生 click() 后既无菜单也无抽屉（P6-B 行为契约 web 面）。
      await evalExpr(ws, `(() => {
        const el = [...document.querySelectorAll('.bubble__content .md-file-link:not(.md-file-link--dead)')][0];
        el.click();
        return true;
      })()`);
      await new Promise((r) => setTimeout(r, 600));
      const noAction = await evalOk(ws, `!document.querySelector('.file-link-menu') && !document.querySelector('.fpreview-drawer.open')`);
      if (noAction !== true) throw new Error('左键点击后出现菜单或抽屉（P6-B 左键零动作契约在 web 端失守）');
      // 2) 右键活链 → 5 项菜单 + 文案字面 + 全部可用（fs:stat 预检 exists=true）。
      //    R2-F-8：右键链一次重试兜底（见上 helper 注）。
      await rightClickMenuWithRetry(LIVE_LINK_PICK, '右键活链开菜单', async () => {
        await waitFor('W-file-context-menu：菜单出现', () => evalOk(ws, `!!document.querySelector('.file-link-menu')`), 10);
      });
      const menuState = JSON.parse(String(await evalExpr(ws, `(() => {
        const menu = document.querySelector('.file-link-menu');
        const items = [...menu.querySelectorAll('[role="menuitem"]')];
        return JSON.stringify({
          texts: items.map((b) => (b.textContent || '').trim()),
          disabled: items.filter((b) => b.disabled).length,
          notice: (menu.querySelector('.flink-menu__notice')?.textContent || '').trim(),
        });
      })()`)));
      if (menuState.texts.join('|') !== '预览|用系统默认程序打开|选择打开方式…|在文件夹中显示|复制路径') {
        throw new Error(`菜单 5 项文案/顺序不符：${menuState.texts.join('|')}`);
      }
      if (menuState.disabled !== 0) throw new Error(`活链菜单禁用项 ${menuState.disabled} ≠ 0（fs:stat 预检应为全部可用）`);
      if (menuState.notice) throw new Error(`活链菜单不应有提示行，实际「${menuState.notice}」`);
      await screenshot(ws, 'W-file-context-menu');
      // 3) 复制路径（非安全上下文 execCommand 降级）：菜单保持可见 + notice 出现（已复制/降级失败
      //    反馈二态均可接受——降级路径本身真实触达即「可用」；二态记入 PASS 摘要）。
      await evalExpr(ws, `(() => {
        const b = [...document.querySelectorAll('.file-link-menu [role="menuitem"]')].find((x) => (x.textContent || '').trim() === '复制路径');
        b.click();
        return true;
      })()`);
      await waitFor('W-file-context-menu：复制反馈 notice 出现（菜单保持可见）', () => evalOk(ws, `(() => {
        const menu = document.querySelector('.file-link-menu');
        if (!menu) return false;
        return (menu.querySelector('.flink-menu__notice')?.textContent || '').trim().length > 0;
      })()`), 8);
      const copyNotice = String(await evalExpr(ws, `(document.querySelector('.file-link-menu .flink-menu__notice')?.textContent || '').trim()`));
      // 4) Esc 关闭（window keydown 关闭机制真实路径）。
      await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
      await waitFor('W-file-context-menu：Esc 关闭菜单', () => evalOk(ws, `!document.querySelector('.file-link-menu')`), 5);
      // 5) 右键死链 → 「文件不存在」提示 + 1-4 禁用（stat 预检/禁用形态与桌面一致；相对路径
      //    clip → fsStat.exists=false）。复制路径恒可用。R2-F-8：右键链一次重试兜底。
      await rightClickMenuWithRetry(DEAD_LINK_PICK, '右键死链', async () => {
        await waitFor('W-file-context-menu：死链菜单「文件不存在」提示', () => evalOk(ws, `(() => {
          const n = document.querySelector('.file-link-menu .flink-menu__notice');
          return !!n && (n.textContent || '').includes('文件不存在');
        })()`), 10);
      });
      const deadState = JSON.parse(String(await evalExpr(ws, `(() => {
        const items = [...document.querySelectorAll('.file-link-menu [role="menuitem"]')];
        return JSON.stringify({ total: items.length, disabled: items.filter((b) => b.disabled).length });
      })()`)));
      if (deadState.total !== 5 || deadState.disabled !== 4) {
        throw new Error(`死链菜单形态不符：total=${deadState.total}（应 5）disabled=${deadState.disabled}（应 4，复制路径恒可用）`);
      }
      await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
      await waitFor('W-file-context-menu：死链菜单 Esc 关闭', () => evalOk(ws, `!document.querySelector('.file-link-menu')`), 5);
      // 6) 右键活链 → 点「预览」→ 抽屉打开（远控语义：读取在桌面主机）。R2-F-8：右键链一次重试兜底。
      await rightClickMenuWithRetry(LIVE_LINK_PICK, '右键活链复现', async () => {
        await waitFor('W-file-context-menu：活链菜单复现', () => evalOk(ws, `!!document.querySelector('.file-link-menu')`), 10);
      });
      await evalExpr(ws, `(() => {
        const b = [...document.querySelectorAll('.file-link-menu [role="menuitem"]')].find((x) => (x.textContent || '').trim() === '预览');
        if (!b || b.disabled) return false;
        b.click();
        return true;
      })()`);
      await waitFor('W-file-context-menu：预览抽屉打开', () => evalOk(ws, `!!document.querySelector('.fpreview-drawer.open')`), 15);
      await evalExpr(ws, `window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), true`);
      await waitFor('W-file-context-menu：抽屉关闭', () => evalOk(ws, `!document.querySelector('.fpreview-drawer.open')`), 8);
      if (exceptions.length > exceptionsBeforeF) throw new Error('W-file-context-menu 用例期间出现 exceptionThrown');
      record('W-file-context-menu', 'PASS', `web 端同款 5 项菜单（左键零动作 ✓；活链全可用 ✓；复制路径降级 notice=「${copyNotice}」；死链「文件不存在」+4 禁用 ✓；预览开抽屉 ✓；Esc 关闭 ✓）；纯内存注入未写真实配置`);
    } catch (e) { record('W-file-context-menu', 'FAIL', e.message); }
    finally { try { fs.rmSync(fixtureMd, { force: true }); } catch { /* 夹具清理尽力而为 */ } }
    await screenshot(ws, 'W-file-context-menu');
  }

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
      const asstWraps = [...document.querySelectorAll('.bubble-wrap--assistant')];
      const lastAsst = asstWraps[asstWraps.length - 1] ?? null;
      const dur = lastAsst ? lastAsst.querySelector('.bubble__meta-duration') : null;
      return JSON.stringify({
        hasWrap: true,
        hasCaption: !!cap,
        capText: cap ? (cap.textContent || '').trim() : '',
        capHasClock: !!(cap && cap.querySelector('svg.bubble-caption-clock')),
        bubbleHasFootnote: bubble ? (bubble.textContent || '').includes('发送于') : null,
        hasAsstDur: !!dur,
        asstDurText: dur ? ((dur.textContent || '').trim()) : '',
      });
    })()`);
    const capObj = JSON.parse(String(capState));
    if (capObj.hasWrap !== true) throw new Error('页面无 .bubble-wrap--user（物化消息未渲染 user 气泡）');
    if (capObj.hasCaption !== true) throw new Error('user 气泡下方无 .bubble-caption（P5 caption 未渲染）');
    // P3 升秒级：caption 文案「你 · 发送于 HH:mm:ss」（秒位段两位）。
    if (!/你 · 发送于 \d{1,2}:\d{2}:\d{2}/.test(String(capObj.capText))) {
      throw new Error(`caption 文本不符（期望「你 · 发送于 HH:mm:ss」（P3 秒级），实际「${String(capObj.capText).slice(0, 60)}」）`);
    }
    // P3：caption 时钟 svg 在位（bubble-caption-clock，位于「你 · 发送于」之前——对齐②视觉语言）。
    if (capObj.capHasClock !== true) throw new Error('caption 元素内缺 svg.bubble-caption-clock（P3 时钟图标未渲染）');
    if (capObj.bubbleHasFootnote !== false) {
      throw new Error(`气泡内仍含「发送于」脚注（双向断言负向失败，bubbleHasFootnote=${capObj.bubbleHasFootnote}）`);
    }
    // P4-T11：assistant ②气泡脚注耗时文本恒时钟格式（m:ss / H:MM:SS），不得小数秒形态。
    if (capObj.hasAsstDur !== true) throw new Error('assistant 气泡缺 .bubble__meta-duration（②脚注不在场，P4-T11 断言面缺失）');
    if (!/^\d+:\d{2}(:\d{2})?$/.test(String(capObj.asstDurText)) || /^\d+(\.\d+)?s$/.test(String(capObj.asstDurText))) {
      throw new Error(`②耗时文本 '${capObj.asstDurText}' 不符时钟格式（期望 m:ss / H:MM:SS，不得小数秒形态——P4）`);
    }
    // ── F-r1-10（flow 疑问-Q1）终态后二次探针：④TurnTimer 运行态异常运行时取证 ──
    // 审查岗截图实证「②已落账（0:10·结束于）同帧 ④ 仍运行态（正在回复 10.7s+思考中 pill）」，
    // 静态推导最贴合 web 桥 runtime overview 迟到重置位（session-store.ts:710/:1209/:1292 对账
    // 守卫在 result 后/turn_ended 前窗口可穿透），未定案 → 运行时取证：终态（materializeSession
    // 已含②落账=F-r1-8 根修口径）后 +2s/+5s 两次读 ④ DOM 态（.turn-timer 类名/文本：运行态=
    // 无 --done 类且文本含「正在回复」，完成态=.turn-timer--done）+ pinia session store 快照
    //（runningSessions/turnStartedAt/lastTurnMeta——既有 evalExpr 直读惯例，非新增调试口），
    // 结果写日志与本 record 备注。两次均收敛完成态 → 疑问定性「瞬时窗口，已自愈」结案；任一次
    // 仍运行态 → 坐实「完成后计时器复活」疑缺陷，只报不修（修复报告给复现步骤与证据，另开
    // 修复点交编排器裁定）。
    const probeSid = String(await activeSessionId(ws));
    const timerProbe = async () => JSON.parse(String(await evalExpr(ws, `(() => {
      const el = document.querySelector('.turn-timer');
      const pinia = document.querySelector('#app')?.__vue_app__?.config?.globalProperties?.$pinia ?? null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      const sid = ${JSON.stringify(probeSid)};
      return JSON.stringify({
        present: !!el,
        done: !!(el && el.classList.contains('turn-timer--done')),
        running: !!(el && !el.classList.contains('turn-timer--done')),
        text: el ? ((el.textContent || '').trim()) : '',
        runningInStore: !!sid && Array.isArray(st?.runningSessions) && st.runningSessions.includes(sid),
        turnStartedAtAlive: !!sid && st?.turnStartedAt?.[sid] != null,
        lastTurnMeta: st?.lastTurnMeta?.[sid] ? 'present' : 'absent',
      });
    })()`)));
    await sleep(2000);
    const timerProbe1 = await timerProbe();
    await sleep(3000);
    const timerProbe2 = await timerProbe();
    const probeJson1 = JSON.stringify(timerProbe1);
    const probeJson2 = JSON.stringify(timerProbe2);
    const timerStillRunning = timerProbe1.running === true || timerProbe2.running === true || timerProbe1.runningInStore === true || timerProbe2.runningInStore === true;
    log(`  ℹ F-r1-10 终态后二次探针：@+2s=${probeJson1}；@+5s=${probeJson2}`);
    const q1Verdict = timerStillRunning
      ? 'F-r1-10 疑问-Q1 坐实：终态后二次探针 ④ 仍运行态（完成后计时器复活疑缺陷）——只报不修，交编排器裁定'
      : 'F-r1-10 疑问-Q1 结案：终态后 +2s/+5s 两探针 ④ 均已收敛完成态——瞬时窗口，已自愈';
    log(`  ℹ ${q1Verdict}`);
    if (exceptions.length > exceptionsBeforeT) throw new Error('W-user-timestamp 用例期间出现 exceptionThrown');
    record('W-user-timestamp', 'PASS', `caption 两向断言 OK（「${capObj.capText}」匹配 /你 · 发送于 \\d{1,2}:\\d{2}:\\d{2}/（P3 秒级）+ 时钟 svg 在位；气泡内无「发送于」）；②耗时 '${capObj.asstDurText}' 时钟格式（P4-T11）；会话=${mat.sessionName}；${q1Verdict}（探针@+2s=${probeJson1} @+5s=${probeJson2}）`);
    await screenshot(ws, 'W-user-timestamp');
    // 善后：删除自建物化会话（不污染真实会话列表）。
    const cleaned = await deleteActiveSessionViaStore(ws);
    log(`  W-user-timestamp 测试会话删除请求${cleaned ? '已发（善后）' : '失败（遗留人工清理）'}`);
    await screenshot(ws, 'W-user-timestamp-cleaned');
  } catch (e) { record('W-user-timestamp', 'FAIL', e.message); await screenshot(ws, 'W-user-timestamp-failed'); }

  // ══ 八问题批次 T1B 新增 13 场景（2026-11-16；03b §1/§4/§7/§8/§11/§12/§13 + 03 §5 E2-06）══
  // 编排：W-dev-stale-banner 最先跑（其步骤②关闭横幅 + 按会话记忆，之后所有场景免受横幅干扰——
  // 与既有用例共存性证明落在本场景步骤⑤「既有顶部选择器可达」）；随后 config 域三场景
  //（W-mcp-scan / W-skill-refresh-web / W-mcp-external-change），W-collapse-persist（视口覆盖+恢复），
  // 队列三场景（各自物化独立会话、互不复用），W-turn-footnote，最后 W-question-* 四场景。
  // 硬纪律落点：隔离 profile 由编排层保证（electron --user-data-dir + --config）；bypassPermissions
  // 经隔离配置 permissionMode 注入（等效注入形态，本批回合类场景不触权限面板）。

  // ── W-dev-stale-banner：D2-3 dev 产物新鲜度横幅五步（可见/关闭/刷新不重现/新 page 重现/既有选择器可达）──
  // 实现锚点（App.vue D2）：.web-rev-warn--dev（静态流内横条，非 fixed 覆盖——与既有用例共存性见步骤⑤
  // 与 t1b 点报告）；关闭钮 .web-rev-warn__close；按会话记忆 sessionStorage 键 clWebDevModeWarnDismissed
  //（会话作用域=page 作用域，跨 page 必重现——步骤④）。
  currentCase = 'W-dev-stale-banner';
  try {
    const exceptionsBeforeB = exceptions.length;
    await ensureLanBridge(ws, 'W-dev-stale-banner');
    // 0) 强制整页加载（fresh load；本 tab 此前从未点过横幅关闭钮 → 横幅必现）。
    // 0.5) T1B 前置复位：清折叠持久化键（上一轮 W-collapse-persist 失败路径可能遗留
    //      cl.sidebarCollapsed='1'——折叠态下 button.new-button 不在位，会连锁误伤后续场景）。
    await evalExpr(ws, `localStorage.removeItem('cl.sidebarCollapsed'); localStorage.removeItem('cl.sidebarWidth'), true`);
    await navigate(ws, urls.lan);
    await waitFor('W-dev-stale-banner：页面渲染+桥连接', () => evalOk(ws, connectedExpr), 30);
    // ① 横幅可见 + 关键文案（devMode 帧 + 文案含「开发模式」与「npm run dev」）。
    const banner1 = JSON.parse(String(await evalExpr(ws, `(() => {
      const el = document.querySelector('.web-rev-warn--dev');
      return JSON.stringify({
        present: !!el,
        text: el ? ((el.querySelector('.web-rev-warn__text')?.textContent) || '').trim() : '',
        hasClose: !!(el && el.querySelector('.web-rev-warn__close')),
        sessionStorageMark: sessionStorage.getItem('clWebDevModeWarnDismissed'),
      });
    })()`)));
    if (!banner1.present) throw new Error('dev 横幅未渲染（!isPackaged 实例下应常驻；devMode welcome 帧未生效？）');
    if (!banner1.text.includes('开发模式')) throw new Error(`横幅文案缺「开发模式」：${banner1.text.slice(0, 60)}`);
    if (!banner1.text.includes('npm run dev')) throw new Error(`横幅文案缺「npm run dev」：${banner1.text.slice(0, 80)}`);
    if (banner1.hasClose !== true) throw new Error('横幅缺关闭钮（.web-rev-warn__close）');
    await screenshot(ws, 'W-dev-stale-banner-visible');
    // ② 点关闭 → 横幅消失。
    await evalExpr(ws, `document.querySelector('.web-rev-warn--dev .web-rev-warn__close')?.click(), true`);
    await waitFor('W-dev-stale-banner：关闭后横幅退场', () => evalOk(ws, `!document.querySelector('.web-rev-warn--dev')`), 5);
    // ③ 刷新 → 不重现（按会话记忆；sessionStorage '1'）。
    await reloadAndReconnect(ws, 'W-dev-stale-banner');
    await sleep(800);
    const banner3 = await evalExpr(ws, `JSON.stringify({
      present: !!document.querySelector('.web-rev-warn--dev'),
      sessionStorageMark: sessionStorage.getItem('clWebDevModeWarnDismissed'),
    })`);
    const b3 = JSON.parse(String(banner3));
    if (b3.present) throw new Error('刷新后横幅重现（按会话记忆失效：sessionStorage 未记关闭态）');
    if (b3.sessionStorageMark !== '1') throw new Error(`sessionStorage 关闭标记缺失（clWebDevModeWarnDismissed=${b3.sessionStorageMark}）`);
    // ④ 新开第二 page（新会话作用域）→ 横幅重现；结束后关闭该 page。
    const created = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
    precondition(created && created.webSocketDebuggerUrl, `第二 page 创建失败（/json/new）：${JSON.stringify(created).slice(0, 120)}`);
    const ws2 = await connectWS(created.webSocketDebuggerUrl);
    ws2.addEventListener('message', (event) => {
      let msg; try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        exceptions.push({ case: currentCase, text: msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '(no desc)' });
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push({ case: currentCase, text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ') });
      }
    });
    try {
      await cdpSend(ws2, 'Runtime.enable');
      await cdpSend(ws2, 'Page.enable');
      await cdpSend(ws2, 'Page.navigate', { url: urls.lan });
      await waitFor('W-dev-stale-banner：第二 page 桥连接', () => evalOk(ws2, connectedExpr), 30);
      await sleep(500);
      const banner4 = await evalExpr(ws2, `!!document.querySelector('.web-rev-warn--dev')`);
      if (banner4 !== true) throw new Error('第二 page（新会话作用域）横幅未重现（devMode 帧或会话作用域判定失效）');
      await screenshot(ws2, 'W-dev-stale-banner-second-page');
    } finally {
      // 第二 page 收尾：先 window.close（对 CDP /json/new 打开的页通常生效），ws 断开后再以
      // /json/close 兜底；仍失败则申报遗留——不阻塞主流程，遗留 page 不影响后续断言。
      try { await evalExpr(ws2, `window.close(), true`); } catch { /* 尽力而为 */ }
      try { ws2.close(); } catch { /* 尽力而为 */ }
      await sleep(300);
      let closed = true;
      try {
        const rest = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json`).then((r) => r.json());
        closed = !rest.some((t) => t.id === created.id);
        if (!closed) {
          try { await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json/close/${created.id}`); } catch { /* 尽力而为 */ }
        }
      } catch { closed = false; }
      log(`  第二 page 收尾（closed=${closed ? 'yes' : '尽力而为，遗留时申报'}）`);
    }
    // ⑤ 关闭横幅后既有顶部选择器可达：新会话按钮在位且可点（共存性证明——横幅为流内横条，
    //    不遮挡顶栏；此处以「点得动」实证，非仅 DOM 在位）。
    await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
    await waitFor('W-dev-stale-banner：新会话输入框出现（顶栏可达）', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 10);
    await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`); // 复位：回到无输入暂态（no-op 语义）
    if (exceptions.length > exceptionsBeforeB) throw new Error('W-dev-stale-banner 用例期间出现 exceptionThrown');
    record('W-dev-stale-banner', 'PASS', `五步全过：①dev 横幅可见含「开发模式/npm run dev」②关闭退场 ③刷新不重现（sessionStorage clWebDevModeWarnDismissed='1'）④第二 page 重现（跨 page 会话作用域）⑤关闭后顶栏新会话按钮可点（共存性：横幅为流内横条不遮挡选择器，B 链零适配申报）`);
  } catch (e) { record('W-dev-stale-banner', 'FAIL', e.message); await screenshot(ws, 'W-dev-stale-banner-failed'); }
  await screenshot(ws, 'W-dev-stale-banner');

  // ── W-mcp-scan：E1-5 网页端 MCP 手动扫描（扫描钮在位→loading→反馈→列表正常→配置文件零写入）──
  // 只读纪律（沿 W-mcp-settings）：不调 saveManaged/writeMcpScoped/setMcpOverride；零写入以
  // ~/.claude.json mtime+size 前后比对佐证（尽力而为申报：同窗口其他进程写入不归本用例管辖）。
  // managed 栏无钮有文案（DOM 抽验，E1-1(2)）。
  currentCase = 'W-mcp-scan';
  try {
    const exceptionsBeforeM = exceptions.length;
    await ensureLanBridge(ws, 'W-mcp-scan');
    await evalExpr(ws, `(location.hash = '#/config?tab=mcp'), true`);
    await waitFor('W-mcp-scan：MCP tab 就绪（作用域 rail 在位）', () => evalOk(ws, `!!document.querySelector('.mcp-rail')`), 20);
    await waitFor('W-mcp-scan：列表加载收口（退出「正在读取」占位）', () => evalOk(ws, `(() => {
      return ![...document.querySelectorAll('.mcp-empty')].some((el) => (el.textContent || '').includes('正在读取'));
    })()`), 15);
    // 1) 切用户级 scope（rail 按名定位 → active 标题行验证）。
    const userClicked = await evalExpr(ws, `(() => {
      const item = [...document.querySelectorAll('.mcp-rail-item')].find((el) => (el.querySelector('.mcp-rail-item__name')?.textContent || '').trim() === '用户级');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (userClicked !== true) throw new Error('未找到「用户级」rail 条目（E1 user 栏扫描入口不可达）');
    await waitFor('W-mcp-scan：用户级 scope 激活（标题行切换）', () => evalOk(ws, `(document.querySelector('.mcp-title-row__name')?.textContent || '').trim() === '用户级'`), 8);
    // 2) 扫描钮在位可点。
    const scanBtn = JSON.parse(String(await evalExpr(ws, `(() => {
      const btn = document.querySelector('[data-testid="mcp-scan-button"]');
      return JSON.stringify({ present: !!btn, disabled: btn ? btn.disabled : null, text: btn ? (btn.textContent || '').trim() : '' });
    })()`)));
    if (!scanBtn.present) throw new Error('user 栏扫描钮缺失（[data-testid="mcp-scan-button"]）');
    if (scanBtn.disabled === true) throw new Error('扫描钮初始态即 disabled（非 loading 期）');
    // 3) 零写入审计基线：~/.claude.json mtime+size。
    const claudeJson = path.join(os.homedir(), '.claude.json');
    let beforeStat = null;
    try { const st = fs.statSync(claudeJson); beforeStat = { mtimeMs: st.mtimeMs, size: st.size }; } catch { beforeStat = null; }
    // 4) 点击扫描 → 紧轮询抓 loading 态（扫描中…）→ 完成复位 → toast 反馈。
    await evalExpr(ws, `document.querySelector('[data-testid="mcp-scan-button"]').click(), true`);
    let caughtLoading = false;
    const loadDeadline = Date.now() + 3000;
    while (Date.now() < loadDeadline) {
      const t = await evalExpr(ws, `(document.querySelector('[data-testid="mcp-scan-button"]')?.textContent || '').trim()`);
      if (String(t).includes('扫描中…')) { caughtLoading = true; break; }
      if (String(t) === '扫描') break; // 扫描快到本轮询都没抓到 loading 文案（亚帧级）→ 已复位
      await sleep(20);
    }
    await waitFor('W-mcp-scan：扫描完成复位（按钮回「扫描」）', () => evalOk(ws, `(document.querySelector('[data-testid="mcp-scan-button"]')?.textContent || '').trim() === '扫描'`), 20);
    await waitFor('W-mcp-scan：扫描完成 toast 反馈（扫描完成…）', () => evalOk(ws, `[...document.querySelectorAll('.mcp-toast')].some((t) => (t.textContent || '').includes('扫描完成'))`), 5, 100);
    // 5) 列表渲染正常（无加载占位、卡片容器在位、快照仍可取）。
    await waitFor('W-mcp-scan：列表渲染正常（无「正在读取」占位）', () => evalOk(ws, `(() => {
      return !!document.querySelector('.mcp-main') && ![...document.querySelectorAll('.mcp-empty')].some((el) => (el.textContent || '').includes('正在读取'));
    })()`), 10);
    const snapOk = await evalOk(ws, `window.claudeLink.getMcpSnapshot().then((r) => !!r && Array.isArray(r.userServers) && Array.isArray(r.projectDirs))`);
    if (snapOk !== true) throw new Error('扫描后 getMcpSnapshot 形状异常');
    // 6) 零写入比对（~/.claude.json）。
    let afterStat = null;
    try { const st = fs.statSync(claudeJson); afterStat = { mtimeMs: st.mtimeMs, size: st.size }; } catch { afterStat = null; }
    const zeroWrite = beforeStat !== null && afterStat !== null && beforeStat.mtimeMs === afterStat.mtimeMs && beforeStat.size === afterStat.size;
    // 7) managed 栏无钮有文案（DOM 抽验）。
    const managedClicked = await evalExpr(ws, `(() => {
      const item = [...document.querySelectorAll('.mcp-rail-item')].find((el) => (el.querySelector('.mcp-rail-item__name')?.textContent || '').trim() === 'Claude Link 管理');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (managedClicked !== true) throw new Error('未找到「Claude Link 管理」rail 条目');
    await waitFor('W-mcp-scan：managed scope 激活', () => evalOk(ws, `(document.querySelector('.mcp-title-row__name')?.textContent || '').trim() === 'Claude Link 管理'`), 8);
    const managedState = JSON.parse(String(await evalExpr(ws, `(() => {
      const btn = document.querySelector('[data-testid="mcp-scan-button"]');
      const note = (document.querySelector('.mcp-title-row__name')?.closest('.mcp-title-row')?.parentElement?.textContent) || document.body.textContent || '';
      return JSON.stringify({ scanBtnAbsent: !btn, noteHasLinkText: note.includes('link 配置实时生效，无需扫描') });
    })()`)));
    if (managedState.scanBtnAbsent !== true) throw new Error('managed 栏出现了扫描钮（契约：managed 不设扫描入口）');
    if (managedState.noteHasLinkText !== true) throw new Error('managed 栏缺「link 配置实时生效，无需扫描」说明文案');
    if (exceptions.length > exceptionsBeforeM) throw new Error('W-mcp-scan 用例期间出现 exceptionThrown');
    record('W-mcp-scan', 'PASS', `user 栏扫描钮在位可点 → loading${caughtLoading ? '态捕获（扫描中…）' : '态未捕获（亚帧级完成，20ms 轮询；按钮 disabled=loading 绑定与复位已断言，申报降级）'} → toast「扫描完成…」反馈 → 列表渲染正常 + 快照形状 OK → ~/.claude.json 零写入（mtime+size 前后一致=${zeroWrite}）→ managed 栏无扫描钮且有「link 配置实时生效，无需扫描」文案`);
  } catch (e) { record('W-mcp-scan', 'FAIL', e.message); await screenshot(ws, 'W-mcp-scan-failed'); }
  await screenshot(ws, 'W-mcp-scan');

  // ── W-skill-refresh-web：E5-2 网页端全局「立即刷新」busy→复位 + 项目「重新枚举」在位 ──
  // 锚点（ConfigPage E5）：[data-testid="skill-refresh-button"]（.skill-sync-bar__now，busy=
  // .skill-sync-bar__now--busy + 文案「刷新中…」，disabled=globalRefreshing）；[data-testid="skill-project-refresh"]。
  currentCase = 'W-skill-refresh-web';
  try {
    const exceptionsBeforeS = exceptions.length;
    await ensureLanBridge(ws, 'W-skill-refresh-web');
    await evalExpr(ws, `(location.hash = '#/config?tab=skill'), true`);
    await waitFor('W-skill-refresh-web：Skill tab 就绪（全局刷新钮在位）', () => evalOk(ws, `!!document.querySelector('[data-testid="skill-refresh-button"]')`), 20);
    // 1) 全局作用域「立即刷新」：点击 → busy 态（class + 文案「刷新中…」）→ 完成复位。
    await evalExpr(ws, `document.querySelector('[data-testid="skill-refresh-button"]').click(), true`);
    const busy = await waitFor('W-skill-refresh-web：busy 态出现（--busy class / 刷新中…）', () => evalOk(ws, `(() => {
      const b = document.querySelector('[data-testid="skill-refresh-button"]');
      return !!b && (b.classList.contains('skill-sync-bar__now--busy') || (b.textContent || '').includes('刷新中…'));
    })()`), 5, 30).then(() => true).catch(() => false);
    // 2) 完成态复位（globalRefreshing 收口；全局重探含 CLI 探测，预算 60s）。
    await waitFor('W-skill-refresh-web：复位（立即刷新 + busy class 退场）', () => evalOk(ws, `(() => {
      const b = document.querySelector('[data-testid="skill-refresh-button"]');
      return !!b && !b.classList.contains('skill-sync-bar__now--busy') && (b.textContent || '').includes('立即刷新') && !b.disabled;
    })()`), 60);
    // 3) 项目作用域「重新枚举」钮（E5-2 末项）：切项目目录 → v-if（skillScope.kind==='project'）在位可见。
    const projItemClicked = await evalExpr(ws, `(() => {
      const item = [...document.querySelectorAll('.skill-md-item--project')].find((el) => (el.querySelector('.skill-md-item__name')?.textContent || '').trim() === 'fixture');
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (projItemClicked !== true) throw new Error('项目目录条目「fixture」未找到（skill-md-item--project）');
    await waitFor('W-skill-refresh-web：项目作用域激活（条目 --active）', () => evalOk(ws, `(() => {
      const item = [...document.querySelectorAll('.skill-md-item--project')].find((el) => (el.querySelector('.skill-md-item__name')?.textContent || '').trim() === 'fixture');
      return !!item && item.classList.contains('skill-md-item--active');
    })()`), 8);
    const projBtnPresent = await evalOk(ws, `(() => {
      const b = document.querySelector('[data-testid="skill-project-refresh"]');
      return !!b && b.getClientRects().length > 0 && !b.disabled;
    })()`);
    if (projBtnPresent !== true) throw new Error('项目作用域下「重新枚举」钮（skill-project-refresh）不在位/不可见');
    if (exceptions.length > exceptionsBeforeS) throw new Error('W-skill-refresh-web 用例期间出现 exceptionThrown');
    record('W-skill-refresh-web', 'PASS', `网页端 Skill tab：全局 skill-refresh-button 点击 → busy 态${busy ? '捕获（--busy/刷新中…）' : '未捕获（亚帧级完成，30ms 轮询；复位断言已成立，申报降级）'} → 复位（立即刷新 + 非 disabled）；切项目目录（fixture）后 skill-project-refresh（重新枚举）在位可点`);
  } catch (e) { record('W-skill-refresh-web', 'FAIL', e.message); await screenshot(ws, 'W-skill-refresh-web-failed'); }
  await screenshot(ws, 'W-skill-refresh-web');

  // ── W-mcp-external-change：E2-06 外部进程直写 .mcp.json → 网页端 MCP tab 重拉可见 ──
  // 夹具目录 = 隔离配置 workingDirectory（E2 watcher 默认工作目录目标；编排层 seed 指向临时目录）。
  // 步骤：①MCP tab 记住基线（fixture 目录 scope 无该 server）→ ②切走（chat 路由，ConfigPage 卸载）
  // → ③外部进程（本脚本）直写 <fixture>/.mcp.json，等 ≥去抖 1.5s + 广播窗 → ④导航回 MCP tab →
  // 重拉 → fixture scope 断言新增 server 卡片可见。只读纪律对 ~/.claude.json 维持；.mcp.json 属
  // 隔离夹具目录（用后删除还原）。
  currentCase = 'W-mcp-external-change';
  const FIXTURE_MCPJSON = path.join(String(rawConfig?.workingDirectory ?? ''), '.mcp.json');
  try {
    const exceptionsBeforeE = exceptions.length;
    if (!rawConfig?.workingDirectory || !fs.existsSync(String(rawConfig.workingDirectory))) {
      throw new PreconditionError('配置缺 workingDirectory（默认 profile 形态）——E2-06 夹具目录不可知，本场景需隔离配置（--config seed workingDirectory=<临时夹具目录>）');
    }
    const fixtureDir = String(rawConfig.workingDirectory);
    const fixtureBasename = path.basename(fixtureDir);
    await ensureLanBridge(ws, 'W-mcp-external-change');
    // ① 基线：MCP tab → fixture 目录 scope → 断言 e2e-ext-server 不在。
    await evalExpr(ws, `(location.hash = '#/config?tab=mcp'), true`);
    await waitFor('W-mcp-external-change：MCP tab 就绪', () => evalOk(ws, `!!document.querySelector('.mcp-rail')`), 20);
    await waitFor('W-mcp-external-change：列表加载收口', () => evalOk(ws, `(() => {
      return ![...document.querySelectorAll('.mcp-empty')].some((el) => (el.textContent || '').includes('正在读取'));
    })()`), 15);
    const clickedBase = await evalExpr(ws, `(() => {
      const item = [...document.querySelectorAll('.mcp-rail-item')].find((el) => (el.querySelector('.mcp-rail-item__name')?.textContent || '').trim() === ${JSON.stringify(fixtureBasename)});
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (clickedBase !== true) throw new Error(`rail 无夹具目录条目「${fixtureBasename}」（watcher/快照目录集未含默认工作目录？）`);
    await waitFor('W-mcp-external-change：fixture scope 激活', () => evalOk(ws, `(document.querySelector('.mcp-title-row__name')?.textContent || '').trim() === ${JSON.stringify(fixtureBasename)}`), 8);
    const baseNames = JSON.parse(String(await evalExpr(ws, `JSON.stringify([...document.querySelectorAll('button[aria-label^="测试连接"]')].map((b) => (b.getAttribute('aria-label') || '').replace(/^测试连接\\s*/, '')))`)));
    if (Array.isArray(baseNames) && baseNames.some((n) => String(n).includes('e2e-ext-server'))) {
      throw new Error('基线已含 e2e-ext-server（上轮残留 .mcp.json 未清理？）');
    }
    // ② 切走（chat 路由；ConfigPage 卸载 → 回来时重挂载重拉）。
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-mcp-external-change：切走（chat 路由就绪）', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    // ③ 外部进程直写 .mcp.json（本脚本=app 外部进程）+ 等 ≥去抖窗（1.5s）+ 广播余量。
    const mcpPayload = { mcpServers: { 'e2e-ext-server': { command: 'node', args: ['-e', "process.stdout.write('e2e-ok')"] } } };
    fs.writeFileSync(FIXTURE_MCPJSON, JSON.stringify(mcpPayload, null, 2));
    log(`  外部直写 ${FIXTURE_MCPJSON}（等待 1.5s 去抖 + 广播窗）`);
    await sleep(3500);
    // ④ 导航回 MCP tab → fixture scope → 断言新增 server 卡片可见（广播 → 重拉链端到端）。
    await evalExpr(ws, `(location.hash = '#/config?tab=mcp'), true`);
    await waitFor('W-mcp-external-change：回 MCP tab 就绪', () => evalOk(ws, `!!document.querySelector('.mcp-rail')`), 20);
    await waitFor('W-mcp-external-change：列表加载收口（重拉后）', () => evalOk(ws, `(() => {
      return ![...document.querySelectorAll('.mcp-empty')].some((el) => (el.textContent || '').includes('正在读取'));
    })()`), 20);
    const clickedBack = await evalExpr(ws, `(() => {
      const item = [...document.querySelectorAll('.mcp-rail-item')].find((el) => (el.querySelector('.mcp-rail-item__name')?.textContent || '').trim() === ${JSON.stringify(fixtureBasename)});
      if (!item) return false;
      item.click();
      return true;
    })()`);
    if (clickedBack !== true) throw new Error(`回 tab 后 rail 无「${fixtureBasename}」条目`);
    await waitFor('W-mcp-external-change：fixture scope 激活（回）', () => evalOk(ws, `(document.querySelector('.mcp-title-row__name')?.textContent || '').trim() === ${JSON.stringify(fixtureBasename)}`), 8);
    await waitFor('W-mcp-external-change：e2e-ext-server 卡片可见（重拉链通）', () => evalOk(ws, `[...document.querySelectorAll('button[aria-label^="测试连接"]')].some((b) => (b.getAttribute('aria-label') || '').includes('e2e-ext-server'))`), 20, 300);
    if (exceptions.length > exceptionsBeforeE) throw new Error('W-mcp-external-change 用例期间出现 exceptionThrown');
    record('W-mcp-external-change', 'PASS', `外部进程直写 ${fixtureBasename}/.mcp.json（新增 e2e-ext-server）→ 等 3.5s（≥1.5s 去抖）→ 导航回 MCP tab → fixture scope 卡片出现（基线 0 卡 → 新增 1 卡；广播→重拉→网页端可见端到端通；夹具用后删除）`);
  } catch (e) {
    if (e instanceof PreconditionError) record('W-mcp-external-change', 'SKIP', e.message);
    else { record('W-mcp-external-change', 'FAIL', e.message); await screenshot(ws, 'W-mcp-external-change-failed'); }
  } finally {
    try { fs.rmSync(FIXTURE_MCPJSON, { force: true }); } catch { /* 尽力而为 */ }
  }
  await screenshot(ws, 'W-mcp-external-change');

  // ── W-collapse-persist：D1-4 网页端折叠+宽度持久化三步（≥1100px 视口强制，≤1100px 响应式语义不测）──
  // 锚点：折叠 button[title="折叠侧栏"]（W-sidebar-collapse 既有）；localStorage 键 cl.sidebarCollapsed /
  // cl.sidebarWidth（session-store LS_COLLAPSE + AppLayout LS_WIDTH，D1 单一来源）；拖宽手柄
  // .resize-handle--sidebar（CDP Input.dispatchMouseEvent 先例）；默认展开宽 240px。
  currentCase = 'W-collapse-persist';
  try {
    const exceptionsBeforeC = exceptions.length;
    await ensureLanBridge(ws, 'W-collapse-persist');
    // 0) 路由复位到 chat（场景内两次 reload 须落在 '#/'——从 config 路由 reload 会停留 config，
    //    button.new-button 永不出现）+ 视口强制 ≥1100px（D1-4 断言前提；Emulation 覆盖，场景尾清除）。
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-collapse-persist：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button') || !!document.querySelector('.sidebar__rail__new')`), 15);
    await cdpSend(ws, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await sleep(300);
    // ① 折叠左栏 → localStorage 键非空且值正确 → 刷新保持。
    await evalExpr(ws, `localStorage.removeItem('cl.sidebarCollapsed'); localStorage.removeItem('cl.sidebarWidth'), true`);
    const collapseClicked = await evalExpr(ws, `(() => {
      const btn = document.querySelector('button[title="折叠侧栏"]');
      if (!btn) return false;
      btn.click();
      return true;
    })()`);
    if (collapseClicked !== true) throw new Error('未找到侧栏折叠钮（button[title="折叠侧栏"]）');
    await waitFor('W-collapse-persist：折叠态根类在位', () => evalOk(ws, `!!document.querySelector('.sidebar--collapsed')`), 10);
    const lsCollapsed = await evalExpr(ws, `localStorage.getItem('cl.sidebarCollapsed')`);
    if (lsCollapsed !== '1') throw new Error(`localStorage cl.sidebarCollapsed=${lsCollapsed}（期望 '1'——折叠态未持久化）`);
    await reloadAndReconnect(ws, 'W-collapse-persist');
    await waitFor('W-collapse-persist：刷新后仍折叠', () => evalOk(ws, `!!document.querySelector('.sidebar--collapsed') && !!document.querySelector('.sidebar__rail__expand')`), 15);
    // ② 展开 → 拖宽手柄至非默认宽 → 刷新保持。
    await evalExpr(ws, `document.querySelector('.sidebar__rail__expand')?.click(), true`);
    await waitFor('W-collapse-persist：展开态恢复', () => evalOk(ws, `!document.querySelector('.sidebar--collapsed') && !!document.querySelector('.resize-handle--sidebar')`), 10);
    const w0 = await evalExpr(ws, `document.querySelector('.sidebar')?.offsetWidth ?? -1`);
    if (Number(w0) <= 100) throw new Error(`展开态宽度 ${w0}px 异常`);
    const handleBox = JSON.parse(String(await evalExpr(ws, `(() => {
      const h = document.querySelector('.resize-handle--sidebar');
      const r = h.getBoundingClientRect();
      return JSON.stringify({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
    })()`)));
    for (const step of [['mousePressed', handleBox.x, handleBox.y], ['mouseMoved', handleBox.x + 50, handleBox.y], ['mouseMoved', handleBox.x + 100, handleBox.y], ['mouseMoved', handleBox.x + 140, handleBox.y], ['mouseReleased', handleBox.x + 140, handleBox.y]]) {
      await cdpSend(ws, 'Input.dispatchMouseEvent', {
        type: step[0], x: Math.round(step[1]), y: Math.round(step[2]),
        button: 'left', buttons: step[0] === 'mousePressed' ? 1 : (step[0] === 'mouseReleased' ? 0 : 1),
        clickCount: step[0] === 'mousePressed' ? 1 : 0,
      });
      await sleep(60);
    }
    await sleep(300);
    const w1 = await evalExpr(ws, `document.querySelector('.sidebar')?.offsetWidth ?? -1`);
    const lsWidth = await evalExpr(ws, `localStorage.getItem('cl.sidebarWidth')`);
    if (!(Number(w1) > Number(w0) + 60)) throw new Error(`拖宽未生效：${w0}px → ${w1}px（期望 +60px 以上）`);
    if (!lsWidth || Number(lsWidth) !== Number(w1)) throw new Error(`cl.sidebarWidth=${lsWidth} 与实际宽度 ${w1}px 不一致（拖宽未持久化）`);
    await reloadAndReconnect(ws, 'W-collapse-persist');
    await waitFor('W-collapse-persist：刷新后宽度保持', () => evalOk(ws, `(() => {
      const w = document.querySelector('.sidebar')?.offsetWidth ?? -1;
      return w >= ${Number(w1) - 12} && w <= ${Number(w1) + 12};
    })()`), 15);
    // ③ 清 localStorage → 刷新 → 回默认宽不报错。
    const exceptionsBeforeClear = exceptions.length;
    await evalExpr(ws, `localStorage.removeItem('cl.sidebarCollapsed'); localStorage.removeItem('cl.sidebarWidth'), true`);
    await reloadAndReconnect(ws, 'W-collapse-persist');
    await waitFor('W-collapse-persist：清存储后回默认宽', () => evalOk(ws, `(() => {
      const w = document.querySelector('.sidebar')?.offsetWidth ?? -1;
      return w >= 230 && w <= 250;
    })()`), 15);
    if (exceptions.length > exceptionsBeforeClear) throw new Error('清存储刷新后出现 exceptionThrown（默认值回退路径异常）');
    if (exceptions.length > exceptionsBeforeC) throw new Error('W-collapse-persist 用例期间出现 exceptionThrown');
    record('W-collapse-persist', 'PASS', `三步全过：①折叠→cl.sidebarCollapsed='1'→刷新保持折叠+展开钮在位 ②展开 ${w0}px→CDP 拖宽至 ${w1}px→cl.sidebarWidth='${lsWidth}'→刷新保持 ③清存储→刷新回默认 ${await evalExpr(ws, `document.querySelector('.sidebar')?.offsetWidth ?? -1`)}px 无异常（视口 1440x900 强制 ≥1100px，尾清除）`);
  } catch (e) { record('W-collapse-persist', 'FAIL', e.message); await screenshot(ws, 'W-collapse-persist-failed'); } finally {
    // 清 Emulation 视口覆盖 + 复位折叠持久化态（失败路径可能遗留 cl.sidebarCollapsed='1'——
    // 折叠态下 button.new-button 不在位，会连锁误伤后续场景；成功路径 step ③ 已复位，此处幂等）。
    try { await cdpSend(ws, 'Emulation.clearDeviceMetricsOverride'); } catch { /* 尽力而为 */ }
    try {
      await evalExpr(ws, `localStorage.removeItem('cl.sidebarCollapsed'); localStorage.removeItem('cl.sidebarWidth'), true`);
      await reloadAndReconnect(ws, 'W-collapse-persist 复位');
    } catch (e) { log(`  W-collapse-persist 复位异常（申报）：${String(e.message).slice(0, 120)}`); }
  }
  await screenshot(ws, 'W-collapse-persist');

  // ── W-queue-restore-countdown：T1R-1 倒计时中刷新 → 恢复门+状态可见 → 发送=入队 ──
  // 前置：queueEnabled=true（隔离配置 seed 既有 true，设置面开关选择器无需校准——申报）；
  // taskDelayMinutes=1 → 倒计时窗 60s，全部断言窗内完成。步骤含 A2-3 顺序断言（入队追加尾部）
  // 与 A3-3 恢复中路由不阻塞（并入步骤 4.5）。恢复门采样降级纪律照 T1R-1 期望 a：
  // 抢不到禁用态样本 → 附属条目 SKIP-with-reason（结构钉 tdd-queue-restore-gate-verify 兜底；
  // round-002 P24 修复后 SKIP 理由带首采样直接证据，非推断），「恢复完成后发送可用 + 状态横条
  // 已呈现 + P35 倒计时秒数两采样递减（期望 b 指示随 QUEUE_EVENT 增量更新的 DOM 直测）」必断言。
  // 入队证据三件套（T1R-1 期望 c）+ 无直发回合 + 原任务不打断抽样断言（countdown 连续 + 任务卡
  // 次序；完整执行链由 W-queue-restore-running 承担——t1b 点报告申报范围）。
  currentCase = 'W-queue-restore-countdown';
  let wqrcSid = '';
  try {
    const exceptionsBeforeQ1 = exceptions.length;
    await ensureLanBridge(ws, 'W-queue-restore-countdown');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-queue-restore-countdown：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    // 1) 物化专用会话（真实回合；queueEnabled=true 下直发路径 standby 不受影响）。
    await materializeSession(ws, 'W-queue-restore-countdown', W_WAKE_TEXT);
    wqrcSid = await activeSessionId(ws);
    if (!wqrcSid) throw new Error('无法取得物化会话 id');
    // 2) 基线空态 standby（轮询收口——物化回合的 DOM 终态可先于主进程 result 落地，引擎
    //    status 可短暂滞留 running；30s 轮询等引擎结算回 standby）。
    const ov0 = await pollOverview(ws, wqrcSid, '基线空态 standby', (o) => o.state?.status === 'standby' && (o.tasks ?? []).length === 0, 30);
    // 3) addTask#1 → 校准链（首跑校准申报，见 t1b 报告）：v3 引擎语义 TASK_ADD 不自动 arm
    //    （armFromUserAction/armAfterTurn 两个入口都不含 addTask——tdd-queue-semantics-v3 引擎
    //    头注释「重启后绝不自动执行」同源），空态直加任务不会进 countdown。以真实用户动作链
    //    「面板暂停→恢复」（TASK_SET_PAUSED true→false → armFromUserAction → startCountdown）
    //    产生倒计时窗——与桌面用户「恢复」按钮同语义，不放宽断言。
    const add1 = JSON.parse(String(await evalExpr(ws, `window.claudeLink.addTask(${JSON.stringify(wqrcSid)}, { text: 'e2e-t1r1-task1', attachmentIds: [], clientMessageId: crypto.randomUUID() }).then((r) => JSON.stringify({ taskId: (r.task && r.task.id) || '' }))`)));
    if (!add1.taskId) throw new Error('addTask#1 回包无 taskId');
    await evalExpr(ws, `window.claudeLink.setTaskPaused(${JSON.stringify(add1.taskId)}, true).then(() => true)`);
    await evalExpr(ws, `window.claudeLink.setTaskPaused(${JSON.stringify(add1.taskId)}, false).then(() => true)`);
    const ovCount = await pollOverview(ws, wqrcSid, '任务#1 进入 countdown（暂停→恢复 arm）', (o) => o.state?.status === 'countdown', 15);
    log(`  倒计时窗在位（remaining=${ovCount.state.countdownRemaining}s interval=${ovCount.state.intervalSeconds}s）`);
    // 4) 立即整页刷新（落在 countdown 窗内；等刷新完成后）+ 桥重连 + 路由就绪 + 50ms 紧轮询抢
    //    「恢复未完成态」样本（reloadAndReconnect 已含 Page.loadEventFired 完成等待——P24 修复，
    //    断言不再可能落预刷新旧页）。
    await reloadAndReconnect(ws, 'W-queue-restore-countdown');
    let caughtRecovering = null;
    let firstSample = null;
    let sampleCount = 0;
    const sampleDeadline = Date.now() + 6000;
    while (Date.now() < sampleDeadline) {
      const gate = await chatInputGate(ws);
      const strip = await queueStripState(ws);
      sampleCount += 1;
      if (!firstSample) firstSample = { gate, strip };
      if (gate.hasInput && (gate.textareaDisabled === true || strip.text.includes('恢复中'))) {
        caughtRecovering = { textareaDisabled: gate.textareaDisabled, stripText: strip.text };
        break;
      }
      // 恢复已完成（发送可用且横条已呈 countdown）→ 采样终止。
      if (gate.textareaDisabled === false && strip.present && strip.text.includes('倒计时')) break;
      await sleep(50);
    }
    // 4.5) A3-3 恢复中路由不阻塞（仅采样捕获时执行；未捕获走 SKIP 降级条目，理由带首采样实测证据）。
    if (caughtRecovering) {
      await evalExpr(ws, `(location.hash = '#/config?tab=mcp'), true`);
      await waitFor('W-queue-restore-countdown：恢复中路由不阻塞（config 页可渲染）', () => evalOk(ws, `!!document.querySelector('.mcp-rail')`), 10);
      await evalExpr(ws, `(location.hash = '#/'), true`);
      await waitFor('W-queue-restore-countdown：恢复中路由不阻塞（切回 chat 页）', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 10);
      record('W-queue-restore-countdown-gate-sample', 'PASS', `恢复门禁用态样本捕获（textareaDisabled=${caughtRecovering.textareaDisabled} strip='${caughtRecovering.stripText.slice(0, 20)}'）+ A3-3 恢复中路由不阻塞（config↔chat 往返可渲染）`);
    } else {
      record('W-queue-restore-countdown-gate-sample', 'SKIP', `恢复门禁用态样本未捕获（reload 完成等待修复后实测：首采样即恢复完成——textareaDisabled=${firstSample?.gate.textareaDisabled} strip='${String(firstSample?.strip.text ?? '').slice(0, 24)}'，共采样 ${sampleCount} 次全程未见禁用/恢复中态；loadOverview 先于首采样完成，直接证据非推断）——按 T1R-1 期望 a 降级申报：恢复门禁用绑定由结构钉 A3-1（npx tsx scripts/tdd-queue-restore-gate-verify.ts）兜底；A3-3 路由不阻塞同因未测（依赖恢复中窗口在场）`);
    }
    // 5) 恢复完成后（必断言）：状态横条已呈现（倒计时剩余秒数形态；轮询收口防单点读抖动）
    //    + 发送可用 + P35 期望 b DOM 直测：倒计时秒数两采样递减（指示随 QUEUE_EVENT 增量更新，
    //    第二采样 < 第一采样；15s 预算远小于 60s 倒计时窗，超时即指示冻结/倒退 → FAIL）。
    const stripAfter = await waitFor('W-queue-restore-countdown：恢复后倒计时横条呈现', async () => {
      const s = await queueStripState(ws);
      // round-002 R3-1：正则随 ChatPage M-C 文案消歧同步（「N 条待执行」→「队列 N 条」，fix-G 已落）
      return s.present && /队列倒计时 \d+s · 队列 \d+ 条/.test(s.text) ? s : false;
    }, 15);
    const m1 = stripAfter.text.match(/队列倒计时 (\d+)s/);
    if (!m1) throw new Error(`恢复后横条无倒计时秒数（text='${stripAfter.text.slice(0, 40)}'）`);
    const cdS1 = Number(m1[1]);
    const sample2 = await waitFor(`W-queue-restore-countdown：倒计时秒数第二采样递减（首采样=${cdS1}s）`, async () => {
      const s = await queueStripState(ws);
      const m = s.present ? s.text.match(/队列倒计时 (\d+)s/) : null;
      return m && Number(m[1]) < cdS1 ? { s2: Number(m[1]), text: s.text } : false;
    }, 15, 250);
    const gateAfter = await chatInputGate(ws);
    // 「发送可用」权威口径=textarea 非 disabled（A3 chatInputDisabled 门）；send 按钮额外叠加
    // 空草稿条件（!modelValue.trim() && !hasAttachments）——空草稿期恒 disabled，不作判据。
    if (gateAfter.textareaDisabled !== false) {
      throw new Error(`恢复完成后发送仍不可用（textareaDisabled=${gateAfter.textareaDisabled}）`);
    }
    // 6) ChatInput 发送 → 入队证据三件套 + 无直发回合（T1R-1 期望 c）。
    const bubblesBeforeSend = await assistantBubbleCount(ws);
    const frameBaseline1 = frameEvidence.received.length;
    await setChatInput(ws, 'e2e-t1r1-usermsg');
    await clickSend(ws);
    const notice = await waitFor('W-queue-restore-countdown：入队反馈（已加入队列）', async () => {
      const n = await noticeState(ws);
      return n.present && n.text.includes('已加入队列') ? n.text : false;
    }, 5, 50);
    await openQueuePanelTab(ws, 'W-queue-restore-countdown');
    await waitFor('W-queue-restore-countdown：任务卡#2 渲染（e2e-t1r1-usermsg）', () => evalOk(ws, `[...document.querySelectorAll('.task-item .task-item__prompt')].some((n) => (n.textContent || '').includes('e2e-t1r1-usermsg'))`), 10);
    // tasks_changed 帧断言：基线后任一帧含新任务（sessionId 匹配 + prompt + pending）——
    // 取「任一帧」而非「末帧」（末帧可能是后续广播的中间态；Task 序列化字段=prompt）。
    const frame1 = await waitFor('W-queue-restore-countdown：tasks_changed 帧到达（含新任务）', () => {
      const frames = queueChangedFramesSince(frameBaseline1);
      return frames.some((f) => f.sessionId === wqrcSid
        && Array.isArray(f.data?.tasks)
        && f.data.tasks.some((t) => t && t.prompt === 'e2e-t1r1-usermsg' && t.status === 'pending'));
    }, 10, 100);
    // A2-3 顺序断言：入队追加尾部（task1 在前、usermsg 在后）；原任务不打断抽样（task1 仍 pending、倒计时继续）。
    const ovAfterEnqueue = await pollOverview(ws, wqrcSid, '入队后快照（2 任务）', (o) => (o.tasks ?? []).length === 2, 8);
    const texts = (ovAfterEnqueue.tasks ?? []).map((t) => t.prompt);
    if (texts[0] !== 'e2e-t1r1-task1' || texts[1] !== 'e2e-t1r1-usermsg') {
      throw new Error(`入队未追加尾部（tasks=${JSON.stringify(texts)}，期望 [task1, usermsg]——A2-4 违背）`);
    }
    if (ovAfterEnqueue.state?.status !== 'countdown') throw new Error(`入队后队列状态被打断（status=${ovAfterEnqueue.state?.status}，期望 countdown 继续）`);
    if ((ovAfterEnqueue.tasks ?? [])[0]?.status !== 'pending') throw new Error('原任务#1 非 pending（被打断/被执行）');
    // 无直发回合：assistant 气泡计数不增（入队消息不出现在聊天流）。P24 sleep 清理：固定
    // sleep(2500) → 有界条件观察窗（预算仍 2.5s 不放宽语义）——窗内任一时刻气泡增长即快速失败，
    // 窗满无增长=无直发（缺席断言的观察窗语义不可事件化，条件化后等价且失败更快）。
    let bubblesAfterSend = Number(bubblesBeforeSend);
    const noDirectDeadline = Date.now() + 2500;
    while (Date.now() < noDirectDeadline) {
      bubblesAfterSend = Number(await assistantBubbleCount(ws));
      if (bubblesAfterSend !== Number(bubblesBeforeSend)) break;
      await sleep(100);
    }
    if (bubblesAfterSend !== Number(bubblesBeforeSend)) {
      throw new Error(`出现直发回合迹象（assistant 气泡 ${bubblesBeforeSend} → ${bubblesAfterSend}）`);
    }
    if (exceptions.length > exceptionsBeforeQ1) throw new Error('W-queue-restore-countdown 用例期间出现 exceptionThrown');
    record('W-queue-restore-countdown', 'PASS', `倒计时中刷新→恢复→发送=入队全链：基线空态 standby → addTask#1 → countdown(remaining=${ovCount.state.countdownRemaining}s) → 整页刷新（等加载完成）→ 恢复后发送可用+状态横条「${stripAfter.text}」+ P35 两采样递减（${cdS1}s→${sample2.s2}s）→ 发送=入队（notice「${String(notice).slice(0, 24)}」+ 任务卡 e2e-t1r1-usermsg + tasks_changed 帧 sessionId 匹配 + assistant 气泡 ${bubblesBeforeSend}→${bubblesAfterSend} 无直发回合）+ A2-4 尾部追加 [task1, usermsg] + 原任务不打断抽样（countdown 继续/task1 pending）`);
    await screenshot(ws, 'W-queue-restore-countdown');
  } catch (e) { record('W-queue-restore-countdown', 'FAIL', e.message); await screenshot(ws, 'W-queue-restore-countdown-failed'); }
  // 善后：清队列任务（countdown 走完前删除 pending 任务；若已在执行则先中断该回合），删物化会话。
  try {
    if (wqrcSid) {
      const ov = await queueOverview(ws, wqrcSid);
      for (const t of (ov.tasks ?? []).filter((x) => x.status === 'pending')) {
        await evalExpr(ws, `window.claudeLink.removeTask(${JSON.stringify(t.id)}).then(() => true)`);
      }
      if (ov.state?.status === 'running') {
        await evalExpr(ws, `window.claudeLink.abortChat(${JSON.stringify(wqrcSid)}).then(() => true)`);
        await waitTurnSettled(ws, 'W-queue-restore-countdown 善后', 60);
      }
    }
  } catch (e) { log(`  W-queue-restore-countdown 善后异常（申报）：${String(e.message).slice(0, 120)}`); }
  await deleteActiveSessionViaStore(ws);
  await screenshot(ws, 'W-queue-restore-countdown-cleaned');

  // ── W-queue-restore-running：T1R-2 running 中刷新 → sending 恢复 → 发送=入队 ──
  // 长任务措辞（※首跑校准）：指示模型写长文不用工具，保证 running 窗 ≥ 刷新+恢复+发送全程。
  // 「无直发回合」断言形态：running 期间首轮回合流可能经重连回流渲染（assistant 计数不稳），
  // 改以「第二条消息不以 user 气泡出现在聊天流」（入队消息出队执行前不可见，B3 反馈注释同源）
  // + tasks_changed 帧证据 + 快照 2 任务三件套。A2-4 queueEnabled=false 恒直发抽验并入收尾，
  // 独立记账条目 W-queue-restore-running-a2-4。
  currentCase = 'W-queue-restore-running';
  let wqrrSid = '';
  try {
    const exceptionsBeforeQ2 = exceptions.length;
    await ensureLanBridge(ws, 'W-queue-restore-running');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-queue-restore-running：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    await materializeSession(ws, 'W-queue-restore-running', W_WAKE_TEXT);
    wqrrSid = await activeSessionId(ws);
    if (!wqrrSid) throw new Error('无法取得物化会话 id');
    // 1) addTask 长任务 → 轮询至 running 且存在执行中回合（currentTaskId 非空；60s 倒计时 + 裕量）。
    const addLong = JSON.parse(String(await evalExpr(ws, `window.claudeLink.addTask(${JSON.stringify(wqrrSid)}, { text: 'e2e-t1r2-longtask：请写一篇约500字的散文，主题「季节与时间」。不要使用任何工具，不要使用 markdown 标题。', attachmentIds: [], clientMessageId: crypto.randomUUID() }).then((r) => JSON.stringify({ taskId: (r.task && r.task.id) || '' }))`)));
    if (!addLong.taskId) throw new Error('长任务 addTask 回包无 taskId');
    // 校准链同 countdown 场景：TASK_ADD 不自动 arm——面板「暂停→恢复」同语义链启动倒计时，
    // 60s 后引擎自动出队执行 → running。
    await evalExpr(ws, `window.claudeLink.setTaskPaused(${JSON.stringify(addLong.taskId)}, true).then(() => true)`);
    await evalExpr(ws, `window.claudeLink.setTaskPaused(${JSON.stringify(addLong.taskId)}, false).then(() => true)`);
    const ovRun = await pollOverview(ws, wqrrSid, '长任务进入 running', (o) => o.state?.status === 'running' && !!o.state?.currentTaskId, 90);
    log(`  running 在位（currentTaskId=${String(ovRun.state.currentTaskId).slice(0, 8)}…），条件等待回合真开跑`);
    // 「回合真开跑」条件等待（P24 sleep 清理：硬 sleep 2000ms → stream-group 在场即开跑；
    // 零流式回合容忍口径同 waitTurnSettled，权威锚=上方 currentTaskId 轮询）。
    await waitFor('W-queue-restore-running：执行中回合已开跑（stream-group 在场）', () => evalOk(ws, `!!document.querySelector('.stream-group')`), 15)
      .catch(() => log('  15s 未见 stream-group（容忍零流式回合），按权威快照 currentTaskId 收口'));
    // 2) running 中刷新（等刷新完成——P24 修复）→ 恢复。
    await reloadAndReconnect(ws, 'W-queue-restore-running');
    // 3) 恢复后断言：队列状态指示 running（「队列任务执行中」，轮询收口替代旧 sleep(500)+单点读）
    //    + 执行中任务卡可见 + 发送可用。
    const stripRun = await waitFor('W-queue-restore-running：running 恢复态横条呈现（队列任务执行中）', async () => {
      const s = await queueStripState(ws);
      return s.present && s.text.includes('队列任务执行中') ? s : false;
    }, 15);
    const ovRunAfter = await queueOverview(ws, wqrrSid);
    if (ovRunAfter.state?.status !== 'running') throw new Error(`恢复后权威快照非 running（status=${ovRunAfter.state?.status}）`);
    if (ovRunAfter.state?.currentTaskId !== ovRun.state.currentTaskId) throw new Error('恢复后 currentTaskId 变化（执行中回合丢失/换代）');
    await openQueuePanelTab(ws, 'W-queue-restore-running');
    // 「运行中任务卡」证据形态校准：task_started 后任务从 pending 列表移除、进 executed 历史
    //（executed-fold 区 outcome='running' 行；默认折叠——先点开折钮再查行）。
    await evalExpr(ws, `(() => {
      const btn = document.querySelector('.executed-fold .executed-fold__title');
      if (btn && !btn.querySelector('.executed-fold__arrow--open')) btn.click();
      return true;
    })()`);
    await waitFor('W-queue-restore-running：执行中任务在 executed 区可见', () => evalOk(ws, `[...document.querySelectorAll('.executed-entry')].some((n) => (n.textContent || '').includes('e2e-t1r2-longtask'))`), 10);
    const gateRun = await chatInputGate(ws);
    if (gateRun.textareaDisabled !== false) throw new Error(`running 恢复后发送不可用（textareaDisabled=${gateRun.textareaDisabled}）`);
    await screenshot(ws, 'W-queue-restore-running-restored');
    // 4) ChatInput 发送第二条 → 入队证据三件套。
    const frameBaseline2 = frameEvidence.received.length;
    await setChatInput(ws, 'e2e-t1r2-second：请只回复数字 42,不要使用任何工具');
    await clickSend(ws);
    await waitFor('W-queue-restore-running：入队反馈（已加入队列）', async () => {
      const n = await noticeState(ws);
      return n.present && n.text.includes('已加入队列') ? n.text : false;
    }, 5, 50);
    await waitFor('W-queue-restore-running：任务卡#2 渲染', () => evalOk(ws, `[...document.querySelectorAll('.task-item .task-item__prompt')].some((n) => (n.textContent || '').includes('e2e-t1r2-second'))`), 10);
    // tasks_changed 帧断言：同 countdown 场景口径——基线后任一帧含新任务（sessionId+prompt+pending）。
    // 注：长任务已在执行（status=running 不入 pendingTasksOf），帧 tasks 恰为 [task2]。
    const frame2 = await waitFor('W-queue-restore-running：tasks_changed 帧到达（含新任务）', () => {
      const frames = queueChangedFramesSince(frameBaseline2);
      return frames.some((f) => f.sessionId === wqrrSid
        && Array.isArray(f.data?.tasks)
        && f.data.tasks.some((t) => t && t.prompt === 'e2e-t1r2-second：请只回复数字 42,不要使用任何工具' && t.status === 'pending'));
    }, 10, 100);
    const userTexts = await userBubbleTexts(ws);
    if (userTexts.some((t) => String(t).includes('e2e-t1r2-second'))) {
      throw new Error('第二条消息以 user 气泡出现在聊天流（直发插队形态，违背入队语义）');
    }
    if (exceptions.length > exceptionsBeforeQ2) throw new Error('W-queue-restore-running 用例期间出现 exceptionThrown');
    record('W-queue-restore-running', 'PASS', `running 中刷新→sending 恢复→发送=入队：长任务 running(currentTaskId 稳定) → 刷新（等加载完成）→ 横条「队列任务执行中」+ 执行中任务卡可见 + 发送可用 → 第二条=入队（notice 已加入队列 + 任务卡 + tasks_changed 帧 sessionId 匹配 pending）+ 无直发抽验（聊天流无该消息 user 气泡——入队消息出队前不可见）`);
    await screenshot(ws, 'W-queue-restore-running');
  } catch (e) { record('W-queue-restore-running', 'FAIL', e.message); await screenshot(ws, 'W-queue-restore-running-failed'); }
  // 善后：删 pending 任务 → 中断执行中回合 → 删会话。
  try {
    if (wqrrSid) {
      const ov = await queueOverview(ws, wqrrSid);
      for (const t of (ov.tasks ?? []).filter((x) => x.status === 'pending')) {
        await evalExpr(ws, `window.claudeLink.removeTask(${JSON.stringify(t.id)}).then(() => true)`);
      }
      if (ov.state?.status === 'running') {
        await evalExpr(ws, `window.claudeLink.abortChat(${JSON.stringify(wqrrSid)}).then(() => true)`);
        await waitTurnSettled(ws, 'W-queue-restore-running 善后', 60);
      }
    }
  } catch (e) { log(`  W-queue-restore-running 善后异常（申报）：${String(e.message).slice(0, 120)}`); }
  await deleteActiveSessionViaStore(ws);
  await screenshot(ws, 'W-queue-restore-running-cleaned');

  // ── W-queue-restore-running-a2-4：A2-4 queueEnabled=false 恒直发（独立记账抽验）──
  // 经 config store 翻转 queueEnabled=false → 发送 → user 气泡出现（直发）+ 无任务卡/无帧。
  // 独立场景化：与 running 主场景分离，避免开关翻转污染主链路；收尾恢复 true。
  currentCase = 'W-queue-restore-running-a2-4';
  let a24Sid = '';
  try {
    const exceptionsBeforeA24 = exceptions.length;
    await ensureLanBridge(ws, 'W-queue-restore-running-a2-4');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-queue-restore-running-a2-4：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    await materializeSession(ws, 'W-queue-restore-running-a2-4', W_WAKE_TEXT);
    a24Sid = await activeSessionId(ws);
    if (!a24Sid) throw new Error('无法取得物化会话 id');
    // 翻转 queueEnabled=false（config store 直设 + saveConfig 持久化；主进程 onQueueEnabledChanged 联动）。
    await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const cs = pinia && pinia._s ? pinia._s.get('config') : null;
      if (!cs) return false;
      cs.config.queueEnabled = false;
      void cs.saveConfig();
      return true;
    })()`);
    await sleep(600);
    // 发送 → 直发证据：user 气泡出现该文本；反向：无任务卡、无 tasks_changed 帧。
    const frameBaselineA24 = frameEvidence.received.length;
    await setChatInput(ws, 'e2e-a24-direct：请只回复数字 42,不要使用任何工具');
    await clickSend(ws);
    await waitFor('W-queue-restore-running-a2-4：直发 user 气泡出现', () => evalOk(ws, `[...document.querySelectorAll('.bubble-wrap--user .bubble')].some((b) => (b.innerText || '').includes('e2e-a24-direct'))`), 10);
    const frameA24 = queueChangedFramesSince(frameBaselineA24);
    if (frameA24.length > 0) throw new Error('queueEnabled=false 发送出现 tasks_changed 帧（误入队）');
    const ovA24 = await queueOverview(ws, a24Sid);
    if ((ovA24.tasks ?? []).length > 0) throw new Error('queueEnabled=false 发送产生了队列任务（误入队）');
    await waitTurnSettled(ws, 'W-queue-restore-running-a2-4 直发回合', 90);
    if (exceptions.length > exceptionsBeforeA24) throw new Error('W-queue-restore-running-a2-4 用例期间出现 exceptionThrown');
    record('W-queue-restore-running-a2-4', 'PASS', `A2-4 直发抽验：queueEnabled=false 翻转 → 发送 e2e-a24-direct → user 气泡出现（直发）+ tasks_changed 帧零条 + 快照 tasks 空 → 收尾还原 queueEnabled=true`);
    await screenshot(ws, 'W-queue-restore-running-a2-4');
  } catch (e) { record('W-queue-restore-running-a2-4', 'FAIL', e.message); await screenshot(ws, 'W-queue-restore-running-a2-4-failed'); } finally {
    // 恢复 queueEnabled=true 必须无条件执行（try 内失败路径若跳过还原，queueEnabled=false 会
    // 持久化到隔离配置，污染本轮后续场景与下一轮 B 链——run-2 事故根因，见 t1b 报告）。
    try {
      await evalExpr(ws, `(() => {
        const app = document.querySelector('#app');
        const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
        const cs = pinia && pinia._s ? pinia._s.get('config') : null;
        if (!cs) return false;
        cs.config.queueEnabled = true;
        void cs.saveConfig();
        return true;
      })()`);
      await sleep(600);
      log('  a2-4 收尾：queueEnabled 已还原 true');
    } catch (e) { log(`  a2-4 收尾 queueEnabled 还原失败（申报）：${String(e.message).slice(0, 120)}`); }
  }
  try {
    if (a24Sid) {
      const ov = await queueOverview(ws, a24Sid);
      for (const t of (ov.tasks ?? []).filter((x) => x.status === 'pending')) {
        await evalExpr(ws, `window.claudeLink.removeTask(${JSON.stringify(t.id)}).then(() => true)`);
      }
      if (ov.state?.status === 'running') {
        await evalExpr(ws, `window.claudeLink.abortChat(${JSON.stringify(a24Sid)}).then(() => true)`);
        await waitTurnSettled(ws, 'W-queue-restore-running-a2-4 善后', 60);
      }
    }
  } catch { /* 善后尽力而为 */ }
  await deleteActiveSessionViaStore(ws);
  await screenshot(ws, 'W-queue-restore-running-a2-4-cleaned');

  // ── W-queue-restore-standby：T1R-3 standby 中刷新 → 发送=直发 ──
  // 空态 standby（queueEnabled=true + 零任务）直发主路径；熔断待命态制造依赖「暂停队列」入口
  //（※选择器首跑校准未做——以判据行为测试 A2-1 兜底，本场景按 T1R-3 夹注记 SKIP 降级申报）。
  // standby 轻量指示：实现口径 standby 无暂停/熔断不渲染横条（ChatPage queueStatusLine 注释），
  // 故恢复后断言=发送可用 + taskStore 权威投影 standby（A3-4 选择器钉意图为准，申报口径）。
  currentCase = 'W-queue-restore-standby';
  let wqrsSid = '';
  try {
    const exceptionsBeforeQ3 = exceptions.length;
    await ensureLanBridge(ws, 'W-queue-restore-standby');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-queue-restore-standby：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    await materializeSession(ws, 'W-queue-restore-standby', W_WAKE_TEXT);
    wqrsSid = await activeSessionId(ws);
    if (!wqrsSid) throw new Error('无法取得物化会话 id');
    // 基线空态 standby（轮询收口，同 countdown 场景的 DOM-vs-主进程竞态处理）。
    const ov0 = await pollOverview(ws, wqrsSid, '基线空态 standby', (o) => o.state?.status === 'standby' && (o.tasks ?? []).length === 0, 30);
    // 刷新 → 恢复完成：发送可用 + taskStore 权威投影 standby。
    await reloadAndReconnect(ws, 'W-queue-restore-standby');
    await waitFor('W-queue-restore-standby：恢复完成（发送可用）', () => evalOk(ws, `(() => {
      const ta = document.querySelector('[data-testid="chat-input-textarea"]');
      return !!ta && ta.disabled === false;
    })()`), 15);
    const tsState = JSON.parse(String(await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const ts = pinia && pinia._s ? pinia._s.get('task') : null;
      return JSON.stringify({ status: ts?.queueState?.status ?? '', sidMatch: ts?.queueState?.sessionId === ${JSON.stringify(wqrsSid)}, ready: ts?.overviewReadyBySession?.[${JSON.stringify(wqrsSid)}] === true });
    })()`)));
    if (tsState.status !== 'standby' || tsState.sidMatch !== true || tsState.ready !== true) {
      throw new Error(`恢复后 taskStore 投影非 standby 过门（status=${tsState.status} sidMatch=${tsState.sidMatch} ready=${tsState.ready}）`);
    }
    // 直发：发送 → user 气泡 + 回合启动；反向：无任务卡新增、无 tasks_changed 帧。
    const frameBaseline3 = frameEvidence.received.length;
    // 直发回合容错重发（一次）：上游空流偶发 error（无 text_delta → stream-group 不出现，
    // run-4 实测 21s 后 outcome=error）——回合 error 不改变「直发路由」语义本身，重发一次
    // 拿 42 终态（申报：容错重发不放宽直发断言；误入队反证独立成立）。
    let finalText = '';
    for (let attempt = 1; attempt <= 2; attempt++) {
      await setChatInput(ws, '请只回复数字 42,不要使用任何工具');
      await clickSend(ws);
      // 终态检测（materializeSession 同款口径，容忍单 token 回复零流式——stream-group 对
      // 一次性到齐的短回复可能整回合不渲染，run-6 实测 5.6s 回合无流式组）：assistant 末气泡
      // 含 42 且无 stream-group。回合 error 时末气泡不含 42 → 记一次重发。
      await waitFor(`W-queue-restore-standby：直发回合终态（第 ${attempt} 次）`, () => evalOk(ws, `(() => {
        const b = document.querySelectorAll('.bubble--assistant');
        const last = b[b.length - 1];
        return !!(last && (last.innerText || '').includes('42')) && !document.querySelector('.stream-group');
      })()`), 120);
      finalText = await evalExpr(ws, `(() => {
        const b = document.querySelectorAll('.bubble--assistant');
        return b.length ? (b[b.length - 1].innerText || '') : '';
      })()`);
      if (String(finalText).includes('42')) break;
      if (attempt === 1) log('  standby 直发回合终态不含 42（上游偶发 error），重发一次');
    }
    if (!String(finalText).includes('42')) throw new Error(`直发回合终态不含 42（含一次重发，text=${String(finalText).slice(0, 60)}）`);
    const framesQ3 = queueChangedFramesSince(frameBaseline3);
    if (framesQ3.length > 0) throw new Error('standby 直发出现 tasks_changed 帧（误入队）');
    const ov3 = await queueOverview(ws, wqrsSid);
    if ((ov3.tasks ?? []).length > 0) throw new Error('standby 直发产生了队列任务（误入队）');
    if (exceptions.length > exceptionsBeforeQ3) throw new Error('W-queue-restore-standby 用例期间出现 exceptionThrown');
    record('W-queue-restore-standby', 'PASS', `空态 standby 刷新→恢复→发送=直发：恢复后发送可用 + taskStore 投影 standby 过门（实现口径 standby 无暂停/熔断不渲染横条，申报）→ 直发回合完成（终态含 42）+ tasks_changed 帧零条 + 快照 tasks 空（A2.2 回归红线；熔断待命态制造依赖暂停入口未做，判据行为测试 A2-1 兜底——SKIP 申报见 t1b 报告）`);
    await screenshot(ws, 'W-queue-restore-standby');
  } catch (e) { record('W-queue-restore-standby', 'FAIL', e.message); await screenshot(ws, 'W-queue-restore-standby-failed'); }
  await deleteActiveSessionViaStore(ws);
  await screenshot(ws, 'W-queue-restore-standby-cleaned');

  // ── W-turn-footnote：F1-2a 成功形态不可见（P2 翻转） + F1-2b 工具结尾同判 + F1-3 interrupted 对照 ──
  // 锚点（MessageList F1）：[data-testid="turn-footnote"]，位于 .message-list__inner 内 renderItems
  // 循环后。P2（2026-11-21 批次）：success 形态不再渲染（信息无损——②气泡脚注与④TurnTimer 承载），
  // F1-2a/F1-2b 由「成功形态可见」翻转为「不可见」（载体不存在或零尺寸/隐藏的等价不可见形态，
  // 且不得出现 turn-footnote--success 类）；F1-3「仅最新回合」改挂 interrupted 对照——pinia 注入
  // interrupted 记账（session store 单槽，空闲态入账）→ 载体恰 1 且 kind interrupted → 真实发送
  // 新回合（markRunning 清槽）→ 载体退场（清槽行为不变的结构性证明）。工具结尾措辞
  //（※首跑校准）：指示模型调用 Bash echo 后回复 42；工具块 .tool-row 在末条内容块区。
  currentCase = 'W-turn-footnote';
  let wfnSid = '';
  try {
    const exceptionsBeforeF = exceptions.length;
    await ensureLanBridge(ws, 'W-turn-footnote');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-turn-footnote：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    // ① F1-2a：成功·正文结尾回合 → 成功脚注不可见（P2）+ ②气泡脚注在场（信息无损 + P4 时钟格式）。
    // 成功脚注若按旧形态渲染会晚于 materializeSession 的 42 终态一拍（sending 下降沿/turn_ended 后）
    // ——给同窗等待再判不可见，覆盖「迟到渲染」窗口（若旧实现回归，该窗内必现 --success）。
    await materializeSession(ws, 'W-turn-footnote', W_WAKE_TEXT);
    wfnSid = await activeSessionId(ws);
    if (!wfnSid) throw new Error('无法取得物化会话 id');
    await sleep(1200); // 旧实现脚注渲染窗（turn_ended 后一拍）——等满再判不可见
    const fnState1 = JSON.parse(String(await evalExpr(ws, `(() => {
      const inner = document.querySelector('.message-list__inner');
      const fns = [...document.querySelectorAll('[data-testid="turn-footnote"]')];
      const last = fns[fns.length - 1] ?? null;
      const visible = !!last && last.offsetParent !== null && (last.offsetWidth > 0 || last.offsetHeight > 0);
      const anySuccess = !!document.querySelector('.turn-footnote--success');
      const dur = document.querySelector('.bubble-wrap--assistant .bubble__meta-duration');
      return JSON.stringify({
        count: fns.length,
        text: last ? ((last.textContent || '').trim()) : '',
        kind: last ? (last.className || '') : '',
        visible,
        anySuccess,
        hasBubbleDur: !!dur,
        durText: dur ? ((dur.textContent || '').trim()) : '',
      });
    })()`)));
    if (fnState1.anySuccess) throw new Error('出现 .turn-footnote--success（P2：成功回合脚注③已移除，渲染面回归）');
    if (fnState1.count > 0 && fnState1.visible) throw new Error(`成功回合后 turn-footnote 载体可见（${fnState1.count} 个，'${fnState1.text.slice(0, 40)}'）——P2 要求 success 形态不可见`);
    if (fnState1.count > 0 && fnState1.kind.includes('success')) throw new Error(`载体 kind 含 success（P2 违背：'${fnState1.kind}'）`);
    if (!fnState1.hasBubbleDur) throw new Error('assistant 气泡脚注②（.bubble__meta-duration）不在场（P2 信息无损前提：②须承接耗时展示）');
    if (!/^\d+:\d{2}(:\d{2})?$/.test(fnState1.durText) || /^\d+(\.\d+)?s$/.test(fnState1.durText)) {
      throw new Error(`②耗时文本 '${fnState1.durText}' 不符时钟格式（期望 m:ss / H:MM:SS，不得小数秒形态——P4）`);
    }
    await screenshot(ws, 'W-turn-footnote-text-tail');
    // ② F1-2b：工具+思考结尾回合 → 成功脚注同判不可见（P2）；toolSeen 保留（工具块观测面）。
    // 终态检测容忍零流式（单次回复 stream-group 可能整回合不渲染——run-6 实测）+ 容错重发
    //（一次）：工具回合对上游偶发 error 重发一次拿工具块（申报：重发不放宽 P2 断言）。
    let toolSeen = false;
    let fnState2 = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      // 每次尝试独立取气泡基线（跨尝试复用全局基线会让第 2 次的终态检测被第 1 次的产出
      // 瞬时满足——run-7 假红根因）。
      const beforeThis = Number(await assistantBubbleCount(ws));
      await setChatInput(ws, '请调用 Bash 工具执行命令：echo e2e-footnote-probe。执行完成后只回复数字 42,不要使用任何其他工具。');
      await clickSend(ws);
      await waitFor(`W-turn-footnote：第二回合 user 气泡受理（第 ${attempt} 次）`, () => evalOk(ws, `[...document.querySelectorAll('.bubble-wrap--user .bubble')].filter((b) => (b.innerText || '').includes('e2e-footnote-probe')).length >= ${attempt}`), 10);
      // 终态：无 stream-group 且 assistant 气泡数增长（新回合产出落 DOM；成功/错误文本均算终态；
      // 零流式回合 stream-group 可能整回合不渲染——终端条件已不依赖其在场）。
      await waitFor(`W-turn-footnote：工具回合终态（第 ${attempt} 次）`, () => evalOk(ws, `(() => {
        const b = document.querySelectorAll('.bubble--assistant').length;
        return !document.querySelector('.stream-group') && b > ${beforeThis};
      })()`), 150);
      await sleep(1200); // 同①：等满旧实现脚注渲染窗再判
      toolSeen = await evalOk(ws, `!!document.querySelector('.tool-row')`);
      fnState2 = JSON.parse(String(await evalExpr(ws, `(() => {
        const fns = [...document.querySelectorAll('[data-testid="turn-footnote"]')];
        const last = fns[fns.length - 1] ?? null;
        const visible = !!last && last.offsetParent !== null && (last.offsetWidth > 0 || last.offsetHeight > 0);
        return JSON.stringify({
          count: fns.length,
          text: last ? ((last.textContent || '').trim()) : '',
          kind: last ? (last.className || '') : '',
          visible,
          anySuccess: !!document.querySelector('.turn-footnote--success'),
        });
      })()`)));
      if (toolSeen && fnState2.count === 0 && !fnState2.anySuccess) break;
      if (attempt === 1) log(`  footnote 工具回合首试未达工具+不可见形态（toolSeen=${toolSeen} footnote count=${fnState2?.count}），重发一次`);
    }
    if (!fnState2 || fnState2.anySuccess || (fnState2.count > 0 && fnState2.visible)) {
      throw new Error(`工具回合后成功脚注可见或 --success 在场（count=${fnState2?.count ?? 'n/a'}，anySuccess=${fnState2?.anySuccess}）——P2 违背`);
    }
    if (fnState2.count > 0 && fnState2.kind.includes('success')) throw new Error(`载体 kind 含 success（P2 违背：'${fnState2.kind}'）`);
    // ③ F1-3 仅最新回合（interrupted 对照）：pinia session store 注入 interrupted 记账（单槽、
    // 空闲态入账）→ 载体恰 1 且 kind interrupted + 文案「已中断」→ 真实发送新回合（markRunning
    // 清槽即时）→ 载体退场。新回合不必等终态（断言对象=清槽行为本身）。
    const injected = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      if (!st) return JSON.stringify({ ok: false, reason: 'no-session-store' });
      const sid = st.activeSession && st.activeSession.id;
      if (!sid) return JSON.stringify({ ok: false, reason: 'no-active-session' });
      if (st.runningSessions.includes(sid)) return JSON.stringify({ ok: false, reason: 'session-running' });
      st.setTurnFootnote(sid, { outcome: 'interrupted', durationMs: 4200, endedAt: Date.now() });
      return JSON.stringify({ ok: true, sid });
    })()`);
    const inj = JSON.parse(String(injected));
    if (!inj.ok) throw new Error(`interrupted 对照注入失败（${inj.reason ?? 'unknown'}）`);
    await waitFor('W-turn-footnote：interrupted 脚注渲染（恰 1 个、kind interrupted）', () => evalOk(ws, `(() => {
      const fns = [...document.querySelectorAll('[data-testid="turn-footnote"]')];
      return fns.length === 1 && (fns[0].className || '').includes('interrupted') && (fns[0].textContent || '').includes('已中断');
    })()`), 5);
    await screenshot(ws, 'W-turn-footnote-interrupted');
    // 新回合起步（markRunning 清槽）→ interrupted 脚注退场（仅最新回合清槽行为不变）。
    const beforeNew = Number(await assistantBubbleCount(ws));
    await setChatInput(ws, 'e2e-footnote-probe：请只回复数字 7,不要使用任何工具');
    await clickSend(ws);
    await waitFor('W-turn-footnote：新回合 user 气泡受理', () => evalOk(ws, `[...document.querySelectorAll('.bubble-wrap--user .bubble')].filter((b) => (b.innerText || '').includes('e2e-footnote-probe：请只回复数字 7')).length >= 1`), 10);
    await waitFor('W-turn-footnote：interrupted 脚注已随新回合清槽退场', () => evalOk(ws, `document.querySelectorAll('[data-testid="turn-footnote"]').length === 0`), 5);
    // 新回合终态等待（成功/错误文本均算终态）——善后删除会话前回落空闲态（防 sending 中删除）。
    await waitFor('W-turn-footnote：对照新回合终态', () => evalOk(ws, `(() => {
      const b = document.querySelectorAll('.bubble--assistant').length;
      return !document.querySelector('.stream-group') && b > ${beforeNew};
    })()`), 150);
    if (exceptions.length > exceptionsBeforeF) throw new Error('W-turn-footnote 用例期间出现 exceptionThrown');
    record('W-turn-footnote', 'PASS', `F1-2a（P2 翻转）：成功正文结尾回合成功脚注不可见（count=${fnState1.count}、anySuccess=false）且②气泡脚注在场（'${fnState1.durText}' 时钟格式）；F1-2b：工具${toolSeen ? '在场' : '未见——重发后仍未见（降级申报见 tooltail 条目）'}回合同判不可见；F1-3（interrupted 对照）：注入 interrupted 记账 → 载体恰 1（kind interrupted）→ 新回合 markRunning 清槽 → 载体退场（仅最新回合行为不变）`);
    await screenshot(ws, 'W-turn-footnote');
    // F1-2b 附属记账：工具块在场 → PASS；否则 SKIP-with-reason（夹具降级申报：措辞已按 ※校准窗
    // 调整 + 重发一次，模型不配合/上游 error 均非本用例可控行）。
    if (toolSeen) {
      record('W-turn-footnote-tooltail', 'PASS', `F1-2b 工具+思考结尾形态：工具块（.tool-row）在末条内容区 + 成功脚注不可见（P2：②气泡脚注承接信息）`);
    } else {
      record('W-turn-footnote-tooltail', 'SKIP', `模型未配合调用 Bash 工具（toolSeen=false；措辞已校准+重发一次，LLM/上游行为非本用例可控行）——工具结尾形态由结构钉 F1-1（npx tsx scripts/tdd-turn-final-footnote-verify.ts 脚注载体与渲染条件）兜底；正文结尾/仅最新回合两断言已在主条目成立`);
    }
  } catch (e) { record('W-turn-footnote', 'FAIL', e.message); await screenshot(ws, 'W-turn-footnote-failed'); }
  await deleteActiveSessionViaStore(ws);
  await screenshot(ws, 'W-turn-footnote-cleaned');

  // ── W-question-sidenav：C1-14 场景 1（C1-1 结构 + C1-2 跳题/下一题恒可点 + C1-3 三态+进度 chip）──
  // 夹具（降级申报）：真实回合触发多题 AskUserQuestion 依赖模型配合（03b C1-14 夹注允许降级），
  // 本场景以 interaction store 注入真实 payload 形状（镜像 buildWizardAskUserQuestionPayload）+
  // respondInteraction 页内 stub 驱动变体 2 组件全 DOM 断言——变体 2 结构钉另由
  // npx tsx scripts/tdd-question-dialog-sidenav-verify.ts 兜底。bypassPermissions 已由隔离配置注入。
  currentCase = 'W-question-sidenav';
  let qNavPayload = null;
  try {
    const exceptionsBeforeW1 = exceptions.length;
    await ensureLanBridge(ws, 'W-question-sidenav');
    await evalExpr(ws, `(location.hash = '#/'), true`);
    await waitFor('W-question-sidenav：chat 路由就绪', () => evalOk(ws, `!!document.querySelector('button.new-button')`), 15);
    qNavPayload = await injectWizardFixture(ws);
    // C1-1 结构：左右分栏（nav + content）+ 左栏 3 题导航 + 右栏单题 + 翻页保留。
    // 分栏在位改轮询等待（10s 上限）：overlay 与 wizard 分栏虽同 patch 渲染（v-if 同树），
    // 但负载抖动下 eval 往返可能落在极端窗口——等待只是消抖，超时报错文案与原语义一致。
    await waitFor('W-question-sidenav：wizard 分栏渲染（nav/content 在位）', () => evalOk(ws, `!!document.querySelector('[data-testid="wizard-nav"]') && !!document.querySelector('[data-testid="wizard-content"]')`), 10);
    const struct = JSON.parse(String(await evalExpr(ws, `(() => {
      const nav = document.querySelector('[data-testid="wizard-nav"]');
      const items = [...document.querySelectorAll('[data-testid="wizard-nav-item"]')];
      const content = document.querySelector('[data-testid="wizard-content"]');
      const chip = document.querySelector('[data-testid="wizard-progress-chip"]');
      const count = (document.querySelector('.wizard-count')?.textContent || '').trim();
      return JSON.stringify({
        hasNav: !!nav, itemCount: items.length, hasContent: !!content,
        chipText: chip ? (chip.textContent || '').trim() : '', count,
      });
    })()`)));
    if (!struct.hasNav || !struct.hasContent) throw new Error('wizard 左右分栏缺失（nav/content 不在位）');
    if (struct.itemCount !== 3) throw new Error(`左栏题号导航项 ${struct.itemCount} ≠ 3`);
    if (struct.count !== '第 1 题 / 共 3 题') throw new Error(`右栏翻页计数异常（'${struct.count}'）`);
    if (!struct.chipText.includes('已答 0/3')) throw new Error(`进度 chip 异常（'${struct.chipText}'）`);
    // C1-2 跳题自由 + 左栏直达 + 下一题恒可点：q0 未答直接点左栏第 3 题 → 直达；上一题仅第一题禁用。
    const nextDisabledAtQ0 = await evalExpr(ws, `document.querySelector('[data-testid="wizard-next-btn"]')?.disabled ?? null`);
    if (nextDisabledAtQ0 !== false) throw new Error(`「下一题」在未答题被禁用（恒可点违背，disabled=${nextDisabledAtQ0}）`);
    // C1-2 步骤②（R5-4，round-005 回路内补断言）：未答题上点「下一题」→ 右栏切至下一题（R4-1
    // 跳过语义：不校验作答、不定位跳转）且警示 flag 不触发（wizardFlaggedIndex 仅由末题
    // submitWizard 置位）。
    await evalExpr(ws, `document.querySelector('[data-testid="wizard-next-btn"]').click(), true`);
    await waitFor('W-question-sidenav：未答 q0 点「下一题」前进到第 2 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 2 题 / 共 3 题'`), 5);
    const flaggedAfterNext = await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')].some((i) => i.classList.contains('wizard-nav__item--flagged'))`);
    if (flaggedAfterNext !== false) throw new Error('未答点「下一题」不应触发警示描边（wizardFlaggedIndex 被置位）');
    // R6-3（round-006）：前进非提交——跳过语义前进路径不得弹出丢弃确认层（wizard-discard-confirm 仅由取消/提交门触发）。
    const discardConfirmAfterNext = await evalExpr(ws, `!!document.querySelector('[data-testid="wizard-discard-confirm"]')`);
    if (discardConfirmAfterNext !== false) throw new Error('前进路径不得弹出丢弃确认层');
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].click(), true`);
    await waitFor('W-question-sidenav：左栏直达第 3 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 3 题 / 共 3 题'`), 5);
    const prevDisabledAtQ2 = await evalExpr(ws, `document.querySelector('[data-testid="wizard-prev-btn"]')?.disabled ?? null`);
    if (prevDisabledAtQ2 !== false) throw new Error('第 3 题「上一题」被禁用（仅第一题禁用违背）');
    // C1-3 三态标识：q0 作答（单选点击即答+自动前进）→ 左栏 ✓ + 状态行摘要 + current 高亮迁移 + chip 1/3。
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][0].click(), true`);
    await waitFor('W-question-sidenav：跳回第 1 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 1 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('开发环境'))?.click(), true`);
    await waitFor('W-question-sidenav：作答后自动前进到第 2 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 2 题 / 共 3 题'`), 5);
    const navState = JSON.parse(String(await evalExpr(ws, `(() => {
      const items = [...document.querySelectorAll('[data-testid="wizard-nav-item"]')];
      const first = items[0];
      return JSON.stringify({
        firstAnswered: first.classList.contains('answered'),
        firstMark: (first.querySelector('.row1 .n')?.textContent || '').trim(),
        firstSummary: (first.querySelector('.row2')?.textContent || '').trim(),
        secondCurrent: items[1].classList.contains('current'),
        chipText: (document.querySelector('[data-testid="wizard-progress-chip"]')?.textContent || '').trim(),
      });
    })()`)));
    if (navState.firstAnswered !== true || navState.firstMark !== '✓') throw new Error(`左栏已答态缺失（answered=${navState.firstAnswered} mark='${navState.firstMark}'）`);
    if (!navState.firstSummary.includes('开发环境')) throw new Error(`左栏答案摘要行异常（'${navState.firstSummary}'）`);
    if (navState.secondCurrent !== true) throw new Error('当前题高亮未迁移到第 2 题');
    if (!navState.chipText.includes('已答 1/3')) throw new Error(`进度 chip 未增量（'${navState.chipText}'）`);
    // 未答态「未作答」状态行抽验（第 3 题未答）。
    const row2Unanswered = await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].querySelector('.row2')?.textContent?.trim() ?? ''`);
    if (row2Unanswered !== '未作答') throw new Error(`未答状态行异常（'${row2Unanswered}'）`);
    if (exceptions.length > exceptionsBeforeW1) throw new Error('W-question-sidenav 用例期间出现 exceptionThrown');
    record('W-question-sidenav', 'PASS', `C1-1 分栏结构（nav 3 项+content 单题+计数「第 1 题 / 共 3 题」+chip 已答 0/3）→ C1-2 跳题自由（q0 未答直达第 3 题；下一题恒可点；未答点下一题前进第 2 题+flag 不触发+前进不弹丢弃确认层（R6-3）；上一题仅第一题禁用）→ C1-3 三态（q0 作答 ✓+摘要「开发环境」+current 迁移第 2 题+chip 已答 1/3+未答「未作答」）`);
    await screenshot(ws, 'W-question-sidenav');
  } catch (e) { record('W-question-sidenav', 'FAIL', e.message); await screenshot(ws, 'W-question-sidenav-failed'); } finally {
    if (qNavPayload) await cleanupWizardFixture(ws, qNavPayload.id);
  }
  await screenshot(ws, 'W-question-sidenav-cleaned');

  // ── W-question-guard：C1-14 场景 2（C1-6 丢弃确认 + C1-7 Esc 分域 + C1-9 Enter 分域 + C1-10 方向键）──
  currentCase = 'W-question-guard';
  let qGuardPayload = null;
  try {
    const exceptionsBeforeW2 = exceptions.length;
    await ensureLanBridge(ws, 'W-question-guard');
    // C1-6 丢弃二次确认：作答 q0 → 取消 → 确认层「丢弃本次作答？」→ 继续作答（层关弹窗在）
    // → 再取消 → 丢弃（弹窗关 + stub 记录 cancel）。
    qGuardPayload = await injectWizardFixture(ws);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('开发环境'))?.click(), true`);
    await waitFor('W-question-guard：q0 已答（自动前进）', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 2 题 / 共 3 题'`), 5);
    await evalExpr(ws, `document.querySelector('[data-testid="wizard-cancel-btn"]')?.click(), true`);
    await waitFor('W-question-guard：丢弃确认层出现', () => evalOk(ws, `!!document.querySelector('[data-testid="wizard-discard-confirm"]')`), 5);
    const discardText = await evalExpr(ws, `(document.querySelector('[data-testid="wizard-discard-confirm"] h3')?.textContent || '').trim()`);
    if (!String(discardText).includes('丢弃本次作答')) throw new Error(`丢弃确认文案异常（'${discardText}'）`);
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-discard-confirm"] button')].find((b) => (b.textContent || '').includes('继续作答'))?.click(), true`);
    await waitFor('W-question-guard：继续作答（确认层关）', () => evalOk(ws, `!document.querySelector('[data-testid="wizard-discard-confirm"]') && !!document.querySelector('[data-testid="wizard-nav"]')`), 5);
    await evalExpr(ws, `document.querySelector('[data-testid="wizard-cancel-btn"]')?.click(), true`);
    await waitFor('W-question-guard：确认层再现', () => evalOk(ws, `!!document.querySelector('[data-testid="wizard-discard-confirm"]')`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-discard-confirm"] button')].find((b) => (b.textContent || '').includes('丢弃'))?.click(), true`);
    await waitFor('W-question-guard：丢弃后弹窗关闭', () => evalOk(ws, `!document.querySelector('[data-testid="wizard-nav"]') && !document.querySelector('.interaction-overlay')`), 5);
    const logAfterDiscard = JSON.parse(String(await evalExpr(ws, `JSON.stringify(window.__e2eRespondLog ?? [])`)));
    if (logAfterDiscard.length !== 1 || logAfterDiscard[0].action !== 'cancel') {
      throw new Error(`丢弃路径未走 respond 链（stub log=${JSON.stringify(logAfterDiscard).slice(0, 80)}）`);
    }
    await cleanupWizardFixture(ws, qGuardPayload.id);
    qGuardPayload = null;
    // run-10 假红修复（2026-11-16 闸门轮）：C1-6 丢弃确认长链之后偶发「Esc 关整单」假红——
    // 隔离探针实证 C1-6→重注入→Esc 全链在干净应用 3/3 正确、纯 C1-7 子序列 5/5 正确，假红源
    // 是本场景之前 15 个场景的累积渲染层状态（跨场景污染，与本脚本 main() 开头 T1B 前置复位
    // 处置的跨轮污染同族）。处置：C1-6 与 C1-7 之间整页刷新硬隔离——C1-7/9/10 的零作答分域
    // 语义本就要求独立成立，刷新后逐字等价重放，场景意图不变。
    await cdpSend(ws, 'Page.reload');
    await waitFor('W-question-guard：刷新后桥连接（C1-7 硬隔离）', () => evalOk(ws, connectedExpr), 20);
    // 重新注入（零作答态）做 Esc/Enter/方向键分域。
    qGuardPayload = await injectWizardFixture(ws);
    // C1-7 Esc 分域：Other 输入框内 Esc 仅失焦不关整单。
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].click(), true`);
    await waitFor('W-question-guard：跳到第 3 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 3 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('Other'))?.click(), true`);
    await waitFor('W-question-guard：Other 输入展开', () => evalOk(ws, `(() => {
      const i = document.querySelector('.wizard-other input');
      return !!i && document.activeElement === i;
    })()`), 5);
    // Esc 派发带捕获探针（假红诊断留痕：window 实收 Esc 的 target 构造器）。
    await evalExpr(ws, `(() => {
      window.__escProbe = [];
      window.__escProbeFn = (e) => { if (e.key === 'Escape') window.__escProbe.push({ tag: e.target?.tagName ?? null, ctor: e.target?.constructor?.name ?? null, dp: e.defaultPrevented }); };
      window.addEventListener('keydown', window.__escProbeFn, true);
      const i = document.querySelector('.wizard-other input');
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return true;
    })()`);
    await sleep(300);
    const escProbe = await evalExpr(ws, `(() => { const p = window.__escProbe ?? []; try { window.removeEventListener('keydown', window.__escProbeFn, true); } catch { /* 尽力而为 */ } window.__escProbeFn = null; return JSON.stringify(p); })()`);
    const stillOpenEsc = await evalOk(ws, `!!document.querySelector('[data-testid="wizard-nav"]')`);
    if (!stillOpenEsc) {
      const escStore = await evalExpr(ws, `JSON.stringify({ kind: (() => { const app = document.querySelector('#app'); const p = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null; const ist = p && p._s ? p._s.get('interaction') : null; return ist?.activeRequest?.kind ?? null; })(), respondLog: (window.__e2eRespondLog ?? []).length, overlay: !!document.querySelector('.interaction-overlay'), discardConfirm: !!document.querySelector('[data-testid="wizard-discard-confirm"]') })`);
      throw new Error(`Other 输入框内 Esc 关闭了整单（Esc 分域违背）——探针=${escProbe} store=${escStore}`);
    }
    // C1-9 Enter 分域：Other 输入内 Enter=确认文本（blur，不提交）；焦点不在输入框时 Enter 无提交。
    await evalExpr(ws, `(() => {
      const i = document.querySelector('.wizard-other input');
      i.focus();
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(300);
    const enterState = JSON.parse(String(await evalExpr(ws, `JSON.stringify({
      dialogOpen: !!document.querySelector('[data-testid="wizard-nav"]'),
      respondCount: (window.__e2eRespondLog ?? []).length,
      blurred: document.activeElement !== document.querySelector('.wizard-other input'),
    })`)));
    if (!enterState.dialogOpen || enterState.respondCount !== 0) {
      throw new Error(`Other 输入内 Enter 产生提交（dialogOpen=${enterState.dialogOpen} respondCount=${enterState.respondCount}）`);
    }
    await evalExpr(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })), true`);
    await sleep(300);
    const enterBody = JSON.parse(String(await evalExpr(ws, `JSON.stringify({
      dialogOpen: !!document.querySelector('[data-testid="wizard-nav"]'),
      respondCount: (window.__e2eRespondLog ?? []).length,
    })`)));
    if (!enterBody.dialogOpen || enterBody.respondCount !== 0) {
      throw new Error('焦点不在输入框时 Enter 提交了弹窗（wizard 分流吞 Enter 失效）');
    }
    // C1-10 方向键仅移焦/滚动不改选中：ArrowDown 派发前后选中/焦点态不变（wizard 分流整体 return——
    // 注意 focusedIndex 初始 0 使首选项恒带 --focused，断言口径=前后差分，非绝对零）。
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][1].click(), true`);
    await waitFor('W-question-guard：跳到第 2 题（多选）', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 2 题 / 共 3 题'`), 5);
    const beforeArrow = JSON.parse(String(await evalExpr(ws, `JSON.stringify({
      selected: document.querySelectorAll('.wizard-content .interaction-option--selected').length,
      focused: document.querySelectorAll('.wizard-content .interaction-option--focused').length,
    })`)));
    await evalExpr(ws, `document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })), true`);
    await sleep(300);
    const afterArrow = JSON.parse(String(await evalExpr(ws, `JSON.stringify({
      selected: document.querySelectorAll('.wizard-content .interaction-option--selected').length,
      focused: document.querySelectorAll('.wizard-content .interaction-option--focused').length,
      dialogOpen: !!document.querySelector('[data-testid="wizard-nav"]'),
    })`)));
    if (afterArrow.selected !== beforeArrow.selected || afterArrow.focused !== beforeArrow.focused || afterArrow.dialogOpen !== true) {
      throw new Error(`方向键改写了选中/焦点态（selected ${beforeArrow.selected}→${afterArrow.selected} focused ${beforeArrow.focused}→${afterArrow.focused}——契约 8 违背）`);
    }
    if (exceptions.length > exceptionsBeforeW2) throw new Error('W-question-guard 用例期间出现 exceptionThrown');
    record('W-question-guard', 'PASS', `C1-6 丢弃二次确认（作答→取消→「丢弃本次作答」→继续作答弹窗在→再取消→丢弃→弹窗关+respond 链 cancel 记录）→ C1-7 Other 输入内 Esc 仅失焦不关单 → C1-9 Other 内 Enter 仅 blur 零提交 + body 上 Enter 零提交（wizard 吞 Enter）→ C1-10 ArrowDown 前后选中/焦点态零变化（selected=${beforeArrow.selected}→${afterArrow.selected} focused=${beforeArrow.focused}→${afterArrow.focused}）`);
    await screenshot(ws, 'W-question-guard');
  } catch (e) { record('W-question-guard', 'FAIL', e.message); await screenshot(ws, 'W-question-guard-failed'); } finally {
    if (qGuardPayload) await cleanupWizardFixture(ws, qGuardPayload.id);
  }
  await screenshot(ws, 'W-question-guard-cleaned');

  // ── W-question-submit：C1-14 场景 3（C1-8 Other 保全 + C1-5 未答齐跳转 + 答齐提交回传）──
  currentCase = 'W-question-submit';
  let qSubmitPayload = null;
  try {
    const exceptionsBeforeW3 = exceptions.length;
    await ensureLanBridge(ws, 'W-question-submit');
    qSubmitPayload = await injectWizardFixture(ws);
    // C1-8 Other 保全：q2 填 Other 文本 → 跳 q0 → 跳回 q2 → 输入值保留。
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].click(), true`);
    await waitFor('W-question-submit：跳到第 3 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 3 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('Other'))?.click(), true`);
    await waitFor('W-question-submit：Other 输入展开', () => evalOk(ws, `!!document.querySelector('.wizard-other input')`), 5);
    await evalExpr(ws, `(() => {
      const i = document.querySelector('.wizard-other input');
      i.value = 'e2e-other-keep-123';
      i.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][0].click(), true`);
    await waitFor('W-question-submit：跳到第 1 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 1 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].click(), true`);
    await waitFor('W-question-submit：跳回第 3 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 3 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('Other'))?.click(), true`);
    const otherKept = await evalExpr(ws, `document.querySelector('.wizard-other input')?.value ?? ''`);
    if (otherKept !== 'e2e-other-keep-123') throw new Error(`Other 文本跨跳转丢失（value='${otherKept}'——C1-8 违背）`);
    // C1-5 未答齐提交 → 自动跳转首个未答题 + 左栏红色警示描边（不弹 toast 不阻断）。
    await evalExpr(ws, `document.querySelector('[data-testid="wizard-next-btn"]').click(), true`);
    await waitFor('W-question-submit：未答齐提交跳转首个未答题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 1 题 / 共 3 题'`), 5);
    const flagged = await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][0].classList.contains('wizard-nav__item--flagged')`);
    if (flagged !== true) throw new Error('首个未答题左栏红色警示描边缺失（wizard-nav__item--flagged）');
    // 答齐提交：q0 选「生产环境」（自动前进 q1）→ q1 多选勾两项 → q2 已答（Other）→ 提交。
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('生产环境'))?.click(), true`);
    await waitFor('W-question-submit：自动前进到第 2 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 2 题 / 共 3 题'`), 5);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('认证'))?.click(), true`);
    await sleep(120);
    await evalExpr(ws, `[...document.querySelectorAll('.wizard-content .interaction-option')].find((b) => (b.textContent || '').includes('缓存'))?.click(), true`);
    await sleep(120);
    // 多选不自动前进：跳到最后一题（q2）后主按钮才变「提交」（wizardPrimaryLabel=末题分支）。
    await evalExpr(ws, `[...document.querySelectorAll('[data-testid="wizard-nav-item"]')][2].click(), true`);
    await waitFor('W-question-submit：跳到第 3 题', () => evalOk(ws, `(document.querySelector('.wizard-count')?.textContent || '').trim() === '第 3 题 / 共 3 题'`), 5);
    const submitLabel = await evalExpr(ws, `(document.querySelector('[data-testid="wizard-next-btn"]')?.textContent || '').trim()`);
    if (!String(submitLabel).includes('提交') || String(submitLabel).includes('（')) {
      throw new Error(`答齐后主按钮 label 异常（'${submitLabel}'，期望「提交」无括号计数）`);
    }
    await evalExpr(ws, `document.querySelector('[data-testid="wizard-next-btn"]').click(), true`);
    await waitFor('W-question-submit：答齐提交后弹窗关闭', () => evalOk(ws, `!document.querySelector('[data-testid="wizard-nav"]') && !document.querySelector('.interaction-overlay')`), 5);
    const respondLog = JSON.parse(String(await evalExpr(ws, `JSON.stringify(window.__e2eRespondLog ?? [])`)));
    if (respondLog.length !== 1) throw new Error(`提交回包数 ${respondLog.length} ≠ 1`);
    const resp = respondLog[0];
    if (resp.action !== 'submit') throw new Error(`回包 action=${resp.action}（期望 submit）`);
    const qa = resp.questionAnswers ?? {};
    const q0Sel = (qa.q0?.selectedOptionIds ?? []).join(',');
    const q1Sel = (qa.q1?.selectedOptionIds ?? []).join(',');
    const q2Other = qa.q2?.otherText ?? '';
    if (!q0Sel.includes('option-1')) throw new Error(`q0 答案回传异常（'${q0Sel}'，期望 option-1=生产环境）`);
    if (!q1Sel.includes('option-0') || !q1Sel.includes('option-2')) throw new Error(`q1 多选答案回传异常（'${q1Sel}'，期望 option-0+option-2）`);
    if (q2Other !== 'e2e-other-keep-123') throw new Error(`q2 Other 文本回传丢失（'${q2Other}'）`);
    if (exceptions.length > exceptionsBeforeW3) throw new Error('W-question-submit 用例期间出现 exceptionThrown');
    record('W-question-submit', 'PASS', `C1-8 Other 保全（'e2e-other-keep-123' 跨 q0↔q2 跳转保留且提交回传 otherText 一致）→ C1-5 未答齐提交（跳转首个未答题 + flagged 警示描边）→ 答齐提交（q0 option-1 / q1 多选 option-0+option-2 / q2 Other 全量逐题回传，弹窗关闭）`);
    await screenshot(ws, 'W-question-submit');
  } catch (e) { record('W-question-submit', 'FAIL', e.message); await screenshot(ws, 'W-question-submit-failed'); } finally {
    if (qSubmitPayload) await cleanupWizardFixture(ws, qSubmitPayload.id);
  }
  await screenshot(ws, 'W-question-submit-cleaned');

  // ── W-question-single：C1-14 场景 4（C1-11 单题弹窗维持现状直提——回归门）──
  currentCase = 'W-question-single';
  let qSinglePayload = null;
  try {
    const exceptionsBeforeW4 = exceptions.length;
    await ensureLanBridge(ws, 'W-question-single');
    qSinglePayload = await injectWizardFixture(ws, { single: true });
    // 单题形态维持现状：无 wizard 左栏/进度 chip/footer 上下题钮；选项直提。
    // footer 取消钮=非 wizard footer 的 ghost 钮（无 wizard-cancel-btn testid——该 testid 仅 wizard footer 有）。
    const singleState = JSON.parse(String(await evalExpr(ws, `JSON.stringify({
      hasWizardNav: !!document.querySelector('[data-testid="wizard-nav"]'),
      hasChip: !!document.querySelector('[data-testid="wizard-progress-chip"]'),
      hasPrev: !!document.querySelector('[data-testid="wizard-prev-btn"]'),
      hasNext: !!document.querySelector('[data-testid="wizard-next-btn"]'),
      optionCount: document.querySelectorAll('.interaction-dialog .interaction-option').length,
      hasCancel: !!document.querySelector('.interaction-dialog__footer button.interaction-btn--ghost'),
    })`)));
    if (singleState.hasWizardNav || singleState.hasChip) throw new Error('单题弹窗渲染出 wizard 结构（左栏/进度 chip——C1-11 回归违背）');
    if (singleState.hasPrev || singleState.hasNext) throw new Error('单题弹窗 footer 出现上一步/下一题（现状直提形态被改）');
    if (singleState.optionCount < 3) throw new Error(`单题选项数异常（${singleState.optionCount}，期望 2+Other）`);
    if (!singleState.hasCancel) throw new Error('单题弹窗缺取消钮（非 wizard footer ghost 钮）');
    // 直提：点击选项 → 立即回传 submit（无二次确认/无前进钮）+ 弹窗关闭。
    await evalExpr(ws, `[...document.querySelectorAll('.interaction-dialog .interaction-option')].find((b) => (b.textContent || '').includes('开发环境'))?.click(), true`);
    await waitFor('W-question-single：直提后弹窗关闭', () => evalOk(ws, `!document.querySelector('.interaction-overlay')`), 5);
    const respondLog = JSON.parse(String(await evalExpr(ws, `JSON.stringify(window.__e2eRespondLog ?? [])`)));
    if (respondLog.length !== 1 || respondLog[0].action !== 'submit') throw new Error(`直提未回传 submit（log=${JSON.stringify(respondLog).slice(0, 80)}）`);
    const sel = (respondLog[0].selectedOptionIds ?? []).join(',');
    if (!sel.includes('option-0')) throw new Error(`直提选项回传异常（'${sel}'）`);
    if (exceptions.length > exceptionsBeforeW4) throw new Error('W-question-single 用例期间出现 exceptionThrown');
    record('W-question-single', 'PASS', `单题（非 form）弹窗维持现状直提：无 wizard 左栏/chip/上下题钮，选项点击即 submit 回传（selectedOptionIds option-0）+ 弹窗关闭`);
    await screenshot(ws, 'W-question-single');
  } catch (e) { record('W-question-single', 'FAIL', e.message); await screenshot(ws, 'W-question-single-failed'); } finally {
    if (qSinglePayload) await cleanupWizardFixture(ws, qSinglePayload.id);
  }
  await screenshot(ws, 'W-question-single-cleaned');

  // ── W-translate（UI 五点批次 p5c 增，2026-11-20；02 清单 P5-T10/T8 + 增补组 B 链面）──
  // 网页版翻译同能力：入口可见 → 点击出进行态 → stub 译文呈现 → 思考入口与正文入口双在场 →
  // 整页刷新后入口/正文完好 + 再打开零重复请求（stub 日志计数不增）→ swap 切换零请求。
  // stub 纪律：翻译上游一律 env stub（ISO electron 已注入 CLAUDE_LINK_TRANSLATE_STUB=1）；
  // stub 日志在桌面主进程侧落盘 = 网页发起的翻译请求由桌面主进程发出的结构性远控证明（T10）。
  // --config 外部备环境模式无 stub env → SKIP（禁真实计费请求，硬约束优先于覆盖）。
  currentCase = 'W-translate';
  {
    const wtAssistantBody = 'W-translate fixture assistant body for the web translation check. ';
    const wtThinkBody = 'W-translate fixture thinking content for the on-demand check. ';
    const stubLogCount = () => {
      if (!TRANSLATE_STUB_LOG) return -1;
      try { return fs.readFileSync(TRANSLATE_STUB_LOG, 'utf8').split('\n').filter((l) => l.trim().length > 0).length; } catch { return 0; }
    };
    try {
      const exceptionsBeforeWT = exceptions.length;
      if (!ISO_MODE || !TRANSLATE_STUB_LOG) {
        record('W-translate', 'SKIP', '外部备环境模式（--config）无 CLAUDE_LINK_TRANSLATE_STUB 注入——翻译上游 stub 纪律（02 §0，禁真实计费请求）优先于覆盖，本场景仅 ISO 模式执行');
      } else {
        await ensureLanBridge(ws, 'W-translate');
        // 点夹具会话卡（DB 直插会话，页面列表应已含）→ 聊天页 → 消息夹具注入（DB 消息经 switchSession 已加载；
        // 注入只为幂等垫底，不覆盖 DB 已载内容——同一批消息按 id 语义一致）。
        const clicked = await evalExpr(ws, `(() => {
          const card = [...document.querySelectorAll('.session-card')]
            .find((c) => (c.querySelector('.session-card__name')?.textContent || '').trim() === 'W-translate-fixture');
          if (!card) return false;
          card.click();
          return true;
        })()`);
        if (clicked !== true) throw new Error('侧栏未找到 W-translate-fixture 夹具会话卡（DB 直插会话未进列表）');
        await waitFor('W-translate：聊天页就绪', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
        await waitFor('W-translate：落库助手消息渲染', () => evalOk(ws, `!!document.querySelector('.bubble--assistant')`), 10);
        // 三跑修正（p5c，2026-11-20）：原 wtInjectMessages 页内 st.messages 整体替换夹具已删——
        // 注入 id/文本（wt-a、330 字符）与 DB 落库行（wt-a-<ts>、660 字符）不一致：刷新前 START 以
        // 注入 id/文本建 target（msg:wt-a）；刷新后渲染层改从 DB 加载（msg:wt-a-<ts>），restore 回来的
        // 条目 target 与渲染消息对不上号 → 按钮呈 idle → 再开点击=真 START（660 字符段缓存全未命中）
        // → stub 日志 1→2「重复计费」假红（W-translate-failed.png 三跑证据：原文视图+已翻译徽标）。
        // DB 夹具即唯一事实源（B4/B5 已证 switchSession 正常加载 DB 消息；桌面 UI5P P5 同纪律），
        // 断言面零变化——修夹具非改用例。

        // T10：入口可见 → 点击出进行态 → stub 译文呈现（请求从桌面主进程发出 = stub 日志在主进程侧落盘）。
        const logBefore = stubLogCount();
        const hasEntry = await evalOk(ws, `!!document.querySelector('.bubble--assistant .tr-entry')`);
        if (!hasEntry) throw new Error('web 版助手消息无翻译入口（.tr-entry 缺失——通道漏接/secure API 踩坑嫌疑）');
        await evalExpr(ws, `document.querySelector('.bubble--assistant .tr-entry').click(), true`);
        // live 窗口仅 ~150ms（stub 80ms 延迟 + 单段夹具 done 快速到达）——50ms 轮询保证采样命中
        //（200ms 默认轮询会整窗漏采，首跑实测超时假红）。
        await waitFor('W-translate：进行态出现（.tr-tag--live）', () => evalOk(ws, `!!document.querySelector('.bubble--assistant .tr-tag--live')`), 10, 50);
        await waitFor('W-translate：stub 译文呈现（【译】前缀）', () => evalOk(ws, `(() => {
          const v = document.querySelector('.bubble--assistant [data-testid="translation-viewport"]');
          return !!v && (v.textContent || '').includes('【译】');
        })()`), 12);
        await waitFor('W-translate：完成徽标（已翻译）', () => evalOk(ws, `!!document.querySelector('.bubble--assistant .tr-tag--done')`), 10);
        const logAfterStart = stubLogCount();
        if (logAfterStart <= logBefore) throw new Error(`stub 日志计数未增长（${logBefore}→${logAfterStart}）——翻译请求未从主进程发出`);
        // T24 web 侧背书（02 清单 T24「零配置开箱」的 web 面）：ISO seed = 真实配置浅拷贝（无
        // translation 键）→ 出厂种子引擎组开箱即用；本场景即「不进配置页直接译出」的点击路径。
        // stub 日志首行 engineKind = google-gtx = 出厂优先序首位（Google→Bing→有道→百度）的行为级观测。
        const firstLogLine = (() => {
          try { return fs.readFileSync(String(TRANSLATE_STUB_LOG), 'utf8').split('\n').find((l) => l.trim().length > 0) ?? ''; } catch { return ''; }
        })();
        let firstKind = '';
        try { firstKind = String(JSON.parse(firstLogLine).engineKind ?? ''); } catch { /* 空串走下方断言 */ }
        if (firstKind !== 'google-gtx') throw new Error(`stub 日志首行 engineKind=${firstKind || '(空)'} ≠ google-gtx（出厂优先序首位漂移）`);
        // 思考入口与正文入口双在场（增补组 B 链面）。
        await evalExpr(ws, `document.querySelector('.think-row__head')?.click(), true`);
        await waitFor('W-translate：思考块展开（headrow 在场）', () => evalOk(ws, `!!document.querySelector('.think-row__headrow')`), 8);
        const dual = await evalExpr(ws, `(() => ({
          think: !!document.querySelector('.think-row__headrow .tr-entry'),
          body: !!document.querySelector('.bubble--assistant .tr-entry'),
        }))()`);
        if (!dual.think || !dual.body) throw new Error(`思考/正文翻译入口未双在场：think=${dual.think} body=${dual.body}`);
        record('W-translate-start', 'PASS', `web 版入口可见 → 点击出进行态（.tr-tag--live）→ stub 译文呈现（【译】）→ 完成徽标 → 思考/正文入口双在场；stub 日志 ${logBefore}→${logAfterStart}（+${logAfterStart - logBefore}）= 请求从桌面主进程发出的结构性远控证明（日志=${path.basename(String(TRANSLATE_STUB_LOG))}）`);
        await screenshot(ws, 'W-translate-start');

        // T8：整页刷新 → 入口在/正文完好 → 再打开零重复请求（缓存命中，stub 日志计数不变）。
        const logAtDone = stubLogCount();
        await reloadAndReconnect(ws, 'W-translate');
        // 刷新后 restoreWebActiveSession 恢复会话；夹具会话不在恢复路径时点卡兜底。
        await waitFor('W-translate：刷新后夹具会话或消息面就绪', () => evalOk(ws, `(() => {
          if (document.querySelector('.bubble--assistant')) return true;
          const card = [...document.querySelectorAll('.session-card')]
            .find((c) => (c.querySelector('.session-card__name')?.textContent || '').trim() === 'W-translate-fixture');
          if (card) { card.click(); }
          return false;
        })()`), 15, 300);
        await waitFor('W-translate：刷新后助手消息渲染', () => evalOk(ws, `!!document.querySelector('.bubble--assistant')`), 10);
        // 刷新后翻译入口在场 + restore 重建投影（done 态译文缺省显示）+ 不闪现错误。
        const afterReload = await evalExpr(ws, `(() => ({
          entry: !!document.querySelector('.bubble--assistant .tr-entry'),
          viewport: !!document.querySelector('.bubble--assistant [data-testid="translation-viewport"]'),
          bodyOk: (() => { const b = document.querySelector('.bubble--assistant'); return b && (b.textContent || '').includes(${JSON.stringify(wtAssistantBody.slice(0, 30))}); })(),
          errorShown: !!document.querySelector('.bubble--assistant [data-testid="translation-error"]'),
        }))()`);
        if (!afterReload.entry) throw new Error('刷新后翻译入口消失（T8 主缺陷形态）');
        if (!afterReload.bodyOk) throw new Error('刷新后消息正文不完好');
        if (afterReload.errorShown) throw new Error('刷新后译文块呈错误态（异常）');
        // 再打开（toggle 往返）零重复请求：缓存命中路径 stub 日志计数不变。
        await evalExpr(ws, `document.querySelector('.bubble--assistant .tr-entry').click(), true`);
        await sleep(600); // toggleShowing 纯视图切换 + Vue patch 窗口
        const toggledOnce = await evalOk(ws, `!document.querySelector('.bubble--assistant [data-testid="translation-viewport"]')`);
        await evalExpr(ws, `document.querySelector('.bubble--assistant .tr-entry').click(), true`);
        await sleep(600);
        const toggledTwice = await evalOk(ws, `!!document.querySelector('.bubble--assistant [data-testid="translation-viewport"]')`);
        const logAfterReopen = stubLogCount();
        if (logAfterReopen !== logAtDone) throw new Error(`刷新后再打开引发重复请求：stub 日志 ${logAtDone}→${logAfterReopen}（重复计费）`);
        if (!toggledOnce || !toggledTwice) throw new Error(`刷新后 toggle 往返异常（收起=${toggledOnce} 再开=${toggledTwice}）`);
        record('W-translate-reopen', 'PASS', `整页刷新后：入口在场 + 正文完好 + restore 重建（${afterReload.viewport ? '译文即时可见' : '译文经 toggle 恢复'}）→ 收起/再开 toggle 往返正常 → stub 日志 ${logAtDone}→${logAfterReopen} 零增量（刷新后对同一输入零重复请求——缓存命中）`);
        await screenshot(ws, 'W-translate-reopen');

        // T8 收起态刷新变体：收起（显示原文）→ 整页刷新 → 入口在场但译文不闪现（showingTranslation
        // 持久化随 restore 走）→ 再开零重复请求（缓存命中）。独立 try/catch（同文件 W-* 记账形态：
        // 失败记本条 FAIL，不误标 W-translate-start）。
        try {
          const logBeforeCollapsed = stubLogCount();
          await evalExpr(ws, `document.querySelector('.bubble--assistant .tr-entry').click(), true`);
          await sleep(600);
          const collapsed = await evalOk(ws, `!document.querySelector('.bubble--assistant [data-testid="translation-viewport"]')`);
          if (!collapsed) throw new Error('收起失败（译文视口仍在场）');
          await reloadAndReconnect(ws, 'W-translate-collapsed');
          await waitFor('W-translate 收起态刷新：消息面就绪', () => evalOk(ws, `!!document.querySelector('.bubble--assistant .tr-entry')`), 15);
          const afterCollapsedReload = await evalExpr(ws, `(() => ({
            entry: !!document.querySelector('.bubble--assistant .tr-entry'),
            viewport: !!document.querySelector('.bubble--assistant [data-testid="translation-viewport"]'),
            errorShown: !!document.querySelector('.bubble--assistant [data-testid="translation-error"]'),
          }))()`);
          if (!afterCollapsedReload.entry) throw new Error('收起态刷新后翻译入口消失');
          if (afterCollapsedReload.viewport) throw new Error('收起态刷新后译文闪现（showingTranslation 未持久化/restore 误置 showing）');
          if (afterCollapsedReload.errorShown) throw new Error('收起态刷新后呈错误态');
          await evalExpr(ws, `document.querySelector('.bubble--assistant .tr-entry').click(), true`);
          await waitFor('收起态刷新后译文重现', () => evalOk(ws, `(() => {
            const v = document.querySelector('.bubble--assistant [data-testid="translation-viewport"]');
            return !!v && (v.textContent || '').includes('【译】');
          })()`), 10);
          const logAfterCollapsed = stubLogCount();
          if (logAfterCollapsed !== logBeforeCollapsed) throw new Error(`收起态刷新+再开引发重复请求：stub 日志 ${logBeforeCollapsed}→${logAfterCollapsed}`);
          record('W-translate-reopen-collapsed', 'PASS', `收起（原文视图）→ 整页刷新 → 入口在场 + 译文不闪现（showingTranslation 持久化）→ 再开译文重现 → stub 日志 ${logBeforeCollapsed}→${logAfterCollapsed} 零增量（缓存命中）`);
          await screenshot(ws, 'W-translate-reopen-collapsed');
        } catch (e) {
          record('W-translate-reopen-collapsed', 'FAIL', e.message);
          await screenshot(ws, 'W-translate-reopen-collapsed-failed');
        }
        if (exceptions.length > exceptionsBeforeWT) throw new Error('W-translate 用例期间出现 exceptionThrown');
      }
    } catch (e) {
      record('W-translate-start', 'FAIL', e.message);
      await screenshot(ws, 'W-translate-failed');
    }
  }

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
  log('==== B1-B8 + 既有 W-* + T1B 新增 13 场景（W-dev-stale-banner / W-mcp-scan / W-skill-refresh-web / W-mcp-external-change / W-collapse-persist / W-queue-restore-{countdown,running,running-a2-4,standby} / W-turn-footnote / W-question-{sidenav,guard,submit,single}）+ P6-B W-file-context-menu 汇总 ====');
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
