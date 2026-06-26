// process-manager.ts
// Claude Code CLI 子进程管理：spawn claude + env 注入（buildSpawnEnv）+ stream-json 解析 + 持久化。
//
// 核心链路：spawnForChat / spawnForTask 启动 claude CLI（--include-partial-messages 流式输出），
// buildSpawnEnv 注入 apiKey / baseUrl / 模型映射等 env（含 advancedJson.env 块展开），
// attachStreamParser 逐行解析 stream-json（init / message / stream_event / result），
// 持久化到 SQLite 并转发渲染进程。testConnection 也复用 buildSpawnEnv，保证测试结果代表真实会话。
//
// @deprecated 本文件的自建 spawn 路径已不再是默认后端——claude-link 现在默认走 Claude Agent SDK
// 适配器（sdk-backend.ts，经 chat-backend.ts 统一入口）。本文件保留作为代码级回退：
//   - 公共工具函数（buildSpawnEnv / normalizeToolResultContent / persistCliEvent / persistMessageParts
//     / SpawnOptions）仍被 sdk-backend 和 connection-tester 复用，不可删除。
//   - 应急切回 spawn 路径：把 chat-backend.ts 的 `export * from './sdk-backend'` 改为
//     `export * from './process-manager'` 即可（接口同形，一行改动）。
// 待 SDK 路径稳定跑一段时间后，再移除本文件的 spawn 路径、把工具函数提为独立公共模块。


import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import type { CliInitEvent, CliSystemInitEvent, CliSystemInfoEvent, CliPermissionEvent, CliResultEvent, CliEvent, CliMessageEvent, CliMessageContentPart } from '../../shared/types/cli';
import { IPC_CHANNELS } from '../../shared/constants';
import { getConfig } from './config-manager';
import { resolveDefaultModel } from '../../shared/settings-parser';
import { resolveAliasToActualModel } from '../../shared/settings-parser';
import { writeClaudeSettings, SKIP_NO_WORKDIR } from './settings-writer';
import { logger } from '../utils/logger';
import * as messageRepo from '../database/repositories/message-repo';
import * as sessionRepo from '../database/repositories/session-repo';
import { extractContextTokens } from '../../shared/context-usage';
import { processKindFromPart, extractSubAgentTitle } from '../../shared/process-kind';
import type { ContextStatsPayload } from '../../shared/types/ipc';

const processes = new Map<string, ChildProcess>();
const sessionCliIds = new Map<string, string>();// 标记某个 child 进程是"被用户中断"而非"出错退出"。
// 必须按 child 实例而非 sessionId：否则中断旧进程后，新 spawn 的同 session 进程
// 在退出时会被旧标记误判为 interrupted（吞掉真正的错误）。WeakSet 随 child GC 自动清理。
const interruptedChildren = new WeakSet<ChildProcess>();

function isWindows(): boolean {
  return process.platform === 'win32';
}

// 与 sdk-backend.markSessionDeleted 同名 no-op：回退到本 spawn 后端时，
// ipc-handlers 仍会 import 此符号（保持接口同形），但 spawn 路径靠 killProcess
// 直接杀进程即可，无需内存判活集合，故此处为空实现。
export function markSessionDeleted(_sessionId: string): void {
  /* no-op for spawn backend */
}

export function respondToPermissionRequest(_response: unknown): void {
  logger.warn('Permission response ignored; spawn backend does not use unified SDK permission prompts.');
}

export interface SpawnOptions {
  model?: string;
  modelOverride?: string | null;
  workingDir?: string | null;
  maxTurns?: number;
  permissionMode?: string;
  resumeSessionId?: string | null;
}

function getCliCommand(): string {
  const config = getConfig();
  return config.cliPath || 'claude';
}

// spawn 前把 claude-link 完整配置投影到运行目录的 .claude/settings.local.json。
// 项目级 settings.local.json 优先级 > 用户 ~/.claude/settings.json，使 claude-link 完全主导
// （key/url/模型映射/权限全部覆盖 CC 自身配置）。失败只记日志，不阻塞 spawn（env 注入仍兜底）。
function projectClaudeSettings(cwd: string): void {
  try {
    const result = writeClaudeSettings(cwd, getConfig());
    if (!result.ok && result.error !== SKIP_NO_WORKDIR) {
      logger.warn(`spawn 前 settings.local.json 投影跳过：${result.error}`);
    }
  } catch (e) {
    logger.warn('spawn 前 settings.local.json 投影失败', e);
  }
}

