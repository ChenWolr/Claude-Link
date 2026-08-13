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

  // Cleanup
  if (sid) {
    try { await evalExpr(ws, `window.claudeLink.deleteSession(${JSON.stringify(sid)})`); } catch {}
  }

  ws.close();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e.message);
  process.exit(1);
});
