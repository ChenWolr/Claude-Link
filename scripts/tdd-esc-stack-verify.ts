// tdd-esc-stack-verify.ts
// A9（D06-F1 + D14-F5，P2）契约钉：全局 ESC 层级裁决（use-esc-stack）。
//
// 根因：①灯箱（z 9999）打开期间按 Esc——InteractionPrompt（setup 期先注册 window keydown，
// z 1200 但 listener 先执行）的 Esc 分支不感知更高遮罩在场，把被遮挡、用户从未见过的权限/
// 选择题按 reason:'user' 收口（主进程映射为「用户拒绝了该工具调用」= 高危误 deny，污染
// transcript）；②更新弹窗（1100）与交互弹窗同开时按 Esc，dismissUpdate 顺带把版本记入
// dismissedVersions，本次运行内不再自动弹。
//
// 修复语义：模块级 Esc 层级注册表（pushEscLayer(priority)——priority 与各遮罩真实 z-index
// 同表），遮罩打开时注册、关闭/卸载时释放（幂等，异常卸载由 onUnmounted 兜底）；带 Esc 分支
// 的 handler 仅当 isTopmost()（无更高优先级遮罩在场）时响应。只改「何时响应」：
// interaction-cancel 纯函数与 reason 映射零改动；栈内无更高层时各 handler 行为与现状一致。
//
// P3-5 追加（2026-10-02 对抗 review）：两个 Diff 弹窗的外层 onKey 仅 Esc 让位——Ctrl+F
// （openSearch 抢焦开搜索框）与 ArrowUp/ArrowDown（gotoChange 改写当前改动位）无 isTopmost
// 守卫：灯箱等更高层遮罩在场时对被遮挡、用户从未见过的 diff 弹窗操作，产生不可见状态变更。
// 修法：与 Esc 同款守卫（escHandle && !escHandle.isTopmost() → return），仅收 Ctrl+F 与
// 箭头两个入口；Tab/其余键维持原行为。
//
// 运行：npx tsx scripts/tdd-esc-stack-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const lightbox = read('../src/renderer/components/chat/ImageLightbox.vue');
const prompt = read('../src/renderer/components/chat/InteractionPrompt.vue');
const updateDialog = read('../src/renderer/components/layout/UpdateDialog.vue');
const diffDialog = read('../src/renderer/components/changes/DiffDialog.vue');
const toolDiffDialog = read('../src/renderer/components/chat/ToolDiffDialog.vue');
const exportFormat = read('../src/renderer/components/export/ExportImageFormatDialog.vue');

// use-esc-stack 模块（行为检查；RED 阶段文件不存在 → require 失败按失败计）
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let esc: any = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  esc = require('../src/renderer/composables/use-esc-stack');
} catch {
  esc = null;
}

console.log('\n=== A9-①：use-esc-stack 行为（优先级裁决 / 释放幂等） ===');
check('模块存在且导出 pushEscLayer', () => {
  assert.ok(esc, 'use-esc-stack.ts 不存在');
  assert.equal(typeof esc.pushEscLayer, 'function');
  assert.ok(esc.ESC_LAYER_PRIORITY, '缺优先级常量表');
});
check('更高优先级在场时低层让位；高层释放后低层恢复响应', () => {
  const low = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.updateDialog);
  const high = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.imageLightbox);
  assert.equal(low.isTopmost(), false, '灯箱在场时更新弹窗应让位');
  assert.equal(high.isTopmost(), true);
  high.release();
  assert.equal(low.isTopmost(), true, '高层释放后低层应恢复响应');
  low.release();
});
check('release 幂等 + 释放后 isTopmost=false（异常卸载兜底）', () => {
  const h = esc.pushEscLayer(esc.ESC_LAYER_PRIORITY.interaction);
  h.release();
  h.release();
  assert.equal(h.isTopmost(), false);
});
check('同优先级互不遮蔽（DiffDialog/ToolDiffDialog/InteractionPrompt 同为 1200）', () => {
  const a = esc.pushEscLayer(1200);
  const b = esc.pushEscLayer(1200);
  assert.equal(a.isTopmost(), true);
  assert.equal(b.isTopmost(), true);
  a.release();
  b.release();
});
check('优先级表与真实 z-index 同源（update 1100 / interaction·diff 1200 / export 9000 / lightbox 9999）', () => {
  assert.equal(esc.ESC_LAYER_PRIORITY.updateDialog, 1100);
  assert.equal(esc.ESC_LAYER_PRIORITY.interaction, 1200);
  assert.equal(esc.ESC_LAYER_PRIORITY.diffDialog, 1200);
  assert.equal(esc.ESC_LAYER_PRIORITY.toolDiffDialog, 1200);
  assert.equal(esc.ESC_LAYER_PRIORITY.exportFormat, 9000);
  assert.equal(esc.ESC_LAYER_PRIORITY.imageLightbox, 9999);
});

console.log('\n=== A9-②：InteractionPrompt 接线（D06-F1 主场景） ===');
check('活动请求在场时注册层、清空时释放；Esc 分支先让位再 preventDefault', () => {
  assert.match(prompt, /pushEscLayer\(ESC_LAYER_PRIORITY\.interaction\)/, '缺 interaction 层注册');
  assert.match(prompt, /from '\.\.\/\.\.\/composables\/use-esc-stack';/, '缺 composable import');
  const escIdx = prompt.indexOf("event.key === 'Escape'");
  const branch = prompt.slice(escIdx, escIdx + 400);
  const guardIdx = branch.indexOf('isTopmost()');
  const pdIdx = branch.indexOf('event.preventDefault()');
  assert.ok(guardIdx > -1, 'Esc 分支缺 isTopmost 让位守卫');
  assert.ok(pdIdx > guardIdx, '守卫必须先于 preventDefault（让位时不得消费事件）');
});

