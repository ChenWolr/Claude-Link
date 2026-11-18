// tdd-send-route-verify.ts
// 2026-11-15 eight-issues 批次点 A2「发送路由：队列活跃→入队」契约脚本。
// 用例正本 = docs/plans/2026-11-15-eight-issues-batch/03b-test-cases-renderer.md §2：
//   · A2-1 发送路由判据矩阵行为直测（兼规范 T2.4 正本，两域共用本脚本）：
//     判据收口形态按实现落地回填——判据内联于 ChatPage.vue handleSend（02-impl-details-renderer.md
//     §1.2 代码形态逐字对照），本脚本从源码切片判据表达式组装纯函数求值（判据与实现同源，
//     防手写镜像漂移），灌入 setActivePinia 真实 store（tdd-queue-tasks-sync T1-D 渲染层 store
//     直测先例 + tdd-activity-f1-f5 makeTaskHarness window.claudeLink stub 先例）；
//   · A2-2 发送入口分流接线钉（两入口收敛 emit('send')→handleSend；enqueue=TASK_ADD 全链桥
//     形状；enqueue 分支零 beginUserTurn；判据三输入绑定主进程权威源）；
//   · A2-7 边界行 1/2（渲染层判据无第四种输出；standby 熔断待命=直发且 standbyReason 不参与判据；
//     边界行 3 的 CDP-C 场景归 T1B/T1C 点，不在本脚本）。
// 运行：npx tsx scripts/tdd-send-route-verify.ts（登记 scripts/selftest-static-list.txt）。
// 红线：ChatInput.vue 全文件零改动（disabled 表达式被 regression-tests.ts 正则逐字钉）——本脚本
// 只读钉其两入口收敛形态，不修改该文件；taskStore.addTask / TASK_ADD 全链不动。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as url from 'node:url';

const req = createRequire(import.meta.url);
const repoRoot = path.join(url.fileURLToPath(new URL('.', import.meta.url)), '..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name} — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`);
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function assertEqual(actual: any, expected: any, msg: string): void {
  assert(actual === expected, `${msg}（实际=${String(actual)} 期望=${String(expected)}）`);
}

const chatPageSrc = read('src/renderer/pages/ChatPage.vue');
const chatInputSrc = read('src/renderer/components/chat/ChatInput.vue');
const taskStoreSrc = read('src/renderer/stores/task-store.ts');
const appSrc = read('src/renderer/App.vue');

// ── 判据切片：从 ChatPage.vue handleSend 内提取 queueBusy / queueStateUnknown / if 条件 ──
// 形态契约（02 §1.2 逐字）：三段依次出现，判据 if 条件形如
// `if (queueEnabled.value && (sending.value || queueBusy || queueStateUnknown)) {`
const BUSY_ANCHOR = 'const queueBusy =';
const UNKNOWN_ANCHOR = 'const queueStateUnknown =';
const IF_ANCHOR = 'if (queueEnabled.value &&';

function extractRouteCriterion(): { busyLine: string; unknownLine: string; cond: string } {
  const busyIdx = chatPageSrc.indexOf(BUSY_ANCHOR);
  assert(busyIdx > -1, 'ChatPage.vue 缺判据锚 const queueBusy =（A2 判据块未落地）');
  const unknownIdx = chatPageSrc.indexOf(UNKNOWN_ANCHOR, busyIdx);
  assert(unknownIdx > -1, 'ChatPage.vue 缺判据锚 const queueStateUnknown =（A2 判据块未落地）');
  const ifIdx = chatPageSrc.indexOf(IF_ANCHOR, unknownIdx);
  assert(ifIdx > -1, 'ChatPage.vue 缺判据锚 if (queueEnabled.value && …)（A2 判据块未落地）');
  const busyLine = chatPageSrc.slice(busyIdx, chatPageSrc.indexOf(';', busyIdx) + 1);
  const unknownLine = chatPageSrc.slice(unknownIdx, chatPageSrc.indexOf(';', unknownIdx) + 1);
  const ifLineEnd = chatPageSrc.indexOf(') {', ifIdx);
  assert(ifLineEnd > -1, '判据 if 行未闭合（缺 ") {"）');
  const cond = chatPageSrc.slice(ifIdx + 'if ('.length, ifLineEnd);
  return { busyLine, unknownLine, cond };
}

type Route = 'enqueue' | 'direct';
// 判据纯函数：taskStore 为 pinia store 实例（属性直读，形态与 handleSend 内一致）、
// sending/queueEnabled 以布尔传入后包成 ref 形态（判据读 .value）。
// 注：生成函数为 4 位置参（taskStore, sending, queueEnabled, sessionId）——round-002 R2-F 收纳
// typecheck 时修正过时的 1 对象参声明（TS2554），调用面 route({…}) 形态不变。
function buildRouteFn(): (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  taskStore: any,
  sending: boolean,
  queueEnabled: boolean,
  sessionId: string,
) => Route {
  const { busyLine, unknownLine, cond } = extractRouteCriterion();
  // eslint-disable-next-line no-new-func
  const factory = new Function(`
    return function route(taskStore, sendingBool, queueEnabledBool, sessionId) {
      ${busyLine}
      ${unknownLine}
      const sending = { value: sendingBool };
      const queueEnabled = { value: queueEnabledBool };
      if (${cond}) return 'enqueue';
      return 'direct';
    };
  `);
  return factory() as (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    taskStore: any,
    sending: boolean,
    queueEnabled: boolean,
    sessionId: string,
  ) => Route;
}

// ── 渲染层 store 直测夹具（对齐 tdd-activity-f1-f5 makeTaskHarness：独立 pinia +
// window.claudeLink stub；pinia/task-store 经同一 createRequire 引入保证单实例）──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let taskStoreMod: any = null;
let piniaMod: any = null;
try {
  taskStoreMod = req('../src/renderer/stores/task-store');
  piniaMod = req('pinia');
} catch {
  taskStoreMod = null;
  piniaMod = null;
}

const S1 = 'sess-route-a2';
function baseQueueState(): Record<string, unknown> {
  return { sessionId: '', status: 'standby', standbyReason: null, countdownRemaining: 0, currentTaskId: null };
}
function setQueueState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  patch: Partial<{ sessionId: string; status: string; countdownRemaining: number }>,
): void {
  store.queueState = { ...baseQueueState(), ...patch } as never;
}
function freshStore(): unknown {
  piniaMod.setActivePinia(piniaMod.createPinia());
  return taskStoreMod.useTaskStore();
}

