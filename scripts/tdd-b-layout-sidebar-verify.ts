// tdd-b-layout-sidebar-verify.ts
// B 布局与侧栏（B1~B6）共用契约脚本 · B1 小节「移除会话分组模式 + 批量删除钮 32×32 迁搜索行」
// ＋ B2 小节「会话卡双行卡化（类名家族一字不改）」
// ＋ B3 小节「会话管理入口（AppHeader toggle）+ SessionsPage 补齐」
// ＋ B4 小节「窄窗两级断点（1100/800）+ 唤回条 pill + 侧栏 overlay 唤回 + 删 isTaskPanelOpen 死状态」
// ＋ B6 小节「侧栏/顶栏细节包（手柄 hover/拖动常亮、重命名图标化+aria、搜索 aria、
//   新会话钮 ink+kbd 反白、暂态激活 inset 3px、品牌区防倒退钉）」（round-001 点 B6）
// （slate-ui-completion-1108-1428 round-001 点 B1/B2/B3；用例正本 = docs/ui-completion/tests/B-layout-sidebar-cases.md
//   §G G-1 / §B1 B1-1~B1-10 / §B2 B2-1~B2-18 / §B3 B3-1~B3-10 / §B6 B6-1~B6-10；行为规范 = docs/ui-completion/10-behavior-specs.md §B1/§B2/§B3/§B6）。
// 全部为纯 node 读文件 + 字面/正则断言，不 import Electron、不跑 DB。
//
// 执行侧裁决（申报留痕）：B1-2/3/4/5/6/7/8 与 B2-4/5/6/7/8/9/10/11/12(CDP 部分)/14/15/16(CDP 部分)/17(CDP
// 部分)/18 的用例卷落点为 CDP 行为断言（cdp-layout 或 cdp-smoke 扩展），但 scripts/cdp-layout-e2e.mjs 与
// scripts/cdp-smoke-test.mjs 均不在点 B1/B2 申报文件圈内（编排器 points.json files），本脚本以同回归面的
// 结构钉转写（模板切片/CSS 切片/字面钉/纯函数行为组）；CDP 运行时验证由点闸门 npm run test:cdp
// （cdp-smoke-test.mjs，preload-API 驱动不涉侧栏 DOM）兜底，运行时像素级断言推迟到 B4（LAYOUT 闸门在圈）
// 再补——见 pB1/pB2 实施报告申报事项。IM chip（B2-17 目检项）随 SessionsPage B3 落地后可实测。
//
// 覆盖（B1）：
//   G-1  契约脚本注册存在（selftest-static-list.txt + tsconfig.tdd.json include 两处）；
//   B1-1 页签「全部/项目」R1 恢复正向钉（.sidebar__tabs/aria「会话分组方式」在场 + tabs 容器切片无 multiselect；
//        script 段 groupByProject/viewGroups/groupSessionsByProject/SessionGroup 四标识符在场）；
//   B1-2 单模板结构钉（viewGroups 切换源：v-for session 恰 1 处、无 v-if/v-else 分支包裹、dateGroups 逐字保留）；
//   B1-3 搜索态同走五桶含置顶优先（displayedSessions 搜索态返回 searchResults + 五桶置顶组前插）；
//   B1-4 批量钮 32×32 图标钮与搜索框同行右置（.sidebar__search-row flex 行、搜索框 flex:1 占满、
//        多选钮 32×32 无旧页签行锚定 margin、list-checks 图标换装、旧垃圾桶线稿弃用）；
//   B1-5 armed 态红底与 title/aria 动态（三元逐字 + --active 类绑定 + danger/on-danger 红底块，
//        且多选钮必须位于搜索行切片内=已迁位）；
//   B1-6 批量态下分组与批量条保持（batchbar 三件套字面 + 删除 (N) 半角括号形态 + viewGroups
//        循环与 batchMode 解耦）；
//   B1-7 空列表态分组头不渲染且批量钮可用（empty v-if 二分 + 五桶空入空出 filter + 多选钮无 v-if/
//        列表长度判定）；
//   B1-8 搜索无结果态（未找到匹配的会话/暂无会话二分逐字，均挂在 empty 块内）；
//   B1-9 项目分组相关代码恰在两文件（src/ 全树正向钉：四标识符恰 AppSidebar.vue + group-sessions.ts；
//        ConfigPage.vue 仍零命中）；
//   B1-10 ConfigPage 零涉（模板切片无「分组」文案、全文件无 groupBy 绑定）。
//
// 覆盖（B2，类名家族一字不改：session-link + 全部 __ 子类 + 四态修饰类保全，仅新增 __r1/__r2/__chip）：
//   B2-1 双行卡 r1/r2 结构与次序钉（R2 迁位后 r1=状态灯→置顶钮→标题、r2=chip→⏳→时间→删除，时间不留首行）；
//   B2-2 状态灯四态语义与 aria 逐字迁移保全（idle 无灯守卫/role=img/statusLabel 接线/容器四态修饰类/
//        session-display-status.ts 四文案权威逐字）；
//   B2-3 ⏳ 字面量契约钉（恰 1 处于 r2 内 + pendingRemoteCountBySession 判定 + title 契约文案）；
//   B2-4 hover 交换（CDP→结构钉）：hover 时时间 display:none、置顶钮显现三件套、删除钮 display:grid；
//   B2-5 :focus-within 同等交换（裁决 B-C3：与 hover 分支并存规则组）；
//   B2-6 批量态（CDP→结构钉）：操作钮 v-if 守卫不渲染、checkbox 在 r1、批量时间恢复含 focus-within 豁免；
//   B2-7 激活卡描边强调 + hover 加深（B-C6 圆角 --radius-sm(8)；负向：旧 accent 8% 混色移除、无左缘条）；
//   B2-8 普通态键盘形态（role=button + tabindex=0 + aria-label=会话名）；
//   B2-9 批量态键盘形态（role=checkbox + aria-checked 随选联动）；
//   B2-10 容器级 Enter/Space 委托激活（nav @keydown + closest(.session-link) 转发）；
//   B2-11 原生控件防双触发（五类原生元素 instanceof 早退先于 closest）；
//   B2-12 入场 stagger 前 8 项阶梯（nth-child(2..8) 35..245ms 逐项、无第 9 档、keyframes 保留）；
//   B2-13 reduced-motion 降级保留（顺序钉：media 块位于 pulse 声明/两 keyframes 之后，块内显式关动画）；
//   B2-14 超长会话名 ellipsis（__name 三件套 + min-width:0）；
//   B2-15 暂态守卫迁移（置顶钮 v-if 含 !session.transient、R2 --pinned 双态类绑定 pinnedAt != null）；
//   B2-16 项目 chip（script 接线 chipLabel 消费 projectLabel + 模板接线 + projectLabel 纯函数行为组）；
//   B2-17 chip 互斥与无则不渲染（IM 判定键=bridgePlatform 裁决、只读文案钉、空值返回 null）；
//   B2-18 搜索∩批量∩激活三态叠加（--selected 规则在 .active 之后叠加可辨 + inset ring + 五桶/批量条前置钉）。
//
// 运行：npx tsx scripts/tdd-b-layout-sidebar-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { projectLabel } from '../src/renderer/utils/group-sessions';

const repoRoot = join(__dirname, '..');
// 读取统一折叠 CRLF→LF：B2 小节含跨行字面钉（卡片块形态），源文件可能为 CRLF 行尾，
// 折叠后脚本对行尾不敏感（B1 既有断言均为单行字面/正则，不受影响）。
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const sidebar = read('src/renderer/components/layout/AppSidebar.vue');
const groupByDate = read('src/renderer/utils/group-sessions-by-date.ts');
const storeSrc = read('src/renderer/stores/session-store.ts');
const configPage = read('src/renderer/pages/ConfigPage.vue');
const staticList = read('scripts/selftest-static-list.txt');
const tsconfigTdd = read('tsconfig.tdd.json');

// 取 template 段（首个顶层 <template> 到最后一个 </template>）与 style 段，用于切片断言。
const tplStart = sidebar.indexOf('<template>');
const tplEnd = sidebar.lastIndexOf('</template>');
const template = sidebar.slice(tplStart, tplEnd);
const style = sidebar.slice(sidebar.indexOf('<style'));

// ConfigPage 模板段（B1-10 用：CSS 注释里合法存在「分组」字样，负断言只钉模板段）。
const cfgTpl = configPage.slice(configPage.indexOf('<template>'), configPage.lastIndexOf('</template>'));

function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}

