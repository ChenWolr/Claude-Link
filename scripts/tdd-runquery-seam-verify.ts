// tdd-runquery-seam-verify.ts
// review-v5 条件 3：runQuery 生产链路 seam 测试——生产 runQuery 事件收口验证（selftest 门禁）。
//
// 验证目标：__setSdkQueryFactoryForTest 注入 fake query 驱动真实 runQuery/forwardEvent，断言
// init_write_skipped / aborted 的「事件收口」（runQuery 恰好发一次、不漏不重）。
//
// 关键设计（report-v2 之后修正）：
//  - forwardEvent 先 IPC send、后 persistCliEvent（DB），且 persistCliEvent 抛错被 try/catch 吞掉。
//    所以只需 spy mainWindow.webContents.send 即可验证事件收口，**不依赖真实 DB 写入**。
//  - better-sqlite3 为 Electron ABI 编译，tsx（系统 Node）加载即 ABI 炸。解法：mock connection 模块
//    返回极简 fakeDb——所有 repo 用 `import { getConnection } from '../connection'`（运行时），
//    mock connection 后它们不再 require better-sqlite3。fakeDb 错误被 forwardEvent 吞，不影响 IPC。
//  - session-repo.createSession 在 run 后 getSession().get() 查回，fakeDb.get 返回 undefined 会抛，
//    故额外 stub session-repo（createSession/getSession/updateCliSessionId/updateLastContext）。
//  - message-repo 等其余 repo 真实跑在 fakeDb 上（错误被吞）。
//
// 仅 2 个模块被 mock（connection + session-repo），验证 runQuery 稳定的事件收口行为，不脆弱。

// ── 1. 在 require 任何主进程模块之前装 _load hook（electron + connection + session-repo）──
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-seam-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

// 极简 fakeDb：prepare/run/all/get/transaction/pragma/exec。错误会被 forwardEvent catch 吞。
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

// session-repo stub：createSession 在 fakeDb 下会因 getSession().get() 返回 undefined 而抛，故 stub。
const sessions = new Map<string, Record<string, unknown>>();
const sessionRepoStub = {
  createSession: (name: string, model: string, workingDir: string | null) => {
    const id = uuidv4();
    const s = { id, name, model, workingDir: workingDir ?? null, cliSessionId: null as string | null };
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
};

const origLoad = Module._load;
Module._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  // connection：repo 用 '../connection' 或 '.../database/connection' 引用。
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// ── 2. 现在可安全 require 主进程模块（better-sqlite3 永不被加载）──
const sessionRepo = require('../src/main/database/repositories/session-repo');
const {
  spawnForChat,
  sendMessage,
  __setSdkQueryFactoryForTest,
} = require('../src/main/modules/sdk-backend');

// resolveExecutable(null) 直接返回 undefined，会触发 runQuery 前置「未检测到本地 Claude Code」拦截。
// fake factory 不真实启动 CLI，但需绕过该检查：把 cliPath 设为一个存在的可执行文件（node 自身）。
const { saveConfig } = require('../src/main/modules/config-manager');
saveConfig({ cliPath: process.execPath });

// ── 3. IPC spy：forwardEvent 先 IPC send，后 persistCliEvent；spy 收集所有 CHAT_EVENT 的 event ──
function makeSpyWindow(sink: Record<string, unknown>[]) {
  return {
    webContents: {
      send: (_channel: string, payload: { sessionId: string; event: Record<string, unknown> }) => {
        if (payload && payload.event) sink.push(payload.event);
      },
    },
    // isDestroyed=true → notifySession 的 buildSessionNotification 前置守卫直接返回，不构造 Notification。
    isDestroyed: () => true,
    isFocused: () => true,
  };
}

// fake query：runQuery 对 query 的最小用法（async iterator + interrupt + getContextUsage + close）。
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

async function runTurn(
  events: Record<string, unknown>[],
  workDir: string,
  userCommandText: string,
): Promise<{ ipc: Record<string, unknown>[]; exitCode: number | null | undefined }> {
  const session = sessionRepo.createSession('seam-test', 'sonnet', workDir);
  const ipc: Record<string, unknown>[] = [];
  const handle = spawnForChat(session.id, makeSpyWindow(ipc), {
    userCommandText,
    workingDir: workDir,
  });
  let exitCode: number | null | undefined;
  const done = new Promise<void>((resolve) => {
    handle.on('exit', (c: number | null) => {
      exitCode = c;
      resolve();
    });
  });
  __setSdkQueryFactoryForTest(async () => makeFakeQuery(events) as any);
  sendMessage(session.id, userCommandText);
  await done;
  return { ipc, exitCode };
}

function countBy(ipc: Record<string, unknown>[], type: string, subtype?: string): number {
  return ipc.filter(
    (e) => e.type === type && (subtype === undefined || e.subtype === subtype),
  ).length;
}

(async () => {
  let pass = 0;
  let fail = 0;
  const check = (name: string, cond: boolean, detail = '') => {
    if (cond) {
      pass++;
      console.log(`  ✅ ${name}`);
    } else {
      fail++;
      console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
    }
  };

  console.log('=== runQuery seam verify（review-v5 条件 3：生产 runQuery 事件收口，IPC spy）===');

  // 场景 1：/init result 到达但 CLAUDE.md 未创建（空目录）→ forwardEvent 发 init_write_skipped 恰好 1 次。
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-init-empty-'));
    const { ipc, exitCode } = await runTurn(
      [
        { type: 'system', subtype: 'init', session_id: 'cli-fake-sid-1' },
        { type: 'result', subtype: 'success', is_error: false, result: '空目录无内容可分析' },
      ],
      workDir,
      '/init',
    );
    const errMsg = (ipc.find((e) => e.type === 'error') as { message?: string } | undefined)?.message;
    if (errMsg) console.log('  ⚠ 场景① runQuery error:', errMsg);
    check(
      '① result 到达 + CLAUDE.md 未创建 → init_write_skipped 事件恰好 1 次（事件收口）',
      countBy(ipc, 'system', 'init_write_skipped') === 1,
      `实际 ${countBy(ipc, 'system', 'init_write_skipped')} 次；IPC 事件 type=[${ipc.map((e) => e.type + (e.subtype ? ':' + e.subtype : '')).join(',')}]`,
    );
    check('① 回合正常退出（exit 0）', exitCode === 0, `exitCode=${exitCode}`);
  }

  // 场景 2：流末无 result → runQuery 合成 aborted 恰好 1 次；且不误发 init_write_skipped（result 未到达）。
  {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-init-noresult-'));
    const { ipc, exitCode } = await runTurn(
      [{ type: 'system', subtype: 'init', session_id: 'cli-fake-sid-2' }],
      workDir,
      '/init',
    );
    check(
      '② 流末无 result → 合成 aborted 事件恰好 1 次（事件收口）',
      countBy(ipc, 'aborted') === 1,
      `实际 ${countBy(ipc, 'aborted')} 次；IPC 事件 type=[${ipc.map((e) => e.type + (e.subtype ? ':' + e.subtype : '')).join(',')}]`,
    );
    check(
      '② 无 result 不误发 init_write_skipped',
      countBy(ipc, 'system', 'init_write_skipped') === 0,
      `实际 ${countBy(ipc, 'system', 'init_write_skipped')} 次`,
    );
    check('② 回合退出（有终态 exit）', exitCode !== undefined, `exitCode=${exitCode}`);
  }

  __setSdkQueryFactoryForTest(null);
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
