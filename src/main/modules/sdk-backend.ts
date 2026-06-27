// sdk-backend.ts
// Claude Agent SDK 适配器：用 @anthropic-ai/claude-agent-sdk 的 query() 替代自建 spawn claude CLI。
//
// 这是 claude-link 的默认且唯一聊天/任务后端（chat-backend.ts re-export 自本模块）。
// 保留 process-manager.ts 作为代码级回退：把 chat-backend.ts 的 re-export 来源改回
// './process-manager' 即全量切回旧的 spawn 路径。
//
// 设计要点：
//  - 与 process-manager 同形接口（spawnForChat/spawnForTask/sendMessage/killProcess/...），
//    ipc-handlers / task-queue-engine 仅改 import 来源，逻辑不动。
//  - SDKMessage → CliEvent 转换（形态高度同构），转换出的事件复用 process-manager 的
//    persistCliEvent / persistMessageParts 落库，并通过 CHAT_EVENT 推前端——前端零改。
//  - Query.interrupt() 走 stdin 控制帧，跨平台（含 Windows）优雅中断当前回合。
//  - buildSpawnEnv 复用：env（含 apiKey/baseUrl/模型映射）原样喂给 Options.env，第三方端点跑通。
//  - pathToClaudeCodeExecutable 取 getConfig().cliPath（cli-detector 发现的系统 claude），
//    不依赖 SDK 自带二进制，规避 Electron 打包坑。
//
// SDK 是纯 ESM（"type":"module"），项目 main 进程经 electron-vite 编译为 CJS，
// 故用模块级缓存的动态 import() 加载 SDK，避免 CJS 静态 import ESM 的语法限制。

import type { BrowserWindow } from 'electron';
import { existsSync } from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { IPC_CHANNELS } from '../../shared/constants';
import type { PermissionResponsePayload } from '../../shared/types/ipc';
import { getConfig } from './config-manager';
import { resolveAliasToActualModel, resolveDefaultModel } from '../../shared/settings-parser';
import { logger } from '../utils/logger';
import * as sessionRepo from '../database/repositories/session-repo';
import { extractContextTokens, detectCompaction } from '../../shared/context-usage';
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
import type { SpawnOptions } from './process-manager';
// 复用 process-manager 的纯函数（env 注入 / 落库）。normalizeToolResultContent/persistMessageParts
// 经 persistCliEvent 间接复用，这里显式 import 以备转换层直接落库。
import {
  buildSpawnEnv,
  normalizeToolResultContent,
  persistCliEvent,
  persistMessageParts,
} from './process-manager';
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
  emitExit: (code: number | null) => void;
  emitError: (err: Error) => void;
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
const pendingPermissionRequests = new Map<string, (response: PermissionResponsePayload) => void>();
// 标记会话已删除：runQuery 下轮迭代检测到即自停，forwardEvent 落库前也据此跳过。
export function markSessionDeleted(sessionId: string): void {
  activeSessions.delete(sessionId);
  cancelInteractionsForSession(sessionId);
  // 清理上下文用量缓存，避免会话删除后 stale 数据堆积（内存泄漏）。
  sessionContextStats.delete(sessionId);
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

    const payload = buildPermissionInteractionPayload(sessionId, toolName, input, options);

    forwardEvent(sessionId, mainWindow, {
      type: 'system',
      subtype: 'permission_request',
      tool_name: toolName,
      tool_use_id: options.toolUseID,
      message: payload.title,
    });

    const response = await requestInteraction(mainWindow, payload, options.signal);
    const result = mapPermissionInteractionResponse(payload, response);
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
  return {
    query: null,
    handle,
    emitExit: (code) => {
      handle.killed = true;
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
}

// ── 读取真实上下文窗口（与 process-manager.readContextWindow 同逻辑）────
function readContextWindow(): number {
  try {
    const config = getConfig();
    const adv = JSON.parse(config.advancedJson || '{}');
    const w = adv?.env?.CLAUDE_LINK_CONTEXT_WINDOW;
    if (typeof w === 'number' && w > 0) return w;
    if (typeof w === 'string' && Number.isFinite(Number(w))) return Number(w);
  } catch {
    // ignore
  }
  return 200000;
}

// 把 config.cliPath（可能是裸命令名 'claude' 或 'npx claude'）解析成 SDK 能直接 spawn的绝对路径。
// SDK 的 pathToClaudeCodeExecutable 不走 shell，要求真正的可执行二进制：
//  - Windows：只接受 .exe（npm 装的 claude 是 #!/bin/sh 脚本 shim 或 .cmd 批处理，SDK spawn 必败，
//    会误报成 libc 不匹配）。所以 Windows 上必须在候选里挑 .exe。
//  - *nix：which 返回的就是可执行文件。
// 解析不到任何合法可执行文件时返回 undefined，让 SDK 回退到其自带的原生二进制（避免硬阻塞）。
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
    // where/which 可能返回多个候选（Windows 上常同时有无扩展名 shim 和 .exe/.cmd），
    // 只挑 SDK 能直接 spawn 的（Windows 上即 .exe）。
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    const good = candidates.find(isLikelyExecutable);
    if (good) return good;
  } catch {
    // 命令不在 PATH，落到下方回退。
  }
  logger.warn(`cliPath "${raw}" 无法解析为可直接执行的二进制，回退到 SDK 自带二进制`);
  return undefined;
}

