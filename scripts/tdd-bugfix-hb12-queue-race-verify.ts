// scripts/tdd-bugfix-hb12-queue-race-verify.ts
// hb12 P2-11【队列批】契约：出队谓词纳入直发在飞 + 归零重试重排（hb12-QUE-01 独立立项）。
//
// 病根：出队守卫不含 chatSendLocks（ipc:77 对引擎不可见）；用户带附件直发的 prepare await
// 窗口内 entries 为空 → mainTimer 归零放行 → spawnForTask 覆盖/被拒误报。违背队列语义 #4。
// 修法：① chatSendLocks 下沉 chat-send-locks（无环）；② 共享谓词 isUserTurnInFlight =
// chatSendLocks ∪ pendingFirstPrompt ∪ active entry；③ mainTimer 归零命中谓词改 ~1s 短延迟
// 重试重排（不可放弃）；④ runTaskNow 守卫同步纳入谓词。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-queue-race-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const locks = read('src/main/modules/chat-send-locks.ts');
const backend = read('src/main/modules/sdk-backend.ts');
const engine = read('src/main/modules/task-queue-engine.ts');
const handlers = read('src/main/ipc-handlers.ts');
const chatBackend = read('src/main/modules/chat-backend.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 锁下沉模块。
check('① chat-send-locks 模块：isChatSendLocked/acquire/release 三导出；ipc-handlers 换用', () => {
  assert.match(locks, /export function isChatSendLocked\(/, '缺查询');
  assert.match(locks, /export function acquireChatSendLock\(/, '缺加锁');
  assert.match(locks, /export function releaseChatSendLock\(/, '缺释放');
  assert.ok(handlers.includes('acquireChatSendLock(sessionId);'), 'CHAT_SEND 未换加锁');
  assert.ok(handlers.includes('releaseChatSendLock(sessionId);'), 'finally 未换释放');
  assert.ok(handlers.includes('isChatSendLocked(sessionId) || getActiveProcess(sessionId)'), 'CHAT_SEND 守卫未换谓词');
  assert.ok(!handlers.includes('const chatSendLocks'), 'ipc-handlers 残留本地锁 Set');
});

// ② 谓词。
check('② 引擎谓词 isUserTurnInFlight：chatSendLocks ∪ pendingFirstPrompt ∪ active entry', () => {
  assert.match(engine, /function isUserTurnInFlight\(sessionId: string\): boolean \{/, '缺谓词');
  const idx = engine.indexOf('function isUserTurnInFlight');
  const body = engine.slice(idx, engine.indexOf('\n}', idx));
  assert.match(body, /isChatSendLocked\(sessionId\)/, '谓词缺锁');
  assert.match(body, /hasPendingFirstPrompt\(sessionId\)/, '谓词缺 pending');
  assert.match(body, /getActiveProcess\(sessionId\)/, '谓词缺 active');
  assert.match(chatBackend, /export \{ isChatSendLocked \} from '\.\/chat-send-locks';/, 'chat-backend 缺再导出');
  assert.match(backend, /export function hasPendingFirstPrompt\(/, 'backend 缺 pending 查询导出');
});

// ③ mainTimer 归零命中短延迟重试。
check('③ mainTimer 归零：直发在飞命中 → ~1s 短延迟重试重排（不放弃）', () => {
  assert.match(engine, /hb12-P2-11：直发在飞（谓词含 chatSendLocks\/pendingFirstPrompt）→ ~1s 短延迟重试重排/, '缺重排注释');
  const idx = engine.indexOf('hb12-P2-11：直发在飞');
  const body = engine.slice(idx, idx + 1800);
  assert.match(body, /isChatSendLocked\(sessionId\) \|\| hasPendingFirstPrompt\(sessionId\)/, '归零回调缺谓词判据');
  assert.match(body, /setTimeout\(/, '缺重试 timer');
  assert.match(body, /popExecute\(sessionId, mainWindow, runnable\[0\]\)/, '重试缺出队');
});

// ④ runTaskNow。
check('④ runTaskNow 守卫纳入谓词', () => {
  const idx = engine.indexOf('export function runTaskNow');
  const body = engine.slice(idx, engine.indexOf('\n}', idx));
  assert.match(body, /isUserTurnInFlight\(task\.sessionId\)/, 'runTaskNow 缺谓词');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
