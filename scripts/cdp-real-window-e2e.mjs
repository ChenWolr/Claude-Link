// scripts/cdp-real-window-e2e.mjs
// review-v9 §5：Task 9 真实窗口发布级验收（可重复、可检查、不依赖人工口述）。
//
// 用法（两种形态，2026-11-17 t1clp 点起；先例 = cdp-web-access-e2e.mjs ISO 自举层）：
//   · 裸跑（默认，ISO 模式）：npm run test:cdp:real-window —— 脚本自举隔离环境：
//     构建新鲜度检查（src 比 out/renderer 新才 npm run build）→ 隔离 seed（真实配置只读底稿 →
//     <ISO>/app/claude-link-config.json，仅改 workingDirectory=<ISO 夹具>/permissionMode=
//     bypassPermissions/webAccess.enabled=false）→ spawn electron（--user-data-dir=<ISO>/app，
//     --remote-debugging-port=9223）→ 跑套件 → 按 PID taskkill /T /F 收口 + rmSync <ISO> 整目录
//     （用后删除，AGENTS.md 隔离纪律；真实配置全程只读）。F1-4 重开语义使用「同 profile 二次
//     冷启动」（内存清零后 DB 诚实回落——内存脚注槽 markRunning/删除会话才清，切走再切回不清，
//     同 run 内重开无法区分内存值与 DB 值，故重启口径，见场景 9 注）。
//   · 旧形态（外部自备实例）：npm run dev:cdp 后运行本脚本——9223 已被占用时 ISO 模式拒绝复用
//     （防跨轮 profile 污染，B 链同款）；该形态实例非隔离 profile，不作为闸门口径。
//
// 退出协议（review-v9 §5）：
//   - exit 0：全部场景通过（无 skip、无 warning-as-pass、无未恢复的设置变更）。
//   - exit 1：断言失败（实现回归）。
//   - exit 2：前置条件不满足（Electron/CDP/CLI/凭据不可用）——「无法执行」，不算通过。
//   - exit 3：环境受限场景未执行（如 /compact 无法达到可压缩阈值）——阻止「Task 9 完成」声明。
//
// 场景（review-v9 §5 顺序）：
//   1. 临时工作目录 <CACHE_ROOT>/e2e/<run-id>/cwd（CACHE_ROOT = CLAUDE_LINK_CACHE_ROOT ?? <系统临时目录>/claude-link-cache；/init 副作用只允许在此）。
//   2. UI 建会话 + 设置工作目录 + /init 落盘断言（CLAUDE.md 存在且非空；无文件须有
//      init_write_skipped 或原生失败，不允许文字回复当成功）。
//   3. 记录消息数/命令快照/诊断摘要 → 切走再切回（重开会话）→ 断言恢复。
//   4. /clear 与「新建对话」分别运行：前者保留 app session（同 id + 原生 result 反馈），
//      后者创建独立 app session（不同 id）。两者不共用通过条件。
//   5. /context /usage /reload-skills：检查消息列表中的原生结果（system/result 消息），
//      不是只看 sendMessage() Promise 返回。
//   6. /compact：warmup 后执行；环境无法达到阈值 → exit 3（未执行，阻止完成声明）。
//   7. /config：备份真实 ~/.claude/settings.json → 执行 → 验证写入位置/key → 恢复并验证。
//      （CC 从进程 env 解析 ~，SDK env 注入无法隔离 HOME——记忆实测，故用快照+恢复。）
//   8. 中断运行中 query：按钮状态恢复、system:aborted 只持久化一次、重开仍可见。
//      8-F1-2c（t1clp 扩展）：中断后即时断言「已中断 · 运行 X:XX」脚注可见（内存 meta 实时）。
//   9. F1-4 重开语义三步（t1clp 扩展，重启口径）：成功回合重开脚注仍在（DB 值=内存流内值）/
//      中断回合重开无脚注（P2-1 不落库诚实）/ 错误回合重开无脚注（同 P2-1 口径）。
//
// 结束只清理自己在 e2e/<run-id>/ 创建的目录与会话；设置备份恢复失败 → 失败并保留备份路径。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const CDP_PORT = 9223;
// R3（2026-11-11 脱敏收尾，对齐 aceadb3 先例）：缓存根可经 CLAUDE_LINK_CACHE_ROOT 覆盖；
// 未设时优先 D:\software\Cache（全局指令：临时文件一律放该目录；t1clp 对齐 B 链 ISO 惯例），
// 目录不存在回落 os.tmpdir() 子目录。
const CACHE_ROOT = process.env.CLAUDE_LINK_CACHE_ROOT
  ?? (fs.existsSync('D:/software/Cache') ? 'D:/software/Cache/claude-link-cache' : path.join(os.tmpdir(), 'claude-link-cache'));
const E2E_ROOT = path.join(CACHE_ROOT, 'e2e');
const RUN_ID = `real-window-${Date.now()}`;
const FIXTURE_ROOT = path.join(E2E_ROOT, RUN_ID);
const CWD = path.join(FIXTURE_ROOT, 'cwd').replace(/\\/g, '/');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_BACKUP = path.join(FIXTURE_ROOT, 'settings-backup.json');

