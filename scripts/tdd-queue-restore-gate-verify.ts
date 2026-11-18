// tdd-queue-restore-gate-verify.ts
// 2026-11-15 eight-issues 批次点 A3「刷新恢复门 + 队列状态聊天页可见」契约脚本。
// 用例正本 = docs/plans/2026-11-15-eight-issues-batch/03b-test-cases-renderer.md §3：
//   · A3-1 恢复门先于输入放行（三钉意图）：
//     ① 禁用绑定钉——ChatInput 发送禁用门控绑定恢复态：ChatPage :disabled 换 computed
//        chatInputDisabled（(sending && !queueEnabled) || queueRecovering），queueRecovering
//        绑 taskStore.overviewReadyBySession（恢复未完成 → disabled=true）；ChatInput.vue 内部
//        disabled 表达式零触碰（regression-tests.ts 正则钉红线）；
//     ② 拉取先于放行序钉——恢复拉取（ensureOverviewReady）触发点在会话激活路径上：onMounted
//        投影恢复块之后 + watch activeSession.id 切会话回调内；放行位只由拉取结果写入；
//     ③ 状态源钉——恢复态字段来源为主进程拉取（getQueueOverview 经 loadOverview），渲染层
//        不臆断（overviewReadyBySession/overviewFailedBySession 仅由 loadOverview 成功路径与
//        ensureOverviewReady 兜底分支写入）。
//   · A3-2 恢复门失败放行（不永久禁言）：
//     [行为] loadOverview 失败 / 3s 超时 → 门控置就绪（ready=true）发送恢复可用，且
//     queueStateKnown=false（A2 保守侧：queueEnabled 时入队）；已过门不重拉。
//     [钉兜底] 负向钉：ensureOverviewReady 的超时与 finally 两分支都必须写 ready=true
//     （无「仅记错不放行」路径）；loadOverview 的 catch 只置 error 不写 ready（失败由
//     ensureOverviewReady 兜底放行），两处合流保证任何路径最终放行。
//   · 附属结构钉（02-impl-details-renderer.md §2.2 queue-strip 载体，04 §4.1 同物异名映射
//     自 tdd-send-route-queue-aware-verify 的 queue-strip 组）：指示条结构/testid/五态文案/
//     插入位（.chat-composer 之前）/样式 token 纪律（全 var()/color-mix，无裸 hex）。
// 运行：npx tsx scripts/tdd-queue-restore-gate-verify.ts（登记 scripts/selftest-static-list.txt）。
// 2026-11-17 R2 修复轮同步留痕（round-001 P34/M-C）：
//   · P34——loadOverview 改返回 boolean（成功 true/失败 false），ensureOverviewReady 以返回值
//     判 failed（原 this.error != null 判据受 removeTask/reorder/setPaused 失败残留误标成功拉取，
//     A2 保守入队窗放大）；负向钉「error 位区分」同步为返回值字面 + 新增行为⑥回归钉。
//   · M-C——倒计时条数文案「N 条待执行」→「队列 N 条」消歧（tasks.length 含 paused 任务），
//     结构钉③同步字面。
// 红线：ChatInput.vue 全文件零改动（disabled 表达式被 regression-tests.ts 正则逐字钉）——本脚本
// 只读钉其内部形态，不修改该文件。
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

// ── task-store 源码切片工具 ──
// 按动作签名切片（起点=锚签名，终点=下一动作的 4 空格缩进签名行）——动作间注释/新动作插入
// 不影响切片边界（防「loadOverview 切片吞掉后继动作体」的假阳性）。
function sliceAction(startAnchor: string, label: string): string {
  const start = taskStoreSrc.indexOf(startAnchor);
  assert(start > -1, `task-store.ts 缺动作起点锚「${startAnchor}」（${label} 未落地）`);
  const next = taskStoreSrc.indexOf('\n    async ', start + startAnchor.length);
  assert(next > -1, `task-store.ts 「${label}」之后无下一动作（切片终点缺失）`);
  return taskStoreSrc.slice(start, next);
}

