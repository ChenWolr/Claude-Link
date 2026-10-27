// scripts/cdp-turn-sync-e2e.mjs
// 「回合投影 + 标题质量」双端围观 E2E（SA-5 / 计划 §6-7，C1-C6）。
//
// 用法（编排器/复现者手动准备环境，脚本只做断言；运行命令：node scripts/cdp-turn-sync-e2e.mjs）：
//   1. npm run build && npx electron . --remote-debugging-port=9223   （应用运行，8790 监听）
//   2. 启动 Chrome headless（可执行路径按本机安装位置准备；user-data-dir 自选临时目录）：
//      "<Chrome 可执行路径>" --headless=new --remote-debugging-port=9224 ^
//        --user-data-dir=<自选临时目录> --no-first-run --no-default-browser-check about:blank
//   3. node scripts/cdp-turn-sync-e2e.mjs [--lan-ip <IPv4>] [--app-log <应用主进程日志路径>]
//
// 双 target：对 Chrome 9224 开两个 page（A=发起端，B=围观端），各自独立 CDP WebSocket 会话，
// 两 page 同 URL（http://<LAN-IP>:8790/#token=<token>，一切日志中 token 掩码前 4 后 4）。
// 帧证据通道：脚本自持第三条 WS（带 token 鉴权，照 scripts/web-access-e2e-probe.ts 的客户端
// 形态），订阅 chat:event 广播，按 JSONL 逐行追加 docs/reports/web-e2e-screenshots/run-C1-C6.log
// （帧时间戳 + sessionId + event.type 摘要 + 关键字段；内容截断 200 字符；token 掩码）——
// 供 C2（turn_ended/aborted 帧截获）与 C5（serverNow 单调）断言取证。控制台镜像日志落
// 同目录 run-C1-C6-console.log（截图 C1-*.png…C6-*.png 亦同目录）。
//
// 退出协议：
//   - exit 0：C1-C6 全 PASS（含 C4 计划允许的 degraded 降级 PASS；SKIP 须带原因单独列出）。
//   - exit 1：任一用例 FAIL / 截图失败（*-shot 记账）/ 出现渲染层异常（exceptionThrown 或
//             console error，X-render 终审记账）。
//   - exit 2：前置条件不满足（Chrome 9224 / 应用 8790 / 配置 token / 帧证据 WS 不可用）。
//
// 技术纪律（对齐 scripts/cdp-web-access-e2e.mjs B1-B8 链）：纯 CDP 原生
// （Input/Runtime/Page），不依赖 computer-use 等 skill；precondition 前置不满足 exit 2；
// LAN IP 由 node:os networkInterfaces() 程序派生（非 internal 且非 100.64/10 CGNAT 段，
// 不硬编码任何本机 IP）；工作空间目标目录 = process.cwd()（F10 脱敏同源做法）。
//
// ── 选择器 → 组件对照（全部静态读源码确定，标注※者为需运行时校准项）──
// | 选择器                                   | 组件（源码位置）                              |
// |------------------------------------------|-----------------------------------------------|
// | #app + window.claudeLink                 | index.html / web-bridge.ts（页面就绪探针）    |
// | button.new-button                        | components/layout/AppSidebar.vue L181（新会话）|
// | .ctl .ctl__btn（首个匹配）+ .menu__item--dir | components/chat/SessionToolbar.vue L176/L198
// |                                          |（工作空间下拉；※见下方校准 1）                |
// | [data-testid="chat-input-textarea"]      | components/chat/ChatInput.vue L351（输入框）  |
// | [data-testid="chat-send-button"]         | components/chat/ChatInput.vue L357（发送）    |
// | .turn-timer / .turn-timer--done /        | components/chat/TurnTimer.vue L57/L68         |
// |   .turn-timer__time（计时文本）          |（运行态无 --done 修饰；完成态带 --done）      |
// | .ctl__btn--abort                         | components/chat/SessionToolbar.vue L308       |
// |                                          |（发送态中断按钮；长按 1s 触发，※校准 2）      |
// | .session-link / .session-link__name /    | components/layout/AppSidebar.vue L255/L280    |
// |   .session-link.active /                 |                                               |
// |   .session-link--running（黄灯运行态）   |                                               |
// | .session-link__status（状态点 role=img） | components/layout/AppSidebar.vue L274         |
// | .message-list / .bubble--user /          | components/chat/MessageList.vue L226 /        |
// |   .bubble--assistant                     | components/chat/MessageBubble.vue L66         |
// | pinia session store（app.__vue_app__…）  | stores/session-store.ts（B3 链同款兜底入口）  |
//
// ── 需运行时校准清单（静态推断不确定处，首跑时重点核验）──
// 1. `.ctl .ctl__btn` 首个匹配 = 工作空间按钮：ContextButton.vue 内无 .ctl/.ctl__btn 类名，
//    故 SessionToolbar 第二个 .ctl（工作空间）的按钮是首个 `.ctl .ctl__btn` 匹配；B3 链
//    2026-10-21 实测同表达式可用，仍列校准。
// 2. 中断按钮为「长按 1 秒」触发（use-hold-action durationMs=1000，rAF 驱动；headless 页
//    rAF 可能停摆致长按打不满）：脚本先 Page.bringToFront(B) 再以 CDP Input.dispatchMouseEvent
//    按住 1.3s 模拟长按；未截获中断帧时依次降级——Esc 急停（ChatPage.vue L84）→ 页面桥
//    abort 通道直调兜底（WEB_CHANNEL_TABLE CHAT_ABORT）。rAF 在后台标签页暂停是本项必须
//    bringToFront 的原因（※运行时验证长按是否触发）。
// 3. 双 page 同一 Chrome：其中一页必然处于后台标签。计时文本由 setInterval(100ms) 驱动
//    （use-now.ts，非 rAF），后台被节流至 ~1s 仍会递增，满足「两次采样差>0」；关键交互
//    （长按/截图）前均 bringToFront 消除风险。
// 4. 计时文本形态来自 formatDurationMs（shared/format-duration.ts）：<60s 为「秒.x s」、
//    60s-3600s 为「分:秒」、≥3600s 为「时:分:秒」——解析器按此三态实现（运行时确认无第
//    四形态）。
//
// 敏感纪律：token 从 %APPDATA%/claude-link/claude-link-config.json 顶层键 webAccessToken
// 读取，一切输出（含 URL/帧 raw/异常栈）先过 sanitize 掩码为前 4 后 4。

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const CHROME_CDP_PORT = 9224;
const CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
const SHOT_DIR = path.resolve('docs/reports/web-e2e-screenshots');
const FRAME_LOG_PATH = path.join(SHOT_DIR, 'run-C1-C6.log');
const CONSOLE_LOG_PATH = path.join(SHOT_DIR, 'run-C1-C6-console.log');

