import { v4 as uuidv4 } from 'uuid';
import type { Task, TaskStatus } from '../../../shared/types/task';
import { getConnection } from '../connection';
import { normalizeDbTime } from '../../../shared/time';
import * as attachmentRepo from './attachment-repo';

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
  client_message_id: string | null;
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
    startedAt: normalizeDbTime(row.started_at),
    completedAt: normalizeDbTime(row.completed_at),
    createdAt: normalizeDbTime(row.created_at),
    updatedAt: normalizeDbTime(row.updated_at),
    attachments: [],
    clientMessageId: row.client_message_id ?? null,
  };
}

/** 批量填充任务附件（无附件的任务赋空数组）。 */
function fillTaskAttachments(tasks: Task[]): void {
  if (tasks.length === 0) return;
  const map = attachmentRepo.getAttachmentsByTaskIds(tasks.map((t) => t.id));
  for (const t of tasks) t.attachments = map.get(t.id) ?? [];
}

export function createTask(sessionId: string, prompt: string, sortOrder: number): Task {
  return createTaskWithAttachments(sessionId, prompt, sortOrder, [], null);
}

export function createTaskWithAttachments(
  sessionId: string,
  prompt: string,
  sortOrder: number,
  attachmentIds: string[],
  clientMessageId: string | null,
): Task {
  const db = getConnection();
  const id = uuidv4();

  const insert = db.prepare(
    `INSERT INTO tasks (id, session_id, prompt, sort_order, client_message_id)
     VALUES (@id, @sessionId, @prompt, @sortOrder, @clientMessageId)`,
  );

  const transaction = db.transaction(() => {
    insert.run({ id, sessionId, prompt, sortOrder, clientMessageId });
    if (attachmentIds.length > 0) {
      attachmentRepo.linkAttachmentsToTask(id, attachmentIds);
      attachmentRepo.markAttachmentsStatus(attachmentIds, 'task');
    }
  });
  transaction();

  const task = getTask(id);
  if (!task) {
    throw new Error(`Failed to create task ${id}`);
  }

  return task;
}

export function getTask(id: string): Task | null {
  const row = getConnection().prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  if (!row) return null;
  const task = toTask(row);
  task.attachments = attachmentRepo.getAttachmentsByTaskIds([id]).get(id) ?? [];
  return task;
}

export function getTasksBySession(sessionId: string): Task[] {
  const rows = getConnection()
    .prepare('SELECT * FROM tasks WHERE session_id = ? ORDER BY sort_order ASC')
    .all(sessionId) as TaskRow[];
  const tasks = rows.map(toTask);
  fillTaskAttachments(tasks);
  return tasks;
}

export function getPendingTasks(sessionId: string): Task[] {
  const rows = getConnection()
    .prepare("SELECT * FROM tasks WHERE session_id = ? AND status = 'pending' ORDER BY sort_order ASC")
    .all(sessionId) as TaskRow[];
  const tasks = rows.map(toTask);
  fillTaskAttachments(tasks);
  return tasks;
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

/**
 * 删除任务：先解除 task_attachments 关联（拿回附件 ID 供 handler 按引用计数删文件），
 * 再 DELETE tasks（DB 级联也会清 task_attachments，显式先取避免丢失列表）。
 */
export function deleteTask(id: string): string[] {
  const attachmentIds = attachmentRepo.deleteTaskAttachmentLinks(id);
  getConnection().prepare('DELETE FROM tasks WHERE id = ?').run(id);
  return attachmentIds;
}

/** 老任务（clientMessageId 为 null）首次执行时生成并持久化一次稳定 ID，后续重试/重启复用。
 *  WHERE client_message_id IS NULL 保证幂等：已设置的不覆盖。 */
export function setTaskClientMessageId(id: string, clientMessageId: string): void {
  getConnection()
    .prepare(
      `UPDATE tasks SET client_message_id = @clientMessageId, updated_at = datetime('now')
       WHERE id = @id AND client_message_id IS NULL`,
    )
    .run({ id, clientMessageId });
}

/** Task 7B：重试失败/取消的任务 → pending，清空执行结果字段，保留附件 links 与稳定 clientMessageId。
 *  WHERE status IN ('failed','cancelled') 保证只对终态失败任务生效，running/pending 不受影响。 */
export function retryTask(id: string): Task | null {
  getConnection()
    .prepare(
      `UPDATE tasks
       SET status = 'pending',
           result = NULL, cost_usd = NULL, duration_ms = NULL,
           error_message = NULL, started_at = NULL, completed_at = NULL,
           updated_at = datetime('now')
       WHERE id = @id AND status IN ('failed', 'cancelled')`,
    )
    .run({ id });
  return getTask(id);
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
