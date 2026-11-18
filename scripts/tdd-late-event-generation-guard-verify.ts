// tdd-late-event-generation-guard-verify.ts
// A1 迟到事件代际守卫伞 契约脚本（批次 2026-11-15-eight-issues-batch；用例 03-test-cases-main §1：A1-01~08 + A1-S1~S3）。
//
// 契约（00-behavior-specs 域 A A1）：
//  1. 旧回合迟到 result 不触发 noteTurnOutcome/haltQueue、knownOutcome 写入、完成通知、命名重试调度。
//  2. 旧回合迟到 api_retry / 重试相关 stream_event 不改写当前回合 apiRetryStates 状态卡与终态闩。
//  3. 守卫判据=回合代际；消息透传与落库不受门（维持既有行为）。
//  4. 接管/新 spawn 时 entry 代际必须递增（createEntry 现状满足，本脚本钉单调递增防回归）。
//  5. 新回合正常 result → 队列记账/通知/命名/重试状态卡行为完全不变（回归红线）。
//  6. 会话删除后迟到事件由 isSessionActive 既有守卫兜底，与代际守卫叠加不冲突。
//
// 实现锚点（01-impl-details §A1）：A1-a forwardEvent result 两块包代际门（不改字面）；
// A1-b api_retry 块顶 isCurrentEntry 门；A1-c assistant/stream_event 两处写态门。
//
// 驱动：seam ②（真实 sdk-backend + 真实 task-queue-engine）+ 闸控/脚本型 fake query。
// 夹具：CLAUDE_LINK_TEST_USERDATA=临时目录；task-repo 桩计 pauseAllPendingCalls；
// message-repo 桩；session-completion-notifier / topic-analyzer 经 _load 拦截为计数桩；
// push-bus initPushBus + setWebPushSink 捕获 chat:event / queue:event。
//
// 【红面申报（实施前实测，证据见 a1-impl-report）】本批 A1 针对的「接管后旧流迟到 result 直达
// result 钩子」链路，在当前实现下已被 runQuery for-await 循环顶既有守卫（sdk-backend.ts:3894
// `if (!isCurrentEntry(sessionId, entry)) break;`，fcc0dd2 2026-07-01 即存在）整事件丢弃：探针实测
// 接管后旧流 yield 的迟到 result 未到达 forwardEvent（透传/落库/五副作用全零）。因此行为用例
// A1-01~08 对「当前实现」已天然绿（契约被循环顶 break 满足），红面由 A1-S2/S3 结构钉承载
//（门文本不存在→红）；A1-a/b/c 三门为纵深防御 + 口径对齐（防后续 await 插入撕开窗口），实现后全绿。
//
// 运行：npx tsx scripts/tdd-late-event-generation-guard-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 0. 结构契约（A1-S1 / A1-S2 / A1-S3 + 契约4 createEntry 单调钉）────────────
const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 截取 source 中 signature 起点函数体（到下一个顶层 function/export）。 */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  const nextExport = source.indexOf('\nexport ', start + 1);
  const candidates = [next, nextExport].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

const feBody = fnBody(backend, 'function forwardEvent(');
const ceBody = fnBody(backend, 'function createEntry(');
const iceBody = fnBody(backend, 'function isCurrentEntry(');
const spawnChatBody = fnBody(backend, 'export function spawnForChat(');
const spawnTaskBody = fnBody(backend, 'export function spawnForTask(');
const eteBody = fnBody(backend, 'export function emitTurnEnded(');

console.log('=== A1-S1 接管点与无新回合新 spawn 点均触发 entry 代际递增（createEntry 单源） ===');
scheck('S1-1 createEntry 以 nextQueryInstance.value++ 产出代际（契约4 单调源）',
  ceBody.includes('queryInstance: nextQueryInstance.value++'),
  'createEntry 缺单调递增字面');
scheck('S1-2 spawnForChat 强制接管（forceKill）之后经 createEntry 建新 entry（接管点递增）',
  spawnChatBody.includes('blocking.forceKill();') &&
  spawnChatBody.indexOf('blocking.forceKill();') < spawnChatBody.indexOf('createEntry()'),
  '接管点未走 createEntry');
scheck('S1-3 spawnForTask（无新回合的新 spawn 点）同样经 createEntry（递增不得只在接管一处）',
  spawnTaskBody.includes('createEntry()'),
  'spawnForTask 未走 createEntry');
scheck('S1-4 isCurrentEntry 口径未变（entries 同一性 + 非 aborting）',
  iceBody.includes("return entries.get(sessionId) === entry && entry.state !== 'aborting';"),
  'isCurrentEntry 判据漂移');

console.log('=== A1-S2 result 钩子会话级副作用全部位于同一代际门后（无旁路） ===');
const gateCalcIdx = feBody.indexOf('const resultGenerationStale');
scheck('S2-1 forwardEvent 内计算 resultGenerationStale（事件 result + queryInstance 数值 + 当前 entry 判空/代际不等）',
  gateCalcIdx > -1 &&
  feBody.includes("event.type === 'result'") &&
  feBody.includes("typeof queryInstance === 'number'") &&
  feBody.includes('currentEntryAtHook == null') &&
  feBody.includes('currentEntryAtHook.queryInstance !== queryInstance'),
  '缺代际门判据计算');
scheck('S2-2 完成通知块受门（isSuccessfulCliResult && !resultGenerationStale）',
  /event\.type === 'result' && isSuccessfulCliResult\(event\) && !resultGenerationStale/.test(feBody),
  'notifySessionCompleted 块未受门');
