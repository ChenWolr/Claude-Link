// task-queue-engine.ts
// 队列任务调度引擎（v3 语义，2026-09-03）。唯一规格：docs/plans/2026-09-03-queue-semantics-v3.md §1。
//
// 调度器状态（每会话独立）：standby（待命，不计时不出队）/ countdown（倒计时中）/ running（回合执行中）。
// 核心不变量：
//  - status='running' 的唯二入口是 beginUserTurn（普通发送/插话占坑后）与 popExecute（队列任务出队），
//    两者都清 standbyReason；
//  - 回合终态以 result 事件为权威信号（noteTurnOutcome），绝不以 getActiveProcess 存在性做守卫——
//    result 到达时进程可能尚未退出，用进程存在性当守卫会吞掉所有正常 result。幂等靠状态机闸
//   （arm/halt 都要求 status==='running'），重复/迟到 result 天然 no-op；
//  - 「重启后绝不自动执行」无闸门设计：引擎所有 Map 启动时为空，倒计时的启动只可能发生在
//    noteTurnOutcome(success)→armAfterTurn 与 armFromUserAction（恢复/全部恢复）两处，runTaskNow
//    则是用户显式动作。没有任何路径会在启动时或开关打开时自发起倒计时，重启后无需唤醒白名单。
import type { BrowserWindow } from 'electron';
import type { Message } from '../../shared/types/session';
import type { QueueState, QueueOverview, ExecutedTaskInfo, ExecutedOutcome, Task } from '../../shared/types/task';
import { IPC_CHANNELS } from '../../shared/constants';
import { resolveQueueDelaySeconds } from '../../shared/queue-config';
import {
  spawnForTask,
  resolveCliSessionId,
  getActiveProcess,
} from './chat-backend';
import type { PreparedAttachmentPrompt } from './attachment-prompt-builder';
import { prepareAttachmentPrompt } from './attachment-prompt-builder';
import { resolveAttachmentRecords } from './attachment-service';
import { getConfig } from './config-manager';
import * as taskRepo from '../database/repositories/task-repo';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';

/** 每会话调度器状态。 */
const queues = new Map<string, QueueState>();
/** 倒计时秒针 interval。 */
const timers = new Map<string, ReturnType<typeof setInterval>>();
/** 倒计时归零触发的主 setTimeout（独立 Map，清理不再动 key 拼接）。 */
const mainTimers = new Map<string, ReturnType<typeof setTimeout>>();
/** 执行代际：会话删除/重建后使旧 child 的迟到 exit 失效。 */
const generations = new Map<string, number>();
/** 「本次已执行」历史（方案 A：纯内存、本次运行期、重启清零、上限 50 条，新→旧）。 */
const executedHistory = new Map<string, ExecutedTaskInfo[]>();

const EXECUTED_HISTORY_CAP = 50;

function getQueueGeneration(sessionId: string): number {
  return generations.get(sessionId) ?? 0;
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
      status: 'standby',
      standbyReason: 'restart',
      countdownRemaining: 0,
      currentTaskId: null,
    };
    queues.set(sessionId, state);
  }
  return state;
}

/** 清掉该会话的秒针 interval 与归零主 timer（幂等）。 */
function cancelTimers(sessionId: string): void {
  const interval = timers.get(sessionId);
  if (interval) {
    clearInterval(interval);
    timers.delete(sessionId);
  }
  const main = mainTimers.get(sessionId);
  if (main) {
    clearTimeout(main);
    mainTimers.delete(sessionId);
  }
}

/** 状态迁移后的权威快照通道：渲染层整体替换 queueState。 */
function emitStateChanged(mainWindow: BrowserWindow, sessionId: string): void {
  const state = getOrCreateQueue(sessionId);
  emitQueueEvent(mainWindow, sessionId, 'state_changed', undefined, { state: { ...state } });
}

/** 结算当前队列任务回合：历史条目定终态 + 清 currentTaskId + 发 task_settled。
 *  中断路径（两段式 abort 兜底只 emitExit 不发 result 事件）依赖此事件更新渲染层历史
 *  与 markStopped——它是中断收口在渲染层的唯一信号。currentTaskId 为空（普通回合）时 no-op。 */
