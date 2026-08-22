// scripts/context-research-harness.mjs
// 上下文占用统计契约对齐计划的证据采集 harness（Task 4/5/6）。
//
// 用法（须先启动 Electron dev:cdp）：
//   node scripts/context-research-harness.mjs minimal --runId run-2026-08-21-205616
//
// 职责：通过 CDP 驱动真实 Electron 窗口，在同一个 cliSessionId 上采集：
//   - CONTEXT_UPDATE payload（onContextUpdate 收集到 window.__ctxResearchUpdates）
//   - /context 原生输出（getSessionMessages 中 system:local_command_output 消息）
//   - ContextButton DOM 快照
// 脱敏后写入 <runId>/ 下的 jsonl。不写生产代码、不落秘密、只清理自己创建的会话。
//
// getContextUsage 的 runtime 快照由主进程 dev stdout（dev-server.log 的「getContextUsage 诊断」行）
// 在 harness 之外采集（每会话 init 时仅一次），本文件负责把其证据引用路径记入产物。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const CDP_PORT = 9223;
const RESEARCH_ROOT = 'D:/software/Cache/claude-link/context-research';

const HOME_DIRS = [process.env.USERPROFILE, process.env.HOME, os.homedir()]
  .filter(Boolean).map(String)
  .filter((d, i, a) => a.indexOf(d) === i)
  .sort((a, b) => b.length - a.length);

function scrub(text) {
  let out = String(text ?? '');
  for (const home of HOME_DIRS) out = out.split(home).join('<USER_DIR>');
  out = out.split('D:\\software\\code\\claude-link').join('<REPO_DIR>');
  out = out.split('D:/software/code/claude-link').join('<REPO_DIR>');
  out = out.replace(/sk-[a-zA-Z0-9_-]{16,}/g, '<redacted>');
  out = out.replace(/(ANTHROPIC_(?:API_KEY|AUTH_TOKEN)\s*[=:]\s*)\S+/gi, '$1<redacted>');
  out = out.replace(/(Authorization\s*[:=]\s*)(Bearer\s+)?\S+/gi, '$1<redacted>');
  return out;
}

function stableId(raw) {
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 10);
}

// ── CDP 基础（与 cdp-real-window-e2e.mjs 同款）──
async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  return targets.find((t) => t.type === 'page') ?? null;
}
function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
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

class PreconditionError extends Error {}

// ── 采集器注入 ──
async function registerCollectors(ws) {
  await evalExpr(ws, `(() => {
    window.__ctxResearch = { updates: [] };
    try { window.__ctxResearchUnsub?.(); } catch {}
    window.__ctxResearchUnsub = window.claudeLink.onContextUpdate((p) => {
      window.__ctxResearch.updates.push({
        t: Date.now(),
        sessionId: p.sessionId,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        windowSize: p.windowSize,
        model: p.model,
        compactedJustNow: p.compactedJustNow ?? false,
      });
    });
    return true;
  })()`);
}
async function readUpdates(ws) {
  return (await evalExpr(ws, `window.__ctxResearch?.updates ?? []`)) ?? [];
}
async function clearUpdates(ws) {
  await evalExpr(ws, `(() => { window.__ctxResearch.updates = []; return true; })()`);
}

