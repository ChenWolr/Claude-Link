// scripts/tdd-bugfix-hb10-queue-race-verify.ts
// hb10 P2-1（ENG-01+QUE-04）契约：队列出队覆盖用户活动 entry 的双保险修复。
//
// 病根：popExecute 的 await prepareAttachmentPrompt 后无占坑复查；spawnForTask 无 blocking 检查
// 直接 entries.set。用户带附件直发的 prepare await 窗口内，队列任务出队会覆盖用户 entry——
// 用户回合被顶掉、消息误报「当前回合仍在执行」。
// 修法（双保险）：
//   ① spawnForTask 内、entries.set 之前，复制 spawnForChat 的占坑检查（在途即抛错，不覆盖）；
//   ② popExecute 的 prepare await 返回后补复查：占坑被用户回合占据 → 撤账回滚（清 currentTaskId +
//      任务回 pending + running 归属保留给在飞回合，hb13-v A1/F4 改钉：不收口 standby），不
//      spawn；task_started/历史 unshift/DB running 落库全部挪到复查之后（避免先广播后撤回）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-queue-race-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const engine = read('src/main/modules/task-queue-engine.ts');
const backend = read('src/main/modules/sdk-backend.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

function fnBody(src: string, head: string): string {
  const idx = src.indexOf(head);
  assert.ok(idx > -1, `未找到 ${head}`);
  const end = src.indexOf('\n}', idx);
  return src.slice(idx, end > -1 ? end : undefined);
}

// ① spawnForTask：占坑检查（双保险之外保险）。
check('① spawnForTask：entries.set 前含占坑检查（pendingFirstPrompt/isEntryActive → 抛错不覆盖）', () => {
  const body = fnBody(backend, 'export function spawnForTask');
  const checkIdx = body.indexOf('pendingFirstPrompt.has(sessionId) || isEntryActive(blocking)');
  const setIdx = body.indexOf('entries.set(sessionId, entry)');
  assert.ok(checkIdx > -1, 'spawnForTask 缺占坑检查（对齐 spawnForChat 语义）');
  assert.ok(setIdx > checkIdx, '占坑检查必须位于 entries.set 之前');
  assert.match(body, /当前回合仍在执行/, '占坑命中缺「当前回合仍在执行」失败形态');
  assert.match(body, /const blocking = entries\.get\(sessionId\)/, '缺 blocking 读取');
});

// ② popExecute：prepare await 后的占坑复查（主保险）。
check('② popExecute：prepare 后复查 getActiveProcess → 撤账（清 currentTaskId + 任务回 pending，不广播 task_settled）', () => {
  const body = fnBody(engine, 'async function popExecute');
  const prepareIdx = body.indexOf('prepareAttachmentPrompt');
  const recheckIdx = body.indexOf('占坑复查');
  assert.ok(recheckIdx > prepareIdx, '复查必须位于 prepare await 之后');
  const guardIdx = body.indexOf('getActiveProcess(sessionId)', recheckIdx);
  assert.ok(guardIdx > -1, '复查缺 getActiveProcess 判据');
  const clearIdx = body.indexOf('state.currentTaskId = null', recheckIdx);
  assert.ok(clearIdx > guardIdx, '复查命中缺 currentTaskId 撤账');
  const backIdx = body.indexOf("updateTaskStatus(task.id, 'pending')", recheckIdx);
  assert.ok(backIdx > clearIdx, '复查命中缺任务回 pending');
  const seg = body.slice(recheckIdx, backIdx + 200);
  assert.ok(!seg.includes("emitQueueEvent(mainWindow, sessionId, 'task_settled'"), '撤回路径不得 emit task_settled（其 markStopped 副作用会误停用户回合 sending 态）');
});

// ③ 广播后移：task_started / 历史 unshift / DB running 落库均在复查之后。
check('③ task_started 事件、历史 unshift、DB running 落库全部位于占坑复查之后（不先广播后撤回）', () => {
  const body = fnBody(engine, 'async function popExecute');
  const recheckIdx = body.indexOf('占坑复查');
  assert.ok(recheckIdx > -1, '未找到占坑复查段');
  const startedIdx = body.indexOf("emitQueueEvent(mainWindow, sessionId, 'task_started'");
  const unshiftIdx = body.indexOf("history.unshift({");
  const dbRunningIdx = body.indexOf("updateTaskStatus(task.id, 'running')");
  assert.ok(startedIdx > recheckIdx, 'task_started 事件仍在复查之前发出（先广播后撤回）');
  assert.ok(unshiftIdx > recheckIdx, '历史 unshift 仍在复查之前（撤回须移除本条 running 记录）');
  assert.ok(dbRunningIdx > recheckIdx, 'DB running 落库仍在复查之前（撤回后 DB 残留 running）');
});

// ④ 复查命中归属保留（hb13-v A1/F4 改钉）：running 归属保留给在飞回合，不收口 standby——
// 旧实现（本契约曾钉为正确）复查命中收口 standby 会剥夺 beginUserTurn 已归属用户回合的
// running，回合结束 noteTurnOutcome 的 running 闸直接 return → armAfterTurn/haltQueue 双跳过，
// 队列静默停摆。正确形态：清 currentTaskId + 任务回 pending 原位，回合结束经
// noteTurnOutcome→armAfterTurn 正常再 arm。
check('④ 复查命中：不收口 standby（running 归属保留给在飞回合）+ currentTaskId 撤账 + 任务回 pending', () => {
  const body = fnBody(engine, 'async function popExecute');
  const recheckIdx = body.indexOf('占坑复查');
  assert.ok(recheckIdx > -1, '未找到占坑复查段');
  const rollbackIdx = body.indexOf('popExecute rollback', recheckIdx);
  assert.ok(rollbackIdx > -1, '未找到复查回滚日志锚点');
  const seg = body.slice(recheckIdx, rollbackIdx);
  assert.ok(!seg.includes("state.status = 'standby'"), '复查命中收口 standby（剥夺在飞回合归属，hb13-v F4 缺陷形态）');
  assert.match(seg, /state\.currentTaskId = null/, '复查命中缺 currentTaskId 撤账');
  assert.match(seg, /updateTaskStatus\(task\.id, 'pending'\)/, '复查命中缺任务回 pending');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
