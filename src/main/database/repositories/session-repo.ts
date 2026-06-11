import { v4 as uuidv4 } from 'uuid';
import type { Session } from '../../../shared/types/session';
import { getConnection } from '../connection';

interface SessionRow {
  id: string;
  name: string;
  cli_session_id: string | null;
  model: string;
  working_dir: string | null;
  permission_mode: Session['permissionMode'];
  max_turns: number;
  created_at: string;
  updated_at: string;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    cliSessionId: row.cli_session_id,
    model: row.model,
    workingDir: row.working_dir,
    permissionMode: row.permission_mode,
    maxTurns: row.max_turns,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
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
  partial: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns'>>,
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

  if (!updates.length) {
    return getSession(id);
  }

  updates.push("updated_at = datetime('now')");
  getConnection()
    .prepare(`UPDATE sessions SET ${updates.join(', ')} WHERE id = @id`)
    .run(values);

  return getSession(id);
}

export function deleteSession(id: string): void {
  getConnection().prepare('DELETE FROM sessions WHERE id = ?').run(id);
}

export function updateCliSessionId(id: string, cliSessionId: string): Session | null {
  getConnection()
    .prepare("UPDATE sessions SET cli_session_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(cliSessionId, id);
  return getSession(id);
}
