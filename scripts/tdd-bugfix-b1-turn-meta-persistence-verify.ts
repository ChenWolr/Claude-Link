// scripts/tdd-bugfix-b1-turn-meta-persistence-verify.ts
// B1 契约：会话回合「耗时/结束时间」持久化。
//
// 病根（2026-09-08 用户报告）：回合 result 的耗时/费用只挂在渲染层内存消息上（attachResultMetadata），
// messages 表的 cost_usd/duration_ms 列从未被写入；会话级更无「最近一回合」元数据。
// 切换会话/重启应用后，TurnTimer 与气泡脚注全部消失；后台完成的会话连内存 meta 都没有。
//
// 修复：新增 IPC 通道 SESSION_RECORD_TURN_META，渲染层回合结束时一次写两级——
// UPDATE messages（气泡脚注持久化）+ UPDATE sessions.last_turn_*（会话级最近回合元数据）；
// TurnTimer 增加「turn-timer--done」完成态行（耗时 + 结束于 HH:mm:ss，不显示费用）。
//
// 本契约锁十件事：①迁移 V12 两列+自愈 ②session-repo 映射与 updateTurnMeta（不 bump updated_at）
// ③message-repo.updateResultMeta（AND session_id 守卫）④IPC 通道+handler 校验 ⑤preload 桥
// ⑥Session 类型字段 ⑦session-store 内存 map/getter/action/删除清理 ⑧use-chat 前后台接入
// （后台 meta 计算必须先于 markCompleted）⑨TurnTimer 完成态（无费用字样）⑩selftest 链入链。
//
// 运行：npx tsx scripts/tdd-bugfix-b1-turn-meta-persistence-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const migrations = read('src/main/database/migrations.ts');
const sessionRepo = read('src/main/database/repositories/session-repo.ts');
const messageRepo = read('src/main/database/repositories/message-repo.ts');
const ipcTypes = read('src/shared/types/ipc.ts');
const ipcHandlers = read('src/main/ipc-handlers.ts');
const preloadApi = read('src/preload/api.ts');
const sessionTypes = read('src/shared/types/session.ts');
const sessionStore = read('src/renderer/stores/session-store.ts');
const useChat = read('src/renderer/composables/use-chat.ts');
const turnTimer = read('src/renderer/components/chat/TurnTimer.vue');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① migrations：V12 版本块（列守卫 + ALTER）+ 尾部自愈守卫，且必须在写版本号之前。
check('① migrations：CURRENT_SCHEMA_VERSION=12 + V12 两列 ALTER/守卫 + 自愈 + 版本块先于 upsertVersion', () => {
  assert.match(migrations, /CURRENT_SCHEMA_VERSION = 12/, 'CURRENT_SCHEMA_VERSION 未升到 12');
  assert.match(migrations, /ALTER TABLE sessions ADD COLUMN last_turn_duration_ms INTEGER DEFAULT NULL/, '缺 last_turn_duration_ms ALTER');
  assert.match(migrations, /ALTER TABLE sessions ADD COLUMN last_turn_ended_at INTEGER DEFAULT NULL/, '缺 last_turn_ended_at ALTER');
  assert.match(migrations, /tableColumns\(db, 'sessions'\)\.has\('last_turn_duration_ms'\)/, 'V12 版本块缺列守卫（duration）');
  assert.match(migrations, /tableColumns\(db, 'sessions'\)\.has\('last_turn_ended_at'\)/, 'V12 版本块缺列守卫（ended_at）');
  assert.match(migrations, /hasCol\('last_turn_duration_ms'\)/, '自愈区缺 last_turn_duration_ms 守卫');
  assert.match(migrations, /hasCol\('last_turn_ended_at'\)/, '自愈区缺 last_turn_ended_at 守卫');
  const v12 = migrations.indexOf('currentVersion < 12');
  const upsert = migrations.indexOf('upsertVersion.run(CURRENT_SCHEMA_VERSION)');
  assert.ok(v12 > -1, '未找到 currentVersion < 12 版本块');
  assert.ok(upsert > -1, '未找到 upsertVersion.run');
  assert.ok(v12 < upsert, 'V12 版本块必须位于 upsertVersion.run 之前');
});

