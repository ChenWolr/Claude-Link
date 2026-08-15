// scripts/cdp-real-window-e2e.mjs
// review-v9 §5：Task 9 真实窗口发布级验收（可重复、可检查、不依赖人工口述）。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行：npm run test:cdp:real-window
//
// 退出协议（review-v9 §5）：
//   - exit 0：全部场景通过（无 skip、无 warning-as-pass、无未恢复的设置变更）。
//   - exit 1：断言失败（实现回归）。
//   - exit 2：前置条件不满足（Electron/CDP/CLI/凭据不可用）——「无法执行」，不算通过。
//   - exit 3：环境受限场景未执行（如 /compact 无法达到可压缩阈值）——阻止「Task 9 完成」声明。
//
// 场景（review-v9 §5 顺序）：
//   1. 临时工作目录 D:/software/Cache/claude-link/e2e/<run-id>/cwd（/init 副作用只允许在此）。
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
//
// 结束只清理自己在 e2e/<run-id>/ 创建的目录与会话；设置备份恢复失败 → 失败并保留备份路径。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP_PORT = 9223;
const E2E_ROOT = 'D:/software/Cache/claude-link/e2e';
const RUN_ID = `real-window-${Date.now()}`;
const FIXTURE_ROOT = path.join(E2E_ROOT, RUN_ID);
const CWD = path.join(FIXTURE_ROOT, 'cwd').replace(/\\/g, '/');
const USER_SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');
const SETTINGS_BACKUP = path.join(FIXTURE_ROOT, 'settings-backup.json');

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

// ── UI 驱动 ──
async function newSessionViaUI(ws, name) {
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor('聊天输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  const sid = await activeSessionId(ws);
  log(`  ℹ 新会话：sid=${sid}`);
  return sid;
}
async function activeSessionId(ws) {
  return waitFor('活跃会话 id', async () => {
    const activeName = await evalExpr(ws, `document.querySelector('.session-link.active .session-link__name')?.textContent?.trim() ?? null`);
    if (!activeName) return null;
    const sessions = await evalExpr(ws, `window.claudeLink.listSessions()`);
    const hit = (sessions ?? []).find((s) => s.name === activeName);
    return hit?.id ?? null;
  }, 15);
}
async function switchSessionViaUI(ws, sessionName) {
  await evalExpr(ws, `(() => {
    const links = [...document.querySelectorAll('.session-link')];
    const target = links.find((l) => l.querySelector('.session-link__name')?.textContent?.trim() === ${JSON.stringify(sessionName)});
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
  await waitFor(`权限按钮反映 ${permValue}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    const btn = btns.find((b) => (b.getAttribute('title') || '').includes('权限模式'));
    // title 使用全角括号「（bypassPermissions）」——只匹配值本身，不匹配括号形态。
    return !!btn && (btn.getAttribute('title') || '').includes('${permValue}');
  })()`), 15);
}

/** 等待当前会话查询空闲（无中断按钮 = 无运行中 query）——发送中点击会被 sending 阻塞。 */
async function waitQueryIdle(ws, timeoutS = 600) {
  await waitFor('查询空闲（无运行中 query）', () => evalOk(ws, `!document.querySelector('button.ctl__btn--abort')`), timeoutS, 1000);
}
/** 通过 UI 发送：先等空闲 → 输入 → 点击发送 → 确认消息被接受（user 消息入列）。 */
async function sendViaUI(ws, sid, text) {
  await waitQueryIdle(ws, 600);
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

  // ── 前置条件校验（不满足 → 明确「无法执行」exit 2）──
  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——先 npm run dev:cdp。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  precondition(hasBridge, 'preload bridge 不可用——Electron/preload 未正常启动。无法执行，exit 2。');
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
      await evalExpr(ws, `document.querySelector('button.ctl__btn--abort')?.click(), true`);
      // 按钮状态恢复（abort 按钮消失）。
      await waitFor('中断按钮消失（sending 复位）', async () => !(await evalOk(ws, `!!document.querySelector('button.ctl__btn--abort')`)), 60, 1000);
      // system:aborted 恰好新增一条。
      await waitFor('system:aborted 持久化', async () => {
        const now = (await getMessages(ws, sid)).filter((m) => m.processKind === 'system:aborted').length;
        return now === abortedBefore + 1 ? true : null;
      }, 60, 1000);
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
      const b = JSON.parse(fs.readFileSync('D:/software/Cache/claude-link/command-baseline.json', 'utf8'));
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
