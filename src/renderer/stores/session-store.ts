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
