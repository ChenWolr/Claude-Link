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
import type { PermissionResponsePayload } from '../../shared/types/ipc';
import { getConfig } from './config-manager';
import { resolveAliasToActualModel, resolveDefaultModel } from '../../shared/settings-parser';
import { resolveContextWindowForSession, lookupUserContextWindow } from '../../shared/model-context-windows';
import { logger } from '../utils/logger';
import * as sessionRepo from '../database/repositories/session-repo';
import { extractContextTokens, detectCompaction } from '../../shared/context-usage';
import { convertToolProgress, convertTaskEvent } from '../../shared/progress-events';
import { isDisplayableSystemInfo } from '../../shared/system-info';
import type { ContextStatsPayload } from '../../shared/types/ipc';
import type {
  CliEvent,
  CliMessageContentPart,
  CliMessageEvent,
  CliResultEvent,
  CliStreamEvent,
  CliSystemInfoEvent,
  CliPermissionEvent,
} from '../../shared/types/cli';
import type { SpawnOptions } from './cli-shared';
// 复用 cli-shared 的纯函数（env 注入 / 落库）。
import {
  buildSpawnEnv,
  normalizeToolResultContent,
  persistCliEvent,
  persistMessageParts,
} from './cli-shared';
import { isMissingConversationResumeError } from './sdk-errors';
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
import { isSubAgentToolUse } from '../../shared/process-kind';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind, type StallInfo, type StallThresholds } from '../../shared/stall-watchdog';

// 显式标注上述工具被复用（避免 lint 误报未使用）；persistMessageParts/normalizeToolResultContent
// 在 convertAssistantMessage 后落库路径会用到。
void normalizeToolResultContent;
void persistMessageParts;

// ── SDK 动态加载（ESM）─────────────────────────────────────────────
// query() 返回 Query（AsyncGenerator<SDKMessage> + interrupt()/setPermissionMode()）。
// 这里只引 type，运行时值由 importSdk() 动态获取。
type Query = AsyncGenerator<Record<string, unknown>, void> & {
  interrupt(): Promise<void>;
};