// CSS 规则块切片：自选择器起到首个 `}`（单层规则块，本文件样式无嵌套）。
function cssBlock(src: string, selector: string): string {
  const start = src.indexOf(selector);
  assert.ok(start !== -1, `未找到样式选择器 ${selector}`);
  return src.slice(start, src.indexOf('}', start));
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

console.log('\n=== G-1 · B 布局侧栏契约脚本注册存在 ===');

check('G-1 注册两处均在：selftest-static-list.txt 尾部行 + tsconfig.tdd.json include', () => {
  assert.ok(staticList.includes('scripts/tdd-b-layout-sidebar-verify.ts'), 'selftest-static-list.txt 缺注册行');
  assert.ok(tsconfigTdd.includes('"scripts/tdd-b-layout-sidebar-verify.ts"'), 'tsconfig.tdd.json include 缺该脚本');
});

console.log('\n=== B1-1 · 页签「全部/项目」R1 恢复正向钉（防结构倒退） ===');

check('B1-1a R1 恢复钉：.sidebar__tabs 与 aria「会话分组方式」在场 + tabs 容器切片内无 sidebar__multiselect（批量钮留搜索行）', () => {
  assert.ok(sidebar.includes('sidebar__tabs'), '缺 .sidebar__tabs 页签容器');
  assert.ok(template.includes('aria-label="会话分组方式"'), '缺页签组 aria-label「会话分组方式」');
  const tabsStart = template.indexOf('class="sidebar__tabs"');
  assert.ok(tabsStart > -1, '模板缺 sidebar__tabs 容器');
  const tabsEnd = template.indexOf('</div>', tabsStart);
  const tabsSlice = template.slice(tabsStart, tabsEnd > -1 ? tabsEnd : undefined);
  assert.ok(!tabsSlice.includes('sidebar__multiselect'), '批量删除钮混入页签行（应留搜索行）');
});
check('B1-1b R1 恢复钉：模板「全部」「项目」两页签文字钮在场且顺序 = 全部 → 项目', () => {
  const allIdx = template.search(/>\s*全部\s*</);
  const projIdx = template.search(/>\s*项目\s*</);
  assert.ok(allIdx > -1, '缺「全部」页签独立文本节点');
  assert.ok(projIdx > -1, '缺「项目」页签独立文本节点');
  assert.ok(allIdx < projIdx, `页签顺序应为「全部」先于「项目」（${allIdx},${projIdx}）`);
});
check('B1-1c R1 恢复钉：script 含 groupByProject/viewGroups/groupSessionsByProject/\\bSessionGroup\\b 四标识符（\\b 排除 DateSessionGroup）', () => {
  assert.ok(/\bgroupByProject\b/.test(sidebar), '缺 groupByProject 组件态');
  assert.ok(/\bviewGroups\b/.test(sidebar), '缺 viewGroups 切换源');
  assert.ok(/\bgroupSessionsByProject\b/.test(sidebar), '缺 groupSessionsByProject 项目分组源');
  assert.ok(/\bSessionGroup\b/.test(sidebar), '缺 SessionGroup 接口类型');
});
check('B1-11 R1 恢复钉（页签行位置 = search-row 闭合后 nav 之前 / 两原生 button / active 三元逐字 / CSS 四块 + ::after accent）', () => {
  // ① 页签行位置：search-row 闭合 </div> 之后、<nav 之前（以多选钮 </button> 定位行闭合，避开 search-wrap 内层 </div>）
  const msIdx = template.indexOf('class="sidebar__multiselect"');
  const msClose = template.indexOf('</button>', msIdx);
  const rowClose = template.indexOf('</div>', msClose);
  const tabsIdx = template.indexOf('class="sidebar__tabs"');
  const navIdx = template.indexOf('<nav class="sidebar__sessions"');
  assert.ok(msIdx > -1 && msClose > msIdx && rowClose > msClose, '缺 search-row 内多选钮/行闭合锚');
  assert.ok(tabsIdx > rowClose && navIdx > tabsIdx,
    `页签行应在 search-row 闭合后、nav 之前（rowClose=${rowClose}, tabs=${tabsIdx}, nav=${navIdx}）`);
  // ② 两 button 均 type="button"
  const tabsEnd = template.indexOf('</div>', tabsIdx);
  const tabsSlice = template.slice(tabsIdx, tabsEnd > -1 ? tabsEnd : undefined);
  assert.equal(countOccurrences(tabsSlice, '<button'), 2, '页签行应恰 2 个原生 button');
  assert.equal(countOccurrences(tabsSlice, 'type="button"'), 2, '两 button 均应 type="button"');
  // ③ active 三元绑定逐字（全部 / 项目）
  assert.ok(sidebar.includes("['sidebar__tab', { 'sidebar__tab--active': !groupByProject }]"), '「全部」active 三元绑定漂移');
  assert.ok(sidebar.includes("['sidebar__tab', { 'sidebar__tab--active': groupByProject }]"), '「项目」active 三元绑定漂移');
  // ④ CSS 四块在场 + ::after 含 accent token
  for (const sel of ['.sidebar__tabs {', '.sidebar__tab {', '.sidebar__tab--active {', '.sidebar__tab--active::after {']) {
    assert.ok(style.includes(sel), `缺 CSS 规则块 ${sel}`);
  }
  const afterIdx = style.indexOf('.sidebar__tab--active::after {');
  const afterBlk = style.slice(afterIdx, style.indexOf('}', afterIdx));
  assert.ok(afterBlk.includes('background: var(--color-accent)'), '::after 缺 background: var(--color-accent)');
});

console.log('\n=== B1-2 · 单模板结构钉（viewGroups 切换源；恢复双分支即红） ===');

check('B1-2a dateGroups computed 接线保留（groupSessionsByDate import + 消费 displayedSessions）+ R1 viewGroups 切换源', () => {
  assert.ok(sidebar.includes("from '../../utils/group-sessions-by-date'"), '缺 groupSessionsByDate import');
  assert.match(sidebar, /const dateGroups = computed\(\(\) => groupSessionsByDate\(store\.displayedSessions\)\);/);
});
check('B1-2b 单模板结构钉（恢复双分支即红）：模板 v-for="session in group.sessions" 恰 1 处', () => {
  assert.equal(countOccurrences(template, 'v-for="session in group.sessions"'), 1,
    `会话行 v-for 应恰 1 处，实际 ${countOccurrences(template, 'v-for="session in group.sessions"')}`);
});
check('B1-2c 单模板结构钉：无分组条件分支包裹（v-if="!groupByProject" 与 <template v-else> 零残留）', () => {
  assert.ok(!template.includes('<template v-else>'), '项目分支 <template v-else> 仍在');
  assert.ok(!template.includes('v-if="!groupByProject"'), '双视图条件包裹仍在');
});
check('B1-2d 组头由 viewGroups 驱动（v-for="group in viewGroups" 保留，单模板切换源）', () => {
  assert.ok(template.includes('<template v-for="group in viewGroups" :key="group.key">'));
});

console.log('\n=== B1-3 · 搜索态结果同走五桶（含置顶优先） ===');

check('B1-3a store.displayedSessions 搜索态返回 searchResults（搜索天然进五桶，不平铺）', () => {
  assert.ok(storeSrc.includes('displayedSessions(state): Session[] {'));
  assert.ok(storeSrc.includes('return state.searchResults ?? state.sessions;'));
});
check('B1-3b 五桶置顶组最前（key pinned + unshift；桶组成/排序由 tdd-sidebar-date-group-verify 保全）', () => {
  assert.ok(groupByDate.includes("key: 'pinned'"));
  assert.ok(groupByDate.includes('groups.unshift('));
});

console.log('\n=== B1-4 · 批量钮 32×32 图标钮与搜索框同行右置 ===');

check('B1-4a 模板：搜索行容器存在，内部顺序 = search-wrap → 多选钮（同行；行在 nav 之前闭合）', () => {
  const rowIdx = template.indexOf('class="sidebar__search-row"');
  const wrapIdx = template.indexOf('class="sidebar__search-wrap"');
  const msIdx = template.indexOf('class="sidebar__multiselect"');
  assert.ok(rowIdx !== -1, '缺 .sidebar__search-row 行容器');
  assert.ok(wrapIdx > rowIdx && msIdx > wrapIdx, '行内顺序应为 search-wrap → multiselect');
  assert.ok(msIdx < template.indexOf('class="sidebar__sessions"'), '多选钮应在搜索行内（nav 列表之前）');
});
check('B1-4b CSS：搜索行 flex 容器（display:flex/align-items:center/gap:8px/margin-top:10px）', () => {
  const block = cssBlock(style, '.sidebar__search-row {');
  assert.ok(block.includes('display: flex'), '行容器缺 display: flex');
  assert.ok(block.includes('align-items: center'), '行容器缺 align-items: center');
  assert.ok(block.includes('gap: 8px'), '行容器缺 gap: 8px');
  assert.ok(block.includes('margin-top: 10px'), '行容器缺 margin-top: 10px（原 search-wrap 顶距上移）');
});
check('B1-4c CSS：搜索框 flex 占满（flex:1 + min-width:0；旧 margin-top 已上移）', () => {
  const block = cssBlock(style, '.sidebar__search-wrap {');
  assert.ok(block.includes('flex: 1'), '搜索框未 flex:1 占满');
  assert.ok(block.includes('min-width: 0'), '搜索框缺 min-width:0（防溢出）');
  assert.ok(!block.includes('margin-top'), 'search-wrap 仍带 margin-top（应上移到行容器）');
});
check('B1-4d CSS：多选钮恰 32×32（旧页签行锚定 margin-left:auto/margin-bottom:3px 删除）', () => {
  const block = cssBlock(style, '.sidebar__multiselect {');
  assert.ok(block.includes('width: 32px;'), `多选钮宽度应 32px，块内：${block.replace(/\s+/g, ' ')}`);
  assert.ok(block.includes('height: 32px;'), '多选钮高度应 32px');
  assert.ok(!block.includes('margin-left'), '仍带 margin-left:auto（页签行锚定残留）');
  assert.ok(!block.includes('margin-bottom'), '仍带 margin-bottom:3px（页签行锚定残留）');
});
check('B1-4e 图标换装 list-checks（D1-05）：新五 path 在场，旧垃圾桶线稿弃用', () => {
  assert.ok(sidebar.includes('d="m3 17 2 2 4-4"'), '缺 list-checks path ①');
  assert.ok(sidebar.includes('d="m3 7 2 2 4-4"'), '缺 list-checks path ②');
  assert.ok(sidebar.includes('d="M13 6h8"') && sidebar.includes('d="M13 12h8"') && sidebar.includes('d="M13 18h8"'), '缺 list-checks 三横线 path');
  assert.ok(!sidebar.includes('M3 6h18'), '旧垃圾桶线稿仍在（应弃用）');
});

console.log('\n=== B1-5 · armed 态红底与 title/aria 动态切换 ===');

check('B1-5a 动态 title/aria 三元逐字（批量删除 / 退出批量删除）', () => {
  assert.ok(sidebar.includes(":title=\"batchMode ? '退出批量删除' : '批量删除'\""));
  assert.ok(sidebar.includes(":aria-label=\"batchMode ? '退出批量删除' : '批量删除'\""));
});
check('B1-5b armed 类绑定与红底 token（--active 绑定 batchMode；danger 底 + on-danger 白字）', () => {
  assert.ok(sidebar.includes("{ 'sidebar__multiselect--active': batchMode }"), '缺 --active 类绑定');
  const block = cssBlock(style, '.sidebar__multiselect--active {');
  assert.ok(block.includes('background: var(--color-danger);'), 'armed 底色应为 var(--color-danger)');
  assert.ok(block.includes('color: var(--color-on-danger);'), 'armed 白字应为 var(--color-on-danger)');
});
check('B1-5c 迁位核对：动态 title 所在钮在搜索行切片内（旧页签行位置残留即红）', () => {
  const rowIdx = template.indexOf('class="sidebar__search-row"');
  const titleIdx = template.indexOf(":title=\"batchMode ? '退出批量删除' : '批量删除'\"");
  const navIdx = template.indexOf('class="sidebar__sessions"');
  assert.ok(rowIdx !== -1 && titleIdx > rowIdx && titleIdx < navIdx, '多选钮 title 不在搜索行切片内');
});

console.log('\n=== B1-6 · 批量态下分组与批量条保持 ===');

check('B1-6a 批量条三件套字面保留（全选 label / 删除所选钮 / 0 选中 disabled）', () => {
  assert.ok(template.includes('class="sidebar__batchbar"'), '缺批量条');
  assert.ok(sidebar.includes('function toggleSelectAll()'));
  assert.ok(sidebar.includes('async function confirmBatchDelete()'));
  assert.ok(sidebar.includes(':disabled="!selectedIds.size"'));
});
check('B1-6b 删除 (N) 半角括号计数形态逐字保留（N=0 时无计数后缀）', () => {
  assert.ok(sidebar.includes('删除{{ selectedIds.size ? ` (${selectedIds.size})` : \'\' }}'));
});
check('B1-6c viewGroups 循环与 batchMode 解耦（循环 template 标签不带任何 batch 条件）', () => {
  const loopIdx = template.indexOf('<template v-for="group in viewGroups"');
  assert.ok(loopIdx !== -1, '缺 viewGroups 循环');
  const loopTag = template.slice(loopIdx, template.indexOf('>', loopIdx) + 1);
  assert.ok(!loopTag.includes('batchMode'), 'viewGroups 循环被 batchMode 条件包裹（批量态分组打散）');
});

console.log('\n=== B1-7 · 空列表态分组头不渲染且批量钮可用 ===');

check('B1-7a 空态分支保留（v-if="!store.displayedSessions.length" + 二分文案）', () => {
  assert.ok(template.includes('v-if="!store.displayedSessions.length"'));
  assert.match(sidebar, /store\.searchQuery \? '未找到匹配的会话' : '暂无会话'/);
});
check('B1-7b 五桶空入空出（空桶 filter 跳过，不渲染幽灵组头）', () => {
  assert.ok(groupByDate.includes('.filter((key) => buckets[key].length > 0)'));
});
check('B1-7c 批量钮与列表内容解耦（多选钮元素切片内无 v-if、无列表长度判定）', () => {
  const msIdx = sidebar.indexOf('class="sidebar__multiselect"');
  const btnBlock = sidebar.slice(msIdx, sidebar.indexOf('</button>', msIdx));
  assert.ok(!btnBlock.includes('v-if'), '多选钮带 v-if（空态可能被隐藏）');
  assert.ok(!btnBlock.includes('displayedSessions'), '多选钮受列表长度判定（空态失效面）');
});

console.log('\n=== B1-8 · 搜索无结果态 ===');

check('B1-8 空态块内二分文案齐备（未找到匹配的会话 / 暂无会话），无组外散行', () => {
  const emptyIdx = template.indexOf('v-if="!store.displayedSessions.length"');
  const emptyBlock = template.slice(emptyIdx, emptyIdx + 300);
  assert.ok(emptyBlock.includes('未找到匹配的会话') && emptyBlock.includes('暂无会话'), '二分文案未同挂 empty 块');
});

console.log('\n=== B1-9 · 项目分组相关代码恰在两文件（R1 恢复正向钉） ===');

check('B1-9 src/ 全树正向钉：groupSessionsByProject/viewGroups/\\bSessionGroup\\b/groupByProject 四标识符恰出现在 AppSidebar.vue + utils/group-sessions.ts 两文件（ConfigPage.vue 仍零命中）', () => {
  const exts = ['.ts', '.tsx', '.mts', '.vue'];
  const patterns: Array<[string, RegExp]> = [
    ['groupSessionsByProject 调用形态', /\bgroupSessionsByProject\s*\(/],
    ['viewGroups 标识符', /\bviewGroups\b/],
    ['SessionGroup 接口标识符', /\bSessionGroup\b/],
    ['groupByProject 标识符', /\bgroupByProject\b/],
  ];
  function walk(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) out.push(...walk(full));
      else if (exts.some((e) => name.endsWith(e))) out.push(full);
    }
    return out;
  }
  const hitFiles = new Set<string>();
  for (const file of walk(join(repoRoot, 'src'))) {
    const content = readFileSync(file, 'utf8');
    for (const [, re] of patterns) {
      if (re.test(content)) { hitFiles.add(file); break; }
    }
  }
  const rel = (f: string): string => f.slice(repoRoot.length).replace(/^[\\/]/, '').replace(/\\/g, '/');
  const hits = [...hitFiles].map(rel).sort();
  assert.deepEqual(hits, [
    'src/renderer/components/layout/AppSidebar.vue',
    'src/renderer/utils/group-sessions.ts',
  ], `四标识符应恰出现在 AppSidebar.vue + group-sessions.ts 两文件，实际命中：\n  ${hits.join('\n  ')}`);
  const cfg = read('src/renderer/pages/ConfigPage.vue');
  for (const [label, re] of patterns) {
    assert.ok(!re.test(cfg), `ConfigPage.vue 命中 ${label}（R1 接线不应外溢到配置页）`);
  }
});
check('B1-9b R1 恢复钉：group-sessions.ts 含 projectLabel + export interface SessionGroup + export function groupSessionsByProject 三者齐备', () => {
  const src = read('src/renderer/utils/group-sessions.ts');
  assert.ok(src.includes('export function projectLabel'), 'projectLabel 应保留（B2/B3 消费）');
  assert.ok(src.includes('export interface SessionGroup'), '缺 export interface SessionGroup');
  assert.ok(src.includes('export function groupSessionsByProject'), '缺 export function groupSessionsByProject');
});
check('B1-9c R1 恢复钉：tdd-group-sessions-verify.ts import 行含 groupSessionsByProject 且文件含 groupSessionsByProject( 调用', () => {
  const src = read('scripts/tdd-group-sessions-verify.ts');
  assert.ok(/import\s*\{[^}]*groupSessionsByProject[^}]*\}\s*from\s*'\.\.\/src\/renderer\/utils\/group-sessions';/.test(src),
    '恢复卷 import 行缺 groupSessionsByProject');
  assert.ok(src.includes('groupSessionsByProject('), '恢复卷未调用 groupSessionsByProject(');
});

console.log('\n=== B1-10 · ConfigPage 零涉（无分组设置项混入） ===');

check('B1-10 ConfigPage 模板无「分组」设置文案、全文件无 groupBy 绑定', () => {
  assert.ok(!cfgTpl.includes('分组'), 'ConfigPage 模板出现「分组」文案');
  assert.ok(!/\bgroupBy/.test(configPage), 'ConfigPage 出现 groupBy 绑定');
});

// ───────────────────────── B2 小节 · 会话卡双行卡化（类名家族一字不改） ─────────────────────────

// r1/r2 行容器切片：r1 = 「class="session-link__r1"」起至 r2 起；r2 = r2 起至空态块起
// （卡片容器内子元素标识符在模板中各恰 1 处，切片到空态块即可覆盖整卡，B2-1a 先钉两容器在场）。
const r1Idx = template.indexOf('class="session-link__r1"');
const r2Idx = template.indexOf('class="session-link__r2"');
const emptyIdx = template.indexOf('class="sidebar__empty"');
const r1 = r1Idx > -1 && r2Idx > r1Idx ? template.slice(r1Idx, r2Idx) : '';
const r2 = r2Idx > -1 && emptyIdx > r2Idx ? template.slice(r2Idx, emptyIdx) : '';

console.log('\n=== B2-1 · 双行卡 r1/r2 结构与次序钉 ===');

check('B2-1a 双行行容器在场：r1/r2 各恰 1 处、r1 先于 r2、均在卡片容器（role 绑定）之内', () => {
  assert.equal(countOccurrences(template, 'class="session-link__r1"'), 1,
    `r1 行容器应恰 1 处，实际 ${countOccurrences(template, 'class="session-link__r1"')}`);
  assert.equal(countOccurrences(template, 'class="session-link__r2"'), 1,
    `r2 行容器应恰 1 处，实际 ${countOccurrences(template, 'class="session-link__r2"')}`);
  const cardIdx = template.indexOf(":role=\"batchMode ? 'checkbox' : 'button'\"");
  assert.ok(cardIdx > -1, '卡片容器缺 role 绑定锚');
  assert.ok(r1Idx > cardIdx && r2Idx > r1Idx, 'r1/r2 应在卡片容器内且 r1 先于 r2');
});
check('B2-1b r1 内次序钉：状态灯 → 置顶钮 → 标题（R2 迁位；负向：r1 无静态 __pinned 标识 / 无时间列=假双行）', () => {
  const st = r1.indexOf('class="session-link__status"');
  const pin = r1.indexOf('class="session-link__pinbtn"');
  const name = r1.indexOf('class="session-link__name"');
  assert.ok(st > -1 && pin > st && name > pin,
    `r1 次序应为 状态灯→置顶钮→名称（status=${st}, pinbtn=${pin}, name=${name}）`);
  assert.ok(!r1.includes('session-link__pinned'), 'r1 仍含静态 __pinned 标识（同位双 pin）');
  assert.ok(!r1.includes('session-link__time'), '时间列仍在 r1（假双行）');
});
check('B2-1c r2 内次序钉：chip → ⏳ → 更新时间 → 删除（R2 迁位后 r2 仅剩删除钮），标题不得掉进 r2', () => {
  const chip = r2.indexOf('class="session-link__chip"');
  const pending = r2.indexOf('session-link__pending');
  const time = r2.indexOf('session-link__time');
  const del = r2.indexOf('session-link__delete');
  assert.ok(chip > -1 && pending > chip && time > pending && del > time,
    `r2 次序应为 chip→⏳→时间→删除（${chip},${pending},${time},${del}）`);
  assert.ok(!r2.includes('session-link__pinbtn'), 'r2 仍含置顶钮（应迁 r1）');
  assert.ok(!r2.includes('session-link__name'), '标题掉进 r2');
});

