// turn-projection.ts
// 主进程回合流式投影缓存（SA-1，计划 2026-10-21「回合投影 + 标题质量」）：纯内存、无 I/O。
//
// 定位：主进程侧的「当前回合进行态」单一事实源——三路流式累加器（text / thinking /
// tool 入参 JSON）+ 瞬态（api_retry / stalled / backgroundTasks）+ 回合起止权威时钟。
// 消费方：标题质量（SA-4+）等只读快照查询；renderer 的实时流式预览仍走既有 CHAT_EVENT
// 事件流，本模块不替代、不改变任何既有事件转发/落库行为（旁路只读投影）。
//
// 事件入口单点收口：sdk-backend 的 forwardEvent / forwardTransient 在推送主窗口之后追加
// noteTurnEvent（try 包裹，投影异常不得阻塞转发链）。回合起止由发射点显式驱动：
// CHAT_SEND / popExecute 成功 spawn 后 noteTurnStarted（并伴生 turn_started 事件）；
// result / killProcess 合成 aborted / runQuery catch 的 error 三终态出口调 noteTurnEnded
//（并伴生 turn_ended 事件，durationMs 以本模块 startedAt 为主进程权威起点）。
//
// 生命周期与代际：generation 复用 sdk-backend 的 query 代际（SessionEntry.queryInstance）。
// 同 generation 重复 noteTurnStarted 幂等（不重置已累积内容）；新 generation 覆盖旧投影
//（旧回合迟到快照不得污染新回合）。终态后投影保留 60000ms 供迟到快照查询，期满清除；
// 会话删除（markSessionDeleted）立即清。

import type { CliEvent, CliStreamEvent } from '../../shared/types/cli';
import type { StallInfo } from '../../shared/stall-watchdog';

/** 终态后投影保留窗（ms）：供迟到 getSnapshot 查询，期满清除。 */
const TERMINAL_RETENTION_MS = 60000;
/** 正文/思考累加器上限（字符数）：超限截断并置 truncated 标志，不影响 message 全量落库。 */
const STREAM_TEXT_LIMIT = 2 * 1024 * 1024;
/** 单个 tool 入参累加值上限（字符数）：超限截断并置 truncated 标志。 */
const STREAM_TOOL_VALUE_LIMIT = 512 * 1024;

/** 回合阶段：由最近一条流事件推导（text→generating / thinking→thinking / tool 入参→tool）。 */
export type TurnPhase = 'thinking' | 'tool' | 'generating';

/** 最近一次 system/api_retry 瞬态载荷快照（CliSystemInfoEvent subtype==='api_retry' 的有效子集）。 */
export interface TurnApiRetryTransient {
  /** 主进程记录时刻。 */
  observedAt: number;
  retryCount?: number;
  retryLimit?: number;
  nextRetryAt?: number;
  retryDelayMs?: number;
  error?: string;
  errorStatus?: number | null;
  sdkAttempt?: number;
  sdkMaxRetries?: number;
}

/** 后台任务（system task_*）记录：started 建档，progress/notification 刷新 lastProgress。 */
export interface TurnBackgroundTask {
  startedAtServer: number;
  lastProgress?: unknown;
}

/** 内部投影态（单例 Map 持有；对外只经 TurnProjectionSnapshot 快照暴露）。 */
interface TurnProjection {
  sessionId: string;
  /** 回合代际（= SessionEntry.queryInstance）：防旧回合迟到快照污染新回合。 */
  generation: number;
  /** 回合起点（主进程 Date.now()，权威值）。 */
  startedAt: number;
  phase: TurnPhase;
  streamText: string;
  streamThinking: string;
  /** toolUseId → input_json_delta 累积。 */
  streamTool: Record<string, string>;
  truncatedText: boolean;
  truncatedThinking: boolean;
  truncatedTool: Record<string, boolean>;
  /** content_block 的命名空间键（`${parentToolUseId ?? ''}#${index}`）→ toolUseId 映射
   * （tool_use id 只在 content_block_start 上出现；主流程与各子 agent 的 index 空间彼此
   * 独立，R2（round-001）——注册/查询两侧同规则拼键，交错流下同 index 不再互相覆盖）。 */
  toolIndexKeys: Map<string, string>;
  apiRetry: TurnApiRetryTransient | null;
  /** 最近一次 stalled 瞬态（StallInfo 快照）。 */
  stalled: StallInfo | null;
  backgroundTasks: Record<string, TurnBackgroundTask>;
  endedAt: number | null;
  outcome: 'success' | 'error' | 'interrupted' | null;
}