// 切片惰性化：缺锚时不炸在模块顶层，让全部 check 报出完整失败面（TDD 红面可读）。
let loadOverviewBodyCache: string | null = null;
function loadOverviewBody(): string {
  if (loadOverviewBodyCache === null) {
    loadOverviewBodyCache = sliceAction('async loadOverview(', 'loadOverview');
  }
  return loadOverviewBodyCache;
}
let ensureBodyCache: string | null = null;
function ensureBody(): string {
  if (ensureBodyCache === null) {
    ensureBodyCache = sliceAction('async ensureOverviewReady(', 'ensureOverviewReady');
  }
  return ensureBodyCache;
}

console.log('\n=== A3-1 钉①：禁用绑定钉（恢复态 → ChatInput disabled） ===');
check('A3-1① ChatPage :disabled 换 computed chatInputDisabled（旧字面 sending && !queueEnabled 消失）', () => {
  assert(chatPageSrc.includes(':disabled="chatInputDisabled"'), 'ChatInput 绑定须为 :disabled="chatInputDisabled"');
  assert(!chatPageSrc.includes(':disabled="sending && !queueEnabled"'), '旧字面 :disabled="sending && !queueEnabled" 须已移除（恢复门接管禁用）');
});
check('A3-1① chatInputDisabled = (sending && !queueEnabled) || queueRecovering（02 §2.2 形态）', () => {
  const idx = chatPageSrc.indexOf('const chatInputDisabled = computed');
  assert(idx > -1, 'ChatPage 缺 chatInputDisabled computed');
  const lineEnd = chatPageSrc.indexOf(');', idx);
  const body = chatPageSrc.slice(idx, lineEnd);
  assert(body.includes('sending.value && !queueEnabled.value'), '须保留 (sending && !queueEnabled) 既有禁用语义');
  assert(body.includes('|| queueRecovering.value'), '须叠加 queueRecovering（恢复未完成禁用）');
});
check('A3-1① queueRecovering 绑定恢复态 store 字段 overviewReadyBySession（queueEnabled 门控）', () => {
  const idx = chatPageSrc.indexOf('const queueRecovering = computed');
  assert(idx > -1, 'ChatPage 缺 queueRecovering computed');
  const lineEnd = chatPageSrc.indexOf(');', idx);
  const body = chatPageSrc.slice(idx, lineEnd);
  assert(body.includes('queueEnabled.value'), 'queueRecovering 须以 queueEnabled 门控（关闭时门不生效）');
  assert(body.includes('store.activeSession?.id'), 'queueRecovering 须绑定活动会话 id');
  assert(body.includes('taskStore.overviewReadyBySession'), 'queueRecovering 须读 taskStore.overviewReadyBySession');
  assert(body.includes('!== true'), '恢复判定须为 ready !== true（未过门=恢复中）');
});
check('A3-1① 回归红线：ChatInput.vue 内部 disabled 表达式逐字保留（regression 正则钉面不破）', () => {
  assert(/disabled \|\| \(!modelValue\.trim\(\) && !hasAttachments\)/.test(chatInputSrc), 'ChatInput 内部 disabled 表达式不得触碰');
});

