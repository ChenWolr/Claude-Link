// tdd-r1r2-restore-verify.ts
// R1/R2 恢复用例卷 R1 节（21 例）转写：静态结构契约（AppSidebar.vue / group-sessions.ts 源码字面、
// 切片、正则 + check 计数）+ 纯函数 assert（node:assert 直调 projectLabel / groupSessionsByProject，固定输入）同卷。
// 用例正本 = docs/ui-completion/tests/R1R2-restore-cases.md §1（R1-01~R1-21）；
// CDP 运行时形态另见 scripts/cdp-layout-e2e.mjs 的 R1 场景组（本卷不冷启动 electron）。
// 运行：npx tsx scripts/tdd-r1r2-restore-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectLabel, groupSessionsByProject } from '../src/renderer/utils/group-sessions';
import type { Session } from '../src/shared/types/session';

const repoRoot = join(__dirname, '..');
// 统一折叠 CRLF→LF：源文件可能为 CRLF 行尾，折叠后字面/切片断言对行尾不敏感。
const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8').replace(/\r\n/g, '\n');

const sidebar = read('src/renderer/components/layout/AppSidebar.vue');
const groupSessionsSrc = read('src/renderer/utils/group-sessions.ts');
const dateSrc = read('src/renderer/utils/group-sessions-by-date.ts');

const tplStart = sidebar.indexOf('<template>');
const tplEnd = sidebar.lastIndexOf('</template>');
const template = sidebar.slice(tplStart, tplEnd);
const script = sidebar.slice(0, sidebar.indexOf('</script>'));
const style = sidebar.slice(sidebar.indexOf('<style'));

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
// 页签容器切片：class="sidebar__tabs" 起至其首个 </div>（两 button 内无 div，闭合即容器）。
function tabsSlice(): string {
  const start = template.indexOf('class="sidebar__tabs"');
  if (start === -1) return '';
  const end = template.indexOf('</div>', start);
  return template.slice(start, end === -1 ? undefined : end);
}
// viewGroups computed 函数体精确切片（正则取到首行首 `});` 闭合，不越界到后续声明）；
// 用于「纯派生无累加态」类断言，避免固定长度切片误伤相邻代码的标识符。
function viewGroupsBody(): string {
  const m = script.match(/const viewGroups = computed<SessionGroup\[\]>\(\(\) => \{[\s\S]*?\n\}\);/);
  return m ? m[0] : '';
}
// 会话构造 helper：逐字沿用 HEAD tdd-group-sessions-verify.ts 的 `as unknown as Session` 收尾
// （Session 接口此后新增字段不影响编译）。
function session(id: string, workingDir: string | null, pinnedAt: number | null = null): Session {
  return {
    id,
    name: `会话-${id}`,
    cliSessionId: null,
    model: 'glm-5.2',
    providerOverride: null,
    modelOverride: null,
    workingDir,
    permissionMode: null,
    maxTurns: 10,
    thinkingLevel: null,
    pinnedAt,
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    lastContextTokens: null,
    lastContextUpdatedAt: null,
    lastContextWindow: null,
    lastContextUsed: null,
    lastContextUsedCapacity: null,
    lastContextUsedAt: null,
  } as unknown as Session;
}

console.log('\n=== R1 恢复分组页签 · 21 例转写（静态契约 + 纯函数） ===');

// ── 静态结构契约（R1-01/02/03/04/05/11/14/15/16/17/18/19/20/21 的静态形态）──

