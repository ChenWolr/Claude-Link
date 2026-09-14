// scripts/tdd-bugfix-hb13-v-queue-retry-verify.ts
// hb13-v A1【队列】契约（行为级）：P2-11 重试机制四项缺陷修复验证。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-queue-tasks.md）：
//   F1/P1 重试闭包引用声明在后且早退路径不初始化的 runnable → 重试触发即 TDZ ReferenceError，
//         引擎卡 countdown(0)（静态契约全绿漏网，故本契约以 vm 抽取实跑）；
//   F2/P2 重试 2 次硬上限后裸 return 放弃 → 永久 countdown(0)，且重试 timer 不在 cancelTimers
//         收口范围；
//   F3/P2 countdown_started 回填的 intervalSeconds 快照被 state_changed 整体替换即时抹除 →
//         etaFor 快照优先从未生效；
//   F4/P2 popExecute 占坑复查命中收口 standby → 剥夺在飞用户回合的 running 归属，
//         回合结束 armAfterTurn/haltQueue 双跳过。
// 修法：出队资格判定收口为单一函数 evaluateDispatch（startCountdown 内嵌，主回调与重试回调
// 共用）；重试 1s 固定间隔无限顺延、timer 登记进 mainTimers；QueueState 携带 intervalSeconds；
// 复查命中不收口 standby（保留 running 归属）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-queue-retry-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { taskEtaText } from '../src/shared/queue-eta';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const engine = read('src/main/modules/task-queue-engine.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

/** 按函数头截取顶层函数完整源码（列 0 闭括号为界，容忍嵌套块）。 */
function sliceTopFn(src: string, head: string): string {
  const idx = src.indexOf(head);
  assert.ok(idx > -1, `未找到 ${head}`);
  const end = src.indexOf('\n}', idx);
  assert.ok(end > -1, `${head} 闭括号未找到`);
  return src.slice(idx, end + 2);
}

/** 截取嵌套（2 空格缩进）函数完整源码。 */
function sliceNestedFn(src: string, head: string): string {
  const idx = src.indexOf(head);
  assert.ok(idx > -1, `未找到 ${head}`);
  const end = src.indexOf('\n  }', idx);
  assert.ok(end > -1, `${head} 嵌套闭括号未找到`);
  return src.slice(idx, end + 4);
}

interface FakeTimer { fn: () => void; delay: number; cancelled: boolean; unref: () => void }

/** 假定时器：不真实等待，手动 fire。 */
function makeFakeTimers() {
  const scheduled: FakeTimer[] = [];
  const make = (fn: () => void, delay?: number): FakeTimer => {
    const t: FakeTimer = { fn, delay: delay ?? 0, cancelled: false, unref: () => {} };
    scheduled.push(t);
    return t;
  };
  return {
    scheduled,
    setTimeout: (fn: () => void, delay?: number) => make(fn, delay),
    setInterval: (fn: () => void, delay?: number) => make(fn, delay),
    clearTimeout: (t: FakeTimer) => { if (t) t.cancelled = true; },
    clearInterval: (t: FakeTimer) => { if (t) t.cancelled = true; },
    pending: () => scheduled.filter((t) => !t.cancelled),
    fire: (t: FakeTimer) => { if (!t.cancelled) { t.cancelled = true; t.fn(); } },
    fireAll: () => { for (const t of scheduled) if (!t.cancelled) { t.cancelled = true; t.fn(); } },
  };
}

