// scripts/tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts
// hb10 P3 ENG 批 + TM 批契约（ENG-02/04/05/06/07/10/12、TM-01/03/04/05/06/07、OPT-1）。
// （ENG-03/09 已并入 hb10-session-p3 契约；ENG-08 按 hb12 §1.2 降级卫生项跳过；
//   ENG-V01 按 hb12 §3 P2-2 改写版实施，随 hb12-exit-classify 契约验收。）
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const chat = read('src/renderer/composables/use-chat.ts');
const retry = read('src/main/modules/reasoning-replay-auto-retry.ts');
const cliShared = read('src/main/modules/cli-shared.ts');
const msgRepo = read('src/main/database/repositories/message-repo.ts');
const handlers = read('src/main/ipc-handlers.ts');
const fmt = read('src/shared/format-duration.ts');
const bubble = read('src/renderer/components/chat/MessageBubble.vue');
const turnTimer = read('src/renderer/components/chat/TurnTimer.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① ENG-02：turn-usage 裸 send 包 try。
check('① ENG-02：turn-usage CONTEXT_UPDATE send 包 try（窗口销毁不劫持调用链）', () => {
  const sendIdx = backend.indexOf('mainWindow.webContents.send(IPC_CHANNELS.CONTEXT_UPDATE, payload);');
  const cacheIdx = backend.indexOf('缓存最近一次 turn usage 供诊断');
  assert.ok(sendIdx > -1 && cacheIdx > sendIdx && cacheIdx - sendIdx < 400, '未定位 turn-usage send');
  const tryIdx = backend.lastIndexOf('try {', sendIdx);
  assert.ok(tryIdx > -1 && sendIdx - tryIdx < 300, 'turn-usage send 缺 try 包裹');
});

// ② ENG-04：watchdog 误报横幅回收。
check('② ENG-04：watchdog 横幅置位记录 + ≤6s 优雅窗成功 result 清除', () => {
  assert.match(chat, /WATCHDOG_ERROR_GRACE_MS = 6000/, '缺 6s 优雅窗常量');
  assert.match(chat, /watchdogErrorAt = Date\.now\(\)/, '缺置位时刻记录');
  assert.match(chat, /判定模型服务卡死/, '误报文案谓词缺失');
  const resultIdx = chat.indexOf("isSuccessfulCliResult(event) && isWatchdogErrorText(error.value)");
  assert.ok(resultIdx > -1, 'result 分支缺误报清除');
});

// ③ ENG-05：resendUserText 落库后补 persisted_message 推送。
check('③ ENG-05：resendUserText 落库后补 persisted_message 推送（重发气泡立即可见）', () => {
  // hb13-v 批C 清理：原 `chat.indexOf === undefined ? -1 : ...` 三元恒取右支（死条件）。
  const idx = backend.indexOf('resendUserText: (text) => {');
  const body = backend.slice(idx, backend.indexOf('sendMessage(sessionId, text);', idx));
  assert.match(body, /event: \{ type: 'persisted_message', message: persisted \}/, '缺 persisted_message 推送');
  const createIdx = body.indexOf('messageRepo.createMessage');
  const pushIdx = body.indexOf("type: 'persisted_message'");
  assert.ok(createIdx > -1 && pushIdx > createIdx, '推送必须位于落库之后');
});

// ④ ENG-06：闩发起时置位。
check('④ ENG-06：防重入闩在 setTimeout 回调内实际发起时置位（放弃的调度不占闩）', () => {
  const schedIdx = retry.indexOf('export function maybeScheduleReasoningReplayRetry');
  const body = retry.slice(schedIdx);
  const setIdx = body.indexOf('retriedTextBySession.set(sessionId, text)');
  const timerIdx = body.indexOf('const timer = setTimeout(');
  assert.ok(setIdx > timerIdx, '闩仍在调度时置位（放弃的调度占闩）');
  assert.match(body, /if \(pendingTimers\.has\(sessionId\)\) return;/, '缺 pending 判重（双调度防）');
  assert.match(body, /if \(pendingTimers\.has\(sessionId\)\) return;/, '缺 pending 判重（双调度防）');
});

// ⑤ ENG-07：resume 重试补 resetStallTracker。
check('⑤ ENG-07：resume 重试二次起步补 resetStallTracker（stall 计时不跨 query）', () => {
  const idx = backend.indexOf('resume 重试：旧会话 id 已清除');
  const seg = backend.slice(idx - 1200, idx);
  assert.match(seg, /resetStallTracker\(sessionId\);/, 'resume 重试缺 resetStallTracker');
  const resetIdx = seg.indexOf('resetStallTracker(sessionId);');
  const clearIdx = seg.indexOf('clearReasoningReplayTurnFlag(sessionId);');
  assert.ok(resetIdx > -1 && clearIdx > -1 && resetIdx > clearIdx, 'resetStallTracker 应在二次起步序列中（清flag 之后、continue 之前——保持 p1-01 契约的窗口钉）');
});

// ⑥ ENG-10：后台任务卡片。
check('⑥ ENG-10：handleBackgroundEvent 补 task_started/progress/notification upsert', () => {
  const bgIdx = chat.indexOf('function handleBackgroundEvent');
  const bgEnd = chat.indexOf('function handleCliEvent');
  const body = chat.slice(bgIdx, bgEnd);
  assert.match(body, /event\.subtype === 'task_started'/, '缺 task_started 分支');
  assert.match(body, /applyProgressEvent\(store, event\);/, '缺任务卡片 upsert 接线');
});

// ⑦ ENG-12：persistCliEvent error case。
check('⑦ ENG-12：persistCliEvent 补 error case（role:system, system:error）', () => {
  const idx = cliShared.indexOf("case 'error': {");
  assert.ok(idx > cliShared.indexOf("case 'aborted': {"), '缺 error case（或顺序异常）');
  const body = cliShared.slice(idx, cliShared.indexOf("case 'result':", idx));
  assert.match(body, /role: 'system',/, '缺 role system');
  assert.match(body, /processKind: 'system:error',/, "缺 processKind 'system:error'");
  assert.match(body, /content: errorEvent\.message,/, '缺事件文案落库');
});

// ⑧ TM-01：渲染层守卫 + 时间下界。
check('⑧ TM-01：前后台 meta 写均有 turnStartedAt 守卫；repo fallback 加 10min 时间下界', () => {
  const attIdx = chat.indexOf('function attachResultMetadata');
  const attBody = chat.slice(attIdx, attIdx + 3000);
  assert.match(attBody, /store\.turnStartedAt\[sid\] != null/, '前台持久化缺 turnStartedAt 守卫');
  const bgIdx = chat.indexOf('function handleBackgroundEvent');
  const bgBody = chat.slice(bgIdx, chat.indexOf('function handleCliEvent'));
  const bgResult = bgBody.slice(bgBody.indexOf("case 'result':"));
  assert.match(bgResult, /if \(startedAt != null\) \{/, '后台分支缺 turnStartedAt 守卫');
  assert.match(msgRepo, /opts\?: \{ endedAt\?: number \| null \}/, 'repo 缺时间窗参数');
  assert.match(msgRepo, /endedAt - 10 \* 60_000/, '缺 10min 宽松窗');
  assert.match(handlers, /findLastTurnMainFlowAssistantId\(sessionId, \{ endedAt \}\)/, 'handler 未传 endedAt');
});

// ⑨ TM-03：空回合也写会话级 meta。
check('⑨ TM-03：walk 未命中主流程 assistant 行时仍 recordTurnMeta(messageId:null)', () => {
  const attIdx = chat.indexOf('function attachResultMetadata');
  const attBody = chat.slice(attIdx, attIdx + 3600);
  assert.match(attBody, /!hitAssistant && isSuccessfulCliResult\(event\)/, '缺空回合回退写');
  assert.match(attBody, /messageId: null,\s*\r?\n\s*costUsd: typeof cost/, '空回合回退缺 null messageId payload');
});

// ⑩ TM-04/05/06。
check('⑩ TM-04/05/06：脚注门控 durationMs||endedAt；formatEndedAt 单源；小时档', () => {
  assert.match(bubble, /v-if="message\.durationMs \|\| message\.endedAt" class="bubble__meta"/, 'TM-04 门控不符');
  assert.match(bubble, /formatEndedAt\(props\.message\.endedAt\)/, 'MessageBubble 缺 formatEndedAt 单源');
  assert.match(turnTimer, /formatEndedAt\(lastMeta\.value\?\.endedAt\)/, 'TurnTimer 缺 formatEndedAt 单源');
  assert.match(fmt, /if \(s >= 3600\)/, '缺小时档');
  assert.match(fmt, /export function formatEndedAt\(/, '缺 formatEndedAt');
  // 行为级：H:MM:SS 与跨天
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { formatDurationMs: fd, formatEndedAt: fe } = require('../src/shared/format-duration') as { formatDurationMs: (n: number) => string; formatEndedAt: (t: number, now?: number) => string };
  assert.equal(fd(7503000), '2:05:03');
  assert.equal(fd(83000), '1:23');
  assert.equal(fd(3700), '3.7s');
  const now = new Date(2026, 8, 13, 12, 0, 0).getTime();
  assert.equal(fe(new Date(2026, 8, 13, 9, 5, 3).getTime(), now), '09:05:03', '当天应 HH:mm:ss');
  assert.equal(fe(new Date(2026, 8, 12, 9, 5, 0).getTime(), now), '9/12 09:05:00'.replace(':00', ''), '跨天应 M/d HH:mm（实际 ' + fe(new Date(2026, 8, 12, 9, 5, 0).getTime(), now) + '）');
});

// ⑪ TM-07：已删会话后台 result 丢弃。
check('⑪ TM-07：后台 result 首行已删会话丢弃', () => {
  const bgIdx = chat.indexOf('function handleBackgroundEvent');
  const bgBody = chat.slice(bgIdx, chat.indexOf('function handleCliEvent'));
  const bgResult = bgBody.slice(bgBody.indexOf("case 'result':"));
  assert.match(bgResult, /!store\.sessions\.some\(\(s\) => s\.id === sid\)\) break;/, '缺已删会话丢弃守卫');
  const dropIdx = bgResult.indexOf('!store.sessions.some');
  const clearIdx = bgResult.indexOf('clearAbortTimer(sid);');
  assert.ok(clearIdx > dropIdx, '丢弃守卫应先于后续内存写');
});

// ⑫ OPT-1。
check('⑫ OPT-1：recordTurnMeta handler 返回 true（省一次全行读）', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.SESSION_RECORD_TURN_META');
  const body = handlers.slice(idx, idx + 2600);
  assert.match(body, /return true;/, 'handler 未改返回 true');
  const retIdx = body.indexOf('return true;');
  assert.ok(body.indexOf('sessionRepo.getSession(sessionId)', retIdx) === -1, 'return true 后仍有全行读（优化无效）');
});


// ⑬ hb12-TM-03（2026-09-13 二轮补救）：recordTurnMeta 两半边 UPDATE 包同一 transaction。
// hb13-v 批C：原编号 ⑭（⑬ 留给 hb12-p3 契约同名域，跳号清理归位）。
check('⑬ TM-03：messages/sessions 两 UPDATE 包 db transaction（P2-2 双门控保留）', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.SESSION_RECORD_TURN_META');
  assert.ok(idx > -1, '缺 SESSION_RECORD_TURN_META handler');
  const body = handlers.slice(idx, idx + 2600);
  assert.match(body, /getConnection\(\)\.transaction\(/, '缺 db transaction 包裹');
  const txIdx = body.indexOf('getConnection().transaction(');
  const msgIdx = body.indexOf('messageRepo.updateResultMeta(');
  const sesIdx = body.indexOf('sessionRepo.updateTurnMeta(');
  assert.ok(txIdx > -1 && msgIdx > txIdx && sesIdx > txIdx, '两半边 UPDATE 必须都在事务内');
  assert.match(body, /costUsd != null \|\| durationMs != null/, '缺 P2-2 messages 门控');
  assert.match(body, /durationMs != null && endedAt != null/, '缺 P2-2 sessions 门控');
});
console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