scheck('S2-3 队列钩子块受门（event.type === result && !resultGenerationStale）',
  /if \(event\.type === 'result' && !resultGenerationStale\) \{/.test(feBody),
  'noteTurnOutcome 钩子块未受门');
scheck('S2-4 四副作用调用点全在门计算之后（notify < naming < hookEntry < noteTurnOutcome）',
  gateCalcIdx > -1 &&
  [feBody.indexOf('notifySessionCompleted(mainWindow, sessionId);'),
    feBody.indexOf('maybeRetrySessionNaming(sessionId);'),
    feBody.indexOf('if (hookEntry && !hookEntry.knownOutcome) hookEntry.knownOutcome = outcome;'),
    feBody.indexOf('noteTurnOutcome(sessionId, outcome, mainWindow);'),
  ].every((i) => i > gateCalcIdx),
  '存在门旁路的副作用调用点');
scheck('S2-5 emitTurnEnded 调用留在门外且字面不变（内部自带幂等+代际门）',
  feBody.includes('emitTurnEnded(sessionId, outcome, queryInstance ?? entries.get(sessionId)?.queryInstance, event.duration_ms);') &&
  feBody.indexOf('emitTurnEnded(sessionId, outcome') > feBody.indexOf('noteTurnOutcome(sessionId, outcome, mainWindow);'),
  'emitTurnEnded 位置/字面漂移');
scheck('S2-6 两份既有字面钉存活：hookEntry.knownOutcome 置位行 + noteTurnOutcome 调用行逐字不动',
  feBody.includes('if (hookEntry && !hookEntry.knownOutcome) hookEntry.knownOutcome = outcome;') &&
  feBody.includes('noteTurnOutcome(sessionId, outcome, mainWindow);') &&
  feBody.includes("isSuccessfulCliResult(event) ? 'success' : isAbortedCliResult(event) ? 'interrupted' : 'error'"),
  '字面钉被破坏（tdd-bugfix-hb12/tdd-turn-projection 同步面）');
scheck('S2-7 门只作用于会话级副作用：门计算位于透传/落库之后（push 与 persistCliEvent 先于门）',
  gateCalcIdx > -1 &&
  feBody.indexOf('pushToMainWindow(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });') < gateCalcIdx &&
  feBody.indexOf('persistCliEvent(sessionId, event);') < gateCalcIdx,
  '门越界盖住透传/落库（A1-04 结构面）');
scheck('S2-8 口径一致参照：emitTurnEnded 既有代际守卫字面仍在（snap.generation !== generation）',
  eteBody.includes('if (typeof generation === \'number\' && snap.generation !== generation) return;'),
  'turn_ended 既有守卫漂移');

console.log('=== A1-S3 api_retry/stream_event 写态点过同口径代际门 ===');
const apiRetryStart = backend.indexOf("if (infoSubtype === 'api_retry') {");
const apiRetryEnd = backend.indexOf("if (subtype === 'permission_denied'", apiRetryStart);
const apiRetryBody = apiRetryStart > -1 && apiRetryEnd > apiRetryStart ? backend.slice(apiRetryStart, apiRetryEnd) : '';
const gateTopIdx = apiRetryBody.indexOf('if (!isCurrentEntry(sessionId, entry)) {');
scheck('S3-1 api_retry 块顶 isCurrentEntry 门先于 recordApiRetry 写态',
  gateTopIdx > -1 && gateTopIdx < apiRetryBody.indexOf('recordApiRetry('),
  'api_retry 写态门缺位或次序错误');
scheck('S3-2 api_retry 门内整体丢弃（stale warn + continue，不写态不转发不快败）',
  apiRetryBody.includes('stale_api_retry_dropped') &&
  gateTopIdx > -1 &&
  apiRetryBody.slice(gateTopIdx, apiRetryBody.indexOf('recordApiRetry(')).includes('continue;'),
  '门内缺丢弃语义');
const assistantBody = (() => {
  const a = backend.indexOf("if (type === 'assistant') {");
  const b = backend.indexOf("if (type === 'user') {", a);
  return a > -1 && b > a ? backend.slice(a, b) : '';
})();
scheck('S3-3 assistant 分支 finishApiRetryExhausted/Recovery 两处写入均过 isCurrentEntry 门',
  /if \(isCurrentEntry\(sessionId, entry\)\) finishApiRetryExhausted\(sessionId, mainWindow, entry\.queryInstance\);/.test(assistantBody) &&
  /if \(isCurrentEntry\(sessionId, entry\)\) finishApiRetryRecovery\(sessionId, mainWindow, entry\.queryInstance\);/.test(assistantBody),
  'assistant 写态门缺位');
scheck('S3-4 assistant 事件转发/落库行不受门（convertAssistantMessage + forwardEvent 原样）',
  assistantBody.includes('const cliEvent = convertAssistantMessage(sdkMsg);') &&
  assistantBody.includes('forwardEvent(sessionId, mainWindow, cliEvent, entry.queryInstance);'),
  'assistant 转发行被门波及');
const streamBody = (() => {
  const a = backend.indexOf("if (type === 'stream_event') {");
  const b = backend.indexOf("if (type === 'tool_progress') {", a);
  return a > -1 && b > a ? backend.slice(a, b) : '';
})();
scheck('S3-5 stream_event 分支 finishApiRetryRecovery 过 isCurrentEntry 门且转发行不动',
  /if \(isCurrentEntry\(sessionId, entry\)\) finishApiRetryRecovery\(sessionId, mainWindow, entry\.queryInstance\);/.test(streamBody) &&
  streamBody.includes('forwardEvent(sessionId, mainWindow, convertStreamEvent(sdkMsg), entry.queryInstance);'),
  'stream_event 写态门缺位或转发行漂移');

// ── 1. 行为 seam 环境 ────────────────────────────────────────────────
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-a1gen-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

let fakeRowid = 0;
const fakeStmt = {
  run: () => ({ lastInsertRowid: ++fakeRowid, changes: 1 }),
  all: () => [],
  get: () => undefined,
  finalize() { /* no-op */ },
};
const fakeDb = {
  prepare: () => fakeStmt,
  transaction: (fn: () => unknown) => fn,
  pragma: () => undefined,
  exec: () => undefined,
  close() { /* no-op */ },
};
const fakeConnection = { getConnection: () => fakeDb, closeConnection: () => {} };

const sessions = new Map<string, Record<string, unknown>>();
const sessionRepoStub = {
  createSession: (name: string, model: string, workingDir: string | null) => {
    const id = uuidv4();
    const s = {
      id, name, model, workingDir: workingDir ?? null, cliSessionId: null as string | null,
      permissionMode: null as string | null, modelOverride: null as string | null,
      providerOverride: null as string | null, maxTurns: 200, thinkingLevel: null as string | null,
    };
    sessions.set(id, s);
    return s;
  },
  getSession: (id: string) => sessions.get(id) ?? null,
  updateCliSessionId: () => null,
  updateLastContext: () => null,
  updateLastContextWindow: () => null,
  updateLastContextUsed: () => null,
};

// task-repo 内存桩：pauseAllPendingCalls 计数 = haltQueue 熔断可观测侧面。
const taskStore = new Map<string, Record<string, unknown>>();
let pauseAllPendingCalls = 0;
const taskRepoStub = {
  getTask: (id: string) => (taskStore.get(id) as never) ?? null,
  createTask: (sessionId: string, prompt: string) => {
    const id = uuidv4();
    const t = { id, sessionId, prompt, status: 'pending', paused: false, clientMessageId: null, sortOrder: 0, attachments: [], error: null, createdAt: new Date().toISOString() };
    taskStore.set(id, t);
    return t;
  },
  updateTaskStatus: (id: string, status: string) => { const t = taskStore.get(id); if (t) t.status = status; },
  updateTaskError: (id: string, error: string) => { const t = taskStore.get(id); if (t) { t.error = error; t.status = 'failed'; } },
  updateTaskResult: () => { /* no-op */ },
  setTaskClientMessageId: () => { /* no-op */ },
  getTasksBySession: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId) as never,
  getPendingTasks: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId && t.status === 'pending') as never,
  pauseAllPending: (sessionId: string) => { pauseAllPendingCalls += 1; for (const t of taskStore.values()) if (t.sessionId === sessionId && t.status === 'pending') t.paused = true; },
  setTaskPaused: (id: string, paused: boolean) => { const t = taskStore.get(id); if (t) t.paused = paused; },
  reorderTasks: () => { /* no-op */ },
};