/** 对外快照（getSnapshot 返回；serverNow 由查询时刻回填，供渲染端时钟偏移校正）。 */
export interface TurnProjectionSnapshot {
  sessionId: string;
  generation: number;
  startedAt: number;
  /** 查询时刻主进程时钟。 */
  serverNow: number;
  phase: TurnPhase;
  /** 三路累加器全文 + 存储长度（截断后长度=上限）。 */
  streamText: string;
  streamTextLength: number;
  truncatedText: boolean;
  streamThinking: string;
  streamThinkingLength: number;
  truncatedThinking: boolean;
  streamTool: Record<string, string>;
  truncatedTool: Record<string, boolean>;
  apiRetry: TurnApiRetryTransient | null;
  stalled: StallInfo | null;
  backgroundTasks: Record<string, TurnBackgroundTask>;
  endedAt: number | null;
  outcome: 'success' | 'error' | 'interrupted' | null;
}

/** 进行中回合概览（仅未 ended 的投影）。 */
export interface TurnRunningEntry {
  sessionId: string;
  startedAt: number;
  generation: number;
}

const projections = new Map<string, TurnProjection>();
/** 终态保留期 timer（防 60s 清理器泄漏：覆盖/立即清时先 cancel）。 */
const retentionTimers = new Map<string, ReturnType<typeof setTimeout>>();

function clearRetentionTimer(sessionId: string): void {
  const timer = retentionTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    retentionTimers.delete(sessionId);
  }
}

/** 带上限追加：超限截断并置 truncated（截断后不再追加，标志粘滞）。 */
function appendCapped(current: string, chunk: string, limit: number): { text: string; truncated: boolean } {
  if (current.length >= limit) return { text: current, truncated: true };
  const next = current + chunk;
  if (next.length <= limit) return { text: next, truncated: false };
  return { text: next.slice(0, limit), truncated: true };
}

/**
 * 回合起点登记。同 generation 幂等（重复调用不重置已累积内容，返回既有 startedAt）；
 * 新 generation 覆盖旧投影（连同旧保留 timer 一并作废）。返回本回合权威 startedAt。
 *
 * A2（review-round1 P3 纵深加固）：generation<0（调用方 getCurrentQueryInstance 取不到
 * queryInstance 时的兜底值，理论不可达——spawn 同步 set entry 已核实）时不登记投影，
 * 直接返回 null、不建 Map 项——防不可终态的 -1 代僵尸投影污染 getRunningOverview；
 * 调用方（CHAT_SEND / popExecute / resendUserText 三发射点）仍照常发射 turn_started
 * 事件，startedAt 以发射点 Date.now() 兜底，仅投影/快照侧无记录（emitTurnEnded 对
 * 无投影回合本就只按近似值补发或不发，语义自洽）。
 */
export function noteTurnStarted(sessionId: string, generation: number): number | null {
  // A2：-1 代兜底不建 Map 项（不触碰既有投影与保留 timer，见函数头注释）。
  if (generation < 0) return null;
  const existing = projections.get(sessionId);
  if (existing && existing.generation === generation) {
    // 同代际幂等：不重置已累积内容（含已 ended 态——终态后同代重调不复活投影）。
    return existing.startedAt;
  }
  clearRetentionTimer(sessionId);
  const startedAt = Date.now();
  projections.set(sessionId, {
    sessionId,
    generation,
    startedAt,
    // 首条流事件到达前的默认值；phase 仅在收到流事件后有意义。
    phase: 'generating',
    streamText: '',
    streamThinking: '',
    streamTool: {},
    truncatedText: false,
    truncatedThinking: false,
    truncatedTool: {},
    toolIndexKeys: new Map(),
    apiRetry: null,
    stalled: null,
    backgroundTasks: {},
    endedAt: null,
    outcome: null,
  });
  return startedAt;
}

