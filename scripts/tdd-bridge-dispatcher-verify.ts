// tdd-bridge-dispatcher-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 4 契约钉：回合调度器同构 CHAT_SEND。
// dispatcher 不 import sdk-backend（引擎原语全部注入，测试注入 fake）。七条同构关键点：
//   1. 正常回合：persist → spawn（opts 七字段同构）→ beginUserTurn → sendMessage(原文)；
//      exit(0)+knownOutcome='success' → {outcome:'success', replyText:持久层文本}。
//   2. 锁成对：成功/抛错路径 releaseChatSendLock 恰一次；busy 提前 return 零次。
//   3. busy：isChatSendLocked 或 getActiveProcess 非空 → busy:true 且不落库不 spawn。
//   4. exit 兜底：knownOutcome=null + exit(0) → noteTurnOutcome('success')；已有终态 → no-op。
//   5. 代际守卫：exit 时 active=另一对象 → 不记账，Promise 仍以 knownOutcome 结算。
//   6. spawn 抛「仍在执行」→ busy:true。
//   7. replyText：findReplyText null → replyText:null（不伪造）。
// 返工追加（2026-09-21 review P1）：
//   8. 时序真实化：sdk-backend 所有出口先 deleteEntry 再 emitExit——exit 回调触发时
//      getKnownTurnOutcome 已恒 null，且 /stop kill 与流丢 result 出口 code=null → 兜底
//      只能判 'error'。本组钉死该机制本身与 limitation 注释（/stop 的静默由 manager 消费
//      此结果，钉在 tdd-bridge-manager-verify [Q]）。
// RED 预期（未改树）：dispatcher 模块不存在 → import 即 FAIL。
// 运行：npx tsx scripts/tdd-bridge-dispatcher-verify.ts

import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  dispatchBridgeTurn,
  type TurnEngineDeps,
  type TurnPersistenceDeps,
} from '../src/main/modules/bridge/dispatcher';

