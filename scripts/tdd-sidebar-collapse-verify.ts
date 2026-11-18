// tdd-sidebar-collapse-verify.ts
// UI13-P4 左侧栏可折叠 源码契约脚本（docs/plans/2026-11-14-ui13-batch/03-test-cases.md「P4 左侧栏可折叠」T4-A~H）：
//   T4-A 折叠钮与窄轨形态（结构钉：底缘折叠钮 title「折叠侧栏」+ 折叠态容器类 sidebar--collapsed
//        + 窄轨含展开钮与新建会话入口）
//   T4-B 展开恢复拖拽宽度（结构钉：sidebarWidth ref 不被 toggleSidebarCollapsed 触碰
//        + 手柄 v-if 与 --sidebar-width 宽度绑定分离 + 折叠轨固定 48px 不动 AppLayout 记忆宽）
//   T4-C 折叠态拖宽手柄不可用（结构钉：AppLayout 手柄 v-if="!sessionStore.sidebarCollapsed" 门控）
//   T4-D 折叠态+宽度持久化（结构钉；【废卷反向重写留痕，2026-11-15 八问题批次 D1】原 UI13-P4 钉
//        「折叠态仅存内存/零 localStorage」（旧 T4-D1~D4 前半）与 00-behavior-specs 域 D 契约 #3
//        「折叠态+展开宽度持久化到 localStorage」相反，按 04-实施计划 §4.1 最小同步纪律废卷反向
//        重写为「有持久化」钉：两折叠位经 LS_COLLAPSE 双键读写（读点=state factory，写点=toggle
//        action try/catch）；AppConfig/config-manager 无 sidebar/collapse 字段的后半钉语义不变
//        保留（持久化载体唯 localStorage，config 通道维持禁入））
//   T4-E 瞬时切换（结构钉：.sidebar--collapsed 与折叠轨新增样式块无 transition 声明）
//   T4-F 订阅零影响（04 §3 裁决 R1 后结构钉：全局事件订阅位于 App.vue 不在侧栏组件内
//        + AppSidebar 折叠仅动容器几何的语义注释；v-if 卸载 DOM 允许，store 持续更新下展开即时正确）
//   T4-G 网页版可用（结构钉：折叠链路（窄轨块/折叠钮/store action 体）零 window.claudeLink
//        新增依赖；npm run typecheck:web 兜底由 GREEN 阶段独立命令执行）
//   T4-H 同步布尔翻转（结构钉：toggleSidebarCollapsed 体=同步布尔翻转+localStorage 写回（D1 持久化
//        写点扩展同步改钉留痕：原「恰为单行布尔翻转」钉被持久化写点扩展破坏，按 03b §7 D1-3 预期
//        同步；无异步中间态语义不变）；注：pinia 在 node 契约环境存在 ESM/CJS 双包分歧，行为直测
//        不可靠，按出卷选结构钉形态）
// 运行：npx tsx scripts/tdd-sidebar-collapse-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sidebarPath = join(__dirname, '../src/renderer/components/layout/AppSidebar.vue');
const layoutPath = join(__dirname, '../src/renderer/components/layout/AppLayout.vue');
const storePath = join(__dirname, '../src/renderer/stores/session-store.ts');
const configTypePath = join(__dirname, '../src/shared/types/config.ts');
const configManagerPath = join(__dirname, '../src/main/modules/config-manager.ts');
const appPath = join(__dirname, '../src/renderer/App.vue');

const sidebar = readFileSync(sidebarPath, 'utf8');
const layout = readFileSync(layoutPath, 'utf8');
const store = readFileSync(storePath, 'utf8');
const configType = readFileSync(configTypePath, 'utf8');
const configManager = readFileSync(configManagerPath, 'utf8');
const app = readFileSync(appPath, 'utf8');

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
  // 括号配对计数切 {…} 块（对齐 tdd-sidebar-card-pin-verify 确定锚点法）。
  // 体括号定位：找首个「其后到行尾仅剩空白」的 {。
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

// template 段（首个顶层 <template> 到最后一个 </template>，排除 style 段）。
const tplStart = sidebar.indexOf('<template>');
const tplEnd = sidebar.lastIndexOf('</template>');
const template = sidebar.slice(tplStart, tplEnd);

