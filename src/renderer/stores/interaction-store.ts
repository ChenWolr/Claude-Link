// interaction-store.ts
// V3-2：统一交互队列（Pinia）。把主进程 IPC 来的交互请求（权限/AskUserQuestion）
// 与渲染进程本地的 confirm 请求纳入同一队列，由 InteractionPrompt 统一展示。
//
// 两条请求来源：
//   - 远程（IPC）：enqueueRemote，响应走 window.claudeLink.respondInteraction
//   - 本地（confirm）：enqueueLocal，响应走 Promise resolve（不经 IPC）
// store 根据 meta.isLocal 路由响应，InteractionPrompt 只管 UI。

import { defineStore } from 'pinia';
import type { InteractionPromptPayload, InteractionPromptResponsePayload } from '../../shared/types/ipc';

interface RequestMeta {
  isLocal: boolean;
  resolver?: (r: InteractionPromptResponsePayload) => void;
}

export const useInteractionStore = defineStore('interaction', {
  state: () => ({
    requests: [] as InteractionPromptPayload[],
    meta: new Map<string, RequestMeta>(),
  }),
  getters: {
    activeRequest(state): InteractionPromptPayload | null {
      return state.requests[0] ?? null;
    },
  },
  actions: {
    // 主进程 IPC 来的请求入队（去重）。返回 true 表示真正入队，false 表示去重跳过。
    // 调用方据此决定是否初始化 UI 选择态，避免二次入队重置用户正在填的表单。
    enqueueRemote(payload: InteractionPromptPayload): boolean {
      if (this.requests.some((r) => r.id === payload.id)) return false;
      this.requests.push(payload);
      this.meta.set(payload.id, { isLocal: false });
      return true;
    },
    // 渲染进程本地请求入队，返回 Promise，用户响应时 resolve。
    enqueueLocal(payload: InteractionPromptPayload): Promise<InteractionPromptResponsePayload> {
      return new Promise((resolve) => {
        this.requests.push(payload);
        this.meta.set(payload.id, { isLocal: true, resolver: resolve });
      });
    },
    // 用户响应：本地请求 resolve Promise，远程请求走 IPC；然后移除该请求。
    // IPC 失败时仍移除请求并向上抛错，让 InteractionPrompt 的 try/finally 复位 submittingId，
    // 避免用户点提交无反应且无法重试。
    async respondAndRemove(response: InteractionPromptResponsePayload): Promise<void> {
      const meta = this.meta.get(response.id);
      try {
        if (meta?.isLocal && meta.resolver) {
          meta.resolver(response);
        } else {
          await window.claudeLink.respondInteraction(response);
        }
      } finally {
        // 无论 IPC 成功与否都移除请求，避免失败时请求留队导致 UI 卡死。
        this.removeRequestData(response.id);
      }
    },
    // 移除请求（abort/会话删除/取消/组件卸载）。本地请求 resolve cancel，避免 Promise 永挂。
    removeRequest(id: string): void {
      const meta = this.meta.get(id);
      if (meta?.isLocal && meta.resolver) {
        meta.resolver({ id, action: 'cancel' });
      }
      this.removeRequestData(id);
    },
    // 清理所有 pending 本地请求（组件卸载时调用，防止 Promise 永挂）。
    cleanupLocalRequests(): void {
      for (const [id, meta] of this.meta) {
        if (meta.isLocal && meta.resolver) {
          meta.resolver({ id, action: 'cancel' });
        }
      }
      // 只清本地请求，远程请求由主进程管理（窗口关闭时主进程会 cancelInteractionsForSession）
      this.requests = this.requests.filter((r) => !this.meta.get(r.id)?.isLocal);
      for (const [id, meta] of this.meta) {
        if (meta.isLocal) this.meta.delete(id);
      }
    },
    // 仅移除数据（内部用，不 resolve）。
    removeRequestData(id: string): void {
      this.requests = this.requests.filter((r) => r.id !== id);
      this.meta.delete(id);
    },
    // V3-2：渲染进程内 confirm（替代 ConfirmDialog.vue）。
    // 走 InteractionPrompt 的 kind:'confirm'，不经主进程 IPC。
    async requestConfirm(opts: {
      title?: string;
      message: string;
      confirmText?: string;
      cancelText?: string;
      danger?: boolean;
      mode?: 'confirm' | 'alert';
    }): Promise<boolean> {
      const id = `local-confirm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const confirmOption = {
        id: 'confirm',
        label: opts.confirmText ?? '确定',
        primary: !opts.danger,
        danger: opts.danger,
      };
      const options = opts.mode === 'alert'
        ? [confirmOption]
        : [{ id: 'cancel', label: opts.cancelText ?? '取消' }, confirmOption];
      const payload: InteractionPromptPayload = {
        id,
        sessionId: '',
        kind: 'confirm',
        title: opts.title ?? '确认操作',
        description: opts.message,
        options,
      };
      const response = await this.enqueueLocal(payload);
      return response.action === 'submit' && response.selectedOptionIds?.includes('confirm') === true;
    },
  },
});
