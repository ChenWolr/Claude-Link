import type { BrowserWindow } from 'electron';
import type { QueueState } from '../../shared/types/task';
import { IPC_CHANNELS, DEFAULT_TASK_DELAY_SECONDS } from '../../shared/constants';
import { spawnForChat, spawnForTask, killProcess, getCliSessionId, sendMessage } from './process-manager';
import { getConfig } from './config-manager';
import * as taskRepo from '../database/repositories/task-repo';
import * as sessionRepo from '../database/repositories/session-repo';

const queues = new Map<string, QueueState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();

function emitQueueEvent(
  mainWindow: BrowserWindow,
  sessionId: string,
  type: string,
  taskId?: string,
  data?: Record<string, unknown>,
): void {
  mainWindow.webContents.send(IPC_CHANNELS.QUEUE_EVENT, {
    sessionId,
    type,
    taskId,
    data,
  });
}

function getOrCreateQueue(sessionId: string): QueueState {
  let state = queues.get(sessionId);
  if (!state) {
    state = {
      sessionId,
      status: 'idle',
      currentTaskId: null,
      lastCompletedTaskId: null,
      countdownRemaining: 0,
      pendingCount: 0,
    };
    queues.set(sessionId, state);
  }
  return state;
}

export function startQueue(sessionId: string, mainWindow: BrowserWindow): void {
  const state = getOrCreateQueue(sessionId);
  if (state.status === 'running') return;

  const pending = taskRepo.getPendingTasks(sessionId);
  if (!pending.length) {
    state.status = 'idle';
    emitQueueEvent(mainWindow, sessionId, 'queue_completed');
    return;
  }

  executeNextTask(sessionId, mainWindow);
}

export function pauseQueue(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state) return;

  const countdownTimer = timers.get(sessionId);
  const mainTimer = timers.get(`${sessionId}__main`);
  if (countdownTimer) {
    clearInterval(countdownTimer);
    timers.delete(sessionId);
  }
  if (mainTimer) {
    clearTimeout(mainTimer);
    timers.delete(`${sessionId}__main`);
  }

  state.status = 'paused';
  emitQueueEvent(mainWindow, sessionId, 'queue_paused');
}

export function resumeQueue(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'paused') return;

  startQueue(sessionId, mainWindow);
}

export function interruptTask(taskId: string, sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || state.currentTaskId !== taskId) return;

  killProcess(sessionId);
  taskRepo.updateTaskStatus(taskId, 'cancelled');

  state.currentTaskId = null;
  state.status = 'idle';

  emitQueueEvent(mainWindow, sessionId, 'task_completed', taskId, { interrupted: true });

  // Continue with next pending task
  const pending = taskRepo.getPendingTasks(sessionId);
  if (pending.length > 0) {
    executeNextTask(sessionId, mainWindow);
  }
}

function executeNextTask(sessionId: string, mainWindow: BrowserWindow): void {
  const state = getOrCreateQueue(sessionId);
  const config = getConfig();

  const pending = taskRepo.getPendingTasks(sessionId);
  state.pendingCount = pending.length;

  if (!pending.length) {
    state.status = 'idle';
    state.currentTaskId = null;
    emitQueueEvent(mainWindow, sessionId, 'queue_completed');
    return;
  }

  const task = pending[0];
  state.status = 'running';
  state.currentTaskId = task.id;

  taskRepo.updateTaskStatus(task.id, 'running');
  emitQueueEvent(mainWindow, sessionId, 'task_started', task.id);

  const cliSessionId = getCliSessionId(sessionId);
  const session = sessionRepo.getSession(sessionId);

  const child = spawnForTask(task.id, sessionId, task.prompt, mainWindow, {
    model: session?.model ?? config.defaultModel,
    modelOverride: session?.modelOverride ?? null,
    workingDir: session?.workingDir ?? config.workingDirectory,
    maxTurns: config.maxTurns,
    permissionMode: session?.permissionMode ?? config.permissionMode,
    resumeSessionId: cliSessionId,
  });

  child.on('exit', (code) => {
    if (state.currentTaskId !== task.id) return;

    if (code === 0) {
      taskRepo.updateTaskStatus(task.id, 'completed');
      emitQueueEvent(mainWindow, sessionId, 'task_completed', task.id, { success: true });
    } else {
      taskRepo.updateTaskError(task.id, `Process exited with code ${code}`);
      emitQueueEvent(mainWindow, sessionId, 'task_failed', task.id, { exitCode: code });
    }

    state.lastCompletedTaskId = task.id;
    state.currentTaskId = null;

    // Schedule next task
    const remaining = taskRepo.getPendingTasks(sessionId);
    state.pendingCount = remaining.length;

    if (remaining.length > 0) {
      startCountdown(sessionId, mainWindow, config.taskDelaySeconds || DEFAULT_TASK_DELAY_SECONDS);
    } else {
      state.status = 'idle';
      emitQueueEvent(mainWindow, sessionId, 'queue_completed');
    }
  });
}

