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
    // 搜索视图态：null 表示无搜索（显示全量 sessions），非 null 表示显示搜索结果。
    // 避免 searchSessions 直接覆盖 sessions 而污染会话管理页/侧栏等全局列表。
    searchResults: null as Session[] | null,
    // 当前搜索词，供 UI 同步空态判断。
    searchQuery: '' as string,
    activeSession: null as Session | null,
    messages: [] as Message[],
    streamingContent: '',
    streamingThinking: '',
    streamingTool: '',
    sending: false,
    error: null as string | null,
    recentWorkspaces: [] as string[],
    // 右侧任务栏当前 Tab：'queue'（排队任务）/ 'subagent'（子Agent）。
    rightTab: 'queue' as 'queue' | 'subagent',
    // 主流程锚点点击后要定位的子 agent（按 parentAgentId），子Agent 面板据此滚动高亮。
    focusedSubAgentId: null as string | null,
    // 力度② turn 边界：当前发送回合在 messages 中的起始索引。MessageList 据此在发送中
    // 隐藏本回合已落库的 text/thinking（与流式块去重），回合结束/会话切换时复位。
    turnStartIndex: 0,
    contextStats: null as { inputTokens: number; outputTokens: number; windowSize: number; ratio: number } | null,
    // 问题 4：CC 自动压缩事件标记。收到 compactedJustNow:true 的 CONTEXT_UPDATE 时置 true，
    // ContextButton 据此弹短暂横幅回显。横幅显示后由 ContextButton 自行复位为 false。
    compactedJustNow: false as boolean,
  }),
  getters: {
    // 当前应展示的会话列表：搜索态下返回 searchResults，否则返回全量 sessions。
    displayedSessions(state): Session[] {
      return state.searchResults ?? state.sessions;
    },
  },
  actions: {
    async loadSessions() {
      try {
        this.sessions = await window.claudeLink.listSessions();
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载会话失败';
      }
      // 重新加载意味着退出搜索态，清空搜索视图。
      this.searchResults = null;
      this.searchQuery = '';
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
      // M2：切换会话必须重置所有发送/流式/错误状态，否则会话 B 会被会话 A 的
      // sending(输入框锁死)/streaming/error 残留污染。
      this.streamingContent = '';
      this.streamingThinking = '';
      this.streamingTool = '';
      this.sending = false;
      this.error = null;
      this.messages = [];
      this.turnStartIndex = 0;
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
        // 搜索态下同步移除，保持搜索列表一致。
        if (this.searchResults) {
          this.searchResults = this.searchResults.filter((s) => s.id !== id);
        }
        if (this.activeSession?.id === id) {
          this.activeSession = null;
          this.messages = [];
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '删除会话失败';
      }
    },
    async searchSessions(query: string) {
      const q = query.trim();
      if (!q) {
        // 空查询退出搜索态，全量列表已在 sessions 里，无需 IPC。
        this.searchResults = null;
        this.searchQuery = '';
        return;
      }
      this.searchQuery = q;
      try {
        this.searchResults = await window.claudeLink.searchSessions(q);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '搜索会话失败';
        // 异常回退全量列表。
        this.searchResults = null;
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
    appendToolStream(text: string) {
      this.streamingTool += text;
    },
    clearToolStream() {
      this.streamingTool = '';
    },
    // 切换右侧任务栏 Tab。
    setRightTab(tab: 'queue' | 'subagent') {
      this.rightTab = tab;
    },
    // 主流程子 Agent 锚点点击：切到子Agent Tab 并标记要定位的 parentAgentId。
    focusSubAgent(parentAgentId: string) {
      this.rightTab = 'subagent';
      this.focusedSubAgentId = parentAgentId;
    },
    clearFocusedSubAgent() {
      this.focusedSubAgentId = null;
    },
    finalizeStream() {
      if (this.streamingContent) {
        this.streamingContent = '';
      }
    },
  },
});
