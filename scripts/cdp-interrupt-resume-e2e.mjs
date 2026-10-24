// scripts/cdp-interrupt-resume-e2e.mjs
// S6（2026-10-22 计划 §4.2）：P3「thinking 中断后立即发新消息能否接住」E2E——验证优先、条件修复。
//
// 疑点 A（计划 §4.1）：user 中断即时硬杀（TerminateProcess）可能把进行中的 thinking 轮撕成残缺
// transcript，紧接的新回合 resume 同一 cliSessionId 时被上游 400 拒收（机制注释见
// sdk-backend.ts 两段式中止块；实测记录当时场景是 watchdog 而非 user）。本脚本连跑 5 轮：
//   建会话（自动模式 + 高思考档）→ 发长 thinking prompt → 等 thinking_delta 流式出现 →
//   点中断（真实长按）→ 立即（<1s）发送第二条 prompt → 断言接住。
//
// 每轮断言：
//   ① 第二条回合收到 result（is_error 非真，成功终态）；
//   ② 全程无 error 事件 / 无「SDK 执行出错」/ api_retry 终态系统消息；
//   ③ 中断后 DB 落 system:aborted 恰一条；
//   ④ sending 复位及时（中断后 ≤3s abort 按钮消失）；
//   ⑤ transcript 无撕裂：中断瞬间快照（--file）与回合结束后正本（--session）分别过
//      scripts/diagnose-interrupt-transcript.mjs，退出码均为 0（1=读取失败同样不算完整）。
// 复现判定（计划 §4.2）：任一轮出现 ②类失败，或 diagnose 退出码非 0 → 疑点 A 成立。
//
// 运行前提（同 cdp-context-e2e.mjs）：真实供应商 + Claude CLI 在位 + `npm run dev:cdp` 起的
// Electron（CDP 9223）。会话权限模式由脚本经真实 UI 切「自动模式」（bypassPermissions，
// 仓库 AGENTS.md 自动化测试铁律）。门控沿用 run-native-if-env 思路：默认不跑、不进 selftest。
//
// 用法与退出协议：
//   CLAUDE_LINK_RUN_INTERRUPT_E2E=1 node scripts/cdp-interrupt-resume-e2e.mjs
//   退出码 0 = 所执行轮次全部通过（5/5）
//   退出码 1 = 存在断言失败轮（含疑点 A 复现证据轮）
//   退出码 2 = 环境前置不足（未设门控 env 时静默 exit 0——非「未实测失败」，是未请求）
//   证据落盘：<CLAUDE_LINK_CACHE_ROOT ?? D:/software/Cache/claude-link>/interrupt-e2e/<runId>/

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROUNDS = Number(process.env.INTERRUPT_E2E_ROUNDS ?? 5);
// F6（2026-10-24 脱敏跟进）：缓存根可经 CLAUDE_LINK_CACHE_ROOT 覆盖；未设时默认值不变（行为零变化）。
const CACHE_ROOT = process.env.CLAUDE_LINK_CACHE_ROOT ?? 'D:/software/Cache/claude-link';
const E2E_ROOT = `${CACHE_ROOT}/e2e`;
const RUN_ID = `irq-${Date.now()}`;
const FIXTURE_ROOT = path.join(E2E_ROOT, RUN_ID);
const CWD = path.join(FIXTURE_ROOT, 'cwd').replace(/\\/g, '/');
const EVIDENCE_DIR = path.join(`${CACHE_ROOT}/interrupt-e2e`, RUN_ID);
const PROJECTS_ROOT = path.join(os.homedir(), '.claude', 'projects');

// 长 thinking prompt（不依赖工具；思考档由会话 thinkingLevel='high' 驱动）。
const PROMPT_A = '请深度分析「家用冰箱制冷循环的完整热力学过程」：先逐步思考，把每个环节的能量转换与工质状态变化完整推理展开（至少 15 个推理步骤），思考完成后用不超过 5 句话总结。不要使用任何工具，不要读取文件。';
const PROMPT_B = '只回复四个字：续发成功。';

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