console.log('\n=== B2-2 · 状态灯四态语义与 aria 逐字迁移保全 ===');

const displayStatusSrc = read('src/shared/session-display-status.ts');
check('B2-2a 新卡 r1 接线保全：idle 无灯 v-if + 状态灯 class/动态修饰/role=img/aria-label=statusLabel/title', () => {
  assert.ok(r1.includes("v-if=\"displayStatus(session.id) !== 'idle'\""), 'idle 无灯守卫丢失');
  assert.ok(r1.includes('class="session-link__status"'), '状态灯静态 class 丢失');
  assert.ok(r1.includes('session-link__status--${displayStatus(session.id)}'), '四态动态修饰类绑定丢失');
  assert.ok(r1.includes('role="img"'), 'role=img 丢失');
  assert.ok(r1.includes(':aria-label="statusLabel(session.id)"'), 'aria-label 接线丢失');
  assert.ok(r1.includes(':title="statusLabel(session.id)"'), 'title 提示丢失');
});
check('B2-2b 容器四态修饰类绑定保全（running/retrying/completed/network-interrupted）', () => {
  assert.ok(template.includes("'session-link--running'"), '缺 --running');
  assert.ok(template.includes("'session-link--retrying'"), '缺 --retrying');
  assert.ok(template.includes("'session-link--completed'"), '缺 --completed');
  assert.ok(template.includes("'session-link--network-interrupted'"), '缺 --network-interrupted');
});
check('B2-2c 文案权威逐字（session-display-status.ts 四 label：执行中/网络异常，正在重试/任务已完成/网络异常，已中断）', () => {
  assert.ok(displayStatusSrc.includes("'执行中'"), '缺「执行中」');
  assert.ok(displayStatusSrc.includes("'网络异常，正在重试'"), '缺「网络异常，正在重试」');
  assert.ok(displayStatusSrc.includes("'任务已完成'"), '缺「任务已完成」');
  assert.ok(displayStatusSrc.includes("'网络异常，已中断'"), '缺「网络异常，已中断」');
});

console.log('\n=== B2-3 · ⏳ 字面量契约钉（r2 位置） ===');

check('B2-3 ⏳ 恰 1 处且在 r2 内 + pendingRemoteCountBySession 判定 + title 契约文案', () => {
  assert.equal(countOccurrences(template, '⏳'), 1,
    `⏳ 应恰 1 处，实际 ${countOccurrences(template, '⏳')}`);
  assert.ok(r2.includes('⏳'), '⏳ 不在 r2 内');
  assert.ok(r2.includes('pendingRemoteCountBySession[session.id]'), '判定键丢失');
  assert.ok(r2.includes('title="该会话有待确认的弹窗"'), 'title 契约文案丢失');
});

console.log('\n=== B2-4 · hover 交换：时间隐藏、操作钮显现（CDP 用例的结构钉转写） ===');

check('B2-4a hover 时时间列 display:none', () => {
  const idx = style.indexOf('.session-link:hover .session-link__time');
  assert.ok(idx > -1, '缺 hover 隐藏时间规则');
  assert.ok(style.slice(idx, style.indexOf('}', idx)).includes('display: none'), '时间列未在 hover 隐藏');
});
check('B2-4b hover 时置顶钮显现（width 18px / opacity 1 / pointer-events auto 三件套；未置顶 hover 显现；已置顶恒显走 --pinned）', () => {
  const idx = style.indexOf('.session-link:hover .session-link__pinbtn');
  assert.ok(idx > -1, '缺 hover 显现 pinbtn 规则');
  const blk = style.slice(idx, style.indexOf('}', idx));
  assert.ok(blk.includes('width: 18px') && blk.includes('opacity: 1') && blk.includes('pointer-events: auto'),
    'pinbtn hover 显现三件套不全');
});
check('B2-4c hover 时删除钮显现（display grid）', () => {
  const idx = style.indexOf('.session-link:hover .session-link__delete');
  assert.ok(idx > -1, '缺 hover 显现 delete 规则');
  assert.ok(style.slice(idx, style.indexOf('}', idx)).includes('display: grid'), '删除钮未在 hover 显现');
});

console.log('\n=== B2-5 · :focus-within 同等交换（键盘路径，裁决 B-C3） ===');

check('B2-5a :focus-within 分支与 hover 并存于置顶钮显现规则组', () => {
  assert.ok(style.includes('.session-link:focus-within .session-link__pinbtn'), '缺 :focus-within pinbtn 分支');
});
check('B2-5b :focus-within 分支覆盖删除钮显现与时间隐藏（与 hover 同规则组）', () => {
  assert.ok(style.includes('.session-link:focus-within .session-link__delete'), '缺 :focus-within delete 分支');
  const idx = style.indexOf('.session-link:hover .session-link__time');
  assert.ok(idx > -1, '缺 hover 隐藏时间规则');
  assert.ok(style.slice(idx, style.indexOf('}', idx)).includes('.session-link:focus-within .session-link__time'),
    '时间隐藏规则组未并入 :focus-within 分支');
});

console.log('\n=== B2-6 · 批量态：时间恢复、操作钮不渲染、checkbox 在场 ===');

check('B2-6a 操作钮 v-if 守卫（批量态不渲染置顶/删除钮，各恰 1 处）', () => {
  assert.equal(countOccurrences(template, 'v-if="!batchMode && !session.transient"'), 1, '置顶钮守卫形态漂移');
  assert.equal(countOccurrences(template, 'v-if="!batchMode"'), 1, '删除钮守卫形态漂移');
});
check('B2-6b checkbox 位于 r1 且 checked 接线保留', () => {
  assert.ok(r1.includes('class="session-link__check"'), 'checkbox 不在 r1 内');
  assert.ok(r1.includes(':checked="selectedIds.has(session.id)"'), 'checked 绑定丢失');
});
check('B2-6c 批量豁免：hover/:focus-within 隐藏时间后恢复显示（batching 规则组含 focus-within 分支）', () => {
  const idx = style.indexOf('.sidebar__sessions.batching .session-link:hover .session-link__time');
  assert.ok(idx > -1, '缺批量时间恢复规则');
  const seg = style.slice(idx, style.indexOf('}', idx));
  assert.ok(seg.includes('.sidebar__sessions.batching .session-link:focus-within .session-link__time'),
    '批量豁免缺 :focus-within 分支');
  assert.ok(seg.includes('display: inline'), '恢复规则应为 display: inline');
});

console.log('\n=== B2-7 · 激活卡描边强调 + hover 描边加深（B-C6 圆角 --radius-sm(8)） ===');

check('B2-7a 卡片块描边卡形态（flex column + border + radius-sm(8)），active 块描边 accent、无左缘条', () => {
  const cardIdx = style.indexOf('.session-link {\n  display: flex;\n  flex-direction: column;');
  assert.ok(cardIdx > -1, '缺卡片块（flex column 形态）');
  const cardBlk = style.slice(cardIdx, style.indexOf('}', cardIdx));
  assert.ok(cardBlk.includes('border: 1px solid var(--color-border)'), '卡片块缺描边');
  assert.ok(cardBlk.includes('border-radius: var(--radius-sm)'), '卡片圆角未走 --radius-sm');
  const activeIdx = style.indexOf('.session-link.active {');
  assert.ok(activeIdx > -1, '缺 .session-link.active 规则块');
  const activeBlk = style.slice(activeIdx, style.indexOf('}', activeIdx));
  assert.ok(activeBlk.includes('border-color: var(--color-accent)'), 'active 块缺描边 border-color accent');
  assert.ok(!activeBlk.includes('border-left'), 'active 块带左缘条（旧语言）');
});
check('B2-7b hover 描边加深（accent-strong）', () => {
  const idx = style.indexOf('.session-link.active:hover {');
  assert.ok(idx > -1, '缺 .session-link.active:hover 规则块');
  assert.ok(style.slice(idx, style.indexOf('}', idx)).includes('border-color: var(--color-accent-strong)'),
    'hover 描边加深缺失');
});
check('B2-7c 负向：旧 accent 8% 混色已移除（描边形态取代，R2.9 同步依据）', () => {
  assert.ok(!style.includes('color-mix(in srgb, var(--color-accent) 8%'), '旧 8% 混色仍在 style 段');
});

console.log('\n=== B2-8 · 普通态键盘形态：role=button + tabindex=0 + aria-label=会话名 ===');

check('B2-8 容器三件套绑定（role 三元 / tabindex 0 / aria-label 普通态=会话名）', () => {
  assert.ok(template.includes(":role=\"batchMode ? 'checkbox' : 'button'\""), 'role 三元绑定缺失');
  assert.ok(template.includes(':tabindex="0"'), 'tabindex=0 缺失');
  assert.ok(template.includes(":aria-label=\"batchMode ? '选择 ' + session.name : session.name\""),
    'aria-label 绑定缺失或取源错误');
});

console.log('\n=== B2-9 · 批量态键盘形态：role=checkbox + aria-checked 随选 ===');

check('B2-9 aria-checked 随选联动绑定 + checkbox 点击切换接线', () => {
  assert.ok(template.includes(":aria-checked=\"batchMode ? selectedIds.has(session.id) : undefined\""),
    'aria-checked 绑定缺失');
  assert.ok(r1.includes('@click.stop="toggleSelected(session.id)"'), 'checkbox 点击切换丢失');
});

console.log('\n=== B2-10 · 容器级 Enter/Space 委托激活 ===');

check('B2-10a nav 挂 @keydown 委托（batching 类绑定保留）', () => {
  assert.ok(
    template.includes('<nav class="sidebar__sessions" :class="{ batching: batchMode }" @keydown="onListKeydown">'),
    'nav 缺 keydown 委托绑定或形态漂移',
  );
});
check('B2-10b onListKeydown 委托体：Enter/Space → closest(.session-link) → preventDefault + row.click()', () => {
  const fnIdx = sidebar.indexOf('function onListKeydown');
  assert.ok(fnIdx > -1, '缺 onListKeydown');
  const body = sidebar.slice(fnIdx, fnIdx + 600);
  assert.ok(body.includes("'Enter'") && body.includes("' '"), '键位过滤缺失');
  assert.ok(body.includes(".closest('.session-link')"), '未锚定卡片容器');
  assert.ok(body.includes('e.preventDefault()') && body.includes('row.click()'), '缺转发 click');
});

console.log('\n=== B2-11 · 原生控件防双触发 ===');

check('B2-11 五类原生可交互元素 instanceof 早退，且先于 closest（排除→锚定次序）', () => {
  const fnIdx = sidebar.indexOf('function onListKeydown');
  const body = sidebar.slice(fnIdx, fnIdx + 600);
  assert.ok(body.includes('t instanceof HTMLInputElement'), '缺 HTMLInputElement 排除');
  for (const ctor of ['HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement']) {
    assert.ok(body.includes(`t instanceof ${ctor}`), `缺 ${ctor} 排除`);
  }
  const nativeIdx = body.indexOf('t instanceof HTMLInputElement');
  const closestIdx = body.indexOf(".closest('.session-link')");
  assert.ok(closestIdx > nativeIdx, '排除应先于 closest（防双触发次序）');
  assert.ok(body.includes('return;'), '排除分支应早退');
});

console.log('\n=== B2-12 · 入场 stagger 前 8 项阶梯（阈值 8） ===');

check('B2-12 nth-child(2..8) 阶梯 35..245ms 逐项在场、无第 9 档、入场 keyframes 保留', () => {
  for (let i = 2; i <= 8; i += 1) {
    const delay = String((i - 1) * 35);
    assert.ok(style.includes(`.session-link:nth-child(${i}) { animation-delay: ${delay}ms; }`),
      `缺第 ${i} 项阶梯（应 ${delay}ms）`);
  }
  assert.ok(!style.includes('.session-link:nth-child(9)'), '出现第 9 档（阈值 8 破坏）');
  assert.ok(style.includes('@keyframes session-enter'), '缺入场 keyframes');
});

console.log('\n=== B2-13 · reduced-motion 降级保留（顺序钉：位于 pulse 声明与两 keyframes 之后） ===');

check('B2-13 media 块顺序正确且块内显式关闭入场动画与状态灯动画', () => {
  const mediaIdx = style.indexOf('@media (prefers-reduced-motion: reduce)');
  const pulseIdx = style.indexOf('animation: session-status-pulse 1.2s ease-in-out infinite');
  const pulseKfIdx = style.indexOf('@keyframes session-status-pulse');
  const enterKfIdx = style.indexOf('@keyframes session-enter');
  assert.ok(mediaIdx > -1 && pulseIdx > -1 && pulseKfIdx > -1 && enterKfIdx > -1, '四锚点缺失');
  assert.ok(mediaIdx > pulseIdx, 'media 块应在 pulse 基础声明之后（同特异性后者胜，前置则降级失效）');
  assert.ok(mediaIdx > pulseKfIdx && mediaIdx > enterKfIdx, 'media 块应在两 keyframes 之后');
  // media 块切片（括号配对计数，media 块含两条内层规则）。
  const open = style.indexOf('{', mediaIdx);
  let depth = 0;
  let end = -1;
  for (let i = open; i > -1 && i < style.length; i += 1) {
    const ch = style[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  const mediaBlk = style.slice(mediaIdx, end > -1 ? end : undefined);
  assert.ok(mediaBlk.includes('.session-link {'), '块内未覆盖入场动画（stagger）');
  assert.ok(mediaBlk.includes('.session-link__status {'), '块内未覆盖状态灯动画');
  assert.equal((mediaBlk.match(/animation: none/g) || []).length, 2, '块内应恰两处 animation: none');
});

console.log('\n=== B2-14 · 超长会话名 ellipsis ===');

check('B2-14 __name 三件套 + min-width:0（r1 内防溢出）', () => {
  const idx = style.indexOf('.session-link__name {');
  assert.ok(idx > -1, '缺 __name 规则块');
  const blk = style.slice(idx, style.indexOf('}', idx));
  assert.ok(blk.includes('white-space: nowrap') && blk.includes('overflow: hidden') && blk.includes('text-overflow: ellipsis'),
    'ellipsis 三件套不全');
  assert.ok(blk.includes('min-width: 0'), '缺 min-width:0');
});

console.log('\n=== B2-15 · 暂态会话无置顶钮（守卫迁移） ===');

check('B2-15 置顶钮守卫含 !session.transient（暂态不出现置顶钮）+ R2 --pinned 双态类绑定在 r1 + 全文件静态 __pinned 零残留', () => {
  assert.ok(template.includes('v-if="!batchMode && !session.transient"'), '暂态守卫丢失');
  assert.ok(r1.includes("'session-link__pinbtn--pinned': session.pinnedAt != null"),
    'R2 --pinned 双态类绑定丢失（已置顶恒显前提）');
  assert.equal(countOccurrences(sidebar, 'session-link__pinned'), 0,
    '静态 __pinned 标识仍有残留（同位双 pin）');
});

console.log('\n=== B2-19 · R2 置顶钮双态钉（新增） ===');

check('B2-19 R2 双态钉：--pinned 恒显块四声明齐备（width/opacity/pointer-events/accent）+ 声明序在 pinbtn 基础块之后（同特异性后者胜）', () => {
  const sel = '.session-link__pinbtn--pinned {';
  const idx = style.indexOf(sel);
  const baseIdx = style.indexOf('.session-link__pinbtn {');
  assert.ok(idx > -1, '缺 --pinned 恒显块');
  assert.ok(baseIdx > -1 && idx > baseIdx, '--pinned 块未声明在 pinbtn 基础块之后（恒显胜出前提）');
  const blk = style.slice(idx, style.indexOf('}', idx));
  for (const decl of ['width: 18px', 'opacity: 1', 'pointer-events: auto', 'color: var(--color-accent)']) {
    assert.ok(blk.includes(decl), `--pinned 块缺 ${decl}`);
  }
});

console.log('\n=== B2-16 · 项目 chip 渲染（r2） ===');

check('B2-16a script 接线：chipLabel 存在且消费 projectLabel（workingDir 末段目录名）', () => {
  // R1 恢复：import 行由「仅 projectLabel」扩为 projectLabel + groupSessionsByProject + type SessionGroup
  // （§1.3-1 裁决）；原逐字整行钉改为等价正则钉——仍要求 projectLabel 自 group-sessions 导入，
  // 钉不删、语义不变（chipLabel 消费 projectLabel 的接线断言体原样保留）。
  assert.ok(/import\s*\{[^}]*\bprojectLabel\b[^}]*\}\s*from\s*'\.\.\/\.\.\/utils\/group-sessions';/.test(sidebar), '缺 projectLabel import');
  const fnIdx = sidebar.indexOf('function chipLabel(');
  assert.ok(fnIdx > -1, '缺 chipLabel');
  const body = sidebar.slice(fnIdx, fnIdx + 400);
  assert.ok(body.includes('projectLabel(session.workingDir)'), 'chipLabel 未消费 projectLabel(workingDir)');
});
check('B2-16b 模板 chip 元素接线（v-if / 文本 / title 同源 chipLabel；title 经 ?? undefined 归一供 vue-tsc 严格档）', () => {
  assert.ok(
    template.includes('<span v-if="chipLabel(session)" class="session-link__chip" :title="chipLabel(session) ?? undefined">{{ chipLabel(session) }}</span>'),
    'chip 元素接线形态不符',
  );
});
check('B2-16c 行为组：projectLabel 纯函数（正/反斜杠末段 + 空值回退）', () => {
  assert.equal(projectLabel('D:\\work\\proj'), 'proj');
  assert.equal(projectLabel('/home/u/claude-link'), 'claude-link');
  assert.equal(projectLabel(''), '');
});

