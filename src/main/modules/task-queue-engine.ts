import type { BrowserWindow } from 'electron';
import type { Message } from '../../shared/types/session';
import type { ChatSendPayload } from '../../shared/types/attachment';
import type { QueueState } from '../../shared/types/task';
import { IPC_CHANNELS, DEFAULT_TASK_DELAY_SECONDS } from '../../shared/constants';
import {
  spawnForChat,
  spawnForTask,
  killProcess,
  resolveCliSessionId,
  sendMessage,
  getActiveProcess,
} from './chat-backend';
import type { PreparedAttachmentPrompt } from './attachment-prompt-builder';
import { prepareAttachmentPrompt } from './attachment-prompt-builder';
import { resolveAttachmentRecords, assertAttachmentsReadyForSend } from './attachment-service';
import { getConfig } from './config-manager';
import * as taskRepo from '../database/repositories/task-repo';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import * as attachmentRepo from '../database/repositories/attachment-repo';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';

const queues = new Map<string, QueueState>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
const queueGenerations = new Map<string, number>();

function getQueueGeneration(sessionId: string): number {
  return queueGenerations.get(sessionId) ?? 0;
}

function isQueueGenerationActive(sessionId: string, generation: number): boolean {
  return getQueueGeneration(sessionId) === generation && sessionRepo.getSession(sessionId) !== null;
}

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

  runNextTask(sessionId, mainWindow);
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

// 中断当前任务。M8：原实现要求 state.currentTaskId === taskId，但 continuing（续写）
// 状态下 currentTaskId 指向旧任务，导致续写中点中断不生效。放宽：running 或 continuing
// 都允许中断当前会话进程，并清理 countdown 定时器避免泄漏。
export function interruptTask(taskId: string, sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state) return;
  // running：currentTaskId 命中；continuing：currentTaskId 可能为 null/旧值，按 taskId 调用方语义中断。
  const isRunning = state.status === 'running' && state.currentTaskId === taskId;
  const isContinuing = state.status === 'continuing';
  if (!isRunning && !isContinuing) return;

  // 使当前执行实例失效：retry 可能很快把同一 task 再设为 currentTaskId，
  // 旧 child 的迟到 exit 不能据此覆盖新一轮 pending/running 状态。
  queueGenerations.set(sessionId, getQueueGeneration(sessionId) + 1);
  killProcess(sessionId, 'queue');
  if (isRunning) {
    taskRepo.updateTaskStatus(taskId, 'cancelled');
  }

  // 清理 countdown / main 定时器，避免 continuing 被中断后定时器仍触发下一任务。
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

  state.currentTaskId = null;
  state.status = 'idle';

  emitQueueEvent(mainWindow, sessionId, 'task_completed', taskId, { interrupted: true });

  // Continue with next pending task
  const pending = taskRepo.getPendingTasks(sessionId);
  if (pending.length > 0) {
    runNextTask(sessionId, mainWindow);
  }
}

/** 任务结束后推进队列：仍有 pending 则倒计时下一个，否则置 idle。 */
function advanceAfterTask(
  sessionId: string,
  mainWindow: BrowserWindow,
  config: ReturnType<typeof getConfig>,
): void {
  const state = queues.get(sessionId);
  if (!state) return;
  const remaining = taskRepo.getPendingTasks(sessionId);
  state.pendingCount = remaining.length;
  if (remaining.length > 0) {
    startCountdown(sessionId, mainWindow, config.taskDelaySeconds || DEFAULT_TASK_DELAY_SECONDS);
  } else {
    state.status = 'idle';
    emitQueueEvent(mainWindow, sessionId, 'queue_completed');
  }
}

/** fire-and-forget 包装：executeNextTask 改 async 后，所有定时器/事件调用点用此避免 unhandled rejection。 */
function runNextTask(sessionId: string, mainWindow: BrowserWindow): void {
  void executeNextTask(sessionId, mainWindow).catch((e) => {
    logger.error(`executeNextTask threw (session ${sessionId})`, e);
  });
}

