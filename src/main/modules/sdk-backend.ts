// sdk-backend.ts
// Claude Agent SDK 适配器：用 @anthropic-ai/claude-agent-sdk 的 query() 接入 Claude Code。
//
// 这是 claude-link 的唯一聊天/任务后端（chat-backend.ts re-export 自本模块）。
//
// 设计要点：
//  - SDKMessage → CliEvent 转换（形态高度同构），转换出的事件复用 cli-shared 的
//    persistCliEvent / persistMessageParts 落库，并通过 CHAT_EVENT 推前端——前端零改。
//  - Query.interrupt() 走 stdin 控制帧，跨平台（含 Windows）优雅中断当前回合。
//  - buildSpawnEnv 复用（来自 cli-shared）：env（含 apiKey/baseUrl/模型映射）原样喂给
//    Options.env，第三方端点跑通。
//  - pathToClaudeCodeExecutable 取 getConfig().cliPath（cli-detector 发现的系统 claude），
//    不依赖 SDK 自带二进制，规避 Electron 打包坑。
//
// SDK 是纯 ESM（"type":"module"），项目 main 进程经 electron-vite 编译为 CJS，
// 故用模块级缓存的动态 import() 加载 SDK，避免 CJS 静态 import ESM 的语法限制。

import type { BrowserWindow } from 'electron';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import { getConfig, getProviderModelSources } from './config-manager';
import { resolveAliasToActualModel, resolveDefaultModel } from '../../shared/settings-parser';
import { resolveSessionModel, buildUnifiedModelEnv, decideAgentModelOverride } from '../../shared/session-model';
import { resolveContextWindowForSession, lookupUserContextWindow } from '../../shared/model-context-windows';
import { resolveEffectiveThinkingLevel, resolveThinkingConfig, type ThinkingConfigResult } from '../../shared/thinking-resolver';
import { isSuccessfulCliResult } from '../../shared/session-completion';
import { convertResultMessage } from '../../shared/result-converter';
import { notifySessionCompleted, notifySessionNetworkInterrupted } from './session-completion-notifier';
import { logger } from '../utils/logger';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import { extractContextTokens, detectCompaction } from '../../shared/context-usage';
import { convertToolProgress, convertTaskEvent } from '../../shared/progress-events';
import {
  parseTodoWriteInput,
  parseTodoWriteOutput,
  parseTaskCreateInput,
  parseTaskCreateOutput,
  parseTaskUpdateInput,
  parseTaskListOutput,
  parseTaskGetOutput,
  parseTaskUpdatedPatch,
} from '../../shared/types/claude-plan';
import type { ClaudePlanTask, ClaudePlanState, ClaudePlanTaskPatch } from '../../shared/types/claude-plan';
import * as claudePlanRepo from '../database/repositories/claude-plan-repo';
import { isDisplayableSystemInfo } from '../../shared/system-info';
import type { ContextStatsPayload } from '../../shared/types/ipc';
import type { AppConfig } from '../../shared/types/config';
import type { CommandChangedPayload, CommandOriginContext, SessionCommandSnapshot } from '../../shared/types/command';
import type {
  CliEvent,
  CliMessageContentPart,
  CliMessageEvent,
  CliStreamEvent,
  CliSystemInfoEvent,
  CliPermissionEvent,
  ClaudePlanCliEvent,
} from '../../shared/types/cli';
import type { SpawnOptions, SessionModelOverride } from './cli-shared';
// 复用 cli-shared 的纯函数（env 注入 / 落库）。
import {
  buildSpawnEnv,
  normalizeToolResultContent,
  persistCliEvent,
  persistMessageParts,
} from './cli-shared';
import { isMissingConversationResumeError } from './sdk-errors';
import type {
  Options as SdkOptions,
  Query as SdkQuery,
  SDKUserMessage,
} from '@anthropic-ai/claude-agent-sdk';
import type { SdkPrompt } from './attachment-prompt-builder';
import { cancelInteractionsForSession, requestInteraction } from './interaction-prompts';
import {
  SUPPORTED_USER_DIALOG_KINDS,
  buildPermissionInteractionPayload,
  createElicitationHandler,
  createUserDialogHandler,
  isAskUserQuestionPayload,
  mapPermissionInteractionResponse,
  requestAskUserQuestionInteractions,
  type CanUseToolOptions,
  type PermissionResult,
} from './sdk-interactions';
import { buildClaudeSettingsProjection } from './claude-settings-projection';
import {
  applyPermissionUpdates,
  coercePermissionUpdatesToSession,
  isToolSessionAllowed,
  type PermissionUpdate,
  type SdkPermissionSettings,
} from './sdk-permissions';
import { sdkCommandRegistry } from './sdk-command-registry';
import { buildNativeSdkOptionsCore, mergeSpawnOptions } from './sdk-command-options';
import { buildCommandOriginEvidence } from './sdk-command-origin';
import { isSubAgentToolUse } from '../../shared/process-kind';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind, type StallInfo, type StallThresholds } from '../../shared/stall-watchdog';
import {
  apiRetrySummary,
  createApiRetryState,
  recordApiRetry,
  recordApiRetryExhausted,
  recordApiRetryRecovery,
  recordApiRetryUserStop,
  toApiRetryTerminalDetails,
  type ApiRetryState,
  type ApiRetryTerminalKind,
} from '../../shared/api-retry-state';

// 显式标注上述工具被复用（避免 lint 误报未使用）；persistMessageParts/normalizeToolResultContent
// 在 convertAssistantMessage 后落库路径会用到。
void normalizeToolResultContent;
void persistMessageParts;

// ── SDK 动态加载（ESM）─────────────────────────────────────────────
// query() 返回 Query（AsyncGenerator<SDKMessage> + interrupt()/setPermissionMode()）。
// 这里只引 type，运行时值由 importSdk() 动态获取。
// prompt 与 Agent SDK 对齐：纯文字 string；含图片时 AsyncIterable<SDKUserMessage>。
// SDK 官方 Query/Options 契约（sdk.d.ts:1246/2194）：仅在本地 wrapper 上保留当前后端
// 需要的 optional getContextUsage 兼容字段，不再用 Record<string, unknown> 抹掉 SDK 类型检查。
type Query = SdkQuery;

interface SdkModule {
  query: (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: SdkOptions }) => Query;
}

let sdkPromise: Promise<SdkModule> | null = null;
async function importSdk(): Promise<SdkModule> {
  if (!sdkPromise) {
    sdkPromise = import('@anthropic-ai/claude-agent-sdk') as unknown as Promise<SdkModule>;
  }
  return sdkPromise;
}

// ── 会话→query 句柄 映射（替代 process-manager 的 processes Map）────────
// 这是进程级单例：SDK 后端与 process-manager 不会同时持有同一 session，但二者各自维护
// 独立 Map 互不影响；回退到 process-manager 时本 Map 自然空置。
// 关键：handle + emit 闭包在 entry 创建时一次成型，runQuery 复用同一套，
// 确保 spawn 时注册的 on('exit') 回调能被 runQuery 的 emitExit 触发。
interface SessionEntry {
  query: Query | null;
  handle: SdkQueryHandle;
  state: 'pending' | 'running' | 'aborting' | 'finished';
  emitExit: (code: number | null) => void;
  emitError: (err: Error) => void;
  // 官方 Options.abortController：query() 传入后，abort() 会在 Windows 上经 SDK
  // → TerminateProcess（瞬时不可捕获），打不死卡死在死 socket 上的子进程时兜底硬杀。
  abortController: AbortController | null;
  // 启动时解析出的当前实际模型 ID（供应商库解析；库空时为老别名链结果）。
  // persistCliEvent 推送初始 windowSize 按它查上下文覆盖；canUseTool 的 Agent/Task
  // 调用级 model 改写（唯一实际模型·第二层保险）也读它。
  requestedAlias: string | null;
  // 本次 query 解析出的「当前实际模型」ID（resolveSessionModel 结果；库空时 null）。
  // 与 requestedAlias 分开存：requestedAlias 兼作上下文窗口查询键，resolvedModel
  // 语义上只表示「子代理也必须统一到它」的当前实际模型。
  resolvedModel: string | null;
  // 仅用于日志区分同一 Query 内部重试与 stale resume 重建的新 Query。
  queryInstance: number;
}
const nextQueryInstance = { value: 1 };

const entries = new Map<string, SessionEntry>();
const sessionCliIds = new Map<string, string>();
// Task 2：每会话的命令来源分类上下文（system.init 的 skills/plugins/slash_commands）。
// replace/commands_changed 需要它把 SDK 原始命令正确分类（user-skill/plugin/builtin）。
// 会话删除时必须在 markSessionDeleted 清理（单一收口）。
const sessionCommandCtx = new Map<string, CommandOriginContext>();
// review-v1 §5.1：init 时的 cwd + plugin 路径（plugins 路径不在 CommandOriginContext 中，单独保存）。
// commands_changed 时按当前磁盘状态重建 evidence 需要这些种子——init 时冻结的 evidence 不反映会话过程中
// 新增/修改/删除的项目命令文件（.claude/skills、.claude/commands）。
interface CommandProvenanceSeed {
  cwd: string | undefined;
  plugins: Array<{ name: string; path?: string }>;
}
const sessionProvenanceSeeds = new Map<string, CommandProvenanceSeed>();
// 中断标记按 query 实例（与 process-manager 的 interruptedChildren 思路一致，避免跨回合串扰）。
const interruptedQueries = new WeakSet<Query>();
// 内存级"会话是否仍存活"集合。删会话时移除，runQuery/forwardEvent 据此在落库前判活，
// 避免：1) 孤儿 query 继续往已被级联删空的 messages 表 INSERT 触发外键失败回滚；
//      2) 反复同步 DB 操作阻塞主进程事件循环导致所有输入框失效。
// 比 sessionRepo.getSession() 轻得多（内存 Set.has vs 索引查询）。
const activeSessions = new Set<string>();
// 问题 4：缓存每会话最近一次上下文用量。CC 自动压缩事件（compact_boundary）不带
// usage，emit CONTEXT_UPDATE 时沿用此缓存，避免前端收到压缩标记但占比回零闪烁。
interface CachedContextStats {
  inputTokens: number;
  outputTokens: number;
  windowSize: number;
}
const sessionContextStats = new Map<string, CachedContextStats>();
// 批次 B：thinking_tokens 限频状态（per-session）。estimated_tokens 是思考阶段高频流式帧，
// 仅当「值变化 且 距上次转发 ≥ THINKING_TOKENS_THROTTLE_MS」才转发，防 IPC 淹没（review-v2 F9）。
// estimated_tokens 在一个思考块内单调递增，丢中间帧不影响最终峰值被后续帧追平。
const THINKING_TOKENS_THROTTLE_MS = 100;
const sessionThinkingTokenThrottle = new Map<string, { lastSentAt: number; lastValue: number }>();
function shouldForwardThinkingTokens(sessionId: string, value: number): boolean {
  const now = Date.now();
  const t = sessionThinkingTokenThrottle.get(sessionId);
  if (t) {
    if (t.lastValue === value) return false; // 值未变：丢弃
    if (now - t.lastSentAt < THINKING_TOKENS_THROTTLE_MS) return false; // 限频窗口内：丢弃
  }
  sessionThinkingTokenThrottle.set(sessionId, { lastSentAt: now, lastValue: value });
  return true;
}
// allow-session 权限更新是 SDK query 内状态；claude-link 后续消息会新建 query + resume，
// 因此按 app session 暂存 destination:'session' 的规则，并在下一次 buildSdkOptions 注入 settings.permissions。
const sessionPermissionUpdates = new Map<string, PermissionUpdate[]>();

function rememberSessionPermissionUpdates(sessionId: string, updates: PermissionUpdate[] | undefined): void {
  const sessionUpdates = coercePermissionUpdatesToSession(updates);
  if (!sessionUpdates.length) return;
  sessionPermissionUpdates.set(sessionId, [...(sessionPermissionUpdates.get(sessionId) ?? []), ...sessionUpdates]);
}

function applySessionPermissionUpdates(sessionId: string, permissions: SdkPermissionSettings): SdkPermissionSettings {
  return applyPermissionUpdates(permissions, sessionPermissionUpdates.get(sessionId));
}

// ── 卡死检测：每会话活动追踪 ────────────────────────────────────────
// 任何真实上游业务事件（assistant/user/stream_event/tool_progress/system/api_retry）
// 都刷新 lastActivityAt；keep_alive 仅记录诊断，不重置业务静默计时。
// 看门狗 setInterval(5s) 扫描，距上次业务活动超阈值 → 发 stalled。
interface StallTracker {
  lastActivityAt: number;
  lastKind: string;
  lastKeepAliveAt: number | null;
  lastParentAgentId: string | null;
  pendingToolUse: boolean;
  stalledSince: number | null;
  stallNotified: boolean;
  stallCount: number;
  hardAbortFired: boolean;
}
const stallTrackers = new Map<string, StallTracker>();
// 待决 tool_use id 集合（判定 zone：有无工具在跑）。add on tool_use，delete on tool_result。
const pendingToolUseIds = new Map<string, Set<string>>();
// 待决子 Agent/Workflow tool_use id 集合（用于横幅定位疑似卡住的子 Agent）。
const pendingSubAgentUseIds = new Map<string, Set<string>>();
function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isInteger(n) && n > 0 ? n : dflt;
}
// 阈值可用环境变量覆盖（CLAUDE_LINK_STALL_MODEL_MS / _TOOL_MS / _HARD_MS / _TOOL_HARD_MS），默认见 stall-watchdog.ts。
const STALL_THRESHOLDS: StallThresholds = {
  modelGapMs: envInt('CLAUDE_LINK_STALL_MODEL_MS', DEFAULT_STALL_THRESHOLDS.modelGapMs),
  toolPendingMs: envInt('CLAUDE_LINK_STALL_TOOL_MS', DEFAULT_STALL_THRESHOLDS.toolPendingMs),
  hardAutoAbortMs: envInt('CLAUDE_LINK_STALL_HARD_MS', DEFAULT_STALL_THRESHOLDS.hardAutoAbortMs),
  // TOOL 区绝对硬中断上限（兜子 Agent 死锁/死连接；合法长工具持续发 tool_progress 不会误触）。
  toolHardAbortMs: envInt('CLAUDE_LINK_STALL_TOOL_HARD_MS', DEFAULT_STALL_THRESHOLDS.toolHardAbortMs),
};
// SDK 未携带 max_retries 时，供本地状态机与 UI 保持数值完整性的展示回退值。
// 不写入 Claude Code 环境变量，因此不影响其实际重试策略。
const API_RETRY_LIMIT_FALLBACK = 10;
const apiRetryStates = new Map<string, ApiRetryState>();
const STALL_TICK_MS = 5_000;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let watchdogWindow: BrowserWindow | null = null;

function resetStallTracker(sessionId: string): void {
  stallTrackers.set(sessionId, {
    lastActivityAt: Date.now(),
    lastKind: 'query_start',
    lastKeepAliveAt: null,
    lastParentAgentId: null,
    pendingToolUse: false,
    stalledSince: null,
    stallNotified: false,
    stallCount: 0,
    hardAbortFired: false,
  });
  pendingToolUseIds.delete(sessionId);
  pendingSubAgentUseIds.delete(sessionId);
}

function cleanupSessionStall(sessionId: string): void {
  stallTrackers.delete(sessionId);
  pendingToolUseIds.delete(sessionId);
  pendingSubAgentUseIds.delete(sessionId);
}

// 活动刷新原语：更新最后业务活动时间/类型并清卡死标记。
function touchActivity(sessionId: string, kind: string): void {
  if (!isBusinessStallActivityKind(kind)) return;
  const t = stallTrackers.get(sessionId);
  if (!t) return;
  t.lastActivityAt = Date.now();
  t.lastKind = kind;
  if (t.stalledSince !== null) {
    t.stalledSince = null;
    t.stallNotified = false;
  }
}

// keep_alive 只证明 SDK/子进程还活着，不代表 API/模型/工具有业务进展；只记诊断时间，
// 不刷新 lastActivityAt，否则代理网关死等但持续心跳时会永远不触发 stalled。
function touchKeepAlive(sessionId: string): void {
  const t = stallTrackers.get(sessionId);
  if (!t) return;
  t.lastKeepAliveAt = Date.now();
}