interface SdkModule {
  query: (params: { prompt: string | unknown; options?: Record<string, unknown> }) => Query;
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
  // 启动时解析出的模型类型别名(sonnet/haiku/opus/fable)或自定义真实模型名。
  // persistCliEvent 推送初始 windowSize 时，按它查用户设的按别名上下文覆盖。
  requestedAlias: string | null;
}
const entries = new Map<string, SessionEntry>();
const sessionCliIds = new Map<string, string>();
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
  // 连续 api_retry 次数：每次 api_retry 自增，仅模型级活动（message/stream_event，见 touchActivity）清零。
  // 达 MAX_API_RETRIES 即快速硬中断，专治空/畸形响应重试风暴。
  consecutiveApiRetries: number;
}
const stallTrackers = new Map<string, StallTracker>();
// 待决 tool_use id 集合（判定 zone：有无工具在跑）。add on tool_use，delete on tool_result。
const pendingToolUseIds = new Map<string, Set<string>>();
// 待决子 Agent/Workflow tool_use id 集合（用于横幅定位疑似卡住的子 Agent）。
const pendingSubAgentUseIds = new Map<string, Set<string>>();
function envInt(name: string, dflt: number): number {
  const v = process.env[name];
  const n = v ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
// 阈值可用环境变量覆盖（CLAUDE_LINK_STALL_MODEL_MS / _TOOL_MS / _HARD_MS / _TOOL_HARD_MS），默认见 stall-watchdog.ts。
const STALL_THRESHOLDS: StallThresholds = {
  modelGapMs: envInt('CLAUDE_LINK_STALL_MODEL_MS', DEFAULT_STALL_THRESHOLDS.modelGapMs),
  toolPendingMs: envInt('CLAUDE_LINK_STALL_TOOL_MS', DEFAULT_STALL_THRESHOLDS.toolPendingMs),
  hardAutoAbortMs: envInt('CLAUDE_LINK_STALL_HARD_MS', DEFAULT_STALL_THRESHOLDS.hardAutoAbortMs),
  // TOOL 区绝对硬中断上限（兜子 Agent 死锁/死连接；合法长工具持续发 tool_progress 不会误触）。
  toolHardAbortMs: envInt('CLAUDE_LINK_STALL_TOOL_HARD_MS', DEFAULT_STALL_THRESHOLDS.toolHardAbortMs),
};
// 连续 api_retry 达此次数（期间无任何真实业务进展）即快速硬中断——专治「空/畸形响应」重试风暴，
// 不必死等 toolHardAbortMs（默认 900s）。SDK 正常限流重试几次后会成功并清零本计数，不会误触。
const MAX_API_RETRIES = envInt('CLAUDE_LINK_MAX_API_RETRIES', 10);
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
    consecutiveApiRetries: 0,
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
  // Bug3：consecutiveApiRetries 只在「模型级」活动（message/stream_event）清零。api_retry 是模型 API
  // 失败信号，唯有模型恢复并真正产出（消息/流式）才代表重试风暴已过；tool_progress/system 是工具执行
  // 与编排活动，与模型健康无关。旧逻辑一概清零 → subagent 跑工具时 api_retry 风暴被反复清零，永远爬不到
  // MAX_API_RETRIES，第二轮 API 死亡时既不硬中断也不再弹横幅，陷入无限等待。改为仅模型级清零后，
  // 风暴能正常累加至阈值触发硬中断（出口）。
  if (kind === 'message' || kind === 'stream_event') {
    t.consecutiveApiRetries = 0;
  }
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
  // api_retry：SDK 正在重试一次失败的 API 调用（如空/畸形响应）——是失败信号而非业务进展。
  // 只累加连续重试计数，不刷新 lastActivityAt（否则重试风暴永远判不出卡死）。
  // 事件本身经 forwardTransient 转发（不落库、不进聊天流），渲染层作瞬态「API 重试中」指示器，
  // 用本回合累计计数（而非 SDK 单次 attempt 字段，第三方端点常恒为 1）原地递增显示「第 N 次」。
  if (event.type === 'system' && (event as CliSystemInfoEvent).subtype === 'api_retry') {
    t.consecutiveApiRetries += 1;
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
    // 连续 api_retry 快速中断：API 反复空/畸形响应（重试风暴）时不必死等 toolHardAbortMs，
    // 直接判定代理/模型服务故障硬杀，让用户在 ~1-2 分钟内得到反馈而非无限等待。
    if (!t.hardAbortFired && t.consecutiveApiRetries >= MAX_API_RETRIES) {
      t.hardAbortFired = true;
      forwardEvent(sessionId, mw, {
        type: 'error',
        message: `API 连续重试 ${t.consecutiveApiRetries} 次仍失败（疑似空/畸形响应或代理网关异常），已自动中断。可点击「重试」重新发送。`,
      });
      logger.error(`[stall] api-retry abort session ${sessionId}: ${t.consecutiveApiRetries} consecutive retries`);
      killProcess(sessionId, 'watchdog');
      continue;
    }
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
      killProcess(sessionId, 'watchdog');
    }
  }
}

const pendingPermissionRequests = new Map<string, (response: PermissionResponsePayload) => void>();
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
  // 清理上下文/权限缓存，避免会话删除后 stale 数据堆积（内存泄漏）。
  sessionContextStats.delete(sessionId);
  sessionPermissionUpdates.delete(sessionId);
  cleanupSessionStall(sessionId);
  for (const [id, resolve] of pendingPermissionRequests) {
    pendingPermissionRequests.delete(id);
    resolve({ id, optionId: 'deny' });
  }
}
function markSessionActive(sessionId: string): void {
  activeSessions.add(sessionId);
}
function isSessionActive(sessionId: string): boolean {
  return activeSessions.has(sessionId);
}

