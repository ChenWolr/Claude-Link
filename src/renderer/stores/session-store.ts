// session-store.ts
// 会话与消息状态：sessions 列表、activeSession、messages（持久化历史）、
// streamingContent（流式正文）/ streamingThinking（流式思考）。
//
// 流式状态由 use-chat 的 stream_event 填充，use-stream 防抖后驱动 MessageList 展示。

import { defineStore } from 'pinia';
import type { Session } from '../../shared/types/session';
import type { Message } from '../../shared/types/session';
import type { ThinkingLevel } from '../../shared/types/thinking';
import type { StallInfo } from '../../shared/stall-watchdog';
import type { ApiRetryTerminalDetailsV1, ApiRetryTerminalKind } from '../../shared/api-retry-state';
import {
  resolveSessionDisplayStatus,
  type SessionDisplayStatus,
  type SessionStatus,
} from '../../shared/session-display-status';
import { resolveContextWindow } from '../../shared/model-context-windows';
import { useConfigStore } from './config-store';
import { useClaudePlanStore } from './claude-plan-store';
import { useCommandStore } from './command-store';

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

export interface ApiRetryInfo {
  retryCount: number;
  retryLimit: number;
  nextRetryAt?: number;
  retryDelayMs?: number;
  errorStatus?: number | null;
  error?: string;
  stopping: boolean;
}