function settleCurrent(sessionId: string, outcome: ExecutedOutcome, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || !state.currentTaskId) return;
  const taskId = state.currentTaskId;
  const history = executedHistory.get(sessionId) ?? [];
  const entry = history.find((h) => h.taskId === taskId && h.outcome === 'running');
  if (entry) {
    entry.outcome = outcome;
    entry.settledAt = new Date().toISOString();
  }
  state.currentTaskId = null;
  logger.info(`[queue] settle task=${taskId} outcome=${outcome} session=${sessionId}`);
  emitQueueEvent(mainWindow, sessionId, 'task_settled', taskId, { outcome });
}

/** 用户直发占坑成功后的回合开始：插话顶掉倒计时（规则 #4 的唯一取消载体）+ 置 running。
 *  standbyReason 描述的是「为什么待命」，回合开始即成历史，置 null。 */
export function beginUserTurn(sessionId: string, mainWindow: BrowserWindow): void {
  const state = getOrCreateQueue(sessionId);
  cancelTimers(sessionId);
  state.status = 'running';
  state.standbyReason = null;
  state.countdownRemaining = 0;
  logger.info(`[queue] beginUserTurn session=${sessionId}`);
  emitStateChanged(mainWindow, sessionId);
}

/** 全量倒计时（每次现取配置——进行中的旧倒计时不受配置修改影响，改配置只影响下一轮）。
 *  入口先 cancelTimers（幂等）并置 standbyReason=null（防 halt_* 残留：熔断→恢复→倒计时中
 *  渲染层 queuePausedNow 须已复位）。 */
function startCountdown(sessionId: string, mainWindow: BrowserWindow): void {
  const state = getOrCreateQueue(sessionId);
  cancelTimers(sessionId);

  const intervalSeconds = resolveQueueDelaySeconds(getConfig().taskDelayMinutes);
  state.standbyReason = null;
  state.status = 'countdown';
  state.countdownRemaining = intervalSeconds;
  emitQueueEvent(mainWindow, sessionId, 'countdown_started', undefined, { seconds: intervalSeconds });
  emitStateChanged(mainWindow, sessionId);

  const generation = getQueueGeneration(sessionId);
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
    cancelTimers(sessionId);
    // 归零回调守卫：竞态防双执行——状态已被插话/停止改变、或已有活动回合时放弃。
    if (!isQueueGenerationActive(sessionId, generation)) return;
    if (state.status !== 'countdown') return;
    if (getActiveProcess(sessionId)) return;
    const runnable = taskRepo.getPendingTasks(sessionId);
    if (!runnable.length) {
      state.status = 'standby';
      state.standbyReason = null;
      state.countdownRemaining = 0;
      emitStateChanged(mainWindow, sessionId);
      return;
    }
    void popExecute(sessionId, mainWindow, runnable[0]).catch((e) => {
      logger.error(`popExecute threw (session ${sessionId})`, e);
    });
  }, intervalSeconds * 1000);
  mainTimers.set(sessionId, mainTimer);
}

/** 回合正常结束后的 arming（仅 noteTurnOutcome(success) 调用）：有开关且有未暂停 pending →
 *  全量倒计时；否则 standby（开关关时保留 switch_off 语义，面板文案不回退成「待命中」）。 */
function armAfterTurn(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'running') return;
  const queueEnabled = getConfig().queueEnabled === true;
  if (queueEnabled && taskRepo.getPendingTasks(sessionId).length > 0) {
    startCountdown(sessionId, mainWindow);
    return;
  }
  state.status = 'standby';
  state.standbyReason = queueEnabled ? null : 'switch_off';
  state.countdownRemaining = 0;
  emitStateChanged(mainWindow, sessionId);
}

