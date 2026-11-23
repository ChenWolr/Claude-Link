// tdd-activity-f1-f5-verify.ts
// F 活动面板组（F1~F5）共用契约脚本（点 F1 先行，F2~F5 由对应点追加本文件）。
// 本点（F1 输出弹窗 Esc）转写用例正本 = docs/ui-completion/tests/F-activity-panel-cases.md
// §F1 全部用例（F1-01～F1-06，逐条对号；附 B 保全用例 F1-04 转写即绿属预期——防倒退钉，
// RED 判据不适用）：
//   · F1-01 输出弹窗 Esc 分支（结构钉：注册存在 + 守卫先于消费，对照 InteractionPrompt A9-② 形态）；
//   · F1-02 分层让位（结构钉：bgOutputDialog===1199 落 1100~1200 空隙且 < interaction +
//     行为组：interaction 在场时输出层 isTopmost()===false，释放后恢复）；
//   · F1-03 Esc 急停不双吞（行为等价钉：① escConsumerOpen 纳 .bg-output-mask 探测 或
//     ② Esc 分支先于关闭 preventDefault——二选一形态任一成立，不绑实现；附 ChatPage 既有
//     急停守卫保全：IME/defaultPrevented/sending/bridgeLocked/五类消费者探测负向防删）；
//   · F1-04 遮罩/× 关闭保全（结构钉，转写即绿属预期）；
//   · F1-05 Esc 关闭焦点还原（结构钉：打开记录触发元素（$event→currentTarget）→关闭路径
//     还原（?. 降级落 body）→打开路径不抢焦）；
//   · F1-06 同层值路由互斥 + 层注册无泄漏（结构钉：watch 注册/释放 + onUnmounted 卸载兜底 +
//     行为组：输出层与 mcpDialog 层 handle 各自 release 幂等、互不干扰）。
// 行为组形态对齐 tdd-esc-stack-verify（use-esc-stack 纯 composable tsx 直测，createRequire
// 引入——本脚本入 tsconfig.tdd.json 闸门，禁裸 require）。
// 运行：npx tsx scripts/tdd-activity-f1-f5-verify.ts（登记 scripts/selftest-static-list.txt +
// tsconfig.tdd.json）
// 红线：readTaskOutput IPC 三处同步（preload api.ts / web-bridge.ts）零触碰，本脚本不断言该链。
// P6-B 契约迁移 2026-11-21（同 MOD-P6-1 族）：F4-04 实时正文交互钉由 @click="onLiveTextClick"
// 迁至 @contextmenu="onLiveTextContextMenu"（左键零动作、右键菜单唯一入口；TaskQueuePanel.vue
// :742/:794 两处绑定，计数钉按全文件口径——后台任务卡 :794 一处在 F4-04 region 截取范围之外）。

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const taskQueue = read('../src/renderer/components/task/TaskQueuePanel.vue');
const chatPage = read('../src/renderer/pages/ChatPage.vue');
const escStack = read('../src/renderer/composables/use-esc-stack.ts');

// use-esc-stack 模块（行为组；实现缺 bgOutputDialog 键时断言按失败计）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esc: any = null;
try {
  const req = createRequire(import.meta.url);
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  esc = req('../src/renderer/composables/use-esc-stack');
} catch {
  esc = null;
}

// 定位工具：TaskQueuePanel Esc 分支函数体（onOutputEscKey → 其后第一个顶层块为界）。
function outputEscFnBody(): string {
  const idx = taskQueue.indexOf('function onOutputEscKey');
  assert.ok(idx > -1, 'TaskQueuePanel 缺 onOutputEscKey Esc 分支函数');
  const end = taskQueue.indexOf('watch(outputVisible', idx);
  return taskQueue.slice(idx, end > -1 ? end : idx + 600);
}
// ChatPage escConsumerOpen 函数体（到 onGlobalKeydown 为界）。
function escConsumerOpenBody(): string {
  const idx = chatPage.indexOf('function escConsumerOpen');
  assert.ok(idx > -1, 'ChatPage 缺 escConsumerOpen');
  const end = chatPage.indexOf('function onGlobalKeydown', idx);
  return chatPage.slice(idx, end > -1 ? end : idx + 800);
}

console.log('\n=== F1-01：输出弹窗打开时按 Esc 关闭（结构钉） ===');
check('F1-01 输出弹窗注册 bgOutputDialog 层；Esc 分支守卫先于消费', () => {
  assert.match(taskQueue, /pushEscLayer\(ESC_LAYER_PRIORITY\.bgOutputDialog\)/, '缺输出弹窗层注册');
  assert.match(taskQueue, /from '\.\.\/\.\.\/composables\/use-esc-stack';/, '缺 composable import');
  const fnBody = outputEscFnBody();
  const escIdx = fnBody.indexOf("e.key !== 'Escape'");
  assert.ok(escIdx > -1, 'Esc 分支缺 Escape 早退（e.key !== \'Escape\'）');
  const guardIdx = fnBody.indexOf('isTopmost()');
  assert.ok(guardIdx > escIdx, 'Esc 分支缺 isTopmost 让位守卫（或守卫先于早退）');
  const pdIdx = fnBody.indexOf('e.preventDefault()');
  assert.ok(pdIdx > guardIdx, '守卫必须先于 preventDefault（让位时不得消费事件）');
  const closeIdx = fnBody.indexOf('outputVisible.value = false');
  assert.ok(closeIdx > pdIdx, 'Esc 分支须消费事件（preventDefault）后关闭弹窗');
});

console.log('\n=== F1-02：Esc 分层让位（结构钉 + 行为组） ===');
check('F1-02 结构钉：bgOutputDialog=1199 落 1100~1200 空隙且 < interaction', () => {
  assert.ok(esc, 'use-esc-stack 模块加载失败');
  assert.equal(esc.ESC_LAYER_PRIORITY.bgOutputDialog, 1199, '输出弹窗层值须为 1199（与 mcpDialog 同级约定）');
  assert.ok(
    esc.ESC_LAYER_PRIORITY.bgOutputDialog >= 1100 && esc.ESC_LAYER_PRIORITY.bgOutputDialog < esc.ESC_LAYER_PRIORITY.interaction,
    '层值须落在 1100~1200 空隙且低于 interaction（≥1200 会在与交互弹窗并存时误关输出弹窗）',
  );
  // 路由互斥注释钉：表内须声明与 mcpDialog 同层值但路由互斥（配置页/会话页）。
  assert.ok(escStack.includes('bgOutputDialog'), '优先级表缺 bgOutputDialog 键');
});
check('F1-02 行为组：interaction 在场时输出层让位；交互层释放后输出层恢复', () => {
  assert.ok(esc, 'use-esc-stack 模块加载失败');
  const output = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.bgOutputDialog);
  const interaction = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.interaction);
  assert.equal(output.isTopmost(), false, 'interaction 1200 在场时输出层 1199 应让位');
  assert.equal(interaction.isTopmost(), true, 'interaction 应为顶层');
  interaction.release();
  assert.equal(output.isTopmost(), true, '交互层释放后输出层应恢复响应');
  output.release();
});

console.log('\n=== F1-03：Esc 急停不双吞（行为等价钉，弹窗开 + 回合运行按 Esc 不得中断回合） ===');
check('F1-03 等价形态其一成立：escConsumerOpen 纳探测 或 Esc 分支先于关闭 preventDefault', () => {
  const ecoBody = escConsumerOpenBody();
  const form1 = ecoBody.includes(".bg-output-mask");
  const fnBody = outputEscFnBody();
  const pdIdx = fnBody.indexOf('e.preventDefault()');
  const closeIdx = fnBody.indexOf('outputVisible.value = false');
  const form2 = pdIdx > -1 && closeIdx > pdIdx;
  assert.ok(
    form1 || form2,
    'Esc 不双吞等价形态缺失：escConsumerOpen 未纳 .bg-output-mask 探测，且输出弹窗 Esc 分支未先于关闭 preventDefault（弹窗开 + 回合运行按 Esc 会误中断回合）',
  );
});
check('F1-03 保全：ChatPage 急停既有守卫全部保持（负向防删）', () => {
  const ecoBody = escConsumerOpenBody();
  for (const probe of [
    'visibleRequestsForActiveSession.length > 0',
    'diffDialogState.value != null',
    'toolDiffDialogState.value != null',
    'imageLightboxState.value != null',
    'filePreviewStore.open',
    ".slash-menu'",
    '.export-overlay',
  ]) {
    assert.ok(ecoBody.includes(probe), `escConsumerOpen 既有探测丢失：${probe}`);
  }
  const gkIdx = chatPage.indexOf('function onGlobalKeydown');
  const gkBody = chatPage.slice(gkIdx, chatPage.indexOf('onMounted(', gkIdx));
  assert.ok(gkBody.includes("e.key !== 'Escape'"), 'onGlobalKeydown 缺 Escape 早退');
  assert.ok(gkBody.includes('isComposing'), 'onGlobalKeydown 缺 IME 组合态守卫');
  assert.ok(gkBody.includes('e.defaultPrevented'), 'onGlobalKeydown 缺 defaultPrevented 让位');
  assert.ok(gkBody.includes('!sending.value'), 'onGlobalKeydown 缺 sending 门');
  assert.ok(gkBody.includes('bridgeLocked.value'), 'onGlobalKeydown 缺桥接只读守卫');
  assert.ok(gkBody.includes('escConsumerOpen()'), 'onGlobalKeydown 缺消费者探测');
});

console.log('\n=== F1-04：遮罩/× 关闭保全（防倒退钉，转写即绿属预期） ===');
check('F1-04 遮罩 @click.self 关闭 + × 钮 aria-label=关闭 且 click 关闭保持', () => {
  const maskIdx = taskQueue.indexOf('class="bg-output-mask"');
  assert.ok(maskIdx > -1, '缺 bg-output-mask 遮罩');
  const maskLine = taskQueue.slice(maskIdx, taskQueue.indexOf('>', maskIdx) + 1);
  assert.ok(maskLine.includes('@click.self="outputVisible = false"'), '遮罩 @click.self 关闭丢失');
  const closeIdx = taskQueue.indexOf('bg-output-dialog__close');
  assert.ok(closeIdx > -1, '缺 × 关闭钮');
  const closeLine = taskQueue.slice(closeIdx, taskQueue.indexOf('</button>', closeIdx));
  assert.ok(closeLine.includes('aria-label="关闭"'), '× 钮 aria-label="关闭" 丢失');
  assert.ok(closeLine.includes('@click="outputVisible = false"'), '× 钮 click 关闭丢失');
});

