// scripts/cdp-commands-e2e.mjs
// review-v9 §4：发布级 renderer DOM 动态命令菜单 E2E（与烟雾测试分离）。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行：npm run test:cdp:commands-e2e
//
// 与 cdp-smoke-test.mjs 的区别：本测试是发布级门禁——所有断言读取真实 DOM
// （[data-testid] 菜单项/来源徽章），不只读 window.claudeLink 返回值；且不把
// 下列事件转换为成功退出：CLI 未配置、初始 probe 未完成、commands_changed 超时、
// 新 skill 未出现在菜单、origin 不符、菜单未刷新（review-v9 §4）。
//
// 退出协议：断言失败 exit 1；前置条件不满足（Electron/CDP/CLI 不可用）exit 2——
// 均为非绿色退出，SKIP 不算 PASS。
//
// 场景（review-v9 §4 发布级顺序）：
//   1. 真实 UI 建会话并在 UI 中切换 workingDir（文件夹选择对话框无法被 CDP 驱动，
//      通过「最近使用」菜单点击完成 UI 路径；首次播种经 IPC 并显式记录该偏差）。
//   2. cwd/.claude/skills 写入 test-cdp-skill-a → DOM 菜单出现，徽章精确为「项目命令」。
//   3. 新增 test-cdp-skill-b → UI 发送 /reload-skills → DOM 出现 b；记录 snapshot revision。
//   4. 删除 b → 再 /reload-skills → DOM 中 b 消失、a 保留、命令数符合新快照（不 concat）。
//   5. 第二会话（不同 cwd）只显示自己的 fixture；切回第一会话再次确认（会话隔离）。
//   6. 延迟 probe：probe 未返回前触发 commands_changed，确认旧 probe 不把 DOM 回退到旧 revision。
//
// 记录：每步输出 sessionId、snapshot revision（source+updatedAt+count 组合代理）、
// DOM 菜单命令名、来源徽章、时间戳与最终 exit code。不记录 API key/完整 settings/用户文件内容。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP_PORT = 9223;
const E2E_ROOT = 'D:/software/Cache/claude-link/e2e';
const RUN_ID = `cdp-cmds-${Date.now()}`;
const FIXTURE_A = path.join(E2E_ROOT, RUN_ID, 'cwd-a').replace(/\\/g, '/');
const FIXTURE_B = path.join(E2E_ROOT, RUN_ID, 'cwd-b').replace(/\\/g, '/');
const SKILL_A = 'test-cdp-skill-a';
const SKILL_B = 'test-cdp-skill-b';
const SKILL_C = 'test-cdp-skill-c';

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
/** 前置条件不满足：明确「无法执行」并 exit 2（不变成绿色通过）。 */
class PreconditionError extends Error {}
function precondition(cond, message) {
  if (!cond) throw new PreconditionError(message);
}

// ── CDP 基础 ──
async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  const page = targets.find((t) => t.type === 'page');
  return page ?? null;
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

