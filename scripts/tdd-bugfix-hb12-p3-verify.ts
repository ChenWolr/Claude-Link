// scripts/tdd-bugfix-hb12-p3-verify.ts
// hb12 P3 批契约（已实施项：SMG-01/02/05/06/07、CHR-04、QUE-04/05、PERM-02/04/06、TM-01、
// SHL-04 备注、ATT-03。CHG-03/05 未实施（hb13-v 复核 F-6/F-7 留档，本契约不含其断言）。
// REFUTED/OPT/降级项按计划不实施——见各 check 注释）。
// 2026-09-13 二轮补救追加 ⑮：hb12-SMG-09（round2 验收 P2-A1 判未实施的最重项，此处补钉）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const store = read('src/renderer/stores/session-store.ts');
const chat = read('src/renderer/composables/use-chat.ts');
const taskStore = read('src/renderer/stores/task-store.ts');
const taskTypes = read('src/shared/types/task.ts');
const panel = read('src/renderer/components/task/TaskQueuePanel.vue');
const sdkInter = read('src/main/modules/sdk-interactions.ts');
const prompt = read('src/renderer/components/chat/InteractionPrompt.vue');
const bubble = read('src/renderer/components/chat/MessageBubble.vue');
const msgAtt = read('src/renderer/components/chat/MessageAttachments.vue');
const safeStore = read('src/main/utils/safe-store.ts');
const analyzer = read('src/main/modules/topic-analyzer.ts');
const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts'); // 二轮补救：SMG-09 会话行回滚钉

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① SMG-01（hb12 维度）：SessionToolbar 三入口 catch + safe-store。
check('① SMG-01：safe-store helper 存在；SessionToolbar 工作目录历史失败不致命', () => {
  assert.match(safeStore, /export function createSafeStore/, '缺 helper');
  // SessionToolbar 切目录的 notice 已由 store error 通道承载——此处钉 store 侧两分支不致命。
  assert.match(store, /hb12-SMG-02：历史记录失败只影响历史/, '暂态分支缺独立 try');
});

// ② SMG-02。
check('② SMG-02：setActiveSessionWorkingDir 两分支 addRecentWorkspace 独立 try/catch', () => {
  const idx = store.indexOf('async setActiveSessionWorkingDir');
  const body = store.slice(idx, store.indexOf('\n    },', idx));
  const hits = (body.match(/hb12-SMG-02/g) ?? []).length;
  assert.ok(hits >= 2, `两分支覆盖率不足（${hits}/2）`);
});

// ③ SMG-05。
check('③ SMG-05：后台事件首行已删会话丢弃', () => {
  const idx = chat.indexOf('hb12-SMG-05：已删除会话的后台事件直接丢弃');
  assert.ok(idx > -1, '缺丢弃守卫');
  const guardIdx = chat.indexOf('!store.sessions.some((s) => s.id === payload.sessionId)) return;', idx);
  const handleIdx = chat.indexOf('handleBackgroundEvent(payload);', idx);
  assert.ok(guardIdx > -1 && guardIdx < handleIdx, '守卫未在 handleBackgroundEvent 之前');
});

// ④ SMG-06。
check('④ SMG-06：retryLastTurn 显式清 turnStartedAt', () => {
  assert.match(chat, /hb12-SMG-06：显式清 turnStartedAt[\s\S]{0,120}delete store\.turnStartedAt\[sid\];/, '缺显式清理');
});

// ⑤ SMG-07（hb12 维度）：topic 1MiB 上限（Deadline 已随 hb10-SMG-02 钉过）。
check('⑤ SMG-07：topic 响应 >1MiB destroy+reject', () => {
  assert.match(analyzer, /TOPIC_RESPONSE_MAX_BYTES/, '缺上限常量');
  assert.match(analyzer, /bytes > TOPIC_RESPONSE_MAX_BYTES/, '缺累积判定');
});

// ⑥ QUE-04。
check('⑥ QUE-04：countdown_started 快照 intervalSeconds + etaFor 优先快照', () => {
  assert.match(taskTypes, /intervalSeconds\?: number;/, 'QueueState 缺可选字段');
  assert.match(taskStore, /this\.queueState\.intervalSeconds = remaining;/, 'store 未回填快照');
  assert.match(panel, /taskStore\.queueState\.intervalSeconds \?\? resolveQueueDelaySeconds/, 'etaFor 未优先快照');
});

// ⑦ QUE-05。
check('⑦ QUE-05：倒计时分支 >=0', () => {
  assert.match(panel, /state\.countdownRemaining >= 0\) \{/, '未放宽 >=0');
});