// ── 消息常量（计划 §6-7 逐字）──
const MSG_42 = '请只回复数字 42,不要使用任何工具'; // C1 普通回合
const MSG_LONG = '请写一篇约3000字的中文长文,主题为「HTTP协议三十年演进史」,要求分至少六个小节,每节有标题,内容详实,不要使用任何工具'; // C2 维持回合的长任务（≥60s 量级长文生成）
const MSG_TITLE = '帮我写一个快速排序的 Python 实现并解释思路'; // C4 首条 >8 字
const MSG_SHORT = '你好'; // C6 短输入（≤8 字，短路径直写标题不发 LLM）

// ── 超时常量（waitFor 默认 250ms 轮询；C4/C6 标题轮询 ≤60s；C2/C4 回合终态等待 300s（R-1：
//    回合耗时受上游 LLM 延迟支配，见 TURN_WAIT_TIMEOUT_S 注）；其余用例 20-30s 上限）──
const WAIT_INTERVAL_MS = 250;
const TOTAL_TIMEOUT_MS = 900_000; // 全链兜底（C1~C6 含两次 LLM 回合 + 60s×2 标题轮询）
const WS_CONNECT_TIMEOUT_MS = 10_000;
const CDP_CALL_TIMEOUT_MS = 30_000;
const TIMER_SAMPLE_GAP_MS = 1_300; // 计时两次采样间隔 ≥1.2s（取 1.3s）
const TITLE_POLL_TIMEOUT_MS = 60_000; // C4/C6 标题轮询上限
// R-1（round-003）：回合自然终态耗时受上游 LLM 延迟支配（实测慢回合 durationMs=141262ms≈141s），
// C4 终态帧等待预算 120→300s（覆盖实测慢上游 ×2 余量）；仅耗时预算放宽，功能断言不变。
const TURN_WAIT_TIMEOUT_S = 300; // C4 回合终态帧等待上限（回合耗时受上游 LLM 延迟支配，见上）

// ── 参数与本机网卡事实程序派生（F10 脱敏：不硬编码任何本机 IP/绝对路径）──
const argOf = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
function deriveLanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (!iface.internal && iface.family === 'IPv4' && net.isIP(iface.address) === 4) {
        const p = iface.address.split('.').map(Number);
        if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) continue; // CGNAT/Tailscale 段排除
        return iface.address;
      }
    }
  }
  return null;
}
const LAN_IP = argOf('--lan-ip', deriveLanIp());
const APP_LOG_PATH = argOf('--app-log', null); // 可选：应用主进程日志（C6 断言无 'Topic analysis' 新增行）
const WS_TARGET = path.resolve(process.cwd()); // 新会话工作空间（npm run/在仓库根执行时即仓库根）

// ── 配置与掩码 ──
let rawConfig;
try { rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawConfig = null; }
const PORT = rawConfig?.webAccess?.port ?? 8790;
const TOKEN = typeof rawConfig?.webAccessToken === 'string' ? rawConfig.webAccessToken : '';
const maskTok = () => (TOKEN ? `${TOKEN.slice(0, 4)}****${TOKEN.slice(-4)}` : '(无)');
const sanitize = (text) => (TOKEN ? String(text).split(TOKEN).join(maskTok()) : String(text));

// ── 控制台镜像日志 ──
const logLines = [];
function log(msg) {
  const line = sanitize(`[${new Date().toISOString()}] ${msg}`);
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  try {
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    // R11：覆盖写改追加写（控制台镜像与帧 JSONL 同为跨跑累积，靠 run start 分隔行消歧）；追加成功后清空缓冲防重复落盘
    fs.appendFileSync(CONSOLE_LOG_PATH, logLines.join('\n') + '\n');
    logLines.length = 0;
  } catch { /* 落盘尽力而为 */ }
}

// ── 结果记账（PASS/FAIL/SKIP + 原因；exit 0=全 PASS 含 degraded，exit 1=任一 FAIL）──
const results = []; // {id, status: PASS|FAIL|SKIP, note}
let currentCase = '(pre)';
function record(id, status, note) { results.push({ id, status, note: sanitize(note) }); log(`  [${id}] ${status} ${note}`); }
const resultOf = (id) => results.find((r) => r.id === id);

// ── 渲染层异常收集（双 page 分别记账；C3 断言 A 页窗口增量，末尾 X-render 终审）──
const renderErrors = []; // {page:'A'|'B', case, kind:'exception'|'console-error', text}
const renderErrorCount = (page) => renderErrors.filter((e) => e.page === page).length;

class PreconditionError extends Error {}
function precondition(cond, msg) { if (!cond) throw new PreconditionError(msg); }

// V-总超时兜底（对齐 B 链/probe 的 TOTAL_TIMEOUT_MS 做法）：超时打印汇总后 exit 1，绝不无声挂死。
const totalTimer = setTimeout(() => {
  log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，脚本自杀退出（防挂死）`);
  log('==== 超时时刻已完成的用例汇总 ====');
  for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
  flushLog();
  process.exit(1);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ══ CDP 基础（连接/调用形态对齐 scripts/cdp-web-access-e2e.mjs，按双 target 拆成每页一会话）══
async function listPageTargets() {
  const resp = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json`);
  const targets = await resp.json();
  return targets.filter((t) => t.type === 'page');
}
async function createPageTarget() {
  // Chrome 111+ /json/new 要求 PUT；旧版 GET 兜底；两者都失败由调用方给出 exit 2 级诊断。
  for (const method of ['PUT', 'GET']) {
    try {
      const resp = await fetch(`http://127.0.0.1:${CHROME_CDP_PORT}/json/new?about:blank`, { method });
      if (resp.ok) return await resp.json();
    } catch { /* 尝试下一种方法 */ }
  }
  return null;
}
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 尽力而为 */ }
      reject(new Error(`WebSocket 连接超时（${WS_CONNECT_TIMEOUT_MS / 1000}s）：${sanitize(url)}`));
    }, WS_CONNECT_TIMEOUT_MS);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`WebSocket 连接失败：${sanitize(url)}`)); });
  });
}

