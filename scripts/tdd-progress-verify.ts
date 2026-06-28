// tdd-progress-verify.ts
// C（进度状态层）行为测试：纯逻辑（progress-events 转换、store 状态、事件→store 映射）。
// Vue 组件无测试框架（项目无 jest/vitest），由 selftest 第 34 节结构契约 + typecheck 覆盖。
// 运行：npx tsx scripts/tdd-progress-verify.ts
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { convertToolProgress, convertTaskEvent } from '../src/shared/progress-events';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { applyProgressEvent } from '../src/renderer/composables/use-chat';

setActivePinia(createPinia());

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

console.log('\n=== session-store: toolProgress（C）===');
check('setToolProgress 写入 + clearToolProgress 清除', () => {
  const store = useSessionStore();
  store.setToolProgress('toolu_tp', 3.2);
  assert.equal(store.toolProgress['toolu_tp'], 3.2);
  store.clearToolProgress('toolu_tp');
  assert.equal(store.toolProgress['toolu_tp'], undefined);
});

console.log('\n=== session-store: backgroundTasks（C）===');
check('upsert 写入 + 覆盖 + remove 清除', () => {
  const store = useSessionStore();
  store.upsertBackgroundTask({ taskId: 'bg_1', description: 'run tests', taskType: 'local_bash' });
  assert.equal(store.backgroundTasks['bg_1'].description, 'run tests');
  store.upsertBackgroundTask({ taskId: 'bg_1', description: 'build', lastToolName: 'Bash' });
  assert.equal(store.backgroundTasks['bg_1'].description, 'build');
  assert.equal(store.backgroundTasks['bg_1'].lastToolName, 'Bash');
  store.removeBackgroundTask('bg_1');
  assert.equal(store.backgroundTasks['bg_1'], undefined);
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
  applyProgressEvent(store, { type: 'tool_progress', toolUseId: 'tu_ap', elapsedSeconds: 5 });
  assert.equal(store.toolProgress['tu_ap'], 5);
  store.clearToolProgress('tu_ap');
});
check('compacting → setCompacting(true)', () => {
  const store = useSessionStore();
  store.setCompacting(false);
  applyProgressEvent(store, { type: 'system', subtype: 'compacting' });
  assert.equal(store.compacting, true);
  store.setCompacting(false);
});
check('task_started → upsertBackgroundTask', () => {
  const store = useSessionStore();
  applyProgressEvent(store, { type: 'system', subtype: 'task_started', taskId: 't_ap', description: 'build', taskType: 'local_bash' });
  assert.equal(store.backgroundTasks['t_ap'].description, 'build');
  store.removeBackgroundTask('t_ap');
});
check('非进度事件不改动（result 不抛错、不动 compacting）', () => {
  const store = useSessionStore();
  store.setCompacting(false);
  applyProgressEvent(store, { type: 'result', subtype: 'success', result: '', total_cost_usd: 0, duration_ms: 0, num_turns: 0, session_id: '', is_error: false });
  assert.equal(store.compacting, false);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
