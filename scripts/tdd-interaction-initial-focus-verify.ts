// tdd-interaction-initial-focus-verify.ts
// B5（D06-F2，P3）契约钉：权限/多选弹窗初始焦点落可用元素 + Tab 困于模态 + Enter 兜底。
//
// 根因（D06-F2 CONFIRMED）：focusDialogStart 取第一个 [data-dialog-initial-focus]——权限弹窗
// （≤8 选项无搜索框）唯一标记在 footer 提交按钮上，而 optionDefaults 刻意空集（防误触预选）
// → canSubmit=false → 按钮禁用 → 对禁用按钮 focus() 是 no-op，真实焦点留在遮罩外：
//   后果1：Enter → submit() 空 ids 静默早退，视觉首项带 --focused 焦点环却毫无反应；
//   后果2：trapTab 只在 activeElement 等于首/尾 focusable 时拦截——焦点未进对话框时
//          Tab 按默认 DOM 序逃出 aria-modal（WCAG 2.4.3）。
//
// 修复语义：
//  ① focusDialogStart 跳过 disabled 候选；全禁用（权限弹窗常态）回落选项列表第一项
//     （.interaction-option 首个按钮，真实 DOM 焦点）；
//  ② trapTab 收紧：activeElement 不在对话框内时 Tab/Shift+Tab 直接拉回模态首/尾元素，
//     焦点永不逃出遮罩；
//  ③ submit 兜底（单选形态，防误触预选设计保留）：selectedIds 空但聚焦环明确落在某选项时，
//     Enter 视为提交该聚焦项（listbox 惯例）；多选/表单/文本输入形态维持原语义。
//     P2-1（2026-10-02 对抗 review）：兜底同时写回 selectedIds（new Set(ids)）——wizard 的
//     persistCurrentQuestionAnswer 读 selectedIds 落账 questionAnswers，只写局部 ids 会把
//     该题记成 selectedOptionIds: []（静默空答案）；「不预选」指初始态不预选，提交路径写回
//     不复活误触面（多选仍空集早退）；
//  ④ 遮挡让位（B5 补修·核验缺陷）：权限弹窗在 z-9999 灯箱等更高层遮罩之下打开（用户从未
//     见过）时，focusDialogStart 不抢占 DOM 焦点、Enter/箭头/空格/Tab 整体让位——否则 Enter
//     经 ③ 兜底静默提交首项（权限首项=允许本次，误授权）；判据与 A9 的 Esc 让位同源
//     （escHandle.isTopmost），无更高层时零行为变化。
//
// 运行：npx tsx scripts/tdd-interaction-initial-focus-verify.ts

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

console.log('\n=== B5（D06-F2）：权限弹窗初始焦点 + Tab 困陷 + Enter 兜底 ===');
check('focusDialogStart 遍历候选跳过 disabled（禁用提交按钮不再作为初始焦点）', () => {
  const idx = src.indexOf('function focusDialogStart()');
  assert.ok(idx > -1, '缺 focusDialogStart');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /querySelectorAll<HTMLElement>\('\[data-dialog-initial-focus\]'\)/, '应遍历全部标记候选');
  assert.match(body, /\.disabled/, '应检查 disabled 跳过');
});
check('全禁用时回落选项列表第一项（真实 DOM 焦点）', () => {
  const idx = src.indexOf('function focusDialogStart()');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /interaction-option/, '回落选择器应指向 .interaction-option');
});
check('trapTab 以 dialog.contains(activeElement) 收紧（焦点在模态外也拉回）', () => {
  const idx = src.indexOf('function trapTab(');
  assert.ok(idx > -1, '缺 trapTab');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /!dialog\.contains\(/, '缺 contains 收紧判定');
});
check('Enter 兜底：单选形态 ids 空时以 focusedOption 提交（预选防误触设计保留）', () => {
  const idx = src.indexOf('async function submit(optionId?: string)');
  assert.ok(idx > -1, '缺 submit');
  const body = src.slice(idx, idx + 1400);
  assert.match(body, /focusedOption\.value/, 'submit 应消费 focusedOption 兜底');
  assert.match(body, /!currentMultiSelect\.value/, '兜底应限单选形态');
});
check('P2-1：兜底分支同步写回 selectedIds（wizard Enter 落真实选择，不落空答案）', () => {
  const idx = src.indexOf('async function submit(optionId?: string)');
  assert.ok(idx > -1, '缺 submit');
  // 窗口 2200：须覆盖到 submit 内 wizard 落账路径（persistCurrentQuestionAnswer 调用点）。
  const body = src.slice(idx, idx + 2200);
  // 兜底先写局部 ids（let ids 可重写），再同步写回 selectedIds——否则 wizard 形态
  // persistCurrentQuestionAnswer 读到的 selectedIds 仍是空集，questionAnswers 记
  // selectedOptionIds: []（静默错误回答，2026-10-02 对抗 review P2-1）。
  assert.match(body, /let ids =/, 'ids 应为可兜底重写的局部变量');
  assert.match(
    body,
    /ids = \[focusedOption\.value\.id\];\s*selectedIds\.value = new Set\(ids\);/,
    '兜底分支须在 ids = [focusedOption.value.id] 之后同步写回 selectedIds.value = new Set(ids)',
  );
  // 写回须先于 wizard 落账路径（persistCurrentQuestionAnswer 在 submit 内随后执行）。
  const writeBackIdx = body.indexOf('selectedIds.value = new Set(ids)');
  const persistIdx = body.indexOf('persistCurrentQuestionAnswer()');
  assert.ok(persistIdx > -1, '窗口应覆盖 persistCurrentQuestionAnswer 调用点');
  assert.ok(writeBackIdx > -1 && writeBackIdx < persistIdx, '写回须先于 persistCurrentQuestionAnswer 调用');
});
check('遮挡让位：更高层遮罩在场时 focusDialogStart 不抢焦（守卫先于候选遍历）', () => {
  const idx = src.indexOf('function focusDialogStart()');
  assert.ok(idx > -1, '缺 focusDialogStart');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  const guardIdx = body.indexOf('isTopmost()');
  assert.ok(guardIdx > -1, 'focusDialogStart 缺 isTopmost 让位守卫（遮挡组合回归）');
  assert.ok(body.indexOf('querySelectorAll') > guardIdx, '守卫必须先于候选遍历（让位时不触碰焦点）');
});
check('遮挡让位：Enter/箭头/空格/Tab 在更高层遮罩在场时整体让位（防静默误授权）', () => {
  const idx = src.indexOf('function handleKeydown(');
  assert.ok(idx > -1, '缺 handleKeydown');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  const guardIdx = body.indexOf('isTopmost()');
  assert.ok(guardIdx > -1, 'handleKeydown 缺 isTopmost 让位守卫（遮挡组合回归）');
  // Enter（兜底静默提交首项=误授权路径）、箭头/空格（move/toggle 改写隐藏选择）、
  // Tab（trapTab 拉焦进不可见弹窗）全部须在守卫条件内、先于各自分支执行。
  for (const key of ["'Tab'", "'ArrowDown'", "'ArrowUp'", "'Enter'", "' '"]) {
    assert.ok(body.slice(0, guardIdx).includes(key), `让位守卫条件应覆盖 ${key}`);
  }
  assert.ok(body.indexOf('trapTab(') > guardIdx, '守卫必须先于 trapTab（让位时不拉焦）');
  assert.ok(body.indexOf('void submit()') > guardIdx, '守卫必须先于 submit（让位时不提交）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
