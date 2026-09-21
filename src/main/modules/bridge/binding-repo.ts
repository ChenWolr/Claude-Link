// binding-repo.ts — bridge_bindings 表 repo（V13）。
// IM 平台用户（飞书 open_id / 微信 user id）↔ claude-link 会话行的绑定存取。
// 一律接收 db 参数（可测性；生产侧由 bridge/init.ts 传 getConnection()），
// 不 import connection.ts（避免单例拽进测试）。不 import electron。

import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';

export interface BridgeBinding {
  id: string;
  platform: 'feishu' | 'wechat';
  sessionKey: string;
  userId: string;
  chatId: string;
  displayName: string | null;
  sessionId: string;
  createdAt: number;
  lastActiveAt: number;
}

interface BridgeBindingRow {
  id: string;
  platform: string;
  session_key: string;
  user_id: string;
  chat_id: string;
  display_name: string | null;
  session_id: string;
  created_at: number;
  last_active_at: number;
}

function toBinding(row: BridgeBindingRow): BridgeBinding {
  return {
    id: row.id,
    platform: row.platform as BridgeBinding['platform'],
    sessionKey: row.session_key,
    userId: row.user_id,
    chatId: row.chat_id,
    displayName: row.display_name,
    sessionId: row.session_id,
    createdAt: row.created_at,
    lastActiveAt: row.last_active_at,
  };
}

export function upsertBinding(
  db: Database.Database,
  b: Omit<BridgeBinding, 'id' | 'createdAt' | 'lastActiveAt'> & { id?: string },
): BridgeBinding {
  const now = Date.now();
  // 同 sessionKey 幂等覆盖：保留原 id/created_at，更新可变字段（会话重建/改名场景）。
  const upsert = db.prepare(`
    INSERT INTO bridge_bindings (id, platform, session_key, user_id, chat_id, display_name, session_id, created_at, last_active_at)
    VALUES (@id, @platform, @sessionKey, @userId, @chatId, @displayName, @sessionId, @now, @now)
    ON CONFLICT(session_key) DO UPDATE SET
      platform = excluded.platform,
      user_id = excluded.user_id,
      chat_id = excluded.chat_id,
      display_name = excluded.display_name,
      session_id = excluded.session_id,
      last_active_at = excluded.last_active_at
  `);
  upsert.run({
    id: b.id ?? randomUUID(),
    platform: b.platform,
    sessionKey: b.sessionKey,
    userId: b.userId,
    chatId: b.chatId,
    displayName: b.displayName,
    sessionId: b.sessionId,
    now,
  });
  const row = db.prepare('SELECT * FROM bridge_bindings WHERE session_key = ?').get(b.sessionKey) as BridgeBindingRow;
  return toBinding(row);
}

export function getBindingBySessionKey(db: Database.Database, sessionKey: string): BridgeBinding | null {
  const row = db.prepare('SELECT * FROM bridge_bindings WHERE session_key = ?').get(sessionKey) as
    | BridgeBindingRow
    | undefined;
  return row ? toBinding(row) : null;
}

export function listBindings(db: Database.Database): BridgeBinding[] {
  const rows = db.prepare('SELECT * FROM bridge_bindings ORDER BY last_active_at DESC').all() as BridgeBindingRow[];
  return rows.map(toBinding);
}

/** /new 用：换绑新会话。未命中返回 null（调用方自行 upsert）。 */
export function rebindSession(db: Database.Database, sessionKey: string, newSessionId: string): BridgeBinding | null {
  const result = db
    .prepare('UPDATE bridge_bindings SET session_id = ?, last_active_at = ? WHERE session_key = ?')
    .run(newSessionId, Date.now(), sessionKey);
  if (result.changes === 0) return null;
  return getBindingBySessionKey(db, sessionKey);
}

/** 回合活动时刷新 lastActiveAt（绑定列表排序依据）。 */
export function touchBinding(db: Database.Database, sessionKey: string): void {
  db.prepare('UPDATE bridge_bindings SET last_active_at = ? WHERE session_key = ?').run(Date.now(), sessionKey);
}

export function deleteBinding(db: Database.Database, sessionKey: string): void {
  db.prepare('DELETE FROM bridge_bindings WHERE session_key = ?').run(sessionKey);
}