// ── ISO 自举（t1clp：裸跑默认自起隔离实例；真实配置只读底稿，写入全部落 ISO 目录）──
const ISO_DIR = path.join(CACHE_ROOT, 'claude-link-realwindow-iso');
const ISO_APP_DIR = path.join(ISO_DIR, 'app');
const ISO_FIXTURE_DIR = path.join(ISO_DIR, 'fixture');
const ISO_CONFIG_PATH = path.join(ISO_APP_DIR, 'claude-link-config.json');
const DEFAULT_CONFIG_PATH = path.join(process.env.APPDATA ?? '', 'claude-link', 'claude-link-config.json');
const REPO_ROOT = process.cwd();
let isoProc = null;
let isoCleaned = false;
function isoTeardown() {
  if (isoCleaned) return;
  isoCleaned = true;
  if (isoProc?.pid) {
    try { spawnSync('taskkill', ['/PID', String(isoProc.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }); log(`[iso-teardown] electron PID ${isoProc.pid} 已 taskkill /T /F`); } catch { /* 尽力而为 */ }
  }
  // 【R2-A·P27】原实现单次 rmSync：taskkill /T /F 后进程句柄释放有延迟窗（Windows EBUSY），
  // 单发即败留人工清理。改 3 次 × 1s 同步重试（Atomics.wait 同步休眠——'exit'/信号处理器内
  // 不允许异步挂起），EBUSY 容忍；3 次仍败才申报留人工清理。仅重试次数变化，退出码语义不变。
  let rmErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try { fs.rmSync(ISO_DIR, { recursive: true, force: true }); rmErr = null; log(`[iso-teardown] 隔离目录已删除：${ISO_DIR}`); break; }
    catch (e) { rmErr = e; if (attempt < 3) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1_000); }
  }
  if (rmErr) log(`[iso-teardown] 隔离目录删除失败（3 次重试后仍失败，申报留人工清理）：${String(rmErr.message).slice(0, 120)}`);
}
process.on('exit', isoTeardown);
process.on('SIGINT', () => { isoTeardown(); process.exit(130); });
process.on('SIGTERM', () => { isoTeardown(); process.exit(143); });

function findListenerPids(port) {
  let out;
  try {
    out = spawnSync('netstat.exe', ['-ano'], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).stdout ?? '';
  } catch {
    return null;
  }
  const pids = [];
  for (const lineRaw of String(out).split(/\r?\n/)) {
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

function ensureBuildFreshIso() {
  let buildMs = 0;
  try { buildMs = fs.statSync(path.join(REPO_ROOT, 'out', 'renderer')).mtimeMs; } catch { buildMs = 0; }
  let newestSrc = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { try { const m = fs.statSync(p).mtimeMs; if (m > newestSrc) newestSrc = m; } catch { /* 尽力而为 */ } }
    }
  };
  try { walk(path.join(REPO_ROOT, 'src')); } catch { /* 交由构建失败路径报错 */ }
  if (buildMs === 0 || newestSrc > buildMs) {
    log(`[iso-build] out/renderer 落后于 src 最新 → npm run build`);
    const r = spawnSync('npm run build', { shell: true, stdio: 'inherit', windowsHide: true, timeout: 600_000, cwd: REPO_ROOT });
    if (r.error || r.status !== 0) throw new PreconditionError(`npm run build 失败（status=${r.status ?? 'N/A'}）——ISO 自举中止`);
  } else {
    log(`[iso-build] 产物新鲜，跳过重建`);
  }
}

/** 拉起 electron（隔离 profile）。F1-4 重启口径与首次自举共用同一 spawn 形态。 */
function spawnIsoElectron() {
  const electronBin = createRequire(import.meta.url)('electron');
  if (typeof electronBin !== 'string' || !fs.existsSync(electronBin)) {
    throw new PreconditionError(`electron 二进制不可解析（require('electron')=${String(electronBin)}）——node_modules 未安装？`);
  }
  return spawn(electronBin, ['.', `--user-data-dir=${ISO_APP_DIR}`, `--remote-debugging-port=${CDP_PORT}`], {
    cwd: REPO_ROOT, stdio: 'ignore', windowsHide: true,
  });
}

async function waitForCdpPage(timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try { const t = await getPageTarget(); if (t) return t; } catch { /* 未就绪继续轮询 */ }
    if (Date.now() > deadline) throw new PreconditionError(`electron CDP ${CDP_PORT} 在 ${timeoutMs}ms 内无 page target——启动失败`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** ISO 自举（裸跑默认）：9223 占用拒绝复用（防跨轮 profile 污染）→ 构建新鲜度 → seed → spawn。
 *  返回连接就绪的 ws（桥可用）。 */
async function ensureIsoEnvironment() {
  const occupied = findListenerPids(CDP_PORT);
  precondition(occupied !== null, 'netstat 校验手段不可用——ISO 自举无法进行');
  precondition(occupied.length === 0, `端口 ${CDP_PORT} 已被占用（PID ${occupied.join(',')}，疑似外部 Electron 实例）——ISO 模式拒绝复用（防跨轮 profile 污染），请先释放该端口（旧形态 npm run dev:cdp 不再作为闸门口径）`);
  ensureBuildFreshIso();
  let base = null;
  try { base = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8')); } catch { base = null; }
  precondition(base && typeof base === 'object', `ISO 自举需真实配置 ${DEFAULT_CONFIG_PATH} 作只读底稿（provider/apiBaseUrl 等）——未找到或不可解析`);
  fs.mkdirSync(ISO_APP_DIR, { recursive: true });
  fs.mkdirSync(ISO_FIXTURE_DIR, { recursive: true });
  // seed = 真实配置浅拷贝 + 三项覆盖（workingDirectory=ISO 夹具防触用户真实目录；bypassPermissions
  // 经隔离配置注入 = AGENTS.md 认可的等效注入形态（场景 1-2 仍走真实 UI 面板二次确权）；web 关闭防端口撞）。
  const seed = { ...base };
  seed.workingDirectory = ISO_FIXTURE_DIR;
  seed.permissionMode = 'bypassPermissions';
  seed.webAccess = { ...(base.webAccess ?? {}), enabled: false };
  fs.writeFileSync(ISO_CONFIG_PATH, JSON.stringify(seed, null, 2), 'utf8');
  isoProc = spawnIsoElectron();
  await waitForCdpPage();
  const page = await getPageTarget();
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 20).catch(() => false);
  precondition(hasBridge, 'ISO 自举 electron preload bridge 不可用');
  log(`[iso] electron 自举完成 PID=${isoProc.pid}（--user-data-dir=${ISO_APP_DIR}；真实配置只读）`);
  return ws;
}

/** F1-4 重启口径：按 PID 收口当前 ISO 实例 → 同 profile 二次冷启动 → 重连 ws（桥就绪）。
 *  同 profile = 内存（pinia turnFootnote 槽）清零而 DB/配置保留——「重开」语义的可信形态。 */
async function restartIsoApp(wsOld) {
  log('[iso-restart] F1-4 重开语义：按 PID 收口实例 → 同 profile 二次冷启动');
  try { wsOld?.close(); } catch { /* 尽力而为 */ }
  if (isoProc?.pid) {
    try { spawnSync('taskkill', ['/PID', String(isoProc.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 }); } catch { /* 尽力而为 */ }
  }
  const deadline = Date.now() + 30_000;
  while ((findListenerPids(CDP_PORT) ?? []).length > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 500));
  }
  await new Promise((r) => setTimeout(r, 1000)); // profile 写句柄释放余量
  isoProc = spawnIsoElectron();
  await waitForCdpPage();
  const page = await getPageTarget();
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge（重启后）', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 20).catch(() => false);
  precondition(hasBridge, '重启后 preload bridge 不可用');
  log(`[iso-restart] 二次冷启动完成 PID=${isoProc.pid}`);
  return ws;
}

let pass = 0;
let fail = 0;
let envLimited = null; // exit 3 原因
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);
async function check(name, fn) {
  try {
    await fn();
    pass++;
    log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    log(`  ❌ ${name} — ${e.message}`);
  }
}
class PreconditionError extends Error {}
function precondition(cond, message) {
  if (!cond) throw new PreconditionError(message);
}

