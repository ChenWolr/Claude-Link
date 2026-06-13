import { defineStore } from 'pinia';
import type { Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/session';

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as Session[],
    activeSession: null as Session | null,
    messages: [] as Message[],
    streamingContent: '',
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
    addMessage(message: Message) {
      this.messages.push(message);

      // Trigger topic analysis for first user message if session name is auto-generated
      if (
        message.role === 'user' &&
        this.messages.filter((m) => m.role === 'user').length === 1 &&
        this.activeSession?.name.startsWith('会话')
      ) {
        window.claudeLink.analyzeTopic(this.activeSession.id, message.content).then((topic) => {
          if (topic && this.activeSession) {
            this.activeSession.name = topic;
            // Refresh sidebar session list
            this.loadSessions();
          }
        });
      }
    },
    appendStream(text: string) {
      this.streamingContent += text;
    },
    clearStream() {
      this.streamingContent = '';
    },
    finalizeStream() {
      if (this.streamingContent) {
        this.streamingContent = '';
      }
    },
  },
});