/** 用户动作触发的 arming（恢复单个/全部恢复/TASK_SET_PAUSED 恢复路径）：standby 且无活动进程
 *  且开关开且有未暂停 pending → 全量倒计时。countdown 已在走时 no-op（「不打断不重置」）；
 *  回合中 no-op（交给 armAfterTurn）。 */
export function armFromUserAction(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'standby') return;
  if (getActiveProcess(sessionId)) return;
  if (getConfig().queueEnabled !== true) return;
  if (taskRepo.getPendingTasks(sessionId).length === 0) return;
  startCountdown(sessionId, mainWindow);
}

/** 熔断：该会话全部 pending 任务置 paused → standby(halt_*)。
 *  幂等闸带 status 条件：已处熔断待命态（standby + halt_*）才直接 return——防 exit 兜底/迟到
 *  事件把 halt_interrupted 覆盖成 halt_failed；熔断→恢复→countdown→再失败时 status 已非
 *  standby（running/countdown），第二次熔断是合法的，不得拦截。
 *  N9：队列开关联动闸——开关关时普通直发回合的失败/中断不得熔断（「开关关：任务状态不动」，
 *  与 armFromUserAction / runTaskNow 的开关闸同语义）。
 *  R1（复查 2026-09-08）：开关关时 beginUserTurn（无开关闸）已把直发回合置 running——早退前须
 *  把 running 收口为 standby(switch_off)，否则回合失败/中断后引擎卡 running（面板假象
 *  「回合执行中…」、armFromUserAction 等 standby 依赖路径被阻塞）。任务状态不动（不
 *  pauseAllPending）、不广播 queue_halted；countdown 理论上不存在（onQueueEnabledChanged(false)
 *  已收口），standby 则 no-op。 */
export function haltQueue(sessionId: string, reason: 'failed' | 'interrupted', mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state) return;
  if (getConfig().queueEnabled !== true) {
    if (state.status === 'running') {
      state.status = 'standby';
      state.standbyReason = 'switch_off';
      state.countdownRemaining = 0;
      logger.info(`[queue] halt suppressed (switch off) session=${sessionId} reason=${reason} → standby(switch_off)`);
      emitStateChanged(mainWindow, sessionId);
    }
    return;
  }
  if (state.status === 'standby' && (state.standbyReason === 'halt_failed' || state.standbyReason === 'halt_interrupted')) {
    return;
  }
  cancelTimers(sessionId);
  taskRepo.pauseAllPending(sessionId);
  state.status = 'standby';
  state.standbyReason = reason === 'failed' ? 'halt_failed' : 'halt_interrupted';
  state.countdownRemaining = 0;
  logger.info(`[queue] halt session=${sessionId} reason=${reason}`);
  emitStateChanged(mainWindow, sessionId);
  emitQueueEvent(mainWindow, sessionId, 'queue_halted', undefined, { reason });
}

/** CHAT_ABORT 专用熔断挂点（killProcess 仍由 handler 调，引擎不自己 kill）：
 *  守卫以引擎状态机为主判据（running）+ 活动进程兜底——与 killProcess 是否同步移除占坑记录的
 *  时序解耦。result('aborted') 先到并已 halt 时 status 已非 running → no-op（不重复熔断）；
 *  空闲误按 → 双判据皆假 → 不熔断。先 settleCurrent（中断路径无 result，这是唯一结算时机，
 *  并令 popExecute 的 exit 兜底因 currentTaskId 不匹配而失效，防 reason 被覆盖），再熔断。 */
export function abortHalt(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  const running = state ? state.status === 'running' : false;
  if (!running && !getActiveProcess(sessionId)) return;
  logger.info(`[queue] abortHalt session=${sessionId}`);
  settleCurrent(sessionId, 'interrupted', mainWindow);
  haltQueue(sessionId, 'interrupted', mainWindow);
}

/** 中央 result 钩子（sdk-backend forwardEvent 调用）。不设进程存在性守卫——result 事件本身就是
 *  回合结束的权威信号（见文件头注释）。先结算队列任务回合（若有），再按 status==='running'
 *  幂等闸分派：success→armAfterTurn（唤醒事件三）；error/interrupted→haltQueue（熔断）。
 *  入口行日志（带当时 status）：result 与 exit 兜底到达顺序的时序实证依据（B19）。 */
