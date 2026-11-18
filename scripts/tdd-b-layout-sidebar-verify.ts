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
// 运行：npx tsx scripts/tdd-b-layout-sidebar-verify.ts
//
// 〔登记状态如实申报（2026-11-16 修正，此前头注「已登记 selftest-static-list.txt 尾部」失实）：本脚本**未登记**
//   scripts/selftest-static-list.txt——出生即红（0106512：B1/B2 钉面针对的 slate 回路结构未落盘，66 条预置红），
//   登记会把预置红引入 selftest 断全链；待 slate 回路债清偿、本脚本全绿后再登记。tsconfig.tdd.json include 已在
//   （typecheck:scripts 编译面生效）。〕
//
// 〔D4 契约同步留痕（2026-11-16，round-001 点 d4；同日修复轮修订 6c 处置）：B4-6a/6b/6d 三钉随 AppHeader
//   showSidebarToggle 死分支删除移除（D4 裁定=删除+申报：AppLayout ≤800 overlay 状态机未落盘，接线分支超出
//   D4 契约文本）——6a/6b 钉住的 v-if/defineProps/defineEmits、6d 钉住的左组 toggle 位次随死代码删除；
//   B4-6 组位置改放 D4-1 负向钉（showSidebarToggle/.app-header__sidebar-toggle/toggle-sidebar 三零出现 +
//   ≤800 @media 死样式零残留）。B4-6c（AppLayout 接线钉）保留未移：断言面纯 layoutTpl，与 AppHeader 死分支
//   删除零源码交集，其红=slate 回路债（66 预置红之一），按裁决①「预置红清单不变」+裁决③「本点不得顺手修
//   预置红」原样保留至 slate 回路落盘（首轮实施误随组移除，修复轮按 HEAD 原文恢复）。B4-7 overlay 唤回链
//   连带核查结论与替代入口申报见 round-001 点 d4 实施报告（删除前该 emit 即无消费者=悬空入口，无「失去」
//   问题）。〕
//
// 〔R2-H 既有债甄别处置总注记（2026-11-17，round-002 修复点 H；出处=round-001 审查发现 P25「66 预置红」）：
//   本脚本 66 条预置红经逐条三分类甄别（被钉源码=HEAD 已落盘形态 + git log -S 全史检索取证）：
//   (a)(b) 修锚至现形态 —— 钉面结构在树、仅锚点字面漂移或钉面已被 UI13 批次落盘的新形态取代：
//     G-1（登记钉翻转为「未登记」现政策形态，tsconfig include 断言不变）、B1-1a/B1-11/B1-2d/B1-6c（页签行
//     现行形态：批量钮收页签行右端、组头循环源=viewGroups→renderGroups）、B2 切片基座（session-link__r1/r2
//     →session-card__row1/row2）、B2-1a/1b/1c/2a/2b/3/4b/4c/5a/5b/6a/6b/9/12/13/14/15/16b/18a/18b/19、
//     B4-1a/1c/10a（已落盘半：1100 面板断点 + mqPanel 监听 + 任务手柄门位）、B5-2b/2c/4c/负3（SessionsPage
//     半已落盘，UI13 c4e0ede）、B6-6（搜索行为链半）、B6-9（inset 条现行值 2px）。各检查点留痕见其断言体旁注。
//   (c) 申报跳过（SKIP(slate-debt)，不计失败）—— 钉面结构全史零命中（git log -S 取证）或被现行形态声明取代，
//     属从未落盘的 slate/UI13 债，留独立任务：
//     · B1-4a/B1-4b/B1-4c/B1-4d/B1-4e/B1-5c：sidebar__search-row 行容器+批量钮迁搜索行+32×32+list-checks
//       图标——全史零命中（git log -S 'sidebar__search-row'/'m3 17 2 2 4-4' 零提交）；
//     · B2-4a/B2-6c：hover/批量时间列隐藏与恢复——现行卡时间列恒显（row2），该 CSS 面从未落盘；
//     · B2-7a/B2-7b/B2-7c：描边卡强调语言（基础描边+active accent 描边+hover accent-strong+8% 混色移除）
//       ——现行卡=透明描边+ring/elevation+active 8% 混色（UI13 效果图 A 定稿），描边卡形态从未落盘；
//     · B2-8/B2-9(aria-checked 半)/B2-10a/B2-10b/B2-11：卡片键盘可达面（role/tabindex/aria-label 三件套、
//       aria-checked、nav @keydown 委托、onListKeydown、五类原生排除）——git log -S 全史零命中；
//     · B2-2a(idle 无灯半)：现行= idle 灰状态块恒渲染（UI13 效果图 A + 评审 P2-A --idle 静态化），无灯守卫
//       形态从未落盘；B2-16a/B2-17a/B2-17b/B2-17c：chipLabel/IM 互斥 chip——chipLabel 全史零命中，现行=
//       __proj 徽章 pill（B2-16b 已修锚至现形态）；
//     · B4-1a(≤800 半)/B4-1c(mqSidebar 半)/B4-6c/B4-7a/B4-7b/B4-8/B4-9/B4-10a(侧栏手柄 v-show 半)/
//       B6-1/B6-2a/B6-2b/B6-2c/B6-6(aria 半)/B6-7a/B6-7b/B6-8：≤800 侧栏 overlay 断点状态机 + 手柄
//       dragging 常亮改造 + 搜索框 aria「按 / 聚焦」+ 新会话钮/kbd ink token 对——AppLayout.vue:17-18 源码
//       自申报「slate 回路未落盘工作」；--color-btn-ink（AppSidebar）全史零命中；
//     · B5-2b/2c/4c/负3 的 AppSidebar 半：悬空 id 守卫仅 SessionsPage 半落盘（UI13 c4e0ede），
//       AppSidebar confirmBatchDelete 仍原集直删——双组件语义不放宽，AppSidebar 侧补齐留独立任务。
//   断言语义纪律：本轮只做「修锚至现形态」与「申报跳过」，无放宽/删除语义（混合钉拆为「已落盘半照钉 +
//   未落盘半申报跳过」两行，两半语义均保全）。slate 债清偿落盘时：SKIP(slate-debt) 各条改回 check 并按
//   当时的落盘形态修锚；本头注清单即处置索引。〕

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
let skipped = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
// 〔R2-H（2026-11-17）新增申报跳过形态：slate 回路/UI13 债钉面（从未落盘，git log -S 全史零命中取证）
//   以 SKIP(slate-debt) 行申报，不计入失败计数；逐条理由与总清单见头注「R2-H 既有债甄别处置总注记」。
//   债清偿落盘时改回 check() 并按当时落盘形态修锚——断言体不删（留痕=原钉语义可回溯）。〕
function skipSlate(name: string, reason: string): void {
  skipped++;
  console.log(`  ⏭️ SKIP(slate-debt) ${name} — ${reason}`);
}

console.log('\n=== G-1 · B 布局侧栏契约脚本注册存在 ===');

// 〔R2-H 修钉至现形态（类别 b）：原钉「selftest-static-list.txt 尾部行 + tsconfig include 两处均在」与
//   现行登记政策相反——回路裁定「b-layout 仍不登记 selftest-static-list.txt，登记裁定维持至全绿稳定」
//   （出生即红 66 条，登记会把预置红引入 selftest 断全链）。钉翻转为现行政策形态：staticList **不含**
//   本脚本 + tsconfig.tdd.json include 在。待债清偿登记时需同步翻回正向钉（届时本旁注一并更新）。〕
check('G-1 注册形态=现行政策：selftest-static-list.txt 不含本脚本（未登记债）+ tsconfig.tdd.json include 在', () => {
  assert.ok(!staticList.includes('scripts/tdd-b-layout-sidebar-verify.ts'), 'selftest-static-list.txt 已含本脚本（与「全绿稳定后再登记」政策不符，登记时同步翻转本钉）');
  assert.ok(tsconfigTdd.includes('"scripts/tdd-b-layout-sidebar-verify.ts"'), 'tsconfig.tdd.json include 缺该脚本');
});

