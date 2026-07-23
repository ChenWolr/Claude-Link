// 附件实体与消息/任务关联的数据库读写。不负责文件系统操作（由 attachment-storage 管理）。
// 所有批量操作使用 transaction；ordinal 按传入顺序写入，保证附件展示顺序稳定。
import type {
  AttachmentKind,
  AttachmentRecord,
  AttachmentStatus,
  AttachmentSummary,
} from '../../../shared/types/attachment';
import { getConnection } from '../connection';

export interface CreateAttachmentInput {
  id: string;
  sessionId: string;
  filename: string;
  mimeType: string;
  kind: AttachmentKind;
  sizeBytes: number;
  sha256: string;
  storageKey: string;
  width?: number;
  height?: number;
  status: AttachmentStatus;
}

interface AttachmentRow {
  id: string;
  session_id: string;
  filename: string;
  mime_type: string;
  kind: AttachmentKind;
  size_bytes: number;
  sha256: string;
  storage_key: string;
  width: number | null;
  height: number | null;
  status: AttachmentStatus;
  created_at: string;
}

function toSummary(row: AttachmentRow): AttachmentSummary {
  return {
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    filename: row.filename,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    width: row.width ?? undefined,
    height: row.height ?? undefined,
    // 记录存在即文件曾成功写入；运行时丢失由预览失败兜底（UI 显示「附件不可用」）。
    previewAvailable: true,
    status: row.status,
  };
}

function toRecord(row: AttachmentRow): AttachmentRecord {
  return {
    ...toSummary(row),
    sha256: row.sha256,
    storageKey: row.storage_key,
  };
}

export function createAttachment(input: CreateAttachmentInput): AttachmentSummary {
  getConnection()
    .prepare(
      `INSERT INTO attachments (id, session_id, filename, mime_type, kind, size_bytes, sha256, storage_key, width, height, status)
       VALUES (@id, @sessionId, @filename, @mimeType, @kind, @sizeBytes, @sha256, @storageKey, @width, @height, @status)`,
    )
    .run({
      id: input.id,
      sessionId: input.sessionId,
      filename: input.filename,
      mimeType: input.mimeType,
      kind: input.kind,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      storageKey: input.storageKey,
      width: input.width ?? null,
      height: input.height ?? null,
      status: input.status,
    });

  // 不回读 SELECT，直接用已知参数构造（与 message-repo.createMessage 一致，省一次同步查询）。
  return {
    id: input.id,
    sessionId: input.sessionId,
    kind: input.kind,
    filename: input.filename,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    width: input.width,
    height: input.height,
    previewAvailable: true,
    status: input.status,
  };
}

export function getAttachment(id: string): AttachmentRecord | null {
  const row = getConnection()
    .prepare('SELECT * FROM attachments WHERE id = ?')
    .get(id) as AttachmentRow | undefined;
  return row ? toRecord(row) : null;
}

/**
 * 按会话范围批量解析附件记录，拒绝缺失、跨会话或重复 ID（不让 IPC 直接读任意附件）。
 * 返回顺序与传入 ids 一致。
 */
export function getAttachmentsByIdsForSession(sessionId: string, ids: string[]): AttachmentRecord[] {
  if (ids.length === 0) return [];
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length !== ids.length) {
    throw new Error('附件 ID 列表含重复项');
  }
  const placeholders = uniqueIds.map(() => '?').join(',');
  const rows = getConnection()
    .prepare(`SELECT * FROM attachments WHERE session_id = ? AND id IN (${placeholders})`)
    .all(sessionId, ...uniqueIds) as AttachmentRow[];
  if (rows.length !== uniqueIds.length) {
    throw new Error('部分附件不存在或不属于当前会话');
  }
  const byId = new Map(rows.map((row) => [row.id, toRecord(row)]));
  return ids.map((id) => byId.get(id)!);
}

export function markAttachmentsStatus(ids: string[], status: AttachmentStatus): void {
  if (ids.length === 0) return;
  const db = getConnection();
  const update = db.prepare('UPDATE attachments SET status = ? WHERE id = ?');
  const transaction = db.transaction((list: string[]) => {
    for (const id of list) update.run(status, id);
  });
  transaction(ids);
}

