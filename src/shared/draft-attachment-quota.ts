// A11（D08-F1）：草稿附件余量预检——暂存前按「已有草稿 + 本次新增」组合裁定，
// 杜绝「先落盘后裁剪」产生不可见草稿（文件 + DB 行/暂态 Map 滞留到下次启动 reconcile 才回收）。
// renderer 不 import 主进程模块（仓库惯例），三约束常量与 attachment-policy 同值本地镜像，
// tdd-draft-attachment-quota-verify ⑨ 钉两处同值（漂移即红）：
//   数量 ≤10（MAX_ATTACHMENTS_PER_SEND）、总预算 ≤50MiB（MAX_TOTAL_BYTES，图片按 Base64
//   编码后长度计入）、单项限额图片 10MiB / 其余 30MiB（MAX_IMAGE/MAX_FILE_BYTES）。
// 预检 kind 允许近似（draftQuotaKindFromMime 按 MIME 镜像判定），字节级真实 kind 与魔数校验
// 仍由主进程 attachment-policy 裁定——预检只是把「必然被拒」的附件挡在落盘之前。
import type { AttachmentKind } from './types/attachment';

export const DRAFT_QUOTA_MAX_COUNT = 10;
export const DRAFT_QUOTA_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const DRAFT_QUOTA_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DRAFT_QUOTA_FILE_MAX_BYTES = 30 * 1024 * 1024;

/** 预检项：kind 近似即可（AttachmentSummary 结构兼容，可直接作为 currentDrafts 传入）。 */
export interface DraftQuotaItem {
  filename: string;
  kind: AttachmentKind;
  sizeBytes: number;
}

export interface DraftQuotaReject {
  item: DraftQuotaItem;
  reason: string;
}

export interface DraftQuotaDecision {
  accepted: DraftQuotaItem[];
  rejected: DraftQuotaReject[];
}

/** 图片计入总预算按 Base64 编码后长度（与 attachment-policy.computeBase64Bytes 同式）。 */
export function draftQuotaImageEncodedBytes(sizeBytes: number): number {
  return Math.ceil(sizeBytes / 3) * 4;
}

/**
 * MIME→kind 近似镜像（attachment-policy.DIRECT_IMAGE_MIME 同集）：粘贴/拖放场景 renderer
 * 只拿得到 file.type；document 与 file 对预算计算无差别，一律按 'file' 口径。
 */
export function draftQuotaKindFromMime(mimeType: string): AttachmentKind {
  const mime = (mimeType ?? '').trim().toLowerCase();
  return mime === 'image/jpeg' || mime === 'image/png' || mime === 'image/gif' || mime === 'image/webp'
    ? 'image'
    : 'file';
}

function quotaBytesOf(item: DraftQuotaItem): number {
  return item.kind === 'image' ? draftQuotaImageEncodedBytes(item.sizeBytes) : item.sizeBytes;
}

/**
 * 余量组合预检：按传入顺序逐项裁定，返回可暂存前缀与被拒明细（保合法项、拒超量项，
 * accepted/rejected 元素引用传入对象——调用方可据引用相等映射回原 File/附件记录）。
 * currentDrafts 的预算同样按 kind 计（AttachmentSummary 有 kind/sizeBytes，可直接传入）。
 */
export function filterDraftAttachmentsByQuota(
  currentDrafts: DraftQuotaItem[],
  incoming: DraftQuotaItem[],
): DraftQuotaDecision {
  const accepted: DraftQuotaItem[] = [];
  const rejected: DraftQuotaReject[] = [];
  let total = currentDrafts.reduce((sum, d) => sum + quotaBytesOf(d), 0);
  for (const item of incoming) {
    if (currentDrafts.length + accepted.length >= DRAFT_QUOTA_MAX_COUNT) {
      rejected.push({ item, reason: `附件数量将超过 ${DRAFT_QUOTA_MAX_COUNT} 个上限` });
      continue;
    }
    if (item.kind === 'image' && item.sizeBytes > DRAFT_QUOTA_IMAGE_MAX_BYTES) {
      rejected.push({ item, reason: `图片「${item.filename}」超过 10 MiB 上限` });
      continue;
    }
    if (item.kind !== 'image' && item.sizeBytes > DRAFT_QUOTA_FILE_MAX_BYTES) {
      rejected.push({ item, reason: `文件「${item.filename}」超过 30 MiB 上限` });
      continue;
    }
    const bytes = quotaBytesOf(item);
    if (total + bytes > DRAFT_QUOTA_MAX_TOTAL_BYTES) {
      rejected.push({ item, reason: '附件总传输量将超过 50 MiB 上限' });
      continue;
    }
    accepted.push(item);
    total += bytes;
  }
  return { accepted, rejected };
}
