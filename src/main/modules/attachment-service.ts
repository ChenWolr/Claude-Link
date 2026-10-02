// 附件应用服务：编排 storage（文件）与 attachment-repo（DB），提供 IPC/发送/启动流程使用的统一入口。
// 不直接暴露文件系统路径给 renderer；绝对路径仅在主进程内部（resolveAttachmentRecords）流转。
import {
  AttachmentInputError,
  classifyAttachment,
  detectDirectImageFormat,
  sanitizeAttachmentFilename,
  validateAttachmentBytes,
  validateImageDimensions,
} from './attachment-policy';
import {
  filterDraftAttachmentsByQuota,
  type DraftQuotaItem,
} from '../../shared/draft-attachment-quota';
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
  CloneMessageAttachmentsResult,
  StoredAttachmentFile,
} from '../../shared/types/attachment';
import { logger } from '../utils/logger';

/**
 * A11（D08-F1）：会话当前草稿余量清单——DB draft 行 + 暂态 Map 同会话项合并，
 * 供暂存权威校验与四入口预检同口径取数（数量 ≤10 / 总预算 50MiB 的「已有」侧基数）。
 */
export function listDraftQuotaItems(sessionId: string): DraftQuotaItem[] {
  const items: DraftQuotaItem[] = attachmentRepo
    .listDraftAttachmentsBySession(sessionId)
    .map((r) => ({ filename: r.filename, kind: r.kind, sizeBytes: r.sizeBytes }));
  for (const r of transientAttachments.values()) {
    if (r.sessionId === sessionId && r.status === 'draft') {
      items.push({ filename: r.filename, kind: r.kind, sizeBytes: r.sizeBytes });
    }
  }
  return items;
}

/**
 * A11（D08-F1）：暂存权威余量校验——「已有草稿 + 本项」三约束任一超限即抛
 * AttachmentInputError（发生在校验落盘之前：不写文件、不建行/不进暂态 Map，杜绝不可见草稿）。
 * kind 按文件名/MIME 近似（classifyAttachment），真实 kind 由随后的字节级校验裁定；
 * 近似与真实不一致的边缘（无扩展名伪装图片等）误差由发送时 validateSendBudget 兜底。
 */
function assertDraftQuotaAllows(sessionId: string, filename: string, mimeType: string | undefined, sizeBytes: number): void {
  const kind = classifyAttachment(filename, mimeType ?? '');
  const decision = filterDraftAttachmentsByQuota(listDraftQuotaItems(sessionId), [
    { filename, kind, sizeBytes },
  ]);
  if (decision.rejected.length > 0) {
    throw new AttachmentInputError(decision.rejected[0].reason);
  }
}

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
  // A11（D08-F1）：余量权威校验先于校验落盘（超限即拒：不写文件、不建 draft 行）。
  assertDraftQuotaAllows(input.sessionId, input.filename, input.mimeType, input.bytes.byteLength);
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
  // A11（D08-F1）：余量权威校验先于校验落盘（超限即拒：不写文件、不进暂态 Map）。
  assertDraftQuotaAllows(input.sessionId, input.filename, input.mimeType, input.bytes.byteLength);
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
  const boundIds: string[] = [];
  // B8（D08-F2）：bindOne 弹出的暂态记录在此留底——失败回滚删行后放回 Map，附件回到
  // 暂态可重试状态（否则失联 id 重试物化被静默跳过，发送被「部分附件不存在」阻断）。
  const consumedRecords: AttachmentRecord[] = [];
  try {
    for (const id of ids) {
      bindOne(sessionId, id, boundIds, consumedRecords);
    }
  } catch (err) {
    // hb10-ATT-V01：物化失败回滚已建行（收集已建 id 逐个 deleteAttachment），不再死锁半态。
    for (const id of boundIds) {
      try { attachmentRepo.deleteAttachment(id); } catch { /* 尽力回滚 */ }
    }
    // B8（D08-F2）：未转正的回暂态 Map（成功位行已删/失败位行未建成）；不在 Map 的 id
    // （DB 已转正/用户已移除）不在留底名单、保持原状，已转正行不受回滚影响。
    for (const record of consumedRecords) {
      transientAttachments.set(record.id, record);
    }
    throw err;
  }
}

