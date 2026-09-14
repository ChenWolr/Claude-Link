import type { AttachmentSummary } from '../../shared/types/attachment';
import type { ExportAttachmentSnapshot, RenderableMessage } from '../../shared/types/export-image';

export type ExportAttachmentPreviewLoader = (attachment: AttachmentSummary) => Promise<{
  mimeType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
}>;

export interface ExportSnapshotBudgetOptions {
  /** 预览字节总预算：边加载边累计，达到后对剩余任务短路降级 previewUnavailable（hb10 P2-10）。 */
  budgetBytes?: number;
  /** 并发上限：默认 8（worker-pool），替换原无上限嵌套 Promise.all 的同时整读。 */
  maxConcurrency?: number;
}

/** 构建不含内部身份和路径的导出附件快照；单张预览失败不阻断整次导出。
 *  hb10 P2-10：任务展平后按受限并发填充（简单 worker-pool：固定 worker 数循环取任务），
 *  预算随加载累计，超预算即对剩余任务短路降级——不再「先整读全部、后判预算」。 */
export async function buildExportAttachmentSnapshots(
  messages: Array<RenderableMessage<AttachmentSummary>>,
  loadPreview: ExportAttachmentPreviewLoader,
  options: ExportSnapshotBudgetOptions = {},
): Promise<Array<RenderableMessage<ExportAttachmentSnapshot>>> {
  const maxConcurrency = Math.max(1, options.maxConcurrency ?? 8);
  const budgetBytes = options.budgetBytes;

  // 先铺基础快照（无预览），任务展平后按序填充，保证输出顺序与输入一致。
  const snapshots: ExportAttachmentSnapshot[][] = messages.map((message) =>
    (message.attachments ?? []).map((attachment) => ({
      kind: attachment.kind,
      filename: attachment.filename,
      mimeType: attachment.mimeType,
      sizeBytes: attachment.sizeBytes,
      width: attachment.width,
      height: attachment.height,
    })),
  );
  type SnapshotTask = { messageIdx: number; attIdx: number; attachment: AttachmentSummary };
  const tasks: SnapshotTask[] = [];
  messages.forEach((message, messageIdx) => {
    (message.attachments ?? []).forEach((attachment, attIdx) => {
      if (attachment.kind !== 'image') return;
      tasks.push({ messageIdx, attIdx, attachment });
    });
  });

  let usedBytes = 0;
  let budgetExhausted = false;
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next++];
      const target = snapshots[task.messageIdx][task.attIdx];
      // 预算耗尽：剩余任务全部短路降级，不再读文件。
      if (budgetExhausted) {
        snapshots[task.messageIdx][task.attIdx] = { ...target, previewUnavailable: true };
        continue;
      }
      try {
        const preview = await loadPreview(task.attachment);
        if (preview.mimeType !== 'image/png' || !preview.width || !preview.height) {
          snapshots[task.messageIdx][task.attIdx] = { ...target, previewUnavailable: true };
          continue;
        }
        usedBytes += preview.bytes.byteLength;
        if (budgetBytes !== undefined && usedBytes >= budgetBytes) budgetExhausted = true;
        // readStoredAttachmentPreview 已返回新副本，此处不再 Uint8Array.from 双拷（hb10 P2-10）。
        target.preview = {
          mimeType: 'image/png',
          bytes: preview.bytes,
          width: preview.width,
          height: preview.height,
        };
      } catch {
        snapshots[task.messageIdx][task.attIdx] = { ...target, previewUnavailable: true };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, tasks.length) }, () => worker()));

  return messages.map((message, messageIdx) => ({ ...message, attachments: snapshots[messageIdx] }));
}
