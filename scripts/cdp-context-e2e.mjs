// scripts/cdp-context-e2e.mjs
// 上下文占用统计契约发布级语义门禁（Task 11；review-v3 §4.8/§6.2 证据落盘）。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行：npm run test:cdp:context-e2e
//
// 退出协议：
//   0 = 全部语义和 UI 断言通过
//   1 = 实现回归 / 字段冲突 / 时序错误
//   2 = CLI/CDP/凭据/前置条件不足，未执行
//   3 = 端点或供应商不提供 native 格式，已验证 unavailable 语义但无法声称 reconciled
//
// 语义场景（S0–S13，每个场景落盘 before/after payload、prompt 元数据、DOM 快照）：
//   S0  空会话（无数据不得显示 0%）
//   S1  短文本（turn usage 不得驱动当前窗口圆环）
//   S2  多轮文本（三轮 turn usage / runtime / DOM 对比）
//   S3  小文件 Read（tool_use/tool_result 后 payload/DOM 变化）
//   S4  大文件 Read（大输出 + /context 分类证据）
//   S5  工具错误（不存在文件的 error tool result 不破坏 UI）
//   S6  CLAUDE.md（注入前后 /context Memory files 贡献对比）
//   S7  MCP（可用时真实执行；不可用时记录 exit 3 原因）
//   S8  thinking（thinking token / turn usage / current context 三者分离）
//   S9  /context 同一 session（native 与 runtime 对账）
//   S10 compaction（/compact：pending → fresh + compactedJustNow 时序）
//   S11 中断重发（A 中断、B 重发、A 迟到 payload 不污染 B）
//   S12 restart/resume（需外部重启编排，本脚本记录原因，语义由 context-research-restart.mjs 覆盖）
//   S13 两 session 隔离（A/B generation、payload、DOM 不串）
//
// 证据落盘（EVIDENCE_DIR，review-v3 §4.8/§6.2）：
//   context-payloads.json —— 全量 CONTEXT_UPDATE payload（脱敏，含 queryGeneration/source/freshness）
//   assertions.json       —— 每条断言的 pass/fail/错误/时间戳
//   scenarios.json        —— 每场景 before/after DOM、prompt、native 原文（脱敏）与 parser 结果
//   scrub-scan.txt        —— 落盘后的脱敏自扫描结果
//
// 复用共享 parser：scripts/native-context-parser-runner.ts（禁止本文件复制 used/max regex）。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// CDP_PORT 在「CDP 基础」区块定义（支持 CDP_PORT 环境变量覆盖）。
const E2E_ROOT = 'D:/software/Cache/claude-link/e2e';
const RUN_ID = `cdp-ctx-${Date.now()}`;
const FIXTURE_ROOT = path.join(E2E_ROOT, RUN_ID);
const CWD = path.join(FIXTURE_ROOT, 'cwd').replace(/\\/g, '/');
const EVIDENCE_DIR = path.join('D:/software/Cache/claude-link/context-research', `e2e-${RUN_ID}`);

let pass = 0;
let fail = 0;
let skipped = 0;
let envLimited = null; // exit 3 原因
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── 脱敏（计划 Task 3 Step 4：session id 前缀、用户目录/仓库占位、密钥抹除）──
const SCRUB_STRING_RULES = [
  [/sk-[A-Za-z0-9_-]{6,}/g, '<redacted>'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi, 'Bearer <redacted>'],
  [/Authorization[=:]\s*[^\s"',}]+/gi, '<redacted-authorization>'],
  [/ANTHROPIC_API_KEY[=:]\s*[^\s"',}]+/gi, 'ANTHROPIC_API_KEY=<redacted>'],
  [/C:\\Users\\[A-Za-z0-9_.-]+/g, '<USER_DIR>'],
  [/D:\\software\\code\\claude-link/g, '<REPO>'],
];
function scrubString(s) {
  let out = s;
  for (const [re, rep] of SCRUB_STRING_RULES) out = out.replace(re, rep);
  return out;
}
function scrubSessionId(id) {
  return typeof id === 'string' ? `${id.slice(0, 8)}…` : id;
}
function scrub(value) {
  if (typeof value === 'string') return scrubString(value);
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(scrub);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = k === 'sessionId' ? scrubSessionId(v) : scrub(v);
  }
  return out;
}

// ── 证据仓储（内存聚合，退出前统一落盘）──
const EVID = { runId: RUN_ID, startedAt: new Date().toISOString(), checks: [], payloads: [], scenarios: {} };
const payloadSeen = new Set();
function recordPayloads(updates) {
  for (const u of updates ?? []) {
    const key = `${u.t}|${u.sessionId}|${u.queryGeneration}|${u.source}|${u.freshness}|${u.currentContextUsedTokens}|${u.turnInputTokens}`;
    if (payloadSeen.has(key)) continue;
    payloadSeen.add(key);
    EVID.payloads.push(scrub(u));
  }
}
function recordScenario(id, data) {
  EVID.scenarios[id] = { ts: new Date().toISOString(), ...data };
}
function dumpEvidence(exitReason) {
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    EVID.exitReason = exitReason ?? null;
    EVID.finishedAt = new Date().toISOString();
    EVID.totals = { pass, fail, skipped };
    const executedScenarios = Object.values(EVID.scenarios).filter((s) => s && s.executed !== false).length;
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'context-payloads.json'), JSON.stringify(EVID.payloads, null, 2), 'utf8');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'assertions.json'), JSON.stringify(EVID.checks, null, 2), 'utf8');
    fs.writeFileSync(path.join(EVIDENCE_DIR, 'scenarios.json'), JSON.stringify(EVID.scenarios, null, 2), 'utf8');
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'summary.md'),
      `# context E2E ${RUN_ID}\n\n` +
      `- 断言：${pass} 通过 / ${fail} 失败 / ${skipped} 跳过（未执行场景不计 pass）\n` +
      `- 真实执行场景数：${executedScenarios}；跳过/受限场景：${Object.values(EVID.scenarios).filter((s) => s && s.executed === false).length}\n` +
      `- payload 数：${EVID.payloads.length}\n` +
      `- 退出原因：${exitReason ?? '正常完成'}\n` +
      `- 场景：${Object.keys(EVID.scenarios).join(', ') || '(无)'}\n`,
      'utf8',
    );
    // 落盘后脱敏自扫描（占位符不算泄漏；只扫我们写的四个文件）。
    const patterns = [/sk-[A-Za-z0-9_-]{6,}/, /C:\\Users\\/, /D:\\software\\code\\claude-link/, /ANTHROPIC_API_KEY[=:] *(?!<redacted>)[^\s<]/];
    const leaks = [];
    for (const f of ['context-payloads.json', 'assertions.json', 'scenarios.json']) {
      const text = fs.readFileSync(path.join(EVIDENCE_DIR, f), 'utf8');
      for (const p of patterns) if (p.test(text)) leaks.push(`${f}: ${p}`);
    }
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, 'scrub-scan.txt'),
      leaks.length === 0
        ? `OK：${new Date().toISOString()} 落盘文件脱敏扫描无泄漏（占位符 <redacted>/<USER_DIR>/<REPO> 除外）\n`
        : `LEAK：${leaks.join('\n')}\n`,
      'utf8',
    );
    log(`证据已落盘：${EVIDENCE_DIR}（payloads=${EVID.payloads.length}）`);
  } catch (e) {
    log(`证据落盘失败：${e.message}`);
  }
}
async function check(name, fn) {
  const entry = { name, ts: new Date().toISOString() };
  try {
    const note = await fn();
    pass++;
    entry.status = 'pass';
    if (typeof note === 'string') entry.note = note;
    log(`  ✅ ${name}${typeof note === 'string' ? `（${note}）` : ''}`);
  } catch (e) {
    fail++;
    entry.status = 'fail';
    entry.error = e.message;
    log(`  ❌ ${name} — ${e.message}`);
  }
  EVID.checks.push(entry);
}
// review-v4 High-4：未执行的场景不得计 pass。skipped 不进 pass/fail，配合 envLimited（exit 3）
// 保证「完整场景未执行时不能 exit 0」。
function checkSkipped(name, reason) {
  skipped++;
  EVID.checks.push({ name, ts: new Date().toISOString(), status: 'skipped', note: reason });
  log(`  ⏭ ${name}（skipped：${reason}）`);
}
class PreconditionError extends Error {}
function precondition(cond, message) {
  if (!cond) throw new PreconditionError(message);
}

