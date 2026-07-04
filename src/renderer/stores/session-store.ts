// session-store.ts
// 会话与消息状态：sessions 列表、activeSession、messages（持久化历史）、
// streamingContent（流式正文）/ streamingThinking（流式思考）。
//
// 流式状态由 use-chat 的 stream_event 填充，use-stream 防抖后驱动 MessageList 展示。

import { defineStore } from 'pinia';
import type { Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/session';
import type { StallInfo } from '../../shared/stall-watchdog';
import { resolveContextWindow } from '../../shared/model-context-windows';
import { useConfigStore } from './config-store';

// C：后台任务（task_*），按 taskId。瞬态，task_notification 终态后移除。
export interface BackgroundTask {
  taskId: string;
  toolUseId?: string;
  description?: string;
  taskType?: string;
  status?: string;
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  lastToolName?: string;
  summary?: string;
}

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
    // sending 改为 getter（从 runningSessions 派生），这里不再存 state。
    // 保留这个字段名是为了向后兼容（其他地方读 store.sending），但它是 getter 不是 state。
    error: null as string | null,
    // 根因修复：per-session 执行状态隔离。监听全局化后，ChatPage 卸载不影响执行。
    runningSessions: [] as string[],
    // per-session 流式快照。切换会话时保存当前流式内容到快照，切回时恢复。
    sessionStreams: {} as Record<string, { content: string; thinking: string; tool: string }>,
    recentWorkspaces: [] as string[],
    // 右侧任务栏当前 Tab：'queue'（排队任务）/ 'subagent'（子Agent）。
    rightTab: 'queue' as 'queue' | 'subagent' | 'background',
    // 主流程锚点点击后要定位的子 agent（按 parentAgentId），子Agent 面板据此滚动高亮。
    focusedSubAgentId: null as string | null,
    // 力度② turn 边界：当前发送回合在 messages 中的起始索引。MessageList 据此在发送中
    // 隐藏本回合已落库的 text/thinking（与流式块去重），回合结束/会话切换时复位。
    turnStartIndex: 0,
    contextStats: null as { inputTokens: number; outputTokens: number; windowSize: number; ratio: number } | null,
    // 问题 4：CC 自动压缩事件标记。收到 compactedJustNow:true 的 CONTEXT_UPDATE 时置 true，
    // ContextButton 据此弹短暂横幅回显。横幅显示后由 ContextButton 自行复位为 false。
    compactedJustNow: false as boolean,
    // C：工具运行实时耗时（tool_progress），按 toolUseId。瞬态，回合结束清。
    toolProgress: {} as Record<string, number>,
    // C：后台任务编排（task_*），按 taskId。task_notification 终态后移除。
    backgroundTasks: {} as Record<string, BackgroundTask>,
    // C：实时压缩进行中（status:compacting）。compact_boundary 复位为 false。
    compacting: false as boolean,
    // 问题 2：本回合开始时间戳（按 sessionId）。markRunning 置位、markStopped 清除。
    // 渲染层据此 + useNow 跳动时钟算实时耗时，整个 sending 期间常驻显示「⏱ X.Xs」。
    turnStartedAt: {} as Record<string, number>,
    // 卡死检测：per-session 卡死信息（主进程看门狗 stalled 事件下发）。getter activeStalledInfo 读当前会话。
    stalledInfo: {} as Record<string, StallInfo>,
    // Bug4/Bug5：per-session API 重试瞬态（api_retry 事件下发，不再落库）。attempt 为本回合累计计数
    //（每条 api_retry 自增，真实业务事件清零），由 ApiRetryBanner 显示「API 重试中（第 N 次）」。
    apiRetryInfo: {} as Record<string, { attempt: number; max?: number; error?: string }>,
    // Bug2：per-session 子 agent 实时思考快照（stream_event thinking_delta 按 parentToolUseId 路由）。
    // 外层 key=sessionId，内层 key=parentAgentId → 累积思考文本。子 Agent Tab 据此在思考中显示
    // ThinkingBlock；该子 agent 的 message 到达（完整思考落库）或回合结束时清除，避免与落库重复。
    subAgentStreamingThinking: {} as Record<string, Record<string, string>>,
  }),
  getters: {
    // 当前应展示的会话列表：搜索态下返回 searchResults，否则返回全量 sessions。
    displayedSessions(state): Session[] {
      return state.searchResults ?? state.sessions;
    },
    // 根因修复：sending 从 runningSessions 派生，不再依赖组件 local ref。
    // ChatPage 卸载/重挂载不影响——只要 activeSession 在 runningSessions 里就是 true。
    sending(state): boolean {
      return !!state.activeSession && state.runningSessions.includes(state.activeSession.id);
    },
    // 问题 2：当前活动会话的本回合开始时间戳（无则 null）。MessageList 实时计时器据此算耗时。
    activeTurnStartedAt(state): number | null {
      if (!state.activeSession) return null;
      return state.turnStartedAt[state.activeSession.id] ?? null;
    },
    // 当前活动会话的卡死信息（无则 null）。StalledBanner 据此显隐。
    activeStalledInfo(state): StallInfo | null {
      if (!state.activeSession) return null;
      return state.stalledInfo[state.activeSession.id] ?? null;
    },
    // Bug4/Bug5：当前活动会话的 API 重试瞬态（无则 null）。ApiRetryBanner 据此显隐。
    activeApiRetryInfo(state): { attempt: number; max?: number; error?: string } | null {
      if (!state.activeSession) return null;
      return state.apiRetryInfo[state.activeSession.id] ?? null;
    },
    // Bug2：当前活动会话的子 agent 实时思考映射（agentId → 文本）。TaskQueuePanel 据此显 ThinkingBlock。
    activeSubAgentThinking(state): Record<string, string> {
      if (!state.activeSession) return {};
      return state.subAgentStreamingThinking[state.activeSession.id] ?? {};
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
      // 问题 1：切换会话不再清空一切。保存当前会话的流式快照，恢复目标会话的快照。
      // sending 不再无条件 false，而是根据目标会话是否在 runningSessions 中决定。
      const oldId = this.activeSession?.id;
      if (oldId && oldId !== session.id) {
        this.sessionStreams[oldId] = {
          content: this.streamingContent,
          thinking: this.streamingThinking,
          tool: this.streamingTool,
        };
      }
      this.activeSession = session;
      // 恢复目标会话的流式快照（如果有），否则清空
      const snapshot = this.sessionStreams[session.id];
      if (snapshot) {
        this.streamingContent = snapshot.content;
        this.streamingThinking = snapshot.thinking;
        this.streamingTool = snapshot.tool;
      } else {
        this.streamingContent = '';
        this.streamingThinking = '';
        this.streamingTool = '';
      }
      // sending 现在是 getter（从 runningSessions 派生），无需手动设。
      // switchSession 恢复流式快照 + 从 DB 重载 messages 即可。
      this.error = null;
      this.messages = [];
      this.turnStartIndex = 0;
      // 问题 4：切换会话时复位自动压缩横幅标记，避免会话 A 的横幅串扰到会话 B。
      this.compactedJustNow = false;
      // C：切换会话清理瞬态进度状态，避免会话 A 的工具耗时/后台任务/压缩态串扰到会话 B。
      this.toolProgress = {};
      this.backgroundTasks = {};
      this.compacting = false;
      // 上下文窗口 fallback 链：优先该会话持久化的真实窗口（连通后缓存），其次按当前模型
      // 查内置表（解决未连接时 1M 模型被当成 200k），再次用户全局覆盖，最后 200k。
      const windowSize = resolveContextWindow({
        lastContextWindow: session.lastContextWindow,
        alias: session.modelOverride || session.model,
        contextWindowByAlias: useConfigStore().config.contextWindowByAlias,
      });
      this.contextStats = session.lastContextTokens
        ? { inputTokens: session.lastContextTokens, outputTokens: 0, windowSize, ratio: windowSize > 0 ? session.lastContextTokens / windowSize : 0 }
        : null;
      try {
        this.messages = await window.claudeLink.getSessionMessages(session.id);
        // 运行中会话切回时，不能把 turnStartIndex 固定成 0；否则 MessageList 会把全量历史
        // 都当成本回合流式重复内容隐藏，造成「主过程/思考消失但计时还在跳」。
        if (this.runningSessions.includes(session.id)) {
          const lastUserIndex = (() => {
            for (let i = this.messages.length - 1; i >= 0; i -= 1) {
              if (this.messages[i].role === 'user') return i;
            }
            return -1;
          })();
          this.turnStartIndex = lastUserIndex >= 0 ? lastUserIndex + 1 : this.messages.length;
        }
      } catch {
        // session may have no messages yet
      }
    },
    async deleteSession(id: string) {
      // 乐观更新：先从 UI 移除（列表/搜索态/activeSession/执行状态），让会话瞬间从侧栏消失，
      // 避免「confirm 弹窗已消失但列表刷新滞后」致用户反复点删除触发新 confirm。IPC 失败时回滚。
      const prevSessions = this.sessions;
      const prevSearch = this.searchResults;
      const prevActive = this.activeSession;
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.searchResults) {
        this.searchResults = this.searchResults.filter((s) => s.id !== id);
      }
      if (this.activeSession?.id === id) {
        this.activeSession = null;
        this.messages = [];
      }
      // 问题 1：清理已删会话的执行状态与流式快照
      this.runningSessions = this.runningSessions.filter((sid) => sid !== id);
      delete this.sessionStreams[id];
      delete this.stalledInfo[id];
      delete this.apiRetryInfo[id];
      delete this.subAgentStreamingThinking[id];
      try {
        await window.claudeLink.deleteSession(id);
      } catch (error) {
        // IPC 失败回滚——恢复列表与活动会话
        this.sessions = prevSessions;
        this.searchResults = prevSearch;
        this.activeSession = prevActive;
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
        // 上下文窗口经 resolveContextWindow 过滤：用户按别名设置优先（「以设置为准」），
        // 否则用 SDK 上报的真实窗口（payload.windowSize）。避免 SDK 误报 200k 覆盖用户设置的 1M。
        const alias = this.activeSession.modelOverride || this.activeSession.model;
        const windowSize = resolveContextWindow({
          lastContextWindow: payload.windowSize,
          alias,
          contextWindowByAlias: useConfigStore().config.contextWindowByAlias,
        });
        this.contextStats = {
          inputTokens: payload.inputTokens,
          outputTokens: payload.outputTokens,
          windowSize,
          ratio: windowSize > 0 ? payload.inputTokens / windowSize : 0,
        };
        // 问题 4：CC 自动压缩事件 → 置标记，ContextButton 弹横幅回显。
        if (payload.compactedJustNow) {
          this.compactedJustNow = true;
          this.compacting = false; // C：压缩完成，复位实时态
        }
      });
    },
    // 问题 4：ContextButton 横幅显示完毕后调用，复位标记以便下次压缩可再次触发。
    clearCompactedJustNow() {
      this.compactedJustNow = false;
    },
    // 根因修复：标记会话为执行中。sendMessage 时调用。
    // sending 是 getter（从 runningSessions 派生），无需手动设 this.sending。
    markRunning(sessionId: string) {
      if (!this.runningSessions.includes(sessionId)) {
        this.runningSessions.push(sessionId);
        // 问题 2：记录本回合开始时间（仅新加入时置位，避免重复 send 覆盖）。
        this.turnStartedAt[sessionId] = Date.now();
      }
    },
    // 根因修复：标记会话执行结束。result/error/aborted 时调用。
    markStopped(sessionId: string) {
      this.runningSessions = this.runningSessions.filter((sid) => sid !== sessionId);
      // 清理该会话的流式快照（执行结束，快照不再需要）
      delete this.sessionStreams[sessionId];
      // 问题 2：清理本回合开始时间戳（执行结束，计时器随之隐藏）。
      delete this.turnStartedAt[sessionId];
      // 卡死横幅随回合结束消失。
      delete this.stalledInfo[sessionId];
      // API 重试指示器随回合结束消失。
      delete this.apiRetryInfo[sessionId];
      // 子 agent 实时思考快照随回合结束清除。
      delete this.subAgentStreamingThinking[sessionId];
    },
    // 问题 1：向非当前会话的流式快照追加内容（后台执行时累积流式，切回时恢复）。
    appendBackgroundStream(sessionId: string, type: 'content' | 'thinking' | 'tool', text: string) {
      if (!this.sessionStreams[sessionId]) {
        this.sessionStreams[sessionId] = { content: '', thinking: '', tool: '' };
      }
      this.sessionStreams[sessionId][type] += text;
    },
    // 问题 1：清空非当前会话的流式快照（result/error/aborted 时）。
    clearBackgroundStream(sessionId: string) {
      delete this.sessionStreams[sessionId];
    },
    // 卡死检测：主进程 stalled 事件 → 记录；用户「继续等待」/重试/中断 → 清除。
    markStalled(sessionId: string, info: StallInfo) {
      this.stalledInfo[sessionId] = info;
    },
    clearStalled(sessionId: string) {
      delete this.stalledInfo[sessionId];
    },
    // Bug4/Bug5：记录一次 api_retry（attempt 本回合累计自增），供 ApiRetryBanner 原地递增显示「第 N 次」。
    markApiRetrying(sessionId: string, info: { max?: number; error?: string }) {
      const prev = this.apiRetryInfo[sessionId];
      this.apiRetryInfo[sessionId] = {
        attempt: prev ? prev.attempt + 1 : 1,
        max: info.max,
        error: info.error,
      };
    },
    clearApiRetrying(sessionId: string) {
      delete this.apiRetryInfo[sessionId];
    },
    // Bug2：累加某子 agent 的实时思考（thinking_delta 按 parentToolUseId 路由进来）。
    appendSubAgentThinking(sessionId: string, agentId: string, text: string) {
      if (!this.subAgentStreamingThinking[sessionId]) this.subAgentStreamingThinking[sessionId] = {};
      this.subAgentStreamingThinking[sessionId][agentId] =
        (this.subAgentStreamingThinking[sessionId][agentId] ?? '') + text;
    },
    // Bug2：清除子 agent 实时思考——传 agentId 清单个（其 message 已落库，完整思考接管）；
    // 不传则清该会话全部（回合结束）。
    clearSubAgentThinking(sessionId: string, agentId?: string) {
      if (!this.subAgentStreamingThinking[sessionId]) return;
      if (agentId) delete this.subAgentStreamingThinking[sessionId][agentId];
      else delete this.subAgentStreamingThinking[sessionId];
    },
    // 根因修复：ChatPage 重挂载（路由跳转回来）时重拉 messages + 同步状态。
    // 不重新注册监听（监听已在 App.vue 全局注册），只刷新当前会话数据。
    async refreshActiveSession() {
      if (!this.activeSession) return;
      try {
        this.messages = await window.claudeLink.getSessionMessages(this.activeSession.id);
      } catch {
        // session may have no messages yet
      }
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
    // C：工具运行进度（tool_progress）。
    setToolProgress(toolUseId: string, seconds: number) {
      this.toolProgress[toolUseId] = seconds;
    },
    clearToolProgress(toolUseId: string) {
      delete this.toolProgress[toolUseId];
    },
    // C：后台任务（task_*）。
    upsertBackgroundTask(task: BackgroundTask) {
      this.backgroundTasks[task.taskId] = task;
    },
    removeBackgroundTask(taskId: string) {
      delete this.backgroundTasks[taskId];
    },
    // C：实时压缩态。
    setCompacting(v: boolean) {
      this.compacting = v;
    },
    // 切换右侧任务栏 Tab。
    setRightTab(tab: 'queue' | 'subagent' | 'background') {
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