console.log('\n=== B2-17 · chip 互斥与无则不渲染（IM 判定键=bridgePlatform 裁决） ===');

check('B2-17a 互斥结构：chip 元素模板恰 1 处（互斥由 chipLabel 单函数 if/return 承载，无双 chip 同现）', () => {
  assert.equal(countOccurrences(template, 'session-link__chip'), 1,
    `chip 元素应恰 1 处，实际 ${countOccurrences(template, 'session-link__chip')}`);
});
check('B2-17b IM 判定键=bridgePlatform：wechat→「微信 · 只读」、其余→「飞书 · 只读」，且优先于项目 chip', () => {
  const fnIdx = sidebar.indexOf('function chipLabel(');
  const body = sidebar.slice(fnIdx, fnIdx + 400);
  assert.ok(body.includes('session.bridgePlatform'), 'IM 判定键不是 bridgePlatform');
  const imIdx = body.indexOf('bridgePlatform');
  const projIdx = body.indexOf('projectLabel(session.workingDir)');
  assert.ok(imIdx > -1 && projIdx > imIdx, 'IM chip 应优先于项目 chip');
  assert.ok(body.includes("'微信 · 只读'") && body.includes("'飞书 · 只读'"), 'IM 只读文案漂移');
});
check('B2-17c 无则不渲染：两源皆空 chipLabel 返回 null（v-if 不渲染空壳）', () => {
  const fnIdx = sidebar.indexOf('function chipLabel(');
  const body = sidebar.slice(fnIdx, fnIdx + 400);
  assert.match(body, /return session\.workingDir \? projectLabel\(session\.workingDir\) : null;/, '空值分支应返回 null');
});

console.log('\n=== B2-18 · 搜索∩批量∩激活三态叠加（结构钉） ===');

check('B2-18a 激活+批量叠加：--selected 规则位于 .active 规则之后（描边叠加可辨）且 inset ring 保留', () => {
  const activeIdx = style.indexOf('.session-link.active {');
  const selIdx = style.indexOf('.session-link--selected {');
  assert.ok(activeIdx > -1 && selIdx > activeIdx, '--selected 应在 .active 规则之后');
  const selBlk = style.slice(selIdx, style.indexOf('}', selIdx));
  assert.ok(selBlk.includes('box-shadow: inset 0 0 0 1px var(--color-accent)'), '选中 inset 描边丢失');
});
check('B2-18b 搜索五桶与批量条前置钉在场（叠加态的结构前提：viewGroups 单模板切换源 + batchbar）', () => {
  assert.ok(template.includes('<template v-for="group in viewGroups" :key="group.key">'), '五桶循环丢失');
  assert.ok(template.includes('class="sidebar__batchbar"'), '批量条丢失');
});

// ───────────────────────── B3 小节 · 会话管理入口（AppHeader toggle）+ SessionsPage 补齐 ─────────────────────────

const appHeader = read('src/renderer/components/layout/AppHeader.vue');
const sessionsPage = read('src/renderer/pages/SessionsPage.vue');
const headerTpl = appHeader.slice(appHeader.indexOf('<template>'), appHeader.lastIndexOf('</template>'));
const headerStyle = appHeader.slice(appHeader.indexOf('<style'));
const pageTpl = sessionsPage.slice(sessionsPage.indexOf('<template>'), sessionsPage.lastIndexOf('</template>'));
const pageStyle = sessionsPage.slice(sessionsPage.indexOf('<style'));

// 卡片 r1/r2 切片：r1 = 「class="session-card__r1"」起至 r2 起；r2 = r2 起至空态块起
// （卡片内子元素标识符在模板中各恰 1 处，切片到空态块即可覆盖整卡）。
const cardR1Idx = pageTpl.indexOf('class="session-card__r1"');
const cardR2Idx = pageTpl.indexOf('class="session-card__r2"');
const pageEmptyIdx = pageTpl.indexOf('v-if="!store.displayedSessions.length"');
const cardR1 = cardR1Idx > -1 && cardR2Idx > cardR1Idx ? pageTpl.slice(cardR1Idx, cardR2Idx) : '';
const cardR2 = cardR2Idx > -1 && pageEmptyIdx > cardR2Idx ? pageTpl.slice(cardR2Idx, pageEmptyIdx) : '';

console.log('\n=== B3-1 · 「会话管理」入口钮存在与 toggle 语义（AppHeader，裁决 B-C4 双路由渲染） ===');