console.log('\n=== A3-1 钉②：拉取先于放行序钉（会话激活路径先拉取、放行位由拉取结果写入） ===');
check('A3-1② onMounted 投影恢复块之后调用 ensureOverviewReady（启动/刷新路径）', () => {
  const mountedIdx = chatPageSrc.indexOf('onMounted(async () => {');
  assert(mountedIdx > -1, 'ChatPage 缺 onMounted');
  const gateIdx = chatPageSrc.indexOf('await taskStore.ensureOverviewReady(', mountedIdx);
  assert(gateIdx > -1, 'onMounted 内须 await taskStore.ensureOverviewReady（恢复门）');
  const projectionIdx = chatPageSrc.indexOf('getRunningOverview', mountedIdx);
  assert(projectionIdx > -1 && projectionIdx < gateIdx, '恢复门调用须在投影恢复（getRunningOverview）块之后');
  const mountedEnd = chatPageSrc.indexOf('});', gateIdx);
  assert(mountedEnd > -1 && gateIdx < mountedEnd, '恢复门调用须仍在 onMounted 体内');
});
check('A3-1② watch activeSession.id 切会话回调内对新会话 ensureOverviewReady', () => {
  const watchIdx = chatPageSrc.indexOf('() => store.activeSession?.id,');
  assert(watchIdx > -1, 'ChatPage 缺 activeSession.id watch');
  const cbIdx = chatPageSrc.indexOf('(newId) => {', watchIdx);
  assert(cbIdx > -1, 'watch 回调形态须为 (newId) => {');
  const watchEnd = chatPageSrc.indexOf('\n);', cbIdx);
  const body = chatPageSrc.slice(cbIdx, watchEnd);
  assert(body.includes('void taskStore.ensureOverviewReady(newId)'), '切会话回调须 void ensureOverviewReady(newId)（per-session 重入门）');
});
check('A3-1② 放行位只由拉取结果驱动：写点收敛在 loadOverview 成功路径与 ensureOverviewReady 兜底（无旁路放行）', () => {
  // 放行 = overviewReadyBySession[sid] 翻 true，写点收敛于 task-store 两处——
  // ChatPage 渲染层不得出现对该字段的直接写（旁路放行面）。
  const writes = taskStoreSrc.match(/overviewReadyBySession\[[^\]]+\] = /g) ?? [];
  // loadOverview 成功路径 1 处（= true）+ ensureOverviewReady 超时兜底 1 处 + finally 兜底 1 处 = 3
  assert(writes.length >= 2, `overviewReadyBySession 写点过少（${writes.length}）：缺 loadOverview 成功写入或 ensureOverviewReady 兜底`);
  assert(loadOverviewBody().includes('this.overviewReadyBySession[sessionId] = true;'), 'loadOverview 成功路径须写 ready=true（放行位由主进程拉取结果驱动）');
  assert(!/overviewReadyBySession\[[^\]]+\]\s*=[^=]/.test(chatPageSrc), 'ChatPage 渲染层不得直接写恢复门字段（只读消费，防旁路放行）');
});

console.log('\n=== A3-1 钉③：状态源钉（恢复态来源=主进程 getQueueOverview 拉取） ===');
check('A3-1③ task-store 声明恢复门双字段且 loadOverview 经 window.claudeLink.getQueueOverview 拉取', () => {
  assert(taskStoreSrc.includes('overviewReadyBySession: {} as Record<string, boolean>'), 'state 须声明 overviewReadyBySession');
  assert(taskStoreSrc.includes('overviewFailedBySession: {} as Record<string, boolean>'), 'state 须声明 overviewFailedBySession');
  assert(loadOverviewBody().includes('await window.claudeLink.getQueueOverview(sessionId)'), 'loadOverview 须经主进程 getQueueOverview 拉取（渲染层不臆断）');
});
check('A3-1③ loadOverview 成功路径末尾写 ready=true/failed=false；catch 仅置 error 不写 ready', () => {
  const tryIdx = loadOverviewBody().indexOf('try {');
  const catchIdx = loadOverviewBody().indexOf('} catch', tryIdx);
  const tryBody = loadOverviewBody().slice(tryIdx, catchIdx);
  assert(tryBody.includes('this.overviewReadyBySession[sessionId] = true;'), '成功路径须写 ready=true');
  assert(tryBody.includes('this.overviewFailedBySession[sessionId] = false;'), '成功路径须清 failed=false');
  const catchBody = loadOverviewBody().slice(catchIdx);
  assert(catchBody.includes('this.error ='), '失败路径须置 error（loadOverview 既有语义保留；failed 判据改经返回值，P34）');
  assert(!catchBody.includes('overviewReadyBySession'), 'catch 不得写 ready（失败不放行过门标记，放行由 ensureOverviewReady 兜底）');
});
check('A3-1③ ensureOverviewReady 消费 loadOverview（门等待=等主进程全量回包）', () => {
  assert(ensureBody().includes('await this.loadOverview(sessionId)'), 'ensureOverviewReady 须复用 loadOverview（主进程权威拉取单源）');
});

