import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 3;

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
        process_kind TEXT,
        parent_agent_id TEXT,
        tool_use_id TEXT,
        title TEXT,
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

  if (currentVersion < 2) {
    db.exec(`
      ALTER TABLE sessions ADD COLUMN model_override TEXT DEFAULT NULL;
    `);
  }

  // 幂等自愈：某些 DB 的 schema_version 与实际列状态不一致（历史迁移把版本号推进了、
  // 或列已被部分加上）。按列是否存在补加，确保任何状态的 DB 都能修好，不阻塞启动。
  {
    const sessCols = db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    const hasCol = (n: string): boolean => sessCols.some((c) => c.name === n);
    if (!hasCol('last_context_tokens')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_context_tokens INTEGER DEFAULT NULL');
    }
    if (!hasCol('last_context_updated_at')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_context_updated_at TEXT DEFAULT NULL');
    }
  }

  // 幂等自愈（messages 过程化四列）：老 DB（plan 落地前建库）的 messages 表没有
  // process_kind / parent_agent_id / tool_use_id / title。按列是否存在补加，老库升级后
  // 即可支持过程分组 / 子 Agent Tab，不阻塞启动、不动现有数据。
  {
    const msgCols = db.prepare('PRAGMA table_info(messages)').all() as { name: string }[];
    const hasMsgCol = (n: string): boolean => msgCols.some((c) => c.name === n);
    if (!hasMsgCol('process_kind')) {
      db.exec('ALTER TABLE messages ADD COLUMN process_kind TEXT');
    }
    if (!hasMsgCol('parent_agent_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN parent_agent_id TEXT');
    }
    if (!hasMsgCol('tool_use_id')) {
      db.exec('ALTER TABLE messages ADD COLUMN tool_use_id TEXT');
    }
    if (!hasMsgCol('title')) {
      db.exec('ALTER TABLE messages ADD COLUMN title TEXT');
    }
    // V4：tool_result 失败标记（is_error）。INTEGER 0/1，幂等自愈补加，老库升级不阻塞。
    if (!hasMsgCol('is_error')) {
      db.exec('ALTER TABLE messages ADD COLUMN is_error INTEGER NOT NULL DEFAULT 0');
    }
  }

  // V3-3：交互历史持久化表。每次用户提交/取消交互弹窗落库一条，
  // 切换会话或重启后仍可在 InteractionPrompt 底部"交互历史"区回看。
  // ON DELETE CASCADE 跟随会话删除清理。CREATE TABLE IF NOT EXISTS 本身幂等。
  db.exec(`
    CREATE TABLE IF NOT EXISTS interaction_history (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT,
      action TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_interaction_history_session ON interaction_history(session_id, created_at DESC);
  `);

  const upsertVersion = versionRow
    ? db.prepare('UPDATE schema_version SET version = ?')
    : db.prepare('INSERT INTO schema_version (version) VALUES (?)');
  upsertVersion.run(CURRENT_SCHEMA_VERSION);
}