// message-repo 桩：createMessage 计数（A1-04 落库面观察）。
let createMessageCalls = 0;
const messageRepoStub = {
  createMessage: (args: Record<string, unknown>) => {
    createMessageCalls += 1;
    return { id: `m${createMessageCalls}`, ...args, createdAt: new Date().toISOString() };
  },
  createMessageWithAttachments: (args: Record<string, unknown>) => {
    createMessageCalls += 1;
    return { id: `m${createMessageCalls}`, ...args, createdAt: new Date().toISOString() };
  },
  getMessages: () => [] as never,
  getMessagesBySession: () => [] as never,
  getMessagesByTask: () => [] as never,
  getRecentMessagesForTurnCheck: () => [] as never,
  updateMessage: () => null,
  getMessageByClientMessageId: () => null,
};

// 副作用计数桩（A1-a 门的两块上游调用点）：完成通知 + 命名重试调度。
let notifyCompletedCalls = 0;
let namingRetryCalls = 0;
const notifierStub = {
  notifySessionCompleted: () => { notifyCompletedCalls += 1; },
  notifySessionNetworkInterrupted: () => { /* no-op */ },
};
const topicAnalyzerStub = {
  maybeRetrySessionNaming: () => { namingRetryCalls += 1; },
  // 2026-11-15 eight-issues B3 契约同步：sdk-backend 新增导入 cancelSessionTopicAnalysis
  //（killProcess('user')/markSessionDeleted 两边沿挂接在飞命名取消），本 stub 补 no-op 成员
  // 防 markSessionDeleted 直跑 TypeError；同步验证 = 本卷 exit 0 +
  // tdd-session-naming-inflight-cancel-verify.ts exit 0。
  cancelSessionTopicAnalysis: () => { /* no-op（B3 边沿接线，本卷不观测） */ },
};

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require(path.join(repoRoot, 'scripts', 'electron-stub.cjs'));
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  if (/[\\/]task-repo$/.test(req)) return taskRepoStub;
  if (/[\\/]message-repo$/.test(req)) return messageRepoStub;
  if (/[\\/]session-completion-notifier$/.test(req)) return notifierStub;
  if (/[\\/]topic-analyzer$/.test(req)) return topicAnalyzerStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

const sdk = require('../src/main/modules/sdk-backend');
const tqe = require('../src/main/modules/task-queue-engine');
const { saveConfig } = require('../src/main/modules/config-manager');
const { initPushBus, setWebPushSink } = require('../src/main/modules/push-bus');