export function respondToPermissionRequest(response: PermissionResponsePayload): void {
  const resolve = pendingPermissionRequests.get(response.id);
  if (!resolve) {
    logger.warn(`Permission response ignored; request not found: ${response.id}`);
    return;
  }
  pendingPermissionRequests.delete(response.id);
  resolve(response);
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
  return (updates ?? [])
    .filter((u) => u.destination === 'session' && (u.type === 'addRules' || u.type === 'replaceRules') && u.behavior === 'allow')
    .flatMap((u) => u.rules.filter((r) => !r.ruleContent).map((r) => r.toolName));
}

function createPermissionHandler(sessionId: string, mainWindow: BrowserWindow) {
  return async (toolName: string, input: Record<string, unknown>, options: CanUseToolOptions): Promise<PermissionResult> => {
    if (!isSessionActive(sessionId)) {
      return { behavior: 'deny', message: '会话已关闭', interrupt: true, toolUseID: options.toolUseID };
    }

    if (toolName === 'AskUserQuestion' && isAskUserQuestionPayload(input)) {
      const result = await requestAskUserQuestionInteractions(sessionId, mainWindow, input, options);
      if (result) {
        recordInteractionResponse(sessionId, mainWindow, '用户完成选择题', Object.entries(result.answers).map(([question, answer]) => `${question}: ${answer}`).join('\n'));
        return { behavior: 'allow', updatedInput: result, toolUseID: options.toolUseID };
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
    if (result.behavior === 'allow') {
      rememberSessionPermissionUpdates(sessionId, result.updatedPermissions);
    }
    logger.info(`[canUseTool-resp] tool=${toolName} action=${response.action} selected=${JSON.stringify(response.selectedOptionIds ?? null)} wrotePerm=${result.updatedPermissions?.length ?? 0} bookToolsAfter=[${bookToolNames(sessionPermissionUpdates.get(sessionId)).join(',')}]`);
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
    emitExit: (code) => {
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
function buildSdkOptions(opts: SpawnOptions, sessionId: string, mainWindow: BrowserWindow, entry: SessionEntry): Record<string, unknown> {
  const config = getConfig();
  const options: Record<string, unknown> = {
    // env：apiKey/baseUrl/模型映射全靠它（复用 buildSpawnEnv，第三方端点跑通的关键）。
    env: buildSpawnEnv(),
    // 复用本地安装的 claude（cli-detector 发现）。cliPath 可能是裸命令名，需解析成绝对路径
    //（Windows 上还要穿透 .cmd shim 拿到真正 .exe），否则 SDK 报 "native binary not found"。
    // 项目不内嵌二进制，解析失败留 undefined，由 runQuery 给中文提示。
    pathToClaudeCodeExecutable: resolveExecutable(config.cliPath),
    // 脱离磁盘 settings：完全由 claude-link 内联控制，避免 ~/.claude/settings.json 污染。
    settingSources: [],
    // 拿流式增量（对应 stream_event），前端逐字/逐工具参数显示。
    includePartialMessages: true,
    // Bug2：转发子 agent 的 text/thinking 为带 parent_tool_use_id 的消息（sdk.d.ts 的 forwardSubagentText，
    // 默认 false 只转发 tool_use/tool_result）。开启后子 Agent Tab 能看到子 agent 完整思考/正文，
    // 配合 stream_event 透传的 parent_tool_use_id，思考中也实时可见，不再只有「开启subagent」锚点。
    forwardSubagentText: true,
    // 启用 adaptive thinking，并显式请求摘要展示；否则新模型默认可能 omitted，思考中无可展示内容。
    thinking: { type: 'adaptive', display: 'summarized' },
    canUseTool: createPermissionHandler(sessionId, mainWindow),
    onElicitation: createElicitationHandler(sessionId, mainWindow),
    // SDK 只有同时声明 supportedDialogKinds 与 onUserDialog，才会把选择题交互交给宿主 UI。
    supportedDialogKinds: SUPPORTED_USER_DIALOG_KINDS,
    onUserDialog: createUserDialogHandler(sessionId, mainWindow),
  };

  // 模型：与 process-manager.buildCommonArgs 同规则——别名解析成实际模型名再传。
  const requestedAlias = opts.modelOverride || opts.model || resolveDefaultModel(config.advancedJson);
  entry.requestedAlias = requestedAlias;
  options.model = resolveAliasToActualModel(requestedAlias, config.advancedJson);

  if (opts.workingDir) options.cwd = opts.workingDir;
  else if (config.workingDirectory) options.cwd = config.workingDirectory;

  if (opts.maxTurns && opts.maxTurns > 0) options.maxTurns = opts.maxTurns;

  if (opts.permissionMode && opts.permissionMode !== 'default') {
    options.permissionMode = opts.permissionMode;
    if (opts.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
  }

  // 内联 settings——脱离磁盘（settingSources:[]），由 claude-link 完全主导。
  // 与 settings-writer.writeClaudeSettings 共用完整投影（buildClaudeSettingsProjection），避免 SDK 路径丢
  // hooks 等 advancedJson 顶层设置；投影内含 env（apiKey/baseUrl/advancedJson.env 字符串项）。
  const settings = buildClaudeSettingsProjection(config);
  // buildClaudeSettingsProjection 返回类型宽化为 Record<string,unknown>，但 env 运行时实为 Record<string,string>；
  // 取别名供下方按会话别名补注入 MAX_CONTEXT_TOKENS（投影不含该项，需在此按会话补）。
  const settingsEnv = settings.env as Record<string, string>;

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
  options.settings = {
    ...settings,
    permissions: applySessionPermissionUpdates(sessionId, settings.permissions as SdkPermissionSettings),
  };

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

function isToolResultPart(part: CliMessageContentPart): boolean {
  return part.type === 'tool_result' || part.type.endsWith('_tool_result');
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

// SDK result → CliResultEvent（字段一一对应）。
function convertResultMessage(sdkMsg: Record<string, unknown>): CliEvent {
  const rawErrors = Array.isArray(sdkMsg.errors) ? sdkMsg.errors : [];
  const errors = rawErrors
    .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string' ? (item as { message: string }).message : ''))
    .filter((item) => item.trim().length > 0);
  return {
    type: 'result',
    subtype: (sdkMsg.subtype as string) ?? 'success',
    result: (sdkMsg.result as string) ?? '',
    total_cost_usd: (sdkMsg.total_cost_usd as number) ?? 0,
    duration_ms: (sdkMsg.duration_ms as number) ?? 0,
    num_turns: (sdkMsg.num_turns as number) ?? 0,
    session_id: (sdkMsg.session_id as string) ?? '',
    is_error: Boolean(sdkMsg.is_error),
    ...(errors.length > 0 ? { errors } : {}),
    terminalReason: typeof sdkMsg.terminal_reason === 'string' ? sdkMsg.terminal_reason : undefined,
    apiErrorStatus: typeof sdkMsg.api_error_status === 'number' ? sdkMsg.api_error_status : null,
    stopReason: typeof sdkMsg.stop_reason === 'string' ? sdkMsg.stop_reason : null,
    usage: (sdkMsg.usage as CliResultEvent['usage']) ?? undefined,
    modelUsage: (sdkMsg.modelUsage as CliResultEvent['modelUsage']) ?? undefined,
  } as CliResultEvent;
}

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

async function startSdkQuery(prompt: string, options: Record<string, unknown>): Promise<Query> {
  const sdk = await importSdk();
  return sdk.query({ prompt, options });
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
  prompt: string,
  mainWindow: BrowserWindow,
  opts: SpawnOptions,
  entry: SessionEntry,
): Promise<void> {
  const { emitExit, emitError } = entry;
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
  // 每个新 query 重置卡死追踪（per-turn stallCount / hardAbortFired）。
  resetStallTracker(sessionId);
  ensureWatchdog(mainWindow);

  const sdkOptions = buildSdkOptions(opts, sessionId, mainWindow, entry);
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
  // resume：优先显式传入，否则用已记录的 CLI session id（等价 process-manager 的 --resume）。
  const resumeId = opts.resumeSessionId || sessionCliIds.get(sessionId);
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
    for await (const sdkMsg of query) {
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
        // api_retry：API 重试进度（限流/过载/鉴权失败等，每次重试前发出）。
        // Bug4/Bug5：改走 forwardTransient——不落库、不进聊天流（不再是「系统消息」噪音）。
        // 渲染层把它当瞬态「API 重试中」指示器，并用本回合累计计数原地递增（而非下方的 attempt 字段——
        // 第三方端点常恒报 1）。consecutiveApiRetries 仍由上面 touchActivityFromEvent（经 forwardTransient）
        // 累加，供看门狗硬中断判定，不受此处通道切换影响。
        if (infoSubtype === 'api_retry') {
          const sysInfo: CliSystemInfoEvent = {
            type: 'system',
            subtype: 'api_retry',
            attempt: typeof sdkMsg.attempt === 'number' ? sdkMsg.attempt : undefined,
            max_retries: typeof sdkMsg.max_retries === 'number' ? sdkMsg.max_retries : undefined,
            error: typeof sdkMsg.error === 'string' ? sdkMsg.error : undefined,
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
        // 其它未知 system 子类型：暂不转发（前端不消费）。
        continue;
      }
      if (type === 'assistant') {
        const cliEvent = convertAssistantMessage(sdkMsg);
        if (cliEvent) forwardEvent(sessionId, mainWindow, cliEvent);
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
          }
        }
        continue;
      }
      if (type === 'stream_event') {
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
        forwardEvent(sessionId, mainWindow, convertResultMessage(sdkMsg));
        continue;
      }
      // 其它 system 子类型 / hook 等暂不转发（前端不消费）。user 消息已在上方按「结果类 part」转发。
    }
    // 流正常结束。若旧 query 已被 abort/替换，按中断收尾，避免误报成功退出。
    emitExit(isCurrentEntry(sessionId, entry) ? 0 : null);
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
  deleteEntry(sessionId, entry);
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
  prompt: string,
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

export function sendMessage(sessionId: string, message: string): void {
  // 首条消息（pendingFirstPrompt 存在）：用同一 entry 起新 query，message 即 prompt。
  const pending = pendingFirstPrompt.get(sessionId);
  if (pending) {
    pendingFirstPrompt.delete(sessionId);
    void runQuery(sessionId, message, pending.mainWindow, pending.opts, pending.entry);
    return;
  }
  // 后续消息：SDK 单 query 模式下不能往已运行的 query 追加 prompt
  // （需 streaming input + AsyncIterable；当前架构每次消息起新 query + resume）。
  // 若有活 query 则记为待续写（下一条会走 spawnForChat+resume）；无活 query 则 warn。
  // 实际聊天续写由 ipc-handlers 的 getActiveProcess 分支判断走 spawnForChat 新 query。
  const entry = entries.get(sessionId);
  if (!entry || !entry.query) {
    logger.warn(`No active SDK query for session ${sessionId}; message dropped.`);
  }
}

export function killProcess(sessionId: string, reason: 'user' | 'watchdog' = 'user'): void {
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
}

export function killAllProcesses(): void {
  for (const [sessionId] of entries) {
    killProcess(sessionId);
  }
}

export function getActiveProcess(sessionId: string): SdkQueryHandle | undefined {
  const entry = entries.get(sessionId);
  return isEntryActive(entry) ? entry.handle : undefined;
}

export function getCliSessionId(sessionId: string): string | undefined {
  return sessionCliIds.get(sessionId);
}

export function setCliSessionId(sessionId: string, cliSessionId: string): void {
  sessionCliIds.set(sessionId, cliSessionId);
}
