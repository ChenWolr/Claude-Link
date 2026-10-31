// tdd-progress-verify.ts
// C（进度状态层）行为测试：纯逻辑（progress-events 转换、store 状态、事件→store 映射）。
// Vue 组件无测试框架（项目无 jest/vitest），由 selftest 第 34 节结构契约 + typecheck 覆盖。
// P5（2026-10-22）：backgroundTasks 按会话分桶（外层 sessionId → 内层 taskId）——本文件用例
// 均为单会话语境，统一传本会话 id SID；跨会话桶隔离/切回可见性由
// tdd-background-task-session-scope-verify.ts 专测。
// 运行：npx tsx scripts/tdd-progress-verify.ts
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { convertToolProgress, convertTaskEvent } from '../src/shared/progress-events';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { applyProgressEvent } from '../src/renderer/composables/use-chat';

setActivePinia(createPinia());

// 单会话语境的固定会话 id（backgroundTasks 桶键；见文件头 P5 说明）。
const SID = 'sess_tdd';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

console.log('\n=== convertToolProgress：SDK tool_progress → CliToolProgressEvent ===');
check('映射 tool_use_id/tool_name/parent_tool_use_id/elapsed_time_seconds', () => {
  const e = convertToolProgress({
    tool_use_id: 'toolu_1',
    tool_name: 'Bash',
    parent_tool_use_id: 'toolu_0',
    elapsed_time_seconds: 3.2,
  });
  assert.equal(e.type, 'tool_progress');
  assert.equal(e.toolUseId, 'toolu_1');
  assert.equal(e.toolName, 'Bash');
  assert.equal(e.parentToolUseId, 'toolu_0');
  assert.equal(e.elapsedSeconds, 3.2);
});
check('缺字段兜底（toolUseId 空串，可选项 undefined，elapsed 0）', () => {
  const e = convertToolProgress({});
  assert.equal(e.toolUseId, '');
  assert.equal(e.toolName, undefined);
  assert.equal(e.parentToolUseId, undefined);
  assert.equal(e.elapsedSeconds, 0);
});

console.log('\n=== convertTaskEvent：SDK task_* → CliTaskEvent ===');
check('task_started 映射 taskId/description/taskType/toolUseId', () => {
  const e = convertTaskEvent('task_started', {
    task_id: 't1',
    tool_use_id: 'toolu_1',
    description: 'run tests',
    task_type: 'local_bash',
  });
  assert.equal(e.type, 'system');
  assert.equal(e.subtype, 'task_started');
  assert.equal(e.taskId, 't1');
  assert.equal(e.toolUseId, 'toolu_1');
  assert.equal(e.description, 'run tests');
  assert.equal(e.taskType, 'local_bash');
});
check('task_notification 映射 status + usage（snake → camel）', () => {
  const e = convertTaskEvent('task_notification', {
    task_id: 't1',
    status: 'completed',
    usage: { total_tokens: 500, tool_uses: 3, duration_ms: 1200 },
  });
  assert.equal(e.subtype, 'task_notification');
  assert.equal(e.status, 'completed');
  assert.equal(e.usage?.totalTokens, 500);
  assert.equal(e.usage?.toolUses, 3);
  assert.equal(e.usage?.durationMs, 1200);
});
check('缺字段兜底（taskId 空串，taskType undefined）', () => {
  const e = convertTaskEvent('task_progress', {});
  assert.equal(e.taskId, '');
  assert.equal(e.taskType, undefined);
  assert.equal(e.usage, undefined);
});

console.log('\n=== convertTaskEvent：D 点新增字段映射（prompt/subagentType/outputFile/skipTranscript）===');
check('task_started 映射 prompt + subagent_type→subagentType + skip_transcript→skipTranscript', () => {
  const e = convertTaskEvent('task_started', {
    task_id: 't_d1',
    description: 'research',
    subagent_type: 'Explore',
    prompt: 'find usages',
    skip_transcript: true,
  });
  assert.equal(e.prompt, 'find usages');
  assert.equal(e.subagentType, 'Explore');
  assert.equal(e.skipTranscript, true);
});
check('task_progress 映射 subagent_type→subagentType', () => {
  const e = convertTaskEvent('task_progress', { task_id: 't_d1', subagent_type: 'Plan' });
  assert.equal(e.subagentType, 'Plan');
});
check('task_notification 映射 output_file→outputFile + skip_transcript→skipTranscript', () => {
  const e = convertTaskEvent('task_notification', {
    task_id: 't_d1',
    status: 'completed',
    output_file: 'C:/tmp/out.log',
    skip_transcript: true,
  });
  assert.equal(e.outputFile, 'C:/tmp/out.log');
  assert.equal(e.skipTranscript, true);
});

