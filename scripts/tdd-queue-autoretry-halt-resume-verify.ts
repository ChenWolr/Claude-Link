// tdd-queue-autoretry-halt-resume-verify.ts
// X10（R09-F1，P3）契约钉：reasoning_replay 自动重试成功后熔断残留自愈。
//
// 根因（R09-F1，复核 CONFIRMED）：直发回合以 reasoning_replay 错误终态结束时，result 钩子先
// haltQueue('failed')（pauseAllPending 全暂停 + 熔断横幅）；2s 后韧性层自动重发一次，重试回合
// beginUserTurn 清横幅置 running；重试成功 → noteTurnOutcome('success') → armAfterTurn 的
// getPendingTasks 只数 paused=0（全为暂停 → 0）→ standby(null)。pauseAllPending 翻回的路径只有
// 用户动作 resumeAllTasks——净效果：队列静默停摆（全暂停 + 无横幅 + standby(null)），须手动
// 「全部恢复」。
//
// 修复语义（X10）：
//   1. haltQueue 记录 lastHaltReason（新增内部值 'reasoning-replay'，现有 failed/interrupted
//      按原值归入；standbyReason / queue_halted 对外仍呈 failed 语义——渲染层契约不变）；
//   2. 失败回合若将被韧性层自动重试（willAutoRetryReasoningReplay 同步守卫命中），熔断原因记
//      'reasoning-replay'；自动重试「实际发起」（resendUserText 成功返回）后置一次性标记；
//   3. 自动重试回合成功终态：lastHaltReason==='reasoning-replay' 且熔断后无人工队列操作
//      （manualInterventionSeqs 与熔断时快照一致）→ resumeAllPending 整批恢复 + arming 交回
//      armAfterTurn（恢复倒计时调度，无需手动「全部恢复」）；不满足条件仅消费记录，不恢复。
//
// 验证手法：结构契约（源码断言）+ 行为验证（Module._load 拦截 config-manager/task-repo 等，
// 驱动真实 task-queue-engine + reasoning-replay-auto-retry，复用 tdd-bugfix-n9 的 seam 手法）。
//
// followup（2026-10-07）：自愈恢复补发 queue_auto_resumed 事件（主进程内部 resumeAllPending
// 不经 IPC，渲染层 queue_halted 置的 paused=true 无翻转信号——任务行残留「已暂停」徽标、
// etaFor 无 ETA）。新增结构⑳㉑㉒（ipc.ts 联合 / 引擎发事件 / task-store 对称 case）与
// 行为⑫⑬⑭（自愈路径恰发一次经 queue:event、人工干预与其余场景零发送）。
//
// followup（2026-10-07，Rv3-3/Rv3-4）：①Rv3-3——自愈实际恢复分支补用户可见 system 提示
// （messageRepo.createMessage 落库 + CHAT_EVENT persisted_message 转发，人工干预跳过路径
// 不发）；②Rv3-4——noteTurnOutcome 失败分支的 interrupted 形态（流丢 result 合成中止收尾）
// 同样先过 willAutoRetryReasoningReplay 谓词，命中记 'reasoning-replay'（否则该形态熔断残留
// 无法经自动重试成功自愈）。结构⑧改形 + 新增结构㉓；行为新增⑮-⑳（场景 H 置于行为⑭全局
// 计数之后执行——H 会再发一条 queue_auto_resumed / persisted_message）。
//
// 运行：npx tsx scripts/tdd-queue-autoretry-halt-resume-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/task-queue-engine.ts'), 'utf8');
const retrySrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/reasoning-replay-auto-retry.ts'), 'utf8');
// followup（2026-10-07）：queue_auto_resumed 渲染层对称恢复的结构断言需要读渲染 store 与 IPC 契约源码。
const taskStoreSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/task-store.ts'), 'utf8');
const ipcSrc = fs.readFileSync(path.join(repoRoot, 'src/shared/types/ipc.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 截取 src 中 from 起到 endMarker（不含）的函数体片段。 */
function bodyBetween(src: string, from: string, endMarker: string): string {
  const at = src.indexOf(from);
  if (at < 0) return '';
  const end = src.indexOf(endMarker, at + from.length);
  return src.slice(at, end > at ? end : src.length);
}

// ── 一、结构契约：task-queue-engine.ts ──
console.log('\n=== 一、结构契约：task-queue-engine.ts ===');
scheck('结构① 引擎只读导入韧性层查询（willAutoRetryReasoningReplay + consumeAutoRetryDispatched，无反向依赖）',
  /import \{ willAutoRetryReasoningReplay, consumeAutoRetryDispatched \} from '\.\/reasoning-replay-auto-retry';/.test(engineSrc));
scheck('结构② haltQueue reason 类型含内部值 \'reasoning-replay\'（failed/interrupted 按原值归入）',
  /'failed' \| 'interrupted' \| 'reasoning-replay'/.test(engineSrc));
{
  const haltBody = bodyBetween(engineSrc, 'export function haltQueue', 'export function abortHalt');
  scheck('结构③ haltQueue 熔断分支记录 lastHaltReasons + 当时干预序号快照',
    haltBody.includes('lastHaltReasons.set(sessionId, reason)') && haltBody.includes('haltInterventionSeqs.set(sessionId,'));
  scheck('结构④ standbyReason 映射：reasoning-replay 归入 halt_failed（横幅/待命语义不变）',
    haltBody.includes("reason === 'interrupted' ? 'halt_interrupted' : 'halt_failed'"));
  scheck('结构⑤ queue_halted 载荷 reason 归一为 failed（渲染层契约不变）',
    haltBody.includes("reason === 'reasoning-replay' ? 'failed' : reason"));
  scheck('结构⑥ haltQueue 熔断分支仍 pauseAllPending（熔断语义本体不动）',
    haltBody.includes('taskRepo.pauseAllPending(sessionId)'));
}
{
  const noteBody = bodyBetween(engineSrc, 'export function noteTurnOutcome', 'export function runTaskNow');
  scheck('结构⑦ noteTurnOutcome 顶部一次性消费自动重试发起标记',
    noteBody.includes('const wasAutoRetryTurn = consumeAutoRetryDispatched(sessionId);'));
  // Rv3-4（2026-10-07）：失败分支改形——interrupted 形态同样先过谓词（谓词先行提取为 rrRetry，
  // 命中记 'reasoning-replay'；非 rr 的 interrupted 语义不变仍记 'interrupted'）。
  scheck('结构⑧ 失败分支经 willAutoRetryReasoningReplay 判定内部熔断原因（Rv3-4：interrupted 形态同样先过谓词）',
    noteBody.includes('const rrRetry = willAutoRetryReasoningReplay(sessionId);') &&
    noteBody.includes("rrRetry ? 'reasoning-replay' : outcome === 'interrupted' ? 'interrupted' : 'failed'"));
  // followup：自愈函数签名增收 mainWindow（沿 noteTurnOutcome 调用链传入，用于发 queue_auto_resumed）。
  const resumeCallIdx = noteBody.indexOf('if (wasAutoRetryTurn) maybeResumeAfterAutoRetry(sessionId, mainWindow);');
  const armIdx = noteBody.indexOf('armAfterTurn(sessionId, mainWindow);');
  scheck('结构⑨ 成功分支：自愈恢复先于 armAfterTurn（恢复后 pending 可数 → 正常起倒计时）',
    resumeCallIdx > -1 && armIdx > resumeCallIdx);
  const resumeFn = bodyBetween(engineSrc, 'function maybeResumeAfterAutoRetry', 'export function runTaskNow');
  scheck('结构⑩ 自愈函数：reasoning-replay 闸 + 人工干预序号比对 + resumeAllPending 整批恢复',
    resumeFn.includes("lastHaltReasons.get(sessionId) !== 'reasoning-replay'") &&
    resumeFn.includes('manualInterventionSeqs.get(sessionId)') &&
    resumeFn.includes('haltInterventionSeqs.get(sessionId)') &&
    resumeFn.includes('taskRepo.resumeAllPending(sessionId)'));
  scheck('结构⑪ 自愈函数不自起倒计时（arming 交回 armAfterTurn，不重复绕 armFromUserAction 干预计数）',
    !resumeFn.includes('armFromUserAction'));
}
{
  const bumpFns: Array<[string, string]> = [
    ['export function runTaskNow', 'export function resumeAllTasks'],
    ['export function resumeAllTasks', 'export function onQueueEnabledChanged'],
    ['export function armFromUserAction', 'export function runTaskNow'],
    ['export function drainCountdownIfNoRunnable', 'export function getQueueOverview'],
  ];
  for (const [from, end] of bumpFns) {
    scheck(`结构⑫ ${from.slice('export function '.length)} 入口递增人工干预计数`, (() => {
      const body = bodyBetween(engineSrc, from, end);
      return body.includes('noteManualQueueIntervention(');
    })());
  }
}
scheck('结构⑬ cleanupQueue 清理三张熔断/干预记录 Map（防跨会话复活）', (() => {
  const body = bodyBetween(engineSrc, 'export function cleanupQueue', '\n}');
  return body.includes('lastHaltReasons.delete(sessionId)') && body.includes('haltInterventionSeqs.delete(sessionId)') && body.includes('manualInterventionSeqs.delete(sessionId)');
})());
scheck('结构⑭ beginUserTurn 不清熔断记录（自动重发回合经它起步，记录须存活到终态自愈点）', (() => {
  const body = bodyBetween(engineSrc, 'export function beginUserTurn', 'function startCountdown');
  return !body.includes('lastHaltReasons');
})());
scheck('结构⑮ abortHalt / popExecute 的熔断调用不携带 \'reasoning-replay\'（中断/队列任务失败维持原语义，无自动恢复）', (() => {
  // 两者均为无嵌套顶层块的简单函数体：'\n}' 即函数自身收尾（不携其后 maybeResumeAfterAutoRetry
  // 的注释/函数体——那里合法持有内部值）。
  const abortBody = bodyBetween(engineSrc, 'export function abortHalt', '\n}');
  const popBody = bodyBetween(engineSrc, 'async function popExecute', '\n}');
  return abortBody.includes("haltQueue(sessionId, 'interrupted', mainWindow)") && !abortBody.includes("'reasoning-replay'") &&
    popBody.includes("haltQueue(sessionId, 'failed', mainWindow)") && !popBody.includes("'reasoning-replay'");
})());

// ── 二、结构契约：reasoning-replay-auto-retry.ts ──
console.log('\n=== 二、结构契约：reasoning-replay-auto-retry.ts ===');
{
  const predBody = bodyBetween(retrySrc, 'export function willAutoRetryReasoningReplay', 'export function maybeScheduleReasoningReplayRetry');
  scheck('结构⑯ 谓词导出 + 同步守卫逐条对齐（turnFlag/开关/载体/防重入闩/pending 判重）',
    predBody.includes('turnHasReasoningReplayError.has(sessionId)') &&
    predBody.includes('autoRetryReasoningReplay === false') &&
    predBody.includes('lastUserTextBySession.get(sessionId)') &&
    predBody.includes('retriedTextBySession.get(sessionId)') &&
    predBody.includes('pendingTimers.has(sessionId)'));
}
{
  const schedBody = bodyBetween(retrySrc, 'export function maybeScheduleReasoningReplayRetry', '/** 会话删除/清理时释放全部状态');
  const resendIdx = schedBody.indexOf('ctx.resendUserText(text);');
  const markIdx = schedBody.indexOf('autoRetryDispatched.add(sessionId);');
  scheck('结构⑰ 发起标记在 resendUserText 成功返回之后置位（放弃的调度不置位）',
    resendIdx > -1 && markIdx > resendIdx);
}
scheck('结构⑱ consumeAutoRetryDispatched 一次性消费（delete + return）', (() => {
  const body = bodyBetween(retrySrc, 'export function consumeAutoRetryDispatched', '\n}');
  return body.includes('autoRetryDispatched.has(sessionId)') && body.includes('autoRetryDispatched.delete(sessionId)');
})());
scheck('结构⑲ clearReasoningReplayState 清发起标记（会话删除防泄漏）', (() => {
  const body = bodyBetween(retrySrc, 'export function clearReasoningReplayState', '\n}');
  return body.includes('autoRetryDispatched.delete(sessionId)');
})());

// ── 二·五、结构契约：queue_auto_resumed（X10 followup：自愈后任务行残留「已暂停」）──
// 主进程内部 resumeAllPending 恢复任务不经 IPC；渲染层 queue_halted 已把本地任务全置
// paused=true，而 state_changed / countdown_started 均不携带 tasks——净效果：自动恢复后面板
// 任务行持续「已暂停」徽标且 etaFor 只数未暂停任务导致无 ETA，直至会话切换 loadOverview。
// 修复契约：自愈路径补发 queue_auto_resumed（经 QUEUE_EVENT 通道），渲染层 handleQueueEvent
// 对称置 paused=false；人工干预跳过路径不发。
console.log('\n=== 二·五、结构契约：queue_auto_resumed（followup） ===');
scheck('结构⑳ ipc.ts QueueEventType 联合含 \'queue_auto_resumed\'', (() => {
  const union = bodyBetween(ipcSrc, 'export type QueueEventType', ';');
  return union.includes("'queue_auto_resumed'");
})());
{
  const resumeFnX = bodyBetween(engineSrc, 'function maybeResumeAfterAutoRetry', 'export function runTaskNow');
  const resumeIdx = resumeFnX.indexOf('taskRepo.resumeAllPending(sessionId);');
  const emitIdx = resumeFnX.indexOf("emitQueueEvent(mainWindow, sessionId, 'queue_auto_resumed')");
  scheck('结构㉑ 自愈函数收 mainWindow 入参，resumeAllPending 成功后发 queue_auto_resumed',
    /function maybeResumeAfterAutoRetry\(sessionId: string, mainWindow: BrowserWindow\)/.test(engineSrc) &&
    resumeIdx > -1 && emitIdx > resumeIdx);
}
scheck('结构㉒ task-store.ts handleQueueEvent 含对称 case（queue_auto_resumed → isActive 守卫后全任务 paused=false）', (() => {
  const handler = bodyBetween(taskStoreSrc, 'handleQueueEvent(payload: QueueEventPayload)', '\n  },');
  const caseIdx = handler.indexOf("case 'queue_auto_resumed':");
  const guardIdx = handler.indexOf('if (!isActive) break;', caseIdx);
  const resetIdx = handler.indexOf('t.paused = false;', caseIdx);
  return caseIdx > -1 && guardIdx > -1 && resetIdx > guardIdx;
})());

// ── 二·六、结构契约：自愈恢复的用户可见系统提示（Rv3-3，2026-10-07 review followup）──
// 自动恢复对用户不可见（熔断前手动暂停的任务被静默翻回执行序列）——契约：实际恢复分支
// （人工干预比对通过之后）照 killProcess interaction_cancelled 落库形态，经
// messageRepo.createMessage 落一条 system 提示并经 CHAT_EVENT persisted_message 转发；
// 人工干预跳过路径（early return）不发。
console.log('\n=== 二·六、结构契约：自愈恢复系统提示（Rv3-3 followup） ===');
{
  const resumeBodyRv3 = bodyBetween(engineSrc, 'function maybeResumeAfterAutoRetry', 'export function noteTurnOutcome');
  const earlyReturnIdx = resumeBodyRv3.indexOf('if ((manualInterventionSeqs.get(sessionId) ?? 0) !== haltSeq)');
  const createIdx = resumeBodyRv3.indexOf('messageRepo.createMessage({');
  const sendIdx = resumeBodyRv3.indexOf('IPC_CHANNELS.CHAT_EVENT');
  const persistedIdx = resumeBodyRv3.indexOf("{ type: 'persisted_message', message: persisted }");
  scheck('结构㉓ 自愈实际恢复分支落用户可见系统提示（createMessage 落库 + CHAT_EVENT persisted_message 转发，且位于人工干预 early-return 之后）',
    earlyReturnIdx > -1 && createIdx > earlyReturnIdx && sendIdx > createIdx && persistedIdx > sendIdx);
}

// ── 三、行为验证：真实引擎 + 真实韧性层（seam 拦截 repo/config/chat-backend）──
console.log('\n=== 三、行为验证（真实引擎 + 真实韧性层） ===');
const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-x10-hr-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

const configStub: Record<string, unknown> = {
  queueEnabled: true,
  taskDelayMinutes: 5,
  autoRetryReasoningReplay: true,
};
const pauseBy: Record<string, number> = {};
const resumeBy: Record<string, number> = {};
const pendingCounts: Record<string, number> = {};
const queueEvents: Array<{ sessionId: string; type: string; ch?: string; data?: Record<string, unknown> }> = [];
// Rv3-3（2026-10-07）：persisted_message（CHAT_EVENT 形态）事件与 createMessage 入参的记录载体
// （行为⑮⑯⑳断言用）。
const persistedNotices: Array<{ sessionId: string; message: unknown }> = [];
const createdMessages: Array<{ sessionId: string; role: string; content: string }> = [];
const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]config-manager$/.test(req)) return { getConfig: () => configStub };
  if (/[\\/]task-repo$/.test(req)) {
    return {
      pauseAllPending: (sessionId: string) => { pauseBy[sessionId] = (pauseBy[sessionId] ?? 0) + 1; },
      resumeAllPending: (sessionId: string) => { resumeBy[sessionId] = (resumeBy[sessionId] ?? 0) + 1; },
      getPendingTasks: (sessionId: string) => Array.from({ length: pendingCounts[sessionId] ?? 0 }),
      getTasksBySession: () => [],
      getTask: () => null,
      updateTaskError: () => undefined,
      updateTaskResult: () => undefined,
      updateTaskStatus: () => undefined,
      setTaskPaused: () => undefined,
      setTaskClientMessageId: () => undefined,
      reorderTasks: () => undefined,
      listTasksBySession: () => [],
    };
  }
  if (/[\\/]session-repo$/.test(req)) return { getSession: () => ({ id: 's' }), updateSessionStatus: () => undefined };
  // Rv3-3：createMessage 捕获入参（role/content 断言用），返回值保持 { id: 'm' }。
  if (/[\\/]message-repo$/.test(req)) {
    return {
      createMessage: (input: { sessionId: string; role: string; content: string }) => {
        createdMessages.push(input);
        return { id: 'm' };
      },
    };
  }
  if (/[\\/]chat-backend$/.test(req)) {
    return {
      spawnForTask: () => { throw new Error('not used'); },
      resolveCliSessionId: () => null,
      getActiveProcess: () => undefined,
      getKnownTurnOutcome: () => null,
      isChatSendLocked: () => false,
      hasPendingFirstPrompt: () => false,
    };
  }
  if (/[\\/]attachment-prompt-builder$/.test(req)) return { prepareAttachmentPrompt: async () => ({ attachmentIds: [], additionalDirectories: [] }) };
  if (/[\\/]attachment-service$/.test(req)) return { resolveAttachmentRecords: () => ({ records: [], paths: [] }) };
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

