// interaction-history-repo.ts
// 交互历史持久化：① 远程交互弹窗（有 sessionId）用户提交/取消时经渲染层 IPC 落库
//（本地 confirm 无 sessionId 不落库）；② 主进程兜底直写 cancel 行：回合取消统一落
//（sdk-backend killProcess，hb12-PERM-05，用户/系统取消均落、文案区分归因）与渲染
// 进程崩溃兜底（interaction-prompts recordCancelHistory，hb13-v B9）。
// 切换会话或重启 app 后仍可在 InteractionPrompt 底部"交互历史"区回看。
//
// V3-3：把 InteractionPrompt.vue 原本仅内存的 history ref 升级为 DB 持久化。
// 表本身不做条数清理（历史行全量留存，仅随会话删除级联清理）；「最近 N 条（默认 8）」
// 只是 getInteractionHistory 查询的 LIMIT，供前端展示。

import { v4 as uuidv4 } from 'uuid';
import { getConnection } from '../connection';
import { normalizeDbTime } from '../../../shared/time';

export interface InteractionHistoryEntry {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  summary: string | null;
  action: 'submit' | 'cancel';
  createdAt: string;
}

interface InteractionHistoryRow {
  id: string;
  session_id: string;
  title: string;
  kind: string;
  summary: string | null;
  action: string;
  created_at: string;
}

function toEntry(row: InteractionHistoryRow): InteractionHistoryEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    kind: row.kind,
    summary: row.summary,
    action: row.action === 'cancel' ? 'cancel' : 'submit',
    createdAt: normalizeDbTime(row.created_at),
  };
}

export interface CreateInteractionHistoryInput {
  sessionId: string;
  title: string;
  kind: string;
  summary?: string | null;
  action: 'submit' | 'cancel';
}

export function createInteractionHistory(input: CreateInteractionHistoryInput): void {
  const db = getConnection();
  db.prepare(
    `INSERT INTO interaction_history (id, session_id, title, kind, summary, action, created_at)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    uuidv4(),
    input.sessionId,
    input.title,
    input.kind,
    input.summary ?? null,
    input.action,
  );
}

export function getInteractionHistory(sessionId: string, limit = 8): InteractionHistoryEntry[] {
  const db = getConnection();
  const rows = db
    .prepare(
      `SELECT id, session_id, title, kind, summary, action, created_at
       FROM interaction_history
       WHERE session_id = ?
       ORDER BY created_at DESC, rowid DESC
       LIMIT ?`,
    )
    .all(sessionId, limit) as InteractionHistoryRow[];
  return rows.map(toEntry);
}