// ── 组装 SDK Options ───────────────────────────────────────────────
function buildSdkOptions(opts: SpawnOptions, sessionId: string, mainWindow: BrowserWindow): Record<string, unknown> {
  const config = getConfig();
  const options: Record<string, unknown> = {
    // env：apiKey/baseUrl/模型映射全靠它（复用 buildSpawnEnv，第三方端点跑通的关键）。
    env: buildSpawnEnv(),
    // 复用系统已装的 claude（cli-detector 发现）。cliPath 可能是裸命令名，需解析成绝对路径，
    // 否则 SDK 报 "native binary not found"；解析失败回退 undefined 让 SDK 用自带二进制。
    pathToClaudeCodeExecutable: resolveExecutable(config.cliPath),
    // 脱离磁盘 settings：完全由 claude-link 内联控制，避免 ~/.claude/settings.json 污染。
    settingSources: [],
    // 拿流式增量（对应 stream_event），前端逐字/逐工具参数显示。
    includePartialMessages: true,
    // 启用 adaptive thinking：交给 SDK/模型决定思考预算，避免新模型拒绝固定 budgetTokens。
    thinking: { type: 'adaptive' },
    canUseTool: createPermissionHandler(sessionId, mainWindow),
    onElicitation: createElicitationHandler(sessionId, mainWindow),
    // SDK 只有同时声明 supportedDialogKinds 与 onUserDialog，才会把选择题交互交给宿主 UI。
    supportedDialogKinds: SUPPORTED_USER_DIALOG_KINDS,
    onUserDialog: createUserDialogHandler(sessionId, mainWindow),
  };

  // 模型：与 process-manager.buildCommonArgs 同规则——别名解析成实际模型名再传。
  const requestedAlias = opts.modelOverride || opts.model || resolveDefaultModel(config.advancedJson);
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

  // 内联 settings（permissions/env）——脱离磁盘（settingSources:[]），由 claude-link 完全主导。
  // 与 settings-writer.writeClaudeSettings 投影内容一致，但不写盘。
  const settingsEnv: Record<string, string> = {};
  try {
    const adv = JSON.parse(config.advancedJson || '{}');
    const envBlock =
      adv && adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)
        ? (adv.env as Record<string, unknown>)
        : null;
    if (envBlock) {
      for (const [k, v] of Object.entries(envBlock)) {
        if (typeof v === 'string') settingsEnv[k] = v;
      }
    }
  } catch {
    /* advancedJson 非法时忽略 */
  }
  options.settings = {
    permissions: { defaultMode: config.permissionMode },
    env: settingsEnv,
  };

  return options;
}

// ── SDKMessage → CliEvent 转换 + 落库 + 推前端 ───────────────────────
function forwardEvent(sessionId: string, mainWindow: BrowserWindow, event: CliEvent): void {
  // 会话已删除：不再落库（messages 表已被级联删空，INSERT 会触发外键失败回滚，
  // 反复同步失败阻塞主进程事件循环，导致所有输入框失效）。事件也不必推前端
  //（前端 activeSession 已切走/置 null，handleEvent 守卫也会丢弃）。
  if (!isSessionActive(sessionId)) return;
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
        windowSize: realWindow ?? readContextWindow(),
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
        sessionRepo.updateLastContext(sessionId, inputTokens);
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
      windowSize: lastStats?.windowSize ?? readContextWindow(),
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

// 把 SDK 的 assistant 消息（{type:'assistant', message:{role,content,usage}, parent_tool_use_id?}）
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
  return {
    type: 'result',
    subtype: (sdkMsg.subtype as string) ?? 'success',
    result: (sdkMsg.result as string) ?? '',
    total_cost_usd: (sdkMsg.total_cost_usd as number) ?? 0,
    duration_ms: (sdkMsg.duration_ms as number) ?? 0,
    num_turns: (sdkMsg.num_turns as number) ?? 0,
    session_id: (sdkMsg.session_id as string) ?? '',
    is_error: Boolean(sdkMsg.is_error),
    usage: (sdkMsg.usage as CliResultEvent['usage']) ?? undefined,
  } as CliResultEvent;
}