// style 段。
const styleStart = sidebar.indexOf('<style');

console.log('\n=== T4-A · 折叠钮与窄轨形态（结构钉） ===');

check('T4-A1 展开态底缘折叠钮：sidebar__footer 块内含 title「折叠侧栏」按钮（页脚配置入口之后）', () => {
  const footerIdx = template.indexOf('class="sidebar__footer"');
  const collapseIdx = template.indexOf('title="折叠侧栏"');
  assert.ok(footerIdx > -1, '未找到 sidebar__footer 块');
  assert.ok(collapseIdx > -1, '未找到 title="折叠侧栏" 折叠钮（侧栏底缘触发器缺失）');
  const settingsIdx = template.indexOf('to="/config"');
  assert.ok(settingsIdx > -1 && settingsIdx < collapseIdx, '折叠钮应位于页脚配置入口之后（底缘尾部追加）');
});
check('T4-A2 底缘折叠钮调 store.toggleSidebarCollapsed() 且按钮级可访问名一致', () => {
  const footerIdx = template.indexOf('class="sidebar__footer"');
  const footerBlock = template.slice(footerIdx, template.indexOf('class="sidebar__rail"') > -1 ? template.indexOf('class="sidebar__rail"') : template.length);
  assert.ok(footerBlock.includes('store.toggleSidebarCollapsed()'), '折叠钮未接 store.toggleSidebarCollapsed()');
  assert.ok(footerBlock.includes('aria-label="折叠侧栏"'), '折叠钮缺 aria-label="折叠侧栏"');
});
check('T4-A3 折叠态容器类：根元素 :class 绑定 sidebar--collapsed ← store.sidebarCollapsed', () => {
  assert.match(
    sidebar,
    /:class="\{\s*'sidebar--collapsed':\s*store\.sidebarCollapsed\s*\}"/,
    '根元素缺 sidebar--collapsed 类绑定',
  );
});
check('T4-A4 折叠窄轨块存在（v-else 形态，位于折叠钮之后）', () => {
  const railIdx = template.indexOf('class="sidebar__rail"');
  assert.ok(railIdx > -1, '未找到折叠窄轨 sidebar__rail 块');
  const collapseIdx = template.indexOf('title="折叠侧栏"');
  assert.ok(collapseIdx === -1 || railIdx > collapseIdx, '窄轨块应在底缘折叠钮之后');
});
check('T4-A5 窄轨内含展开钮（title/aria「展开侧栏」）与新建会话入口（title「新建会话」走 handleNewSession）', () => {
  const railIdx = template.indexOf('class="sidebar__rail"');
  assert.ok(railIdx > -1, '未找到折叠窄轨块');
  const railBlock = template.slice(railIdx);
  assert.ok(railBlock.includes('title="展开侧栏"'), '窄轨缺展开钮（title「展开侧栏」）');
  assert.ok(railBlock.includes('title="新建会话"'), '窄轨缺新建会话入口');
  assert.ok(railBlock.includes('handleNewSession'), '窄轨新建入口未接 handleNewSession');
});
check('T4-A6 顶部 brand 方标「CL」点击=展开（窄轨内 CL 方标钮带 title「展开侧栏」）', () => {
  const railIdx = template.indexOf('class="sidebar__rail"');
  const railBlock = template.slice(railIdx > -1 ? railIdx : 0);
  assert.match(railBlock, /class="sidebar__rail__mark"[^>]*>CL<\/button>/, '窄轨缺 CL 方标钮（brand-mark 窄轨形态）');
  assert.ok(railBlock.includes('store.toggleSidebarCollapsed()'), 'CL 方标未接展开动作');
});

console.log('\n=== T4-B · 展开恢复拖拽宽度（结构钉） ===');

