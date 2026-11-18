// tdd-collapse-unify-verify.ts
// 八问题批次 D1 桌面左右折叠统一+持久化 契约脚本
// （docs/plans/2026-11-15-eight-issues-batch/03b-test-cases-renderer.md §7 D1-1/D1-2/D1-3/D1-6；
//   行为契约唯一事实源 = 00-behavior-specs.md 域 D D1 节；CDP 场景 D1-4/D1-5 归 B 链/cdp-layout，不在本脚本）
//   D1-1 左右折叠轨视觉统一+右栏死手柄消除（钉）：右轨 .rail/.rail__btn/.rail__icon 与左轨同值字面
//        （轨宽 48/钮 26/图标 14/背景 var(--color-panel)/padding 14px 8px 12px/无 border-left）；
//        右栏拖宽手柄 v-if 含 !sessionStore.overviewCollapsed（折叠态总宽=48px，残条/死手柄消除）；
//        左栏既有 .sidebar--collapsed 48px 与 .task-panel--collapsed 48px 引用钉（不回归）。
//   D1-2 折叠钮交互形态统一（钉）：hover 同形（panel-soft 底+text 色，旧 accent 混色 hover 移除）；
//        :focus-visible 同值（outline 2px accent 55% 混色 offset 1px——AppSidebar 三钮类
//        new/expand/collapse + TaskQueuePanel .rail__btn）；右折叠钮 rail__btn--active 绑定移除
//        （折叠钮无激活态分歧，分类钮激活态保留）；title 文案各自对象名且右钮去方向词
//        （「向右折叠活动总览」→「折叠活动总览」）；aria-expanded/aria-label 保留。
//   D1-3 折叠态+宽度持久化四键（行为直测+钉）：cl.sidebarCollapsed/cl.overviewCollapsed（session-store
//        LS_COLLAPSE）/cl.sidebarWidth/cl.taskPanelWidth（AppLayout LS_WIDTH）——读点=state factory
//        readBool / ref readWidth（fallback 240/340，min/max 与拖拽钳制同源）；写点=toggle action /
//        onMouseUp 拖拽收尾（均 try/catch 静默）；readBool/readWidth 提取源码函数体 new Function
//        直测非法值回落（缺键/'abc'/越界/存储抛错→默认，合法值直通）。
//        实现形态申报：taskWidth 保留 `const taskWidth = ref(340)`（selftest-settings-mapping:1423 /
//        tdd-rightpanel-route-gate-verify:61 的 taskWidth=ref(340) 既有钉，本批同步清单未列，
//        钉语义「默认 340」在 D1 回落语义下仍真），持久化读回紧随其后单次赋值（行为等价两步形态）。
//   D1-6 ≤1100px 右栏队列 pill 语义维持（钉）：现状无 CSS @media 载体（规则锚回填实测：语义载体
//        =AppLayout JS matchMedia '(max-width: 1100px)' + 唤回 pill 模板结构），字面钉住不回归；
//        GUI 像素层（轨内 hover 对齐/图标视觉/两轨并列观感）人工目视项进实施报告。
//   D1-R5-1 修复路径钉（round-006 R6-1，补 R5-1 零钉）：TaskQueuePanel setFilter 切片含
//        sessionStore.toggleOverviewCollapsed(); 调用字面 + 全文件 overviewCollapsed = false
//        直写字面零出现（折叠态点分类钮走持久化 toggle 路径，防直写回归）。red-on-old 自证：
//        git show 3be0d7d:src/renderer/components/task/TaskQueuePanel.vue 临时形态反证一次
//        （基线 :387 恰一处直写、setFilter 切片无 toggle 调用 → 新钉两断言对基线必红；
//        R4-1 先例同机制，留痕 round-006/R6-fix-report.md）。
// 运行：npx tsx scripts/tdd-collapse-unify-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sidebarPath = join(__dirname, '../src/renderer/components/layout/AppSidebar.vue');
const taskPanelPath = join(__dirname, '../src/renderer/components/task/TaskQueuePanel.vue');
const layoutPath = join(__dirname, '../src/renderer/components/layout/AppLayout.vue');
const storePath = join(__dirname, '../src/renderer/stores/session-store.ts');

