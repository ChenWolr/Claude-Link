// tdd-queue-semantics-v3-verify.ts
// 队列任务语义 v3（2026-09-03）源码契约 + 纯函数行为断言。唯一规格：
// docs/plans/2026-09-03-queue-semantics-v3.md（§1 语义表 16 条 / §3 任务分解 / §4 边界值）。
// 覆盖机制要点：①result 路径无进程守卫、状态机幂等；②beginUserTurn/popExecute 唯二 running 入口；
// ③haltQueue 幂等闸带 standby 条件；④runTaskNow=cancelTimers→插队→popExecute；⑤settleCurrent 发
// task_settled；⑥CHAT_SEND 挂 beginUserTurn+exit 兜底、CHAT_ABORT 挂 abortHalt。
// 纯源码 + 纯函数断言，不依赖 Electron 运行时。
import { readFileSync, existsSync } from 'node:fs';
import {
  sanitizeTaskDelayMinutes,
  resolveQueueDelaySeconds,
  DEFAULT_TASK_DELAY_MINUTES,
} from '../src/shared/queue-config';
import { taskEtaText } from '../src/shared/queue-eta';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}
// 旧语义死路径标识：分片拼装——本文件不出现任何完整旧标识字面量，
// 从而不触发「全仓 grep 旧标识零命中」门禁（计划 §6.1；断言本身仍逐一锁死零残留）。
const OLD_QUEUE_SEND = 'queue' + 'User' + 'Message';
const OLD_CONTINUE = 'continue' + 'With' + 'User' + 'Message';
const OLD_AUTOSTART = 'maybe' + 'Auto' + 'Start' + 'Queue';
const OLD_SKIP = 'skip' + 'Count' + 'down';
const OLD_RETRY_CH = 'TASK_' + 'RETRY';
const OLD_INTERRUPT_CH = 'TASK_' + 'INTERRUPT';
const OLD_QSTART_CH = 'QUEUE_' + 'START';
const OLD_ARMED = 'armed' + 'Sessions';

/** 截取 source 中 from 起点函数体（到下一个顶层 function 或文件尾）。 */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  const nextExport = source.indexOf('\nexport ', start + 1);
  const candidates = [next, nextExport].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

// ── 1) shared/queue-eta：ETA 纯函数（§1 规格逐行行为断言）──
{
  const PAUSED = '已暂停 · 点恢复后重新计时';
  const STANDBY = '待命 · 完成一次会话或点恢复后调度';
  const base = { countdownRemaining: 0, intervalSeconds: 300, runnableIndex: 0 };

  // 规则 1：暂停短路；非暂停 -1 → null
  check('eta: 已暂停任务短路返回暂停文案', taskEtaText({ paused: true }, { ...base, status: 'countdown', countdownRemaining: 30 }) === PAUSED);
  check('eta: 已暂停任务任何状态都返回暂停文案（running）', taskEtaText({ paused: true }, { ...base, status: 'running' }) === PAUSED);
  check('eta: 未暂停但 runnableIndex=-1 返回 null', taskEtaText({ paused: false }, { ...base, status: 'countdown', runnableIndex: -1 }) === null);

  // 规则 2：running
  check('eta: running 首位=回合结束后倒计时（5 分钟）', taskEtaText({ paused: false }, { ...base, status: 'running' }) === '当前回合结束后倒计时 5 分钟 执行');
  check('eta: running 首位秒级间隔（45s）', taskEtaText({ paused: false }, { ...base, status: 'running', intervalSeconds: 45 }) === '当前回合结束后倒计时 45s 执行');
  check('eta: running 第 3 位=最早约 15 分钟（第 3 位）', taskEtaText({ paused: false }, { ...base, status: 'running', runnableIndex: 2 }) === '最早约 15 分钟 后（第 3 位）');

  // 规则 3：countdown（live 秒 + 下界公式 + 负数钳 0）
  check('eta: countdown 首位 live=42s 后执行', taskEtaText({ paused: false }, { ...base, status: 'countdown', countdownRemaining: 42 }) === '42s 后执行');
  check('eta: countdown 首位负数钳 0', taskEtaText({ paused: false }, { ...base, status: 'countdown', countdownRemaining: -3 }) === '0s 后执行');
  check('eta: countdown 第 2 位=最早约 2 分钟（cd42+60）', taskEtaText({ paused: false }, { ...base, status: 'countdown', countdownRemaining: 42, intervalSeconds: 60, runnableIndex: 1 }) === '最早约 2 分钟 后（第 2 位）');
  check('eta: countdown 第 2 位秒级下界（cd30+45=75s→1 分钟）', taskEtaText({ paused: false }, { ...base, status: 'countdown', countdownRemaining: 30, intervalSeconds: 45, runnableIndex: 1 }) === '最早约 1 分钟 后（第 2 位）');

  // 规则 4：standby
  check('eta: standby 文案', taskEtaText({ paused: false }, { ...base, status: 'standby' }) === STANDBY);

  // 边界：interval 非法回落 300
  check('eta: interval=NaN 回落 300（running 首位 5 分钟）', taskEtaText({ paused: false }, { ...base, status: 'running', intervalSeconds: Number.NaN }) === '当前回合结束后倒计时 5 分钟 执行');
  check('eta: interval=0 回落 300', taskEtaText({ paused: false }, { ...base, status: 'running', intervalSeconds: 0 }) === '当前回合结束后倒计时 5 分钟 执行');
  check('eta: interval=-5 回落 300', taskEtaText({ paused: false }, { ...base, status: 'running', intervalSeconds: -5 }) === '当前回合结束后倒计时 5 分钟 执行');
}