check('T4-B1 AppLayout :style 的 --sidebar-width 绑定只依赖 sidebarWidth（与折叠态解耦，展开即恢复记忆宽）', () => {
  const lineMatch = layout.match(/^[^\n]*'--sidebar-width'[^\n]*$/m);
  assert.ok(lineMatch, 'AppLayout 未找到 --sidebar-width 绑定行');
  const line = lineMatch[0];
  assert.ok(line.includes('sidebarWidth + '), '--sidebar-width 绑定未消费 sidebarWidth');
  assert.ok(!line.includes('sidebarCollapsed'), '--sidebar-width 绑定不得随折叠态切换（折叠宽由 AppSidebar 固定 48px 覆盖）');
});
check('T4-B2 toggleSidebarCollapsed 不触碰 sidebarWidth（store action 体零宽度引用）', () => {
  const fnIdx = store.indexOf('toggleSidebarCollapsed() {');
  assert.ok(fnIdx > -1, 'session-store 缺 toggleSidebarCollapsed action');
  const body = sliceBalanced(store, fnIdx);
  assert.ok(!body.includes('sidebarWidth'), 'action 体不得触碰 sidebarWidth（拖宽记忆）');
});
check('T4-B3 折叠轨固定 48px：.sidebar--collapsed 块 width/min-width 48px 且不含 var(--sidebar-width)', () => {
  const cssIdx = sidebar.indexOf('.sidebar--collapsed {', styleStart);
  assert.ok(cssIdx > -1, '缺 .sidebar--collapsed 样式块');
  const block = sliceBalanced(sidebar, cssIdx);
  assert.ok(block.includes('width: 48px'), '折叠轨 width 应固定 48px');
  assert.ok(block.includes('min-width: 48px'), '折叠轨 min-width 应固定 48px');
  assert.ok(!block.includes('var(--sidebar-width)'), '折叠轨不得消费 --sidebar-width（AppLayout 记忆宽不被折叠改动）');
});
check('T4-B4 AppLayout sidebarWidth 赋值点唯一（仅拖拽钳制路径），折叠不新增写点', () => {
  const n = countOccurrences(layout, 'sidebarWidth.value =');
  assert.equal(n, 1, `sidebarWidth 赋值应恰 1 处（拖拽钳制），实际 ${n}`);
});

console.log('\n=== T4-C · 折叠态拖宽手柄不可用（结构钉） ===');

check('T4-C1 侧栏拖宽手柄 v-if="!sessionStore.sidebarCollapsed" 门控（折叠即隐藏不可拖）', () => {
  const handleIdx = layout.indexOf('class="resize-handle resize-handle--sidebar"');
  assert.ok(handleIdx > -1, '未找到侧栏拖宽手柄');
  const lineStart = layout.lastIndexOf('\n', handleIdx) + 1;
  const lineEnd = layout.indexOf('\n', handleIdx);
  const line = layout.slice(lineStart, lineEnd);
  assert.ok(line.includes('v-if="!sessionStore.sidebarCollapsed"'), '手柄行缺 v-if 折叠门控');
});
check('T4-C2 手柄展开态仍可拖（@mousedown="onSidebarResizeStart" 保留）', () => {
  const handleIdx = layout.indexOf('class="resize-handle resize-handle--sidebar"');
  assert.ok(handleIdx > -1, '未找到侧栏拖宽手柄');
  const line = layout.slice(layout.lastIndexOf('\n', handleIdx) + 1, layout.indexOf('\n', handleIdx));
  assert.ok(line.includes('@mousedown="onSidebarResizeStart"'), '手柄拖拽接线丢失');
});

console.log('\n=== T4-D · 折叠态持久化（结构钉；废卷反向重写留痕见脚本头注） ===');

