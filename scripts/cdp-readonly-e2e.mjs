// scripts/cdp-readonly-e2e.mjs
// review-v10 §4：受限非管理员账户 + 真实 DENY ACL 下，完整 Electron + Agent SDK + Claude Code
// 链路的 /init 只读目录验收（四层断言）。
//
// 用法（由 scripts/readonly-account-e2e.mjs 编排调用，也可手动）：
//   node scripts/cdp-readonly-e2e.mjs --port 9224 --cwd <readonly-cwd> [--cli-exe <path>]
//
// 前置（编排脚本负责）：
//   - 专用非管理员账户已创建并以该账户启动 Electron（CDP 端口）；
//   - 只读夹具 ACL 已配置，且同账户 Node 写入预检已得 EPERM/EACCES；
//   - 该账户自己的 ~/.claude/settings.json env 块已受控引导（不复制加密 store）。
//
// 四层断言（review-v10 §4.4-5）：
//   ① 文件：CLAUDE.md 不存在或哈希不变；
//   ② UI：不出现成功写入提示——必须出现原生失败或 init_write_skipped 持久化消息；
//   ③ 会话：sending 复位（无中断按钮），最终消息失败语义明确；
//   ④ 持久化：切走再切回同一会话后终态一致，无额外成功写入记录。
//
// 退出协议：0 全过 / 1 断言失败 / 2 前置不满足（明确「无法执行」，不算通过）。无 SKIP。

import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CDP_PORT = Number(argOf('--port') ?? 9224);
const RO_CWD = argOf('--cwd');
const CLI_EXE = argOf('--cli-exe');

if (!RO_CWD) {
  console.error('缺少 --cwd（只读夹具目录）');
  process.exit(2);
}

let pass = 0;
let fail = 0;
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

// ── CDP 基础 ──
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