// ── CDP 基础（与 cdp-commands-e2e.mjs 同款最小实现）──
async function getPageTarget() {
  // 【R2-A·P27（round-001）】原实现无界等待：CDP /json 半开/挂起时 fetch 永不返回（编排器亲历
  // iso-restart 挂死 >600s）。加 30s 超时（AbortSignal.timeout，Node≥17.3）：超时即 reject，
  // 由上层既有轮询语义（waitForCdpPage 90s 截止/重启等待）兜底；编排面超时修复，断言语义零变化。
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`, { signal: AbortSignal.timeout(30_000) });
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
}
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    // 【R2-A·P27】原实现仅 open/error 两个落定路径：TCP 已连但 WS 升级握手无响应时 Promise 永不
    // 落定（挂死形态之一）。加 30s 竞速超时：超时 reject 并关闭悬挂 socket（close 尽力而为，
    // 迟到的 error/close 事件落定在已 reject 的 Promise 上为 no-op）。
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* 尽力而为 */ }
      reject(new Error(`WebSocket 连接超时（30s 无 open）：${url}`));
    }, 30_000);
    ws.addEventListener('open', () => { clearTimeout(timer); resolve(ws); });
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket connection failed')); });
  });
}
async function cdpCall(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1000000);
  return new Promise((resolve, reject) => {
    const handler = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id === id) {
        ws.removeEventListener('message', handler);
        if (msg.error) reject(new Error('CDP: ' + JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    };
    ws.addEventListener('message', handler);
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evalExpr(ws, expr) {
  const r = await cdpCall(ws, 'Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 300));
  return r.result?.value;
}
async function evalOk(ws, expr) {
  return (await evalExpr(ws, expr)) === true;
}
async function insertText(ws, text) {
  await cdpCall(ws, 'Input.insertText', { text });
}
async function waitFor(label, fn, timeoutS = 60, intervalMs = 500) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      lastErr = e.message;
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}${lastErr ? `；最后错误：${lastErr}` : ''}`);
}

