// tdd-update-dialog-autoheight-verify.ts
// P1（更新弹窗更新说明溢出，2026-10-27 五问题计划 round-001 p1）静态源钉：
// 弹窗壳新增 opt-in autoHeight——style 不输出 height 键（卡片高度随内容自适应），
// 仅 UpdateDialog 启用；其余 7 个壳层使用方零感知（反向钉防误扩散）。
//
// 配套：DialogResizeHandles 增可选 dirs（UpdateDialog 只留 e/w 横向手柄，autoHeight 下
// 竖向手柄无视觉反馈）；UpdateDialog 卡片 max-height + overflow:auto 视口兜底。
// 壳层测量/居中/钳制/拖动逻辑零改动（rect.height 仍参与居中与钳制数学，只是不输出到 style）。
//
// F1（round-001 审查 P2，2026-10-27 五问题计划 round-002 fix-a）：autoHeight 下壳层 rect.height
// 停留在打开瞬间折叠态测量值，展开说明/缩窗/双击复位/全局 pointerup 四路径都可能把 footer 顶出视口——
// UpdateDialog 组件级兜底重钳（details @toggle → rAF、window resize 120ms 二次校正、双击复位后校正、
// 全局 pointerup 兜底重钳覆盖拖动与 e-w 缩放收尾），按真实渲染盒把 top 拉回视口；壳层零改动。
// 本脚本共 22 钉（P1-①…P1-⑥）。
//
// 运行：npx tsx scripts/tdd-update-dialog-autoheight-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const shell = read('../src/renderer/composables/use-dialog-shell.ts');
const updateDialog = read('../src/renderer/components/layout/UpdateDialog.vue');
const handles = read('../src/renderer/components/common/DialogResizeHandles.vue');
const selftestList = read('selftest-static-list.txt');

// 提取 SFC <style> 内指定选择器的声明块（`\n}` 顶格闭括号结束，与仓库既有代码形态匹配）。
function extractCssBlock(src: string, selector: string): string {
  const m = src.match(new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `未找到样式块 ${selector}`);
  return m[1];
}

console.log('\n=== P1-① use-dialog-shell.ts：opt-in autoHeight，style 分支输出 height 键 ===');
check('UseDialogShellOptions 新增 autoHeight?: boolean（opt-in，不影响既有使用方）', () => {
  assert.ok(shell.includes('autoHeight?: boolean'), '选项字段缺失');
  assert.ok(shell.includes('opt-in'), '缺 opt-in 语义注释（须写明不影响既有使用方）');
});
check('style computed 含 if (!opts.autoHeight) 分支（height 键仅在该分支输出）', () => {
  assert.ok(shell.includes('if (!opts.autoHeight)'), '缺 if (!opts.autoHeight) 分支');
  assert.ok(shell.includes('s.height ='), '缺 s.height 赋值（height 键须由分支条件输出）');
});
check('旧的无条件 height 键输出已移除（style 对象字面量不再含 height: `${r.height}px`）', () => {
  assert.ok(!shell.includes('height: `${r.height}px`'), 'style 仍无条件输出 height 键（autoHeight 未生效）');
});
check('left/top/width 键无条件保留（autoHeight 只影响 height 键）', () => {
  for (const k of ['left: `${r.left}px`', 'top: `${r.top}px`', 'width: `${r.width}px`']) {
    assert.ok(shell.includes(k), `缺 ${k}`);
  }
});
check('测量/居中/钳制/拖动逻辑零改动（关键调用仍在）', () => {
  for (const pin of [
    'clampRectToViewport(centerRect(', // 打开时测量→居中→钳制
    'offsetWidth', // 自然尺寸测量
    'dragRect(session.startRect', // 拖动
    'resizeRect(session.startRect', // 缩放
    'clampRectToViewport(rect.value', // 窗口 resize 重钳
  ]) {
    assert.ok(shell.includes(pin), `关键逻辑形态漂移：缺 ${pin}`);
  }
});