(async () => {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const engine = require('../src/main/modules/task-queue-engine');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const retry = require('../src/main/modules/reasoning-replay-auto-retry');
  const win = {
    webContents: {
      // Rv3-3（2026-10-07）：persisted_message（CHAT_EVENT 形态）的 type 在 payload.event.type——
      // 与 QUEUE_EVENT 顶层 type 两种形态都记录（type 判定改为 ?? 合取，不影响既有 queueEvents
      // 断言的 type 过滤）；persisted 事件另入 persistedNotices 供 Rv3-3 行为断言。
      send: (ch: string, payload?: {
        sessionId?: string;
        type?: string;
        data?: Record<string, unknown>;
        event?: { type?: string; message?: unknown };
      }) => {
        const t = payload?.type ?? payload?.event?.type;
        if (t) queueEvents.push({ sessionId: payload?.sessionId ?? '', type: t, ch, data: payload?.data });
        if (payload?.event?.type === 'persisted_message') {
          persistedNotices.push({ sessionId: payload?.sessionId ?? '', message: payload.event.message });
        }
      },
    },
  } as never;

  /** 构造一个「将被自动重试的 reasoning_replay 失败直发回合」并走到熔断。 */
  function rrFailHalt(sessionId: string, text: string): void {
    retry._testonlyInjectTurnError(sessionId);
    retry.recordOutgoingUserText(sessionId, text);
    engine.beginUserTurn(sessionId, win);
    engine.noteTurnOutcome(sessionId, 'error', win);
  }
  /** 调度真实自动重试（spy ctx，不真的起 query）。 */
  function scheduleRetry(sessionId: string, resent: string[]): void {
    retry.maybeScheduleReasoningReplayRetry({
      sessionId,
      mainWindow: win,
      hasRunningQuery: () => false,
      isSessionAlive: () => true,
      forwardSystemNotice: () => undefined,
      resendUserText: (text: string) => { resent.push(text); },
    });
  }

  // 场景 A（主链路）：失败熔断 → 自动重试真实发起 → 重试成功 → 自愈恢复 + 倒计时调度。
  const sessA = 'sess-x10-a';
  const resentA: string[] = [];
  rrFailHalt(sessA, '帮我查天气A');
  check('行为① rr 失败照常熔断（pauseAllPending 被调）', (pauseBy[sessA] ?? 0) === 1, `pause=${pauseBy[sessA] ?? 0}`);
  check('行为② 熔断待命 halt_failed（横幅语义不变）',
    engine.getQueueOverview(sessA).state.standbyReason === 'halt_failed');
  check('行为③ queue_halted 载荷 reason 归一为 failed（渲染层契约不变）', (() => {
    const ev = queueEvents.find((e) => e.sessionId === sessA && e.type === 'queue_halted');
    return Boolean(ev) && (ev?.data?.reason as string) === 'failed';
  })(), JSON.stringify(queueEvents.filter((e) => e.type === 'queue_halted')));
  scheduleRetry(sessA, resentA);
  await waitFor('自动重试发起（sessA）', () => resentA.length > 0);
  check('行为④ ~2s 后同文本自动重试真实发起（发起标记置位载体）', resentA[0] === '帮我查天气A', JSON.stringify(resentA));
  pendingCounts[sessA] = 1; // 自愈恢复后 armAfterTurn 须看到可执行任务 → 起倒计时
  engine.beginUserTurn(sessA, win); // 重发回合起步（清横幅置 running——对应 resendUserText 内挂点）
  engine.noteTurnOutcome(sessA, 'success', win); // 重试成功 → 自愈点
  check('行为⑤ 自动重试成功后熔断残留自愈（resumeAllPending 被调，无需手动「全部恢复」）',
    (resumeBy[sessA] ?? 0) === 1, `resume=${resumeBy[sessA] ?? 0}`);
  const stA = engine.getQueueOverview(sessA).state;
  check('行为⑥ 恢复倒计时调度（countdown(300)，任务恢复串行执行）',
    stA.status === 'countdown' && stA.countdownRemaining === 300, `status=${stA.status} remaining=${stA.countdownRemaining}`);

  // 场景 B（人工干预）：熔断 → 重试发起 → 期间人工恢复过任务（armFromUserAction 入口计数）→ 成功不自动恢复。
  const sessB = 'sess-x10-b';
  const resentB: string[] = [];
  rrFailHalt(sessB, '帮我查天气B');
  scheduleRetry(sessB, resentB);
  await waitFor('自动重试发起（sessB）', () => resentB.length > 0);
  pendingCounts[sessB] = 1;
  engine.beginUserTurn(sessB, win);
  engine.armFromUserAction(sessB, win); // 模拟 TASK_SET_PAUSED 恢复路径的人工干预
  engine.noteTurnOutcome(sessB, 'success', win);
  check('行为⑦ 人工队列操作后不自动恢复（用户决断优先）', (resumeBy[sessB] ?? 0) === 0, `resume=${resumeBy[sessB] ?? 0}`);

  // 场景 C（重试再失败）：熔断 → 重试发起 → 重试回合仍失败 → 回归普通熔断，不自动恢复。
  const sessC = 'sess-x10-c';
  const resentC: string[] = [];
  rrFailHalt(sessC, '帮我查天气C');
  scheduleRetry(sessC, resentC);
  await waitFor('自动重试发起（sessC）', () => resentC.length > 0);
  engine.beginUserTurn(sessC, win);
  engine.noteTurnOutcome(sessC, 'error', win);
  check('行为⑧ 重试回合再失败不自动恢复 + 再次熔断（防重入闩已占，回归 failed 语义）',
    (resumeBy[sessC] ?? 0) === 0 && (pauseBy[sessC] ?? 0) === 2 &&
    engine.getQueueOverview(sessC).state.standbyReason === 'halt_failed',
    `resume=${resumeBy[sessC] ?? 0} pause=${pauseBy[sessC] ?? 0}`);

  // 场景 D（无发起标记）：熔断标记为 reasoning-replay 但重试从未发起 → 后续普通成功不误恢复。
  const sessD = 'sess-x10-d';
  rrFailHalt(sessD, '帮我查天气D');
  pendingCounts[sessD] = 1;
  engine.beginUserTurn(sessD, win); // 不调度重试（模拟发起被二次守卫拦截/放弃）
  engine.noteTurnOutcome(sessD, 'success', win);
  check('行为⑨ 自动重试未实际发起时，后续回合成功不误恢复（二道闸）', (resumeBy[sessD] ?? 0) === 0, `resume=${resumeBy[sessD] ?? 0}`);

  // 场景 E（非 rr 失败）：普通错误熔断 → 成功后不自动恢复（人工熔断语义不受影响）。
  const sessE = 'sess-x10-e';
  engine.beginUserTurn(sessE, win);
  engine.noteTurnOutcome(sessE, 'error', win);
  pendingCounts[sessE] = 1;
  engine.beginUserTurn(sessE, win);
  engine.noteTurnOutcome(sessE, 'success', win);
  check('行为⑩ 非 rr 失败的熔断不自动恢复（lastHaltReason 不匹配）', (resumeBy[sessE] ?? 0) === 0, `resume=${resumeBy[sessE] ?? 0}`);

  // 场景 F（开关关）：autoRetryReasoningReplay=false（b4c8899 开关）→ 失败按 failed 熔断、成功不恢复（零变化）。
  const sessF = 'sess-x10-f';
  configStub.autoRetryReasoningReplay = false;
  rrFailHalt(sessF, '帮我查天气F');
  configStub.autoRetryReasoningReplay = true;
  pendingCounts[sessF] = 1;
  engine.beginUserTurn(sessF, win);
  engine.noteTurnOutcome(sessF, 'success', win);
  check('行为⑪ 自动重试开关关闭时零变化（不标记、不恢复）', (resumeBy[sessF] ?? 0) === 0, `resume=${resumeBy[sessF] ?? 0}`);

  // 场景 G（followup 汇总）：queue_auto_resumed 只在自愈路径发出（经 queue:event 通道）；
  // 人工干预跳过路径与其余全部场景（重试再失败/未发起/非 rr/开关关）零发送。
  const resumedA = queueEvents.filter((e) => e.type === 'queue_auto_resumed' && e.sessionId === sessA);
  check('行为⑫ 自愈路径发出 queue_auto_resumed（sessA 恰一次，经 queue:event 通道）',
    resumedA.length === 1 && resumedA[0].ch === 'queue:event',
    JSON.stringify(queueEvents.filter((e) => e.type === 'queue_auto_resumed')));
  check('行为⑬ 人工干预跳过路径不发 queue_auto_resumed（sessB 零次）',
    queueEvents.filter((e) => e.type === 'queue_auto_resumed' && e.sessionId === sessB).length === 0);
  check('行为⑭ 全运行 queue_auto_resumed 总次数恰为 1（其余场景零发送；Rv3-4 场景 H 在本断言之后执行）',
    queueEvents.filter((e) => e.type === 'queue_auto_resumed').length === 1,
    JSON.stringify(queueEvents.filter((e) => e.type === 'queue_auto_resumed')));

  // Rv3-3（2026-10-07 review followup）：自愈恢复须对用户可见——实际恢复分支恰发一条
  // persisted_message（role system、content 含固定文案）；人工干预跳过路径（sessB）零发送。
  const noticeA = persistedNotices.filter((n) => n.sessionId === sessA);
  const createdA = createdMessages.filter((m) => m.sessionId === sessA);
  check('行为⑮ 自愈路径恰发一条用户可见系统提示（sessA persisted_message ×1，role system + 文案含「已自动重试成功」）',
    noticeA.length === 1 && createdA.length === 1 &&
    createdA[0].role === 'system' && createdA[0].content.includes('已自动重试成功'),
    JSON.stringify({ noticeA: noticeA.length, createdA }));
  check('行为⑯ 人工干预跳过路径零发送（sessB persisted_message 与 createMessage 落库均为 0）',
    persistedNotices.filter((n) => n.sessionId === sessB).length === 0 &&
    createdMessages.filter((m) => m.sessionId === sessB).length === 0);

  // 场景 H（Rv3-4，2026-10-07 review followup）：流丢 result 的 interrupted 形态收尾（sdk-backend
  // 合成 aborted 后调 noteTurnOutcome('interrupted')，钩子先于重试调度点、rr 旗标仍在位）——
  // 谓词同样命中 → 熔断记 'reasoning-replay'（对外归一 failed），自动重试成功后熔断残留可自愈。
  // 置于行为⑭全局计数之后执行（H 会再发一条 queue_auto_resumed / persisted_message）。
  const sessH = 'sess-x10-h';
  const resentH: string[] = [];
  retry._testonlyInjectTurnError(sessH);
  retry.recordOutgoingUserText(sessH, '帮我查天气H');
  engine.beginUserTurn(sessH, win);
  engine.noteTurnOutcome(sessH, 'interrupted', win); // interrupted 形态（非 'error'）
  check('行为⑰ interrupted 形态 rr 命中时照常熔断（pauseAllPending 被调，待命仍 halt_failed）',
    engine.getQueueOverview(sessH).state.standbyReason === 'halt_failed' && (pauseBy[sessH] ?? 0) === 1,
    `reason=${engine.getQueueOverview(sessH).state.standbyReason} pause=${pauseBy[sessH] ?? 0}`);
  check('行为⑱ interrupted 形态 rr 命中时 queue_halted 载荷 reason 归一为 failed（渲染层契约不变）', (() => {
    const ev = queueEvents.find((e) => e.sessionId === sessH && e.type === 'queue_halted');
    return Boolean(ev) && (ev?.data?.reason as string) === 'failed';
  })(), JSON.stringify(queueEvents.filter((e) => e.sessionId === sessH && e.type === 'queue_halted')));
  scheduleRetry(sessH, resentH);
  await waitFor('自动重试发起（sessH）', () => resentH.length > 0);
  pendingCounts[sessH] = 1;
  engine.beginUserTurn(sessH, win);
  engine.noteTurnOutcome(sessH, 'success', win); // 重试成功 → 自愈点（interrupted 形态熔断残留）
  check('行为⑲ interrupted 形态熔断经自动重试成功自愈（resumeAllPending 被调 + queue_auto_resumed 发出）',
    (resumeBy[sessH] ?? 0) === 1 &&
    queueEvents.some((e) => e.sessionId === sessH && e.type === 'queue_auto_resumed'),
    `resume=${resumeBy[sessH] ?? 0}`);
  check('行为⑳ 终局计数：全运行 queue_auto_resumed 恰 2 次（sessA+sessH）、persisted_message 恰 2 条',
    queueEvents.filter((e) => e.type === 'queue_auto_resumed').length === 2 &&
    persistedNotices.length === 2,
    JSON.stringify({
      autoResumed: queueEvents.filter((e) => e.type === 'queue_auto_resumed').length,
      persisted: persistedNotices.length,
    }));

  assert.ok(pass + fail > 0, '至少应执行一条行为断言');
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(sfail + fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