function bindOne(sessionId: string, id: string, boundIds: string[], consumedRecords: AttachmentRecord[]): void {
  {
    const record = transientAttachments.get(id);
    if (!record) return;
    // hb10-ATT-04（收窄）：归属守卫——记录不属于目标会话（会话 id 传错/复用）跳过。
    if (record.sessionId !== sessionId) return;
    // B8：留底先于弹出——createAttachment 抛错时记录仍可经回滚放回 Map。
    consumedRecords.push(record);
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
    boundIds.push(id);
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

/** 受控预览：校验会话归属后返回缩略图/原图 bytes，不返回路径（原图无读侧字节预检，上界来自图片暂存 10MiB 上限；导出快照链另传 maxBytes 读前预检）。 */
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
  // hb10-ATT-09：原图预览（thumbnail=false）仅限 image kind——文档/文件不放行原图通道。
  if (!request.thumbnail && record.kind !== 'image') {
    throw new AttachmentInputError('该附件类型不支持原图预览');
  }
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
): Promise<CloneMessageAttachmentsResult> {
  const summaries = attachmentRepo.getAttachmentsByMessageIds([messageId]).get(messageId) ?? [];
  logger.info(`cloneMessageAttachmentsToDraft: sessionId=${sessionId} messageId=${messageId} 消息附件数=${summaries.length}`);
  for (const sum of summaries) {
    if (sum.sessionId !== sessionId) {
      throw new AttachmentInputError('消息不属于当前会话');
    }
  }
  if (summaries.length === 0) return { created: [], rejected: [] };

  // A11（D08-F1）：克隆按「克隆后总量」预检——已有草稿 + 本消息附件组合裁定，余量内
  // 逐个克隆，超量项不读盘不落盘、以 rejected 名单返回（调用方 notice，替代旧的
  // 「全量克隆后由 renderer store 拒收」——超量克隆件不再滞留为不可见草稿）。
  // accepted/rejected 元素引用传入对象，据引用相等映射回源摘要。
  const quotaOf = new Map<AttachmentSummary, DraftQuotaItem>();
  const incoming = summaries.map((s) => {
    const q: DraftQuotaItem = { filename: s.filename, kind: s.kind, sizeBytes: s.sizeBytes };
    quotaOf.set(s, q);
    return q;
  });
  const decision = filterDraftAttachmentsByQuota(listDraftQuotaItems(sessionId), incoming);
  const allowed = new Set(decision.accepted);
  const rejected = decision.rejected.map((r) => ({ filename: r.item.filename, reason: r.reason }));

  const created: AttachmentSummary[] = [];
  const createdIds: string[] = [];
  try {
    for (const sum of summaries) {
      if (!allowed.has(quotaOf.get(sum)!)) continue;
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
    logger.info(`cloneMessageAttachmentsToDraft: 成功克隆 ${created.length} 个附件为草稿（预检拒 ${rejected.length} 个）`);
    return { created, rejected };
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
  const dbKeys = attachmentRepo.listAllStorageKeys();
  // P2-12：清扫 .part 时跳过 DB 已登记键——名字本身以 .part 结尾的合法附件不得误删。
  await cleanupStalePartFiles(60 * 60 * 1000, dbKeys);
  const dbKeySet = new Set(dbKeys);
  const storedKeys = await listStoredAttachmentKeys();
  for (const key of storedKeys) {
    if (!dbKeySet.has(key)) {
      await removeAttachmentFile(key).catch((e) => logger.error(`cleanup orphan attachment ${key} failed`, e));
    }
  }
}

/** 会话删除后清理：按此前收集的 storage keys 删除物理文件（DB 级联已删行）。文件删除失败仅记 error 日志，交下次启动 orphan cleanup 兜底重试。 */
export async function cleanupSessionAttachments(sessionId: string, storageKeys: string[]): Promise<void> {
  for (const key of storageKeys) {
    await removeAttachmentFile(key).catch((e) =>
      logger.error(`cleanup session ${sessionId} attachment ${key} failed`, e),
    );
  }
}
