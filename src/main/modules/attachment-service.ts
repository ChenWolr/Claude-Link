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
  cleanupStalePartFiles,
  listStoredAttachmentKeys,
  probeImageDimensions,
  readStoredAttachmentBytes,
  readStoredAttachmentPreview,
  removeAttachmentFile,
  resolveAbsolutePath,
  writeAttachmentFile,
} from './attachment-storage';
import { randomUUID } from 'node:crypto';
import * as attachmentRepo from '../database/repositories/attachment-repo';
import type {
  AttachmentKind,
  AttachmentPreviewResponse,
  AttachmentRecord,
  AttachmentSummary,
  StoredAttachmentFile,
} from '../../shared/types/attachment';
import { logger } from '../utils/logger';

/** 校验 + 原子写文件（不建 DB 行）。正式暂存与暂态暂存两条路径共用，保证校验语义不分裂。 */
async function validateAndStoreAttachment(input: StagedAttachmentInput): Promise<{
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  width?: number;
  height?: number;
  stored: StoredAttachmentFile;
}> {
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
  return { kind: policy.kind, filename: safeFilename, mimeType, width, height, stored };
}

/**
 * 暂存草稿附件：字节级校验 → 图片尺寸校验 → 原子写文件 → 建 draft 记录。
 * 任一步失败都删除已写的临时文件。返回的摘要不含绝对路径/哈希/storageKey。
 * id 由调用方（IPC handler）提供，与 repo 记录、storageKey 共用。
 */
export async function stageAttachment(input: StagedAttachmentInput): Promise<AttachmentSummary> {
  const info = await validateAndStoreAttachment(input);
  try {
    return attachmentRepo.createAttachment({
      id: input.id,
      sessionId: input.sessionId,
      filename: info.filename,
      mimeType: info.mimeType,
      kind: info.kind,
      sizeBytes: info.stored.sizeBytes,
      sha256: info.stored.sha256,
      storageKey: info.stored.storageKey,
      width: info.width,
      height: info.height,
      status: 'draft',
    });
  } catch (error) {
    await removeAttachmentFile(info.stored.storageKey).catch(() => {});
    throw error;
  }
}

// —— 暂态附件（无会话行暂存）——
// 「新会话」延迟持久化：暂态会话尚无 sessions 行，attachments 表外键（session_id REFERENCES
// sessions）不允许建行。这里只写物理文件 + 内存 Map；物化（SESSION_CREATE 带
// bindTransientAttachmentIds）时经 bindTransientAttachmentsToSession 转正为 draft 行。
// 崩溃/放弃的暂态文件没有 DB 记录 → 下次启动 cleanupOrphanAttachments 自动清扫。
const transientAttachments = new Map<string, AttachmentRecord>();

/** 暂态暂存：校验+落盘与正式路径完全一致，但记录进内存 Map 而非 DB。 */
export async function stageTransientAttachment(input: StagedAttachmentInput): Promise<AttachmentSummary> {
  const info = await validateAndStoreAttachment(input);
  const record: AttachmentRecord = {
    id: input.id,
    sessionId: input.sessionId,
    kind: info.kind,
    filename: info.filename,
    mimeType: info.mimeType,
    sizeBytes: info.stored.sizeBytes,
    width: info.width,
    height: info.height,
    previewAvailable: true,
    status: 'draft',
    sha256: info.stored.sha256,
    storageKey: info.stored.storageKey,
  };
  transientAttachments.set(input.id, record);
  // 摘要不携带内部字段（sha256/storageKey 不出主进程）。
  const { sha256: _sha, storageKey: _key, ...summary } = record;
  return summary;
}

/** 按 id + 会话归属取暂态记录（归属校验与 DB 路径同构）。 */
export function getTransientAttachment(id: string, sessionId: string): AttachmentRecord | null {
  const record = transientAttachments.get(id);
  return record && record.sessionId === sessionId ? record : null;
}