class CdpPage {
  constructor(ws, tag) {
    this.ws = ws;
    this.tag = tag; // 'A' | 'B'
    this.msgId = 0;
    this.pending = new Map();
    this.dead = false;
    ws.addEventListener('message', (event) => this.handleMessage(event));
    ws.addEventListener('close', () => this.killPending(`[${this.tag}] CDP WebSocket 已关闭`));
    ws.addEventListener('error', () => this.killPending(`[${this.tag}] CDP WebSocket 错误`));
  }
  handleMessage(event) {
    let msg; try { msg = JSON.parse(event.data); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(`CDP[${this.tag}]: ` + JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      renderErrors.push({
        page: this.tag, case: currentCase, kind: 'exception',
        text: String(msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text || '(no desc)').slice(0, 300),
      });
    } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      renderErrors.push({
        page: this.tag, case: currentCase, kind: 'console-error',
        text: (msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300),
      });
    }
  }
  killPending(reason) {
    this.dead = true;
    for (const [id, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error(`${reason}（未完成调用 id=${id}）`)); }
    this.pending.clear();
  }
  send(method, params = {}) {
    const id = ++this.msgId;
    return new Promise((resolve, reject) => {
      if (this.dead) { reject(new Error(`[${this.tag}] CDP 已断开，拒绝新调用`)); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP[${this.tag}] 调用超时（${CDP_CALL_TIMEOUT_MS / 1000}s）：${method}`));
      }, CDP_CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`Eval[${this.tag}]: ` + String(r.exceptionDetails.exception?.description || '').slice(0, 300));
    return r.result?.value;
  }
  async evalOk(expr) { return (await this.eval(expr)) === true; }
}

async function waitFor(label, fn, timeoutS = 30, intervalMs = WAIT_INTERVAL_MS) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}${lastErr ? `；最后错误：${lastErr}` : ''}`);
}
async function screenshot(page, name) {
  try {
    await page.send('Page.bringToFront').catch(() => {}); // 双页环境：截图前置于前台保证新鲜渲染
    const r = await page.send('Page.captureScreenshot', { format: 'png' });
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    fs.writeFileSync(path.join(SHOT_DIR, `${name}.png`), Buffer.from(r.data, 'base64'));
    log(`  截图落盘 ${name}.png`);
  } catch (e) {
    // 截图失败 = 证据链缺失，记入当前用例 FAIL（对齐 B 链 *-shot 记账纪律）。
    record(`${currentCase}-shot`, 'FAIL', `截图失败（用例 ${currentCase}，截图名 ${name}）：${e.message}`);
  }
}
async function navigate(page, url) {
  log(`  [${page.tag}] 导航 ${sanitize(url)}`);
  await page.send('Page.navigate', { url });
}

// ══ 帧证据通道（第三条 WS：token 鉴权 + chat:event 广播 → JSONL 落盘）══
let frameSeq = 0;
const chatFrames = []; // {seq, ts, sessionId, event}
let frameChannelClosed = null; // 非空=通道已断开（原因）
function appendFrameLine(line) {
  try { fs.mkdirSync(SHOT_DIR, { recursive: true }); fs.appendFileSync(FRAME_LOG_PATH, sanitize(line) + '\n'); } catch { /* 尽力而为 */ }
}
function recordChatFrame(args) {
  const env = args && args[0];
  const ev = env && typeof env === 'object' ? env.event : null;
  const entry = {
    ts: new Date().toISOString(),
    seq: ++frameSeq,
    channel: 'chat:event',
    sessionId: env && typeof env.sessionId === 'string' ? env.sessionId : null,
    type: ev && typeof ev.type === 'string' ? ev.type : null,
  };
  if (ev && typeof ev === 'object') {
    const f = {};
    if (ev.type === 'turn_started') { f.startedAt = ev.startedAt; f.serverNow = ev.serverNow; f.turnKind = ev.turnKind; f.generation = ev.generation; }
    else if (ev.type === 'turn_ended') { f.endedAt = ev.endedAt; f.durationMs = ev.durationMs; f.outcome = ev.outcome; }
    else if (ev.type === 'result') { f.subtype = ev.subtype; f.is_error = ev.is_error; }
    else if (ev.type === 'aborted') { f.message = String(ev.message ?? '').slice(0, 80); }
    if (Object.keys(f).length > 0) entry.fields = f;
  }
  entry.raw = JSON.stringify(args ?? null).slice(0, 200); // 内容截断至 200 字符
  chatFrames.push({ seq: entry.seq, ts: entry.ts, sessionId: entry.sessionId, event: ev && typeof ev === 'object' ? ev : null });
  appendFrameLine(JSON.stringify(entry));
}
function connectFrameChannel(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 尽力而为 */ }
      reject(new Error(`帧证据 WS 连接/欢迎帧超时（${WS_CONNECT_TIMEOUT_MS / 1000}s）：${sanitize(url)}（token 无效或应用未运行）`));
    }, WS_CONNECT_TIMEOUT_MS);
    ws.addEventListener('message', (event) => {
      let f; try { f = JSON.parse(event.data); } catch { return; }
      if (f.kind === 'welcome') { clearTimeout(timer); resolve(ws); return; }
      if (f.kind === 'event' && f.channel === 'chat:event') recordChatFrame(f.args);
      else if (f.kind === 'bye') { frameChannelClosed = `bye(${f.reason})`; log(`  [帧通道] 服务端 bye：${f.reason}`); }
    });
    ws.addEventListener('close', () => {
      if (!frameChannelClosed) { frameChannelClosed = 'closed'; log('  [帧通道] 连接关闭'); }
      clearTimeout(timer);
      reject(new Error('帧证据 WS 在欢迎帧前关闭（token 无效 → bye/bad-token 或服务不可达）'));
    });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`帧证据 WS 错误：${sanitize(url)}`)); });
  });
}
const isTerminalEvent = (ev) => !!ev && (ev.type === 'result' || ev.type === 'aborted' || ev.type === 'turn_ended');
async function waitFrame(label, sid, pred, timeoutS = 20, minSeq = 0) {
  if (frameChannelClosed) throw new Error(`帧证据通道已断开（${frameChannelClosed}），无法等待帧：${label}`);
  return waitFor(label, () => {
    if (frameChannelClosed) throw new Error(`帧证据通道已断开（${frameChannelClosed}）`);
    return chatFrames.find((f) => f.seq > minSeq && f.sessionId === sid && pred(f.event)) || null;
  }, timeoutS, 100);
}
/** 自 minSeq 起按帧到达序重放该会话回合状态（turn_started→running；终态→stopped）。 */
function turnRunningSince(sid, minSeq = 0) {
  let running = false;
  for (const f of chatFrames) {
    if (f.seq <= minSeq || f.sessionId !== sid || !f.event) continue;
    const t = f.event.type;
    if (t === 'turn_started') running = true;
    else if (t === 'result' || t === 'aborted' || t === 'turn_ended') running = false;
  }
  return running;
}

