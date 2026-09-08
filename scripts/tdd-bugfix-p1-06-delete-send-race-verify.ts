// tdd-bugfix-p1-06-delete-send-race-verify.ts
// P1-6 契约钉：会话删除与发送竞态——已删会话被 markSessionActive「复活」，
// 孤儿 query 烧完整回合 + FK 报错刷屏。
//
// 三处收口：
//   ① CHAT_SEND 在 prepareAttachmentPrompt 之后、createMessage 之前重查 getSession；
//   ② markSessionActive 拒绝复活（marked-deleted 集合），spawnForChat 命中即中止 spawn；
//   ③ runQuery 在 cancelCommandProbe await 之后、entry.state='running' 之前判会话仍 active
//      且 entry 未被移除。
//
// 行为 seam（真实 sdk-backend + mock factory）：sendMessage 后 runQuery 停在 cancelCommandProbe
// 的 await（微任务），同同步块内 markSessionDeleted 先行——恢复时无修复会把 entry 重新置回
// running 并起孤儿 query（factory 被调）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-06-delete-send-race-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. 结构契约 ──
const backend = read('src/main/modules/sdk-backend.ts');
const ipc = read('src/main/ipc-handlers.ts');

scheck('结构① markSessionActive 拒绝复活（内部查 marked-deleted 集合）',
  /markedDeletedSessions|isSessionMarkedDeleted/.test(backend) &&
  /function markSessionActive[\s\S]{0,400}(markedDeletedSessions|isSessionMarkedDeleted)/.test(backend));
scheck('结构② spawnForChat 在占坑前拒绝已标记删除的会话（中止 spawn）', (() => {
  const body = backend.slice(backend.indexOf('export function spawnForChat('));
  const seg = body.slice(0, body.indexOf('\nexport ', 10) > 0 ? body.indexOf('\nexport ', 10) : 2000);
  return /已删除|MarkedDeleted|markedDeleted/.test(seg);
})());
scheck('结构③ runQuery 起步段（cancelCommandProbe 之后、entry.state=running 之前）有删除守卫', (() => {
  const at = backend.indexOf('await cancelCommandProbe(sessionId)');
  const atRunning = backend.indexOf("entry.state = 'running';", at);
  const seg = backend.slice(at, atRunning);
  return atRunning > at && seg.includes('isSessionActive') ;
})());
scheck('结构④ CHAT_SEND 在 prepareAttachmentPrompt 之后重查 getSession', (() => {
  const at = ipc.indexOf('attachmentIdsForRollback = prepared.attachmentIds;');
  const atCreate = ipc.indexOf('messageRepo.createMessageWithAttachments', at);
  const seg = ipc.slice(at, atCreate);
  return atCreate > at && seg.includes('getSession');
})());

// ── 2. 行为 seam ──
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-delrace-ud-'));
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
  deleteSession: (id: string) => { sessions.delete(id); },
  updateCliSessionId: () => null,
  updateLastContext: () => null,
  updateLastContextWindow: () => null,
  updateLastContextUsed: () => null,
};

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

const sdk = require('../src/main/modules/sdk-backend');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeHangQuery() {
  let rejectRun!: (err: Error) => void;
  const promise = new Promise<void>((_, rej) => { rejectRun = rej; });
  return {
    async *[Symbol.asyncIterator]() {
      await promise;
      yield { type: 'noop' };
    },
    async interrupt() { /* no-op */ },
    async getContextUsage() {
      return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 };
    },
    close() { /* no-op */ },
    fail(err: Error) { rejectRun(err); },
  };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const win = { webContents: { send: () => { /* 无关 */ } }, isDestroyed: () => true, isFocused: () => true };
  const queries: ReturnType<typeof makeHangQuery>[] = [];
  sdk.__setSdkQueryFactoryForTest(async () => {
    const q = makeHangQuery();
    queries.push(q);
    return q as never;
  });

  // 场景 A（守卫③）：sendMessage → runQuery 停在 cancelCommandProbe await → 同步块内删除会话
  //（模拟 50ms 删除窗内的竞态：markSessionDeleted + DB 删行）→ runQuery 恢复。
  const sessionA = sessionRepoStub.createSession('del-race', 'sonnet', null);
  sdk.spawnForChat(sessionA.id, win as never, { userCommandText: '删除竞态消息' });
  sdk.sendMessage(sessionA.id, '删除竞态消息');
  // 同一同步栈内执行删除——微任务里的 runQuery 恢复必然晚于本行。
  sdk.markSessionDeleted(sessionA.id);
  sessionRepoStub.deleteSession(sessionA.id);
  await sleep(300);
  check('行为A 删除竞态下不产生孤儿回合（factory 未被调，query 未起）', queries.length === 0,
    `queries=${queries.length}（=1 则 entry 被复活、孤儿回合已烧起）`);

  // 场景 B（守卫②）：已删除会话再 spawnForChat——拒绝复活，不占坑。
  let threw = '';
  try {
    sdk.spawnForChat(sessionA.id, win as never, { userCommandText: '复活尝试' });
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  check('行为B 已删除会话的 spawn 被拒绝（markSessionActive 不复活）',
    threw.includes('已删除'), `throw=${threw || '(无异常)'}`);

  // 清理。
  queries.forEach((q) => q.fail(new Error('cleanup')));
  await sleep(100);
  sdk.__setSdkQueryFactoryForTest(null);

  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