check('T4-D1 折叠态初始化读回 localStorage：state 两折叠位经 readBool(LS_COLLAPSE.*)（旧「内存态 false」钉反向）', () => {
  assert.ok(store.includes("const LS_COLLAPSE = { sidebar: 'cl.sidebarCollapsed', overview: 'cl.overviewCollapsed' } as const;"),
    'session-store 缺 LS_COLLAPSE 持久化键常量');
  assert.ok(store.includes('overviewCollapsed: readBool(LS_COLLAPSE.overview),'), 'overviewCollapsed 缺 readBool 读回初始化');
  assert.ok(store.includes('sidebarCollapsed: readBool(LS_COLLAPSE.sidebar),'), 'sidebarCollapsed 缺 readBool 读回初始化');
});
check('T4-D2 折叠双键写回在 toggle action（try/catch 静默；旧「零 localStorage 写入」钉反向）', () => {
  const ovIdx = store.indexOf('toggleOverviewCollapsed() {');
  assert.ok(ovIdx > -1, '缺 toggleOverviewCollapsed action');
  const ovBody = sliceBalanced(store, ovIdx);
  assert.ok(ovBody.includes("localStorage.setItem(LS_COLLAPSE.overview, this.overviewCollapsed ? '1' : '0')"),
    'toggleOverviewCollapsed 缺 cl.overviewCollapsed 写回');
  assert.ok(ovBody.includes('try {') && ovBody.includes('} catch {'), 'toggleOverviewCollapsed 写回缺 try/catch 静默');
  const sbIdx = store.indexOf('toggleSidebarCollapsed() {');
  assert.ok(sbIdx > -1, '缺 toggleSidebarCollapsed action');
  const sbBody = sliceBalanced(store, sbIdx);
  assert.ok(sbBody.includes("localStorage.setItem(LS_COLLAPSE.sidebar, this.sidebarCollapsed ? '1' : '0')"),
    'toggleSidebarCollapsed 缺 cl.sidebarCollapsed 写回');
  assert.ok(sbBody.includes('try {') && sbBody.includes('} catch {'), 'toggleSidebarCollapsed 写回缺 try/catch 静默');
});
check('T4-D3 AppConfig（config.ts）无 sidebar/collapse 对应字段（持久化载体唯 localStorage，config 通道维持禁入）', () => {
  assert.ok(!/sidebar/i.test(configType), 'AppConfig 不得含 sidebar 字段（折叠态不进 config 持久化）');
});
check('T4-D4 config-manager.ts 无 sidebar/collapse 对应字段（持久化载体唯 localStorage，config 通道维持禁入）', () => {
  assert.ok(!/sidebar/i.test(configManager), 'config-manager 不得含 sidebar 字段（折叠态不进 config 持久化）');
});

console.log('\n=== T4-E · 瞬时切换无过渡（结构钉） ===');

check('T4-E1 .sidebar--collapsed 块无 transition 声明', () => {
  const cssIdx = sidebar.indexOf('.sidebar--collapsed {', styleStart);
  assert.ok(cssIdx > -1, '缺 .sidebar--collapsed 样式块');
  const block = sliceBalanced(sidebar, cssIdx);
  assert.ok(!block.includes('transition'), '折叠容器不得带过渡（契约 #4 瞬时切换）');
});
check('T4-E2 折叠轨新增样式块（rail/mark/new/expand）无 transition 声明', () => {
  const names = ['.sidebar__rail {', '.sidebar__rail__mark {', '.sidebar__rail__new {', '.sidebar__rail__expand {'];
  for (const name of names) {
    const idx = sidebar.indexOf(name, styleStart);
    assert.ok(idx > -1, `缺折叠轨样式块 ${name}`);
    const block = sliceBalanced(sidebar, idx);
    assert.ok(!block.includes('transition'), `${name} 不得带过渡`);
  }
});
check('T4-E3 .sidebar 基础块无 transition（回归钉：根容器几何切换瞬时的前提）', () => {
  const idx = sidebar.indexOf('.sidebar {', styleStart);
  assert.ok(idx > -1, '缺 .sidebar 基础样式块');
  const block = sliceBalanced(sidebar, idx);
  assert.ok(!block.includes('transition'), '.sidebar 基础块不得带 transition');
});

console.log('\n=== T4-F · 订阅零影响（R1 裁决后结构钉） ===');

