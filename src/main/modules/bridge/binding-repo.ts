// binding-repo.ts — bridge_bindings 表 repo（V14）。
// IM 平台用户（飞书 open_id / 微信 user id）↔ claude-link 会话行的绑定存取。
// 解绑语义（V14 墓碑）：deleteBinding 置 unbound_at（行保留、get/list/touch 过滤），
// 消息被忽略直到该用户发 /new（upsert ON CONFLICT 清墓碑复活）或重新产生绑定。
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
  // unbound_at = NULL：显式重建（/new 换绑、flush 悬空重建）天然清解绑墓碑复活。
  const upsert = db.prepare(`
    INSERT INTO bridge_bindings (id, platform, session_key, user_id, chat_id, display_name, session_id, created_at, last_active_at)
    VALUES (@id, @platform, @sessionKey, @userId, @chatId, @displayName, @sessionId, @now, @now)
    ON CONFLICT(session_key) DO UPDATE SET
      platform = excluded.platform,
      user_id = excluded.user_id,
      chat_id = excluded.chat_id,
      display_name = excluded.display_name,
      session_id = excluded.session_id,
      last_active_at = excluded.last_active_at,
      unbound_at = NULL
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
  // 墓碑行不可见：解绑后查询等同未绑定（flush 走 isUnbound 分支忽略，不悬空重建）。
  const row = db.prepare('SELECT * FROM bridge_bindings WHERE session_key = ? AND unbound_at IS NULL').get(sessionKey) as
    | BridgeBindingRow
    | undefined;
  return row ? toBinding(row) : null;
}

export function listBindings(db: Database.Database): BridgeBinding[] {
  const rows = db.prepare('SELECT * FROM bridge_bindings WHERE unbound_at IS NULL ORDER BY last_active_at DESC').all() as BridgeBindingRow[];
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

/** 回合活动时刷新 lastActiveAt（绑定列表排序依据）。墓碑行不触碰。 */
export function touchBinding(db: Database.Database, sessionKey: string): void {
  db.prepare('UPDATE bridge_bindings SET last_active_at = ? WHERE session_key = ? AND unbound_at IS NULL').run(Date.now(), sessionKey);
}

/**
 * 解绑（V14 墓碑）：置 unbound_at 而非物理删行——manager.flush 凭 isUnbound 区分
 * 「悬空→自动重建」与「已解绑→忽略」，消灭解绑后自动接回复活路径。幂等：已置位不刷新时间。
 */
export function deleteBinding(db: Database.Database, sessionKey: string): void {
  db.prepare('UPDATE bridge_bindings SET unbound_at = ? WHERE session_key = ? AND unbound_at IS NULL').run(Date.now(), sessionKey);
}

/** 该 sessionKey 是否处于解绑墓碑态（get/list 已过滤墓碑行，须以本函数单独判定）。 */
export function isUnbound(db: Database.Database, sessionKey: string): boolean {
  return db.prepare('SELECT 1 FROM bridge_bindings WHERE session_key = ? AND unbound_at IS NOT NULL').get(sessionKey) !== undefined;
}

/**
 * 指定平台 last_active_at 最新活跃绑定的 user_id（批次5.2 wechat owner 存量迁移用）。
 * 墓碑行不参与；无活跃绑定返回 null（等待首捕获）。
 */
export function getLatestBindingUserIdByPlatform(db: Database.Database, platform: BridgeBinding['platform']): string | null {
  const row = db.prepare(
    'SELECT user_id FROM bridge_bindings WHERE platform = ? AND unbound_at IS NULL ORDER BY last_active_at DESC LIMIT 1',
  ).get(platform) as { user_id: string } | undefined;
  return row?.user_id ?? null;
}

/**
 * 清除指定平台的全部解绑墓碑行（物理删除，2026-09-23 微信扫码重连修复）：
 * 重新扫码登录 = 该平台桥接的全新开始，旧墓碑不应继续吞掉 owner 的普通消息
 * （症状：新连接后普通消息静默无回复，必须发 /new 才能复活）。返回删除行数。
 * 只删墓碑行（unbound_at IS NOT NULL），活跃绑定不动；幂等（无墓碑删 0 行）。
 */
export function purgeTombstonesByPlatform(db: Database.Database, platform: BridgeBinding['platform']): number {
  const result = db.prepare('DELETE FROM bridge_bindings WHERE platform = ? AND unbound_at IS NOT NULL').run(platform);
  return result.changes;
}

/**
 * 物理删除指定平台的全部绑定行（活跃 + 墓碑，2026-09-23 退出登录完全重置）：
 * 退出登录 = 微信桥完全重置，旧绑定（含指向旧会话的活跃绑定与解绑墓碑）全部清除，
 * 重新扫码后从零开始（首条消息自动重建绑定+新会话）。返回被删的 session_key 列表
 * （调用方逐 key 清 manager 在途状态）。异平台行不动；无行返回 []（幂等）。
 */
export function purgeAllBindingsByPlatform(db: Database.Database, platform: BridgeBinding['platform']): string[] {
  const rows = db.prepare('SELECT session_key FROM bridge_bindings WHERE platform = ?').all(platform) as Array<{ session_key: string }>;
  if (rows.length === 0) return [];
  db.prepare('DELETE FROM bridge_bindings WHERE platform = ?').run(platform);
  return rows.map((r) => r.session_key);
}