/** TS 源 → 注入依赖的可运行函数（destructure 注入模块级自由变量，vm 沙箱注入全局）。 */
function makeRunnable(
  fnSrc: string,
  fnName: string,
  depNames: string[],
  sandbox: Record<string, unknown> = {},
): (deps: Record<string, unknown>) => () => void {
  const js = ts.transpileModule(fnSrc, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
  const wrapper = `(function(__deps){ const {${depNames.join(',')}} = __deps; ${js}; return ${fnName}; })`;
  const factory = vm.runInNewContext(wrapper, vm.createContext(sandbox));
  return (deps) => factory(deps) as () => void;
}

const DISPATCH_DEPS = [
  'isQueueGenerationActive', 'isChatSendLocked', 'hasPendingFirstPrompt', 'getActiveProcess',
  'taskRepo', 'popExecute', 'logger', 'emitStateChanged', 'mainTimers',
  'sessionId', 'generation', 'state', 'mainWindow',
];

interface DispatchEnv {
  gen: boolean;
  locked: boolean;
  pending: number;
  pendingPrompt: number;
  activeProc: number;
  dispatched: unknown[];
  logs: string[];
  state: { sessionId: string; status: string; standbyReason: string | null; countdownRemaining: number; currentTaskId: string | null; intervalSeconds?: number };
  mainTimers: Map<string, FakeTimer>;
  timers: ReturnType<typeof makeFakeTimers>;
  run: () => void;
}

/** 构造 evaluateDispatch 运行环境（真实函数实跑，依赖全部注入）。 */
function makeDispatchEnv(): DispatchEnv {
  const src = sliceNestedFn(engine, 'function evaluateDispatch');
  const timers = makeFakeTimers();
  const env: DispatchEnv = {
    gen: true,
    locked: false,
    pending: 1,
    pendingPrompt: 0,
    activeProc: 0,
    dispatched: [],
    logs: [],
    state: { sessionId: 's1', status: 'countdown', standbyReason: null, countdownRemaining: 0, currentTaskId: null },
    mainTimers: new Map(),
    timers,
    run: () => {},
  };
  const factory = makeRunnable(
    src, 'evaluateDispatch', DISPATCH_DEPS,
    { setTimeout: timers.setTimeout, setInterval: timers.setInterval, clearTimeout: timers.clearTimeout, clearInterval: timers.clearInterval },
  );
  const deps = {
    isQueueGenerationActive: (_sid: string, _gen: number) => env.gen,
    isChatSendLocked: () => env.locked,
    hasPendingFirstPrompt: () => env.pendingPrompt > 0,
    getActiveProcess: () => (env.activeProc > 0 ? ({} as unknown) : null),
    taskRepo: { getPendingTasks: () => (env.pending > 0 ? [{ id: 'taskA' }] : []) },
    popExecute: (sid: string, _win: unknown, task: unknown) => { env.dispatched.push({ sid, task }); return { catch: () => {} }; },
    logger: { error: (...a: unknown[]) => { env.logs.push(a.join(' ')); }, info: () => {} },
    emitStateChanged: () => { env.logs.push('state_changed'); },
    mainTimers: env.mainTimers,
    sessionId: 's1',
    generation: 1,
    state: env.state,
    mainWindow: {},
  };
  env.run = factory(deps as unknown as Record<string, unknown>);
  return env;
}

// ① F1：直发在飞命中 → 1s 重试重排且不抛错；锁释放后重试回调真实出队（旧代码此处 TDZ 抛错）。
check('① F1/TDZ：重试排程→锁释放→重试回调出队 taskA（全链无 ReferenceError）', () => {
  const env = makeDispatchEnv();
  env.locked = true;
  env.run();
  assert.equal(env.dispatched.length, 0, '直发在飞时不得出队');
  const armed = env.timers.pending();
  assert.equal(armed.length, 1, `重试未排程（armed=${armed.length}）`);
  assert.equal(armed[0].delay, 1000, '重试延迟应为 ~1s');
  env.locked = false;
  assert.doesNotThrow(() => env.timers.fire(armed[0]), '重试回调抛错（TDZ/未定义引用）');
  assert.equal(env.dispatched.length, 1, '锁释放后重试未出队');
  assert.equal((env.dispatched[0] as { task: { id: string } }).task.id, 'taskA', '出队任务非队首');
});

// ② F2：持续在飞无限顺延不裸放弃（旧代码 2 次后不再排程）。
check('② F2/不放弃：连续 5 轮在飞每轮都再排程；第 6 轮锁释放后出队', () => {
  const env = makeDispatchEnv();
  env.locked = true;
  env.run();
  for (let i = 0; i < 5; i++) {
    const armed = env.timers.pending();
    assert.equal(armed.length, 1, `第 ${i + 1} 轮重试后无后续排程（裸放弃）`);
    env.timers.fire(armed[0]);
  }
  assert.equal(env.dispatched.length, 0, '在飞期间不得出队');
  env.locked = false;
  env.timers.fire(env.timers.pending()[0]);
  assert.equal(env.dispatched.length, 1, '锁释放后未出队');
});

// ③ F2/收口：重试 timer 登记进 mainTimers（cancelTimers 经该 Map 收口），取消后 fire 不出队。
check('③ F2/收口：重试 timer 进 mainTimers；取消后触发不出队', () => {
  const env = makeDispatchEnv();
  env.locked = true;
  env.run();
  const armed = env.timers.pending();
  assert.equal(env.mainTimers.get('s1'), armed[0], '重试 timer 未登记 mainTimers（cancelTimers 无法收口）');
  armed[0].cancelled = true; // 模拟 cancelTimers
  armed[0].fn();
  assert.equal(env.dispatched.length, 0, '已取消的重试不得出队');
});

// ④ 代际/接管守卫：代际失效与 running 接管均不出队不排程。
check('④ 守卫：代际失效不排程；running 被插话接管时重试命中不出队', () => {
  const env = makeDispatchEnv();
  env.gen = false;
  env.run();
  assert.equal(env.timers.pending().length, 0, '代际失效不得排程');
  const env2 = makeDispatchEnv();
  env2.locked = true;
  env2.run();
  env2.state.status = 'running'; // 插话接管
  assert.doesNotThrow(() => env2.timers.pending()[0].fn());
  assert.equal(env2.dispatched.length, 0, 'running 接管后重试不得出队');
});

// ⑤ F4：popExecute 占坑复查命中不收口 standby（保留在飞回合的 running 归属）。
check('⑤ F4/归属保留：复查命中段无 standby 收口，保留 currentTaskId 撤账+任务回 pending', () => {
  const body = sliceTopFn(engine, 'async function popExecute');
  const recheckIdx = body.indexOf('占坑复查');
  assert.ok(recheckIdx > -1, '未找到占坑复查段');
  const rollbackIdx = body.indexOf('popExecute rollback', recheckIdx);
  assert.ok(rollbackIdx > -1, '未找到复查回滚日志锚点');
  const seg = body.slice(recheckIdx, rollbackIdx);
  assert.ok(!seg.includes("state.status = 'standby'"), '复查命中不得收口 standby（剥夺在飞回合归属 → armAfterTurn/haltQueue 双跳过）');
  assert.ok(seg.includes("state.currentTaskId = null") || seg.includes('state.currentTaskId === task.id) state.currentTaskId = null'), '复查命中缺 currentTaskId 撤账');
  assert.ok(seg.includes("updateTaskStatus(task.id, 'pending')"), '复查命中缺任务回 pending');
});

// ⑥ F3：startCountdown 实跑——QueueState 携带 intervalSeconds，countdown_started 后整体替换快照不失真。
check('⑥ F3/快照：startCountdown 置 state.intervalSeconds 且 {...state} 快照携带（整体替换不再抹除）', () => {
  const src = sliceTopFn(engine, 'function startCountdown');
  const timers = makeFakeTimers();
  const state = { sessionId: 's1', status: 'standby' as string, standbyReason: null as string | null, countdownRemaining: 0, currentTaskId: null as string | null };
  const events: { type: string; data?: Record<string, unknown> }[] = [];
  const deps = {
    getOrCreateQueue: () => state,
    cancelTimers: () => {},
    resolveQueueDelaySeconds: (_m: unknown) => 30,
    getConfig: () => ({ taskDelayMinutes: 5 }),
    emitQueueEvent: (_win: unknown, _sid: string, type: string, _tid?: string, data?: Record<string, unknown>) => events.push({ type, data }),
    emitStateChanged: () => events.push({ type: 'state_changed' }),
    getQueueGeneration: () => 1,
    isQueueGenerationActive: () => true,
    timers: new Map(),
    mainTimers: new Map(),
    isChatSendLocked: () => false,
    hasPendingFirstPrompt: () => false,
    getActiveProcess: () => null,
    taskRepo: { getPendingTasks: () => [{ id: 'taskA' }] },
    popExecute: () => ({ catch: () => {} }),
    logger: { error: () => {}, info: () => {} },
  };
  // 在含假定时器的沙箱里执行 startCountdown（函数体内引用全局 setTimeout/setInterval）
  const startCountdown = makeRunnable(
    src, 'startCountdown', Object.keys(deps),
    { setTimeout: timers.setTimeout, setInterval: timers.setInterval, clearTimeout: timers.clearTimeout, clearInterval: timers.clearInterval },
  )(deps as unknown as Record<string, unknown>);
  startCountdown('s1', {});
  assert.equal(state.status, 'countdown', 'startCountdown 未置 countdown');
  assert.equal(state.intervalSeconds, 30, 'state 未携带 intervalSeconds 快照（hb13-v F3）');
  const started = events.find((e) => e.type === 'countdown_started');
  assert.ok(started && started.data?.seconds === 30, 'countdown_started 载荷缺 seconds');
  const snapshot = { ...state } as typeof state; // 渲染层 state_changed 整体替换等价形态
  assert.equal(snapshot.intervalSeconds, 30, '整体替换快照丢失 intervalSeconds（F3 抹除复现）');
  const mainArmed = timers.pending().find((t) => t.delay === 30000);
  assert.ok(mainArmed, '主 timer 未按 30s 排程');
});

// ⑦ F3/消费端：etaFor 优先快照（真实共享纯函数实调）——快照 30s 而非回落值。
check('⑦ F3/消费端：taskEtaText 使用快照 intervalSeconds（30s vs 回落 300s 可区分）', () => {
  const got = taskEtaText({ paused: false }, { status: 'countdown', countdownRemaining: 0, intervalSeconds: 30, runnableIndex: 1 });
  assert.equal(got, '最早约 30s 后（第 2 位）', `快照未生效：${got}`);
  const fell = taskEtaText({ paused: false }, { status: 'countdown', countdownRemaining: 0, intervalSeconds: Number.NaN, runnableIndex: 1 });
  assert.equal(fell, '最早约 5 分钟 后（第 2 位）', `回落口径漂移：${fell}`);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