console.log('\n=== A3-2 行为直测：失败/超时放行 + 保守侧 + 已过门不重拉 ===');
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
check('A3-2 夹具可用（task-store/pinia 模块在 tsx 下可加载）', () => {
  assert(taskStoreMod && typeof taskStoreMod.useTaskStore === 'function' && piniaMod, 'task-store/pinia 模块加载失败，行为直测不可用');
});
const S1 = 'sess-gate-a3';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function freshStore(): any {
  piniaMod.setActivePinia(piniaMod.createPinia());
  return taskStoreMod.useTaskStore();
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function withWindow(getQueueOverview: (sessionId: string) => Promise<unknown>, fn: (store: any) => Promise<void>): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const prevWindow = g.window;
  g.window = { claudeLink: { getQueueOverview } };
  const store = freshStore();
  return fn(store).finally(() => { g.window = prevWindow; });
}
function baseOverview(sessionId: string): Record<string, unknown> {
  return {
    tasks: [],
    executed: [],
    state: { sessionId, status: 'standby', standbyReason: null, countdownRemaining: 0, currentTaskId: null },
  };
}

const behaviorCases: Array<[string, () => Promise<void>]> = [];
behaviorCases.push([
  'A3-2 行为①：loadOverview 成功 → ensureOverviewReady 放行且 known=true（failed=false）',
  () => withWindow(async (sid: string) => baseOverview(sid), async (store) => {
    assertEqual(store.queueStateKnown(S1), false, '未过门会话须 unknown');
    await store.ensureOverviewReady(S1);
    assertEqual(store.overviewReadyBySession[S1], true, '过门须置 ready=true');
    assertEqual(store.overviewFailedBySession[S1], false, '成功不得置 failed');
    assertEqual(store.queueStateKnown(S1), true, '成功过门后须 known');
  }),
]);
behaviorCases.push([
  'A3-2 行为②：loadOverview 失败 → 门放行（ready=true）+ failed=true → known=false（A2 保守侧）',
  () => withWindow(async () => { throw new Error('队列 IPC 断'); }, async (store) => {
    await store.ensureOverviewReady(S1);
    assertEqual(store.overviewReadyBySession[S1], true, '失败也须放行（不永久禁言输入框，契约 A3-3）');
    assertEqual(store.overviewFailedBySession[S1], true, '失败须置 failed=true（返回值判据，A2 保守侧判据）');
    assertEqual(store.queueStateKnown(S1), false, '失败会话须 unknown（queueEnabled 时保守入队）');
    assert(store.error != null, '失败须留 error 位（loadOverview 既有语义）');
  }),
]);
behaviorCases.push([
  'A3-2 行为③：主进程超时（3s 内无回包）→ 门放行 + failed=true（不永久禁言）',
  async () => {
    const start = Date.now();
    await withWindow(
      () => new Promise(() => { /* 永不 resolve 的挂起拉取 */ }),
      async (store) => {
        await store.ensureOverviewReady(S1);
        const elapsed = Date.now() - start;
        assert(elapsed >= 2500, `超时兜底须等满 3s 窗（实测 ${elapsed}ms 过早放行）`);
        assert(elapsed <= 9000, `超时兜底须在 3s 附近放行（实测 ${elapsed}ms 过晚）`);
        assertEqual(store.overviewReadyBySession[S1], true, '超时须放行（ready=true）');
        assertEqual(store.overviewFailedBySession[S1], true, '超时须置 failed=true（保守侧）');
        assertEqual(store.queueStateKnown(S1), false, '超时会话须 unknown（保守入队）');
      },
    );
  },
]);
behaviorCases.push([
  'A3-2 行为④：已过门会话不重拉（ensureOverviewReady 幂等早退）',
  async () => {
    let calls = 0;
    await withWindow(async (sid: string) => { calls += 1; return baseOverview(sid); }, async (store) => {
      await store.ensureOverviewReady(S1);
      assertEqual(calls, 1, '首次过门恰拉取一次');
      await store.ensureOverviewReady(S1);
      assertEqual(calls, 1, '已过门不得重拉（含失败放行后的会话不重复等待）');
    });
  },
]);
behaviorCases.push([
  'A3-2 行为⑤：切会话 per-session 键隔离——旧会话结果不串扰新会话门',
  () => withWindow(async (sid: string) => baseOverview(sid), async (store) => {
    await store.ensureOverviewReady('sess-a');
    assertEqual(store.queueStateKnown('sess-b'), false, '未过门的新会话须独立 unknown');
    await store.ensureOverviewReady('sess-b');
    assertEqual(store.queueStateKnown('sess-a'), true, '旧会话门态不受新会话拉取影响');
    assertEqual(store.queueStateKnown('sess-b'), true, '新会话过门');
  }),
]);
behaviorCases.push([
  'A3-2 行为⑥（P34 回归钉）：无关操作残留 error 不误标成功拉取（返回值判据）',
  () => withWindow(async (sid: string) => baseOverview(sid), async (store) => {
    // 复现 P34：removeTask/reorder/setPaused 失败置 this.error 后成功路径不清（store 既有形态），
    // 随后的成功 loadOverview 不得被该残留位误标 failed（原 this.error != null 判据在此必红）。
    store.error = '删除任务失败（残留）';
    await store.ensureOverviewReady(S1);
    assertEqual(store.overviewReadyBySession[S1], true, '成功拉取须过门（ready=true）');
    assertEqual(store.overviewFailedBySession[S1], false, '成功拉取不得被残留 error 误标 failed（P34）');
    assertEqual(store.queueStateKnown(S1), true, '成功拉取须 known（A2 保守入队窗不被放大）');
  }),
]);

