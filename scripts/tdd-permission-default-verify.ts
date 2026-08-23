// tdd-permission-default-verify.ts
// 权限「全局默认 + 会话覆盖」行为级 seam 自测（selftest 门禁）。
//
// 验证目标：
//   1. 聊天主链路经 SDK query() 而非原生 spawn —— 用 __setSdkQueryFactoryForTest 注入 fake query
//      工厂，捕获 sdk.query(params) 收到的 options.permissionMode。工厂被调用即证明走的是 SDK 路径；
//      若走原生 spawn，工厂不会被调用、测试直接失败。
//   2. 回落语义：会话 permissionMode 为 null/未设 → 回落全局默认 config.permissionMode；
//      会话显式设档 → 以会话档为准（resolveEffectivePermissionMode 行为）。
//
// 复用 tdd-runquery-seam-verify 的 seam 手法（mock electron + connection + session-repo，
// 避免 better-sqlite3 ABI 炸），但**不 stub sdk-backend 的 buildSdkOptions**——驱动真实生产 options 组装。
//
// 运行：npx tsx scripts/tdd-permission-default-verify.ts

// ── 1. 在 require 任何主进程模块之前装 _load hook（electron + connection + session-repo）──
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-perm-ud-'));
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

// session-repo stub：createSession 在 fakeDb 下会因 getSession().get() 返回 undefined 而抛，故 stub。
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
const { saveConfig, getConfig } = require('../src/main/modules/config-manager');

// cliPath 设为 node 自身（存在的可执行文件），绕过 runQuery 的「未检测到本地 Claude Code」前置拦截。
saveConfig({ cliPath: process.execPath });

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

// 驱动一回合，返回 SDK query 工厂收到的 options 快照（含 permissionMode）+ IPC 事件 + 退出码。
async function runTurn(opts: {
  permissionMode?: string | null;
  globalPermissionMode?: string;
}): Promise<{
  sdkOptionsPermissionMode: unknown;
  factoryCalls: number;
  ipc: Record<string, unknown>[];
  exitCode: number | null | undefined;
}> {
  if (opts.globalPermissionMode !== undefined) {
    saveConfig({ permissionMode: opts.globalPermissionMode as never });
  }
  const session = sessionRepoStub.createSession('perm-test', 'sonnet', null);
  const ipc: Record<string, unknown>[] = [];
  const handle = spawnForChat(session.id, makeSpyWindow(ipc), {
    userCommandText: 'hello',
    ...(opts.permissionMode !== undefined ? { permissionMode: opts.permissionMode } : {}),
  });

  let exitCode: number | null | undefined;
  const done = new Promise<void>((resolve) => {
    handle.on('exit', (c: number | null) => {
      exitCode = c;
      resolve();
    });
  });

  let sdkOptionsPermissionMode: unknown = '__NOT_CALLED__';
  let factoryCalls = 0;
  __setSdkQueryFactoryForTest(async (params: { options: Record<string, unknown> }) => {
    factoryCalls += 1;
    sdkOptionsPermissionMode = params.options.permissionMode;
    return makeFakeQuery([
      { type: 'system', subtype: 'init', session_id: 'cli-fake-sid' },
      { type: 'result', subtype: 'success', is_error: false, result: 'ok' },
    ]) as never;
  });

  sendMessage(session.id, 'hello');
  await done;
  return { sdkOptionsPermissionMode, factoryCalls, ipc, exitCode };
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

  console.log('=== 权限「全局默认 + 会话覆盖」seam 自测（真实 buildSdkOptions + fake sdk.query）===');

  // 场景 1：全局默认 = plan，会话未设（null/未传）→ sdk.query options.permissionMode 回落 'plan'。
  {
    const r = await runTurn({ globalPermissionMode: 'plan' });
    check(
      '① 会话未设权限 + 全局默认 plan → sdk.query 收到 permissionMode="plan"（回落全局默认）',
      r.sdkOptionsPermissionMode === 'plan',
      `实际=${String(r.sdkOptionsPermissionMode)}`,
    );
    check('① 聊天走 SDK query 路径（工厂被调用，非原生 spawn）', r.factoryCalls === 1, `factoryCalls=${r.factoryCalls}`);
    check('① 回合正常退出（exit 0）', r.exitCode === 0, `exitCode=${r.exitCode}`);
  }

  // 场景 2：全局默认 = plan，会话显式 bypassPermissions → 会话档优先。
  {
    const r = await runTurn({ globalPermissionMode: 'plan', permissionMode: 'bypassPermissions' });
    check(
      '② 会话显式 bypassPermissions → sdk.query 收到 "bypassPermissions"（会话覆盖全局）',
      r.sdkOptionsPermissionMode === 'bypassPermissions',
      `实际=${String(r.sdkOptionsPermissionMode)}`,
    );
    check('② 聊天走 SDK query 路径（工厂被调用）', r.factoryCalls === 1, `factoryCalls=${r.factoryCalls}`);
  }

  // 场景 3：会话显式传 null（跟随全局默认）→ 回落全局默认。
  {
    const r = await runTurn({ globalPermissionMode: 'acceptEdits', permissionMode: null });
    check(
      '③ 会话显式 null（跟随全局）+ 全局 acceptEdits → sdk.query 收到 "acceptEdits"',
      r.sdkOptionsPermissionMode === 'acceptEdits',
      `实际=${String(r.sdkOptionsPermissionMode)}`,
    );
  }

  // 场景 4：全局默认脏值回落（getConfig 清洗）——config 层保证 resolveEffective 输入恒合法。
  {
    const before = getConfig();
    check('④ 全局默认读回恒为合法四档之一（getConfig 脏值清洗）',
      ['default', 'plan', 'acceptEdits', 'bypassPermissions'].includes(before.permissionMode),
      `实际=${before.permissionMode}`);
  }

  __setSdkQueryFactoryForTest(null);
  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
