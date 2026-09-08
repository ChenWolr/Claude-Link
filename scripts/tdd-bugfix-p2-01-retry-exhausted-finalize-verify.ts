// tdd-bugfix-p2-01-retry-exhausted-finalize-verify.ts
// P2-1 契约钉：重试烧满后「流丢 result / SDK 异常」收尾 → exhausted 终态不落库、红灯与通知全丢。
//
// 修复语义：合成 aborted 出口、catch 非（P2-1）中断出口、killProcess watchdog 硬杀路径
// 均补调 finishApiRetryExhausted（未烧满/不在重试中时 recordApiRetryExhausted 边沿状态机
// 天然 no-op；多出口重复调用幂等——terminal 后再调返回 false）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-01-retry-exhausted-finalize-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function windowAfter(src: string, anchor: string, target: string, radius = 400): boolean {
  const at = src.indexOf(anchor);
  return at !== -1 && src.slice(at, at + anchor.length + radius).includes(target);
}

scheck('结构① 合成 aborted 出口（流丢 result）补记账',
  windowAfter(backend, 'if (isCurrentEntry(sessionId, entry) && !gotResult) {', 'finishApiRetryExhausted(sessionId, mainWindow, entry.queryInstance)'));
scheck('结构② catch 非（用户中断）出口补记账', (() => {
  const at = backend.indexOf('if (interruptedQueries.has(query)) {');
  const elseAt = backend.indexOf('} else {', at);
  return elseAt !== -1 && backend.slice(elseAt, elseAt + 400).includes('finishApiRetryExhausted(sessionId, mainWindow');
})());
scheck('结构③ killProcess watchdog 硬杀路径补记账',
  windowAfter(backend, "if (reason === 'watchdog' && mainWindow) {", 'finishApiRetryExhausted(sessionId, mainWindow', 300));

// ── 行为 seam：重试烧满（attempt=max_retries=1）→ 流抛错 → exhausted 终态可见 ──
const Module = require('module');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-p201-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
process.env.APPDATA = tmpUserData; // electron-store env-paths 回落隔离

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
    const id = `sid-${sessions.size + 1}`;
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

saveConfig({ cliPath: process.execPath, notifyOnLeave: false, minimizeToTray: false });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const session = sessionRepoStub.createSession('p201', 'sonnet', null);
  const events: Array<Record<string, unknown>> = [];
  const win = {
    webContents: {
      send: (_c: string, payload: { event?: Record<string, unknown> }) => {
        if (payload?.event) events.push(payload.event);
      },
    },
    isDestroyed: () => true,
    isFocused: () => true,
  };

  // 烧满重试（max_retries=1，attempt=1 已达限）后流抛错（非用户中断）。
  sdk.__setSdkQueryFactoryForTest(async () => ({
    async *[Symbol.asyncIterator]() {
      yield { type: 'system', subtype: 'api_retry', attempt: 1, max_retries: 1, retry_delay_ms: 5000, error: 'upstream 500' };
      throw new Error('stream died after retries burned');
    },
    async interrupt() { /* no-op */ },
    async getContextUsage() { return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 }; },
    close() { /* no-op */ },
  }) as never);

  const handle = sdk.spawnForChat(session.id, win as never, { userCommandText: '烧满后异常' });
  const exited = new Promise<void>((r) => handle.on('exit', () => r()));
  sdk.sendMessage(session.id, '烧满后异常');
  await exited;
  await sleep(300);

  const terminalEvents = events.filter((e) =>
    (e.type === 'persisted_message' && (e.message as { processKind?: string })?.processKind === 'system:api_retry_exhausted') ||
    e.type === 'api_retry_terminal');
  check('行为① 烧满后流异常收尾补落 exhausted 终态（persisted_message/api_retry_terminal 可见）',
    terminalEvents.length > 0,
    `events=[${events.map((e) => e.type).join(',')}]`);

  sdk.__setSdkQueryFactoryForTest(null);
  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