/** 流事件分流：三路累加 + phase 推导 + toolUseId 命名空间解析。 */
function noteStreamEvent(p: TurnProjection, event: CliStreamEvent): void {
  const se = event.event;
  if (!se) return;
  // content_block_start：登记/清退 index → toolUseId 映射（tool_use 的 id 只在此出现）。
  if (se.type === 'content_block_start') {
    const index = typeof se.index === 'number' ? se.index : null;
    if (index == null) return;
    // R2（round-001）：注册侧按 parentToolUseId 分命名空间——主流程与各子 agent 的 index
    // 空间彼此独立，并行子 agent / 主子交错流下同 index 注册不再互相覆盖（串桶根因）。
    // 键拼装规则与下方 input_json_delta 查询侧严格一致（同一 nsIndex 形态）。
    const nsIndex = `${event.parentToolUseId ?? ''}#${index}`;
    const block = se.content_block;
    if (block && block.type === 'tool_use') {
      const blockId = block.id;
      const key = typeof blockId === 'string' && blockId ? blockId : `#${index}`;
      p.toolIndexKeys.set(nsIndex, key);
    } else {
      // 非 tool_use 块占用该 index：清掉可能残留的旧映射，防串块。
      p.toolIndexKeys.delete(nsIndex);
    }
    return;
  }
  const delta = se.delta;
  if (!delta) return;
  switch (delta.type) {
    case 'text_delta': {
      if (delta.text) {
        const r = appendCapped(p.streamText, delta.text, STREAM_TEXT_LIMIT);
        p.streamText = r.text;
        p.truncatedText = p.truncatedText || r.truncated;
        p.phase = 'generating';
      }
      break;
    }
    case 'thinking_delta': {
      if (delta.thinking) {
        const r = appendCapped(p.streamThinking, delta.thinking, STREAM_TEXT_LIMIT);
        p.streamThinking = r.text;
        p.truncatedThinking = p.truncatedThinking || r.truncated;
        p.phase = 'thinking';
      }
      break;
    }
    case 'input_json_delta': {
      if (delta.partial_json) {
        const index = typeof se.index === 'number' ? se.index : null;
        // R2（round-001）：查询侧与 content_block_start 注册侧同规则拼装命名空间键
        //（`${parentToolUseId ?? ''}#${index}`）——解析 resolved 必须查注册侧写入的同一键。
        const nsIndex = index != null ? `${event.parentToolUseId ?? ''}#${index}` : null;
        const resolved = nsIndex != null ? p.toolIndexKeys.get(nsIndex) ?? `#${index}` : '#unknown';
        // 子 agent 工具入参（带 parentToolUseId）与主流程 index 空间可能重叠，独立命名空间防互踩。
        // 最终 streamTool 键形态不变：子 agent `sub:${parentToolUseId}:${resolved}`，主流程 `${resolved}`。
        const key = event.parentToolUseId ? `sub:${event.parentToolUseId}:${resolved}` : resolved;
        const r = appendCapped(p.streamTool[key] ?? '', delta.partial_json, STREAM_TOOL_VALUE_LIMIT);
        p.streamTool[key] = r.text;
        p.truncatedTool[key] = (p.truncatedTool[key] ?? false) || r.truncated;
        p.phase = 'tool';
      }
      break;
    }
    default:
      // signature_delta / citations_delta / compaction_content_delta：不入三路累加器（规格只收三种增量）。
      break;
  }
}

/** system 子类型分流：api_retry 瞬态 / task_* 后台任务 / 其余忽略。 */
function noteSystemEvent(p: TurnProjection, event: Extract<CliEvent, { type: 'system' }>): void {
  if (event.subtype === 'api_retry') {
    p.apiRetry = {
      observedAt: Date.now(),
      retryCount: event.retryCount,
      retryLimit: event.retryLimit,
      nextRetryAt: event.nextRetryAt,
      retryDelayMs: event.retryDelayMs,
      error: event.error,
      errorStatus: event.errorStatus ?? null,
      sdkAttempt: event.sdkAttempt,
      sdkMaxRetries: event.sdkMaxRetries,
    };
    return;
  }
  if (event.subtype === 'task_started' || event.subtype === 'task_progress' || event.subtype === 'task_notification') {
    if (!event.taskId) return;
    if (event.subtype === 'task_started') {
      p.backgroundTasks[event.taskId] = { startedAtServer: Date.now() };
      return;
    }
    // progress / notification：刷新 lastProgress（started 缺失时防御性建档——迟到 progress 不丢）。
    const entry = p.backgroundTasks[event.taskId] ?? { startedAtServer: Date.now() };
    entry.lastProgress = {
      at: Date.now(),
      subtype: event.subtype,
      status: event.status,
      summary: event.summary,
      lastToolName: event.lastToolName,
      usage: event.usage,
      toolUseId: event.toolUseId,
    };
    p.backgroundTasks[event.taskId] = entry;
  }
  // 其余 system 子类型（init/informational/compacting/permission_* 等）不进投影。
}