console.log('\n=== A2-1 判据切片与收口形态（02 §1.2 逐字形态钉） ===');
check('A2-1 判据切片：queueBusy=sessionId 相等且 status∈{countdown,running}；queueStateUnknown=!queueStateKnown(sessionId)', () => {
  const { busyLine, unknownLine, cond } = extractRouteCriterion();
  assert(busyLine.includes('taskStore.queueState.sessionId === sessionId'), 'queueBusy 须以 taskStore.queueState.sessionId === sessionId 为前提');
  assert(busyLine.includes("taskStore.queueState.status === 'countdown'"), "queueBusy 须含 status === 'countdown'");
  assert(busyLine.includes("taskStore.queueState.status === 'running'"), "queueBusy 须含 status === 'running'");
  assert(unknownLine.includes('!taskStore.queueStateKnown(sessionId)'), 'queueStateUnknown 须为 !taskStore.queueStateKnown(sessionId)');
  assert(cond.includes('queueEnabled.value'), '判据 if 须含 queueEnabled.value');
  assert(cond.includes('sending.value'), '判据 if 须含 sending.value（直发回合在飞兜底项保留）');
  assert(cond.includes('queueBusy'), '判据 if 须含 queueBusy');
  assert(cond.includes('queueStateUnknown'), '判据 if 须含 queueStateUnknown（A3 恢复门失败保守侧）');
});

console.log('\n=== A2-1 判据矩阵行为直测（真实 pinia store 灌入） ===');
check('A2-1 store 夹具可用（task-store 模块在 tsx 下可加载）', () => {
  assert(taskStoreMod && typeof taskStoreMod.useTaskStore === 'function' && piniaMod, 'task-store/pinia 模块加载失败，行为直测不可用');
});

function makeRouteCase(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any;
  route: (input: { sending: boolean; queueEnabled: boolean; sessionId: string }) => Route;
} {
  assert(taskStoreMod && piniaMod, 'task-store/pinia 模块加载失败');
  const store = freshStore();
  const routeFn = buildRouteFn();
  return {
    store,
    route: (input) => routeFn(store, input.sending, input.queueEnabled, input.sessionId),
  };
}