// 从一个 CliEvent 推导并刷新活动状态。合成/终态事件（stalled/error/aborted/result）
// 不计入「上游活跃」——否则发 stalled 会自我复位卡死时钟。
function touchActivityFromEvent(sessionId: string, event: CliEvent): void {
  if (!isBusinessStallActivityKind(event.type)) {
    return;
  }
  const t = stallTrackers.get(sessionId);
  if (!t) return;
  // api_retry 是失败信号而非业务进展：权威次数由 apiRetryStates 维护；
  // 这里仍须按 system 子类型提前返回，避免重试风暴刷新 stall 时间。
  if (event.type === 'system' && (event as CliSystemInfoEvent).subtype === 'api_retry') {
    return;
  }
  let set = pendingToolUseIds.get(sessionId);
  if (!set) {
    set = new Set();
    pendingToolUseIds.set(sessionId, set);
  }
  let subAgentSet = pendingSubAgentUseIds.get(sessionId);
  if (!subAgentSet) {
    subAgentSet = new Set();
    pendingSubAgentUseIds.set(sessionId, subAgentSet);
  }
  if (event.type === 'tool_progress') {
    if (event.toolUseId) set.add(event.toolUseId);
    if (event.parentToolUseId) t.lastParentAgentId = event.parentToolUseId;
  }
  if (event.type === 'system') {
    if ((event.subtype === 'task_started' || event.subtype === 'task_progress') && event.toolUseId) {
      set.add(event.toolUseId);
      t.lastParentAgentId = event.toolUseId;
    } else if (event.subtype === 'task_notification' && event.toolUseId) {
      set.delete(event.toolUseId);
      subAgentSet.delete(event.toolUseId);
      if (t.lastParentAgentId === event.toolUseId) t.lastParentAgentId = Array.from(subAgentSet).at(-1) ?? null;
    }
  }
  if (event.type === 'message') {
    for (const part of event.content) {
      if (part.type === 'tool_use' || part.type === 'server_tool_use' || part.type === 'mcp_tool_use') {
        const id = part.id ?? part.tool_use_id;
        if (id) {
          set.add(id);
          // 主流程刚发出 Agent/Task/Workflow/Skill tool_use 后，子 Agent 可能还没吐出
          // parentToolUseId 事件就卡住；先记录该 tool_use id，横幅即可定位疑似卡住的子 Agent。
          if (!event.parentToolUseId && isSubAgentToolUse(part)) {
            subAgentSet.add(id);
            t.lastParentAgentId = id;
          }
        }
      } else if (
        part.type === 'tool_result' ||
        part.type === 'web_search_tool_result' ||
        part.type === 'web_fetch_tool_result' ||
        part.type === 'code_execution_tool_result' ||
        part.type === 'mcp_tool_result'
      ) {
        if (part.tool_use_id) {
          set.delete(part.tool_use_id);
          subAgentSet.delete(part.tool_use_id);
          if (t.lastParentAgentId === part.tool_use_id) {
            t.lastParentAgentId = Array.from(subAgentSet).at(-1) ?? null;
          }
        }
      }
    }
    if (event.parentToolUseId) t.lastParentAgentId = event.parentToolUseId;
  }
  t.pendingToolUse = set.size > 0;
  touchActivity(sessionId, event.type);
}

function ensureWatchdog(mainWindow: BrowserWindow): void {
  watchdogWindow = mainWindow;
  if (watchdogTimer) return;
  watchdogTimer = setInterval(watchdogTick, STALL_TICK_MS);
  // unref：看门狗计时器不得阻止 Electron 退出（app.quit() 仍会终止进程，此为卫生性兜底）。
  if (watchdogTimer && typeof watchdogTimer.unref === 'function') {
    watchdogTimer.unref();
  }
}

function watchdogTick(): void {
  const mw = watchdogWindow;
  if (!mw || mw.isDestroyed()) return;
  const now = Date.now();
  for (const [sessionId, t] of stallTrackers) {
    if (!isSessionActive(sessionId)) continue;
    const verdict = classifyStall(t.lastActivityAt, now, t.pendingToolUse, STALL_THRESHOLDS);
    if (!verdict.stalled) {
      // 活跃：清标记，下次再卡可再次通知。
      if (t.stallNotified) {
        t.stallNotified = false;
        t.stalledSince = null;
      }
      continue;
    }
    // stalledSince = 首次判定卡死的时刻（非 lastActivityAt）：sinceMs = 自卡死判定至今
    //（与 gapMs=总静默 区分：gapMs 给横幅「已 Ns 无响应」，sinceMs 表卡死已持续多久）。
    if (t.stalledSince === null) t.stalledSince = now;
    const sinceMs = now - (t.stalledSince ?? now);
    // 首次到达阈值：发一次 stalled（forwardTransient 不落库，纯状态横幅）。
    if (!t.stallNotified) {
      t.stallNotified = true;
      t.stallCount += 1;
      const info: StallInfo = {
        sinceMs,
        gapMs: verdict.gapMs,
        lastKind: t.lastKind,
        pendingAgentId: t.lastParentAgentId,
        zone: verdict.zone,
        stallCount: t.stallCount,
      };
      forwardTransient(sessionId, mw, { type: 'stalled', ...info });
      logger.warn(`[stall] session ${sessionId} 无响应 ${Math.round(verdict.gapMs / 1000)}s（zone=${verdict.zone}, lastKind=${t.lastKind}, agent=${t.lastParentAgentId ?? '-'}, count=${t.stallCount}）`);
    }
    // 硬中断：静默累计到 zone 上限 → killProcess（abortController 真硬杀）。每回合只发一次。
    // model 区=模型服务卡死；tool 区=子任务/工具死锁或死连接（长工具会持续发 tool_progress，不会到这）。
    if (verdict.hardAbort && !t.hardAbortFired) {
      t.hardAbortFired = true;
      const secs = Math.round(verdict.gapMs / 1000);
      const reason =
        verdict.zone === 'tool'
          ? `子任务/工具已 ${secs} 秒无进展，判定卡死（死连接/死锁），已自动中断。可点击「重试」重新发送。`
          : `已 ${secs} 秒无响应，判定模型服务卡死，已自动中断。可点击「重试」重新发送。`;
      forwardEvent(sessionId, mw, { type: 'error', message: reason });
      logger.error(`[stall] hard auto-abort session ${sessionId}: ${secs}s ${verdict.zone}-zone silence`);
      killProcess(sessionId, 'watchdog', mw);
    }
  }
}

// 标记会话已删除：runQuery 下轮迭代检测到即自停，forwardEvent 落库前也据此跳过。
export function markSessionDeleted(sessionId: string): void {
  activeSessions.delete(sessionId);
  cancelInteractionsForSession(sessionId);
  pendingFirstPrompt.delete(sessionId);
  const entry = entries.get(sessionId);
  if (entry) {
    abortEntry(entry);
    removeEntryIfCurrent(sessionId, entry);
  }
  // 清理上下文/权限/CLI resume 缓存，避免会话删除后 stale 数据堆积（内存泄漏）。
  sessionContextStats.delete(sessionId);
  sessionPermissionUpdates.delete(sessionId);
  sessionCliIds.delete(sessionId);
  contextUsageDiagnosed.delete(sessionId);
  sessionCommandCtx.delete(sessionId); // Task 2：命令分类上下文按会话清理（单一收口）
  sessionProvenanceSeeds.delete(sessionId); // review-v1 §5.1：provenance 种子同生命周期清理
  // 原生 Slash Commands：会话删除时取消正在进行的命令探测并清理快照，避免 stale 命令堆积与 A/B 串扰。
  // cancelCommandProbeInternal 用 0 超时 fire-and-forget（abort 同步触发，probe 异步自行退出）。
  void cancelCommandProbeInternal(sessionId, 0);
  sdkCommandRegistry.clear(sessionId);
  cleanupToolUseCache(sessionId);
  cleanupSessionStall(sessionId);
  apiRetryStates.delete(sessionId);
  sessionThinkingTokenThrottle.delete(sessionId);
}
export function markSessionActive(sessionId: string): void {
  activeSessions.add(sessionId);
}
function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

function recordInteractionResponse(sessionId: string, mainWindow: BrowserWindow, title: string, summary: string): void {
  forwardEvent(sessionId, mainWindow, {
    type: 'system',
    subtype: 'interaction_response',
    text: `${title}\n${summary}`,
    level: 'info',
  });
}

// 诊断用：列出会话小本本里「裸 allow」的工具名（整工具放行）。定位权限重复弹窗后可移除。
function bookToolNames(updates: PermissionUpdate[] | undefined): string[] {
  return (updates ?? []).flatMap((update) => {
    if (update.destination !== 'session' || (update.type !== 'addRules' && update.type !== 'replaceRules') || update.behavior !== 'allow') {
      return [];
    }
    return update.rules.filter((rule) => !rule.ruleContent).map((rule) => rule.toolName);
  });
}

function createPermissionHandler(sessionId: string, mainWindow: BrowserWindow, workingDir: string | null) {
  void workingDir;
  return async (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
    if (!isSessionActive(sessionId)) {
      return { behavior: 'deny', message: '会话已关闭', interrupt: true, toolUseID: options.toolUseID };
    }

    // 唯一实际模型·第二层保险（doc2 §5.3）：Agent/Task 工具调用级 model 改写。
    // 调用级 model 优先于 agent 定义 frontmatter（sdk-tools.d.ts AgentInput.model），
    // 把入参 model 钉到本会话当前实际模型，杜绝 agent 定义/模型自行传 haiku 等别名
    // 绕过会话选择。fork 天然继承 parent 不改；该分支无条件放行（仅改写入参），
    // 不引入额外权限询问，且必须在下方「本会话已授权」本地短路之前。
    const currentModel = entries.get(sessionId)?.resolvedModel ?? null;
    const rewriteModel = decideAgentModelOverride(toolName, input, currentModel);
    if (rewriteModel) {
      logger.info(`[canUseTool] Agent/Task model 改写为当前实际模型：${String(input.model)} -> ${rewriteModel}`);
      return { behavior: 'allow', updatedInput: { ...input, model: rewriteModel }, toolUseID: options.toolUseID };
    }

    if (toolName === 'AskUserQuestion' && isAskUserQuestionPayload(input)) {
      const result = await requestAskUserQuestionInteractions(sessionId, mainWindow, input, options);
      if (result) {
        recordInteractionResponse(sessionId, mainWindow, '用户完成选择题', Object.entries(result.answers).map(([question, answer]) => `${question}: ${answer}`).join('\n'));
        return { behavior: 'allow', updatedInput: { ...result }, toolUseID: options.toolUseID };
      }
      return { behavior: 'deny', message: '用户取消了选择题交互', toolUseID: options.toolUseID };
    }

    // 本会话已授权的工具直接放行（本地短路）：用户点过「本会话总是允许」后，allow-session 经
    // withToolSessionAllow 在 sessionPermissionUpdates 写入该工具的裸 allow 规则。CLI 在 headless
    // (stdio) 模式下不会据此自动跳过后续同工具 prompt，故 claude-link 自行短路，避免同一会话同一工具
    // 反复弹窗。短路跨 query 生效（sessionPermissionUpdates 按 app session 缓存，新 query 复用）。
    // 不发 permission_request 系统消息、不入交互历史——用户已授权，无需再留痕。
    const sessionBook = sessionPermissionUpdates.get(sessionId);
    const sessionAllowed = isToolSessionAllowed(sessionBook, toolName);
    logger.info(`[canUseTool] tool=${toolName} shortCircuit=${sessionAllowed} bookTools=[${bookToolNames(sessionBook).join(',')}]`);

    if (sessionAllowed) {
      return { behavior: 'allow', updatedInput: input, toolUseID: options.toolUseID };
    }

    const payload = buildPermissionInteractionPayload(sessionId, toolName, input, options);

    forwardEvent(sessionId, mainWindow, {
      type: 'system',
      subtype: 'permission_request',
      tool_name: toolName,
      tool_use_id: options.toolUseID,
      message: payload.title,
    });

    const response = await requestInteraction(mainWindow, payload, options.signal);
    const result = mapPermissionInteractionResponse(payload, response, input);
    const updatedPermissions = result.behavior === 'allow' ? result.updatedPermissions : undefined;
    if (updatedPermissions) {
      rememberSessionPermissionUpdates(sessionId, updatedPermissions);
    }
    logger.info(`[canUseTool-resp] tool=${toolName} action=${response.action} selected=${JSON.stringify(response.selectedOptionIds ?? null)} wrotePerm=${updatedPermissions?.length ?? 0} bookToolsAfter=[${bookToolNames(sessionPermissionUpdates.get(sessionId)).join(',')}]`);
    recordInteractionResponse(sessionId, mainWindow, payload.title, response.action === 'submit' ? `选择：${response.selectedOptionIds?.join(', ') ?? '提交'}` : '已取消');
    return result;
  };
}

// ── 句柄：鸭子类型 ChildProcess 的 exit 语义 ────────────────────────
// task-queue-engine 依赖 child.on('exit', code) 推进队列，这里提供同形 on('exit')/on('error')。
interface SdkQueryHandle {
  killed: boolean;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  interrupt(): void;
}

// 创建一个 entry（handle + emit 闭包一次成型）。所有方共享这一套，杜绝二次创建导致回调失效。
function createEntry(): SessionEntry {
  const exitCbs: Array<(code: number | null) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  let exitEmitted = false;
  const handle: SdkQueryHandle = {
    killed: false,
    on(event, cb) {
      if (event === 'exit') exitCbs.push(cb as (code: number | null) => void);
      else if (event === 'error') errorCbs.push(cb as (err: Error) => void);
    },
    interrupt() {
      handle.killed = true;
    },
  };
  const entry: SessionEntry = {
    query: null,
    handle,
    state: 'pending',
    abortController: null,
    requestedAlias: null,
    resolvedModel: null,
    queryInstance: nextQueryInstance.value++,
    emitExit: (code) => {
      if (exitEmitted) return;
      exitEmitted = true;
      handle.killed = true;
      if (entry.state !== 'aborting') entry.state = 'finished';
      for (const cb of exitCbs) {
        try {
          cb(code);
        } catch (e) {
          logger.error('exit callback threw', e);
        }
      }
    },
    emitError: (err) => {
      for (const cb of errorCbs) {
        try {
          cb(err);
        } catch (e) {
          logger.error('error callback threw', e);
        }
      }
    },
  };
  return entry;
}

// 统一 entry + 卡死 tracker 清理（runQuery 的多个退出点共用，防泄漏）。
function isEntryActive(entry: SessionEntry | undefined): entry is SessionEntry {
  return !!entry && entry.state !== 'aborting' && entry.state !== 'finished' && !entry.handle.killed;
}

function markEntryAborting(entry: SessionEntry): void {
  entry.state = 'aborting';
  entry.handle.interrupt();
}

function abortEntry(entry: SessionEntry): void {
  markEntryAborting(entry);
  try {
    entry.abortController?.abort();
  } catch {
    // abort 已触发过等异常忽略
  }
}

function isCurrentEntry(sessionId: string, entry: SessionEntry): boolean {
  return entries.get(sessionId) === entry && entry.state !== 'aborting';
}

function removeEntryIfCurrent(sessionId: string, entry: SessionEntry): void {
  if (entries.get(sessionId) === entry) entries.delete(sessionId);
}

// 统一 entry + 卡死 tracker 清理（runQuery 的多个退出点共用，防泄漏）。
function deleteEntry(sessionId: string, entry: SessionEntry): void {
  const isCurrent = entries.get(sessionId) === entry;
  if (isCurrent) {
    entries.delete(sessionId);
    cleanupSessionStall(sessionId);
    apiRetryStates.delete(sessionId);
    // F15: 回合结束清理 toolUse 缓存，防止中断/崩溃后泄漏
    cleanupToolUseCache(sessionId);
  }
}

// ── 读取初始上下文窗口（SDK 未上报真实值时的兜底）────────────────────
// 按当前会话请求的别名/真实模型名查用户设的覆盖（env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>），
// 命中则返回，否则 200k。与渲染层 resolveContextWindow 共享优先级语义，避免主进程推送的
// 初始值覆盖前端 switchSession 已算出的正确分母。aliasOrModel 来自 entry.requestedAlias。
function readContextWindow(aliasOrModel?: string | null): number {
  try {
    const config = getConfig();
    return resolveContextWindowForSession({
      aliasOrModel: aliasOrModel ?? null,
      advancedJson: config.advancedJson,
      contextWindowByAlias: config.contextWindowByAlias,
    });
  } catch {
    // ignore
  }
  return 200000;
}

