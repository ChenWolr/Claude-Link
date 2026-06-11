import { v4 as uuidv4 } from 'uuid';
import type { Message } from '../../../shared/types/session';
import { getConnection } from '../connection';

interface MessageRow {
  id: string;
  session_id: string;
  role: Message['role'];
  content: string;
  raw_event: string | null;
  event_type: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  parent_task_id: string | null;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    rawEvent: row.raw_event,
    eventType: row.event_type,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    parentTaskId: row.parent_task_id,
    createdAt: row.created_at,
  };
}

export function createMessage(
  sessionId: string,
  role: Message['role'],
  content: string,
  eventType: string | null = null,
  rawEvent: string | null = null,
  parentTaskId: string | null = null,
): Message {
  const id = uuidv4();

  getConnection()
    .prepare(
      `INSERT INTO messages (id, session_id, role, content, event_type, raw_event, parent_task_id)
       VALUES (@id, @sessionId, @role, @content, @eventType, @rawEvent, @parentTaskId)`,
    )
    .run({ id, sessionId, role, content, eventType, rawEvent, parentTaskId });

  const message = getConnection()
    .prepare('SELECT * FROM messages WHERE id = ?')
    .get(id) as MessageRow | undefined;

  if (!message) {
    throw new Error(`Failed to create message ${id}`);
  }

  return toMessage(message);
}

export function getMessagesBySession(sessionId: string): Message[] {
  const rows = getConnection()
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC')
    .all(sessionId) as MessageRow[];
  return rows.map(toMessage);
}

export function getMessagesByTask(taskId: string): Message[] {
  const rows = getConnection()
    .prepare('SELECT * FROM messages WHERE parent_task_id = ? ORDER BY created_at ASC')
    .all(taskId) as MessageRow[];
  return rows.map(toMessage);
}