// 矩阵（03b A2-1 表逐格 8 行）+ unknown 2 行（02 §1.4 边界值表）+ sending 兜底 2 行（02 §1.2）。
const MATRIX: Array<{
  name: string;
  queueEnabled: boolean;
  status: string | null;
  known: boolean;
  sending?: boolean;
  stateSession?: string;
  expected: Route;
}> = [
  { name: 'true+countdown → enqueue', queueEnabled: true, status: 'countdown', known: true, expected: 'enqueue' },
  { name: 'true+running → enqueue', queueEnabled: true, status: 'running', known: true, expected: 'enqueue' },
  { name: 'true+standby（熔断待命/空态同型）→ direct', queueEnabled: true, status: 'standby', known: true, expected: 'direct' },
  { name: 'true+空闲无任务（快照他属会话）→ direct', queueEnabled: true, status: 'standby', known: true, stateSession: 'other-sess', expected: 'direct' },
  { name: 'false+countdown → direct（A2.3 恒直发）', queueEnabled: false, status: 'countdown', known: true, expected: 'direct' },
  { name: 'false+running → direct（A2.3 恒直发）', queueEnabled: false, status: 'running', known: true, expected: 'direct' },
  { name: 'false+standby → direct（A2.3 恒直发）', queueEnabled: false, status: 'standby', known: true, expected: 'direct' },
  { name: 'false+空闲无任务 → direct（A2.3 恒直发）', queueEnabled: false, status: 'standby', known: true, stateSession: 'other-sess', expected: 'direct' },
  { name: 'true+unknown（恢复门失败/未拉取）→ enqueue（保守侧）', queueEnabled: true, status: null, known: false, expected: 'enqueue' },
  { name: 'false+unknown → direct（unknown 不参与恒直发）', queueEnabled: false, status: null, known: false, expected: 'direct' },
  { name: 'true+standby+sending → enqueue（直发回合在飞兜底）', queueEnabled: true, status: 'standby', known: true, sending: true, expected: 'enqueue' },
  { name: 'false+sending → direct（sending 不越过 queueEnabled=false）', queueEnabled: false, status: 'standby', known: true, sending: true, expected: 'direct' },
];

for (const cell of MATRIX) {
  check(`A2-1 矩阵：${cell.name}`, () => {
    const { store, route } = makeRouteCase();
    // known 铺设：known=true → loadOverview 已成功（ready 位按会话键控）；
    // known=false → 不铺设（fresh store 未拉取）。
    if (cell.known) {
      store.overviewReadyBySession[S1] = true;
      store.overviewFailedBySession[S1] = false;
    }
    if (cell.status !== null) {
      setQueueState(store, { sessionId: cell.stateSession ?? S1, status: cell.status });
    } else {
      setQueueState(store, { sessionId: '' });
    }
    const got = route({ queueEnabled: cell.queueEnabled, sending: cell.sending ?? false, sessionId: S1 });
    assertEqual(got, cell.expected, '路由输出不符');
  });
}