check('R1-01 页签组在搜索行与列表之间渲染且语义完整（role=group / aria=会话分组方式 / 恰 2 原生 button / 文档序）', () => {
  const tabs = tabsSlice();
  assert.ok(tabs.length > 0, '模板缺 .sidebar__tabs 容器');
  assert.ok(tabs.includes('role="group"'), '页签容器缺 role="group"');
  assert.ok(tabs.includes('aria-label="会话分组方式"'), '页签容器缺 aria-label「会话分组方式」');
  assert.equal(countOccurrences(tabs, '<button'), 2, '页签容器内原生 button 应恰 2 个');
  assert.ok(tabs.includes('全部') && tabs.includes('项目'), '两页签文案「全部」「项目」不齐');
  const rowIdx = template.indexOf('class="sidebar__search-row"');
  const tabsIdx = template.indexOf('class="sidebar__tabs"');
  const navIdx = template.indexOf('class="sidebar__sessions"');
  assert.ok(rowIdx > -1 && tabsIdx > rowIdx && navIdx > tabsIdx,
    `模板序应为 search-row → 页签容器 → sidebar__sessions（${rowIdx},${tabsIdx},${navIdx}）`);
});

check('R1-02 默认激活「全部」且列表走日期五桶（groupByProject 初值 false / 五桶置顶组前插 / active 绑定）', () => {
  assert.ok(script.includes('const groupByProject = ref(false);'), '缺组件态初值 false（默认「全部」语义）');
  assert.ok(sidebar.includes("{ 'sidebar__tab--active': !groupByProject }"), '「全部」钮缺 active 三元绑定');
  assert.match(sidebar, /const dateGroups = computed\(\(\) => groupSessionsByDate\(store\.displayedSessions\)\);/,
    'dateGroups 五桶接线应逐字保留');
  assert.ok(dateSrc.includes("key: 'pinned'") && dateSrc.includes('groups.unshift('), '五桶置顶组前插语义不在');
});

check('R1-03 active 页签有 accent 视觉、非 active 无（::after 走 var(--color-accent) + 页签 CSS 零硬编码 hex）', () => {
  const cssStart = style.indexOf('.sidebar__tabs {');
  const cssEnd = style.indexOf('/* 分组头');
  assert.ok(cssStart > -1, '缺 .sidebar__tabs 规则块');
  const tabsCss = style.slice(cssStart, cssEnd > cssStart ? cssEnd : undefined);
  assert.ok(tabsCss.includes('.sidebar__tab--active {'), '缺 active 态规则块');
  assert.ok(tabsCss.includes('.sidebar__tab--active::after {'), '缺 active ::after 下划线规则块');
  assert.ok(tabsCss.includes('background: var(--color-accent);'), 'active ::after 未引用 accent token');
  const hexes = tabsCss.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `页签 CSS 含硬编码色值：${hexes.join(', ')}`);
});

check('R1-04 点「项目」进入项目分组视图（@click 接线 + viewGroups 项目分支 + 单模板 v-for viewGroups）', () => {
  assert.ok(sidebar.includes('@click="groupByProject = true"'), '缺「项目」钮点击接线');
  assert.ok(script.includes('if (groupByProject.value) return groupSessionsByProject(store.displayedSessions);'),
    'viewGroups 项目分支未消费 groupSessionsByProject(displayedSessions)');
  assert.ok(template.includes('<template v-for="group in viewGroups" :key="group.key">'), '单模板循环源未切 viewGroups');
  assert.equal(countOccurrences(template, 'v-for="session in group.sessions"'), 1, '会话行 v-for 应恰 1 处（单模板）');
});

check('R1-05 点「全部」回日期视图且五桶组成不变（@click 接线 + dateGroups adapter 归一 dir:null）', () => {
  assert.ok(sidebar.includes('@click="groupByProject = false"'), '缺「全部」钮点击接线');
  assert.ok(script.includes('return dateGroups.value.map((g) => ({ ...g, dir: null }));'),
    'viewGroups 全部分支未把日期组适配为 dir:null 的 SessionGroup 形');
  assert.match(sidebar, /const dateGroups = computed\(\(\) => groupSessionsByDate\(store\.displayedSessions\)\);/,
    'dateGroups 逐字保留→往返五桶组成不变');
});

