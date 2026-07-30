// claude-plan-repo.ts
// Claude 计划状态快照持久化。独立于手动排队 tasks 表，不复用其 schema 或查询语义。
//
// TodoWrite 是完整替换快照；TaskCreate/Update 是 patch；TaskList 是完整任务集合替换。
// 每次成功合并在事务内递增 revision 并返回完整快照（供主进程 IPC 推送）。
// ON DELETE CASCADE 保证删除会话时自动清理 claude_plan_state 行。

import { getConnection } from '../connection';
import type {
  ClaudePlanState,
  ClaudePlanTask,
  ClaudeTodoItem,
} from '../../../shared/types/claude-plan';

interface PlanStateRow {
  session_id: string;
  todos_json: string;
  tasks_json: string;
  revision: number;
  updated_at: string;
}

function rowToState(row: PlanStateRow | undefined): ClaudePlanState | null {
  if (!row) return null;
  let todos: ClaudeTodoItem[] = [];
  let tasks: ClaudePlanTask[] = [];
  try {
    const parsedTodos = JSON.parse(row.todos_json);
    if (Array.isArray(parsedTodos)) todos = parsedTodos;
  } catch {
    // 坏 JSON 不覆盖，返回空数组
  }
  try {
    const parsedTasks = JSON.parse(row.tasks_json);
    if (Array.isArray(parsedTasks)) tasks = parsedTasks;
  } catch {
    // 坏 JSON 不覆盖，返回空数组
  }
  return {
    sessionId: row.session_id,
    todos,
    tasks,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

/** 读取会话的计划快照。无记录返回 null。 */
export function getPlanState(sessionId: string): ClaudePlanState | null {
  const db = getConnection();
  const row = db.prepare(
    'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
  ).get(sessionId) as PlanStateRow | undefined;
  return rowToState(row);
}

/** 确保有行存在（无则插入空快照），返回当前行。 */
function ensureRow(db: ReturnType<typeof getConnection>, sessionId: string): PlanStateRow {
  // INSERT OR IGNORE: 若行已存在则不动，保持已有 revision/todos/tasks。
  db.prepare(
    `INSERT OR IGNORE INTO claude_plan_state (session_id, todos_json, tasks_json, revision, updated_at)
     VALUES (?, '[]', '[]', 0, datetime('now'))`,
  ).run(sessionId);
  return db.prepare(
    'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
  ).get(sessionId) as PlanStateRow;
}

/** 替换 TodoWrite 完整快照，递增 revision，返回完整状态。 */
export function replaceTodos(sessionId: string, todos: ClaudeTodoItem[]): ClaudePlanState | null {
  const db = getConnection();
  const updateFn = db.transaction(() => {
    const row = ensureRow(db, sessionId);
    const newRevision = row.revision + 1;
    db.prepare(
      `UPDATE claude_plan_state SET todos_json = ?, revision = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(todos), newRevision, sessionId);
    return db.prepare(
      'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
    ).get(sessionId) as PlanStateRow;
  });
  return rowToState(updateFn());
}

/** 插入或更新单条 Task（TaskCreate 用正式 ID 建立任务），递增 revision，返回完整状态。 */
export function upsertTask(sessionId: string, task: ClaudePlanTask): ClaudePlanState | null {
  const db = getConnection();
  const updateFn = db.transaction(() => {
    const row = ensureRow(db, sessionId);
    const newRevision = row.revision + 1;
    let tasks: ClaudePlanTask[] = [];
    try {
      const parsed = JSON.parse(row.tasks_json);
      if (Array.isArray(parsed)) tasks = parsed;
    } catch {
      // 坏 JSON 从空开始
    }
    const idx = tasks.findIndex((t) => t.id === task.id);
    if (idx >= 0) {
      tasks[idx] = task;
    } else {
      tasks.push(task);
    }
    db.prepare(
      `UPDATE claude_plan_state SET tasks_json = ?, revision = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(tasks), newRevision, sessionId);
    return db.prepare(
      'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
    ).get(sessionId) as PlanStateRow;
  });
  return rowToState(updateFn());
}

/** patch 单条 Task（TaskUpdate/task_updated），递增 revision，返回完整状态。 */
export function patchTask(
  sessionId: string,
  taskId: string,
  patch: Partial<ClaudePlanTask>,
): ClaudePlanState | null {
  const db = getConnection();
  const updateFn = db.transaction(() => {
    const row = ensureRow(db, sessionId);
    const newRevision = row.revision + 1;
    let tasks: ClaudePlanTask[] = [];
    try {
      const parsed = JSON.parse(row.tasks_json);
      if (Array.isArray(parsed)) tasks = parsed;
    } catch {
      // 坏 JSON 从空开始
    }
    const idx = tasks.findIndex((t) => t.id === taskId);
    if (idx >= 0) {
      tasks[idx] = { ...tasks[idx], ...patch };
    }
    // 未找到任务：patch 是 no-op（不创建假任务），但仍更新 revision 以推送当前快照
    db.prepare(
      `UPDATE claude_plan_state SET tasks_json = ?, revision = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(tasks), newRevision, sessionId);
    return db.prepare(
      'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
    ).get(sessionId) as PlanStateRow;
  });
  return rowToState(updateFn());
}

/** 替换完整任务集合（TaskList），递增 revision，返回完整状态。 */
export function replaceTasks(sessionId: string, tasks: ClaudePlanTask[]): ClaudePlanState | null {
  const db = getConnection();
  const updateFn = db.transaction(() => {
    const row = ensureRow(db, sessionId);
    const newRevision = row.revision + 1;
    db.prepare(
      `UPDATE claude_plan_state SET tasks_json = ?, revision = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(tasks), newRevision, sessionId);
    return db.prepare(
      'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
    ).get(sessionId) as PlanStateRow;
  });
  return rowToState(updateFn());
}

/** 删除单条 Task（TaskUpdate status=deleted），递增 revision，返回完整状态。 */
export function removeTask(sessionId: string, taskId: string): ClaudePlanState | null {
  const db = getConnection();
  const updateFn = db.transaction(() => {
    const row = ensureRow(db, sessionId);
    const newRevision = row.revision + 1;
    let tasks: ClaudePlanTask[] = [];
    try {
      const parsed = JSON.parse(row.tasks_json);
      if (Array.isArray(parsed)) tasks = parsed;
    } catch {
      // 坏 JSON 从空开始
    }
    const filtered = tasks.filter((t) => t.id !== taskId);
    db.prepare(
      `UPDATE claude_plan_state SET tasks_json = ?, revision = ?, updated_at = datetime('now') WHERE session_id = ?`,
    ).run(JSON.stringify(filtered), newRevision, sessionId);
    return db.prepare(
      'SELECT session_id, todos_json, tasks_json, revision, updated_at FROM claude_plan_state WHERE session_id = ?',
    ).get(sessionId) as PlanStateRow;
  });
  return rowToState(updateFn());
}