function startCountdown(sessionId: string, mainWindow: BrowserWindow, delaySeconds: number): void {
  const state = queues.get(sessionId);
  if (!state) return;

  state.status = 'waiting';
  state.countdownRemaining = delaySeconds;

  emitQueueEvent(mainWindow, sessionId, 'countdown_started', undefined, { seconds: delaySeconds });

  const countdownInterval = setInterval(() => {
    state.countdownRemaining -= 1;
    emitQueueEvent(mainWindow, sessionId, 'countdown_tick', undefined, {
      remaining: state.countdownRemaining,
    });

    if (state.countdownRemaining <= 0) {
      clearInterval(countdownInterval);
    }
  }, 1000);

  timers.set(sessionId, countdownInterval);

  const mainTimer = setTimeout(() => {
    clearInterval(countdownInterval);
    timers.delete(sessionId);
    executeNextTask(sessionId, mainWindow);
  }, delaySeconds * 1000);

  // Store the main timer reference for cancellation
  timers.set(`${sessionId}__main`, mainTimer);
}

export function continueWithUserMessage(
  sessionId: string,
  message: string,
  mainWindow: BrowserWindow,
): void {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'waiting') return;

  // Cancel countdown timers
  const countdownTimer = timers.get(sessionId);
  const mainTimer = timers.get(`${sessionId}__main`);
  if (countdownTimer) {
    clearInterval(countdownTimer);
    timers.delete(sessionId);
  }
  if (mainTimer) {
    clearTimeout(mainTimer);
    timers.delete(`${sessionId}__main`);
  }

  state.status = 'continuing';
  emitQueueEvent(mainWindow, sessionId, 'countdown_cancelled');
  const continuingTaskId = state.currentTaskId ?? state.lastCompletedTaskId ?? undefined;
  emitQueueEvent(mainWindow, sessionId, 'task_continuing', continuingTaskId);

  // Re-spawn CLI with --resume to continue the previous conversation session.
  // The original task process has already exited, so we need a new process.
  const config = getConfig();
  const cliSessionId = getCliSessionId(sessionId);
  const session = sessionRepo.getSession(sessionId);
  const child = spawnForChat(sessionId, mainWindow, {
    model: session?.model ?? config.defaultModel,
    modelOverride: session?.modelOverride ?? null,
    workingDir: session?.workingDir ?? config.workingDirectory,
    maxTurns: config.maxTurns,
    permissionMode: session?.permissionMode ?? config.permissionMode,
    resumeSessionId: cliSessionId,
  });

  // Write the user's continuation message to stdin
  sendMessage(sessionId, message);

  // 保持 'continuing' 状态直到续写进程退出，让前端能展示"继续执行当前任务"。
  // 进程退出后再由 exit handler 决定进入下一任务倒计时或回到 idle。
  child.on('exit', () => {
    state.currentTaskId = null;

    const remaining = taskRepo.getPendingTasks(sessionId);
    state.pendingCount = remaining.length;

    if (remaining.length > 0) {
      startCountdown(sessionId, mainWindow, config.taskDelaySeconds || DEFAULT_TASK_DELAY_SECONDS);
    } else {
      state.status = 'idle';
      emitQueueEvent(mainWindow, sessionId, 'queue_completed');
    }
  });
}

export function skipCountdown(sessionId: string, mainWindow: BrowserWindow): void {
  const countdownTimer = timers.get(sessionId);
  const mainTimer = timers.get(`${sessionId}__main`);

  if (countdownTimer) {
    clearInterval(countdownTimer);
    timers.delete(sessionId);
  }
  if (mainTimer) {
    clearTimeout(mainTimer);
    timers.delete(`${sessionId}__main`);
  }

  executeNextTask(sessionId, mainWindow);
}

export function getQueueState(sessionId: string): QueueState {
  return queues.get(sessionId) ?? {
    sessionId,
    status: 'idle',
    currentTaskId: null,
    lastCompletedTaskId: null,
    countdownRemaining: 0,
    pendingCount: 0,
  };
}

export function cleanupQueue(sessionId: string): void {
  const countdownTimer = timers.get(sessionId);
  const mainTimer = timers.get(`${sessionId}__main`);
  if (countdownTimer) clearInterval(countdownTimer);
  if (mainTimer) clearTimeout(mainTimer);
  timers.delete(sessionId);
  timers.delete(`${sessionId}__main`);
  queues.delete(sessionId);
}