check('R1-11 组头携带完整目录供 title 呈现（分组对象 dir=workingDir 原文 + 组头 :title 归一）', () => {
  const groups = groupSessionsByProject([session('a', 'D:\\a\\b\\proj')]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].dir, 'D:\\a\\b\\proj', '分组对象应携带 workingDir 原文（反斜杠不归一）');
  assert.equal(groups[0].label, 'proj', 'label 应为末段名');
  assert.ok(template.includes(':title="group.dir ?? undefined"'), '组头缺 :title="group.dir ?? undefined" 归一绑定');
});

check('R1-14 搜索态下项目视图对搜索结果分组（两视图分支同源 store.displayedSessions）', () => {
  assert.ok(script.includes('groupSessionsByProject(store.displayedSessions)'),
    '项目分组源须消费 store.displayedSessions（搜索态同生效）');
  assert.ok(script.includes('groupSessionsByDate(store.displayedSessions)'),
    '日期分组源须消费 store.displayedSessions（两视图同源）');
});

check('R1-15 项目视图停留期间搜索防抖结果晚到 → 分组重算（viewGroups 为 computed 响应式派生）', () => {
  assert.ok(script.includes('const viewGroups = computed<SessionGroup[]>(() => {'), 'viewGroups 非 computed（断链即不重算）');
  const body = viewGroupsBody();
  assert.ok(body.length > 0, 'viewGroups computed 块切片缺失');
  assert.ok(body.includes('store.displayedSessions'), 'viewGroups 派生体未读 displayedSessions（搜索结果到达不触发重算）');
});

check('R1-16 批量删除模式在项目视图可用（viewGroups 循环标签无 batchMode 条件 + 批量三件套在场）', () => {
  const loopIdx = template.indexOf('<template v-for="group in viewGroups"');
  assert.ok(loopIdx > -1, '缺 viewGroups 循环');
  const loopTag = template.slice(loopIdx, template.indexOf('>', loopIdx) + 1);
  assert.ok(!loopTag.includes('batchMode'), 'viewGroups 循环被 batchMode 条件包裹（项目视图批量态打散）');
  assert.ok(template.includes('class="sidebar__batchbar"'), '批量条丢失');
  assert.ok(template.includes('class="session-link__check"'), '复选框丢失');
});

check('R1-17 批量选中集合跨视图切换保留（selectedIds 组件态 + 页签点击不清空选中集）', () => {
  assert.ok(script.includes('const selectedIds = ref(new Set<string>());'), 'selectedIds 非组件态 ref');
  const tabs = tabsSlice();
  assert.ok(!tabs.includes('selectedIds'), '页签点击接线触碰 selectedIds（切视图清空选中集）');
  assert.ok(sidebar.includes('@click="groupByProject = true"') && sidebar.includes('@click="groupByProject = false"'),
    '两页签应为纯布尔赋值（不带清空副作用）');
});

check('R1-18 页签选择不持久化（组件态 ref + 无 electron-store/config/localStorage 写入路径）静态钉', () => {
  assert.ok(script.includes('const groupByProject = ref(false);'), '页签态非组件态 ref（疑似落盘）');
  const lines = sidebar.split('\n').filter((l) => l.includes('groupByProject'));
  assert.ok(lines.length > 0, '缺 groupByProject 引用');
  for (const l of lines) {
    assert.ok(!/localStorage|sessionStorage|electronStore|electron-store|configManager|setConfig|saveConfig|writeConfig|persist|readConfig|getConfig/.test(l),
      `groupByProject 行疑似持久化写入：${l.trim()}`);
  }
  assert.ok(!groupSessionsSrc.includes('groupByProject'), '分组纯函数文件不应持有视图开关态');
});

check('R1-19 页签键盘可达（两原生 button 均 type="button"，Tab 按文档序可达、Enter/Space 激活）', () => {
  const tabs = tabsSlice();
  assert.equal(countOccurrences(tabs, '<button'), 2, '页签钮应恰 2 个（div 冒充即红）');
  assert.equal(countOccurrences(tabs, 'type="button"'), 2, '两页签均须 type="button"');
});

