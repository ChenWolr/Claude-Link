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
import type { ContextUsageSource, ContextUsageFreshness, ContextSamplePhase } from '../../shared/context-usage';
import { shouldAcceptContextPayload, shouldShowCompactedBanner, hasCompleteCanonicalFields } from '../../shared/context-usage';
import { computeTurnStartIndex } from '../../shared/turn-boundary';
import { isAutoSessionName } from '../../shared/auto-session-name';import { useConfigStore } from './config-store';
import { useClaudePlanStore } from './claude-plan-store';
import { useCommandStore } from './command-store';
import { useChatDraftStore } from './chat-draft-store';

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

// Task 9：canonical 上下文状态（单一真相源）。ContextButton 只读这里，不得再从
// contextLastWindow 拼装「当前窗口已用」。source/freshness 决定展示级别。
export interface CanonicalContextState {
  currentContextUsedTokens: number | null;
  contextWindowCapacityTokens: number | null;
  currentContextUsedPercent: number | null;
  currentContextRemainingTokens: number | null;
  currentContextRemainingPercent: number | null;
  turnInputTokens: number | null;
  turnCacheReadTokens: number | null;
  turnCacheCreationTokens: number | null;
  turnOutputTokens: number | null;
  source: ContextUsageSource | null;
  freshness: ContextUsageFreshness | null;
  consistency: 'reconciled' | 'mismatch' | 'unavailable' | null;
  diagnostic: string | null;
  /** 采样阶段（review-v4 High-1）：runtime 快照为 query-start/post-turn/post-compaction；其余 null。 */
  samplePhase: ContextSamplePhase | null;
}

// Task 9：contextStats getter 的视图（ContextButton 消费）。
export interface ContextStatsView {
  // 当前窗口（可信值，可 null）
  currentUsedTokens: number | null;
  currentPercent: number | null;
  currentRemainingTokens: number | null;
  currentRemainingPercent: number | null;
  windowSize: number;
  // turn usage（参考，不得驱动圆环）
  turnInputTokens: number | null;
  turnCacheReadTokens: number | null;
  turnCacheCreationTokens: number | null;
  turnOutputTokens: number | null;
  source: ContextUsageSource | null;
  freshness: ContextUsageFreshness | null;
  consistency: 'reconciled' | 'mismatch' | 'unavailable' | null;
  diagnostic: string | null;
  /** 采样阶段（review-v4 High-1）：runtime 快照的 query-start/post-turn/post-compaction；其余 null。 */
  samplePhase: ContextSamplePhase | null;
}

// post-turn 官方 /context 探针持久化的 last-known → canonical 预填（Task 3 Step 3）。
// 重启/切回会话时若 DB 有 last_context_used 且 renderer 尚无 canonical 值，预填数字
// 并诚实标注 stale + source='native-context' + samplePhase='post-turn'——重启后无新
// telemetry，契约不允许冒充 fresh（S12 实证语义保持）。会话内新 payload 到达即覆盖。
function buildPersistedCanonical(session: Session): CanonicalContextState | null {
  const used = session.lastContextUsed;
  if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) return null;
  const capacity = session.lastContextUsedCapacity;
  const percent =
    typeof capacity === 'number' && Number.isFinite(capacity) && capacity > 0
      ? Math.round((used / capacity) * 100)
      : null;
  return {
    currentContextUsedTokens: used,
    contextWindowCapacityTokens: typeof capacity === 'number' && capacity > 0 ? capacity : null,
    currentContextUsedPercent: percent,
    currentContextRemainingTokens:
      typeof capacity === 'number' && capacity >= used ? capacity - used : null,
    currentContextRemainingPercent: percent != null ? Math.max(0, 100 - percent) : null,
    turnInputTokens: null,
    turnCacheReadTokens: null,
    turnCacheCreationTokens: null,
    turnOutputTokens: null,
    source: 'native-context',
    freshness: 'stale',
    consistency: 'unavailable',
    diagnostic: '上次会话记录值，等待刷新',
    samplePhase: 'post-turn',
  };
}

// A2（契约普查 2026-09-08）：searchSessions 请求代际——模块级自增（与组件生命周期解耦，
// 对照 config-store loadNativeSettingsDiagnostic 的请求代际先例）。H2 的 onUnmounted 只能
// 取消未触发的防抖 timer；timer 已 fire、IPC 在途时导航走，晚完成的旧搜索会把 searchResults
// 重新置入（AppSidebar 常驻消费，不可见过滤器变体）。发起新查询即换代，晚到旧结果/旧失败
// 一律丢弃。
let searchSessionsRequestId = 0;