// ══ 页面侧表达式（选择器见头部对照表）══
const connectedExpr = `(() => {
  const app = document.querySelector('#app');
  return !!(app && app.childElementCount > 0) && !!window.claudeLink;
})()`;
// pinia 前导（B3 链同款入口：app.__vue_app__ → $pinia → _s.get('session')）
const PINIA_PRELUDE = `const piniaSt = () => { const app = document.querySelector('#app'); const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null; return pinia && pinia._s ? pinia._s.get('session') : null; };`;
const piniaStateExpr = `(() => { ${PINIA_PRELUDE}
  const s = piniaSt(); if (!s) return null;
  return {
    activeId: s.activeSession ? s.activeSession.id : null,
    activeName: s.activeSession ? s.activeSession.name : null,
    activeTransient: !!(s.activeSession && s.activeSession.transient),
    running: s.runningSessions ? Array.from(s.runningSessions) : [],
  };
})()`;
// 运行态计时文本（TurnTimer 运行态无 --done 修饰；完成态 .turn-timer--done 不取）
const readTimerExpr = `(() => { const el = document.querySelector('.turn-timer:not(.turn-timer--done) .turn-timer__time'); return el ? (el.textContent || '').trim() : null; })()`;
const runningTimerExpr = `!!document.querySelector('.turn-timer:not(.turn-timer--done)')`;
const sidebarActiveExpr = `(() => { const el = document.querySelector('.session-link.active'); if (!el) return null; return {
  running: el.classList.contains('session-link--running'),
  statusDot: !!el.querySelector('.session-link__status'),
  name: (el.querySelector('.session-link__name')?.textContent || '').trim(),
}; })()`;
const activeTitleExpr = `(() => { const el = document.querySelector('.session-link.active .session-link__name'); return el ? (el.textContent || '').trim() : null; })()`;
const activeStatusClassExpr = `(() => { const el = document.querySelector('.session-link.active'); if (!el) return '(无 active)'; const m = [...el.classList].find((c) => c.startsWith('session-link--')); return m ?? 'idle'; })()`;
const abortVisibleExpr = `(() => { const b = document.querySelector('.ctl__btn--abort'); if (!b) return false; return b.getClientRects().length > 0; })()`;

/** 计时文本 → 可比秒数（formatDurationMs 三态：「x.ys」/「m:ss」/「h:mm:ss」）。 */
function parseDurationText(text) {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  let m = /^(\d+(?:\.\d+)?)s$/.exec(t);
  if (m) return parseFloat(m[1]);
  m = /^(\d+):(\d{2})$/.exec(t);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
  m = /^(\d+):(\d{2}):(\d{2})$/.exec(t);
  if (m) return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  return null;
}