// ── UI 驱动（与 cdp-real-window-e2e.mjs 同款）──
async function newSessionViaUI(ws) {
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor('聊天输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  const sid = await activeSessionId(ws);
  return sid;
}
async function activeSessionId(ws) {
  return waitFor('活跃会话 id', async () => {
    const activeName = await evalExpr(ws, `document.querySelector('.session-link.active .session-link__name')?.textContent?.trim() ?? null`);
    if (!activeName) return null;
    const sessions = await evalExpr(ws, `window.claudeLink.listSessions()`);
    return (sessions ?? []).find((s) => s.name === activeName)?.id ?? null;
  }, 15);
}
async function sessionOf(ws, sid) {
  return (await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`)) ?? null;
}
async function setWorkingDir(ws, dir) {
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link'))?.click(), true`);
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
async function getMessages(ws, sid) {
  return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? [];
}
async function sendViaUI(ws, text) {
  await waitQueryIdle(ws, 600);
  await typeInChatInput(ws, text);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
}
async function waitTurnComplete(ws, sid, baseCount, timeoutS = 180) {
  return waitFor('回合完成', async () => {
    const msgs = await getMessages(ws, sid);
    return msgs.length > baseCount + 1 ? msgs[msgs.length - 1] : null;
  }, timeoutS, 1000);
}
async function setPermissionModeViaUI(ws, permValue, permLabel) {
  await evalExpr(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    if (!btn) throw new Error('权限模式按钮未找到');
    btn.click(); return true;
  })()`);
  const clicked = await evalExpr(ws, `(() => {
    const items = [...document.querySelectorAll('.perm-item')];
    const t = items.find((i) => i.querySelector('.perm-item__label')?.textContent?.trim() === ${JSON.stringify(permLabel)});
    if (t) { t.click(); return true; }
    return false;
  })()`);
  if (!clicked) throw new Error(`权限面板未找到「${permLabel}」`);
  await waitFor(`权限按钮反映 ${permValue}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    return !!btn && (btn.getAttribute('title') || '').includes('${permValue}');
  })()`), 15);
}

// ── 采样函数 ──
async function sampleDom(ws) {
  return await evalExpr(ws, `(() => {
    const btn = document.querySelector('.ctx__btn');
    const ring = document.querySelector('.ctx__ring-fg');
    const rows = [...document.querySelectorAll('.ctx__row')].map((r) => ({
      label: r.querySelector('span')?.textContent?.trim() ?? '',
      value: r.querySelector('code')?.textContent?.trim() ?? '',
    }));
    return {
      present: !!btn,
      title: btn?.getAttribute('title') ?? null,
      ringDasharray: ring?.getAttribute('stroke-dasharray') ?? null,
      popoverRows: rows,
    };
  })()`);
}
// /context 原生输出：最近的 system:local_command_output 消息 content（可能含 /context 原文）。
async function readNativeContext(ws, sid) {
  const msgs = await getMessages(ws, sid);
  // /context 实测以 assistant 消息落库（含 "Context Usage"），local_command_output 是本实现的另一候选形态。
  const ctxMsgs = msgs.filter((m) =>
    typeof m.content === 'string' && (m.content.includes('Context Usage') || (m.role === 'system' && typeof m.processKind === 'string' && m.processKind.includes('local_command_output'))));
  const last = ctxMsgs[ctxMsgs.length - 1] ?? null;
  if (!last) return null;
  return scrub(last.content);
}
// 诊断：本回合所有消息的 (role, processKind, content 前 160 字) 摘要，用于定位 /context 落库形态。
async function dumpMessageKinds(ws, sid, sinceCount) {
  const msgs = await getMessages(ws, sid);
  return msgs.slice(sinceCount).map((m) => ({
    role: m.role,
    processKind: m.processKind,
    eventType: m.eventType,
    head: scrub(String(m.content ?? '')).slice(0, 160),
  }));
}

function argValue(name) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && i + 1 < process.argv.length) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split('=').slice(1).join('=');
  return null;
}

async function main() {
  const phase = process.argv[2] ?? 'minimal';
  const runId = argValue('runId') ?? `run-${Date.now()}`;
  const outDir = path.join(RESEARCH_ROOT, runId);
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`phase=${phase} runId=${runId} outDir=${outDir}`);

  const page = await getPageTarget();
  if (!page) throw new PreconditionError(`无法连接 CDP 端口 ${CDP_PORT}——先 npm run dev:cdp。exit 2`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  if (!hasBridge) throw new PreconditionError('preload bridge 不可用。exit 2');
  const cfg = await evalExpr(ws, `window.claudeLink.getConfig()`);
  if (!cfg || !cfg.apiBaseUrl) throw new PreconditionError('getConfig 未返回有效 apiBaseUrl。exit 2');
  console.log(`cfg.apiBaseUrl=${scrub(cfg.apiBaseUrl)} model=${cfg.defaultModel ?? '(none)'}`);

  await registerCollectors(ws);

  const created = [];
  const cleanup = async () => {
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
  };

  const prompts = [];
  const append = (line) => { prompts.push(line); fs.appendFileSync(path.join(outDir, 'prompts.jsonl'), JSON.stringify(line) + '\n'); };
  const ipcLog = [];
  const uiLog = [];
  const nativeLog = [];
  const flush = () => {
    fs.writeFileSync(path.join(outDir, 'ipc-context-update.jsonl'), ipcLog.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'ui-context-snapshots.jsonl'), uiLog.map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'native-context-output.jsonl'), nativeLog.map((x) => JSON.stringify(x)).join('\n') + '\n');
  };

  const sampleTurn = async (sid, label) => {
    const updates = await readUpdates(ws);
    const dom = await sampleDom(ws);
    const sess = await sessionOf(ws, sid);
    const entry = {
      label,
      cliSessionId: stableId(sess?.cliSessionId),
      appSessionId: stableId(sid),
      ipc: updates.map((u) => ({ inputTokens: u.inputTokens, outputTokens: u.outputTokens, windowSize: u.windowSize, compactedJustNow: u.compactedJustNow })),
      dom,
    };
    ipcLog.push({ label, cliSessionId: entry.cliSessionId, appSessionId: entry.appSessionId, updates: entry.ipc });
    uiLog.push({ label, cliSessionId: entry.cliSessionId, dom });
    return entry;
  };

  try {
    const sid = await newSessionViaUI(ws);
    created.push(sid);
    const sess = await sessionOf(ws, sid);
    console.log(`sid=${stableId(sid)} cliSessionId(初始)=${stableId(sess?.cliSessionId)}`);

    if (phase === 'minimal') {
      // 隔离 cwd：text-only 场景也按 Task 3 Step 3 用独立工作目录，避免仓库 CLAUDE.md/AGENTS.md 注入污染口径。
      const isoCwd = path.join(outDir, 'cwd').replace(/\\/g, '/');
      fs.mkdirSync(isoCwd, { recursive: true });
      fs.writeFileSync(path.join(isoCwd, 'README.md'), '# context-research\n', 'utf8');
      await setWorkingDir(ws, isoCwd);
      console.log(`隔离 cwd=${isoCwd}`);

      // S0：空会话（无消息）→ 采 DOM（应 pending 非 0%），再发 /context 采 native。
      await clearUpdates(ws);
      const s0Dom = await sampleDom(ws);
      uiLog.push({ scenario: 'S0-empty-session', phase: 'before-any-query', dom: s0Dom, cliSessionId: stableId(sess?.cliSessionId) });
      console.log('S0 空会话 DOM:', JSON.stringify(s0Dom));

      // 发 /context（本地命令，default 权限即可）——触发 init → getContextUsage 诊断。
      const base0 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, base0, 180);
      await waitQueryIdle(ws, 180);
      const native0 = await readNativeContext(ws, sid);
      const kinds0 = await dumpMessageKinds(ws, sid, base0);
      nativeLog.push({ scenario: 'S0-empty-session', native: native0, messageKinds: kinds0, cliSessionId: stableId(sess?.cliSessionId) });
      console.log('S0 /context 原生输出(脱敏):', native0);
      console.log('S0 /context 消息形态:', JSON.stringify(kinds0, null, 2));
      const s0After = await sampleTurn(sid, 'S0-after-/context');
      console.log('S0 after /context:', JSON.stringify(s0After));

      // S1：短文本（default 权限，无工具）
      await clearUpdates(ws);
      const s1Prompt = '请只回复"收到"，不要使用任何工具。';
      const b1 = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, s1Prompt);
      await waitTurnComplete(ws, sid, b1, 180);
      await waitQueryIdle(ws, 180);
      const s1 = await sampleTurn(sid, 'S1-short-text');
      append({ scenario: 'S1-short-text-no-tools', prompt: s1Prompt, cliSessionId: s1.cliSessionId });
      console.log('S1 短文本:', JSON.stringify(s1));
      // S1 后 /context 对账
      const b1c = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, b1c, 180);
      await waitQueryIdle(ws, 180);
      nativeLog.push({ scenario: 'S1-short-text', native: await readNativeContext(ws, sid), cliSessionId: s1.cliSessionId });

      // S2：多轮文本（三轮）
      const s2Prompts = ['只回复"1"。', '请复述这句话：Claude context baseline。', '请总结当前对话，控制在 20 字以内。'];
      for (let i = 0; i < s2Prompts.length; i++) {
        await clearUpdates(ws);
        const bb = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, s2Prompts[i]);
        await waitTurnComplete(ws, sid, bb, 180);
        await waitQueryIdle(ws, 180);
        const t = await sampleTurn(sid, `S2-turn-${i + 1}`);
        append({ scenario: `S2-turn-${i + 1}`, prompt: s2Prompts[i], cliSessionId: t.cliSessionId });
        console.log(`S2 turn${i + 1}:`, JSON.stringify(t));
        // 每轮后 /context 对账
        const bc = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, '/context');
        await waitTurnComplete(ws, sid, bc, 180);
        await waitQueryIdle(ws, 180);
        nativeLog.push({ scenario: `S2-turn-${i + 1}`, native: await readNativeContext(ws, sid), cliSessionId: t.cliSessionId });
      }
      flush();
      console.log('minimal 阶段完成；证据已写入', outDir);
    } else if (phase === 'tool') {
      // Task 5：工具、注入、MCP、长输出场景（S3–S8）。工具执行需 bypassPermissions。
      const isoCwd = path.join(outDir, 'cwd-tool').replace(/\\/g, '/');
      fs.mkdirSync(isoCwd, { recursive: true });
      // S3 小文件、S4 大文件、S5 错误工具目标文件
      fs.writeFileSync(path.join(isoCwd, 'small.txt'), 'Hello from small file. ' + 'x'.repeat(200) + '\n', 'utf8');
      fs.writeFileSync(path.join(isoCwd, 'large.txt'), 'L' + 'y'.repeat(60000) + '\n', 'utf8');
      await setWorkingDir(ws, isoCwd);
      await setPermissionModeViaUI(ws, 'bypassPermissions', '自动模式');
      console.log(`工具阶段 cwd=${isoCwd}，权限=bypassPermissions`);

      const doScenario = async (label, prompt, opts = {}) => {
        await clearUpdates(ws);
        const b = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, prompt);
        await waitTurnComplete(ws, sid, b, opts.timeoutS ?? 300);
        await waitQueryIdle(ws, 300);
        const t = await sampleTurn(sid, label);
        append({ scenario: label, prompt, cliSessionId: t.cliSessionId, permissionMode: 'bypassPermissions' });
        console.log(`${label}:`, JSON.stringify(t));
        // 工具后 /context 对账
        const bc = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, '/context');
        await waitTurnComplete(ws, sid, bc, 180);
        await waitQueryIdle(ws, 180);
        nativeLog.push({ scenario: label, native: await readNativeContext(ws, sid), cliSessionId: t.cliSessionId });
        return t;
      };

      await doScenario('S3-read-small-file', `请用 Read 工具读取工作目录下的 small.txt 文件，然后只回复文件内容的第一个词。`);
      await doScenario('S4-read-large-file', `请用 Read 工具读取工作目录下的 large.txt 文件，然后只回复该文件包含多少个字符（数字）。`);
      await doScenario('S5-tool-error', `请用 Read 工具读取工作目录下不存在的文件 nonexistent-xyz.txt，然后如实说明发生了什么。`);
      await doScenario('S8-thinking-or-reasoning', `请先在心里推理，再回答：1+1 等于几？只需给最终数字，不要解释过程。`, { timeoutS: 300 });

      flush();
      console.log('tool 阶段完成；证据已写入', outDir);
    } else if (phase === 'lifecycle') {
      // Task 6：compaction / 中断重发 / 两 session 隔离（S10/S11/S13）。restart/resume(S12) 需重启 Electron，单独脚本。
      const isoCwd = path.join(outDir, 'cwd-life').replace(/\\/g, '/');
      fs.mkdirSync(isoCwd, { recursive: true });
      fs.writeFileSync(path.join(isoCwd, 'README.md'), '# lifecycle\n', 'utf8');
      await setWorkingDir(ws, isoCwd);
      await setPermissionModeViaUI(ws, 'bypassPermissions', '自动模式');
      console.log(`生命周期 cwd=${isoCwd}，权限=bypassPermissions`);

      // S10 compaction：多轮长输出 warmup 扩大上下文，观察 compact_boundary / /context 前后变化。
      await clearUpdates(ws);
      for (let i = 0; i < 3; i++) {
        const b = (await getMessages(ws, sid)).length;
        await sendViaUI(ws, `请极其详尽地解释 TypeScript ${['泛型','条件类型','映射类型'][i]}，给出至少 800 字与完整代码示例。`);
        await waitTurnComplete(ws, sid, b, 300);
        await waitQueryIdle(ws, 300);
        console.log(`S10 warmup ${i + 1} 完成`);
      }
      const preCompact = await sampleTurn(sid, 'S10-pre-compact');
      const bPre = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, bPre, 180);
      await waitQueryIdle(ws, 180);
      nativeLog.push({ scenario: 'S10-pre-compact', native: await readNativeContext(ws, sid), cliSessionId: preCompact.cliSessionId });
      console.log('S10 pre-compact:', JSON.stringify(preCompact));

      await clearUpdates(ws);
      const bCompact = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/compact');
      await waitTurnComplete(ws, sid, bCompact, 300);
      await waitQueryIdle(ws, 300);
      const postCompact = await sampleTurn(sid, 'S10-post-compact');
      const bPost = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '/context');
      await waitTurnComplete(ws, sid, bPost, 180);
      await waitQueryIdle(ws, 180);
      nativeLog.push({ scenario: 'S10-post-compact', native: await readNativeContext(ws, sid), cliSessionId: postCompact.cliSessionId });
      console.log('S10 post-compact:', JSON.stringify(postCompact));

      // S11 中断后重发：发长输出 → 中断 → 再发短文本，验证旧 query 快照不覆盖新 query。
      await clearUpdates(ws);
      await sendViaUI(ws, '请极其详尽地解释整个 JavaScript 生态系统历史，尽量长，至少 2000 字。');
      await waitFor('中断按钮出现', () => evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`), 60, 500);
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.click(), true`);
      await waitFor('中断按钮消失', async () => !(await evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`)), 60, 1000);
      const interruptSample = await sampleTurn(sid, 'S11-after-interrupt');
      const bResend = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '只回复"重发成功"。');
      await waitTurnComplete(ws, sid, bResend, 180);
      await waitQueryIdle(ws, 180);
      const resendSample = await sampleTurn(sid, 'S11-after-resend');
      append({ scenario: 'S11-interrupt-and-resend', cliSessionId: resendSample.cliSessionId });
      console.log('S11 after-interrupt:', JSON.stringify(interruptSample));
      console.log('S11 after-resend:', JSON.stringify(resendSample));

      // S13 两 session 隔离：建第二个会话，上下文明显不同，切 UI 比较 CONTEXT_UPDATE/存储不串。
      const sidB = await newSessionViaUI(ws);
      created.push(sidB);
      await setWorkingDir(ws, isoCwd);
      const bB = (await getMessages(ws, sidB)).length;
      await sendViaUI(ws, '请只用一句话回复："B 会话就绪"。');
      await waitTurnComplete(ws, sidB, bB, 180);
      await waitQueryIdle(ws, 180);
      const sampleB = await sampleTurn(sidB, 'S13-session-B');
      console.log('S13 session B:', JSON.stringify(sampleB));
      // 切回 A
      const nameA = await evalExpr(ws, `window.claudeLink.getSession(${JSON.stringify(sid)})`);
      const bA = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, '只回复"A 会话仍在"。');
      await waitTurnComplete(ws, sid, bA, 180);
      await waitQueryIdle(ws, 180);
      const sampleA = await sampleTurn(sid, 'S13-session-A-return');
      console.log('S13 session A return:', JSON.stringify(sampleA));
      append({ scenario: 'S13-two-session-isolation', cliSessionId: sampleA.cliSessionId });

      flush();
      console.log('lifecycle 阶段完成；证据已写入', outDir);
    } else {
      throw new Error(`未知 phase: ${phase}`);
    }
  } finally {
    flush();
    await cleanup();
  }
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（无法执行，不算通过）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  process.exit(1);
});
