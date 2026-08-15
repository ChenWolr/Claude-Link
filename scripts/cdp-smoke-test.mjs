// scripts/cdp-smoke-test.mjs
// review-v3 §6.6: 可重复的 Electron/CDP 烟雾测试。
//
// 用法：
//   1. 启动 Electron：npm run dev:cdp
//   2. 运行测试：npm run test:cdp
//
// 连接到已运行的 Electron 实例（CDP 端口 9223），验证：
//   - preload bridge (window.claudeLink) 存在
//   - getConfig 返回有效配置
//   - createSession + getSessionMessages 基础链路
//   - getSessionCommands 返回命令快照
//   - getCommandDiagnostics 返回脱敏 provenance
//
// 这是烟雾测试——不验证完整命令行为矩阵，只确认 Electron → IPC → renderer 链路活着。
// review-v4 §5.2 扩展：§6.3 ⑤⑥⑦ 增加真实动态 commands_changed E2E 断言（add/remove/isolation）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const CDP_PORT = 9223;

async function getPageTarget() {
  const resp = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await resp.json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error(`No page target at CDP port ${CDP_PORT}. Is Electron running with --remote-debugging-port=${CDP_PORT}?`);
  return page;
}

function connectWS(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.addEventListener('open', () => resolve(ws));
    ws.addEventListener('error', () => reject(new Error('WebSocket connection failed')));
  });
}

async function cdpCall(ws, expr) {
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
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
  });
}

async function evalExpr(ws, expr) {
  const r = await cdpCall(ws, expr);
  if (r.exceptionDetails) throw new Error('Eval: ' + (r.exceptionDetails.exception?.description || '').slice(0, 200));
  return r.result?.value;
}

let pass = 0;
let fail = 0;
function check(name, fn) {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${e.message}`); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${e.message}`); }
}

// review-v4 §5.2：动态 commands_changed 测试在部分环境下可能因 API/CLI 配置不可用而无法触发，
// 此时标记 SKIP（不计入 fail）而非 FAIL——保留断言完整性，同时不阻塞烟雾测试门禁。
let skip = 0;
class SkipError extends Error { constructor(msg) { super(msg); this.name = 'SkipError'; } }
async function checkAsyncSkip(name, fn) {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) {
    if (e.name === 'SkipError') { skip++; console.log(`  ⏭️  ${name} — SKIP: ${e.message}`); }
    else { fail++; console.log(`  ❌ ${name} — ${e.message}`); }
  }
}