export function buildSpawnEnv(): Record<string, string> {
  const config = getConfig();
  const env: Record<string, string> = { ...process.env as Record<string, string> };

  // Inject API Key so CLI can authenticate
  if (config.apiKey) {
    env.ANTHROPIC_API_KEY = config.apiKey;
  }

  // Inject custom API Base URL if not the official endpoint
  const baseUrl = config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') {
    env.ANTHROPIC_BASE_URL = baseUrl;
  }

  // Inject advanced JSON as environment variables.
  // 支持两种结构：
  //   1) 扁平格式 { "KEY": "value" } —— 顶层字符串直接注入（向后兼容）
  //   2) Claude Code settings.json 格式 { "env": { "KEY": "value" }, ... }
  //      —— 必须展开 env 块，否则 ANTHROPIC_DEFAULT_*_MODEL 等模型映射丢失，
  //        导致 --model sonnet 别名解析成默认 claude-sonnet-4-6 发给第三方端点被拒。
  if (config.advancedJson && config.advancedJson !== '{}') {
    try {
      const advanced = JSON.parse(config.advancedJson) as Record<string, unknown>;
      for (const [key, value] of Object.entries(advanced)) {
        if (typeof value === 'string') {
          env[key] = value;
        }
      }
      const envBlock = advanced.env;
      if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
        for (const [key, value] of Object.entries(envBlock as Record<string, unknown>)) {
          if (typeof value === 'string') {
            env[key] = value;
          }
        }
      }
    } catch {
      logger.warn('Failed to parse advancedJson for env injection');
    }
  }

  return env;
}

function buildCommonArgs(sessionId: string, opts: SpawnOptions): string[] {
  const config = getConfig();
  const args: string[] = [];

  args.push('-p');
  args.push('--output-format', 'stream-json');
  args.push('--verbose');
  args.push('--include-partial-messages');
  // 解析成实际模型名再传 --model：CLI 参数优先级最高，确保 claude-link 的映射生效，
  // 不被 ~/.claude/settings.json 覆盖（问题 3 根因）。
  const requestedAlias = opts.modelOverride || opts.model || resolveDefaultModel(config.advancedJson);
  const effectiveModel = resolveAliasToActualModel(requestedAlias, config.advancedJson);
  args.push('--model', effectiveModel);

  if (opts.maxTurns && opts.maxTurns > 0) {
    args.push('--max-turns', String(opts.maxTurns));
  }

  if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode);
  }

  // Resolve resume id: explicit override > in-memory map > DB persisted value
  const resumeId = opts.resumeSessionId || sessionCliIds.get(sessionId);
  if (resumeId) {
    args.push('--resume', resumeId);
  }

  return args;
}

