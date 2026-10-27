// turn-file-checkpoint-repo.ts
// 回合文件改动 checkpoint 落库（计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan
// §3.3 / §4-P1）：写文件类工具每次成功落盘，由 checkpoint 记录器（turn-diff-checkpoint，P3）写一行
// turn_file_checkpoints 快照；本 repo 只做窄存储/读取，截断与 binary 判定在记录器侧完成。
// 聚合消费（P4 turn-diff）经 listBySession 的 JOIN 拿 m.rowid（messages.id → rowid 映射）做回合区间比较；
// message_id 因异常落库缺失的孤儿行被 JOIN 自然丢弃（§3.3 边界：不抛错、不删除物理行）。
// 风格对齐同目录现有 repo（模块级函数 + getConnection()，session-repo / interaction-history-repo 同款）。

import { getConnection } from '../connection';

/** insert 入参 = 表列（id 自增不传）；截断/二进制判定由调用方（记录器）完成。 */
export interface TurnFileCheckpointInsert {
  session_id: string;
  message_id: string;
  path: string;
  tool_name: string;
  tool_use_id: string;
  input_json: string | null;
  input_truncated: number;
  after_content: string | null;
  after_truncated: number;
  binary: number;
  snapshot_state: 'disk' | 'failed';
}

/** listBySession 返回行 = 表列原样（snake_case，聚合按列取用）+ mrow（JOIN messages 的 rowid）。 */
export interface TurnFileCheckpointRow {
  id: number;
  session_id: string;
  message_id: string;
  path: string;
  tool_name: string;
  tool_use_id: string;
  input_json: string | null;
  input_truncated: number;
  after_content: string | null;
  after_truncated: number;
  binary: number;
  snapshot_state: string;
  mrow: number;
}

export function insert(row: TurnFileCheckpointInsert): void {
  const db = getConnection();
  db.prepare(
    `INSERT INTO turn_file_checkpoints (
       session_id, message_id, path, tool_name, tool_use_id,
       input_json, input_truncated, after_content, after_truncated,
       binary, snapshot_state
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.session_id,
    row.message_id,
    row.path,
    row.tool_name,
    row.tool_use_id,
    row.input_json,
    row.input_truncated,
    row.after_content,
    row.after_truncated,
    row.binary,
    row.snapshot_state,
  );
}

/** 按会话取全部 checkpoint（id 升序 = 落库顺序）。孤儿 message_id 行被 JOIN 自然丢弃，不抛错。 */
export function listBySession(sessionId: string): TurnFileCheckpointRow[] {
  const db = getConnection();
  return db
    .prepare(
      `SELECT t.*, m.rowid AS mrow
       FROM turn_file_checkpoints t
       JOIN messages m ON m.id = t.message_id
       WHERE t.session_id = ?
       ORDER BY t.id ASC`,
    )
    .all(sessionId) as TurnFileCheckpointRow[];
}

/** 该会话 checkpoint 物理行数（原始 COUNT，孤儿行计入；仅随 sessions 删除级联清零）。 */
export function countBySession(sessionId: string): number {
  const db = getConnection();
  return (db
    .prepare('SELECT COUNT(*) AS n FROM turn_file_checkpoints WHERE session_id = ?')
    .get(sessionId) as { n: number }).n;
}

/** 幂等守卫：该会话同 toolUseId 是否已有 checkpoint 行（resume/重放防重复落库，P3 记录器调用）。 */
export function existsByToolUseId(sessionId: string, toolUseId: string): boolean {
  const db = getConnection();
  const row = db
    .prepare('SELECT 1 AS hit FROM turn_file_checkpoints WHERE session_id = ? AND tool_use_id = ? LIMIT 1')
    .get(sessionId, toolUseId) as { hit: number } | undefined;
  return row !== undefined;
}
