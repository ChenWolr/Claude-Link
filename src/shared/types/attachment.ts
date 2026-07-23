// 会话附件共享类型：主进程 ↔ 渲染进程 ↔ 导出快照共用。
// 本文件只放类型，无运行时逻辑、无 Electron/Node/Vue 副作用，regression 脚本可直接导入。
// 设计依据：docs/superpowers/specs/2026-07-23-chat-attachments-design.md。

/** 附件大类：图片直传模型；文档/源码交给 Claude Code Read；其余为普通文件（同样走 Read）。 */
export type AttachmentKind = 'image' | 'document' | 'file';

/**
 * 附件生命周期状态：
 * - draft：已暂存未发送（草稿），可被移除/清理；
 * - message：已绑定到一条用户消息；
 * - task：已绑定到一个排队任务；
 * - failed：暂存或发送过程中失败（保留记录供排查，不再参与发送）。
 */
export type AttachmentStatus = 'draft' | 'message' | 'task' | 'failed';

/**
 * 附件摘要：renderer 与导出快照唯一持有的附件视图。
 * 不含绝对路径、SHA-256、storageKey 等内部字段，避免泄露文件系统信息。
 */
export interface AttachmentSummary {
  id: string;
  sessionId: string;
  kind: AttachmentKind;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  width?: number;
  height?: number;
  previewAvailable: boolean;
  status: AttachmentStatus;
}

/**
 * 统一发送载荷：普通聊天 / 等待续接 / 排队任务三条路径共用。
 * - text：用户输入文字（trim 后写入 messages.content，附件-only 时为 ''）；
 * - attachmentIds：按显示顺序的草稿附件 ID；
 * - clientMessageId：renderer 乐观消息与主进程数据库消息共用的稳定消息 ID，
 *   不是文件路径，也不改变产品层「text + attachmentIds」语义。
 */
export interface ChatSendPayload {
  text: string;
  attachmentIds: string[];
  clientMessageId: string;
}

/** 主进程受控预览响应：只返回有界缩略图/原图 bytes，绝不返回绝对路径。 */
export interface AttachmentPreviewResponse {
  attachmentId: string;
  mimeType: string;
  bytes: Uint8Array;
  width?: number;
  height?: number;
  isThumbnail: boolean;
}

/** 主进程内部记录：在摘要之上增加存储定位与去重哈希，不暴露给 renderer。 */
export interface AttachmentRecord extends AttachmentSummary {
  sha256: string;
  storageKey: string;
}

/** storage 层写入后的物理文件定位（绝对路径仅在主进程内部流转）。 */
export interface StoredAttachmentFile {
  storageKey: string;
  absolutePath: string;
  sizeBytes: number;
  sha256: string;
}

/** 统一发送 IPC 的返回：数据库消息 ID 与最终附件摘要（状态已置 message/task）。 */
export interface SendMessageResult {
  messageId: string;
  attachments: AttachmentSummary[];
}
