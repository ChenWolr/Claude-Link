// tdd-reasoning-replay-resilience-verify.ts
// reasoning_replay（DeepSeek thinking 回传 400）韧性层 seam 自测（selftest 门禁）。
//
// 验证目标（复用 tdd-permission-default-verify 的 seam 手法：mock electron + connection +
// session-repo，驱动真实 runQuery/forwardEvent/落库路径）：
//   1. 全链路触发：assistant 正文命中 isReasoningReplayApiError → cli-shared 打
//      noteReasoningReplayError → 回合 result 终态 → ~2s 后同文本自动重发一次
//      （factory 第二次被调用）+ 转发 system:auto_retry 系统提示。
//   2. 防重入：同一会话同一文本只自动重试一次。
//   3. 设置开关：autoRetryReasoningReplay=false 时不重发。
//   4. 命令文本：'/' 前缀不作为重试载体。
//
// 运行：npx tsx scripts/tdd-reasoning-replay-resilience-verify.ts

// ── 1. 在 require 任何主进程模块之前装 _load hook（electron + connection + session-repo）──
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-retry-ud-'));
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
      id,
      name,
      model,
      workingDir: workingDir ?? null,
      cliSessionId: null as string | null,
      permissionMode: null as string | null,
      modelOverride: null as string | null,
      providerOverride: null as string | null,
      maxTurns: 200,
      thinkingLevel: null as string | null,
    };
    sessions.set(id, s);
    return s;
  },
  getSession: (id: string) => sessions.get(id) ?? null,
  updateCliSessionId: (id: string, sid: string | null) => {
    const s = sessions.get(id);
    if (s) s.cliSessionId = sid;
    return s ?? null;
  },
  updateLastContext: () => null,
  updateLastContextWindow: () => null,
  updateLastContextUsed: () => null,
};

const origLoad = Module._load;
Module._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// ── 2. 安全 require 主进程模块 ──
const { spawnForChat, sendMessage, __setSdkQueryFactoryForTest } = require('../src/main/modules/sdk-backend');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath });

const ERROR_TEXT = 'API Error: 400 The `reasoning_content` in the thinking mode must be passed back to the API.';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeSpyWindow(sink: Record<string, unknown>[]) {
  return {
    webContents: {
      send: (_channel: string, payload: { sessionId: string; event: Record<string, unknown> }) => {
        if (payload && payload.event) sink.push(payload.event);
      },
    },
    isDestroyed: () => true,
    isFocused: () => true,
  };
}

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
function installFactory() {
  factoryCalls = 0;
  __setSdkQueryFactoryForTest(async () => {
    factoryCalls += 1;
    return makeFakeQuery([assistantErrorEvent, okResult]) as never;
  });
}

async function waitFor(label: string, fn: () => boolean, timeoutMs = 6000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

// 发起一个「错误回合」：spawn（记录 userCommandText）→ 挂 exit 监听 → sendMessage 起 query。
// 传 reuseSessionId 时复用同一会话（防重入守卫按会话键控，场景 2 需要）。
// 返回 { promise, sessionId }；promise 在回合终态（exit）时 resolve，携带捕获的 IPC 事件流。
function runErrorTurnSync(userText: string, reuseSessionId?: string): {
  promise: Promise<{ ipc: Record<string, unknown>[] }>;
  sessionId: string;
} {
  const session = reuseSessionId
    ? sessionRepoStub.getSession(reuseSessionId)
    : sessionRepoStub.createSession('retry-test', 'sonnet', null);
  if (!session) throw new Error('session missing');
  const ipc: Record<string, unknown>[] = [];
  const win = makeSpyWindow(ipc);
  const handle = spawnForChat(session.id, win, { userCommandText: userText });
  const promise = new Promise<{ ipc: Record<string, unknown>[] }>((resolve) => {
    handle.on('exit', () => resolve({ ipc }));
    sendMessage(session.id, userText);
  });
  return { promise, sessionId: session.id };
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

(async () => {
  // 场景 1：全链路触发——错误回合结束后 ~2s 自动重发一次 + 系统提示可见。
  let session1 = '';
  {
    installFactory();
    const r0 = runErrorTurnSync('帮我查天气');
    session1 = r0.sessionId;
    const r = await r0.promise;
    await waitFor('第二次 query（自动重发）', () => factoryCalls >= 2);
    await sleep(300); // 留出第二回合事件 flush
    const notice = r.ipc.find((e) => (e as { subtype?: string }).subtype === 'auto_retry');
    check('① 错误回合后 ~2s 同文本自动重发（factory 第 2 次调用）', factoryCalls === 2, `factoryCalls=${factoryCalls}`);
    check('① 转发 system:auto_retry 系统提示', Boolean(notice), `ipc 子类型=[${r.ipc.map((e) => (e as { subtype?: string }).subtype ?? (e as { type?: string }).type).join(',')}]`);
    check('① 提示文案含「已自动重试」', Boolean(notice) && String((notice as { text?: string }).text).includes('已自动重试'));
  }

  // 场景 2：防重入——同一会话同一文本（重发回合自身再次报错）不再触发第三次。
  // 不重装 factory：计数延续场景 1（重发回合=第 2 次；本场景回合=第 3 次）。
  {
    const { promise } = runErrorTurnSync('帮我查天气', session1);
    await promise;
    await sleep(2600);
    check('② 同会话同文本只重试一次（factory 停在第 3 次调用）', factoryCalls === 3, `factoryCalls=${factoryCalls}`);
  }

  // 场景 3：设置关闭 → 不重发。
  {
    saveConfig({ autoRetryReasoningReplay: false });
    installFactory();
    const { promise } = runErrorTurnSync('换个任务');
    await promise;
    await sleep(2600);
    check('③ autoRetryReasoningReplay=false 不重发', factoryCalls === 1, `factoryCalls=${factoryCalls}`);
    saveConfig({ autoRetryReasoningReplay: true });
  }

  // 场景 4：命令文本不作为重试载体。
  {
    installFactory();
    const { promise } = runErrorTurnSync('/init');
    await promise;
    await sleep(2600);
    check('④ /命令文本错误回合不自动重发', factoryCalls === 1, `factoryCalls=${factoryCalls}`);
  }

  __setSdkQueryFactoryForTest(null);
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