export function noteTurnOutcome(sessionId: string, outcome: 'success' | 'error' | 'interrupted', mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  logger.info(`[queue] outcome session=${sessionId} outcome=${outcome} status=${state?.status ?? 'none'} currentTask=${state?.currentTaskId ?? 'none'}`);
  if (state && state.currentTaskId) {
    // ExecutedOutcome 无 'error' 档（typecheck 存量缺口）：错误回合按渲染层四态映射为 'failed'。
    settleCurrent(sessionId, outcome === 'error' ? 'failed' : outcome, mainWindow);
  }
  if (!state || state.status !== 'running') return;
  if (outcome === 'success') {
    armAfterTurn(sessionId, mainWindow);
  } else {
    haltQueue(sessionId, outcome === 'interrupted' ? 'interrupted' : 'failed', mainWindow);
  }
}

/** 「立即执行」：守卫（抛 Error 给 IPC → 渲染层 notice）后跳过倒计时立即出队执行；
 *  非队首=插队：该任务 reorder 到可执行序列首位，原队首保留为下一个倒计时对象。
 *  paused 任务可立即执行（主会话空闲时），执行前先解除暂停。 */
export function runTaskNow(taskId: string, mainWindow: BrowserWindow): QueueOverview {
  const task = taskRepo.getTask(taskId);
  if (!task || task.status !== 'pending') throw new Error('任务不存在或不在待执行状态');
  if (getConfig().queueEnabled !== true) throw new Error('队列开关已关闭');
  const state = getOrCreateQueue(task.sessionId);
  if (getActiveProcess(task.sessionId) || state.status === 'running') {
    throw new Error('当前会话有任务执行中，结束后可立即执行');
  }
  cancelTimers(task.sessionId);
  // v3.1：paused 任务允许「立即执行」（主会话空闲守卫已过）——先解除暂停，落位/结算按未暂停处理
  if (task.paused) taskRepo.setTaskPaused(taskId, false);
  // 插队：目标任务挪到会话全部任务首位（其余保持现序），原队首自然成为下一个出队对象。
  const rest = taskRepo.getTasksBySession(task.sessionId).filter((t) => t.id !== taskId).map((t) => t.id);
  taskRepo.reorderTasks(task.sessionId, [taskId, ...rest]);
  void popExecute(task.sessionId, mainWindow, task).catch((e) => {
    logger.error(`popExecute (runTaskNow) threw (task ${taskId})`, e);
  });
  return getQueueOverview(task.sessionId);
}

/** 「全部恢复」（熔断提示行内按钮）：全部 paused→pending + 立即开始全量倒计时（经 armFromUserAction
 *  的 standby 前置守卫；无活动回合时必 arm，回合中则交给回合结束 armAfterTurn）。 */
export function resumeAllTasks(sessionId: string, mainWindow: BrowserWindow): QueueOverview {
  taskRepo.resumeAllPending(sessionId);
  armFromUserAction(sessionId, mainWindow);
  return getQueueOverview(sessionId);
}

/** 队列开关切换钩子（CONFIG_SAVE 值变化时调）：关→取消各会话倒计时转 standby(switch_off)，
 *  任务状态不动；开→仅清各会话的 switch_off reason（不 arm——重新打开不自动计时）。 */
export function onQueueEnabledChanged(enabled: boolean, mainWindow: BrowserWindow): void {
  if (!enabled) {
    for (const [sessionId, state] of queues) {
      if (state.status !== 'countdown') continue;
      cancelTimers(sessionId);
      state.status = 'standby';
      state.standbyReason = 'switch_off';
      state.countdownRemaining = 0;
      emitStateChanged(mainWindow, sessionId);
    }
    return;
  }
  for (const state of queues.values()) {
    if (state.standbyReason === 'switch_off') {
      state.standbyReason = null;
      emitStateChanged(mainWindow, state.sessionId);
    }
  }
}

