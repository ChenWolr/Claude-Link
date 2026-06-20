// session-store.ts
// 会话与消息状态：sessions 列表、activeSession、messages（持久化历史）、
// streamingContent（流式正文）/ streamingThinking（流式思考）。
//
// 流式状态由 use-chat 的 stream_event 填充，use-stream 防抖后驱动 MessageList 展示。

import { defineStore } from 'pinia';
import type { Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/session';

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as Session[],
    activeSession: null as Session | null,
    messages: [] as Message[],
    streamingContent: '',
    streamingThinking: '',
    sending: false,
    error: null as string | null,
    recentWorkspaces: [] as string[],
    contextStats: null as { inputTokens: number; outputTokens: number; windowSize: number; ratio: number } | null,
  }),
  actions: {
    async loadSessions() {
      try {
        this.sessions = await window.claudeLink.listSessions();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载会话失败';
      }
    },
    async createSession(name: string) {
      try {
        const session = await window.claudeLink.createSession(name);
        this.sessions.unshift(session);
        return session;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '创建会话失败';
        return null;
      }
    },
    async switchSession(session: Session) {
      this.activeSession = session;
      this.streamingContent = '';
      this.messages = [];
      this.contextStats = session.lastContextTokens
        ? { inputTokens: session.lastContextTokens, outputTokens: 0, windowSize: 200000, ratio: session.lastContextTokens / 200000 }
        : null;
      try {
        this.messages = await window.claudeLink.getSessionMessages(session.id);
      } catch {
        // session may have no messages yet
      }
    },
    async deleteSession(id: string) {
      try {
        await window.claudeLink.deleteSession(id);
        this.sessions = this.sessions.filter((s) => s.id !== id);
        if (this.activeSession?.id === id) {
          this.activeSession = null;
          this.messages = [];
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '删除会话失败';
      }
    },
    async searchSessions(query: string) {
      if (!query.trim()) {
        await this.loadSessions();
        return;
      }
      try {
        this.sessions = await window.claudeLink.searchSessions(query);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '搜索会话失败';
        await this.loadSessions();
      }
    },
    async updateActiveSessionModelOverride(modelOverride: string | null) {
      if (!this.activeSession) return;
      try {
        const normalized = modelOverride?.trim() || null;
        const updated = await window.claudeLink.updateModelOverride(this.activeSession.id, normalized);
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '更新会话模型失败';
      }
    },
    // 会话级工作空间：写入 session.workingDir，spawn 时生效；同时记入最近历史便于复用。
    async setActiveSessionWorkingDir(dir: string | null) {
      if (!this.activeSession) return;
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, { workingDir: dir });
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
        if (dir) this.recentWorkspaces = await window.claudeLink.addRecentWorkspace(dir);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '更新工作空间失败';
      }
    },
    // 会话级权限模式：写入 session.permissionMode，spawn 时通过 --permission-mode 生效。
    async setActiveSessionPermissionMode(mode: Session['permissionMode']) {
      if (!this.activeSession) return;
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, { permissionMode: mode });
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '更新权限模式失败';
      }
    },
    async loadRecentWorkspaces() {
      try {
        this.recentWorkspaces = await window.claudeLink.listRecentWorkspaces();
      } catch {
        // 静默：历史为空也能用
      }
    },
    bindContextUpdates() {
      return window.claudeLink.onContextUpdate((payload) => {
        if (this.activeSession?.id !== payload.sessionId) return;
        this.contextStats = {
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          windowSize: payload.windowSize,
          ratio: payload.windowSize > 0 ? payload.inputTokens / payload.windowSize : 0,
        };
      });
    },
    // 会话重命名：写入 session.name。默认名由首句 analyzeTopic 自动生成，此处供用户自定义。
    async renameActiveSession(name: string) {
      if (!this.activeSession) return;
      const trimmed = name.trim();
      if (!trimmed) return;
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, { name: trimmed });
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '重命名失败';
      }
    },
    addMessage(message: Message) {
      this.messages.push(message);

      // Trigger topic analysis for first user message if session name is auto-generated
      if (
        message.role === 'user' &&
        this.messages.filter((m) => m.role === 'user').length === 1 &&
        this.activeSession?.name.startsWith('会话')
      ) {
        const sessionId = this.activeSession.id;
        window.claudeLink.analyzeTopic(sessionId, message.content).then((topic) => {
          if (topic) {
            // Only update if still on the same session
            if (this.activeSession?.id === sessionId) {
              this.activeSession.name = topic;
            }
            this.loadSessions();
          }
        }).catch(() => {
          // Silently ignore topic analysis failures (fallback is applied by main process)
        });
      }
    },
    appendStream(text: string) {
      this.streamingContent += text;
    },
    clearStream() {
      this.streamingContent = '';
    },
    appendThinking(text: string) {
      this.streamingThinking += text;
    },
    clearThinking() {
      this.streamingThinking = '';
    },
    finalizeStream() {
      if (this.streamingContent) {
        this.streamingContent = '';
      }
    },
  },
});