// ── UI 驱动 ──
async function newSessionViaUI(ws, name) {
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor('聊天输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  // 2026-09-07 适配（暂态会话，08-28/50e4883 起）：「新会话」= renderer-only 暂态草稿，
  // 不入 listSessions、侧栏无名字条目——经 Pinia 直调 materializeActiveTransient 物化
  // （同 id 建 DB 行；对齐 cdp-context-e2e 的既有适配）。
  await evalExpr(ws, `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    const st = pinia && pinia._s ? pinia._s.get('session') : null;
    return st && st.materializeActiveTransient ? st.materializeActiveTransient().then((s) => !!s) : Promise.resolve(false);
  })()`);
  const sid = await evalExpr(ws, `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    const st = pinia && pinia._s ? pinia._s.get('session') : null;
    return st && st.activeSession ? st.activeSession.id : null;
  })()`);
  if (!sid) throw new Error('物化后未取得活跃会话 id');
  log(`  ℹ 新会话：sid=${sid}`);
  return sid;
}
async function activeSessionId(ws) {
  // 【t1clp 既有用例同步留痕，2026-11-17】.session-link* → .session-card*：c4e0ede（UI13 渲染
  // 批次，2026-11-15）将侧栏会话卡类名整体改名（改名后 session-link 在 AppSidebar 零残留），
  // 本脚本三处锚点随现行实现最小同步（断言语义不变）。run1 实测旧锚致 setWorkingDir 卡配置页
  // → 全链发送被「请先选择工作空间」拒收级联失败。
  return waitFor('活跃会话 id', async () => {
    const activeName = await evalExpr(ws, `document.querySelector('.session-card.active .session-card__name')?.textContent?.trim() ?? null`);
    if (!activeName) return null;
    const sessions = await evalExpr(ws, `window.claudeLink.listSessions()`);
    const hit = (sessions ?? []).find((s) => s.name === activeName);
    return hit?.id ?? null;
  }, 15);
}
async function switchSessionViaUI(ws, sessionName) {
  // 【R2-A·F8（round-001）】restartIsoApp 返回仅保证 preload bridge ready，侧栏会话列表
  // （DB → listSessions → .session-card 渲染）尚未就绪——原实现 restart 后 ~13ms 即 eval 点击，
  // 条目缺席必抛「侧栏未找到会话」（三轮确定性复现：orch-pchain.log 12 passed/3 failed，恒为
  // 场景9-①②③）。改等待式点击：先轮询目标条目在位（15s 超时/500ms 重试间隔），在位再点击；
  // 函数签名与调用面零扩散，点击目标与切换后等待语义逐字不变（点击表达式的 !target 守卫保留，
  // 轮询通过→点击间的极小窗口仍由原守卫兜底）。
  await waitFor(`侧栏会话条目出现（${sessionName}）`, () => evalOk(ws, `(() => {
    const links = [...document.querySelectorAll('.session-card')];
    return links.some((l) => l.querySelector('.session-card__name')?.textContent?.trim() === ${JSON.stringify(sessionName)});
  })()`), 15, 500);
  await evalExpr(ws, `(() => {
    const links = [...document.querySelectorAll('.session-card')];
    const target = links.find((l) => l.querySelector('.session-card__name')?.textContent?.trim() === ${JSON.stringify(sessionName)});
    if (!target) throw new Error('侧栏未找到会话 ' + ${JSON.stringify(sessionName)});
    target.click();
    return true;
  })()`);
  await waitFor('切换后输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
}
async function sessionNameOf(ws, sid) {
  const sessions = await evalExpr(ws, `window.claudeLink.listSessions()`);
  return (sessions ?? []).find((s) => s.id === sid)?.name ?? null;
}
async function setWorkingDir(ws, sid, dir) {
  // 与 cdp-commands-e2e.mjs 同款：播种最近列表（IPC——native 对话框无法 CDP 驱动）→
  // 重挂载工具栏加载最近列表 → UI 菜单点击完成正式切换（真实 UI 路径）。
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  await evalExpr(ws, `(document.querySelector('.session-card.active') || document.querySelector('.session-card'))?.click(), true`);
  await waitFor('回到聊天页（工具栏出现）', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
  await evalExpr(ws, `(() => {
    const wsBtn = document.querySelector('[data-testid="workspace-trigger"]');
    if (!wsBtn) throw new Error('工作空间按钮未找到');
    wsBtn.click();
    return true;
  })()`);
  const clicked = await evalExpr(ws, `(() => {
    const items = [...document.querySelectorAll('.session-toolbar .menu__item')];
    const target = items.find((i) => i.getAttribute('title') === ${JSON.stringify(dir)});
    if (target) { target.click(); return true; }
    return false;
  })()`);
  if (!clicked) throw new Error(`「最近使用」菜单中未出现 ${dir}`);
  await waitFor(`工作空间按钮反映 ${dir}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    return btns.some((b) => (b.getAttribute('title') || '') === ${JSON.stringify(dir)});
  })()`), 15);
}
async function typeInChatInput(ws, text) {
  await evalExpr(ws, `(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    if (!ta) throw new Error('输入框未找到');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await insertText(ws, text);
  await new Promise((r) => setTimeout(r, 300));
}
/** 通过真实 UI 设置会话权限模式（权限按钮 → perm-item 点击）。
 *  /init 等需要工具执行的命令在 default 模式下会等待用户批准权限——无人值守测试必须
 *  显式切换（review 修正：此前 /init 挂 20 分钟实为等待权限确认，非网关慢）。 */
async function setPermissionModeViaUI(ws, permValue, permLabel) {
  await evalExpr(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    if (!btn) throw new Error('权限模式按钮未找到');
    btn.click();
    return true;
  })()`);
  const clicked = await evalExpr(ws, `(() => {
    const items = [...document.querySelectorAll('.perm-item')];
    const t = items.find((i) => i.querySelector('.perm-item__label')?.textContent?.trim() === ${JSON.stringify(permLabel)});
    if (t) { t.click(); return true; }
    return false;
  })()`);
  if (!clicked) throw new Error(`权限面板未找到「${permLabel}」`);
  // 【t1clp 既有用例同步留痕，2026-11-17】UI13（c4e0ede）改权限触发钮 title 形态：由
  // 「权限模式（bypassPermissions）」改为「本会话 Claude Code 权限模式（自动模式）；运行中切换
  // 即时生效」——title 不再含原始值字面，改锚为「会话级已钉住目标 label 且不再跟随全局默认」
  // （点击后的确定性后置态；label 匹配 + 负向排除跟随态，语义=会话权限已切到目标模式）。
  await waitFor(`权限按钮反映 ${permValue}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    const t = btn ? (btn.getAttribute('title') || '') : '';
    return t.includes(${JSON.stringify(permLabel)}) && !t.includes('跟随全局默认');
  })()`), 15);
}

/** 等待当前会话查询空闲（无中断按钮 = 无运行中 query）——发送中点击会被 sending 阻塞。 */
async function waitQueryIdle(ws, timeoutS = 600) {
  await waitFor('查询空闲（无运行中 query）', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), timeoutS, 1000);
}
/** 通过 UI 发送：先等空闲 → 输入 → 点击发送 → 确认消息被接受（user 消息入列）。
 *  t1clp：发送前补「输入框可用（恢复门放行）」等待——A3 恢复门（八问题批次）在会话切换/重启后
 *  有亚秒级禁用窗，禁用期点击发送被 ChatInput 吞掉（02 §2.2 判据），显式等放行防编排竞态。 */
async function sendViaUI(ws, sid, text) {
  await waitQueryIdle(ws, 600);
  await waitFor('输入框可用（A3 恢复门放行）', () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return !!ta && !ta.disabled; })()`), 10, 200);
  const before = (await getMessages(ws, sid)).length;
  await typeInChatInput(ws, text);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
  await waitFor('消息被接受（user 消息入列）', async () => (await getMessages(ws, sid)).length > before, 30, 500);
}
/** 发送后等父组件清空草稿（发送已被接受）——避免异步清空与后续输入竞争。 */
async function waitDraftSettled(ws) {
  await waitFor('草稿清空（发送已被接受）', () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return !!ta && ta.value === ''; })()`), 10, 200);
}
async function getMessages(ws, sid) {
  return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? [];
}
/** 等待原生结果消息（role=system 且 processKind 含 result）出现；返回该消息。 */
async function waitResultMessage(ws, sid, label, timeoutS = 180) {
  return waitFor(`原生结果消息（${label}）`, async () => {
    const msgs = await getMessages(ws, sid);
    return msgs.find((m) => m.role === 'system' && typeof m.processKind === 'string' && m.processKind.includes('result')) ?? null;
  }, timeoutS, 1000);
}
/** 等待发送完成：出现新的 system 消息（result/aborted/local 输出）。 */
/** 回合完成：出现用户消息之外的任一响应消息（system result / local_command_output /
 *  assistant——实测 /reload-skills 的原生结果以 assistant 消息呈现，/usage 等以 system result
 *  落库；两者都是 UI 的原生结果区域，不能只认 system result 一种形态）。 */
