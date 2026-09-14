// 按会话隔离的聊天草稿 store：文字草稿 + 附件草稿摘要。
// 只保存元数据（AttachmentSummary），不保存 bytes / Blob URL / 文件路径。
// 切换会话不清理旧 key（各会话草稿分别保留）；应用重启自然从空 state 开始（不持久化）。
import { defineStore } from 'pinia';
import type { AttachmentSummary } from '../../shared/types/attachment';

export const useChatDraftStore = defineStore('chatDraft', {
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
    // hb13-v B10.2：上限丢弃改「返回被拒摘要」——调用方拿到被拒 ids 弹 notice（ATT-06
    // 「调用方弹 notice」承诺兑现），不再仅 console.warn 静默丢弃。
    addAttachments(sessionId: string, attachments: AttachmentSummary[]): AttachmentSummary[] {
      const list = this.attachmentsBySession[sessionId] ?? [];
      // hb10-ATT-06：暂存即限量——单会话草稿上限 10 个，超出丢弃（调用方弹 notice）。
      const room = Math.max(0, 10 - list.length);
      const rejected = attachments.slice(room);
      if (rejected.length > 0) {
        console.warn('[draft] 附件超出 10 个上限，丢弃 ' + rejected.length + ' 个');
      }
      this.attachmentsBySession[sessionId] = [...list, ...attachments.slice(0, room)];
      return rejected;
    },
    /** 移除草稿附件：先调主进程删 draft 记录与物理文件，成功后再从 store 删。失败抛错，保留附件。 */
    async removeAttachment(sessionId: string, attachmentId: string): Promise<void> {
      await window.claudeLink.removeDraftAttachment(sessionId, attachmentId);
      const list = this.attachmentsBySession[sessionId] ?? [];
      this.attachmentsBySession[sessionId] = list.filter((a) => a.id !== attachmentId);
    },
    /** 仅在发送被主进程成功接受后调用：清空当前会话文字与附件草稿。失败路径不调用，保留草稿供重试。 */
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