/** 新会话：侧栏新建按钮 → 暂态输入框出现 → 选工作空间（B3 链实测形态 + pinia 兜底）。 */
async function newSessionOn(page) {
  await page.eval(`document.querySelector('button.new-button')?.click(), true`);
  await waitFor('新会话输入框出现', () => page.evalOk(`!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  await ensureWorkspace(page);
}
async function ensureWorkspace(page) {
  // 工作空间下拉：SessionToolbar 首个 `.ctl .ctl__btn`（※校准 1）；目标目录 = WS_TARGET（title 精确匹配）。
  await page.eval(`document.querySelector('.ctl .ctl__btn')?.click(), true`);
  const picked = await waitFor('工作空间菜单出现', () => page.evalOk(`!!document.querySelector('.menu__item--dir')`), 5, 200)
    .then(() => page.eval(`[...document.querySelectorAll('.menu__item--dir')].find((b) => b.title === ${JSON.stringify(WS_TARGET)})?.click(), true`))
    .catch(() => false);
  let ok = false;
  if (picked === true) {
    ok = await waitFor('工作空间已选中（按钮 title 变为目录）', () => page.evalOk(`(() => {
      const btn = document.querySelector('.ctl .ctl__btn');
      const t = btn?.title ?? '';
      return t.length > 0 && !t.includes('未选择');
    })()`), 8).then(() => true).catch(() => false);
  }
  if (!ok) {
    // 兜底：最近列表无目标目录时经 pinia 直设（与 chooseRecent→setActiveSessionWorkingDir 同一状态位）
    log(`  [${page.tag}] 工作空间菜单无目标目录项，改经 pinia 直设 workingDir（兜底路径）`);
    await page.eval(`(() => { ${PINIA_PRELUDE}
      const st = piniaSt();
      if (st && st.activeSession) { st.activeSession.workingDir = ${JSON.stringify(WS_TARGET)}; return true; }
      return false;
    })()`);
    await sleep(300);
  }
}
/** 发消息：textarea 赋值 + input 事件驱动 v-model → 点击发送（B3 链形态）。 */
async function sendMessage(page, text) {
  await page.eval(`(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    if (!ta) return false;
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await page.eval(`document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
}
/** 等待 A 物化（activeSession 由暂态翻持久，id 稳定沿用）→ 返回会话 id。 */
async function waitMaterialized(page, label) {
  return waitFor(`${label} 会话物化（暂态 → 持久，id 稳定）`, () => page.eval(`(() => { ${PINIA_PRELUDE} const s = piniaSt(); return s && s.activeSession && !s.activeSession.transient ? s.activeSession.id : null; })()`), 20);
}
/** 切换某端到指定会话：UI 点击（名称匹配 + activeId 校验）优先，pinia 直调 switchSession 兜底。 */
async function switchPageToSession(page, sid, label) {
  await waitFor(`${label} 侧栏列表出现会话（sessions:changed → 去抖刷新）`, () => page.evalOk(`(() => { ${PINIA_PRELUDE}
    const s = piniaSt();
    return !!(s && s.sessions && s.sessions.some((x) => x.id === ${JSON.stringify(sid)}));
  })()`), 20);
  const activeOkExpr = `(() => { ${PINIA_PRELUDE} const s = piniaSt(); return !!(s && s.activeSession && s.activeSession.id === ${JSON.stringify(sid)}); })()`;
  const clicked = await page.eval(`(() => { ${PINIA_PRELUDE}
    const s = piniaSt();
    const target = s && s.sessions ? s.sessions.find((x) => x.id === ${JSON.stringify(sid)}) : null;
    if (!target) return false;
    const el = [...document.querySelectorAll('.session-link')].find((l) => (l.querySelector('.session-link__name')?.textContent || '').trim() === target.name);
    if (!el) return false;
    el.click();
    return true;
  })()`);
  if (clicked === true) {
    const ok = await waitFor(`${label} 点击后 active 会话切换`, () => page.evalOk(activeOkExpr), 10).then(() => true).catch(() => false);
    if (ok) return 'ui-click';
  }
  log(`  [${label}] UI 点击后未检测到 active 切换（或未命中），改经 pinia 直调 switchSession（兜底路径）`);
  await page.eval(`(() => { ${PINIA_PRELUDE}
    const st = piniaSt();
    const target = st && st.sessions ? st.sessions.find((x) => x.id === ${JSON.stringify(sid)}) : null;
    if (st && target) { void st.switchSession(target); return true; }
    return false;
  })()`);
  await waitFor(`${label} pinia 直切后 active 会话切换`, () => page.evalOk(activeOkExpr), 10);
  return 'pinia-direct';
}
/** 中断按钮长按（1s 门槛 + rAF 余量）：bringToFront 后 CDP 鼠标按下 → 1.3s → 松开。 */
async function holdAbortViaMouse(page) {
  const rect = await page.eval(`(() => { const b = document.querySelector('.ctl__btn--abort'); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!rect) throw new Error('未找到中断按钮（.ctl__btn--abort）');
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(1300);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
}
/** Esc 急停兜底（ChatPage 全局 keydown：sending 且无 Esc 消费者打开 → abort()）。 */
async function pressEscape(page) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
  await sleep(120);
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
}
/** --app-log：统计 'Topic analysis' 行数（C6 以「新增行数=0」证明短输入未发起 LLM）。 */
function countTopicLines() {
  const text = fs.readFileSync(APP_LOG_PATH, 'utf8');
  return text.split(/\r?\n/).filter((l) => l.includes('Topic analysis')).length;
}

// ══ 主流程 ══
async function main() {
  precondition(TOKEN.length > 0, `配置 ${CONFIG_PATH} 顶层键 webAccessToken 缺失或为空`);
  precondition(LAN_IP && net.isIP(LAN_IP), `LAN IP 不可用：网卡未发现非 internal IPv4 且未提供合法 --lan-ip（当前=${LAN_IP}）`);
  if (APP_LOG_PATH) precondition(fs.existsSync(APP_LOG_PATH), `--app-log 路径不存在：${APP_LOG_PATH}`);

  const probeTcp = (host, port) => new Promise((resolve) => {
    const sock = net.connect({ host, port, timeout: 4000 });
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
  precondition(await probeTcp('127.0.0.1', PORT), `应用 ${PORT} 端口 TCP 不可达（请先按脚本头注释启动应用并开启网页访问）`);
  let pages = await listPageTargets().catch(() => null);
  precondition(Array.isArray(pages), `Chrome CDP ${CHROME_CDP_PORT} /json 不可达（请先按脚本头注释启动 Chrome headless）`);
  while (pages.length < 2) {
    const created = await createPageTarget();
    precondition(created, `Chrome CDP ${CHROME_CDP_PORT} 无法新建第二个 page target（/json/new PUT/GET 均失败），当前 page 数=${pages.length}`);
    pages = await listPageTargets();
  }
  // 帧证据通道（前置：token 有效性由 welcome 帧验证，失败 exit 2）
  const frameUrl = `ws://${LAN_IP}:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`;
  const frameWs = await connectFrameChannel(frameUrl);
  // ── 跑分隔标记（R11）：帧 JSONL 跨跑累积而 seq 每跑重置，先落 run-start 行便于跨跑定位消歧；
  //    run 序号 = 帧日志既有 start 标记数 + 1（首跑/不可读按 1）；argv 摘要逐项过 sanitize 不落 token。──
  let runNo = 1;
  try {
    runNo = ((fs.readFileSync(FRAME_LOG_PATH, 'utf8').match(/"run":"start"/g) || []).length) + 1;
  } catch { /* 首跑无文件或不可读：按 run 1 记 */ }
  const runTs = new Date().toISOString();
  appendFrameLine(JSON.stringify({ run: 'start', ts: runTs, note: `C1-C6 run ${runNo}`, argv: process.argv.slice(2).map((a) => sanitize(a)) }));
  log(`==== run start ${runTs} ====`);
  log(`帧证据 WS 已连接（chat:event → ${FRAME_LOG_PATH}）`);

  const urls = { lan: `http://${LAN_IP}:${PORT}/#token=${TOKEN}` };
  const pageA = new CdpPage(await connectWS(pages[0].webSocketDebuggerUrl), 'A');
  const pageB = new CdpPage(await connectWS(pages[1].webSocketDebuggerUrl), 'B');
  log(`已连接 Chrome CDP 双 target（A=${pages[0].url}，B=${pages[1].url}）；端口=${PORT} token=${maskTok()} LAN=${LAN_IP}${APP_LOG_PATH ? ` app-log=${APP_LOG_PATH}` : ''}`);
  await pageA.send('Runtime.enable'); await pageA.send('Page.enable');
  await pageB.send('Runtime.enable'); await pageB.send('Page.enable');

  // 两 page 同 URL 载入应用（B 落在首页围观位）
  await navigate(pageA, urls.lan);
  await navigate(pageB, urls.lan);
  await waitFor('A 页面渲染+桥连接', () => pageA.evalOk(connectedExpr), 30);
  await waitFor('B 页面渲染+桥连接', () => pageB.evalOk(connectedExpr), 30);

  // ── C1 双端围观：A 发长文消息 → B 点入 → TurnTimer + 计时递增 + 黄灯 + 中断按钮 ──
  currentCase = 'C1';
  const c1 = { sid: null, startSeq: 0, sample1Raw: null, sample1: null, sample2Raw: null };
  try {
    await newSessionOn(pageA);
    c1.startSeq = frameSeq;
    // R-1（round-003）：C1 前提=MSG_LONG 长文回合——短回合（42）实测最快 ~5s 即自然终态，
    // 撑不满 TurnTimer 双采样窗（≥5s）；长文回合存活期受上游 LLM 延迟支配（实测 ≈141s），
    // 后续等终态预算按「覆盖慢上游 ×2」口径取 300s（C2/C4），断言不变。
    await sendMessage(pageA, MSG_LONG);
    c1.sid = await waitMaterialized(pageA, 'C1');
    log(`  C1 会话已物化 sid=${c1.sid}，B 进入围观位`);
    await switchPageToSession(pageB, c1.sid, 'B');
    const started = await waitFrame('C1 turn_started 帧', c1.sid, (ev) => ev?.type === 'turn_started', 30, c1.startSeq);
    log(`  C1 turn_started 帧 seq=${started.seq} serverNow=${started.event.serverNow}`);
    // ① B 侧 TurnTimer DOM 出现（运行态）
    await waitFor('B 运行态 TurnTimer 出现', () => pageB.evalOk(runningTimerExpr), 20);
    // ② 计时递增：两次采样（间隔 ≥1.2s）解析为可比数值，后 > 前（差>0）——非仅存在性断言
    c1.sample1Raw = await pageB.eval(readTimerExpr);
    c1.sample1 = parseDurationText(c1.sample1Raw);
    if (c1.sample1 === null) throw new Error(`C1 首采样计时文本不可解析：「${c1.sample1Raw}」`);
    await sleep(TIMER_SAMPLE_GAP_MS);
    c1.sample2Raw = await pageB.eval(readTimerExpr);
    const s2 = parseDurationText(c1.sample2Raw);
    if (s2 === null) {
      const term = chatFrames.find((f) => f.seq > started.seq && f.sessionId === c1.sid && isTerminalEvent(f.event));
      throw new Error(term
        ? `第二采样时回合已终态（${term.event.type}），无法完成递增采样（回合过快）`
        : `C1 第二采样计时文本不可解析：「${c1.sample2Raw}」`);
    }
    if (!(s2 > c1.sample1)) throw new Error(`B 计时未递增：${c1.sample1Raw} → ${c1.sample2Raw}（parsed ${c1.sample1} → ${s2}）`);
    // ③ B 侧栏该会话黄灯（运行态标识）
    const sb = await pageB.eval(sidebarActiveExpr);
    if (!sb || sb.running !== true || sb.statusDot !== true) throw new Error(`B 侧栏运行态标识缺失：${JSON.stringify(sb)}`);
    // ④ B 中断按钮可见
    const abortVis = await pageB.eval(abortVisibleExpr);
    if (abortVis !== true) throw new Error('B 中断按钮不可见（.ctl__btn--abort）');
    await screenshot(pageA, 'C1-A');
    await screenshot(pageB, 'C1-B');
    record('C1', 'PASS', `B 围观成功：TurnTimer 在场且计时递增 ${c1.sample1Raw}→${c1.sample2Raw}（差 ${+(s2 - c1.sample1).toFixed(1)}s）、侧栏黄灯（session-link--running + 状态点）、中断按钮可见`);
  } catch (e) {
    record('C1', 'FAIL', e.message);
    await screenshot(pageA, 'C1-A-failed').catch(() => {});
    await screenshot(pageB, 'C1-B-failed').catch(() => {});
  }

  // ── C2 跨端中断：A about:blank 模拟关闭 → B 长按→Esc→API 直调三层中断链 → 帧 turn_ended(interrupted)/aborted ──
  currentCase = 'C2';
  const c2 = { via: null, terminalType: null };
  if (resultOf('C1')?.status !== 'PASS') {
    record('C2', 'SKIP', 'C1 未通过，无进行中回合可跨端中断（依赖 C1 回合）');
  } else {
    try {
      // 确定性前置（R-1 修正，round-003）：C1 为 MSG_LONG 长文回合，自然终态耗时受上游 LLM
      // 延迟支配（实测 durationMs=141262ms≈141s；旧注释「42 短回合 ~10s」系 C1 改 MSG_LONG
      // 前的口径，与前提失配致 90s 预算必超——run9/run10 复现）。预算 300s=覆盖实测慢上游
      // ×2 余量；若回合已结束则立即返回，随后再发长任务保证中断窗口充足。
      await waitFrame('C1 短回合自然终态', c1.sid, (ev) => isTerminalEvent(ev) || ev?.type === 'turn_ended', 300, c1.startSeq);
      const seqMark = frameSeq;
      await sendMessage(pageA, MSG_LONG);
      await waitFrame('C2 长任务 turn_started 帧', c1.sid, (ev) => ev?.type === 'turn_started', 30, seqMark);
      await sleep(1500); // 确认回合真正进行中（spawn 占坑后）
      const seqBefore = frameSeq;
      // A 模拟关闭：navigate about:blank（同源 hash 变化不重载，必须整页离开）→ 等 ≥1s
      await navigate(pageA, 'about:blank');
      await sleep(1200);
      // B 点击中断按钮：bringToFront（rAF 后台暂停，校准 3）→ CDP 鼠标长按 1.3s
      await pageB.send('Page.bringToFront');
      const interruptedPred = (ev) => (ev?.type === 'turn_ended' && ev.outcome === 'interrupted') || ev?.type === 'aborted';
      let hit = null;
      // 中断三层链（复跑 2 三根因：长按 rAF 停摆打不满 1s / Esc 时回合或已自然结束 / 缺 API 级兜底）：
      // ①长按中断按钮 → ②Esc 急停（须回合仍 sending）→ ③页面桥 abort 接口直调（中断按钮
      // onComplete 的同源调用、页面自身公开 API 面，不依赖 rAF/键盘焦点，确定性兜底）。
      try {
        await holdAbortViaMouse(pageB);
        c2.via = '长按中断按钮';
        hit = await waitFrame('C2 中断帧（长按，turn_ended interrupted / aborted）', c1.sid, interruptedPred, 8, seqBefore).catch(() => null);
      } catch (e) {
        log(`  第一层长按中断按钮执行失败：${e.message}`);
      }
      if (!hit) {
        log('  第一层（长按中断按钮）8s 内未截获中断帧，降级第二层 Esc 急停兜底');
        await pressEscape(pageB);
        c2.via = 'Esc 急停兜底';
        hit = await waitFrame('C2 Esc 兜底中断帧', c1.sid, interruptedPred, 5, seqBefore).catch(() => null);
      }
      if (!hit) {
        log('  第二层（Esc 急停兜底）5s 内未截获中断帧，降级第三层 API 直调兜底');
        // 第三层：window.claudeLink 的 abort 接口直调（WEB_CHANNEL_TABLE CHAT_ABORT→killProcess(user)），
        // 与中断按钮 onComplete 同源、不依赖 rAF/键盘焦点，确定性兜底。
        await pageB.eval(`window.claudeLink.abortChat(${JSON.stringify(c1.sid)})`); c2.via = 'API 直调兜底(abortChat)';
        hit = await waitFrame('C2 API 直调兜底中断帧', c1.sid, interruptedPred, 10, seqBefore).catch(() => null);
        if (!hit) {
          log('  第三层（API 直调兜底）10s 内仍未截获中断帧，三层中断链全部未生效');
        }
      }
      if (!hit) throw new Error('帧流未截获该会话 turn_ended(outcome=interrupted) 或 aborted 帧（长按/Esc/API 直调三层链均未生效，帧证据见 run-C1-C6.log）');
      c2.terminalType = hit.event.type === 'turn_ended' ? `turn_ended(outcome=${hit.event.outcome})` : 'aborted';
      // ② B 端回合终止：运行态 TurnTimer 消失 + （中断按钮消失 或 输入恢复）
      await waitFor('B 运行态 TurnTimer 消失', () => pageB.evalOk(`!(${runningTimerExpr})`), 15);
      const abortGone = await pageB.evalOk(`!document.querySelector('.ctl__btn--abort')`);
      const inputBack = await pageB.evalOk(`(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return !!ta && !ta.disabled; })()`);
      if (!abortGone && !inputBack) throw new Error('B 端回合终止证据缺失：中断按钮未消失且输入未恢复');
      // ③ A 保持 about:blank
      const hrefA = await pageA.eval('location.href');
      if (hrefA !== 'about:blank') throw new Error(`A 未保持 about:blank（实际 ${sanitize(hrefA)}）`);
      await screenshot(pageB, 'C2-B');
      record('C2', 'PASS', `跨端中断成功（${c2.via}）：帧截获 ${c2.terminalType}（seq=${hit.seq}）、B 回合终止（计时器退场${abortGone ? '+中断按钮消失' : ''}${inputBack ? '+输入恢复' : ''}）、A 保持 about:blank`);
    } catch (e) {
      record('C2', 'FAIL', e.message);
      await screenshot(pageB, 'C2-B-failed').catch(() => {});
    }
  }

  // ── C3 刷新恢复：A navigate 回应用 URL → 计时/状态恢复 + 已流出内容在场 + 无渲染层异常 ──
  currentCase = 'C3';
  if (!c1.sid) {
    record('C3', 'SKIP', 'C1 未建立会话（sid 缺失），刷新恢复无对象');
  } else {
    try {
      const errCount0 = renderErrorCount('A');
      await navigate(pageA, urls.lan);
      await waitFor('A 刷新后桥连接恢复', () => pageA.evalOk(connectedExpr), 30);
      await waitFor('A 恢复 active 会话（web active 持久化恢复）', () => pageA.evalOk(`(() => { ${PINIA_PRELUDE} const s = piniaSt(); return !!(s && s.activeSession && s.activeSession.id === ${JSON.stringify(c1.sid)}); })()`), 25);
      // B 对齐到同一会话（终态分支状态比对需要；幂等）
      await switchPageToSession(pageB, c1.sid, 'B');
      const stA = await pageA.eval(piniaStateExpr);
      const running = !!(stA && stA.running && stA.running.includes(c1.sid));
      let branchNote;
      if (running) {
        // ① 回合仍 running：TurnTimer 恢复且计时递增（两次采样差>0）
        // R-1 核查结论（round-003）：此 15s 为「刷新后运行态计时器 DOM 恢复」等待，非回合耗时
        // 预算——回合存活期由 C2 中断链终结，常规流 C3 走终态分支，此分支仅在 C2 中断失败时
        // 触达；run9/run10 此处超时系 C2 前置失败连带（回合在窗口内外均存活、DOM 未恢复），
        // 与上游 LLM 延迟无耦合，故不随 MSG_LONG 前提调整，依据留档 round-003 报告。
        await waitFor('A 运行态 TurnTimer 恢复', () => pageA.evalOk(runningTimerExpr), 15);
        const t1raw = await pageA.eval(readTimerExpr);
        const t1 = parseDurationText(t1raw);
        await sleep(TIMER_SAMPLE_GAP_MS);
        const t2raw = await pageA.eval(readTimerExpr);
        const t2 = parseDurationText(t2raw);
        if (t1 === null || t2 === null || !(t2 > t1)) throw new Error(`A 刷新后计时未递增（running 分支）：${t1raw} → ${t2raw}`);
        branchNote = `running 分支：计时恢复且递增 ${t1raw}→${t2raw}`;
      } else {
        // ① 已终态：无悬挂计时器 + 两端均非运行态
        // 判定依据：计划语义「已终态则一致」= 两端都无悬挂运行态（completed/idle 属各自信息集的
        // 合法终态展示，sessionStatus 为运行期态，桌面重启同构），不要求类名严格相等。
        const hang = await pageA.evalOk(runningTimerExpr);
        if (hang) throw new Error('回合已终态但 A 仍显示运行态计时器（悬挂计时器）');
        const clsA = await pageA.eval(activeStatusClassExpr);
        const clsB = await pageB.eval(activeStatusClassExpr);
        if (String(clsA).includes('running') || String(clsB).includes('running')) throw new Error(`终态后仍有一端显示运行态：A=${clsA} B=${clsB}`);
        branchNote = `终态分支:无悬挂计时器,两端均非运行态(A=${clsA} B=${clsB})`;
      }
      // ② 已流出内容在场（该会话消息列表含此前消息文本片段）
      const hasPrior = await pageA.evalOk(`(() => {
        const ml = document.querySelector('.message-list');
        const t = ml ? (ml.innerText || ml.textContent || '') : '';
        return t.includes(${JSON.stringify('请只回复数字 42')}) || t.includes(${JSON.stringify('请写一篇约3000字')});
      })()`);
      if (hasPrior !== true) throw new Error('A 会话消息列表未见此前消息文本片段（已流出内容缺失）');
      // ③ A 页无 console error、无 exceptionThrown（C3 窗口增量）
      const delta = renderErrorCount('A') - errCount0;
      if (delta > 0) {
        const added = renderErrors.filter((e) => e.page === 'A').slice(errCount0);
        throw new Error(`A 页刷新恢复期间新增渲染层异常 ${delta} 条：` + added.map((x) => `[${x.kind}] ${String(x.text).slice(0, 120)}`).join(' | '));
      }
      await screenshot(pageA, 'C3-A');
      record('C3', 'PASS', `刷新恢复成功：${branchNote}；已流出内容在场；C3 窗口无 console error/exceptionThrown`);
    } catch (e) {
      record('C3', 'FAIL', e.message);
      await screenshot(pageA, 'C3-A-failed').catch(() => {});
    }
  }

  // ── C4 标题两端一致：A 新会话 >8 字首条 → 回合完成 → ≤60s 轮询两端标题 ──
  currentCase = 'C4';
  let c4Sid = null;
  try {
    await newSessionOn(pageA);
    const seqMark = frameSeq;
    await sendMessage(pageA, MSG_TITLE);
    c4Sid = await waitMaterialized(pageA, 'C4');
    await waitFrame('C4 turn_started 帧', c4Sid, (ev) => ev?.type === 'turn_started', 30, seqMark);
    await waitFrame('C4 回合终态帧', c4Sid, (ev) => isTerminalEvent(ev), TURN_WAIT_TIMEOUT_S, seqMark);
    log(`  C4 回合已终态，B 对齐围观位后轮询两端标题（≤60s）`);
    await switchPageToSession(pageB, c4Sid, 'B');
    let titleA = null; let titleB = null; let degraded = false;
    const deadline = Date.now() + TITLE_POLL_TIMEOUT_MS;
    for (;;) {
      titleA = await pageA.eval(activeTitleExpr);
      titleB = await pageB.eval(activeTitleExpr);
      if (titleA && titleA === titleB && !/^会话 \d+$/.test(titleA)) break; // 两端一致且非自动槽位
      if (Date.now() > deadline) {
        // B2（review-round1 P3 收紧）：降级必须两端对称——B 端标题与 A 端一致（titleB === titleA
        // 且同为「会话 N」槽位形态）；A/B 不对称（如仅一端收到 SESSIONS_CHANGED 推送的病态）
        // 不判 degraded，落入下方 FAIL 分支（两端不一致 throw）。
        degraded = titleA != null && titleA === titleB && /^会话 \d+$/.test(String(titleA).trim());
        break;
      }
      await sleep(500);
    }
    const first15 = MSG_TITLE.slice(0, 15);
    if (degraded) {
      // 降级分支（计划允许）：60s 后仍「会话 N」（LLM 失败环境）→ 断言任何一端都不显示首句截断名
      if ((titleA ?? '') === first15 || (titleB ?? '') === first15) throw new Error(`降级分支违规：标题照抄首句前 15 字（A=${titleA}，B=${titleB}）`);
      await screenshot(pageA, 'C4-A');
      await screenshot(pageB, 'C4-B');
      record('C4', 'PASS', `C4-PASS(degraded)：60s 内标题仍自动槽位（LLM 失败环境；A=${titleA}，B=${titleB}），两端均未照抄截断首句（前 15 字=「${first15}」）`);
    } else {
      if (!titleA || !titleB || titleA !== titleB) throw new Error(`两端标题不一致：A=${titleA}，B=${titleB}`);
      if (/^会话 \d+$/.test(titleA.trim())) throw new Error(`60s 轮询超时且标题仍为自动槽位「${titleA}」（未判入降级分支，按 FAIL）`);
      if (titleA.trim() === first15 || titleB.trim() === first15) throw new Error(`标题照抄首条消息前 15 字：${titleA}`);
      await screenshot(pageA, 'C4-A');
      await screenshot(pageB, 'C4-B');
      record('C4', 'PASS', `两端标题一致且非照抄截断：A=B=「${titleA}」（≠自动槽位，≠首 15 字「${first15}」）`);
    }
  } catch (e) {
    record('C4', 'FAIL', e.message);
    await screenshot(pageA, 'C4-A-failed').catch(() => {});
  }

  // ── C5 计时非负 + serverNow 单调：从帧流 JSONL 提取该会话全部 turn_started 帧断言 ──
  currentCase = 'C5';
  if (!c1.sid) {
    record('C5', 'SKIP', 'C1 未建立会话，帧流无该会话 turn_started 可断言');
  } else {
    try {
      const starts = chatFrames.filter((f) => f.sessionId === c1.sid && f.event?.type === 'turn_started');
      if (starts.length === 0) throw new Error('帧流中无该会话 turn_started 帧（证据缺失，见 run-C1-C6.log）');
      // ① C1 的计时首采样值 ≥0
      if (c1.sample1 === null || !(c1.sample1 >= 0)) throw new Error(`C1 首采样值缺失或为负：${c1.sample1}（raw=${c1.sample1Raw}）`);
      // ② turn_started.serverNow 序列单调不减（按帧到达序）
      let prev = -Infinity; let badIdx = -1; let missingIdx = -1;
      starts.forEach((f, i) => {
        const sn = f.event.serverNow;
        if (typeof sn !== 'number' || !Number.isFinite(sn)) { if (missingIdx < 0) missingIdx = i; return; }
        if (sn < prev && badIdx < 0) badIdx = i;
        prev = sn;
      });
      if (missingIdx >= 0) throw new Error(`第 ${missingIdx + 1} 条 turn_started 缺 serverNow 数值字段`);
      if (badIdx >= 0) throw new Error(`turn_started.serverNow 非单调不减：第 ${badIdx + 1} 条回退（共 ${starts.length} 条，证据 run-C1-C6.log）`);
      const snList = starts.map((f) => f.event.serverNow).join(' → ');
      await screenshot(pageB, 'C5-B'); // R12：C5 补齐「每步截图」证据（B 围观位当前态；失败按 *-shot 记账纪律自然处理）
      record('C5', 'PASS', `首采样 ${c1.sample1} ≥ 0（raw=${c1.sample1Raw}）；turn_started ${starts.length} 条 serverNow 单调不减：${snList}（证据=帧 JSONL）`);
    } catch (e) {
      record('C5', 'FAIL', e.message);
      await screenshot(pageB, 'C5-B-failed').catch(() => {}); // R12：失败分支同其他用例形态补现场截图
    }
  }

  // ── C6 短输入不走 LLM：A 新会话「你好」→ ≤60s 轮询标题恰为原文 ──
  currentCase = 'C6';
  let c6Sid = null;
  try {
    await newSessionOn(pageA);
    const baseline = APP_LOG_PATH ? countTopicLines() : null; // 基线：C4 的 LLM 标题分析可能已产生 'Topic analysis' 行，断言口径=新增行数
    await sendMessage(pageA, MSG_SHORT);
    c6Sid = await waitMaterialized(pageA, 'C6');
    let title = null;
    const deadline = Date.now() + TITLE_POLL_TIMEOUT_MS;
    for (;;) {
      title = await pageA.eval(activeTitleExpr);
      if (title === MSG_SHORT) break;
      if (Date.now() > deadline) break;
      await sleep(400);
    }
    if (title !== MSG_SHORT) throw new Error(`短输入标题期望恰为原文「${MSG_SHORT}」，实际「${title}」`);
    let logNote;
    if (APP_LOG_PATH) {
      const nowCount = countTopicLines();
      const delta = nowCount - (baseline ?? 0);
      if (delta !== 0) throw new Error(`--app-log 新增 'Topic analysis' 行 ${delta} 条（基线 ${baseline} → ${nowCount}），短输入仍发起了 LLM 请求`);
      logNote = `；--app-log 无新增 'Topic analysis' 行（基线 ${baseline}）——证明未发起 LLM 请求`;
    } else {
      logNote = '；未提供 --app-log，以「标题恰为原文（新 prompt 禁止照抄，LLM 路径几乎不可能返回原文）」为证据形态并注明';
    }
    await screenshot(pageA, 'C6-A');
    record('C6', 'PASS', `短输入标题恰为原文「${title}」（未走 LLM）${logNote}`);
  } catch (e) {
    record('C6', 'FAIL', e.message);
    await screenshot(pageA, 'C6-A-failed').catch(() => {});
  }

  // ── 善后：尽力删除本次物化的测试会话（经 store deleteSession，B3 链同款；不参与断言）──
  for (const sid of [c1.sid, c4Sid, c6Sid].filter(Boolean)) {
    try {
      await pageA.eval(`(() => { ${PINIA_PRELUDE}
        const st = piniaSt();
        if (st) { void st.deleteSession(${JSON.stringify(sid)}); return true; }
        return false;
      })()`);
      log(`  测试会话 ${sid} 已请求删除（善后）`);
    } catch { log(`  测试会话 ${sid} 删除失败（不影响断言，遗留人工清理）`); }
  }
  await sleep(500);

  // ── 全程渲染层异常终审（任一 console error / exceptionThrown = FAIL；C3 已另断言其窗口）──
  currentCase = '(final)';
  if (renderErrors.length > 0) {
    record('X-render', 'FAIL', `全程渲染层异常 ${renderErrors.length} 条：` + renderErrors.map((x) => `[${x.page}/${x.case}/${x.kind}] ${String(x.text).slice(0, 120)}`).join(' | '));
  }

  // ── 汇总（exit 0=全 PASS 含 degraded；exit 1=任一 FAIL/截图失败/渲染层异常；exit 2=前置不满足）──
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const skipCount = results.filter((r) => r.status === 'SKIP').length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  log('==== C1-C6 汇总 ====');
  for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
  log(`PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}（证据目录 ${SHOT_DIR}；帧 JSONL ${FRAME_LOG_PATH}）`);
  flushLog();
  try { frameWs.close(); } catch { /* 尽力而为 */ }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`[前置条件不满足] ${sanitize(e.message)}`);
    console.error('请按脚本头注释准备环境：应用（8790）+ Chrome headless 双 page（9224）+ 配置 token。');
    flushLog();
    process.exit(2);
  }
  console.error(`[运行错误] ${sanitize(e?.stack || e)}`);
  flushLog();
  process.exit(1);
});
