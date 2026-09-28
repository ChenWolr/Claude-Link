// tdd-sidebar-structure-verify.ts
// 侧栏 Quiet Console 重设计（2026-09-27 计划 §2.5/§2.6/§3）源码契约脚本：
//   R1  §3 钉死字面量全量复查（状态四态类/状态点/pulse/watch 同步/暂态链路/⏳ pending/双删确认文案与顺序）
//   R2  新结构钉（日期分组/时间列接线、Ctrl+N 与 / 快捷键守卫、新会话按钮位于搜索框之前、页脚配置、无引擎 LED）
//   R3  色板钉（quiet-console / terminal-pro 入 constants、isDark 正确、settings-mapping 数量断言 11）
// 运行：npx tsx scripts/tdd-sidebar-structure-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sidebar = readFileSync(join(__dirname, '../src/renderer/components/layout/AppSidebar.vue'), 'utf8');
const constants = readFileSync(join(__dirname, '../src/shared/constants.ts'), 'utf8');
const mapping = readFileSync(join(__dirname, './selftest-settings-mapping.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// 取 template 段（首个顶层 <template> 到 </template>）用于顺序断言。
const tplStart = sidebar.indexOf('<template>');
// lastIndexOf 取外层 template 闭合（文件里最后一个 </template>），排除 style 段。
const tplEnd = sidebar.lastIndexOf('</template>');
const template = sidebar.slice(tplStart, tplEnd);

console.log('\n=== R1 · §3 钉死字面量全量复查 ===');

check('R1.1 状态四态修饰类保留（running/retrying/completed/network-interrupted）', () => {
  assert.ok(sidebar.includes("'session-link--running'"));
  assert.ok(sidebar.includes("'session-link--retrying'"));
  assert.ok(sidebar.includes("'session-link--completed'"));
  assert.ok(sidebar.includes("'session-link--network-interrupted'"));
});
check('R1.2 状态点静态类 + aria-label/title + role=img', () => {
  assert.ok(sidebar.includes('class="session-link__status"'));
  assert.ok(sidebar.includes(':aria-label='));
  assert.ok(sidebar.includes('role="img"'));
  assert.ok(sidebar.includes('statusLabel(session.id)'));
});
check('R1.3 pulse 动画：keyframes 名保留且基础声明恰好 1 条 + reduced-motion 块在其后', () => {
  const pulseDecls = sidebar.split('animation: session-status-pulse 1.2s ease-in-out infinite').length - 1;
  assert.equal(pulseDecls, 1, `pulse 声明应恰好 1 条，实际 ${pulseDecls}`);
  const mediaIdx = sidebar.indexOf('@media (prefers-reduced-motion: reduce)');
  const pulseIdx = sidebar.indexOf('animation: session-status-pulse 1.2s ease-in-out infinite');
  const keyframesIdx = sidebar.indexOf('@keyframes session-status-pulse');
  assert.ok(mediaIdx > pulseIdx, 'reduced-motion 块应在 pulse 声明之后');
  assert.ok(mediaIdx > keyframesIdx, 'reduced-motion 块应在 keyframes 之后');
});
check('R1.4 watch 块（store.searchQuery → 本地回写）精确形态保留', () => {
  assert.match(
    sidebar,
    /watch\(\s*\(\) => store\.searchQuery,\s*\(q\) => \{\s*searchQuery\.value = q;\s*\},?\s*\);/,
  );
});
check('R1.5 新会话走暂态链路（store.startTransientSession()）', () => {
  assert.ok(sidebar.includes('store.startTransientSession()'));
});
check('R1.6 pending 徽标：⏳ 字面量 + pendingRemoteCountBySession[session.id] 判定', () => {
  assert.match(sidebar, /pendingRemoteCountBySession\[session\.id\]/);
  assert.match(sidebar, /⏳/);
});
check('R1.7 两个删除确认 message 模板逐字保留且 batch 版先出现（f1 契约靠第一个 message: 匹配）', () => {
  const batchMsg = '确定删除选中的 ${count} 个会话？会话及其全部消息、任务与附件将被永久删除，此操作不可撤销。';
  const singleMsg = '确定删除会话「${session.name}」？此操作不可撤销。';
  const batchIdx = sidebar.indexOf(batchMsg);
  const singleIdx = sidebar.indexOf(singleMsg);
  assert.ok(batchIdx !== -1, '批量删除文案缺失');
  assert.ok(singleIdx !== -1, '单删文案缺失');
  assert.ok(batchIdx < singleIdx, 'batch 版 message 必须在文件中先于 single 版');
});

console.log('\n=== R2 · Quiet Console 新结构钉 ===');

check('R2.1 日期分组接线：groupSessionsByDate import + computed 消费 displayedSessions', () => {
  assert.ok(sidebar.includes("from '../../utils/group-sessions-by-date'"));
  assert.match(sidebar, /groupSessionsByDate\(store\.displayedSessions\)/);
});
check('R2.2 时间列接线：formatSessionTime import + 模板消费 session.updatedAt', () => {
  assert.ok(sidebar.includes("from '../../utils/format-session-time'"));
  assert.match(sidebar, /formatSessionTime\(session\.updatedAt\)/);
});
check('R2.3 Ctrl+N 新会话快捷键（ctrl/meta + n + preventDefault）', () => {
  assert.match(sidebar, /\(e\.ctrlKey \|\| e\.metaKey\) && e\.key\.toLowerCase\(\) === 'n'/);
  assert.match(sidebar, /onGlobalKeydown/);
});
check('R2.4 「/」聚焦搜索带 isComposing + isEditableTarget 守卫', () => {
  assert.ok(sidebar.includes('isEditableTarget'));
  assert.ok(sidebar.includes('e.isComposing'));
  assert.match(sidebar, /searchInputRef\.value\?\.focus\(\)/);
});
check('R2.5 searchInputRef 挂到模板搜索框', () => {
  assert.match(sidebar, /const searchInputRef = ref<HTMLInputElement \| null>\(null\)/);
  assert.match(template, /ref="searchInputRef"/);
});
check('R2.6 新会话按钮位于搜索框之前（Quiet Console 主操作上位）', () => {
  const newBtnIdx = template.indexOf('class="new-button"');
  const searchIdx = template.indexOf('ref="searchInputRef"');
  assert.ok(newBtnIdx !== -1 && searchIdx !== -1, '两元素都须存在');
  assert.ok(newBtnIdx < searchIdx, `new-button(${newBtnIdx}) 应在搜索框(${searchIdx}) 之前`);
});
check('R2.7 暂态激活态 = inset 左缘 2px accent（无旧双环）', () => {
  assert.ok(sidebar.includes("'new-button--active'"));
  assert.match(sidebar, /box-shadow: inset 2px 0 0 var\(--color-accent\)/);
});
check('R2.8 页脚配置入口 to="/config" 且无引擎 LED（「引擎已连接」字样禁入）', () => {
  assert.match(template, /to="\/config"/);
  assert.ok(!sidebar.includes('引擎已连接'), '页脚不得出现引擎 LED 文案（计划 §6 偏差 1）');
});
check('R2.9 活动行 = accent 8% 混色（无左缘 border-left 条）', () => {
  assert.match(sidebar, /color-mix\(in srgb, var\(--color-accent\) 8%, var\(--color-panel-soft\)\)/);
  const activeIdx = sidebar.indexOf('.session-link.active {');
  const block = sidebar.slice(activeIdx, activeIdx + 200);
  assert.ok(!block.includes('border-left'), '活动行不得带左缘条（那是 B 方案语言）');
});
check('R2.10 空态二分文案保留（搜索无结果 / 暂无会话）', () => {
  assert.match(sidebar, /store\.searchQuery \? '未找到匹配的会话' : '暂无会话'/);
});
check('R2.11 批量操作条逻辑字面保留（全选/删除(n)/0 选中 disabled）', () => {
  assert.ok(sidebar.includes('toggleSelectAll'));
  assert.ok(sidebar.includes('confirmBatchDelete'));
  assert.match(sidebar, /:disabled="!selectedIds\.size"/);
});
check('R2.12 日期分组视图分支存在（v-if="!groupByProject" 走 dateGroups）', () => {
  assert.match(template, /v-if="!groupByProject"/);
  assert.match(template, /v-for="group in dateGroups"/);
  assert.match(template, /v-for="group in viewGroups"/);
});
check('R2.13 style 段零硬编码色值（全部走 var(--color-*)/color-mix token）', () => {
  const style = sidebar.slice(sidebar.indexOf('<style'));
  const hexColors = style.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(hexColors, [], `style 段发现硬编码色值：${hexColors.join(', ')}`);
});

console.log('\n=== R3 · 双色板钉（constants.ts + settings-mapping 同步） ===');

check('R3.1 constants.ts 含 quiet-console（静默，浅色）', () => {
  assert.ok(constants.includes("id: 'quiet-console'"));
  const block = constants.slice(constants.indexOf("id: 'quiet-console'"), constants.indexOf("id: 'terminal-pro'"));
  assert.match(block, /isDark: false/);
  assert.ok(block.includes('静默'), '缺中文名');
});
check('R3.2 constants.ts 含 terminal-pro（终端，isDark: true）', () => {
  assert.ok(constants.includes("id: 'terminal-pro'"));
  const block = constants.slice(constants.indexOf("id: 'terminal-pro'"));
  assert.match(block, /isDark: true/);
  assert.ok(block.includes('终端'), '缺中文名');
});
check('R3.3 两色板位于数组末尾（warm-paper 仍居首、默认色板不变）', () => {
  const firstIdx = constants.indexOf("id: 'warm-paper'");
  const qcIdx = constants.indexOf("id: 'quiet-console'");
  const tpIdx = constants.indexOf("id: 'terminal-pro'");
  assert.ok(firstIdx !== -1 && firstIdx < qcIdx && qcIdx < tpIdx, '色板顺序应为 warm-paper … quiet-console → terminal-pro');
});
check('R3.4 settings-mapping 数量契约同步为 11 套', () => {
  assert.match(mapping, /THEME_PALETTES\.length === 11/);
  assert.ok(mapping.includes("'terminal-pro' ? p.isDark === true : p.isDark === false"), '缺 terminal-pro 深色豁免分支');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