// ── UI 驱动辅助（真实 DOM 操作）──
/** 等待条件成立；超时抛错。 */
async function waitFor(label, fn, timeoutS = 30, intervalMs = 500) {
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

/** 通过侧栏「+ 新会话」按钮真实创建会话；sid 用 listSessions 前后差集识别
 *  （侧栏 unshift 最新在前，与 listSessions 顺序不同；会话可能重名，名字/位置匹配都不可靠）。
 *  2026-09-07 适配（暂态会话，08-28/50e4883 起）：「新会话」= renderer-only 暂态草稿，
 *  不入 listSessions——点击后经 Pinia 直调 materializeActiveTransient 物化（同 id 建 DB 行，
 *  与「发首条消息自动物化」同路径；对齐 cdp-context-e2e 的既有适配）。 */
async function newSessionViaUI(ws) {
  const before = new Set(((await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? []).map((s) => s.id));
  await evalExpr(ws, `document.querySelector('button.new-button')?.click(), true`);
  await waitFor('聊天输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
  const materialized = await evalExpr(ws, `(() => {
    const app = document.querySelector('#app');
    const pinia = app && app.__vue_app__ ? app.__vue_app__.config.globalProperties.$pinia : null;
    const st = pinia && pinia._s ? pinia._s.get('session') : null;
    return st && st.materializeActiveTransient ? st.materializeActiveTransient().then((s) => !!s) : Promise.resolve(false);
  })()`);
  if (!materialized) log('  ℹ 会话未物化（可能已是持久会话——非暂态基线）');
  const sid = await waitFor('新会话出现在 listSessions（差集唯一）', async () => {
    const list = (await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? [];
    const fresh = list.filter((s) => !before.has(s.id));
    return fresh.length === 1 ? fresh[0].id : null;
  }, 30);
  const sessions = (await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? [];
  return { sid, name: sessions.find((s) => s.id === sid)?.name ?? '(未命名)' };
}

/** 通过侧栏会话链接切换会话：按目标会话名字找候选链接，逐一点击并以工作空间按钮
 *  title（= 活跃会话 workingDir，唯一）确认到位——重名会话下仍可确定切换。 */
async function switchSessionViaUI(ws, sid) {
  const sessions = (await evalExpr(ws, `window.claudeLink.listSessions()`)) ?? [];
  const target = sessions.find((s) => s.id === sid);
  if (!target) throw new Error(`listSessions 中未找到会话 ${sid}`);
  if (!target.workingDir) throw new Error(`目标会话 ${sid} 无 workingDir，无法按工作空间消歧（须先设置工作目录）`);
  const candidates = await evalExpr(ws, `[...document.querySelectorAll('.session-link')]
    .map((l, i) => ({ i, name: l.querySelector('.session-link__name')?.textContent?.trim() ?? '' }))
    .filter((x) => x.name === ${JSON.stringify(target.name)})`);
  for (const c of candidates ?? []) {
    await evalExpr(ws, `document.querySelectorAll('.session-link')[${c.i}].click(), true`);
    await waitFor('切换后输入框出现', () => evalOk(ws, `!!document.querySelector('[data-testid="chat-input-textarea"]')`), 15);
    const titles = await evalExpr(ws, `[...document.querySelectorAll('.session-toolbar .ctl__btn')].map((b) => b.getAttribute('title') || '').join('|')`);
    if (String(titles).includes(target.workingDir)) return;
  }
  throw new Error(`未能通过 UI 切换到会话 ${sid}（名字候选 ${(candidates ?? []).length} 个均不匹配 workingDir）`);
}

/** 在 UI 中设置工作目录：播种最近列表（IPC——native 文件夹对话框无法被 CDP 驱动，记录为
 *  UI 路径偏差）→ 离开/回到聊天页使 SessionToolbar 重挂载并加载最近列表 → 打开工作空间
 *  菜单点击「最近使用」中的目标目录（正式切换走真实 UI 路径，经 store 更新按钮与 probe）。 */
async function setWorkingDirViaUI(ws, sid, dir) {
  await evalExpr(ws, `window.claudeLink.addRecentWorkspace(${JSON.stringify(dir)})`);
  // 离开聊天页（/config）再回来——SessionToolbar onMounted 重新 loadRecentWorkspaces。
  await evalExpr(ws, `document.querySelector('.settings-link')?.click(), true`);
  await new Promise((r) => setTimeout(r, 800));
  await evalExpr(ws, `(document.querySelector('.session-link.active') || document.querySelector('.session-link'))?.click(), true`);
  await waitFor('回到聊天页（工具栏出现）', () => evalOk(ws, `!!document.querySelector('.session-toolbar')`), 15);
  // 打开工作空间菜单，点击「最近使用」中的目标目录（真实 UI 路径：chooseRecent → store.setActiveSessionWorkingDir）。
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
  if (!clicked) throw new Error(`「最近使用」菜单中未出现 ${dir}（重挂载后仍未加载）`);
  await waitFor(`工作空间按钮反映 ${dir}`, () => evalOk(ws, `(() => {
    const btns = [...document.querySelectorAll('.session-toolbar .ctl__btn')];
    return btns.some((b) => (b.getAttribute('title') || '') === ${JSON.stringify(dir)});
  })()`), 15);
}

/** 在真实输入框键入文本（focus → 清空 → Input.insertText 触发真实 input 事件 → Vue 渲染菜单）。 */
async function typeInChatInput(ws, text) {
  await evalExpr(ws, `(() => {
    const ta = document.querySelector('[data-testid="chat-input-textarea"]');
    if (!ta) throw new Error('输入框未找到（会话未打开）');
    ta.focus();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await insertText(ws, text);
  await new Promise((r) => setTimeout(r, 300));
}

/** 输入过滤词后读取菜单项。发送消息后父组件异步清空草稿可能覆盖刚输入的文本——
 *  输入后校验 textarea 值，被覆盖则重输一次；仍不符返回 null（外层轮询重试）。 */
async function menuHasItem(ws, commandName) {
  const filter = `/${commandName}`;
  await typeInChatInput(ws, filter);
  let value = await evalExpr(ws, `document.querySelector('[data-testid="chat-input-textarea"]')?.value ?? ''`);
  if (value !== filter) {
    await typeInChatInput(ws, filter);
    value = await evalExpr(ws, `document.querySelector('[data-testid="chat-input-textarea"]')?.value ?? ''`);
    if (value !== filter) return null;
  }
  return readMenuItem(ws, commandName);
}

/** 读取 DOM 菜单项（按 data-command）；返回 { present, badge, name }。 */
async function readMenuItem(ws, commandName) {
  return evalExpr(ws, `(() => {
    const item = document.querySelector('[data-testid="slash-menu-item"][data-command=${JSON.stringify(commandName)}]');
    if (!item) return { present: false, badge: null };
    const badge = item.querySelector('[data-testid="slash-menu-origin"]');
    return { present: true, badge: badge?.textContent?.trim() ?? null };
  })()`);
}

/** 等待主进程命令快照进入 ready 且非空（CLI 已配置的前置证明）。 */
async function waitProbeReady(ws, sid) {
  return waitFor('初始 probe 完成（snapshot ready）', async () => {
    const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    if (snap && snap.status === 'ready' && Array.isArray(snap.commands) && snap.commands.length > 0) return snap;
    return null;
  }, 90, 1000);
}

async function snapshotRevision(ws, sid) {
  const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
  return { source: snap?.source, updatedAt: snap?.updatedAt, count: snap?.commands?.length };
}

/** 通过 UI 发送消息（输入 + 点击发送按钮）。 */
async function sendViaUI(ws, text) {
  await typeInChatInput(ws, text);
  await evalExpr(ws, `document.querySelector('[data-testid="chat-send-button"]')?.click(), true`);
}

/** 发送后等父组件清空草稿（发送已被接受）——避免异步清空与后续输入竞争。 */
async function waitDraftSettled(ws) {
  await waitFor('草稿清空（发送已被接受）', () => evalOk(ws, `(() => { const ta = document.querySelector('[data-testid="chat-input-textarea"]'); return !!ta && ta.value === ''; })()`), 10, 200);
}

function writeSkill(cwd, skillName, description) {
  const dir = path.join(cwd, '.claude', 'skills', skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${skillName} body.\n`, 'utf8');
}
function removeSkill(cwd, skillName) {
  fs.rmSync(path.join(cwd, '.claude', 'skills', skillName), { recursive: true, force: true });
}

// ── 主流程 ──
async function main() {
  console.log('=== CDP Commands E2E（review-v9 §4：renderer DOM 发布级门禁）===');
  log(`runId=${RUN_ID} fixtureRoot=${path.join(E2E_ROOT, RUN_ID)}`);

  const page = await getPageTarget();
  precondition(page, `无法连接 CDP 端口 ${CDP_PORT}——Electron 未以 --remote-debugging-port=${CDP_PORT} 启动（npm run dev:cdp）。无法执行，exit 2。`);
  const ws = await connectWS(page.webSocketDebuggerUrl);
  const hasBridge = await waitFor('preload bridge', () => evalOk(ws, `typeof window.claudeLink === 'object'`), 15).catch(() => false);
  precondition(hasBridge, 'preload bridge (window.claudeLink) 不可用——Electron/preload 未正常启动。无法执行，exit 2。');

  // 夹具：cwd-a 带 skill-a；cwd-b 带独立 skill；延迟 probe 场景用 cwd-a 下后加 skill-c。
  writeSkill(FIXTURE_A, SKILL_A, 'CDP commands-e2e skill A');
  writeSkill(FIXTURE_B, 'test-cdp-iso-fixture', 'CDP commands-e2e isolation fixture');

  const created = [];
  const cleanup = async () => {
    for (const sid of created) {
      try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch { /* ignore */ }
    }
    try { fs.rmSync(path.join(E2E_ROOT, RUN_ID), { recursive: true, force: true }); } catch { /* ignore */ }
    try { ws.close(); } catch { /* ignore */ }
  };

  try {
    // ── 场景 1：真实 UI 建会话 + 切换 workingDir + 初始 probe（CLI 配置前置）──
    let sid1 = null;
    await check('场景1 UI 建会话 + workingDir 切换 + 初始 probe ready（CLI 已配置）', async () => {
      const s = await newSessionViaUI(ws);
      sid1 = s.sid;
      created.push(sid1);
      log(`  ℹ 会话1：name=${s.name} sid=${sid1}`);
      await setWorkingDirViaUI(ws, sid1, FIXTURE_A);
      const snap = await waitProbeReady(ws, sid1);
      log(`  ℹ 初始快照：rev=${JSON.stringify({ source: snap.source, updatedAt: snap.updatedAt, count: snap.commands.length })}`);
    });
    precondition(sid1, '场景1 未取得会话 id——无法继续（exit 2）');

    // ── 场景 2：DOM 菜单出现 skill-a，徽章精确为「项目命令」──
    await check('场景2 DOM 菜单出现 test-cdp-skill-a，徽章文本=「项目命令」', async () => {
      await typeInChatInput(ws, `/${SKILL_A}`);
      const item = await waitFor(`DOM 菜单项 ${SKILL_A}`, () => readMenuItem(ws, SKILL_A).then((r) => (r.present ? r : null)), 30);
      if (item.badge !== '项目命令') {
        throw new Error(`origin 徽章不符：期望「项目命令」，实际 ${JSON.stringify(item.badge)}`);
      }
      // 同时校验 snapshot 的 origin（DOM 与数据源一致）。
      const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid1)})`);
      const cmd = (snap.commands ?? []).find((c) => c.name === SKILL_A);
      if (!cmd || cmd.origin !== 'project') {
        throw new Error(`snapshot origin 不符：期望 project，实际 ${cmd?.origin ?? '缺失'}`);
      }
      log(`  ℹ DOM 项 ${SKILL_A} badge=${item.badge}（snapshot origin=project 一致）`);
    });

    // ── 场景 3：新增 skill-b → UI 发送 /reload-skills → DOM 出现 b ──
    let revAfterAdd = null;
    await check('场景3 新增 skill-b + UI /reload-skills → DOM 菜单出现 b（记录 revision）', async () => {
      writeSkill(FIXTURE_A, SKILL_B, 'CDP commands-e2e skill B');
      await sendViaUI(ws, '/reload-skills');
      const item = await waitFor(`DOM 菜单项 ${SKILL_B}（commands_changed 后菜单刷新）`, async () => { const r = await menuHasItem(ws, SKILL_B); return r?.present ? r : null; }, 60, 1000);
      if (item.badge !== '项目命令') throw new Error(`skill-b 徽章不符：期望「项目命令」，实际 ${JSON.stringify(item.badge)}`);
      revAfterAdd = await snapshotRevision(ws, sid1);
      log(`  ℹ skill-b 出现在 DOM 菜单（badge=${item.badge}）；rev=${JSON.stringify(revAfterAdd)}`);
    });

    // ── 场景 4：删除 skill-b → 再 /reload-skills → DOM b 消失、a 保留、数量符合新快照 ──
    await check('场景4 删除 skill-b + UI /reload-skills → DOM b 消失、a 保留（全量替换不 concat）', async () => {
      const before = await snapshotRevision(ws, sid1);
      removeSkill(FIXTURE_A, SKILL_B);
      await sendViaUI(ws, '/reload-skills');
      await waitDraftSettled(ws);
      await waitFor(`DOM 菜单项 ${SKILL_B} 消失`, async () => {
        const r = await menuHasItem(ws, SKILL_B);
        return r && !r.present ? true : null; // null=输入被草稿清空竞争覆盖，须重试（不得当作缺席）
      }, 60, 1000);
      const after = await snapshotRevision(ws, sid1);
      const itemA = await menuHasItem(ws, SKILL_A);
      if (!itemA?.present) throw new Error(`${SKILL_A} 不应在移除 ${SKILL_B} 后从 DOM 消失`);
      if (after.count == null || before.count == null || after.count !== before.count - 1) {
        // 诊断：转储前后快照差集，定位计数不符的真实来源。
        const namesAfter = await evalExpr(ws, `(window.claudeLink.getSessionCommands(${JSON.stringify(sid1)})?.commands ?? []).map((c) => c.name)`);
        throw new Error(`快照命令数不符全量替换语义：before=${before.count} after=${after.count}（期望 -1）；after 名单=${JSON.stringify(namesAfter)}`);
      }
      log(`  ℹ b 已从 DOM 消失，a 保留；rev=${JSON.stringify(after)}`);
    });

    // ── 场景 5：第二会话（不同 cwd）隔离 + 切回确认 ──
    await check('场景5 会话隔离：会话2 只显示自己的 fixture，切回会话1 再次确认', async () => {
      const s2 = await newSessionViaUI(ws);
      const sid2 = s2.sid;
      created.push(sid2);
      log(`  ℹ 会话2：name=${s2.name} sid=${sid2}`);
      await setWorkingDirViaUI(ws, sid2, FIXTURE_B);
      await waitProbeReady(ws, sid2);
      const own = await waitFor('会话2 DOM 显示自己的 fixture', async () => { const r = await menuHasItem(ws, 'test-cdp-iso-fixture'); return r?.present ? r : null; }, 30);
      if (own.badge !== '项目命令') throw new Error(`会话2 fixture 徽章不符：${JSON.stringify(own.badge)}`);
      const leakA = await menuHasItem(ws, SKILL_A);
      if (leakA?.present) {
        // 诊断：转储 sid2 快照、活跃工作空间、当前菜单全部项与输入框值，定位泄漏来源。
        const snap2 = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid2)})`);
        const titles = await evalExpr(ws, `[...document.querySelectorAll('.session-toolbar .ctl__btn')].map((b) => b.getAttribute('title') || '').join('|')`);
        const names2 = (snap2?.commands ?? []).map((c) => c.name);
        const domDump = await evalExpr(ws, `(() => ({
          menuCount: document.querySelectorAll('[data-testid="slash-menu"]').length,
          taCount: document.querySelectorAll('[data-testid="chat-input-textarea"]').length,
          taValue: document.querySelector('[data-testid="chat-input-textarea"]')?.value ?? null,
          items: [...document.querySelectorAll('[data-testid="slash-menu-item"]')].map((i) => i.dataset.command),
        }))()`);
        throw new Error(`会话2 不应显示会话1 的 ${SKILL_A}（隔离失败）；sid2 快照 count=${names2.length} hasA=${names2.includes(SKILL_A)} hasIso=${names2.includes('test-cdp-iso-fixture')}；titles=${JSON.stringify(titles)}；DOM=${JSON.stringify(domDump)}`);
      }
      // 切回会话1（真实侧栏点击，按 sid + workingDir 消歧）。
      await switchSessionViaUI(ws, sid1);
      const backA = await waitFor('切回会话1 后 DOM 仍显示 skill-a', async () => { const r = await menuHasItem(ws, SKILL_A); return r?.present ? r : null; }, 30);
      const backB = await menuHasItem(ws, SKILL_B);
      if (backB?.present) throw new Error(`切回会话1 后不应显示已删除的 ${SKILL_B}`);
      log(`  ℹ 会话2 显示自有 fixture（badge=${own.badge}）；切回会话1 后 ${SKILL_A} 保留（badge=${backA.badge}）`);
    });

    // ── 场景 6：延迟 probe——probe 未返回前触发 commands_changed，旧 probe 不得回退 DOM ──
    await check('场景6 延迟 probe：commands_changed 先落地，旧 probe 不把 DOM 回退到旧 revision', async () => {
      const s3 = await newSessionViaUI(ws);
      const sid3 = s3.sid;
      created.push(sid3);
      log(`  ℹ 会话3（延迟 probe）：sid=${sid3}`);
      // 先播种 workingDir（新会话 probe 由 workingDir 设置触发，立刻加 skill-c 抢在 probe 返回前）。
      await setWorkingDirViaUI(ws, sid3, FIXTURE_A);
      // 记录本会话全部 commands_changed 推送（断言旧 probe 不回退 + 失败诊断）。
      await evalExpr(ws, `window.__s6Events = []; window.__s6Listener = ((p) => { if (p.sessionId === ${JSON.stringify(sid3)}) window.__s6Events.push({ source: p.snapshot?.source, count: p.snapshot?.commands?.length, hasC: (p.snapshot?.commands ?? []).some((c) => c.name === ${JSON.stringify(SKILL_C)}) }); }); window.claudeLink.onCommandChanged(window.__s6Listener);`);
      writeSkill(FIXTURE_A, SKILL_C, 'CDP commands-e2e skill C (delayed probe)');
      await sendViaUI(ws, '/reload-skills');
      await waitDraftSettled(ws);
      // commands_changed 后 DOM 应出现 skill-c。
      try {
        await waitFor(`DOM 菜单项 ${SKILL_C}（commands_changed）`, async () => { const r = await menuHasItem(ws, SKILL_C); return r?.present ? r : null; }, 90, 1000);
      } catch (e) {
        const evts = await evalExpr(ws, `window.__s6Events`);
        const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid3)})`);
        const msgs = await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid3)})`);
        throw new Error(`${e.message}；诊断：commands_changed 推送=${JSON.stringify(evts)}；快照 source=${snap?.source} count=${snap?.commands?.length} hasC=${(snap?.commands ?? []).some((c) => c.name === SKILL_C)}；消息数=${msgs.length}（末条 ${String(msgs[msgs.length - 1]?.content ?? '').slice(0, 80)}）`);
      }
      const rev = await snapshotRevision(ws, sid3);
      log(`  ℹ skill-c 已出现；rev=${JSON.stringify(rev)}；推送=${JSON.stringify(await evalExpr(ws, `window.__s6Events`))}`);
      // 等 15s：若旧 probe 异步返回，不得把 DOM/快照回退到不含 skill-c 的旧 revision。
      await new Promise((r) => setTimeout(r, 15000));
      const still = await menuHasItem(ws, SKILL_C);
      if (!still?.present) throw new Error('skill-c 从 DOM 消失——旧 probe 把快照回退到旧 revision（revision guard 失效）');
      const rev2 = await snapshotRevision(ws, sid3);
      const snapNow = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid3)})`);
      const cmdC = (snapNow.commands ?? []).find((c) => c.name === SKILL_C);
      if (!cmdC) throw new Error(`快照回退：${SKILL_C} 不在当前 snapshot（rev=${JSON.stringify(rev2)}）`);
      log(`  ℹ 15s 后 skill-c 仍在 DOM 与快照；rev=${JSON.stringify(rev2)}`);
      removeSkill(FIXTURE_A, SKILL_C);
      await sendViaUI(ws, '/reload-skills');
      await waitDraftSettled(ws);
      await waitFor('清理：skill-c 从 DOM 消失', async () => {
        const r = await menuHasItem(ws, SKILL_C);
        return r && !r.present ? true : null;
      }, 60, 1000);
    });
  } finally {
    await cleanup();
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