check('R1-20 空态文案分支在两视图下沿用（单空态分支 + 二分文案 + 分支不随 groupByProject 分叉）', () => {
  assert.equal(countOccurrences(template, 'v-if="!store.displayedSessions.length"'), 1,
    '空态分支应恰 1 处（两视图共用，不得新增第三种空态）');
  assert.match(sidebar, /store\.searchQuery \? '未找到匹配的会话' : '暂无会话'/, '二分空态文案漂移');
  const emptyIdx = template.indexOf('v-if="!store.displayedSessions.length"');
  const emptyBlock = template.slice(emptyIdx, emptyIdx + 300);
  assert.ok(!emptyBlock.includes('groupByProject'), '空态分支随 groupByProject 分叉（项目视图新增空态）');
});

check('R1-21 快速连点页签终态一致（viewGroups 纯派生无累加态 + 两 @click 为幂等布尔赋值）', () => {
  assert.equal(countOccurrences(sidebar, '@click="groupByProject = true"'), 1, '「项目」点击接线应恰 1 处');
  assert.equal(countOccurrences(sidebar, '@click="groupByProject = false"'), 1, '「全部」点击接线应恰 1 处');
  const body = viewGroupsBody();
  assert.ok(body.length > 0, 'viewGroups computed 块切片缺失');
  assert.ok(!body.includes('push(') && !body.includes('selectedIds') && !/(\+\+|--)/.test(body),
    'viewGroups 派生体含累加/写集副作用（连点可能重复渲染或丢项）');
});

// ── 纯函数 assert（R1-06/07/08/09/10/12/13；固定输入，node:assert 直调）──

check('R1-06 反斜杠/正斜杠/混用路径归入同一组、组名=末段（owner 终裁：key=归一化全路径，尾斜杠独立组）', () => {
  // owner 终裁（计划 §0）优先于用例卷出卷口误：util 仅做「反斜杠归一」（replace(/\\/g,'/')），
  // 不做尾斜杠归一；key=归一化全路径 → 尾斜杠路径为独立组（同名不同目录两组、label 均末段名）。
  // 变异 M1-R1（key 改用原始 workingDir 不做归一）会使前 3 条裂成 3 组 → 本钉仍红。
  const inputs = [
    session('p1', 'D:\\a\\b\\proj'),
    session('p2', 'D:/a/b/proj'),
    session('p3', 'D:\\a/b\\proj'),
    session('p4', 'D:/a/b/proj/'),
  ];
  const groups = groupSessionsByProject(inputs);
  const main = groups.find((g) => g.key === 'D:/a/b/proj');
  assert.ok(main, '缺归一化全路径 key 组（反斜杠归一丢失）');
  assert.equal(main.label, 'proj', '组名应为末段名（非全路径）');
  assert.deepEqual(main.sessions.map((s) => s.id), ['p1', 'p2', 'p3'], '前 3 条混用分隔符路径应同组');
  const trailing = groups.find((g) => g.key === 'D:/a/b/proj/');
  assert.ok(trailing, '尾斜杠路径按全路径 key 应独立成组（owner 终裁）');
  assert.equal(trailing.label, 'proj', '尾斜杠组 label 仍为末段名（可同名两组）');
  assert.deepEqual(trailing.sessions.map((s) => s.id), ['p4']);
});

check('R1-07 无 workingDir（null）与空串同归「未选择工作空间」组', () => {
  const groups = groupSessionsByProject([
    session('n1', null),
    session('e1', ''),
    session('p1', 'C:\\w\\app'),
  ]);
  const none = groups.find((g) => g.key === '__none__')!;
  assert.ok(none, '缺「未选择工作空间」组');
  assert.equal(none.label, '未选择工作空间', '组名逐字不符');
  assert.deepEqual(none.sessions.map((s) => s.id), ['n1', 'e1'], 'null 与空串须同组');
  assert.ok(!none.sessions.some((s) => s.id === 'p1'), '有目录会话误入「未选择工作空间」组');
});