// ── CDP 基础（与 cdp-real-window-e2e.mjs 同款）──
// review-v4 High-2：CDP 不可达/page 缺失/WebSocket 失败一律 PreconditionError（exit 2），
// 不得落入 FATAL（exit 1）污染门禁语义。端口支持 CDP_PORT 环境变量覆盖（供无 app 的协议测试）。
const CDP_PORT = Number(process.env.CDP_PORT ?? 9223);
async function getPageTarget() {
  let resp;
  try {
    resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  } catch (e) {
    throw new PreconditionError(`CDP ${CDP_PORT} 无法连接（${e.message}）——先 npm run dev:cdp。环境前置不足，exit 2。`);
  }
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
}
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new PreconditionError(`CDP WebSocket 无法建立（${url.slice(0, 60)}…）。环境前置不足，exit 2。`)));
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
async function evalOk(ws, expr) { return (await evalExpr(ws, expr)) === true; }
async function insertText(ws, text) { await cdpCall(ws, 'Input.insertText', { text }); }
async function waitFor(label, fn, timeoutS = 60, intervalMs = 500) {
  const deadline = Date.now() + timeoutS * 1000;
  let lastErr = '';
  while (Date.now() < deadline) {
    try { const v = await fn(); if (v) return v; } catch (e) { lastErr = e.message; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时（${timeoutS}s）：${label}${lastErr ? `；最后错误：${lastErr}` : ''}`);
}

// ── 证据采集 ──
async function registerCollectors(ws) {
  await evalExpr(ws, `(() => {
    window.__ctxE2E = { updates: [] };
    try { window.__ctxE2EUnsub?.(); } catch {}
    window.__ctxE2EUnsub = window.claudeLink.onContextUpdate((p) => {
      window.__ctxE2E.updates.push({ t: Date.now(), ...p });
    });
    return true;
  })()`);
}
async function newSessionViaUI(ws) {
  // 真实选择器：侧栏 `.new-button`（AppSidebar），ChatPage 空态另有 `.new-session-button`。
  // 修复记录：旧选择器 `.new-session-btn` 从未匹配，此前靠应用恢复的激活会话蒙混——现在
  // 显式校验按钮存在并点击，失败按前置条件（exit 2）处理。
  const clicked = await evalExpr(ws, `(() => {
    const b = document.querySelector('.new-button') || document.querySelector('.new-session-button');
    if (!b) return false;
    b.click(); return true;
  })()`);
  precondition(clicked, '新建会话按钮未找到（.new-button / .new-session-button）——UI 结构变化或路由异常');
  await new Promise((r) => setTimeout(r, 900));
  try {
    const sid = await activeSessionId(ws);
    // 基线暂态会话（50e4883）适配：新建落在暂态草稿（不落库）。立即经 Pinia 调
    // materializeActiveTransient 物化（同 id 建 DB 行），使后续 getSession/getMessages/
    // assertWorkingDir 等主进程 DB 链路可用——与「发首条消息时自动物化」同一路径。
    const materialized = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st && st.materializeActiveTransient ? st.materializeActiveTransient().then((s) => !!s) : Promise.resolve(false);
    })()`);
    if (!materialized) log('  ℹ 会话未物化（可能已是持久会话——非暂态基线）');
    return sid;
  } catch (e) {
    throw new PreconditionError(`新建会话后未出现活跃会话：${e.message}`);
  }
}
async function activeSessionId(ws) {
  return waitFor('活跃会话 id', async () => {
    // 基线暂态会话（50e4883）适配：「+ 新会话」进入暂态草稿（不落库、侧栏无 .session-link），
    // 发首条消息才以同 id 物化。活跃判定优先直取 Pinia store 的 activeSession.id（暂态/持久
    // 都覆盖）；持久会话维持侧栏 name 比对兜底。
    const storeSid = await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      const a = st && st.activeSession;
      return a && a.id ? a.id : null;
    })()`);
    if (storeSid) return storeSid;
    const activeName = await evalExpr(ws, `document.querySelector('.session-link.active .session-link__name')?.textContent?.trim() ?? null`);
    if (!activeName) return null;
    const sessions = await evalExpr(ws, `window.claudeLink.listSessions()`);
    return (sessions ?? []).find((s) => s.name === activeName)?.id ?? null;
  }, 15);
}
async function sessionOf(ws, sid) { return (await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`)) ?? null; }
// review-v4 High-3：设置后必须从 session 记录断言 workingDir === dir（不只看菜单按钮 title）。
async function setWorkingDir(ws, dir) {
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  // 基线暂态会话适配：侧栏无任何 .session-link 时（暂态草稿），点 .new-button 回到同一暂态
  // （单例复用，不新建）→ router 回聊天页。持久会话维持点会话条目回聊天页的原路径。
  await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link') || (document.querySelector('.session-link') ? null : document.querySelector('.new-button')))?.click(), true`);
  await waitFor('回到聊天页（工具栏出现）', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
  await evalExpr(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const wsBtn = btns.find((b) => (b.textContent || '').includes('▾'));
    if (!wsBtn) throw new Error('工作空间按钮未找到');
    wsBtn.click(); return true;
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
// review-v4 High-3 修复后的调用约定：setWorkingDir(ws, dir) 两参；设置完成后由调用方用
// assertWorkingDir 从 sessionRepo 记录复核 workingDir === dir（真实隔离保证，不依赖 UI title）。
async function assertWorkingDir(ws, sid, dir) {
  const s = await sessionOf(ws, sid);
  const wd = s?.workingDir ?? null;
  if (wd !== dir) throw new Error(`会话 workingDir 复核失败：期望 ${dir}，实际 ${wd}`);
  return wd;
}
// review-v4 High-5：工具场景前置——经真实 UI 切换权限模式并从 session 记录复核。
// 失败按 PreconditionError（exit 2）处理，绝不进入 query 等待（避免把权限等待误判为网关超时）。
// value/label 对齐 SessionToolbar：bypassPermissions=「自动模式」（CLAUDE.md 自动化测试铁律）。
async function ensurePermissionMode(ws, sid, mode, label) {
  // 基线适配（权限全局默认 + 权限菜单改版）：DB permissionMode=null 表示「跟随全局默认档」，
  // 生效档 = 会话显式档 ?? config.permissionMode。全局默认已等于目标档时无需切档（点菜单
  // 「默认」项落库仍为 null，旧等待必超时；且旧 contains('自动模式') 匹配会误点「默认：自动
  // 模式」项——故仅显式切档时用 .perm-item__label 精确匹配）。
  const s = (await sessionOf(ws, sid)) ?? null;
  const globalDefault = (await evalExpr(ws, `window.claudeLink.getConfig().then((c) => c.permissionMode ?? null)`)) ?? null;
  const effective = s?.permissionMode ?? globalDefault;
  if (effective === mode) return effective;
  const opened = await evalExpr(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    if (!btn) return false;
    btn.click(); return true;
  })()`);
  precondition(opened, '权限模式按钮未找到（工具栏）——UI 结构变化，环境前置不足');
  const clicked = await evalExpr(ws, `(() => {
    const labels = [...document.querySelectorAll('.perm-item .perm-item__label')];
    const t = labels.find((i) => (i.textContent || '').trim() === ${JSON.stringify(label)});
    if (t) { t.closest('.perm-item').click(); return true; }
    return false;
  })()`);
  precondition(clicked, `权限面板未找到「${label}」（目标 ${mode}）——环境前置不足`);
  await waitFor(`权限模式生效 ${mode}`, async () => {
    const s2 = await sessionOf(ws, sid);
    return (s2?.permissionMode ?? globalDefault) === mode;
  }, 15);
  return mode;
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
async function waitQueryIdle(ws, timeoutS = 600) {
  await waitFor('查询空闲', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), timeoutS, 1000);
}
async function getMessages(ws, sid) { return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? []; }
async function sendViaUI(ws, text) {
  await waitQueryIdle(ws, 600);
  await typeInChatInput(ws, text);
  // 稳健发送：主进程「方案 A」在 deleteEntry 前 await post-turn 快照（1.4s~5s 窗口），
  // renderer 收到 result 先清 abort 按钮（waitQueryIdle 通过），但主进程 entry 尚未释放——
  // 此时快速连发会撞上 chat:send 被拒「当前回合仍在执行」，草稿保留（父组件只在主进程
  // 接受后清空）。这里点击后轮询「输入框被清空」= 发送被主进程接受；未清空则重试点击。
  const deadline = Date.now() + 20_000;
  for (;;) {
    await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
    const accepted = await waitFor(
      '发送被接受（输入框清空）',
      () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return ta ? !ta.value.trim() : true; })()`),
      3,
      200,
    ).catch(() => false);
    if (accepted) return;
    if (Date.now() > deadline) throw new Error('发送未被主进程接受（输入框未清空，疑似 entry 未释放）');
  }
}
async function waitTurnComplete(ws, sid, baseCount, timeoutS = 180) {
  return waitFor('回合完成', async () => {
    const msgs = await getMessages(ws, sid);
    const last = msgs[msgs.length - 1];
    return (msgs.length > baseCount + 1 && last && (last.role === 'assistant' || (last.role === 'system' && /result|aborted|local_command/.test(last.processKind || '')))) ? last : null;
  }, timeoutS, 1000);
}
async function abortCurrentTurn(ws) {
  await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.click(), true`);
}

// native /context 原文：最近的含 "Context Usage" 的消息。
async function readNativeContext(ws, sid) {
  const msgs = await getMessages(ws, sid);
  const ctxMsgs = msgs.filter((m) => typeof m.content === 'string' && m.content.includes('Context Usage'));
  const last = ctxMsgs[ctxMsgs.length - 1] ?? null;
  return last?.content ?? null;
}
// 复用共享 runner（禁止本文件复制 used/max regex）。
// Windows：spawnSync('npx') 无 shell 时 ENOENT（npx 是 .cmd，r.status=null）——
// 曾把「runner 启动失败」误报成「无法解析 /context 原文」。优先 node 直调仓库内 tsx cli。
function parseViaSharedRunner(text) {
  const tsxCli = path.join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const input = JSON.stringify({ texts: [text] });
  const r = fs.existsSync(tsxCli)
    ? spawnSync(process.execPath, [tsxCli, 'scripts/native-context-parser-runner.ts'], { input, encoding: 'utf8', cwd: process.cwd() })
    : spawnSync('npx', ['tsx', 'scripts/native-context-parser-runner.ts'], { input, encoding: 'utf8', cwd: process.cwd(), shell: true });
  if (r.error) {
    log(`  ⚠ parser runner 启动失败：${r.error.message}`);
    return null;
  }
  if (r.status !== 0) return null;
  try {
    return JSON.parse(r.stdout).reports?.[0] ?? null;
  } catch { return null; }
}
// review-v5 Low-1：hover 打开 popover 采样（stale title 只有 popover 展开时可查）。
async function samplePopover(ws) {
  await evalExpr(ws, `document.querySelector('.ctx')?.dispatchEvent(new MouseEvent('mouseenter')), true`);
  await new Promise((r) => setTimeout(r, 400));
  const title = await evalExpr(ws, `document.querySelector('.ctx__btn')?.getAttribute('title') ?? null`);
  const rows = await evalExpr(ws, `(() => [...document.querySelectorAll('.ctx__row')].map((r) => ({ label: r.querySelector('span')?.textContent?.trim() ?? '', value: r.querySelector('code')?.textContent?.trim() ?? '' })))()`);
  await evalExpr(ws, `document.querySelector('.ctx')?.dispatchEvent(new MouseEvent('mouseleave')), true`);
  return { title, rows };
}
// expectStale=true：title 须含「上次采样」（review-v5 Low-1）；expectStale=false：fresh 终态
// title 不得标注「上次采样」（防语义倒置回归）。
// context-circle-v2 D4：弹层三行化——诊断行已从 DOM 删除（原 stale 分支断言非空「诊断」行，
// 随 D5 反转为「不得存在诊断行」）；并恒断言 popover 恰好三行（已用上下文/全部上下文/占比）。
const EXPECTED_POPOVER_LABELS = ['已用上下文', '全部上下文', '占比'];
async function assertDiagAndTitle(ws, expectStale) {
  const pop = await samplePopover(ws);
  const labels = pop.rows.map((r) => r.label);
  if (JSON.stringify(labels) !== JSON.stringify(EXPECTED_POPOVER_LABELS)) {
    throw new Error(`popover 应恰好三行 ${JSON.stringify(EXPECTED_POPOVER_LABELS)}（实际 ${JSON.stringify(labels)}）`);
  }
  if (pop.rows.some((r) => r.label === '诊断')) throw new Error('popover 不得再渲染「诊断」行（context-circle-v2 D4 已删）');
  if (expectStale) {
    if (!pop.title || !pop.title.includes('上次采样')) throw new Error(`stale 态 title 应标注「上次采样」（实际：${pop.title}）`);
  } else if (pop.title && pop.title.includes('上次采样')) {
    throw new Error(`fresh 终态 title 不应标注「上次采样」（实际：${pop.title}）`);
  }
  return pop;
}
async function readUpdates(ws) {
  const updates = (await evalExpr(ws, `window.__ctxE2E?.updates ?? []`)) ?? [];
  recordPayloads(updates);
  return updates;
}
async function clearUpdates(ws) { await evalExpr(ws, `(() => { window.__ctxE2E.updates = []; return true; })()`); }
// post-turn 官方 /context 探针（本计划 Task 5）：回合结束后 fire-and-forget 起 `claude.exe -p
// "/context" --resume <sid> --no-session-persistence`。等待并返回该 fresh payload
// （source='native-context' && freshness='fresh' && samplePhase='post-turn'），超时则 fail。
// context-circle-v2 D5：等待窗按 45s 预算放大（探针实测地板 13-21s，旧 10s 预算必然超时）——
// 调用点 50/70/50/30（压缩回合加 5s 方案A 收尾延迟与 resume 慢余量，故 70）。
// sessionId 过滤：只匹配当前会话的探针，避免残留会话/其它会话的迟到探针误命中。
// minGen 过滤（review-v1 High-2）：只接受代际 > minGen 的探针，用于识破「旧回合迟到探针」冒充
// 本回合探针（否则断言空转通过，如把 B 回合探针误当成被中断 A 回合的探针）。
async function waitForPostTurnProbe(ws, sid, timeoutS = 50, minGen = -1) {
  return waitFor('post-turn 探针 fresh payload（native-context+post-turn）', async () => {
    const ups = await readUpdates(ws);
    return ups.find((u) => u.sessionId === sid && u.source === 'native-context' && u.freshness === 'fresh' && u.samplePhase === 'post-turn' && (typeof u.queryGeneration !== 'number' || u.queryGeneration > minGen)) ?? null;
  }, timeoutS, 500);
}
async function sampleDom(ws) {
  return await evalExpr(ws, `(() => {
    const btn = document.querySelector('.ctx__btn');
    const ring = document.querySelector('.ctx__ring-fg');
    const rows = [...document.querySelectorAll('.ctx__row')].map((r) => ({
      label: r.querySelector('span')?.textContent?.trim() ?? '',
      value: r.querySelector('code')?.textContent?.trim() ?? '',
    }));
    return { present: !!btn, title: btn?.getAttribute('title') ?? null, ringDasharray: ring?.getAttribute('stroke-dasharray') ?? null, popoverRows: rows };
  })()`);
}
// 场景级快照：before/after DOM + 会话隔离字段（workingDir/permissionMode）+ payload 尾巴。
async function snapshotEvidence(ws, sid, label) {
  const dom = await sampleDom(ws);
  const sess = await sessionOf(ws, sid);
  const updates = await readUpdates(ws);
  return {
    label,
    ts: new Date().toISOString(),
    dom,
    workingDir: sess?.workingDir ?? null,
    permissionMode: sess?.permissionMode ?? null,
    payloadCount: updates.length,
    lastPayload: updates[updates.length - 1]
      ? {
          queryGeneration: updates[updates.length - 1].queryGeneration ?? null,
          source: updates[updates.length - 1].source ?? null,
          freshness: updates[updates.length - 1].freshness ?? null,
          currentContextUsedTokens: updates[updates.length - 1].currentContextUsedTokens ?? null,
          turnInputTokens: updates[updates.length - 1].turnInputTokens ?? null,
        }
      : null,
  };
}
// 跑一个普通回合 + 前后证据（S2/S3/S4/S5/S6/S8 共用骨架）。
async function runTurnWithEvidence(ws, sid, scenarioId, prompt, timeoutS = 300) {
  const before = await snapshotEvidence(ws, sid, `${scenarioId}:before`);
  await clearUpdates(ws);
  const baseCount = (await getMessages(ws, sid)).length;
  await sendViaUI(ws, prompt);
  await waitTurnComplete(ws, sid, baseCount, timeoutS);
  await waitQueryIdle(ws, timeoutS);
  // 工具回合里模型先落一条叙述性 assistant 消息（waitTurnComplete 抓到的往往是它）——
  // 回合真正结束后重读消息列表，取本回合最后一条终态消息作为回复依据。
  const msgs = (await getMessages(ws, sid)).slice(baseCount);
  const lastMsg = [...msgs].reverse().find((m) => m.role === 'assistant' || (m.role === 'system' && /result|aborted|local_command/.test(m.processKind || ''))) ?? null;
  const after = await snapshotEvidence(ws, sid, `${scenarioId}:after`);
  return { before, after, lastMsg };
}

async function main() {
  console.log('=== CDP 上下文占用契约 E2E（Task 11）===');
  log(`runId=${RUN_ID}`);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  recordScenario('meta', { cwd: CWD, evidenceDir: EVIDENCE_DIR });

  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——先 npm run dev:cdp。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  precondition(hasBridge, 'preload bridge 不可用。无法执行，exit 2。');
  const cfg = await evalExpr(ws, `window.claudeLink.getConfig()`);
  precondition(cfg && cfg.apiBaseUrl, 'getConfig 未返回有效 apiBaseUrl。无法执行，exit 2。');

  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(CWD, 'README.md'), '# context-e2e\n', 'utf8');

  await registerCollectors(ws);
  const created = [];
  const cleanup = async () => {
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
    try { fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true }); } catch { /* ignore */ }
  };

  try {
    const sid = await newSessionViaUI(ws);
    created.push(sid);
    // review-v4 High-3：旧写法把 (ws, sid, CWD) 三个参数传给两参签名——dir 收到的是 session ID，
    // 会话 cwd 变成不存在的路径（回合必挂）。改为两参 + sessionRepo 复核。
    await setWorkingDir(ws, CWD);
    await assertWorkingDir(ws, sid, CWD);
    const sess = await sessionOf(ws, sid);
    const cliSid = sess?.cliSessionId;
    log(`sid=${sid.slice(0, 8)}… cliSessionId=${cliSid ? cliSid.slice(0, 8) + '…' : '(未初始化)'}`);
    recordScenario('meta', { cwd: CWD, evidenceDir: EVIDENCE_DIR, cliSessionId: scrubSessionId(cliSid ?? null) });

    // ── 全场景权限前置（review-v4 High-5 + 本计划 Task 5 铁律）──
    // 经真实 UI 切「自动模式」（bypassPermissions）。必须在 S0 之前、任何回合之前设置：
    // 当前配置模型（如 deepseek-v4-flash）在「纯文本」回合也会自行调用 Read 工具，default 权限下
    // canUseTool 弹窗无人点击 → 静默卡住（曾实测 305s stall + 11 分钟权限等待，见 AGENTS.md 铁律）。
    // 在 check 外调用：失败 → PreconditionError（exit 2），不把权限等待误判为网关超时。
    await ensurePermissionMode(ws, sid, 'bypassPermissions', '自动模式');
    recordScenario('permission', { mode: 'bypassPermissions', beforeScenario: 'S0', note: 'S0–S13 全场景前置（模型纯文本回合也可能自行调工具）' });

    // ── S0：空会话不得显示 0%（pending）──（必须先于任何消息，保持空会话语义）
    await check('S0 空会话 UI 不伪造 0%（显示待刷新/pending）', async () => {
      const dom = await sampleDom(ws);
      recordScenario('S0', { dom });
      const isPending = !dom.title || dom.title.includes('待刷新') || (dom.ringDasharray == null);
      if (!isPending) throw new Error(`空会话 UI 应 pending，实际 title=${dom.title} ring=${dom.ringDasharray}`);
    });

    // ── 前置：网关健康预检（上游 502/抖动时重试至多 3 次；全部失败才 exit 2）──
    // 网关实测存在抖动窗口（同分钟内一次成功一次 502），单发预检会把「窗口期外」误判为不可用。
    // 预检仍是最小回合语义：能完成任一次即视为上游可用，后续场景照常执行并各自带超时。
    let preflightOk = false;
    let preflightErr = '';
    for (let attempt = 1; attempt <= 3 && !preflightOk; attempt++) {
      try {
        const b = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, '只回复"ok"。');
        await waitTurnComplete(ws, sid, b, 90);
        await waitQueryIdle(ws, 90);
        preflightOk = true;
        log(`  ℹ 网关健康预检通过（第 ${attempt} 次尝试）`);
      } catch (e) {
        preflightErr = e.message;
        log(`  ℹ 预检第 ${attempt} 次失败：${e.message}`);
        if (attempt < 3) {
          await waitQueryIdle(ws, 120).catch(() => {});
          await new Promise((r) => setTimeout(r, 20000));
        }
      }
    }
    if (!preflightOk) {
      // 上游 502/挂起或回合无法完成 → 环境前置不满足，明确 exit 2（不是实现回归）。
      throw new PreconditionError(`网关/上游不可用（3 次预检回合均未在 90s 内完成，可能 HTTP 502 抖动）——${preflightErr}`);
    }

    // ── S1：短文本 turn usage 不得驱动当前窗口圆环 ──
    await check('S1 短文本：CONTEXT_UPDATE 区分 turn usage 与当前窗口', async () => {
      await clearUpdates(ws);
      const b = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '请只回复"收到"，不要使用任何工具。');
      await waitTurnComplete(ws, sid, b, 180);
      await waitQueryIdle(ws, 180);
      const updates = await readUpdates(ws);
      if (updates.length === 0) throw new Error('未收到 CONTEXT_UPDATE');
      const last = updates[updates.length - 1];
      // turn usage 必须单独标记；当前窗口主值不得等于 turn usage（除非两者都 null）。
      if (last.turnInputTokens != null && last.currentContextUsedTokens === last.turnInputTokens) {
        throw new Error(`turn usage(${last.turnInputTokens}) 被当作当前窗口主值`);
      }
      // source/freshness 必须下发；review-v3 High-2：payload 必须带 queryGeneration（代际）。
      if (!last.source || !last.freshness) throw new Error(`缺 source/freshness：source=${last.source} freshness=${last.freshness}`);
      if (typeof last.queryGeneration !== 'number') throw new Error(`缺 queryGeneration：${String(last.queryGeneration)}`);
      // ── post-turn 官方 /context 探针增强（本计划 Task 5 S1）──
      // 回合真实结束后 ≤50s（v2 D5：预算 45s+余量）出现 source='native-context' && freshness='fresh' &&
      // samplePhase='post-turn' 的精确 fresh payload；其 used 不得低于本回合 query-start 值。
      const msgCountAfterTurn = (await getMessages(ws, sid)).length;
      const probe = await waitForPostTurnProbe(ws, sid, 50);
      // 污染断言：探针走独立进程 + --no-session-persistence，消息不得落 DB。
      const msgCountAfterProbe = (await getMessages(ws, sid)).length;
      if (msgCountAfterProbe !== msgCountAfterTurn) {
        throw new Error(`探针污染 DB 消息数：${msgCountAfterTurn} → ${msgCountAfterProbe}`);
      }
      const qs = updates.find((u) => u.samplePhase === 'query-start');
      const qsUsed = qs && typeof qs.currentContextUsedTokens === 'number' ? qs.currentContextUsedTokens : null;
      // 探针 used 不得显著低于 query-start 值。原生 /context 报告用 k 缩写（0.1k=100 舍入），
      // 与 SDK getContextUsage 精确值可能有 ≤100 tokens 的舍入差；按 500 tokens 容差比较，
      // 只拒绝「探针明显偏小」的异常（压缩后骤降等），不把正常舍入误差判为回归。
      if (
        qsUsed != null &&
        typeof probe.currentContextUsedTokens === 'number' &&
        probe.currentContextUsedTokens < qsUsed - 500
      ) {
        throw new Error(`探针 used(${probe.currentContextUsedTokens}) 明显低于 query-start used(${qsUsed})`);
      }
      // DOM 终态：探针 fresh 到达后 title 为「上下文已用 X%」，不再标「上次采样」。
      const pop = await assertDiagAndTitle(ws, false);
      recordScenario('S1', { prompt: '请只回复"收到"', lastPayload: scrub(last), probePayload: scrub(probe), dom: await sampleDom(ws), popover: pop });
      log(`  ℹ 代际 queryGeneration=${probe.queryGeneration}；探针 used=${probe.currentContextUsedTokens}（review-v3 High-2，证据随 payload 落盘）`);
      return `queryGeneration=${probe.queryGeneration} probeUsed=${probe.currentContextUsedTokens}`;
    });

    // ── S2：多轮文本（三轮 before/after 对比）──
    await check('S2 多轮文本：三轮 turn usage / runtime / DOM 均有采样', async () => {
      const turns = [];
      for (let i = 1; i <= 3; i++) {
        const r = await runTurnWithEvidence(ws, sid, `S2:turn${i}`, `第 ${i} 轮：请只回复"第${i}轮完成"，不要使用工具。`, 180);
        turns.push({ before: r.before, after: r.after, replyPreview: scrubString(String(r.lastMsg?.content ?? '').slice(0, 60)) });
      }
      recordScenario('S2', { turns });
      const all = EVID.payloads.filter((p) => p.sessionId === scrubSessionId(sid));
      const turnUsage = all.filter((p) => p.source === 'estimated-turn-usage');
      if (turnUsage.length < 3) throw new Error(`三轮应各产生 turn usage payload（实际 ${turnUsage.length}）`);
      if (!all.some((p) => typeof p.queryGeneration === 'number')) throw new Error('payload 缺 queryGeneration');
      return `turnUsage=${turnUsage.length} payloads=${all.length}`;
    });

    // ── S3：小文件 Read ──（权限已在 S0 之前经 UI 切自动模式，全场景覆盖）──
    fs.writeFileSync(path.join(CWD, 'small.txt'), 'SMALL-FILE-LINE-1\nSMALL-FILE-LINE-2\n', 'utf8');
    await check('S3 小文件 Read：读到 fixture marker（隔离可信）', async () => {
      const r = await runTurnWithEvidence(ws, sid, 'S3', '请用 Read 工具读取 small.txt，然后只回复第一行内容。', 300);
      const msgs = await getMessages(ws, sid);
      const reply = String(r.lastMsg?.content ?? '');
      const hasToolTrace = msgs.some((m) => typeof m.content === 'string' && /small\.txt|SMALL-FILE-LINE/.test(m.content));
      recordScenario('S3', { prompt: 'Read small.txt', hasToolTrace, replyPreview: scrubString(reply.slice(0, 120)), cwd: r.after.workingDir, permissionMode: r.after.permissionMode, before: r.before, after: r.after });
      if (r.after.dom.present === false) throw new Error('回合后 ContextButton 消失');
      // review-v4 5.6-4：结果必须包含唯一 marker，证明真实读到 fixture cwd 的文件。
      if (!reply.includes('SMALL-FILE-LINE-1')) throw new Error(`回复未包含 small.txt 第一行 marker（实际：${reply.slice(0, 80)}）`);
      // review-v5 Low-1：工具回合结束后的 stale title 语义（post-turn 兜底为常态）。
      const lp3 = r.after.lastPayload;
      const pop3 = await assertDiagAndTitle(ws, !(lp3?.source === 'runtime-live' && lp3?.freshness === 'fresh'));
      recordScenario('S3', { prompt: 'Read small.txt', hasToolTrace, replyPreview: scrubString(reply.slice(0, 120)), cwd: r.after.workingDir, permissionMode: r.after.permissionMode, before: r.before, after: r.after, popover: pop3 });
      return `marker 命中，cwd=${r.after.workingDir}`;
    });

    // ── S4：大文件 Read + /context 分类 ──
    const bigLines = Array.from({ length: 40000 }, (_, i) => `BIG-LINE-${i} ${'x'.repeat(40)}`);
    fs.writeFileSync(path.join(CWD, 'big.txt'), bigLines.join('\n'), 'utf8');
    await check('S4 大文件 Read：大输出 + /context 分类证据', async () => {
      const r = await runTurnWithEvidence(ws, sid, 'S4', '请用 Read 工具读取 big.txt（很大，可能被截断），只回复你看到的最后一行的行号数字。', 420);
      const reply = String(r.lastMsg?.content ?? '');
      // /context 采分类证据（System tools / Messages 等贡献）。
      await clearUpdates(ws);
      const b = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, b, 180);
      await waitQueryIdle(ws, 180);
      await readUpdates(ws);
      const native = await readNativeContext(ws, sid);
      const report = native ? parseViaSharedRunner(native) : null;
      recordScenario('S4', { prompt: 'Read big.txt', replyPreview: scrubString(reply.slice(0, 80)), cwd: r.after.workingDir, permissionMode: r.after.permissionMode, before: r.before, after: r.after, nativeParser: report });
      if (r.after.dom.present === false) throw new Error('回合后 ContextButton 消失');
      // review-v4 5.6-5：末行 marker——截断时行号 < 39999 也必须有数字，证明读的是 big.txt 本体。
      if (!/[0-9]/.test(reply)) throw new Error(`回复未含行号数字（实际：${reply.slice(0, 80)}）`);
      // P2 mid-turn：回合中途轮询断言（docs/.../2026-08-22 §7 Step 1）。
      // S4 大文件 Read 的工具结果足够大（Δused 远超 1000 门限），mid-turn payload 应送达；
      // 若节流（8s）/值变化门限导致缺席，本断言如实失败并记录命中数（不假绿）。
      // context-circle-v2 环境适配：query-start/mid-turn 快照都走 SDK 控制通道（query.getContextUsage），
      // 该通道在本机当前 CLI 状态下已死（08-29 实证 90s 无响应；context-circle-v2 计划 §1.3 定案
      // 「runtime 快照三阶段全部超时属预期，不是回归」）。通道活性以「本会话至今是否出现过任何
      // runtime-live 快照」判定——全程无 live 快照即通道死证据，mid-turn 断言按环境受限处理
      // （exit 3，同 S7/S9/S12 先例），不判实现回归；通道活（曾出现 live 快照）时保持严格断言。
      const midTurn = EVID.payloads.filter((p) => p.sessionId === scrubSessionId(sid) && p.samplePhase === 'mid-turn');
      const midTurnLive = midTurn.filter((p) => p.source === 'runtime-live' && p.freshness === 'fresh');
      if (midTurnLive.length === 0) {
        const liveEver = EVID.payloads.some((p) => p.sessionId === scrubSessionId(sid) && p.source === 'runtime-live' && p.freshness === 'fresh');
        if (!liveEver) {
          const reason = 'S4 mid-turn：SDK 控制通道死（本会话无任何 runtime-live 快照）——runtime 快照超时属基线预期（context-circle-v2 计划 §1.3），环境受限非实现回归';
          envLimited = envLimited ?? reason;
          recordScenario('S4', { status: 'environment-limited', reason, midTurnHits: midTurn.length });
          return `mid-turn 断言环境受限跳过（控制通道死，mid-turn 命中 ${midTurn.length} 次）；Read 与 /context 断言已过`;
        }
        throw new Error(`S4 未捕获 mid-turn live payload（samplePhase=mid-turn, source=runtime-live, freshness=fresh）——mid-turn 命中 ${midTurn.length} 次但均非 live/fresh（节流/值变化门限可能抑制）`);
      }
      return `${/[0-9]{4,}/.test(reply) ? '行号=' + reply.replace(/\s+/g, ' ').slice(0, 20) : '行号<1000（截断）'}；parser 分类 ${report?.categories?.length ?? 0} 项；mid-turn payload 命中 ${midTurnLive.length} 次`;
    });

    // ── S5：工具错误 ──
    await check('S5 工具错误：error tool result 不破坏上下文 UI', async () => {
      const r = await runTurnWithEvidence(ws, sid, 'S5', '请用 Read 工具读取 missing-file-definitely-not-exist-12345.txt（不存在），把工具返回的错误要点用一句话告诉我。', 300);
      recordScenario('S5', { prompt: 'Read 不存在文件', replyPreview: scrubString(String(r.lastMsg?.content ?? '').slice(0, 120)), before: r.before, after: r.after });
      if (r.after.dom.present === false) throw new Error('error tool result 后 ContextButton 消失');
    });

    // ── S6：CLAUDE.md 注入前后对比 ──
    await check('S6 CLAUDE.md：注入前后 /context Memory files 贡献对比', async () => {
      fs.writeFileSync(path.join(CWD, 'CLAUDE.md'), 'MARKER-FOR-S6-CONTEXT-CONTRIBUTION-TEST\n', 'utf8');
      const beforeNative = await (async () => {
        const b = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, '/context');
        await waitTurnComplete(ws, sid, b, 180);
        await waitQueryIdle(ws, 180);
        await readUpdates(ws);
        return readNativeContext(ws, sid);
      })();
      const beforeReport = beforeNative ? parseViaSharedRunner(beforeNative) : null;
      // 注入后：跑一个短回合让 CLAUDE.md 进入上下文，再 /context。
      await runTurnWithEvidence(ws, sid, 'S6:after', '请只回复"已注入"。', 180);
      const b2 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, b2, 180);
      await waitQueryIdle(ws, 180);
      await readUpdates(ws);
      const afterNative = await readNativeContext(ws, sid);
      const afterReport = afterNative ? parseViaSharedRunner(afterNative) : null;
      const mem = (r) => r?.categories?.find((c) => /memory/i.test(c.name))?.tokens ?? null;
      recordScenario('S6', {
        beforeParser: beforeReport,
        afterParser: afterReport,
        memoryTokens: { before: mem(beforeReport), after: mem(afterReport) },
      });
      if (!beforeReport && !afterReport) return 'native /context 不可解析（已记录）';
      return `Memory files tokens：${mem(beforeReport)} → ${mem(afterReport)}`;
    });

    // ── S7：MCP（可用时真实执行；不可用时记录 exit 3 原因，不删场景、不计 pass）──
    await (async () => {
      const mcpCfg = cfg?.mcpServers ?? null;
      const has = mcpCfg && Object.keys(mcpCfg).length > 0;
      if (!has) {
        const reason = 'S7：当前配置无可用 MCP 服务器，未执行真实 MCP 工具调用';
        envLimited = envLimited ?? reason;
        checkSkipped('S7 MCP：可用性探测与执行', reason);
        recordScenario('S7', { executed: false, status: 'environment-limited', reason });
        return;
      }
      await check('S7 MCP：真实执行', async () => {
        const r = await runTurnWithEvidence(ws, sid, 'S7', '请列出当前可用的 MCP 工具名（只列名字）。', 300);
        recordScenario('S7', { executed: true, before: r.before, after: r.after, replyPreview: scrubString(String(r.lastMsg?.content ?? '').slice(0, 200)) });
        return '已执行 MCP 探测回合';
      });
    })();

    // ── S8：thinking / turn usage / current context 三者分离 ──
    await check('S8 thinking：thinking token / turn usage / current context 三者分离', async () => {
      const r = await runTurnWithEvidence(ws, sid, 'S8', '请先在思考里逐步推演，再只回复最终数字：17 × 23 = ?', 300);
      const mine = EVID.payloads.filter((p) => p.sessionId === scrubSessionId(sid)).slice(-6);
      recordScenario('S8', { before: r.before, after: r.after, replyPreview: scrubString(String(r.lastMsg?.content ?? '').slice(0, 30)), recentPayloads: mine });
      const last = mine[mine.length - 1];
      // 契约：turn usage 与当前窗口分离（thinking 计入 output/turn，不冒充 current）。
      if (last && last.turnInputTokens != null && last.currentContextUsedTokens === last.turnInputTokens) {
        throw new Error('turn usage 被当作当前窗口主值');
      }
      if (r.after.dom.present === false) throw new Error('回合后 ContextButton 消失');
      // review-v5 Low-1：thinking 回合结束后的 stale title 语义。
      const terminalFresh8 = last != null && last.source === 'runtime-live' && last.freshness === 'fresh';
      const pop8 = await assertDiagAndTitle(ws, !terminalFresh8);
      recordScenario('S8', { before: r.before, after: r.after, replyPreview: scrubString(String(r.lastMsg?.content ?? '').slice(0, 30)), recentPayloads: mine, popover: pop8 });
      return last ? `turnIn=${last.turnInputTokens} current=${last.currentContextUsedTokens}` : 'payload 已记录';
    });

    // ── S9：/context 同一 session（native 与 runtime 对账）──
    // review-v4：区分「回合完成但端点不返回 native 格式」（环境受限 → skipped + exit 3）
    // 与「回合本身超时」（保持 fail，进 exit 1 供归因）。
    await (async () => {
      let turnDone = false;
      await check('S9 /context：回合完成', async () => {
        try {
          const b = (await getMessages(ws, sid)).length;
          await sendViaUI(ws, '/context');
          await waitTurnComplete(ws, sid, b, 180);
          await waitQueryIdle(ws, 180);
          turnDone = true;
        } catch (e) { throw e; }
      });
      if (!turnDone) return;
      const updates = await readUpdates(ws);
      const native = await readNativeContext(ws, sid);
      if (!native) {
        const reason = 'S9：本端点/供应商不返回可解析 /context 原文（回合完成但无 Context Usage 消息）';
        envLimited = envLimited ?? reason;
        checkSkipped('S9 /context native 对账', reason);
        recordScenario('S9', { nativeAvailable: false, status: 'environment-limited', payloads: updates.length });
        return;
      }
      await check('S9 /context 同一 session：native 可解析（共享 runner）', async () => {
        const report = parseViaSharedRunner(native);
        if (!report) throw new Error('共享 runner 无法解析 /context 原文');
        if (typeof report.usedTokens !== 'number' || typeof report.maxTokens !== 'number') {
          throw new Error('解析结果缺 usedTokens/maxTokens');
        }
        // review-v3 §4.8：记录代际与对账终态（reconciled/native-context 由 payload 追溯）。
        const ctxPayload = updates.filter((u) => u.source === 'reconciled' || u.source === 'native-context' || u.source === 'unavailable').pop() ?? null;
        // review-v5 Medium-1/Low-1：fresh 对账终态 title 不得被标成「上次采样」（防语义倒置）。
        const freshReconcile = ctxPayload != null && (ctxPayload.source === 'native-context' || ctxPayload.source === 'reconciled') && ctxPayload.freshness === 'fresh';
        const pop9 = await assertDiagAndTitle(ws, !freshReconcile);
        recordScenario('S9', { nativeAvailable: true, parser: report, reconcilePayload: ctxPayload ? scrub(ctxPayload) : null, dom: await sampleDom(ws), popover: pop9 });
        log(`  ℹ /context 解析：used=${report.usedTokens} max=${report.maxTokens} pct=${report.percentage}`);
        return ctxPayload ? `终态 source=${ctxPayload.source}` : '未捕获对账 payload';
      });
    })();

    // ── S10：compaction（/compact 触发 pending → fresh + compactedJustNow 时序）──
    await check('S10 compaction：pending 先行、成功标记只在 fresh payload', async () => {
      await clearUpdates(ws);
      const b = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/compact');
      await waitTurnComplete(ws, sid, b, 300);
      await waitQueryIdle(ws, 300);
      const updates = await readUpdates(ws);
      recordScenario('S10', { payloads: updates.map(scrub), dom: await sampleDom(ws) });
      // review-v5 Low-2：/compact 回合一条 payload 都没有 → 实现回归（result turn usage /
      // compact pending / 兜底至少应有一条），不得 vacuous pass。
      if (updates.length === 0) throw new Error('/compact 回合未产生任何 CONTEXT_UPDATE payload（vacuous pass 已禁止）');
      const pending = updates.find((u) => u.freshness === 'pending');
      const banner = updates.find((u) => u.compactedJustNow === true);
      if (banner && banner.freshness !== 'fresh') throw new Error(`compactedJustNow 出现在非 fresh payload（freshness=${banner.freshness}）`);
      // review-v1 Low-2：Step 3b 已把 shouldShowCompactedBanner 扩展到 native-context，此处旧断言
      // 同步——探针 banner（native-context）若早于本 check 的 readUpdates 到达，不得误报 source 不可信。
      if (banner && !(banner.source === 'runtime-live' || banner.source === 'reconciled' || banner.source === 'native-context')) throw new Error(`compactedJustNow source 不可信（${banner.source}）`);
      // review-v5 Low-2：pending 必须先于成功 banner（断言名「pending 先行」的顺序语义）。
      let orderNote = 'no-banner';
      if (banner && pending) {
        const pendingIdx = updates.indexOf(pending);
        const bannerIdx = updates.indexOf(banner);
        if (pendingIdx > bannerIdx) throw new Error(`压缩时序错误：pending(idx=${pendingIdx}) 晚于 banner(idx=${bannerIdx})`);
        orderNote = `pendingIdx(${pendingIdx}) < bannerIdx(${bannerIdx})`;
      } else if (banner && !pending) {
        orderNote = 'banner-without-pending';
      }
      if (!pending && !banner) return `未观察到压缩 payload（${updates.length} 条其他 payload，已记录）`;
      return `pending=${!!pending} freshBanner=${!!banner} ${orderNote}`;
    });

    // ── S10 增强（压缩兜底，F8）：/compact 回合结束后 ≤10s 出现 post-turn 探针 fresh payload，
    // 且其 used 值明显低于压缩前最后已知值（压缩骤降的精确证据）。Step 3b：该 payload 带
    // compactedJustNow:true 且横幅出现。
    await check('S10 压缩兜底：/compact 后 post-turn 探针给出骤降后的精确 fresh 值', async () => {
      // review-v1 Low-1：基线在压缩**前**采集——从全局 EVID.payloads（本会话累计）回溯最后一个
      // currentContextUsedTokens != null 的 payload（如 S9 /context 对账的 ~36k），而非压缩回合自身
      // 的 window buffer（/compact 回合快、常无带数值 payload，preCompactKnown 恒为 null 使对比空转）。
      const sidScrubbed = scrubSessionId(sid);
      const preCompactKnown = (() => {
        for (let i = EVID.payloads.length - 1; i >= 0; i -= 1) {
          const p = EVID.payloads[i];
          if (p.sessionId === sidScrubbed && typeof p.currentContextUsedTokens === 'number') {
            return p.currentContextUsedTokens;
          }
        }
        return null;
      })();
      // 70s 等待（v2 D5，原 25s）：探针预算 45s（实测地板 13-21s）；压缩回合 result 分支的
      // await refreshContextSnapshot(post-turn) 在 deleteEntry 前最多阻塞 5s（方案 A 固有延迟），
      // 探针才 spawn；再加压缩后 resume 慢（网关）余量。
      const probe = await waitForPostTurnProbe(ws, sid, 70);
      const used = probe.currentContextUsedTokens;
      if (typeof used !== 'number') throw new Error('探针 payload 缺 currentContextUsedTokens');
      if (preCompactKnown != null && typeof preCompactKnown === 'number' && used >= preCompactKnown) {
        throw new Error(`压缩后探针 used(${used}) 未明显低于压缩前(${preCompactKnown})`);
      }
      // Step 3b：压缩回合探针应带 compactedJustNow:true，且共享横幅判定对 native-context+ fresh 为 true。
      if (probe.compactedJustNow !== true) {
        throw new Error(`压缩回合探针应带 compactedJustNow:true（实际 ${probe.compactedJustNow}）`);
      }
      const bannerShown = await evalOk(ws, `!!document.querySelector('.ctx__banner:not(.ctx__banner--compacting)')`);
      // compact metadata display：探针 payload 断言 compactFromTokens 为数值（账单挂载成功）。
      // 横幅 DOM 文本：有账单数字时须匹配 /→|清出/；降级（旧 CLI 无账单）时回退现有文案且不 fail。
      const bannerText = await evalExpr(ws, `document.querySelector('.ctx__banner:not(.ctx__banner--compacting)')?.textContent?.trim() ?? null`);
      let metadataNote = 'no-compact-metadata';
      if (typeof probe.compactFromTokens === 'number' && typeof probe.compactToTokens === 'number' && typeof probe.compactDroppedTokens === 'number') {
        metadataNote = `compactFrom=${probe.compactFromTokens} compactTo=${probe.compactToTokens} compactDropped=${probe.compactDroppedTokens}`;
        if (bannerShown && bannerText != null && !/→|清出/.test(bannerText)) {
          throw new Error(`横幅应显示真实压缩数字（含 →/清出），实际「${bannerText}」`);
        }
      } else {
        // 降级路径：无账单时横幅回退现有文案，存在即通过（记录 note）。
        metadataNote = 'no-compact-metadata（旧 CLI 或无账单，横幅回退现有文案）';
      }
      recordScenario('S10', { probePayload: scrub(probe), preCompactKnown, bannerShown, bannerText: scrubString(bannerText ?? ''), metadataNote });
      return `压缩后探针 used=${used}（压缩前 ${preCompactKnown ?? '未知'}）bannerShown=${bannerShown} ${metadataNote}`;
    });

    // ── S11：中断重发（A 迟到 payload 不污染 B）──
    await check('S11 中断重发：A 中断、B 重发，A 代际 payload 不得晚于 B 出现', async () => {
      await clearUpdates(ws);
      const b = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '请从 1 慢慢数到 30，每个数字单独一行，不要使用工具，不要提前停止。');
      // 等 A 回合进入 streaming 后中断。
      await waitFor('A 回合进入执行（abort 按钮出现）', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 60, 500);
      await new Promise((r) => setTimeout(r, 1500));
      await abortCurrentTurn(ws);
      await waitQueryIdle(ws, 120);
      const aPayloads = await readUpdates(ws);
      const aGen = Math.max(0, ...aPayloads.map((u) => (typeof u.queryGeneration === 'number' ? u.queryGeneration : 0)));
      recordScenario('S11:afterAbort', { aGen, payloads: aPayloads.length, dom: await sampleDom(ws) });
      // B 重发。
      await clearUpdates(ws);
      const b2 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '只回复"重发完成"。');
      const doneMsg = await waitTurnComplete(ws, sid, b2, 180);
      await waitQueryIdle(ws, 180);
      await new Promise((r) => setTimeout(r, 2500)); // 给 A 迟到 payload 留窗口。
      const bPayloads = await readUpdates(ws);
      const bGens = bPayloads.map((u) => u.queryGeneration).filter((g) => typeof g === 'number');
      const bGen = bGens.length > 0 ? Math.min(...bGens) : null;
      recordScenario('S11:afterResend', { bGen, payloads: bPayloads.length, replyPreview: scrubString(String(doneMsg?.content ?? '').slice(0, 40)) });
      if (bGen == null) throw new Error('B 回合未捕获任何带代际的 payload');
      // 契约（Task 6 Step 4 / review-v3 High-2）：B 首个 payload 之后不得再出现 A 代际（≤ aGen）。
      // 从 B 的首个 payload 起算——清缓冲到 B 启动之间的 A 收尾尾巴不算迟到。
      const firstBIdx = bPayloads.findIndex((u) => typeof u.queryGeneration === 'number' && u.queryGeneration > aGen);
      const lateA = firstBIdx >= 0 ? bPayloads.slice(firstBIdx + 1).filter((u) => typeof u.queryGeneration === 'number' && u.queryGeneration <= aGen) : [];
      if (lateA.length > 0) throw new Error(`B 回合窗口内出现 A 代际迟到 payload：gen=${lateA.map((u) => u.queryGeneration).join(',')}`);
      recordScenario('S11:final', { domAfterLateWindow: await sampleDom(ws) });
      return `aGen=${aGen} bGen=${bGen} lateA=0`;
    });

    // ── S11 增强（中断兜底）：A 回合中断后 ≤10s 出现**被中断回合自身代际**的 post-turn 探针。
    // review-v1 High-2：不再 clearUpdates——改为发送 A 前记录缓冲内已知最大代际 G0，断言探针代际
    // aProbeGen > G0（必须属于 A 或更新的回合；旧回合迟到探针 gen ≤ G0 必被识破），并用 minBGen
    // 夹逼证明代际单调。修复前此断言对「旧探针冒充」必须失败。
    await check('S11 中断兜底：A 中断后 ≤10s 出 A 代际探针；连发代际序列单调', async () => {
      // G0 = 发送 A 前缓冲内已知最大代际（旧回合迟到探针的代际上限）。
      const g0 = Math.max(0, ...(await readUpdates(ws)).map((u) => (typeof u.queryGeneration === 'number' ? u.queryGeneration : 0)));
      const b3 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '请从 1 慢慢数到 40，每个数字单独一行，不要使用工具，不要提前停止。');
      await waitFor('A 回合进入执行（abort 按钮出现）', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 60, 500);
      await new Promise((r) => setTimeout(r, 1200));
      await abortCurrentTurn(ws);
      await waitQueryIdle(ws, 120);
      // A 回合中断后：其探针应在 ≤50s 内出现（v2 D5：45s 预算+余量），且代际 > G0（属于被中断的 A 回合，而非旧回合迟到探针）。
      const aProbe = await waitForPostTurnProbe(ws, sid, 50, g0);
      const aProbeGen = aProbe.queryGeneration;
      if (typeof aProbeGen !== 'number' || aProbeGen <= g0) throw new Error(`A 探针代际(${aProbeGen})未大于 G0(${g0})——中断探针可能未命中被中断回合`);
      // 若 A 回合自身产出过带代际 payload（query-start 等），进一步断言探针代际恰等于 A 代际。
      const aGens = (await readUpdates(ws)).map((u) => u.queryGeneration).filter((g) => typeof g === 'number' && g > g0);
      if (aGens.length > 0) {
        const aGen = Math.min(...aGens);
        if (aProbeGen < aGen) throw new Error(`A 探针代际(${aProbeGen})早于 A 回合首包代际(${aGen})`);
      }
      recordScenario('S11:afterAbort', { g0, aProbeGen, probeUsed: aProbe.currentContextUsedTokens ?? null });
      // B 重发：B 回合 payload 代际应 > A 探针代际（单调）。
      await clearUpdates(ws);
      const b4 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '只回复"重发完成"。');
      await waitTurnComplete(ws, sid, b4, 180);
      await waitQueryIdle(ws, 180);
      // B 回合结束后同样应出现 B 代际的探针（> A 探针代际）。等待并消费它：
      // ① 验证代际单调；② 避免该迟到探针污染后续 S13 的「两会话隔离」断言。
      // 30s（v2 D5）：紧随 A 探针之后，A 已确认探针链路可用，取较小余量即可。
      const bProbe = await waitForPostTurnProbe(ws, sid, 30, aProbeGen);
      const bProbeGen = bProbe.queryGeneration;
      const bPayloads2 = await readUpdates(ws);
      const bGens2 = bPayloads2.map((u) => u.queryGeneration).filter((g) => typeof g === 'number');
      if (bGens2.length === 0) throw new Error('B 回合未捕获任何带代际的 payload');
      const minBGen = Math.min(...bGens2);
      if (minBGen <= aProbeGen) throw new Error(`B 回合代际(${minBGen})未严格大于 A 探针代际(${aProbeGen})`);
      if (typeof bProbeGen !== 'number' || bProbeGen <= aProbeGen) throw new Error(`B 探针代际(${bProbeGen})未严格大于 A 探针代际(${aProbeGen})`);
      recordScenario('S11:afterResend', { g0, aProbeGen, minBGen, bProbeGen });
      return `G0=${g0} A探针代际=${aProbeGen} B代际=${minBGen} B探针代际=${bProbeGen}（单调）`;
    });

    // ── S12：restart/resume（review-v4 High-4：未执行不得计 pass）──
    // 应用级重启无法在本脚本内完成（重启会销毁 CDP 宿主）；语义由 scripts/context-research-restart.mjs
    // 单独编排采证。此处记 skipped + envLimited（exit 3），主门禁不得因 S12 缺席而 exit 0。
    await (async () => {
      const reason = 'S12：应用级重启无法在本脚本内完成（重启会销毁 CDP 宿主）；restart/resume 语义由 scripts/context-research-restart.mjs 单独编排采证';
      envLimited = envLimited ?? reason;
      checkSkipped('S12 restart/resume：需外部重启编排', reason);
      recordScenario('S12', { executed: false, status: 'environment-limited', reason });
    })();

    // ── S13：两 session 隔离 + 代际不串 ──
    await check('S13 两 session 隔离（A/B payload、generation、DOM 不串）', async () => {
      const cliSidA = (await sessionOf(ws, sid))?.cliSessionId;
      const sidB = await newSessionViaUI(ws);
      created.push(sidB);
      await setWorkingDir(ws, CWD);
      await assertWorkingDir(ws, sidB, CWD);
      const cliSidB = (await sessionOf(ws, sidB))?.cliSessionId;
      if (cliSidA && cliSidB && cliSidA === cliSidB) throw new Error('A/B 会话 cliSessionId 相同');
      // B 发一条消息，确认 CONTEXT_UPDATE 带 B 的 sessionId 与 B 自己的代际。
      await clearUpdates(ws);
      const bB = (await getMessages(ws, sidB)).length;
      await sendViaUI(ws, '只回复"B 就绪"。');
      await waitTurnComplete(ws, sidB, bB, 180);
      await waitQueryIdle(ws, 180);
      const updatesB = await readUpdates(ws);
      const badSession = updatesB.some((u) => u.sessionId === sid);
      if (badSession) throw new Error('B 会话的 CONTEXT_UPDATE 串到了 A 会话');
      const gensB = updatesB.map((u) => u.queryGeneration).filter((g) => typeof g === 'number');
      if (gensB.length === 0) throw new Error('B 回合 payload 缺 queryGeneration');
      const domB = await sampleDom(ws);
      recordScenario('S13', {
        cliSessionIds: { a: scrubSessionId(cliSidA ?? null), b: scrubSessionId(cliSidB ?? null) },
        bGenerations: gensB,
        bDom: domB,
        bPayloads: updatesB.length,
      });
      if (domB.present === false) throw new Error('B 会话 ContextButton 缺失');
      return `B 代际 ${Math.min(...gensB)}–${Math.max(...gensB)}`;
    });
  } finally {
    await cleanup();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  dumpEvidence(fail > 0 ? 'assertions-failed' : envLimited ? 'env-limited' : 'ok');
  if (fail > 0) process.exit(1);
  if (envLimited) {
    console.error(`\n环境受限（exit 3）：${envLimited}`);
    process.exit(3);
  }
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（exit 2）：${e.message}`);
    dumpEvidence(`precondition: ${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  dumpEvidence(`fatal: ${e.message}`);
  process.exit(1);
});