interface ApiRetryTerminalFallback {
  kind: ApiRetryTerminalKind;
  summary: string;
  details: ApiRetryTerminalDetailsV1;
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
    // 右侧活动栏筛选：'all'（默认，四类总览同屏）/ 'queue' / 'subagent' / 'background' / 'changes'。
    // 演进自旧 rightTab 互斥 Tab——保留字段名与 'changes'/'background' 等字面量，仅新增 'all' 默认。
    rightTab: 'all' as 'all' | 'plan' | 'queue' | 'subagent' | 'background' | 'changes',
    // 活动总览折叠态：true=只留 rail 图标轨、隐藏主体内容（rail 底部双箭头按钮切换）。
    overviewCollapsed: false,
    // 主流程锚点点击后要定位的子 agent（按 parentAgentId），子Agent 面板据此滚动高亮。
    focusedSubAgentId: null as string | null,
    // 力度② turn 边界：当前发送回合在 messages 中的起始索引。MessageList 据此在发送中
    // 隐藏本回合已落库的 text/thinking（与流式块去重），回合结束/会话切换时复位。
    turnStartIndex: 0,
    // 真实上下文用量（来自 SDK usage）。windowSize/ratio 不在此存，改由 contextStats getter
    // 派生——使切换模型（modelOverride）或改设置（contextWindowByAlias）时即时重算，
    // 无需等下一回合 CONTEXT_UPDATE。修复「切了模型上下文窗口不刷新」。
    contextUsage: null as { inputTokens: number; outputTokens: number } | null,
    // 当前活动会话最近一次 SDK 上报的真实窗口（作 resolveContextWindow 的 lastContextWindow）。
    // 切会话时从 session.lastContextWindow 初始化，收 usage 回调时用 payload.windowSize 覆盖。
    contextLastWindow: null as number | null,
    // 问题 4：CC 自动压缩事件标记。收到 compactedJustNow:true 的 CONTEXT_UPDATE 时置 true，
    // ContextButton 据此弹短暂横幅回显。横幅显示后由 ContextButton 自行复位为 false。
    compactedJustNow: false as boolean,
    // C：工具运行实时耗时（tool_progress），按 toolUseId。瞬态，回合结束清。
    toolProgress: {} as Record<string, number>,
    // C：后台任务编排（task_*），按 taskId。task_notification 终态后移除。
    backgroundTasks: {} as Record<string, BackgroundTask>,
    // C：实时压缩进行中（status:compacting）。compact_boundary 复位为 false。
    compacting: false as boolean,
    // 批次 B：当前会话思考 token 实时估算（thinking_tokens.estimated_tokens）。全局瞬态字段，
    // 切会话/回合结束清零；ContextButton hover 展示。null=无（未在思考或回合已结束）。
    thinkingTokens: null as number | null,
    // 问题 2：本回合开始时间戳（按 sessionId）。markRunning 置位、markStopped 清除。
    // 渲染层据此 + useNow 跳动时钟算实时耗时，整个 sending 期间常驻显示「⏱ X.Xs」。
    turnStartedAt: {} as Record<string, number>,
    // v2-F3：回合 generation（按 sessionId）。每次 markRunning（新回合开始）递增；
    // use-chat 的 abort finally 兜底捕获发起中断时的 generation，到点若已开启新回合
    //（generation 变化）则 no-op，绝不误停随后启动的新回合。deleteSession 一并清理。
    turnGeneration: {} as Record<string, number>,
    // 卡死检测：per-session 卡死信息（主进程看门狗 stalled 事件下发）。getter activeStalledInfo 读当前会话。
    stalledInfo: {} as Record<string, StallInfo>,
    // per-session API 重试瞬态：直接投影主进程下发的权威 count/limit，不在 renderer 自行累计。
    apiRetryInfo: {} as Record<string, ApiRetryInfo>,
    // 主进程终态消息落库失败时的运行期兜底；新回合、删除会话或显式关闭时清理。
    apiRetryTerminalFallback: {} as Record<string, ApiRetryTerminalFallback>,
    // Bug2：per-session 子 agent 实时思考快照（stream_event thinking_delta 按 parentToolUseId 路由）。
    // 外层 key=sessionId，内层 key=parentAgentId → 累积思考文本。子 Agent Tab 据此在思考中显示
    // ThinkingBlock；该子 agent 的 message 到达（完整思考落库）或回合结束时清除，避免与落库重复。
    subAgentStreamingThinking: {} as Record<string, Record<string, string>>,
    // 会话侧栏状态灯基础终态：'running'（闪烁黄灯）| 'completed'（静态绿灯）|
    // 'network_interrupted'（静态红灯，retry 真正耗尽）。按 sessionId。
    // 未出现在映射中的会话为 idle（无状态点）——已有会话首次加载不会错误亮灯。
    // 只保留内存态是有意设计：绿灯/常红表示「本次应用运行期间最近一次成功完成/网络中断」，
    // 不把旧历史误显示为本次启动后的完成（跨重启保留需另开数据库字段/迁移）。
    // retrying（红闪）不写入 sessionStatus：apiRetryInfo 是 retry 瞬态的唯一真相源，
    // 侧栏展示由 sessionDisplayStatus getter 统一解析两者。
    sessionStatus: {} as Record<string, SessionStatus>,
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
    // 当前活动会话的 API 重试瞬态（无则 null）。ApiRetryBanner 据此显隐。
    activeApiRetryInfo(state): ApiRetryInfo | null {
      if (!state.activeSession) return null;
      return state.apiRetryInfo[state.activeSession.id] ?? null;
    },
    // 侧栏展示状态：统一解析基础终态（sessionStatus）+ retry 瞬态（apiRetryInfo），
    // 按固定优先级 completed > network_interrupted > retrying > running > idle。
    // 侧栏只能通过这个统一入口解析状态，避免模板分别拼基础状态和 retry 瞬态。
    sessionDisplayStatus(state) {
      return (sessionId: string): SessionDisplayStatus =>
        resolveSessionDisplayStatus(state.sessionStatus[sessionId], Boolean(state.apiRetryInfo[sessionId]));
    },
    activeApiRetryTerminalFallback(state): ApiRetryTerminalFallback | null {
      if (!state.activeSession) return null;
      return state.apiRetryTerminalFallback[state.activeSession.id] ?? null;
    },
    // Bug2：当前活动会话的子 agent 实时思考映射（agentId → 文本）。TaskQueuePanel 据此显 ThinkingBlock。
    activeSubAgentThinking(state): Record<string, string> {
      if (!state.activeSession) return {};
      return state.subAgentStreamingThinking[state.activeSession.id] ?? {};
    },
    // 上下文统计：windowSize/ratio 派生而非写入。依赖 activeSession.modelOverride/model +
    // contextLastWindow + configStore.contextWindowByAlias，任一变化即时重算。
    // 原先 contextStats 是切会话/收 usage 回调时写入的快照，切模型不触发重算，要等下一回合
    // CONTEXT_UPDATE 才刷新——此 getter 从根上消除该滞后。
    contextStats(state): { inputTokens: number; outputTokens: number; windowSize: number; ratio: number } | null {
      if (!state.activeSession) return null;
      const alias = state.activeSession.modelOverride || state.activeSession.model;
      const windowSize = resolveContextWindow({
        lastContextWindow: state.contextLastWindow,
        alias,
        contextWindowByAlias: useConfigStore().config.contextWindowByAlias,
      });
      const inputTokens = state.contextUsage?.inputTokens ?? 0;
      const outputTokens = state.contextUsage?.outputTokens ?? 0;
      return { inputTokens, outputTokens, windowSize, ratio: windowSize > 0 ? inputTokens / windowSize : 0 };
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
        // Task 5：新会话创建后拉取命令快照初始态（loading）；主进程 probe 经 COMMANDS_CHANGED 推完整列表。
        void useCommandStore().load(session.id);
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
      // N4：切到已有会话（应用重启后 registry 为空）时触发命令快照加载；主进程 COMMANDS_GET
      // 对无快照会话会异步启动探测。
      void useCommandStore().load(session.id);
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
      // 批次 B：清思考 token 估算，避免会话 A 的思考峰值串扰到会话 B 的 ContextButton。
      this.thinkingTokens = null;
      // 真实用量 + 上次连通的真实窗口交给 state；windowSize/ratio 由 contextStats getter 派生，
      // 切模型/改设置时即时重算。lastContextWindow 为该会话持久化的 SDK 真实窗口（连通后缓存）。
      this.contextLastWindow = session.lastContextWindow;
      this.contextUsage = session.lastContextTokens
        ? { inputTokens: session.lastContextTokens, outputTokens: 0 }
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
      const prevMessages = this.messages;
      this.sessions = this.sessions.filter((s) => s.id !== id);
      if (this.searchResults) {
        this.searchResults = this.searchResults.filter((s) => s.id !== id);
      }
      if (this.activeSession?.id === id) {
        this.activeSession = null;
        this.messages = [];
      }
      // 问题 1：清理已删会话的执行状态与流式快照。
      // v2-F1：删除前仅快照「静态、仍真实」的展示终态（completed/network_interrupted 及
      // 对应 fallback）。主进程 SESSION_DELETE 在 DB DELETE 前已不可逆地 cleanupQueue /
      // markSessionDeleted / killProcess 终止 query/queue/retry——运行中/重试中/流式/计时
      // 等活状态已不存在于主进程，失败回滚不得恢复（否则形成幽灵运行态）。
      const prevSessionStatus = this.sessionStatus[id];
      const prevFallback = this.apiRetryTerminalFallback[id];
      this.runningSessions = this.runningSessions.filter((sid) => sid !== id);
      delete this.sessionStreams[id];
      delete this.stalledInfo[id];
      delete this.apiRetryInfo[id];
      delete this.apiRetryTerminalFallback[id];
      delete this.subAgentStreamingThinking[id];
      // 原生 Slash Commands：清理命令快照（与 UI 同步移除；失败回滚不恢复——主进程 markSessionDeleted
      // 已清 registry，切回该会话时 load 重建）。
      useCommandStore().clear(id);
      // 状态灯与回合计时随会话删除一并清理，避免迟到的完成态串到其它会话。
      delete this.sessionStatus[id];
      delete this.turnStartedAt[id];
      delete this.turnGeneration[id];
      // 清理 Claude 计划状态（独立于手动排队 tasks 表）。
      const planStore = useClaudePlanStore();
      const prevPlan = planStore.planBySession[id];
      planStore.clearSession(id);
      try {
        await window.claudeLink.deleteSession(id);
      } catch (error) {
        // IPC 失败回滚——只恢复静态、仍然真实的状态：列表/搜索/活动会话与其消息、
        // plan、completed/network_interrupted 终态（及常红对应 fallback）。
        // 活状态（runningSessions、sessionStatus='running'、apiRetryInfo、sessionStreams、
        // turnStartedAt、stalledInfo、subAgentStreamingThinking）一律不恢复——主进程已
        // 不可逆终止对应 query，恢复只会显示不存在的幽灵运行态；删除前 running/retrying
        // 的会话回 idle 并提示删除失败，历史 messages 可恢复。
        this.sessions = prevSessions;
        this.searchResults = prevSearch;
        this.activeSession = prevActive;
        this.messages = prevMessages;
        if (prevSessionStatus === 'completed' || prevSessionStatus === 'network_interrupted') {
          this.sessionStatus[id] = prevSessionStatus;
        }
        if (prevSessionStatus === 'network_interrupted' && prevFallback !== undefined) {
          this.apiRetryTerminalFallback[id] = prevFallback;
        }
        // F11: 恢复 plan store 状态（clearSession 已删除）
        if (prevPlan) {
          planStore.planBySession[id] = prevPlan;
        }
        this.error = error instanceof Error ? error.message : '删除会话失败';
      }
    },
    // 批量删除：逐个复用 deleteSession 的完整链（乐观更新、执行态清理、主进程
    // 停 query/队列 → DELETE 级联物理删库 → 附件物理文件清理、失败回滚）。
    // 单个失败只回滚该会话并写 error，不中断其余会话的删除。
    async deleteSessions(ids: string[]) {
      for (const id of ids) {
        await this.deleteSession(id);
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
    // 会话级供应商×模型选用（doc2 §4.4）：一次写两个 override + 主进程更新全局「最近使用」记忆。
    // 切换保留会话历史，从下一条消息起生效（每条消息 = 全新 query + resume，天然成立）。
    async setActiveSessionProviderModel(providerId: string, modelId: string) {
      if (!this.activeSession) return;
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, {
          providerOverride: providerId,
          modelOverride: modelId,
        });
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
    // 会话级思考强度：写入 session.thinkingLevel（null/'auto' = 跟随全局默认），下次 spawn 注入生效。
    // 与 setActiveSessionPermissionMode 同构（通用 updateSession 通道）。
    async setActiveSessionThinkingLevel(level: ThinkingLevel | null) {
      if (!this.activeSession) return;
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, { thinkingLevel: level });
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '更新思考强度失败';
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
        // 真实用量 + SDK 上报的真实窗口交给 state；windowSize/ratio 由 contextStats getter 派生。
        // 用户按别名设置（contextWindowByAlias）优先级高于 payload.windowSize，由 getter 内
        // resolveContextWindow 处理，避免 SDK 误报 200k 覆盖用户设置的 1M。
        this.contextLastWindow = payload.windowSize;
        this.contextUsage = { inputTokens: payload.inputTokens, outputTokens: payload.outputTokens };
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
      // 新回合开始时，上一回合仅运行期可见的终态兜底失效。
      delete this.apiRetryTerminalFallback[sessionId];
      // 新回合开始：上一回合的完成态（绿灯）与网络中断常红一起失效
      // （绿灯/常红回到黄灯/执行中）——这是常红会话恢复为可运行黄灯的唯一入口。
      delete this.sessionStatus[sessionId];
      // 新回合开始：清旧 retry 瞬态，避免上一回合残留的红闪串到新回合。
      delete this.apiRetryInfo[sessionId];
      if (!this.runningSessions.includes(sessionId)) {
        this.runningSessions.push(sessionId);
        // 问题 2：记录本回合开始时间（仅新加入时置位，避免重复 send 覆盖）。
        this.turnStartedAt[sessionId] = Date.now();
      }
      // v2-F3：每次 markRunning 递增回合 generation（新回合边界）。abort finally 兜底
      // 据此识别「被中断的那一代」，旧 finally 不会误停新回合。
      this.turnGeneration[sessionId] = (this.turnGeneration[sessionId] ?? 0) + 1;
      // 侧栏黄灯：无论重复 send 与否都保持 running 状态。
      this.sessionStatus[sessionId] = 'running';
    },
    // 根因修复：标记会话成功完成。成功 result 时调用。
    // 与 markStopped 同构清理运行期数据，但额外写入 sessionStatus 'completed'（侧栏绿灯）。
    // 常红防覆盖守卫：已确认 network_interrupted 的会话，迟到/异常排序的 success result
    // 不得把常红覆盖成绿灯，只做幂等清理。
    markCompleted(sessionId: string) {
      this.runningSessions = this.runningSessions.filter((sid) => sid !== sessionId);
      delete this.sessionStreams[sessionId];
      delete this.turnStartedAt[sessionId];
      delete this.stalledInfo[sessionId];
      delete this.apiRetryInfo[sessionId];
      delete this.subAgentStreamingThinking[sessionId];
      if (this.sessionStatus[sessionId] !== 'network_interrupted') {
        this.sessionStatus[sessionId] = 'completed';
      }
    },
    // retry 真正耗尽（network interrupted）：专门处理 retry exhausted 终态。
    // 与 markStopped 同构清理运行期数据，但额外写入 sessionStatus 'network_interrupted'
    //（侧栏红灯常亮）。不清除 apiRetryTerminalFallback——DB 写终态失败时 fallback
    // 卡片仍需可见。下一次 markRunning（新回合/下一项任务）是清除常红回黄灯的唯一入口。
    markNetworkInterrupted(sessionId: string) {
      this.runningSessions = this.runningSessions.filter((sid) => sid !== sessionId);
      delete this.sessionStreams[sessionId];
      delete this.turnStartedAt[sessionId];
      delete this.stalledInfo[sessionId];
      delete this.apiRetryInfo[sessionId];
      delete this.subAgentStreamingThinking[sessionId];
      this.sessionStatus[sessionId] = 'network_interrupted';
    },
    // 根因修复：标记会话执行结束。失败 result / error / aborted 时调用。
    // 只删除运行态数据，不写 completed——错误、用户中断、aborted 不得亮绿灯。
    // 基础状态按规则处理：running 删除回 idle；undefined 保持 idle；
    // completed 保留绿灯；network_interrupted 保留常红——exhausted 后迟到的
    // 失败 result/error/aborted 不得清掉已确认的常红。
    markStopped(sessionId: string, options: { preserveApiRetry?: boolean } = {}) {
      this.runningSessions = this.runningSessions.filter((sid) => sid !== sessionId);
      // 清理该会话的流式快照（执行结束，快照不再需要）
      delete this.sessionStreams[sessionId];
      // 问题 2：清理本回合开始时间戳（执行结束，计时器随之隐藏）。
      delete this.turnStartedAt[sessionId];
      // 卡死横幅随回合结束消失。
      delete this.stalledInfo[sessionId];
      if (!options.preserveApiRetry) delete this.apiRetryInfo[sessionId];
      // 子 agent 实时思考快照随回合结束清除。
      delete this.subAgentStreamingThinking[sessionId];
      // 错误/中断/aborted：不保留运行态也不亮绿灯 → 回 idle（无状态点）。
      if (this.sessionStatus[sessionId] === 'running') {
        delete this.sessionStatus[sessionId];
      }
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
    // 直接替换为主进程权威状态；不得在 renderer 自行 +1。
    // 每个新 retry episode 的首个 api_retry 都会经过此 action：同时使上一 episode 的
    // 运行期 terminal fallback 失效（recovered 后同一 Query 可开启新 episode，旧 fallback
    // 不得在新 episode 的 persisted 终态落库后重新出现）。删除幂等，连续多次
    // api_retry 通知安全，不影响权威 retry count/limit。
    // v2-F2：terminal 后迟到的 api_retry 直接忽略——基础终态已确认（completed/
    // network_interrupted）或回合已不在运行，写回只会让聊天区重新出现“正在自动重试”
    // 卡片，而 query 已终止。新回合先经过 markRunning（清终态、加回 runningSessions），
    // 合法 retry 不会被挡住；忽略时也不得清 terminal fallback。
    markApiRetrying(sessionId: string, info: Omit<ApiRetryInfo, 'stopping'>) {
      if (this.sessionStatus[sessionId] === 'completed' || this.sessionStatus[sessionId] === 'network_interrupted') {
        return;
      }
      if (!this.runningSessions.includes(sessionId)) return;
      this.apiRetryInfo[sessionId] = { ...info, stopping: false };
      delete this.apiRetryTerminalFallback[sessionId];
    },
    markApiRetryStopping(sessionId: string) {
      const info = this.apiRetryInfo[sessionId];
      if (info) info.stopping = true;
    },
    clearApiRetrying(sessionId: string) {
      delete this.apiRetryInfo[sessionId];
    },
    setApiRetryTerminalFallback(sessionId: string, fallback: ApiRetryTerminalFallback) {
      this.apiRetryTerminalFallback[sessionId] = fallback;
      delete this.apiRetryInfo[sessionId];
    },
    clearApiRetryTerminalFallback(sessionId: string) {
      delete this.apiRetryTerminalFallback[sessionId];
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
      // Task 7B：按 id upsert——task 执行/waiting 续接经 queue event 回传同一 id 的 user message 时，
      // 替换而非追加，避免重复气泡（retry/重放也复用同一稳定 id）。
      const existingIdx = this.messages.findIndex((m) => m.id === message.id);
      const isNew = existingIdx < 0;
      if (isNew) {
        this.messages.push(message);
      } else {
        this.messages.splice(existingIdx, 1, message);
      }

      // Trigger topic analysis for first user message if session name is auto-generated
      if (
        isNew &&
        message.role === 'user' &&
        this.messages.filter((m) => m.role === 'user').length === 1 &&
        this.activeSession?.name.startsWith('会话')
      ) {
        const sessionId = this.activeSession.id;
        const textContent = message.content.trim();
        const firstName = message.attachments?.[0]?.filename?.trim();
        if (textContent) {
          // 有文字：LLM 概括主题（仅传正文文字，不传附件 bytes/路径）。
          window.claudeLink.analyzeTopic(sessionId, textContent).then((topic) => {
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
        } else if (firstName) {
          // 附件-only：文件名即标题素材，直接截断使用，不喂 LLM——
          // 孤立文件名会被 LLM 误判为「没有对话内容」而回复客套话，反而劣化标题。
          const topic = firstName.replace(/\s+/g, ' ').slice(0, 15);
          window.claudeLink.updateSession(sessionId, { name: topic }).then((updated) => {
            if (updated && this.activeSession?.id === sessionId) {
              this.activeSession.name = updated.name;
            }
            this.loadSessions();
          }).catch(() => {
            // ignore
          });
        }
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
    // 批次 B：思考 token 实时估算（瞬态）。null=清零（回合结束/切会话）。
    setThinkingTokens(v: number | null) {
      this.thinkingTokens = v;
    },
    // 切换右侧活动栏筛选（含 'all' 总览）。
    setRightTab(tab: 'all' | 'plan' | 'queue' | 'subagent' | 'background' | 'changes') {
      this.rightTab = tab;
    },
    // 折叠/展开活动总览主体（保留 rail 图标轨）。
    toggleOverviewCollapsed() {
      this.overviewCollapsed = !this.overviewCollapsed;
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