check('T4-F1 全局事件订阅在 App.vue（CHAT_EVENT startListening + SESSIONS_CHANGED onSessionsChanged）', () => {
  assert.ok(/startListening\(\)/.test(app), 'App.vue 缺 CHAT_EVENT 全局订阅（startListening）');
  assert.ok(app.includes('onSessionsChanged'), 'App.vue 缺 SESSIONS_CHANGED 全局订阅');
});
check('T4-F2 AppSidebar 组件内零订阅注册（会话推送订阅不随侧栏折叠/卸载丢失）', () => {
  for (const anchor of ['onChatEvent', 'onSessionsChanged', 'onQueueEvent', 'startListening', 'bindContextUpdates']) {
    assert.ok(!sidebar.includes(anchor), `AppSidebar 不得含订阅注册 ${anchor}（全局订阅位于 App.vue）`);
  }
});
check('T4-F3 折叠语义注释在位（R1 裁决：折叠仅 v-if 卸载主体 DOM，订阅在 App.vue 全局，store 持续更新展开即时正确）', () => {
  const idx = sidebar.indexOf('UI13-P4 折叠');
  assert.ok(idx > -1, 'AppSidebar 缺 UI13-P4 折叠语义注释');
  const seg = sidebar.slice(idx, idx + 600);
  assert.ok(seg.includes('App.vue') && seg.includes('订阅'), '注释未说明「订阅在 App.vue 全局」语义');
  assert.ok(seg.includes('v-if'), '注释未说明折叠仅卸载主体 DOM 的实现语义');
});

console.log('\n=== T4-G · 网页版可用（结构钉；typecheck:web 兜底另行执行） ===');

check('T4-G1 折叠窄轨块零 window.claudeLink 依赖（折叠链路无新增 Electron 通道）', () => {
  const railIdx = template.indexOf('class="sidebar__rail"');
  assert.ok(railIdx > -1, '未找到折叠窄轨块');
  const railBlock = template.slice(railIdx);
  assert.ok(!railBlock.includes('window.claudeLink'), '折叠窄轨不得新增 window.claudeLink 依赖');
});
check('T4-G2 底缘折叠钮与 store action 体零 window 依赖', () => {
  const fnIdx = store.indexOf('toggleSidebarCollapsed() {');
  assert.ok(fnIdx > -1, 'session-store 缺 toggleSidebarCollapsed action');
  const body = sliceBalanced(store, fnIdx);
  assert.ok(!body.includes('window'), 'toggleSidebarCollapsed 不得依赖 window（纯内存翻转）');
});

console.log('\n=== T4-H · 同步布尔翻转（结构钉） ===');

check('T4-H1 toggleSidebarCollapsed 体=同步布尔翻转先行+localStorage 写回（D1 写点扩展同步改钉；仍无异步中间态）', () => {
  const fnIdx = store.indexOf('toggleSidebarCollapsed() {');
  assert.ok(fnIdx > -1, 'session-store 缺 toggleSidebarCollapsed action');
  const body = sliceBalanced(store, fnIdx).replace(/\s+/g, '');
  assert.ok(body.startsWith('toggleSidebarCollapsed(){this.sidebarCollapsed=!this.sidebarCollapsed;'),
    'action 体必须以同步布尔翻转为首语句（防连点竞态中间态）');
  assert.ok(body.includes("localStorage.setItem(LS_COLLAPSE.sidebar,this.sidebarCollapsed?'1':'0')"),
    'action 体缺 cl.sidebarCollapsed 持久化写回（D1 契约 #3）');
  assert.ok(body.includes('try{') && body.includes('catch{'), '写回缺 try/catch 静默（隐私模式不得抛错）');
});
check('T4-H2 action 体零 async/setTimeout/Promise（无异步翻转竞态面）', () => {
  const fnIdx = store.indexOf('toggleSidebarCollapsed() {');
  const body = sliceBalanced(store, fnIdx);
  assert.ok(!body.includes('async'), 'action 体不得 async');
  assert.ok(!body.includes('setTimeout'), 'action 体不得 setTimeout');
  assert.ok(!body.includes('Promise'), 'action 体不得 Promise');
});
check('T4-H3 this.sidebarCollapsed 写点唯一（action 内 3 处引用=翻转 2+持久化三元 1；D1 写点扩展同步改钉，无他处触碰）', () => {
  assert.equal(countOccurrences(store, 'this.sidebarCollapsed'), 3, 'this.sidebarCollapsed 应仅出现在 action 内（翻转 2 处+写回三元 1 处）');
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
