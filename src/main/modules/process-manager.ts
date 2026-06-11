import { spawn, type ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';
import type { CliInitEvent, CliEvent } from '../../shared/types/cli';
import { IPC_CHANNELS } from '../../shared/constants';
import { getConfig } from './config-manager';
import { logger } from '../utils/logger';

const processes = new Map<string, ChildProcess>();
const sessionCliIds = new Map<string, string>();

export interface SpawnOptions {
  model?: string;
  workingDir?: string | null;
  maxTurns?: number;
  permissionMode?: string;
  resumeSessionId?: string | null;
}

function getCliCommand(): string {
  const config = getConfig();
  return config.cliPath || 'claude';
}

function buildCommonArgs(opts: SpawnOptions): string[] {
  const config = getConfig();
  const args: string[] = [];

  args.push('-p');
  args.push('--output-format', 'stream-json');
  args.push('--verbose');
  args.push('--include-partial-messages');
  args.push('--model', opts.model || config.defaultModel);

  if (opts.maxTurns && opts.maxTurns > 0) {
    args.push('--max-turns', String(opts.maxTurns));
  }

  if (opts.permissionMode && opts.permissionMode !== 'default') {
    args.push('--permission-mode', opts.permissionMode);
  }

  const resumeId = opts.resumeSessionId || sessionCliIds.get(opts.resumeSessionId || '');
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

      try {
        const event = JSON.parse(trimmed) as CliEvent;

        if (event.type === 'init') {
          const initEvent = event as CliInitEvent;
          sessionCliIds.set(sessionId, initEvent.session_id);
        }

        mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });
      } catch {
        logger.warn(`Failed to parse CLI output line: ${trimmed.slice(0, 200)}`);
      }
    }
  });

  childProcess.stderr?.on('data', (chunk: Buffer) => {
    logger.warn(`CLI stderr [${sessionId}]: ${chunk.toString('utf8').trim()}`);
  });

  childProcess.on('exit', (code) => {
    processes.delete(sessionId);
    logger.info(`CLI process exited [${sessionId}] code=${code}`);
  });
}

export function spawnForChat(
  sessionId: string,
  mainWindow: BrowserWindow,
  opts: SpawnOptions = {},
): ChildProcess {
  killProcess(sessionId);

  const config = getConfig();
  const args = buildCommonArgs(opts);
  args.push('--input-format', 'stream-json');

  const cwd = opts.workingDir || config.workingDirectory || process.cwd();

  logger.info(`Spawning CLI for chat [${sessionId}] in ${cwd}`);

  const child = spawn(getCliCommand(), args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
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
  const args = buildCommonArgs(opts);
  args.unshift(prompt);
  args.unshift('-p');

  const cwd = opts.workingDir || config.workingDirectory || process.cwd();

  logger.info(`Spawning CLI for task [${taskId}] session [${sessionId}]`);

  const child = spawn(getCliCommand(), args, {
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env },
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