/** 移除暂态附件：删映射 + 删物理文件（失败仅记日志，交 orphan cleanup 兜底）。 */
export async function removeTransientAttachment(sessionId: string, id: string): Promise<void> {
  const record = getTransientAttachment(id, sessionId);
  if (!record) return;
  transientAttachments.delete(id);
  await removeAttachmentFile(record.storageKey).catch((e) => logger.error('removeTransientAttachment file failed', e));
}

/**
 * 物化转正：把暂态附件绑定到刚建好的会话行（status='draft'，随后走正常发送链路）。
 * storageKey 保留暂存时的原值（key 由暂态 sessionId 段构成，仅是路径字符串，不影响
 * 定位/删除/预览——后续会话删除按 DB 行里的 key 清文件，同样命中）。不在 Map 里的 id
 * 静默跳过（已被用户移除或本就不存在）。
 */
export function bindTransientAttachmentsToSession(sessionId: string, ids: string[]): void {
  for (const id of ids) {
    const record = transientAttachments.get(id);
    if (!record) continue;
    transientAttachments.delete(id);
    attachmentRepo.createAttachment({
      id: record.id,
      sessionId,
      filename: record.filename,
      mimeType: record.mimeType,
      kind: record.kind,
      sizeBytes: record.sizeBytes,
      sha256: record.sha256,
      storageKey: record.storageKey,
      width: record.width,
      height: record.height,
      status: 'draft',
    });
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

/**
 * 发送前附件就绪校验：归属当前会话 + 必须为 draft 状态（已发送附件不可重复发送）。
 * 空列表为 no-op（Task 3 阶段 renderer 恒传空，Task 4/7 复用此函数接入真实附件）。
 * 复用 resolveAttachmentRecords（其内部 getAttachmentsByIdsForSession 已拒绝缺失/跨会话/重复 ID）。
 */
export function assertAttachmentsReadyForSend(
  sessionId: string,
  ids: string[],
): { records: AttachmentRecord[]; paths: Record<string, string> } {
  const resolved = resolveAttachmentRecords(sessionId, ids);
  for (const record of resolved.records) {
    if (record.status !== 'draft') {
      throw new AttachmentInputError(`附件「${record.filename}」不是草稿状态，无法发送。`);
    }
  }
  return resolved;
}

/** 移除草稿附件：校验会话归属与 draft 状态后，先删 DB 记录再删物理文件。 */
export async function removeDraftAttachment(sessionId: string, attachmentId: string): Promise<void> {
  const record = attachmentRepo.getAttachment(attachmentId);
  if (!record) {
    // 暂态附件（无 DB 行）：走内存映射 + 物理文件删除。
    await removeTransientAttachment(sessionId, attachmentId);
    return;
  }
  if (record.sessionId !== sessionId) throw new AttachmentInputError('附件不属于当前会话');
  if (record.status !== 'draft') throw new AttachmentInputError('仅可移除草稿状态的附件');
  attachmentRepo.deleteAttachment(attachmentId);
  await removeAttachmentFile(record.storageKey).catch((e) => logger.error('removeAttachmentFile failed', e));
}

/**
 * 删除任务/消息解除关联后【零引用】的附件（DB 记录 + 物理文件）。
 * 用于 TASK_REMOVE：deleteTask 已解除 task_attachments，若该附件既无 message 也无 task 引用
 * （getAttachmentReferenceCount===0，即未执行的 pending task 附件）则彻底删除；
 * 已被执行升格为 message 的附件仍有 message 引用，保留。物理删除失败交 orphan cleanup 重试。
 */
export async function cleanupDetachedAttachments(ids: string[]): Promise<void> {
  for (const id of ids) {
    const record = attachmentRepo.getAttachment(id);
    if (!record) continue;
    if (attachmentRepo.getAttachmentReferenceCount(id) > 0) continue;
    attachmentRepo.deleteAttachment(id);
    await removeAttachmentFile(record.storageKey).catch((e) =>
      logger.error('cleanupDetachedAttachments removeAttachmentFile failed', e),
    );
  }
}

/** 受控预览：校验会话归属后返回有界缩略图/原图 bytes，不返回路径。 */
export async function getAttachmentPreview(request: {
  sessionId: string;
  attachmentId: string;
  thumbnail: boolean;
}): Promise<AttachmentPreviewResponse> {
  const record =
    attachmentRepo.getAttachment(request.attachmentId) ??
    getTransientAttachment(request.attachmentId, request.sessionId);
  if (!record) throw new AttachmentInputError('附件不存在');
  if (record.sessionId !== request.sessionId) throw new AttachmentInputError('附件不属于当前会话');
  return readStoredAttachmentPreview(record, request.thumbnail);
}

/**
 * 克隆历史消息附件为草稿：异步发送失败（provider 拒图等）后，让用户基于已落库附件重新编辑发送。
 * 逐个读原文件 → 写新 draft（新 id/文件）；任一失败回滚整组（删已产生的 draft 记录+文件），不返回半组。
 * 跨会话防护：消息附件必须属于当前会话（getAttachmentsByMessageIds 不校验 session）。
 * 不自动重发、不切模型；调用方拿到草稿后由用户编辑并手动发送（新 clientMessageId）。
 */
export async function cloneMessageAttachmentsToDraft(
  sessionId: string,
  messageId: string,
): Promise<AttachmentSummary[]> {
  const summaries = attachmentRepo.getAttachmentsByMessageIds([messageId]).get(messageId) ?? [];
  logger.info(`cloneMessageAttachmentsToDraft: sessionId=${sessionId} messageId=${messageId} 消息附件数=${summaries.length}`);
  for (const sum of summaries) {
    if (sum.sessionId !== sessionId) {
      throw new AttachmentInputError('消息不属于当前会话');
    }
  }
  if (summaries.length === 0) return [];

  const created: AttachmentSummary[] = [];
  const createdIds: string[] = [];
  try {
    for (const sum of summaries) {
      const record = attachmentRepo.getAttachment(sum.id);
      if (!record) throw new AttachmentInputError(`附件「${sum.filename}」记录缺失`);
      const bytes = await readStoredAttachmentBytes(record);
      const staged = await stageAttachment({
        id: randomUUID(),
        sessionId,
        filename: sum.filename,
        mimeType: sum.mimeType,
        bytes,
      });
      created.push(staged);
      createdIds.push(staged.id);
    }
    logger.info(`cloneMessageAttachmentsToDraft: 成功克隆 ${created.length} 个附件为草稿`);
    return created;
  } catch (err) {
    // 任一失败：清理已产生的 draft 副本（record + file），整组不返回。
    for (const id of createdIds) {
      try {
        await removeDraftAttachment(sessionId, id);
      } catch (e) {
        logger.error(`clone cleanup ${id} failed`, e);
      }
    }
    throw err;
  }
}

/**
 * 启动时按真实引用修正附件状态，避免崩溃窗口留下的 draft 被误删。
 * 消息引用优先于任务引用；均无引用才删除记录和物理文件。
 */
export async function reconcileDraftAttachments(): Promise<void> {
  const drafts = attachmentRepo.listDraftAttachments();
  for (const draft of drafts) {
    try {
      const refs = attachmentRepo.getAttachmentReferenceCounts(draft.id);
      if (refs.message > 0) {
        attachmentRepo.markAttachmentsStatus([draft.id], 'message');
      } else if (refs.task > 0) {
        attachmentRepo.markAttachmentsStatus([draft.id], 'task');
      } else {
        attachmentRepo.deleteAttachment(draft.id);
        await removeAttachmentFile(draft.storageKey);
      }
    } catch (e) {
      logger.error(`reconcile draft attachment ${draft.id} failed`, e);
    }
  }
}

/** 兼容旧调用名；语义已改为引用 reconcile。 */
export const cleanupDraftAttachments = reconcileDraftAttachments;

/** 启动清理：删除数据库无记录的孤儿物理文件和过期临时文件。 */
export async function cleanupOrphanAttachments(): Promise<void> {
  await cleanupStalePartFiles();
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
