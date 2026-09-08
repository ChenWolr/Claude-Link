// tdd-bugfix-p1-01-replay-turnflag-verify.ts
// P1-1 契约钉：reasoning_replay 回合错误标记跨回合残留 → 成功回合被原样重发（重复回复+重复计费）。
//
// 根因：turnHasReasoningReplayError（per-session Set）只在「调度自动重试」入口消费（delete）；
// 回合 A 命中后被中断/流异常收尾（catch 分支不消费）→ 标记残留 → 回合 B 成功后 result 出口
// 消费到 A 的残留标记，把 B 的 lastUserText 2s 后原样重发。
//
// 修复语义：回合起步（runQuery 状态重置段 + resume 重试二次起步）必清标记；
// 正常「命中→自动重试」链路不变；中断后下一回合不再被重发。
//
// 验证手法（复用 tdd-reasoning-replay-resilience-verify 的 seam）：mock electron/connection/
// session-repo，驱动真实 runQuery/forwardEvent/落库路径 + 结构文本契约钉清flag调用点。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-01-replay-turnflag-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 1. 结构契约（先于行为，直接读源码）──
const repoRoot = path.resolve(__dirname, '..');
const rel = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const backend = rel('src/main/modules/sdk-backend.ts');
const replayModule = rel('src/main/modules/reasoning-replay-auto-retry.ts');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function windowAfter(src: string, anchor: string, target: string, radius = 300): boolean {
  const at = src.indexOf(anchor);
  if (at === -1) return false;
  return src.slice(at, at + anchor.length + radius).includes(target);
}

scheck('结构① replay 模块导出回合级清flag函数 clearReasoningReplayTurnFlag',
  replayModule.includes('export function clearReasoningReplayTurnFlag('));
scheck('结构② runQuery 回合起步重置段（resetStallTracker 附近）调用 clearReasoningReplayTurnFlag',
  windowAfter(backend, 'resetStallTracker(sessionId)', 'clearReasoningReplayTurnFlag(sessionId)'));
scheck('结构③ resume 重试二次起步（新 query = 新回合注释附近）同样清flag',
  windowAfter(backend, '// 新 query = 新回合，重置终态追踪', 'clearReasoningReplayTurnFlag(sessionId)'));
scheck('结构④ 清flag调用点 ≥3 处（起步 + 两处 resume 重试），且不误用会话级 clearReasoningReplayState 顶替',
  (backend.match(/clearReasoningReplayTurnFlag\(sessionId\)/g) ?? []).length >= 3);

// ── 2. 行为 seam：回合 A 流异常收尾（不消费标记）→ 回合 B 成功 → 不得重发 B 文本 ──
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-replayflag-ud-'));
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

const origLoad = Module._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

const { spawnForChat, sendMessage, __setSdkQueryFactoryForTest } = require('../src/main/modules/sdk-backend');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath, autoRetryReasoningReplay: true });

const ERROR_TEXT = 'API Error: 400 The `reasoning_content` in the thinking mode must be passed back to the API.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeFakeQuery(events: Record<string, unknown>[], throwAfter = false) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
      if (throwAfter) throw new Error('stream broke mid-turn (simulated interruption tail)');
    },
    async interrupt() { /* no-op */ },
    async getContextUsage() {
      return { maxTokens: 0, rawMaxTokens: 0, totalTokens: 0, percentage: 0 };
    },
    close() { /* no-op */ },
  };
}

const assistantErrorEvent = {
  type: 'assistant',
  message: { role: 'assistant', content: [{ type: 'text', text: ERROR_TEXT }] },
  session_id: 'cli-fake-sid',
  parent_tool_use_id: null,
};
const okResult = { type: 'result', subtype: 'success', is_error: false, result: 'ok' };

let factoryCalls = 0;

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  const session = sessionRepoStub.createSession('replay-flag-test', 'sonnet', null);
  const win = {
    webContents: { send: () => { /* 事件流不关心 */ } },
    isDestroyed: () => true,
    isFocused: () => true,
  };

  // 回合 A：命中 reasoning_replay 错误正文（打标记）→ 流中途抛错（catch 收尾，不消费标记）。
  __setSdkQueryFactoryForTest(async () => { factoryCalls += 1; return makeFakeQuery([assistantErrorEvent], true) as never; });
  factoryCalls = 0;
  const handleA = spawnForChat(session.id, win as never, { userCommandText: '第一问' });
  const exitA = new Promise<void>((r) => handleA.on('exit', () => r()));
  sendMessage(session.id, '第一问');
  await exitA;
  await sleep(2600); // 若 A 被消费会在此窗口重发——验证「异常收尾不消费」前提
  check('行为① 回合 A 异常收尾本身不触发自动重发（前提：标记未被消费）',
    factoryCalls === 1, `factoryCalls=${factoryCalls}`);

  // 回合 B：干净成功回合。若起步清了残留标记 → 不得重发 B 文本；RED 状态下残留标记
  // 会被 B 的 result 出口消费 → 2s 后原样重发 '第二问'（factory 第 2 次调用）。
  __setSdkQueryFactoryForTest(async () => { factoryCalls += 1; return makeFakeQuery([okResult]) as never; });
  const handleB = spawnForChat(session.id, win as never, { userCommandText: '第二问' });
  const exitB = new Promise<void>((r) => handleB.on('exit', () => r()));
  sendMessage(session.id, '第二问');
  await exitB;
  await sleep(2600);
  check('行为② 中断残留标记不串回合：B 成功回合后无原样重发（factoryCalls 停在 2：A+B）',
    factoryCalls === 2, `factoryCalls=${factoryCalls}（若=3 则 B 被残留标记重发）`);

  __setSdkQueryFactoryForTest(null);
  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
