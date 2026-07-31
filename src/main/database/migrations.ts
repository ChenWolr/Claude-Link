import type Database from 'better-sqlite3';

const CURRENT_SCHEMA_VERSION = 7;

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
    // 上下文窗口持久化：缓存 SDK result.modelUsage.contextWindow 的真实值，
    // 切换会话重建 contextStats 时直接复用，避免一律回到 200k 兜底（内置模型表/fallback 顶不住真实值）。
    if (!hasCol('last_context_window')) {
      db.exec('ALTER TABLE sessions ADD COLUMN last_context_window INTEGER DEFAULT NULL');
    }
    // 思考强度档位（V7）：null = 回落全局默认（AppConfig.defaultThinkingLevel）。
    // 脏值清洗在 session-repo.toSession / ipc-handlers 入参校验双层兜底。
    if (!hasCol('thinking_level')) {
      db.exec('ALTER TABLE sessions ADD COLUMN thinking_level TEXT DEFAULT NULL');
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

  // V5：任务稳定消息身份 client_message_id。入队时写入，执行/失败重试/应用重启都复用同一 ID
  // 创建 user message，禁止执行时重新生成（避免重复消息）。幂等自愈补列；部分唯一索引（NULL 不参与）。
  {
    const taskCols = db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    const hasTaskCol = (n: string): boolean => taskCols.some((c) => c.name === n);
    if (!hasTaskCol('client_message_id')) {
      db.exec('ALTER TABLE tasks ADD COLUMN client_message_id TEXT');
    }
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_client_message_id
      ON tasks(client_message_id) WHERE client_message_id IS NOT NULL;
  `);

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

  // V4：会话附件（图片直传模型；文档与普通文件交给 Claude Code Read）。
  // 无条件 CREATE TABLE IF NOT EXISTS（不放进 currentVersion<1 初始块），保证 v3 老库升级也能拿到新表。
  // ON DELETE CASCADE：附件跟随 session/message/task 删除清理关联记录；物理文件由 attachment-service
  // 按引用计数清理（DB 级联只删行，不删文件）。storage_key UNIQUE 便于去重与孤儿清理定位。
  db.exec(`
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('image','document','file')),
      size_bytes INTEGER NOT NULL CHECK(size_bytes >= 0),
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      width INTEGER,
      height INTEGER,
      status TEXT NOT NULL CHECK(status IN ('draft','message','task','failed')),
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_session ON attachments(session_id, created_at);

    CREATE TABLE IF NOT EXISTS message_attachments (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(message_id, attachment_id),
      UNIQUE(message_id, ordinal)
    );
    CREATE TABLE IF NOT EXISTS task_attachments (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      attachment_id TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      PRIMARY KEY(task_id, attachment_id),
      UNIQUE(task_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS idx_message_attachments_attachment ON message_attachments(attachment_id);
    CREATE INDEX IF NOT EXISTS idx_task_attachments_attachment ON task_attachments(attachment_id);
  `);

  // V6：Claude 计划状态快照表。TodoWrite（完整替换）与 TaskCreate/Update/List/Get（ID-keyed patch）
  // 的按会话隔离快照。独立于手动排队 tasks 表，不复用其 schema。ON DELETE CASCADE 跟随会话删除。
  // 无条件 CREATE TABLE IF NOT EXISTS（不放进 currentVersion<1 初始块），保证老库升级也能拿到新表。
  db.exec(`
    CREATE TABLE IF NOT EXISTS claude_plan_state (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      todos_json TEXT NOT NULL DEFAULT '[]',
      tasks_json TEXT NOT NULL DEFAULT '[]',
      revision INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  const upsertVersion = versionRow
    ? db.prepare('UPDATE schema_version SET version = ?')
    : db.prepare('INSERT INTO schema_version (version) VALUES (?)');
  upsertVersion.run(CURRENT_SCHEMA_VERSION);
}