console.log('\n=== F1-05：Esc 关闭时焦点还原到触发钮（结构钉） ===');
check('F1-05 打开记录触发元素（$event→currentTarget）；关闭路径 ?. 降级还原；打开不抢焦', () => {
  assert.match(taskQueue, /outputTriggerEl/, '缺 outputTriggerEl 触发元素记录');
  assert.match(
    taskQueue,
    /function openTaskOutput\(t: BackgroundTask, \w+\?: MouseEvent\)/,
    'openTaskOutput 签名缺事件参数',
  );
  assert.match(taskQueue, /@click="openTaskOutput\(t, \$event\)"/, '模板触发钮未传 $event');
  assert.match(taskQueue, /outputTriggerEl\.value = \(.*currentTarget/, '打开路径未记录 currentTarget');
  const fnBody = outputEscFnBody();
  assert.match(fnBody, /outputTriggerEl\.value\?\.focus\(\)/, 'Esc 关闭路径缺焦点还原（须 ?. 降级：目标卸载安全落 body）');
  // 打开时既有焦点行为不变：openTaskOutput 内不得调用 focus()（打开不抢焦）。
  const openIdx = taskQueue.indexOf('function openTaskOutput');
  const openBody = taskQueue.slice(openIdx, openIdx + 1200);
  assert.ok(!openBody.includes('.focus()'), 'openTaskOutput 打开路径不得抢焦');
});

console.log('\n=== F1-06：同层值路由互斥 + 层注册无泄漏（结构钉 + 行为组） ===');
check('F1-06 结构钉：watch(outputVisible) 注册/释放接线 + onUnmounted 卸载兜底', () => {
  assert.match(taskQueue, /watch\(\s*outputVisible/, '缺 outputVisible watch 注册/释放接线');
  assert.match(taskQueue, /import \{[^}]*onUnmounted[^}]*\} from 'vue';/, '缺 onUnmounted import');
  assert.match(taskQueue, /onUnmounted\(\s*\(\)\s*=>\s*\{/, '缺卸载兜底钩子');
  assert.match(taskQueue, /escLayer\?\.release\(\)/, '卸载兜底缺层释放（escLayer?.release()）');
});
check('F1-06 行为组：输出层与 mcpDialog 层 handle 各自 release 幂等、互不干扰', () => {
  assert.ok(esc, 'use-esc-stack 模块加载失败');
  const out = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.bgOutputDialog);
  const mcp = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.mcpDialog);
  assert.equal(out.isTopmost(), true, '仅输出层 + mcp 层同值在场时输出层应为顶（无更高层）');
  assert.equal(mcp.isTopmost(), true);
  out.release();
  out.release(); // 幂等：二次 release 不炸
  assert.equal(out.isTopmost(), false, '输出层释放后 isTopmost 应为 false');
  assert.equal(mcp.isTopmost(), true, '输出层释放不得影响 mcp 层（各自独立句柄，路由互斥不串扰）');
  mcp.release();
  assert.equal(mcp.isTopmost(), false);
});

// ---------------------------------------------------------------------------
// F2：队列加载失败横条 + 重试（task-store 增 overviewError）——用例正本 =
// docs/ui-completion/tests/F-activity-panel-cases.md §F2 全部用例（F2-01～F2-06
// 逐条对号，四向覆盖：正常 01/02/06、边界 03、异常 04、并发 05）：
//   · F2-01 失败横条渲染门绑 overviewError + 文案模板「加载队列失败：{error}」非写死
//     + 重试钮存在（结构钉 + 行为组：Error 拒绝置具体 message / 非 Error 拒绝走兜底「加载队列失败」同模板）；
//   · F2-02 重试成功或下次拉取成功即收横条（结构钉：loadOverview 入口清空 overviewError
//     先于 try——成功路径不清不置即「成功即收」裁决 F-C1；行为组：失败置值→再次成功收敛 null）；
//   · F2-03 空队列（成功）不显示横条（结构钉：渲染门只看 error 不看 tasks.length 空态 +
//     空态文案逐字保绿；行为组：成功且 tasks=[] 恒不置值）；
//   · F2-04 失败不弹全局 toast（结构钉负断言：TaskQueuePanel/task-store 无全局 toast 通道
//     标识符；行为组负断言：失败路径 window.claudeLink 仅 getQueueOverview 被访问）；
//   · F2-05 会话切换重新拉取后状态正确（行为组：A 失败→B 成功收敛、C 失败显 C 的 error
//     不残留 A；结构钉防倒退：面板 watch activeSession?.id 拉取 + onMounted 兜底保全——A-8）；
//   · F2-06 重试钮以当前活动会话 id 重新拉取（结构钉：click→面板 loadOverview→
//     taskStore.loadOverview(sessionStore.activeSession.id)；行为组：sessionId 透传）。
// 红线防倒退钉：task-store error 字段既有生产/消费零改动（addTask catch 置值返回 false、
// loadOverview 既有 this.error 写入行保持、TaskQueuePanel handleRunNow/handleResumeAll
// requestConfirm 消费保持）；getQueueOverview handler 零触碰不在本脚本断言面。
// 行为组形态：task-store 真模块 createRequire 引入（tsx 下 .ts 可加载）+ pinia 内存实例 +
// window.claudeLink stub（Proxy 记录被访问通道名，负断言复用）——禁裸 require 同 F1。
// ---------------------------------------------------------------------------

const taskStoreSrc = read('../src/renderer/stores/task-store.ts');

// task-store 真模块（行为组；加载失败时行为组按失败计，结构钉不受影响）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let taskStoreMod: any = null;
try {
  const req = createRequire(import.meta.url);
  taskStoreMod = req('../src/renderer/stores/task-store');
} catch {
  taskStoreMod = null;
}

async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// 定位工具：task-store loadOverview 函数体（到下一 action addTask 为界）。
function loadOverviewFnBody(): string {
  const idx = taskStoreSrc.indexOf('async loadOverview');
  assert.ok(idx > -1, 'task-store 缺 loadOverview');
  const end = taskStoreSrc.indexOf('async addTask', idx);
  return taskStoreSrc.slice(idx, end > -1 ? end : idx + 800);
}
// 定位工具：TaskQueuePanel queue-error 失败横条块（开标签到自身 </div>）。
function queueErrorBarBlock(): string {
  const idx = taskQueue.indexOf('class="queue-error"');
  assert.ok(idx > -1, 'TaskQueuePanel 缺 queue-error 失败横条');
  const end = taskQueue.indexOf('</div>', idx);
  return taskQueue.slice(idx, end > -1 ? end : idx + 500);
}
// 定位工具：TaskQueuePanel 本地 loadOverview 函数体（到 handleDelete 为界）。
function panelLoadOverviewFnBody(): string {
  const idx = taskQueue.indexOf('function loadOverview()');
  assert.ok(idx > -1, 'TaskQueuePanel 缺本地 loadOverview');
  const end = taskQueue.indexOf('function handleDelete', idx);
  return taskQueue.slice(idx, end > -1 ? end : idx + 400);
}

// F2 行为组 harness：每例独立 pinia + window.claudeLink stub（Proxy 记录被访问通道名）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeTaskHarness(getQueueOverview: (sessionId: string) => Promise<unknown>): any {
  assert.ok(taskStoreMod, 'task-store 模块加载失败（行为组不可用）');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;
  const calls: string[] = [];
  const prevWindow = g.window;
  g.window = {
    claudeLink: new Proxy(
      { getQueueOverview },
      {
        get(target: Record<string, unknown>, prop: string | symbol) {
          if (typeof prop === 'string') calls.push(prop);
          if (prop === 'getQueueOverview') return target.getQueueOverview;
          return target[prop as string];
        },
      },
    ),
  };
  const req = createRequire(import.meta.url);
  const pinia = req('pinia');
  pinia.setActivePinia(pinia.createPinia());
  const store = taskStoreMod.useTaskStore();
  return {
    store,
    calls,
    restore: () => { g.window = prevWindow; },
  };
}

// QueueOverview stub（成功响应；空队列默认 tasks=[]）。
function overviewOk(tasks: unknown[] = []): unknown {
  return {
    tasks,
    executed: [],
    state: { sessionId: '', status: 'standby', standbyReason: null, countdownRemaining: 0, currentTaskId: null },
  };
}

console.log('\n=== F2-01：失败横条（渲染门 + 文案模板 + 重试钮；结构钉） ===');
check('F2-01 结构钉：store 增 overviewError 字段；loadOverview catch 置值（非 Error 走兜底文案）', () => {
  assert.match(taskStoreSrc, /overviewError: null as string \| null,/, 'task-store state 缺 overviewError 字段');
  assert.match(
    taskStoreSrc,
    /this\.overviewError = error instanceof Error \? error\.message : '加载队列失败';/,
    'loadOverview catch 缺 overviewError 置值（须含非 Error 兜底「加载队列失败」）',
  );
});
check('F2-01 结构钉：横条渲染门绑 taskStore.overviewError；文案模板含 {error} 非写死；重试钮存在', () => {
  const bar = queueErrorBarBlock();
  assert.ok(taskQueue.includes('v-if="taskStore.overviewError"'), '横条渲染门缺失（须 v-if 绑 taskStore.overviewError）');
  assert.ok(bar.includes('加载队列失败：{{ taskStore.overviewError }}'), '文案须为模板插值「加载队列失败：{{ taskStore.overviewError }}」（写死不含 {error} 必红）');
  assert.ok(bar.includes('@click="loadOverview"'), '重试钮缺 click 接线');
  assert.ok(bar.includes('重试</button>'), '缺「重试」钮');
});

console.log('\n=== F2-01 行为组：失败置值（Error / 非 Error 两形态） ===');
const f2BehaviorTasks: Array<[string, () => Promise<void>]> = [];
f2BehaviorTasks.push([
  'F2-01 行为组：loadOverview 拒绝（Error）→ overviewError = 具体 message',
  async () => {
    const h = makeTaskHarness(async () => { throw new Error('队列 IPC 断'); });
    try {
      await h.store.loadOverview('sess-1');
      assert.equal(h.store.overviewError, '队列 IPC 断', '失败未置 overviewError 为具体 message');
    } finally { h.restore(); }
  },
]);
f2BehaviorTasks.push([
  'F2-01 行为组：loadOverview 拒绝（非 Error）→ overviewError = 兜底「加载队列失败」',
  async () => {
    const h = makeTaskHarness(async () => { throw '字符串拒绝'; });
    try {
      await h.store.loadOverview('sess-1');
      assert.equal(h.store.overviewError, '加载队列失败', '非 Error 拒绝未走兜底文案');
    } finally { h.restore(); }
  },
]);

console.log('\n=== F2-02：成功即收（结构钉 + 行为组；裁决 F-C1） ===');
check('F2-02 结构钉：loadOverview 入口清空 overviewError（入口行先于 try——成功路径不清不置即收）', () => {
  const fn = loadOverviewFnBody();
  const clearIdx = fn.indexOf('this.overviewError = null;');
  const tryIdx = fn.indexOf('try {');
  assert.ok(clearIdx > -1, 'loadOverview 缺入口清空（this.overviewError = null）');
  assert.ok(tryIdx > -1 && clearIdx < tryIdx, '入口清空必须先于 try（成功即收 F-C1）');
});
f2BehaviorTasks.push([
  'F2-02 行为组：失败置值 → 再次拉取成功 → overviewError 收敛为 null（重试成功/下次拉取成功即收）',
  async () => {
    let ok = false;
    const h = makeTaskHarness(async () => {
      if (!ok) throw new Error('首轮失败');
      return overviewOk([{ id: 't1' }]);
    });
    try {
      await h.store.loadOverview('sess-1');
      assert.equal(h.store.overviewError, '首轮失败', '前置失败未置值');
      ok = true;
      await h.store.loadOverview('sess-1');
      assert.equal(h.store.overviewError, null, '成功拉取未收敛 overviewError（横条须收）');
      assert.equal(h.store.tasks.length, 1, '成功拉取数据未应用');
    } finally { h.restore(); }
  },
]);

console.log('\n=== F2-03：空队列（成功）不显示横条（边界） ===');
check('F2-03 结构钉：渲染门只看 error 不看空态；空态文案逐字保绿', () => {
  const bar = queueErrorBarBlock();
  assert.ok(!bar.includes('tasks.length'), '渲染门不得引用 tasks.length（空态不触发横条）');
  assert.ok(
    taskQueue.includes('暂无排队任务；开启队列任务后，回复生成中在会话框发送即入队'),
    '空态文案丢失（须逐字保持）',
  );
});
f2BehaviorTasks.push([
  'F2-03 行为组：成功且 tasks=[] → overviewError 恒 null（不误置）',
  async () => {
    const h = makeTaskHarness(async () => overviewOk());
    try {
      await h.store.loadOverview('sess-1');
      assert.equal(h.store.overviewError, null, '空队列成功误置 overviewError');
    } finally { h.restore(); }
  },
]);

