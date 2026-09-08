// tdd-bugfix-n4-replay-skip-attachments-verify.ts
// N4（P2）契约钉：reasoning_replay 自动重试对带附件回合照发且只发纯文本——
// 模块头自称「不重试带附件回合」但实现无任何附件门控；重试落一条无附件重复 user 行
// 污染历史，模型回复「没看到图」。
//
// 修复语义：CHAT_SEND 的 spawnForChat 调用处把 prepared 附件信息传入 SpawnOptions
//（hasAttachments），recordOutgoingUserText 命中即不记录——无重试载体则终态出口不调度重发。
// 纯文本回合的自动重试链路不变。
//
// 验证手法（复用 p1-01 的 runQuery 行为 seam）：mock electron/connection/session-repo，
// 驱动真实 spawnForChat/sendMessage/落库路径，断言附件回合错误后不自动重发。
//
// 运行：npx tsx scripts/tdd-bugfix-n4-replay-skip-attachments-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// ── 1. 结构契约 ──
const repoRoot = path.resolve(__dirname, '..');
const rel = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const backend = rel('src/main/modules/sdk-backend.ts');
const replayModule = rel('src/main/modules/reasoning-replay-auto-retry.ts');
const cliShared = rel('src/main/modules/cli-shared.ts');
const ipcHandlers = rel('src/main/ipc-handlers.ts');

let spass = 0;
let sfail = 0;
function scheck(name: string, cond: boolean, detail = ''): void {
  if (cond) { spass += 1; console.log(`  ✅ ${name}`); }
  else { sfail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

scheck('结构① SpawnOptions 声明 hasAttachments', cliShared.includes('hasAttachments?: boolean;'));
scheck('结构② recordOutgoingUserText 接收附件门控参数（命中即不记录）',
  /export function recordOutgoingUserText\([^)]*hasAttachments\??: boolean[^)]*\)/.test(replayModule)
  || /recordOutgoingUserText\([\s\S]{0,200}?\??:\s*boolean/.test(replayModule));
scheck('结构③ CHAT_SEND 调用处传入附件信息（prepared.attachmentIds 长度）',
  /hasAttachments:\s*[\w.]+\.attachmentIds\.length > 0/.test(ipcHandlers));
scheck('结构④ 模块头注释与实现对齐（附件回合不记录重试载体）',
  /recordOutgoingUserText[\s\S]{0,300}?带附件回合/.test(replayModule)
  || /带附件回合[\s\S]{0,200}?recordOutgoingUserText/.test(replayModule));

// ── 2. 行为 seam：附件回合错误后不自动重发；纯文本回合照常重发 ──
const Module = require('module');
const os = require('os');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-n4replay-ud-'));
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

function makeFakeQuery(events: Record<string, unknown>[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
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
  const session = sessionRepoStub.createSession('n4-replay-skip-att', 'sonnet', null);
  const win = {
    webContents: { send: () => { /* 事件流不关心 */ } },
    isDestroyed: () => true,
    isFocused: () => true,
  };

  // 回合 A：带附件回合（hasAttachments: true）命中 reasoning_replay 错误后正常 result。
  // 修复后：附件文本不记录 → 终态出口无重试载体 → 不自动重发（factoryCalls 停 1）。
  // RED 状态：无附件门控 → 文本被记录 → 2s 后原样重发（factoryCalls=2）。
  __setSdkQueryFactoryForTest(async () => { factoryCalls += 1; return makeFakeQuery([assistantErrorEvent, okResult]) as never; });
  factoryCalls = 0;
  const handleA = spawnForChat(session.id, win as never, { userCommandText: '帮我看这张图', hasAttachments: true });
  const exitA = new Promise<void>((r) => handleA.on('exit', () => r()));
  sendMessage(session.id, '帮我看这张图');
  await exitA;
  await sleep(2600);
  check('行为① 带附件回合命中 reasoning_replay 错误后不自动重发（factoryCalls 停 1）',
    factoryCalls === 1, `factoryCalls=${factoryCalls}（若=2 则附件回合被纯文本重发）`);

  // 回合 B：纯文本回合命中同样错误 → 自动重试链路不变（2.6s 内 factory 第 2 次调用）。
  factoryCalls = 0; // 只统计 B 段：B 本体 + B 的自动重发
  __setSdkQueryFactoryForTest(async () => { factoryCalls += 1; return makeFakeQuery([assistantErrorEvent, okResult]) as never; });
  const handleB = spawnForChat(session.id, win as never, { userCommandText: '纯文本提问' });
  const exitB = new Promise<void>((r) => handleB.on('exit', () => r()));
  sendMessage(session.id, '纯文本提问');
  await exitB;
  await sleep(2600);
  check('行为② 纯文本回合自动重试链路不变（factoryCalls=2：B+重发）',
    factoryCalls === 2, `factoryCalls=${factoryCalls}（若=1 则纯文本重试被误伤）`);

  __setSdkQueryFactoryForTest(null);
  const totalFail = sfail + fail;
  console.log(`\nverify 结果：结构 ${spass} passed/${sfail} failed，行为 ${pass} passed/${fail} failed`);
  process.exit(totalFail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