export const useSessionStore = defineStore('session', {
  state: () => ({
    sessions: [] as Session[],
    // 搜索视图态：null 表示无搜索（显示全量 sessions），非 null 表示显示搜索结果。
    // 避免 searchSessions 直接覆盖 sessions 而污染会话管理页/侧栏等全局列表。
    searchResults: null as Session[] | null,
    // 当前搜索词，供 UI 同步空态判断。
    searchQuery: '' as string,
    activeSession: null as Session | null,
    // 暂态会话单例持有者（B3/B5）：切到已有会话后暂态不再是 activeSession，但对象仍在此存活；
    // 再点「新会话」回到同一对象（同 id → chat-draft-store 草稿天然找回）。物化成功即清空（B6）。
    transientDraft: null as Session | null,
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
    // 当前活动会话最近一次 SDK 上报的真实窗口（作 resolveContextWindow 的 lastContextWindow）。
    // 切会话时从 session.lastContextWindow 初始化，收 usage 回调时用 payload 覆盖。
    contextLastWindow: null as number | null,
    // Task 9：canonical 上下文占用（当前窗口 + turn usage + source/freshness/diagnostic）。
    // 单一真相源：ContextButton 只读这里；切换会话时置 null（无 fresh 数据 → pending）。
    canonicalContext: null as CanonicalContextState | null,
    // review-v3 High-2：每会话已见的 CONTEXT_UPDATE query 代际（主进程 entry.queryInstance）。
    // 收到 payload 先过代际门（shouldAcceptContextPayload）：旧代际 / 已知代际却缺代际的
    // 迟到 payload 一律拒收，防止被中断/替换的旧回合覆盖新回合 canonical 状态。
    // 权威值来自主进程 entry；renderer 不自行递增（本地只被动记录见过的最大代际）。
    contextQueryGenerations: {} as Record<string, number | undefined>,
    // 问题 4：CC 自动压缩事件标记。收到 compactedJustNow:true 的 CONTEXT_UPDATE 时置 true，
    // ContextButton 据此弹短暂横幅回显。横幅显示后由 ContextButton 自行复位为 false。
    compactedJustNow: false as boolean,
    // compact metadata display：最近一次压缩账单显示态（横幅 + popover 共用）。shouldShowCompactedBanner
    // 通过时从 payload 提取（全可选），切换会话时与 compactedJustNow 一并清空。
    lastCompactionSummary: null as null | {
      fromTokens?: number;
      toTokens?: number;
      droppedTokens?: number;
      durationMs?: number;
      trigger?: string;
    },
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
    // B1：最近一回合的耗时/结束时刻（按 sessionId）。回合 result 到达时由 use-chat 写入，
    // 比 sessions 列表对象里的 lastTurn* 字段新鲜（后者只在 IPC 返回整会话时刷新）。
    // TurnTimer 完成态优先读这里，读不到（重启后/切回未刷新）回落 Session 字段。
    lastTurnMeta: {} as Record<string, { durationMs: number; endedAt: number }>,
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
    // B1：当前活动会话的最近回合元数据。内存 map 优先（本启动周期内最新），
    // 否则回落 Session 持久化字段（重启恢复/切回）。都无 → null（完成态不渲染）。
    activeLastTurnMeta(state): { durationMs: number; endedAt: number } | null {
      const sid = state.activeSession?.id;
      if (!sid) return null;
      const mem = state.lastTurnMeta[sid];
      if (mem) return mem;
      const s = state.activeSession;
      if (s?.lastTurnDurationMs != null && s.lastTurnEndedAt != null) {
        return { durationMs: s.lastTurnDurationMs, endedAt: s.lastTurnEndedAt };
      }
      return null;
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
    // 上下文统计（Task 9）：从 canonicalContext 派生。圆环只读当前窗口可信值；
    // turn usage 仅作参考。无可信当前窗口时 currentUsedTokens/currentPercent 为 null（pending）。
    contextStats(state): ContextStatsView | null {
      if (!state.activeSession) return null;
      const alias = state.activeSession.modelOverride || state.activeSession.model;
      const windowSize = resolveContextWindow({
        lastContextWindow: state.contextLastWindow,
        alias,
        contextWindowByAlias: useConfigStore().config.contextWindowByAlias,
      });
      const c = state.canonicalContext;
      // review-v2 证据缺口 3：turn usage 只读 canonicalContext，不再回落旧 contextUsage state。
      return {
        currentUsedTokens: c?.currentContextUsedTokens ?? null,
        currentPercent: c?.currentContextUsedPercent ?? null,
        currentRemainingTokens: c?.currentContextRemainingTokens ?? null,
        currentRemainingPercent: c?.currentContextRemainingPercent ?? null,
        windowSize,
        turnInputTokens: c?.turnInputTokens ?? null,
        turnCacheReadTokens: c?.turnCacheReadTokens ?? null,
        turnCacheCreationTokens: c?.turnCacheCreationTokens ?? null,
        turnOutputTokens: c?.turnOutputTokens ?? null,
        source: c?.source ?? null,
        freshness: c?.freshness ?? null,
        consistency: c?.consistency ?? null,
        diagnostic: c?.diagnostic ?? null,
        samplePhase: c?.samplePhase ?? null,
      };
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
    // —— 暂态会话（新会话延迟持久化）——
    // 点击「新会话」不再落库：构造 renderer-only 暂态对象占据 activeSession，首条消息发送时经
    // materializeActiveTransient 物化为同 id 的 DB 行。狂点新会话只回到同一暂态（单例），
    // 侧栏不出现任何条目；文字/附件草稿按 id 存于 chat-draft-store，天然跨视图/跨会话切换存活。
    startTransientSession() {
      if (this.activeSession?.transient) return; // 单例：当前已在暂态则原地复用（草稿与选择全保留）
      // 离开的是持久会话：先保存流式快照（与 switchSession 同构），否则下面的瞬态清空会让
      // 该会话切换前已流出的正文/思考永久丢失（后台事件从零累积，直到回合结束落库才自愈）。
      const oldId = this.activeSession?.id;
      if (oldId) {
        this.sessionStreams[oldId] = {
          content: this.streamingContent,
          thinking: this.streamingThinking,
          tool: this.streamingTool,
        };
      }
      if (this.transientDraft) {
        // B5：切到已有会话后暂态在后台存活——回到同一对象（同 id，文字/附件草稿按 id 存于
        // chat-draft-store 天然找回；暂态期间选定的 override/工作空间就在对象上）。
        this.activeSession = this.transientDraft;
      } else {
        const now = new Date().toISOString();
        this.transientDraft = {
          id: crypto.randomUUID(),
          name: '新会话',
          cliSessionId: null,
          model: '',
          providerOverride: null,
          modelOverride: null,
          workingDir: null,
          permissionMode: null,
          maxTurns: 200,
          thinkingLevel: null,
          createdAt: now,
          updatedAt: now,
          lastContextTokens: null,
          lastContextUpdatedAt: null,
          lastContextWindow: null,
          lastContextUsed: null,
          lastContextUsedCapacity: null,
          lastContextUsedAt: null,
          lastEffectiveEffort: null,
          lastTurnDurationMs: null,
          lastTurnEndedAt: null,
          transient: true,
        };
        this.activeSession = this.transientDraft;
      }
      // 与 switchSession 同构的瞬态清理（暂态无历史可拉）。
      this.streamingContent = '';
      this.streamingThinking = '';
      this.streamingTool = '';
      this.error = null;
      this.messages = [];
      this.turnStartIndex = 0;
      this.compactedJustNow = false;
      this.lastCompactionSummary = null;
      this.toolProgress = {};
      this.backgroundTasks = {};
      this.compacting = false;
      this.thinkingTokens = null;
      this.contextLastWindow = null;
      this.canonicalContext = null;
      // B10 反转：主进程 COMMANDS_GET 已对无 DB 行会话开放只读分流（不再抛错），暂态创建即 load
      // 一次（与 switchSession 的 N4 同构）——斜杠菜单立即拿到全局兜底快照（全局指令），不再停留
      // loading；物化后 SESSION_CREATE 的 per-session probe 经 COMMANDS_CHANGED 升级为精确命令。
      const transientId = this.activeSession?.id;
      if (transientId) void useCommandStore().load(transientId);
    },
    /** 物化当前暂态会话：沿用同一 id 建 DB 行（含暂态期间选定的 override/工作空间/附件绑定）。 */
    async materializeActiveTransient(): Promise<Session | null> {
      const transient = this.activeSession;
      if (!transient?.transient) return this.activeSession;
      try {
        const draftIds = (useChatDraftStore().getAttachments(transient.id) ?? []).map((a) => a.id);
        const session = await window.claudeLink.createSession(`会话 ${this.sessions.length + 1}`, {
          id: transient.id,
          workingDir: transient.workingDir,
          providerOverride: transient.providerOverride ?? undefined,
          modelOverride: transient.modelOverride ?? undefined,
          // F-1：权限档/思考强度同样随物化落库（null=跟随默认 → undefined 省字段，建行默认即 NULL）。
          permissionMode: transient.permissionMode ?? undefined,
          thinkingLevel: transient.thinkingLevel ?? undefined,
          bindTransientAttachmentIds: draftIds,
        });
        this.sessions.unshift(session);
        // 物化成功：单例暂态退场（下次「新会话」= 全新空白暂态，B6）。
        this.transientDraft = null;
        // Task 5：新会话创建后拉取命令快照初始态（loading）；主进程 probe 经 COMMANDS_CHANGED 推完整列表。
        void useCommandStore().load(session.id);
        // await 期间用户可能已切走：只有仍在本会话时才替换 activeSession（物化结果无论如何都已进列表）。
        if (this.activeSession?.id === session.id) this.activeSession = session;
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
      // compact metadata display：压缩账单显示态随会话切换清空（与 compactedJustNow 复位同处）。
      this.lastCompactionSummary = null;
      // C：切换会话清理瞬态进度状态，避免会话 A 的工具耗时/后台任务/压缩态串扰到会话 B。
      this.toolProgress = {};
      this.backgroundTasks = {};
      this.compacting = false;
      // 批次 B：清思考 token 估算，避免会话 A 的思考峰值串扰到会话 B 的 ContextButton。
      this.thinkingTokens = null;
      // Task 9：真实窗口容量（provenance）交给 state；canonical 当前窗口数据在切换后置 null
      // （无 fresh 快照 → pending），不得把持久化的 lastContextTokens（累计 turn usage）伪装成当前。
      this.contextLastWindow = session.lastContextWindow;
      // Task 3 Step 3：若有 post-turn 探针持久化的精确占用，预填 stale（诚实标注非实时），
      // 否则置 null（pending 空态）。会话内新 payload 到达即覆盖此预填值。
      this.canonicalContext = buildPersistedCanonical(session);
      try {
        const loaded = await window.claudeLink.getSessionMessages(session.id);
        // P2-17：并发竞态守卫（对照 materializeActiveTransient 既有先例）——getSessionMessages
        // 的 IPC 往返期间用户可能已切到别的会话，慢响应不得覆盖新会话的 messages/turnStartIndex。
        if (this.activeSession?.id !== session.id) return;
        this.messages = loaded;
        // 运行中会话切回时，不能把 turnStartIndex 固定成 0；否则 MessageList 会把全量历史
        // 都当成本回合流式重复内容隐藏，造成「主过程/思考消失但计时还在跳」。
        // P1-3：口径收口到共享纯函数（与直发/队列回合同一实现）。
        if (this.runningSessions.includes(session.id)) {
          this.turnStartIndex = computeTurnStartIndex(this.messages);
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
      // B1：最近回合元数据随会话删除一并清理（DB 行由级联删除处理）。
      delete this.lastTurnMeta[id];
      // review-v3 High-2：已删会话的 context 代际记录一并清理（防内存泄漏；会话已删，
      // 主进程不会再发该会话的 CONTEXT_UPDATE，无需保留 known generation 拒收旧值）。
      delete this.contextQueryGenerations[id];
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
      // 先换代再分流：空查询同样使在途旧搜索失效（清空输入 = 最新意图是全量列表）。
      const requestId = ++searchSessionsRequestId;
      const q = query.trim();
      if (!q) {
        // 空查询退出搜索态，全量列表已在 sessions 里，无需 IPC。
        this.searchResults = null;
        this.searchQuery = '';
        return;
      }
      this.searchQuery = q;
      try {
        const results = await window.claudeLink.searchSessions(q);
        // A2：IPC 往返期间用户可能已发起新搜索/退出搜索态，晚到的旧结果不得覆盖新状态。
        if (requestId !== searchSessionsRequestId) return;
        this.searchResults = results;
      } catch (error) {
        // 晚到的旧失败同理：不清新结果、不误报 error。
        if (requestId !== searchSessionsRequestId) return;
        this.error = error instanceof Error ? error.message : '搜索会话失败';
        // 异常回退全量列表。
        this.searchResults = null;
      }
    },
    // OPT-10：updateActiveSessionModelOverride 已删除——无调用方的死代码（模型选用唯一现场
    // =供应商模型选择器 setActiveSessionProviderModel；preload 的 updateModelOverride 方法同步移除）。
    // 会话级供应商×模型选用（doc2 §4.4）：一次写两个 override + 主进程更新全局「最近使用」记忆。
    // 切换保留会话历史，从下一条消息起生效（每条消息 = 全新 query + resume，天然成立）。
    async setActiveSessionProviderModel(providerId: string, modelId: string) {
      if (!this.activeSession) return;
      // 暂态会话：尚未落库，先写内存；物化时随 SessionCreateSpec 一并落库（原位变更保单例引用）。
      if (this.activeSession.transient) {
        this.activeSession.providerOverride = providerId;
        this.activeSession.modelOverride = modelId;
        return;
      }
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
      // 暂态会话：先写内存（原位变更保单例引用），物化时随 SessionCreateSpec 一并落库；目录照记历史。
      if (this.activeSession.transient) {
        this.activeSession.workingDir = dir;
        if (dir) this.recentWorkspaces = await window.claudeLink.addRecentWorkspace(dir);
        return;
      }
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
    // 会话级权限模式：写入 session.permissionMode（null = 跟随全局默认 config.permissionMode），
    // spawn 时经 resolveEffectivePermissionMode 回落为实际档后经 --permission-mode 生效。
    async setActiveSessionPermissionMode(mode: Session['permissionMode']) {
      if (!this.activeSession) return;
      if (this.activeSession.transient) {
        this.activeSession.permissionMode = mode;
        return;
      }
      try {
        const updated = await window.claudeLink.updateSession(this.activeSession.id, { permissionMode: mode });
        if (updated) {
          this.activeSession = updated;
          this.sessions = this.sessions.map((session) => (session.id === updated.id ? updated : session));
        }
        // 批次二 #3：运行中回合经 streaming 控制请求即时生效；无运行回合（返回 false）自然
        // 回落「下一条消息生效」——新 query 读上面已落库的 session.permissionMode。
        // catch 静默回落：控制请求失败不影响已写入的会话档，最坏退化为下一条生效。
        try {
          await window.claudeLink.setRunningPermissionMode(this.activeSession.id, mode);
        } catch {
          // 静默回落（IPC 不可达等极端情况）
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '更新权限模式失败';
      }
    },
    // 会话级思考强度：写入 session.thinkingLevel（null/'auto' = 跟随全局默认），下次 spawn 注入生效。
    // 与 setActiveSessionPermissionMode 同构（通用 updateSession 通道）。
    async setActiveSessionThinkingLevel(level: ThinkingLevel | null) {
      if (!this.activeSession) return;
      if (this.activeSession.transient) {
        this.activeSession.thinkingLevel = level;
        return;
      }
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
    // P2（effort 可见性）：回合结束后从主进程拉最新 lastEffectiveEffort 合并进 activeSession。
    // 只合并这一个字段——不整体替换 activeSession，避免覆盖 renderer 侧乐观状态。
    // 时序：CLI 把 assistant 事件落盘晚于 result 数秒，主进程在 result 后 2/4/6/8s 延迟重试写
    // DB；渲染层无法区分「本轮新值」与「上轮旧值」，故按固定时刻表（3.5/6/9s）拉取合并，
    // 覆盖主进程整个写入窗，最后一次为准。会话切换即放弃，不跨会话误合并。
    async refreshActiveSessionEffort() {
      if (!this.activeSession || this.activeSession.transient) return;
      const sid = this.activeSession.id;
      for (const delayMs of [3500, 6000, 9000]) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        if (this.activeSession?.id !== sid) return;
        try {
          const s = await window.claudeLink.getSession(sid);
          if (this.activeSession?.id !== sid) return;
          if (s && s.id === sid && s.lastEffectiveEffort) {
            this.activeSession.lastEffectiveEffort = s.lastEffectiveEffort;
          }
        } catch {
          // 静默：诊断信息
          return;
        }
      }
    },
    async loadRecentWorkspaces() {
      try {
        this.recentWorkspaces = await window.claudeLink.listRecentWorkspaces();
      } catch {
        // 静默：历史为空也能用
      }
    },
    // 从最近目录历史永久删除一条（只移除历史记录，不删除磁盘目录）。主进程返回删除后的完整列表。
    async removeRecentWorkspace(dir: string) {
      try {
        this.recentWorkspaces = await window.claudeLink.removeRecentWorkspace(dir);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '删除目录历史失败';
      }
    },
    bindContextUpdates() {
      return window.claudeLink.onContextUpdate((payload) => {
        // review-v3 High-2：代际门——旧 query 的迟到 payload（中断/替换后到达）与「已知代际却
        // 缺代际」的可疑 payload 一律拒收，防止旧回合覆盖新回合 canonical 状态。规则见
        // shouldAcceptContextPayload（共享纯函数，行为有专项测试）；通过时记录见过的最大代际。
        // P2-10：门提前到 activeSession 判定之前——后台会话的合法 payload 也要过门并回填列表，
        // 而非直接丢弃。
        const gate = shouldAcceptContextPayload(this.contextQueryGenerations[payload.sessionId], payload.queryGeneration);
        if (!gate.accept) return;
        this.contextQueryGenerations[payload.sessionId] = gate.nextKnownGeneration;
        // P2-10：后台会话的探针/runtime fresh 数据回填 sessions 列表对象——否则驻留会话 A 时
        // 会话 B 的 post-turn 探针结果被整体丢弃，切回 B 时 switchSession 从列表旧对象预填
        // canonicalContext（旧值/待刷新）。带 live 占用值的 payload 才回填（turn-usage-only
        // 事件 currentContextUsedTokens=null，红线：turn usage 永不驱动圆环，照旧不回填）。
        const listItem = this.sessions.find((s) => s.id === payload.sessionId);
        if (listItem && typeof payload.currentContextUsedTokens === 'number' && payload.currentContextUsedTokens >= 0) {
          listItem.lastContextUsed = payload.currentContextUsedTokens;
          listItem.lastContextUsedCapacity = payload.contextWindowCapacityTokens ?? listItem.lastContextUsedCapacity ?? null;
          listItem.lastContextUsedAt = payload.refreshedAt ?? Date.now();
        }
        if (this.activeSession?.id !== payload.sessionId) return;
        // review-v4 Medium-2：字段完整性协议校验——canonical 字段缺省（undefined）即协议错误，
        // 拒收，不得与 prev state 拼接成混合状态（无数据必须显式 null，由主进程构造保证）。
        if (!hasCompleteCanonicalFields(payload)) return;
        // 真实窗口容量交给 state（provenance）；windowSize/percent 由 contextStats getter 派生。
        // 用户按别名设置（contextWindowByAlias）优先级高于 payload.windowSize，由 getter 内
        // resolveContextWindow 处理，避免 SDK 误报 200k 覆盖用户设置的 1M。
        this.contextLastWindow = payload.windowSize;
        // Task 9：canonical 单一真相源。当前窗口主值只读 canonical 字段；turn usage 单列。
        // 关键：turn-usage-only 事件（message/result，currentContextUsedTokens=null）不得把
        // 已到达的 runtime-live 当前窗口值清空——否则 live 快照会被随后 message/result 的
        // estimated 事件覆盖回 null。此时保留 last-known 值并降级 freshness 为 stale。
        // 但 pending（压缩后/重启后等待 fresh）与 unavailable（无数据）必须清空——旧数字已
        // 失效（压缩后实际占用下降），不得显示过期数字冒充当前。
        const incomingUsed = payload.currentContextUsedTokens;
        const hasLive =
          typeof incomingUsed === 'number' && Number.isFinite(incomingUsed) && incomingUsed >= 0;
        const prev = this.canonicalContext;
        const prevUsed = prev?.currentContextUsedTokens ?? null;
        const prevHasLive = typeof prevUsed === 'number' && prevUsed >= 0;
        const incomingFreshness = payload.freshness ?? null;
        const shouldPreserve = !hasLive && prevHasLive && (incomingFreshness === 'estimated' || incomingFreshness === 'stale');
        const currentUsedTokens = hasLive ? incomingUsed : shouldPreserve ? prevUsed : null;
        const currentUsedPercent = hasLive
          ? payload.currentContextUsedPercent ?? null
          : shouldPreserve
            ? prev?.currentContextUsedPercent ?? null
            : null;
        this.canonicalContext = {
          currentContextUsedTokens: currentUsedTokens,
          contextWindowCapacityTokens: payload.contextWindowCapacityTokens ?? prev?.contextWindowCapacityTokens ?? null,
          currentContextUsedPercent: currentUsedPercent,
          currentContextRemainingTokens: hasLive
            ? payload.currentContextRemainingTokens ?? null
            : shouldPreserve
              ? prev?.currentContextRemainingTokens ?? null
              : null,
          currentContextRemainingPercent: hasLive
            ? payload.currentContextRemainingPercent ?? null
            : shouldPreserve
              ? prev?.currentContextRemainingPercent ?? null
              : null,
          // review-v2 证据缺口 3：turn usage 单一来源——runtime-live 快照不带 turn 字段时，
          // 从 prev 保留最近一轮 turn usage，不再回落旧 contextUsage state。
          turnInputTokens: payload.turnInputTokens ?? prev?.turnInputTokens ?? null,
          turnCacheReadTokens: payload.turnCacheReadTokens ?? prev?.turnCacheReadTokens ?? null,
          turnCacheCreationTokens: payload.turnCacheCreationTokens ?? prev?.turnCacheCreationTokens ?? null,
          turnOutputTokens: payload.turnOutputTokens ?? prev?.turnOutputTokens ?? null,
          source: hasLive ? payload.source ?? null : shouldPreserve ? prev?.source ?? null : null,
          freshness: hasLive ? payload.freshness ?? null : shouldPreserve ? 'stale' : payload.freshness ?? null,
          consistency: payload.consistency ?? null,
          // review-v5 Medium-1：shouldPreserve 优先透传 payload.diagnostic（post-turn 兜底
          // 的诊断本就含「上一可信快照采样阶段」），仅 payload 无诊断时才用兜底文案。
          diagnostic: hasLive
            ? payload.diagnostic ?? null
            : shouldPreserve
              ? payload.diagnostic ?? '上次快照已过期，等待刷新'
              : payload.diagnostic ?? null,
          samplePhase: payload.samplePhase ?? null,
        };
        // 问题 4：CC 自动压缩事件 → 置标记，ContextButton 弹横幅回显。
        // review-v2 High#3 / review-v3 §5.3 双保险（shouldShowCompactedBanner 共享纯函数）：
        // compactedJustNow 只在 fresh 快照（freshness==='fresh' 且 source 为 runtime-live/reconciled）
        // 到达时置位，pending/unavailable/stale 不假称完成。主进程侧仅在 compact_result:success 后的
        // 同代 fresh 快照附加 compactedJustNow，此处再验一次终态语义。
        if (shouldShowCompactedBanner(payload)) {
          this.compactedJustNow = true;
          this.compacting = false; // C：压缩完成，复位实时态
          // compact metadata display：从 payload 提取账单显示态（全可选；缺字段自然缺席，
          // formatCompactionSummary 会回退现有文案）。
          this.lastCompactionSummary = {
            ...(typeof payload.compactFromTokens === 'number' ? { fromTokens: payload.compactFromTokens } : {}),
            ...(typeof payload.compactToTokens === 'number' ? { toTokens: payload.compactToTokens } : {}),
            ...(typeof payload.compactDroppedTokens === 'number' ? { droppedTokens: payload.compactDroppedTokens } : {}),
            ...(typeof payload.compactDurationMs === 'number' ? { durationMs: payload.compactDurationMs } : {}),
            ...(typeof payload.compactTrigger === 'string' ? { trigger: payload.compactTrigger } : {}),
          };
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
        // 第四态阶段徽章配套：全新回合清空工具进度残留（中断 aborted 后 tool_result 不到达会遗留旧
        // toolUseId → 阶段徽章误判「工具执行中」）。toolProgress 是全局 map（仅活动会话的 tool_progress
        // 事件写入），故只在「活动会话」开启全新回合时清——后台会话 B 的队列 markRunning(B) 不得清掉
        // 活动会话 A 运行中工具的实时进度（否则 A 阶段徽章误回落「思考中」、ProcessGroup/子Agent 实时
        // 耗时丢失）。续写 continuing 时 runningSessions 已含该会话、不进此分支，保留进行中进度。
        if (sessionId === this.activeSession?.id) {
          this.toolProgress = {};
        }
      }
      // v2-F3：每次 markRunning 递增回合 generation（新回合边界）。abort finally 兜底
      // 据此识别「被中断的那一代」，旧 finally 不会误停新回合。
      this.turnGeneration[sessionId] = (this.turnGeneration[sessionId] ?? 0) + 1;
      // 侧栏黄灯：无论重复 send 与否都保持 running 状态。
      this.sessionStatus[sessionId] = 'running';
    },
    // B1：写入最近回合元数据（内存态 + 就地补 sessions/activeSession 对象字段，保持侧栏数据一致）。
    setLastTurnMeta(sessionId: string, meta: { durationMs: number | null; endedAt: number }) {
      if (meta.durationMs != null && meta.durationMs > 0) {
        this.lastTurnMeta[sessionId] = { durationMs: meta.durationMs, endedAt: meta.endedAt };
      }
      const target = this.sessions.find((s) => s.id === sessionId);
      if (target) {
        target.lastTurnDurationMs = meta.durationMs;
        target.lastTurnEndedAt = meta.endedAt;
      }
      if (this.activeSession?.id === sessionId) {
        this.activeSession.lastTurnDurationMs = meta.durationMs;
        this.activeSession.lastTurnEndedAt = meta.endedAt;
      }
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
      if (this.activeSession.transient) return;
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
      if (this.activeSession.transient) {
        this.activeSession.name = trimmed;
        return;
      }
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
    /** P1-3：按共享口径重算回合边界（队列回合的 user_message_created 分支在消息入列后调用）。 */
    recomputeTurnStartIndex() {
      this.turnStartIndex = computeTurnStartIndex(this.messages);
    },
    addMessage(message: Message) {
      // P1-4 归属守卫（单点）：非活动会话的消息一律拒绝——后台队列回合的 user message
      // 经 task-store 直连本方法，无守卫时串入当前会话（幽灵气泡），isNew+user 数=1 判定
      // 还会用外来内容触发 analyzeTopic 改错标题。活动会话写入谓词恒真不受影响；
      // activeSession 为 null（暂态草稿）时拒绝一切远端消息。切回原会话由 DB 重载补齐。
      if (message.sessionId !== this.activeSession?.id) return;
      // Task 7B：按 id upsert——task 执行/waiting 续接经 queue event 回传同一 id 的 user message 时，
      // 替换而非追加，避免重复气泡（retry/重放也复用同一稳定 id）。
      const existingIdx = this.messages.findIndex((m) => m.id === message.id);
      const isNew = existingIdx < 0;
      if (isNew) {
        this.messages.push(message);
      } else {
        this.messages.splice(existingIdx, 1, message);
      }

      // P1-3：回合边界随消息入列重算（队列回合的 turnStartIndex 唯一更新点由 task-store 调用）。
      this.turnStartIndex = computeTurnStartIndex(this.messages);

      // Trigger topic analysis for first user message if session name is auto-generated
      if (
        isNew &&
        message.role === 'user' &&
        this.messages.filter((m) => m.role === 'user').length === 1 &&
        isAutoSessionName(this.activeSession?.name)
      ) {
        const sessionId = this.activeSession.id;
        const textContent = message.content.trim();
        const firstName = message.attachments?.[0]?.filename?.trim();
        if (textContent) {
          // 有文字：LLM 概括主题（仅传正文文字，不传附件 bytes/路径）。
          window.claudeLink.analyzeTopic(sessionId, textContent).then((topic) => {
            if (topic) {
              // Only update if still on the same session
              // F4：发送瞬间到主题返回之间用户可能已手动重命名——迟到的主题不覆盖
              // （与主进程 topic-analyzer 写前重查同门槛）。H3：判据收紧为
              // isAutoSessionName 精确形态，「会话备份」等自然命名一律让位。
              if (this.activeSession?.id === sessionId && isAutoSessionName(this.activeSession.name)) {
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
          // H3：DB 写前同门槛——当前名已非「会话 N」自动形态（用户已手动命名）则跳过
          // DB 写，不让附件名覆盖手动名。与上方触发门槛构成双保险，防未来重构在本分支
          // 插入 await 后打开竞态窗口（触发门槛判定的是分支入口瞬间）。
          if (!isAutoSessionName(this.activeSession?.name)) return;
          window.claudeLink.updateSession(sessionId, { name: topic }).then((updated) => {
            // F4：附件名命名同样加门槛——覆盖视图前重查当前名仍是自动形态。
            if (updated && this.activeSession?.id === sessionId && isAutoSessionName(this.activeSession.name)) {
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