export function linkAttachmentsToMessage(messageId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getConnection();
  const insert = db.prepare(
    'INSERT INTO message_attachments (message_id, attachment_id, ordinal) VALUES (?, ?, ?)',
  );
  const transaction = db.transaction((list: string[]) => {
    list.forEach((attachmentId, ordinal) => insert.run(messageId, attachmentId, ordinal));
  });
  transaction(ids);
}

export function linkAttachmentsToTask(taskId: string, ids: string[]): void {
  if (ids.length === 0) return;
  const db = getConnection();
  const insert = db.prepare(
    'INSERT INTO task_attachments (task_id, attachment_id, ordinal) VALUES (?, ?, ?)',
  );
  const transaction = db.transaction((list: string[]) => {
    list.forEach((attachmentId, ordinal) => insert.run(taskId, attachmentId, ordinal));
  });
  transaction(ids);
}

/** 批量加载多消息的附件；无附件的 messageId 不写入 Map，由调用方按 [] 兜底。 */
export function getAttachmentsByMessageIds(messageIds: string[]): Map<string, AttachmentSummary[]> {
  const map = new Map<string, AttachmentSummary[]>();
  if (messageIds.length === 0) return map;
  const placeholders = messageIds.map(() => '?').join(',');
  const rows = getConnection()
    .prepare(
      `SELECT a.*, ma.message_id AS message_id, ma.ordinal AS ordinal
       FROM message_attachments ma
       JOIN attachments a ON a.id = ma.attachment_id
       WHERE ma.message_id IN (${placeholders})
       ORDER BY ma.message_id, ma.ordinal`,
    )
    .all(...messageIds) as (AttachmentRow & { message_id: string; ordinal: number })[];
  for (const row of rows) {
    const list = map.get(row.message_id) ?? [];
    list.push(toSummary(row));
    map.set(row.message_id, list);
  }
  return map;
}

export function getAttachmentsByTaskIds(taskIds: string[]): Map<string, AttachmentSummary[]> {
  const map = new Map<string, AttachmentSummary[]>();
  if (taskIds.length === 0) return map;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = getConnection()
    .prepare(
      `SELECT a.*, ta.task_id AS task_id, ta.ordinal AS ordinal
       FROM task_attachments ta
       JOIN attachments a ON a.id = ta.attachment_id
       WHERE ta.task_id IN (${placeholders})
       ORDER BY ta.task_id, ta.ordinal`,
    )
    .all(...taskIds) as (AttachmentRow & { task_id: string; ordinal: number })[];
  for (const row of rows) {
    const list = map.get(row.task_id) ?? [];
    list.push(toSummary(row));
    map.set(row.task_id, list);
  }
  return map;
}

/** 附件被消息/任务引用的总次数（决定物理文件是否可删）。 */
export function getAttachmentReferenceCount(id: string): number {
  const db = getConnection();
  const m = db.prepare('SELECT COUNT(*) AS n FROM message_attachments WHERE attachment_id = ?').get(id) as { n: number };
  const t = db.prepare('SELECT COUNT(*) AS n FROM task_attachments WHERE attachment_id = ?').get(id) as { n: number };
  return m.n + t.n;
}

/** 删除任务-附件关联，返回被解除的附件 ID（供 handler 按引用计数决定是否删文件）。 */
export function deleteTaskAttachmentLinks(taskId: string): string[] {
  const db = getConnection();
  const rows = db
    .prepare('SELECT attachment_id FROM task_attachments WHERE task_id = ?')
    .all(taskId) as { attachment_id: string }[];
  if (rows.length > 0) {
    db.prepare('DELETE FROM task_attachments WHERE task_id = ?').run(taskId);
  }
  return rows.map((row) => row.attachment_id);
}

export function listStorageKeysBySession(sessionId: string): string[] {
  const rows = getConnection()
    .prepare('SELECT storage_key FROM attachments WHERE session_id = ?')
    .all(sessionId) as { storage_key: string }[];
  return rows.map((row) => row.storage_key);
}

export function listDraftAttachments(): AttachmentRecord[] {
  const rows = getConnection()
    .prepare("SELECT * FROM attachments WHERE status = 'draft'")
    .all() as AttachmentRow[];
  return rows.map(toRecord);
}

export function listAllStorageKeys(): string[] {
  const rows = getConnection()
    .prepare('SELECT storage_key FROM attachments')
    .all() as { storage_key: string }[];
  return rows.map((row) => row.storage_key);
}

export function deleteAttachment(id: string): void {
  getConnection().prepare('DELETE FROM attachments WHERE id = ?').run(id);
}