saveConfig({ cliPath: process.execPath, queueEnabled: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 事件采集：webSink 单点捕获（push-bus 唯一出口），按通道分流。
// chatEvents 存扁平事件（sessionId 合并进事件对象，窗口断言可按会话过滤）。
type ChatEvent = Record<string, unknown>;
const chatEvents: ChatEvent[] = [];
const queueEvents: Array<Record<string, unknown>> = [];
const dummyWin = {
  webContents: { send: () => { /* 主窗单播哑窗：采集只走 webSink，避免双计 */ } },
  isDestroyed: () => true,
  isFocused: () => true,
  flashFrame: () => { /* no-op */ },
};
initPushBus(() => dummyWin as never);
setWebPushSink((channel: string, args: unknown[]) => {
  const payload = (Array.isArray(args) ? args[0] : args) as Record<string, unknown> | undefined;
  if (!payload) return;
  if (process.env.A1_DEBUG) console.log(`  [sink] ${channel} ${(JSON.stringify(payload) ?? '').slice(0, 120)}`);
  if (channel === 'chat:event') {
    const ev = (payload as { event?: ChatEvent }).event ?? payload;
    chatEvents.push({ sessionId: payload.sessionId, ...ev });
  }
  if (channel === 'queue:event') queueEvents.push(payload);
});

// 窗口切片助手：快照下标 → （可选按会话过滤）事件列表。
function chatWindow(snap: number, sid?: string): ChatEvent[] {
  const slice = chatEvents.slice(snap);
  return sid ? slice.filter((e) => e.sessionId === sid) : slice;
}
function queueWindow(snap: number, sid?: string): Array<Record<string, unknown>> {
  const slice = queueEvents.slice(snap);
  return sid ? slice.filter((e) => e.sessionId === sid) : slice;
}

// 未处理 rejection 计数（A1-07：叠加守卫不得抛未捕获异常）。
let unhandledRejections = 0;
process.on('unhandledRejection', (reason) => {
  unhandledRejections += 1;
  console.log(`  [unhandledRejection#${unhandledRejections}]`, reason instanceof Error ? reason.message : String(reason));
});

// 脚本型假 query：分段 { holdBefore?: Promise; emit: raw SDK 消息[] }，末段后可挂起。
type RawMsg = Record<string, unknown>;
type Segment = { holdBefore?: Promise<void>; emit: RawMsg[] };
interface SeqQuery {
  [Symbol.asyncIterator](): AsyncGenerator<RawMsg, void>;
  interrupt(): Promise<void>;
  getContextUsage(): Promise<{ maxTokens: number; rawMaxTokens: number; totalTokens: number; percentage: number }>;
  close(): void;
  fail(err: Error): void;
}
function makeSeqQuery(segments: Segment[]): SeqQuery {
  let rejectRun!: (err: Error) => void;
  const failure = new Promise<never>((_, rej) => { rejectRun = rej; });
  failure.catch(() => { /* 兜底标记已处理：生成器已收尾后再 fail() 不产生未处理 rejection */ });
  const raceFail = <T,>(p: Promise<T>): Promise<T> => Promise.race([p, failure]) as Promise<T>;
  const gen = async function* (): AsyncGenerator<RawMsg, void> {
    for (const seg of segments) {
      if (seg.holdBefore) await raceFail(seg.holdBefore);
      for (const msg of seg.emit) {
        yield msg;
      }
    }
    await raceFail(new Promise<void>(() => { /* 挂起直到 fail() */ }));
  };
  const q = {
    [Symbol.asyncIterator]: gen,
    async interrupt() { /* ack 立即返回 */ },
    async getContextUsage() { return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 }; },
    close() { /* no-op */ },
    fail(err: Error) { rejectRun(err); },
  };
  return q as unknown as SeqQuery;
}

const RAW_RESULT_SUCCESS: RawMsg = {
  type: 'result', subtype: 'success', is_error: false, result: 'done',
  duration_ms: 1000, num_turns: 1, session_id: 'cli-x', total_cost_usd: 0,
};
const RAW_API_RETRY: RawMsg = {
  type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 3, retry_delay_ms: 1000,
};
const RAW_STREAM_EVENT: RawMsg = {
  type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } },
};