/**
 * 唯一事件挂点（forwardEvent / forwardTransient 在推送后追加调用）。
 * 内部按 event.type 分流；终态事件（result/aborted/error）不在此处理——
 * 终态由发射点显式调 noteTurnEnded。无投影记录（未 noteTurnStarted 的回合）或
 * 已终态（迟到事件）一律忽略，保证终态快照稳定。
 */
export function noteTurnEvent(sessionId: string, event: CliEvent): void {
  const p = projections.get(sessionId);
  if (!p || p.endedAt != null) return;
  switch (event.type) {
    case 'stream_event':
      noteStreamEvent(p, event);
      break;
    case 'system':
      noteSystemEvent(p, event);
      break;
    case 'stalled':
      p.stalled = {
        sinceMs: event.sinceMs,
        gapMs: event.gapMs,
        lastKind: event.lastKind,
        pendingAgentId: event.pendingAgentId,
        zone: event.zone,
        stallCount: event.stallCount,
      };
      break;
    default:
      // message/result/aborted/error/tool_progress/api_retry_terminal 等不进投影
      //（message 全量已落库，投影只服务进行态；终态走 noteTurnEnded）。
      break;
  }
}

/** 投影快照（无记录返回 null——终态 60s 保留期内仍可查，期满/清除后 null）。 */
export function getSnapshot(sessionId: string): TurnProjectionSnapshot | null {
  const p = projections.get(sessionId);
  if (!p) return null;
  const backgroundTasks: Record<string, TurnBackgroundTask> = {};
  for (const [taskId, task] of Object.entries(p.backgroundTasks)) {
    backgroundTasks[taskId] = { ...task };
  }
  return {
    sessionId: p.sessionId,
    generation: p.generation,
    startedAt: p.startedAt,
    serverNow: Date.now(),
    phase: p.phase,
    streamText: p.streamText,
    streamTextLength: p.streamText.length,
    truncatedText: p.truncatedText,
    streamThinking: p.streamThinking,
    streamThinkingLength: p.streamThinking.length,
    truncatedThinking: p.truncatedThinking,
    streamTool: { ...p.streamTool },
    truncatedTool: { ...p.truncatedTool },
    apiRetry: p.apiRetry ? { ...p.apiRetry } : null,
    stalled: p.stalled ? { ...p.stalled } : null,
    backgroundTasks,
    endedAt: p.endedAt,
    outcome: p.outcome,
  };
}

/** 进行中回合概览（仅未 ended 的投影；供「哪些回合在跑」类查询）。 */
export function getRunningOverview(): TurnRunningEntry[] {
  const running: TurnRunningEntry[] = [];
  for (const p of projections.values()) {
    if (p.endedAt != null) continue;
    running.push({ sessionId: p.sessionId, startedAt: p.startedAt, generation: p.generation });
  }
  return running;
}

/**
 * 回合终态登记：generation 不匹配（旧回合迟到终态）或已结算时 no-op（幂等）。
 * 登记后投影保留 TERMINAL_RETENTION_MS 供迟到快照查询，期满自动清除。
 */
export function noteTurnEnded(sessionId: string, generation: number, outcome: 'success' | 'error' | 'interrupted'): void {
  const p = projections.get(sessionId);
  if (!p || p.generation !== generation || p.endedAt != null) return;
  p.endedAt = Date.now();
  p.outcome = outcome;
  clearRetentionTimer(sessionId);
  const timer = setTimeout(() => {
    retentionTimers.delete(sessionId);
    // 到期仍可能是更新代际的投影吗？不会：noteTurnStarted 新代际必先 clearRetentionTimer，
    // 该回调只可能在未被覆盖时执行；防御性按引用比对再删。
    if (projections.get(sessionId) === p) projections.delete(sessionId);
  }, TERMINAL_RETENTION_MS);
  if (typeof timer.unref === 'function') timer.unref();
  retentionTimers.set(sessionId, timer);
}

/** 立即清（会话删除 markSessionDeleted 收口调用）。 */
export function clearSession(sessionId: string): void {
  clearRetentionTimer(sessionId);
  projections.delete(sessionId);
}

/** 测试注入用：清全部投影与保留 timer。 */
export function reset(): void {
  for (const timer of retentionTimers.values()) clearTimeout(timer);
  retentionTimers.clear();
  projections.clear();
}
