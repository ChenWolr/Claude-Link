// tdd-background-task-session-scope-verify.ts
// P5 后台任务跨会话显示——按会话维度重构（2026-10-22 计划 §6.1/§6.3/§6.5）TDD 契约脚本。
// 根因：session-store.backgroundTasks 原为无会话维度的全局 map——A 会话的后台任务卡
// 串到 B 会话面板（正向串扰），B 会话发新回合/切换/删会话/新建暂态整表清掉 A 的终态卡
//（反向串扰）。修复：重构为两层索引（外层 sessionId → 内层 taskId，对齐同文件
// subAgentStreamingThinking 形态），渲染与清理全部按会话桶作用域收窄。
// 契约四项（计划 §6.5）：
//   ① store 两层 Record 结构 + activeBackgroundTasks getter（活动会话桶视图）；
//   ② use-chat applyProgressEvent 带 sessionId 参数、handleBackgroundEvent task_* 分支透传 payload.sessionId；
//   ③ TaskQueuePanel 消费 activeBackgroundTasks（ProcessGroup 反查同走）；
//   ④ switchSession 不再整表清 backgroundTasks、deleteSession 按桶删（startTransientSession 同收窄）。
// 另含行为级断言（pinia 真实 store）：A/B 桶隔离、切回 A 运行卡仍在、回合边界清卡只及本会话。
// 运行：npx tsx scripts/tdd-background-task-session-scope-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import type { Session } from '../src/shared/types/session';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { applyProgressEvent } from '../src/renderer/composables/use-chat';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const storeSrc = read('src/renderer/stores/session-store.ts');
const chatSrc = read('src/renderer/composables/use-chat.ts');
const panelSrc = read('src/renderer/components/task/TaskQueuePanel.vue');
const groupSrc = read('src/renderer/components/chat/ProcessGroup.vue');

console.log('\n=== 静态契约 ①—④ · 计划 §6.5 ===');

// ① store：两层 Record + 活动会话桶 getter。
check('① backgroundTasks 声明为两层 Record<sessionId, Record<taskId, BackgroundTask>>', () => {
  assert.match(
    storeSrc,
    /backgroundTasks: \{\} as Record<string, Record<string, BackgroundTask>>/,
    'backgroundTasks 未按会话维度分桶',
  );
});
check('① activeBackgroundTasks getter：活动会话桶视图，缺桶回落空对象', () => {
  const idx = storeSrc.indexOf('activeBackgroundTasks(state)');
  assert.ok(idx >= 0, '缺 activeBackgroundTasks getter');
  const body = storeSrc.slice(idx, idx + 300);
  assert.match(body, /state\.backgroundTasks\[state\.activeSession\?\.id \?\? ''\] \?\? \{\}/);
});

// ② use-chat：签名带 sessionId；后台分支透传 payload.sessionId；前台分支传 activeSession.id。
check('② applyProgressEvent 签名带 sessionId: string 参数', () => {
  assert.match(
    chatSrc,
    /export function applyProgressEvent\(store: ReturnType<typeof useSessionStore>, event: CliEvent, sessionId: string\): void/,
    'applyProgressEvent 缺 sessionId 入参',
  );
});
check('② handleBackgroundEvent task_* 分支透传 payload.sessionId（sid）', () => {
  const idx = chatSrc.indexOf('function handleBackgroundEvent(');
  assert.ok(idx >= 0, '缺 handleBackgroundEvent');
  const body = chatSrc.slice(idx, chatSrc.indexOf('\n  }', idx));
  assert.match(body, /applyProgressEvent\(store, event, sid\)/, '后台分支未透传会话 id');
});
check('② handleCliEvent 前台 task_* 分支传当前 activeSession.id', () => {
  assert.match(chatSrc, /applyProgressEvent\(store, event, store\.activeSession\.id\)/, '前台 task_* 分支未传活动会话 id');
});

// ③ 面板/过程组只消费活动会话桶（不得直读原始两层 map）。
check('③ TaskQueuePanel 消费 activeBackgroundTasks（不再整表渲染）', () => {
  assert.match(panelSrc, /Object\.values\(sessionStore\.activeBackgroundTasks\)/);
  assert.ok(!panelSrc.includes('sessionStore.backgroundTasks'), 'TaskQueuePanel 不得直读 backgroundTasks 原始 map');
});
check('③ ProcessGroup 后台运行反查同走 activeBackgroundTasks', () => {
  assert.match(groupSrc, /Object\.values\(store\.activeBackgroundTasks\)/);
  assert.ok(!groupSrc.includes('store.backgroundTasks'), 'ProcessGroup 不得直读 backgroundTasks 原始 map');
});

// ④ 切换/删除/暂态的清理作用域收窄。
check('④ switchSession 不再整表清 backgroundTasks（切回原会话任务卡仍在）', () => {
  const idx = storeSrc.indexOf('async switchSession(');
  const body = storeSrc.slice(idx, storeSrc.indexOf('\n    },', idx));
  assert.ok(!body.includes('this.backgroundTasks'), 'switchSession 不得触碰 backgroundTasks（各会话桶互不串扰）');
  assert.match(body, /this\.toolProgress = \{\};/, 'toolProgress 清空应保留（既有语义不动）');
});
check('④ deleteSession 按会话桶删（delete backgroundTasks[id]）', () => {
  const idx = storeSrc.indexOf('async deleteSession(id: string) {');
  const end = storeSrc.indexOf('async deleteSessions(', idx);
  const body = storeSrc.slice(idx, end > idx ? end : undefined);
  assert.match(body, /delete this\.backgroundTasks\[id\];/, 'deleteSession 未按桶删');
  assert.ok(!body.includes('this.backgroundTasks = {}'), 'deleteSession 不得整表清空其他会话的桶');
});
check('④(补充锁定) startTransientSession 不再整表清 backgroundTasks（新建暂态不得误清他会话卡）', () => {
  const idx = storeSrc.indexOf('startTransientSession(');
  const body = storeSrc.slice(idx, storeSrc.indexOf('\n    },', idx));
  assert.ok(!body.includes('this.backgroundTasks'), 'startTransientSession 不得整表清 backgroundTasks');
});

