// scripts/cdp-turn-sync-e2e.mjs
// 「回合投影 + 标题质量」双端围观 E2E（SA-5 / 计划 §6-7，C1-C6）。
//
// 用法（两种形态，2026-11-17 t1clp 点起；先例 = cdp-web-access-e2e.mjs ISO 自举层）：
//   · 裸跑（默认，ISO 模式）：node scripts/cdp-turn-sync-e2e.mjs [--lan-ip <IPv4>] [--app-log <路径>]
//     脚本自举隔离环境：构建新鲜度检查（src 比 out/renderer 新才 npm run build）→ 隔离 seed
//     （真实配置只读底稿 → <ISO>/app/claude-link-config.json，仅改 webAccess.port=空闲端口/
//     queueEnabled=true/taskDelayMinutes=60（3600s 倒计时窗，T1C 断言期内任务不弹出不扰断言）/
//     workingDirectory=<ISO 夹具>/permissionMode=bypassPermissions）→ 拉起 electron
//     （--user-data-dir=<ISO>/app，--remote-debugging-port=9223 供桌面 page attach）→ 拉起
//     headless Chrome（9224，--user-data-dir=<ISO>/chrome）→ 跑套件 → 按 PID taskkill /T /F
//     收口 + rmSync <ISO> 整目录（用后删除，AGENTS.md 隔离纪律）。真实配置全程只读。
//   · 外部备环境（--config <路径>）：保持旧版行为（脚本只做断言，环境自备）：
//     1. npm run build && npx electron . --remote-debugging-port=9223   （应用运行，8790 监听）
//     2. Chrome headless：--headless=new --remote-debugging-port=9224 --user-data-dir=<临时目录>
//     3. node scripts/cdp-turn-sync-e2e.mjs --config <配置路径> [--lan-ip <IPv4>] [--app-log <路径>]
//
// 双端联动（t1clp 点新增）：桌面 page = attach Electron 9223 主窗口 page target（※首跑校准：
// /json 首个非 devtools page；attach 不可得时降级「网页发起端+网页围观端」双 page 口径并在
// 结果 note 与实施报告申报）。双 target（Chrome 9224）：A=发起端，B=围观端，各自独立 CDP
// WebSocket 会话，两 page 同 URL（http://<LAN-IP>:<port>/#token=<token>，一切日志中 token 掩码前 4 后 4）。
// 帧证据通道：脚本自持第三条 WS（带 token 鉴权，照 scripts/web-access-e2e-probe.ts 的客户端
// 形态），订阅 chat:event 广播，按 JSONL 逐行追加 docs/reports/web-e2e-screenshots/run-C1-C6.log
// （帧时间戳 + sessionId + event.type 摘要 + 关键字段；内容截断 200 字符；token 掩码）——
// 供 C2（turn_ended/aborted 帧截获）与 C5（serverNow 单调）断言取证。控制台镜像日志落
// 同目录 run-C1-C6-console.log（截图 C1-*.png…C6-*.png 亦同目录）。
//
// 退出协议：
//   - exit 0：C1-C6 + T1C-1/2/3 全 PASS（含 C4 计划允许的 degraded 降级 PASS；SKIP 须带原因
//             单独列出；T1C 降级口径（attach 不可得→双 web page）在 note 标注 [降级]）。
//   - exit 1：任一用例 FAIL / 截图失败（*-shot 记账）/ 出现渲染层异常（exceptionThrown 或
//             console error，X-render 终审记账）。
//   - exit 2：前置条件不满足（ISO 自举失败 / Chrome 9224 / 应用端口 / 配置 token / 帧证据 WS
//             不可用）。
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
// | .ctl .ctl__btn（首个匹配）+ .menu__item--dir | components/chat/SessionToolbar.vue L179/L193
// |                                          |（工作空间下拉；※见下方校准 1）                |
// | [data-testid="chat-input-textarea"]      | components/chat/ChatInput.vue L351（输入框）  |
// | [data-testid="chat-send-button"]         | components/chat/ChatInput.vue L361（发送）    |
// | .turn-timer / .turn-timer--done /        | components/chat/TurnTimer.vue L57/L68         |
// |   .turn-timer__time（计时文本）          |（运行态无 --done 修饰；完成态带 --done）      |
// | .ctl__btn--abort                         | components/chat/SessionToolbar.vue L313       |
// |                                          |（发送态中断按钮；长按 1s 触发，※校准 2）      |
// | .session-card / .session-card__name /    | components/layout/AppSidebar.vue :303/:334    |
// |   .session-card.active /                 |                                               |
// |   .session-card--running（黄灯运行态）   |                                               |
// | .session-card__status（状态点 role=img） | components/layout/AppSidebar.vue :324         |
// |                                          |                                               |
// | 【t1clp 既有用例同步留痕，2026-11-17】上表 .session-link* 三行原为 .session-link 系选择器，
// | 与现行 AppSidebar.vue（R1 分组改版后 .session-card 系）漂移，run1 实测 C1/C4/C6 全数假红
// | （B 侧栏运行态标识缺失 / 两端标题 A=null B=null）。按最小同步原则改钉本脚本内四处表达式与
// | switchPageToSession 定位链（断言意图不变，仅锚点跟随现行实现），非静默适配——本头注与实施
// | 报告双留痕。 |
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
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const CHROME_CDP_PORT = 9224;
const ISO_APP_CDP_PORT = 9223; // ISO 自举 electron 调试端口：T1C 桌面 page attach 源（头注对照）
const DEFAULT_CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
// t1clp：CONFIG_PATH/rawConfig/PORT/TOKEN 四元组可变——ISO 模式 seed 落盘后同轮整体重派生
//（对齐 B 链「必须同源同轮更新，防半新半旧」纪律）；外部备环境（--config）只覆写 CONFIG_PATH。
let CONFIG_PATH = DEFAULT_CONFIG_PATH;
let rawConfig = null;
try { rawConfig = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { rawConfig = null; }
if (process.argv.includes('--config')) {
  const i = process.argv.indexOf('--config');
  const p = i >= 0 ? process.argv[i + 1] : null;
  if (p && fs.existsSync(p)) { CONFIG_PATH = p; try { rawConfig = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { rawConfig = null; } }
}
let PORT = rawConfig?.webAccess?.port ?? 8790;
let TOKEN = typeof rawConfig?.webAccessToken === 'string' ? rawConfig.webAccessToken : '';
const SHOT_DIR = path.resolve('docs/reports/web-e2e-screenshots');
const FRAME_LOG_PATH = path.join(SHOT_DIR, 'run-C1-C6.log');
const CONSOLE_LOG_PATH = path.join(SHOT_DIR, 'run-C1-C6-console.log');
// t1clp：ISO 模式（裸跑默认）= 脚本自举隔离环境；--config 外部备环境模式保持旧版行为。
const ISO_MODE = !process.argv.includes('--config');

// ── 消息常量（计划 §6-7 逐字）──
const MSG_42 = '请只回复数字 42,不要使用任何工具'; // C1 普通回合
const MSG_LONG = '请写一篇约3000字的中文长文,主题为「HTTP协议三十年演进史」,要求分至少六个小节,每节有标题,内容详实,不要使用任何工具'; // C2 维持回合的长任务（≥60s 量级长文生成）
const MSG_TITLE = '帮我写一个快速排序的 Python 实现并解释思路'; // C4 首条 >8 字
const MSG_SHORT = '你好'; // C6 短输入（≤8 字，短路径直写标题不发 LLM）

// ── 超时常量（waitFor 默认 250ms 轮询；C4/C6 标题轮询 ≤60s；C2/C4 回合终态等待 300s（R-1：
//    回合耗时受上游 LLM 延迟支配，见 TURN_WAIT_TIMEOUT_S 注）；其余用例 20-30s 上限）──
const WAIT_INTERVAL_MS = 250;
// t1clp：900s→1500s——T1C-1/2/3 新增（1 次物化回合 + 3 组入队断言 + 收尾清队），与 C1~C6
// （两次 LLM 长回合 + 60s×2 标题轮询）合计预算放宽；仅耗时预算放宽，断言不变（申报留痕）。
const TOTAL_TIMEOUT_MS = 1_500_000; // 全链兜底（C1~C6 + T1C 含多次 LLM 回合 + 60s×2 标题轮询）
const WS_CONNECT_TIMEOUT_MS = 10_000;
const CDP_CALL_TIMEOUT_MS = 30_000;
const TIMER_SAMPLE_GAP_MS = 1_300; // 计时两次采样间隔 ≥1.2s（取 1.3s）
const TITLE_POLL_TIMEOUT_MS = 60_000; // C4/C6 标题轮询上限
// R-1（round-003）：回合自然终态耗时受上游 LLM 延迟支配（实测慢回合 durationMs=141262ms≈141s），
// C4 终态帧等待预算 120→300s（覆盖实测慢上游 ×2 余量）；仅耗时预算放宽，功能断言不变。
const TURN_WAIT_TIMEOUT_S = 300; // C4 回合终态帧等待上限（回合耗时受上游 LLM 延迟支配，见上）
// t1clp：ISO 自举独立看门狗（构建+拉起上限 15 分钟，对齐 B 链）；套件总看门狗改为延迟武装
//（ISO 在自举成功后武装、外部备环境模式模块加载即武装——自举时间不挤占套件预算）。
const BOOTSTRAP_TIMEOUT_MS = 900_000;

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
// t1clp：武装时机延迟化（ISO 自举可能含一次分钟级构建，不挤占套件预算——B 链同款）。
function armSuiteWatchdog() {
  const totalTimer = setTimeout(() => {
    log(`[总超时] ${TOTAL_TIMEOUT_MS}ms 到，脚本自杀退出（防挂死）`);
    log('==== 超时时刻已完成的用例汇总 ====');
    for (const r of results) log(`  ${r.id}: ${r.status} ${r.note}`);
    flushLog();
    try { isoTeardown(); } catch { /* 尽力而为 */ }
    process.exit(1);
  }, TOTAL_TIMEOUT_MS);
  totalTimer.unref();
}
if (!ISO_MODE) armSuiteWatchdog();

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

// ══ 帧证据通道（第三条 WS：token 鉴权 + chat:event/queue:event 广播 → JSONL 落盘）══
let frameSeq = 0;
const chatFrames = []; // {seq, ts, sessionId, event}
// t1clp：queue:event 帧证据（tasks_changed 双向断言面）——服务端向全部已认证连接广播全部通道
//（web-access-e2e-probe.ts 协议事实：事件无 subscribe 帧），同一条帧 WS 原样携带 queue:event。
const queueFrames = []; // {seq, ts, sessionId, type, taskId, dataTasks}
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
/** queue:event 帧记账（t1clp）：tasks_changed 等队列广播——载荷 {sessionId,type,taskId?,data?}。 */
function recordQueueFrame(args) {
  const env = args && args[0];
  const entry = {
    ts: new Date().toISOString(),
    seq: ++frameSeq,
    channel: 'queue:event',
    sessionId: env && typeof env.sessionId === 'string' ? env.sessionId : null,
    type: env && typeof env.type === 'string' ? env.type : null,
  };
  const tasks = env?.data?.tasks;
  if (Array.isArray(tasks)) {
    entry.tasks = tasks.map((t) => ({
      id: typeof t?.id === 'string' ? t.id : null,
      prompt: typeof t?.prompt === 'string' ? t.prompt.slice(0, 60) : null,
      paused: t?.paused === true,
    }));
  }
  if (typeof env?.taskId === 'string') entry.taskId = env.taskId;
  queueFrames.push(entry);
  appendFrameLine(sanitize(JSON.stringify(entry)));
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
      else if (f.kind === 'event' && f.channel === 'queue:event') recordQueueFrame(f.args);
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

// ── queue:event 帧助手（t1clp：T1C-1/2/3 tasks_changed 双向断言面）──
/** 等待一条满足谓词的 queue:event 帧（该会话、minSeq 之后）。 */
async function waitQueueFrame(label, sid, pred, timeoutS = 20, minSeq = 0) {
  if (frameChannelClosed) throw new Error(`帧证据通道已断开（${frameChannelClosed}），无法等待队列帧：${label}`);
  return waitFor(label, () => {
    if (frameChannelClosed) throw new Error(`帧证据通道已断开（${frameChannelClosed}）`);
    return queueFrames.find((f) => f.seq > minSeq && f.sessionId === sid && pred(f)) || null;
  }, timeoutS, 100);
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
const sidebarActiveExpr = `(() => { const el = document.querySelector('.session-card.active'); if (!el) return null; return {
  running: el.classList.contains('session-card--running'),
  statusDot: !!el.querySelector('.session-card__status'),
  name: (el.querySelector('.session-card__name')?.textContent || '').trim(),
}; })()`;
const activeTitleExpr = `(() => { const el = document.querySelector('.session-card.active .session-card__name'); return el ? (el.textContent || '').trim() : null; })()`;
const activeStatusClassExpr = `(() => { const el = document.querySelector('.session-card.active'); if (!el) return '(无 active)'; const m = [...el.classList].find((c) => c.startsWith('session-card--')); return m ?? 'idle'; })()`;
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
    const el = [...document.querySelectorAll('.session-card')].find((l) => (l.querySelector('.session-card__name')?.textContent || '').trim() === target.name);
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

// ══ T1C 双端联动助手（t1clp：CdpPage 版队列/通知/入队操作；形态对齐 B 链 W-queue 助手）══
/** 队列权威快照（page 桥直取；桌面 page 与 web page 同 API 面）。 */
async function queueOverviewOf(page, sid) {
  const raw = await page.eval(`window.claudeLink.getQueueOverview(${JSON.stringify(sid)}).then((r) => JSON.stringify(r))`);
  return JSON.parse(String(raw));
}
/** 轮询主进程权威快照至谓词成立（B 链 pollOverview 同款）。 */
async function pollOverviewOf(page, sid, label, pred, timeoutS = 30, intervalMs = 400) {
  const deadline = Date.now() + timeoutS * 1000;
  let last = null;
  while (Date.now() < deadline) {
    last = await queueOverviewOf(page, sid);
    try { if (pred(last)) return last; } catch { /* 谓词异常按未满足继续 */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}；末次快照 status=${last?.state?.status} tasks=${(last?.tasks ?? []).length}`);
}
/** ChatPage 即时 notice 横条（入队「已加入队列」反馈；4s 自动消失，须发送后立即轮询）。 */
async function noticeOf(page) {
  const raw = await page.eval(`(() => { const el = document.querySelector('.notice'); return JSON.stringify({ present: !!el, text: el ? (el.textContent || '').trim() : '' }); })()`);
  return JSON.parse(String(raw));
}
/** 输入框门态（A2-7 边界行 3「无锁死/无未定义态」断言面：textarea disabled 权威反射）。 */
async function inputGateOf(page) {
  const raw = await page.eval(`(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return JSON.stringify({ hasInput: !!ta, disabled: ta ? ta.disabled : null }); })()`);
  return JSON.parse(String(raw));
}
/** 右侧活动面板展开 + 切 queue Tab（B 链 openQueuePanelTab 同款；任务卡 .task-item 仅在 queue tab 渲染）。 */
async function openQueueTabOn(page, label) {
  await page.eval(`document.querySelector('.reopen-task-panel')?.click(), true`);
  await waitFor(`${label}：右侧活动面板展开（.rail 在位）`, () => page.evalOk(`!!document.querySelector('.rail')`), 10);
  const needClick = await page.eval(`(() => { ${PINIA_PRELUDE}
    const st = piniaSt(); return st ? st.rightTab !== 'queue' : false; })()`);
  if (needClick === true) {
    const ok = await page.eval(`(() => { const btn = document.querySelector('button[aria-label="排队任务"]'); if (!btn) return false; btn.click(); return true; })()`);
    if (ok !== true) throw new Error(`${label}：未找到图标轨「排队任务」按钮（button[aria-label="排队任务"]）`);
  }
  await waitFor(`${label}：.queue-bar 排队状态条渲染`, () => page.evalOk(`!!document.querySelector('.queue-bar')`), 10);
}
/** 任务卡可见性探针（prompt 文本匹配）。 */
async function taskCardVisible(page, prompt) {
  return page.evalOk(`[...document.querySelectorAll('.task-item .task-item__prompt')].some((n) => (n.textContent || '').includes(${JSON.stringify(prompt)}))`);
}
/** 填字 + 点击发送（B3 链形态；T1C 发送动作统一入口）。 */
async function sendOn(page, text) {
  await page.eval(`(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    if (!ta) return false;
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await page.eval(`document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
}
/** 仅预填输入框不点发送（T1C-3 双端近同时发送：先两端填字、再背靠背点击）。 */
async function prefillInput(page, text) {
  const ok = await page.eval(`(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    if (!ta || ta.disabled) return false;
    ta.value = ${JSON.stringify(text)};
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  if (ok !== true) throw new Error(`预填输入失败（输入框缺失或禁用）`);
}
/** 确保队列忙窗（countdown/running）：不在窗内时以「暂停→恢复」真实用户动作链重 arm（B 链校准同款）。 */
async function ensureQueueBusyWindow(page, sid, task0Id, label) {
  try {
    return await pollOverviewOf(page, sid, `${label}：队列忙窗在位`, (o) => o.state?.status === 'countdown' || o.state?.status === 'running', 3, 300);
  } catch {
    log(`  [${label}] 忙窗不在（倒计时已收口），以 TASK_SET_PAUSED true→false 重 arm`);
    await page.eval(`window.claudeLink.setTaskPaused(${JSON.stringify(task0Id)}, true).then(() => true)`);
    await page.eval(`window.claudeLink.setTaskPaused(${JSON.stringify(task0Id)}, false).then(() => true)`);
    return pollOverviewOf(page, sid, `${label}：重 arm 后进入 countdown`, (o) => o.state?.status === 'countdown' || o.state?.status === 'running', 15);
  }
}

// ══ ISO 自举（裸跑默认；--config 外部备环境模式不走此路径；t1clp 点新增，先例 = B 链同款层）══
// 背景：闸门命令为裸 `node scripts/cdp-turn-sync-e2e.mjs`，旧版在此形态下只会校验前置条件
// （实例未起 → exit 2），环境靠人工预先准备——闸门环境无人备环境，必红（基线实测 exit 2/FATAL）。
// 修复：裸跑时脚本自举隔离环境（构建新鲜度→隔离 seed→electron 9223（兼作桌面 attach 源）+
// Chrome 9224→跑套件→按 PID 收口删目录）。隔离纪律：真实配置只读不改，一切写入落 ISO 目录。
// CACHE_ROOT：env 覆盖惯例对齐 cdp-update-e2e.mjs；默认优先 D:\software\Cache（全局指令：临时
// 文件一律放该目录），目录不存在回落 os.tmpdir()。
const CACHE_ROOT = process.env.CLAUDE_LINK_CACHE_ROOT
  ?? (fs.existsSync('D:/software/Cache') ? 'D:/software/Cache/claude-link-cache' : path.join(os.tmpdir(), 'claude-link-cache'));
const ISO_DIR = path.join(CACHE_ROOT, 'claude-link-turnsync-e2e-iso');
const ISO_APP_DIR = path.join(ISO_DIR, 'app'); // electron --user-data-dir：配置随 userData 隔离（单实例锁按 userData）
const ISO_CHROME_DIR = path.join(ISO_DIR, 'chrome');
const ISO_FIXTURE_DIR = path.join(ISO_DIR, 'fixture'); // seed workingDirectory：与用户真实默认工作目录隔离
const ISO_CONFIG_PATH = path.join(ISO_APP_DIR, 'claude-link-config.json');

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

function findListenerPids(port) {
  let out;
  try {
    out = execFileSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
  } catch {
    return null; // netstat 执行失败 → 调用方按校验不通过处理
  }
  const pids = [];
  for (const lineRaw of out.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line.toUpperCase().startsWith('TCP')) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 5 || parts[3].toUpperCase() !== 'LISTENING') continue;
    const m = parts[1].match(/:(\d+)$/);
    if (!m || Number(m[1]) !== port) continue;
    const pid = Number(parts[4]);
    if (Number.isInteger(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
  }
  return pids;
}

function pickFreePort(start) {
  for (let p = start; p < start + 20; p++) {
    const pids = findListenerPids(p);
    if (pids === null) throw new PreconditionError('netstat 校验手段不可用——ISO 自举端口选择无法进行');
    if (pids.length === 0) return p;
  }
  return null;
}

function ensureBuildFresh() {
  let buildMs = 0;
  try { buildMs = fs.statSync(path.join(process.cwd(), 'out', 'renderer')).mtimeMs; } catch { buildMs = 0; }
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
    // shell:true 单命令串形态：Node ≥18.20 对 .cmd 直接 spawnSync 抛 EINVAL（CVE-2024-27980）。
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
  // seed = 真实配置浅拷贝 + 五项覆盖：port=空闲端口防撞；queueEnabled=true（T1C 前提，默认 false
  // 显式开启）；taskDelayMinutes=60（resolveQueueDelaySeconds 夹取 [1,60] 分钟 → 3600s 倒计时窗，
  // T1C 断言期内无任务弹出、计数稳定）；workingDirectory=ISO 夹具；permissionMode=bypassPermissions
  //（回合类场景前置，经隔离配置注入 = AGENTS.md 认可的等效注入形态）。
  const seed = { ...base };
  seed.webAccess = { ...(base.webAccess ?? {}), enabled: true, port };
  seed.queueEnabled = true;
  seed.taskDelayMinutes = 60;
  seed.workingDirectory = ISO_FIXTURE_DIR;
  seed.permissionMode = 'bypassPermissions';
  fs.writeFileSync(ISO_CONFIG_PATH, JSON.stringify(seed, null, 2), 'utf8');
  return seed;
}

function launchIsoElectron() {
  const electronBin = createRequire(import.meta.url)('electron');
  if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
    throw new PreconditionError(`electron 二进制不可解析（require('electron')=${String(electronBin)}）——node_modules 未安装？`);
  }
  return spawn(electronBin, ['.', `--user-data-dir=${ISO_APP_DIR}`, `--remote-debugging-port=${ISO_APP_CDP_PORT}`],
    { cwd: process.cwd(), stdio: 'ignore', windowsHide: true });
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
    try { const t = await listPageTargets(); if (t.length >= 1) return t; } catch { /* 未就绪，继续轮询 */ }
    if (Date.now() > deadline) throw new PreconditionError(`Chrome CDP ${CHROME_CDP_PORT} 在 ${timeoutMs}ms 内无 page target——headless Chrome 可能启动失败`);
    await sleep(500);
  }
}

/** 桌面 page attach（t1clp）：Electron 调试端口 9223 /json 的首个非 devtools page target。
 *  ※首跑校准项：main window 是 9223 上唯一常规 page（tray/隐藏窗无 page target）；attach 不可得
 *  返回 null（T1C 降级「网页发起端+网页围观端」双 page 口径，note 标注 [降级] + 报告申报）。 */
async function findDesktopPageTarget() {
  try {
    const resp = await fetch(`http://127.0.0.1:${ISO_APP_CDP_PORT}/json`);
    if (!resp.ok) return null;
    const targets = await resp.json();
    const pages = (Array.isArray(targets) ? targets : []).filter((t) => t.type === 'page' && !String(t.url).startsWith('devtools'));
    return pages[0] ?? null;
  } catch { return null; }
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
    // 0. Chrome 调试端口占用预检：外部实例复用 = 跨轮 profile 污染（B 链先例），拒绝复用。
    const chromePids = findListenerPids(CHROME_CDP_PORT);
    precondition(chromePids !== null, 'netstat 校验手段不可用——ISO 自举无法进行');
    precondition(chromePids.length === 0, `端口 ${CHROME_CDP_PORT} 已被占用（PID ${chromePids.join(',')}，疑似外部 headless Chrome）——ISO 模式拒绝复用（防跨轮 profile 污染），请先释放该端口`);
    const appPids = findListenerPids(ISO_APP_CDP_PORT);
    precondition(appPids !== null && appPids.length === 0, `端口 ${ISO_APP_CDP_PORT} 已被占用（PID ${appPids?.join(',')}，疑似外部 Electron 实例）——ISO 模式拒绝复用，请先释放该端口`);
    // 1. 构建新鲜度（src 比 out/renderer 新才重建；自举实例启动晚于构建 → 产物新鲜度天然成立）。
    ensureBuildFresh();
    // 2. 空闲 web access 端口（8791 起，避开真实实例 8790）。
    const port = pickFreePort(8791);
    precondition(port !== null, '8791-8810 无空闲端口——ISO 自举无法选口');
    // 3. seed 配置 + 配置四元组同轮重派生（CONFIG_PATH/rawConfig/PORT/TOKEN 必须同源，防半新半旧）。
    const seed = seedIsoConfig(port);
    CONFIG_PATH = ISO_CONFIG_PATH;
    rawConfig = seed;
    PORT = port;
    TOKEN = seed.webAccessToken;
    // 4. electron（--user-data-dir 隔离；9223 调试口供 T1C 桌面 page attach）。
    isoElectronProc = launchIsoElectron();
    await waitForListener(port, 90_000, 'electron web access', isoElectronProc);
    // 5. headless Chrome（双 web page 用）。
    const chromeBin = findChromiumBinary();
    precondition(chromeBin, '未发现 Chrome/Edge 可执行文件（搜索过 Program Files/LOCALAPPDATA 标准路径；可用 CLAUDE_LINK_E2E_CHROME 显式指定）');
    isoChromeProc = launchIsoChrome(chromeBin);
    await waitForChromeTarget(30_000);
    log(`ISO 自举完成：web access 端口=${port}，electron PID=${isoElectronProc?.pid}（9223 桌面 attach 源），chrome PID=${isoChromeProc?.pid}（${chromeBin}），ISO 目录用后删除`);
  } finally {
    clearTimeout(guard);
  }
}

// ══ 主流程 ══
async function main() {
  // ISO 自举（裸跑默认）：先拉起隔离实例再校验——自举实例启动晚于构建，产物新鲜度天然成立。
  // 外部备环境跑（--config）不走此路径，保持旧版「只校验+指引」行为（t1clp 对齐 B 链口径）。
  if (ISO_MODE) {
    await ensureIsoEnvironment();
    armSuiteWatchdog();
  }
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
  // ── t1clp：桌面 page attach（T1C 双端联动）——ISO 自举实例 9223 必有主窗口 page；外部备环境
  // 模式下 9223 可能未开调试口 → attach 不可得 → T1C 降级「网页发起端+网页围观端」口径申报。
  const desktopTarget = await findDesktopPageTarget();
  let desktopPage = null;
  let desktopDegraded = false;
  if (desktopTarget) {
    try {
      desktopPage = new CdpPage(await connectWS(desktopTarget.webSocketDebuggerUrl), 'D');
      await desktopPage.send('Runtime.enable');
      await desktopPage.send('Page.enable');
      await waitFor('桌面 page 渲染+桥连接（Electron 9223 attach）', () => desktopPage.evalOk(connectedExpr), 20);
    } catch (e) {
      log(`  [T1C] 桌面 page attach 失败（${String(e.message).slice(0, 120)}）→ 降级「网页发起端+网页围观端」口径`);
      try { desktopPage.ws.close(); } catch { /* 尽力而为 */ }
      desktopPage = null;
    }
  }
  if (!desktopPage) {
    desktopDegraded = true;
    log('  [T1C] 桌面 page attach 不可得（9223 无 page target 或连接失败）→ T1C-1/2/3 降级双 web page 口径（A=发起端 B=围观端），报告申报');
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
    record('C1', 'PASS', `B 围观成功：TurnTimer 在场且计时递增 ${c1.sample1Raw}→${c1.sample2Raw}（差 ${+(s2 - c1.sample1).toFixed(1)}s）、侧栏黄灯（session-card--running + 状态点）、中断按钮可见`);
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

  // ── T1C 双端联动（t1clp）：桌面入队网页可见 / 网页入队桌面可见 / 双端同时发送各自入队 ──
  // 规范 T1.2 + 03b §1 T1C-1/2/3 + A2-7 边界行 3（收尾并入）：入队路由跨端可达（tasks_changed
  // 双向）、尾部追加顺序稳定无锁死、一端清空队列另一端无未定义态。
  // 发起端 = 桌面 page（attach 可得时）或 pageA（降级口径，note 标注 [降级]）；围观端 = pageB。
  // 夹具：物化专用会话（真实回合 standby 直发）→ addTask#0 + 暂停→恢复 arm 倒计时（B 链校准同款
  // 真实用户动作链；seed taskDelayMinutes=60 → 3600s 窗，断言期内无任务弹出、计数稳定）。
  currentCase = 'T1C';
  const T1C_TASK0 = 'e2e-t1c-task0-请只回复数字0';
  const T1C_MSG1 = 'e2e-t1c1-桌面入队-请只回复数字1';
  const T1C_MSG2 = 'e2e-t1c2-网页入队-请只回复数字2';
  const T1C_MSG3A = 'e2e-t1c3a-桌面并发入队';
  const T1C_MSG3B = 'e2e-t1c3b-网页并发入队';
  let t1cSid = null;
  let t1cTask0Id = null;
  let t1cTaskIds = []; // 收尾清队清单（A2-7 边界行 3）
  const initiator = desktopPage ?? pageA;
  const initiatorKind = desktopPage ? '桌面(Electron9223 attach)' : '网页A[降级口径]';
  try {
    // 0) 夹具：发起端建会话 + 真物化回合（standby 直发）→ 观围观端对齐。
    await newSessionOn(initiator);
    const t1cStartSeq = frameSeq;
    await sendMessage(initiator, MSG_42);
    t1cSid = await waitMaterialized(initiator, 'T1C');
    log(`  T1C 会话已物化 sid=${t1cSid}（发起端=${initiatorKind}，围观端=网页B）`);
    await waitFrame('T1C 物化回合终态', t1cSid, (ev) => isTerminalEvent(ev), TURN_WAIT_TIMEOUT_S, t1cStartSeq);
    await switchPageToSession(pageB, t1cSid, 'B');
    // 1) 基线：standby 空态（轮询收口，B 链同款——DOM 终态可先于主进程 result 落地）。
    await pollOverviewOf(initiator, t1cSid, 'T1C 基线空态 standby', (o) => o.state?.status === 'standby' && (o.tasks ?? []).length === 0, 30);
    // 2) addTask#0 + 暂停→恢复 arm 倒计时（TASK_SET_PAUSED true→false → armFromUserAction）。
    const add0 = JSON.parse(String(await initiator.eval(`window.claudeLink.addTask(${JSON.stringify(t1cSid)}, { text: ${JSON.stringify(T1C_TASK0)}, attachmentIds: [], clientMessageId: crypto.randomUUID() }).then((r) => JSON.stringify({ taskId: (r.task && r.task.id) || '' }))`)));
    if (!add0.taskId) throw new Error('T1C addTask#0 回包无 taskId');
    t1cTask0Id = add0.taskId;
    t1cTaskIds.push(t1cTask0Id);
    await initiator.eval(`window.claudeLink.setTaskPaused(${JSON.stringify(t1cTask0Id)}, true).then(() => true)`);
    await initiator.eval(`window.claudeLink.setTaskPaused(${JSON.stringify(t1cTask0Id)}, false).then(() => true)`);
    const armed = await pollOverviewOf(initiator, t1cSid, 'T1C task#0 进入 countdown（暂停→恢复 arm）', (o) => o.state?.status === 'countdown', 15);
    log(`  倒计时窗在位（remaining=${armed.state.countdownRemaining}s interval=${armed.state.intervalSeconds}s）`);
    await openQueueTabOn(pageB, 'T1C 围观端面板');
    await screenshot(pageB, 'T1C-fixture');
    record('T1C-fixture', 'PASS', `夹具就绪：sid=${t1cSid.slice(0, 8)}… 物化回合终态 + task#0 arm 倒计时 + 观围观端 queue tab 在位（发起端=${initiatorKind}）`);
  } catch (e) {
    record('T1C-fixture', 'FAIL', e.message);
    record('T1C-1', 'SKIP', 'T1C 夹具失败，双端联动断言无前提');
    record('T1C-2', 'SKIP', 'T1C 夹具失败，双端联动断言无前提');
    record('T1C-3', 'SKIP', 'T1C 夹具失败，双端联动断言无前提');
    await screenshot(pageB, 'T1C-fixture-failed').catch(() => {});
  }

  if (resultOf('T1C-fixture')?.status === 'PASS') {
    // ── T1C-1 桌面入队网页可见：发起端倒计时窗内发送 → 围观网页 tasks_changed 帧后任务卡可见、计数一致 ──
    try {
      const seqMark = frameSeq;
      await sendOn(initiator, T1C_MSG1);
      const notice = await waitFor('T1C-1 发起端入队反馈（已加入队列）', async () => {
        const n = await noticeOf(initiator);
        return n.present && n.text.includes('已加入队列') ? n.text : null;
      }, 8, 200);
      const frame = await waitQueueFrame('T1C-1 tasks_changed 帧（含新任务）', t1cSid, (f) => f.type === 'tasks_changed' && (f.tasks ?? []).some((t) => (t.prompt || '').includes(T1C_MSG1)), 20, seqMark);
      const ovInit = await queueOverviewOf(initiator, t1cSid);
      const ovObs = await queueOverviewOf(pageB, t1cSid);
      if ((ovInit.tasks ?? []).length !== (ovObs.tasks ?? []).length) {
        throw new Error(`两端任务计数不一致：发起端=${(ovInit.tasks ?? []).length} 围观端=${(ovObs.tasks ?? []).length}`);
      }
      const sameIds = JSON.stringify((ovInit.tasks ?? []).map((t) => t.id)) === JSON.stringify((ovObs.tasks ?? []).map((t) => t.id));
      if (!sameIds) throw new Error('两端任务 id 序列不一致（tasks_changed 未达围观端或顺序分叉）');
      await waitFor('T1C-1 围观端任务卡渲染', () => taskCardVisible(pageB, T1C_MSG1), 10);
      const cardCount = await pageB.eval(`document.querySelectorAll('.task-item').length`);
      if (cardCount !== (ovObs.tasks ?? []).length) {
        throw new Error(`围观端任务卡数 ${cardCount} ≠ 快照任务数 ${(ovObs.tasks ?? []).length}`);
      }
      t1cTaskIds.push(...(ovInit.tasks ?? []).filter((t) => (t.prompt || '').includes(T1C_MSG1)).map((t) => t.id));
      await screenshot(pageB, 'T1C-1-B');
      record('T1C-1', 'PASS', `入队跨端可见（发起端=${initiatorKind}）：notice「${String(notice).slice(0, 24)}」+ tasks_changed 帧 seq=${frame.seq} + 围观端任务卡可见 + 两端计数一致（${(ovObs.tasks ?? []).length} 条）且 id 序列一致`);
    } catch (e) {
      record('T1C-1', 'FAIL', e.message);
      await screenshot(pageB, 'T1C-1-B-failed').catch(() => {});
    }

    // ── T1C-2 网页入队桌面可见：围观端（网页）入队 → 发起端（桌面）任务面板可见同任务 ──
    try {
      await ensureQueueBusyWindow(initiator, t1cSid, t1cTask0Id, 'T1C-2');
      const seqMark = frameSeq;
      await sendOn(pageB, T1C_MSG2);
      const notice = await waitFor('T1C-2 网页端入队反馈（已加入队列）', async () => {
        const n = await noticeOf(pageB);
        return n.present && n.text.includes('已加入队列') ? n.text : null;
      }, 8, 200);
      await waitQueueFrame('T1C-2 tasks_changed 帧（含网页端新任务）', t1cSid, (f) => f.type === 'tasks_changed' && (f.tasks ?? []).some((t) => (t.prompt || '').includes(T1C_MSG2)), 20, seqMark);
      // 发起端（桌面）：任务面板可见同任务 + 权威快照计数反映。
      await openQueueTabOn(initiator, 'T1C-2 发起端面板');
      await waitFor('T1C-2 发起端任务卡渲染（网页入队的任务）', () => taskCardVisible(initiator, T1C_MSG2), 10);
      const ovInit = await queueOverviewOf(initiator, t1cSid);
      if (!(ovInit.tasks ?? []).some((t) => (t.prompt || '').includes(T1C_MSG2))) {
        throw new Error(`发起端权威快照无网页入队任务（tasks=${(ovInit.tasks ?? []).length} 条）`);
      }
      t1cTaskIds.push(...(ovInit.tasks ?? []).filter((t) => (t.prompt || '').includes(T1C_MSG2)).map((t) => t.id));
      await screenshot(initiator, 'T1C-2-initiator');
      record('T1C-2', 'PASS', `网页入队反向可见（tasks_changed 双向）：网页 notice「${String(notice).slice(0, 24)}」+ 发起端（${initiatorKind}）任务面板同任务可见 + 权威快照 ${(ovInit.tasks ?? []).length} 条含新任务`);
    } catch (e) {
      record('T1C-2', 'FAIL', e.message);
      await screenshot(initiator, 'T1C-2-initiator-failed').catch(() => {});
    }

    // ── T1C-3 双端同时发送各自入队（tasks 恰 +2、尾部追加顺序稳定、无锁死）+ A2-7 边界行 3 收尾 ──
    try {
      await ensureQueueBusyWindow(initiator, t1cSid, t1cTask0Id, 'T1C-3');
      const baseline = await queueOverviewOf(initiator, t1cSid);
      const baseLen = (baseline.tasks ?? []).length;
      // 双端近同时发送：先两端预填输入（校验可用性），再背靠背点击发送（跨进程无法严格同时，
      // 取「两端均落在同一忙窗内、互不踩踏」为口径——规范 T1.2「双端同时发送各自入队」语义）。
      await prefillInput(initiator, T1C_MSG3A);
      await prefillInput(pageB, T1C_MSG3B);
      const errCountBeforeT3 = { init: renderErrorCount(initiator.tag), obs: renderErrorCount('B') };
      await initiator.eval(`document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
      await pageB.eval(`document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
      // 各自「已加入队列」反馈（4s 存活窗，紧轮询）。
      const nA = await waitFor('T1C-3 发起端入队反馈', async () => { const n = await noticeOf(initiator); return n.present && n.text.includes('已加入队列') ? n.text : null; }, 8, 150);
      const nB = await waitFor('T1C-3 网页端入队反馈', async () => { const n = await noticeOf(pageB); return n.present && n.text.includes('已加入队列') ? n.text : null; }, 8, 150);
      // tasks 恰 +2：快照轮询至两条新任务都在（尾部追加）。
      const s1 = await pollOverviewOf(pageB, t1cSid, 'T1C-3 两端任务均入队', (o) => {
        const ts = o.tasks ?? [];
        return ts.some((t) => (t.prompt || '').includes(T1C_MSG3A)) && ts.some((t) => (t.prompt || '').includes(T1C_MSG3B));
      }, 20);
      const s1Tasks = s1.tasks ?? [];
      if (s1Tasks.length !== baseLen + 2) throw new Error(`队列 tasks ${s1Tasks.length} ≠ 基线 ${baseLen}+2（丢失或多余）`);
      const idxA = s1Tasks.findIndex((t) => (t.prompt || '').includes(T1C_MSG3A));
      const idxB = s1Tasks.findIndex((t) => (t.prompt || '').includes(T1C_MSG3B));
      if (Math.min(idxA, idxB) < baseLen) throw new Error(`新任务出现插队首（idx A=${idxA} B=${idxB}，基线长=${baseLen}）——违背尾部追加`);
      // 尾部追加顺序稳定：1.2s 后二采快照 id 序列一致（无丢失/无重排）。
      await sleep(1200);
      const s2 = await queueOverviewOf(pageB, t1cSid);
      const s2Ids = JSON.stringify((s2.tasks ?? []).map((t) => t.id));
      const s1Ids = JSON.stringify(s1Tasks.map((t) => t.id));
      if (s2Ids !== s1Ids) throw new Error(`追加顺序不稳定：S1=${s1Ids} → S2=${s2Ids}`);
      // 无锁死：两端输入框均恢复可用。
      await waitFor('T1C-3 发起端输入框恢复可用', async () => (await inputGateOf(initiator)).disabled === false, 10, 300);
      await waitFor('T1C-3 网页端输入框恢复可用', async () => (await inputGateOf(pageB)).disabled === false, 10, 300);
      const t3Note = `双端同时发送各自入队：两端 notice 齐（「${String(nA).slice(0, 18)}」/「${String(nB).slice(0, 18)}」）+ tasks 恰 +2（${baseLen}→${s1Tasks.length}）+ 尾部追加（idx ${idxA}/${idxB} ≥ 基线长）+ 1.2s 二采序列稳定 + 两端输入框恢复可用`;
      // ── A2-7 边界行 3 收尾：一端清空队列 → 另一端输入框可用、无未定义态报错（console error
      // 记账口径同 B 链：发起端/围观端渲染层异常增量均为 0）。 ──
      const clearFrameSeq = frameSeq;
      const t1cIdsNow = (s2.tasks ?? []).map((t) => t.id);
      for (const tid of t1cIdsNow) {
        await initiator.eval(`window.claudeLink.removeTask(${JSON.stringify(tid)}).then(() => true)`);
      }
      await pollOverviewOf(pageB, t1cSid, 'A2-7 边界行3：队列清空同步到对端', (o) => (o.tasks ?? []).length === 0, 15);
      const gateObs = await inputGateOf(pageB);
      if (gateObs.disabled === true) throw new Error('队列清空后围观端输入框仍禁用（锁死/未定义态）');
      const dInit = renderErrorCount(initiator.tag) - errCountBeforeT3.init;
      const dObs = renderErrorCount('B') - errCountBeforeT3.obs;
      if (dInit > 0 || dObs > 0) {
        const added = [...renderErrors.filter((x) => x.page === initiator.tag).slice(errCountBeforeT3.init), ...renderErrors.filter((x) => x.page === 'B').slice(errCountBeforeT3.obs)];
        throw new Error(`清队窗口渲染层异常：发起端 +${dInit} 围观端 +${dObs}：` + added.slice(0, 4).map((x) => `[${x.kind}] ${String(x.text).slice(0, 80)}`).join(' | '));
      }
      t1cTaskIds = []; // 已清空，收尾无需再删
      await screenshot(pageB, 'T1C-3-B');
      record('T1C-3', 'PASS', `${t3Note}；A2-7 边界行3 收尾：发起端清空队列 → 对端快照 0 条同步 + 输入框可用 + 渲染层异常增量 0（发起端/围观端双页记账）`);
    } catch (e) {
      record('T1C-3', 'FAIL', e.message);
      await screenshot(pageB, 'T1C-3-B-failed').catch(() => {});
    }
  }
  if (desktopDegraded) {
    log('  [T1C 申报] 桌面 page attach 不可得，T1C-1/2/3 以「网页发起端+网页围观端」双 page 口径执行（跨端同步语义保留，桌面真实窗口面未覆盖）——见实施报告');
  }

  // ── 善后：尽力删除本次物化的测试会话（经 store deleteSession，B3 链同款；不参与断言）──
  for (const sid of [c1.sid, c4Sid, c6Sid, t1cSid].filter(Boolean)) {
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