// ── UI 驱动（与 cdp-real-window-e2e.mjs 同款模式）──
async function newSessionViaUI(ws) {
  const before = new Set(((await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? []).map((s) => s.id));
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor('聊天输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  return waitFor('新会话出现在 listSessions（差集唯一）', async () => {
    const list = (await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? [];
    const fresh = list.filter((s) => !before.has(s.id));
    return fresh.length === 1 ? fresh[0].id : null;
  }, 15);
}
async function setWorkingDirViaUI(ws, dir) {
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link'))?.click(), true`);
  await waitFor('回到聊天页（工具栏出现）', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
  await evalExpr(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const wsBtn = btns.find((b) => (b.textContent || '').includes('▾'));
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
  await waitFor(`权限按钮反映 ${permValue}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    return !!btn && (btn.getAttribute('title') || '').includes('${permValue}');
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
  await waitFor('查询空闲（无运行中 query）', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), timeoutS, 1000);
}
async function getMessages(ws, sid) {
  return (await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`)) ?? [];
}
async function sendViaUI(ws, sid, text) {
  await waitQueryIdle(ws, 600);
  const before = (await getMessages(ws, sid)).length;
  await typeInChatInput(ws, text);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
  await waitFor('消息被接受（user 消息入列）', async () => (await getMessages(ws, sid)).length > before, 30, 500);
}
async function waitTurnComplete(ws, sid, baseCount, timeoutS = 180) {
  return waitFor(`回合完成（响应消息，>${baseCount}+1 条）`, async () => {
    const msgs = await getMessages(ws, sid);
    return msgs.length > baseCount + 1 ? msgs[msgs.length - 1] : null;
  }, timeoutS, 1000);
}
async function switchSessionViaUI(ws, sid) {
  const sessions = (await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? [];
  const target = sessions.find((s) => s.id === sid);
  if (!target?.workingDir) throw new Error(`目标会话 ${sid} 无 workingDir`);
  const candidates = await evalExpr(ws, `[...document.querySelectorAll('.session-link')]
    .map((l, i) => ({ i, name: l.querySelector('.session-link__name')?.textContent?.trim() ?? '' }))
    .filter((x) => x.name === ${JSON.stringify(target.name)})`);
  for (const c of candidates ?? []) {
    await evalExpr(ws, `document.querySelectorAll('.session-link')[${c.i}].click(), true`);
    await waitFor('切换后输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
    const titles = await evalExpr(ws, `[...document.querySelectorAll('.session-toolbar .ctl__btn')].map((b) => b.getAttribute('title') || '').join('|')`);
    if (String(titles).includes(target.workingDir)) return;
  }
  throw new Error(`未能通过 UI 切换到会话 ${sid}`);
}

function hashIfExists(file) {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function main() {
  console.log('=== Read-only Account E2E（review-v10 §4：受限账户 + DENY ACL 完整链）===');
  log(`cwd=${RO_CWD} port=${CDP_PORT}`);

  // ── 前置（不满足 → exit 2「无法执行」）──
  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——受限账户 Electron 未启动。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  precondition(hasBridge, 'preload bridge 不可用。无法执行，exit 2。');
  // 只读夹具前置：目录可读、CLAUDE.md 初始状态记录。
  const claudeMd = path.join(RO_CWD, 'CLAUDE.md');
  const hashBefore = hashIfExists(claudeMd);
  log(`CLAUDE.md 初始：${hashBefore ? `存在（sha256 ${hashBefore.slice(0, 12)}…）` : '不存在'}`);

  const created = [];
  try {
    let sid = null;
    await check('受限账户真实 UI：建会话 + 只读 workingDir + 初始命令 probe ready（CLI 链可用）', async () => {
      sid = await newSessionViaUI(ws);
      created.push(sid);
      log(`  ℹ 会话：sid=${sid}`);
      await setWorkingDirViaUI(ws, RO_CWD);
      // CLI 前置：初始 probe 须 ready（受限账户能发现并运行 claude.exe）。
      try {
        await waitFor('初始 probe ready', async () => {
          const s = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
          return s && s.status === 'ready' && (s.commands ?? []).length > 0 ? s : null;
        }, 90, 1000);
      } catch (e) {
        if (!CLI_EXE) throw e;
        // 受限账户 PATH 无 CLI：经 saveConfig 配置 cliPath（该账户自己的 config，受控引导）。
        log(`  ℹ probe 未 ready（${e.message.slice(0, 80)}）——经 saveConfig 配置 cliPath 后重试`);
        await evalExpr(ws, `(async () => {
          const cfg = await window.claudeLink.getConfig();
          await window.claudeLink.saveConfig({ ...cfg, cliPath: ${JSON.stringify(CLI_EXE)} });
          return true;
        })()`);
        await evalExpr(ws, `location.reload(), true`);
        await waitFor('reload 后 bridge 恢复', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 30);
        await setWorkingDirViaUI(ws, RO_CWD);
        await waitFor('初始 probe ready（配置 cliPath 后）', async () => {
          const s = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
          return s && s.status === 'ready' && (s.commands ?? []).length > 0 ? s : null;
        }, 120, 1000);
      }
    });
    precondition(sid, '未取得会话——无法继续（exit 2）');

    // /init 前切自动模式（项目准则 9：无人值守工具执行必须 bypass）。
    await check('会话权限模式 → 自动模式（经真实 UI 权限面板）', async () => {
      await setPermissionModeViaUI(ws, 'bypassPermissions', '自动模式');
    });

    // ── 真实 UI 发送 /init ──
    await check('真实 UI 发送 /init（只读 cwd，等待回合完成）', async () => {
      const base = (await getMessages(ws, sid)).length;
      await sendViaUI(ws, sid, '/init');
      await waitTurnComplete(ws, sid, base, 540);
    });

    // ── 四层断言 ──
    await check('① 文件层：CLAUDE.md 未被创建/修改（不存在或哈希不变）', async () => {
      const hashAfter = hashIfExists(claudeMd);
      if (hashBefore === null && hashAfter !== null) throw new Error('CLAUDE.md 被创建——只读 ACL 未生效');
      if (hashBefore !== null && hashAfter !== hashBefore) throw new Error('CLAUDE.md 被修改——只读 ACL 未生效');
      log(`  ℹ CLAUDE.md 终态：${hashAfter ? `未变（${hashAfter.slice(0, 12)}…）` : '不存在'}`);
    });

    let finalMsgs = [];
    await check('②+③ UI/会话层：原生失败或 init_write_skipped，sending 复位', async () => {
      await waitQueryIdle(ws, 600);
      finalMsgs = await getMessages(ws, sid);
      const skipped = finalMsgs.filter((m) => typeof m.processKind === 'string' && m.processKind.includes('init_write_skipped'));
      const failure = finalMsgs.filter((m) =>
        m.role === 'system' && typeof m.processKind === 'string' && m.processKind.includes('result') &&
        ((m.isError === true) || /error|failed|失败|拒绝|denied|EPERM|EACCES/i.test(String(m.content ?? ''))));
      log(`  ℹ 消息总数=${finalMsgs.length}，init_write_skipped=${skipped.length}，failure-result=${failure.length}`);
      log(`  ℹ 末 3 条：${JSON.stringify(finalMsgs.slice(-3).map((m) => ({ role: m.role, kind: m.processKind, isError: m.isError ?? null, head: String(m.content ?? '').slice(0, 70) })))}`);
      if (skipped.length === 0 && failure.length === 0) {
        throw new Error('未出现 init_write_skipped 或原生失败终态——UI 层无明确失败语义（不允许静默）');
      }
      // sending 复位：无中断按钮（waitQueryIdle 已确认），显式再断言一次。
      const abort = await evalExpr(ws, `!!document.querySelector('button.ctl__btn--abort')`);
      if (abort) throw new Error('sending 未复位（中断按钮仍在）');
    });

    await check('④ 持久化层：切走再切回后终态一致、无额外成功写入记录', async () => {
      const sid2 = await newSessionViaUI(ws);
      created.push(sid2);
      await switchSessionViaUI(ws, sid);
      const reopened = await getMessages(ws, sid);
      if (reopened.length < finalMsgs.length) throw new Error(`重开后消息丢失：${finalMsgs.length} → ${reopened.length}`);
      const skipped = reopened.filter((m) => typeof m.processKind === 'string' && m.processKind.includes('init_write_skipped')).length;
      if (skipped === 0) {
        const failure = reopened.filter((m) =>
          m.role === 'system' && typeof m.processKind === 'string' && m.processKind.includes('result') &&
          ((m.isError === true) || /error|failed|失败|拒绝|denied|EPERM|EACCES/i.test(String(m.content ?? ''))));
        if (failure === 0) throw new Error('重开后失败终态消失（持久化不一致）');
      }
      const hashAfter = hashIfExists(claudeMd);
      if (hashBefore === null && hashAfter !== null) throw new Error('重开后 CLAUDE.md 出现（额外写入）');
      log(`  ℹ 重开后消息 ${finalMsgs.length}→${reopened.length}，失败终态保持，文件未变`);
    });
  } finally {
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  if (e instanceof PreconditionError) {
    console.error(`\n前置条件不满足（无法执行，不算通过）：${e.message}`);
    process.exit(2);
  }
  console.error('FATAL:', e.message);
  process.exit(1);
});