// SDK stream_event（SDKPartialAssistantMessage）已是 {type:'stream_event', event}，直接转发。
function convertStreamEvent(sdkMsg: Record<string, unknown>): CliEvent {
  return { type: 'stream_event', event: sdkMsg.event as CliStreamEvent['event'] } as CliStreamEvent;
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
  if (prev && prev.query && prev !== entry) {
    interruptedQueries.add(prev.query);
    try {
      await prev.query.interrupt();
    } catch {
      // ignore
    }
  }
  entries.set(sessionId, entry);

  const sdkOptions = buildSdkOptions(opts, sessionId, mainWindow);
  // resume：优先显式传入，否则用已记录的 CLI session id（等价 process-manager 的 --resume）。
  const resumeId = opts.resumeSessionId || sessionCliIds.get(sessionId);
  if (resumeId) sdkOptions.resume = resumeId;

  let query: Query;
  let resumedOnce = Boolean(resumeId);
  try {
    query = await startSdkQuery(prompt, sdkOptions);
  } catch (err) {
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
        if (entries.get(sessionId) === entry) entries.delete(sessionId);
        return;
      }
    } else {
      forwardEvent(sessionId, mainWindow, {
        type: 'error',
        message: `启动 SDK 失败：${err instanceof Error ? err.message : String(err)}`,
      });
      emitError(err instanceof Error ? err : new Error(String(err)));
      emitExit(1);
      if (entries.get(sessionId) === entry) entries.delete(sessionId);
      return;
    }
  }
  entry.query = query;

  while (true) {
  try {
    for await (const sdkMsg of query) {
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
          sessionCliIds.set(sessionId, sid);
          // 会话已删则不写库（避免外键失败）。
          if (isSessionActive(sessionId)) {
            try {
              sessionRepo.updateCliSessionId(sessionId, sid);
            } catch (err) {
              logger.warn(`Failed to persist cli session id [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
            }
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
          const sysInfo: CliSystemInfoEvent = {
            type: 'system',
            subtype: infoSubtype,
            text: typeof sdkMsg.text === 'string' ? sdkMsg.text : undefined,
            level: sdkMsg.level === 'warn' ? 'warn' : 'info',
          };
          forwardEvent(sessionId, mainWindow, sysInfo);
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
        // 其它未知 system 子类型：暂不转发（前端不消费）。
        continue;
      }
      if (type === 'assistant') {
        const cliEvent = convertAssistantMessage(sdkMsg);
        if (cliEvent) forwardEvent(sessionId, mainWindow, cliEvent);
        continue;
      }
      if (type === 'stream_event') {
        forwardEvent(sessionId, mainWindow, convertStreamEvent(sdkMsg));
        continue;
      }
      if (type === 'result') {
        forwardEvent(sessionId, mainWindow, convertResultMessage(sdkMsg));
        continue;
      }
      // user 回显 / 其它 system 子类型 / hook / task 等暂不转发（前端不消费）。
    }
    // 流正常结束。
    emitExit(0);
    break;
  } catch (err) {
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
  if (entries.get(sessionId) === entry) entries.delete(sessionId);
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

export function killProcess(sessionId: string): void {
  cancelInteractionsForSession(sessionId);
  const entry = entries.get(sessionId);
  if (entry && entry.query) {
    interruptedQueries.add(entry.query);
    entry.handle.interrupt();
    void entry.query.interrupt().catch(() => {
      // 中断失败不阻塞；query 会因迭代抛错走 aborted 分支。
    });
    logger.info(`Interrupted SDK query for session ${sessionId}`);
  }
}

export function killAllProcesses(): void {
  for (const [sessionId] of entries) {
    killProcess(sessionId);
  }
}

export function getActiveProcess(sessionId: string): SdkQueryHandle | undefined {
  return entries.get(sessionId)?.handle;
}

export function getCliSessionId(sessionId: string): string | undefined {
  return sessionCliIds.get(sessionId);
}

export function setCliSessionId(sessionId: string, cliSessionId: string): void {
  sessionCliIds.set(sessionId, cliSessionId);
}