console.log('\n=== A9-③：UpdateDialog 接线（D14-F5） ===');
check('dialogVisible 驱动注册/释放；Esc 在更高层在场时不记 dismissedVersions', () => {
  assert.match(updateDialog, /pushEscLayer\(ESC_LAYER_PRIORITY\.updateDialog\)/, '缺 update 层注册');
  const keyIdx = updateDialog.indexOf('function onKeydown');
  const body = updateDialog.slice(keyIdx, updateDialog.indexOf('}', keyIdx));
  assert.match(body, /isTopmost\(\)/, 'onKeydown 缺栈顶守卫');
  assert.match(body, /dismissUpdate\(\)/, '缺 dismiss 调用');
});

console.log('\n=== A9-④：其余 overlay 收口（灯箱/两个 Diff/导出格式） ===');
check('ImageLightbox：state 驱动注册/释放（Esc 消费后出栈）', () => {
  assert.match(lightbox, /pushEscLayer\(ESC_LAYER_PRIORITY\.imageLightbox\)/, '缺 lightbox 层注册');
  assert.match(lightbox, /release\(\)/, '缺释放');
});
check('DiffDialog / ToolDiffDialog：state 驱动注册/释放 + Esc 守卫（外层 window onKey 分支）', () => {
  for (const [name, src] of [['DiffDialog', diffDialog], ['ToolDiffDialog', toolDiffDialog]] as const) {
    assert.match(src, /pushEscLayer\(ESC_LAYER_PRIORITY\./, `${name} 缺层注册`);
    // 内层搜索框 handler（onSearchKeydown）也有 Escape 分支——守卫断言必须定位外层 window onKey。
    const onKeyIdx = src.indexOf('function onKey(');
    const onKeyBody = src.slice(onKeyIdx, src.indexOf('function onOverlayClick', onKeyIdx));
    const escIdx = onKeyBody.indexOf("e.key === 'Escape'");
    assert.ok(escIdx > -1, `${name} 外层 onKey 未定位到 Esc 分支`);
    const branch = onKeyBody.slice(escIdx, escIdx + 300);
    const guardIdx = branch.indexOf('isTopmost()');
    assert.ok(guardIdx > -1, `${name} 外层 Esc 分支缺栈顶守卫`);
  }
});
check('P3-5：DiffDialog / ToolDiffDialog 操作键让位（Ctrl+F/箭头，非顶层不响应）', () => {
  for (const [name, src] of [['DiffDialog', diffDialog], ['ToolDiffDialog', toolDiffDialog]] as const) {
    const onKeyIdx = src.indexOf('function onKey(');
    assert.ok(onKeyIdx > -1, `${name} 缺外层 onKey`);
    const onKeyBody = src.slice(onKeyIdx, src.indexOf('function onOverlayClick', onKeyIdx));
    // Ctrl+F 分支：区域截到 Esc 分支为止（Esc 自带守卫不得误计），守卫先于 preventDefault/openSearch。
    const ctrlFIdx = onKeyBody.indexOf("e.key.toLowerCase() === 'f'");
    assert.ok(ctrlFIdx > -1, `${name} 未定位到 Ctrl+F 分支`);
    const escBranchIdx = onKeyBody.indexOf("e.key === 'Escape'", ctrlFIdx);
    assert.ok(escBranchIdx > -1, `${name} Ctrl+F 分支后应有 Esc 分支（区域边界）`);
    const ctrlFBranch = onKeyBody.slice(ctrlFIdx, escBranchIdx);
    const ctrlFGuard = ctrlFBranch.indexOf('isTopmost()');
    assert.ok(ctrlFGuard > -1, `${name} Ctrl+F（openSearch）入口缺 isTopmost 让位守卫`);
    assert.ok(ctrlFBranch.indexOf('preventDefault') > ctrlFGuard, `${name} Ctrl+F 守卫须先于 preventDefault（让位时不消费事件）`);
    assert.ok(ctrlFBranch.indexOf('openSearch()') > ctrlFGuard, `${name} Ctrl+F 守卫须先于 openSearch 调用`);
    // 箭头（gotoChange）分支：isTextTarget 过滤之后、首个箭头分支之前须有守卫
    //（Esc 分支的守卫在 isTextTarget 之前，不构成误计）。分支定位用完整
    // `if (e.key === 'ArrowDown')` 形态——守卫条件里也会出现箭头键名，不得误计。
    const arrowIdx = onKeyBody.indexOf("if (e.key === 'ArrowDown')");
    assert.ok(arrowIdx > -1, `${name} 未定位到箭头分支`);
    const textIdx = onKeyBody.indexOf('isTextTarget(e.target)');
    assert.ok(textIdx > -1, `${name} 缺 isTextTarget 过滤`);
    const arrowSeg = onKeyBody.slice(textIdx, arrowIdx);
    assert.ok(arrowSeg.includes('isTopmost()'), `${name} 箭头（gotoChange）入口前缺 isTopmost 让位守卫（isTextTarget 之后）`);
  }
});
check('ExportImageFormatDialog：open 驱动注册/释放 + Esc 守卫', () => {
  assert.match(exportFormat, /pushEscLayer\(ESC_LAYER_PRIORITY\.exportFormat\)/, '缺 export 层注册');
  const escIdx = exportFormat.indexOf("e.key === 'Escape'");
  const branch = exportFormat.slice(escIdx, exportFormat.indexOf('else if', escIdx));
  assert.match(branch, /isTopmost\(\)/, 'Esc 分支缺栈顶守卫');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