// D 点：用假时钟驱动 Date.now，让 startedAt/progressHistory.at 断言跨毫秒稳定（不 sleep）。
function withFakeNow(fn: (advance: (ms: number) => void) => void): void {
  const real = Date.now;
  let fake = 1_700_000_000_000;
  Date.now = () => fake;
  try {
    fn((ms) => {
      fake += ms;
    });
  } finally {
    Date.now = real;
  }
}

console.log('\n=== D：store 扩展 + task_* 事件语义（skipTranscript 滤除/startedAt 保留/history cap/终态保留）===');
check('clearBackgroundTasks 只清终态卡：started → 清 → 运行卡仍在 → progress 仍被消费 → 终态 → 再清 → 卡消失', () => {
  const store = useSessionStore();
  withFakeNow((advance) => {
    // F4 新语义：回合边界只清上一回合终态卡；运行中卡保留跨回合（progress 继续被消费）。
    applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 'bg_c1', description: 'run', taskType: 'local_bash' }, SID);
    store.clearBackgroundTasks(SID);
    assert.ok(store.backgroundTasks[SID]?.['bg_c1'], '运行中卡不得被回合边界 clearBackgroundTasks 清掉');
    advance(1_000);
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_progress', taskId: 'bg_c1', usage: { totalTokens: 10, toolUses: 1 }, lastToolName: 'Bash',
    }, SID);
    assert.equal((store.backgroundTasks[SID]?.['bg_c1'].progressHistory as unknown[]).length, 1, '清后运行卡的 progress 仍应被消费（history 增长）');
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_notification', taskId: 'bg_c1', status: 'completed', usage: { totalTokens: 10, toolUses: 1, durationMs: 900 },
    }, SID);
    assert.equal(store.backgroundTasks[SID]?.['bg_c1'].status, 'completed');
    store.clearBackgroundTasks(SID);
    assert.equal(store.backgroundTasks[SID]?.['bg_c1'], undefined, '终态卡在下次回合边界被清');
  });
});
check('clearBackgroundTasks 终态+运行混合：只删终态卡，运行中卡保留', () => {
  const store = useSessionStore();
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 'bg_mix_run', description: 'running', taskType: 'local_bash' }, SID);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 'bg_mix_done', description: 'done', taskType: 'local_bash' }, SID);
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 'bg_mix_fail', description: 'fail', taskType: 'local_bash' }, SID);
  applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 'bg_mix_done', status: 'completed' }, SID);
  applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 'bg_mix_fail', status: 'failed' }, SID);
  store.clearBackgroundTasks(SID);
  assert.ok(store.backgroundTasks[SID]?.['bg_mix_run'], '无 status（运行中）卡应保留');
  assert.equal(store.backgroundTasks[SID]?.['bg_mix_done'], undefined, 'completed 终态卡应被清');
  assert.equal(store.backgroundTasks[SID]?.['bg_mix_fail'], undefined, 'failed 终态卡应被清');
});
check('task_started skipTranscript=true 内务任务不建卡', () => {
  const store = useSessionStore();
  applyProgressEvent(store, {
    type: 'system', subtype: 'task_started', taskId: 't_hk', description: 'housekeeping', taskType: 'local_bash', skipTranscript: true,
  }, SID);
  assert.equal(store.backgroundTasks[SID]?.['t_hk'], undefined);
});
check('task_notification skipTranscript=true 同样滤除（内务完全不出现在面板）', () => {
  const store = useSessionStore();
  applyProgressEvent(store, {
    type: 'system', subtype: 'task_notification', taskId: 't_hk2', status: 'completed', skipTranscript: true, summary: 'hk done',
  }, SID);
  assert.equal(store.backgroundTasks[SID]?.['t_hk2'], undefined);
});
check('task_started 建 startedAt/progressHistory/prompt/subagentType；重复 started 不重置计时', () => {
  const store = useSessionStore();
  withFakeNow((advance) => {
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_started', taskId: 't_dup', description: 'x', taskType: 'local_agent', subagentType: 'Explore', prompt: 'p',
    }, SID);
    const first = store.backgroundTasks[SID]?.['t_dup'];
    assert.equal(first.startedAt, 1_700_000_000_000);
    assert.deepEqual(first.progressHistory, []);
    assert.equal(first.subagentType, 'Explore');
    assert.equal(first.prompt, 'p');
    advance(5_000);
    // 重复 started（SDK 重发/迟到）：startedAt 保留旧值，progressHistory 不被清空
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_started', taskId: 't_dup', description: 'x again', taskType: 'local_agent',
    }, SID);
    const again = store.backgroundTasks[SID]?.['t_dup'];
    assert.equal(again.startedAt, 1_700_000_000_000);
    assert.deepEqual(again.progressHistory, []);
    assert.equal(again.description, 'x again'); // 其余字段照常 upsert
  });
});
check('task_progress push progressHistory（cap 50 丢最旧）+ usage/lastToolName/subagentType upsert', () => {
  const store = useSessionStore();
  withFakeNow((advance) => {
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_started', taskId: 't_cap', description: 'cap', taskType: 'local_bash',
    }, SID);
    for (let i = 1; i <= 55; i += 1) {
      advance(100);
      applyProgressEvent(store, {
        type: 'system', subtype: 'task_progress', taskId: 't_cap', subagentType: i === 20 ? 'Explore' : undefined,
        usage: { totalTokens: i * 10, toolUses: i, durationMs: i * 100 }, lastToolName: `T${i}`,
      }, SID);
    }
    const card = store.backgroundTasks[SID]?.['t_cap'];
    const hist = card.progressHistory as Array<Record<string, number | string | undefined>>;
    assert.equal(hist.length, 50);
    assert.equal((hist[0].lastToolName as string), 'T6'); // 前 5 条被挤出（丢最旧）
    assert.equal((hist[49].lastToolName as string), 'T55');
    assert.equal(hist[49].totalTokens, 550);
    assert.equal(card.lastToolName, 'T55');
    assert.equal(card.usage?.totalTokens, 550);
    assert.equal(card.subagentType, 'Explore'); // progress 携带的 subagentType 也 upsert
  });
});
check('task_progress 无卡忽略；终态卡后的迟到 progress 忽略（事件乱序边界）', () => {
  const store = useSessionStore();
  withFakeNow(() => {
    // 无卡（未 started）：忽略不建卡
    applyProgressEvent(store, { type: 'system', subtype: 'task_progress', taskId: 't_ghost', usage: { totalTokens: 1 } }, SID);
    assert.equal(store.backgroundTasks[SID]?.['t_ghost'], undefined);
    // started → notification 终态 → 迟到 progress：不追加历史、不复活、status 不变
    applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_late', description: 'late', taskType: 'local_bash' }, SID);
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_notification', taskId: 't_late', status: 'completed', usage: { totalTokens: 5, toolUses: 1, durationMs: 100 },
    }, SID);
    applyProgressEvent(store, { type: 'system', subtype: 'task_progress', taskId: 't_late', usage: { totalTokens: 99, toolUses: 9 }, lastToolName: 'Late' }, SID);
    const card = store.backgroundTasks[SID]?.['t_late'];
    assert.equal(card.status, 'completed');
    assert.equal((card.progressHistory as unknown[]).length, 0);
    assert.equal(card.lastToolName, undefined);
    assert.equal(card.usage?.totalTokens, 5);
  });
});
check('迟到/重复 task_started 不复活终态卡（status/startedAt/progressHistory 不变）', () => {
  const store = useSessionStore();
  withFakeNow((advance) => {
    applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_late_start', description: 'first', taskType: 'local_bash' }, SID);
    const startedAt = store.backgroundTasks[SID]?.['t_late_start'].startedAt;
    applyProgressEvent(store, { type: 'system', subtype: 'task_notification', taskId: 't_late_start', status: 'completed', summary: 'done' }, SID);
    advance(5_000);
    // F5：终态守卫——迟到的重复 started 不得把 completed 卡复活为永久运行中
    applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_late_start', description: 'late again', taskType: 'local_bash' }, SID);
    const card = store.backgroundTasks[SID]?.['t_late_start'];
    assert.equal(card.status, 'completed', '终态不得被迟到 started 覆盖');
    assert.equal(card.startedAt, startedAt, 'startedAt 不变');
    assert.deepEqual(card.progressHistory, [], 'progressHistory 不变');
    assert.equal(card.summary, 'done', '终态 summary 不变');
  });
});
check('task_notification 终态卡保留（无 4s 自动删除定时器）+ status/outputFile 更新', () => {
  const store = useSessionStore();
  // 捕获式 setTimeout stub：行为级断言「flush 全部挂起定时器后终态卡仍在」；
  // 旧实现会排 4s removeBackgroundTask → flush 后卡片被删（红）；新实现无定时器、卡片保留（绿）。
  const realSetTimeout = globalThis.setTimeout;
  const scheduled: Array<() => void> = [];
  globalThis.setTimeout = ((fn: () => void) => {
    scheduled.push(fn);
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;
  try {
    applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_fin', description: 'fin', taskType: 'local_bash' }, SID);
    applyProgressEvent(store, {
      type: 'system', subtype: 'task_notification', taskId: 't_fin', status: 'completed',
      outputFile: 'C:/tmp/out.log', summary: 'done', usage: { totalTokens: 9, toolUses: 2, durationMs: 800 },
    }, SID);
    const card = store.backgroundTasks[SID]?.['t_fin'];
    assert.equal(card.status, 'completed');
    // F6：终态计时兜底——finishedAt 在终态到达时刻快照，存在且 ≥ startedAt（durationMs 缺失时兜底用）。
    assert.ok(card.finishedAt != null, '终态卡应有 finishedAt');
    assert.ok(card.startedAt != null, '运行卡应有 startedAt');
    assert.ok(card.finishedAt >= (card.startedAt as number), 'finishedAt 应 ≥ startedAt');
    assert.equal(card.outputFile, 'C:/tmp/out.log');
    assert.equal(card.summary, 'done');
    assert.equal(card.usage?.durationMs, 800);
    for (const fn of scheduled) fn(); // flush 全部挂起定时器
    assert.ok(store.backgroundTasks[SID]?.['t_fin'], '终态卡应保留，不得 4s 自动删除');
    assert.equal(scheduled.length, 0, '不应再排自动删除定时器');
  } finally {
    globalThis.setTimeout = realSetTimeout;
    for (const fn of scheduled) fn(); // 兜底 flush，防 stub 期间排的定时器泄漏到后续用例
  }
});

console.log('\n=== session-store: toolProgress（C）===');
check('setToolProgress 写入 + clearToolProgress 清除', () => {
  const store = useSessionStore();
  store.setToolProgress('toolu_tp', 3.2);
  assert.equal(store.toolProgress['toolu_tp'], 3.2);
  store.clearToolProgress('toolu_tp');
  assert.equal(store.toolProgress['toolu_tp'], undefined);
});

console.log('\n=== session-store: backgroundTasks（C，P5 起按会话分桶）===');
check('upsert 写入 + 覆盖 + remove 清除（本会话桶内）', () => {
  const store = useSessionStore();
  store.upsertBackgroundTask(SID, { taskId: 'bg_1', description: 'run tests', taskType: 'local_bash' });
  assert.equal(store.backgroundTasks[SID]?.['bg_1'].description, 'run tests');
  store.upsertBackgroundTask(SID, { taskId: 'bg_1', description: 'build', lastToolName: 'Bash' });
  assert.equal(store.backgroundTasks[SID]?.['bg_1'].description, 'build');
  assert.equal(store.backgroundTasks[SID]?.['bg_1'].lastToolName, 'Bash');
  store.removeBackgroundTask(SID, 'bg_1');
  assert.equal(store.backgroundTasks[SID]?.['bg_1'], undefined);
});

console.log('\n=== session-store: compacting（C）===');
check('setCompacting 切换', () => {
  const store = useSessionStore();
  assert.equal(store.compacting, false);
  store.setCompacting(true);
  assert.equal(store.compacting, true);
  store.setCompacting(false);
  assert.equal(store.compacting, false);
});

console.log('\n=== applyProgressEvent：事件 → store 映射 ===');
check('tool_progress → setToolProgress', () => {
  const store = useSessionStore();
  applyProgressEvent(store, { type: 'tool_progress', toolUseId: 'tu_ap', elapsedSeconds: 5 }, SID);
  assert.equal(store.toolProgress['tu_ap'], 5);
  store.clearToolProgress('tu_ap');
});
check('compacting → setCompacting(true)', () => {
  const store = useSessionStore();
  store.setCompacting(false);
  applyProgressEvent(store, { type: 'system', subtype: 'compacting' }, SID);
  assert.equal(store.compacting, true);
  store.setCompacting(false);
});
check('task_started → upsertBackgroundTask（入本会话桶）', () => {
  const store = useSessionStore();
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_ap', description: 'build', taskType: 'local_bash' }, SID);
  assert.equal(store.backgroundTasks[SID]?.['t_ap'].description, 'build');
  store.removeBackgroundTask(SID, 't_ap');
});
check('非进度事件不改动（result 不抛错、不动 compacting）', () => {
  const store = useSessionStore();
  store.setCompacting(false);
  applyProgressEvent(store, { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 0, num_turns: 0, session_id: '', is_error: false }, SID);
  assert.equal(store.compacting, false);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