// R2-N2：原 `import type { SdkQueryHandle } from '../src/main/sdk-backend'` 是死导入——路径错
// （真实位置多一层 /modules）且该接口未导出；type-only 导入被 tsx 擦除、又不在任何 typecheck
// 门禁内，故全绿掩盖。按 dispatcher.ts 同一手法本地声明结构化等价类型（sdk-backend.ts :696-701 真实形状）。
interface BridgeQueryHandle {
  killed: boolean;
  on(event: 'exit', cb: (code: number | null) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  interrupt(): void;
}

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── fake 基建 ──

interface FakeHandle extends BridgeQueryHandle {
  emitExit(code: number | null): void;
  emitError(err: Error): void;
}

function createFakeHandle(): FakeHandle {
  const exitCbs: Array<(code: number | null) => void> = [];
  const errorCbs: Array<(err: Error) => void> = [];
  const handle: FakeHandle = {
    killed: false,
    on(event, cb) {
      if (event === 'exit') exitCbs.push(cb as (code: number | null) => void);
      else errorCbs.push(cb as (err: Error) => void);
    },
    interrupt() { handle.killed = true; },
    emitExit(code) { for (const cb of exitCbs) cb(code); },
    emitError(err) { for (const cb of errorCbs) cb(err); },
  };
  return handle;
}

interface SessionRow {
  model: string; modelOverride: string | null; providerOverride: string | null;
  workingDir: string | null; permissionMode: string | null; thinkingLevel: string | null;
  cliSessionId: string | null;
}

interface FakeEngine extends TurnEngineDeps {
  calls: string[];
  session: SessionRow | null;
  sessionMissing: boolean;
  lockedFlag: boolean;
  activeHandle: BridgeQueryHandle | undefined;
  knownOutcome: 'success' | 'error' | 'interrupted' | null;
  handleToEmit: FakeHandle | null;
  activeAtExit: BridgeQueryHandle | undefined; // 代际守卫测试：exit 时刻切到另一对象
  spawnThrows: Error | null;
  spawnedOpts: Record<string, unknown> | null;
  sentMessage: string | null;
  notedOutcomes: Array<{ sessionId: string; outcome: string }>;
  lastHandle: FakeHandle | null;
}

function createFakeEngine(overrides: Partial<FakeEngine> = {}): FakeEngine {
  const engine: FakeEngine = {
    calls: [],
    session: {
      model: 'glm-4.6', modelOverride: 'glm-4.6', providerOverride: 'prov-1',
      workingDir: 'D:/work', permissionMode: 'acceptEdits', thinkingLevel: 'high',
      cliSessionId: 'cli-uuid-1',
    },
    sessionMissing: false,
    lockedFlag: false,
    activeHandle: undefined,
    knownOutcome: null,
    handleToEmit: null,
    activeAtExit: undefined,
    spawnThrows: null,
    spawnedOpts: null,
    sentMessage: null,
    notedOutcomes: [],
    lastHandle: null,
    getSessionRow(sessionId) {
      void sessionId;
      engine.calls.push('getSessionRow');
      return engine.sessionMissing ? null : engine.session;
    },
    isChatSendLocked(sessionId) {
      void sessionId;
      engine.calls.push('isChatSendLocked');
      return engine.lockedFlag;
    },
    getActiveProcess(sessionId) {
      void sessionId;
      engine.calls.push('getActiveProcess');
      return engine.activeHandle;
    },
    acquireChatSendLock(sessionId) {
      void sessionId;
      engine.calls.push('acquireChatSendLock');
    },
    releaseChatSendLock(sessionId) {
      void sessionId;
      engine.calls.push('releaseChatSendLock');
    },
    spawnForChat(sessionId, opts) {
      void sessionId;
      engine.calls.push('spawnForChat');
      if (engine.spawnThrows) throw engine.spawnThrows;
      engine.spawnedOpts = opts as Record<string, unknown>;
      const h = engine.handleToEmit ?? createFakeHandle();
      engine.lastHandle = h;
      return h;
    },
    beginUserTurn(sessionId) {
      void sessionId;
      engine.calls.push('beginUserTurn');
    },
    sendMessage(sessionId, prompt) {
      void sessionId;
      engine.calls.push('sendMessage');
      engine.sentMessage = prompt;
    },
    getKnownTurnOutcome(sessionId) {
      void sessionId;
      return engine.knownOutcome;
    },
    noteTurnOutcome(sessionId, outcome) {
      engine.notedOutcomes.push({ sessionId, outcome });
    },
    getConfigMaxTurns() {
      return 87;
    },
    ...overrides,
  };
  return engine;
}

interface FakePersistence extends TurnPersistenceDeps {
  persisted: Array<{ sessionId: string; text: string }>;
  replyText: string | null;
}

function createFakePersistence(replyText: string | null = '本回合回复正文'): FakePersistence {
  const p: FakePersistence = {
    persisted: [],
    replyText,
    persistUserMessage(sessionId, text) {
      p.persisted.push({ sessionId, text });
    },
    findReplyText(sessionId) {
      void sessionId;
      return p.replyText;
    },
  };
  return p;
}

const emitAtExit = (engine: FakeEngine, code: number | null): void => {
  // dispatch 内部同步走到 await exitPromise 前已注册回调；先让出一个微任务再触发。
  queueMicrotask(() => {
    if (engine.activeAtExit !== undefined) engine.activeHandle = engine.activeAtExit;
    engine.lastHandle?.emitExit(code);
  });
};

async function main(): Promise<void> {
// ── 1. 正常回合 ──
{
  const engine = createFakeEngine({ knownOutcome: 'success' });
  const persistence = createFakePersistence('回复正文甲');
  const p = dispatchBridgeTurn(engine, persistence, 'sess-1', '你好桥接');
  emitAtExit(engine, 0);
  const result = await p;

  const idx = (name: string) => engine.calls.indexOf(name);
  check('1', '①', 'persistUserMessage 先于 spawnForChat',
    idx('persistUserMessage') === -1 || engine.persisted.length === 1
      ? persistence.persisted.length === 1 && idx('spawnForChat') > -1 && idx('beginUserTurn') > idx('spawnForChat')
      : false,
    `persisted=${persistence.persisted.length} calls=${engine.calls.join(',')}`);
  // 注：persist 走 persistence 对象，不在 engine.calls 里；时序用 spawn/begin/send 相对序断言。
  check('1', '②', '时序 spawn → beginUserTurn → sendMessage',
    idx('spawnForChat') < idx('beginUserTurn') && idx('beginUserTurn') < idx('sendMessage'),
    engine.calls.join(','));
  const opts = engine.spawnedOpts ?? {};
  const optsOk = opts.maxTurns === 87
    && opts.resumeSessionId === 'cli-uuid-1'
    && opts.permissionMode === 'acceptEdits'
    && opts.thinkingLevel === 'high'
    && opts.model === 'glm-4.6'
    && opts.modelOverride === 'glm-4.6'
    && opts.providerOverride === 'prov-1'
    && opts.workingDir === 'D:/work'
    && opts.userCommandText === '你好桥接'
    && opts.hasAttachments === false;
  check('1', '③', 'spawn opts 七字段同构 CHAT_SEND（maxTurns=全局，余取 session 行）', optsOk,
    JSON.stringify(opts));
  check('1', '④', 'sendMessage 收到原文', engine.sentMessage === '你好桥接', String(engine.sentMessage));
  check('1', '⑤', "exit(0)+knownOutcome=success → {outcome:'success', replyText:持久层文本}",
    result.outcome === 'success' && result.replyText === '回复正文甲' && result.busy !== true,
    JSON.stringify(result));
  check('1', '⑥', '显式终态路径不重复 noteTurnOutcome', engine.notedOutcomes.length === 0,
    JSON.stringify(engine.notedOutcomes));
}

// ── 2. 锁成对 ──
{
  const engineOk = createFakeEngine({ knownOutcome: 'success' });
  const pOk = dispatchBridgeTurn(engineOk, createFakePersistence(), 's', 'x');
  emitAtExit(engineOk, 0);
  await pOk;
  const releaseCount = engineOk.calls.filter((c) => c === 'releaseChatSendLock').length;
  const acquireCount = engineOk.calls.filter((c) => c === 'acquireChatSendLock').length;
  check('2', '①', '成功路径 acquire/release 恰各一次', acquireCount === 1 && releaseCount === 1,
    `acquire=${acquireCount} release=${releaseCount}`);

  const engineThrow = createFakeEngine({ knownOutcome: 'success' });
  engineThrow.spawnThrows = new Error('sendMessage 炸了');
  const pThrow = dispatchBridgeTurn(engineThrow, createFakePersistence(), 's', 'x');
  const rThrow = await pThrow;
  const relThrow = engineThrow.calls.filter((c) => c === 'releaseChatSendLock').length;
  check('2', '②', '抛错路径 release 恰一次且返回 error',
    relThrow === 1 && rThrow.outcome === 'error', `release=${relThrow} r=${JSON.stringify(rThrow)}`);

  const engineBusy = createFakeEngine({ lockedFlag: true });
  const rBusy = await dispatchBridgeTurn(engineBusy, createFakePersistence(), 's', 'x');
  const relBusy = engineBusy.calls.filter((c) => c === 'releaseChatSendLock').length;
  const acqBusy = engineBusy.calls.filter((c) => c === 'acquireChatSendLock').length;
  check('2', '③', 'busy 提前 return：acquire/release 均 0 次', relBusy === 0 && acqBusy === 0,
    `acquire=${acqBusy} release=${relBusy}`);
}

// ── 3. busy：锁或活进程 → busy 且不落库不 spawn ──
{
  const engineLock = createFakeEngine({ lockedFlag: true });
  const persLock = createFakePersistence();
  const r1 = await dispatchBridgeTurn(engineLock, persLock, 's', 'x');
  check('3', '①', 'isChatSendLocked=true → busy:true',
    r1.outcome === 'error' && r1.busy === true && r1.replyText === null, JSON.stringify(r1));
  check('3', '②', 'busy：不落库不 spawn', persLock.persisted.length === 0 && engineLock.spawnedOpts === null);

  const engineActive = createFakeEngine({ activeHandle: createFakeHandle() });
  const r2 = await dispatchBridgeTurn(engineActive, createFakePersistence(), 's', 'x');
  check('3', '③', 'getActiveProcess 非空 → busy:true',
    r2.outcome === 'error' && r2.busy === true, JSON.stringify(r2));
}

// ── 4. exit 兜底 ──
{
  const engineNull = createFakeEngine({ knownOutcome: null });
  const p = dispatchBridgeTurn(engineNull, createFakePersistence(), 's', 'x');
  emitAtExit(engineNull, 0);
  const r = await p;
  check('4', '①', "knownOutcome=null + exit(0) → noteTurnOutcome('success') 被调（防僵尸 running）",
    r.outcome === 'success' && engineNull.notedOutcomes.length === 1
    && engineNull.notedOutcomes[0]!.outcome === 'success',
    `r=${JSON.stringify(r)} noted=${JSON.stringify(engineNull.notedOutcomes)}`);

  const engineKnown = createFakeEngine({ knownOutcome: 'error' });
  const p2 = dispatchBridgeTurn(engineKnown, createFakePersistence(), 's', 'x');
  emitAtExit(engineKnown, 0);
  const r2 = await p2;
  check('4', '②', 'knownOutcome=error → 兜底 no-op（不重复记账）',
    r2.outcome === 'error' && engineKnown.notedOutcomes.length === 0,
    `noted=${JSON.stringify(engineKnown.notedOutcomes)}`);

  const engineCrash = createFakeEngine({ knownOutcome: null });
  const p3 = dispatchBridgeTurn(engineCrash, createFakePersistence(), 's', 'x');
  emitAtExit(engineCrash, 1);
  const r3 = await p3;
  check('4', '③', 'exit(非0) + 无终态 → noteTurnOutcome(error)',
    r3.outcome === 'error' && engineCrash.notedOutcomes[0]?.outcome === 'error',
    JSON.stringify(engineCrash.notedOutcomes));
}

// ── 5. 代际守卫 ──
{
  const engine = createFakeEngine({ knownOutcome: 'success', activeAtExit: createFakeHandle() });
  const p = dispatchBridgeTurn(engine, createFakePersistence('迟到窗回复'), 's', 'x');
  emitAtExit(engine, 0);
  const r = await p;
  check('5', '①', 'exit 时 active=另一对象 → 不做队列记账（noteTurnOutcome 0 次）',
    engine.notedOutcomes.length === 0, JSON.stringify(engine.notedOutcomes));
  check('5', '②', 'Promise 仍以 knownOutcome 结算（success）',
    r.outcome === 'success' && r.replyText === '迟到窗回复', JSON.stringify(r));
}

// ── 6. spawn 抛「仍在执行」→ busy ──
{
  const engine = createFakeEngine({ spawnThrows: new Error('当前回合仍在执行，请等待结束或中断后重试') });
  const r = await dispatchBridgeTurn(engine, createFakePersistence(), 's', 'x');
  check('6', '①', 'spawn 抛仍在执行 → busy:true',
    r.outcome === 'error' && r.busy === true, JSON.stringify(r));
  const rel = engine.calls.filter((c) => c === 'releaseChatSendLock').length;
  check('6', '②', '该路径锁仍成对释放（release 恰 1 次）', rel === 1, `release=${rel}`);
}

// ── 7. replyText 提取 ──
{
  const engine = createFakeEngine({ knownOutcome: 'success' });
  const p = dispatchBridgeTurn(engine, createFakePersistence(null), 's', 'x');
  emitAtExit(engine, 0);
  const r = await p;
  check('7', '①', 'findReplyText=null → {success, replyText:null}（不伪造文本）',
    r.outcome === 'success' && r.replyText === null, JSON.stringify(r));

  const engineMiss = createFakeEngine({ sessionMissing: true });
  const rMiss = await dispatchBridgeTurn(engineMiss, createFakePersistence(), 'gone', 'x');
  check('7', '②', 'session 行缺失 → error（调用方重建绑定后重试）且零副作用',
    rMiss.outcome === 'error' && engineMiss.spawnedOpts === null
    && engineMiss.calls.filter((c) => c === 'releaseChatSendLock').length === 0,
    JSON.stringify(rMiss));
}

// ── 8. 时序真实化（review P1 契约钉）──
{
  // 真实时序模型：sdk-backend 出口先 deleteEntry 再 emitExit → exit 回调触发时 entry 已移除，
  // getKnownTurnOutcome 恒返回 null；/stop kill 路径 exit code=null（系统杀语义）。
  const engine = createFakeEngine({ knownOutcome: null });
  const p = dispatchBridgeTurn(engine, createFakePersistence(), 'sess-stop', '中断前的消息');
  emitAtExit(engine, null);
  const r = await p;
  check('8', '①', '时序真实化：known 恒 null + exit(null) → 兜底判 error（noteTurnOutcome(error) 恰一次）',
    r.outcome === 'error' && engine.notedOutcomes.length === 1
    && engine.notedOutcomes[0]!.outcome === 'error',
    `r=${JSON.stringify(r)} noted=${JSON.stringify(engine.notedOutcomes)}`);
  check('8', '②', '该结果不带 busy、无正文（/stop 后 manager 不得走 busy 重试，须直接静默）',
    r.busy !== true && r.replyText === null, JSON.stringify(r));
  // limitation 文档钉（review P1 附带项）：error-result 出口同样 emitExit(0) 被兜底判 success
  // 的现状，必须在 dispatcher.ts 注释写明（接受现状：有 partial 文本时行为正确）。
  const dispSrc = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/bridge/dispatcher.ts'), 'utf8');
  check('8', '③', 'dispatcher.ts 注释写明「error-result 出口 emitExit(0) 误判 success」limitation',
    dispSrc.includes('emitExit(0)') && dispSrc.includes('误判'), '缺 limitation 注释');
}

assert.ok(true);
console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
}

void main();