// ② session-repo：SessionRow/toSession 映射 + updateTurnMeta（SQL 不得含 updated_at）。
check('② session-repo：SessionRow/toSession 两字段映射 + updateTurnMeta 且 SQL 不 bump updated_at', () => {
  assert.match(sessionRepo, /last_turn_duration_ms: number \| null;/, 'SessionRow 缺 last_turn_duration_ms');
  assert.match(sessionRepo, /last_turn_ended_at: number \| null;/, 'SessionRow 缺 last_turn_ended_at');
  assert.match(sessionRepo, /lastTurnDurationMs: row\.last_turn_duration_ms/, 'toSession 缺 lastTurnDurationMs 映射');
  assert.match(sessionRepo, /lastTurnEndedAt: row\.last_turn_ended_at/, 'toSession 缺 lastTurnEndedAt 映射');
  const fnIdx = sessionRepo.indexOf('export function updateTurnMeta');
  assert.ok(fnIdx > -1, '未找到 export function updateTurnMeta');
  const nextExport = sessionRepo.indexOf('export ', fnIdx + 10);
  const body = sessionRepo.slice(fnIdx, nextExport > -1 ? nextExport : undefined);
  assert.match(body, /UPDATE sessions SET last_turn_duration_ms = \?, last_turn_ended_at = \? WHERE id = \?/, 'updateTurnMeta SQL 形态不符');
  assert.doesNotMatch(body, /updated_at/, 'updateTurnMeta 不得更新 updated_at（侧栏排序由用户操作驱动）');
});

// ③ message-repo：updateResultMeta + AND session_id 归属守卫；审查修复轮：主流程 assistant 行查找
//（parentAgentId 守卫 + user 边界 + 50 行窗口打满回落全量）。
check('③ message-repo：updateResultMeta（AND session_id 守卫）+ findLastTurnMainFlowAssistantId（parentAgentId 守卫 + user 边界 + 窗口回落全量）', () => {
  const fnIdx = messageRepo.indexOf('export function updateResultMeta');
  assert.ok(fnIdx > -1, '未找到 export function updateResultMeta');
  const nextExport = messageRepo.indexOf('export ', fnIdx + 10);
  const body = messageRepo.slice(fnIdx, nextExport > -1 ? nextExport : undefined);
  assert.match(body, /UPDATE messages SET cost_usd = \?, duration_ms = \? WHERE id = \? AND session_id = \?/, 'updateResultMeta SQL 缺 AND session_id 归属守卫');
  assert.match(body, /r\.changes > 0/, 'updateResultMeta 应返回 changes > 0 布尔');
  const findIdx = messageRepo.indexOf('export function findLastTurnMainFlowAssistantId');
  assert.ok(findIdx > -1, '审查修复轮：未找到 export function findLastTurnMainFlowAssistantId');
  const findBody = messageRepo.slice(findIdx, messageRepo.indexOf('export ', findIdx + 10) > -1 ? messageRepo.indexOf('export ', findIdx + 10) : undefined);
  assert.match(findBody, /if \(m\.parentAgentId != null\) continue;/, '查找缺主流程守卫（parentAgentId != null 先行 continue，跳过子 agent 行；P3-1 须先于 user 边界）');
  assert.match(findBody, /m\.role === 'user'\) return null/, '查找缺 user 边界（遇 user 即停返回 null）');
  assert.match(findBody, /rows\.length === 50 && !rows\.some\(\(m\) => m\.role === 'user'\)/, '查找缺窗口打满未见 user 的回落谓词');
  assert.match(findBody, /getMessagesBySession\(sessionId\)\.reverse\(\)/, '回落全量必须 .reverse()——getMessagesBySession 是 ASC 旧→新，walk 期望新→旧；漏反转则长回合 fallback 恒 null/误写最老行');
});