// 把 config.cliPath（可能是裸命令名 'claude' 或 'npx claude'）解析成 SDK 能直接 spawn 的绝对路径。
// SDK 的 pathToClaudeCodeExecutable 不走 shell，要求真正的可执行二进制：
//  - Windows：只接受 .exe。npm 装的 claude 表面是 .cmd shim，但 shim 背后就是真正的
//    bin/claude.exe（PE 二进制），解析 .cmd 内容即可拿到，SDK 直接 spawn 它。
//  - *nix：which 返回的就是可执行文件。
// 项目宗旨：要求用户本地安装 Claude Code，不内嵌二进制。解析不到则返回 undefined，
// 由 runQuery 给出中文提示（本地没装 claude 即不可用）。
function isLikelyExecutable(p: string): boolean {
  if (!p) return false;
  if (process.platform === 'win32') {
    // Windows：SDK 只能直接 spawn 真正的 PE 二进制（.exe）。
    const lower = p.toLowerCase();
    return lower.endsWith('.exe');
  }
  // *nix：which 返回的即可执行
  return true;
}

// 解析 Windows .cmd/.bat shim，提取它最终 spawn 的真正 .exe（.cmd 不能直接 spawn）。
// 典型 npm shim 内容: "%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*
// %dp0% / %~dp0 是 shim 自身所在目录（含尾部分隔符）。
function resolveFromCmdShim(cmdPath: string): string | undefined {
  try {
    const text = readFileSync(cmdPath, 'utf8');
    const dir = path.dirname(cmdPath);
    const m = text.match(/"[^"]*?\.exe"|[\w./\\:-]+\.exe/i);
    if (!m) return undefined;
    let p = m[0]
      .replace(/"/g, '')
      .replace(/%dp0%/gi, dir + path.sep)
      .replace(/%~dp0/gi, dir + path.sep);
    if (!path.isAbsolute(p)) p = path.join(dir, p);
    p = path.normalize(p); // 清理 %dp0%\ 自带尾部分隔符与原 .cmd 后续 \ 叠加产生的双斜杠
    return existsSync(p) && isLikelyExecutable(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function resolveExecutable(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // 含空格（如 'npx claude'）取首段再解析。
  const cmd = raw.trim().split(/\s+/)[0];
  if (!cmd) return undefined;
  // 若 config.cliPath 本身已是绝对路径且是合法可执行文件，直接用。
  if (path.isAbsolute(cmd) && existsSync(cmd) && isLikelyExecutable(cmd)) return cmd;

  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    if (process.platform === 'win32') {
      // Windows：候选里先挑直接 .exe；都没有则逐个解析 .cmd/.bat shim。where 常同时返回
      // 多个 shim（有的指向另一个 .cmd——解析无 .exe 会跳过，有的直接指向 bin/claude.exe 命中）。
      const direct = candidates.find((c) => isLikelyExecutable(c));
      if (direct) return direct;
      for (const c of candidates) {
        const lower = c.toLowerCase();
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
          const exe = resolveFromCmdShim(c);
          if (exe) return exe;
        }
      }
    } else if (candidates[0]) {
      // *nix：which 返回的即可执行。
      return candidates[0];
    }
  } catch {
    // 命令不在 PATH。
  }
  logger.warn(`cliPath "${raw}" 无法解析为本地 Claude Code 可执行文件`);
  return undefined;
}

// ── 组装 SDK Options ───────────────────────────────────────────────
// 解析本次 query 的「会话当前实际模型」覆盖（doc2 §5.1）：供应商库（会话 override >
// 最近使用 > 库首）解析出供应商 + 模型；库为空时返回 null（走老字段/别名链兜底）。
function resolveSessionOverride(opts: SpawnOptions): SessionModelOverride | null {
  const config = getConfig();
  const resolved = resolveSessionModel(
    { providerOverride: opts.providerOverride ?? null, modelOverride: opts.modelOverride ?? null },
    { providerId: config.lastUsedProviderId, modelId: config.lastUsedModelId },
    getProviderModelSources(),
  );
  if (!resolved.provider || !resolved.modelId) return null;
  return {
    apiBaseUrl: resolved.provider.apiBaseUrl,
    apiKey: resolved.provider.apiKey,
    modelId: resolved.modelId,
  };
}

/**
 * 统一构造 claude-link 显式 settings 块（review-v1 F6）。生产 query 与 probe 共用，杜绝配置漂移。
 * 优先级：Claude Code managed < user < project < local < 此处 claude-link 显式 Options.settings。
 * 返回：
 *   settings —— 完整显式 settings（projection 顶层 + 会话级 permissions + 动态注入 env + thinking patch）；
 *   additionalDirectories —— 用户配置与附件目录并集（非空时同时写顶层 Options 与 settings.permissions）。
 */
function buildClaudeLinkSettingsBlock(
  config: AppConfig,
  sessionId: string,
  opts: SpawnOptions,
  thinkingConfig: ThinkingConfigResult,
  requestedAlias: string,
  modelOverride: SessionModelOverride | null,
): { settings: Record<string, unknown>; additionalDirectories: string[] | undefined } {
  // 内联 settings——claude-link 显式设置叠加在原生来源之上（managed < user < project < local
  // < Options.settings）。与 settings-writer.writeClaudeSettings 共用完整投影（buildClaudeSettingsProjection），
  // 避免 SDK 路径丢 hooks 等 advancedJson 顶层设置；投影内含 env（apiKey/baseUrl/advancedJson.env 字符串项）。
  const settings = buildClaudeSettingsProjection(config);
  // buildClaudeSettingsProjection 返回类型宽化为 Record<string,unknown>，但 env 运行时实为 Record<string,string>；
  // 取别名供下方按会话别名补注入 MAX_CONTEXT_TOKENS（投影不含该项，需在此按会话补）。
  const settingsEnv = settings.env as Record<string, string>;

  // 会话当前实际模型注入（唯一实际模型·第一层保险）：settings.env 是 SDK 侧最高优先级通道
  // （高于 Options.env），把供应商端点/密钥与 ANTHROPIC_MODEL + 四别名映射全部钉到当前实际模型，
  // 压过 advancedJson / 投影里可能残留的旧映射。
  if (modelOverride) {
    settingsEnv.ANTHROPIC_BASE_URL = modelOverride.apiBaseUrl;
    if (modelOverride.apiKey) {
      settingsEnv.ANTHROPIC_API_KEY = modelOverride.apiKey;
      delete settingsEnv.ANTHROPIC_AUTH_TOKEN;
    }
    Object.assign(settingsEnv, buildUnifiedModelEnv(modelOverride.modelId));
  }

  // 按当前模型别名动态注入 CC 的真实窗口 override（CLAUDE_CODE_MAX_CONTEXT_TOKENS）。
  // CC 对第三方/未知模型名（如 glm-5.2，非 claude- 开头）默认回退 200k → 提前压缩丢上下文。
  // 用户在配置页按别名设的窗口在此注入，让 CC 按该窗口处理。仅当用户显式配置该别名时注入
  // （lookupUserContextWindow 返 undefined 则不注入），避免把未配的官方模型（如 fable 5 的 1M）降级。
  // 优先级：flag settings.env（此处）> options.env（buildSpawnEnv）；MAX_CONTEXT_TOKENS > [1m] 后缀。
  // v2.1.193+ 对未知模型名直接生效，无需 DISABLE_COMPACT；若日后改回 claude-* 官方名需配合 DISABLE_COMPACT。
  const userWindow = lookupUserContextWindow({
    aliasOrModel: requestedAlias,
    advancedJson: config.advancedJson,
    contextWindowByAlias: config.contextWindowByAlias,
  });
  if (typeof userWindow === 'number' && userWindow > 0) {
    // 钳制 [1e5, 1e6]：与 SDK autoCompactWindow zod 范围对齐，超界 CC 行为未定义。
    const clamped = Math.max(100000, Math.min(1000000, userWindow));
    if (clamped !== userWindow) {
      logger.warn(`[${sessionId}] contextWindowByAlias[${requestedAlias}]=${userWindow} 越界 [1e5,1e6]，注入钳制为 ${clamped}`);
    }
    settingsEnv.CLAUDE_CODE_MAX_CONTEXT_TOKENS = String(clamped);
    logger.info(`[${sessionId}] 注入 CLAUDE_CODE_MAX_CONTEXT_TOKENS=${clamped} (alias=${requestedAlias})`);
  }

  // permissions 先应用 session 级更新，再并集 additionalDirectories（用户配置 + 附件目录）。
  const permissions = applySessionPermissionUpdates(
    sessionId,
    settings.permissions as SdkPermissionSettings,
  );
  const mergedDirs = new Set<string>();
  for (const dir of permissions.additionalDirectories ?? []) {
    if (typeof dir === 'string' && dir.trim()) mergedDirs.add(path.resolve(dir.trim()));
  }
  for (const dir of opts.additionalDirectories ?? []) {
    if (typeof dir === 'string' && dir.trim()) mergedDirs.add(path.resolve(dir.trim()));
  }
  let additionalDirectories: string[] | undefined;
  if (mergedDirs.size > 0) {
    additionalDirectories = [...mergedDirs];
    // 双写同一集合：顶层 options 与 settings.permissions，避免 SDK/CLI 只读一侧时丢目录。
    permissions.additionalDirectories = additionalDirectories;
  }

  const out: Record<string, unknown> = { ...settings, permissions };
  // 每会话思考强度 settingsPatch 覆盖全局投影：opts.thinkingLevel 已过 resolveEffectiveThinkingLevel
  // 解析为实际生效档，故此处覆盖优先级最高（query 级 > 全局投影 > advancedJson）。
  if (thinkingConfig.settingsPatch) {
    Object.assign(out, thinkingConfig.settingsPatch);
  }
  return { settings: out, additionalDirectories };
}

function buildSdkOptions(opts: SpawnOptions, sessionId: string, mainWindow: BrowserWindow, entry: SessionEntry): Record<string, unknown> {
  const config = getConfig();
  // 思考强度：会话 override（null/auto）回落全局默认，再映射成 thinking/effort/settingsPatch。
  // thinking → Options.thinking（adaptive + 摘要展示）；effort → Options.effort（含 max，运行时补偿）；
  // settingsPatch → 合并进 Options.settings，覆盖全局投影（query 级 > 全局 > advancedJson）。
  const effectiveLevel = resolveEffectiveThinkingLevel(opts.thinkingLevel ?? null, config.defaultThinkingLevel);
  const thinkingConfig = resolveThinkingConfig(effectiveLevel);
  // 供应商库解析（会话 override > 最近使用 > 库首）；命中则本回合 env/options.model/别名映射
  // 全部以它为准，modelOverride 语义为实际模型 ID（唯一实际模型原则）。
  const override = resolveSessionOverride(opts);
  const requestedAlias = override?.modelId ?? (opts.modelOverride || opts.model || resolveDefaultModel(config.advancedJson));
  entry.requestedAlias = requestedAlias;
  entry.resolvedModel = override?.modelId ?? null;
  // Task 3 / review-v1 F6：显式 settings 由 buildClaudeLinkSettingsBlock 单一构造，query 与 probe 共用，
  // 经 buildNativeSdkOptionsCore 统一放入 Options（原生 settings 来源——不传 settingSources，SDK 默认
  // 加载 user/project/local）。
  const { settings, additionalDirectories } = buildClaudeLinkSettingsBlock(config, sessionId, opts, thinkingConfig, requestedAlias, override);
  const options: Record<string, unknown> = buildNativeSdkOptionsCore({
    env: buildSpawnEnv(override),
    exe: resolveExecutable(config.cliPath),
    model: override ? override.modelId : resolveAliasToActualModel(requestedAlias, config.advancedJson),
    thinking: thinkingConfig.thinking,
    effort: thinkingConfig.effort,
    cwd: opts.workingDir || config.workingDirectory || undefined,
    maxTurns: opts.maxTurns,
    permissionMode: opts.permissionMode as SdkOptions['permissionMode'],
    settings,
    additionalDirectories,
  });
  // 生产 query 特有：流式增量（stream_event）、子 agent 思考透传、统一交互弹窗 hook。
  options.includePartialMessages = true;
  options.forwardSubagentText = true;
  options.canUseTool = createPermissionHandler(sessionId, mainWindow, opts.workingDir || config.workingDirectory || null);
  options.onElicitation = createElicitationHandler(sessionId, mainWindow);
  options.supportedDialogKinds = SUPPORTED_USER_DIALOG_KINDS;
  options.onUserDialog = createUserDialogHandler(sessionId, mainWindow);

  return options;
}

// ── SDKMessage → CliEvent 转换 + 落库 + 推前端 ───────────────────────
function forwardEvent(sessionId: string, mainWindow: BrowserWindow, event: CliEvent): void {
  // 会话已删除：不再落库（messages 表已被级联删空，INSERT 会触发外键失败回滚，
  // 反复同步失败阻塞主进程事件循环，导致所有输入框失效）。事件也不必推前端
  //（前端 activeSession 已切走/置 null，handleEvent 守卫也会丢弃）。
  if (!isSessionActive(sessionId)) return;
  touchActivityFromEvent(sessionId, event);
  try {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
  try {
    persistCliEvent(sessionId, event);
  } catch (err) {
    logger.error(`Failed to persist SDK event [${sessionId}]`, err);
  }
  // 失焦完成通知：仅真实成功 result 触发（isSuccessfulCliResult 与 renderer 绿灯同一判定）。
  // 放在事件已推送并尝试落库之后，避免通知先于聊天内容出现；同步快速返回、不 await、
  // 不触碰 activeSessions 生命周期。窗口聚焦/已销毁、错误/中断/aborted/API retry 终态均不通知。
  // 已删除会话因上方 isSessionActive 守卫提前 return，不会弹陈旧通知。
  if (event.type === 'result' && isSuccessfulCliResult(event)) {
    notifySessionCompleted(mainWindow, sessionId);
  }
  // 上下文用量：message/result 的 usage（与 process-manager.attachStreamParser 同逻辑）。
  const usage = (event as { usage?: Record<string, unknown> }).usage;
  if (usage && (event.type === 'message' || event.type === 'result')) {
    const inputTokens = extractContextTokens(usage as never);
    if (inputTokens > 0) {
      const modelUsage = (event as { modelUsage?: Record<string, { contextWindow?: number }> }).modelUsage;
      const realWindow =
        modelUsage && typeof modelUsage === 'object'
          ? Object.values(modelUsage)[0]?.contextWindow ?? undefined
          : undefined;
      const payload: ContextStatsPayload = {
        sessionId,
        inputTokens,
        outputTokens: (usage as { output_tokens?: number }).output_tokens ?? 0,
        windowSize: realWindow ?? readContextWindow(entries.get(sessionId)?.requestedAlias ?? null),
        model: null,
      };
      mainWindow.webContents.send(IPC_CHANNELS.CONTEXT_UPDATE, payload);
      // 缓存最近一次用量，供 compact_boundary 事件（无 usage）emit 时沿用。
      sessionContextStats.set(sessionId, {
        inputTokens,
        outputTokens: (usage as { output_tokens?: number }).output_tokens ?? 0,
        windowSize: payload.windowSize,
      });
      try {
        // 连同真实窗口一起持久化：payload.windowSize 已是 realWindow ?? readContextWindow()
        // 的值，切换会话重建时直接复用，不再回到 200k 兜底。
        sessionRepo.updateLastContext(sessionId, inputTokens, payload.windowSize);
      } catch (err) {
        logger.warn(`Failed to persist last context [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  // 问题 4：检测 CC 自动压缩事件（system + subtype 'compact_boundary'）。
  // 压缩事件本身不带 usage，emit CONTEXT_UPDATE 带 compactedJustNow:true 并沿用
  // 缓存的最近用量作为载体。前端 ContextButton 据此弹横幅回显自动压缩。
  const compaction = detectCompaction(event);
  if (compaction) {
    const lastStats = sessionContextStats.get(sessionId);
    const payload: ContextStatsPayload = {
      sessionId,
      inputTokens: lastStats?.inputTokens ?? 0,
      outputTokens: lastStats?.outputTokens ?? 0,
      windowSize: lastStats?.windowSize ?? readContextWindow(entries.get(sessionId)?.requestedAlias ?? null),
      model: null,
      compactedJustNow: true,
    };
    try {
      mainWindow.webContents.send(IPC_CHANNELS.CONTEXT_UPDATE, payload);
    } catch {
      // webContents 可能已销毁（窗口关闭），忽略
    }
  }
}

// 瞬态事件（tool_progress / task_* / compacting）：只 IPC 推前端，不落库 messages 表
// （它们是运行中进度，不是对话历史，落库会污染历史回看）。
function forwardTransient(sessionId: string, mainWindow: BrowserWindow, event: CliEvent): void {
  if (!isSessionActive(sessionId)) return;
  touchActivityFromEvent(sessionId, event);
  try {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

// 原生 Slash Commands：把 registry 快照经独立 COMMANDS_CHANGED IPC 推前端（不落库、不进 CHAT_EVENT）。
// 带 isSessionActive 守卫——迟到事件对已删除会话无效（计划 Task 4 §3/§7）。
function emitCommandChanged(sessionId: string, mainWindow: BrowserWindow, snapshot: SessionCommandSnapshot): void {
  if (!isSessionActive(sessionId)) return;
  try {
    mainWindow.webContents.send(IPC_CHANNELS.COMMANDS_CHANGED, { sessionId, snapshot } as CommandChangedPayload);
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

// Task 8：本地命令输出（local_command_output）主进程单一落库。参照 persistApiRetryTerminal：
// createMessage（role:system, processKind 'system:local_command_output'）+ 推 persisted_message 让 renderer upsert。
// renderer 不二次落库；result.result 走现有 result 终态兜底（两者并存）。
function persistLocalCommandOutput(sessionId: string, mainWindow: BrowserWindow, content: string): void {
  if (!isSessionActive(sessionId)) return;
  let message: ReturnType<typeof messageRepo.createMessage>;
  try {
    message = messageRepo.createMessage({
      sessionId,
      role: 'system',
      content,
      eventType: 'system',
      processKind: 'system:local_command_output',
    });
  } catch (err) {
    logger.error(`Failed to persist local_command_output [${sessionId}]`, err);
    return;
  }
  try {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
      sessionId,
      event: { type: 'persisted_message', message },
    });
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

const RETRY_PROCESS_KIND: Record<ApiRetryTerminalKind, string> = {
  recovered: 'system:api_retry_recovered',
  user_stopped: 'system:api_retry_stopped',
  exhausted: 'system:api_retry_exhausted',
};

function persistApiRetryTerminal(
  sessionId: string,
  mainWindow: BrowserWindow,
  state: ApiRetryState,
): void {
  if (!isSessionActive(sessionId) || state.phase !== 'terminal' || !state.terminalKind) return;
  const details = toApiRetryTerminalDetails(state);
  if (!details) return;
  const summary = apiRetrySummary(state.terminalKind, state.retryCount);
  let message: ReturnType<typeof messageRepo.createMessage>;
  try {
    message = messageRepo.createMessage({
      sessionId,
      role: 'system',
      content: summary,
      eventType: 'system',
      rawEvent: JSON.stringify(details),
      processKind: RETRY_PROCESS_KIND[state.terminalKind],
      title: '上游服务重试',
      isError: state.terminalKind === 'exhausted',
    });
  } catch (err) {
    logger.error(`Failed to persist API retry terminal [${sessionId}]`, err);
    try {
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
        sessionId,
        event: {
          type: 'api_retry_terminal',
          kind: state.terminalKind,
          summary,
          details,
          persisted: false,
        },
      });
    } catch {
      // webContents 可能已销毁。
    }
    return;
  }
  try {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
      sessionId,
      event: { type: 'persisted_message', message },
    });
  } catch {
    // DB 已成功写入；窗口关闭时不伪报落库失败，也不发送 fallback。
  }
}

function finishApiRetryRecovery(sessionId: string, mainWindow: BrowserWindow, queryInstance?: number): void {
  const current = apiRetryStates.get(sessionId);
  if (!current) return;
  const recovered = recordApiRetryRecovery(current, Date.now());
  apiRetryStates.set(sessionId, recovered.state);
  if (recovered.becameRecovered && recovered.terminalState) {
    logger.info(`[retry-trace] recovered session=${sessionId} query=${queryInstance ?? 'unknown'} retries=${recovered.terminalState.retryCount}`);
    persistApiRetryTerminal(sessionId, mainWindow, recovered.terminalState);
  }
}

function finishApiRetryExhausted(sessionId: string, mainWindow: BrowserWindow, queryInstance?: number): boolean {
  const current = apiRetryStates.get(sessionId);
  if (!current) return false;
  const exhausted = recordApiRetryExhausted(current, Date.now());
  apiRetryStates.set(sessionId, exhausted.state);
  if (exhausted.becameExhausted) {
    logger.warn(`[retry-trace] exhausted session=${sessionId} query=${queryInstance ?? 'unknown'} retries=${exhausted.state.retryCount}`);
    // 顺序固定：先 persistApiRetryTerminal（renderer 的 persisted/fallback 终态先发出，
    // UI 常红先行），再发失焦网络中断通知。通知只位于 becameExhausted === true 分支——
    // assistant error 后再到 error result 时第二次耗尽调用返回 false，不重复通知；
    // DB 写终态失败时 fallback 已发出，随后仍可通知。recovered/user_stopped/普通
    // error/result、killProcess 均不在此发网络中断通知。
    persistApiRetryTerminal(sessionId, mainWindow, exhausted.state);
    notifySessionNetworkInterrupted(mainWindow, sessionId);
  }
  return exhausted.becameExhausted;
}

function isToolResultPart(part: CliMessageContentPart): boolean {
  return part.type === 'tool_result' || part.type.endsWith('_tool_result');
}

// ── Claude 计划（TodoWrite / Task 工具）处理 ───────────────────────
// 独立于手动排队 tasks 表。tool_use → 即时/缓存解析 → repo 原子更新 → IPC 推送。
// 计划快照不写入 messages 表（工具调用本身仍按现有逻辑保留在聊天历史）。

// 按会话隔离的 toolUseId → { toolName, input, applied? } 缓存，用于配对 tool_use 与 tool_result。
// 仅缓存计划相关工具（TodoWrite/TaskCreate/TaskUpdate/TaskList/TaskGet）。
// applied 标记：TodoWrite input 阶段已处理 → output 阶段跳过（F13 幂等）。
// 会话删除时在 markSessionDeleted 清理；重启后不依赖此缓存（依赖已持久化快照）。
const sessionToolUseCache = new Map<string, Map<string, { toolName: string; input: Record<string, unknown>; applied?: boolean }>>();

// 按会话隔离的 orphan patch 缓存：task_updated 到达但 taskId 未知时暂存，待 TaskCreate/List/Get 建立后重放（F8）。
const sessionOrphanPatches = new Map<string, Map<string, ClaudePlanTaskPatch[]>>();

function getToolUseCache(sessionId: string): Map<string, { toolName: string; input: Record<string, unknown>; applied?: boolean }> {
  let cache = sessionToolUseCache.get(sessionId);
  if (!cache) {
    cache = new Map();
    sessionToolUseCache.set(sessionId, cache);
  }
  return cache;
}

function getOrphanPatches(sessionId: string): Map<string, ClaudePlanTaskPatch[]> {
  let orphans = sessionOrphanPatches.get(sessionId);
  if (!orphans) {
    orphans = new Map();
    sessionOrphanPatches.set(sessionId, orphans);
  }
  return orphans;
}

function cleanupToolUseCache(sessionId: string): void {
  sessionToolUseCache.delete(sessionId);
  sessionOrphanPatches.delete(sessionId);
}

// 推送计划快照到渲染进程（瞬态：不落库 messages，不调 persistCliEvent）。
function forwardClaudePlanState(sessionId: string, mainWindow: BrowserWindow, state: ClaudePlanState): void {
  if (!isSessionActive(sessionId)) return;
  try {
    mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
      sessionId,
      event: { type: 'claude_plan', sessionId, state } as ClaudePlanCliEvent,
    } as { sessionId: string; event: CliEvent });
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

// F1: 从 SDK user 消息提取结构化工具结果。优先用顶层 tool_use_result（SDK 类型 sdk.d.ts:4198），
// 因为 SDK 内置工具（Skill/TaskCreate/TaskList/TaskGet/TodoWrite）的结构化结果是放在
// user 消息顶层 tool_use_result 字段，而 tool_result.content 是人类可读文本。
function extractStructuredResult(
  toolUseResult: unknown,
  part: CliMessageContentPart,
): Record<string, unknown> | null {
  // 优先用顶层 tool_use_result（对象则直接用；数组取第一个对象元素）
  if (toolUseResult && typeof toolUseResult === 'object') {
    if (Array.isArray(toolUseResult)) {
      const first = toolUseResult.find((e) => e && typeof e === 'object' && !Array.isArray(e));
      if (first) return first as Record<string, unknown>;
    } else {
      return toolUseResult as Record<string, unknown>;
    }
  }
  // 回退：从 tool_result.content 解析 JSON（某些工具可能在 content 里放 JSON 文本）
  if (part.type !== 'tool_result') return null;
  const content = (part as { content?: unknown }).content;
  if (typeof content === 'string') {
    try { return JSON.parse(content) as Record<string, unknown>; } catch { return null; }
  }
  if (Array.isArray(content)) {
    const textItem = content.find(
      (c) => c && typeof c === 'object' && (c as { type?: string }).type === 'text' && typeof (c as { text?: unknown }).text === 'string',
    );
    if (textItem) {
      try { return JSON.parse((textItem as { text: string }).text) as Record<string, unknown>; } catch { return null; }
    }
  }
  return null;
}

// 处理 assistant 消息中的 tool_use 块：
// - TodoWrite：即时完整替换快照（input.todos 是新状态），标记 applied（F13 幂等）
// - TaskUpdate：只缓存，不立即写库（F2 推迟到 result 确认 success）
// - TaskCreate/TaskList/TaskGet：缓存 input 等待对应 tool_result
// F9：parentToolUseId 非空 = 子 Agent 消息 → 跳过（不污染父会话主计划）
function processAssistantToolUseForPlan(
  sessionId: string,
  mainWindow: BrowserWindow,
  content: CliMessageContentPart[],
  parentToolUseId?: string,
): void {
  if (!isSessionActive(sessionId)) return;
  // F9：子 Agent 的 plan 工具不影响父会话主计划
  if (parentToolUseId) return;
  const cache = getToolUseCache(sessionId);
  for (const part of content) {
    if (part.type !== 'tool_use') continue;
    const toolName = part.name;
    const input = part.input;
    const toolUseId = part.id ?? part.tool_use_id ?? '';
    if (!toolUseId) continue;

    // 仅缓存计划相关工具
    if (
      toolName === 'TodoWrite' || toolName === 'TaskCreate' ||
      toolName === 'TaskUpdate' || toolName === 'TaskList' || toolName === 'TaskGet'
    ) {
      cache.set(toolUseId, { toolName, input });
    }

    // TodoWrite：即时完整替换快照（input.todos 是新状态），标记 applied 实现 F13 幂等
    if (toolName === 'TodoWrite') {
      const todos = parseTodoWriteInput(input);
      if (todos) {
        try {
          const state = claudePlanRepo.replaceTodos(sessionId, todos);
          if (state) forwardClaudePlanState(sessionId, mainWindow, state);
          // 标记 input 阶段已处理，output 阶段跳过避免双写 revision 翻倍（F13）
          cache.set(toolUseId, { toolName, input, applied: true });
        } catch (err) {
          logger.warn(`[plan] replaceTodos failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    // F2：TaskUpdate 不在 tool_use 阶段立即写库——推迟到 tool_result 确认 success
    // 只缓存 input（已缓存），result 阶段在 processToolResultForPlan 中处理
  }
}

// 处理 user 消息中的 tool_result 块：配对缓存的 toolUseId，
// F1: 从 sdkMsg.tool_use_result 顶层取结构化结果（而非 content JSON.parse）。
// F2: TaskUpdate 在此确认 success 后才写库（失败则丢弃 provisional patch）。
// F4: TaskList 用 mergeTasks（保留本地详情）。
// F5: TaskGet 用 upsertPatch（patch 语义，保留本地未返回字段）。
// F8: 任务建立后重放 orphan patch。
// F13: TodoWrite input 已处理 → output 跳过（幂等）。
function processToolResultForPlan(
  sessionId: string,
  mainWindow: BrowserWindow,
  content: CliMessageContentPart[],
  toolUseResult: unknown,
): void {
  if (!isSessionActive(sessionId)) return;
  const cache = getToolUseCache(sessionId);
  const orphans = getOrphanPatches(sessionId);
  for (const part of content) {
    if (!isToolResultPart(part)) continue;
    const toolUseId = (part as { tool_use_id?: string }).tool_use_id ?? '';
    if (!toolUseId) continue;
    const cached = cache.get(toolUseId);
    if (!cached) continue;

    // F1: 优先从顶层 tool_use_result 取结构化结果
    const resultObj = extractStructuredResult(toolUseResult, part);

    if (cached.toolName === 'TaskCreate') {
      if (!resultObj) { cache.delete(toolUseId); continue; }
      const taskResult = parseTaskCreateOutput(resultObj);
      if (taskResult) {
        const inputParsed = parseTaskCreateInput(cached.input);
        if (inputParsed) {
          const task: ClaudePlanTask = {
            id: taskResult.id,
            subject: taskResult.subject || inputParsed.subject,
            description: inputParsed.description,
            ...(inputParsed.activeForm ? { activeForm: inputParsed.activeForm } : {}),
            status: 'pending',
            blocks: [],
            blockedBy: [],
            ...(inputParsed.metadata ? { metadata: inputParsed.metadata } : {}),
          };
          try {
            const state = claudePlanRepo.upsertTask(sessionId, task);
            if (state) {
              forwardClaudePlanState(sessionId, mainWindow, state);
              // F8: 重放该 taskId 的 orphan patches
              replayOrphanPatches(sessionId, mainWindow, taskResult.id, orphans);
            }
          } catch (err) {
            logger.warn(`[plan] upsertTask (TaskCreate) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } else if (cached.toolName === 'TaskUpdate') {
      // F2: 推迟到 result 确认 success 后才写库
      const parsed = parseTaskUpdateInput(cached.input);
      if (!parsed) { cache.delete(toolUseId); continue; }
      // 检查 success（结构化结果可能含 success 字段）
      const success = resultObj?.success;
      // success === false → 丢弃 provisional patch（SDK 拒绝了更新）
      if (success === false) {
        cache.delete(toolUseId);
        continue;
      }
      // success === true 或无 success 字段 → 执行更新
      if ('delete' in parsed) {
        try {
          const state = claudePlanRepo.removeTask(sessionId, parsed.taskId);
          if (state) forwardClaudePlanState(sessionId, mainWindow, state);
        } catch (err) {
          logger.warn(`[plan] removeTask (TaskUpdate) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        const patch = parsed.patch;
        // F6: patch 非空即转发（含 owner/blocks/blockedBy/metadata）
        if (Object.keys(patch).length > 0) {
          try {
            const state = claudePlanRepo.patchTask(sessionId, parsed.taskId, patch);
            if (state) forwardClaudePlanState(sessionId, mainWindow, state);
          } catch (err) {
            logger.warn(`[plan] patchTask (TaskUpdate) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    } else if (cached.toolName === 'TaskList') {
      if (!resultObj) { cache.delete(toolUseId); continue; }
      // F4: merge 而非 replace——保留本地 description/activeForm/metadata/blocks
      const entries = parseTaskListOutput(resultObj);
      if (entries) {
        try {
          const state = claudePlanRepo.mergeTasks(sessionId, entries);
          if (state) {
            forwardClaudePlanState(sessionId, mainWindow, state);
            // F8: 对每个 entry taskId 重放 orphan patches
            for (const entry of entries) {
              replayOrphanPatches(sessionId, mainWindow, entry.id, orphans);
            }
          }
        } catch (err) {
          logger.warn(`[plan] mergeTasks (TaskList) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (cached.toolName === 'TaskGet') {
      if (!resultObj) { cache.delete(toolUseId); continue; }
      // F5: upsertPatch（patch 语义）而非全量 upsert——保留本地未返回字段
      const result = parseTaskGetOutput(resultObj);
      if (result) {
        try {
          const state = claudePlanRepo.upsertPatch(sessionId, result.id, result.patch);
          if (state) {
            forwardClaudePlanState(sessionId, mainWindow, state);
            // F8: 重放该 taskId 的 orphan patches
            replayOrphanPatches(sessionId, mainWindow, result.id, orphans);
          }
        } catch (err) {
          logger.warn(`[plan] upsertPatch (TaskGet) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } else if (cached.toolName === 'TodoWrite') {
      // F13: input 阶段已处理 → output 跳过（避免双写 revision 翻倍）
      if (cached.applied) {
        cache.delete(toolUseId);
        continue;
      }
      // input 阶段未处理（parseTodoWriteInput 返回 null 等）→ 用 output 确认
      if (resultObj) {
        const todos = parseTodoWriteOutput(resultObj);
        if (todos) {
          try {
            const state = claudePlanRepo.replaceTodos(sessionId, todos);
            if (state) forwardClaudePlanState(sessionId, mainWindow, state);
          } catch (err) {
            logger.warn(`[plan] replaceTodos (output confirm) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }
    }

    cache.delete(toolUseId);
  }
}

// F8: 重放 orphan patches（task_updated 在任务建立前到达时缓存的 patch）
function replayOrphanPatches(
  sessionId: string,
  mainWindow: BrowserWindow,
  taskId: string,
  orphans: Map<string, ClaudePlanTaskPatch[]>,
): void {
  const patches = orphans.get(taskId);
  if (!patches || patches.length === 0) return;
  orphans.delete(taskId);
  for (const patch of patches) {
    try {
      const state = claudePlanRepo.patchTask(sessionId, taskId, patch);
      if (state) forwardClaudePlanState(sessionId, mainWindow, state);
    } catch (err) {
      logger.warn(`[plan] orphan replay patchTask failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// 处理 SDK system/task_updated 消息：归一化 running → in_progress，patch 已知任务。
// F8: 若 taskId 未知（patchTask no-op），把 patch 缓存为 orphan，待 TaskCreate/List/Get 建立后重放。
function processTaskUpdatedForPlan(
  sessionId: string,
  mainWindow: BrowserWindow,
  sdkMsg: Record<string, unknown>,
): void {
  if (!isSessionActive(sessionId)) return;
  const parsed = parseTaskUpdatedPatch(sdkMsg);
  if (!parsed) return;
  // patch 为空对象时不推送（无实质变更）
  if (Object.keys(parsed.patch).length === 0) return;
  try {
    const state = claudePlanRepo.patchTask(sessionId, parsed.taskId, parsed.patch);
    if (state) {
      forwardClaudePlanState(sessionId, mainWindow, state);
      // F8: 检查任务是否存在——不存在则缓存为 orphan
      const taskExists = state.tasks.some((t) => t.id === parsed.taskId);
      if (!taskExists) {
        const orphans = getOrphanPatches(sessionId);
        const existing = orphans.get(parsed.taskId);
        if (existing) {
          existing.push(parsed.patch);
        } else {
          orphans.set(parsed.taskId, [parsed.patch]);
        }
      }
    }
  } catch (err) {
    logger.warn(`[plan] patchTask (task_updated) failed [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 把 SDK 的 assistant/user 消息（{type:'assistant'|'user', message:{role,content,usage}, parent_tool_use_id?}）
// 转成 CliMessageEvent。透传 parent_tool_use_id → parentToolUseId，让子 agent 过程能归属到
// 主流程对应工具，抽到右侧「子Agent」Tab。
function convertAssistantMessage(sdkMsg: Record<string, unknown>): CliMessageEvent | null {
  const message = sdkMsg.message as
    | { role?: string; content?: CliMessageContentPart[]; usage?: Record<string, unknown> }
    | undefined;
  if (!message || !Array.isArray(message.content)) return null;
  const parentToolUseId =
    typeof sdkMsg.parent_tool_use_id === 'string' ? sdkMsg.parent_tool_use_id : undefined;
  return {
    type: 'message',
    role: (message.role === 'user' ? 'user' : 'assistant') as 'user' | 'assistant',
    content: message.content,
    usage: (message.usage as CliMessageEvent['usage']) ?? undefined,
    ...(parentToolUseId ? { parentToolUseId } : {}),
  };
}

// SDK result → CliResultEvent 转换已提取至共享层（src/shared/result-converter.ts，F1）：
// 保留真实 subtype（缺失保持 undefined），由 isSuccessfulCliResult 结合 is_error 判定终态，
// 避免第三方端点 is_error=true 且无 subtype 时被无条件补成 success 而错误亮绿灯/发完成通知。

// SDK stream_event（SDKPartialAssistantMessage）已是 {type:'stream_event', event}，直接转发。
// Bug2：透传 parent_tool_use_id（sdk.d.ts:3788 SDKPartialAssistantMessage 带），让渲染层把子 agent 的
// thinking_delta 路由到对应「子Agent」Tab 的实时思考，而非无脑塞进主流程（致思考中 Tab 空白）。
function convertStreamEvent(sdkMsg: Record<string, unknown>): CliEvent {
  const parentToolUseId =
    typeof sdkMsg.parent_tool_use_id === 'string' ? sdkMsg.parent_tool_use_id : undefined;
  return {
    type: 'stream_event',
    event: sdkMsg.event as CliStreamEvent['event'],
    ...(parentToolUseId ? { parentToolUseId } : {}),
  } as CliStreamEvent;
}

// review-v4 P1-2 test-only seam：允许测试注入 fake query factory，驱动真实 runQuery/forwardEvent/DB
// 而不调真实 CLI/模型。仅测试入口安装；生产永不安装；finally 恢复默认。无 IPC/API/环境变量暴露。
type SdkQueryFactory = (params: { prompt: SdkPrompt; options: Record<string, unknown> }) => Promise<Query>;

const defaultSdkQueryFactory: SdkQueryFactory = async (params) => {
  const sdk = await importSdk();
  return sdk.query(params);
};

let activeSdkQueryFactory: SdkQueryFactory = defaultSdkQueryFactory;

/** @internal test-only — 安装 fake query factory 覆盖真实 SDK query；传 null 恢复默认。 */
export function __setSdkQueryFactoryForTest(factory: SdkQueryFactory | null): void {
  activeSdkQueryFactory = factory ?? defaultSdkQueryFactory;
}

async function startSdkQuery(prompt: SdkPrompt, options: Record<string, unknown>): Promise<Query> {
  return activeSdkQueryFactory({ prompt, options });
}

// ── 原生 Slash Commands 命令发现（Task 4）─────────────────────────────
// 新会话创建后立即在后台独立 probe（Task 1 实测可行：shouldQuery:false 单条消息收到 init +
// supportedCommands 返回 29 命令，无真实模型回合）。不写 sessionCliIds、不进聊天 entries、不落库、
// 不发真实用户 prompt；有自己的 AbortController/超时/cleanup。CHAT_SEND 触发真实 query 前取消。

// control-only prompt：单条 shouldQuery:false 的 SDKUserMessage——追加到 transcript 但不触发 assistant
// 回合（sdk.d.ts:4206）。Task 1 probe B 路径已验证可行。
function controlPromptIterable(): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'claude-link command discovery probe' }] },
      parent_tool_use_id: null,
      shouldQuery: false,
    } as SDKUserMessage;
    // 不再 yield：保持 query 存活到 supportedCommands 返回，由 finally / cancelCommandProbe 收尾。
  })();
}

// probe 用的 SDK options：复用 buildSdkOptions 的会话上下文（F2 修复）——model override / settings 投影 /
// permissions（含会话级权限更新）/ additionalDirectories / thinking / effort / cwd / contextWindow，
// 保证 supportedCommands 返回与「用户随后真实聊天 query」一致的命令集合。control-only 不触发回合，
// 因此不注入 canUseTool / onElicitation / onUserDialog（无交互）。
// review-v1 F6：settings 块与 additionalDirectories 由 buildClaudeLinkSettingsBlock 统一构造
// （与 buildSdkOptions 同一逻辑），杜绝 probe 与真实 query 配置漂移。
function buildProbeSdkOptions(opts: SpawnOptions, sessionId: string): { options: Record<string, unknown>; exe: string | undefined } {
  const config = getConfig();
  const exe = resolveExecutable(config.cliPath);
  const effectiveLevel = resolveEffectiveThinkingLevel(opts.thinkingLevel ?? null, config.defaultThinkingLevel);
  const thinkingConfig = resolveThinkingConfig(effectiveLevel);
  // 与生产 query 同一供应商库解析（F2/N1：probe 与真实回合的模型/端点上下文一致）。
  const override = resolveSessionOverride(opts);
  const requestedAlias = override?.modelId ?? (opts.modelOverride || opts.model || resolveDefaultModel(config.advancedJson));
  // Task 3 / review-v1 F6：与生产 query 同一核心构造（原生 settings 来源，不传 settingSources 数组；
  // 显式 settings 共用 buildClaudeLinkSettingsBlock，经工厂统一放入 Options）。
  const { settings, additionalDirectories } = buildClaudeLinkSettingsBlock(config, sessionId, opts, thinkingConfig, requestedAlias, override);
  const options: Record<string, unknown> = buildNativeSdkOptionsCore({
    env: buildSpawnEnv(override),
    exe,
    model: override ? override.modelId : resolveAliasToActualModel(requestedAlias, config.advancedJson),
    thinking: thinkingConfig.thinking,
    effort: thinkingConfig.effort,
    cwd: opts.workingDir || config.workingDirectory || undefined,
    maxTurns: opts.maxTurns,
    permissionMode: opts.permissionMode as SdkOptions['permissionMode'],
    settings,
    additionalDirectories,
  });

  return { options, exe };
}

interface CommandProbeEntry {
  query: Query | null;
  abortController: AbortController;
  aborted: boolean;
  queryInstance: number;
  donePromise: Promise<void>;
  resolveDone: () => void;
}
const commandProbes = new Map<string, CommandProbeEntry>();
const nextProbeInstance = { value: 1 };

function isCurrentProbe(sessionId: string, entry: CommandProbeEntry): boolean {
  return commandProbes.get(sessionId) === entry;
}

/**
 * 新会话创建后立即在后台发起命令发现。成功 → registry 全量写入 source:'probe' 快照并推 COMMANDS_CHANGED；
 * 失败/无 exe → degraded（保留缓存命令）；SDK 无 supportedCommands → degraded（由真实 query init 兜底）。
 * 不阻塞普通聊天；返回的 Promise 在 probe 结束后 resolve。
 */
export async function startCommandProbe(sessionId: string, mainWindow: BrowserWindow, opts: SpawnOptions = {}): Promise<void> {
  // N3：先等待已有 probe 取消结束（有限超时），避免两个 probe 并发创建/退出 Claude Code 进程。
  await cancelCommandProbeInternal(sessionId, 1000);
  // N5：重启后打开已有会话时 activeSessions 为空（markSessionActive 只在 SESSION_CREATE / spawnForChat /
  // spawnForTask 调用），probe 不应因此被拦截。会话存活的判据是「内存活跃 或 DB 中真实存在（未删除）」；
  // 删除会话会同时撤销 activeSessions 登记与 DB 记录。getSession 结果同时供下方 N1 配置合并复用。
  let sessionFromDb: ReturnType<typeof sessionRepo.getSession> = null;
  try {
    sessionFromDb = sessionRepo.getSession(sessionId);
  } catch (e) {
    logger.warn(`[${sessionId}] 读取会话失败：${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isSessionActive(sessionId) && !sessionFromDb) return;
  // N3：活跃聊天 query 时不并发启动 probe——只标 stale（真实 query init 会兜底发现命令）。
  if (isEntryActive(entries.get(sessionId))) {
    emitCommandChanged(sessionId, mainWindow, sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'stale'));
    return;
  }
  // N1：增量 opts（SESSION_UPDATE 只传 patch）用完整 Session 配置补全，保证探测上下文与会话一致。
  const fullOpts = mergeSpawnOptions(sessionFromDb, opts);
  // O1：buildProbeSdkOptions 内部（模型映射/settings 投影/权限更新）异常时兜底 degraded，
  // fire-and-forget 不允许 unhandled rejection。
  let probeSdk: { options: Record<string, unknown>; exe: string | undefined };
  try {
    probeSdk = buildProbeSdkOptions(fullOpts, sessionId);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', `命令探测失败：${message}`);
    emitCommandChanged(sessionId, mainWindow, snap);
    return;
  }
  const { options, exe } = probeSdk;
  if (!exe) {
    const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', '未检测到本地 Claude Code，无法发现 Slash 命令');
    emitCommandChanged(sessionId, mainWindow, snap);
    return;
  }
  // F3：工作目录/会话设置变化导致的重新探测——已有 ready/degraded 快照标 stale（保留旧命令供本地
  // 过滤，UI 显示“可能不是最新”），无快照则 loading。
  if (!sdkCommandRegistry.has(sessionId)) {
    emitCommandChanged(sessionId, mainWindow, sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'loading'));
  } else if (
    sdkCommandRegistry.get(sessionId).status === 'ready' ||
    sdkCommandRegistry.get(sessionId).status === 'degraded'
  ) {
    emitCommandChanged(sessionId, mainWindow, sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'stale'));
  }
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });
  const entry: CommandProbeEntry = {
    query: null,
    abortController: new AbortController(),
    aborted: false,
    queryInstance: ++nextProbeInstance.value,
    donePromise,
    resolveDone,
  };
  commandProbes.set(sessionId, entry);
  void runCommandProbe(sessionId, mainWindow, options, entry);
  await donePromise;
}

const PROBE_TIMEOUT_MS = 30_000;
const SUPPORTED_COMMANDS_TIMEOUT_MS = 8_000;

async function runCommandProbe(
  sessionId: string,
  mainWindow: BrowserWindow,
  options: Record<string, unknown>,
  entry: CommandProbeEntry,
): Promise<void> {
  const hardTimer = setTimeout(() => {
    entry.aborted = true;
    try {
      entry.abortController.abort();
    } catch {
      // ignore
    }
  }, PROBE_TIMEOUT_MS);
  try {
    const query = await startSdkQuery(controlPromptIterable(), { ...options, abortController: entry.abortController });
    if (entry.aborted || !isSessionActive(sessionId) || !isCurrentProbe(sessionId, entry)) {
      try {
        await query.interrupt();
      } catch {
        // ProcessTransport not ready → ignore
      }
      return;
    }
    entry.query = query;
    for await (const msg of query as AsyncGenerator<Record<string, unknown>, void>) {
      if (!isSessionActive(sessionId) || !isCurrentProbe(sessionId, entry) || entry.aborted) break;
      const t = msg.type as string;
      const st = msg.subtype as string | undefined;
      if (t === 'system' && st === 'init') {
        // 独立 probe 也必须先保存 init 来源上下文；否则 supportedCommands 结果会用空 ctx 分类。
        sessionCommandCtx.set(sessionId, buildCommandOriginContext(msg as Record<string, unknown>, sessionId));
        await resolveAndApplyProbeCommands(sessionId, mainWindow, query, entry);
        break; // 拿到命令即退出消费循环
      }
    }
  } catch (e) {
    if (isSessionActive(sessionId) && isCurrentProbe(sessionId, entry)) {
      const message = e instanceof Error ? e.message : String(e);
      const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', `命令探测失败：${message}`);
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  } finally {
    clearTimeout(hardTimer);
    // Task 1 实测：流结束后 interrupt 会抛 ProcessTransport is not ready for writing → catch ignore；
    // abortController.abort() 作为硬杀兜底（与 runQuery 一致）。
    try {
      await entry.query?.interrupt();
    } catch {
      // ignore
    }
    try {
      entry.abortController.abort();
    } catch {
      // ignore
    }
    if (isCurrentProbe(sessionId, entry)) commandProbes.delete(sessionId);
    entry.resolveDone();
  }
}

/**
 * review-v2 §5：SDK 子进程的 userHome 可能被 advancedJson.env 的 USERPROFILE/HOME 覆盖。
 * buildSpawnEnv() 先 {...process.env} 再注入 advancedJson.env 块，其中可能含 USERPROFILE/HOME——
 * 该 env 经 SDK options 传给 Claude Code 子进程。证据扫描必须用与子进程一致的 userHome，
 * 否则 SDK 发现的 Skill 在证据扫描中找不到对应磁盘证据，分类回退到 unknown。
 */
function effectiveUserHome(): string | undefined {
  const env = buildSpawnEnv();
  return env.USERPROFILE || env.HOME;
}

/** 从 system.init 消息提取命令来源分类上下文（Task 2）。 */
function buildCommandOriginContext(
  sdkMsg: Record<string, unknown>,
  sessionId?: string,
): CommandOriginContext {
  const skills = Array.isArray(sdkMsg.skills)
    ? (sdkMsg.skills as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  const plugins = Array.isArray(sdkMsg.plugins)
    ? (sdkMsg.plugins as Array<Record<string, unknown>>)
        .map((p) => (typeof p?.name === 'string' ? p.name : ''))
        .filter((n) => n.length > 0)
    : [];
  const slashCommands = Array.isArray(sdkMsg.slash_commands)
    ? (sdkMsg.slash_commands as unknown[]).filter((s): s is string => typeof s === 'string')
    : [];
  // review-v2 §5：证据扫描的 userHome 必须与 SDK 子进程一致——用 buildSpawnEnv() 的 effective env，
  // 而非宿主 process.env 默认值（advancedJson.env 可能覆盖 USERPROFILE/HOME）。
  const userHome = effectiveUserHome();
  const cwd = typeof sdkMsg.cwd === 'string' ? sdkMsg.cwd : undefined;
  const rawPlugins = Array.isArray(sdkMsg.plugins) ? (sdkMsg.plugins as Array<{ name: string; path?: string }>) : [];
  const evidence = buildCommandOriginEvidence({
    cwd,
    plugins: rawPlugins,
    ...(userHome ? { userHome } : {}),
  });
  // review-v1 §5.1：保存 init 时的 cwd + plugin 路径种子，供 commands_changed 刷新证据时重扫项目来源。
  if (sessionId) {
    sessionProvenanceSeeds.set(sessionId, { cwd, plugins: rawPlugins });
  }
  return { skills, plugins, slashCommands, evidence };
}

/**
 * review-v1 §5.1：commands_changed 时按当前会话 cwd 重新扫描项目来源证据。
 * init 时冻结的 evidence 不反映会话过程中新增/修改/删除的项目命令文件（.claude/skills、.claude/commands）；
 * commands_changed 表示命令列表已变化，必须重建 evidence 以正确分类新增/变更的项目命令。
 * skills/plugins/slashCommands 名称集合沿用 init（SDK canonical 视图，不随项目文件变化）；
 * evidence 部分（文件来源映射）按当前磁盘状态重扫。
 */
function refreshCommandOriginContext(sessionId: string, queryCwd?: string): CommandOriginContext {
  const ctx = sessionCommandCtx.get(sessionId);
  const seed = sessionProvenanceSeeds.get(sessionId);
  // review-v2 §5：与 buildCommandOriginContext 一致，用 effective env 的 userHome。
  const userHome = effectiveUserHome();
  // review-v9 §4（实测修复）：commands_changed 可能早于 system:init 到达，或 seed 冻结的是
  // 旧 cwd 的 init（实测：会话创建时 probe 用全局默认 cwd，设置 workingDir 后首个 query 的
  // changed 若沿用 seed cwd，会把新 cwd 的 project skill 分类成 unknown）。当前 query 的 cwd
  // 才是 CLI 本次扫描的真实根目录——优先于 seed，并回写 seed 供后续刷新使用。
  const cwd = queryCwd ?? seed?.cwd;
  if (queryCwd && queryCwd !== seed?.cwd) {
    sessionProvenanceSeeds.set(sessionId, { cwd: queryCwd, plugins: seed?.plugins ?? [] });
  }
  const evidence = buildCommandOriginEvidence({
    cwd,
    plugins: seed?.plugins ?? [],
    ...(userHome ? { userHome } : {}),
  });
  if (ctx) {
    return { skills: ctx.skills, plugins: ctx.plugins, slashCommands: ctx.slashCommands, evidence };
  }
  // init 未处理（commands_changed 早于 init 到达）：名称集合为空——分类由 evidence（文件来源
  // 映射）+ '(user)' 描述标记 + KNOWN_BUILTIN_NAMES 兜底完成，不再返回 EMPTY 导致 unknown 固化。
  return { skills: [], plugins: [], slashCommands: [], evidence };
}

/** 从 cwd 向上收集存在的 CLAUDE.md 候选（CC 会加载的上下文文件，Task 3 诊断用）。 */
function findClaudeMdCandidates(cwd: string): string[] {
  const candidates: string[] = [];
  let dir = cwd;
  for (let i = 0; i < 8 && dir; i++) {
    const p = path.join(dir, 'CLAUDE.md');
    if (existsSync(p)) candidates.push(p);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return candidates;
}

/**
 * Task 3 Step 5：SDK 官方 resolveSettings 诊断（不 spawn CLI）。
 * 返回可克隆摘要：来源级联（source + path）、可见 CLAUDE.md 候选、effective 键名。
 * 绝不回传 effective 的值（可能含 env/API key 等秘密）——只取键名，日志与 IPC 一律脱敏。
 */
export async function getNativeSettingsDiagnostic(cwd: string): Promise<{
  cwd: string;
  sources: Array<{ source: string; path?: string }>;
  claudeMdCandidates: string[];
  effectiveKeys: string[];
}> {
  const sdk = (await importSdk()) as unknown as { resolveSettings?: (opts: { cwd: string }) => Promise<Record<string, any>> };
  if (typeof sdk.resolveSettings !== 'function') {
    throw new Error('SDK 未导出 resolveSettings（Task 3 原生 settings 诊断依赖）');
  }
  const resolved = await sdk.resolveSettings({ cwd });
  return {
    cwd,
    sources: Array.isArray(resolved?.sources)
      ? resolved.sources.map((s: any) => ({
          source: typeof s?.source === 'string' ? s.source : 'unknown',
          ...(typeof s?.path === 'string' && s.path ? { path: s.path } : {}),
        }))
      : [],
    claudeMdCandidates: findClaudeMdCandidates(cwd),
    effectiveKeys:
      resolved?.effective && typeof resolved.effective === 'object'
        ? Object.keys(resolved.effective)
        : [],
  };
}

async function resolveAndApplyProbeCommands(
  sessionId: string,
  mainWindow: BrowserWindow,
  query: Query,
  entry: CommandProbeEntry,
): Promise<void> {
  if (typeof query.supportedCommands !== 'function') {
    if (isSessionActive(sessionId) && isCurrentProbe(sessionId, entry)) {
      const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', 'SDK 不支持 supportedCommands');
      emitCommandChanged(sessionId, mainWindow, snap);
    }
    return;
  }
  const startRev = sdkCommandRegistry.getRevision(sessionId);
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rawCommands = await Promise.race([
      query.supportedCommands(),
      new Promise<never>((_, reject) => {
        // O3：记录定时器句柄，supportedCommands 先 resolve 时在 finally 清理。
        timeoutTimer = setTimeout(() => reject(new Error('supportedCommands timeout')), SUPPORTED_COMMANDS_TIMEOUT_MS);
      }),
    ]);
    // F4：只有仍是启动时代际（期间无 commands_changed 等 replace）才写入，防旧 probe 覆盖新列表。
    if (
      isSessionActive(sessionId) &&
      isCurrentProbe(sessionId, entry) &&
      sdkCommandRegistry.getRevision(sessionId) === startRev
    ) {
      const snap = sdkCommandRegistry.replace(sessionId, Array.isArray(rawCommands) ? rawCommands : [], 'probe', sessionCommandCtx.get(sessionId));
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  } catch (e) {
    if (isSessionActive(sessionId) && isCurrentProbe(sessionId, entry)) {
      const message = e instanceof Error ? e.message : String(e);
      const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', `supportedCommands 失败：${message}`);
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/**
 * 取消某会话的命令探测并等待其结束（有限超时）。CHAT_SEND 触发真实 query 前调用，保证 probe 与真实
 * query 不并行（Task 4 §7）。取消失败不阻塞普通发送超过短超时。
 */
export async function cancelCommandProbe(sessionId: string, timeoutMs = 1_500): Promise<void> {
  await cancelCommandProbeInternal(sessionId, timeoutMs);
}

async function cancelCommandProbeInternal(sessionId: string, timeoutMs: number): Promise<void> {
  const entry = commandProbes.get(sessionId);
  if (!entry) return;
  entry.aborted = true;
  try {
    entry.abortController.abort();
  } catch {
    // ignore
  }
  try {
    await entry.query?.interrupt();
  } catch {
    // ProcessTransport not ready → ignore
  }
  await Promise.race([entry.donePromise, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

// ── 启动全局兜底命令探测（无会话绑定）──
// app.whenReady 后跑一次：复用 buildProbeSdkOptions（哨兵 sessionId，applySessionPermissionUpdates
// 无害退化）+ startSdkQuery + controlPromptIterable。结果写入 registry.globalFallback，作为「无 per-session
// 快照会话」的兜底（重启后旧会话立即可用 + 探测异常容错）。per-session 快照永远优先。
// 不走 per-session 的 isSessionActive 守卫 / revision / commandProbes map；启动只跑一次（幂等）。
const GLOBAL_PROBE_SESSION_ID = '__global_command_probe__';

interface GlobalProbeEntry {
  query: Query | null;
  abortController: AbortController;
  donePromise: Promise<void>;
  resolveDone: () => void;
}
let globalProbe: GlobalProbeEntry | null = null;

/** 启动一次全局兜底命令探测（幂等：已有在跑则跳过）。fire-and-forget 调用。 */
export function runGlobalCommandProbe(mainWindow: BrowserWindow): void {
  if (globalProbe) return;
  let resolveDone!: () => void;
  const donePromise = new Promise<void>((r) => {
    resolveDone = r;
  });
  const entry: GlobalProbeEntry = {
    query: null,
    abortController: new AbortController(),
    donePromise,
    resolveDone,
  };
  globalProbe = entry;
  void runGlobalCommandProbeInternal(mainWindow, entry);
}

async function runGlobalCommandProbeInternal(mainWindow: BrowserWindow, entry: GlobalProbeEntry): Promise<void> {
  const hardTimer = setTimeout(() => {
    try {
      entry.abortController.abort();
    } catch {
      // ignore
    }
  }, PROBE_TIMEOUT_MS);
  try {
    // 复用 probe 的 options builder（空 SpawnOptions + 哨兵 sessionId）：仅构造内存 options.settings，不写盘；
    // applySessionPermissionUpdates 对未知 sessionId 查表返回 undefined → 原样 permissions。
    let probeSdk: { options: Record<string, unknown>; exe: string | undefined };
    try {
      probeSdk = buildProbeSdkOptions({}, GLOBAL_PROBE_SESSION_ID);
    } catch (e) {
      logger.warn(`[global-probe] 构建探测选项失败：${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const { options, exe } = probeSdk;
    if (!exe) return; // 无 CLI：不写 degraded，留给 per-session 处理
    const query = await startSdkQuery(controlPromptIterable(), { ...options, abortController: entry.abortController });
    if (entry.abortController.signal.aborted) {
      try {
        await query.interrupt();
      } catch {
        // ignore
      }
      return;
    }
    entry.query = query;
    for await (const msg of query as AsyncGenerator<Record<string, unknown>, void>) {
      if (entry.abortController.signal.aborted) break;
      const t = msg.type as string;
      const st = msg.subtype as string | undefined;
      if (t === 'system' && st === 'init') {
        await applyGlobalProbeCommands(
          mainWindow,
          query,
          entry,
          buildCommandOriginContext(msg as Record<string, unknown>),
        );
        break; // 拿到命令即退出消费循环
      }
    }
  } catch (e) {
    logger.warn(`[global-probe] 探测失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(hardTimer);
    try {
      await entry.query?.interrupt();
    } catch {
      // ProcessTransport not ready → ignore
    }
    try {
      entry.abortController.abort();
    } catch {
      // ignore
    }
    if (globalProbe === entry) globalProbe = null;
    entry.resolveDone();
  }
}

async function applyGlobalProbeCommands(
  mainWindow: BrowserWindow,
  query: Query,
  entry: GlobalProbeEntry,
  ctx: CommandOriginContext,
): Promise<void> {
  if (typeof query.supportedCommands !== 'function') return;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const rawCommands = await Promise.race([
      query.supportedCommands(),
      new Promise<never>((_, reject) => {
        // O3：记录定时器句柄，supportedCommands 先 resolve 时在 finally 清理。
        timeoutTimer = setTimeout(() => reject(new Error('supportedCommands timeout')), SUPPORTED_COMMANDS_TIMEOUT_MS);
      }),
    ]);
    if (entry.abortController.signal.aborted) return;
    // 写入全局兜底（内部清洗 + 去重，与 replace 同款；带本次 init 的分类上下文）。
    sdkCommandRegistry.setGlobalFallback(Array.isArray(rawCommands) ? rawCommands : [], 'probe', ctx);
    // 回填（N7）：globalFallback 就绪后，对 activeSessions 中「命令仍为空」的会话补推兜底命令。不按 has(sid)
    // 判断——loading/degraded 已写入 snapshots 使 has 为 true，但命令可能仍空（probe 进行中/失败/兜底晚到）。
    // 按 commands 空判断：保留该会话当前 status（loading/degraded），用 setStatusPreservingCommands 补 cache 命令不清空。
    const fallback = sdkCommandRegistry.getGlobalFallback();
    if (fallback && fallback.commands.length > 0) {
      for (const sid of activeSessions) {
        const current = sdkCommandRegistry.get(sid);
        if (current.commands.length > 0) continue; // 已有命令（per-session ready 或已回填 cache），跳过
        const snap = sdkCommandRegistry.setStatusPreservingCommands(sid, current.status);
        emitCommandChanged(sid, mainWindow, snap);
      }
    }
  } catch (e) {
    logger.warn(`[global-probe] supportedCommands 失败：${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timeoutTimer);
  }
}

/** 取消全局兜底探测并等待其结束（有限超时）。app 退出时调用，避免孤儿 claude 子进程。 */
export async function cancelGlobalCommandProbe(timeoutMs = 500): Promise<void> {
  const entry = globalProbe;
  if (!entry) return;
  try {
    entry.abortController.abort();
  } catch {
    // ignore
  }
  try {
    await entry.query?.interrupt();
  } catch {
    // ProcessTransport not ready → ignore
  }
  await Promise.race([entry.donePromise, new Promise<void>((r) => setTimeout(r, timeoutMs))]);
}

// Task 4 §2/§3：真实 query init 兜底命令发现。probe 是主路径（新会话创建即跑）；此处仅当 probe 未就绪
// （失败/未跑/SDK 不支持，snapshot 非 ready）时：先用 init.slash_commands 写名称级早期快照（source:'init'），
// 再异步调 supportedCommands 补完整描述。probe 已 ready 则跳过（commands_changed 负责后续刷新）。
async function maybeDiscoverCommandsFromInit(
  sessionId: string,
  mainWindow: BrowserWindow,
  entry: SessionEntry,
  sdkMsg: Record<string, unknown>,
  query: Query,
): Promise<void> {
  if (!isSessionActive(sessionId) || !isCurrentEntry(sessionId, entry)) return;
  if (sdkCommandRegistry.get(sessionId).status === 'ready') return;
  // init.slash_commands 是名称级字符串数组（sdk.d.ts:4060）；作为早期快照，仅当该会话尚无任何命令时写入。
  if (Array.isArray(sdkMsg.slash_commands)) {
    const names = (sdkMsg.slash_commands as unknown[]).filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0,
    );
    if (names.length > 0 && sdkCommandRegistry.get(sessionId).commands.length === 0) {
      const initCmds: unknown[] = names.map((n) => ({
        name: n.replace(/^\/+/, ''),
        description: '',
        argumentHint: '',
        aliases: [],
        source: 'sdk',
      }));
      const snap = sdkCommandRegistry.replace(sessionId, initCmds, 'init', buildCommandOriginContext(sdkMsg, sessionId));
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  }
  const startRev = sdkCommandRegistry.getRevision(sessionId);
  if (typeof query.supportedCommands !== 'function') return;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raw = await Promise.race([
      query.supportedCommands(),
      new Promise<never>((_, reject) => {
        // O3：记录定时器句柄，supportedCommands 先 resolve 时在 finally 清理。
        timeoutTimer = setTimeout(() => reject(new Error('supportedCommands timeout')), SUPPORTED_COMMANDS_TIMEOUT_MS);
      }),
    ]);
    // F4：只有仍是启动时代际（期间无 commands_changed 等 replace）才写入，防止 init 旧 probe 覆盖新列表。
    if (
      isSessionActive(sessionId) &&
      isCurrentEntry(sessionId, entry) &&
      sdkCommandRegistry.getRevision(sessionId) === startRev
    ) {
      const snap = sdkCommandRegistry.replace(
        sessionId,
        Array.isArray(raw) ? raw : [],
        'probe',
        sessionCommandCtx.get(sessionId),
      );
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`[${sessionId}] supportedCommands (init fallback) failed: ${message}`);
    if (
      isSessionActive(sessionId) &&
      isCurrentEntry(sessionId, entry) &&
      sdkCommandRegistry.get(sessionId).commands.length === 0
    ) {
      const snap = sdkCommandRegistry.setStatusPreservingCommands(sessionId, 'degraded', `命令发现失败：${message}`);
      emitCommandChanged(sessionId, mainWindow, snap);
    }
  } finally {
    clearTimeout(timeoutTimer);
  }
}

function clearResumeSessionId(sessionId: string): void {
  sessionCliIds.delete(sessionId);
  if (!isSessionActive(sessionId)) return;
  try {
    sessionRepo.updateCliSessionId(sessionId, null);
  } catch (err) {
    logger.warn(`Failed to clear cli session id [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

// 每会话只诊断一次（首回合 result 后调 query.getContextUsage），避免每 turn 重复调用。
const contextUsageDiagnosed = new Set<string>();

// ── 运行一个 query：消费 SDKMessage 流，转 CliEvent 推前端，结束后 emit exit ─
async function runQuery(
  sessionId: string,
  prompt: SdkPrompt,
  mainWindow: BrowserWindow,
  opts: SpawnOptions,
  entry: SessionEntry,
): Promise<void> {
  const { emitExit, emitError } = entry;
  try {
    // Task 4 §7：真实 query 启动前取消该会话的命令探测并等待其结束（有限超时），保证 probe 与真实
    // query 不并行。取消失败不阻塞普通发送超过 cancelCommandProbe 的短超时。
    await cancelCommandProbe(sessionId);
    entry.query = null;

  // spawn 前若已有旧 query（同 session），先中断并移除——与 process-manager 的 killProcess 一致。
  const prev = entries.get(sessionId);
  if (prev && prev !== entry) {
    if (prev.query) interruptedQueries.add(prev.query);
    abortEntry(prev);
    if (prev.query) {
      try {
        await prev.query.interrupt();
      } catch {
        // ignore
      }
    }
    removeEntryIfCurrent(sessionId, prev);
  }
  entry.state = 'running';
  entries.set(sessionId, entry);
  // 回合终态追踪：SDK 正常应在流末 yield 一条 result。但第三方端点（如 glm-5.2）
  // 或 Windows 下 result 常丢失 → for-await 跑完却没终态事件 → 前端 sending 永久卡死
  //（后端 entry 已 deleteEntry 变空闲，故仍能发新消息——状态解耦）。gotResult 标记本回合
  // 是否真收到 result；未收到则在流末合成一条，恢复 process-manager 时代「0 退出无 result
  // 合成 aborted」的兜底（见 cli.ts CliAbortedEvent 注释）。
  let gotResult = false;
  // 每个新 Query 重置本回合卡死追踪与 API retry 状态。
  resetStallTracker(sessionId);
  apiRetryStates.set(sessionId, createApiRetryState(API_RETRY_LIMIT_FALLBACK));
  ensureWatchdog(mainWindow);

  const sdkOptions = buildSdkOptions(opts, sessionId, mainWindow, entry);
  // P1-3（review-v1）：/init 文件副作用诊断——回合开始前记录目标 CLAUDE.md 是否存在。result 成功后
  // 若仍未创建（空目录无内容可分析 / 权限不足 / plan 模式 Write 被拦），推送"未执行文件写入"横幅。
  // 判定基于文件存在性（结构化），不靠 result 文本关键词推断；仅 /init 命令有"应写 CLAUDE.md"的副作用语义。
  // review-v2 P2：带附件时 prompt 是 AsyncIterable，typeof string 判定失效。优先用调用方在
  // SpawnOptions.userCommandText 保留的原始用户命令文本（ipc-handlers/task-queue 在 prepareAttachmentPrompt
  // 前已知 payload.text），不从 AsyncIterable 反推命令名。
  const initCommandText = (opts.userCommandText ?? (typeof prompt === 'string' ? prompt : '')).trim();
  const initCwd = opts.workingDir || getConfig().workingDirectory;
  const initTargetFile = /^(\/init)\b/.test(initCommandText) && initCwd
    ? path.join(initCwd, 'CLAUDE.md')
    : null;
  const initFileExistedBefore = initTargetFile ? existsSync(initTargetFile) : false;
  // 卡死检测/硬杀：每会话一个 AbortController，传入 Options.abortController。
  // killProcess 在软中断之外调 .abort()，Windows 上 → TerminateProcess 真硬杀。
  entry.abortController = new AbortController();
  sdkOptions.abortController = entry.abortController;
  // 项目宗旨：要求用户本地安装 Claude Code，不内嵌二进制。本地没装（pathToClaudeCodeExecutable
  // 解析不到）时给出中文提示，而非把 SDK 的英文 "Native CLI binary not found" 直接甩给用户。
  if (!sdkOptions.pathToClaudeCodeExecutable) {
    forwardEvent(sessionId, mainWindow, {
      type: 'error',
      message: '未检测到本地 Claude Code，请先安装 Claude Code 后重试。',
    });
    emitError(new Error('claude code not found locally'));
    emitExit(1);
    deleteEntry(sessionId, entry);
    return;
  }
  // resume：优先显式传入，否则统一解析（内存 → DB 回填缓存），让重启/崩溃后仍能续接（Task 7B）。
  const resumeId = opts.resumeSessionId || resolveCliSessionId(sessionId);
  if (resumeId) sdkOptions.resume = resumeId;

  let query: Query;
  let resumedOnce = Boolean(resumeId);
  try {
    query = await startSdkQuery(prompt, sdkOptions);
  } catch (err) {
    if (!isCurrentEntry(sessionId, entry)) {
      emitExit(null);
      return;
    }
    if (resumedOnce && isMissingConversationResumeError(err)) {
      logger.warn(`Resume session ${resumeId} not found for app session ${sessionId}; clearing stale cli_session_id and starting a new SDK conversation.`);
      clearResumeSessionId(sessionId);
      delete sdkOptions.resume;
      resumedOnce = false;
      try {
        query = await startSdkQuery(prompt, sdkOptions);
        apiRetryStates.set(sessionId, createApiRetryState(API_RETRY_LIMIT_FALLBACK));
      } catch (retryErr) {
        forwardEvent(sessionId, mainWindow, {
          type: 'error',
          message: `启动 SDK 失败：${retryErr instanceof Error ? retryErr.message : String(retryErr)}`,
        });
        emitError(retryErr instanceof Error ? retryErr : new Error(String(retryErr)));
        emitExit(1);
        deleteEntry(sessionId, entry);
        return;
      }
    } else {
      forwardEvent(sessionId, mainWindow, {
        type: 'error',
        message: `启动 SDK 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      emitError(err instanceof Error ? err : new Error(String(err)));
      emitExit(1);
      deleteEntry(sessionId, entry);
      return;
    }
  }
  if (!isCurrentEntry(sessionId, entry)) {
    interruptedQueries.add(query);
    void query.interrupt().catch(() => {
      // 启动过程中已被 abort/替换，query 刚返回即补发 interrupt，避免旧流继续运行。
    });
    try {
      entry.abortController?.abort();
    } catch {
      // ignore
    }
    emitExit(null);
    return;
  }
  entry.query = query;

  while (true) {
  try {
    for await (const sdkMsg of query as AsyncGenerator<Record<string, unknown>, void>) {
      // 旧 query 被 abort/替换后可能稍后才吐出事件；只允许当前 running entry 继续转发。
      if (!isCurrentEntry(sessionId, entry)) break;
      // 守卫：会话已被删除（SESSION_DELETE 调 markSessionDeleted）→ 立即停止消费流，
      // 不再落库/转发。否则孤儿 query 会继续往已级联删空的 messages 表 INSERT，外键失败回滚阻塞主进程。
      if (!isSessionActive(sessionId)) {
        try {
          await query.interrupt();
        } catch {
          // ignore
        }
        break;
      }
      const type = sdkMsg.type as string;
      if (type === 'system') {
        // system init：提取 session_id（等价 C1 修复），持久化供后续 resume。
        const subtype = sdkMsg.subtype as string | undefined;
        if (subtype === 'init' && sdkMsg.session_id) {
          const sid = sdkMsg.session_id as string;
          touchActivity(sessionId, 'system:init');
          sessionCliIds.set(sessionId, sid);
          // Task 2：捕获命令来源分类上下文（skills/plugins/slash_commands），供本会话 replace 分类。
          sessionCommandCtx.set(sessionId, buildCommandOriginContext(sdkMsg as Record<string, unknown>, sessionId));
          // 会话已删则不写库（避免外键失败）。
          if (isSessionActive(sessionId)) {
            try {
              sessionRepo.updateCliSessionId(sessionId, sid);
            } catch (err) {
              logger.warn(`Failed to persist cli session id [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          // 诊断：init 后 CC 已连通且 query 仍活着，读 CC 实际认定的窗口/阈值/auto-compact 开关，
          // 验证 CLAUDE_CODE_MAX_CONTEXT_TOKENS 注入是否生效 + 第三方端点 auto-compact 是否启用（#65585）。
          // 不能在 result 事件后调——result 是流末事件，query 随即关闭，getContextUsage 会
          // "Query closed before response received"。fire-and-forget，每会话只诊断一次。
          if (!contextUsageDiagnosed.has(sessionId)) {
            contextUsageDiagnosed.add(sessionId);
            void query.getContextUsage()
              .then((cu) => {
                logger.info(
                  `[${sessionId}] getContextUsage 诊断：maxTokens=${cu.maxTokens} rawMaxTokens=${cu.rawMaxTokens}` +
                  ` totalTokens=${cu.totalTokens} percentage=${cu.percentage}` +
                  ` autoCompactThreshold=${cu.autoCompactThreshold ?? 'n/a'} isAutoCompactEnabled=${cu.isAutoCompactEnabled}` +
                  ` | 注入别名=${entry.requestedAlias ?? 'n/a'}`,
                );
              })
              .catch((e) => {
                logger.warn(`[${sessionId}] getContextUsage 诊断失败：${e instanceof Error ? e.message : String(e)}`);
              });
          }
          // Task 4 §2/§3：命令发现兜底——probe 未就绪时用 init.slash_commands + supportedCommands 补全。
          void maybeDiscoverCommandsFromInit(sessionId, mainWindow, entry, sdkMsg, query);
          continue;
        }
        // 系统横幅（informational / compact_boundary / plugin_install）：转发并落库。
        // SDK 的 'info' 子类型归一化为 'informational'。
        const infoSubtype =
          subtype === 'info' ? 'informational' : subtype;
        if (
          infoSubtype === 'informational' ||
          infoSubtype === 'compact_boundary' ||
          infoSubtype === 'plugin_install'
        ) {
          const text =
            typeof sdkMsg.content === 'string' ? sdkMsg.content : (typeof sdkMsg.text === 'string' ? sdkMsg.text : undefined);
          // 问题 5：空文本的 informational 横幅不转发/落库（每回合噪音「ℹ️ 系统提示」）。
          if (!isDisplayableSystemInfo(infoSubtype, text)) continue;
          const sysInfo: CliSystemInfoEvent = {
            type: 'system',
            subtype: infoSubtype,
            text,
            level: sdkMsg.level === 'warn' ? 'warn' : 'info',
          };
          forwardEvent(sessionId, mainWindow, sysInfo);
          continue;
        }
        // api_retry 仅表示 Claude Code 已安排随后的一次真实重试；SDK 的 attempt/max_retries
        // 是当前请求链的权威序号。通知阶段绝不能提前耗尽或中断 Query。
        if (infoSubtype === 'api_retry') {
          const current = apiRetryStates.get(sessionId) ?? createApiRetryState(API_RETRY_LIMIT_FALLBACK);
          const retryDelayMs = typeof sdkMsg.retry_delay_ms === 'number' ? sdkMsg.retry_delay_ms : undefined;
          const errorStatus = typeof sdkMsg.error_status === 'number' ? sdkMsg.error_status : null;
          const sdkAttempt = typeof sdkMsg.attempt === 'number' ? sdkMsg.attempt : undefined;
          const sdkMaxRetries = typeof sdkMsg.max_retries === 'number' ? sdkMsg.max_retries : undefined;
          const next = recordApiRetry(current, {
            now: Date.now(),
            retryAttempt: sdkAttempt,
            retryLimit: sdkMaxRetries,
            retryDelayMs,
            error: typeof sdkMsg.error === 'string' ? sdkMsg.error : undefined,
            errorStatus,
          });
          apiRetryStates.set(sessionId, next.state);
          // v2-F2：terminal（exhausted/recovered/user_stopped）收口后迟到的 api_retry 直接丢弃——
          // recordApiRetry 对 terminal 状态返回原 state（phase 保持 terminal），query 已终止，
          // 前端不得重新显示“正在自动重试”卡片。仅真正排期（phase === 'retrying'）才构造转发。
          if (next.state.phase !== 'retrying') {
            logger.warn(
              `[retry-trace] late_api_retry_dropped session=${sessionId} phase=${next.state.phase} attempt=${sdkAttempt ?? 'unknown'}`,
            );
            continue;
          }
          logger.warn(
            `[retry-trace] retry_scheduled session=${sessionId} query=${entry.queryInstance} attempt=${sdkAttempt ?? 'unknown'}/${sdkMaxRetries ?? API_RETRY_LIMIT_FALLBACK} delayMs=${retryDelayMs ?? 'unknown'} status=${errorStatus ?? 'network'}`,
          );

          const sysInfo: CliSystemInfoEvent = {
            type: 'system',
            subtype: 'api_retry',
            retryCount: next.state.retryCount,
            retryLimit: sdkMaxRetries ?? next.state.retryLimit,
            nextRetryAt: next.state.nextRetryAt ?? undefined,
            retryDelayMs,
            errorStatus,
            error: next.state.lastError ?? undefined,
            sdkAttempt,
            sdkMaxRetries,
            level: 'warn',
          };
          forwardTransient(sessionId, mainWindow, sysInfo);
          continue;
        }
        // 权限询问/拒绝事件：转发并落库（processKind = permission）。
        if (subtype === 'permission_denied' || subtype === 'permission_request') {
          const perm: CliPermissionEvent = {
            type: 'system',
            subtype,
            tool_name: typeof sdkMsg.tool_name === 'string' ? sdkMsg.tool_name : undefined,
            tool_use_id: typeof sdkMsg.tool_use_id === 'string' ? sdkMsg.tool_use_id : undefined,
            message: typeof sdkMsg.message === 'string' ? sdkMsg.message : undefined,
          };
          forwardEvent(sessionId, mainWindow, perm);
          continue;
        }
        // task_*：后台任务编排（后台 Bash / Monitor / 后台子 Agent）。瞬态转发不落库。
        if (subtype === 'task_started' || subtype === 'task_progress' || subtype === 'task_notification') {
          forwardTransient(
            sessionId,
            mainWindow,
            convertTaskEvent(subtype as 'task_started' | 'task_progress' | 'task_notification', sdkMsg),
          );
          continue;
        }
        // task_updated：Claude 计划任务的系统级状态更新（区别于后台 task_*）。
        // patch.status 的 'running' 归一化为 'in_progress'，patch 已知任务。
        // 瞬态转发不落库——计划快照存在独立 claude_plan_state 表。
        if (subtype === 'task_updated') {
          processTaskUpdatedForPlan(sessionId, mainWindow, sdkMsg);
          continue;
        }
        // status:compacting：实时压缩进行中（compact_boundary 是完成后的边界，由 forwardEvent 处理）。
        if (subtype === 'status' && sdkMsg.status === 'compacting') {
          const sysInfo: CliSystemInfoEvent = { type: 'system', subtype: 'compacting' };
          forwardTransient(sessionId, mainWindow, sysInfo);
          continue;
        }
        // M5：status 的其它取值同样可见。compact_result/compact_error 让压缩结果可见
        // （之前只有 compacting，压缩失败时用户无感知）；requesting 视作轻量进度。均为瞬态。
        if (subtype === 'status') {
          if (sdkMsg.compact_result !== undefined) {
            const sysInfo: CliSystemInfoEvent = {
              type: 'system',
              subtype: 'compact_result',
              compactResult: sdkMsg.compact_result === 'success' ? 'success' : 'failed',
              compactError: typeof sdkMsg.compact_error === 'string' ? sdkMsg.compact_error : undefined,
            };
            forwardTransient(sessionId, mainWindow, sysInfo);
          } else if (sdkMsg.status === 'requesting') {
            const sysInfo: CliSystemInfoEvent = { type: 'system', subtype: 'requesting' };
            forwardTransient(sessionId, mainWindow, sysInfo);
          }
          continue;
        }
        // 批次 B：thinking_tokens——思考 token 实时估算（SDK 思考阶段高频流式）。
        // 限频转发（shouldForwardThinkingTokens），瞬态不落库；前端 ContextButton hover 实时展示，
        // 回合结束由 use-chat 清零。estimated_tokens 是思考块累计估算，非计费 output_tokens。
        if (subtype === 'thinking_tokens') {
          const estimated = typeof sdkMsg.estimated_tokens === 'number' ? sdkMsg.estimated_tokens : undefined;
          if (estimated !== undefined && shouldForwardThinkingTokens(sessionId, estimated)) {
            const sysInfo: CliSystemInfoEvent = {
              type: 'system',
              subtype: 'thinking_tokens',
              estimatedTokens: estimated,
            };
            forwardTransient(sessionId, mainWindow, sysInfo);
          }
          continue;
        }
        // Task 4 §4：commands_changed——命令列表中途变化（skills 动态发现等）。SDK 官定客户端应 REPLACE
        // 缓存列表（sdk.d.ts:2751），不重新调 supportedCommands（其只反映 init 时快照）。registry 全量替换，
        // source:'changed'，不落库、不走 CHAT_EVENT（走独立 COMMANDS_CHANGED IPC）。
        if (subtype === 'commands_changed') {
          const rawCommands = Array.isArray(sdkMsg.commands) ? sdkMsg.commands : [];
          // review-v1 §5.1：按当前会话 cwd 重建来源证据（init 时冻结的 evidence 不反映会话过程中
          // 新增/修改/删除的项目命令文件 .claude/skills、.claude/commands）。skills/plugins/slashCommands
          // 名称集合沿用 init（SDK canonical 视图），evidence 按当前磁盘状态重扫。
          const snap = sdkCommandRegistry.replace(sessionId, rawCommands, 'changed', refreshCommandOriginContext(sessionId, opts.workingDir || getConfig().workingDirectory || undefined));
          emitCommandChanged(sessionId, mainWindow, snap);
          continue;
        }
        // Task 8：local_command_output——本地命令（/clear /help 等）的输出。主进程单一落库
        // （role:system, processKind 'system:local_command_output'），renderer 按 persisted_message upsert，
        // 不二次落库。content 为 string 时原样；非 string 安全 JSON.stringify；不靠正文正则猜命令名。
        // result.result 走现有 result 终态（/usage 等结果只出现在 result.result，见 §0.1-9），两者并存。
        if (subtype === 'local_command_output') {
          const rawContent = sdkMsg.content;
          const content = typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent ?? '');
          persistLocalCommandOutput(sessionId, mainWindow, content);
          continue;
        }
        // 其它未知 system 子类型：暂不转发（前端不消费）。
        continue;
      }
      if (type === 'assistant') {
        // assistant 带 error 表示最后一次真实尝试失败；正常 assistant 才表示重试恢复。
        if (typeof sdkMsg.error === 'string') {
          finishApiRetryExhausted(sessionId, mainWindow, entry.queryInstance);
        } else {
          finishApiRetryRecovery(sessionId, mainWindow, entry.queryInstance);
        }
        const cliEvent = convertAssistantMessage(sdkMsg);
        if (cliEvent) {
          forwardEvent(sessionId, mainWindow, cliEvent);
          // Claude 计划：扫描 tool_use 块，处理 TodoWrite/TaskCreate/TaskUpdate 等。
          // 不写入 messages 表——计划快照存在独立 claude_plan_state 表。
          // F9：传 parentToolUseId，子 Agent 的 plan 工具不影响父会话主计划。
          processAssistantToolUseForPlan(sessionId, mainWindow, cliEvent.content, cliEvent.parentToolUseId);
        }
        continue;
      }
      if (type === 'user') {
        // 问题 6（根因）：SDK 的 user 消息是回传「工具执行结果」的通道——content 含 tool_result /
        // *_tool_result 等结果块。原先整类 user 消息「暂不转发」，导致 tool_result 永不落库：主/子 Agent
        // 的工具结果都显示不出来（DB 实测 tool_result 0 行、子 Agent 联网搜索「全部没有结果」即此所致）。
        // 这里仅取出结果类 part 转发（convertAssistantMessage 已透传 parent_tool_use_id，子 Agent 的结果能归到对应组）；
        // 纯文本 user 消息（初始 prompt 回显）无结果 part → 跳过，避免与本地已落库的用户输入重复。
        const cliEvent = convertAssistantMessage(sdkMsg);
        if (cliEvent) {
          const resultParts = cliEvent.content.filter(isToolResultPart);
          if (resultParts.length > 0) {
            forwardEvent(sessionId, mainWindow, { ...cliEvent, content: resultParts });
            // Claude 计划：配对 tool_result 与缓存的 tool_use，解析 TaskCreate/TaskList/TaskGet 输出。
            // F1: 传 sdkMsg.tool_use_result（SDK 顶层结构化结果，非 content 文本）。
            processToolResultForPlan(sessionId, mainWindow, resultParts, sdkMsg.tool_use_result);
          }
        }
        continue;
      }
      if (type === 'stream_event') {
        finishApiRetryRecovery(sessionId, mainWindow, entry.queryInstance);
        forwardEvent(sessionId, mainWindow, convertStreamEvent(sdkMsg));
        continue;
      }
      if (type === 'tool_progress') {
        forwardTransient(sessionId, mainWindow, convertToolProgress(sdkMsg));
        continue;
      }
      // SDK 内置心跳：只证明子进程还活着，不代表模型/API/工具有业务进展。
      // 因此只记录诊断时间，不刷新 lastActivityAt，避免代理死等但持续心跳时永远不触发 stalled。
      if (type === 'keep_alive') {
        touchKeepAlive(sessionId);
        continue;
      }
      if (type === 'result') {
        gotResult = true;
        if (sdkMsg.is_error === true) {
          finishApiRetryExhausted(sessionId, mainWindow, entry.queryInstance);
        }
        // P1-3 / review-v2 P1 / review-v3 P1：/init 回合结束（result 到达）但未创建 CLAUDE.md → 推送独立
        // init_write_skipped 横幅（计划 Task 5 Step 3）。用专用 subtype 而非 informational——informational
        // 会被 renderer 冗余过滤吞掉（review-v2 P1）。review-v3 P1：与 result.is_error 解耦——无论成功
        // （空目录无内容可分析）还是 plan/权限拒绝（Write 被拦，is_error=true/error_max_turns），只要回合前
        // 目标文件不存在且回合后仍不存在，就发此提示。它不声称成功（warn 级 + 「未能创建」文案），只陈述
        // 「未写入」事实，与普通错误终态并存。取消（aborted 无 result）不走此分支（result 未到达）。
        if (initTargetFile && !initFileExistedBefore && !existsSync(initTargetFile)) {
          forwardEvent(sessionId, mainWindow, {
            type: 'system',
            subtype: 'init_write_skipped',
            text: '未执行文件写入：/init 未能创建 CLAUDE.md（目录可能为空或被权限/计划模式拦截），请检查工作目录内容与权限。',
            level: 'warn',
          });
        }
        forwardEvent(sessionId, mainWindow, convertResultMessage(sdkMsg));
        // result 已明确结束当前回合：先释放 active entry，再通知队列退出。
        // renderer 收到 result 后可立即发送下一回合，不再撞上尚未走到函数 finally 的旧 entry。
        deleteEntry(sessionId, entry);
        emitExit(0);
        return;
      }
      // 其它 system 子类型 / hook 等暂不转发（前端不消费）。user 消息已在上方按「结果类 part」转发。
    }
    // 流正常结束。若旧 query 已被 abort/替换，按中断收尾，避免误报成功退出。
    // 终态兜底：本回合未收到 result（第三方端点/Windows 丢包）→ 合成一条 aborted，
    // 保证前端 sending 必复位。前端 aborted 处理器幂等 markStopped；persistCliEvent 对
    // aborted 无 case，不落库、不污染历史（与既有中断路径同形，见下方 catch 的 aborted）。
    // 仅对当前 entry 合成——已被替换的旧 entry 由新 entry 负责发终态，这里跳过避免重复。
    if (isCurrentEntry(sessionId, entry) && !gotResult) {
      forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '回合已结束' });
      deleteEntry(sessionId, entry);
      emitExit(0);
      return;
    }
    emitExit(null);
    break;
  } catch (err) {
    if (!isCurrentEntry(sessionId, entry)) {
      emitExit(null);
      break;
    }
    if (resumedOnce && isMissingConversationResumeError(err)) {
      logger.warn(`Resume session ${resumeId} not found while streaming app session ${sessionId}; clearing stale cli_session_id and starting a new SDK conversation.`);
      clearResumeSessionId(sessionId);
      delete sdkOptions.resume;
      resumedOnce = false;
      try {
        query = await startSdkQuery(prompt, sdkOptions);
        entry.query = query;
        gotResult = false; // 新 query = 新回合，重置终态追踪
        apiRetryStates.set(sessionId, createApiRetryState(API_RETRY_LIMIT_FALLBACK));
        continue;
      } catch (retryErr) {
        const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        forwardEvent(sessionId, mainWindow, { type: 'error', message: `SDK 执行出错：${msg}` });
        emitExit(1);
        break;
      }
    }
    if (interruptedQueries.has(query)) {
      // 用户中断：发 aborted（不弹错误，等价 M4）。
      forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '已中断' });
      emitExit(null);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      forwardEvent(sessionId, mainWindow, { type: 'error', message: `SDK 执行出错：${msg}` });
      emitExit(1);
    }
    break;
  }
  }
  } catch (err) {
    // buildSdkOptions / 其它启动阶段异常不在内部 startSdkQuery catch 覆盖范围内；
    // 必须发终态并交给 finally 清理 entry，否则 fire-and-forget runQuery 会永久占坑。
    if (isCurrentEntry(sessionId, entry)) {
      const message = err instanceof Error ? err.message : String(err);
      forwardEvent(sessionId, mainWindow, { type: 'error', message: `SDK 执行出错：${message}` });
      emitError(err instanceof Error ? err : new Error(message));
      emitExit(1);
    } else {
      emitExit(null);
    }
  } finally {
    deleteEntry(sessionId, entry);
  }
}

// ── 同形公共接口（与 process-manager 签名一致）──────────────────────
export function spawnForChat(
  sessionId: string,
  mainWindow: BrowserWindow,
  opts: SpawnOptions = {},
): SdkQueryHandle {
  // 创建 entry（handle + emit 一次成型）。不立即起 query——等 sendMessage 带首条消息再 query()。
  // pendingFirstPrompt 记住 mainWindow/opts，sendMessage 时用同 entry 起 query，
  // 这样 spawn 时返回的 handle 就是 runQuery 要 emit 的那个，on('exit') 回调不丢失。
  // 若已有 pending 或 active entry，拒绝覆盖，防止并发 CHAT_SEND 后写吃掉先写的 prompt。
  if (pendingFirstPrompt.has(sessionId) || isEntryActive(entries.get(sessionId))) {
    throw new Error('当前回合仍在执行，请等待结束或中断后重试');
  }
  const entry = createEntry();
  entries.set(sessionId, entry);
  markSessionActive(sessionId);
  pendingFirstPrompt.set(sessionId, { mainWindow, opts, entry });
  return entry.handle;
}

// 首条 prompt 待发：spawnForChat 只准备，sendMessage 真正触发 query。
const pendingFirstPrompt = new Map<
  string,
  { mainWindow: BrowserWindow; opts: SpawnOptions; entry: SessionEntry }
>();

export function spawnForTask(
  taskId: string,
  sessionId: string,
  prompt: SdkPrompt,
  mainWindow: BrowserWindow,
  opts: SpawnOptions = {},
): SdkQueryHandle {
  void taskId;
  // task 模式：prompt 已知，直接起 query。entry 一次成型，runQuery 复用其 emit。
  const entry = createEntry();
  entries.set(sessionId, entry);
  markSessionActive(sessionId);
  void runQuery(sessionId, prompt, mainWindow, opts, entry);
  return entry.handle;
}

export function sendMessage(sessionId: string, message: SdkPrompt): void {
  // 首条消息（pendingFirstPrompt 存在）：用同一 entry 起新 query，message 即 prompt。
  const pending = pendingFirstPrompt.get(sessionId);
  if (pending) {
    pendingFirstPrompt.delete(sessionId);
    void runQuery(sessionId, message, pending.mainWindow, pending.opts, pending.entry);
    return;
  }
  // 后续消息：SDK 单 query 模式下不能往已运行的 query 追加 prompt
  // （需 streaming input + AsyncIterable；当前架构每次消息起新 query + resume）。
  // 误用（未 spawn / 活 query 中途追加）一律抛错，禁止静默 drop。
  const entry = entries.get(sessionId);
  if (entry?.query) {
    throw new Error('当前回合仍在执行，请等待结束或中断后重试');
  }
  throw new Error(`会话 ${sessionId} 没有待发送的 SDK 入口，请先 spawnForChat。`);
}

export type KillReason =
  | 'user'
  | 'api_retry_exhausted'
  | 'watchdog'
  | 'queue'
  | 'session_cleanup';

export function killProcess(
  sessionId: string,
  reason: KillReason,
  mainWindow?: BrowserWindow,
): void {
  if (reason === 'user' && mainWindow) {
    const current = apiRetryStates.get(sessionId);
    if (current) {
      const stopped = recordApiRetryUserStop(current, Date.now());
      apiRetryStates.set(sessionId, stopped.state);
      if (stopped.becameStopped) {
        persistApiRetryTerminal(sessionId, mainWindow, stopped.state);
      }
    }
  }
  cancelInteractionsForSession(sessionId);
  pendingFirstPrompt.delete(sessionId);
  const entry = entries.get(sessionId);
  if (entry) {
    // user 与 watchdog 中断都记入 interruptedQueries：让 runQuery 的 catch 走 aborted 分支
    //（干净收尾），避免 watchdog 已发友好 error 后又叠一条「SDK 执行出错」。
    if (entry.query) interruptedQueries.add(entry.query);
    abortEntry(entry);
    // 立即从 active entries 移除：retryLastTurn 后续 CHAT_SEND 才能走 spawnForChat + resume，
    // 不会被 getActiveProcess 误判为仍有活 query 而把消息 drop 掉。旧 query 退出时靠 identity guard 清理。
    removeEntryIfCurrent(sessionId, entry);
    cleanupSessionStall(sessionId);
    // Task 4 review P1-2：用户中断/卡死硬杀须显式发幂等 aborted 终态。killProcess 已 abortEntry
    // （state='aborting'）+ removeEntryIfCurrent，isCurrentEntry 此后 false；runQuery 流末兜底
    // （isCurrentEntry 检查）与 catch 段（!isCurrentEntry → emitExit(null)）都不会再发 aborted，
    // 导致后台会话/窗口切换/依赖统一终态事件的路径收不到取消结果、sending 不复位。此处补发：
    // forwardEvent 对 aborted 只 IPC 不落库（persistCliEvent 无 case），前端 markStopped 幂等；
    // runQuery 不会重复发（上述分支已吞掉）。session_cleanup/queue/api_retry_exhausted 不发
    // （会话已删 forwardEvent 被 isSessionActive 守卫拦，或新 query 接管负责终态）。
    if ((reason === 'user' || reason === 'watchdog') && mainWindow) {
      forwardEvent(sessionId, mainWindow, { type: 'aborted', message: reason === 'user' ? '已中断' : '已硬中断' });
    }
    if (entry.query) {
      void entry.query.interrupt().catch(() => {
        // 软中断失败不阻塞；query 会因迭代抛错走 aborted 分支。
      });
    }
    // 硬杀兜底：query.interrupt() 是 stdin 控制帧（软），子进程卡死在死 socket 上时
    // 根本读不到。abortController.abort() 经 SDK 在 Windows 上 → TerminateProcess
    //（瞬时不可捕获），真能打死。两条都发，软的先给优雅退出机会。
    logger.info(`Interrupted SDK query for session ${sessionId} (reason=${reason}, abort signaled)`);
  }
  // killProcess 会先移除当前 entry，迟到的 deleteEntry 因 identity guard 不再清理；
  // 因此在终态已由调用方写入后同步收口，避免被中断 Query 的状态滞留。
  apiRetryStates.delete(sessionId);
}

export function killAllProcesses(): void {
  for (const [sessionId] of entries) {
    killProcess(sessionId, 'session_cleanup');
  }
}

export function getActiveProcess(sessionId: string): SdkQueryHandle | undefined {
  const entry = entries.get(sessionId);
  return isEntryActive(entry) ? entry.handle : undefined;
}

export function getCliSessionId(sessionId: string): string | undefined {
  return sessionCliIds.get(sessionId);
}

/**
 * 统一 resume ID 解析（Task 7B）：内存优先，未命中查 DB 并回填缓存，再无则 undefined。
 * 让 task 执行 / waiting 续接 / 应用重启路径在内存丢失（重启/崩溃）后仍能从 DB 恢复 resume，
 * 避免 stale transcript 或 resume 丢失导致图片/消息重发。
 */
export function resolveCliSessionId(sessionId: string): string | undefined {
  const cached = sessionCliIds.get(sessionId);
  if (cached) return cached;
  const persisted = sessionRepo.getSession(sessionId)?.cliSessionId ?? undefined;
  if (persisted) sessionCliIds.set(sessionId, persisted);
  return persisted;
}

export function setCliSessionId(sessionId: string, cliSessionId: string): void {
  sessionCliIds.set(sessionId, cliSessionId);
}
