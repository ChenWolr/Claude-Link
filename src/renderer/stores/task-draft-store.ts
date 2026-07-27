// Task 7B：按会话隔离的【任务队列】草稿 store（文字 + 附件摘要）。
// 与 chat-draft-store 独立——TaskQueuePanel 有自己的 composer，不与主输入争用附件。
// 只保存元数据（AttachmentSummary），不保存 bytes / Blob URL / 文件路径。
// 切换会话不清理旧 key（各会话草稿分别保留）；应用重启从空 state 开始（不持久化）。
import { defineStore } from 'pinia';
import type { AttachmentSummary } from '../../shared/types/attachment';

export const useTaskDraftStore = defineStore('taskDraft', {
  state: () => ({
    textBySession: {} as Record<string, string>,
    attachmentsBySession: {} as Record<string, AttachmentSummary[]>,
  }),
  actions: {
    getText(sessionId: string): string {
      return this.textBySession[sessionId] ?? '';
    },
    setText(sessionId: string, text: string): void {
      this.textBySession[sessionId] = text;
    },
    getAttachments(sessionId: string): AttachmentSummary[] {
      return this.attachmentsBySession[sessionId] ?? [];
    },
    addAttachments(sessionId: string, attachments: AttachmentSummary[]): void {
      const list = this.attachmentsBySession[sessionId] ?? [];
      this.attachmentsBySession[sessionId] = [...list, ...attachments];
    },
    /** 移除任务草稿附件：先调主进程删 draft 记录与物理文件，成功后再从 store 删。失败抛错，保留附件。 */
    async removeAttachment(sessionId: string, attachmentId: string): Promise<void> {
      await window.claudeLink.removeDraftAttachment(sessionId, attachmentId);
      const list = this.attachmentsBySession[sessionId] ?? [];
      this.attachmentsBySession[sessionId] = list.filter((a) => a.id !== attachmentId);
    },
    /** 仅在任务被主进程成功接受后调用：清空当前会话文字与附件草稿。失败路径不调用，保留草稿供重试。 */
    clearAfterAccepted(sessionId: string): void {
      this.textBySession[sessionId] = '';
      this.attachmentsBySession[sessionId] = [];
    },
    getCanSend(sessionId: string): boolean {
      const text = (this.textBySession[sessionId] ?? '').trim();
      const atts = this.attachmentsBySession[sessionId] ?? [];
      return text.length > 0 || atts.length > 0;
    },
  },
});
