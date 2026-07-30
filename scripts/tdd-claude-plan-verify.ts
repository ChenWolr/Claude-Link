// tdd-claude-plan-verify.ts
// Claude 计划任务纯行为测试：验证 TodoWrite / TaskCreate/Update/List/Get 解析与 reducer。
// 独立于 DB / Electron / Pinia，使用 node:assert + tsx 运行。
//
// 运行：npx tsx scripts/tdd-claude-plan-verify.ts

import assert from 'node:assert/strict';
import {
  parseTodoWriteInput,
  parseTodoWriteOutput,
  parseTaskCreateInput,
  parseTaskCreateOutput,
  parseTaskUpdateInput,
  parseTaskListOutput,
  parseTaskGetOutput,
  parseTaskUpdatedPatch,
  applyPlanEvent,
  createEmptyPlanState,
} from '../src/shared/types/claude-plan';
import type { ClaudePlanState, ClaudeTodoItem, ClaudePlanTask } from '../src/shared/types/claude-plan';

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── parseTodoWriteInput ──────────────────────────────────

console.log('\n── parseTodoWriteInput ──');

test('合法 todos 数组', () => {
  const result = parseTodoWriteInput({
    todos: [
      { content: '步骤1', status: 'pending', activeForm: '正在步骤1' },
      { content: '步骤2', status: 'in_progress', activeForm: '正在步骤2' },
      { content: '步骤3', status: 'completed', activeForm: '完成步骤3' },
    ],
  });
  assert.ok(result);
  assert.equal(result!.length, 3);
  assert.equal(result![0].status, 'pending');
  assert.equal(result![1].status, 'in_progress');
  assert.equal(result![2].status, 'completed');
});

test('空数组（显式清空）', () => {
  const result = parseTodoWriteInput({ todos: [] });
  assert.ok(result);
  assert.equal(result!.length, 0);
});

test('非法 status 返回 null', () => {
  const result = parseTodoWriteInput({
    todos: [{ content: 'x', status: 'running', activeForm: 'x' }],
  });
  assert.equal(result, null);
});

test('非数组 todos 返回 null', () => {
  assert.equal(parseTodoWriteInput({ todos: 'not-array' }), null);
  assert.equal(parseTodoWriteInput({}), null);
});

test('过长 content 被截断', () => {
  const long = 'a'.repeat(10000);
  const result = parseTodoWriteInput({
    todos: [{ content: long, status: 'pending', activeForm: 'x' }],
  });
  assert.ok(result);
  assert.equal(result![0].content.length, 5000);
});

// ── parseTodoWriteOutput ─────────────────────────────────

console.log('\n── parseTodoWriteOutput ──');

test('合法 newTodos', () => {
  const result = parseTodoWriteOutput({
    oldTodos: [],
    newTodos: [{ content: '新', status: 'in_progress', activeForm: '正在新' }],
  });
  assert.ok(result);
  assert.equal(result!.length, 1);
  assert.equal(result![0].content, '新');
});

test('无 newTodos 返回 null', () => {
  assert.equal(parseTodoWriteOutput({ oldTodos: [] }), null);
});

// ── parseTaskCreateInput ─────────────────────────────────

console.log('\n── parseTaskCreateInput ──');

test('合法 TaskCreate input', () => {
  const result = parseTaskCreateInput({
    subject: '设计数据库',
    description: '设计 SQLite schema',
    activeForm: '正在设计数据库',
    metadata: { priority: 'high' },
  });
  assert.ok(result);
  assert.equal(result!.subject, '设计数据库');
  assert.equal(result!.description, '设计 SQLite schema');
  assert.equal(result!.activeForm, '正在设计数据库');
  assert.deepEqual(result!.metadata, { priority: 'high' });
});

test('空 subject 返回 null', () => {
  assert.equal(parseTaskCreateInput({ subject: '', description: 'x' }), null);
  assert.equal(parseTaskCreateInput({ description: 'x' }), null);
});

test('无 activeForm 不报错', () => {
  const result = parseTaskCreateInput({ subject: 'test', description: 'd' });
  assert.ok(result);
  assert.equal(result!.activeForm, undefined);
});

// ── parseTaskCreateOutput ────────────────────────────────

console.log('\n── parseTaskCreateOutput ──');

test('合法 task.id', () => {
  const result = parseTaskCreateOutput({ task: { id: 'task-1', subject: '标题' } });
  assert.ok(result);
  assert.equal(result!.id, 'task-1');
  assert.equal(result!.subject, '标题');
});

test('空 id 返回 null', () => {
  assert.equal(parseTaskCreateOutput({ task: { id: '', subject: 'x' } }), null);
  assert.equal(parseTaskCreateOutput({}), null);
});

// ── parseTaskUpdateInput ─────────────────────────────────

console.log('\n── parseTaskUpdateInput ──');