async function executeNextTask(sessionId: string, mainWindow: BrowserWindow): Promise<void> {
  const generation = getQueueGeneration(sessionId);
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

  const session = sessionRepo.getSession(sessionId);
  if (!isQueueGenerationActive(sessionId, generation)) return;

  // Task 7B：稳定 clientMessageId（老任务首次执行时生成并持久化，retry/重启复用同一 ID）。
  let clientMessageId = task.clientMessageId;
  if (!clientMessageId) {
    clientMessageId = randomUUID();
    taskRepo.setTaskClientMessageId(task.id, clientMessageId);
  }

  // 解析附件 → prepare 带图片/文件路径的 SDK prompt（可重复迭代，支持 stale-resume 后二次 query）。
  let prepared: PreparedAttachmentPrompt;
  try {
    const { records, paths } = resolveAttachmentRecords(sessionId, task.attachments.map((a) => a.id));
    prepared = await prepareAttachmentPrompt({
      sessionId,
      payload: { text: task.prompt, attachmentIds: records.map((r) => r.id), clientMessageId },
      attachments: records,
      attachmentPaths: paths,
    });
    if (!isQueueGenerationActive(sessionId, generation)) return;
  } catch (err) {
    // 构造失败：task→failed，保留 task link（附件状态不动，仍可 retry）；推进队列继续下一个。
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`executeNextTask prepare failed (task ${task.id}): ${msg}`);
    taskRepo.updateTaskError(task.id, msg);
    emitQueueEvent(mainWindow, sessionId, 'task_failed', task.id);
    state.lastCompletedTaskId = task.id;
    state.currentTaskId = null;
    advanceAfterTask(sessionId, mainWindow, config);
    return;
  }

  // 创建或复用 user message（按 parent_task_id 查；幂等，retry/重启不翻倍消息/links）。
  if (!isQueueGenerationActive(sessionId, generation)) return;
  const existing = messageRepo.getMessagesByTask(task.id).find((m) => m.role === 'user');
  let userMessage: Message;
  if (existing) {
    userMessage = existing;
  } else {
    userMessage = messageRepo.createMessageWithAttachments({
      id: clientMessageId,
      sessionId,
      role: 'user',
      content: prepared.displayText,
      eventType: 'message',
      parentTaskId: task.id,
      attachments: prepared.attachmentIds,
      promoteAttachments: true,
    });
    emitQueueEvent(mainWindow, sessionId, 'user_message_created', task.id, { message: userMessage });
  }

  if (!isQueueGenerationActive(sessionId, generation)) return;
  const executionGeneration = generation;
  let child: ReturnType<typeof spawnForTask>;
  try {
    child = spawnForTask(task.id, sessionId, prepared.prompt, mainWindow, {
      model: session?.model ?? config.defaultModel,
      modelOverride: session?.modelOverride ?? null,
      workingDir: session?.workingDir ?? config.workingDirectory,
      maxTurns: config.maxTurns,
      permissionMode: session?.permissionMode ?? config.permissionMode,
      thinkingLevel: session?.thinkingLevel ?? null,
      resumeSessionId: resolveCliSessionId(sessionId),
      additionalDirectories: prepared.additionalDirectories,
      userCommandText: task.prompt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`executeNextTask spawn failed (task ${task.id}): ${message}`);
    taskRepo.updateTaskError(task.id, message);
    emitQueueEvent(mainWindow, sessionId, 'task_failed', task.id);
    state.lastCompletedTaskId = task.id;
    state.currentTaskId = null;
    advanceAfterTask(sessionId, mainWindow, config);
    return;
  }

  child.on('exit', (code) => {
    if (state.currentTaskId !== task.id || !isQueueGenerationActive(sessionId, executionGeneration)) return;

    if (code === 0) {
      taskRepo.updateTaskStatus(task.id, 'completed');
      emitQueueEvent(mainWindow, sessionId, 'task_completed', task.id, { success: true });
    } else {
      taskRepo.updateTaskError(task.id, `Process exited with code ${code}`);
      emitQueueEvent(mainWindow, sessionId, 'task_failed', task.id, { exitCode: code });
    }

    state.lastCompletedTaskId = task.id;
    state.currentTaskId = null;
    advanceAfterTask(sessionId, mainWindow, config);
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
    runNextTask(sessionId, mainWindow);
  }, delaySeconds * 1000);

  // Store the main timer reference for cancellation
  timers.set(`${sessionId}__main`, mainTimer);
}

