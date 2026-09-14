// scripts/tdd-bugfix-hb10-perm-plan-allowbook-verify.ts
// hb10 P2-2（PERM-01）契约：会话 allow-book 不随权限档失效（plan 档越权）。
//
// 病根：isToolSessionAllowed 短路无档位判断——plan 档会话里「本会话总是允许」记下的裸 allow
// 规则静默放行编辑类工具，绕过 plan 档「任何工具都走弹窗终审」的产品语义。
// 修法三件：
//   ① sdk-backend 新增导出 clearSessionPermissionBook(sessionId)（清 sessionPermissionUpdates 键）；
//   ② CHAT_SET_PERMISSION_MODE 档位变更成功后调用它——切档即失效本会话记忆的全部 allow-session 放行；
//   ③ createPermissionHandler 短路点加档位守卫：有效档为 plan 时跳过短路（plan 档任何工具走弹窗）；
//     default/acceptEdits/bypass 维持既有短路体验。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-perm-plan-allowbook-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① clearSessionPermissionBook 导出。
check('① sdk-backend 导出 clearSessionPermissionBook（删 sessionPermissionUpdates 对应键）', () => {
  assert.match(backend, /export function clearSessionPermissionBook\(sessionId: string\): void/, '缺导出函数');
  const idx = backend.indexOf('export function clearSessionPermissionBook');
  const body = backend.slice(idx, backend.indexOf('\n}', idx));
  assert.match(body, /sessionPermissionUpdates\.delete\(sessionId\)/, '函数体缺 sessionPermissionUpdates.delete');
});

// ② CHAT_SET_PERMISSION_MODE 成功后清账。
check('② CHAT_SET_PERMISSION_MODE：变更成功后调用 clearSessionPermissionBook', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.CHAT_SET_PERMISSION_MODE');
  assert.ok(idx > -1, '未找到 CHAT_SET_PERMISSION_MODE handler');
  const body = handlers.slice(idx, handlers.indexOf('ipcMain.handle', idx + 10) > -1 ? handlers.indexOf('ipcMain.handle', idx + 10) : undefined);
  assert.match(body, /clearSessionPermissionBook\(sessionId\)/, 'handler 缺 clearSessionPermissionBook 调用');
  const effIdx = body.indexOf('setRunningQueryPermissionMode(sessionId, effective)');
  const clearIdx = body.indexOf('clearSessionPermissionBook(sessionId)');
  assert.ok(effIdx > -1 && clearIdx > effIdx, '清账必须位于档位变更之后（先变更后失效）');
});

// ③ 短路点 plan 档守卫。
check('③ createPermissionHandler 短路点：plan 档守卫（有效档=plan 时跳过短路，工具走弹窗终审）', () => {
  const idx = backend.indexOf('function createPermissionHandler');
  const body = backend.slice(idx, idx + 6000);
  const planIdx = body.indexOf("resolveEffectivePermissionMode(sessionRepo.getSession(sessionId)?.permissionMode ?? null, getConfig().permissionMode) === 'plan'");
  assert.ok(planIdx > -1, '短路点缺 plan 档判据（resolveEffectivePermissionMode 会话档×全局默认）');
  const allowedIdx = body.indexOf('isToolSessionAllowed(sessionBook, toolName)');
  assert.ok(allowedIdx > planIdx, 'plan 判据必须先于 isToolSessionAllowed 短路求值');
  assert.match(body, /sessionAllowed = !planGated && options\.agentID == null && isToolSessionAllowed/, 'sessionAllowed 缺 planGated 守卫（plan 档静默放行未堵）');
  // 非 plan 档短路行为不变：agentID 守卫与短路 allow 返回形态保持。
  assert.match(body, /if \(sessionAllowed\) \{\s*return \{ behavior: 'allow', updatedInput: input, toolUseID: options\.toolUseID \};/, '非 plan 档短路 allow 形态被破坏');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