test('patch 模式', () => {
  const result = parseTaskUpdateInput({
    taskId: 'task-1',
    status: 'in_progress',
    subject: '更新标题',
  });
  assert.ok(result);
  assert.ok(!('delete' in result));
  assert.equal(result!.taskId, 'task-1');
  if (!('delete' in result)) {
    assert.equal(result!.patch.status, 'in_progress');
    assert.equal(result!.patch.subject, '更新标题');
  }
});

test('delete 模式', () => {
  const result = parseTaskUpdateInput({
    taskId: 'task-1',
    status: 'deleted',
  });
  assert.ok(result);
  assert.ok('delete' in result);
  assert.equal(result!.taskId, 'task-1');
});

test('空 taskId 返回 null', () => {
  assert.equal(parseTaskUpdateInput({ taskId: '', status: 'pending' }), null);
});

// ── parseTaskListOutput ──────────────────────────────────

console.log('\n── parseTaskListOutput ──');

test('合法 tasks 数组', () => {
  const result = parseTaskListOutput({
    tasks: [
      { id: 't1', subject: '任务1', status: 'pending', blockedBy: [] },
      { id: 't2', subject: '任务2', status: 'completed', blockedBy: ['t1'] },
    ],
  });
  assert.ok(result);
  assert.equal(result!.length, 2);
  assert.equal(result![0].id, 't1');
  assert.equal(result![1].blockedBy[0], 't1');
});

test('过滤非法 status', () => {
  const result = parseTaskListOutput({
    tasks: [
      { id: 't1', subject: '任务1', status: 'pending', blockedBy: [] },
      { id: 't2', subject: '任务2', status: 'running', blockedBy: [] },
    ],
  });
  assert.ok(result);
  assert.equal(result!.length, 1); // running 被过滤
});

test('非数组返回 null', () => {
  assert.equal(parseTaskListOutput({ tasks: 'x' }), null);
});

// ── parseTaskGetOutput ───────────────────────────────────

console.log('\n── parseTaskGetOutput ──');

test('合法 task', () => {
  const result = parseTaskGetOutput({
    task: {
      id: 't1',
      subject: '任务1',
      description: '描述',
      status: 'in_progress',
      blocks: ['t2'],
      blockedBy: [],
    },
  });
  assert.ok(result);
  assert.equal(result!.id, 't1');
  assert.equal(result!.status, 'in_progress');
  assert.deepEqual(result!.blocks, ['t2']);
});

test('null task 返回 null', () => {
  assert.equal(parseTaskGetOutput({ task: null }), null);
  assert.equal(parseTaskGetOutput({}), null);
});

// ── parseTaskUpdatedPatch ────────────────────────────────

console.log('\n── parseTaskUpdatedPatch ──');

test('running 归一化为 in_progress', () => {
  const result = parseTaskUpdatedPatch({
    task_id: 't1',
    patch: { status: 'running' },
  });
  assert.ok(result);
  assert.equal(result!.patch.status, 'in_progress');
});

test('completed 保留', () => {
  const result = parseTaskUpdatedPatch({
    task_id: 't1',
    patch: { status: 'completed' },
  });
  assert.ok(result);
  assert.equal(result!.patch.status, 'completed');
});

test('failed 保留', () => {
  const result = parseTaskUpdatedPatch({
    task_id: 't1',
    patch: { status: 'failed' },
  });
  assert.ok(result);
  assert.equal(result!.patch.status, 'failed');
});

test('未知 status 返回 null', () => {
  assert.equal(
    parseTaskUpdatedPatch({ task_id: 't1', patch: { status: 'unknown' } }),
    null,
  );
});

test('空 task_id 返回 null', () => {
  assert.equal(parseTaskUpdatedPatch({ task_id: '', patch: { status: 'running' } }), null);
});

test('无 status 的 patch 不报错', () => {
  const result = parseTaskUpdatedPatch({
    task_id: 't1',
    patch: { description: '更新描述' },
  });
  assert.ok(result);
  assert.equal(result!.patch.description, '更新描述');
  assert.equal(result!.patch.status, undefined);
});

// ── applyPlanEvent (reducer) ─────────────────────────────

console.log('\n── applyPlanEvent (reducer) ──');

const SID = 'session-1';

test('todos_replace 替换并递增 revision', () => {
  const state = createEmptyPlanState(SID);
  const todos: ClaudeTodoItem[] = [
    { content: 'A', status: 'pending', activeForm: 'A' },
    { content: 'B', status: 'in_progress', activeForm: 'B' },
  ];
  const next = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: SID, todos,
  });
  assert.equal(next.todos.length, 2);
  assert.equal(next.revision, 1);
  assert.notEqual(next.updatedAt, state.updatedAt);
});

