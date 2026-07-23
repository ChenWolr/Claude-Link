// 附件应用服务：编排 storage（文件）与 attachment-repo（DB），提供 IPC/发送/启动流程使用的统一入口。
// 不直接暴露文件系统路径给 renderer；绝对路径仅在主进程内部（resolveAttachmentRecords）流转。
import {
  AttachmentInputError,
  detectDirectImageFormat,
  sanitizeAttachmentFilename,
  validateAttachmentBytes,
  validateImageDimensions,
} from './attachment-policy';
import {
  type StagedAttachmentInput,
  listStoredAttachmentKeys,
  probeImageDimensions,
  readStoredAttachmentPreview,
  removeAttachmentFile,
  resolveAbsolutePath,
  writeAttachmentFile,
} from './attachment-storage';
import * as attachmentRepo from '../database/repositories/attachment-repo';
import type {
  AttachmentPreviewResponse,
  AttachmentRecord,
  AttachmentSummary,
} from '../../shared/types/attachment';
import { logger } from '../utils/logger';

/**
 * 暂存草稿附件：字节级校验 → 图片尺寸校验 → 原子写文件 → 建 draft 记录。
 * 任一步失败都删除已写的临时文件。返回的摘要不含绝对路径/哈希/storageKey。
 * id 由调用方（IPC handler）提供，与 repo 记录、storageKey 共用。
 */
export async function stageAttachment(input: StagedAttachmentInput): Promise<AttachmentSummary> {
  const policy = validateAttachmentBytes({
    filename: input.filename,
    mimeType: input.mimeType ?? '',
    bytes: input.bytes,
  });
  if (!policy.ok) throw new AttachmentInputError(policy.message);

  let width: number | undefined;
  let height: number | undefined;
  if (policy.kind === 'image') {
    const dims = probeImageDimensions(input.bytes);
    if (!dims) {
      throw new AttachmentInputError(`附件「${input.filename}」的内容不是有效的图片，无法解码。`);
    }
    const dimCheck = validateImageDimensions(dims);
    if (!dimCheck.ok) throw new AttachmentInputError(dimCheck.message);
    width = dims.width;
    height = dims.height;
  }

  const stored = await writeAttachmentFile(input);
  const safeFilename = sanitizeAttachmentFilename(input.filename);
  const detectedMime = detectDirectImageFormat(input.bytes);
  const mimeType = detectedMime ?? (input.mimeType?.trim() || 'application/octet-stream');

  try {
    return attachmentRepo.createAttachment({
      id: input.id,
      sessionId: input.sessionId,
      filename: safeFilename,
      mimeType,
      kind: policy.kind,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      storageKey: stored.storageKey,
      width,
      height,
      status: 'draft',
    });
  } catch (error) {
    await removeAttachmentFile(stored.storageKey).catch(() => {});
    throw error;
  }
}

/** 按会话范围解析附件记录与受控绝对路径（供 prompt builder 取文件路径送 Read）。 */
export function resolveAttachmentRecords(
  sessionId: string,
  ids: string[],
): { records: AttachmentRecord[]; paths: Record<string, string> } {
  const records = attachmentRepo.getAttachmentsByIdsForSession(sessionId, ids);
  const paths: Record<string, string> = {};
  for (const record of records) {
    paths[record.id] = resolveAbsolutePath(record.storageKey);
  }
  return { records, paths };
}

/** 移除草稿附件：校验会话归属与 draft 状态后，先删 DB 记录再删物理文件。 */
export async function removeDraftAttachment(sessionId: string, attachmentId: string): Promise<void> {
  const record = attachmentRepo.getAttachment(attachmentId);
  if (!record) return;
  if (record.sessionId !== sessionId) throw new AttachmentInputError('附件不属于当前会话');
  if (record.status !== 'draft') throw new AttachmentInputError('仅可移除草稿状态的附件');
  attachmentRepo.deleteAttachment(attachmentId);
  await removeAttachmentFile(record.storageKey).catch((e) => logger.error('removeAttachmentFile failed', e));
}

/** 受控预览：校验会话归属后返回有界缩略图/原图 bytes，不返回路径。 */
export async function getAttachmentPreview(request: {
  sessionId: string;
  attachmentId: string;
  thumbnail: boolean;
}): Promise<AttachmentPreviewResponse> {
  const record = attachmentRepo.getAttachment(request.attachmentId);
  if (!record) throw new AttachmentInputError('附件不存在');
  if (record.sessionId !== request.sessionId) throw new AttachmentInputError('附件不属于当前会话');
  return readStoredAttachmentPreview(record, request.thumbnail);
}

/** 启动清理：删除遗留的 draft 附件（未发送草稿）。 */
export async function cleanupDraftAttachments(): Promise<void> {
  const drafts = attachmentRepo.listDraftAttachments();
  for (const draft of drafts) {
    try {
      attachmentRepo.deleteAttachment(draft.id);
      await removeAttachmentFile(draft.storageKey);
    } catch (e) {
      logger.error(`cleanup draft attachment ${draft.id} failed`, e);
    }
  }
}

/** 启动清理：删除数据库无记录的孤儿物理文件。 */
export async function cleanupOrphanAttachments(): Promise<void> {
  const dbKeys = new Set(attachmentRepo.listAllStorageKeys());
  const storedKeys = await listStoredAttachmentKeys();
  for (const key of storedKeys) {
    if (!dbKeys.has(key)) {
      await removeAttachmentFile(key).catch((e) => logger.error(`cleanup orphan attachment ${key} failed`, e));
    }
  }
}

/** 会话删除后清理：按此前收集的 storage keys 删除物理文件（DB 级联已删行）。文件删除失败只记警告。 */
export async function cleanupSessionAttachments(sessionId: string, storageKeys: string[]): Promise<void> {
  for (const key of storageKeys) {
    await removeAttachmentFile(key).catch((e) =>
      logger.error(`cleanup session ${sessionId} attachment ${key} failed`, e),
    );
  }
}