console.log('\n=== F2-04：失败不弹全局 toast（异常，负断言） ===');
check('F2-04 结构钉负断言：TaskQueuePanel 与 task-store 无全局 toast 通道标识符', () => {
  for (const src of [taskQueue, taskStoreSrc]) {
    for (const id of ['sessionErrorToast', 'providerErrorToast', 'showToast', 'pushToast']) {
      assert.ok(!src.includes(id), `失败链不得接入全局 toast 通道（发现 ${id}）`);
    }
  }
});
f2BehaviorTasks.push([
  'F2-04 行为组负断言：失败路径 window.claudeLink 仅 getQueueOverview 被访问',
  async () => {
    const h = makeTaskHarness(async () => { throw new Error('x'); });
    try {
      await h.store.loadOverview('sess-1');
      assert.deepEqual(h.calls, ['getQueueOverview'], `失败路径触达了额外通道：${h.calls.join(',')}`);
    } finally { h.restore(); }
  },
]);

console.log('\n=== F2-05：会话切换重新拉取后状态正确（并发/状态） ===');
f2BehaviorTasks.push([
  'F2-05 行为组：A 失败→B 成功收敛；C 失败显 C 的 error（A 不残留）',
  async () => {
    const errorsBySession: Record<string, string | null> = { A: 'A 拉取失败', B: null, C: 'C 拉取失败' };
    const h = makeTaskHarness(async (sessionId: string) => {
      const err = errorsBySession[sessionId];
      if (err) throw new Error(err);
      return overviewOk();
    });
    try {
      await h.store.loadOverview('A');
      assert.equal(h.store.overviewError, 'A 拉取失败', 'A 失败未置值');
      await h.store.loadOverview('B');
      assert.equal(h.store.overviewError, null, 'B 成功未收敛（A 的 error 残留到 B）');
      await h.store.loadOverview('C');
      assert.equal(h.store.overviewError, 'C 拉取失败', 'C 失败未显示 C 自己的 error');
    } finally { h.restore(); }
  },
]);
check('F2-05 结构钉防倒退：面板 watch activeSession?.id 拉取 + onMounted 兜底保全（A-8，重试为叠加非替换）', () => {
  const watchIdx = taskQueue.indexOf('() => sessionStore.activeSession?.id');
  assert.ok(watchIdx > -1, '缺会话切换 watch（activeSession?.id）');
  const watchBody = taskQueue.slice(watchIdx, watchIdx + 300);
  assert.ok(watchBody.includes('if (sessionStore.activeSession) loadOverview();'), '切换 watch 拉取接线丢失');
  const mountedIdx = taskQueue.indexOf('onMounted(() => {');
  assert.ok(mountedIdx > -1, '缺 onMounted 兜底钩子');
  const mountedBody = taskQueue.slice(mountedIdx, taskQueue.indexOf('});', mountedIdx));
  assert.ok(mountedBody.includes('loadOverview();'), 'onMounted 兜底拉取丢失（重试接线不得替换兜底，route-gate B② 保全）');
});

console.log('\n=== F2-06：重试钮 = 以当前活动会话 id 重新拉取 ===');
check('F2-06 结构钉：横条 click → 面板 loadOverview → taskStore.loadOverview(activeSession.id)', () => {
  const bar = queueErrorBarBlock();
  assert.ok(bar.includes('@click="loadOverview"'), '重试钮未接面板本地 loadOverview');
  const fn = panelLoadOverviewFnBody();
  assert.match(
    fn,
    /taskStore\.loadOverview\(sessionStore\.activeSession\.id\)/,
    '面板 loadOverview 未以当前活动会话 id 调 store（绑陈旧 sessionId 必红）',
  );
});
f2BehaviorTasks.push([
  'F2-06 行为组：sessionId 透传（stub 收到 === 传入会话 id）',
  async () => {
    let received: string | null = null;
    const h = makeTaskHarness(async (sessionId: string) => {
      received = sessionId;
      return overviewOk();
    });
    try {
      await h.store.loadOverview('sess-target');
      assert.equal(received, 'sess-target', 'sessionId 未透传到 IPC');
    } finally { h.restore(); }
  },
]);

console.log('\n=== F2 红线：error 字段既有生产/消费零改动（防倒退钉） ===');
check('F2 红线钉：addTask 失败链 / loadOverview 既有 this.error 写入 / requestConfirm 弹窗消费保持', () => {
  assert.match(
    taskStoreSrc,
    /this\.error = error instanceof Error \? error\.message : '添加任务失败';\s*\n\s*return false;/,
    'addTask 失败链（置 error + return false）被改动',
  );
  assert.match(
    loadOverviewFnBody(),
    /this\.error = error instanceof Error \? error\.message : '加载队列失败';/,
    'loadOverview 既有 this.error 写入行被移除（error 字段生产面零改动红线）',
  );
  const runNowIdx = taskQueue.indexOf('async function handleRunNow');
  const runNowBody = taskQueue.slice(runNowIdx, runNowIdx + 500);
  assert.ok(runNowBody.includes('message: taskStore.error,'), 'handleRunNow requestConfirm 弹窗消费丢失');
  const resumeAllIdx = taskQueue.indexOf('async function handleResumeAll');
  const resumeAllBody = taskQueue.slice(resumeAllIdx, resumeAllIdx + 500);
  assert.ok(resumeAllBody.includes('message: taskStore.error,'), 'handleResumeAll requestConfirm 弹窗消费丢失');
});

// ---------------------------------------------------------------------------
// F3：倒计时进度条（queueState 快照全长，禁本地计时器）——用例正本 =
// docs/ui-completion/tests/F-activity-panel-cases.md §F3 全部用例（F3-01～F3-06
// 逐条对号，四向覆盖：正常 01/02、边界 03/04、异常 05、并发 06（事件驱动刷新））：
//   · F3-01 队首任务卡倒计时期渲染进度条（结构钉：cdbar 紧随 ETA 行 + 面板 :countdown-percent
//     传参（:key 之后、事件之前）+ 行为组：countdown 态队首返回数值、非队首 null）；
//   · F3-02 宽度映射（行为组真实输入输出：remaining=interval→100、递减同比例、0→0；
//     结构钉：分母=intervalSeconds 快照优先（裁决 F-C3）+ 缺失回退 resolveQueueDelaySeconds
//     与 etaFor 同式；行为组：快照存在零回退、缺失走回退全长）；
//   · F3-03 两极间隔平滑（行为组：interval=60/3600 单调 + 钳制 [0,100] + 中点抽验；
//     负 remaining→渲染门拦截返回 null 绝无负宽度——impl §3.4-3 异常防御形态，
//     与 eta 负数钳 0 既有口径同向）；
//   · F3-04 五分支渲染门（结构钉逐分支标识符 + 行为组：standby/running/paused/非队首/
//     interval 非法全 null，正例唯一渲染）；
//   · F3-05 数据纪律负断言（两文件 setInterval 零出现 + TaskItem 纯 props 无 store/useNow
//     + 函数体无本地计时标识符、数据源=队列投影）；
//   · F3-06 数据源绑定队列投影（附 B 保全，转写即绿属预期：store countdown_started 快照
//     + tick 镜像既有链钉 + TaskItem 无本地进度镜像）。
// 行为组形态：countdownPercentFor 为组件内纯计算（.vue 不可模块加载）——大括号配平提取
// 函数源码文本 + new Function 剥离 TS 签名后注入 stub（taskStore/configStore/
// resolveQueueDelaySeconds/leadingTaskId）真实执行实现代码；提取失败即计失败（RED 判据
// 对准实现缺口），禁裸 require 同 F1/F2。
// 红线：shared/queue-eta.ts 零触碰（本脚本不断言其内容）；task-store queueState 投影
// 既有链零改动（F3-06 钉保全）；task-queue-engine 倒计时泵零触碰（不在断言面）。
// ---------------------------------------------------------------------------

const taskItemSrc = read('../src/renderer/components/task/TaskItem.vue');

// 定位工具：大括号配平提取 startMarker 起始的完整函数体（嵌套安全：函数体无字符串含括号）。
function extractBracedFn(src: string, startMarker: string): string {
  const idx = src.indexOf(startMarker);
  assert.ok(idx > -1, `源码缺 ${startMarker}（实现缺口）`);
  let depth = 0;
  let started = false;
  for (let i = idx; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') { depth += 1; started = true; }
    else if (ch === '}') {
      depth -= 1;
      if (started && depth === 0) return src.slice(idx, i + 1);
    }
  }
  assert.ok(false, `${startMarker} 函数体提取失败（大括号配平未闭合）`);
}

