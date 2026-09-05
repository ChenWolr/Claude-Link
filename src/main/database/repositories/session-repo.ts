import { v4 as uuidv4 } from 'uuid';
import type { Session } from '../../../shared/types/session';
import { isValidThinkingLevel } from '../../../shared/types/thinking';
import { isValidPermissionMode } from '../../../shared/permission-resolver';
import { getConnection } from '../connection';
import { normalizeSearchText } from '../../utils/search-normalizer';
import { normalizeDbTime } from '../../../shared/time';

interface SessionRow {
  id: string;
  name: string;
  cli_session_id: string | null;
  model: string;
  provider_override: string | null;
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
  last_context_used: number | null;
  last_context_used_capacity: number | null;
  last_context_used_at: number | null;
  last_effective_effort: string | null;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    name: row.name,
    cliSessionId: row.cli_session_id,
    model: row.model,
    providerOverride: row.provider_override ?? null,
    modelOverride: row.model_override ?? null,
    workingDir: row.working_dir,
    // 脏值兜底：DB 值非法（手改/历史脏数据）时回落 null（= 跟随全局默认）。
    permissionMode: isValidPermissionMode(row.permission_mode) ? row.permission_mode : null,
    maxTurns: row.max_turns,
    // 脏值兜底：DB 值非法（手改/历史脏数据）时回落 null（= 跟随全局默认）。
    thinkingLevel: isValidThinkingLevel(row.thinking_level) ? row.thinking_level : null,
    createdAt: normalizeDbTime(row.created_at),
    updatedAt: normalizeDbTime(row.updated_at),
    lastContextTokens: row.last_context_tokens,
    lastContextUpdatedAt: normalizeDbTime(row.last_context_updated_at),
    lastContextWindow: row.last_context_window,
    lastContextUsed: row.last_context_used,
    lastContextUsedCapacity: row.last_context_used_capacity,
    lastContextUsedAt: row.last_context_used_at,
    lastEffectiveEffort: row.last_effective_effort ?? null,
  };
}

export function createSession(
  name: string,
  model: string,
  workingDir: string | null = null,
  id?: string,
): Session {
  const db = getConnection();
  // id 可由调用方指定：暂态会话物化沿用 renderer 生成的 uuid，让草稿 key（chat-draft-store
  // 按 sessionId 索引）与附件 id 无需迁移。缺省时行为与旧版完全一致（自生成 uuid）。
  const sessionId = id ?? uuidv4();

  // permission_mode 显式写 NULL（= 跟随全局默认 AppConfig.permissionMode），
  // 不落 'default'——否则会钉死新会话为默认档，全局默认权限永远不生效。
  db.prepare(
    `INSERT INTO sessions (id, name, model, working_dir, permission_mode)
     VALUES (@id, @name, @model, @workingDir, NULL)`,
  ).run({ id: sessionId, name, model, workingDir });

  const session = getSession(sessionId);
  if (!session) {
    throw new Error(`Failed to create session ${sessionId}`);
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
  partial: Partial<
    Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel' | 'providerOverride' | 'modelOverride' | 'lastEffectiveEffort'>
  >,
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
  if (partial.providerOverride !== undefined) {
    updates.push('provider_override = @providerOverride');
    values.providerOverride = partial.providerOverride;
  }
  if (partial.modelOverride !== undefined) {
    updates.push('model_override = @modelOverride');
    values.modelOverride = partial.modelOverride;
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
  if (partial.lastEffectiveEffort !== undefined) {
    updates.push('last_effective_effort = @lastEffectiveEffort');
    values.lastEffectiveEffort = partial.lastEffectiveEffort;
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

  // 仅按会话标题匹配：不命中消息内容与附件文件名（会话内内容不参与搜索）。
  // 用与前端完全相同的 normalizeSearchText 函数做对称归一化，
  // 避免 SQL REPLACE 与 TS 正则的归一化分歧导致漏匹配。
  return sessions.filter((session) => normalizeSearchText(session.name).includes(normalizedQuery));
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

// 仅持久化窗口容量（不写 last_context_tokens）。用于 turn usage 事件：turn usage 不是当前窗口，
// 不得写入 last_context_tokens 冒充当前上下文；容量才是有持久化价值的 provenance。
export function updateLastContextWindow(id: string, windowSize?: number): Session | null {
  getConnection()
    .prepare(
      "UPDATE sessions SET last_context_window = ?, last_context_updated_at = datetime('now') WHERE id = ?",
    )
    .run(windowSize ?? null, id);
  return getSession(id);
}

// post-turn 官方 /context 探针成功后持久化回合末精确占用（used/capacity/采样时间戳）。
// 与 last_context_tokens（历史累计 turn usage）分离：这里写的是「当前窗口已用」的 last-known，
// 重启/切回会话时预填 stale 恢复显示。used 与模型无绑定关系，故不设模型列。
export function updateLastContextUsed(id: string, used: number, capacity: number, at: number): Session | null {
  getConnection()
    .prepare(
      'UPDATE sessions SET last_context_used = ?, last_context_used_capacity = ?, last_context_used_at = ? WHERE id = ?',
    )
    .run(used, capacity, at, id);
  return getSession(id);
}
