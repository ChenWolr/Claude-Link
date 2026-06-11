import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 1;

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER NOT NULL
    );
  `);

  const versionRow = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  const currentVersion = versionRow?.version ?? 0;

  if (currentVersion < 1) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        cli_session_id TEXT,
        model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6',
        working_dir TEXT,
        permission_mode TEXT DEFAULT 'default',
        max_turns INTEGER DEFAULT 200,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
        content TEXT NOT NULL,
        raw_event TEXT,
        event_type TEXT,
        cost_usd REAL,
        duration_ms INTEGER,
        parent_task_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, created_at);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','queued','running','completed','failed','cancelled')),
        sort_order INTEGER NOT NULL DEFAULT 0,
        result TEXT,
        cost_usd REAL,
        duration_ms INTEGER,
        error_message TEXT,
        started_at TEXT,
        completed_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_session_order ON tasks(session_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);
  }

  const upsertVersion = versionRow
    ? db.prepare('UPDATE schema_version SET version = ?')
    : db.prepare('INSERT INTO schema_version (version) VALUES (?)');
  upsertVersion.run(CURRENT_SCHEMA_VERSION);
}