const sidebar = readFileSync(sidebarPath, 'utf8');
const taskPanel = readFileSync(taskPanelPath, 'utf8');
const layout = readFileSync(layoutPath, 'utf8');
const store = readFileSync(storePath, 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}
function sliceBalanced(src: string, startIdx: number): string {
  // 括号配对计数切 {…} 块（对齐 tdd-sidebar-collapse-verify 同名先例）。
  let openIdx = -1;
  for (let i = startIdx; i < src.length; i += 1) {
    if (src[i] !== '{') continue;
    let j = i + 1;
    while (j < src.length && src[j] !== '\n' && /\s/.test(src[j])) j += 1;
    if (j >= src.length || src[j] === '\n') { openIdx = i; break; }
  }
  if (openIdx === -1) return '';
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  return '';
}
function cssBlock(src: string, selector: string): string {
  const idx = src.indexOf(selector);
  assert.ok(idx > -1, `缺样式块 ${selector}`);
  const block = sliceBalanced(src, idx);
  assert.ok(block.length > 0, `样式块 ${selector} 花括号配对失败`);
  return block;
}
/** 提取顶层 `function NAME(...)` 的花括号内函数体（供 new Function 注入 fake localStorage 行为直测）。 */
function fnBody(src: string, name: string): string {
  const sigIdx = src.indexOf(`function ${name}(`);
  assert.ok(sigIdx > -1, `未找到 function ${name}`);
  const openIdx = src.indexOf('{', sigIdx);
  assert.ok(openIdx > -1, `function ${name} 缺函数体`);
  let depth = 0;
  for (let i = openIdx; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  assert.ok(false, `function ${name} 花括号配对失败`);
  return '';
}

// TaskQueuePanel template 段（首个 <template> 到最后一个 </template>，排除 style 段）。
const tqpTplStart = taskPanel.indexOf('<template>');
const tqpTplEnd = taskPanel.lastIndexOf('</template>');
const tqpTemplate = taskPanel.slice(tqpTplStart, tqpTplEnd);
const tqpStyle = taskPanel.slice(taskPanel.indexOf('<style'));

console.log('\n=== D1-1 · 左右折叠轨视觉统一 + 右栏死手柄消除（钉） ===');

check('D1-1① 右轨 .rail 与左轨同值：width 48px + padding 14px 8px 12px + background var(--color-panel)', () => {
  const block = cssBlock(tqpStyle, '.rail {');
  assert.ok(block.includes('width: 48px'), '.rail 轨宽应为 48px');
  assert.ok(block.includes('padding: 14px 8px 12px'), '.rail padding 应为 14px 8px 12px（左轨同值）');
  assert.ok(block.includes('background: var(--color-panel)'), '.rail 背景应为 var(--color-panel)（左轨同值）');
});
check('D1-1② 右轨 .rail 无 border-left（左轨无内分隔；rail__divider 保留作钮组分隔）', () => {
  const block = cssBlock(tqpStyle, '.rail {');
  assert.ok(!block.includes('border-left'), '.rail 不得残留 border-left（右轨向左轨对齐）');
  const dividerIdx = tqpStyle.indexOf('.rail__divider {');
  assert.ok(dividerIdx > -1, '.rail__divider 应保留（钮组分隔）');
});
check('D1-1③ 右轨 .rail__btn 26×26（旧 38px 字面移除）', () => {
  const block = cssBlock(tqpStyle, '.rail__btn {');
  assert.ok(block.includes('width: 26px') && block.includes('height: 26px'), '.rail__btn 应为 26×26（左轨同值）');
  assert.ok(!block.includes('38px'), '.rail__btn 不得残留 38px 旧值');
});
check('D1-1④ 右轨 .rail__icon 14×14（旧 20px 字面移除）', () => {
  const block = cssBlock(tqpStyle, '.rail__icon {');
  assert.ok(block.includes('width: 14px') && block.includes('height: 14px'), '.rail__icon 应为 14×14（左轨同值）');
  assert.ok(!block.includes('20px'), '.rail__icon 不得残留 20px 旧值');
});
check('D1-1⑤ 右栏死手柄消除：AppLayout 任务手柄 v-if 含 !sessionStore.overviewCollapsed（折叠态总宽=48px）', () => {
  const handleIdx = layout.indexOf('class="resize-handle resize-handle--task"');
  assert.ok(handleIdx > -1, '未找到任务拖宽手柄');
  const line = layout.slice(layout.lastIndexOf('\n', handleIdx) + 1, layout.indexOf('\n', handleIdx));
  assert.ok(line.includes('v-if='), '任务手柄缺 v-if（折叠态死手柄仍渲染=视觉 53px）');
  assert.ok(line.includes('!sessionStore.overviewCollapsed'), '任务手柄 v-if 缺 !sessionStore.overviewCollapsed 门控');
});
check('D1-1⑥ 折叠态 48px 双钉引用不回归：.sidebar--collapsed 与 .task-panel--collapsed 均 width/min-width 48px', () => {
  const sidebarBlk = cssBlock(sidebar.slice(sidebar.indexOf('<style')), '.sidebar--collapsed {');
  assert.ok(sidebarBlk.includes('width: 48px') && sidebarBlk.includes('min-width: 48px'), '.sidebar--collapsed 48px 钉丢失（T4-B3 同源）');
  const taskBlk = cssBlock(tqpStyle, '.task-panel--collapsed {');
  assert.ok(taskBlk.includes('width: 48px') && taskBlk.includes('min-width: 48px'), '.task-panel--collapsed 48px 钉丢失');
});
check('D1-1⑦ R5-1 修复路径钉（round-006 R6-1）：setFilter 走 toggleOverviewCollapsed 持久化路径 + 全文件 overviewCollapsed = false 直写零出现', () => {
  const setIdx = taskPanel.indexOf('function setFilter(');
  assert.ok(setIdx > -1, '缺 function setFilter');
  const setBody = sliceBalanced(taskPanel, setIdx);
  assert.ok(setBody.length > 0, 'setFilter 函数体切片失败');
  assert.ok(setBody.includes('sessionStore.toggleOverviewCollapsed();'),
    'setFilter 切片缺 sessionStore.toggleOverviewCollapsed(); 调用（折叠态点分类钮须走持久化 toggle 路径，R5-1）');
  assert.equal(countOccurrences(taskPanel, 'overviewCollapsed = false'), 0,
    'TaskQueuePanel 全文件出现 overviewCollapsed = false 直写字面（R5-1：直写绕过 cl.overviewCollapsed 持久化，已修不得回退）');
});

console.log('\n=== D1-2 · 折叠钮交互形态统一（钉） ===');

check('D1-2① 右轨 hover 与左轨同形：.rail__btn:hover = panel-soft 底 + text 色（旧 accent 混色移除）', () => {
  const hoverBlk = cssBlock(tqpStyle, '.rail__btn:hover {');
  assert.ok(hoverBlk.includes('background: var(--color-panel-soft)'), '.rail__btn:hover 缺 panel-soft 底（左轨同形）');
  assert.ok(hoverBlk.includes('color: var(--color-text)'), '.rail__btn:hover 缺 text 色');
  assert.ok(!hoverBlk.includes('color-mix'), '.rail__btn:hover 不得残留 accent 混色旧形态');
  const leftHoverBlk = cssBlock(sidebar.slice(sidebar.indexOf('<style')), '.sidebar__rail__new:hover {');
  assert.ok(leftHoverBlk.includes('background: var(--color-panel-soft)') && leftHoverBlk.includes('color: var(--color-text)'),
    '左轨 hover 基准漂移（基准侧不应被改动）');
});
check('D1-2② :focus-visible 两轨统一：左三钮类（new/expand/collapse）+ 右 .rail__btn 各补 2px accent 55% 混色 outline offset 1px', () => {
  const FOCUS_OUTLINE = 'outline: 2px solid color-mix(in srgb, var(--color-accent) 55%, transparent);';
  const sidebarStyle = sidebar.slice(sidebar.indexOf('<style'));
  for (const sel of ['.sidebar__rail__new', '.sidebar__rail__expand', '.sidebar__collapse']) {
    const blk = cssBlock(sidebarStyle, `${sel}:focus-visible {`);
    assert.ok(blk.includes(FOCUS_OUTLINE), `${sel}:focus-visible 缺 2px accent 55% 混色 outline`);
    assert.ok(blk.includes('outline-offset: 1px;'), `${sel}:focus-visible 缺 outline-offset: 1px`);
  }
  const railBlk = cssBlock(tqpStyle, '.rail__btn:focus-visible {');
  assert.ok(railBlk.includes(FOCUS_OUTLINE), '.rail__btn:focus-visible 缺 2px accent 55% 混色 outline');
  assert.ok(railBlk.includes('outline-offset: 1px;'), '.rail__btn:focus-visible 缺 outline-offset: 1px');
});
check('D1-2③ 右折叠钮 rail__btn--active 绑定移除（折叠钮无激活态分歧）；分类钮 --active 样式块保留', () => {
  const btnIdx = tqpTemplate.indexOf('rail__btn--collapse');
  assert.ok(btnIdx > -1, '未找到右折叠钮（rail__btn--collapse）');
  const btnBlock = tqpTemplate.slice(btnIdx, tqpTemplate.indexOf('</button>', btnIdx));
  assert.ok(!btnBlock.includes('rail__btn--active'), '右折叠钮不得绑定 rail__btn--active（形态一致性修正）');
  assert.equal(countOccurrences(taskPanel, "'rail__btn--active': sessionStore.overviewCollapsed"), 0,
    '旧 overviewCollapsed→rail__btn--active 绑定字面残留');
  const activeBlk = cssBlock(tqpStyle, '.rail__btn--active {');
  assert.ok(activeBlk.includes('accent'), '分类钮 .rail__btn--active 样式块应保留（右轨独有功能面）');
});
check('D1-2④ title 文案：右钮去方向词（折叠活动总览），左钮对象名维持（折叠侧栏/展开侧栏）', () => {
  assert.ok(tqpTemplate.includes(":title=\"sessionStore.overviewCollapsed ? '展开活动总览' : '折叠活动总览'\""),
    '右折叠钮 title 分支应为「展开活动总览/折叠活动总览」（去方向词）');
  assert.ok(!taskPanel.includes('向右折叠活动总览'), '「向右折叠活动总览」方向词残留');
  assert.ok(!taskPanel.includes('向左折叠活动总览'), '「向左折叠活动总览」方向词残留');
  assert.ok(sidebar.includes('title="折叠侧栏"') && sidebar.includes('title="展开侧栏"'),
    '左栏折叠/展开钮对象名文案漂移（基准侧不应被改动）');
});
check('D1-2⑤ 可达性语义保留：右折叠钮 aria-expanded/aria-label 同型在位', () => {
  assert.ok(tqpTemplate.includes(':aria-expanded="!sessionStore.overviewCollapsed"'), '右折叠钮缺 aria-expanded 绑定');
  assert.ok(tqpTemplate.includes(":aria-label=\"sessionStore.overviewCollapsed ? '展开活动总览' : '折叠活动总览'\""),
    '右折叠钮 aria-label 分支漂移');
});

console.log('\n=== D1-3 · 折叠态+宽度持久化四键（行为直测 + 钉） ===');

check('D1-3① 键常量单一来源：session-store LS_COLLAPSE 双键 + AppLayout LS_WIDTH 双键字面', () => {
  assert.ok(store.includes("const LS_COLLAPSE = { sidebar: 'cl.sidebarCollapsed', overview: 'cl.overviewCollapsed' } as const;"),
    "session-store 缺 LS_COLLAPSE 键常量（cl.sidebarCollapsed/cl.overviewCollapsed）");
  assert.ok(layout.includes("const LS_WIDTH = { sidebar: 'cl.sidebarWidth', task: 'cl.taskPanelWidth' } as const;"),
    "AppLayout 缺 LS_WIDTH 键常量（cl.sidebarWidth/cl.taskPanelWidth）");
});
check('D1-3② 读点=state factory 初始化：两折叠位 readBool(LS_COLLAPSE.*) 读回', () => {
  assert.ok(store.includes('overviewCollapsed: readBool(LS_COLLAPSE.overview),'), 'overviewCollapsed 未从 localStorage 读回初始化');
  assert.ok(store.includes('sidebarCollapsed: readBool(LS_COLLAPSE.sidebar),'), 'sidebarCollapsed 未从 localStorage 读回初始化');
});
check('D1-3③ 写点=toggle action（同步翻转先行+try/catch 写回，无异步中间态）', () => {
  const ovIdx = store.indexOf('toggleOverviewCollapsed() {');
  assert.ok(ovIdx > -1, '缺 toggleOverviewCollapsed action');
  const ovBody = sliceBalanced(store, ovIdx).replace(/\s+/g, '');
  assert.ok(ovBody.startsWith('toggleOverviewCollapsed(){this.overviewCollapsed=!this.overviewCollapsed;'),
    'toggleOverviewCollapsed 翻转必须先行（同步单点翻转）');
  assert.ok(ovBody.includes("localStorage.setItem(LS_COLLAPSE.overview,this.overviewCollapsed?'1':'0')"),
    'toggleOverviewCollapsed 缺 cl.overviewCollapsed 写回');
  assert.ok(ovBody.includes('try{') && ovBody.includes('catch{'), 'toggleOverviewCollapsed 写回缺 try/catch 静默');
  assert.ok(!ovBody.includes('async') && !ovBody.includes('setTimeout') && !ovBody.includes('Promise'),
    'toggleOverviewCollapsed 不得引入异步面');
  const sbIdx = store.indexOf('toggleSidebarCollapsed() {');
  assert.ok(sbIdx > -1, '缺 toggleSidebarCollapsed action');
  const sbBody = sliceBalanced(store, sbIdx).replace(/\s+/g, '');
  assert.ok(sbBody.startsWith('toggleSidebarCollapsed(){this.sidebarCollapsed=!this.sidebarCollapsed;'),
    'toggleSidebarCollapsed 翻转必须先行（同步单点翻转）');
  assert.ok(sbBody.includes("localStorage.setItem(LS_COLLAPSE.sidebar,this.sidebarCollapsed?'1':'0')"),
    'toggleSidebarCollapsed 缺 cl.sidebarCollapsed 写回');
  assert.ok(sbBody.includes('try{') && sbBody.includes('catch{'), 'toggleSidebarCollapsed 写回缺 try/catch 静默');
});
check('D1-3④ 读点=宽度 ref 初始化：sidebarWidth 直读 readWidth（fallback 240 + 拖拽同源 min/max）', () => {
  assert.ok(layout.includes('const sidebarWidth = ref(readWidth(LS_WIDTH.sidebar, 240, SIDEBAR_MIN, SIDEBAR_MAX));'),
    'sidebarWidth 未按 readWidth(LS_WIDTH.sidebar, 240, SIDEBAR_MIN, SIDEBAR_MAX) 初始化');
  assert.ok(layout.includes('function readWidth('), 'AppLayout 缺 readWidth 读取器');
});
check('D1-3⑤ 宽度写点=onMouseUp 拖拽收尾单点写回（分目标键+try/catch 静默）', () => {
  const upIdx = layout.indexOf('function onMouseUp() {');
  assert.ok(upIdx > -1, 'AppLayout 缺 onMouseUp');
  const body = sliceBalanced(layout, upIdx);
  assert.ok(body.includes("if (dragging === 'sidebar')") && body.includes("localStorage.setItem(LS_WIDTH.sidebar, String(sidebarWidth.value))"),
    'onMouseUp 缺 cl.sidebarWidth 收尾写回');
  assert.ok(body.includes("if (dragging === 'task')") || body.includes("else if (dragging === 'task')"),
    'onMouseUp 缺拖拽目标分流');
  assert.ok(body.includes('localStorage.setItem(LS_WIDTH.task, String(taskWidth.value))'), 'onMouseUp 缺 cl.taskPanelWidth 收尾写回');
  assert.equal(countOccurrences(body, 'try {'), 2, 'onMouseUp 两条写回须各自 try/catch 静默');
  assert.ok(!body.includes('await') && !body.includes('setTimeout'), 'onMouseUp 不得引入异步面');
});
check('D1-3⑥ [行为] readBool 提取源码体直测：缺键/非\'1\'/存储抛错→false，\'1\'→true', () => {
  const readBool = new Function('key', 'localStorage', fnBody(store, 'readBool')) as (k: string, ls: unknown) => boolean;
  const mk = (storeMap: Map<string, string> | null, thrower = false) => ({
    getItem(k: string) { if (thrower) throw new Error('storage denied'); return storeMap ? (storeMap.get(k) ?? null) : null; },
  });
  assert.equal(readBool('cl.sidebarCollapsed', mk(null)), false, '缺键应回落 false');
  assert.equal(readBool('k', mk(new Map([['k', '1']]))), true, "'1' 应读回 true");
  assert.equal(readBool('k', mk(new Map([['k', '0']]))), false, "'0' 应回落 false");
  assert.equal(readBool('k', mk(new Map([['k', 'abc']]))), false, "非法值 'abc' 应回落 false");
  assert.equal(readBool('k', mk(null, true)), false, '存储抛错应静默回落 false');
});
check('D1-3⑦ [行为] readWidth 提取源码体直测：缺键/非有限数/越 min-max/存储抛错→fallback，界内值直通', () => {
  const readWidth = new Function('key', 'fallback', 'min', 'max', 'localStorage', fnBody(layout, 'readWidth')) as
    (k: string, fb: number, min: number, max: number, ls: unknown) => number;
  const mk = (v: string | null, thrower = false) => ({
    getItem(_k: string) { if (thrower) throw new Error('storage denied'); return v; },
  });
  assert.equal(readWidth('cl.sidebarWidth', 240, 180, 460, mk(null)), 240, '侧栏缺键应回落默认 240');
  assert.equal(readWidth('cl.taskPanelWidth', 340, 240, 560, mk(null)), 340, '右栏缺键应回落默认 340');
  assert.equal(readWidth('k', 240, 180, 460, mk('abc')), 240, "非法值 'abc' 应回落默认");
  assert.equal(readWidth('k', 240, 180, 460, mk('100')), 240, '低于 min(180) 应回落默认');
  assert.equal(readWidth('k', 240, 180, 460, mk('999')), 240, '高于 max(460) 应回落默认');
  assert.equal(readWidth('k', 240, 180, 460, mk('300')), 300, '界内值 300 应直通');
  assert.equal(readWidth('k', 340, 240, 560, mk('420')), 420, '右栏界内值 420 应直通');
  assert.equal(readWidth('k', 340, 240, 560, mk('200')), 340, '右栏低于 min(240) 应回落默认');
  assert.equal(readWidth('k', 240, 180, 460, mk(null, true)), 240, '存储抛错应静默回落默认');
});
check('D1-3⑧ 宽度读点钳制与拖拽钳制同源：readWidth 调用传 SIDEBAR_MIN/MAX 与 TASK_MIN/MAX（拖宽纳入持久化）', () => {
  assert.ok(layout.includes('readWidth(LS_WIDTH.sidebar, 240, SIDEBAR_MIN, SIDEBAR_MAX)'), '侧栏 readWidth 未传拖拽钳制常量');
  assert.ok(layout.includes('readWidth(LS_WIDTH.task, 340, TASK_MIN, TASK_MAX)'), '右栏 readWidth 未传拖拽钳制常量');
  assert.ok(layout.includes('const taskWidth = ref(340);'), '右栏 340 默认契约钉（selftest-settings-mapping 1423）漂移');
});

console.log('\n=== D1-6 · ≤1100px 右栏队列 pill 语义维持（钉；现状载体=JS matchMedia，无 CSS @media） ===');

check('D1-6① 断点源字面保留：AppLayout matchMedia \'(max-width: 1100px)\' + 初值取 matches', () => {
  assert.ok(layout.includes("window.matchMedia('(max-width: 1100px)')"), '≤1100 断点 mqPanel 字面漂移');
  assert.ok(layout.includes('ref(mqPanel.matches)'), 'panelForceHidden 初值未取 matches（窄窗首绘闪变回归）');
});
check('D1-6② 断点监听与唤回联动保留：change 监听 + 唤回条 pill 三件套', () => {
  assert.ok(layout.includes("mqPanel.addEventListener('change', onMqPanelChange)"), 'mqPanel change 监听丢失');
  assert.ok(layout.includes('v-else-if="isChatRoute && panelForceHidden && !panelRecalled"'), '唤回条 v-else-if 门漂移');
  assert.ok(layout.includes('class="reopen-task-panel"'), '唤回条 pill 元素丢失');
  assert.ok(layout.includes('@click="panelRecalled = true"'), '唤回条点击恢复接线丢失');
});
check('D1-6③ 右栏主体渲染门与 ≤1100 隐藏语义绑定保留', () => {
  assert.ok(layout.includes('v-if="isChatRoute && (!panelForceHidden || panelRecalled)"'), '右栏主体渲染门漂移');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