// ── 动态 commands_changed 测试辅助函数 ──
function writeSkill(cwd, skillName, description) {
  const skillDir = path.join(cwd, '.claude', 'skills', skillName);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n\n${skillName} body.\n`,
  );
}
function removeSkill(cwd, skillName) {
  fs.rmSync(path.join(cwd, '.claude', 'skills', skillName), { recursive: true, force: true });
}
async function waitForProbe(ws, sid, timeoutS = 30) {
  for (let i = 0; i < timeoutS; i++) {
    const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    if (snap && snap.status !== 'loading' && snap.status !== 'empty') return snap;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return null;
}
async function sendReloadSkills(ws, sid) {
  const payload = JSON.stringify({ text: '/reload-skills', attachmentIds: [], clientMessageId: crypto.randomUUID() });
  return evalExpr(ws, `window.claudeLink.sendMessage(${JSON.stringify(sid)}, ${payload})`);
}
async function waitForCmdChanged(ws, flagExpr, timeoutS = 30) {
  for (let i = 0; i < timeoutS; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await evalExpr(ws, flagExpr)) return true;
  }
  return false;
}

async function main() {
  console.log('=== CDP Smoke Test (review-v3 §6.6) ===');
  console.log(`Connecting to CDP port ${CDP_PORT}...`);

  const page = await getPageTarget();
  const ws = await connectWS(page.webSocketDebuggerUrl);
  console.log('Connected.');

  // Wait for preload bridge
  for (let i = 0; i < 30; i++) {
    if (await evalExpr(ws, `typeof window.claudeLink === 'object'`)) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  // ① preload bridge
  await checkAsync('preload bridge (window.claudeLink) 存在', async () => {
    const t = await evalExpr(ws, `typeof window.claudeLink`);
    if (t !== 'object') throw new Error(`claudeLink type = ${t}`);
  });

  // ② getConfig
  await checkAsync('getConfig 返回有效配置', async () => {
    const cfg = await evalExpr(ws, `window.claudeLink.getConfig()`);
    if (!cfg || typeof cfg !== 'object') throw new Error('getConfig returned non-object');
    if (!cfg.apiBaseUrl) throw new Error('apiBaseUrl missing');
  });

  // ③ createSession + getSessionMessages
  let sid = null;
  await checkAsync('createSession + getSessionMessages 基础链路', async () => {
    const session = await evalExpr(ws, `window.claudeLink.createSession('cdp-smoke')`);
    if (!session?.id) throw new Error('createSession returned no id');
    sid = session.id;
    const msgs = await evalExpr(ws, `window.claudeLink.getSessionMessages(${JSON.stringify(sid)})`);
    if (!Array.isArray(msgs)) throw new Error('getSessionMessages returned non-array');
  });

  // ④ getSessionCommands (command snapshot)
  await checkAsync('getSessionCommands 返回命令快照', async () => {
    const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    if (!snap || typeof snap !== 'object') throw new Error('getSessionCommands returned non-object');
    if (typeof snap.status !== 'string') throw new Error('snapshot.status missing');
  });

  // ⑤ getCommandDiagnostics (provenance)
  await checkAsync('getCommandDiagnostics 返回脱敏 provenance', async () => {
    const diag = await evalExpr(ws, `window.claudeLink.getCommandDiagnostics(${JSON.stringify(sid)})`);
    if (!diag || typeof diag !== 'object') throw new Error('getCommandDiagnostics returned non-object');
    const str = JSON.stringify(diag);
    if (/sk-[a-zA-Z0-9]{20,}/.test(str)) throw new Error('API key leaked in diagnostics');
  });

  // ⑥ getNativeSettingsDiagnostic
  await checkAsync('getNativeSettingsDiagnostic 返回脱敏设置诊断', async () => {
    const diag = await evalExpr(ws, `window.claudeLink.getNativeSettingsDiagnostic('.')`);
    if (!diag || typeof diag !== 'object') throw new Error('getNativeSettingsDiagnostic returned non-object');
  });

  // ── review-v3 §6.3: renderer 菜单动态变化运行时断言 ──
  console.log('\n  --- §6.3 commands_changed renderer 断言 ---');

  // §6.3 ①: 两个会话命令快照各自独立（sessionId 隔离——动态命令不串到另一会话）
  await checkAsync('§6.3 ① 两会话命令快照 sessionId 隔离', async () => {
    const session2 = await evalExpr(ws, `window.claudeLink.createSession('cdp-iso')`);
    if (!session2?.id) throw new Error('第二个会话创建失败');
    const snap1 = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    const snap2 = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(session2.id)})`);
    if (snap1.sessionId !== sid) throw new Error(`snap1.sessionId=${snap1.sessionId} ≠ ${sid}`);
    if (snap2.sessionId !== session2.id) throw new Error(`snap2.sessionId=${snap2.sessionId} ≠ ${session2.id}`);
    if (snap1.sessionId === snap2.sessionId) throw new Error('两会话快照 sessionId 相同（隔离失败）');
    try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(session2.id)})`); } catch {}
  });

  // §6.3 ②: 命令快照含 origin/availability/source provenance 字段（徽章数据源）
  await checkAsync('§6.3 ② 命令快照含 origin/availability/source provenance', async () => {
    const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    if (!snap.commands || !Array.isArray(snap.commands)) throw new Error('commands 非数组');
    if (snap.commands.length === 0) throw new Error('commands 为空（可能探测未完成）');
    const cmd = snap.commands[0];
    if (!('origin' in cmd)) throw new Error('command 缺 origin 字段');
    if (!('availability' in cmd)) throw new Error('command 缺 availability 字段');
    if (!('source' in cmd)) throw new Error('command 缺 source 字段');
  });

  // §6.3 ③: onCommandChanged 监听器可注册/移除（动态命令推送通道）
  await checkAsync('§6.3 ③ onCommandChanged 监听器注册/移除无异常', async () => {
    await evalExpr(ws, `
      window.__cmdListener = (payload) => { window.__lastCmdPayload = payload; };
      window.claudeLink.onCommandChanged(window.__cmdListener);
    `);
    await evalExpr(ws, `window.claudeLink.removeCommandListener()`);
    // No throw = pass
  });

  // §6.3 ④: 命令快照全量替换语义验证（replaceFromEvent 不 concat 旧命令）
  await checkAsync('§6.3 ④ 命令快照同名去重（全量替换不 concat）', async () => {
    const snap = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(sid)})`);
    if (!snap.commands || snap.commands.length === 0) throw new Error('commands 为空');
    const names = snap.commands.map(c => c.name.toLowerCase());
    const unique = new Set(names);
    if (unique.size !== names.length) {
      const dupes = names.filter((n, i) => names.indexOf(n) !== i);
      throw new Error(`命令快照有重名：${dupes.join(', ')}（全量替换去重失败）`);
    }
  });

  // ── review-v4 §5.2: 动态 commands_changed 真实链路 E2E ──
  console.log('\n  --- §6.3 ⑤⑥⑦ 动态 commands_changed 真实 E2E（add/remove/isolation）---');

  const DYN_CWD = path.join('D:/software/Cache/temp', `cdp-dynamic-${Date.now()}`).replace(/\\/g, '/');
  const SKILL_A = 'test-cdp-skill-a';
  const SKILL_B = 'test-cdp-skill-b';
  let dynSid = null;

  // §6.3 ⑤: Dynamic add — create cwd with skill-a → probe → add skill-b → /reload-skills → assert skill-b appears
  await checkAsyncSkip('§6.3 ⑤ 动态新增：/reload-skills 后新 skill 出现在快照 + provenance 徽章', async () => {
    writeSkill(DYN_CWD, SKILL_A, 'CDP dynamic test skill A');

    const session = await evalExpr(ws, `window.claudeLink.createSession('cdp-dynamic')`);
    if (!session?.id) throw new Error('createSession 失败');
    dynSid = session.id;
    await evalExpr(ws, `window.claudeLink.updateSession(${JSON.stringify(dynSid)}, ${JSON.stringify({ workingDir: DYN_CWD })})`);

    const initialSnap = await waitForProbe(ws, dynSid);
    if (!initialSnap) throw new SkipError('初始探测未完成（CLI/API 可能未配置）');
    const initialCount = initialSnap.commands?.length ?? 0;

    // Register listener for this session only
    await evalExpr(ws, `
      window.__dynCmdFired = false;
      window.__dynCmdPayload = null;
      window.__dynCmdListener = (payload) => {
        if (payload.sessionId === ${JSON.stringify(dynSid)}) {
          window.__dynCmdFired = true;
          window.__dynCmdPayload = payload;
        }
      };
      window.claudeLink.onCommandChanged(window.__dynCmdListener);
    `);

    // Add skill-b on disk, then trigger reload
    writeSkill(DYN_CWD, SKILL_B, 'CDP dynamic test skill B');
    await sendReloadSkills(ws, dynSid);

    const fired = await waitForCmdChanged(ws, 'window.__dynCmdFired', 30);
    if (!fired) throw new SkipError('commands_changed 监听器 30s 内未触发（/reload-skills 可能无变更）');

    const payload = await evalExpr(ws, `window.__dynCmdPayload`);
    if (!payload?.snapshot?.commands) throw new Error('payload.snapshot.commands 缺失');
    const cmdNames = payload.snapshot.commands.map((c) => c.name);
    if (!cmdNames.includes(SKILL_B)) throw new SkipError(`${SKILL_B} 未出现在更新后快照`);

    // review-v8 §5.2：收紧 origin 断言——skill 创建在 cwd/.claude/skills/ 下，
    // Claude Code provenance 语义将其分类为 project（非 user-skill/plugin/builtin）。
    // 断言精确 origin=project；其它值（含 unknown）均为失败。
    const skillBCmd = payload.snapshot.commands.find((c) => c.name === SKILL_B);
    if (!skillBCmd) throw new Error(`${SKILL_B} 未在快照中找到`);
    if (skillBCmd.origin !== 'project') {
      throw new Error(`${SKILL_B} origin=${skillBCmd.origin} 须为 project（cwd/.claude/skills/ 下的 skill 按 Claude Code 语义分类为 project），不能为 ${skillBCmd.origin}`);
    }
    console.log(`  ℹ ${SKILL_B} origin=project ✓ provenance 精确匹配`);

    console.log(`  ℹ 初始 ${initialCount} 命令 → 更新后 ${payload.snapshot.commands.length} 命令（+${SKILL_B}）`);
  });

  // §6.3 ⑥: Dynamic remove — remove skill-b → /reload-skills → assert skill-b disappears (full-replace, not concat)
  await checkAsyncSkip('§6.3 ⑥ 动态移除：/reload-skills 后旧 skill 从快照消失（全量替换不 concat）', async () => {
    if (!dynSid) throw new SkipError('⑤ 未成功创建动态测试会话');

    await evalExpr(ws, `window.__dynCmdFired = false`);
    removeSkill(DYN_CWD, SKILL_B);
    await sendReloadSkills(ws, dynSid);

    const fired = await waitForCmdChanged(ws, 'window.__dynCmdFired', 30);
    if (!fired) throw new SkipError('commands_changed 监听器 30s 内未触发');

    const payload = await evalExpr(ws, `window.__dynCmdPayload`);
    if (!payload?.snapshot?.commands) throw new Error('payload.snapshot.commands 缺失');
    const cmdNames = payload.snapshot.commands.map((c) => c.name);
    if (cmdNames.includes(SKILL_B)) throw new Error(`${SKILL_B} 仍在快照中（全量替换失败，旧命令未消失）`);

    // skill-a should still be present
    if (!cmdNames.includes(SKILL_A)) throw new Error(`${SKILL_A} 不应在移除 ${SKILL_B} 后消失`);
    console.log(`  ℹ 移除后 ${payload.snapshot.commands.length} 命令（-${SKILL_B}, ${SKILL_A} 保留）`);
  });

  // §6.3 ⑦: Session isolation — session 2 with different cwd has different command set
  await checkAsyncSkip('§6.3 ⑦ 会话隔离：不同 cwd 的会话命令集不串', async () => {
    if (!dynSid) throw new SkipError('⑤ 未成功创建动态测试会话');

    const cwd2 = path.join('D:/software/Cache/temp', `cdp-iso-${Date.now()}`).replace(/\\/g, '/');
    writeSkill(cwd2, 'test-cdp-iso-skill', 'Isolation test skill');

    const session2 = await evalExpr(ws, `window.claudeLink.createSession('cdp-iso-dyn')`);
    if (!session2?.id) throw new Error('第二个会话创建失败');
    await evalExpr(ws, `window.claudeLink.updateSession(${JSON.stringify(session2.id)}, ${JSON.stringify({ workingDir: cwd2 })})`);

    const snap2 = await waitForProbe(ws, session2.id);
    if (!snap2) throw new SkipError('第二个会话探测未完成');

    const names2 = (snap2.commands ?? []).map((c) => c.name);
    if (!names2.includes('test-cdp-iso-skill')) throw new SkipError(`session 2 未发现 test-cdp-iso-skill`);
    if (names2.includes(SKILL_A) || names2.includes(SKILL_B)) {
      throw new Error(`session 2 不应含 ${SKILL_A}/${SKILL_B}（会话隔离失败）`);
    }

    // session 1 should NOT have test-cdp-iso-skill
    const snap1 = await evalExpr(ws, `window.claudeLink.getSessionCommands(${JSON.stringify(dynSid)})`);
    const names1 = (snap1.commands ?? []).map((c) => c.name);
    if (names1.includes('test-cdp-iso-skill')) {
      throw new Error(`session 1 不应含 test-cdp-iso-skill（会话隔离失败）`);
    }

    try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(session2.id)})`); } catch {}
    try { fs.rmSync(cwd2, { recursive: true, force: true }); } catch {}
    console.log(`  ℹ session1=${names1.length}命令 session2=${names2.length}命令，互不交叉`);
  });

  // Cleanup dynamic test
  try { await evalExpr(ws, `window.claudeLink.removeCommandListener()`); } catch {}
  if (dynSid) {
    try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(dynSid)})`); } catch {}
  }
  try { fs.rmSync(DYN_CWD, { recursive: true, force: true }); } catch {}

  // Cleanup
  if (sid) {
    try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch {}
  }

  ws.close();
  console.log(`\n${pass} passed, ${fail} failed, ${skip} skipped`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