function attachStreamParser(
  sessionId: string,
  childProcess: ChildProcess,
  mainWindow: BrowserWindow,
): void {
  let buffer = '';
  let stderr = '';
  let sawResult = false;

  childProcess.stdout?.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      let event: CliEvent;
      try {
        event = JSON.parse(trimmed) as CliEvent;
      } catch {
        logger.warn(`Failed to parse CLI output line: ${trimmed.slice(0, 200)}`);
        continue;
      }

      // Forward event to renderer first
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });

      // Persist structured events to database
      try {
        persistCliEvent(sessionId, event);
      } catch (err) {
        logger.error(`Failed to persist CLI event [${sessionId}]`, err);
      }

      if (event.type === 'result') {
        sawResult = true;
      }

      // 问题 4：提取真实上下文用量，推送 + 落库
      const usage = (event as { usage?: { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } }).usage;
      if (usage && (event.type === 'message' || event.type === 'result')) {
        const inputTokens = extractContextTokens(usage);
        if (inputTokens > 0) {
          // result 事件带 modelUsage.<model>.contextWindow —— 这是 CC 自己算出的
          // 真实上下文窗口（与 CC 状态栏一致），优先用它，远胜猜测/默认 200k。
          const modelUsage = (event as { modelUsage?: Record<string, { contextWindow?: number; maxOutputTokens?: number }> }).modelUsage;
          const realWindow = modelUsage && typeof modelUsage === 'object'
            ? (Object.values(modelUsage)[0]?.contextWindow ?? undefined)
            : undefined;
          const payload: ContextStatsPayload = {
            sessionId,
            inputTokens,
            outputTokens: usage.output_tokens ?? 0,
            windowSize: realWindow ?? readContextWindow(),
            model: null,
          };
          mainWindow.webContents.send(IPC_CHANNELS.CONTEXT_UPDATE, payload);
          try {
            sessionRepo.updateLastContext(sessionId, inputTokens);
          } catch (err) {
            logger.warn(`Failed to persist last context [${sessionId}]`, err);
          }
        }
      }
    }
  });

  childProcess.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    stderr += text;
    logger.warn(`CLI stderr [${sessionId}]: ${text.trim()}`);
  });

  childProcess.on('exit', (code) => {
    // Only remove from map if this is still the active process for the session.
    // Avoids race: if a new process was spawned for the same session before
    // this old one fully exited, we must not evict the new child.
    if (processes.get(sessionId) === childProcess) {
      processes.delete(sessionId);
    }
    const interrupted = interruptedChildren.has(childProcess);

    if (interrupted) {
      // 用户主动中断：不发 error（避免误报），但需复位前端 sending，否则输入框死锁。
      // nix 上 SIGINT 后 CC 会先发 result(error_during_execution)，sawResult 已 true，这里不会进；
      // Windows 硬杀会丢 result，靠这里兜底复位。
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
        sessionId,
        event: { type: 'aborted', message: '已中断' },
      });
    } else if (!sawResult) {
      // 进程退出但全程没收到 result 事件：
      //  - 非 0 退出 → 报错误（含 stderr 详情）
      //  - 0 退出但无 result（异常静默退出）→ 也需复位前端，否则 sending 永久 true
      if (code) {
        const detail = stderr.trim() || `退出码 ${code}`;
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
          sessionId,
          event: { type: 'error', message: `CLI 进程异常退出：${detail.slice(0, 500)}`, code },
        });
      } else {
        mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, {
          sessionId,
          event: { type: 'aborted', message: 'CLI 已结束' },
        });
      }
    }

    logger.info(`CLI process exited [${sessionId}] code=${code} interrupted=${interrupted}`);
  });
}

export function persistCliEvent(sessionId: string, event: CliEvent): void {
  switch (event.type) {
    case 'init': {
      const initEvent = event as CliInitEvent;
      sessionCliIds.set(sessionId, initEvent.session_id);
      sessionRepo.updateCliSessionId(sessionId, initEvent.session_id);
      break;
    }

    case 'system': {
      // system 子类型分流：init 取 session_id；informational/compact_boundary/plugin_install
      // 与 permission_denied 落库为过程消息（processKind = system:<subtype> / permission）。
      const sysEvent = event as CliSystemInitEvent | CliSystemInfoEvent | CliPermissionEvent;
      if (sysEvent.subtype === 'init') {
        // 新版 CC 用 {type:'system',subtype:'init'} 携带 session_id。
        // 与 connection-tester 保持一致，否则 --resume 拿不到真实 session id。
        if (sysEvent.session_id) {
          sessionCliIds.set(sessionId, sysEvent.session_id);
          sessionRepo.updateCliSessionId(sessionId, sysEvent.session_id);
        }
        break;
      }
      if (sysEvent.subtype === 'permission_denied' || sysEvent.subtype === 'permission_request') {
        const p = event as CliPermissionEvent;
        const toolName = p.tool_name ? `：${p.tool_name}` : '';
        messageRepo.createMessage({
          sessionId,
          role: 'system',
          content: p.message || (p.subtype === 'permission_request' ? `等待权限确认${toolName}` : `权限被拒绝${toolName}`),
          eventType: 'system',
          processKind: 'permission',
          toolUseId: p.tool_use_id ?? null,
        });
        break;
      }
      const info = event as CliSystemInfoEvent;
      const defaultText: Record<string, string> = {
        informational: '系统提示',
        compact_boundary: '上下文已达压缩边界',
        plugin_install: '插件安装',
      };
      messageRepo.createMessage({
        sessionId,
        role: 'system',
        content: info.text || defaultText[info.subtype] || '系统提示',
        eventType: 'system',
        processKind: `system:${info.subtype}`,
      });
      break;
    }

    case 'message': {
      const msgEvent = event as CliMessageEvent;
      persistMessageParts(
        sessionId,
        msgEvent.content,
        msgEvent.role,
        msgEvent.parentToolUseId ?? null,
      );
      break;
    }

    case 'stream_event':
      break;

    case 'result': {
      // result.result 兜底落库：当本回合没有任何 assistant 正文（message 事件未带 text part，
      // 某些端点/纯工具回合把最终结论只放在 result.result）时，把结论落库一条，否则
      // 实时显示有、切走再切回（从 DB 回读）就整条丢失——违背「全过程不丢失」与计划验证 #5。
      // 与渲染层 ensureResultMessage 同条件：错误回合（非中断）的 result 文本是失败原因，
      // 只走前端错误横幅，不当 assistant 正文落库（避免污染历史 + 与横幅重复）；
      // message 事件已落过正文则不重复（result.result 通常与最后一段 text 同内容）。
      const r = event as CliResultEvent;
      const text = r.result?.trim();
      if (!text) break;
      const subtype = r.subtype;
      const isUserInterrupt = subtype === 'error_during_execution';
      // 与渲染层 use-chat.ts 的 isErrResult 完全一致（含 subtype !== undefined 守卫）：
      // spawn 路径下若端点返回 is_error:true 但缺省 subtype，两侧必须同判，否则一个落库一个
      // 不落会导致 DB/内存分歧、切走再切回丢失该条。SDK 路径因 convertResultMessage 强制
      // subtype 非 undefined 而免疫此分支。
      const isErrResult = !!r.is_error && !isUserInterrupt && subtype !== 'success' && subtype !== undefined;
      if (isErrResult) break;
      if (currentTurnHasMainFlowText(sessionId)) break;
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: r.result, eventType: 'message', processKind: null,
      });
      break;
    }
  }
}

