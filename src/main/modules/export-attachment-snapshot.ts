import type { AttachmentSummary } from '../../shared/types/attachment';
import type { ExportAttachmentSnapshot, RenderableMessage } from '../../shared/types/export-image';

export type ExportAttachmentPreviewLoader = (attachment: AttachmentSummary) => Promise<{
  mimeType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
}>;

/** 构建不含内部身份和路径的导出附件快照；单张预览失败不阻断整次导出。 */
export async function buildExportAttachmentSnapshots(
  messages: Array<RenderableMessage<AttachmentSummary>>,
  loadPreview: ExportAttachmentPreviewLoader,
): Promise<Array<RenderableMessage<ExportAttachmentSnapshot>>> {
  return Promise.all(messages.map(async (message) => {
    const attachments: ExportAttachmentSnapshot[] = await Promise.all(
      (message.attachments ?? []).map(async (attachment) => {
        const snapshot: ExportAttachmentSnapshot = {
          kind: attachment.kind,
          filename: attachment.filename,
          mimeType: attachment.mimeType,
          sizeBytes: attachment.sizeBytes,
          width: attachment.width,
          height: attachment.height,
        };
        if (attachment.kind !== 'image') return snapshot;
        try {
          const preview = await loadPreview(attachment);
          if (preview.mimeType !== 'image/png' || !preview.width || !preview.height) {
            return { ...snapshot, previewUnavailable: true };
          }
          return {
            ...snapshot,
            preview: {
              mimeType: 'image/png',
              bytes: Uint8Array.from(preview.bytes),
              width: preview.width,
              height: preview.height,
            },
          };
        } catch {
          return { ...snapshot, previewUnavailable: true };
        }
      }),
    );
    return { ...message, attachments };
  }));
}