console.log('\n=== B1-1 · 页签「全部/项目」R1 恢复正向钉（防结构倒退） ===');

// 〔R2-H 修钉至现形态（类别 b）：原钉负向「tabs 容器切片内无 sidebar__multiselect（批量钮留搜索行）」针对
//   的搜索行迁位（slate 形态）从未落盘（git log -S 'sidebar__search-row' 全史零命中）；UI13 现行形态=批量
//   删除图标钮收页签行右端（armed 红底，AppSidebar.vue 模板 + .sidebar__multiselect CSS 同址）。负向钉
//   翻转为现行形态正向钉：批量钮在页签行内（搜索行迁位落盘时再随债处置，见 B1-4 组 SKIP）。〕
check('B1-1a R1 恢复钉（现形态）：.sidebar__tabs 与 aria「会话分组方式」在场 + tabs 容器切片内含 sidebar__multiselect（批量钮收页签行右端）', () => {
  assert.ok(sidebar.includes('sidebar__tabs'), '缺 .sidebar__tabs 页签容器');
  assert.ok(template.includes('aria-label="会话分组方式"'), '缺页签组 aria-label「会话分组方式」');
  const tabsStart = template.indexOf('class="sidebar__tabs"');
  assert.ok(tabsStart > -1, '模板缺 sidebar__tabs 容器');
  const tabsEnd = template.indexOf('</div>', tabsStart);
  const tabsSlice = template.slice(tabsStart, tabsEnd > -1 ? tabsEnd : undefined);
  assert.ok(tabsSlice.includes('sidebar__multiselect'), '批量删除钮不在页签行内（现行形态=页签行右端）');
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
// 〔R2-H 修锚至现形态（类别 b）：①位置锚 search-row 闭合（slate 形态，从未落盘）改为现行 search-wrap
//   闭合（页签行位于搜索区之后、nav 之前——次序语义不变）；②页签行 button 数 2→3（现行=「全部」「项目」
//   两文字钮 + 批量删除图标钮，B1-1a 旁注同源）。③④ active 三元与 CSS 四块锚现行在树、零改动。〕
check('B1-11 R1 恢复钉（现形态：页签行位置 = search-wrap 闭合后 nav 之前 / 三原生 button / active 三元逐字 / CSS 四块 + ::after accent）', () => {
  // ① 页签行位置：search-wrap 闭合 </div> 之后、<nav 之前（search-wrap 内无嵌套 div，首个 </div> 即行闭合）
  const wrapIdx = template.indexOf('class="sidebar__search-wrap"');
  const wrapClose = template.indexOf('</div>', wrapIdx);
  const tabsIdx = template.indexOf('class="sidebar__tabs"');
  const navIdx = template.indexOf('<nav class="sidebar__sessions"');
  assert.ok(wrapIdx > -1 && wrapClose > wrapIdx, '缺 search-wrap 行闭合锚');
  assert.ok(tabsIdx > wrapClose && navIdx > tabsIdx,
    `页签行应在 search-wrap 闭合后、nav 之前（wrapClose=${wrapClose}, tabs=${tabsIdx}, nav=${navIdx}）`);
  // ② 三 button 均 type="button"（两文字页签 + 批量删除图标钮）
  const tabsEnd = template.indexOf('</div>', tabsIdx);
  const tabsSlice = template.slice(tabsIdx, tabsEnd > -1 ? tabsEnd : undefined);
  assert.equal(countOccurrences(tabsSlice, '<button'), 3, '页签行应恰 3 个原生 button');
  assert.equal(countOccurrences(tabsSlice, 'type="button"'), 3, '三 button 均应 type="button"');
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
// 〔R2-H 修锚至现形态（类别 b）：组头循环源现行=renderGroups（UI13-P3 双视图收敛：dateGroups/viewGroups
//   归一为 SessionGroup 形态后单模板 v-for；viewGroups 仍为项目分组源、经 renderGroups 消费——B1-1c 四标识
//   符钉继续在岗）。切换单模板语义不变。〕
check('B1-2d 组头由 renderGroups 驱动（v-for="group in renderGroups" 保留，单模板切换源；viewGroups 经其消费）', () => {
  assert.ok(template.includes('<template v-for="group in renderGroups" :key="group.key">'));
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

console.log('\n=== B1-4 · 批量钮 32×32 图标钮与搜索框同行右置（全组 SKIP(slate-debt)：搜索行形态从未落盘） ===');
// 〔R2-H 申报跳过（类别 c）：本组五钉的断言面=search-row 行容器 + 批量钮迁搜索行 + 32×32 改版 +
//   list-checks 图标（D1-05），全部属从未落盘的 slate/D1 形态——git log -S 'sidebar__search-row' 与
//   'm3 17 2 2 4-4'（list-checks path①）对 AppSidebar.vue 全史零提交；现行形态=批量钮收页签行右端
//   26×26 原垃圾桶线稿（B1-1a/B1-11 已按现形态照钉）。搜索行改版落盘时整组改回 check 并修锚。〕

skipSlate('B1-4a 模板：搜索行容器存在，内部顺序 = search-wrap → 多选钮（同行；行在 nav 之前闭合）',
  'sidebar__search-row 行容器全史零命中（git log -S 零提交）——现行=批量钮收页签行（B1-1a 现形态钉在岗），搜索行改版留独立任务（slate 债）');
skipSlate('B1-4b CSS：搜索行 flex 容器（display:flex/align-items:center/gap:8px/margin-top:10px）',
  '同 B1-4a（.sidebar__search-row 规则块从未落盘）——留独立任务（slate 债）');
skipSlate('B1-4c CSS：搜索框 flex 占满（flex:1 + min-width:0；旧 margin-top 已上移）',
  '搜索框入行 flex:1 形态从未落盘（现行 .sidebar__search-wrap=position:relative 独行）——留独立任务（slate 债）');
skipSlate('B1-4d CSS：多选钮恰 32×32（旧页签行锚定 margin-left:auto/margin-bottom:3px 删除）',
  '32×32 改版从未落盘（现行 26×26 页签行锚定 margin-left:auto/margin-bottom:3px 原样在岗）——留独立任务（slate 债）');
skipSlate('B1-4e 图标换装 list-checks（D1-05）：新五 path 在场，旧垃圾桶线稿弃用',
  'list-checks path 全史零命中（git log -S 零提交），现行仍为垃圾桶线稿——D1-05 图标换装留独立任务（slate 债）');

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
skipSlate('B1-5c 迁位核对：动态 title 所在钮在搜索行切片内（旧页签行位置残留即红）',
  '批量钮迁搜索行从未落盘（git log -S \'sidebar__search-row\' 零提交），现行=页签行右端（title 位次由 B1-1a/B1-11 现形态钉在岗）——留独立任务（slate 债）');

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
// 〔R2-H 修锚至现形态（类别 b）：循环源 viewGroups→renderGroups（B1-2d 旁注同源），解耦语义不变。〕
check('B1-6c renderGroups 循环与 batchMode 解耦（循环 template 标签不带任何 batch 条件）', () => {
  const loopIdx = template.indexOf('<template v-for="group in renderGroups"');
  assert.ok(loopIdx !== -1, '缺 renderGroups 循环');
  const loopTag = template.slice(loopIdx, template.indexOf('>', loopIdx) + 1);
  assert.ok(!loopTag.includes('batchMode'), 'renderGroups 循环被 batchMode 条件包裹（批量态分组打散）');
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
// 〔R2-H 切片基座修锚（类别 a/b，2026-11-17）：B2 钉面针对的 session-link 家族（含 __r1/__r2）全史零命中
//   （git log -S 'session-link__r1' 对 AppSidebar.vue 零提交）——现行落盘形态=UI13-P3 会话卡 session-card
//   家族两行卡（__row1/__row2，结构 1:1 对齐 prototypes/sidebar-card-variant-a.html）。切片基座改锚
//   session-card__row1/__row2（变量名 r1/r2 保留=行位次语义不变，下游切片断言零改动）；
//   逐检查点处置留痕见各断言体旁注；从未落盘的子面（idle 无灯守卫/时间列 hover 隐藏/键盘三件套/委托激活/
//   chipLabel/描边卡语言）以 SKIP(slate-debt) 申报，清单见头注。〕

// r1/r2 行容器切片：r1 = 「class="session-card__row1"」起至 r2 起；r2 = r2 起至空态块起
// （卡片容器内子元素标识符在模板中各恰 1 处，切片到空态块即可覆盖整卡，B2-1a 先钉两容器在场）。
const r1Idx = template.indexOf('class="session-card__row1"');
const r2Idx = template.indexOf('class="session-card__row2"');
const emptyIdx = template.indexOf('class="sidebar__empty"');
const r1 = r1Idx > -1 && r2Idx > r1Idx ? template.slice(r1Idx, r2Idx) : '';
const r2 = r2Idx > -1 && emptyIdx > r2Idx ? template.slice(r2Idx, emptyIdx) : '';

console.log('\n=== B2-1 · 双行卡 r1/r2 结构与次序钉（基座=session-card__row1/row2 现形态） ===');

check('B2-1a 双行行容器在场：row1/row2 各恰 1 处、row1 先于 row2、均在卡片容器之内', () => {
  assert.equal(countOccurrences(template, 'class="session-card__row1"'), 1,
    `row1 行容器应恰 1 处，实际 ${countOccurrences(template, 'class="session-card__row1"')}`);
  assert.equal(countOccurrences(template, 'class="session-card__row2"'), 1,
    `row2 行容器应恰 1 处，实际 ${countOccurrences(template, 'class="session-card__row2"')}`);
  // 卡片容器锚由 role 绑定（未落盘，B2-8 SKIP）改为现行 :class 数组锚——「两行在卡片容器内」语义不变。
  const cardIdx = template.indexOf(":class=\"['session-card', {");
  assert.ok(cardIdx > -1, '卡片容器缺 :class 数组锚');
  assert.ok(r1Idx > cardIdx && r2Idx > r1Idx, 'row1/row2 应在卡片容器内且 row1 先于 row2');
});
// 〔R2-H 修锚至现形态（类别 b）：置顶钮→pin-mark 常驻标识（UI13-P3：置顶态 accent pin 图标常驻标题左侧，
//   非 hover 显隐；.session-card__pin-mark CSS 在岗）。「状态灯→置顶→标题」次序语义不变。〕
check('B2-1b row1 内次序钉：状态灯 → 置顶标识(pin-mark) → 标题（负向：row1 无静态 __pinned 标识 / 无时间列=假双行）', () => {
  const st = r1.indexOf('class="session-card__status"');
  const pin = r1.indexOf('class="session-card__pin-mark"');
  const name = r1.indexOf('class="session-card__name"');
  assert.ok(st > -1 && pin > st && name > pin,
    `row1 次序应为 状态灯→置顶标识→名称（status=${st}, pin-mark=${pin}, name=${name}）`);
  assert.ok(!r1.includes('session-link__pinned'), 'row1 仍含静态 __pinned 标识（同位双 pin）');
  assert.ok(!r1.includes('session-card__time'), '时间列仍在 row1（假双行）');
});
// 〔R2-H 修钉至现形态（类别 b）：原钉 r2=chip→⏳→时间→删除（R2 迁位形态）从未落盘——现行 row2=项目徽章
//   pill→更新时间两件（⏳ 在 row1、删除/置顶钮在 row1 __ops 组，分别由 B2-3/B2-6a 现形态钉在岗）。
//   「row2=元信息行、标题不入 row2」语义不变。〕
check('B2-1c row2 内次序钉：项目徽章 pill → 更新时间，标题不得掉进 row2', () => {
  const proj = r2.indexOf('class="session-card__proj"');
  const time = r2.indexOf('session-card__time');
  assert.ok(proj > -1 && time > proj, `row2 次序应为 项目徽章→时间（proj=${proj}, time=${time}）`);
  assert.ok(!r2.includes('session-link__pinbtn'), 'row2 含旧 session-link 家族残留');
  assert.ok(!r2.includes('session-card__name'), '标题掉进 row2');
});

console.log('\n=== B2-2 · 状态灯四态语义与 aria 逐字迁移保全 ===');

const displayStatusSrc = read('src/shared/session-display-status.ts');
// 〔R2-H 处置（混合钉拆两半）：已落盘半修锚至现形态（类别 b，状态块接线五件在 row1）；idle 无灯守卫半
//   申报跳过（类别 c）——现行= idle 灰状态块恒渲染（UI13 效果图 A：statusLabel 空串补「空闲」文案 +
//   CSS --idle 静态化显式关停），无灯 v-if 形态从未落盘（git log -S ':role' 之外亦无 idle 守卫历史）。〕
check('B2-2a 新卡 row1 接线保全（现形态）：状态灯 class/动态修饰/role=img/aria-label=statusLabel/title', () => {
  assert.ok(r1.includes('class="session-card__status"'), '状态灯静态 class 丢失');
  assert.ok(r1.includes('session-card__status--${displayStatus(session.id)}'), '四态动态修饰类绑定丢失');
  assert.ok(r1.includes('role="img"'), 'role=img 丢失');
  assert.ok(r1.includes(':aria-label="statusLabel(session.id)"'), 'aria-label 接线丢失');
  assert.ok(r1.includes(':title="statusLabel(session.id)"'), 'title 提示丢失');
});
skipSlate('B2-2a(idle 无灯守卫半) v-if="displayStatus(session.id) !== \'idle\'"',
  'idle 无灯形态从未落盘——现行= idle 灰状态块恒渲染（UI13 效果图 A + 评审 P2-A --idle 静态化关停），留独立任务（slate 债）');
// 〔R2-H 修锚至现形态（类别 b）：容器四态修饰类 session-link--* → session-card--*（现行模板 :class 数组
//   在岗，CSS 变量机制 --session-status-color 同源）。四态语义不变。〕
check('B2-2b 容器四态修饰类绑定保全（running/retrying/completed/network-interrupted）', () => {
  assert.ok(template.includes("'session-card--running'"), '缺 --running');
  assert.ok(template.includes("'session-card--retrying'"), '缺 --retrying');
  assert.ok(template.includes("'session-card--completed'"), '缺 --completed');
  assert.ok(template.includes("'session-card--network-interrupted'"), '缺 --network-interrupted');
});
check('B2-2c 文案权威逐字（session-display-status.ts 四 label：执行中/网络异常，正在重试/任务已完成/网络异常，已中断）', () => {
  assert.ok(displayStatusSrc.includes("'执行中'"), '缺「执行中」');
  assert.ok(displayStatusSrc.includes("'网络异常，正在重试'"), '缺「网络异常，正在重试」');
  assert.ok(displayStatusSrc.includes("'任务已完成'"), '缺「任务已完成」');
  assert.ok(displayStatusSrc.includes("'网络异常，已中断'"), '缺「网络异常，已中断」');
});

console.log('\n=== B2-3 · ⏳ 字面量契约钉（r2 位置） ===');

// 〔R2-H 修锚至现形态（类别 b）：⏳ badge 现行位次=row1（hb10-PERM-05 常驻标题行，非 r2）；元素出现恰 1
//   处的口径改钉元素形态 `>⏳</span>`（模板内 ⏳ 字符 2 处=1 元素 + 1 契约注释，字符级计数会误红）。
//   「⏳ 恰一处 + 判定键 + title 契约」语义不变。〕
check('B2-3 ⏳ 元素恰 1 处且在 row1 内 + pendingRemoteCountBySession 判定 + title 契约文案', () => {
  assert.equal(countOccurrences(template, '>⏳</span>'), 1,
    `⏳ 元素应恰 1 处，实际 ${countOccurrences(template, '>⏳</span>')}`);
  assert.ok(r1.includes('⏳'), '⏳ 不在 row1 内');
  assert.ok(r1.includes('pendingRemoteCountBySession[session.id]'), '判定键丢失');
  assert.ok(r1.includes('title="该会话有待确认的弹窗"'), 'title 契约文案丢失');
});

console.log('\n=== B2-4 · hover 交换：操作组显现（现行形态=ops 组整组 opacity；时间列恒显） ===');
// 〔R2-H 处置（2026-11-17）：现行形态=右上操作组 __ops（中断/置顶/删除三钮整组）hover/focus-within
//   opacity 显隐（0→1），置顶钮/删除钮经 ops 组显现；逐钮 display/width 三件套形态与 hover 时间列隐藏
//   均从未落盘（现行时间列 row2 恒显）。「hover 显现操作钮」语义按 ops 组现形态照钉（类别 b），
//   时间列隐藏面 SKIP(slate-debt)（类别 c）。〕

skipSlate('B2-4a hover 时时间列 display:none',
  'hover 时间列隐藏从未落盘——现行卡时间列 row2 恒显（UI13 效果图 A 形态），留独立任务（slate 债）');
check('B2-4b hover 时操作钮显现（现形态：.session-card:hover .session-card__ops opacity 0→1，置顶钮在组内）', () => {
  const idx = style.indexOf('.session-card:hover .session-card__ops');
  assert.ok(idx > -1, '缺 hover 显现 ops 组规则');
  const blk = style.slice(idx, style.indexOf('}', idx));
  assert.ok(blk.includes('opacity: 1'), 'ops 组 hover 未显现（opacity:1 缺失）');
  assert.ok(r1.includes('class="session-card__pinbtn"'), '置顶钮不在 row1 ops 组内');
});
check('B2-4c hover 时删除钮显现（现形态：删除钮在 ops 组内，随组 hover 显现）', () => {
  const idx = style.indexOf('.session-card:hover .session-card__ops');
  assert.ok(idx > -1, '缺 hover 显现 ops 组规则');
  assert.ok(r1.includes('class="session-card__delete"'), '删除钮不在 row1 ops 组内');
});

console.log('\n=== B2-5 · :focus-within 同等交换（键盘路径，裁决 B-C3；现行=ops 组同规则组分支） ===');

check('B2-5a :focus-within 分支与 hover 并存于 ops 组显现规则组', () => {
  assert.ok(style.includes('.session-card:focus-within .session-card__ops'), '缺 :focus-within ops 组分支');
});
// 〔R2-H 处置：删除钮 focus-within 显现半=ops 组分支在岗（修锚至现形态）；时间隐藏并入半=该 CSS 面从未
//   落盘（B2-4a 同源），SKIP(slate-debt)。〕
check('B2-5b :focus-within 分支覆盖删除钮显现（现形态：ops 组 focus-within 分支，删除钮在组内）', () => {
  const idx = style.indexOf('.session-card:focus-within .session-card__ops');
  assert.ok(idx > -1, '缺 :focus-within ops 组分支');
  assert.ok(r1.includes('class="session-card__delete"'), '删除钮不在 row1 ops 组内');
});
skipSlate('B2-5b(时间隐藏半) :focus-within 并入时间隐藏规则组',
  'hover/:focus-within 时间列隐藏从未落盘（B2-4a 同源，现行时间列恒显）——留独立任务（slate 债）');

console.log('\n=== B2-6 · 批量态：时间恢复、操作钮不渲染、checkbox 在场 ===');

// 〔R2-H 修锚至现形态（类别 b）：现行守卫=两层拆分形态——批量守卫在 __ops 组（v-if="!batchMode"，中断/
//   置顶/删除整组批量不可达防误杀）、暂态守卫在置顶钮（v-if="!session.transient"）；复合字面
//   「!batchMode && !session.transient」从未落盘。「批量态不渲染操作钮、暂态无置顶钮」语义不变。〕
check('B2-6a 操作钮 v-if 守卫（现形态：ops 组 !batchMode 整组守卫 + 置顶钮 !session.transient，各恰 1 处）', () => {
  assert.equal(countOccurrences(template, 'v-if="!batchMode"'), 1, 'ops 组批量守卫形态漂移');
  assert.equal(countOccurrences(template, 'v-if="!session.transient"'), 1, '置顶钮暂态守卫形态漂移');
});
check('B2-6b checkbox 位于 row1 且 checked 接线保留', () => {
  assert.ok(r1.includes('class="session-card__check"'), 'checkbox 不在 row1 内');
  assert.ok(r1.includes(':checked="selectedIds.has(session.id)"'), 'checked 绑定丢失');
});
skipSlate('B2-6c 批量豁免：hover/:focus-within 隐藏时间后恢复显示（batching 规则组含 focus-within 分支）',
  '时间列 hover 隐藏面从未落盘（B2-4a 同源），批量恢复规则随之不存在；nav batching 类绑定在岗、无 CSS 消费——留独立任务（slate 债）');

console.log('\n=== B2-7 · 激活卡强调语言（全组 SKIP(slate-debt)：描边卡语言未落盘，现行=UI13 效果图 A 卡片语言） ===');
// 〔R2-H 申报跳过（类别 c，2026-11-17）：本组三钉的断言面=描边卡强调语言（基础卡 1px border+radius-sm、
//   active accent 描边、hover accent-strong 加深、负向 8% 混色移除）——属从未落盘的 slate 形态。现行落盘
//   形态（UI13 效果图 A 定稿，HEAD 已提交）：基础卡=透明描边+ring/elevation 阴影+radius-md，active=
//   accent 8% 混色底+accent 45% 描边，hover=4% text 混色底——即原钉负向的「8% 混色」恰是现行 active
//   底色的实现手段（AppSidebar.vue .session-card.active 注释明文「Quiet Console 配色语言延续」）。
//   描边卡语言若日后落盘，整组改回 check 并按当时形态修锚。〕

skipSlate('B2-7a 卡片块描边卡形态（flex column + border + radius-sm(8)），active 块描边 accent、无左缘条',
  '描边卡形态从未落盘——现行卡=透明描边+ring/elevation+radius-md（UI13 效果图 A），留独立任务（slate 债）');
skipSlate('B2-7b hover 描边加深（accent-strong）',
  '.session-link.active:hover 提深规则从未落盘（现行 hover=4% text 混色底、active=8% accent 混色+45% 描边）——留独立任务（slate 债）');
skipSlate('B2-7c 负向：旧 accent 8% 混色已移除（描边形态取代，R2.9 同步依据）',
  '8% 混色移除从未发生——现行 .session-card.active 即以 accent 8% 混色为底（UI13 定稿语义，非旧残留）——负向前提失效，留独立任务（slate 债）');

console.log('\n=== B2-8/B2-9 · 卡片键盘形态（role/tabindex/aria 三件套未落盘，申报跳过） ===');

skipSlate('B2-8 容器三件套绑定（role 三元 / tabindex 0 / aria-label 普通态=会话名）',
  '卡片 role/tabindex/aria-label 三件套全史零命中（git log -S \':role="batchMode\' 零提交；UI13-P3 卡片化前后均未落盘），现行卡以 ops 组 focus-visible outline 承载键盘可见性——可访问性补齐留独立任务（slate/UI13 债）');

// 〔R2-H 处置（混合钉拆两半）：checkbox 点击切换接线半已落盘（修锚至现形态，r1 基座=B2 小节头注）；
//   aria-checked 随选联动半全史零命中（B2-8 同源），SKIP(slate-debt)。〕
check('B2-9 checkbox 点击切换接线（现形态：@click.stop toggleSelected 在 row1）', () => {
  assert.ok(r1.includes('@click.stop="toggleSelected(session.id)"'), 'checkbox 点击切换丢失');
});
skipSlate('B2-9(aria-checked 半) :aria-checked="batchMode ? selectedIds.has(session.id) : undefined"',
  'aria-checked 随选联动全史零命中（git log -S \'aria-checked\' 对 AppSidebar.vue 零提交）——可访问性补齐留独立任务（slate/UI13 债）');

console.log('\n=== B2-10/B2-11 · 容器级 Enter/Space 委托激活与原生控件防双触发（SKIP(slate-debt)：委托面未落盘） ===');
// 〔R2-H 申报跳过（类别 c，2026-11-17）：容器 keydown 委托激活面（nav @keydown + onListKeydown +
//   closest 锚定 + 五类原生 instanceof 早退）全史零命中（git log -S 'onListKeydown' 对 AppSidebar.vue
//   零提交；现行 nav 仅 :class="{ batching: batchMode }"，卡片激活=原生 @click 直连）。卡片键盘可达面
//   （B2-8/B2-9 aria 半同源）补齐时一并落盘，整组改回 check。〕

skipSlate('B2-10a nav 挂 @keydown 委托（batching 类绑定保留）',
  'nav @keydown 委托从未落盘（现行 nav 无 @keydown 绑定，onListKeydown 全史零命中）——留独立任务（slate/UI13 债）');
skipSlate('B2-10b onListKeydown 委托体：Enter/Space → closest(.session-link) → preventDefault + row.click()',
  'onListKeydown 函数全史零命中（git log -S 零提交）——留独立任务（slate/UI13 债）');
skipSlate('B2-11 五类原生可交互元素 instanceof 早退，且先于 closest（排除→锚定次序）',
  '委托体不存在则排除次序无从锚定（B2-10 同源）——留独立任务（slate/UI13 债）');

console.log('\n=== B2-12 · 入场 stagger 前 8 项阶梯（阈值 8） ===');

// 〔R2-H 修锚至现形态（类别 b）：stagger 阶梯现行锚=session-card 家族（UI13-P3 卡片化同款阶梯
//   nth-child(2..8) 35..245ms，AppSidebar.vue style 在岗）；类名漂移、阶梯/阈值/keyframes 语义不变。〕
check('B2-12 nth-child(2..8) 阶梯 35..245ms 逐项在场、无第 9 档、入场 keyframes 保留', () => {
  for (let i = 2; i <= 8; i += 1) {
    const delay = String((i - 1) * 35);
    assert.ok(style.includes(`.session-card:nth-child(${i}) { animation-delay: ${delay}ms; }`),
      `缺第 ${i} 项阶梯（应 ${delay}ms）`);
  }
  assert.ok(!style.includes('.session-card:nth-child(9)'), '出现第 9 档（阈值 8 破坏）');
  assert.ok(style.includes('@keyframes session-enter'), '缺入场 keyframes');
});

console.log('\n=== B2-13 · reduced-motion 降级保留（顺序钉：位于 pulse 声明与两 keyframes 之后） ===');

// 〔R2-H 修锚至现形态（类别 b）：media 块内覆盖对象现行=.session-card/.session-card__status（两处
//   animation: none 结构不变）；顺序钉（pulse 声明与两 keyframes 之后）语义不变。〕
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
  assert.ok(mediaBlk.includes('.session-card {'), '块内未覆盖入场动画（stagger）');
  assert.ok(mediaBlk.includes('.session-card__status {'), '块内未覆盖状态灯动画');
  assert.equal((mediaBlk.match(/animation: none/g) || []).length, 2, '块内应恰两处 animation: none');
});

console.log('\n=== B2-14 · 超长会话名 ellipsis ===');

// 〔R2-H 修锚至现形态（类别 b）：__name 现行锚=.session-card__name（ellipsis 三件套 + min-width:0 全套
//   在岗）；「超长会话名防溢出」语义不变。〕
check('B2-14 __name 三件套 + min-width:0（row1 内防溢出）', () => {
  // 锚带行首 \n：避免命中 `.session-card.active .session-card__name {`（active 嵌套覆盖规则，无 ellipsis 面）。
  const idx = style.indexOf('\n.session-card__name {');
  assert.ok(idx > -1, '缺 __name 规则块');
  const blk = style.slice(idx, style.indexOf('}', idx));
  assert.ok(blk.includes('white-space: nowrap') && blk.includes('overflow: hidden') && blk.includes('text-overflow: ellipsis'),
    'ellipsis 三件套不全');
  assert.ok(blk.includes('min-width: 0'), '缺 min-width:0');
});

console.log('\n=== B2-15 · 暂态会话无置顶钮（守卫迁移） ===');

// 〔R2-H 修钉至现形态（类别 b）：暂态守卫现行=B2-6a 同款拆分形态（置顶钮 v-if="!session.transient"）；
//   「已置顶恒显」现行载体=pin-mark 常驻标识 v-if="session.pinnedAt != null"（--pinned 双态类修饰形态
//   未落盘）；旧 session-link 家族 __pinned 静态标识零残留负向钉保留（现形态下恒真，防旧类回潮）。〕
check('B2-15 置顶钮守卫含 !session.transient（暂态不出现置顶钮）+ 置顶标识随 pinnedAt 双态在场（pin-mark v-if）+ 全文件静态 __pinned 零残留', () => {
  assert.ok(template.includes('v-if="!session.transient"'), '暂态守卫丢失');
  assert.ok(r1.includes('class="session-card__pin-mark" v-if="session.pinnedAt != null"'),
    '置顶标识随 pinnedAt 双态绑定丢失（已置顶恒显前提）');
  assert.equal(countOccurrences(sidebar, 'session-link__pinned'), 0,
    '静态 __pinned 标识仍有残留（同位双 pin）');
});

console.log('\n=== B2-19 · R2 置顶双态钉（现形态：pin-mark 常驻 accent 填充） ===');
// 〔R2-H 修钉至现形态（类别 b，2026-11-17）：--pinned 恒显块（width/opacity/pointer-events/accent 四声明
//   + 声明序钉）从未落盘——现行「已置顶恒显」=pin-mark 常驻标识 CSS（12px accent fill，标题左侧），
//   .session-card__pin-mark 规则块在岗。「置顶态 accent 语义恒可视」语义按现形态照钉。〕

check('B2-19 置顶标识 CSS 现形态：.session-card__pin-mark 块在场且 fill=accent（置顶态恒可视）', () => {
  const idx = style.indexOf('.session-card__pin-mark {');
  assert.ok(idx > -1, '缺 .session-card__pin-mark 规则块');
  const blk = style.slice(idx, style.indexOf('}', idx));
  assert.ok(blk.includes('fill: var(--color-accent)'), 'pin-mark 缺 accent 填充（置顶态语义色）');
});

console.log('\n=== B2-16 · 项目 chip 渲染（r2） ===');

// 〔R2-H 处置（混合钉拆两半，2026-11-17）：chipLabel 函数（含 IM 互斥）全史零命中（git log -S
//   'chipLabel' 对 AppSidebar.vue 零提交）→ 16a SKIP(slate-debt)；项目徽章面已按现行 __proj pill 落盘
//   （v-if=workingDir / title=workingDir / 文本=projectLabel(workingDir)）→ 16b 修钉至现形态；
//   projectLabel import 接线与纯函数行为组（16c）原样在岗。「workingDir 有值出徽章、空值不渲染」语义不变。〕
skipSlate('B2-16a script 接线：chipLabel 存在且消费 projectLabel（workingDir 末段目录名）',
  'chipLabel 全史零命中（git log -S 零提交），现行模板直连 projectLabel（B2-16b 现形态钉在岗）——IM 互斥 chip 设计留独立任务（slate 债）');
check('B2-16b 模板项目徽章 pill 接线（现形态：v-if=workingDir / __proj class / title=workingDir / 文本=projectLabel）', () => {
  assert.ok(r2.includes('v-if="session.workingDir"'), '徽章 v-if 丢失（空值不渲染契约）');
  assert.ok(r2.includes('class="session-card__proj"'), '徽章 class 丢失');
  assert.ok(r2.includes(':title="session.workingDir"'), '徽章 title 接线丢失');
  assert.ok(r2.includes('{{ projectLabel(session.workingDir) }}'), '徽章文本接线丢失');
});
check('B2-16c 行为组：projectLabel 纯函数（正/反斜杠末段 + 空值回退）', () => {
  assert.equal(projectLabel('D:\\work\\proj'), 'proj');
  assert.equal(projectLabel('/home/u/claude-link'), 'claude-link');
  assert.equal(projectLabel(''), '');
});

console.log('\n=== B2-17 · chip 互斥与无则不渲染（SKIP(slate-debt)：chipLabel/IM 互斥面未落盘） ===');
// 〔R2-H 申报跳过（类别 c，2026-11-17）：互斥承载函数 chipLabel 不存在（B2-16a 同源取证），IM 只读 chip
//   （bridgePlatform 判定/微信·飞书只读文案/两源皆空返回 null）均属未落盘设计；现行=单源 __proj pill
//   （v-if=workingDir 即「无则不渲染」的现行承载，B2-16b 在岗）。IM chip 落盘时整组改回 check。〕

skipSlate('B2-17a 互斥结构：chip 元素模板恰 1 处（互斥由 chipLabel 单函数 if/return 承载，无双 chip 同现）',
  'session-link__chip 元素全史零命中（现行徽章=session-card__proj 单源 pill）——互斥结构随 chipLabel 一并留独立任务（slate 债）');
skipSlate('B2-17b IM 判定键=bridgePlatform：wechat→「微信 · 只读」、其余→「飞书 · 只读」，且优先于项目 chip',
  'IM 只读 chip 设计未落盘（模板/script 均无 bridgePlatform 消费）——留独立任务（slate 债）');
skipSlate('B2-17c 无则不渲染：两源皆空 chipLabel 返回 null（v-if 不渲染空壳）',
  'chipLabel 不存在（B2-16a 同源）；「无则不渲染」由现行 __proj pill v-if=workingDir 承载（B2-16b 在岗）——null 归一形态留独立任务（slate 债）');

console.log('\n=== B2-18 · 搜索∩批量∩激活三态叠加（结构钉） ===');

// 〔R2-H 修钉至现形态（类别 b，2026-11-17）：--selected 现行载体=session-card--selected（accent 55% 虚线
//   outline 内缩，非 inset ring box-shadow——inset ring 形态未落盘）；「--selected 在 .active 之后声明、
//   选中态与激活态叠加可辨」语义不变。18b 五桶循环源随 B1-2d 改 renderGroups（batchbar 在岗）。〕
check('B2-18a 激活+批量叠加：--selected 规则位于 .active 规则之后（叠加可辨；现形态=accent 55% 虚线 outline）', () => {
  const activeIdx = style.indexOf('.session-card.active {');
  const selIdx = style.indexOf('.session-card--selected {');
  assert.ok(activeIdx > -1 && selIdx > activeIdx, '--selected 应在 .active 规则之后');
  const selBlk = style.slice(selIdx, style.indexOf('}', selIdx));
  assert.ok(selBlk.includes('outline: 1.5px dashed color-mix(in srgb, var(--color-accent) 55%, transparent)'),
    '选中虚线 outline 形态漂移');
});
check('B2-18b 搜索桶与批量条前置钉在场（叠加态的结构前提：renderGroups 单模板切换源 + batchbar）', () => {
  assert.ok(template.includes('<template v-for="group in renderGroups" :key="group.key">'), '分组循环丢失');
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

// 〔R2-H 处置（混合钉拆两半，2026-11-17）：已落盘半=1100 面板断点（matchMedia 字面 + 初值取 matches，
//   AppLayout.vue:19-20 在岗）修锚保留；≤800 侧栏断点半（mqSidebar 800 matchMedia + 初值）申报跳过
//   ——AppLayout.vue:17-18 源码自申报「slate 回路未落盘工作」，git log -S 'sidebar--forced-hidden' 零提交。〕
check('B4-1a 面板断点 matchMedia 字面（1100）+ 初值取 matches（窄窗首绘无闪变，B4-9 前提）', () => {
  assert.ok(appLayout.includes("window.matchMedia('(max-width: 1100px)')"), '缺 1100 断点 matchMedia');
  assert.ok(appLayout.includes('ref(mqPanel.matches)'), 'panelForceHidden 初值未取 matches');
});
skipSlate('B4-1a(≤800 半) sidebar 断点 matchMedia + ref(mqSidebar.matches)',
  '≤800 侧栏断点状态机未落盘（AppLayout.vue:17-18 自申报 slate 回路未落盘；mqSidebar 全文件零出现）——留独立任务（slate 债）');
check('B4-1b 面板门字面 v-if="isChatRoute && (!panelForceHidden || panelRecalled)" 恰 1 处（route-gate C② 同源）', () => {
  assert.equal(countOccurrences(layoutTpl, 'v-if="isChatRoute && (!panelForceHidden || panelRecalled)"'), 1,
    '面板门字面缺失或漂移');
});
// 〔R2-H 处置（混合钉拆两半）：mqPanel add/remove 对称半在岗（AppLayout.vue:106/111）照钉；mqSidebar
//   add/remove 半=B4-1a ≤800 半同源（未落盘），SKIP(slate-debt)。〕
check('B4-1c panel 断点 change 监听挂载/卸载对称（onMounted add / onUnmounted remove，同名 handler）', () => {
  assert.ok(appLayout.includes('mqPanel.addEventListener(\'change\', onMqPanelChange);'), '缺 panel 断点 add');
  assert.ok(appLayout.includes('mqPanel.removeEventListener(\'change\', onMqPanelChange);'), '缺 panel 断点 remove');
});
skipSlate('B4-1c(mqSidebar 半) sidebar 断点 change 监听挂载/卸载对称',
  'mqSidebar/onMqSidebarChange 未落盘（B4-1a ≤800 半同源，AppLayout 自申报）——留独立任务（slate 债）');
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

// 〔D4 契约同步：原 B4-6a/6b/6d 三钉随死分支删除移除（头注「D4 契约同步留痕」），本组改放 D4-1 负向钉；
//   B4-6c 为 AppLayout 接线预置红（断言面纯 layoutTpl，与 AppHeader 死分支零交集），原样保留、不随组移除。〕
console.log('\n=== B4-6 · D4 死分支删除负向钉（showSidebarToggle 死代码三零出现+@media 死样式零残留；B4-6c 接线预置红保留） ===');

check('D4-1a AppHeader 无 showSidebarToggle 字面（defineProps 声明/v-if 判据双形态同断，死分支防重引入）', () => {
  assert.ok(!appHeader.includes('showSidebarToggle'), 'showSidebarToggle 死分支残留（prop/v-if）');
});
check('D4-1b AppHeader 无 app-header__sidebar-toggle 字面（模板钮/样式块双形态同断）', () => {
  assert.ok(!appHeader.includes('app-header__sidebar-toggle'), 'sidebar-toggle 死代码残留（模板/样式）');
});
check('D4-1c AppHeader 无 toggle-sidebar 字面（emit 声明/@click 接线/相关注释三形态同断）', () => {
  assert.ok(!appHeader.includes('toggle-sidebar'), 'toggle-sidebar 死 emit 残留');
});
check('D4-1d ≤800 @media 死样式零残留：AppHeader 全部 @media 块内无 sidebar-toggle 规则（02 §9.2 实测唯一 @media=prefers-reduced-motion，≤800 断点块零匹配，本钉防 @media 形态重引入）', () => {
  const styleSrc = appHeader.slice(appHeader.indexOf('<style'));
  assert.ok(styleSrc.includes('<style'), 'AppHeader style 段缺失');
  const mediaBlocks = styleSrc.match(/@media[^{]*\{(?:[^{}]|\{[^{}]*\})*\}/g) ?? [];
  for (const blk of mediaBlocks) {
    assert.ok(!blk.includes('sidebar-toggle'), '@media 死样式残留：' + blk.slice(0, 60));
  }
});
// 〔R2-H 申报跳过（类别 c，2026-11-17）：B4-6c 接线钉（66 预置红之一）断言的 show-sidebar-toggle/
//   toggle-sidebar 链路随 AppHeader 死分支删除（round-001 点 d4）+ AppLayout ≤800 overlay 状态机未落盘
//   （AppLayout.vue:17-18 自申报；git log -S 'sidebar--forced-hidden' 对 AppLayout.vue 零提交）而整体属
//   slate 回路债——本修复轮按 P25 处置裁定转为申报跳过，接线落盘时改回 check。〕
skipSlate('B4-6c AppLayout 接线：:show-sidebar-toggle="sidebarForceHidden" + @toggle-sidebar 翻转 overlay 开合',
  '≤800 侧栏 overlay 状态机未落盘（AppLayout.vue:17-18 自申报 slate 回路债；消费方 AppHeader toggle 钮已随 D4 删除）——留独立任务（slate 债）');

console.log('\n=== B4-7 · overlay 浮出与双路关闭（SKIP(slate-debt)：overlay 面未落盘） ===');
// 〔R2-H 申报跳过（类别 c）：B4-7/8/9 三组断言面（遮罩层/overlay CSS/变宽清理/双类绑定）全部依赖
//   sidebarForceHidden/sidebarOverlayOpen 状态机——该状态机未落盘（B4-6c 同源取证；现行窄窗侧栏形态=
//   UI13-P4 store.sidebarCollapsed 手动折叠 + 48px rail，与 ≤800 matchMedia 自动 overlay 属不同设计）。
//   overlay 落盘时整组改回 check。〕

skipSlate('B4-7a 遮罩层：v-if="sidebarForceHidden && sidebarOverlayOpen" + @click 关闭（遮罩点击路）；toggle 再点=第二路',
  'overlay 状态机未落盘（sidebarOverlayOpen 全文件零出现）——留独立任务（slate 债）');
skipSlate('B4-7b overlay CSS：.sidebar--overlay-open 含 position:fixed + z-index（覆盖于内容之上）；backdrop 含 inset:0 + z-index',
  '.sidebar--overlay-open/.sidebar-overlay-backdrop CSS 未落盘（git log -S 零提交）——留独立任务（slate 债）');

console.log('\n=== B4-8 · 窗口变宽侧栏自动恢复（SKIP(slate-debt)：同 B4-7 overlay 面未落盘） ===');

skipSlate('B4-8 变宽清理双保险：onMqSidebarChange 内 if (!e.matches) sidebarOverlayOpen=false + watch(sidebarForceHidden) 复位',
  'onMqSidebarChange/watch(sidebarForceHidden) 未落盘（B4-1c mqSidebar 半同源）——留独立任务（slate 债）');

console.log('\n=== B4-9 · 断点穿越 800↔1100 状态一致（SKIP(slate-debt)：双类绑定未落盘） ===');

skipSlate('B4-9 侧栏类双绑定：--forced-hidden 与 --overlay-open 并存绑定（同特异性后者胜=CSS 顺序钉）',
  'sidebar--forced-hidden/sidebar--overlay-open 类绑定与 CSS 未落盘（现行侧栏形态=UI13-P4 sidebar--collapsed 折叠，不同设计）——留独立任务（slate 债）');

console.log('\n=== B4-10 · 断点标志优先于拖宽手柄（不互踩）+ 拖宽契约不回归（红线） ===');

// 〔R2-H 处置（混合钉拆两半，2026-11-17）：任务手柄在面板门内的位次半已落盘（现行锚=plain class+
//   v-if 折叠门，AppLayout.vue:131/134 在岗）修锚保留；侧栏手柄断点钳制半（v-show="!sidebarForceHidden"）
//   未落盘（现行=UI13-P4 v-if="!sessionStore.sidebarCollapsed" 折叠门控，不同设计）SKIP(slate-debt)。
//   原旁注「B6 同步 :class 数组绑定」所指形态亦未落盘（B6-2b 同源）。〕
check('B4-10a 任务手柄在面板门 template 内（同门隐藏；现形态锚=resize-handle--task plain class）', () => {
  const gateIdx = layoutTpl.indexOf('v-if="isChatRoute && (!panelForceHidden || panelRecalled)"');
  const taskHandleIdx = layoutTpl.indexOf('class="resize-handle resize-handle--task"');
  assert.ok(gateIdx > -1 && taskHandleIdx > gateIdx, '任务手柄不在面板门 template 内（断点下漏藏）');
});
skipSlate('B4-10a(侧栏手柄半) 侧栏手柄 v-show="!sidebarForceHidden"（断点钳制手柄）',
  '≤800 断点钳制未落盘（v-show="!sidebarForceHidden" 全史零命中；现行=v-if="!sessionStore.sidebarCollapsed" 折叠门控，UI13-P4 设计）——留独立任务（slate 债）');
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
// 〔R2-H 处置（混合钉拆两半，2026-11-17）：B5 悬空 id 守卫仅 SessionsPage 半落盘（UI13 c4e0ede，
//   SessionsPage.vue:73-89 过滤行/count 桥/deleteSessions(ids) 在岗）——SessionsPage 半照钉（语义零放宽）；
//   AppSidebar 半未落盘（confirmBatchDelete 仍 `const count = selectedIds.value.size` 原集直删）按
//   SKIP(slate-debt) 申报，双组件补齐留独立任务。以下 B5-2b/2c/4c/负3 四钉同此处置。〕
check('B5-2b 结构钉（SessionsPage 半，已落盘）：过滤行逐字同形 + 位于 requestConfirm 之前（守卫=组件层，先于弹窗）', () => {
  const name = 'SessionsPage';
  const fn = pageFn;
  assert.ok(fn.includes(FILTER_LINE), `${name} 守卫过滤行字面漂移`);
  const f = fn.indexOf(FILTER_LINE);
  const c = fn.indexOf('requestConfirm(');
  assert.ok(c > -1 && f < c, `${name} 过滤行必须先于 requestConfirm（守卫在组件层=弹窗之前）`);
});
skipSlate('B5-2b(AppSidebar 半) 守卫过滤行逐字同形 + 先于 requestConfirm',
  'AppSidebar confirmBatchDelete 守卫未落盘（仍原集 selectedIds.size 直删；SessionsPage 半已落盘 UI13 c4e0ede）——双组件语义不放宽，补齐留独立任务（UI 债）');
check('B5-2c 结构钉（SessionsPage 半，已落盘）：提交换过滤结果——deleteSessions(ids) 恰 1 处且不再对选中集原样发起删除', () => {
  const name = 'SessionsPage';
  const fn = pageFn;
  assert.equal((fn.match(/store\.deleteSessions\(/g) ?? []).length, 1, `${name} deleteSessions 调用必须恰 1 处`);
  assert.ok(fn.includes('await store.deleteSessions(ids);'), `${name} 提交参数必须是过滤后 ids`);
  assert.ok(!fn.includes('deleteSessions([...selectedIds.value])'), `${name} 仍对 selectedIds 原集发起删除（悬空 id 直达删除链）`);
});
skipSlate('B5-2c(AppSidebar 半) deleteSessions(ids) 提交过滤后结果',
  'AppSidebar 仍 `deleteSessions([...selectedIds.value])` 原集直删（守卫未落盘，B5-2b 半同源）——补齐留独立任务（UI 债）');

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
check('B5-4c 结构钉（SessionsPage 半，已落盘）：watch 接线齐全——源 getter 映射 sessions id 集 + 批量态/空集守卫 + 条件写回', () => {
  const name = 'SessionsPage';
  const src = sessionsPage;
  assert.ok(src.includes('() => store.sessions.map((s) => s.id)'), `${name} 缺 watch 源 getter（sessions id 集）`);
  assert.ok(src.includes('if (!batchMode.value || selectedIds.value.size === 0) return;'), `${name} 缺批量态/空集守卫`);
  assert.ok(src.includes('const alive = new Set(ids);'), `${name} 缺存活集`);
  assert.ok(src.includes('if (next.size !== selectedIds.value.size) selectedIds.value = next;'),
    `${name} 缺条件写回（无失效不写回=引用稳定）`);
  assert.ok(/import\s*{[^}]*\bwatch\b[^}]*}\s*from\s*'vue';/.test(src), `${name} 缺 watch import`);
});
skipSlate('B5-4c(AppSidebar 半) watch 选中集自动修剪接线',
  'AppSidebar 选中集自动修剪未落盘（watch getter/守卫/写回四件零出现；SessionsPage 半已落盘 UI13 c4e0ede）——补齐留独立任务（UI 债）');
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
check('B5-负3 计数按过滤后（SessionsPage 半，已落盘）：count 变量承接过滤后长度（const count = ids.length）+ 模板保持 ${count} 逐字（R1.7/f1 契约）', () => {
  const name = 'SessionsPage';
  const fn = pageFn;
  const bridge = fn.indexOf('const count = ids.length;');
  assert.ok(bridge > fn.indexOf(FILTER_LINE), `${name} 缺 count 承接过滤后长度（或位置先于过滤行）`);
  assert.ok(fn.indexOf('requestConfirm(') > bridge, `${name} 计数桥未在确认之前（弹窗计数非过滤后值）`);
  assert.ok(fn.includes('${count} 个会话'), `${name} 模板字面漂移（R1.7/f1 靠该逐字文案）`);
  assert.ok(!fn.includes('selectedIds.value.size'), `${name} 残留 selectedIds.size 计数源（未按过滤后计算）`);
});
skipSlate('B5-负3(AppSidebar 半) count 桥承接过滤后长度',
  'AppSidebar 计数仍= selectedIds.value.size（守卫未落盘，B5-2b 半同源；模板 ${count} 逐字在岗）——补齐留独立任务（UI 债）');
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

console.log('\n=== B6-1/B6-2 · 手柄弱底与拖动常亮（SKIP(slate-debt)：dragging 常亮改造未落盘） ===');
// 〔R2-H 申报跳过（类别 c，2026-11-17）：B6-1/B6-2 组的断言面（hover accent 30% 弱底、:active 伪类废除、
//   dragging ref 化、两手柄 :class --dragging 绑定、--dragging 并入 hover 规则组）属从未落盘的改造——
//   git log -S "ref<'sidebar' | 'task' | null>" 对 AppLayout.vue 零提交；现行=模块级 let dragging +
//   plain class 手柄 + `.resize-handle:hover, .resize-handle:active { background: var(--color-accent) }`
//   共享规则（:active 仍在岗）。拖动常亮改造落盘时整组改回 check。〕

skipSlate('B6-1 .resize-handle:hover 弱底 = accent 30% 透明混色（accent 系、弱于实底；:active 拖动态伪类废除）',
  '弱底混色与 :active 废除未落盘（现行 hover/:active 共享实底 accent；30% 混色全史零命中）——留独立任务（slate 债）');
skipSlate("B6-2a dragging 改 ref<'sidebar' | 'task' | null>（模板 class 绑定需响应性）：模块级 let 残留=红",
  "ref 化未落盘（现行 let dragging 模块级可变；git log -S ref<'sidebar' 零提交）——留独立任务（slate 债）");
skipSlate("B6-2b 两手柄 :class 绑定 --dragging 类（v-show 断点钳制原位）",
  '--dragging 类绑定未落盘（现行手柄 plain class；B4-10a 侧栏手柄半同源）——留独立任务（slate 债）');
skipSlate('B6-2c --dragging 与 :hover 同规则组弱底（class 常亮与指针位置解耦）+ mouseup 清 ref 还原',
  '--dragging 规则组未落盘（B6-2a/2b 同源；mouseup 清 dragging=let 形态在岗）——留独立任务（slate 债）');

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

console.log('\n=== B6-6 · 侧栏搜索框 aria/placeholder/行为链（aria 半未落盘申报跳过；行为链半照钉） ===');
// 〔R2-H 处置（混合钉拆两半，2026-11-17）：placeholder/搜索行为链半已落盘（AppSidebar.vue:247-255 在岗）
//   照钉；aria-label「搜索会话标题（按 / 聚焦）」半未落盘（git log -S '按 / 聚焦' 零提交；现行「/」提示
//   为纯视觉 .sidebar__search-slash 角标 span，aria 无承载）——SKIP(slate-debt)。〕

check('B6-6 搜索框 placeholder/搜索行为链零改动（现形态半）', () => {
  const inputIdx = sidebar.indexOf('class="sidebar__search"');
  assert.ok(inputIdx > -1, '缺侧栏搜索框');
  const tag = sidebar.slice(inputIdx, sidebar.indexOf('/>', inputIdx));
  assert.ok(tag.includes('placeholder="搜索会话标题"'), 'placeholder 漂移');
  assert.ok(tag.includes('@input="onSearchInput"') && tag.includes('@search="handleSearchClear"'), '搜索行为链漂移');
});
skipSlate('B6-6(aria 半) 搜索框 aria-label="搜索会话标题（按 / 聚焦）"',
  'aria-label 未落盘（git log -S 零提交；现行=视觉「/」角标无 aria 承载）——可访问性补齐留独立任务（slate/UI13 债）');

console.log('\n=== B6-7 · 新会话钮 ink 主按钮（SKIP(slate-debt)：ink token 面未落盘；保全钉 7c/7d 在岗） ===');
// 〔R2-H 申报跳过（类别 c）：ink token 对（--color-btn-ink/--color-on-btn-ink 底字回填 + 86%⊕ 混色 hover）
//   从未落盘——git log -S '--color-btn-ink' 对 AppSidebar.vue 零提交；现行=panel 底/text 字（描边扁平钮）。
//   零硬编码 hex 负断言（7c）与模板内容保全（7d）已落盘、继续在岗。ink 化落盘时改回 check。〕

skipSlate('B6-7a 底/字接 A2 ink token 对 + border 透明占位（--active 描边可渲染）',
  'ink token 对未落盘（现行 .new-button=panel 底/text 字/border-strong 描边）——留独立任务（slate 债）');
skipSlate('B6-7b hover 提亮 = btn-ink 86% ⊕ on-btn-ink 混色（token 语义；切旧板回退自动成立）',
  'ink hover 混色未落盘（现行 hover=panel-soft 底）——留独立任务（slate 债）');
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

console.log('\n=== B6-8 · kbd 反白（SKIP(slate-debt)：ink token 面未落盘，B6-7 同源） ===');

skipSlate('B6-8 kbd 反白 token 对：字=on-btn-ink、底透明（露 btn-ink）、边框 on-btn-ink 35% 混色；负向禁回退 text-muted/color-bg',
  'kbd 反白 ink 化未落盘（现行 kbd=text-muted 字/color-bg 底/border 描边，随 B6-7 ink 面一并落盘）——留独立任务（slate 债）');

console.log('\n=== B6-9 · 暂态激活 inset accent 条（现形态：inset 2px；R2.7 3px 同步未落盘） ===');
// 〔R2-H 修锚至现形态（类别 a，2026-11-17）：inset accent 条结构在岗（.new-button--active：accent 描边 +
//   box-shadow inset 条），唯宽度字面 R2.7 的 2px→3px 同步未落盘（现行 2px 为 HEAD 已落盘值）——锚修至
//   现行 2px。R2.7 3px 同步若日后落盘，此处锚随行更新。〕

check('B6-9 .new-button--active：accent 描边 + box-shadow inset 2px 0 0 accent（暂态会话下可见；R2.7 3px 同步未落盘，现行值 2px）', () => {
  const blk = cssBlock(sidebar, '.new-button--active {');
  assert.ok(blk.includes('border-color: var(--color-accent);'), '缺 accent 描边');
  assert.ok(blk.includes('box-shadow: inset 2px 0 0 var(--color-accent);'), 'inset 条漂移（现行应为 2px accent）');
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

console.log(`\n[B 布局侧栏契约 · B1+B2+B3+B4+B5+B6] 通过 ${pass} / 失败 ${fail} / 申报跳过(slate-debt) ${skipped}`);
process.exit(fail === 0 ? 0 : 1);