// store action 签名与快照恢复落桶。
check('store actions 带会话维度签名（upsert/remove/clear 均 sessionId 入参）', () => {
  assert.match(storeSrc, /upsertBackgroundTask\(sessionId: string, task: BackgroundTask\)/);
  assert.match(storeSrc, /removeBackgroundTask\(sessionId: string, taskId: string\)/);
  assert.match(storeSrc, /clearBackgroundTasks\(sessionId: string\)/);
});
check('applyRuntimeSnapshot 快照恢复按 snap.sessionId 落桶', () => {
  // P1-G2（2026-10-24 网页运行态同步）定位锚收窄：switchSession 新增的快照拉取调用点
  //（this.applyRuntimeSnapshot(snap)）先于 action 定义出现，裸 indexOf 会切到调用处——
  // 改钉定义签名，断言语义不变（快照恢复按会话 id 落本会话桶）。
  const idx = storeSrc.indexOf('applyRuntimeSnapshot(snap: TurnProjectionSnapshotView)');
  const body = storeSrc.slice(idx, storeSrc.indexOf('\n    },', idx));
  assert.match(body, /this\.backgroundTasks\[sid\]/, '快照恢复未按会话 id 落桶');
});

console.log('\n=== 行为断言 · A/B 会话桶隔离（计划 §6.3 边界值）===');

const SID_A = 'sessA';
const SID_B = 'sessB';
function freshStore(): ReturnType<typeof useSessionStore> {
  setActivePinia(createPinia());
  return useSessionStore();
}
function setActive(store: ReturnType<typeof useSessionStore>, sid: string): void {
  store.activeSession = { id: sid } as unknown as Session;
}

check('B1 A 会话建卡只入 A 桶；B 桶与 B 视图不出现（正向串扰修复）', () => {
  const store = freshStore();
  setActive(store, SID_B);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't1', description: 'A 任务', taskType: 'local_bash' }, SID_A);
  assert.equal(store.backgroundTasks[SID_A]?.['t1']?.description, 'A 任务');
  assert.equal(store.backgroundTasks[SID_B]?.['t1'], undefined, 'B 桶不得出现 A 的卡');
  assert.equal(Object.keys(store.activeBackgroundTasks).length, 0, 'B 视图不得出现 A 的任务卡');
});

check('B2 切回 A：A 的运行中卡仍在且 startedAt 保留（切回计时恢复）', () => {
  const store = freshStore();
  setActive(store, SID_B);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't1', description: 'A 任务' }, SID_A);
  setActive(store, SID_A);
  const card = store.activeBackgroundTasks['t1'];
  assert.ok(card, '切回 A 后运行卡应可见');
  assert.ok(typeof card.startedAt === 'number', 'startedAt 保留（计时恢复）');
});

check('B3 A 后台完成：终态卡留在 A 桶；B 视图无残留', () => {
  const store = freshStore();
  setActive(store, SID_B);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't2', description: 'A 任务' }, SID_A);
  applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 't2', status: 'completed' }, SID_A);
  setActive(store, SID_A);
  assert.equal(store.activeBackgroundTasks['t2']?.status, 'completed', '终态卡保留在 A 桶（1973d30 语义）');
  setActive(store, SID_B);
  assert.equal(store.activeBackgroundTasks['t2'], undefined, 'B 视图无 A 的终态卡');
});

check('B4 回合边界清卡只及本会话：A 清终态留运行，B 的终态卡不动（反向串扰修复）', () => {
  const store = freshStore();
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_run', description: 'A 运行' }, SID_A);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_done', description: 'A 终态' }, SID_A);
  applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 't_done', status: 'completed' }, SID_A);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_b', description: 'B 终态' }, SID_B);
  applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 't_b', status: 'completed' }, SID_B);
  store.clearBackgroundTasks(SID_A);
  assert.ok(store.backgroundTasks[SID_A]?.['t_run'], 'A 运行中卡保留（跨回合）');
  assert.equal(store.backgroundTasks[SID_A]?.['t_done'], undefined, 'A 终态卡被清');
  assert.equal(store.backgroundTasks[SID_B]?.['t_b']?.status, 'completed', 'B 的终态卡不受 A 回合边界影响');
});

check('B5 removeBackgroundTask 双键删除：错会话键不误删', () => {
  const store = freshStore();
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't9', description: 'x' }, SID_A);
  store.removeBackgroundTask(SID_B, 't9');
  assert.ok(store.backgroundTasks[SID_A]?.['t9'], '错会话键（B, t9）不得删 A 的卡');
  store.removeBackgroundTask(SID_A, 't9');
  assert.equal(store.backgroundTasks[SID_A]?.['t9'], undefined);
});

check('B6 缺桶/空桶安全：getter 回落空对象；clear/remove 对缺桶 no-op 不抛错', () => {
  const store = freshStore();
  setActive(store, 'sess_none');
  assert.deepEqual(store.activeBackgroundTasks, {});
  store.clearBackgroundTasks('sess_none');
  store.removeBackgroundTask('sess_none', 'nope');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