console.log('\n=== A2-1 store 行为：queueStateKnown 由 loadOverview 结果驱动（主进程权威） ===');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeKnownHarness(getQueueOverview: (sessionId: string) => Promise<unknown>): any {
  assert(taskStoreMod && piniaMod, 'task-store/pinia 模块加载失败');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const prevWindow = g.window;
  g.window = { claudeLink: { getQueueOverview } };
  const store = freshStore();
  return { store, restore: () => { g.window = prevWindow; } };
}
const knownTasks: Array<[string, () => Promise<void>]> = [];
knownTasks.push([
  'A2-1 行为：loadOverview 成功 → queueStateKnown=true（该会话过恢复门）',
  async () => {
    const h = makeKnownHarness(async (sid: string) => ({
      tasks: [], executed: [], state: { ...baseQueueState(), sessionId: sid, status: 'standby' },
    }));
    try {
      assertEqual(h.store.queueStateKnown('fresh-sess'), false, '未拉取会话须 unknown');
      await h.store.loadOverview(S1);
      assertEqual(h.store.queueStateKnown(S1), true, 'loadOverview 成功后须 known');
      assertEqual(h.store.overviewReadyBySession[S1], true, '成功须置 overviewReadyBySession');
      assertEqual(h.store.overviewFailedBySession[S1], false, '成功须清 overviewFailedBySession');
    } finally { h.restore(); }
  },
]);
knownTasks.push([
  'A2-1 行为：loadOverview 失败 → queueStateKnown=false（保守侧：ready 不置位，failed 标记由 A3 ensureOverviewReady 落）',
  async () => {
    const h = makeKnownHarness(async () => { throw new Error('队列 IPC 断'); });
    try {
      await h.store.loadOverview(S1);
      assertEqual(h.store.queueStateKnown(S1), false, '失败会话须 unknown（A2 保守侧入队）');
      assert(h.store.overviewReadyBySession[S1] !== true, '失败不得置 ready（未成功过门）');
    } finally { h.restore(); }
  },
]);
async function main(): Promise<void> {
  for (const [name, fn] of knownTasks) {
    await fn()
      .then(() => { passed += 1; console.log(`  PASS ${name}`); })
      .catch((e: unknown) => { failed += 1; console.log(`  FAIL ${name} — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`); });
  }

console.log('\n=== A2-2 发送入口分流接线钉 ===');
check('A2-2 钉①：ChatInput 两入口（按钮 submit / Enter 分支）均收敛 emit(\'send\')，父级 @send="handleSend"', () => {
  const submitIdx = chatInputSrc.indexOf('function submit(): void {');
  assert(submitIdx > -1, 'ChatInput 缺 submit 函数（两入口收敛点）');
  const submitBody = chatInputSrc.slice(submitIdx, chatInputSrc.indexOf('}', submitIdx) + 1);
  assert(submitBody.includes("emit('send')"), "submit 须 emit('send')（按钮与 Enter 共用收敛点）");
  const keydownIdx = chatInputSrc.indexOf('function handleKeydown');
  assert(keydownIdx > -1, 'ChatInput 缺 handleKeydown');
  // handleKeydown 内有两个 Enter 分支（slash 菜单选中 / 发送）；钉发送分支=调 submit() 的那个。
  let enterSendFound = false;
  let probe = keydownIdx;
  for (;;) {
    const idx = chatInputSrc.indexOf("if (e.key === 'Enter' && !e.shiftKey) {", probe);
    if (idx === -1) break;
    const body = chatInputSrc.slice(idx, chatInputSrc.indexOf('}', idx) + 1);
    if (body.includes('submit()')) { enterSendFound = true; break; }
    probe = idx + 1;
  }
  assert(enterSendFound, 'Enter 发送分支须调 submit()（与按钮同入口）');
  assert(chatPageSrc.includes('@send="handleSend"'), 'ChatPage 须以 @send 接线 handleSend');
});
check('A2-2 钉②：enqueue 分支调 taskStore.addTask(sessionId, payload)（TASK_ADD 全链桥），direct 分支走 sendMessage(payload)；payload 含附件 ids+clientMessageId', () => {
  const { cond } = extractRouteCriterion();
  const ifIdx = chatPageSrc.indexOf(`if (${cond}) {`);
  assert(ifIdx > -1, '判据 if 行与切片条件不一致（判据块被改动）');
  const elseIdx = chatPageSrc.indexOf('} else {', ifIdx);
  assert(elseIdx > ifIdx, '路由块缺 else 直发分支');
  const enqBranch = chatPageSrc.slice(ifIdx, elseIdx);
  const directMsgIdx = chatPageSrc.indexOf('sendMessage(payload)', elseIdx);
  const directBranch = chatPageSrc.slice(elseIdx, chatPageSrc.indexOf('}', directMsgIdx));
  assert(enqBranch.includes('ok = await taskStore.addTask(sessionId, payload)'), 'enqueue 分支须走 taskStore.addTask（TASK_ADD 全链）');
  assert(directBranch.includes('ok = await sendMessage(payload)'), 'direct 分支须走 sendMessage');
  const payloadFn = chatPageSrc.slice(chatPageSrc.indexOf('function buildPayload()'), chatPageSrc.indexOf('function handleSend'));
  assert(payloadFn.includes('attachmentIds'), 'buildPayload 须带 attachmentIds（TASK_ADD 附件链）');
  assert(payloadFn.includes('clientMessageId: crypto.randomUUID()'), 'buildPayload 须带 clientMessageId（幂等索引）');
});
check('A2-2 钉③：enqueue 分支不触发 beginUserTurn（ChatPage 全文件无 beginUserTurn 调用形态）', () => {
  assert(!/beginUserTurn\s*\(/.test(chatPageSrc), 'ChatPage 不得出现 beginUserTurn( 调用（渲染层无直发前置触发权）');
});
check('A2-2 钉④：判据三输入绑定主进程权威源——queueState←loadOverview 回包+QUEUE_EVENT 订阅；sending←useChat；queueEnabled←configStore.config', () => {
  assert(taskStoreSrc.includes('this.queueState = overview.state;'), 'queueState 快照源须为 getQueueOverview 回包');
  assert(appSrc.includes('onQueueEvent(') && appSrc.includes('taskStore.handleQueueEvent'), 'QUEUE_EVENT 须经 App.vue 全局订阅进 taskStore');
  const { busyLine, unknownLine } = extractRouteCriterion();
  assert(busyLine.includes('taskStore.queueState') && unknownLine.includes('taskStore.queueStateKnown'), '判据状态源须绑 taskStore（主进程快照/事件驱动字段）');
  assert(chatPageSrc.includes('const { sending, error, lastFailedBySession, sendMessage, abort } = useChat();'), 'sending 须来自 useChat（store.runningSessions 事件派生）');
  assert(chatPageSrc.includes('configStore.config.queueEnabled === true'), 'queueEnabled 须来自 configStore.config 权威');
});
check('A2-2 钉⑤：路由块无渲染层臆断分支（无计时器/估算参与路由）', () => {
  const busyIdx = chatPageSrc.indexOf(BUSY_ANCHOR);
  const blockEnd = chatPageSrc.indexOf('sendMessage(payload)', busyIdx);
  const routeBlock = chatPageSrc.slice(busyIdx, blockEnd);
  assert(!/setTimeout|setInterval|Date\.now|performance\.now/.test(routeBlock), '路由块不得含本地计时/估算（判据三输入全主进程权威）');
});

console.log('\n=== A2-7 边界行 1/2（判据层兜底 + 无第四种输出；行 3 归 CDP-C） ===');
check('A2-7 边界行 1：渲染层判据无第四种输出——路由目标恰两个（addTask/sendMessage 各一次），if/else 单层布尔判据', () => {
  extractRouteCriterion(); // 判据锚缺失时在此给出明确失败消息
  const busyIdx = chatPageSrc.indexOf(BUSY_ANCHOR);
  const handleSendEnd = chatPageSrc.indexOf('if (ok) {', busyIdx);
  const routeBlock = chatPageSrc.slice(busyIdx, handleSendEnd);
  const addTaskCalls = routeBlock.match(/taskStore\.addTask\(/g) ?? [];
  const sendMsgCalls = routeBlock.match(/await sendMessage\(/g) ?? [];
  assertEqual(addTaskCalls.length, 1, '路由块 addTask 调用须恰一次');
  assertEqual(sendMsgCalls.length, 1, '路由块 sendMessage 调用须恰一次');
  assert(!/else if/.test(routeBlock), '路由块不得出现 else if（判据输出恰二值）');
  const { cond } = extractRouteCriterion();
  assert(cond.includes('queueBusy') && cond.includes('queueStateUnknown'), '判据须为 queueBusy ∥ queueStateUnknown 布尔单条件（归零竞态无第四分支：countdown 恒 enqueue、standby 恒 direct）');
});
check('A2-7 边界行 2：standby 熔断待命=直发，standbyReason/paused 不参与渲染层判据', () => {
  const { busyLine, unknownLine, cond } = extractRouteCriterion();
  for (const seg of [busyLine, unknownLine, cond]) {
    assert(!seg.includes('standbyReason'), '判据不得读 standbyReason（standby 熔断待命与空态统一直发）');
    assert(!seg.includes('paused'), '判据不得读 paused（熔断待命发送不解除 paused，判据不感知）');
  }
  const { store, route } = makeRouteCase();
  store.overviewReadyBySession[S1] = true;
  store.overviewFailedBySession[S1] = false;
  setQueueState(store, { sessionId: S1, status: 'standby' });
  assertEqual(route({ queueEnabled: true, sending: false, sessionId: S1 }), 'direct', '熔断待命 standby 须直发');
});

  console.log(`\n[tdd-send-route] passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