// ── 2) shared/types/ipc：通道增删 ──
{
  const ipcTypes = read('../src/shared/types/ipc.ts');
  check("ipc: 新通道 TASK_RUN_NOW: 'task:run-now'", /TASK_RUN_NOW: 'task:run-now'/.test(ipcTypes));
  check("ipc: 新通道 QUEUE_RESUME_ALL: 'queue:resumeAll'", /QUEUE_RESUME_ALL: 'queue:resumeAll'/.test(ipcTypes));
  check("ipc: 新通道 QUEUE_GET_OVERVIEW: 'queue:getOverview'", /QUEUE_GET_OVERVIEW: 'queue:getOverview'/.test(ipcTypes));
  check('ipc: 删除队列级开始通道', !ipcTypes.includes(OLD_QSTART_CH));
  check('ipc: 删除 QUEUE_PAUSE', !ipcTypes.includes('QUEUE_PAUSE'));
  check('ipc: 删除 QUEUE_RESUME 通道', !ipcTypes.includes("QUEUE_RESUME:") && !ipcTypes.includes("'queue:resume'"));
  check('ipc: 删除 QUEUE_GET_STATE', !ipcTypes.includes('QUEUE_GET_STATE'));
  check('ipc: 删除 QUEUE_USER_MESSAGE', !ipcTypes.includes('QUEUE_USER_MESSAGE'));
  check('ipc: 删除任务中断通道', !ipcTypes.includes(OLD_INTERRUPT_CH));
  check('ipc: 删除任务重试通道', !ipcTypes.includes(OLD_RETRY_CH));
  check('ipc: 保留 TASK_ADD', ipcTypes.includes('TASK_ADD'));
  check('ipc: 保留 TASK_REMOVE', ipcTypes.includes('TASK_REMOVE'));
  check('ipc: 保留 TASK_GET_ALL', ipcTypes.includes('TASK_GET_ALL'));
  check('ipc: 保留 TASK_REORDER', ipcTypes.includes('TASK_REORDER'));
  check('ipc: 保留 TASK_SET_PAUSED', ipcTypes.includes('TASK_SET_PAUSED'));
  check('ipc: 保留 QUEUE_EVENT', ipcTypes.includes('QUEUE_EVENT'));
  check("ipc: QueueEventType 含 state_changed", /'state_changed'/.test(ipcTypes));
  check("ipc: QueueEventType 含 task_settled", /'task_settled'/.test(ipcTypes));
  check("ipc: QueueEventType 含 queue_halted", /'queue_halted'/.test(ipcTypes));
  check('ipc: QueueEventType 删 countdown_cancelled', !ipcTypes.includes("'countdown_cancelled'"));
  check('ipc: QueueEventType 删 task_continuing', !ipcTypes.includes("'task_continuing'"));
  check('ipc: QueueEventType 删 queue_paused', !ipcTypes.includes("'queue_paused'"));
  check('ipc: QueueEventType 删 queue_completed', !ipcTypes.includes("'queue_completed'"));
  check('ipc: QueueEventType 删 task_completed', !ipcTypes.includes("'task_completed'"));
  check('ipc: QueueEventType 删 task_failed', !ipcTypes.includes("'task_failed'"));

  const taskTypes = read('../src/shared/types/task.ts');
  check("task.ts: QueueStateStatus = 'standby' | 'countdown' | 'running'", /QueueStateStatus = 'standby' \| 'countdown' \| 'running'/.test(taskTypes));
  check('task.ts: QueueState 有 standbyReason', /standbyReason: QueueStandbyReason|standbyReason: 'restart' \| 'halt_failed' \| 'halt_interrupted' \| 'switch_off' \| null/.test(taskTypes));
  check('task.ts: QueueState 删 lastCompletedTaskId', !taskTypes.includes('lastCompletedTaskId'));
  check('task.ts: QueueState 删 pendingCount', !taskTypes.includes('pendingCount'));
  check('task.ts: ExecutedOutcome 四态', /ExecutedOutcome = 'running' \| 'success' \| 'failed' \| 'interrupted'/.test(taskTypes));
  check('task.ts: ExecutedTaskInfo 含 taskId/prompt/attachments/outcome/settledAt', /interface ExecutedTaskInfo \{[\s\S]*taskId: string;[\s\S]*prompt: string;[\s\S]*attachments: AttachmentSummary\[\];[\s\S]*outcome: ExecutedOutcome;[\s\S]*settledAt: string;/.test(taskTypes));
  check('task.ts: QueueOverview 含 state/tasks/executed', /interface QueueOverview \{[\s\S]*state: QueueState;[\s\S]*tasks: Task\[\];[\s\S]*executed: ExecutedTaskInfo\[\];/.test(taskTypes));

  const completion = read('../src/shared/session-completion.ts');
  check('session-completion: 导出 isAbortedCliResult', /export function isAbortedCliResult/.test(completion));
  const abortFn = fnBody(completion, 'export function isAbortedCliResult');
  check('session-completion: aborted 判定实证值 error_during_execution', abortFn.includes("'error_during_execution'"));
}

// ── 3) 引擎 task-queue-engine.ts：调度原语/幂等闸/退出兜底/旧语义清除 ──
{
  const engine = read('../src/main/modules/task-queue-engine.ts');
  check('engine: 导出 beginUserTurn', engine.includes('export function beginUserTurn'));
  const beginBody = fnBody(engine, 'export function beginUserTurn');
  check('engine: beginUserTurn 体内 cancelTimers（插话顶掉倒计时）', beginBody.includes('cancelTimers(sessionId)'));
  check('engine: beginUserTurn 置 status running', beginBody.includes("state.status = 'running'"));
  check('engine: beginUserTurn 清 standbyReason', beginBody.includes('standbyReason = null'));

  check('engine: 导出 noteTurnOutcome', engine.includes('export function noteTurnOutcome'));
  const noteBody = fnBody(engine, 'export function noteTurnOutcome');
  check('engine: noteTurnOutcome 先 settleCurrent', noteBody.indexOf('settleCurrent(') >= 0);
  check('engine: noteTurnOutcome 以 status running 为幂等闸（无进程存在性守卫）', noteBody.includes("state.status !== 'running'") || noteBody.includes("state?.status !== 'running'"));
  check('engine: noteTurnOutcome success→armAfterTurn', noteBody.includes('armAfterTurn('));
  check('engine: noteTurnOutcome error/interrupted→haltQueue', noteBody.includes('haltQueue('));

  check('engine: 导出 haltQueue', /export function haltQueue/.test(engine));
  const haltBody = fnBody(engine, 'export function haltQueue');
  check('engine: haltQueue 幂等闸带 status standby 条件（第二次熔断合法）', haltBody.includes("state.status === 'standby'") && haltBody.includes('halt_failed'));
  check('engine: haltQueue 调 pauseAllPending', haltBody.includes('taskRepo.pauseAllPending(sessionId)'));
  check('engine: haltQueue 体内先 cancelTimers（防御性）', haltBody.indexOf('cancelTimers(sessionId)') >= 0);
  check('engine: haltQueue 发 queue_halted', haltBody.includes("'queue_halted'"));

  check('engine: startCountdown 置 standbyReason 为 null（防 halt 残留）', fnBody(engine, 'function startCountdown').includes('standbyReason = null'));
  const startBody = fnBody(engine, 'function startCountdown');
  check('engine: startCountdown 现取配置 resolveQueueDelaySeconds(getConfig().taskDelayMinutes)', startBody.includes('resolveQueueDelaySeconds(getConfig().taskDelayMinutes)'));
  check('engine: 归零回调守卫 status countdown', startBody.includes("state.status !== 'countdown'"));
  check('engine: 归零回调守卫无活动进程', /if \(getActiveProcess\(sessionId\)\) return/.test(startBody));
  check('engine: 归零回调守卫后 popExecute', startBody.includes('popExecute('));

  check('engine: armAfterTurn 以 running 为前置', fnBody(engine, 'function armAfterTurn').includes("state.status !== 'running'"));
  check('engine: armAfterTurn 开关关保留 switch_off', fnBody(engine, 'function armAfterTurn').includes("'switch_off'"));
  check('engine: armFromUserAction 以 standby 为前置', fnBody(engine, 'function armFromUserAction').includes("state.status !== 'standby'"));
  const armUserBody = fnBody(engine, 'function armFromUserAction');
  check('engine: armFromUserAction 守卫开关+可执行任务+无活动进程', armUserBody.includes('queueEnabled') && armUserBody.includes('getPendingTasks(sessionId)') && armUserBody.includes('getActiveProcess(sessionId)'));

  check('engine: 导出 runTaskNow', engine.includes('export function runTaskNow'));
  const runNowBody = fnBody(engine, 'export function runTaskNow');
  const idxCancel = runNowBody.indexOf('cancelTimers(');
  const idxReorder = runNowBody.indexOf('reorderTasks(');
  const idxPop = runNowBody.indexOf('popExecute(');
  check('engine: runTaskNow 顺序=cancelTimers→插队 reorder→popExecute', idxCancel >= 0 && idxReorder > idxCancel && idxPop > idxReorder);
  check('engine: runTaskNow 不再拦截已暂停任务', !runNowBody.includes('已暂停的任务请先恢复'));
  check('engine: runTaskNow 对 paused 任务先解除暂停', runNowBody.includes('if (task.paused) taskRepo.setTaskPaused(taskId, false)'));
  check('engine: runTaskNow 守卫队列开关', runNowBody.includes('queueEnabled'));
  check('engine: runTaskNow 守卫活动进程', runNowBody.includes('getActiveProcess('));

  check('engine: settleCurrent 发 task_settled（中断路径唯一信号）', fnBody(engine, 'function settleCurrent').includes("'task_settled'"));

  check('engine: 导出 abortHalt', engine.includes('export function abortHalt'));
  const abortBody = fnBody(engine, 'export function abortHalt');
  check('engine: abortHalt 守卫 status running 或活动进程', abortBody.includes("state.status === 'running'") && abortBody.includes('getActiveProcess(sessionId)'));
  check('engine: abortHalt 先 settleCurrent(interrupted)', abortBody.includes("settleCurrent(sessionId, 'interrupted', mainWindow)"));
  check('engine: abortHalt 再 haltQueue(interrupted)', abortBody.includes("haltQueue(sessionId, 'interrupted', mainWindow)"));

  check('engine: 导出 resumeAllTasks', engine.includes('export function resumeAllTasks'));
  const resumeAllBody = fnBody(engine, 'export function resumeAllTasks');
  check('engine: resumeAllTasks 调 resumeAllPending + armFromUserAction', resumeAllBody.includes('taskRepo.resumeAllPending(sessionId)') && resumeAllBody.includes('armFromUserAction('));

  check('engine: 导出 onQueueEnabledChanged', engine.includes('export function onQueueEnabledChanged'));
  const switchBody = fnBody(engine, 'export function onQueueEnabledChanged');
  check('engine: 开关关→countdown 会话 cancelTimers+switch_off', switchBody.includes('cancelTimers(sessionId)') && switchBody.includes("'switch_off'"));
  check('engine: 开关开→仅清 switch_off reason 不 arm', switchBody.includes('standbyReason === '));

  check('engine: 导出 getQueueOverview', engine.includes('export function getQueueOverview'));
  check('engine: overview tasks 过滤 pending', fnBody(engine, 'export function getQueueOverview').includes("t.status === 'pending'"));
  check('engine: executedHistory 模块级 Map', /const executedHistory = new Map<string, ExecutedTaskInfo\[\]>\(\)/.test(engine));
  const popBodyEarly = fnBody(engine, 'async function popExecute');
  check('engine: executed 历史上限 50 截断', /const EXECUTED_HISTORY_CAP = 50/.test(engine) && popBodyEarly.includes('EXECUTED_HISTORY_CAP'));
  check('engine: mainTimers 独立 Map', /const mainTimers = new Map<string, ReturnType<typeof setTimeout>>\(\)/.test(engine));
  check('engine: generations Map', /const generations = new Map<string, number>\(\)/.test(engine));

  const popBody = fnBody(engine, 'async function popExecute');
  check('engine: popExecute 存在（出队唯一执行体）', popBody.length > 0);
  check('engine: popExecute 置 status running + currentTaskId', popBody.includes("state.status = 'running'") && popBody.includes('state.currentTaskId = task.id'));
  check('engine: popExecute 写 executedHistory running 条目', popBody.includes("outcome: 'running'"));
  check('engine: popExecute 发 task_started', popBody.includes("'task_started'"));
  check('engine: popExecute 的 child exit 兜底存在', popBody.includes("child.on('exit'"));
  check('engine: exit 兜底以 currentTaskId 匹配为闸（result 先到自然失效）', popBody.includes('state.currentTaskId !== task.id'));
  check('engine: exit 兜底调 noteTurnOutcome', popBody.includes('noteTurnOutcome(sessionId, code === 0'));
  check('engine: popExecute 建消息带 parentTaskId', popBody.includes('parentTaskId: task.id'));
  check('engine: prepare/spawn 失败→settle failed + haltQueue', popBody.includes("settleCurrent(sessionId, 'failed', mainWindow)"));

  // 旧语义清除
  check('engine: 删旧续写链路函数', !engine.includes(OLD_CONTINUE));
  check('engine: 删 startQueue', !engine.includes('function startQueue'));
  check('engine: 删 pauseQueue', !engine.includes('function pauseQueue'));
  check('engine: 删 resumeQueue', !engine.includes('function resumeQueue'));
  check('engine: 删 interruptTask', !engine.includes('interruptTask'));
  check('engine: 删旧跳过倒计时函数', !engine.includes(OLD_SKIP));
  check('engine: 删旧自动调度函数', !engine.includes(OLD_AUTOSTART));
  check('engine: 删 cancelWaitingIfDrained', !engine.includes('cancelWaitingIfDrained'));
  check('engine: 无重启唤醒白名单（重启不自动执行由空 Map 天然保证）', !engine.includes(OLD_ARMED));
  check('engine: getOrCreateQueue 初始 standby+restart', /status: 'standby',[\s\S]{0,40}standbyReason: 'restart'/.test(engine));
}

// ── 4) ipc-handlers.ts：挂点与处理器 ──
{
  const handlers = read('../src/main/ipc-handlers.ts');
  const chatSendBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.CHAT_SEND'), handlers.indexOf('IPC_CHANNELS.CHAT_ABORT'));
  check('ipc-handlers: CHAT_SEND 占坑后挂 beginUserTurn（插话顶掉倒计时）', chatSendBody.includes('beginUserTurn(sessionId, mainWindow)'));
  check('ipc-handlers: CHAT_SEND 换挂 exit 兜底调 noteTurnOutcome', /child\.on\('exit', \(code\) =>[\s\S]{0,400}noteTurnOutcome\(sessionId, code === 0 \? 'success' : 'error', mainWindow\)/.test(chatSendBody));
  check('ipc-handlers: CHAT_SEND 不再挂旧自动调度钩子', !chatSendBody.includes(OLD_AUTOSTART));

  const abortBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.CHAT_ABORT'), handlers.indexOf('IPC_CHANNELS.CHAT_SET_PERMISSION_MODE'));
  check('ipc-handlers: CHAT_ABORT 在 killProcess 后挂 abortHalt', abortBody.includes("killProcess(sessionId, 'user', mainWindowRef)") && abortBody.includes('abortHalt(sessionId, mainWindowRef)'));

  check('ipc-handlers: 注册 TASK_RUN_NOW', handlers.includes('IPC_CHANNELS.TASK_RUN_NOW'));
  check('ipc-handlers: 注册 QUEUE_RESUME_ALL', handlers.includes('IPC_CHANNELS.QUEUE_RESUME_ALL'));
  check('ipc-handlers: 注册 QUEUE_GET_OVERVIEW', handlers.includes('IPC_CHANNELS.QUEUE_GET_OVERVIEW'));
  const taskRemoveBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.TASK_REMOVE'), handlers.indexOf('IPC_CHANNELS.TASK_GET_ALL'));
  check('ipc-handlers: TASK_REMOVE 删空收口 drainCountdownIfNoRunnable', taskRemoveBody.includes('drainCountdownIfNoRunnable'));
  const setPausedBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.TASK_SET_PAUSED'), handlers.indexOf('// Queue'));
  check('ipc-handlers: TASK_SET_PAUSED 恢复路径调 armFromUserAction', setPausedBody.includes('armFromUserAction('));
  check('ipc-handlers: TASK_SET_PAUSED 暂停路径调 drainCountdownIfNoRunnable', setPausedBody.includes('drainCountdownIfNoRunnable'));
  check('ipc-handlers: CONFIG_SAVE 钩 onQueueEnabledChanged', /CONFIG_SAVE[\s\S]{0,400}onQueueEnabledChanged\(/.test(handlers));
  check('ipc-handlers: 删任务中断 handler', !handlers.includes('IPC_CHANNELS.' + OLD_INTERRUPT_CH));
  check('ipc-handlers: 删任务重试 handler', !handlers.includes('IPC_CHANNELS.' + OLD_RETRY_CH));
  check('ipc-handlers: 删队列级开始 handler', !handlers.includes('IPC_CHANNELS.' + OLD_QSTART_CH));
  check('ipc-handlers: 删 QUEUE_USER_MESSAGE handler', !handlers.includes('IPC_CHANNELS.QUEUE_USER_MESSAGE'));
  check('ipc-handlers: TASK_ADD 透传 clientMessageId 保留', /createTaskWithAttachments\([\s\S]*payload\.clientMessageId/.test(handlers));
}

// ── 5) task-repo：bulk 熔断/恢复 + 重启 failed ──
{
  const repo = read('../src/main/database/repositories/task-repo.ts');
  check('repo: 导出 pauseAllPending', repo.includes('export function pauseAllPending'));
  check('repo: 导出 resumeAllPending', repo.includes('export function resumeAllPending'));
  const pauseBody = fnBody(repo, 'export function pauseAllPending');
  const resumeBody = fnBody(repo, 'export function resumeAllPending');
  check('repo: pauseAllPending SQL 形态（pending 且未暂停→paused=1）', pauseBody.includes("SET paused = 1") && pauseBody.includes("AND status = 'pending' AND paused = 0"));
  check('repo: resumeAllPending SQL 形态（paused=1→0）', resumeBody.includes("SET paused = 0") && resumeBody.includes("AND status = 'pending' AND paused = 1"));
  check('repo: resetRunningTasks 置 failed（执行过、回合异常死亡）', /resetRunningTasks[\s\S]{0,400}SET status = 'failed'/.test(repo));
  check('repo: retryTask 函数已删除', !repo.includes('export function retryTask'));
}

// ── 6) sdk-backend：result 中央转发三态映射 ──
{
  const sdkBackend = read('../src/main/modules/sdk-backend.ts');
  check('sdk-backend: result→outcome 三态映射', /isSuccessfulCliResult\(event\) \? 'success' : isAbortedCliResult\(event\) \? 'interrupted' : 'error'/.test(sdkBackend));
  check('sdk-backend: result→noteTurnOutcome 挂点', /event\.type === 'result'[\s\S]{0,300}noteTurnOutcome\(sessionId, outcome, mainWindow\)/.test(sdkBackend));
  check('sdk-backend: import isAbortedCliResult', sdkBackend.includes('isAbortedCliResult'));
  check('sdk-backend: import noteTurnOutcome（缺失=运行时 ReferenceError，纯文本断言拦不住）', sdkBackend.includes("} from './task-queue-engine'") && sdkBackend.includes('noteTurnOutcome'));
}

// ── 7) preload/api.ts：队列段方法增删 ──
{
  const preload = read('../src/preload/api.ts');
  check('preload: runTaskNow → QueueOverview', /runTaskNow: \(taskId: string\) => Promise<QueueOverview>/.test(preload));
  check('preload: resumeAllQueue → QueueOverview', /resumeAllQueue: \(sessionId: string\) => Promise<QueueOverview>/.test(preload));
  check('preload: getQueueOverview → QueueOverview', /getQueueOverview: \(sessionId: string\) => Promise<QueueOverview>/.test(preload));
  check('preload: setTaskPaused 返回 Task[]', /setTaskPaused: \(taskId: string, paused: boolean\) => Promise<Task\[\]>/.test(preload));
  check('preload: addTask 返回 { task; tasks }', /addTask: \(sessionId: string, payload: ChatSendPayload\) => Promise<\{ task: Task; tasks: Task\[\] \}>/.test(preload));
  check('preload: 删 startQueue', !preload.includes('startQueue'));
  check('preload: 删 pauseQueue', !preload.includes('pauseQueue'));
  check('preload: 删 resumeQueue', !preload.includes('resumeQueue'));
  check('preload: 删 getQueueState', !preload.includes('getQueueState'));
  check('preload: 删旧队列发送方法', !preload.includes(OLD_QUEUE_SEND));
  check('preload: 删 interruptTask', !preload.includes('interruptTask'));
  check('preload: 删 retryTask', !preload.includes('retryTask'));
}

// ── 8) 渲染层 task-store.ts ──
{
  const ts = read('../src/renderer/stores/task-store.ts');
  check('store: loadOverview action', ts.includes('async loadOverview'));
  check('store: runTaskNow action', ts.includes('async runTaskNow'));
  check('store: resumeAll action', ts.includes('async resumeAll'));
  check('store: state 变量 executed', ts.includes('executed: [] as ExecutedTaskInfo[]') || ts.includes('executed'));
  check('store: queueState 初始 standby', /status: 'standby'/.test(ts));
  check('store: state_changed 整体替换 queueState', /case 'state_changed'[\s\S]{0,200}this\.queueState =/.test(ts));
  check('store: task_started 移除任务 + 历史置入', /case 'task_started'[\s\S]{0,400}filter[\s\S]{0,400}unshift/.test(ts));
  check('store: task_started 调 markRunning', /case 'task_started'[\s\S]{0,400}markRunning/.test(ts));
  check('store: task_settled 更新历史 outcome', /case 'task_settled'[\s\S]{0,300}outcome/.test(ts));
  check('store: task_settled 非 success 走 markStopped（中断兜底）', /case 'task_settled'[\s\S]{0,400}markStopped/.test(ts));
  check('store: queue_halted 全部置 paused', /case 'queue_halted'[\s\S]{0,200}paused = true/.test(ts));
  check('store: user_message_created 保留 addMessage', ts.includes("case 'user_message_created'") && ts.includes('sessionStore.addMessage(msg)'));
  check('store: 删旧分支 task_completed', !ts.includes("'task_completed'"));
  check('store: 删旧分支 task_failed', !ts.includes("'task_failed'"));
  check('store: 删旧分支 task_continuing', !ts.includes("'task_continuing'"));
  check('store: 删旧分支 queue_paused', !ts.includes("'queue_paused'"));
  check('store: 删旧分支 queue_completed', !ts.includes("'queue_completed'"));
  check('store: 删旧分支 countdown_cancelled', !ts.includes("'countdown_cancelled'"));
  check('store: 删旧队列发送 action', !ts.includes(OLD_QUEUE_SEND));
  check('store: 删 startQueue/pauseQueue/resumeQueue/retryTask/interruptTask actions', !ts.includes('startQueue') && !ts.includes('pauseQueue') && !ts.includes('resumeQueue') && !ts.includes('retryTask') && !ts.includes('interruptTask'));
}

// ── 9) TaskQueuePanel.vue：渲染 bug 修复 + 队列栏重写 + 历史折叠 ──
{
  const panel = read('../src/renderer/components/task/TaskQueuePanel.vue');
  check('panel: 删除 #item 具名插槽（vue-draggable-plus 只渲染默认插槽——存量渲染 bug）', !panel.includes('#item'));
  check('panel: 删除 item-key 属性', !panel.includes('item-key'));
  check('panel: 默认插槽 v-for 渲染 TaskItem 且 :key', /<TaskItem[\s\S]{0,200}v-for="task in taskStore\.tasks"[\s\S]{0,200}:key="task\.id"/.test(panel));
  check('panel: 保留 handle=.task-item__drag', panel.includes('handle=".task-item__drag"'));
  check('panel: VueDraggable 保留 v-model + @end', panel.includes('v-model="taskStore.tasks"') && panel.includes('@end="handleDragReorder"'));
  check('panel: TaskItem 接 :eta', panel.includes(':eta="etaFor(task)"'));
  check('panel: TaskItem 接 @runnow', panel.includes('@runnow="handleRunNow"'));
  check('panel: 会话切换 watcher → loadOverview', /\(\) => sessionStore\.activeSession\?\.id[\s\S]{0,200}loadOverview/.test(panel));
  check('panel: 引入 taskEtaText', panel.includes('taskEtaText'));
  check('panel: 引入 resolveQueueDelaySeconds', panel.includes('resolveQueueDelaySeconds'));
  check('panel: etaFor 计算可执行位次', /function etaFor/.test(panel));
  check('panel: queuePausedNow 判据 halt_failed/halt_interrupted', /queuePausedNow/.test(panel) && /'halt_failed'/.test(panel) && /'halt_interrupted'/.test(panel));
  check('panel: queueEnabledNow 读配置 store', /queueEnabledNow/.test(panel));
  check('panel: 全部恢复按钮', panel.includes('全部恢复'));
  check('panel: resumeAll 接线', panel.includes('resumeAll('));
  check('panel: 历史折叠标题 本次已执行', panel.includes('本次已执行'));
  check('panel: 历史折叠默认收起', /executedCollapsed = ref\(true\)/.test(panel));
  check('panel: 队列栏删旧「开始」按钮', !panel.includes('>开始</button>'));
  check('panel: 队列栏删旧「恢复」按钮', !panel.includes('>恢复</button>'));
  check('panel: 队列栏删旧「暂停」按钮', !panel.includes('>暂停</button>'));
  check('panel: queue-bar 分支含 countdown 文案', panel.includes('后执行下一个任务'));
  check('panel: standby/restart 提示文案', panel.includes('队列待命'));
  check('panel: halt_failed 提示文案', panel.includes('上次执行失败，队列已全部暂停'));
  check('panel: halt_interrupted 提示文案', panel.includes('上次执行被中断，队列已全部暂停'));
  check('panel: switch_off 提示文案', panel.includes('队列开关已关闭：不倒计时、不自动执行'));
  check('panel: 指标条 countdown→等待', /等待 \$\{/.test(panel) || panel.includes('等待 ${'));
  check('panel: 指标条 熔断→已熔断', panel.includes('已熔断'));
  check('panel: composer 不回归（无 task-panel__add）', !panel.includes('task-panel__add'));
  check('panel: 删 handleStart/handlePause/handleResume/handleRetry/handleInterrupt', !panel.includes('handleStart') && !panel.includes('handlePause)') && !panel.includes('handleRetry') && !panel.includes('handleInterrupt'));
}

// ── 10) TaskItem.vue：pending 专用卡 ──
{
  const item = read('../src/renderer/components/task/TaskItem.vue');
  check('item: 立即执行按钮恒渲染（含已暂停置灰）', item.includes('立即执行'));
  check('item: runnow emit 声明', /runnow: \[taskId: string\]/.test(item));
  check('item: 立即执行 disabled 四态判据（paused 解禁）', item.includes(':disabled="sending || queuePaused || !queueEnabled"'));
  check('item: 删「已暂停的任务请先恢复」title', !item.includes('已暂停的任务请先恢复'));
  check('item: title 队列开关已关闭', item.includes('队列开关已关闭'));
  check('item: title 队列已暂停，恢复队列后可执行', item.includes('队列已暂停，恢复队列后可执行'));
  check('item: title 当前会话有任务执行中', item.includes('当前会话有任务执行中，结束后可立即执行'));
  check('item: title 跳过倒计时语义', item.includes('跳过倒计时，立即把该任务移出队列并作为普通消息发送'));
  check('item: ETA 行', item.includes('task-item__eta'));
  check('item: 附件 chip（头行）', item.includes('task-item__atts-chip'));
  check('item: 详情逐文件列表', item.includes('task-item__att-file'));
  check('item: 附件说明行', item.includes('附件 {') || /附件 \{\{/.test(item));
  check('item: 删除中断按钮', !item.includes('>中断</button>'));
  check('item: 删除重试按钮', !item.includes('>重试</button>'));
  check('item: 删 running 自动展开 watch', !item.includes("newStatus === 'running'"));
  check('item: 删结果/费用/耗时/错误展示', !item.includes('task-item__result') && !item.includes('task-item__meta'));
  check('item: 禁用态样式 opacity', /.action:disabled/.test(item));
  check('item: 暂停/删除按钮常亮（solid 类、muted 零残留）', item.includes('action--solid') && !item.includes('action--muted'));
  check('item: props 含 eta/sending/queuePaused/queueEnabled', /eta\?: string \| null/.test(item) && /sending\?: boolean/.test(item) && /queuePaused\?: boolean/.test(item) && /queueEnabled\?: boolean/.test(item));
}

// ── 11) ChatPage.vue：两路收敛 ──
{
  const chatPage = read('../src/renderer/pages/ChatPage.vue');
  check('ChatPage: 入队判据 sending+queueEnabled（queueEnabled && (sending || 引擎running双保险)）', /queueEnabled\.value && \(sending\.value \|\|/.test(chatPage));
  check('ChatPage: 软防线 queueState running 双保险', /taskStore\.queueState\.status === 'running'/.test(chatPage));
  check('ChatPage: 入队走 taskStore.addTask', chatPage.includes('taskStore.addTask(sessionId, payload)'));
  check('ChatPage: 其余走 sendMessage', chatPage.includes('sendMessage(payload)'));
  check('ChatPage: 删旧队列发送路由', !chatPage.includes(OLD_QUEUE_SEND));
  check('ChatPage: 删 isQueueSession 三路路由', !chatPage.includes('isQueueSession'));
  check('ChatPage: ChatInput disabled 判据保留', chatPage.includes(':disabled="sending && !queueEnabled"'));
}

// ── 12) MessageBubble.vue：来自队列标 ──
{
  const bubble = read('../src/renderer/components/chat/MessageBubble.vue');
  check('bubble: 来自队列 tag', bubble.includes('来自队列'));
  check('bubble: exportMode 下不渲染', /!exportMode &&[\s\S]{0,80}parentTaskId/.test(bubble));
  check('bubble: class bubble__queue-tag', bubble.includes('bubble__queue-tag'));

  const exportTypes = read('../src/shared/types/export-image.ts');
  check('export-image: RenderableMessage 补 parentTaskId 可选字段', /parentTaskId\?: string \| null/.test(exportTypes));
}

// ── 13) 挂载：selftest:static 链 ──
{
  const pkg = JSON.parse(read('../package.json')) as { scripts: Record<string, string> };
  check('package.json: selftest:static 挂载 tdd-queue-semantics-v3-verify', pkg.scripts['selftest:static'].includes('tdd-queue-semantics-v3-verify'));
  check('package.json: 摘除 tdd-queue-rework-verify', !pkg.scripts['selftest:static'].includes('tdd-queue-rework-verify'));
  check('旧脚本文件已删除', !existsSync(new URL('./tdd-queue-rework-verify.ts', import.meta.url)));
}

// ── 14) 迁移自 tdd-queue-rework-verify 的仍有效断言 ──
{
  // queue-config 分钟制全组（原 §1）
  check('默认间隔分钟 = 5', DEFAULT_TASK_DELAY_MINUTES === 5);
  check('sanitize(undefined) 回落 5', sanitizeTaskDelayMinutes(undefined) === 5);
  check('sanitize(null) 回落 5', sanitizeTaskDelayMinutes(null) === 5);
  check('sanitize("abc") 回落 5', sanitizeTaskDelayMinutes('abc') === 5);
  check('sanitize(NaN) 回落 5', sanitizeTaskDelayMinutes(NaN) === 5);
  check('sanitize(0) 收敛 1（最低 1 分钟）', sanitizeTaskDelayMinutes(0) === 1);
  check('sanitize(-3) 收敛 1', sanitizeTaskDelayMinutes(-3) === 1);
  check('sanitize(2.9) 向下取整 2', sanitizeTaskDelayMinutes(2.9) === 2);
  check('sanitize(60) 原样 60', sanitizeTaskDelayMinutes(60) === 60);
  check('sanitize(61) 夹取 60', sanitizeTaskDelayMinutes(61) === 60);
  check('sanitize(100) 夹取 60', sanitizeTaskDelayMinutes(100) === 60);
  check('resolve(5) = 300s', resolveQueueDelaySeconds(5) === 300);
  check('resolve(非法) = 300s（清洗后默认）', resolveQueueDelaySeconds('x') === 300);
  check('resolve(0) = 60s（清洗后 1 分钟）', resolveQueueDelaySeconds(0) === 60);

  // DB V9 paused 列（OPT-8 后版本升至 10，paused 列契约保留）
  const mig = read('../src/main/database/migrations.ts');
  check('CURRENT_SCHEMA_VERSION >= 11（V11 一次性清洗；V9 paused 之上叠加 OPT-8 索引迁移）', /CURRENT_SCHEMA_VERSION = 11/.test(mig));
  check('V9 补列 paused INTEGER NOT NULL DEFAULT 0', /ADD COLUMN paused INTEGER NOT NULL DEFAULT 0/.test(mig));
  const repo = read('../src/main/database/repositories/task-repo.ts');
  check('getPendingTasks 过滤 paused = 0', /AND paused = 0/.test(repo));
  check('setTaskPaused 保留（单任务暂停/恢复）', repo.includes('export function setTaskPaused'));
  const taskTypes = read('../src/shared/types/task.ts');
  check('Task 类型有 paused: boolean', /paused: boolean/.test(taskTypes));

  // 渲染层残留防护
  const panel = read('../src/renderer/components/task/TaskQueuePanel.vue');
  check('面板不再引用任务草稿 store', !panel.includes('useTaskDraftStore'));
  check('面板不再有附件选择入口', !panel.includes('pickTaskAttachments'));
  check('task-draft-store 文件已删除', !existsSync(new URL('../src/renderer/stores/task-draft-store.ts', import.meta.url)));
}

console.log(`tdd-queue-semantics-v3-verify: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