check('R1-08 纯函数：组内置顶优先（pinnedAt 降序）其余保持原序', () => {
  const groups = groupSessionsByProject([
    session('u1', '/d/p'),
    session('pa', '/d/p', 1000),
    session('pb', '/d/p', 2000),
    session('u2', '/d/p'),
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['pb', 'pa', 'u1', 'u2']);
});

check('R1-09 纯函数：组间保持首现顺序（非字典序/计数序）', () => {
  const groups = groupSessionsByProject([
    session('s1', '/d/proj2'),
    session('s2', '/d/proj1'),
    session('s3', '/d/proj2'),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['proj2', 'proj1']);
});

check('R1-10 纯函数：项目视图不做置顶跨组提取（置顶会话仍留所属项目组内）', () => {
  const groups = groupSessionsByProject([
    session('pinX', '/d/projA', 1),
    session('uA', '/d/projA'),
    session('pinY', '/d/projB', 2),
  ]);
  assert.deepEqual(groups.map((g) => g.label), ['projA', 'projB'], '组序应为首现序 [projA, projB]');
  assert.ok(!groups.some((g) => g.key === '置顶' || g.label === '置顶'), '出现跨组「置顶」组（复用日期提取逻辑）');
  assert.deepEqual(groups[0].sessions.map((s) => s.id), ['pinX', 'uA'], 'pinX 应在 projA 组内');
  assert.deepEqual(groups[1].sessions.map((s) => s.id), ['pinY'], 'pinY 应在 projB 组内');
});

check('R1-12 纯函数：空输入→空输出（无「未选择工作空间」幽灵组）', () => {
  assert.deepEqual(groupSessionsByProject([]), []);
});

check('R1-13 纯函数：仅分隔符/盘符根等畸形路径不抛错、组名非空', () => {
  const groups = groupSessionsByProject([
    session('slash', '\\'),
    session('root', 'D:\\'),
  ]);
  assert.equal(groups.length, 2);
  for (const g of groups) assert.ok(g.label.length > 0, `畸形路径组名不应为空：key=${g.key}`);
  assert.equal(projectLabel('\\'), '\\', '仅分隔符回落原文');
  assert.equal(projectLabel('D:\\'), 'D:', '盘符根取盘符段');
});

console.log('\n=== R2 置顶按钮移至会话卡前方 · 12 例转写（静态结构钉 + 形态断言） ===');
// 用例正本 = docs/ui-completion/tests/R1R2-restore-cases.md §2（R2-01~R2-12）。
// 断言以目标态为准；owner 终裁（计划 §0-4）优先于用例卷 R2-08 出卷口误：
//   :title = 短文案「取消置顶 / 置顶会话」（不含会话名）；
//   :aria-label = 文案 + 会话名（"（… ? '取消置顶 ' : '置顶会话 ') + session.name"）。
// 标 CDP 的 8 例（R2-03/04/05/06/08/09/10/12）运行时面另见 scripts/cdp-layout-e2e.mjs R2 场景组；
// 本卷以静态结构钉 / 形态断言承载同回归面的源码形态。
// r1/r2 切片：r1 = class="session-link__r1" 起至 r2 起；r2 = r2 起至空态块起（切片法同
// tdd-b-layout-sidebar-verify B2-1，卡内子元素标识符在模板中各恰 1 处）。
const restoreR1Idx = template.indexOf('class="session-link__r1"');
const restoreR2Idx = template.indexOf('class="session-link__r2"');
const restoreEmptyIdx = template.indexOf('class="sidebar__empty"');
const restoreR1 = restoreR1Idx > -1 && restoreR2Idx > restoreR1Idx
  ? template.slice(restoreR1Idx, restoreR2Idx) : '';
const restoreR2 = restoreR2Idx > -1 && restoreEmptyIdx > restoreR2Idx
  ? template.slice(restoreR2Idx, restoreEmptyIdx) : '';

check('R2-01 位置钉：置顶钮在 r1（状态灯后、标题前），r2 仅 chip→⏳→时间→删除（r1/r2 切片 + indexOf 次序 + 负向）', () => {
  assert.ok(restoreR1.length > 0 && restoreR2.length > 0, 'r1/r2 切片锚缺失');
  const st = restoreR1.indexOf('class="session-link__status"');
  const pin = restoreR1.indexOf('class="session-link__pinbtn"');
  const name = restoreR1.indexOf('class="session-link__name"');
  assert.ok(st > -1 && pin > st && name > pin,
    `r1 次序应为 状态灯→置顶钮→名称（status=${st}, pinbtn=${pin}, name=${name}）`);
  assert.ok(!restoreR1.includes('session-link__time'), '时间列仍在 r1（假双行）');
  assert.ok(!restoreR2.includes('session-link__pinbtn'), 'r2 仍含置顶钮（应迁 r1）');
  const chip = restoreR2.indexOf('class="session-link__chip"');
  const pending = restoreR2.indexOf('session-link__pending');
  const time = restoreR2.indexOf('session-link__time');
  const del = restoreR2.indexOf('session-link__delete');
  assert.ok(chip > -1 && pending > chip && time > pending && del > time,
    `r2 次序应为 chip→⏳→时间→删除（${chip},${pending},${time},${del}）`);
  assert.ok(!restoreR2.includes('session-link__name'), '标题掉进 r2');
});

check('R2-02 原静态图钉标识零残留（同位不双 pin）：__pinned 双形态零命中 + pinbtn 恰 1 处 + CSS 块零残留', () => {
  assert.equal(countOccurrences(sidebar, 'session-link__pinned'), 0,
    '静态 __pinned 标识（模板 + CSS）仍有残留');
  assert.equal(countOccurrences(template, 'class="session-link__pinbtn"'), 1,
    '单卡模板 pinbtn 应恰 1 处（= 置顶钮本身，无同位双 pin）');
  assert.equal(countOccurrences(template, 'v-if="session.pinnedAt != null"'), 0,
    '静态 pin 标识 v-if 字面残留');
  assert.ok(!style.includes('.session-link__pinned {'), '静态 __pinned CSS 块残留');
});

check('R2-03 已置顶恒显 accent：--pinned CSS 块四声明齐备 + 声明序在基础块之后 + 选择器不依赖 hover 前缀 + 零硬编码 hex', () => {
  const sel = '.session-link__pinbtn--pinned {';
  const idx = style.indexOf(sel);
  const baseIdx = style.indexOf('.session-link__pinbtn {');
  assert.ok(idx > -1, '缺 --pinned 恒显块');
  assert.ok(baseIdx > -1 && idx > baseIdx, '--pinned 块未声明在基础块之后（同特异性后者胜前提）');
  const selectorLine = style.slice(idx, style.indexOf('{', idx) + 1);
  assert.ok(!/:hover|:focus-within/.test(selectorLine), '恒显选择器不得挂 :hover/:focus-within 前缀');
  const blk = style.slice(idx, style.indexOf('}', idx));
  for (const decl of ['width: 18px', 'opacity: 1', 'pointer-events: auto', 'color: var(--color-accent)']) {
    assert.ok(blk.includes(decl), `--pinned 块缺 ${decl}`);
  }
  const hexes = blk.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
  assert.deepEqual(hexes, [], `--pinned 块含硬编码色值：${hexes.join(', ')}`);
});

check('R2-04 置顶/取消置顶点击走 store.togglePin（乐观重排）：接线恰 1 处 + --pinned 双态类绑定恰 1 处', () => {
  assert.equal(countOccurrences(template, '@click.stop="store.togglePin(session.id)"'), 1,
    'togglePin 接线应恰 1 处（不旁路 store 乐观更新链路）');
  assert.equal(countOccurrences(template, ':class="{ \'session-link__pinbtn--pinned\': session.pinnedAt != null }"'), 1,
    '--pinned 双态类绑定应恰 1 处（pinnedAt 即变即时切态）');
});

check('R2-05 未置顶钮 hover/:focus-within 显现：后代选择器规则组在场 + 与 delete 显现组 200 字符相邻（易红点零改动）', () => {
  assert.ok(style.includes('.session-link:hover .session-link__pinbtn'), '缺 hover 显现 pinbtn 规则');
  assert.ok(style.includes('.session-link:focus-within .session-link__pinbtn'), '缺 :focus-within 显现分支');
  // 相邻序钉与 tdd-session-pin-verify ⑤ C7 同款：pinbtn 显现组后 200 字符内紧跟 delete 显现组。
  assert.match(sidebar, /\.session-link:hover \.session-link__pinbtn,\s*\.session-link:focus-within \.session-link__pinbtn,\s*\.session-link__pinbtn:focus-visible \{[\s\S]{0,200}\.session-link:hover \.session-link__delete,\s*\.session-link:focus-within \.session-link__delete \{/,
    'pinbtn 显现组后 200 字符内未紧跟 delete 显现组（相邻序漂移）');
});

check('R2-06 键盘可达：pinbtn :focus-visible 焦点环在场 + 隐藏态 width:0/opacity:0（非 display:none）+ :focus-within 分支并存', () => {
  assert.ok(/\.session-link__pinbtn:focus-visible \{/.test(style), '缺 :focus-visible 焦点环');
  const baseIdx = style.indexOf('.session-link__pinbtn {');
  assert.ok(baseIdx > -1, '缺 pinbtn 基础块');
  const baseBlk = style.slice(baseIdx, style.indexOf('}', baseIdx));
  assert.ok(baseBlk.includes('width: 0') && baseBlk.includes('opacity: 0') && baseBlk.includes('pointer-events: none'),
    '基础隐藏态三件套不全（width:0/opacity:0/pointer-events:none）');
  assert.ok(!baseBlk.includes('display: none'), '隐藏态不得用 display:none（脱离 Tab 序，键盘不可达）');
  assert.ok(style.includes('.session-link:focus-within .session-link__pinbtn'), '缺 :focus-within 显现分支');
});

check('R2-07 暂态会话不渲染置顶钮：v-if 守卫字面 !batchMode && !session.transient 在 r1 且恰 1 处', () => {
  assert.ok(restoreR1.includes('v-if="!batchMode && !session.transient"'),
    'r1 置顶钮缺 !batchMode && !session.transient 守卫');
  assert.equal(countOccurrences(template, 'v-if="!batchMode && !session.transient"'), 1,
    '置顶钮守卫应恰 1 处（暂态/批量双保险）');
});

check('R2-08 title/aria 双属性逐字（owner §0-4：title=短文案、aria-label=文案+会话名；用例卷 R2-08「title 也含名」为出卷口误，不据此改 title）', () => {
  assert.equal(countOccurrences(restoreR1, ':title="session.pinnedAt != null ? \'取消置顶\' : \'置顶会话\'"'), 1,
    'r1 置顶钮 title 短文案应恰 1 处（不含会话名）');
  assert.equal(countOccurrences(restoreR1, ':aria-label="(session.pinnedAt != null ? \'取消置顶 \' : \'置顶会话 \') + session.name"'), 1,
    'r1 置顶钮 aria-label（文案 + 会话名）应恰 1 处');
  assert.ok(!/:title="[^"]*session\.name/.test(restoreR1), 'title 不得拼接会话名（owner 终裁：短文案）');
  assert.ok(restoreR1.includes('+ session.name'), 'aria-label 须拼接会话名');
});

check('R2-09 批量模式置顶钮隐藏、r1 首位为复选框：!batchMode 守卫在 r1 置顶钮 + checkbox 先于置顶钮', () => {
  const chk = restoreR1.indexOf('class="session-link__check"');
  const pin = restoreR1.indexOf('class="session-link__pinbtn"');
  assert.ok(chk > -1 && pin > chk, '复选框应在 r1 首位且先于置顶钮（批量语义不冲突）');
  assert.ok(restoreR1.includes('v-if="!batchMode && !session.transient"'),
    'r1 置顶钮缺 !batchMode 守卫（批量态与复选框同现即红）');
});

check('R2-10 时间列↔删除钮 hover 互换机制保持（时间隐藏/删除显现/批量 time 恢复三组规则字面在场）', () => {
  assert.ok(style.includes('.session-link:hover .session-link__time,'), '缺 hover 隐藏时间列规则组');
  assert.ok(style.includes('.session-link:hover .session-link__delete,'), '缺 hover 显现删除钮规则组');
  assert.ok(style.includes('.sidebar__sessions.batching .session-link:hover .session-link__time,'),
    '缺批量态时间列恢复规则组');
  const timeIdx = style.indexOf('.session-link:hover .session-link__time');
  assert.ok(style.slice(timeIdx, style.indexOf('}', timeIdx)).includes('display: none'), 'hover 未隐藏时间列');
  const delIdx = style.indexOf('.session-link:hover .session-link__delete');
  assert.ok(style.slice(delIdx, style.indexOf('}', delIdx)).includes('display: grid'), 'hover 未显现删除钮');
});

check('R2-11 置顶点击走既有 store 动作（接线恰 1 处且在 r1，不旁路 store.togglePin 乐观 patch/失败回滚）', () => {
  assert.equal(countOccurrences(template, '@click.stop="store.togglePin(session.id)"'), 1,
    'togglePin 接线应恰 1 处');
  assert.ok(restoreR1.includes('@click.stop="store.togglePin(session.id)"'),
    'r1 置顶钮未接 store.togglePin');
});

check('R2-12 连点置顶终态一致（形态断言：--pinned 双态由 session.pinnedAt 单一权威源驱动 + 两连点回落未置顶 + 无本地累加态）', () => {
  // 形态断言：复刻模板 :class 的会话级双态判定（pinnedAt != null），固定输入覆盖正常/边界/异常向。
  const pinClass = (pinnedAt: number | null | undefined): string =>
    (pinnedAt != null ? 'session-link__pinbtn--pinned' : '');
  assert.equal(pinClass(null), '', 'null → 未置顶');
  assert.equal(pinClass(undefined), '', 'undefined（旧数据缺字段）→ 未置顶');
  assert.equal(pinClass(0), 'session-link__pinbtn--pinned', '0（合法 pinnedAt 边界）→ 已置顶');
  assert.equal(pinClass(1730000000000), 'session-link__pinbtn--pinned', '正数 → 已置顶');
  let pinnedAt: number | null = null;
  pinnedAt = pinnedAt == null ? Date.now() : null; // 第一次点击：置顶
  assert.equal(pinClass(pinnedAt), 'session-link__pinbtn--pinned');
  pinnedAt = pinnedAt == null ? Date.now() : null; // 第二次点击：取消
  assert.equal(pinClass(pinnedAt), '', '两次连点终态应回落未置顶（乐观 patch 与权威重拉竞争不乱序）');
  assert.equal(countOccurrences(template, ':class="{ \'session-link__pinbtn--pinned\': session.pinnedAt != null }"'), 1,
    '双态类绑定须由 session.pinnedAt 单一权威源驱动');
  assert.ok(!restoreR1.includes('push(') && !restoreR1.includes('++'), '置顶态不得引入本地累加/写集副作用');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