// 当前回合（最近一条 user 消息之后）主流程是否已有 assistant 正文（eventType='message'
// 且 parentAgentId 为空）。result.result 兜底落库的去重依据，与渲染层 turnHasAssistantText 同义。
// 排除子 Agent 正文：result.result 是主流程回答，不能因子 Agent 产出过文本就误判已有正文。
function currentTurnHasMainFlowText(sessionId: string): boolean {
  const rows = messageRepo.getMessagesBySession(sessionId);
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const m = rows[i];
    if (m.role === 'user') break;
    if (m.role === 'assistant' && m.eventType === 'message' && !m.parentAgentId) return true;
  }
  return false;
}

// tool_result.content 可能是 string，也可能是 [{type:'text',text}, {type:'image',...}, ...] 数组。
// 归一化为可读文本：数组提取每项文本拼接，其它形态退化为 JSON。
export function normalizeToolResultContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item && typeof item === 'object' && 'text' in item && typeof (item as { text?: unknown }).text === 'string') {
          return (item as { text: string }).text;
        }
        return JSON.stringify(item, null, 2);
      })
      .join('\n');
  }
  if (content === undefined || content === null) return '';
  return JSON.stringify(content, null, 2);
}

export function persistMessageParts(
  sessionId: string,
  parts: CliMessageContentPart[],
  role: 'user' | 'assistant',
  parentAgentId: string | null = null,
): void {
  for (const part of parts) {
    const processKind = processKindFromPart(part);
    if (part.type === 'text' && 'text' in part) {
      messageRepo.createMessage({
        sessionId, role, content: part.text, eventType: 'message',
        processKind, parentAgentId,
      });
    } else if (part.type === 'tool_use') {
      messageRepo.createMessage({
        sessionId,
        role: 'assistant',
        content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
        eventType: 'tool_use',
        processKind,
        parentAgentId,
        toolUseId: part.tool_use_id ?? null,
        title: extractSubAgentTitle(part),
      });
    } else if (part.type === 'server_tool_use') {
      messageRepo.createMessage({
        sessionId,
        role: 'assistant',
        content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
        eventType: 'tool_use',
        processKind,
        parentAgentId,
        toolUseId: part.id ?? null,
      });
    } else if (part.type === 'tool_result') {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
      });
    } else if (part.type === 'web_search_tool_result' || part.type === 'web_fetch_tool_result') {
      const resultText = normalizeToolResultContent((part as { content?: unknown }).content);
      messageRepo.createMessage({
        sessionId, role: 'tool', content: resultText, eventType: 'tool_result',
        processKind, parentAgentId, toolUseId: part.tool_use_id ?? null,
      });
    } else if (part.type === 'thinking' && 'thinking' in part) {
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: part.thinking, eventType: 'thinking',
        processKind, parentAgentId,
      });
    } else if (part.type === 'redacted_thinking') {
      messageRepo.createMessage({
        sessionId, role: 'assistant', content: '（此段思考已被安全策略隐藏）',
        eventType: 'thinking', processKind, parentAgentId,
      });
    }
  }
}

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

