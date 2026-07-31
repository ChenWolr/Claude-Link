import { v4 as uuidv4 } from 'uuid';
import type { Session } from '../../../shared/types/session';
import { isValidThinkingLevel } from '../../../shared/types/thinking';
import { getConnection } from '../connection';
import { normalizeSearchText } from '../../utils/search-normalizer';
import { normalizeDbTime } from '../../../shared/time';

interface SessionRow {
  id: string;
  name: string;
  cli_session_id: string | null;
  model: string;
  model_override: string | null;
  working_dir: string | null;
  permission_mode: Session['permissionMode'];
  max_turns: number;
  thinking_level: string | null;
  created_at: string;
  updated_at: string;
  last_context_tokens: number | null;
  last_context_updated_at: string | null;
  last_context_window: number | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    cliSessionId: row.cli_session_id,
    model: row.model,
    modelOverride: row.model_override,
    workingDir: row.working_dir,
    permissionMode: row.permission_mode,
    maxTurns: row.max_turns,
    // 脏值兜底：DB 值非法（手改/历史脏数据）时回落 null（= 跟随全局默认）。
    thinkingLevel: isValidThinkingLevel(row.thinking_level) ? row.thinking_level : null,
    createdAt: normalizeDbTime(row.created_at),
    updatedAt: normalizeDbTime(row.updated_at),
    lastContextTokens: row.last_context_tokens,
    lastContextUpdatedAt: normalizeDbTime(row.last_context_updated_at),
    lastContextWindow: row.last_context_window,
  };
}

export function createSession(name: string, model: string, workingDir: string | null = null): Session {
  const db = getConnection();
  const id = uuidv4();

  db.prepare(
    `INSERT INTO sessions (id, name, model, working_dir)
     VALUES (@id, @name, @model, @workingDir)`,
  ).run({ id, name, model, workingDir });

  const session = getSession(id);
  if (!session) {
    throw new Error(`Failed to create session ${id}`);
  }

  return session;
}

export function getSession(id: string): Session | null {
  const row = getConnection()
    .prepare('SELECT * FROM sessions WHERE id = ?')
    .get(id) as SessionRow | undefined;
  return row ? toSession(row) : null;
}

export function listSessions(): Session[] {
  const rows = getConnection()
    .prepare('SELECT * FROM sessions ORDER BY updated_at DESC')
    .all() as SessionRow[];
  return rows.map(toSession);
}

export function updateSession(
  id: string,
  partial: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel'>>,
): Session | null {
  const updates: string[] = [];
  const values: Record<string, unknown> = { id };

  if (partial.name !== undefined) {
    updates.push('name = @name');
    values.name = partial.name;
  }
  if (partial.model !== undefined) {
    updates.push('model = @model');
    values.model = partial.model;
  }
  if (partial.workingDir !== undefined) {
    updates.push('working_dir = @workingDir');
    values.workingDir = partial.workingDir;
  }
  if (partial.permissionMode !== undefined) {
    updates.push('permission_mode = @permissionMode');
    values.permissionMode = partial.permissionMode;
  }
  if (partial.maxTurns !== undefined) {
    updates.push('max_turns = @maxTurns');
    values.maxTurns = partial.maxTurns;
  }
  if (partial.thinkingLevel !== undefined) {
    updates.push('thinking_level = @thinkingLevel');
    values.thinkingLevel = partial.thinkingLevel;
  }

  if (!updates.length) {
    return getSession(id);
  }

  updates.push("updated_at = datetime('now')");
  getConnection()
    .prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = @id`)
    .run(values);

  return getSession(id);
}

export function searchSessions(query: string): Session[] {
  const normalizedQuery = normalizeSearchText(query);
  const sessions = listSessions();
  if (!normalizedQuery) {
    return sessions;
  }

  // 用与前端完全相同的 normalizeSearchText 函数做对称归一化，
  // 避免 SQL REPLACE 与 TS 正则的归一化分歧导致漏匹配。
  // 一次性取出每个会话的拼接消息内容用于内容匹配。
  const contentMap = new Map<string, string>();
  const contentRows = getConnection()
    .prepare("SELECT session_id, GROUP_CONCAT(content, ' ') AS text FROM messages GROUP BY session_id")
    .all() as { session_id: string; text: string | null }[];
  for (const row of contentRows) {
    contentMap.set(row.session_id, row.text ?? '');
  }

  // 仅历史消息附件文件名参与搜索；草稿、失败和仅任务引用的附件不应命中。
  // 不纳入 storage_key / MIME / 哈希 / 文件内容。
  const attachmentNameMap = new Map<string, string>();
  const attachmentNameRows = getConnection()
    .prepare(
      `SELECT a.session_id, GROUP_CONCAT(a.filename, ' ') AS text
       FROM message_attachments ma
       JOIN attachments a ON a.id = ma.attachment_id
       GROUP BY a.session_id`,
    )
    .all() as { session_id: string; text: string | null }[];
  for (const row of attachmentNameRows) {
    attachmentNameMap.set(row.session_id, row.text ?? '');
  }

  return sessions.filter((session) => {
    if (normalizeSearchText(session.name).includes(normalizedQuery)) return true;
    const content = contentMap.get(session.id);
    if (content && normalizeSearchText(content).includes(normalizedQuery)) return true;
    const attachmentNames = attachmentNameMap.get(session.id);
    if (attachmentNames && normalizeSearchText(attachmentNames).includes(normalizedQuery)) return true;
    return false;
  });
}

export function deleteSession(id: string): void {
  getConnection().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function updateCliSessionId(id: string, cliSessionId: string | null): Session | null {
  getConnection()
    .prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(cliSessionId, id);
  return getSession(id);
}

export function updateModelOverride(id: string, modelOverride: string | null): Session | null {
  getConnection()
    .prepare("UPDATE sessions SET model_override = ?, updated_at = datetime('now') WHERE id = ?")
    .run(modelOverride, id);
  return getSession(id);
}

export function updateLastContext(id: string, tokens: number, windowSize?: number): Session | null {
  getConnection()
    .prepare(
      "UPDATE sessions SET last_context_tokens = ?, last_context_window = ?, last_context_updated_at = datetime('now') WHERE id = ?",
    )
    .run(tokens, windowSize ?? null, id);
  return getSession(id);
}