console.log('\n=== A3-2 负向钉：无「仅记错不放行」路径 ===');
check('A3-2 负向钉：ensureOverviewReady 超时与 finally 两兜底分支均写 ready=true（任何 settle 路径放行）', () => {
  const releaseWrites = ensureBody().match(/overviewReadyBySession\[sessionId\] = true/g) ?? [];
  assert(releaseWrites.length >= 2, `ensureOverviewReady 放行写点须≥2（超时兜底+finally 兜底），实测 ${releaseWrites.length}`);
  assert(ensureBody().includes('setTimeout'), '须有 3s 超时兜底（主进程超时/异常不得永久禁言）');
  assert(ensureBody().includes('3000'), '超时窗字面 3000（契约 3s）');
  assert(ensureBody().includes('Promise.race'), '须以 Promise.race 竞速拉取与超时');
  assert(ensureBody().includes('overviewFailedBySession[sessionId] = !loadOk'), 'failed 须经 loadOverview 返回值判（P34：共享 error 位受无关残留误标）');
});
check('A3-2 负向钉：loadOverview catch 只置 error；放行职责收敛在 ensureOverviewReady（职责单源）', () => {
  const catchBody = loadOverviewBody().slice(loadOverviewBody().indexOf('} catch'));
  assert(catchBody.includes('this.error ='), 'catch 须置 error');
  assert(!catchBody.includes('overviewReadyBySession'), 'loadOverview 失败路径不得写 ready（放行兜底单源在 ensureOverviewReady）');
});