/** 暂停/删除任务后若已无未暂停 pending → 取消倒计时转 standby（语义表 #9/#10 的挂点载体）；
 *  仍有未暂停任务 → 倒计时继续（到期取新队首）。非 countdown 状态 no-op。 */
export function drainCountdownIfNoRunnable(sessionId: string, mainWindow: BrowserWindow): void {
  const state = queues.get(sessionId);
  if (!state || state.status !== 'countdown') return;
  if (taskRepo.getPendingTasks(sessionId).length > 0) return;
  cancelTimers(sessionId);
  state.status = 'standby';
  state.standbyReason = null;
  state.countdownRemaining = 0;
  emitStateChanged(mainWindow, sessionId);
}

/** 面板全量数据：状态快照 + pending 任务（含 paused，按 sort_order）+ 本次已执行历史。 */
export function getQueueOverview(sessionId: string): QueueOverview {
  const state = getOrCreateQueue(sessionId);
  return {
    state: { ...state },
    tasks: taskRepo.getTasksBySession(sessionId).filter((t) => t.status === 'pending'),
    executed: executedHistory.get(sessionId) ?? [],
  };
}

/** 会话删除：代际+1 使旧 child 迟到 exit 失效，并清全部五张 per-session Map。 */
export function cleanupQueue(sessionId: string): void {
  generations.set(sessionId, getQueueGeneration(sessionId) + 1);
  cancelTimers(sessionId);
  queues.delete(sessionId);
  executedHistory.delete(sessionId);
  generations.delete(sessionId);
}

/** 出队执行（countdown 归零取 runnable[0] 与 runTaskNow 共用；status='running' 的第二个入口）。
 *  承接旧 executeNextTask 主体，差异：落位/历史/结算全部对齐 v3 语义——
 *  旧 child exit 的 advance/completed/failed 收尾删除，仅保留 result 丢失兜底
 * （currentTaskId 匹配才补 noteTurnOutcome；正常路径 result 先到、settle 已清 currentTaskId，
 *  此匹配自然失效；abortHalt 已熔断时 haltQueue 的 halt_* 幂等闸保证 reason 不被覆盖）。 */
