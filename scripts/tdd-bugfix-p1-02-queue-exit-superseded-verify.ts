// tdd-bugfix-p1-02-queue-exit-superseded-verify.ts
// P1-2 契约钉：队列 popExecute exit 兜底缺「新回合在途」守卫 → 误熔断整个队列。
//
// 根因（真实时序驱动复现）：watchdog 两段式 kill 的 ≤5s 优雅窗内 entry.forceKill 已置
//（getActiveProcess 判否）→ 用户直发消息畅通：spawnForChat 经 F1 forceKill 接管旧 entry，
// beginUserTurn 只置 running 不清 currentTaskId → 旧任务 child 迟到 exit 命中 popExecute
// 兜底（generation 活跃 + currentTaskId 仍匹配）→ noteTurnOutcome('error') 时引擎 status
// 已是 running（新直发回合）→ haltQueue 误熔断：全部 pending 转 paused + 待命栏。
//
// 修复语义：exit 兜底携带「新回合在途」让位谓词（与 CHAT_SEND exit 兜底代际守卫同形：
// active && active !== child），命中即 return——不记账、不熔断。正常队列回合失败仍熔断。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-02-queue-exit-superseded-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 1. 结构契约 ──
const repoRoot = path.resolve(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/task-queue-engine.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 截取 source 中 from 起点函数体（到下一个顶层 function/export）。 */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  const nextExport = source.indexOf('\nexport ', start + 1);
  const candidates = [next, nextExport].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

const popBody = fnBody(engineSrc, 'async function popExecute');
const exitFallback = popBody.slice(popBody.indexOf("child.on('exit'"));
scheck('结构① popExecute exit 兜底查询活动进程（getActiveProcess）', exitFallback.includes('getActiveProcess(sessionId)'));
scheck('结构② exit 兜底带「新回合在途」让位谓词（active && active !== child）',
  /active\s*&&\s*active\s*!==\s*child/.test(exitFallback));
scheck('结构③ 让位分支先于 noteTurnOutcome（命中即 return，不记账不熔断）',
  exitFallback.indexOf('active !== child') !== -1 &&
  exitFallback.indexOf('active !== child') < exitFallback.indexOf('noteTurnOutcome(sessionId, code === 0'));

// ── 2. 行为 seam：真实引擎 + 真实 sdk-backend（mock factory）驱动两段式 kill 优雅窗竞态 ──
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-queueexit-ud-'));
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

// task-repo 内存桩：记录 pauseAllPending 调用（熔断的可观侧面）。
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
  setTaskClientMessageId: (id: string, mid: string) => { const t = taskStore.get(id); if (t) t.clientMessageId = mid; },
  getTasksBySession: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId) as never,
  getPendingTasks: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId && t.status === 'pending') as never,
  pauseAllPending: (sessionId: string) => { pauseAllPendingCalls += 1; for (const t of taskStore.values()) if (t.sessionId === sessionId && t.status === 'pending') t.paused = true; },
  setTaskPaused: (id: string, paused: boolean) => { const t = taskStore.get(id); if (t) t.paused = paused; },
  reorderTasks: () => { /* no-op */ },
};

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  if (/[\\/]task-repo$/.test(req)) return taskRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

const sdk = require('../src/main/modules/sdk-backend');
const { runTaskNow, beginUserTurn, getQueueOverview, cleanupQueue } = require('../src/main/modules/task-queue-engine');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath, queueEnabled: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 挂起型假 query：流挂起直到 fail() 被调（模拟被 watchdog 打断后迟到的旧流）。 */
function makeHangQuery() {
  let rejectRun!: (err: Error) => void;
  const promise = new Promise<void>((_, rej) => { rejectRun = rej; });
  const q = {
    async *[Symbol.asyncIterator]() {
      await promise;
      yield { type: 'noop' }; // 不可达：仅防 TS 对空生成器的抱怨
    },
    async interrupt() { /* ack 立即返回 */ },
    async getContextUsage() {
      return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 };
    },
    close() { /* no-op */ },
    fail(err: Error) { rejectRun(err); },
  };
  return q;
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const session = sessionRepoStub.createSession('queue-exit-test', 'sonnet', null);
  const queueEvents: Record<string, unknown>[] = [];
  const win = {
    webContents: {
      send: (channel: string, payload: Record<string, unknown>) => {
        if (channel === 'queue:event') queueEvents.push(payload);
      },
    },
    isDestroyed: () => true,
    isFocused: () => true,
  };

  const queries: ReturnType<typeof makeHangQuery>[] = [];
  sdk.__setSdkQueryFactoryForTest(async () => {
    const q = makeHangQuery();
    queries.push(q);
    return q as never;
  });

  // ① 队列任务出队执行（popExecute → spawnForTask → 挂起 query）。
  const task = taskRepoStub.createTask(session.id, '队列任务一');
  runTaskNow(task.id, win as never);
  await sleep(300);
  check('前置：任务回合已 spawn（factory 调用 1 次）', queries.length === 1, `queries=${queries.length}`);

  // ② watchdog 两段式 kill 进入优雅窗：entry.forceKill 置位（getActiveProcess 判否）。
  sdk.killProcess(session.id, 'watchdog', win);
  await sleep(50);

  // ③ 优雅窗内用户直发消息：spawnForChat 经 F1 forceKill 强制接管旧 entry → 新 entry 在途；
  //    CHAT_SEND 同序列调 beginUserTurn（置 running、不清 currentTaskId）。
  const win2 = { webContents: { send: () => { /* 聊天事件流不关心 */ } }, isDestroyed: () => true, isFocused: () => true };
  sdk.spawnForChat(session.id, win2 as never, { userCommandText: '直发消息' });
  sdk.sendMessage(session.id, '直发消息');
  beginUserTurn(session.id, win as never);
  await sleep(100);
  check('前置：直发回合已接管（factory 调用 2 次）', queries.length === 2, `queries=${queries.length}`);

  // ④ 旧任务 child 迟到 exit：旧流抛错收尾（entry 已被移除 → catch 提前 emitExit(null)）。
  queries[0].fail(new Error('graceful window aborted (simulated watchdog kill)'));
  await sleep(500);

  // 断言：旧 child 迟到 exit 不得熔断队列（不 haltQueue、不 pauseAllPending、状态不被闸）。
  const halted = queueEvents.some((e) => e.type === 'queue_halted');
  const overview = getQueueOverview(session.id);
  check('行为① 旧 child 迟到 exit 不触发 queue_halted', !halted,
    `queue 事件=[${queueEvents.map((e) => e.type).join(',')}]`);
  check('行为② 不误 pauseAllPending（pending 任务不转 paused）', pauseAllPendingCalls === 0,
    `pauseAllPendingCalls=${pauseAllPendingCalls}`);
  check('行为③ 引擎状态不被熔断闸（status 停留 running，非 standby/halt_failed）',
    overview.state.status === 'running' && overview.state.standbyReason === null,
    `status=${overview.state.status} standbyReason=${overview.state.standbyReason ?? 'null'}`);
  check('行为④ 误熔断不发生（task 仍非 paused）', task.paused === false, `paused=${task.paused}`);

  // 清理：结束直发回合与引擎状态。
  queries[1]?.fail(new Error('cleanup'));
  await sleep(200);
  cleanupQueue(session.id);
  sdk.__setSdkQueryFactoryForTest(null);

  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