export async function continueWithUserMessage(
  sessionId: string,
  payload: ChatSendPayload,
  mainWindow: BrowserWindow,
): Promise<Message> {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'waiting') {
    throw new Error('当前不在等待续接状态，无法提交消息');
  }
  const session = sessionRepo.getSession(sessionId);
  if (!session) throw new Error('会话不存在');

  // 预检（全通过后才动状态）：无 active query + 附件就绪（draft）+ prepare prompt。
  if (getActiveProcess(sessionId)) {
    throw new Error('当前回合仍在执行，请等待结束或中断后重试');
  }
  const { records, paths } = assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
  const prepared = await prepareAttachmentPrompt({
    sessionId,
    payload,
    attachments: records,
    attachmentPaths: paths,
  });

  // 取消 countdown（预检通过后才取消，避免非法提交误清倒计时/误清草稿）。
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

  const continuingTaskId = state.currentTaskId ?? state.lastCompletedTaskId ?? undefined;
  const config = getConfig();
  // query 真正接收前保持附件 draft；同步启动失败时可删除消息并原样重试。
  const userMessage = messageRepo.createMessageWithAttachments({
    id: payload.clientMessageId,
    sessionId,
    role: 'user',
    content: prepared.displayText,
    eventType: 'message',
    attachments: prepared.attachmentIds,
    promoteAttachments: false,
  });

  let spawned = false;
  let child: ReturnType<typeof spawnForChat>;
  try {
    child = spawnForChat(sessionId, mainWindow, {
      model: session.model ?? config.defaultModel,
      modelOverride: session.modelOverride ?? null,
      workingDir: session.workingDir ?? config.workingDirectory,
      maxTurns: config.maxTurns,
      permissionMode: session.permissionMode ?? config.permissionMode,
      thinkingLevel: session.thinkingLevel,
      resumeSessionId: resolveCliSessionId(sessionId),
      additionalDirectories: prepared.additionalDirectories,
      userCommandText: payload.text,
    });
    spawned = true;

    // SDK prompt（含图片时为可重复迭代 AsyncIterable，支持 stale-resume 重试）；sendMessage 触发 runQuery。
    sendMessage(sessionId, prepared.prompt);
  } catch (err) {
    if (spawned) killProcess(sessionId, 'queue');
    messageRepo.deleteMessage(userMessage.id);
    if (prepared.attachmentIds.length > 0) {
      attachmentRepo.markAttachmentsStatus(prepared.attachmentIds, 'draft');
    }
    throw err;
  }

  if (prepared.attachmentIds.length > 0) {
    attachmentRepo.markAttachmentsStatus(prepared.attachmentIds, 'message');
  }
  state.status = 'continuing';
  emitQueueEvent(mainWindow, sessionId, 'countdown_cancelled');
  emitQueueEvent(mainWindow, sessionId, 'task_continuing', continuingTaskId);
  emitQueueEvent(mainWindow, sessionId, 'user_message_created', continuingTaskId, { message: userMessage });

  // 保持 'continuing' 直到续写进程退出；退出后推进下一任务或回 idle。
  child.on('exit', () => {
    // P1 守卫：续写进程退出可能晚于 interruptTask（已被改为 idle）或晚于新任务 spawn（已是 running）。
    // 仅在仍是 continuing 时推进，否则交由当前状态所有者处理，避免僵尸回调插队。
    if (state.status !== 'continuing') return;

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

  return userMessage;
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

  runNextTask(sessionId, mainWindow);
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
  queueGenerations.set(sessionId, getQueueGeneration(sessionId) + 1);
  const countdownTimer = timers.get(sessionId);
  const mainTimer = timers.get(`${sessionId}__main`);
  if (countdownTimer) clearInterval(countdownTimer);
  if (mainTimer) clearTimeout(mainTimer);
  timers.delete(sessionId);
  timers.delete(`${sessionId}__main`);
  queues.delete(sessionId);
}
