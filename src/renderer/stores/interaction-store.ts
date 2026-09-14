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
import { useSessionStore } from './session-store';

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
    // hb10-PERM-05：按会话维度的远程 pending 计数（侧栏 badge / 托盘 ⏳ 数据源）。
    pendingRemoteCountBySession(state): Record<string, number> {
      const out: Record<string, number> = {};
      for (const r of state.requests) {
        if (!r.sessionId) continue;
        out[r.sessionId] = (out[r.sessionId] ?? 0) + 1;
      }
      return out;
    },
    // P2-8：当前会话可见的 pending 请求（与 InteractionPrompt.currentRequests 同一谓词）：
    // 本会话远程请求 + 本地 confirm（sessionId='' 全局可见）。他会话的 pending 请求不在此列——
    // diff 弹窗的「让位」判定改用本 getter，避免驻留会话 A 时 B 的后台弹窗静默阻断 A 的弹窗。
    visibleRequestsForActiveSession(state): InteractionPromptPayload[] {
      const sid = useSessionStore().activeSession?.id;
      if (!sid) return state.requests.filter((r) => !r.sessionId);
      return state.requests.filter((r) => !r.sessionId || r.sessionId === sid);
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
    // hb10-PERM-03：30s 对账（仅弹窗可见时轮询）——主进程已不在的（已答复/已取消但回执丢失）
    // 本地移除；主进程有而本地没有的（漏收）补挂。死亡/不可见挂起可自愈。
    // （hb13-v 批C：原注释「IPC 失败时仍移除请求…」描述的是 respondAndRemove 旧行为，
    //  与现实现「失败不移除、请求留队可重试」相反，已删——见 respondAndRemove 处注释。）
    async reconcile(): Promise<void> {
      try {
        const pending = await window.claudeLink.getPendingInteractions();
        const localIds = new Set(this.requests.map((r) => r.id));
        const pendingIds = new Set(pending.map((p) => p.id));
        for (const r of this.requests) {
          if (!this.meta.get(r.id)?.isLocal && !pendingIds.has(r.id)) this.removeRequestData(r.id);
        }
        for (const p of pending) {
          if (!localIds.has(p.id)) {
            this.requests.push(p);
            this.meta.set(p.id, { isLocal: false });
          }
        }
      } catch {
        // IPC 失败：下一轮再对账。
      }
    },
    async respondAndRemove(response: InteractionPromptResponsePayload): Promise<void> {
      const meta = this.meta.get(response.id);
      if (meta?.isLocal && meta.resolver) {
        meta.resolver(response);
        this.removeRequestData(response.id);
        return;
      }
      // hb10-PERM-03：IPC 失败时不本地移除——请求可能仍可作答，留队由 30s 对账/用户重试收口
      //（原 finally 无条件移除会把 IPC 失败变成「静默丢答案」，主进程仍挂起等回复）。
      await window.claudeLink.respondInteraction(response);
      this.removeRequestData(response.id);
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
      // 只清本地请求，远程请求由主进程管理：窗口关闭时 requestInteraction 内的 mainWindow 'closed'
      // 监听将各 pending promise 以 cancel/abort resolve；会话删除/硬杀才走 cancelInteractionsForSession。
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