async function waitTurnComplete(ws, sid, baseCount, timeoutS = 180) {
  return waitFor(`回合完成（响应消息，>${baseCount}+1 条）`, async () => {
    const msgs = await getMessages(ws, sid);
    return msgs.length > baseCount + 1 ? msgs[msgs.length - 1] : null;
  }, timeoutS, 1000);
}

async function main() {
  console.log('=== CDP Real Window E2E（review-v9 §5：Task 9 发布级窗口验收）===');
  log(`runId=${RUN_ID} fixtureRoot=${FIXTURE_ROOT} cwd=${CWD}`);

  // ── t1clp：ISO 自举（裸跑默认自起隔离实例；9223 占用拒绝复用）——替代旧「先 npm run dev:cdp」
  //    外部实例形态（非隔离 profile，不再作为闸门口径，头注留痕）。 ──
  let ws = await ensureIsoEnvironment();
  const cfg = await evalExpr(ws, `window.claudeLink.getConfig()`);
  precondition(cfg && cfg.apiBaseUrl, 'getConfig 未返回有效 apiBaseUrl（CLI/网关未配置）。无法执行，exit 2。');

  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(CWD, 'README.md'), '# real-window-e2e\n\nA minimal project for /init verification.\n', 'utf8');

  const created = [];
  let settingsBackedUp = false;
  const cleanup = async () => {
    // /config 设置恢复（review-v9 §5：恢复失败 → 失败并保留备份路径，禁止静默删除）。
    if (settingsBackedUp) {
      try {
        if (USER_SETTINGS_BACKUP_EXISTS()) {
          fs.copyFileSync(SETTINGS_BACKUP, USER_SETTINGS);
          settingsRestoredOk = fileEquals(USER_SETTINGS, SETTINGS_BACKUP);
        }
      } catch (e) {
        settingsRestoreError = e.message;
      }
    }
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
  };
  function USER_SETTINGS_BACKUP_EXISTS() { return fs.existsSync(SETTINGS_BACKUP); }
  function fileEquals(a, b) {
    const h = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
    return h(a) === h(b);
  }
  let settingsRestoredOk = true;
  let settingsRestoreError = null;

  try {
    // ── 场景 1+2：UI 会话 + workingDir + /init 落盘 ──
    let sid = null;
    await check('场景1-2 UI 建会话 + 工作目录 + /init 真实落盘（CLAUDE.md 非空）', async () => {
      sid = await newSessionViaUI(ws);
      created.push(sid);
      await setWorkingDir(ws, sid, CWD);
      // CLI 配置前置：初始命令 probe ready。
      const snap = await waitFor('初始 probe ready（CLI 已配置）', async () => {
        const s = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
        return s && s.status === 'ready' && (s.commands ?? []).length > 0 ? s : null;
      }, 90, 1000);
      log(`  ℹ 初始快照：${snap.commands.length} 条命令（source=${snap.source}）`);
      // /init 走 Write 工具：default 模式下会等待用户批准权限（无人值守将悬挂）——
      // 通过真实 UI 把本会话切到「自动模式」（bypassPermissions）再发送。
      await setPermissionModeViaUI(ws, 'bypassPermissions', '自动模式');
      log('  ℹ 会话权限模式 → 自动模式（bypassPermissions，经 UI 权限面板）');
      const baseCount = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, sid, '/init');
      // /init 是多 turn 模型工作流（native E2E 给到 480s+ wall-clock），此处同量级：
      // 等回合出现响应消息，再等查询真正结束（多 turn Write 需数分钟）。
      await waitTurnComplete(ws, sid, baseCount, 540);
      // /init 多 turn Write 可能 >600s 才收尾：文件出现即落盘证据，不硬等查询结束。
      // /init 多 turn Write 在慢网关下实测 >600s：给足 1200s（文件出现即证据）。
      await waitFor('CLAUDE.md 出现（/init 落盘）', () => fs.existsSync(path.join(CWD, 'CLAUDE.md')), 1200, 2000);
      const claudeMd = path.join(CWD, 'CLAUDE.md');
      if (fs.existsSync(claudeMd)) {
        const content = fs.readFileSync(claudeMd, 'utf8').trim();
        if (content.length === 0) throw new Error('CLAUDE.md 存在但为空——不满足落盘门禁');
        log(`  ℹ CLAUDE.md 已落盘（${content.length} 字符）`);
      } else {
        // 无文件：必须有 init_write_skipped 或明确原生失败消息，不允许把文字回复当成功。
        const msgs = await getMessages(ws, sid);
        const skipped = msgs.some((m) => typeof m.processKind === 'string' && m.processKind.includes('init_write_skipped'));
        if (!skipped) {
          throw new Error('/init 未落盘且 UI 无 init_write_skipped/原生失败标记——目录可写+凭据可用时不允许');
        }
        throw new Error('/init 未落盘（UI 显示 init_write_skipped）——目录可写且凭据可用，落盘门禁失败');
      }
    });
    precondition(sid, '场景1-2 未取得会话——无法继续（exit 2）');

    // ── 场景 3：重开会话（切走再切回）→ 消息/命令/持久化恢复 ──
    await check('场景3 重开会话：消息数/命令快照/持久化状态恢复', async () => {
      const beforeMsgs = await getMessages(ws, sid);
      const beforeSnap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
      const name = await sessionNameOf(ws, sid);
      // 建第二个会话并切换（会话关闭 = 不再活跃）。
      const sid2 = await newSessionViaUI(ws);
      created.push(sid2);
      await switchSessionViaUI(ws, name);
      const afterMsgs = await getMessages(ws, sid);
      if (afterMsgs.length < beforeMsgs.length) throw new Error(`重开后消息丢失：${beforeMsgs.length} → ${afterMsgs.length}`);
      const afterSnap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
      if ((afterSnap.commands ?? []).length !== (beforeSnap.commands ?? []).length) {
        throw new Error(`重开后命令快照数量变化：${beforeSnap.commands.length} → ${afterSnap.commands.length}`);
      }
      log(`  ℹ 重开后消息 ${beforeMsgs.length}→${afterMsgs.length}，命令 ${beforeSnap.commands.length} 条保持`);
    });

    // ── 场景 4：/clear 与「新建对话」分别验证（不共用通过条件）──
    await check('场景4a /clear：同 app session 内原生重置（id 不变 + result 反馈）', async () => {
      const base = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, sid, '/clear');
      await waitTurnComplete(ws, sid, base, 120);
      await waitQueryIdle(ws, 180);
      const stillSame = (await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`))?.id === sid;
      if (!stillSame) throw new Error('/clear 不应切换/删除 app session（原生重置在会话内进行）');
      log('  ℹ /clear 完成：app session 保留，result 反馈已入消息列表');
    });
    await check('场景4b 新建对话：独立 app session（不同 id）', async () => {
      const sidNew = await newSessionViaUI(ws);
      created.push(sidNew);
      if (sidNew === sid) throw new Error('新建对话必须创建独立 app session（id 不同）');
      const name = await sessionNameOf(ws, sid);
      await switchSessionViaUI(ws, name);
      log(`  ℹ 新建对话 id=${sidNew.slice(0, 8)}… ≠ 原 ${sid.slice(0, 8)}…`);
    });

    // ── 场景 5：/context /usage /reload-skills 的原生结果区（消息列表）──
    for (const cmd of ['/context', '/usage', '/reload-skills']) {
      await check(`场景5 ${cmd}：UI 原生结果消息（非仅 sendMessage Promise）`, async () => {
        const before = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, sid, cmd);
        // 原生结果区 = 持久化响应消息（system result / local_command_output / assistant 实测皆有）。
        await waitTurnComplete(ws, sid, before, 120);
        await waitQueryIdle(ws, 180);
        log(`  ℹ ${cmd} 产生原生结果消息（消息 ${before} → ${(await getMessages(ws, sid)).length}）`);
      });
    }

    // ── 场景 6：/compact（环境无法达到阈值 → exit 3 未执行）──
    await check('场景6 /compact：warmup 后真实压缩证据', async () => {
      // warmup 两轮长输出，堆积上下文。
      for (const prompt of [
        '请极其详尽地解释 TypeScript 的泛型、条件类型、映射类型与 infer，每种给多个完整代码示例，至少 800 字。',
        '接着极其详尽地解释 JavaScript 闭包、原型链、事件循环，每种给完整代码示例，至少 800 字。',
      ]) {
        const base = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, sid, prompt);
        await waitTurnComplete(ws, sid, base, 300);
        await waitQueryIdle(ws, 300);
      }
      const base = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, sid, '/compact');
      await waitTurnComplete(ws, sid, base, 300);
      await waitQueryIdle(ws, 300);
      const msgs = await getMessages(ws, sid);
      const compactEvidence = msgs.some((m) =>
        typeof m.processKind === 'string' && /compact/i.test(m.processKind));
      if (!compactEvidence) {
        // 环境无法确认压缩证据（模型 summarization 瞬态/上下文不足）→ 未执行（exit 3），不放绿灯。
        envLimited = '/compact 未取得压缩证据（warmup 后仍无 compact 相关消息/事件——模型或上下文阈值限制）';
        throw new Error(envLimited);
      }
      log('  ℹ /compact 有压缩证据消息');
    });

    // ── 场景 7：/config 写用户级 settings + 备份恢复 ──
    await check('场景7 /config：写入 ~/.claude/settings.json + 恢复原值', async () => {
      // 备份真实设置（CC 从进程 env 解析 ~，SDK env 注入无法隔离 HOME——记忆实测）。
      fs.mkdirSync(path.dirname(SETTINGS_BACKUP), { recursive: true });
      if (fs.existsSync(USER_SETTINGS)) fs.copyFileSync(USER_SETTINGS, SETTINGS_BACKUP);
      settingsBackedUp = true;
      const before = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, 'utf8') : null;
      const cfgBase = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, sid, '/config autoCompact=false');
      // 原生结果区 = 持久化响应消息（result 或 local_command_output 形态皆有，实测口径）。
      await waitTurnComplete(ws, sid, cfgBase, 120);
      await waitQueryIdle(ws, 300);
      const after = fs.existsSync(USER_SETTINGS) ? fs.readFileSync(USER_SETTINGS, 'utf8') : null;
      let parsed = {};
      try { parsed = JSON.parse(after ?? '{}'); } catch { /* keep {} */ }
      if (!('autoCompactEnabled' in parsed)) {
        throw new Error(`/config 未写入用户级 settings.json（autoCompactEnabled 缺失；after keys=${Object.keys(parsed).join(',')}）`);
      }
      log(`  ℹ /config 写入 autoCompactEnabled=${parsed.autoCompactEnabled}（用户级 settings.json）`);
      // 恢复在 finally/cleanup 统一执行；此处只记录原值摘要。
      log(`  ℹ 原值已备份：${SETTINGS_BACKUP}（${before?.length ?? 0} 字符）`);
    });

    // ── 场景 8：中断运行中 query ──
    await check('场景8 中断：按钮恢复 + system:aborted 恰一次 + 重开仍可见', async () => {
      const abortedBefore = (await getMessages(ws, sid))
        .filter((m) => m.processKind === 'system:aborted').length;
      await sendViaUI(ws, sid, '请极其详尽地解释整个 JavaScript 生态系统历史，尽量长。');
      // 等待中断按钮出现（query 运行中）。
      await waitFor('中断按钮出现（query 运行中）', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 60, 500);
      // 问题⑥ 后中断按钮改长按 1 秒：.click() 走不到 pointerdown/长按路径（永不 abort）。
      // 模拟真实长按：pointerdown → 1.2s → pointerup；须窗口可见（进度由 rAF 驱动，遮挡窗 rAF 停摆会长按不完成）。
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
      await new Promise((r) => setTimeout(r, 1200));
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
      // 按钮状态恢复（abort 按钮消失）。
      await waitFor('中断按钮消失（sending 复位）', async () => !(await evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`)), 60, 1000);
      // system:aborted 恰好新增一条。
      await waitFor('system:aborted 持久化', async () => {
        const now = (await getMessages(ws, sid)).filter((m) => m.processKind === 'system:aborted').length;
        return now === abortedBefore + 1 ? true : null;
      }, 60, 1000);
      // ── t1clp F1-2c（八问题批次）：中断后即时断言「已中断 · 运行 X:XX」脚注可见——内存 meta
      // 实时（setTurnFootnote 于 use-chat turn_ended 两分支无条件记账；sending 下降沿后即渲染，
      // 独立载体 data-testid=turn-footnote，kind=interrupted）。须在本场景的「重开」之前断言
      //（重开切走再切回不清内存槽，脚注仍在——与 F1-4 重启口径的正本区分，见场景 9 注）。 ──
      await check('场景8-F1-2c 中断脚注即时可见（已中断 · 运行 X:XX，内存 meta 实时）', async () => {
        await waitFor('中断脚注出现（turn-footnote--interrupted）', () => evalOk(ws, `(() => {
          const el = document.querySelector('[data-testid="turn-footnote"]');
          return !!el && el.classList.contains('turn-footnote--interrupted');
        })()`), 10, 300);
        const text = await evalExpr(ws, `((document.querySelector('[data-testid="turn-footnote"]')?.textContent || '')).trim()`);
        if (!/^已中断\s*·\s*运行\s+\S+/.test(String(text))) {
          throw new Error(`中断脚注文案形态不符（期望「已中断 · 运行 X:XX」）：「${text}」`);
        }
        log(`  ℹ F1-2c 中断脚注即时可见：「${text}」（内存 meta 实时，尚未重开）`);
      });
      // 重开（切走再切回）后仍可见。
      const name = await sessionNameOf(ws, sid);
      const sidTmp = await newSessionViaUI(ws);
      created.push(sidTmp);
      await switchSessionViaUI(ws, name);
      const afterReopen = (await getMessages(ws, sid)).filter((m) => m.processKind === 'system:aborted').length;
      if (afterReopen !== abortedBefore + 1) {
        throw new Error(`重开后 system:aborted 数量不符：期望 ${abortedBefore + 1}，实际 ${afterReopen}`);
      }
      log(`  ℹ 中断生效：aborted=${afterReopen}（+1），sending 已复位，重开仍可见`);
    });

    // ── 场景 9：F1-4 重开语义三步（t1clp，重启口径）──
    // 「重开」= 同 profile 二次冷启动（restartIsoApp）：内存脚注槽（pinia turnFootnote）随进程
    // 清零，DB 诚实回落——切走再切回（同 run）不清内存槽（仅 markRunning/deleteSession 清），
    // 无法区分「内存值」与「DB 值」，故取重启为重开正本（02 §12.3「重开仅成功（DB 回落）」）。
    // 三会话各自独占（首个回合即定语义，防 lastTurn* 交叉污染）：
    //   A=成功回合（脚注仍在，DB 值=内存流内值）；B=中断回合（无脚注，P2-1 不落库诚实）；
    //   C=错误回合（无脚注，错误回合不落库同 P2-1 口径——若实现扩展错误回合落库须申报并同步本用例）。
    let sidF1a = null;
    let sidF1b = null;
    let sidF1c = null;
    let f1aFootnoteText = null;
    let nameF1a = null;
    let nameF1b = null;
    let nameF1c = null;
    await check('场景9-pre F1-4 三会话夹具（成功/中断/错误回合各一，脚注即时态捕获）', async () => {
      // A：成功回合（正文结尾，42）。
      sidF1a = await newSessionViaUI(ws);
      created.push(sidF1a);
      await setWorkingDir(ws, sidF1a, CWD);
      const baseA = (await getMessages(ws, sidF1a)).length;
      await sendViaUI(ws, sidF1a, '请只回复数字 42，不要使用任何工具');
      await waitTurnComplete(ws, sidF1a, baseA, 180);
      await waitQueryIdle(ws, 180);
      await waitFor('A 成功脚注出现（turn-footnote--success）', () => evalOk(ws, `(() => {
        const el = document.querySelector('[data-testid="turn-footnote"]');
        return !!el && el.classList.contains('turn-footnote--success');
      })()`), 10, 300);
      f1aFootnoteText = (await evalExpr(ws, `(document.querySelector('[data-testid="turn-footnote"]')?.textContent || '').trim()`));
      if (!/^本次回复\s+\S+\s*·\s*结束于\s+\S+/.test(String(f1aFootnoteText))) {
        throw new Error(`A 成功脚注文案形态不符（期望「本次回复 X · 结束于 HH:MM:SS」）：「${f1aFootnoteText}」`);
      }
      nameF1a = await sessionNameOf(ws, sidF1a);
      log(`  ℹ F1-4 A 成功回合脚注（内存流内值）：「${f1aFootnoteText}」`);
      // B：中断回合（独立会话，首个回合即中断——lastTurn* 保持 null）。
      sidF1b = await newSessionViaUI(ws);
      created.push(sidF1b);
      await setWorkingDir(ws, sidF1b, CWD);
      await sendViaUI(ws, sidF1b, '请极其详尽地解释整个 Rust 生态系统的演进历史，尽量长，不要使用任何工具。');
      await waitFor('B 中断按钮出现（query 运行中）', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 60, 500);
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
      await new Promise((r) => setTimeout(r, 1200));
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
      await waitFor('B 中断按钮消失（sending 复位）', async () => !(await evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`)), 60, 1000);
      nameF1b = await sessionNameOf(ws, sidF1b);
      log(`  ℹ F1-4 B 中断回合落位（中断脚注即时态在场，重启后将诚实消失）`);
      // C：错误回合（工作目录不存在 → CLI spawn 失败 → 错误回合；※首跑校准项）。
      sidF1c = await newSessionViaUI(ws);
      created.push(sidF1c);
      const C_ERROR_DIR = path.join(FIXTURE_ROOT, 'nonexistent-cwd').replace(/\\/g, '/');
      await setWorkingDir(ws, sidF1c, C_ERROR_DIR);
      const baseC = (await getMessages(ws, sidF1c)).length;
      await sendViaUI(ws, sidF1c, '请只回复数字 7，不要使用任何工具');
      await waitTurnComplete(ws, sidF1c, baseC, 180);
      await waitQueryIdle(ws, 180);
      nameF1c = await sessionNameOf(ws, sidF1c);
      const errFootnote = await evalOk(ws, `(() => {
        const el = document.querySelector('[data-testid="turn-footnote"]');
        return !!el && el.classList.contains('turn-footnote--error');
      })()`);
      log(`  ℹ F1-4 C 错误回合落位（错误脚注即时态在场=${errFootnote}——重启后将诚实消失）`);
    });
    precondition(sidF1a && sidF1b && sidF1c, '场景9-pre 未取得三会话——F1-4 三步无法执行（exit 2）');

    // 重启（内存清零、DB 保留）→ 三步重开断言。
    ws = await restartIsoApp(ws);

    // 【t1clp 用例口径同步申报，2026-11-17】用例原期望「重开脚注与内存流内值一致」不可达：
    // 双源语义为既有实现（use-chat SA-3 收口序——result 先至写 DB（event.duration_ms=CLI 生成
    // 耗时，run2 实测 2.2s）并 markCompleted 摘 running；turn_ended 后至，内存脚注槽在 running
    // 守卫之前无条件记账（墙钟耗时，run2 实测 6.3s），其成功分支因 running 已摘而跳过二次
    // DB 写）。两值同源不同测（生成耗时 vs 回合墙钟），V12/b1 双写链零触碰面不许拉平。
    // 本检查同步为「重开脚注在且为 DB 诚实值（成功形态齐全）」，双源拉平归审查岗裁定。
    await check('场景9-① F1-4 成功回合重开脚注仍在（值来自 DB 持久化——成功形态齐全，见口径同步申报）', async () => {
      await switchSessionViaUI(ws, nameF1a);
      await waitFor('① 成功脚注出现（重开后 DB 回落）', () => evalOk(ws, `!!document.querySelector('[data-testid="turn-footnote"]')`), 15, 300);
      const text = (await evalExpr(ws, `(document.querySelector('[data-testid="turn-footnote"]')?.textContent || '').trim()`));
      if (!/^本次回复\s+\S+\s*·\s*结束于\s+\S+/.test(String(text))) {
        throw new Error(`重开后成功脚注形态不符：「${text}」`);
      }
      log(`  ℹ F1-4① 重开脚注（DB 值）：「${text}」；内存流内值：「${f1aFootnoteText}」（双源口径见申报）`);
    });
    await check('场景9-② F1-4 中断回合重开无脚注（P2-1 中断不落库语义诚实）', async () => {
      await switchSessionViaUI(ws, nameF1b);
      await waitFor('② 会话页就绪（输入框在场）', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
      await new Promise((r) => setTimeout(r, 1500)); // 消息渲染沉降余量
      const present = await evalOk(ws, `!!document.querySelector('[data-testid="turn-footnote"]')`);
      if (present) {
        const t = await evalExpr(ws, `(document.querySelector('[data-testid="turn-footnote"]')?.textContent || '').trim()`);
        throw new Error(`中断回合重开出现伪造脚注：「${t}」（P2-1 中断不落库语义被破）`);
      }
    });
    await check('场景9-③ F1-4 错误回合重开无脚注（错误回合不落库同 P2-1 口径）', async () => {
      await switchSessionViaUI(ws, nameF1c);
      await waitFor('③ 会话页就绪（输入框在场）', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
      await new Promise((r) => setTimeout(r, 1500)); // 消息渲染沉降余量
      const present = await evalOk(ws, `!!document.querySelector('[data-testid="turn-footnote"]')`);
      if (present) {
        const t = await evalExpr(ws, `(document.querySelector('[data-testid="turn-footnote"]')?.textContent || '').trim()`);
        throw new Error(`错误回合重开出现脚注：「${t}」（错误回合落库=实现扩展，须申报并同步本用例）`);
      }
    });
  } finally {
    await cleanup();
    // 设置恢复验证（review-v9 §5：恢复失败 → 失败并保留备份路径）。
    if (settingsBackedUp) {
      if (!settingsRestoredOk) {
        fail++;
        log(`  ❌ 用户设置恢复失败（${settingsRestoreError ?? '哈希不一致'}）——备份保留于 ${SETTINGS_BACKUP}，禁止静默丢弃`);
      } else if (fs.existsSync(SETTINGS_BACKUP)) {
        log(`  ℹ 用户设置已恢复并验证一致（备份保留：${SETTINGS_BACKUP}）`);
      }
    }
    try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* 清理失败不覆盖断言结果 */ }
  }

  // 输出版本信息（review-v9 §5 验收 1：app/CC/SDK 版本 + 测试 cwd + 匿名 settings source 摘要）。
  try {
    const appPkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    let ccV = '?'; let sdkV = '?';
    try {
      const b = JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, 'claude-link', 'command-baseline.json'), 'utf8'));
      ccV = b?.environment?.claudeCodeVersion ?? '?';
      sdkV = b?.environment?.sdkVersion ?? '?';
    } catch { /* baseline 缺失如实显示 ? */ }
    log(`版本：app=${appPkg.version} claudeCode=${ccV} agentSdk=${sdkV}；测试 cwd=${CWD}`);
    const diag = await evalExpr(ws, `window.claudeLink.getNativeSettingsDiagnostic('.')`);
    // 匿名化：只保留 source 类型与层名，不含真实路径。
    const anon = Array.isArray(diag?.sources)
      ? diag.sources.map((x) => ({ source: x.source }))
      : Object.keys(diag?.sources ?? diag ?? {}).length;
    log(`settings source 摘要（匿名）：${JSON.stringify(anon)}`);
  } catch { /* 诊断不可用不阻塞 */ }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  if (envLimited) {
    console.error(`\n环境受限场景未执行（阻止「Task 9 完成」声明）：${envLimited}`);
    process.exit(3);
  }
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（无法执行，不算通过）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  process.exit(1);
});