test('task_upsert 新增任务', () => {
  let state = createEmptyPlanState(SID);
  const task: ClaudePlanTask = {
    id: 't1', subject: '任务1', description: '', status: 'pending',
    blocks: [], blockedBy: [],
  };
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID, task,
  });
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 't1');
  assert.equal(state.revision, 1);
});

test('task_upsert 更新已有任务', () => {
  let state = createEmptyPlanState(SID);
  const task: ClaudePlanTask = {
    id: 't1', subject: '旧', description: '', status: 'pending',
    blocks: [], blockedBy: [],
  };
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID, task,
  });
  const updated: ClaudePlanTask = { ...task, subject: '新', status: 'in_progress' };
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID, task: updated,
  });
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].subject, '新');
  assert.equal(state.tasks[0].status, 'in_progress');
  assert.equal(state.revision, 2);
});

test('task_patch 更新已知任务', () => {
  let state = createEmptyPlanState(SID);
  const task: ClaudePlanTask = {
    id: 't1', subject: '原始', description: '', status: 'pending',
    blocks: [], blockedBy: [],
  };
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID, task,
  });
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_patch', sessionId: SID,
    taskId: 't1', patch: { status: 'completed' },
  });
  assert.equal(state.tasks[0].status, 'completed');
  assert.equal(state.revision, 2);
});

test('task_patch 未知 taskId 不创建假任务', () => {
  const state = createEmptyPlanState(SID);
  const next = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_patch', sessionId: SID,
    taskId: 'unknown', patch: { status: 'completed' },
  });
  assert.equal(next.tasks.length, 0);
  assert.equal(next.revision, 1); // revision 仍递增
});

test('tasks_replace 完整替换', () => {
  let state = createEmptyPlanState(SID);
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID,
    task: { id: 'old', subject: '旧', description: '', status: 'completed', blocks: [], blockedBy: [] },
  });
  const tasks: ClaudePlanTask[] = [
    { id: 't1', subject: '新1', description: '', status: 'pending', blocks: [], blockedBy: [] },
    { id: 't2', subject: '新2', description: '', status: 'in_progress', blocks: [], blockedBy: [] },
  ];
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'tasks_replace', sessionId: SID, tasks,
  });
  assert.equal(state.tasks.length, 2);
  assert.equal(state.tasks[0].id, 't1');
  assert.equal(state.tasks[1].id, 't2');
  assert.equal(state.revision, 2);
});

test('task_delete 移除任务', () => {
  let state = createEmptyPlanState(SID);
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_upsert', sessionId: SID,
    task: { id: 't1', subject: '任务1', description: '', status: 'pending', blocks: [], blockedBy: [] },
  });
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'task_delete', sessionId: SID, taskId: 't1',
  });
  assert.equal(state.tasks.length, 0);
  assert.equal(state.revision, 2);
});

test('revision 保护：旧 revision 不覆盖新状态', () => {
  let state = createEmptyPlanState(SID);
  // 应用 revision=1 的事件
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: SID,
    todos: [{ content: '新', status: 'pending', activeForm: '新' }],
    revision: 1,
  });
  assert.equal(state.todos.length, 1);
  assert.equal(state.revision, 1);
  // 尝试用 revision=0 的事件覆盖（应被拒绝）
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: SID,
    todos: [{ content: '旧', status: 'completed', activeForm: '旧' }],
    revision: 0,
  });
  assert.equal(state.todos.length, 1);
  assert.equal(state.todos[0].content, '新');
  assert.equal(state.revision, 1); // 未递增
});

test('跨会话事件不应用', () => {
  const state = createEmptyPlanState(SID);
  const next = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: 'other-session',
    todos: [{ content: 'x', status: 'pending', activeForm: 'x' }],
  });
  assert.equal(next.todos.length, 0);
  assert.equal(next.revision, 0);
});

test('空数组 todos_replace 清空', () => {
  let state = createEmptyPlanState(SID);
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: SID,
    todos: [{ content: 'A', status: 'pending', activeForm: 'A' }],
  });
  state = applyPlanEvent(state, {
    type: 'claude_plan', operation: 'todos_replace', sessionId: SID,
    todos: [],
  });
  assert.equal(state.todos.length, 0);
  assert.equal(state.revision, 2);
});

// ── createEmptyPlanState ─────────────────────────────────

console.log('\n── createEmptyPlanState ──');

test('空快照初始值', () => {
  const state = createEmptyPlanState('test');
  assert.equal(state.sessionId, 'test');
  assert.equal(state.todos.length, 0);
  assert.equal(state.tasks.length, 0);
  assert.equal(state.revision, 0);
  assert.ok(state.updatedAt);
});

// ── 结果汇总 ─────────────────────────────────────────────

console.log(`\n${'='.repeat(60)}`);
console.log(`Claude Plan 纯行为测试：${passed} 通过，${failed} 失败`);
console.log('='.repeat(60));

if (failed > 0) {
  process.exit(1);
}
