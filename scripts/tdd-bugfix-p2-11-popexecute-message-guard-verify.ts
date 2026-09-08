// tdd-bugfix-p2-11-popexecute-message-guard-verify.ts
// P2-11 契约钉：popExecute 消息创建段无异常收口 → 引擎僵尸 running、任务无痕丢失。
//
// 修复语义：消息创建段包 try/catch——失败 updateTaskError + settleCurrent('failed')（自发
// task_settled 让渲染层收口）；本地 DB 错误不触发 haltQueue 熔断；settleCurrent 后 exit 兜底
// 因 currentTaskId 失配自然失效。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-11-popexecute-message-guard-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const engineSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/task-queue-engine.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 截取函数体。 */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  const nextExport = source.indexOf('\nexport ', start + 1);
  const candidates = [next, nextExport].filter((i) => i > start);
  return source.slice(start, candidates.length ? Math.min(...candidates) : source.length);
}

const popBody = fnBody(engineSrc, 'async function popExecute');
const catchIdx = popBody.indexOf('} catch (err) {', popBody.indexOf('创建或复用 user message'));
const catchSeg = catchIdx > -1 ? popBody.slice(catchIdx, catchIdx + 600) : '';
scheck('结构① 消息创建段 try/catch 存在（catch 含 updateTaskError + settleCurrent failed）',
  catchIdx > -1 && catchSeg.includes('updateTaskError') && catchSeg.includes("settleCurrent(sessionId, 'failed', mainWindow)"));
scheck('结构② 本地 DB 错误不熔断（catch 段无 haltQueue 调用）',
  catchIdx > -1 && !/haltQueue\(sessionId/.test(catchSeg));

// ── 行为 seam ──
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p211-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
process.env.APPDATA = tmpUserData;

let fakeRowid = 0;
const fakeStmt = {
  run: () => ({ lastInsertRowid: ++fakeRowid, changes: 1 }),
  all: () => [],
  get: () => undefined,
  finalize() { /* no-op */ },
};
const fakeDb = {
  prepare(sql: string) {
    // 模拟 messages 表瞬时故障（唯一真实失败路径注入点）。
    if (sql.includes('INSERT INTO messages')) throw new Error('db disk I/O error (simulated)');
    return fakeStmt;
  },
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
const taskStore = new Map<string, Record<string, unknown>>();
let pauseAllPendingCalls = 0;
const taskRepoStub = {
  getTask: (id: string) => (taskStore.get(id) as never) ?? null,
  createTask: (sessionId: string, prompt: string) => {
    const id = uuidv4();
    const t = { id, sessionId, prompt, status: 'pending', paused: false, clientMessageId: null, sortOrder: 0, attachments: [], error: null };
    taskStore.set(id, t);
    return t;
  },
  updateTaskStatus: (id: string, status: string) => { const t = taskStore.get(id); if (t) t.status = status; },
  updateTaskError: (id: string, error: string) => { const t = taskStore.get(id); if (t) { t.error = error; t.status = 'failed'; } },
  setTaskClientMessageId: () => { /* no-op */ },
  getTasksBySession: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId) as never,
  getPendingTasks: (sessionId: string) => [...taskStore.values()].filter((t) => t.sessionId === sessionId && t.status === 'pending') as never,
  pauseAllPending: () => { pauseAllPendingCalls += 1; },
  setTaskPaused: () => { /* no-op */ },
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

const { runTaskNow, getQueueOverview, cleanupQueue } = require('../src/main/modules/task-queue-engine');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath, queueEnabled: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const session = sessionRepoStub.createSession('p211', 'sonnet', null);
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
  const { __setSdkQueryFactoryForTest } = require('../src/main/modules/sdk-backend');
  __setSdkQueryFactoryForTest(async () => {
    throw new Error('query must never start when message creation fails');
  });

  const task = taskRepoStub.createTask(session.id, '消息创建即失败的任务');
  runTaskNow(task.id, win as never);
  await sleep(400);

  const overview = getQueueOverview(session.id);
  check('行为① 任务终态化（status=failed，非僵尸 running）', task.status === 'failed', String(task.status));
  check('行为② 任务带错误信息', typeof task.error === 'string' && task.error.includes('消息创建失败'), String(task.error));
  check('行为③ 引擎不僵尸 running（置 standby，currentTaskId 已结算清空）',
    overview.state.currentTaskId === null && overview.state.status === 'standby',
    `${overview.state.status}/${overview.state.currentTaskId}`);
  check('行为④ 本地 DB 错误不熔断（无 queue_halted、无 pauseAllPending）',
    pauseAllPendingCalls === 0 && !queueEvents.some((e) => e.type === 'queue_halted'),
    `pauseCalls=${pauseAllPendingCalls}`);
  check('行为⑤ 发 task_settled 让渲染层收口', queueEvents.some((e) => e.type === 'task_settled'),
    `events=[${queueEvents.map((e) => e.type).join(',')}]`);

  cleanupQueue(session.id);
  __setSdkQueryFactoryForTest(null);
  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
