import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskStatus } from '../../../shared/types/task';
import { getConnection } from '../connection';

interface TaskRow {
  id: string;
  session_id: string;
  prompt: string;
  status: TaskStatus;
  sort_order: number;
  result: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  error_message: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    sessionId: row.session_id,
    prompt: row.prompt,
    status: row.status,
    sortOrder: row.sort_order,
    result: row.result,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    errorMessage: row.error_message,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createTask(sessionId: string, prompt: string, sortOrder: number): Task {
  const id = uuidv4();

  getConnection()
    .prepare(
      `INSERT INTO tasks (id, session_id, prompt, sort_order)
       VALUES (@id, @sessionId, @prompt, @sortOrder)`,
    )
    .run({ id, sessionId, prompt, sortOrder });

  const task = getTask(id);
  if (!task) {
    throw new Error(`Failed to create task ${id}`);
  }

  return task;
}

export function getTask(id: string): Task | null {
  const row = getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  return row ? toTask(row) : null;
}

export function getTasksBySession(sessionId: string): Task[] {
  const rows = getConnection()
    .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY sort_order ASC')
    .all(sessionId) as TaskRow[];
  return rows.map(toTask);
}

export function getPendingTasks(sessionId: string): Task[] {
  const rows = getConnection()
    .prepare("SELECT * FROM tasks WHERE session_id = ? AND status = 'pending' ORDER BY sort_order ASC")
    .all(sessionId) as TaskRow[];
  return rows.map(toTask);
}

export function updateTaskStatus(id: string, status: TaskStatus): Task | null {
  const startedAt = status === 'running' ? "started_at = COALESCE(started_at, datetime('now'))," : '';
  const completedAt = ['completed', 'failed', 'cancelled'].includes(status)
    ? "completed_at = COALESCE(completed_at, datetime('now')),"
    : '';

  getConnection()
    .prepare(
      `UPDATE tasks
       SET status = @status,
           ${startedAt}
           ${completedAt}
           updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, status });

  return getTask(id);
}

export function updateTaskResult(
  id: string,
  result: string,
  costUsd: number | null,
  durationMs: number | null,
): Task | null {
  getConnection()
    .prepare(
      `UPDATE tasks
       SET result = @result,
           cost_usd = @costUsd,
           duration_ms = @durationMs,
           status = 'completed',
           completed_at = COALESCE(completed_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, result, costUsd, durationMs });

  return getTask(id);
}

export function updateTaskError(id: string, errorMessage: string): Task | null {
  getConnection()
    .prepare(
      `UPDATE tasks
       SET error_message = @errorMessage,
           status = 'failed',
           completed_at = COALESCE(completed_at, datetime('now')),
           updated_at = datetime('now')
       WHERE id = @id`,
    )
    .run({ id, errorMessage });

  return getTask(id);
}

export function reorderTasks(sessionId: string, taskIds: string[]): void {
  const db = getConnection();
  const update = db.prepare(
    `UPDATE tasks
     SET sort_order = @sortOrder,
         updated_at = datetime('now')
     WHERE id = @id AND session_id = @sessionId`,
  );

  const transaction = db.transaction((ids: string[]) => {
    ids.forEach((id, sortOrder) => update.run({ id, sessionId, sortOrder }));
  });

  transaction(taskIds);
}

export function deleteTask(id: string): void {
  getConnection().prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function resetRunningTasks(sessionId?: string): void {
  if (sessionId) {
    getConnection()
      .prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'running' AND session_id = ?")
      .run(sessionId);
    return;
  }

  getConnection()
    .prepare("UPDATE tasks SET status = 'pending', updated_at = datetime('now') WHERE status = 'running'")
    .run();
}