async function popExecute(sessionId: string, mainWindow: BrowserWindow, task: Task): Promise<void> {
  if (!task) return;
  const generation = getQueueGeneration(sessionId);
  const state = getOrCreateQueue(sessionId);
  state.status = 'running';
  state.currentTaskId = task.id;
  state.countdownRemaining = 0;
  state.standbyReason = null;
  emitStateChanged(mainWindow, sessionId);

  // DB 仍记 running——面板不读它，仅崩溃恢复（resetRunningTasks→failed）用。
  taskRepo.updateTaskStatus(task.id, 'running');
  const history = executedHistory.get(sessionId) ?? [];
  history.unshift({
    taskId: task.id,
    prompt: task.prompt,
    attachments: task.attachments,
    outcome: 'running',
    settledAt: new Date().toISOString(),
  });
  if (history.length > EXECUTED_HISTORY_CAP) history.length = EXECUTED_HISTORY_CAP;
  executedHistory.set(sessionId, history);
  emitQueueEvent(mainWindow, sessionId, 'task_started', task.id, {
    prompt: task.prompt,
    attachments: task.attachments,
  });

  const session = sessionRepo.getSession(sessionId);
  if (!isQueueGenerationActive(sessionId, generation)) return;

  // 稳定 clientMessageId（老任务首次执行时生成并持久化，重启复用同一 ID）。
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
    // 构造失败：定账 failed + 熔断（v3 语义：任务不再回队，失败重试走主会话「重新编辑发送」）。
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`popExecute prepare failed (task ${task.id}): ${msg}`);
    taskRepo.updateTaskError(task.id, msg);
    settleCurrent(sessionId, 'failed', mainWindow);
    haltQueue(sessionId, 'failed', mainWindow);
    return;
  }

  // 创建或复用 user message（按 parent_task_id 查；幂等，重启不翻倍消息/links）。
  if (!isQueueGenerationActive(sessionId, generation)) return;
  try {
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
  } catch (err) {
    // P2-11：消息创建段异常收口——此前夹在两个 try 之间裸奔，IPC/DB 瞬时失败会让引擎僵尸
    // running、任务无痕丢失。失败定账 failed + 结算（settleCurrent 自发 task_settled 让渲染层
    // 收口）。本地 DB 错误**不**触发 haltQueue 熔断（与回合失败/上游错误语义区分，pending 任务
    // 不转 paused）；但必须显式退出 running（置 standby），否则无回合可结算，引擎卡死。
    // settleCurrent 后 exit 兜底因 currentTaskId 失配自然失效。
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`popExecute createMessage failed (task ${task.id}): ${message}`);
    taskRepo.updateTaskError(task.id, `消息创建失败：${message}`);
    settleCurrent(sessionId, 'failed', mainWindow);
    const stateAfter = queues.get(sessionId);
    if (stateAfter && stateAfter.status === 'running') {
      stateAfter.status = 'standby';
      stateAfter.standbyReason = 'halt_failed';
      emitStateChanged(mainWindow, sessionId);
    }
    return;
  }

  if (!isQueueGenerationActive(sessionId, generation)) return;
  const executionGeneration = generation;
  let child: ReturnType<typeof spawnForTask>;
  try {
    child = spawnForTask(task.id, sessionId, prepared.prompt, mainWindow, {
      model: session?.model ?? getConfig().defaultModel,
      modelOverride: session?.modelOverride ?? null,
      providerOverride: session?.providerOverride ?? null,
      workingDir: session?.workingDir ?? getConfig().workingDirectory,
      maxTurns: getConfig().maxTurns,
      permissionMode: session?.permissionMode ?? null,
      thinkingLevel: session?.thinkingLevel ?? null,
      resumeSessionId: resolveCliSessionId(sessionId),
      additionalDirectories: prepared.additionalDirectories,
      userCommandText: task.prompt,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`popExecute spawn failed (task ${task.id}): ${message}`);
    taskRepo.updateTaskError(task.id, message);
    settleCurrent(sessionId, 'failed', mainWindow);
    haltQueue(sessionId, 'failed', mainWindow);
    return;
  }

  // 注意：spawnForTask 是 task 模式（prompt 已知，直接起 query），无需也不能再 sendMessage
  //（会抛「没有待发送的 SDK 入口」——ChatSend 模式的首条消息通道）。

  // result 丢失兜底（崩溃路径）：正常路径 result 先到、settleCurrent 已清 currentTaskId，
  // 此匹配自然失效；abortHalt 已熔断时 noteTurnOutcome 的 running 闸 + haltQueue 的 halt_* 闸双双 no-op。
  child.on('exit', (code) => {
    if (!isQueueGenerationActive(sessionId, executionGeneration)) return;
    if (state.currentTaskId !== task.id) return;
    // P1-2「新回合在途」让位守卫（与 CHAT_SEND exit 兜底的代际守卫同形）：两段式 kill 优雅窗内
    // getActiveProcess 判否、直发消息畅通，spawnForChat 经 forceKill 接管后 beginUserTurn 只置
    // running 不清 currentTaskId；旧任务 child 迟到 exit 若照常记账，noteTurnOutcome('error')
    // 会命中新回合的 running 闸 → haltQueue 误熔断整个队列。有别的活动 entry 在途（必属别的
    // 回合）即让位——不记账、不熔断。引擎已从 chat-backend 导入 getActiveProcess，无循环依赖。
    const active = getActiveProcess(sessionId);
    if (active && active !== child) {
      logger.info(`[queue] child exit fallback session=${sessionId} task=${task.id} 让位：新回合在途，旧 exit 不记账`);
      return;
    }
    logger.info(`[queue] child exit fallback session=${sessionId} task=${task.id} code=${code}`);
    noteTurnOutcome(sessionId, code === 0 ? 'success' : 'error', mainWindow);
  });
}