export function spawnForChat(
  sessionId: string,
  mainWindow: BrowserWindow,
  opts: SpawnOptions = {},
): ChildProcess {
  killProcess(sessionId);

  const config = getConfig();
  const args = buildCommonArgs(sessionId, opts);
  args.push('--input-format', 'stream-json');

  const cwd = opts.workingDir || config.workingDirectory || process.cwd();

  projectClaudeSettings(cwd);

  logger.info(`Spawning CLI for chat [${sessionId}] in ${cwd}`);

  const child = spawn(getCliCommand(), args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSpawnEnv(),
  });

  processes.set(sessionId, child);
  attachStreamParser(sessionId, child, mainWindow);

  return child;
}

export function spawnForTask(
  taskId: string,
  sessionId: string,
  prompt: string,
  mainWindow: BrowserWindow,
  opts: SpawnOptions = {},
): ChildProcess {
  killProcess(sessionId);

  const config = getConfig();
  // buildCommonArgs 的第一个参数是 ['-p', '--output-format', ...]，
  // 把 '-p' 替换为 '-p <prompt>'，确保只有一个 -p。
  const args = buildCommonArgs(sessionId, opts);
  // args[0] === '-p'，在它后面插入 prompt
  args.splice(1, 0, prompt);

  const cwd = opts.workingDir || config.workingDirectory || process.cwd();

  projectClaudeSettings(cwd);

  logger.info(`Spawning CLI for task [${taskId}] session [${sessionId}]`);

  const child = spawn(getCliCommand(), args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildSpawnEnv(),
  });

  processes.set(sessionId, child);
  attachStreamParser(sessionId, child, mainWindow);

  return child;
}

export function sendMessage(sessionId: string, message: string): void {
  const child = processes.get(sessionId);
  if (!child || !child.stdin) {
    logger.warn(`No active process for session ${sessionId}`);
    return;
  }

  const payload = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });

  child.stdin.write(payload + '\n');
}

// 中断 Claude Code CLI 当前回合。
// 设计要点（已修正 review 发现的孤儿进程 + 标记串扰）：
//   - 标记按 child 实例（interruptedChildren WeakSet），避免跨同 session 的新进程误判。
//   - 立即从 processes map 移除：让下一次消息走 spawnForChat（--resume 续聊），不写旧 stdin。
//   - *nix：先发 SIGINT 让 CC 的 SIGINT handler 优雅 abort 正在进行的 HTTP 流（减少无谓 token），
//     再给 800ms 优雅窗口；窗口内未退出则 SIGKILL 强杀，杜绝孤儿进程继续读写 stdio。
//   - Windows：SIGINT 无效，直接 TerminateProcess 硬杀。
//   - exit handler 据 child 标记决定发 aborted（中断）还是 error（异常），中断不弹错误。
export function killProcess(sessionId: string): void {
  const child = processes.get(sessionId);
  if (child && !child.killed) {
    interruptedChildren.add(child);
    processes.delete(sessionId); // 立即移除：下次消息走新 spawn，绝不写旧 stdin
    if (isWindows()) {
      child.kill();
    } else {
      try {
        child.kill('SIGINT');
        // 优雅窗口：SIGINT 后 CC 可能保持存活（仅 abort 当前回合）。
        // claude-link 不复用旧进程（每次中断后走新 spawn + --resume），故超时后强杀防孤儿。
        setTimeout(() => {
          if (!child.killed) {
            try {
              child.kill('SIGKILL');
            } catch {
              // 已退出则忽略
            }
          }
        }, 800);
      } catch {
        child.kill('SIGKILL');
      }
    }
    logger.info(`Interrupted process for session ${sessionId} (platform=${process.platform})`);
  }
}

export function killAllProcesses(): void {
  for (const [sessionId] of processes) {
    killProcess(sessionId);
  }
}

export function getActiveProcess(sessionId: string): ChildProcess | undefined {
  return processes.get(sessionId);
}

export function getCliSessionId(sessionId: string): string | undefined {
  return sessionCliIds.get(sessionId);
}

export function setCliSessionId(sessionId: string, cliSessionId: string): void {
  sessionCliIds.set(sessionId, cliSessionId);
}
