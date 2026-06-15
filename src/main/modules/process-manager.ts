// process-manager.ts
// Claude Code CLI 子进程管理：spawn claude + env 注入（buildSpawnEnv）+ stream-json 解析 + 持久化。
//
// 核心链路：spawnForChat / spawnForTask 启动 claude CLI（--include-partial-messages 流式输出），
// buildSpawnEnv 注入 apiKey / baseUrl / 模型映射等 env（含 advancedJson.env 块展开），
// attachStreamParser 逐行解析 stream-json（init / message / stream_event / result），
// 持久化到 SQLite 并转发渲染进程。testConnection 也复用 buildSpawnEnv，保证测试结果代表真实会话。

import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import type { CliInitEvent, CliEvent, CliMessageEvent, CliMessageContentPart } from '../../shared/types/cli';
import { IPC_CHANNELS } from '../../shared/constants';
import { getConfig } from './config-manager';
import { logger } from '../utils/logger';
import * as messageRepo from '../database/repositories/message-repo';
import * as sessionRepo from '../database/repositories/session-repo';

const processes = new Map<string, ChildProcess>();
const sessionCliIds = new Map<string, string>();

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
  // modelOverride takes precedence over model/config.defaultModel
  const effectiveModel = opts.modelOverride || opts.model || config.defaultModel;
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
    }
  });

  childProcess.stderr?.on('data', (chunk: Buffer) => {
    logger.warn(`CLI stderr [${sessionId}]: ${chunk.toString('utf8').trim()}`);
  });

  childProcess.on('exit', (code) => {
    // Only remove from map if this is still the active process for the session.
    // Avoids race: if a new process was spawned for the same session before
    // this old one fully exited, we must not evict the new child.
    if (processes.get(sessionId) === childProcess) {
      processes.delete(sessionId);
    }
    logger.info(`CLI process exited [${sessionId}] code=${code}`);
  });
}

function persistCliEvent(sessionId: string, event: CliEvent): void {
  switch (event.type) {
    case 'init': {
      const initEvent = event as CliInitEvent;
      sessionCliIds.set(sessionId, initEvent.session_id);
      sessionRepo.updateCliSessionId(sessionId, initEvent.session_id);
      break;
    }

    case 'message': {
      const msgEvent = event as CliMessageEvent;
      persistMessageParts(sessionId, msgEvent.content, msgEvent.role);
      break;
    }

    // stream_event and result are not persisted as individual messages;
    // the renderer assembles the final text from stream deltas and
    // the `message` event carries the complete content.
    case 'stream_event':
    case 'result':
      break;
  }
}

function persistMessageParts(
  sessionId: string,
  parts: CliMessageContentPart[],
  role: 'user' | 'assistant',
): void {
  for (const part of parts) {
    if (part.type === 'text' && 'text' in part) {
      messageRepo.createMessage(sessionId, role, part.text, 'message');
    } else if (part.type === 'tool_use') {
      const content = JSON.stringify({
        name: part.name,
        input: part.input,
        toolUseId: part.tool_use_id ?? null,
      }, null, 2);
      messageRepo.createMessage(sessionId, 'assistant', content, 'tool_use');
    } else if (part.type === 'tool_result') {
      const resultText = typeof (part as { content?: string }).content === 'string'
        ? (part as { content: string }).content
        : JSON.stringify((part as { content?: unknown }).content ?? '', null, 2);
      messageRepo.createMessage(sessionId, 'tool', resultText, 'tool_result');
    } else if (part.type === 'thinking' && 'thinking' in part) {
      messageRepo.createMessage(sessionId, 'assistant', part.thinking, 'thinking');
    }
  }
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

export function killProcess(sessionId: string): void {
  const child = processes.get(sessionId);
  if (child && !child.killed) {
    child.kill();
    processes.delete(sessionId);
    logger.info(`Killed process for session ${sessionId}`);
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