// F3 行为组 harness：提取 countdownPercentFor 源码 → 剥 TS 签名 → new Function 注入 stub
// 真实执行；返回 fn 与 resolve 调用计数（快照优先/回退路径判据）。
function buildCountdownPercentFor(h: {
  queueState: { status: string; countdownRemaining: number; intervalSeconds?: number };
  taskDelayMinutes: number;
  leadingId: string | null;
  resolveImpl?: (minutes: number) => number;
}): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  fn: (task: { id: string; paused: boolean }) => any;
  resolveCalls: () => number;
} {
  const fnSrc = extractBracedFn(taskQueue, 'function countdownPercentFor');
  const js = fnSrc.replace(/^function countdownPercentFor\([^)]*\)[^{]*\{/, 'function (task) {');
  let resolveCalls = 0;
  const resolve = (minutes: number): number => {
    resolveCalls += 1;
    return h.resolveImpl ? h.resolveImpl(minutes) : minutes * 60;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const fn = (new Function(
    'taskStore', 'configStore', 'resolveQueueDelaySeconds', 'leadingTaskId',
    `"use strict"; return (${js});`,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) as any)(
    { queueState: h.queueState },
    { config: { taskDelayMinutes: h.taskDelayMinutes } },
    resolve,
    { value: h.leadingId },
  );
  return { fn, resolveCalls: () => resolveCalls };
}

console.log('\n=== F3-01：队首任务卡倒计时期渲染进度条（结构钉 + 行为组） ===');
check('F3-01 结构钉：cdbar div 紧随 ETA 行后（ETA 行不动）、v-if 绑 countdownPercent；面板 :key 后传 :countdown-percent；TaskItem 可选 prop 声明', () => {
  assert.match(
    taskQueue,
    /:countdown-percent="countdownPercentFor\(task\)"/,
    '面板缺 :countdown-percent 传参',
  );
  // 传参位置：:key="task.id" 之后（不得插 v-for 与 :key 之间——queue-semantics-v3 §9 200 字符正则保全）、事件绑定之前。
  const itemIdx = taskQueue.indexOf('<TaskItem');
  const keyIdx = taskQueue.indexOf(':key="task.id"', itemIdx);
  const cdIdx = taskQueue.indexOf(':countdown-percent', itemIdx);
  const evIdx = taskQueue.indexOf('@runnow', itemIdx);
  assert.ok(keyIdx > -1 && cdIdx > keyIdx, ':countdown-percent 须在 :key 之后');
  assert.ok(evIdx > -1 && cdIdx < evIdx, ':countdown-percent 须在事件绑定之前');
  // TaskItem：cdbar 结构 + 渲染门 + 顺序（ETA 行 div 之后、actions 之前）。
  const etaIdx = taskItemSrc.indexOf('class="task-item__eta"');
  const cdBarIdx = taskItemSrc.indexOf('class="task-item__cdbar"');
  const actionsIdx = taskItemSrc.indexOf('class="task-item__actions"');
  assert.ok(etaIdx > -1, 'TaskItem ETA 行丢失（queue-semantics-v3 §10 保全）');
  assert.ok(cdBarIdx > -1, 'TaskItem 缺 cdbar 进度条');
  assert.ok(cdBarIdx > etaIdx && cdBarIdx < actionsIdx, 'cdbar 须在 ETA 行之后、操作钮区之前（ETA 行下方落点）');
  // 块窗口从 ETA 行起（v-if 与 class 同行、v-if 在前，单点定位会截掉开标签前半——以 ETA 行起整窗断言）。
  const cdbarBlock = taskItemSrc.slice(etaIdx, taskItemSrc.indexOf('class="task-item__actions"', etaIdx));
  assert.ok(cdbarBlock.includes('v-if="countdownPercent != null"'), 'cdbar 渲染门须绑 countdownPercent != null');
  assert.ok(cdbarBlock.includes('aria-hidden="true"'), 'cdbar 缺 aria-hidden（纯装饰）');
  assert.ok(cdbarBlock.includes('task-item__cdbar-fill'), 'cdbar 缺 fill 内条');
  assert.ok(cdbarBlock.includes("width: countdownPercent + '%'"), 'fill 宽度须绑定 countdownPercent');
  assert.match(taskItemSrc, /countdownPercent\?: number \| null;/, 'TaskItem 缺 countdownPercent 可选 prop 声明');
  // 样式：2px 渐变 + reduced-motion 降级（视觉形态可钉部分）。
  assert.match(taskItemSrc, /\.task-item__cdbar\s*\{[^}]*height:\s*2px/, 'cdbar 缺 2px 高度');
  assert.match(taskItemSrc, /\.task-item__cdbar-fill\s*\{[^}]*linear-gradient/, 'cdbar fill 缺渐变');
  assert.match(taskItemSrc, /prefers-reduced-motion:\s*reduce[\s\S]{0,120}task-item__cdbar-fill\s*\{[^}]*transition:\s*none/, '缺 reduced-motion 降级');
});
check('F3-01 行为组：countdown 态队首未暂停任务返回数值宽度；第 2 位及以后 → null 不渲染', () => {
  const qs = { status: 'countdown', countdownRemaining: 42, intervalSeconds: 300 };
  const h = buildCountdownPercentFor({ queueState: qs, taskDelayMinutes: 5, leadingId: 't1' });
  const leading = h.fn({ id: 't1', paused: false });
  assert.ok(typeof leading === 'number' && leading > 0, `队首任务倒计时期应返回数值宽度，得到 ${leading}`);
  assert.equal(h.fn({ id: 't2', paused: false }), null, '非队首（第 2 位）任务卡不得渲染进度条');
});

console.log('\n=== F3-02：宽度映射（行为组真实输入输出 + 结构钉数据源） ===');
check('F3-02 行为组：remaining=interval→100%、递减同比例、remaining=0→0%；快照存在零回退（裁决 F-C3 全长=快照）', () => {
  const qs = { status: 'countdown', countdownRemaining: 300, intervalSeconds: 300 };
  const h = buildCountdownPercentFor({ queueState: qs, taskDelayMinutes: 5, leadingId: 't1' });
  const task = { id: 't1', paused: false };
  assert.equal(h.fn(task), 100, 'remaining=interval（满格起点）应为 100%');
  qs.countdownRemaining = 150;
  assert.equal(h.fn(task), 50, '剩余减半应同比例 50%');
  qs.countdownRemaining = 75;
  assert.equal(h.fn(task), 25, '递减应保持同比例');
  qs.countdownRemaining = 0;
  assert.equal(h.fn(task), 0, 'remaining=0（归零执行瞬间）应为 0%');
  assert.equal(h.resolveCalls(), 0, 'intervalSeconds 快照存在时不得回退 resolveQueueDelaySeconds（全长=快照 F-C3）');
});
check('F3-02 结构钉：映射分母=intervalSeconds 快照优先 + 缺失回退与 etaFor 同式；钳制形态在位', () => {
  const fnSrc = extractBracedFn(taskQueue, 'function countdownPercentFor');
  assert.ok(fnSrc.includes('taskStore.queueState'), '进度函数数据源须为 taskStore.queueState 投影（非组件内镜像）');
  assert.ok(fnSrc.includes('st.intervalSeconds ??'), '全长须快照优先（intervalSeconds ?? …，裁决 F-C3）');
  assert.ok(
    fnSrc.includes('resolveQueueDelaySeconds(configStore.config.taskDelayMinutes)'),
    '快照缺失回退须与 etaFor 同式（resolveQueueDelaySeconds(configStore.config.taskDelayMinutes)）',
  );
  assert.ok(fnSrc.includes('Math.min(Math.max('), '缺 [0, interval] 钳制（回退间隔 < 剩余时条宽 >100%）');
});
check('F3-02 行为组（快照缺失回退）：intervalSeconds=undefined → resolve 全长兜底；超全长钳 100%', () => {
  const qs = { status: 'countdown', countdownRemaining: 300, intervalSeconds: undefined };
  const h = buildCountdownPercentFor({ queueState: qs, taskDelayMinutes: 5, leadingId: 't1' });
  assert.equal(h.fn({ id: 't1', paused: false }), 100, '回退全长 5*60=300，remaining=300 应 100%');
  assert.equal(h.resolveCalls(), 1, '快照缺失应恰回退一次 resolveQueueDelaySeconds');
  // 超全长钳 100：回退/快照全长 < 剩余时不出 >100% 条宽。
  const qs2 = { status: 'countdown', countdownRemaining: 450, intervalSeconds: 300 };
  const h2 = buildCountdownPercentFor({ queueState: qs2, taskDelayMinutes: 5, leadingId: 't1' });
  assert.equal(h2.fn({ id: 't1', paused: false }), 100, 'remaining 超全长须钳 100%（不得出 >100% 宽度）');
});

console.log('\n=== F3-03：两极间隔平滑（行为组：单调 + 钳制 + 中点抽验） ===');
check('F3-03 行为组：interval=60/3600 两极单调且 [0,100]；中点 30/60→50%、1800/60min→50%；负 remaining→null（无负宽度）', () => {
  const task = { id: 't1', paused: false };
  for (const interval of [60, 3600]) {
    const qs = { status: 'countdown', countdownRemaining: interval, intervalSeconds: interval };
    const h = buildCountdownPercentFor({ queueState: qs, taskDelayMinutes: 1, leadingId: 't1' });
    const remainings = interval === 60 ? [60, 45, 30, 15, 0] : [3600, 2700, 1800, 900, 0];
    let prev = 101;
    for (const r of remainings) {
      qs.countdownRemaining = r;
      const p = h.fn(task);
      assert.ok(typeof p === 'number', `interval=${interval} remaining=${r} 应返回数值，得到 ${p}`);
      assert.ok(p >= 0 && p <= 100, `interval=${interval} remaining=${r} 越界 [0,100]：${p}`);
      assert.ok(p <= prev, `interval=${interval} 序列非单调递减：${p} > ${prev}`);
      prev = p;
    }
    const mid = interval === 60 ? 30 : 1800;
    qs.countdownRemaining = mid;
    assert.equal(h.fn(task), 50, `中点抽验 remaining=${mid}/${interval} 应 50%`);
    // 负 remaining：渲染门拦截返回 null（不渲染绝无负宽度——impl §3.4-3 防御；引擎正常不下发负值）。
    qs.countdownRemaining = -5;
    assert.equal(h.fn(task), null, '负 remaining 应被渲染门拦截（null），绝不得出负宽度');
  }
});

console.log('\n=== F3-04：无倒计时五分支不渲染（结构钉逐分支 + 行为组） ===');
check('F3-04 结构钉：渲染门五分支标识符逐一定位（countdown 门/负值防御/paused/非队首/interval 非法）', () => {
  const fnSrc = extractBracedFn(taskQueue, 'function countdownPercentFor');
  assert.ok(fnSrc.includes("st.status !== 'countdown'"), '缺 status 门（standby/running 二分支）');
  assert.ok(fnSrc.includes('st.countdownRemaining < 0'), '缺 countdownRemaining<0 异常防御');
  assert.ok(fnSrc.includes('task.paused'), '缺 paused 分支（暂停任务不渲染）');
  assert.ok(fnSrc.includes('leadingTaskId.value !== task.id'), '缺非队首分支');
  assert.ok(fnSrc.includes('interval <= 0'), '缺 interval 非法分支（防除零）');
});
check('F3-04 行为组：standby/running/paused/非队首/interval 非法 → 全 null；正例（countdown+队首+合法间隔）唯一渲染', () => {
  const task = { id: 't1', paused: false };
  // ② standby（开关关 switch_off / restart / 全暂停待命均落此）③ running。
  for (const status of ['standby', 'running']) {
    const qs = { status, countdownRemaining: 100, intervalSeconds: 300 };
    const h = buildCountdownPercentFor({ queueState: qs, taskDelayMinutes: 5, leadingId: 't1' });
    assert.equal(h.fn(task), null, `status=${status} 不得渲染进度条`);
  }
  // ① paused（候选暂停分支）。
  const qsP = { status: 'countdown', countdownRemaining: 100, intervalSeconds: 300 };
  const hP = buildCountdownPercentFor({ queueState: qsP, taskDelayMinutes: 5, leadingId: 't1' });
  assert.equal(hP.fn({ id: 't1', paused: true }), null, '暂停任务不得渲染进度条');
  // ④ 非队首。
  const qsL = { status: 'countdown', countdownRemaining: 100, intervalSeconds: 300 };
  const hL = buildCountdownPercentFor({ queueState: qsL, taskDelayMinutes: 5, leadingId: 't2' });
  assert.equal(hL.fn(task), null, '非队首任务不得渲染进度条');
  // ⑤ interval 非法（快照缺失 + resolve 回 0/NaN）。
  const qsZ = { status: 'countdown', countdownRemaining: 100, intervalSeconds: undefined };
  const hZ = buildCountdownPercentFor({ queueState: qsZ, taskDelayMinutes: 5, leadingId: 't1', resolveImpl: () => 0 });
  assert.equal(hZ.fn(task), null, 'interval=0（非法）不得渲染进度条（防除零）');
  const qsN = { status: 'countdown', countdownRemaining: 100, intervalSeconds: undefined };
  const hN = buildCountdownPercentFor({ queueState: qsN, taskDelayMinutes: 5, leadingId: 't1', resolveImpl: () => Number.NaN });
  assert.equal(hN.fn(task), null, 'interval=NaN（非法）不得渲染进度条');
  // 正例对照：唯一渲染形态。
  const qsOk = { status: 'countdown', countdownRemaining: 100, intervalSeconds: 300 };
  const hOk = buildCountdownPercentFor({ queueState: qsOk, taskDelayMinutes: 5, leadingId: 't1' });
  assert.equal(hOk.fn(task), (100 / 300) * 100, '正例（countdown+队首+合法间隔）应唯一渲染');
});

console.log('\n=== F3-05：禁本地计时器（数据纪律负断言，异常向） ===');
check('F3-05 负断言：两文件 setInterval 零出现；TaskItem 纯 props（无 store/useNow）；进度函数体无本地计时标识符、数据源=队列投影', () => {
  assert.ok(!taskQueue.includes('setInterval'), 'TaskQueuePanel 不得出现 setInterval（禁组件本地计时器）');
  assert.ok(!taskItemSrc.includes('setInterval'), 'TaskItem 不得出现 setInterval');
  assert.ok(!taskItemSrc.includes('use-now'), 'TaskItem 不得引 use-now（保持纯 props 组件）');
  assert.ok(!taskItemSrc.includes('useNow'), 'TaskItem 不得用 useNow');
  assert.ok(!taskItemSrc.includes('useTaskStore') && !taskItemSrc.includes('stores/task-store'), 'TaskItem 不得依赖 store（进度数据经 props 传入）');
  const fnSrc = extractBracedFn(taskQueue, 'function countdownPercentFor');
  for (const id of ['Date.now', 'setTimeout', 'setInterval', 'requestAnimationFrame', 'useNow']) {
    assert.ok(!fnSrc.includes(id), `进度函数体不得含本地计时标识符 ${id}（进度唯一刷新源=countdown_tick 事件经 store 投影）`);
  }
  assert.ok(fnSrc.includes('taskStore.queueState'), '进度数据源须为队列投影（countdown_started/tick → store → 渲染）');
});

console.log('\n=== F3-06：进度数据源绑定队列投影（附 B 保全，转写即绿属预期——防倒退钉） ===');
check('F3-06 保全：store countdown_started 快照 + countdown_tick 镜像既有链零改动', () => {
  const tickIdx = taskStoreSrc.indexOf("case 'countdown_started':");
  assert.ok(tickIdx > -1, 'task-store 缺 countdown_started 分支');
  const tickBody = taskStoreSrc.slice(tickIdx, taskStoreSrc.indexOf("case 'task_started'", tickIdx));
  assert.ok(tickBody.includes('countdownRemaining = remaining'), 'countdown_started/tick 的 countdownRemaining 镜像丢失');
  assert.ok(tickBody.includes('this.queueState.intervalSeconds = remaining'), 'countdown_started 全长快照（hb12-QUE-04）丢失——进度全长口径断链');
});
check('F3-06 保全：TaskItem 无本地进度镜像（进度数据不落组件内 ref/state）', () => {
  assert.ok(!taskItemSrc.includes('countdownRemaining'), 'TaskItem 不得本地镜像 countdownRemaining');
  assert.ok(!taskItemSrc.includes('intervalSeconds'), 'TaskItem 不得本地镜像 intervalSeconds');
  assert.ok(!taskItemSrc.includes('countdownPercentFor'), 'TaskItem 不得自带进度计算（面板纯计算产出经 props 传入）');
});

// ── F4：子代理组卡重绘（线性图标 / 三态徽章 / 保全展开体与联动）────────────────
// 用例正本 = docs/ui-completion/tests/F-activity-panel-cases.md §F4 全部用例
//（F4-01～F4-07，逐条对号；附 B 保全用例 F4-03/04/05/07 转写即绿属预期——防倒退钉，RED 判据不适用）：
//   · F4-01 组卡线性图标替换 🤖 emoji（负断言防残留 + 结构钉 stroke="currentColor" / rail 同几何）；
//   · F4-02 状态徽章三态进行中/已完成/未完成（结构钉三态文案 + 行为组 subAgentStatusClass 三类互斥）；
//   · F4-03 ⏱ 计时+三点+› 旋转箭头保全（结构钉；耗时文本组卡头一处 body 不重复——附 A-2 行为锚）；
//   · F4-04 展开体三件保全（ThinkingBlock / subagent-live-text v-enrich / ProcessGroup+MessageBubble）；
//   · F4-05 显式收起优先机制不变（结构钉：collapsedGroups 分支先于 running 自动展开）；
//   · F4-06 「未完成」徽章 warn 语义色（结构钉：--incomplete 引 var(--color-warn*，无新 hex、无新色相）；
//   · F4-07 focusSubAgent 1.6s 高亮联动保全（结构钉：1600 字面 + --focused class + scrollIntoView + 锚点）。
// 既有钉同步（附 A-1）：tdd-subagent-verify.ts「未完成组不误显示已完成」二态字面钉 → 三态等价断言。
// 头部行紧凑化（impl §4.2-3 padding 10px12px→8px10px）属目检兜底域（附 C-2），不设机器钉。

// 定位工具：子 Agent 组卡区段（v-for g in subAgentGroups 起 → 后台卡 v-for 为界）。
function subAgentCardRegion(): string {
  const start = taskQueue.indexOf('v-for="g in subAgentGroups"');
  assert.ok(start > -1, 'TaskQueuePanel 缺子 Agent 组卡 v-for 区段');
  const end = taskQueue.indexOf('v-for="t in backgroundTaskList"', start);
  assert.ok(end > start, '组卡区段截取失败（后台卡锚点缺失）');
  return taskQueue.slice(start, end);
}

// F4-02 行为组 harness：提取 subAgentStatusClass 源码 → 剥 TS 签名 → new Function 真实执行
//（函数体只依赖 g.running/g.completed 两字段，纯映射无副作用——形态同 F3 buildCountdownPercentFor）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildSubAgentStatusClass(): (g: { running?: boolean; completed?: boolean }) => any {
  const fnSrc = extractBracedFn(taskQueue, 'function subAgentStatusClass');
  const js = fnSrc.replace(/^function subAgentStatusClass\([^)]*\)[^{]*\{/, 'function (g) {');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (new Function(`"use strict"; return (${js});`) as any)();
}

console.log('\n=== F4-01：组卡线性图标替换 🤖 emoji（负断言防残留 + 结构钉） ===');
check('F4-01 组卡 icon 无 🤖 emoji 字面（负断言，组卡区段零出现）；组卡头线性 SVG stroke="currentColor" 且几何=rail 子Agent 图标', () => {
  const region = subAgentCardRegion();
  assert.ok(!region.includes('🤖'), '子 Agent 组卡区段残留 🤖 emoji（重绘漏改或把新图标又写成 emoji）');
  // emoji 直挂 icon span 形态全文件零出现（后台卡 taskIcon() 分支不在本点范围，不受此断言约束）。
  assert.ok(!taskQueue.includes('subagent-group__icon">🤖'), '组卡 icon span 直挂 emoji 字面（禁 emoji 作结构图标）');
  // 结构钉：组卡头存在线性 SVG（stroke="currentColor"，对齐 rail__icon 图标纪律注释）。
  const svgIdx = region.indexOf('<svg');
  assert.ok(svgIdx > -1, '组卡头缺线性 SVG 图标');
  const svgTag = region.slice(svgIdx, region.indexOf('>', svgIdx) + 1);
  assert.ok(svgTag.includes('stroke="currentColor"'), '组卡图标非线性描边（缺 stroke="currentColor"）');
  assert.ok(svgTag.includes('viewBox="0 0 16 16"'), '组卡图标缺 16×16 viewBox（与 rail 图标同几何基准）');
  // 图标几何逐字复用 rail 子Agent 图标（图标集单一来源，impl §4.2-1）。
  assert.ok(region.includes('<circle cx="8" cy="5.6" r="2.4" />'), '组卡图标几何偏离 rail 子Agent 图标（circle）');
  assert.ok(region.includes('d="M3.2 13.6c0-2.6 2.2-4.2 4.8-4.2s4.8 1.6 4.8 4.2"'), '组卡图标几何偏离 rail 子Agent 图标（path）');
});

console.log('\n=== F4-02：状态徽章三态进行中/已完成/未完成（结构钉 + 行为组） ===');
check('F4-02 结构钉：三态文案逐字（进行中/已完成/未完成）+ 徽章类绑定 subAgentStatusClass(g) + 三态样式类定义齐全', () => {
  // 文案三分支逐字保全（tdd-subagent-verify 既有钉字面 + running 分支——三态退二态必红）。
  const fnSrc = extractBracedFn(taskQueue, 'function subAgentStatusText');
  assert.ok(/if\s*\(g\.running\)\s*return\s*'进行中';/.test(fnSrc), '缺 running→「进行中」分支（三态退二态）');
  assert.ok(fnSrc.includes("g.completed ? '已完成' : '未完成'"), '缺 completed 二分文案字面（既有钉字面）');
  // 徽章挂载点：状态 span 改绑三态类映射。
  assert.ok(taskQueue.includes(':class="subAgentStatusClass(g)"'), '状态徽章未绑三态类映射 subAgentStatusClass(g)');
  // 三态类定义齐全（--running 既有 + --done/--incomplete 新增）。
  for (const cls of ['subagent-group__status--running', 'subagent-group__status--done', 'subagent-group__status--incomplete']) {
    assert.ok(taskQueue.includes(`.${cls}`), `缺徽章三态样式类 .${cls}`);
  }
});
check('F4-02 行为组：running→--running、completed→--done、未完成→--incomplete，三类互斥；未完成组不落 done 类', () => {
  const cls = buildSubAgentStatusClass();
  const running = cls({ running: true, completed: false });
  const done = cls({ running: false, completed: true });
  const incomplete = cls({ running: false, completed: false });
  assert.ok(String(running).includes('subagent-group__status--running'), 'running 组应落 --running 类');
  assert.ok(String(done).includes('subagent-group__status--done'), 'completed 组应落 --done 类');
  assert.ok(String(incomplete).includes('subagent-group__status--incomplete'), '未完成组应落 --incomplete 类');
  assert.notEqual(incomplete, done, '未完成组不得落「已完成」类（附 A-1 语义等价保全）');
  assert.notEqual(running, done, '三态互斥破坏：running 与 done 同类');
  assert.notEqual(running, incomplete, '三态互斥破坏：running 与 incomplete 同类');
});
check('F4-02 三点动画随 running 分支渲染（非 running 态无 dots）', () => {
  const region = subAgentCardRegion();
  assert.ok(region.includes('v-if="g.running" class="subagent-running-dots"'), '组卡三点动画未挂 running 分支（非 running 态将误出 dots）');
});

console.log('\n=== F4-03：⏱ 计时+三点+› 旋转箭头保全（附 B 保全，转写即绿属预期——防倒退钉） ===');
check('F4-03 保全：⏱ 计时接线组卡头一处（body 不重复）；三点动画类+keyframes+reduced-motion 保持；› 箭头 open 态旋转保持', () => {
  // 耗时文本唯一出处：组卡头一处绑定（定义外的绑定数=1；A-2「只保留一处」行为锚）。
  const durRefs = taskQueue.split('subAgentDurationText(g)').length - 1;
  assert.equal(durRefs, 1, `耗时文本绑定应仅组卡头一处，实为 ${durRefs} 处（body 重复）`);
  assert.ok(taskQueue.includes('>⏱{{ subAgentDurationText(g) }}</span>'), '⏱ 计时文本绑定形态丢失');
  // 三点动画：类样式 + keyframes + reduced-motion 全在位。
  assert.ok(taskQueue.includes('.subagent-running-dots span'), '三点动画样式丢失');
  assert.ok(taskQueue.includes('@keyframes subagent-dot-pulse'), '三点动画 keyframes 丢失');
  const reducedIdx = taskQueue.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedIdx > -1 && taskQueue.slice(reducedIdx).includes('.subagent-running-dots span'), 'reduced-motion 停动画块丢失');
  // › 箭头 + open 态旋转（open class 驱动 transform）。
  const region = subAgentCardRegion();
  assert.ok(region.includes('subagent-group__arrow'), '› 箭头丢失');
  assert.match(taskQueue, /\.subagent-group__header--open \.subagent-group__arrow\s*\{[^}]*transform:\s*rotate/, '箭头 open 态旋转丢失');
});

console.log('\n=== F4-04：展开体三件保全（附 B 保全，转写即绿属预期——防倒退钉） ===');
check('F4-04 保全：展开体 ThinkingBlock（实时思考）/ subagent-live-text（实时正文 v-enrich）/ ProcessGroup+MessageBubble（落库消息）三件渲染链保持', () => {
  const region = subAgentCardRegion();
  assert.ok(region.includes('<ThinkingBlock'), '展开体缺 ThinkingBlock（实时思考）');
  assert.ok(region.includes('class="subagent-live-text markdown-body"'), '展开体缺实时正文容器');
  assert.ok(region.includes('v-enrich'), '实时正文缺 v-enrich 委托（文件链接点击链断）');
  // P6-B 契约迁移 2026-11-21（同 MOD-P6-1 族）：实时正文左键零动作，交互入口唯一化为右键委托。
  assert.ok(region.includes('@contextmenu="onLiveTextContextMenu"'), '实时正文右键委托丢失');
  const liveCtxBinds = taskQueue.match(/@contextmenu="onLiveTextContextMenu"/g) ?? [];
  assert.strictEqual(liveCtxBinds.length, 2, `实时正文 @contextmenu 委托应恰 2 处（TaskQueuePanel.vue:742/:794），实际 ${liveCtxBinds.length} 处`);
  assert.ok(region.includes('ProcessGroup'), '展开体缺 ProcessGroup（落库 fold）');
  assert.ok(region.includes('<MessageBubble'), '展开体缺 MessageBubble（落库消息气泡）');
});

console.log('\n=== F4-05：显式收起优先机制不变（附 B 保全，转写即绿属预期——防倒退钉） ===');
check('F4-05 保全：显式收起分支先于 running 自动展开（collapsedGroups 命中即收起，running 不覆盖）；toggle 接线不变', () => {
  const fnSrc = extractBracedFn(taskQueue, 'function isSubAgentGroupExpanded');
  assert.ok(fnSrc.includes('if (collapsedGroups.value.has(id)) return false;'), '显式收起优先语义丢失');
  const collapsedIdx = fnSrc.indexOf('collapsedGroups.value.has(id)');
  const autoIdx = fnSrc.indexOf('return expandedGroups.value.has(id) || running');
  assert.ok(collapsedIdx > -1 && autoIdx > collapsedIdx, '显式收起分支须先于 running 自动展开（顺序即语义）');
  assert.ok(taskQueue.includes('@click="toggleSubAgentGroup(g.parentAgentId, g.running)"'), '展开/收起 toggle 接线丢失');
});

console.log('\n=== F4-06：「未完成」徽章 warn 语义色（边界；结构钉） ===');
check('F4-06 --incomplete 引 var(--color-warn* 语义 token；--done 引 success 系；无硬编码 hex、无新色相（靛蓝/紫零出现）', () => {
  const incIdx = taskQueue.indexOf('.subagent-group__status--incomplete');
  assert.ok(incIdx > -1, '缺 --incomplete 徽章样式');
  const incBody = taskQueue.slice(incIdx, taskQueue.indexOf('}', incIdx));
  assert.ok(incBody.includes('var(--color-warn'), '未完成徽章未走 warn 语义 token（裁决：未完成=warn 语义色）');
  assert.ok(incBody.includes('border-color'), '未完成徽章缺描边');
  const doneIdx = taskQueue.indexOf('.subagent-group__status--done');
  assert.ok(doneIdx > -1, '缺 --done 徽章样式');
  const doneBody = taskQueue.slice(doneIdx, taskQueue.indexOf('}', doneIdx));
  assert.ok(doneBody.includes('var(--color-success'), '已完成徽章未走 success 语义 token');
  // 色相纪律：徽章样式段（--running→dots 之间）无硬编码 hex；全文件无靛蓝/紫色相字面（裁决 D4④）。
  const badgeTail = taskQueue.slice(taskQueue.indexOf('.subagent-group__status--running'), taskQueue.indexOf('.subagent-running-dots'));
  assert.ok(!badgeTail.includes('#'), '徽章样式段出现硬编码 hex 字面（须只引语义 token）');
  assert.ok(!/--ind/.test(taskQueue), '引入靛蓝系变量（裁决 D4④：统一 accent 系不引入新色相）');
  assert.ok(!/6366f1|8b5cf6|a78bfa|4f46e5/i.test(taskQueue), '引入靛蓝/紫 hex 字面（裁决 D4④）');
});

console.log('\n=== F4-07：focusSubAgent 1.6s 高亮联动保全（附 B 保全，转写即绿属预期——防倒退钉） ===');
check('F4-07 保全：subagent-{parentAgentId} 锚点 + scrollIntoView 定位 + --focused 高亮 class + 1600ms 时长字面保持', () => {
  const region = subAgentCardRegion();
  assert.ok(region.includes(':id="`subagent-${g.parentAgentId}`"'), '组卡锚点 id 丢失（联动定位失效）');
  assert.ok(taskQueue.includes('el.scrollIntoView({ behavior: \'smooth\', block: \'start\' })'), '滚动定位接线丢失');
  assert.ok(taskQueue.includes("el.classList.add('subagent-group--focused')"), '--focused 高亮 class 丢失');
  assert.ok(
    taskQueue.includes("setTimeout(() => el.classList.remove('subagent-group--focused'), 1600)"),
    '1600ms 高亮时长字面丢失（防改动为过短/过长）',
  );
  assert.ok(taskQueue.includes('subagent-group--focused'), '高亮样式锚丢失');
});

// ── F5：面板语义保全防倒退钉 + dragover 插入位提示 + 头行键盘 + dead code 顺带删 ──
// 用例正本 = docs/ui-completion/tests/F-activity-panel-cases.md §F5 全部用例
//（F5-01～F5-11，逐条对号；附 B 保全用例 F5-01/03/04/06/07/08/10 转写即绿属预期——
// 防倒退钉，RED 判据不适用；新增强 F5-02/05/09 须先红后绿）：
//   · F5-01 指标条五格值语义逐字保持（队列格=调度状态文案非数量——裁决 D4-10）；
//   · F5-02 指标格 aria-pressed（新增强；语义=筛选态 rightTab，与 rail__btn 先例同构——
//     impl §5.2①：aria-pressed 是按钮切换态，--active 是数据活跃高亮，两者并存不同源；
//     tests 卷 F5-02「同源」措辞按 impl §5.2① 显式澄清收窄为「绑定在位且逐格接线」）；
//   · F5-03 任务卡操作钮恒渲染+禁用 title 四态逐字（保全锚=tdd-queue-semantics-v3 §10 全组）；
//   · F5-04 手柄拖拽+sending 禁拖保全（负断言：整行 draggable 不得引入）；
//   · F5-05 dragover 插入位高亮（新增强；裁决=纯 CSS 消费 SortableJS ghost 槽位——
//     vue-draggable-plus 0.6 默认 ghostClass:"sortable-ghost"（dist L657 实证），
//     自定义 dragover 监听方案已否决（与 SortableJS DOM 搬移互相打架）；视觉目检兜底附 C-4）；
//   · F5-06 ETA 分支/空态五类/状态条七分支文案逐字（保全；N9 空队列门在位）；
//   · F5-07 后台卡三类分支+状态四态保持（保全；A-6 activeBackgroundTasks 消费）；
//   · F5-08 改动区六件套保全（保全）；
//   · F5-09 任务卡头行键盘可达（新增强：role=button+tabindex+aria-expanded+Enter/Space，
//     手柄 @click.stop 防冒泡保持；focus-visible；整行 draggable 负断言）；
//   · F5-10 计划卡全只读负断言（**关键防倒退**：审批钮零出现——裁决 D4-01/D4⑥）+
//     Task 六态/Todo 三态 + dead code 顺带删（hasPlan / claude-plan-card__empty /
//     「Claude 尚未创建计划任务」空态块——面板侧 R596 v-if 守卫使该分支永不可达，
//     删除不产生新可达路径；实施报告申报）；
//   · F5-11 计数角标 live 态保持（保全：tp-section__count 五类随事件实时更新非静态快照）。
// 红线：VueDraggable handle/v-model/@end/:disabled 接线一个字符不动；queue-eta.ts 纯函数
// 零触碰（本节只读断言其分支字面）；ChangesPanel/TaskStatusBadge 语义零改动（token 复核）。

const planCardSrc = read('../src/renderer/components/task/ClaudePlanCard.vue');
const changesPanelSrc = read('../src/renderer/components/changes/ChangesPanel.vue');
const queueEtaSrc = read('../src/shared/queue-eta.ts');

// 定位工具：named computed 箭头函数体（该文件 computed 恒以 `});` 顶格收口）。
function computedBody(src: string, name: string): string {
  const idx = src.indexOf(`const ${name} = computed`);
  assert.ok(idx > -1, `源码缺 ${name} computed（实现缺口）`);
  const end = src.indexOf('\n});', idx);
  return src.slice(idx, end > -1 ? end : idx + 600);
}

console.log('\n=== F5-01：指标条五格值语义逐字保持（队列格=调度状态文案非数量） ===');
check('F5-01 五格按钮结构+点击 setFilter+active 绑定保持；五类值文案逐字', () => {
  const start = taskQueue.indexOf('<div class="status-metrics">');
  assert.ok(start > -1, '缺状态指标条 status-metrics');
  const region = taskQueue.slice(start, taskQueue.indexOf('</div>', start));
  const cells: Array<[string, string, string]> = [
    ['plan', 'planMetric', '计划'],
    ['queue', 'queueMetric', '队列'],
    ['subagent', 'subAgentMetric', '子Agent'],
    ['background', 'backgroundMetric', '后台'],
    ['changes', 'changesMetric', '改动'],
  ];
  for (const [tab, metric, label] of cells) {
    const clickIdx = region.indexOf(`@click="setFilter('${tab}')"`);
    assert.ok(clickIdx > -1, `指标条缺 ${tab} 格 click 接线（点击=只看此类）`);
    const cell = region.slice(region.lastIndexOf('<button', clickIdx), region.indexOf('</button>', clickIdx));
    assert.ok(cell.includes('class="status-metric"'), `${tab} 格缺 status-metric 类`);
    assert.ok(cell.includes(`:class="{ 'status-metric--active': ${metric}.active }"`), `${tab} 格 --active 绑定丢失（数据活跃高亮）`);
    assert.ok(cell.includes(`<span class="status-metric__label">${label}</span>`), `${tab} 格标签「${label}」丢失`);
    assert.ok(cell.includes(`<span class="status-metric__value">{{ ${metric}.text }}</span>`), `${tab} 格值绑定丢失`);
  }
});
check('F5-01 值语义逐字：queueMetric=调度状态文案（执行中/等待/等待中/已熔断/待命），不得改为数量', () => {
  const body = computedBody(taskQueue, 'queueMetric');
  assert.ok(body.includes("'执行中'"), '缺 running→执行中 分支');
  assert.ok(body.includes('`等待 ${formatCountdownHuman(cd)}`'), '缺 countdown 等待分支文案');
  assert.ok(body.includes("'等待中'"), '缺 countdown 归零等待中分支');
  assert.ok(body.includes("'已熔断'"), '缺 halt_*→已熔断 分支');
  assert.ok(body.includes("'待命'"), '缺 default→待命 分支');
  assert.ok(!body.includes('tasks.length'), '队列格值不得引用任务数量（裁决 D4-10：调度状态文案非数量）');
});
check('F5-01 值语义逐字：plan/subAgent/background/changes 四格', () => {
  const plan = computedBody(taskQueue, 'planMetric');
  assert.ok(plan.includes("'无'") && plan.includes('${planDone.value}/${n}'), 'plan 格值文案偏离（无 | x/n）');
  const sub = computedBody(taskQueue, 'subAgentMetric');
  assert.ok(sub.includes("'无'") && sub.includes('${running} 运行中') && sub.includes('${total} 组'), 'subAgent 格值文案偏离（无 | N 运行中 | N 组）');
  const bg = computedBody(taskQueue, 'backgroundMetric');
  assert.ok(bg.includes("'无'") && bg.includes('${n} 个任务'), 'background 格值文案偏离（无 | N 个任务）');
  const ch = computedBody(taskQueue, 'changesMetric');
  assert.ok(ch.includes("'无'") && ch.includes('${n} 个文件'), 'changes 格值文案偏离（无 | N 个文件）');
});

console.log('\n=== F5-02：指标格 aria-pressed 反映筛选态（新增强，RED→GREEN） ===');
check('F5-02 五格 status-metric 各补 :aria-pressed="sessionStore.rightTab === \'<tab>\'"（rail__btn 先例同构）', () => {
  const start = taskQueue.indexOf('<div class="status-metrics">');
  assert.ok(start > -1, '缺状态指标条 status-metrics');
  const region = taskQueue.slice(start, taskQueue.indexOf('</div>', start));
  for (const tab of ['plan', 'queue', 'subagent', 'background', 'changes']) {
    const clickIdx = region.indexOf(`@click="setFilter('${tab}')"`);
    assert.ok(clickIdx > -1, `指标条缺 ${tab} 格`);
    const cell = region.slice(region.lastIndexOf('<button', clickIdx), region.indexOf('</button>', clickIdx));
    assert.ok(
      cell.includes(`:aria-pressed="sessionStore.rightTab === '${tab}'"`),
      `${tab} 格缺 :aria-pressed 筛选态绑定（须与 rail__btn 先例同构：sessionStore.rightTab === '${tab}'）`,
    );
  }
  assert.equal((region.match(/:aria-pressed=/g) ?? []).length, 5, '指标条 aria-pressed 应恰 5 处（一格一绑）');
});

console.log('\n=== F5-03：任务卡操作钮恒渲染+禁用 title 四态逐字（附 B 保全，转写即绿属预期） ===');
check('F5-03 五钮恒渲染形态保持（pending v-if 门 + 详情钮）+ disabled 判据逐字 + title 四态逐字', () => {
  // 恒渲染：pending 门 ×4（立即执行/暂停/恢复/删除，暂停恢复各带 paused 扩展条件）+ 详情钮无条件渲染。
  assert.equal((taskItemSrc.match(/v-if="task\.status === 'pending'/g) ?? []).length, 4, 'pending 渲染门应恰 4 处（立即执行/暂停/恢复/删除）');
  assert.ok(taskItemSrc.includes('@click="expanded = !expanded">{{ expanded ? \'收起\' : \'详情\' }}</button>'), '详情钮丢失（恒渲染）');
  assert.ok(taskItemSrc.includes(':disabled="sending || queuePaused || !queueEnabled"'), '立即执行 disabled 判据被改动');
  const title = computedBody(taskItemSrc, 'runNowTitle');
  for (const t of [
    '队列开关已关闭',
    '队列已暂停，恢复队列后可执行',
    '当前会话有任务执行中，结束后可立即执行',
    '跳过倒计时，立即把该任务移出队列并作为普通消息发送',
  ]) {
    assert.ok(title.includes(t), `runNowTitle 四态 title 丢字：「${t}」`);
  }
  assert.ok(taskItemSrc.includes('action--solid') && taskItemSrc.includes('action--accent'), '操作钮样式类（action--solid/action--accent）丢失');
});

console.log('\n=== F5-04：手柄拖拽+sending 禁拖保全（附 B 保全，转写即绿属预期） ===');
check('F5-04 VueDraggable handle/v-model/@end/:disabled 接线逐字 + dragDisabled=sending + 整行拖拽负断言', () => {
  assert.ok(taskQueue.includes('handle=".task-item__drag"'), '拖拽手柄配置丢失（拖拽仅手柄生效红线）');
  assert.ok(taskQueue.includes('v-model="taskStore.tasks"'), '拖拽 v-model 丢失（排序数据链）');
  assert.ok(taskQueue.includes('@end="handleDragReorder"'), '拖拽 @end 排序接线丢失');
  assert.ok(taskQueue.includes(':disabled="dragDisabled"'), '拖拽 disabled 接线丢失');
  const dragBody = computedBody(taskQueue, 'dragDisabled');
  assert.ok(dragBody.includes('sessionStore.sending'), 'dragDisabled 判据须=sending（sending 禁拖红线）');
  // 负断言：整行拖拽不得引入——TaskItem 模板区零 draggable 属性（注释文字不参与断言）；
  // 面板零 ghostClass 覆盖、零整行 draggable。
  const tplStart = taskItemSrc.indexOf('<template>');
  // 剔除 HTML 注释后断言（注释文字不参与属性红线）。
  const tplRegion = taskItemSrc.slice(tplStart, taskItemSrc.indexOf('<style', tplStart)).replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!tplRegion.includes('draggable'), 'TaskItem 模板引入 draggable 属性（整行拖拽红线）');
  assert.ok(!taskQueue.includes('ghostClass') && !taskQueue.includes(':draggable'), '面板引入 ghostClass 覆盖或整行 draggable（红线）');
});

console.log('\n=== F5-05：dragover 插入位高亮提示（新增强，RED→GREEN；纯 CSS 消费 sortable-ghost） ===');
check('F5-05 TaskItem 存在 .task-item.sortable-ghost 插入槽位样式（accent 虚线 + 弱底），零 JS 监听', () => {
  const idx = taskItemSrc.indexOf('.task-item.sortable-ghost');
  assert.ok(idx > -1, '缺 .task-item.sortable-ghost 插入位高亮样式（拖拽中无落点反馈）');
  const body = taskItemSrc.slice(idx, taskItemSrc.indexOf('}', idx));
  assert.ok(body.includes('opacity'), 'ghost 槽位缺透明度降级');
  assert.ok(body.includes('outline: 1px dashed var(--color-accent-strong)'), 'ghost 槽位缺 accent 虚线描边');
  assert.ok(body.includes('color-mix(in srgb, var(--color-accent)'), 'ghost 槽位弱底须走 accent token（禁硬编码色）');
  // 裁决红线：纯 CSS 消费 SortableJS ghost——自定义 dragover 监听否决，零 JS 接线。
  assert.ok(!taskItemSrc.includes('dragover'), 'TaskItem 不得引入 dragover JS 监听（裁决：纯 CSS ghost 槽位）');
  assert.ok(!/@dragover/.test(taskQueue), '面板不得引入 @dragover 接线');
});

console.log('\n=== F5-06：ETA 分支/空态五类/状态条七分支文案逐字（附 B 保全，转写即绿属预期） ===');
check('F5-06a ETA 分支文案逐字（shared/queue-eta.ts 纯函数零触碰只读钉：暂停/running 首位与第 N 位/countdown 首位与第 N 位/待命）', () => {
  for (const t of [
    '已暂停 · 点恢复后重新计时',
    '`当前回合结束后倒计时 ${fmt(interval)} 执行`',
    '`最早约 ${fmt((idx + 1) * interval)} 后（第 ${idx + 1} 位）`',
    '`${formatCountdownHuman(cd)} 后执行`',
    '`最早约 ${fmt(cd + idx * interval)} 后（第 ${idx + 1} 位）`',
    "'待命 · 完成一次会话或点恢复后调度'",
  ]) {
    assert.ok(queueEtaSrc.includes(t), `taskEtaText 分支文案丢字：${t}`);
  }
  assert.ok(!taskItemSrc.includes('taskEtaText('), 'TaskItem 不得自带 ETA 计算（面板 etaFor 纯函数产出经 props 传入）');
});
check('F5-06b 空态五类逐字在位（「子 Agent」空格称呼两处各有其真）', () => {
  for (const t of [
    'Claude 尚未创建计划',
    '暂无排队任务；开启队列任务后，回复生成中在会话框发送即入队',
    '暂无子 Agent 过程',
    '暂无后台任务',
    '工作目录无改动',
  ]) {
    assert.ok(taskQueue.includes(t), `空态文案丢失：「${t}」`);
  }
  // headTitle「子Agent」无空格——两称呼勿互改。
  assert.ok(taskQueue.includes("case 'subagent': return '子Agent';"), 'headTitle「子Agent」无空格称呼被改动');
});
check('F5-06c 状态条七分支逐字 + N9 空队列门 + 「全部恢复」渲染门与 title 逐字', () => {
  const bar = computedBody(taskQueue, 'queueBarHint');
  for (const t of [
    '后执行下一个任务（期间可在会话框插话或点「立即执行」）',
    '回合执行中… 结束后自动倒计时',
    '回合执行中… 结束后队列空闲',
    '上次执行失败，队列已全部暂停',
    '上次执行被中断，队列已全部暂停',
    '应用重启，队列待命：点「立即执行」/「恢复」，或完成一次会话后开始',
    '队列开关已关闭：不倒计时、不自动执行',
    '所有任务已暂停 · 点恢复/全部恢复后执行',
    '待命中',
  ]) {
    assert.ok(bar.includes(t), `queue-bar 分支文案丢字：「${t}」`);
  }
  // N9：halt_* 零任务不弹熔断横幅（break 落「待命中」）。
  assert.equal((bar.match(/if \(taskStore\.tasks\.length === 0\) break;/g) ?? []).length, 2, 'N9 空队列门应恰 2 处（halt_failed/halt_interrupted）');
  // 「全部恢复」渲染门 + title 逐字。
  const barIdx = taskQueue.indexOf('class="queue-bar"');
  const barBlock = taskQueue.slice(barIdx, taskQueue.indexOf('</div>', taskQueue.indexOf('全部恢复', barIdx)));
  assert.ok(barBlock.includes('v-if="queueBarHint.showResumeAll"'), '「全部恢复」渲染门丢失');
  assert.ok(barBlock.includes('title="全部暂停任务恢复为待执行，并立即开始全量倒计时"'), '「全部恢复」title 逐字丢失');
});

console.log('\n=== F5-07：后台卡三类分支+状态四态保持（附 B 保全，转写即绿属预期） ===');
check('F5-07 taskIcon 三类分支 + bgStatusText 四态逐字 + agent/bash/monitor 渲染面保全 + A-6 消费', () => {
  const icon = taskQueue.slice(taskQueue.indexOf('function taskIcon'), taskQueue.indexOf('function taskIcon') + 220);
  assert.ok(icon.includes("taskType === 'local_bash'") && icon.includes("'⌨️'"), 'bash 类图标分支丢失');
  assert.ok(icon.includes("'local_agent' || taskType === 'remote_agent'") && icon.includes("'🤖'"), 'agent 类图标分支丢失');
  assert.ok(icon.includes("'🔁'"), 'monitor 类默认图标分支丢失');
  const status = taskQueue.slice(taskQueue.indexOf('function bgStatusText'), taskQueue.indexOf('function bgStatusText') + 260);
  for (const t of ["case 'completed': return '已完成'", "case 'failed': return '失败'", "case 'stopped': return '已停止'", "default: return '运行中'"]) {
    assert.ok(status.includes(t), `bgStatusText 四态文案丢字：${t}`);
  }
  // agent 类内嵌组体 + 组未到兜底（prompt/usage/summary）。
  const bgIdx = taskQueue.indexOf('v-if="isAgentTask(t)"');
  assert.ok(bgIdx > -1, '后台卡 agent 类分流丢失');
  const bgBlock = taskQueue.slice(bgIdx, taskQueue.indexOf('<!-- bash / monitor', bgIdx));
  assert.ok(bgBlock.includes('focusBgGroup(g.parentAgentId)'), 'agent 卡「在子Agent 页签查看」联动丢失');
  assert.ok(bgBlock.includes('bgGroupOf(t)'), 'agent 卡组关联丢失');
  assert.ok(bgBlock.includes('bgPromptText(t)'), 'agent 卡 prompt 兜底丢失');
  // bash/monitor 类：最近工具/usage/时间线/查看输出。
  const bmIdx = taskQueue.indexOf('最近工具：{{ t.lastToolName }}');
  assert.ok(bmIdx > -1, 'bash/monitor 类最近工具行丢失');
  const bmBlock = taskQueue.slice(bmIdx, taskQueue.indexOf('</template>', bmIdx));
  assert.ok(bmBlock.includes('t.usage.totalTokens') && bmBlock.includes('t.usage.toolUses') && bmBlock.includes('t.usage.durationMs'), 'usage 三项丢失');
  assert.ok(bmBlock.includes('bg-task__timeline'), '进度时间线丢失');
  assert.ok(bmBlock.includes('查看输出</button>'), '终态「查看输出」丢失');
  // A-6：会话桶隔离消费（不得直读原始 map）。
  assert.ok(taskQueue.includes('Object.values(sessionStore.activeBackgroundTasks)'), '后台任务须消费 activeBackgroundTasks 会话桶（A-6）');
  assert.ok(!taskQueue.includes('sessionStore.backgroundTasks'), '不得直读 sessionStore.backgroundTasks 原始 map');
  // prompt 120 字截断。
  assert.ok(taskQueue.includes('p.length > 120 ? `${p.slice(0, 120)}…` : p'), 'prompt 120 字截断丢失');
});

console.log('\n=== F5-08：改动区六件套保全（附 B 保全，转写即绿属预期） ===');
check('F5-08a 面板总览摘要：cap5 + 「还有 N 个，查看全部」+ 行点击 DiffDialog + title 逐字', () => {
  assert.ok(taskQueue.includes('const CHANGES_SUMMARY_CAP = 5;'), '总览摘要 cap=5 常量丢失');
  assert.ok(taskQueue.includes('changesStore.files.slice(0, CHANGES_SUMMARY_CAP)'), '摘要切片未走 cap 常量');
  assert.ok(taskQueue.includes('还有 {{ changesCount - changesSummaryFiles.length }} 个，'), '「还有 N 个，」丢失');
  assert.ok(taskQueue.includes('查看全部</button>'), '「查看全部」丢失');
  assert.ok(taskQueue.includes(':title="`查看 ${f.path} 的对比`"'), '摘要行 title 逐字丢失');
  assert.ok(taskQueue.includes('@click="openSummaryFile(f.path, $event)"'), '摘要行点击接线丢失');
  const fn = taskQueue.slice(taskQueue.indexOf('function openSummaryFile'), taskQueue.indexOf('function openSummaryFile') + 220);
  assert.ok(fn.includes('openDiffDialog(path'), '摘要行点击未走 DiffDialog');
});
check('F5-08b ChangesPanel 六件套：刷新(force)/失败横条+重试/baseline/touched ●/500 截断/空态三级', () => {
  // ① force 刷新 + 刷新中态。
  assert.ok(changesPanelSrc.includes('store.refresh(false, true)'), '刷新钮缺 force=true（用户唯一强制重扫入口）');
  assert.ok(changesPanelSrc.includes("store.loading ? '刷新中…' : '刷新'"), '刷新/刷新中 二态丢失');
  // ② 失败横条 keyed on refreshFailed + 重试 refresh(true)。
  assert.ok(changesPanelSrc.includes('v-if="store.refreshFailed"'), '失败横条渲染门丢失');
  assert.ok(changesPanelSrc.includes('刷新失败：{{ store.error }}'), '失败文案模板丢失');
  assert.ok(changesPanelSrc.includes("'，已保留上次列表'"), '「已保留上次列表」丢失');
  assert.ok(changesPanelSrc.includes('@click="store.refresh(true)"'), '重试缺 refresh(true) 强制重拉');
  // ③ baseline。
  assert.ok(changesPanelSrc.includes('对比 HEAD {{ baselineShort }}'), 'baseline 短 hash 回显丢失');
  // ④ touched ●。
  assert.ok(changesPanelSrc.includes('title="本次会话编辑过"'), 'touched ● title 丢失');
  assert.ok(changesPanelSrc.includes("class=\"changes__touched\" title=\"本次会话编辑过\">●</span>"), 'touched ● 标记丢失');
  // ⑤ 500 截断 + 汇总行。
  assert.ok(changesPanelSrc.includes('store.files.slice(0, 500)'), '500 条截断丢失');
  assert.ok(changesPanelSrc.includes('其余 {{ store.files.length - 500 }} 条未显示'), '截断汇总行丢失');
  // ⑥ 空态三级化。
  assert.ok(changesPanelSrc.includes('当前没有活动会话或工作目录'), '无会话空态丢失');
  assert.ok(changesPanelSrc.includes('工作目录无改动'), '无改动空态丢失');
});

console.log('\n=== F5-09：任务卡头行键盘可达（新增强，RED→GREEN） ===');
check('F5-09 头行 role=button+tabindex=0+aria-expanded+Enter/Space+title 逐字；手柄 @click.stop 保持；focus-visible', () => {
  const idx = taskItemSrc.indexOf('class="task-item__header"');
  assert.ok(idx > -1, 'TaskItem 缺头行');
  const tag = taskItemSrc.slice(taskItemSrc.lastIndexOf('<div', idx), taskItemSrc.indexOf('>', idx) + 1);
  assert.ok(tag.includes('role="button"'), '头行缺 role="button"（键盘不可达）');
  assert.ok(tag.includes('tabindex="0"'), '头行缺 tabindex="0"（不可 Tab 聚焦）');
  assert.ok(tag.includes(':aria-expanded="expanded"'), '头行缺 aria-expanded 跟随展开态');
  assert.ok(tag.includes('@keydown.enter.prevent="expanded = !expanded"'), '头行缺 Enter 激活');
  assert.ok(tag.includes('@keydown.space.prevent="expanded = !expanded"'), '头行缺 Space 激活（.prevent 防页面滚动）');
  assert.ok(tag.includes('title="点击查看 / 收起详情"'), '头行 title 逐字丢失');
  // 手柄防冒泡保持（点击手柄不得触发展开）。
  assert.ok(taskItemSrc.includes('<span class="task-item__drag" @click.stop>⠿</span>'), '拖拽手柄 @click.stop 防冒泡丢失');
  // focus-visible 可见焦点。
  const fv = taskItemSrc.indexOf('.task-item__header:focus-visible');
  assert.ok(fv > -1, '头行缺 :focus-visible 焦点样式');
  const fvBody = taskItemSrc.slice(fv, taskItemSrc.indexOf('}', fv));
  assert.ok(fvBody.includes('outline: 2px solid var(--color-accent)'), 'focus-visible 须走 accent token 描边');
});

console.log('\n=== F5-10：计划卡全只读负断言（审批钮零出现，防倒退关键钉）+ Task 六态/Todo 三态 + dead code 删 ===');
check('F5-10a 审批钮零出现（ClaudePlanCard 全文件 + 面板全文件零审批字面；唯一按钮=任务头展开钮）', () => {
  for (const src of [planCardSrc, taskQueue]) {
    for (const w of ['审批', '批准', '拒绝', 'approve', 'Approve', 'approvePlan']) {
      assert.ok(!src.includes(w), `审批语义字面「${w}」出现（规范明令审批入口为零，InteractionPrompt 是唯一审批通路）`);
    }
  }
  // ClaudePlanCard 唯一 <button> = 任务头行展开钮（disclosure 性质，非审批）。
  const btnCount = (planCardSrc.match(/<button/g) ?? []).length;
  assert.equal(btnCount, 1, `ClaudePlanCard 应恰 1 个按钮（任务头展开钮），实为 ${btnCount}`);
  assert.ok(planCardSrc.includes('class="plan-task__header"'), '唯一按钮须为 plan-task__header 展开钮');
  // 只读纪律：无 emit、无确认弹窗通道。
  assert.ok(!planCardSrc.includes('defineEmits'), 'ClaudePlanCard 不得新增 emit');
  assert.ok(!planCardSrc.includes('requestConfirm'), 'ClaudePlanCard 不得接确认弹窗');
});
check('F5-10b Task 六态文案/Todo 三态圆环/完成划线/状态 dot 六态全保持', () => {
  const label = planCardSrc.slice(planCardSrc.indexOf('function taskStatusLabel'), planCardSrc.indexOf('function taskStatusLabel') + 600);
  for (const t of ["case 'pending': return '待开始'", "case 'in_progress': return '进行中'", "case 'completed': return '已完成'", "case 'failed': return '失败'", "case 'killed': return '已终止'", "case 'paused': return '已暂停'"]) {
    assert.ok(label.includes(t), `Task 六态标签丢字：${t}`);
  }
  // Todo 三态圆环（completed 对勾 / in_progress 半填充 / pending 空心）。
  assert.ok(planCardSrc.includes("item.status === 'completed'") && planCardSrc.includes("item.status === 'in_progress'"), 'Todo 三态渲染分支丢失');
  assert.ok((planCardSrc.match(/plan-todo-item--\$\{item\.status\}/g) ?? []).length >= 1, 'Todo 三态类绑定丢失');
  assert.ok(planCardSrc.includes('d="M8 2a6 6 0 0 1 0 12z"'), 'in_progress 半填充图标丢失');
  // 完成划线（Todo 文本 + Task subject）。
  assert.ok(planCardSrc.includes('plan-todo-item__text--done') && planCardSrc.includes('plan-task__subject--done'), '完成划线类丢失');
  // 状态 dot 六态类。
  for (const cls of ['plan-task__dot--in_progress', 'plan-task__dot--completed', 'plan-task__dot--failed', 'plan-task__dot--paused']) {
    assert.ok(planCardSrc.includes(`.${cls}`), `状态 dot 类丢失：.${cls}`);
  }
  assert.ok(planCardSrc.includes('plan-dot-pulse'), 'dot 脉冲动画丢失');
  const reducedIdx = planCardSrc.indexOf('@media (prefers-reduced-motion: reduce)');
  assert.ok(reducedIdx > -1 && planCardSrc.slice(reducedIdx).includes('.plan-task__dot--in_progress'), 'dot 动画 reduced-motion 降级丢失');
});
check('F5-10c dead code 已删（裁决 D4⑥）：hasPlan computed / claude-plan-card__empty 空态块 / v-else 解包', () => {
  // 代码形态断言（注释文字不参与）：无 const hasPlan 定义、无 !hasPlan 模板用法。
  assert.ok(!/const hasPlan\b/.test(planCardSrc), 'hasPlan computed 定义残留（永不可达分支 dead code）');
  assert.ok(!planCardSrc.includes('!hasPlan'), 'hasPlan 模板用法残留');
  assert.ok(!planCardSrc.includes('claude-plan-card__empty'), '.claude-plan-card__empty 空态块残留（面板侧 v-if 守卫下永不可达）');
  assert.ok(!planCardSrc.includes('Claude 尚未创建计划任务'), '卡内空态文案残留（面板侧空态「Claude 尚未创建计划」为其唯一呈现）');
  assert.ok(!planCardSrc.includes('<template v-else>'), 'v-else 解包残留');
  // 面板侧守卫不动（永不可达的根因守卫保留，planTotalCount===0 时面板渲染自己的空态）。
  assert.ok(taskQueue.includes('<ClaudePlanCard v-if="planTotalCount" />'), '面板侧计划卡渲染守卫被改动');
});
check('F5-10d TaskStatusBadge 六态 emoji+文字与样式类零语义改动（token 复核）', () => {
  const badgeSrc = read('../src/renderer/components/task/TaskStatusBadge.vue');
  for (const t of ["status === 'pending'\">⏳", "status === 'queued'\">📋", "status === 'running'\">▶️", "status === 'completed'\">✅", "status === 'failed'\">❌", "status === 'cancelled'\">🚫"]) {
    assert.ok(badgeSrc.includes(t), `六态 emoji 丢字：${t}`);
  }
  for (const cls of ['badge--pending', 'badge--queued', 'badge--running', 'badge--completed', 'badge--failed', 'badge--cancelled']) {
    assert.ok(badgeSrc.includes(`.${cls}`), `徽章样式类丢失：.${cls}`);
  }
  // token 纪律：样式块无硬编码 hex（radius/尺寸除外——10px 圆角为 radius 值非色值）。
  const styleIdx = badgeSrc.indexOf('<style');
  const style = badgeSrc.slice(styleIdx);
  assert.ok(!/#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})\b/.test(style), 'TaskStatusBadge 样式出现硬编码 hex（须只引 --color-* 变量）');
});

console.log('\n=== F5-11：计数角标 live 态保持（附 B 保全，转写即绿属预期） ===');
check('F5-11 tp-section__count 五类实时绑定 + rail 徽章 live 类（plan/subagent）+ rail__badge--live 样式', () => {
  for (const t of [
    '<span v-if="planTotalCount" class="tp-section__count">{{ planDone }}/{{ planTotalCount }}</span>',
    '<span v-if="taskStore.tasks.length" class="tp-section__count">{{ taskStore.tasks.length }}</span>',
    '<span v-if="subAgentGroups.length" class="tp-section__count">{{ subAgentGroups.length }}</span>',
    '<span v-if="backgroundTaskCount" class="tp-section__count">{{ backgroundTaskCount }}</span>',
    '<span v-if="changesCount" class="tp-section__count">{{ changesCount }}</span>',
  ]) {
    assert.ok(taskQueue.includes(t), `计数角标实时绑定丢失：${t}`);
  }
  assert.ok(taskQueue.includes("'rail__badge--live': planMetric.active"), '计划 rail 徽章 live 绑定丢失');
  assert.ok(taskQueue.includes("'rail__badge--live': runningSubAgentCount > 0"), '子Agent rail 徽章 live 绑定丢失');
  assert.ok(taskQueue.includes('.rail__badge--live'), 'rail__badge--live 样式丢失');
});

// 行为组统一在 async main 内串行执行（cjs 输出无顶层 await）。
async function main(): Promise<void> {
  for (const [name, fn] of f2BehaviorTasks) {
    await checkAsync(name, fn);
  }
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail > 0 ? 1 : 0);
}
void main();