console.log('\n=== 附属结构钉：queue-strip 队列状态轻量指示条（02 §2.2 载体） ===');
check('结构钉①：queue-strip 载体存在（data-testid/role/v-if 绑定 queueStatusLine）且插在 .chat-composer 之前', () => {
  assert(chatPageSrc.includes('data-testid="queue-status-strip"'), '缺 data-testid="queue-status-strip"');
  assert(chatPageSrc.includes('class="queue-strip"'), '缺 .queue-strip 载体');
  const stripIdx = chatPageSrc.indexOf('data-testid="queue-status-strip"');
  assert(chatPageSrc.slice(Math.max(0, stripIdx - 120), stripIdx).includes('v-if="queueStatusLine"'), '指示条须 v-if="queueStatusLine"（无态不渲染）');
  assert(chatPageSrc.includes('role="status"'), '指示条须 role="status"（无障碍语义）');
  const composerIdx = chatPageSrc.indexOf('class="chat-composer"');
  assert(stripIdx > -1 && composerIdx > stripIdx, '指示条须插在 .chat-composer 之前（输入区上方唯一队列可见面）');
});
check('结构钉②：queueStatusLine 五态 kind 齐备（recovering/countdown/running/halt/paused）', () => {
  const idx = chatPageSrc.indexOf('const queueStatusLine = computed');
  assert(idx > -1, 'ChatPage 缺 queueStatusLine computed');
  const lineEnd = chatPageSrc.indexOf('\n});', idx);
  const body = chatPageSrc.slice(idx, lineEnd);
  for (const kind of ['recovering', 'countdown', 'running', 'halt', 'paused']) {
    assert(body.includes(`'${kind}'`), `五态缺 kind '${kind}'`);
  }
  assert(body.includes("status === 'countdown'"), 'countdown 态须判 queueState.status');
  assert(body.includes("status === 'running'"), 'running 态须判 queueState.status');
  assert(body.includes("standbyReason === 'halt_failed'"), '熔断态须判 standbyReason=halt_failed');
  assert(body.includes("standbyReason === 'halt_interrupted'"), '熔断态须判 standbyReason=halt_interrupted');
  assert(body.includes('.filter((t) => t.paused)'), '暂停计数须由 tasks.filter(paused) 派生');
});
check('结构钉③：五态文案字面（恢复中/倒计时+秒数+条数/执行中/熔断双因/暂停 N 条）', () => {
  for (const text of ['队列状态恢复中…', '队列倒计时', '· 队列 ${taskStore.tasks.length} 条', '队列任务执行中', '队列已熔断（回合失败）', '队列已熔断（已中断）', '条任务已暂停']) {
    assert(chatPageSrc.includes(text), `缺文案「${text}」`);
  }
});
check('结构钉④：standby 无暂停/熔断不渲染（末分支 return null）', () => {
  const idx = chatPageSrc.indexOf('const queueStatusLine = computed');
  const lineEnd = chatPageSrc.indexOf('\n});', idx);
  const body = chatPageSrc.slice(idx, lineEnd);
  assert(body.trimEnd().endsWith('return null;'), 'computed 末分支须 return null（standby 无暂停不渲染，右栏面板已覆盖）');
});
check('结构钉⑤：样式 token 纪律——queue-strip 样式切片全 var()/color-mix，无裸 hex', () => {
  const styleIdx = chatPageSrc.lastIndexOf('<style scoped>');
  const styleSection = chatPageSrc.slice(styleIdx);
  const stripIdx = styleSection.indexOf('.queue-strip');
  assert(stripIdx > -1, '缺 .queue-strip 样式块');
  const slice = styleSection.slice(stripIdx);
  assert(!/#[0-9a-fA-F]{3,8}\b/.test(slice), 'queue-strip 样式切片不得出现裸 hex（浅深双板全 token）');
  assert(slice.includes('color-mix(in srgb, var(--color-panel-soft)'), '背景须按 .notice warn 混色先例走 color-mix+panel-soft');
  assert(slice.includes('var(--color-border)'), '边框须走 var(--color-border)');
  assert(slice.includes('var(--color-warn'), 'warn 态须走 --color-warn 族 token');
  assert(slice.includes('var(--color-accent)'), '倒计时进度条填充须走 var(--color-accent)');
  assert(slice.includes('var(--radius-sm)'), '圆角须走 var(--radius-sm)');
});

async function main(): Promise<void> {
  for (const [name, fn] of behaviorCases) {
    await fn()
      .then(() => { passed += 1; console.log(`  PASS ${name}`); })
      .catch((e: unknown) => { failed += 1; console.log(`  FAIL ${name} — ${(e instanceof Error ? e.message : String(e)).slice(0, 300)}`); });
  }
  console.log(`\n[tdd-queue-restore-gate] passed=${passed} failed=${failed}`);
  process.exit(failed > 0 ? 1 : 0);
}

void main();