let pass = 0;
let failCount = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { failCount += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 幂等收尾：清队列状态 + 关闭未收尾 query + 摘 factory。 */
async function settleScenario(sessionId: string | null, queries: Array<{ fail(err: Error): void }>): Promise<void> {
  for (const q of queries) q.fail(new Error('scenario cleanup'));
  await sleep(120);
  if (sessionId) tqe.cleanupQueue(sessionId);
}

(async () => {
  sdk.__setSdkQueryFactoryForTest(async () => { throw new Error('factory 未按场景安装'); });

  // ── A1-01 同代际正常回合全副作用在位（红线基线 + 边界行1）─────────────
  console.log('\n=== A1-01 同代际正常回合：五项副作用全在位（红线） ===');
  {
    const session = sessionRepoStub.createSession('a1-01', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    let openGen1!: () => void;
    const gateGen1 = new Promise<void>((res) => { openGen1 = res; });
    sdk.__setSdkQueryFactoryForTest(async () => {
      const q = makeSeqQuery([
        { emit: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello-01' }] } }] },
        { holdBefore: gateGen1, emit: [RAW_RESULT_SUCCESS] },
      ]);
      queries.push(q);
      return q as never;
    });
    const task = taskRepoStub.createTask(session.id, '队列任务一');
    tqe.runTaskNow(task.id, win as never);
    await sleep(400);
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    const baseCreate = createMessageCalls;
    const chatSnap = chatEvents.length;
    const queueSnap = queueEvents.length;
    openGen1();
    await sleep(600);
    const newChat = chatWindow(chatSnap, session.id);
    const newQueue = queueWindow(queueSnap, session.id);
    const settled = newQueue.some((e) => e.type === 'task_settled' && (e.data as Record<string, unknown> | undefined)?.outcome === 'success');
    const turnEndedOk = newChat.some((e) => e.type === 'turn_ended' && e.outcome === 'success');
    const resultForwarded = newChat.some((e) => e.type === 'result');
    check('A1-01① 队列记账发生（task_settled success，引擎正常流转无虚假 halt）', settled,
      `queue events=[${newQueue.map((e) => e.type).join(',')}]`);
    check('A1-01② 完成通知恰 1 次', notifyCompletedCalls - baseNotify === 1, `delta=${notifyCompletedCalls - baseNotify}`);
    check('A1-01③ 命名重试调度恰 1 次', namingRetryCalls - baseNaming === 1, `delta=${namingRetryCalls - baseNaming}`);
    check('A1-01④ turn_ended(success) 伴生信号出现', turnEndedOk);
    check('A1-01⑤ 回合正常收尾且无 queue_halted', !newQueue.some((e) => e.type === 'queue_halted') && resultForwarded && pauseAllPendingCalls === 0,
      `resultForwarded=${resultForwarded} pauseAll=${pauseAllPendingCalls}`);
    check('A1-01⑥ 同代际落库零阻碍（result 链 createMessage 有推进）', createMessageCalls > baseCreate,
      `createMessage delta=${createMessageCalls - baseCreate}`);
    await settleScenario(session.id, queries);
  }

  // ── A1-02 单次接管后旧回合迟到 result 全副作用被剪（条款1 主链路）─────────
  console.log('\n=== A1-02 接管后旧流迟到 result：五副作用全剪，新回合不受污染 ===');
  {
    const session = sessionRepoStub.createSession('a1-02', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    const gates: Array<() => void> = [];
    sdk.__setSdkQueryFactoryForTest(async () => {
      const gate = new Promise<void>((res) => { gates.push(res); });
      const q = makeSeqQuery([{ holdBefore: gate, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    // ① 队列任务回合起步（gen1 挂起）
    const task = taskRepoStub.createTask(session.id, '队列任务二');
    tqe.runTaskNow(task.id, win as never);
    await sleep(400);
    // ② watchdog 进优雅窗 → spawnForChat+sendMessage+beginUserTurn 接管（gen2）
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    sdk.spawnForChat(session.id, win as never, { userCommandText: '直发消息' });
    sdk.sendMessage(session.id, '直发消息');
    tqe.beginUserTurn(session.id, win as never);
    // CHAT_SEND 生产同款投影登记（ipc-handlers 发射块的 seam 等价：noteTurnStarted 新代际重建快照）
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(200);
    check('A1-02前置 两代 query 并存（factory 调用 2 次）', queries.length === 2, `queries=${queries.length}`);
    // ③④ 开 gen1 旧流闸 → 迟到 success result
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    const basePause = pauseAllPendingCalls;
    const chatSnap = chatEvents.length;
    const queueSnap = queueEvents.length;
    gates[0]();
    await sleep(600);
    const newChat = chatWindow(chatSnap, session.id);
    const newQueue = queueWindow(queueSnap, session.id);
    check('A1-02① 迟到 result 不触发队列记账（无 task_settled / queue_halted）',
      !newQueue.some((e) => e.type === 'task_settled' || e.type === 'queue_halted'),
      `queue events=[${newQueue.map((e) => e.type).join(',')}]`);
    check('A1-02② 不误 pauseAllPending（haltQueue 不熔断 pending）', pauseAllPendingCalls - basePause === 0,
      `pauseAll delta=${pauseAllPendingCalls - basePause}`);
    check('A1-02③ 新 entry knownOutcome 未被旧回合写脏（getKnownTurnOutcome 为 null）',
      sdk.getKnownTurnOutcome(session.id) === null,
      `knownOutcome=${String(sdk.getKnownTurnOutcome(session.id))}`);
    check('A1-02④ 无完成通知', notifyCompletedCalls - baseNotify === 0, `delta=${notifyCompletedCalls - baseNotify}`);
    check('A1-02⑤ 无命名重试调度', namingRetryCalls - baseNaming === 0, `delta=${namingRetryCalls - baseNaming}`);
    check('A1-02⑥ 透传/落库口径与修复前零差异（迟到 result 不新增 CHAT_EVENT result 转发）',
      !newChat.some((e) => e.type === 'result'),
      `chat events=[${newChat.map((e) => e.type).join(',')}]`);
    // ⑤ 开 gen2 闸 → 新回合正常收尾
    const base2Notify = notifyCompletedCalls;
    const base2Naming = namingRetryCalls;
    const chatSnap2 = chatEvents.length;
    const queueSnap2 = queueEvents.length;
    gates[1]();
    await sleep(600);
    const newQueue2 = queueWindow(queueSnap2, session.id);
    check('A1-02⑦ 新代际五副作用如期（记账/通知/命名/turn_ended/无 halt）',
      newQueue2.some((e) => e.type === 'task_settled') &&
      notifyCompletedCalls - base2Notify === 1 &&
      namingRetryCalls - base2Naming === 1 &&
      chatWindow(chatSnap2, session.id).some((e) => e.type === 'turn_ended') &&
      !newQueue2.some((e) => e.type === 'queue_halted'),
      `settled=${newQueue2.some((e) => e.type === 'task_settled')} notify=${notifyCompletedCalls - base2Notify} naming=${namingRetryCalls - base2Naming}`);
    await settleScenario(session.id, queries);
  }

  // ── A1-03 旧代际 api_retry / stream_event 不污染新回合重试状态卡（条款2）──
  console.log('\n=== A1-03 旧代际 api_retry/stream_event 不污染新回合状态卡；新代际照常 ===');
  {
    const session = sessionRepoStub.createSession('a1-03', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    let openGen1!: () => void;
    const gateGen1 = new Promise<void>((res) => { openGen1 = res; });
    let openGen2Tail!: () => void;
    const gateGen2Tail = new Promise<void>((res) => { openGen2Tail = res; });
    sdk.__setSdkQueryFactoryForTest(async () => {
      if (queries.length === 0) {
        const q = makeSeqQuery([{ holdBefore: gateGen1, emit: [RAW_API_RETRY, RAW_STREAM_EVENT] }]);
        queries.push(q);
        return q as never;
      }
      // gen2：起步即 api_retry → stream_event（恢复），随后挂起待闸放行 result
      const q = makeSeqQuery([
        { emit: [RAW_API_RETRY, RAW_STREAM_EVENT] },
        { holdBefore: gateGen2Tail, emit: [RAW_RESULT_SUCCESS] },
      ]);
      queries.push(q);
      return q as never;
    });
    // ① 回合1 起步挂起（chat 路径）
    sdk.spawnForChat(session.id, win as never, { userCommandText: '第一问' });
    sdk.sendMessage(session.id, '第一问');
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(300);
    // ② watchdog + 接管 gen2（gen2 流起步即 emit api_retry + stream_event 后挂起）
    const curSnap = chatEvents.length;
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    sdk.spawnForChat(session.id, win as never, { userCommandText: '第二问' });
    sdk.sendMessage(session.id, '第二问');
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(300);
    check('A1-03前置 接管完成（factory 调用 2 次）', queries.length === 2, `queries=${queries.length}`);
    // ④ 新代际同形态事件 → 照常发出（红线；窗口=接管后至开 gen1 闸前）
    const curWindow = chatWindow(curSnap, session.id);
    check('A1-03③ 新代际 api_retry 状态卡照常发出（红线不被门误伤）',
      curWindow.some((e) => e.type === 'system' && e.subtype === 'api_retry'),
      `current events=[${curWindow.map((e) => `${e.type}:${e.subtype ?? ''}`).join(',')}]`);
    check('A1-03④ 新代际恢复终态照常（system:api_retry_recovered persisted_message）',
      curWindow.some((e) => {
        const m = e.message as Record<string, unknown> | undefined;
        return e.type === 'persisted_message' && m && m.processKind === 'system:api_retry_recovered';
      }),
      `persisted kinds=[${curWindow.filter((e) => e.type === 'persisted_message').map((e) => String((e.message as Record<string, unknown>).processKind)).join(',')}]`);
    // ③ 开 gen1 闸 → 旧代际 api_retry/stream_event
    const staleSnap = chatEvents.length;
    openGen1();
    await sleep(500);
    const staleWindow = chatWindow(staleSnap, session.id);
    check('A1-03① 旧代际 api_retry 不产生重试状态卡事件（sink 无 api_retry）',
      !staleWindow.some((e) => e.type === 'system' && e.subtype === 'api_retry') &&
      !staleWindow.some((e) => e.type === 'api_retry_terminal'),
      `stale events=[${staleWindow.map((e) => e.type).join(',')}]`);
    check('A1-03② 旧代际 stream_event 不产生恢复终态（无 system:api_retry_recovered 落库推送）',
      !staleWindow.some((e) => {
        const m = e.message as Record<string, unknown> | undefined;
        return e.type === 'persisted_message' && m && m.processKind === 'system:api_retry_recovered';
      }),
      '旧代际恢复终态误发');
    // ⑤ gen2 result 收尾
    openGen2Tail();
    await sleep(400);
    await settleScenario(session.id, queries);
  }

  // ── A1-04 守卫只剪会话级副作用，透传/落库不受门（条款3）────────────────
  console.log('\n=== A1-04 门的作用域边界：透传/落库路径零差异（结构 + 行为） ===');
  {
    // 结构面在 S2-7 已钉（门计算位于 push/persist 之后）；此处行为面复验 A1-02 场景的
    // 落库计数守恒：迟到 result 未引入任何新增落库（与修复前探针基线一致）。
    const session = sessionRepoStub.createSession('a1-04', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    const gates: Array<() => void> = [];
    sdk.__setSdkQueryFactoryForTest(async () => {
      const gate = new Promise<void>((res) => { gates.push(res); });
      const q = makeSeqQuery([{ holdBefore: gate, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问四' });
    sdk.sendMessage(session.id, '问四');
    await sleep(300);
    const baseCreate = createMessageCalls;
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问四接管' });
    sdk.sendMessage(session.id, '问四接管');
    await sleep(250);
    const midCreate = createMessageCalls;
    gates[0]();
    await sleep(500);
    check('A1-04① 迟到 result 不新增任何落库（createMessage 零增量，与修复前一致）',
      createMessageCalls - midCreate === 0, `delta=${createMessageCalls - midCreate}`);
    check('A1-04② 前置：接管本身落库行为正常（user 行落库有推进）', midCreate > baseCreate,
      `mid-base=${midCreate - baseCreate}`);
    gates[1]();
    await sleep(400);
    await settleScenario(session.id, queries);
  }

  // ── A1-05 同回合多次接管：代际单调递增、各旧代际独立被剪（边界行2 + 条款4）──
  console.log('\n=== A1-05 连续两次接管：gen1/gen2 迟到 result 全剪，gen3 正常 ===');
  {
    const session = sessionRepoStub.createSession('a1-05', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    const gates: Array<() => void> = [];
    sdk.__setSdkQueryFactoryForTest(async () => {
      const gate = new Promise<void>((res) => { gates.push(res); });
      const q = makeSeqQuery([{ holdBefore: gate, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问五-1' });
    sdk.sendMessage(session.id, '问五-1');
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(250);
    const gen1 = sdk.getCurrentQueryInstance(session.id);
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问五-2' });
    sdk.sendMessage(session.id, '问五-2');
    tqe.beginUserTurn(session.id, win as never);
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(200);
    const gen2 = sdk.getCurrentQueryInstance(session.id);
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问五-3' });
    sdk.sendMessage(session.id, '问五-3');
    tqe.beginUserTurn(session.id, win as never);
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(200);
    const gen3 = sdk.getCurrentQueryInstance(session.id);
    check('A1-05前置 三代并存且代际单调递增（契约4）',
      queries.length === 3 && typeof gen1 === 'number' && typeof gen2 === 'number' && typeof gen3 === 'number' &&
      (gen1 as number) < (gen2 as number) && (gen2 as number) < (gen3 as number),
      `gens=${gen1},${gen2},${gen3}`);
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    gates[0]();
    await sleep(350);
    gates[1]();
    await sleep(350);
    check('A1-05① gen1/gen2 迟到 result 全剪（通知/命名零触发）',
      notifyCompletedCalls - baseNotify === 0 && namingRetryCalls - baseNaming === 0,
      `notify=${notifyCompletedCalls - baseNotify} naming=${namingRetryCalls - baseNaming}`);
    check('A1-05② gen3 entry 未被旧代际写脏', sdk.getKnownTurnOutcome(session.id) === null,
      `knownOutcome=${String(sdk.getKnownTurnOutcome(session.id))}`);
    const queueBefore = queueEvents.length;
    const baseNotify2 = notifyCompletedCalls;
    gates[2]();
    await sleep(500);
    const newQueue = queueEvents.slice(queueBefore);
    check('A1-05③ gen3 正常记账 + 通知（新代际不受污染）',
      notifyCompletedCalls - baseNotify2 === 1 && !newQueue.some((e) => e.type === 'queue_halted'),
      `notify=${notifyCompletedCalls - baseNotify2} halted=${newQueue.some((e) => e.type === 'queue_halted')}`);
    await settleScenario(session.id, queries);
  }

  // ── A1-06 接管语境红线：新回合正常 result 不受守卫误伤 + 优雅窗同代际合法终态 ──
  console.log('\n=== A1-06 接管后新回合正常 result 五副作用全在位（红线） ===');
  {
    const session = sessionRepoStub.createSession('a1-06', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    let openGen1!: () => void;
    const gateGen1 = new Promise<void>((res) => { openGen1 = res; });
    sdk.__setSdkQueryFactoryForTest(async () => {
      if (queries.length === 0) {
        const q = makeSeqQuery([{ holdBefore: gateGen1, emit: [RAW_RESULT_SUCCESS] }]);
        queries.push(q);
        return q as never;
      }
      const q = makeSeqQuery([
        { emit: [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hello-06' }] } }] },
        { emit: [RAW_RESULT_SUCCESS] },
      ]);
      queries.push(q);
      return q as never;
    });
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问六-1' });
    sdk.sendMessage(session.id, '问六-1');
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(250);
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60);
    // 副作用/事件窗口从接管 sendMessage 前起算（gen2 流无闸，result 在 sleep 内自然走完）
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    const chatSnap = chatEvents.length;
    const queueSnap = queueEvents.length;
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问六-2' });
    sdk.sendMessage(session.id, '问六-2');
    tqe.beginUserTurn(session.id, win as never);
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(400); // gen2 流自然走完（assistant + result，无闸）
    const newChat = chatWindow(chatSnap, session.id);
    const newQueue = queueWindow(queueSnap, session.id);
    check('A1-06① 新回合记账/通知/命名/turn_ended 全在位且无 halt',
      notifyCompletedCalls - baseNotify === 1 && namingRetryCalls - baseNaming === 1 &&
      newChat.some((e) => e.type === 'turn_ended' && e.outcome === 'success') &&
      !newQueue.some((e) => e.type === 'queue_halted'),
      `notify=${notifyCompletedCalls - baseNotify} naming=${namingRetryCalls - baseNaming} ended=${newChat.some((e) => e.type === 'turn_ended')}`);
    // 收尾：gen1 旧流清理
    openGen1();
    await sleep(200);
    await settleScenario(session.id, queries);
  }

  console.log('\n=== A1-06b 优雅窗内同代际 result 合法处理（门不得误剪同代际） ===');
  {
    const session = sessionRepoStub.createSession('a1-06b', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    let openGen1!: () => void;
    const gateGen1 = new Promise<void>((res) => { openGen1 = res; });
    sdk.__setSdkQueryFactoryForTest(async () => {
      const q = makeSeqQuery([{ holdBefore: gateGen1, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问六b' });
    sdk.sendMessage(session.id, '问六b');
    sdk.noteTurnStartedAndEmit(session.id);
    await sleep(300);
    sdk.killProcess(session.id, 'watchdog', win as never);
    await sleep(60); // 进优雅窗，未接管（kill 链已按 interrupted 消费 turn_ended，生产口径）
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    const queueSnap = queueEvents.length;
    openGen1(); // 同代际 result 在优雅窗内到达 → 合法终态信号，门必须放行
    await sleep(500);
    check('A1-06b① 优雅窗内同代际 result 副作用在位（通知/命名照发，门不误剪同代际）',
      notifyCompletedCalls - baseNotify === 1 && namingRetryCalls - baseNaming === 1,
      `notify=${notifyCompletedCalls - baseNotify} naming=${namingRetryCalls - baseNaming}`);
    check('A1-06b② 同代际 result 正常记账收尾（无 queue_halted）',
      !queueWindow(queueSnap, session.id).some((e) => e.type === 'queue_halted'));
    await settleScenario(session.id, queries);
  }

  // ── A1-07 会话删除后迟到事件：isSessionActive 既有守卫叠加不冲突（条款6）────
  console.log('\n=== A1-07 删除后迟到 result：isSessionActive 兜底，无异常无副作用 ===');
  {
    const session = sessionRepoStub.createSession('a1-07', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    let openGen1!: () => void;
    const gateGen1 = new Promise<void>((res) => { openGen1 = res; });
    sdk.__setSdkQueryFactoryForTest(async () => {
      const q = makeSeqQuery([{ holdBefore: gateGen1, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    sdk.spawnForChat(session.id, win as never, { userCommandText: '问七' });
    sdk.sendMessage(session.id, '问七');
    await sleep(300);
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    const rejectionsBefore = unhandledRejections;
    sdk.markSessionDeleted(session.id);
    openGen1();
    await sleep(500);
    check('A1-07① 删除后迟到 result 零会话级副作用（isSessionActive 兜底）',
      notifyCompletedCalls - baseNotify === 0 && namingRetryCalls - baseNaming === 0,
      `notify=${notifyCompletedCalls - baseNotify} naming=${namingRetryCalls - baseNaming}`);
    check('A1-07② 叠加路径无未处理 rejection / 不崩', unhandledRejections === rejectionsBefore,
      `rejections=${unhandledRejections - rejectionsBefore}`);
    await settleScenario(null, queries);
  }

  // ── A1-08 代际深度压力：连续 6 次接管后代际仍单调、旧代际全剪（边界行3）────
  console.log('\n=== A1-08 连续 6 次接管：gen1..5 迟到 result 全剪，gen6 正常，代际无回绕 ===');
  {
    const session = sessionRepoStub.createSession('a1-08', 'sonnet', null);
    const win = dummyWin;
    const queries: Array<ReturnType<typeof makeSeqQuery>> = [];
    const gates: Array<() => void> = [];
    sdk.__setSdkQueryFactoryForTest(async () => {
      const gate = new Promise<void>((res) => { gates.push(res); });
      const q = makeSeqQuery([{ holdBefore: gate, emit: [RAW_RESULT_SUCCESS] }]);
      queries.push(q);
      return q as never;
    });
    const gens: number[] = [];
    for (let k = 1; k <= 6; k += 1) {
      if (k > 1) {
        sdk.killProcess(session.id, 'watchdog', win as never);
        await sleep(60);
      }
      sdk.spawnForChat(session.id, win as never, { userCommandText: `问八-${k}` });
      sdk.sendMessage(session.id, `问八-${k}`);
      tqe.beginUserTurn(session.id, win as never);
      sdk.noteTurnStartedAndEmit(session.id);
      await sleep(220);
      const g = sdk.getCurrentQueryInstance(session.id);
      gens.push(typeof g === 'number' ? g : -1);
    }
    check('A1-08前置 六次 spawn 代际严格单调递增（无上限回绕）',
      gens.length === 6 && gens.every((g, i) => g > 0 && (i === 0 || g > gens[i - 1])),
      `gens=${gens.join(',')}`);
    const baseNotify = notifyCompletedCalls;
    const baseNaming = namingRetryCalls;
    for (let k = 0; k < 5; k += 1) {
      gates[k]();
      await sleep(250);
    }
    check('A1-08① gen1..5 迟到 result 全剪（通知/命名零触发）',
      notifyCompletedCalls - baseNotify === 0 && namingRetryCalls - baseNaming === 0,
      `notify=${notifyCompletedCalls - baseNotify} naming=${namingRetryCalls - baseNaming}`);
    check('A1-08② gen6 entry 未被旧代际写脏', sdk.getKnownTurnOutcome(session.id) === null,
      `knownOutcome=${String(sdk.getKnownTurnOutcome(session.id))}`);
    const baseNotify2 = notifyCompletedCalls;
    const chatSnap = chatEvents.length;
    gates[5]();
    await sleep(500);
    check('A1-08③ gen6 正常收尾（通知 1 次 + turn_ended success）',
      notifyCompletedCalls - baseNotify2 === 1 &&
      chatWindow(chatSnap, session.id).some((e) => e.type === 'turn_ended' && e.outcome === 'success'),
      `notify=${notifyCompletedCalls - baseNotify2}`);
    await settleScenario(session.id, queries);
  }

  sdk.__setSdkQueryFactoryForTest(null);

  console.log(`\nA1-07 全程未处理 rejection 累计：${unhandledRejections}`);
  check('A1-全局 全脚本零未处理 rejection', unhandledRejections === 0, `count=${unhandledRejections}`);

  const totalFail = sfail + failCount;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${failCount} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