// ── 门控（run-native-if-env 思路）：未显式请求时不跑、不算失败 ──
if (process.env.CLAUDE_LINK_RUN_INTERRUPT_E2E !== '1') {
  console.log('[gated] CLAUDE_LINK_RUN_INTERRUPT_E2E 未设为 1——本 E2E 需真实供应商与 dev:cdp 环境，默认跳过（exit 0）。');
  process.exit(0);
}

class PreconditionError extends Error {}
function precondition(cond, message) {
  if (!cond) throw new PreconditionError(message);
}

// ── CDP 基础（与 cdp-context-e2e.mjs 同款）──
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
    ws.addEventListener('error', () => reject(new PreconditionError(`CDP WebSocket 无法建立。环境前置不足，exit 2。`)));
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

// ── UI 操作（真实选择器，抄 cdp-context-e2e.mjs）──
async function activeSessionId(ws) {
  return waitFor('活跃会话 id', async () => {
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
async function newSessionViaUI(ws) {
  const clicked = await evalExpr(ws, `(() => {
    const b = document.querySelector('.new-button') || document.querySelector('.new-session-button');
    if (!b) return false;
    b.click(); return true;
  })()`);
  precondition(clicked, '新建会话按钮未找到（.new-button / .new-session-button）——UI 结构变化或路由异常');
  await new Promise((r) => setTimeout(r, 900));
  try {
    const sid = await activeSessionId(ws);
    // 基线暂态会话适配：立即物化（同 cdp-context-e2e.mjs），使 DB 链路可用。
    await evalExpr(ws, `(() => {
      const app = document.querySelector('#app');
      const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
      const st = pinia && pinia._s ? pinia._s.get('session') : null;
      return st && st.materializeActiveTransient ? st.materializeActiveTransient().then((s) => !!s) : Promise.resolve(false);
    })()`);
    return sid;
  } catch (e) {
    throw new PreconditionError(`新建会话后未出现活跃会话：${e.message}`);
  }
}
async function sessionOf(ws, sid) { return (await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`)) ?? null; }
async function setWorkingDir(ws, dir) {
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
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
// 自动权限模式（仓库 AGENTS.md 铁律）：经真实 UI 切换并从 session 记录复核；失败按前置不足（exit 2）。
async function ensurePermissionMode(ws, sid, mode, label) {
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
async function waitQueryIdle(ws, timeoutS = 240) {
  await waitFor('查询空闲（abort 按钮消失）', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), timeoutS, 500);
}
async function getMessages(ws, sid) { return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? []; }
async function sendViaUI(ws, text) {
  await waitQueryIdle(ws, 240);
  await typeInChatInput(ws, text);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
  await waitFor('发送被接受（输入框清空）', () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return ta ? !ta.value.trim() : true; })()`), 20, 200);
}
// 中断按钮改长按 1 秒（问题⑥）：模拟真实长按 pointerdown → 1.2s → pointerup；窗口须可见。
async function abortCurrentTurn(ws) {
  await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
  await new Promise((r) => setTimeout(r, 1200));
  await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerId: 1, button: 0 })), true`);
}

// ── 事件采集器（onChatEvent 摘要入缓冲）──
async function resetCollector(ws) {
  await evalExpr(ws, `(() => {
    window.__irqE2E = { events: [] };
    try { window.__irqE2EUnsub?.(); } catch {}
    window.__irqE2EUnsub = window.claudeLink.onChatEvent((p) => {
      try {
        const e = p && p.event ? p.event : {};
        let kind = e.type || 'unknown', sub = e.subtype ?? null, extra = null;
        if (e.type === 'stream_event') {
          kind = 'stream_delta';
          sub = e.event && e.event.delta ? e.event.delta.type : (e.event && e.event.type) || null;
        } else if (e.type === 'result') {
          extra = { isError: e.is_error ?? null, resultHead: String(e.result || '').slice(0, 40) };
        } else if (e.type === 'error') {
          extra = { message: String(e.message || '').slice(0, 160) };
        } else if (e.type === 'aborted') {
          extra = { message: String(e.message || '').slice(0, 60) };
        } else if (e.type === 'system') {
          sub = e.subtype ?? null;
        }
        window.__irqE2E.events.push({ t: Date.now(), sid: p ? p.sessionId : null, kind, sub, extra });
      } catch {}
    });
    return true;
  })()`);
}
async function readEvents(ws) { return (await evalExpr(ws, `window.__irqE2E ? window.__irqE2E.events : []`)) ?? []; }
const eventsOf = (events, sid) => events.filter((e) => e.sid === sid);

// ── transcript 定位与快照 ──
function collectJsonlFiles(root) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}
function locateTranscript(cliSid) {
  const hit = collectJsonlFiles(PROJECTS_ROOT).find((f) => path.basename(f) === `${cliSid}.jsonl`);
  return hit ?? null;
}
function runDiagnose(cliSid, snapshotPath) {
  const out = { snapshot: null, live: null };
  if (snapshotPath && fs.existsSync(snapshotPath)) {
    const r = spawnSync(process.execPath, ['scripts/diagnose-interrupt-transcript.mjs', '--file', snapshotPath], { encoding: 'utf8', cwd: process.cwd(), timeout: 60000 });
    out.snapshot = { code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  if (cliSid) {
    const r = spawnSync(process.execPath, ['scripts/diagnose-interrupt-transcript.mjs', '--session', cliSid], { encoding: 'utf8', cwd: process.cwd(), timeout: 60000 });
    out.live = { code: r.status, output: (r.stdout || '') + (r.stderr || '') };
  }
  return out;
}

// ── 主流程 ──
async function main() {
  console.log('=== P3 thinking 中断-立即续发 E2E（S6 阶段一验证）===');
  log(`runId=${RUN_ID} rounds=${ROUNDS}`);
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.mkdirSync(CWD, { recursive: true });
  fs.writeFileSync(path.join(CWD, 'README.md'), '# interrupt-resume-e2e\n', 'utf8');

  // 环境前置：CDP / bridge / 真实供应商（apiBaseUrl 非空）。
  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——先 npm run dev:cdp。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  precondition(hasBridge, 'preload bridge 不可用。无法执行，exit 2。');
  const cfg = await evalExpr(ws, `window.claudeLink.getConfig()`);
  precondition(cfg && cfg.apiBaseUrl, 'getConfig 未返回有效 apiBaseUrl（无真实供应商配置）。无法执行，exit 2。');
  log(`apiBaseUrl 已配置（真实供应商前置满足）；全局默认权限=${cfg.permissionMode ?? 'null'}`);

  const created = [];
  const rounds = [];
  const cleanup = async () => {
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
  };

  try {
    await resetCollector(ws);

    for (let i = 1; i <= ROUNDS; i++) {
      const round = { round: i, startedAt: new Date().toISOString(), checks: {} };
      console.log(`\n────────── 第 ${i}/${ROUNDS} 轮 ──────────`);
      try {
        // 1) 建会话 + 工作目录 + 自动模式 + 高思考档。
        const sid = await newSessionViaUI(ws);
        created.push(sid);
        round.sid = sid;
        await setWorkingDir(ws, CWD);
        const wd = (await sessionOf(ws, sid))?.workingDir;
        if (wd !== CWD) throw new Error(`会话 workingDir 复核失败：期望 ${CWD}，实际 ${wd}`);
        await ensurePermissionMode(ws, sid, 'bypassPermissions', '自动模式');
        await evalExpr(ws, `window.claudeLink.updateSession(${JSON.stringify(sid)}, { thinkingLevel: 'high' })`);
        await waitFor('思考档生效 high', async () => ((await sessionOf(ws, sid))?.thinkingLevel ?? null) === 'high', 15);
        const baseCount = (await getMessages(ws, sid)).length;

        // 2) 发长 thinking prompt，等 thinking_delta 流式出现。
        await resetCollector(ws);
        const tSendA = Date.now();
        await sendViaUI(ws, PROMPT_A);
        await waitFor('A 回合进入执行（abort 按钮出现）', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 90, 500);
        const firstThinking = await waitFor('thinking_delta 流式出现', async () => {
          const evs = eventsOf(await readEvents(ws), sid).filter((e) => e.kind === 'stream_delta' && e.sub === 'thinking_delta');
          return evs.length > 0 ? evs[0] : null;
        }, 120, 300);
        // 在 thinking 中段停留片刻再中断（确保撕的是 thinking 轮）。
        await new Promise((r) => setTimeout(r, 800));
        const evsBeforeAbort = eventsOf(await readEvents(ws), sid);
        round.thinking = {
          firstThinkingDeltaAt: firstThinking.t,
          deltaCountBeforeAbort: evsBeforeAbort.filter((e) => e.sub === 'thinking_delta').length,
          abortDuringThinking: evsBeforeAbort.length > 0 && evsBeforeAbort[evsBeforeAbort.length - 1].sub === 'thinking_delta',
        };
        const cliSid = (await sessionOf(ws, sid))?.cliSessionId ?? null;
        round.cliSessionId = cliSid;
        log(`回合 A thinking 中（delta=${round.thinking.deltaCountBeforeAbort}，cliSessionId=${cliSid ? cliSid.slice(0, 8) + '…' : 'null'}），执行中断…`);

        // 3) 真实长按中断 → ④ sending 复位即时检查 → 立即快照 transcript → <1s 内发送第二条。
        // （④ 必须在续发前取证：B 发出后 abort 按钮会因 B 在执行而重新出现，中断后查必然假阴。）
        await abortCurrentTurn(ws);
        const tAbort = Date.now();
        const tResetStart = Date.now();
        try {
          await waitFor('④ sending 复位（sending=false → abort 按钮消失）', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), 1.5, 60);
          round.checks.sendingReset = true;
          round.sendingResetMs = Date.now() - tResetStart;
        } catch {
          round.checks.sendingReset = false;
          round.sendingResetMs = null;
        }
        // 快照摄于 B 追加前——保住「末行」撕裂语义（B resume 会向同一 jsonl 追加掩埋现场）。
        let snapshotPath = null;
        if (cliSid) {
          const live = locateTranscript(cliSid);
          if (live) {
            snapshotPath = path.join(EVIDENCE_DIR, `round-${i}-${cliSid}.snapshot.jsonl`);
            fs.copyFileSync(live, snapshotPath);
          }
        }
        await typeInChatInput(ws, PROMPT_B);
        let tClicked = null;
        const deadline = Date.now() + 20_000;
        for (;;) {
          await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
          if (tClicked === null) tClicked = Date.now();
          const accepted = await waitFor(
            '发送被接受（输入框清空）',
            () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return ta ? !ta.value.trim() : true; })()`),
            3,
            150,
          ).catch(() => false);
          if (accepted) break;
          if (Date.now() > deadline) throw new Error('续发未被主进程接受（输入框未清空）——立即续发链路可能被占坑检查拒绝');
        }
        const tAccepted = Date.now();
        round.timing = { abortToSendClickMs: tClicked - tAbort, abortToAcceptedMs: tAccepted - tAbort };
        log(`④ sending 复位 ${round.sendingResetMs ?? '>1.5s(未复位)'}；中断→点击发送 ${tClicked - tAbort}ms；中断→发送被接受 ${tAccepted - tAbort}ms`);
        round.checks.resendWithin1s = (tClicked - tAbort) < 1000;

        // ① B 回合收到 result（成功终态）：等 result 事件（is_error 非真）+ 查询空闲。
        const bResult = await waitFor('① B 回合 result 事件', async () => {
          const evs = eventsOf(await readEvents(ws), sid).filter((e) => e.kind === 'result');
          return evs.length > 0 ? evs[evs.length - 1] : null;
        }, 240, 500);
        round.checks.bResultReceived = true;
        round.checks.bResultSuccess = bResult.extra ? bResult.extra.isError !== true : false;
        round.bResult = bResult.extra;
        await waitQueryIdle(ws, 120);
        await new Promise((r) => setTimeout(r, 1500)); // 给 A 残尾/迟到事件留窗口再取证。

        // ② 全程无 error / api_retry 终态 / SDK 执行出错：事件缓冲 + DB 系统消息双查。
        const evsFinal = eventsOf(await readEvents(ws), sid);
        const errEvents = evsFinal.filter((e) => e.kind === 'error');
        const msgs = await getMessages(ws, sid);
        const windowMsgs = msgs.slice(baseCount);
        const badSystemMsgs = windowMsgs.filter((m) =>
          m.role === 'system' && (
            (m.processKind || '').includes('api_retry') ||
            (m.processKind || '') === 'system:error' ||
            String(m.content || '').includes('SDK 执行出错')
          ));
        round.errorEvents = errEvents.map((e) => e.extra?.message ?? '');
        round.badSystemMsgs = badSystemMsgs.map((m) => ({ processKind: m.processKind, content: String(m.content || '').slice(0, 120) }));
        round.checks.noError = errEvents.length === 0 && badSystemMsgs.length === 0;

        // ③ 中断后 DB 落 system:aborted 恰一条。
        const abortedMsgs = windowMsgs.filter((m) => m.processKind === 'system:aborted');
        round.abortedCount = abortedMsgs.length;
        round.checks.abortedPersistedOnce = abortedMsgs.length === 1;

        // ⑤ transcript 撕裂诊断：中断瞬间快照（--file）+ 回合结束后正本（--session）。
        const diag = runDiagnose(cliSid, snapshotPath);
        round.diagnose = {
          snapshotCode: diag.snapshot ? diag.snapshot.code : 'no-snapshot',
          liveCode: diag.live ? diag.live.code : 'no-cliSid',
          snapshotOutputHead: diag.snapshot ? diag.snapshot.output.split('\n').filter((l) => /判定|汇总|撕裂|不可解析/.test(l)).join(' | ').slice(0, 300) : null,
          liveOutputHead: diag.live ? diag.live.output.split('\n').filter((l) => /判定|汇总|撕裂|不可解析/.test(l)).join(' | ').slice(0, 300) : null,
        };
        // F5（2026-10-24 review）：transcriptIntact 收紧为 diagnose 退出码 === 0——读取失败（exit 1）
        // 同样不算完整（旧 code !== 2 放行 READ_ERROR 假阴）。
        round.checks.transcriptIntact =
          (diag.snapshot ? diag.snapshot.code === 0 : true) && (diag.live ? diag.live.code === 0 : true);

        const allPass = Object.values(round.checks).every(Boolean);
        round.verdict = allPass ? 'pass' : 'fail';
        console.log(`第 ${i} 轮判定：${round.verdict.toUpperCase()}  ${JSON.stringify(round.checks)}`);
      } catch (e) {
        round.verdict = 'error';
        round.error = e.message;
        console.log(`第 ${i} 轮异常：${e.message}`);
      }
      rounds.push(round);
      fs.writeFileSync(path.join(EVIDENCE_DIR, 'rounds.json'), JSON.stringify(rounds, null, 2), 'utf8');
    }
  } finally {
    await cleanup();
  }

  // 汇总。
  const passRounds = rounds.filter((r) => r.verdict === 'pass');
  const failRounds = rounds.filter((r) => r.verdict === 'fail');
  const errRounds = rounds.filter((r) => r.verdict === 'error');
  const suspectA = failRounds.some((r) => r.checks.noError === false || r.checks.transcriptIntact === false);
  const summary = {
    runId: RUN_ID,
    finishedAt: new Date().toISOString(),
    roundsTotal: rounds.length,
    pass: passRounds.length,
    fail: failRounds.length,
    error: errRounds.length,
    suspectAReproduced: suspectA,
    rounds,
  };
  fs.writeFileSync(path.join(EVIDENCE_DIR, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n=== 汇总：${passRounds.length}/${rounds.length} 轮通过；fail=${failRounds.length} error=${errRounds.length}；疑点 A 复现=${suspectA ? '是' : '否'} ===`);
  console.log(`证据落盘：${EVIDENCE_DIR}`);
  if (errRounds.length > 0 && passRounds.length + failRounds.length === 0) {
    console.error('全部轮次环境异常（非断言失败）——按前置不足处理，exit 2。');
    process.exit(2);
  }
  process.exit(failRounds.length > 0 ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（exit 2）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e && e.stack ? e.stack : e);
  process.exit(1);
});