check('B3-1a 钮四件套：双路由 v-if / class=app-header__manage / title=aria=「会话管理」 / @click=toggleSessionsPage', () => {
  assert.ok(headerTpl.includes("v-if=\"isChat || route.name === 'sessions'\""), '缺双路由渲染条件（chat 与 sessions 两路由都要有钮）');
  assert.ok(headerTpl.includes('class="app-header__manage"'), '缺 .app-header__manage');
  assert.ok(headerTpl.includes('title="会话管理"'), '缺 title=「会话管理」');
  assert.ok(headerTpl.includes('aria-label="会话管理"'), '缺 aria-label=「会话管理」');
  assert.ok(headerTpl.includes('@click="toggleSessionsPage"'), '缺 @click=toggleSessionsPage 接线');
});
check('B3-1b toggle 双向语义：sessions 路由点击回 /、chat 路由点击跳 /sessions', () => {
  assert.ok(appHeader.includes('const router = useRouter();'), '缺 useRouter 接线');
  assert.ok(appHeader.includes("router.push(route.name === 'sessions' ? '/' : '/sessions');"),
    'toggle 分支语义漂移（应为 sessions→/，其余→/sessions）');
});
check('B3-1c 位置钉：manage 在右端组（.app-header__right）内、分享钮之前', () => {
  const rightIdx = headerTpl.indexOf('class="app-header__right"');
  const manageIdx = headerTpl.indexOf('class="app-header__manage"');
  const shareIdx = headerTpl.indexOf('class="app-header__share"');
  assert.ok(rightIdx > -1, '缺右端组容器 .app-header__right');
  assert.ok(manageIdx > rightIdx, 'manage 不在右端组内');
  assert.ok(shareIdx > manageIdx, 'manage 应在分享钮之前（右端组首钮）');
});
check('B3-1d manage 图标四 path 在场（规范逐字）且 svg aria-hidden', () => {
  const mIdx = headerTpl.indexOf('class="app-header__manage"');
  const sIdx = headerTpl.indexOf('class="app-header__share"');
  const manageBlk = headerTpl.slice(mIdx, sIdx > mIdx ? sIdx : undefined);
  for (const p of ['d="m16 6 4 14"', 'd="M12 6v14"', 'd="M8 8v12"', 'd="M4 4v16"']) {
    assert.ok(manageBlk.includes(p), `manage 图标缺 path ${p}`);
  }
  assert.ok(manageBlk.includes('aria-hidden="true"'), 'svg 缺 aria-hidden');
});
check('B3-1e CSS 基座对齐 share（34×34 / border / panel-soft / hover accent 提亮）且不含导出专属 busy/done/pulse', () => {
  const blk = cssBlock(headerStyle, '.app-header__manage {');
  assert.ok(blk.includes('width: 34px') && blk.includes('height: 34px'), 'manage 钮应 34×34');
  assert.ok(blk.includes('border: 1px solid var(--color-border)'), 'manage 缺描边基座');
  assert.ok(blk.includes('background: var(--color-panel-soft)'), 'manage 缺 panel-soft 底');
  const hoverIdx = headerStyle.indexOf('.app-header__manage:hover');
  assert.ok(hoverIdx > -1, 'manage 缺 :hover 规则');
  const hoverBlk = headerStyle.slice(hoverIdx, headerStyle.indexOf('}', hoverIdx));
  assert.ok(hoverBlk.includes('color: var(--color-accent-strong)'), 'hover 缺 accent-strong 提亮');
  assert.ok(!headerStyle.includes('.app-header__manage--busy'), 'manage 带 busy 修饰（导出语义专属，不得复制）');
  assert.ok(!headerStyle.includes('.app-header__manage--done'), 'manage 带 done 修饰（导出语义专属，不得复制）');
  assert.ok(!/\.app-header__manage[^{]*\{[^}]*animation/.test(headerStyle), 'manage 带 animation（pulse 为导出专属）');
});
check('B3-1f 右端组 CSS：flex 行 / 居中 / gap 8px（B4 左右组重排同形态承接，不返工）', () => {
  const blk = cssBlock(headerStyle, '.app-header__right {');
  assert.ok(blk.includes('display: flex'), '右端组缺 display:flex');
  assert.ok(blk.includes('align-items: center'), '右端组缺 align-items:center');
  assert.ok(blk.includes('gap: 8px'), '右端组 gap 应 8px');
});

console.log('\n=== B3-2 · SessionsPage 状态灯四态语义与 aria 与侧栏同源（session-display-status 唯一事实源） ===');

check('B3-2a 同源接线：import sessionDisplayStatusMeta + type SessionDisplayStatus（shared util，非复制字符串）', () => {
  assert.ok(sessionsPage.includes("from '../../shared/session-display-status';"), '缺 shared util import');
  assert.ok(sessionsPage.includes('sessionDisplayStatusMeta'), '缺 sessionDisplayStatusMeta 消费');
  assert.ok(sessionsPage.includes('type SessionDisplayStatus'), '缺类型 import');
});
check('B3-2b 投影函数形态：displayStatus 消费 store.sessionDisplayStatus；statusLabel 消费 sessionDisplayStatusMeta', () => {
  assert.match(sessionsPage,
    /function displayStatus\(sessionId: string\): SessionDisplayStatus \{\s*return store\.sessionDisplayStatus\(sessionId\);\s*\}/,
    'displayStatus 投影形态漂移');
  assert.match(sessionsPage,
    /function statusLabel\(sessionId: string\): string \{\s*return sessionDisplayStatusMeta\(displayStatus\(sessionId\)\)\.label;\s*\}/,
    'statusLabel 投影形态漂移');
});
check('B3-2c 卡片状态灯接线（idle 无灯守卫 + 动态四态修饰类 + role=img + aria/title=statusLabel）', () => {
  assert.ok(cardR1.includes("v-if=\"displayStatus(session.id) !== 'idle'\""), 'idle 无灯守卫丢失');
  assert.ok(cardR1.includes('class="session-card__status"'), '状态灯静态 class 丢失');
  assert.ok(cardR1.includes('session-card__status--${displayStatus(session.id)}'), '四态动态修饰类绑定丢失');
  assert.ok(cardR1.includes('role="img"'), 'role=img 丢失');
  assert.ok(cardR1.includes(':aria-label="statusLabel(session.id)"'), 'aria-label 接线丢失');
  assert.ok(cardR1.includes(':title="statusLabel(session.id)"'), 'title 接线丢失');
});
check('B3-2d 文案零复制：页面不含四态文案字面（侧栏与页面同源逐字一致由共享 util 保证）', () => {
  for (const s of ["'执行中'", "'网络异常，正在重试'", "'任务已完成'", "'网络异常，已中断'"]) {
    assert.ok(!sessionsPage.includes(s), `页面出现状态文案复制 ${s}（应消费共享 util）`);
  }
});
check('B3-2e 状态灯 CSS 四态在场（--session-status-color 变量机制 + completed/network_interrupted 静态覆写 + 改名 keyframes）', () => {
  assert.ok(pageStyle.includes('animation: session-card-status-pulse'), '缺改名 pulse 动画声明');
  assert.ok(pageStyle.includes('@keyframes session-card-status-pulse'), '缺改名 keyframes');
  assert.ok(pageStyle.includes('.session-card__status--running'), '缺 running 修饰规则');
  assert.ok(pageStyle.includes('--session-status-color: var(--color-warn)'), '缺 warn 色映射');
  assert.ok(pageStyle.includes('--session-status-color: var(--color-danger)'), '缺 danger 色映射');
  assert.ok(pageStyle.includes('--session-status-color: var(--color-success)'), '缺 success 色映射');
  assert.ok(pageStyle.includes('.session-card__status--completed'), '缺 completed 修饰');
  assert.ok(pageStyle.includes('.session-card__status--network_interrupted'), '缺 network_interrupted 修饰');
});
check('B3-2f reduced-motion 降级（media 块位于基础动画声明与 keyframes 之后，块内显式关状态灯动画）', () => {
  const mediaIdx = pageStyle.indexOf('@media (prefers-reduced-motion: reduce)');
  const animIdx = pageStyle.indexOf('animation: session-card-status-pulse');
  const kfIdx = pageStyle.indexOf('@keyframes session-card-status-pulse');
  assert.ok(mediaIdx > -1 && animIdx > -1 && kfIdx > -1, '三锚点缺失');
  assert.ok(mediaIdx > animIdx && mediaIdx > kfIdx, 'media 块顺序错误（同特异性后者胜，前置降级失效）');
  const innerIdx = pageStyle.indexOf('.session-card__status {', mediaIdx);
  assert.ok(innerIdx > mediaIdx, 'media 块内未覆盖状态灯');
  const innerBlk = pageStyle.slice(innerIdx, pageStyle.indexOf('}', innerIdx));
  assert.ok(innerBlk.includes('animation: none'), '降级块缺 animation: none');
});

console.log('\n=== B3-3 · meta 换源：项目 chip + formatSessionTime 短时间 ===');

check('B3-3a import 接线：formatSessionTime + projectLabel', () => {
  assert.ok(sessionsPage.includes("from '../utils/format-session-time';"), '缺 formatSessionTime import');
  assert.ok(sessionsPage.includes("from '../utils/group-sessions';"), '缺 projectLabel import');
});
check('B3-3b projectChip 投影：workingDir 有值走 projectLabel、空值返回 null（无则不渲染）', () => {
  assert.match(sessionsPage,
    /function projectChip\(session: \{ workingDir: string \| null \}\): string \| null \{\s*return session\.workingDir \? projectLabel\(session\.workingDir\) : null;\s*\}/,
    'projectChip 形态漂移');
});
check('B3-3c r2 构成与次序钉：chip（v-if + title ?? undefined 归一）→ time（formatSessionTime）', () => {
  assert.ok(cardR2.includes('v-if="projectChip(session)"'), 'chip v-if 丢失');
  assert.ok(cardR2.includes('class="session-card__chip"'), 'chip class 丢失');
  assert.ok(cardR2.includes(':title="projectChip(session) ?? undefined"'), 'chip title 未归一（vue-tsc 严格档，B2-16b 同款）');
  assert.ok(cardR2.includes('{{ projectChip(session) }}'), 'chip 文本接线丢失');
  assert.ok(cardR2.includes('class="session-card__time"'), 'time class 丢失');
  assert.ok(cardR2.includes('{{ formatSessionTime(session.updatedAt) }}'), '短时间接线丢失');
  const chipIdx = cardR2.indexOf('session-card__chip');
  const timeIdx = cardR2.indexOf('session-card__time');
  assert.ok(chipIdx > -1 && timeIdx > chipIdx, 'r2 次序应为 chip → time');
});
check('B3-3d 负断言：toLocaleString 长格式退场（短时间域由 formatSessionTime 既有 T1~T7 保全）', () => {
  assert.ok(!sessionsPage.includes('toLocaleString'), 'meta 仍用 toLocaleString 长格式');
});

console.log('\n=== B3-4 · model 字段不再展示（负断言） ===');

check('B3-4 全文件无 session.model 引用（模板/meta 均不再展示，无兜底 title）', () => {
  assert.ok(!sessionsPage.includes('session.model'), 'session.model 仍被引用（规范明文「不再展示」）');
});

console.log('\n=== B3-5 · 「全部 · N」计数头随列表联动（裁决 B3-5：N=displayedSessions.length） ===');

check('B3-5a 计数头字面与 N 绑定（displayedSessions.length，随搜索过滤联动；非 sessions.length、非字面常量）', () => {
  assert.ok(pageTpl.includes('全部 · {{ store.displayedSessions.length }}'), '计数头字面/绑定漂移');
  assert.ok(!pageTpl.includes('store.sessions.length'), 'N 绑定到全量 sessions（搜索过滤后不联动）');
});
check('B3-5b 计数头位于 header 左组（.sessions-page__left）内', () => {
  const leftIdx = pageTpl.indexOf('class="sessions-page__left"');
  const countIdx = pageTpl.indexOf('全部 ·');
  assert.ok(leftIdx > -1, '缺左组容器 .sessions-page__left');
  assert.ok(countIdx > leftIdx, '计数头不在左组内');
});

console.log('\n=== B3-6 · 「← 返回会话」逐字且回 / ===');

check('B3-6a 跨文件字面比对：页面返回钮文本与 ConfigPage .back-button 文案逐字一致（含 ← 与空格）', () => {
  assert.ok(configPage.includes('>← 返回会话</button>'), 'ConfigPage 基准文案读取失败');
  assert.ok(pageTpl.includes('>← 返回会话</button>'), '页面返回钮文本与 ConfigPage 基准不一致');
});
check('B3-6b 返回钮接线：class=sessions-page__back + @click router.push(\'/\')', () => {
  assert.ok(pageTpl.includes("<button type=\"button\" class=\"sessions-page__back\" @click=\"router.push('/')\">← 返回会话</button>"),
    '返回钮接线/文案漂移');
});
check('B3-6c 位置钉：返回钮在 header 内、列表外（列表空时仍可达）', () => {
  const backIdx = pageTpl.indexOf('class="sessions-page__back"');
  const listIdx = pageTpl.indexOf('class="sessions-list"');
  assert.ok(backIdx > -1 && listIdx > backIdx, '返回钮应位于列表之前（header 内）');
});

console.log('\n=== B3-7 · 空列表态：两空态文案不变 + 返回钮恒可达 ===');

check('B3-7a 两空态文案二分保留（searchQuery ? 未找到匹配的会话 : 暂无会话）', () => {
  assert.match(sessionsPage, /store\.searchQuery \? '未找到匹配的会话' : '暂无会话'/, '空态二分文案漂移');
});
check('B3-7b 返回钮恒渲染（钮元素切片内无 v-if——空列表/搜索无结果时页面仍有回路）', () => {
  const btnIdx = pageTpl.indexOf('<button type="button" class="sessions-page__back"');
  assert.ok(btnIdx > -1, '返回钮缺失');
  const btnBlk = pageTpl.slice(btnIdx, pageTpl.indexOf('</button>', btnIdx));
  assert.ok(!btnBlk.includes('v-if'), '返回钮带条件渲染（空态死路面）');
});

console.log('\n=== B3-8 · 卡片键盘可达（B2 机制形态复用） ===');

check('B3-8a 三件套：role 三元 / tabindex=0 / aria-label 三元（普通态=会话名，批量态=选择 +名称）', () => {
  assert.ok(pageTpl.includes(":role=\"batchMode ? 'checkbox' : 'button'\""), 'role 三元缺失');
  assert.ok(pageTpl.includes(':tabindex="0"'), 'tabindex 缺失');
  assert.ok(pageTpl.includes(":aria-label=\"batchMode ? '选择 ' + session.name : session.name\""), 'aria-label 缺失');
});
check('B3-8b 列表容器挂 @keydown 委托（.sessions-list）', () => {
  assert.ok(pageTpl.includes('<div class="sessions-list" @keydown="onListKeydown">'), '容器缺 keydown 委托');
});
check('B3-8c 委托体：Enter/Space 过滤 → 五类原生控件排除（先于 closest）→ closest(.session-card) → preventDefault + row.click()', () => {
  const fnIdx = sessionsPage.indexOf('function onListKeydown');
  assert.ok(fnIdx > -1, '缺 onListKeydown');
  const body = sessionsPage.slice(fnIdx, fnIdx + 700);
  assert.ok(body.includes("'Enter'") && body.includes("' '"), '键位过滤缺失');
  assert.ok(body.includes('t instanceof HTMLInputElement'), '缺输入框排除');
  for (const ctor of ['HTMLButtonElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLAnchorElement']) {
    assert.ok(body.includes(`t instanceof ${ctor}`), `缺 ${ctor} 排除`);
  }
  const nativeIdx = body.indexOf('t instanceof HTMLInputElement');
  const closestIdx = body.indexOf(".closest('.session-card')");
  assert.ok(closestIdx > nativeIdx, '排除应先于 closest（防双触发次序）');
  assert.ok(body.includes('e.preventDefault()') && body.includes('row.click()'), '缺转发 click');
});

console.log('\n=== B3-9 · 批量态 checkbox 语义 ===');

check('B3-9 aria-checked 随选联动 + 原生 checkbox 接线（click.stop 防双触发）', () => {
  assert.ok(pageTpl.includes(':aria-checked="batchMode ? selectedIds.has(session.id) : undefined"'), 'aria-checked 绑定缺失');
  assert.ok(pageTpl.includes('class="session-card__check"'), '原生 checkbox 缺失');
  assert.ok(pageTpl.includes(':checked="selectedIds.has(session.id)"'), 'checked 绑定丢失');
  assert.ok(pageTpl.includes('@click.stop="toggleSelected(session.id)"'), 'checkbox 点击切换丢失');
});

console.log('\n=== B3-10 · 批量三件套与危险确认文案保持真实（红线） ===');

check('B3-10a 批量三件套文案逐字保留（批量删除/退出批量、全选、已选 N 个会话、删除所选）', () => {
  assert.ok(pageTpl.includes("{{ batchMode ? '退出批量' : '批量删除' }}"), '批量切换钮文案漂移');
  assert.ok(pageTpl.includes('全选'), '全选 label 丢失');
  assert.ok(pageTpl.includes('已选 {{ selectedIds.size }} 个会话'), '已选计数文案漂移');
  assert.ok(pageTpl.includes('删除所选'), '删除所选钮丢失');
});
check('B3-10b 确认链保持真实：confirmBatchDelete / confirmDelete 均走 requestConfirm + danger:true + 确认后才删', () => {
  const batchIdx = sessionsPage.indexOf('async function confirmBatchDelete');
  assert.ok(batchIdx > -1, '缺 confirmBatchDelete');
  const batchBody = sessionsPage.slice(batchIdx, batchIdx + 700);
  assert.ok(batchBody.includes('interactionStore.requestConfirm({'), '批量确认链失守');
  assert.ok(batchBody.includes('danger: true'), '批量 danger 档丢失');
  const delIdx = sessionsPage.indexOf('async function confirmDelete(session:');
  assert.ok(delIdx > -1, '缺 confirmDelete（F1 锚定形态漂移）');
  const delBody = sessionsPage.slice(delIdx, delIdx + 700);
  assert.ok(delBody.includes('interactionStore.requestConfirm({'), '单删确认链失守');
  assert.ok(delBody.includes("title: '删除会话'"), '单删确认标题漂移');
  assert.ok(delBody.includes('if (ok) await store.deleteSession(session.id);'), '确认后才删除链路漂移');
});
check('B3-10c 置顶/删除文本钮文案与接线保全（tdd-session-pin 锚定形态）', () => {
  assert.ok(pageTpl.includes("{{ session.pinnedAt != null ? '取消置顶' : '置顶' }}"), '置顶文本钮随态文案漂移');
  assert.ok(pageTpl.includes('@click.stop="store.togglePin(session.id)"'), '置顶接线丢失');
  assert.ok(pageTpl.includes('v-if="session.pinnedAt != null"'), 'pin 标识守卫丢失');
  assert.ok(pageTpl.includes('@click.stop="confirmDelete(session)"'), '删除接线丢失');
  assert.ok(pageTpl.includes('>删除</button>'), '删除文本钮丢失');
});
check('B3-10d 新建钮保全（+ 新建会话 + createAndNavigate 暂态链）', () => {
  assert.ok(pageTpl.includes('+ 新建会话'), '新建钮文案丢失');
  assert.ok(sessionsPage.includes('function createAndNavigate()'), '新建函数丢失');
  assert.ok(sessionsPage.includes('store.startTransientSession();'), '暂态链丢失');
});

// ───────────────────────── B4 小节 · 窄窗两级断点（1100/800）+ 唤回条 pill + 侧栏 overlay 唤回 ─────────────────────────
// 用例正本 tests 卷 §B4（B4-1~B4-12）。CDP 行为面（B4-1/2/4/5/6/7/8/9/10/11 的运行时断言）落 cdp-layout B4
// 场景节——该文件不在点 B4 申报文件圈内（B1/B2 先例同款申报），本小节以同回归面结构钉转写 + CDP 运行时
// 验证由点闸门 npm run test:cdp:layout 兜底（视口 1200 起不触发断点，既有断言零涉）。

const appLayout = read('src/renderer/components/layout/AppLayout.vue');
const layoutTpl = appLayout.slice(appLayout.indexOf('<template>'), appLayout.lastIndexOf('</template>'));
const layoutStyle = appLayout.slice(appLayout.indexOf('<style'));

// 唤回条 pill 按钮切片：门字面起到 </button> 止。
const pillIdx = layoutTpl.indexOf('v-else-if="isChatRoute && panelForceHidden && !panelRecalled"');
const pill = pillIdx > -1 ? layoutTpl.slice(pillIdx, layoutTpl.indexOf('</button>', pillIdx)) : '';

console.log('\n=== B4-1 · ≤1100 面板隐藏+手柄隐藏+唤回条出现（状态机接线） ===');

check('B4-1a 两断点 matchMedia 字面（1100/800；max-width=≤ 语义，B4-10 边界值同源）+ 初值取 matches（窄窗首绘无闪变，B4-9 前提）', () => {
  assert.ok(appLayout.includes("window.matchMedia('(max-width: 1100px)')"), '缺 1100 断点 matchMedia');
  assert.ok(appLayout.includes("window.matchMedia('(max-width: 800px)')"), '缺 800 断点 matchMedia');
  assert.ok(appLayout.includes('ref(mqPanel.matches)'), 'panelForceHidden 初值未取 matches');
  assert.ok(appLayout.includes('ref(mqSidebar.matches)'), 'sidebarForceHidden 初值未取 matches');
});
check('B4-1b 面板门字面 v-if="isChatRoute && (!panelForceHidden || panelRecalled)" 恰 1 处（route-gate C② 同源）', () => {
  assert.equal(countOccurrences(layoutTpl, 'v-if="isChatRoute && (!panelForceHidden || panelRecalled)"'), 1,
    '面板门字面缺失或漂移');
});
check('B4-1c change 监听挂载/卸载对称（onMounted add ×2 / onUnmounted remove ×2，同名 handler）', () => {
  assert.ok(appLayout.includes('mqPanel.addEventListener(\'change\', onMqPanelChange);'), '缺 panel 断点 add');
  assert.ok(appLayout.includes('mqSidebar.addEventListener(\'change\', onMqSidebarChange);'), '缺 sidebar 断点 add');
  assert.ok(appLayout.includes('mqPanel.removeEventListener(\'change\', onMqPanelChange);'), '缺 panel 断点 remove');
  assert.ok(appLayout.includes('mqSidebar.removeEventListener(\'change\', onMqSidebarChange);'), '缺 sidebar 断点 remove');
});
check('B4-1d pill 三构成齐备：svg 图标（aria-hidden）+「队列」文字+badge 元素均在 pill 按钮切片内', () => {
  assert.ok(pillIdx > -1, '缺唤回条 pill（v-else-if 门缺失）');
  const svgIdx = pill.indexOf('<svg');
  const labelIdx = pill.indexOf('>队列</span>');
  const badgeIdx = pill.indexOf('reopen-task-panel__badge');
  assert.ok(svgIdx > -1, 'pill 缺图标 svg');
  assert.ok(pill.includes('aria-hidden="true"'), 'pill svg 缺 aria-hidden');
  assert.ok(labelIdx > svgIdx, 'pill 缺「队列」文字（或次序漂移）');
  assert.ok(badgeIdx > labelIdx, 'pill 缺计数角标元素（或次序漂移）');
});

console.log('\n=== B4-2 · 唤回条点击恢复面板（内联回唤，裁决 B-C1） ===');

check('B4-2a 唤回条门字面 v-else-if="isChatRoute && panelForceHidden && !panelRecalled"（面板回归→pill 随 !panelRecalled 退场）', () => {
  assert.equal(countOccurrences(layoutTpl, 'v-else-if="isChatRoute && panelForceHidden && !panelRecalled"'), 1,
    '唤回条门字面缺失或漂移');
});
check('B4-2b 点击唤回接线 @click="panelRecalled = true"（recalled=true 时面板门 || 分支放行→面板内联回归）', () => {
  assert.ok(pill.includes('@click="panelRecalled = true"'), '唤回条点击接线缺失');
});

console.log('\n=== B4-3 · 唤回条计数=当前会话队列任务数（响应式派生） ===');

check('B4-3a 派生源接线：useTaskStore import + 实例化（task-store tasks=当前活动会话队列视图，头注释权威）', () => {
  assert.ok(appLayout.includes("from '../../stores/task-store';"), '缺 task-store import');
  assert.ok(appLayout.includes('const taskStore = useTaskStore();'), '缺 useTaskStore 实例化');
});
check('B4-3b 计数响应式绑定：badge v-if="taskStore.tasks.length" + 插值 {{ taskStore.tasks.length }}（随任务增减联动，无心跳轮询）', () => {
  assert.ok(pill.includes('v-if="taskStore.tasks.length"'), 'badge 缺响应式 v-if');
  assert.ok(pill.includes('{{ taskStore.tasks.length }}'), 'badge 缺响应式插值');
});

console.log('\n=== B4-4 · 计数 0 无角标（裁决 B4-4：badge v-if 隐藏；图标+「队列」恒在场） ===');

check('B4-4 badge 守卫只罩角标：「队列」文字与图标不携带计数条件（0 计数时 pill 主体不消失）', () => {
  const badgeIdx = pill.indexOf('reopen-task-panel__badge');
  assert.ok(badgeIdx > -1, '缺 badge 元素');
  const badgeTag = pill.slice(Math.max(0, badgeIdx - 60), badgeIdx + 30);
  assert.ok(badgeTag.includes('v-if="taskStore.tasks.length"'), 'badge v-if 守卫缺失');
  const labelIdx = pill.indexOf('>队列</span>');
  const labelTag = pill.slice(Math.max(0, labelIdx - 60), labelIdx + 10);
  assert.ok(!labelTag.includes('v-if'), '「队列」文字带计数条件（0 计数把 pill 主体藏掉，逻辑反了）');
});

console.log('\n=== B4-5 · 窗口变宽面板自动恢复+唤回条隐藏 ===');

check('B4-5a 变宽恢复双保险①：onMqPanelChange 内 if (!e.matches) panelRecalled.value = false', () => {
  const fnIdx = appLayout.indexOf('function onMqPanelChange');
  assert.ok(fnIdx > -1, '缺 onMqPanelChange');
  const body = appLayout.slice(fnIdx, fnIdx + 200);
  assert.ok(body.includes('panelForceHidden.value = e.matches;'), '未同步 matches');
  assert.ok(body.includes('if (!e.matches) panelRecalled.value = false;'), '变宽未复位 recalled（断点单向，回不来）');
});
check('B4-5b 变宽恢复双保险②：watch(panelForceHidden) false→panelRecalled=false（防漏接 change 时序）', () => {
  const wIdx = appLayout.indexOf('watch(panelForceHidden');
  assert.ok(wIdx > -1, '缺 panelForceHidden watch');
  const body = appLayout.slice(wIdx, wIdx + 140);
  assert.ok(body.includes('panelRecalled.value = false'), 'watch 未复位 recalled');
});

console.log('\n=== B4-6 · ≤800 侧栏隐藏+Header 左端图标钮（title「显示会话列表」） ===');

check('B4-6a AppHeader toggle 钮四件套：v-if="showSidebarToggle" / class=app-header__sidebar-toggle / title=aria=「显示会话列表」', () => {
  assert.ok(headerTpl.includes('v-if="showSidebarToggle"'), 'toggle 钮缺 v-if');
  assert.ok(headerTpl.includes('class="app-header__sidebar-toggle"'), '缺 .app-header__sidebar-toggle');
  assert.ok(headerTpl.includes('title="显示会话列表"'), 'title 漂移（规范钉文案）');
  assert.ok(headerTpl.includes('aria-label="显示会话列表"'), 'aria-label 漂移');
});
check('B4-6b AppHeader props/emits：defineProps<{ showSidebarToggle?: boolean }> + emits toggle-sidebar', () => {
  assert.ok(appHeader.includes('defineProps<{ showSidebarToggle?: boolean }>()'), '缺 showSidebarToggle prop');
  assert.ok(appHeader.includes("(e: 'toggle-sidebar'): void"), '缺 toggle-sidebar emit 声明');
  assert.ok(headerTpl.includes("@click=\"emit('toggle-sidebar')\""), '钮未接 emit');
});
check('B4-6c AppLayout 接线：:show-sidebar-toggle="sidebarForceHidden" + @toggle-sidebar 翻转 overlay 开合', () => {
  assert.ok(layoutTpl.includes(':show-sidebar-toggle="sidebarForceHidden"'), 'AppLayout 未传 show-sidebar-toggle prop');
  assert.ok(layoutTpl.includes('@toggle-sidebar="sidebarOverlayOpen = !sidebarOverlayOpen"'), 'emit 未接 overlay 开合翻转');
});
check('B4-6d 左右组重排：左组 .app-header__left 包裹 toggle 钮与标题区（toggle 在 title 之前），右组保持 B3 双钮', () => {
  const leftIdx = headerTpl.indexOf('class="app-header__left"');
  const toggleIdx = headerTpl.indexOf('class="app-header__sidebar-toggle"');
  const titleIdx = headerTpl.indexOf('class="app-header__title"');
  const rightIdx = headerTpl.indexOf('class="app-header__right"');
  const manageIdx = headerTpl.indexOf('class="app-header__manage"');
  const shareIdx = headerTpl.indexOf('class="app-header__share"');
  assert.ok(leftIdx > -1, '缺左组容器');
  assert.ok(toggleIdx > leftIdx && titleIdx > toggleIdx, 'toggle 应在左组内且先于标题区');
  assert.ok(rightIdx > leftIdx && manageIdx > rightIdx && shareIdx > manageIdx, '右组 B3 双钮次序破坏');
});

console.log('\n=== B4-7 · overlay 浮出与双路关闭 ===');

check('B4-7a 遮罩层：v-if="sidebarForceHidden && sidebarOverlayOpen" + @click 关闭（遮罩点击路）；toggle 再点=第二路', () => {
  assert.ok(layoutTpl.includes('v-if="sidebarForceHidden && sidebarOverlayOpen"'), '遮罩层缺失或条件漂移');
  const maskIdx = layoutTpl.indexOf('class="sidebar-overlay-backdrop"');
  assert.ok(maskIdx > -1, '缺 .sidebar-overlay-backdrop');
  const maskTag = layoutTpl.slice(Math.max(0, maskIdx - 120), maskIdx + 90);
  assert.ok(maskTag.includes('@click="sidebarOverlayOpen = false"'), '遮罩点击不关闭');
});
check('B4-7b overlay CSS：.sidebar--overlay-open 含 position:fixed + z-index（覆盖于内容之上）；backdrop 含 inset:0 + z-index', () => {
  const ovIdx = layoutStyle.indexOf('.sidebar--overlay-open {');
  assert.ok(ovIdx > -1, '缺 .sidebar--overlay-open 规则');
  const ovBlk = layoutStyle.slice(ovIdx, layoutStyle.indexOf('}', ovIdx));
  assert.ok(ovBlk.includes('position: fixed'), 'overlay 未脱流 fixed');
  assert.ok(/z-index:\s*\d+/.test(ovBlk), 'overlay 缺 z-index');
  const bdIdx = layoutStyle.indexOf('.sidebar-overlay-backdrop {');
  assert.ok(bdIdx > -1, '缺 backdrop 规则');
  const bdBlk = layoutStyle.slice(bdIdx, layoutStyle.indexOf('}', bdIdx));
  assert.ok(bdBlk.includes('position: fixed') && bdBlk.includes('inset: 0'), 'backdrop 未全屏覆盖');
});

console.log('\n=== B4-8 · 窗口变宽侧栏自动恢复（overlay 态清理） ===');

check('B4-8 变宽清理双保险：onMqSidebarChange 内 if (!e.matches) sidebarOverlayOpen=false + watch(sidebarForceHidden) 复位', () => {
  const fnIdx = appLayout.indexOf('function onMqSidebarChange');
  assert.ok(fnIdx > -1, '缺 onMqSidebarChange');
  const body = appLayout.slice(fnIdx, fnIdx + 200);
  assert.ok(body.includes('if (!e.matches) sidebarOverlayOpen.value = false;'), '变宽未关 overlay（残留浮层）');
  const wIdx = appLayout.indexOf('watch(sidebarForceHidden');
  assert.ok(wIdx > -1, '缺 sidebarForceHidden watch');
  const wBody = appLayout.slice(wIdx, wIdx + 140);
  assert.ok(wBody.includes('sidebarOverlayOpen.value = false'), 'watch 未关 overlay');
});

console.log('\n=== B4-9 · 断点穿越 800↔1100 状态一致（类绑定+复位双保险共证） ===');

check('B4-9 侧栏类双绑定：--forced-hidden 与 --overlay-open 并存绑定（同特异性后者胜=CSS 顺序钉）', () => {
  assert.ok(layoutTpl.includes("'sidebar--forced-hidden': sidebarForceHidden"), '缺 --forced-hidden 绑定');
  assert.ok(layoutTpl.includes("'sidebar--overlay-open'"), '缺 --overlay-open 绑定');
  const fhIdx = layoutStyle.indexOf('.sidebar--forced-hidden {');
  const ovIdx2 = layoutStyle.indexOf('.sidebar--overlay-open {');
  assert.ok(fhIdx > -1 && ovIdx2 > fhIdx, 'overlay 规则未置于 hidden 之后（同特异性后者胜，overlay 不显）');
  const fhBlk = layoutStyle.slice(fhIdx, layoutStyle.indexOf('}', fhIdx));
  assert.ok(fhBlk.includes('display: none'), '--forced-hidden 缺 display:none');
});

console.log('\n=== B4-10 · 断点标志优先于拖宽手柄（不互踩）+ 拖宽契约不回归（红线） ===');

check('B4-10a 侧栏手柄 v-show="!sidebarForceHidden"（断点钳制手柄）；任务手柄在面板门 template 内（同门隐藏）〔B6 同步：手柄 class 改 :class 数组绑定，--dragging 类由 B6-2b 钉〕', () => {
  const handleIdx = layoutTpl.indexOf(":class=\"['resize-handle', 'resize-handle--sidebar', { 'resize-handle--dragging': dragging === 'sidebar' }]\"");
  assert.ok(handleIdx > -1, '缺侧栏手柄（B6 后为 :class 数组绑定形态）');
  const handleTag = layoutTpl.slice(Math.max(0, handleIdx - 60), handleIdx);
  assert.ok(handleTag.includes('v-show="!sidebarForceHidden"'), '侧栏手柄未接断点钳制');
  const gateIdx = layoutTpl.indexOf('v-if="isChatRoute && (!panelForceHidden || panelRecalled)"');
  const taskHandleIdx = layoutTpl.indexOf(":class=\"['resize-handle', 'resize-handle--task', { 'resize-handle--dragging': dragging === 'task' }]\"");
  assert.ok(gateIdx > -1 && taskHandleIdx > gateIdx, '任务手柄不在面板门 template 内（断点下漏藏）');
});
check('B4-10b 拖宽契约不回归：钳制常量 180-460/240-560、col-resize、禁选中、taskWidth = ref(340)（selftest-settings-mapping 锚）', () => {
  assert.ok(appLayout.includes('const SIDEBAR_MIN = 180;'), 'SIDEBAR_MIN 漂移');
  assert.ok(appLayout.includes('const SIDEBAR_MAX = 460;'), 'SIDEBAR_MAX 漂移');
  assert.ok(appLayout.includes('const TASK_MIN = 240;'), 'TASK_MIN 漂移');
  assert.ok(appLayout.includes('const TASK_MAX = 560;'), 'TASK_MAX 漂移');
  assert.ok(/taskWidth\s*=\s*ref\(340\)/.test(appLayout), 'taskWidth 契约漂移');
  assert.ok(appLayout.includes("'col-resize'"), '拖宽光标丢失');
  assert.ok(appLayout.includes("'none'"), '拖宽禁选中丢失');
  assert.ok(layoutTpl.includes('title="拖动调整侧栏宽度"') && layoutTpl.includes('title="拖动调整队列宽度"'), '手柄 title 丢失');
});

console.log('\n=== B4-11 · pill CSS（D1-07 改形态：图标+队列+计数角标） ===');

check('B4-11a pill 基座：position:fixed + border-radius: var(--radius-pill) + inline-flex 行（沿用 right:12/top:84）', () => {
  const pillCssIdx = layoutStyle.indexOf('.reopen-task-panel {');
  assert.ok(pillCssIdx > -1, '缺 pill CSS');
  const blk = layoutStyle.slice(pillCssIdx, layoutStyle.indexOf('}', pillCssIdx));
  assert.ok(blk.includes('position: fixed'), 'pill 缺 fixed');
  assert.ok(blk.includes('border-radius: var(--radius-pill)'), 'pill 未走 --radius-pill');
  assert.ok(blk.includes('display: inline-flex'), 'pill 缺 inline-flex 行布局');
  assert.ok(blk.includes('right: 12px') && blk.includes('top: 84px'), 'pill 位置漂移');
});
check('B4-11b badge 与 icon：badge 底 accent/字 on-accent + icon 线稿 fill:none stroke:currentColor', () => {
  const badgeIdx = layoutStyle.indexOf('.reopen-task-panel__badge {');
  assert.ok(badgeIdx > -1, '缺 badge CSS');
  const badgeBlk = layoutStyle.slice(badgeIdx, layoutStyle.indexOf('}', badgeIdx));
  assert.ok(badgeBlk.includes('background: var(--color-accent)'), 'badge 缺 accent 底');
  assert.ok(badgeBlk.includes('color: var(--color-on-accent)'), 'badge 缺 on-accent 字色');
  assert.ok(badgeBlk.includes('border-radius: var(--radius-pill)'), 'badge 未走 --radius-pill');
  const iconIdx = layoutStyle.indexOf('.reopen-task-panel__icon {');
  assert.ok(iconIdx > -1, '缺 icon CSS');
  const iconBlk = layoutStyle.slice(iconIdx, layoutStyle.indexOf('}', iconIdx));
  assert.ok(iconBlk.includes('fill: none') && iconBlk.includes('stroke: currentColor'), 'icon 线稿形态漂移');
});

console.log('\n=== B4-12 · 网页版浏览器窗口同效（matchMedia 标准 Web API） ===');

check('B4-12 断点唯一 API=matchMedia（无 Electron 专有桥/require 参与；浏览器与桌面同源生效）', () => {
  assert.ok(appLayout.includes('window.matchMedia'), '断点未走 matchMedia');
  assert.ok(!appLayout.includes('window.claudeLink'), 'AppLayout 出现桥接 API（断点逻辑混入专有通道）');
  assert.ok(!/\brequire\(/.test(appLayout), 'AppLayout 出现 require（Web 包死）');
});

console.log('\n=== B4-负 · 死状态删除 ===');

check('B4-负1 isTaskPanelOpen 死状态已整体删除（K4 现状死入口代码在重绑时消化；route-gate C⑤ 同源）', () => {
  assert.ok(!appLayout.includes('isTaskPanelOpen'), 'isTaskPanelOpen 残留');
});

// ───────────────────────── B5 小节 · 批量删除悬空 id 守卫（两处调用点组件层过滤） ─────────────────────────
// 用例正本 = docs/ui-completion/tests/B-layout-sidebar-cases.md §B5 B5-1~B5-4（四向：正常/边界/异常/并发）；
// 行为规范 = docs/ui-completion/10-behavior-specs.md §B5；实现方案 = docs/ui-completion/impl/B-layout-sidebar-impl.md §5
// （两处 confirmBatchDelete 同款改法、函数签名不变；session-store.ts 零改动——守卫必须在 requestConfirm
//   之前=组件层，不预埋 store 层防御）。
// 执行侧裁决（申报留痕，同 B1/B2 先例）：B5 主形态=双端 CDP 编排（跨端 SESSIONS_CHANGED delete 注入），
// cdp 脚本不在点 B5 申报文件圈内 → 本脚本以「纯函数行为组（守卫语义四向覆盖）+ 两组件结构钉
// （过滤先于确认 / 空集静默短路 / 计数按过滤后 / watch 集合自动修剪 / store 零改动）」转写；
// CDP 运行时验证由点闸门 npm run test:cdp 兜底。组件内联过滤不可 import → 行为组用逐字同形
// 参考纯函数钉语义，结构钉钉住组件代码与参考表达式的同形性（文本漂移即红）。
// 执行侧裁决②（申报留痕）：确认弹窗 message 模板插值保持 ${count} 逐字不变——圈外契约
// tdd-sidebar-structure-verify.ts R1.7 与 tdd-bugfix-f1-…verify.ts 按该逐字文案断言（两脚本均不在本点
// 文件圈内，改之即破圈）；过滤后长度经 `const count = ids.length;` 承接，计数语义=过滤后，与 impl §5
// 草图「模板内直写 ${ids.length}」形态等值；impl 草图与自身「模板文字逐字不变、R1.7 断言继续命中」
// 承诺互斥，按承诺面裁决取 count 桥（B5-负3 双侧钉住该裁决）。

// B5 参考纯函数（与两组件守卫表达式逐字同形；同形性由 B5-2b 结构钉校验）。
function filterAliveIds(selectedIds: string[], sessions: { id: string }[]): string[] {
  return selectedIds.filter((id) => sessions.some((s) => s.id === id));
}

// B5 参考纯函数（watch 集合自动修剪语义：无失效返回原引用=不写回不重渲；空选中集合直通）。
function trimSelectedIds(selectedIds: Set<string>, sessionIds: string[]): Set<string> {
  if (selectedIds.size === 0) return selectedIds;
  const alive = new Set(sessionIds);
  const next = new Set([...selectedIds].filter((id) => alive.has(id)));
  return next.size !== selectedIds.size ? next : selectedIds;
}

// 组件层守卫切片：confirmBatchDelete 函数体（首个行首 `}` 闭合，两文件函数体均无行首大括号嵌套）。
const batchFnOf = (src: string): string => {
  const i = src.indexOf('async function confirmBatchDelete');
  assert.ok(i > -1, '缺 confirmBatchDelete 函数');
  const end = src.indexOf('\n}', i);
  assert.ok(end > -1, 'confirmBatchDelete 函数体未闭合');
  return src.slice(i, end + 2);
};

const sidebarFn = batchFnOf(sidebar);
const pageFn = batchFnOf(sessionsPage);
const FILTER_LINE =
  'const ids = [...selectedIds.value].filter((id) => store.sessions.some((s) => s.id === id));';
const BOTH_FNS: [string, string][] = [
  ['AppSidebar', sidebarFn],
  ['SessionsPage', pageFn],
];

console.log('\n=== B5-1 · 全部有效→过滤恒等，行为与现状一致（正常路径） ===');

check('B5-1a 全部选中 id 均在集合内：过滤恒等（同序同长同元素——提交数组与现状 selectedIds 展开逐项一致）', () => {
  const sessions = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  assert.deepEqual(filterAliveIds(['a', 'b', 'c'], sessions), ['a', 'b', 'c']);
  assert.deepEqual(filterAliveIds(['c', 'a'], sessions), ['c', 'a'], '顺序必须保持 selectedIds 序（非 sessions 序）');
  assert.equal(filterAliveIds(['a'], sessions).length, 1);
});
check('B5-1b 精确字符串匹配（不做模糊/大小写/空白宽容——悬空判定与集合成员判定同规则）', () => {
  const sessions = [{ id: 'a' }, { id: 'A-x' }];
  assert.deepEqual(filterAliveIds(['a ', 'x'], sessions), [], '尾随空格 id 必须视为悬空');
  assert.deepEqual(filterAliveIds(['A-x'], sessions), ['A-x'], '大小写敏感精确匹配');
});

console.log('\n=== B5-2 · 部分失效→仅删有效项且计数按过滤后（边界值） ===');

check('B5-2a 部分悬空：仅存活者保留、悬空者丢弃，计数=过滤后长度（确认弹窗计数数据源）', () => {
  const sessions = [{ id: 'a' }, { id: 'c' }]; // b 已被跨端删除 → 集合已自动修剪
  const kept = filterAliveIds(['a', 'b', 'c'], sessions);
  assert.deepEqual(kept, ['a', 'c']);
  assert.equal(kept.length, 2, '确认弹窗计数必须等于过滤后 ids.length（非 selectedIds.size）');
});
check('B5-2b 结构钉（两处）：过滤行逐字同形 + 位于 requestConfirm 之前（守卫=组件层，先于弹窗）', () => {
  for (const [name, fn] of BOTH_FNS) {
    assert.ok(fn.includes(FILTER_LINE), `${name} 守卫过滤行字面漂移`);
    const f = fn.indexOf(FILTER_LINE);
    const c = fn.indexOf('requestConfirm(');
    assert.ok(c > -1 && f < c, `${name} 过滤行必须先于 requestConfirm（守卫在组件层=弹窗之前）`);
  }
});
check('B5-2c 结构钉（两处）：提交换过滤结果——deleteSessions(ids) 恰 1 处且不再对选中集原样发起删除', () => {
  for (const [name, fn] of BOTH_FNS) {
    assert.equal((fn.match(/store\.deleteSessions\(/g) ?? []).length, 1, `${name} deleteSessions 调用必须恰 1 处`);
    assert.ok(fn.includes('await store.deleteSessions(ids);'), `${name} 提交参数必须是过滤后 ids`);
    assert.ok(!fn.includes('deleteSessions([...selectedIds.value])'), `${name} 仍对 selectedIds 原集发起删除（悬空 id 直达删除链）`);
  }
});

console.log('\n=== B5-3 · 过滤后为空→静默短路：无弹窗无报错（异常路径） ===');

check('B5-3a 全悬空→过滤为空数组（结构钉：空守卫 if (!count) return 位于 requestConfirm 之前）', () => {
  assert.deepEqual(filterAliveIds(['x', 'y'], [{ id: 'a' }]), [], '全悬空必须过滤为空');
  for (const [name, fn] of BOTH_FNS) {
    const g = fn.indexOf('if (!count) return;');
    const c = fn.indexOf('requestConfirm(');
    assert.ok(g > -1, `${name} 缺空集守卫`);
    assert.ok(g > fn.indexOf(FILTER_LINE) && c > g, `${name} 空守卫必须紧随过滤行且先于 requestConfirm（无弹窗无报错）`);
  }
});
check('B5-3b 空集静默不触碰批量态（结构钉：空守卫为纯 return——不退出批量模式不清选中集）', () => {
  for (const [name, fn] of BOTH_FNS) {
    const g = fn.indexOf('if (!count) return;');
    const guard = fn.slice(g, g + 40);
    assert.ok(!guard.includes('batchMode'), `${name} 空守卫不得退出批量模式（静默短路=现状无选中时行为）`);
  }
});
check('B5-3c sessions 为空集合→任何选中全悬空（极值）', () => {
  assert.deepEqual(filterAliveIds(['a', 'b'], []), []);
});

console.log('\n=== B5-4 · 外部删除后选中集合自动修剪一致（并发与状态） ===');

check('B5-4a watch 自动修剪语义：跨端事件后存活集收敛选中集（幽灵条目丢弃、存活者保留）', () => {
  assert.deepEqual([...trimSelectedIds(new Set(['a', 'b', 'c']), ['a', 'c'])].sort(), ['a', 'c'],
    '修剪必须丢弃已删 b、保留存活 a/c');
  assert.equal(trimSelectedIds(new Set(['a']), []).size, 0, '全悬空修剪为空集');
});
check('B5-4b 修剪引用稳定：无失效返回原引用（不写回→不触发批量条计数/全选态无谓重渲）；空选中集直通', () => {
  const sel = new Set(['a', 'b']);
  assert.equal(trimSelectedIds(sel, ['a', 'b', 'c']), sel, '无失效必须返回原引用');
  assert.equal(trimSelectedIds(new Set(), ['a']).size, 0, '空选中集合直通（不产生新集合）');
});
check('B5-4c 结构钉（两处）：watch 接线齐全——源 getter 映射 sessions id 集 + 批量态/空集守卫 + 条件写回', () => {
  for (const [name, src] of [['AppSidebar', sidebar], ['SessionsPage', sessionsPage]] as const) {
    assert.ok(src.includes('() => store.sessions.map((s) => s.id)'), `${name} 缺 watch 源 getter（sessions id 集）`);
    assert.ok(src.includes('if (!batchMode.value || selectedIds.value.size === 0) return;'), `${name} 缺批量态/空集守卫`);
    assert.ok(src.includes('const alive = new Set(ids);'), `${name} 缺存活集`);
    assert.ok(src.includes('if (next.size !== selectedIds.value.size) selectedIds.value = next;'),
      `${name} 缺条件写回（无失效不写回=引用稳定）`);
    assert.ok(/import\s*{[^}]*\bwatch\b[^}]*}\s*from\s*'vue';/.test(src), `${name} 缺 watch import`);
  }
});
check('B5-4d allSelected 判定源不改：仍按 displayedSessions 求值（修剪联动由 selectedIds 写回触发）', () => {
  assert.ok(sidebar.includes('store.displayedSessions.every((s) => selectedIds.value.has(s.id))'), 'AppSidebar allSelected 判定源漂移');
  assert.ok(sessionsPage.includes('store.displayedSessions.every((s) => selectedIds.value.has(s.id))'), 'SessionsPage allSelected 判定源漂移');
});

console.log('\n=== B5-负 · store 层零改动 + 签名/计数/成功路径保全 ===');

check('B5-负1 store.deleteSessions 函数体零改动：逐个 deleteSession 复用链、无存在性过滤（不预埋 store 层防御）', () => {
  const i = storeSrc.indexOf('async deleteSessions(ids: string[])');
  assert.ok(i > -1, '缺 store.deleteSessions');
  const body = storeSrc.slice(i, storeSrc.indexOf('\n    },', i));
  assert.ok(body.includes('for (const id of ids)') && body.includes('await this.deleteSession(id);'),
    'store.deleteSessions 复用链漂移（本点要求零改动）');
  assert.ok(!body.includes('.some(') && !body.includes('.filter('), 'store 层出现存在性过滤（守卫必须只在组件层）');
});
check('B5-负2 函数签名不变：async function confirmBatchDelete() { 恰 1 处（两组件，无新参数）', () => {
  assert.equal((sidebar.match(/async function confirmBatchDelete\(\) \{/g) ?? []).length, 1, 'AppSidebar 签名漂移');
  assert.equal((sessionsPage.match(/async function confirmBatchDelete\(\) \{/g) ?? []).length, 1, 'SessionsPage 签名漂移');
});
check('B5-负3 计数按过滤后：count 变量承接过滤后长度（const count = ids.length）+ 模板保持 ${count} 逐字（R1.7/f1 契约）', () => {
  for (const [name, fn] of BOTH_FNS) {
    const bridge = fn.indexOf('const count = ids.length;');
    assert.ok(bridge > fn.indexOf(FILTER_LINE), `${name} 缺 count 承接过滤后长度（或位置先于过滤行）`);
    assert.ok(fn.indexOf('requestConfirm(') > bridge, `${name} 计数桥未在确认之前（弹窗计数非过滤后值）`);
    assert.ok(fn.includes('${count} 个会话'), `${name} 模板字面漂移（R1.7/f1 靠该逐字文案）`);
    assert.ok(!fn.includes('selectedIds.value.size'), `${name} 残留 selectedIds.size 计数源（未按过滤后计算）`);
  }
});
check('B5-负4 成功路径行为保全：确认通过仍复位批量态+清选中集（if (!ok) return 之后次序钉）', () => {
  for (const [name, fn] of BOTH_FNS) {
    const okIdx = fn.indexOf('if (!ok) return;');
    const batchIdx = fn.indexOf('batchMode.value = false;', okIdx);
    const clearIdx = fn.indexOf('selectedIds.value = new Set();', batchIdx);
    assert.ok(okIdx > -1 && batchIdx > okIdx && clearIdx > batchIdx, `${name} 成功路径复位次序漂移`);
  }
});

// ───────────────────────── B6 小节 · 侧栏/顶栏细节包（手柄/重命名/搜索 aria/新会话钮 ink/保全项） ─────────────────────────
// 用例正本 = docs/ui-completion/tests/B-layout-sidebar-cases.md §B6 B6-1~B6-10（四向：正常 B6-1/4/6/7/9、
// 边界 B6-3/8/10、异常 B6-5、并发与状态 B6-2）；行为规范 = docs/ui-completion/10-behavior-specs.md §B6；
// 实现方案 = docs/ui-completion/impl/B-layout-sidebar-impl.md §6（§6.2(1) 手柄 / §6.2(2) 重命名 / §6.2(3) 搜索
// aria / §6.2(4) 新会话钮 ink / §6.2(5) 保全清单）。
// 执行侧裁决（申报留痕，同 B1/B2/B5 先例）：B6-1/B6-2/B6-3/B6-5/B6-8/B6-9 的主形态为 CDP 行为断言
// （mousemove+computed style / 双色板对比 / 拖动序列），scripts/cdp-layout-e2e.mjs 不在点 B6 申报文件圈内
// → 本脚本以同回归面的结构钉转写（dragging ref+class 绑定、hover∪--dragging 规则组、token 对逐字、
// aria/行为矩阵逐字、品牌区三锚钉）；CDP 运行时验证由点闸门 npm run test:cdp 兜底。
// ink token 名按 A2 产出回填（--color-btn-ink / --color-on-btn-ink；裁决 B6-7：B 点不独立钉死 token 名，
// 引用 A2 定稿语义对 + 零硬编码 hex 负断言）。

console.log('\n=== B6-1 · 手柄 hover accent 30% 弱底（正常路径） ===');

check('B6-1 .resize-handle:hover 弱底 = accent 30% 透明混色（accent 系、弱于实底；:active 拖动态伪类废除）', () => {
  const hoverIdx = layoutStyle.indexOf('.resize-handle:hover');
  assert.ok(hoverIdx > -1, '缺 .resize-handle:hover 规则');
  const blk = layoutStyle.slice(hoverIdx, layoutStyle.indexOf('}', hoverIdx));
  assert.ok(blk.includes('color-mix(in srgb, var(--color-accent) 30%, transparent)'), 'hover 弱底漂移（应为 accent 30% 混色）');
  assert.ok(blk.includes('.resize-handle--dragging'), '拖动常亮类未并入 hover 规则组（B6-2 联动）');
  assert.ok(!layoutStyle.includes('.resize-handle:active'), ':active 高亮规则残留（B6 废除拖动伪类语义）');
});

console.log('\n=== B6-2 · 拖动常亮（并发与状态：拖动中指针离开不高亮消失——B6 点名回归面） ===');

check("B6-2a dragging 改 ref<'sidebar' | 'task' | null>（模板 class 绑定需响应性）：模块级 let 残留=红", () => {
  assert.ok(appLayout.includes("const dragging = ref<'sidebar' | 'task' | null>(null);"), 'dragging 未 ref 化');
  assert.ok(!/\blet dragging\b/.test(appLayout), 'let dragging 残留（无响应源，拖动常亮失效）');
  for (const wire of [
    "dragging.value = 'sidebar';",
    "dragging.value = 'task';",
    'if (!dragging.value) return;',
    "dragging.value === 'sidebar'",
    "dragging.value === 'task'",
    'dragging.value = null;',
  ]) {
    assert.ok(appLayout.includes(wire), `拖拽接线未改 .value：${wire}`);
  }
});
check("B6-2b 两手柄 :class 绑定 --dragging 类（v-show 断点钳制原位；B4-10a 已同步改钉 :class 形态）", () => {
  assert.ok(layoutTpl.includes("'resize-handle--dragging': dragging === 'sidebar'"), '侧栏手柄缺 --dragging 绑定');
  assert.ok(layoutTpl.includes("'resize-handle--dragging': dragging === 'task'"), '任务手柄缺 --dragging 绑定');
  assert.ok(layoutTpl.includes('v-show="!sidebarForceHidden"'), '侧栏手柄断点钳制漂移（B4 契约）');
});
check('B6-2c --dragging 与 :hover 同规则组弱底（class 常亮与指针位置解耦）+ mouseup 清 ref 还原', () => {
  const hoverIdx = layoutStyle.indexOf('.resize-handle:hover');
  assert.ok(hoverIdx > -1, '缺手柄 hover 规则组');
  const blk = layoutStyle.slice(hoverIdx, layoutStyle.indexOf('}', hoverIdx));
  assert.ok(blk.includes('.resize-handle--dragging'), '--dragging 未并入 hover 规则组（拖动中指针离开高亮会消失）');
  const upIdx = appLayout.indexOf('function onMouseUp()');
  assert.ok(upIdx > -1, '缺 onMouseUp');
  const upBlk = appLayout.slice(upIdx, appLayout.indexOf('}', upIdx));
  assert.ok(upBlk.includes('dragging.value = null;'), 'mouseup 未清 dragging（松手还原无源）');
});

console.log('\n=== B6-3 · 手柄钳制/光标/禁选中契约零回归（边界值；常量钉见 B4-10b，此处钉 body 抑制还原对） ===');

check('B6-3 拖动期 body cursor/userSelect 抑制与还原四点齐全（拖动中抑制、mouseup 还原；B4-10b 常量/光标/禁选中原钉继续在岗）', () => {
  assert.ok(appLayout.includes("document.body.style.cursor = 'col-resize';"), '拖动期 cursor 抑制缺失');
  assert.ok(appLayout.includes("document.body.style.userSelect = 'none';"), '拖动期禁选中缺失');
  assert.ok(appLayout.includes("document.body.style.cursor = '';"), 'cursor 还原缺失');
  assert.ok(appLayout.includes("document.body.style.userSelect = '';"), 'userSelect 还原缺失');
});

console.log('\n=== B6-4 · 重命名输入 aria「重命名会话」+ 钮图标化（结构钉；CDP 抽验由冒烟兜底） ===');

check('B6-4a 编辑框 aria-label 逐字 + maxlength 80 原位（input 属性零漂移）', () => {
  const inputIdx = headerTpl.indexOf('class="app-header__name-input"');
  assert.ok(inputIdx > -1, '缺重命名编辑框');
  const tag = headerTpl.slice(Math.max(0, inputIdx - 160), inputIdx + 300);
  assert.ok(tag.includes('aria-label="重命名会话"'), '编辑框缺 aria-label="重命名会话"');
  assert.ok(tag.includes('maxlength="80"'), 'maxlength 80 漂移');
  assert.ok(tag.includes('v-model="draftName"'), 'v-model 漂移');
});
check('B6-4b 重命名钮图标化：svg pencil（title/aria=「重命名会话」双钉）且 ✎ 文本残留=红', () => {
  const btnIdx = headerTpl.indexOf('class="app-header__rename"');
  assert.ok(btnIdx > -1, '缺重命名钮');
  const tag = headerTpl.slice(btnIdx, headerTpl.indexOf('</button>', btnIdx));
  assert.ok(tag.includes('title="重命名会话"'), '钮 title 漂移');
  assert.ok(tag.includes('aria-label="重命名会话"'), '钮缺 aria-label="重命名会话"');
  assert.ok(tag.includes('@click="startEdit"'), '钮点击链漂移');
  assert.ok(tag.includes('<svg viewBox="0 0 24 24" aria-hidden="true">'), '钮非图标化（缺 svg）');
  assert.ok(tag.includes('M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'), 'pencil path 漂移');
  assert.ok(!tag.includes('✎'), '钮文本 ✎ 残留（未图标化）');
});
check('B6-4c 行为矩阵接线逐字：Enter/blur 保存、Esc .stop 取消（.stop 防冒泡误触急停）', () => {
  assert.ok(headerTpl.includes('@keydown.enter.prevent="commitEdit"'), 'Enter 保存漂移');
  assert.ok(headerTpl.includes('@keydown.esc.stop="cancelEdit"'), 'Esc .stop 取消漂移');
  assert.ok(headerTpl.includes('@blur="commitEdit"'), 'blur 保存漂移');
});
check('B6-4d 样式：rename 钮 inline-flex 对齐 + svg 14×14 currentColor 线稿；文字色/opacity/hover 原规则零改动', () => {
  const blk = cssBlock(headerStyle, '.app-header__rename {');
  assert.ok(blk.includes('display: inline-flex') && blk.includes('align-items: center'), '缺 inline-flex 对齐');
  const svgBlk = cssBlock(headerStyle, '.app-header__rename svg {');
  assert.ok(svgBlk.includes('width: 14px') && svgBlk.includes('height: 14px'), 'svg 尺寸漂移');
  assert.ok(svgBlk.includes('stroke: currentColor'), 'svg 未走 currentColor（硬编码色嫌疑）');
  assert.ok(svgBlk.includes('stroke-linecap: round') && svgBlk.includes('stroke-linejoin: round'), '线稿端点漂移');
  assert.ok(cssBlock(headerStyle, '.app-header__rename:hover {').includes('opacity: 1'), 'hover 规则漂移（应零改动）');
});

console.log('\n=== B6-6 · 侧栏搜索框 aria-label 逐字（含「按 / 聚焦」提示） ===');

check('B6-6 搜索框 aria-label="搜索会话标题（按 / 聚焦）" 且 placeholder/搜索行为链零改动', () => {
  const inputIdx = sidebar.indexOf('class="sidebar__search"');
  assert.ok(inputIdx > -1, '缺侧栏搜索框');
  const tag = sidebar.slice(inputIdx, sidebar.indexOf('/>', inputIdx));
  assert.ok(tag.includes('aria-label="搜索会话标题（按 / 聚焦）"'), '搜索框 aria 逐字漂移');
  assert.ok(tag.includes('placeholder="搜索会话标题"'), 'placeholder 漂移');
  assert.ok(tag.includes('@input="onSearchInput"') && tag.includes('@search="handleSearchClear"'), '搜索行为链漂移');
});

console.log('\n=== B6-7 · 新会话钮 ink 主按钮（A2 定稿 token 回填：--color-btn-ink / --color-on-btn-ink） ===');

check('B6-7a 底/字接 A2 ink token 对 + border 透明占位（--active 描边可渲染）', () => {
  const blk = cssBlock(sidebar, '.new-button {');
  assert.ok(blk.includes('background: var(--color-btn-ink);'), '新会话钮底未接 --color-btn-ink（A2 定稿名）');
  assert.ok(blk.includes('color: var(--color-on-btn-ink);'), '新会话钮字未接 --color-on-btn-ink');
  assert.ok(blk.includes('border: 1px solid transparent;'), 'border 未改透明占位（--active 态 border-color 不可渲染）');
});
check('B6-7b hover 提亮 = btn-ink 86% ⊕ on-btn-ink 混色（token 语义；切旧板回退自动成立）', () => {
  const blk = cssBlock(sidebar, '.new-button:hover {');
  assert.ok(blk.includes('color-mix(in srgb, var(--color-btn-ink) 86%, var(--color-on-btn-ink))'), 'hover 提亮非 ink token 混色');
});
check('B6-7c 切片负断言：新钮样式区（.new-button { → .update-badge）零硬编码 hex（R2.13 同口径）', () => {
  const from = sidebar.indexOf('.new-button {');
  const to = sidebar.indexOf('.update-badge', from);
  assert.ok(from > -1 && to > from, '切片界漂移');
  const hexes = sidebar.slice(from, to).match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `新钮样式切片含硬编码色值：${hexes.join(', ')}`);
});
check('B6-7d 模板内容保全：「新会话」/「Ctrl N」/handleNewSession 接线/暂态激活类绑定逐字', () => {
  assert.ok(sidebar.includes('<span>新会话</span>'), '「新会话」文案漂移');
  assert.ok(sidebar.includes('<kbd>Ctrl N</kbd>'), 'kbd「Ctrl N」漂移');
  assert.ok(sidebar.includes('@click="handleNewSession"'), '点击链漂移');
  assert.ok(sidebar.includes("'new-button--active': store.activeSession?.transient"), '暂态激活类绑定漂移');
});

console.log('\n=== B6-8 · kbd 反白且暗色板可读（边界值：on-btn-ink/btn-ink token 对语义承担，A2 §2.2 全表保证两板高对比） ===');

check('B6-8 kbd 反白 token 对：字=on-btn-ink、底透明（露 btn-ink）、边框 on-btn-ink 35% 混色；负向禁回退 text-muted/color-bg', () => {
  const blk = cssBlock(sidebar, '.new-button kbd {');
  assert.ok(blk.includes('color: var(--color-on-btn-ink);'), 'kbd 字色未反白（on-btn-ink）');
  assert.ok(blk.includes('color-mix(in srgb, var(--color-on-btn-ink) 35%, transparent)'), 'kbd 边框未走 on-btn-ink 混色');
  assert.ok(blk.includes('background: transparent;'), 'kbd 背景应为透明（露 btn-ink 底）');
  assert.ok(!blk.includes('var(--color-text-muted)'), 'kbd 仍走 text-muted（ink 底上不可读）');
  assert.ok(!blk.includes('var(--color-bg)'), 'kbd 仍走 color-bg 底（反白破坏）');
});

console.log('\n=== B6-9 · 暂态激活 inset 3px accent 条（R2.7 同步值；负向 2px 残留=红） ===');

check('B6-9 .new-button--active：accent 描边 + box-shadow inset 3px 0 0 accent（暂态会话下可见）', () => {
  const blk = cssBlock(sidebar, '.new-button--active {');
  assert.ok(blk.includes('border-color: var(--color-accent);'), '缺 accent 描边');
  assert.ok(blk.includes('box-shadow: inset 3px 0 0 var(--color-accent);'), 'inset 条漂移（应为 3px accent）');
  assert.ok(!blk.includes('inset 2px'), 'inset 2px 残留（R2.7 未同步）');
});

console.log('\n=== B6-10 · 品牌区防倒退钉（更新徽标/品牌行/「当前会话」eyebrow 三锚独立记账 + 分享矩阵在场钉） ===');

check('B6-10a 品牌行锚：<h1>Claude Link</h1> + brand-mark 方标原位', () => {
  assert.ok(sidebar.includes('<h1>Claude Link</h1>'), '品牌行 h1 被删');
  assert.ok(sidebar.includes('class="brand-mark"'), 'CL 方标被删');
});
check("B6-10b 更新徽标锚：testid + title 模板逐字 + 「可更新」文案（D1-13 保留真实现状）", () => {
  assert.ok(sidebar.includes('data-testid="update-badge"'), '徽标 testid 被删');
  assert.ok(sidebar.includes("`发现新版本 v${updateStore.state.newVersion ?? ''}，点击查看`"), '徽标 title 模板漂移');
  assert.ok(sidebar.includes('>可更新</button>'), '徽标文案被删');
});
check('B6-10c eyebrow 锚：「当前会话」label 原位（D1 裁决⑤保留真实）', () => {
  assert.ok(headerTpl.includes('<p class="app-header__label">当前会话</p>'), 'eyebrow 被删');
});
check('B6-10d 分享钮 disabled 矩阵在场钉（红线：B6 不触碰 share 家族——disabled/busy/done 三态锚）', () => {
  assert.ok(headerTpl.includes(':disabled="!canExport"'), '分享钮 disabled 矩阵被碰');
  assert.ok(headerTpl.includes("'app-header__share--busy': exportStore.running"), 'busy 类漂移');
  assert.ok(headerTpl.includes("'app-header__share--done': exportStore.phase === 'done'"), 'done 类漂移');
});

console.log(`\n[B 布局侧栏契约 · B1+B2+B3+B4+B5+B6] 通过 ${pass} / 失败 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