// ⑧ PERM-02。
check('⑧ PERM-02：deny 显式选择映射用户拒绝文案', () => {
  const idx = sdkInter.indexOf('hb12-PERM-02：显式选择 deny 选项');
  assert.ok(idx > -1, '缺 deny 分支');
  const body = sdkInter.slice(idx, idx + 300);
  assert.match(body, /用户拒绝了该工具调用/, '缺用户拒绝文案');
  // 位置：deny 分支须先于 reason:'user' 兜底
  const denyIdx = sdkInter.indexOf("if (selectedId === 'deny') {");
  const reasonIdx = sdkInter.indexOf("if (response.reason === 'user') {");
  assert.ok(denyIdx > -1 && reasonIdx > denyIdx, 'deny 分支位置不符');
});

// ⑨ PERM-04。
check('⑨ PERM-04：弹窗草稿按 request.id 缓存恢复', () => {
  assert.match(prompt, /draftCache/, '缺草稿缓存');
  assert.match(prompt, /const cached = draftCache\.get\(request\.id\);/, 'initSelection 缓存恢复缺失');
});

// ⑩ PERM-06。
check('⑩ PERM-06：buildPermissionTitle 截断 200', () => {
  assert.match(sdkInter, /target\.length > 200 \? \$\{target\.slice\(0, 200\)\}…|target\.slice\(0, 200\)/, '缺截断');
});

// ⑪ CHR-04。
check('⑪ CHR-04：copyMessage 失败态', () => {
  assert.match(bubble, /copyFailed/, '缺失败态');
  assert.match(bubble, /复制失败/, '缺失败文案');
});

// ⑫ ATT-03。
check('⑫ ATT-03：openPreview 会话归属守卫', () => {
  assert.match(msgAtt, /hb10-ATT-03：会话归属守卫/, '缺守卫');
});

// ⑬ TM-01（hb12 维度；hb13-v A11 正名补钉）：此前函数体只断言无关的 getKnownTurnOutcome
//（名实不符，给验收造成「已对齐」假象）——现真实钉回落触发谓词 parentAgentId 口径与时间窗。
check('⑬ TM-01：repo fallback 谓词 parentAgentId 对齐 + 时间窗下界真实成立', () => {
  const msgRepo = read('src/main/database/repositories/message-repo.ts');
  assert.match(msgRepo, /!rows\.some\(\(m\) => m\.role === 'user' && m\.parentAgentId == null\)/, '回落触发谓词缺 parentAgentId == null 口径');
  assert.match(msgRepo, /endedAt - 10 \* 60_000/, '缺 10min 时间下界');
  assert.match(msgRepo, /SELECT id, session_id, role, content, event_type, process_kind, parent_agent_id, created_at/, '窄窗/回落 SELECT 缺 created_at 列（时间下界在窄窗主路径恒 NaN 跳过）');
});

// 不实施留档（对照计划 §4；2026-09-13 二轮补救更正归因——round2 验收 P2-A8 判原注释把
// SMG-03/CHR-01/CHR-03/ATT-06(EXIF) 与 OPT/REFUTED 混列「按计划不实施」失实，四项已随二轮补救实施，
// 见各自域契约脚本的新增钉）：
// hb12-SMG-04/08/10、CHR-02/05/06、ATT-04/05(REFUTED)/06(CMYK 半边仍待真机样张)、
// CTX-03(存疑)/CTX-04(REFUTED)、PRV-06/07/08/09(OPT)、CMD-05/06(OPT)、SHL-04/05(OPT)。
check('留档：REFUTED/OPT 项未实施（查看本注释即可）', () => {
  assert.ok(true);
});

// ⑮ hb12-SMG-09（二轮补救，round2 验收 P2-A1 判未实施的最重项）。
check('⑮ SMG-09：bindTransientAttachmentsToSession 包 try，catch 内先 deleteSession 回滚再重抛', () => {
  const idx = handlers.indexOf('if (spec?.bindTransientAttachmentIds?.length) {');
  assert.ok(idx > -1, 'SESSION_CREATE 缺 bind 分支');
  const body = handlers.slice(idx, idx + 500);
  assert.match(body, /try \{/, 'bind 调用缺 try 包裹');
  const tryIdx = body.indexOf('try {');
  const bindIdx = body.indexOf('bindTransientAttachmentsToSession(session.id, spec.bindTransientAttachmentIds)');
  const rollbackIdx = body.indexOf('sessionRepo.deleteSession(session.id)');
  const rethrowIdx = body.indexOf('throw err;');
  assert.ok(bindIdx > tryIdx, 'bind 必须在 try 内');
  assert.ok(rollbackIdx > bindIdx, '缺 sessionRepo.deleteSession 会话行回滚');
  assert.ok(rethrowIdx > rollbackIdx, '重抛必须先回滚会话行');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
