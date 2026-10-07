// tdd-interaction-prompt-enter-guard.ts
// X1（R06-F1，P2）契约钉：Enter/Space 焦点在弹窗 footer 按钮/<summary> 上时让位原生激活。
//
// 根因（R06-F1 CONFIRMED，2026-10-06 纠察）：window 级 keydown 的 Enter 分支只排除 otherInput、
// isTextEntryTarget 不覆盖 <button>，分支先 preventDefault() 再 submit()——焦点在「拒绝/上一步/
// 交互历史 summary」上按 Enter，按钮原生激活（click）被吞，改走 submit 兜底。叠加 a2829fb 的
// B5 兜底（空选提交 focusedOption；focusedIndex 初始 0=allow 且 Tab 不改写它；权限选项序
// allow→(allow-session)→deny）：Tab 到「拒绝」按 Enter = 提交「允许本次」（误授权，a2829fb 前
// 同路径为无害早退，行为翻转）。Space 分支同族：多选形态 preventDefault + toggleOption 吞掉
// 按钮激活并改写隐藏选择。
//
// 修复语义：
//  ① Enter 分支 preventDefault 之前加让位判定：event.target 在本弹窗（dialogRef.contains）内、
//     closest('button, summary') 命中、又不属选项按钮（closest('.interaction-option') 不命中）
//     时直接 return——不 preventDefault、不 submit，放行浏览器原生激活（Enter→click 到达
//     @click="cancel"（拒绝→deny 路径）/ @click="previousQuestion"（上一步回退）/ summary
//     原生 toggle（交互历史展开，不再整单提交））；
//  ② Space 分支同款让位（先于 preventDefault / toggleOption）——「取消」按钮上 Space 原生激活
//     取消，不再改写隐藏选择；
//  ③ 选项按钮（button.interaction-option，InteractionOptionList 虚拟/非虚拟两形态渲染）不让位：
//     Enter 维持 submit 兜底、Space 维持 toggleOption（listbox 惯例，B5 语义保留）；焦点在弹窗
//     空白/遮罩/body 上也不让位（Enter 仍走 submit 兜底）；
//  ④ 让位限定 dialogRef 内：焦点在遮罩外按钮（弹窗背后 UI）时不放行其原生激活——与 A9/B5
//     「不可见元素不得被键盘触碰」的遮挡让位约束同源。
//
// 运行：npx tsx scripts/tdd-interaction-prompt-enter-guard.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const src = readFileSync(new URL('../src/renderer/components/chat/InteractionPrompt.vue', import.meta.url), 'utf8');
const optionListSrc = readFileSync(new URL('../src/renderer/components/chat/InteractionOptionList.vue', import.meta.url), 'utf8');

const ENTER_BRANCH_MARK = "event.key === 'Enter' && document.activeElement !== otherInput.value";
const SPACE_BRANCH_MARK = "event.key === ' ' && currentMultiSelect.value";

function handleKeydownBody(): string {
  const idx = src.indexOf('function handleKeydown(');
  assert.ok(idx > -1, '缺 handleKeydown');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.ok(body.length > 0, 'handleKeydown 函数体切片失败');
  return body;
}

/** 切片某键分支：自分支条件起、至下一分支条件（endMark）或函数体末尾。 */
function branchBody(branchMark: string, endMark: string | null): string {
  const body = handleKeydownBody();
  const start = body.indexOf(branchMark);
  assert.ok(start > -1, `缺分支条件 ${branchMark}`);
  const end = endMark ? body.indexOf(endMark, start) : -1;
  return end > -1 ? body.slice(start, end) : body.slice(start);
}