console.log('\n=== P1-② UpdateDialog.vue：启用 autoHeight + 视口兜底 + 只留横向手柄 ===');
check('useDialogShell 传入 autoHeight: true', () => {
  assert.ok(updateDialog.includes('autoHeight: true'), '未启用 autoHeight');
});
check('模板 DialogResizeHandles 只留 e/w 横向手柄', () => {
  assert.ok(updateDialog.includes(":dirs=\"['e', 'w']\""), '缺 :dirs="[\'e\', \'w\']"');
});
check('.update-dialog 卡片块含 max-height: calc(100vh …)（视口兜底）', () => {
  const block = extractCssBlock(updateDialog, '.update-dialog');
  assert.ok(block.includes('max-height: calc(100vh'), '.update-dialog 块缺 max-height: calc(100vh 兜底');
});
check('.update-dialog 卡片块含 overflow: auto（极矮视口卡片自身滚动，footer 恒可达）', () => {
  const block = extractCssBlock(updateDialog, '.update-dialog');
  assert.ok(/overflow:\s*auto/.test(block), '.update-dialog 块缺 overflow: auto');
});
check('说明区内滚既有行为保留（.release-notes 仍 max-height:180px + overflow:auto）', () => {
  const block = extractCssBlock(updateDialog, '.update-dialog__notes :deep(.release-notes)');
  assert.ok(block.includes('max-height: 180px'), '.release-notes 的 max-height:180px 被移除（既有行为回归）');
  assert.ok(/overflow:\s*auto/.test(block), '.release-notes 的 overflow:auto 被移除');
});

console.log('\n=== P1-③ DialogResizeHandles.vue：可选 dirs，默认仍全 8 向 ===');
check('props 增可选 dirs?: ResizeDir[]', () => {
  assert.ok(handles.includes('dirs?: ResizeDir[]'), '缺 dirs?: ResizeDir[] 可选 prop');
});
check('默认 8 向字面保留（其余 7 个使用方零改动仍得全向手柄）', () => {
  assert.ok(
    handles.includes("'n', 'e', 's', 'w', 'ne', 'nw', 'se', 'sw'"),
    '默认 8 向字面漂移',
  );
});
check('模板 v-for 用 props.dirs ?? 全向回退', () => {
  assert.ok(/v-for="dir in \(props\.dirs \?\? /.test(handles), '模板缺 props.dirs ?? 回退（dirs 未接线）');
});

console.log('\n=== P1-④ 反向钉：其余 7 个壳层使用方不得出现 autoHeight（防误扩散） ===');
const others: Array<[string, string]> = [
  ['InteractionPrompt.vue', '../src/renderer/components/chat/InteractionPrompt.vue'],
  ['DiffDialog.vue', '../src/renderer/components/changes/DiffDialog.vue'],
  ['ToolDiffDialog.vue', '../src/renderer/components/chat/ToolDiffDialog.vue'],
  ['ExportImageFormatDialog.vue', '../src/renderer/components/export/ExportImageFormatDialog.vue'],
  ['FilePickerDialog.vue', '../src/renderer/components/common/FilePickerDialog.vue'],
  ['McpSettings.vue', '../src/renderer/components/config/McpSettings.vue'],
  ['TaskQueuePanel.vue', '../src/renderer/components/task/TaskQueuePanel.vue'],
];
for (const [name, p] of others) {
  check(`${name} 不含 autoHeight（opt-in 未扩散）`, () => {
    assert.ok(!read(p).includes('autoHeight'), `${name} 出现 autoHeight（误扩散）`);
  });
}

console.log('\n=== P1-⑤ selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(
    selftestList.includes('scripts/tdd-update-dialog-autoheight-verify.ts'),
    '清单未登记（尾部追加一行）',
  );
});

console.log('\n=== P1-⑥ F1 修复钉（round-002 fix-a）：四路径兜底重钳接线（壳层零改动） ===');
check('F1 修复钉：details @toggle 重钳 + window resize 兜底校正存在（壳层零改动）', () => {
  for (const pin of ['@toggle="onNotesToggle"', 'reclampCardBottom', "addEventListener('resize', onWinResize)", '@dblclick="onHeadDblClick"', "addEventListener('pointerup', onPointerUpReclamp)"]) {
    assert.ok(updateDialog.includes(pin), `F1 兜底接线缺失：${pin}`);
  }
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