// ④ IPC：通道常量 + handler（会话存在性校验 + 正数校验 + 双写）；审查修复轮：messageId 命中
// 失败/为 null 时回落 findLastTurnMainFlowAssistantId（直传 messageId 与 DB id 两套 uuid 永不相等）。
check('④ ipc.ts 通道常量 + ipc-handlers handler（getSession 校验 + v>0 正数校验 + 双写 + messageId 失配 fallback）', () => {
  assert.match(ipcTypes, /SESSION_RECORD_TURN_META: 'session:recordTurnMeta'/, 'IPC_CHANNELS 缺 SESSION_RECORD_TURN_META');
  const hIdx = ipcHandlers.indexOf('IPC_CHANNELS.SESSION_RECORD_TURN_META');
  assert.ok(hIdx > -1, 'ipc-handlers 缺 SESSION_RECORD_TURN_META handler');
  const body = ipcHandlers.slice(hIdx, hIdx + 2600);
  assert.match(body, /sessionRepo\.getSession\(sessionId\)/, 'handler 缺会话存在性校验');
  assert.match(body, /v > 0/, 'handler 缺正数校验（v > 0）');
  assert.match(body, /messageRepo\.updateResultMeta/, 'handler 缺 messages 写入');
  assert.match(body, /sessionRepo\.updateTurnMeta/, 'handler 缺 sessions 写入');
  assert.match(body, /const directHit = typeof payload\?\.messageId === 'string' && payload\.messageId[\s\S]*?:\s*false;/, '审查修复轮：handler 缺 updateResultMeta 返回值检查（directHit）');
  // 审查收口：messageId 类型收窄——仅字符串直传，不得 String() 强转（非字符串直接走 fallback）。
  assert.doesNotMatch(body, /String\(payload\.messageId\)/, '审查收口：handler 不得对 messageId 做 String() 强转');
  assert.match(body, /if \(!directHit\) \{\s*const fallbackId = messageRepo\.findLastTurnMainFlowAssistantId\(sessionId\);/, '审查修复轮：handler 缺 fallback（直传 0 行/null 时调 findLastTurnMainFlowAssistantId）');
  assert.match(body, /if \(fallbackId\) messageRepo\.updateResultMeta\(fallbackId, sessionId, meta\);/, '审查修复轮：fallback 命中后未用 fallbackId 再写 messages');
});

// ⑤ preload：recordTurnMeta 声明 + 实现。
check('⑤ preload/api.ts：recordTurnMeta 接口声明与 invoke 实现', () => {
  assert.match(preloadApi, /recordTurnMeta: \(/, 'ClaudeLinkAPI 缺 recordTurnMeta 声明');
  assert.match(preloadApi, /recordTurnMeta: \(sessionId, payload\) => ipcRenderer\.invoke\(IPC_CHANNELS\.SESSION_RECORD_TURN_META, sessionId, payload\)/, 'recordTurnMeta 实现未 invoke SESSION_RECORD_TURN_META');
});

// ⑥ shared/types/session.ts：Session 两字段。
check('⑥ Session 类型：lastTurnDurationMs / lastTurnEndedAt', () => {
  assert.match(sessionTypes, /lastTurnDurationMs: number \| null;/, 'Session 缺 lastTurnDurationMs');
  assert.match(sessionTypes, /lastTurnEndedAt: number \| null;/, 'Session 缺 lastTurnEndedAt');
});

// ⑦ session-store：state map + getter + action + deleteSession 清理。
check('⑦ session-store：lastTurnMeta state + activeLastTurnMeta getter + setLastTurnMeta action + deleteSession 清理', () => {
  assert.match(sessionStore, /lastTurnMeta: \{\} as Record<string, \{ durationMs: number; endedAt: number \}>,/, '缺 lastTurnMeta state');
  assert.match(sessionStore, /activeLastTurnMeta\(state\)/, '缺 activeLastTurnMeta getter');
  assert.match(sessionStore, /setLastTurnMeta\(sessionId: string, meta:/, '缺 setLastTurnMeta action');
  // P2-4 加钉：getter 回落形态（重启/切回恢复的精确形状，防字段漂移）。
  assert.match(sessionStore, /return \{ durationMs: s\.lastTurnDurationMs, endedAt: s\.lastTurnEndedAt \};/, 'getter 缺 Session 字段回落形态');
  // P2-4 加钉：setLastTurnMeta 须同步 activeSession 对象字段（完成态/侧栏数据一致）。
  assert.match(sessionStore, /this\.activeSession\.lastTurnDurationMs = meta\.durationMs;/, 'setLastTurnMeta 缺 activeSession 同步（durationMs）');
  assert.match(sessionStore, /this\.activeSession\.lastTurnEndedAt = meta\.endedAt;/, 'setLastTurnMeta 缺 activeSession 同步（endedAt）');
  // P2-4 加钉：deleteSession 清理必须位于 deleteSession 函数体内（位置钉，防漂移到其它 action）。
  const dsIdx = sessionStore.indexOf('async deleteSession(id: string) {');
  const dsEnd = sessionStore.indexOf('async deleteSessions(', dsIdx);
  assert.ok(dsIdx > -1 && dsEnd > dsIdx, '未定位到 deleteSession 函数体');
  assert.ok(sessionStore.slice(dsIdx, dsEnd).includes('delete this.lastTurnMeta[id];'), 'deleteSession 函数体内缺 lastTurnMeta 清理');
});

// ⑧ use-chat：前台 attachResultMetadata 持久化 + 后台 result 分支接入（meta 计算先于 markCompleted）。
check('⑧ use-chat：前台 attachResultMetadata 含 recordTurnMeta/endedAt；后台 result 分支接入且 meta 计算先于 markCompleted', () => {
  const frontIdx = useChat.indexOf('function attachResultMetadata');
  assert.ok(frontIdx > -1, '未找到 attachResultMetadata');
  const frontEnd = useChat.indexOf('async function sendMessage');
  const front = useChat.slice(frontIdx, frontEnd > -1 ? frontEnd : undefined);
  assert.match(front, /recordTurnMeta\(/, '前台 attachResultMetadata 缺 recordTurnMeta 调用');
  assert.match(front, /const endedAt = Date\.now\(\)/, '前台缺 endedAt 计算');
  // 审查修复轮：回溯循环跳过子 agent 行（continue 不 break），且在 assistant 赋值之前。
  const skipIdx = front.indexOf('if (message.parentAgentId) continue;');
  const costIdx = front.indexOf('message.costUsd =');
  assert.ok(skipIdx > -1, '审查修复轮：attachResultMetadata 回溯缺 parentAgentId skip（continue）');
  assert.ok(costIdx > -1, '未找到 assistant costUsd 赋值');
  assert.ok(skipIdx < costIdx, 'parentAgentId skip 必须位于 assistant 赋值之前');
  // P2-1 加钉：持久化（setLastTurnMeta + recordTurnMeta）必须位于 isSuccessfulCliResult 门控内
  // （中断/错误回合不产生记录——error_during_execution 为第三态 false，对齐后台分支）。
  const gateIdx = front.indexOf('if (sid && isSuccessfulCliResult(event)) {');
  const setIdx = front.indexOf('store.setLastTurnMeta(');
  const recIdx = front.indexOf('window.claudeLink.recordTurnMeta(');
  assert.ok(gateIdx > -1, 'P2-1：前台缺持久化门控 if (sid && isSuccessfulCliResult(event))');
  assert.ok(setIdx > -1 && gateIdx < setIdx, 'P2-1：setLastTurnMeta 必须位于门控之内');
  assert.ok(recIdx > -1 && gateIdx < recIdx, 'P2-1：recordTurnMeta 必须位于门控之内');
  // 后台分支：handleBackgroundEvent 与 handleCliEvent 之间的切片。
  const bgIdx = useChat.indexOf('function handleBackgroundEvent');
  const cliIdx = useChat.indexOf('function handleCliEvent');
  assert.ok(bgIdx > -1 && cliIdx > bgIdx, '未定位到 handleBackgroundEvent 区段');
  const bg = useChat.slice(bgIdx, cliIdx);
  const resultCase = bg.indexOf("case 'result':");
  assert.ok(resultCase > -1, '后台分支缺 case result');
  const bgResult = bg.slice(resultCase);
  assert.match(bgResult, /recordTurnMeta\(/, '后台 result 分支缺 recordTurnMeta 调用');
  // 顺序硬要求：turnStartedAt 捕获必须位于 markCompleted 之前（markCompleted 会 delete turnStartedAt）。
  const capture = bgResult.indexOf('store.turnStartedAt[sid]');
  const completed = bgResult.indexOf('store.markCompleted(sid)');
  assert.ok(capture > -1, '后台分支未捕获 turnStartedAt[sid]');
  assert.ok(completed > -1, '后台分支缺 markCompleted');
  assert.ok(capture < completed, '后台 meta 计算（turnStartedAt 捕获）必须先于 markCompleted');
});

// ⑨ TurnTimer：完成态分支 + 结束于文案 + 不出现费用。
check('⑨ TurnTimer：v-else-if="lastMeta" 完成态 + turn-timer--done + 结束于文案 + 完成态无费用字样 + Transition out-in', () => {
  assert.match(turnTimer, /<Transition name="turn-timer" mode="out-in">/, '审查收口：Transition 缺 mode="out-in"（sending↔done 切换会一帧双条/布局跳动）');
  assert.match(turnTimer, /v-else-if="lastMeta"/, '缺完成态分支 v-else-if="lastMeta"');
  assert.match(turnTimer, /turn-timer--done/, '缺 turn-timer--done 完成态样式类');
  assert.match(turnTimer, /结束于/, '缺「结束于」文案');
  const doneIdx = turnTimer.indexOf('v-else-if="lastMeta"');
  // P2-4 补强：扫整个完成态块（到 </Transition> 为止）——只扫到首个 </div> 时，嵌套 div
  // 后插 $ 会逃逸契约。
  const closeIdx = turnTimer.indexOf('</Transition>', doneIdx);
  assert.ok(closeIdx > -1, '完成态分支未闭合（缺 </Transition>）');
  const doneBranch = turnTimer.slice(doneIdx, closeIdx);
  assert.ok(!doneBranch.includes('costUsd'), '完成态分支不得出现 costUsd（费用不展示）');
  assert.ok(!doneBranch.includes('$'), '完成态分支不得出现 $ 字样');
  assert.match(doneBranch, /formatDurationMs\(lastMeta\.durationMs\)/, '完成态缺耗时展示');
});

// ⑩ package.json：selftest:static 链入链。B2 契约属另一工作流、可能未入链——
// 本断言不得硬依赖其存在；仅当 B2 已入链时才要求 B1 排在其后（链尾追加顺序）。
check('⑩ package.json：selftest:static 链包含 tdd-bugfix-b1-turn-meta-persistence-verify.ts', () => {
  const chain = pkg.scripts['selftest:static'];
  assert.ok(chain, '未找到 selftest:static 脚本');
  const b1 = chain.indexOf('tdd-bugfix-b1-turn-meta-persistence-verify.ts');
  const b2 = chain.indexOf('tdd-bugfix-b2-back-bottom-viewport-anchor-verify.ts');
  assert.ok(b1 > -1, 'selftest:static 未包含 B1 契约脚本');
  if (b2 > -1) {
    assert.ok(b1 > b2, 'B1 契约应追加在 B2 之后（链尾）');
  }
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