console.log('\n=== X1（R06-F1）：Enter/Space 在弹窗按钮/summary 上让位原生激活 ===');
check('Enter 分支：让位判定（button/summary）存在且先于 preventDefault', () => {
  const body = branchBody(ENTER_BRANCH_MARK, "event.key === 'Escape'");
  const guardIdx = body.indexOf("closest('button, summary')");
  assert.ok(guardIdx > -1, "Enter 分支缺 closest('button, summary') 让位判定");
  const preventIdx = body.indexOf('event.preventDefault()');
  assert.ok(preventIdx > -1, 'Enter 分支缺 preventDefault（兜底路径被误删？）');
  assert.ok(guardIdx < preventIdx, '让位判定必须先于 preventDefault（否则原生激活仍被吞）');
  assert.ok(body.indexOf('void submit()') > preventIdx, 'Enter 分支 submit 兜底仍在（让位之外路径不变）');
});
check('Space 分支：让位判定（button/summary）存在且先于 preventDefault/toggleOption', () => {
  const body = branchBody(SPACE_BRANCH_MARK, null);
  const guardIdx = body.indexOf("closest('button, summary')");
  assert.ok(guardIdx > -1, "Space 分支缺 closest('button, summary') 让位判定");
  const preventIdx = body.indexOf('event.preventDefault()');
  assert.ok(preventIdx > -1, 'Space 分支缺 preventDefault（兜底路径被误删？）');
  assert.ok(guardIdx < preventIdx, '让位判定必须先于 preventDefault（否则按钮激活仍被吞）');
  assert.ok(body.indexOf('toggleOption(') > preventIdx, 'Space 分支 toggleOption 仍在（选项上 Space 语义不变）');
});
check('让位判定排除选项按钮：!closest(.interaction-option)（选项上 Enter 仍 submit 兜底 / Space 仍 toggle）', () => {
  for (const [name, body] of [['Enter', branchBody(ENTER_BRANCH_MARK, "event.key === 'Escape'")], ['Space', branchBody(SPACE_BRANCH_MARK, null)]] as const) {
    assert.match(body, /!target\.closest\('\.interaction-option'\)/, `${name} 分支缺选项排除（否则让位吞掉选项 Enter 兜底/toggle 语义）`);
  }
});
check('让位限定本弹窗内：dialogRef.contains(target)（遮罩外按钮不放行原生激活）', () => {
  for (const [name, body] of [['Enter', branchBody(ENTER_BRANCH_MARK, "event.key === 'Escape'")], ['Space', branchBody(SPACE_BRANCH_MARK, null)]] as const) {
    assert.match(body, /dialogRef\.value\?\.contains\(target\)/, `${name} 分支缺 dialogRef 范围限定`);
  }
});
check('两分支条件未收窄：otherInput 排除与 currentMultiSelect 限定保持原样', () => {
  const body = handleKeydownBody();
  assert.ok(body.includes(ENTER_BRANCH_MARK), 'Enter 分支条件被改动');
  assert.ok(body.includes(SPACE_BRANCH_MARK), 'Space 分支条件被改动');
});
check('让位判定的优先级次序：A9/B5 遮挡让位（isTopmost）仍先于 Enter 让位', () => {
  const body = handleKeydownBody();
  const occlusionGuardIdx = body.indexOf('!escHandle.isTopmost()');
  const enterBranchIdx = body.indexOf(ENTER_BRANCH_MARK);
  assert.ok(occlusionGuardIdx > -1, '缺 isTopmost 遮挡让位守卫（B5 补修回归？）');
  assert.ok(occlusionGuardIdx < enterBranchIdx, '遮挡让位守卫必须先于 Enter 分支（不可见弹窗整体让位优先）');
  assert.match(body, /if \(isTextEntryTarget\(event\.target\)\) return;/, 'isTextEntryTarget 首行守卫须保持（文本输入路径零改动）');
});
check('B5 兜底仍在 submit（空白处 Enter 提交聚焦项的语义保留）', () => {
  const idx = src.indexOf('async function submit(optionId?: string)');
  assert.ok(idx > -1, '缺 submit');
  const body = src.slice(idx, idx + 2200);
  assert.match(
    body,
    /ids = \[focusedOption\.value\.id\];\s*selectedIds\.value = new Set\(ids\);/,
    'B5 兜底（focusedOption 提交 + selectedIds 写回）须保持',
  );
});
check('让位目标在场：footer 拒绝/取消与上一步为真实 <button>（原生 click 分别到达 cancel/previousQuestion）', () => {
  assert.match(
    src,
    /<button type="button" class="interaction-btn interaction-btn--ghost" @click="cancel">/,
    'footer 拒绝/取消 ghost 按钮须为 <button @click="cancel">',
  );
  assert.match(
    src,
    /<button v-if="isWizard && wizardIndex > 0"[^>]*@click="previousQuestion">/,
    '上一步按钮须为 <button @click="previousQuestion">',
  );
});
check('让位目标在场：交互历史 <summary>（Enter 让位后原生 toggle，不再整单提交）', () => {
  assert.match(src, /<summary>交互历史（\{\{ history\.length \}\}）<\/summary>/, '交互历史 summary 须保持原生可 toggle 形态');
});
check('选项判别器有效：选项渲染为 <button class="interaction-option">（虚拟/非虚拟两形态）', () => {
  const matches = optionListSrc.match(/class="interaction-option"/g) ?? [];
  assert.ok(matches.length >= 2, `选项按钮应带 interaction-option class（虚拟+非虚拟 ≥2 处，实际 ${matches.length}）`);
  assert.match(optionListSrc, /<button[\s\S]{0,220}class="interaction-option"/, '选项元素应为 <button>（是 button 才需要 class 排除判别）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
