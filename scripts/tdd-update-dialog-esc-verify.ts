// tdd-update-dialog-esc-verify.ts
// X3（R14-F1，P2）契约钉：更新弹窗消费 ESC 时 preventDefault，防一次 ESC 双吞。
//
// 根因（复核 CONFIRMED）：UpdateDialog 的 onKeydown 消费 ESC 时不 preventDefault，且
// ChatPage escConsumerOpen() 七探针（interaction/diff/toolDiff/lightbox/.slash-menu/
// .menu 系/.export-overlay）不含更新弹窗——两 window 监听器同拍各执行一次：
// 一次 ESC = dismissUpdate（记 dismissedVersions）+ ChatPage 急停 abort（正在流式的
// 回合被中断；若属队列执行，按 README 队列语义「回合失败或中断触发熔断」连锁暂停全队列）。
//
// 修复语义（方案①，一行）：onKeydown 在「本组件消费」分支（已通过 Escape/dialogVisible
// 守卫与 isTopmost 让位检查之后）dismissUpdate() 之前 e.preventDefault()——ChatPage
// onGlobalKeydown 既有 e.defaultPrevented 守卫随即让位，abort 不触发；escConsumerOpen
// 无需改动。让位分支（isTopmost false）保持不 preventDefault（A9/D14-F5 让位链不回归，
// 高层遮罩自行消费）；弹窗不可见时保持不 preventDefault（不吞 ChatPage 急停的 Esc）。
//
// 运行：npx tsx scripts/tdd-update-dialog-esc-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
const read = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8');
const updateDialog = read('../src/renderer/components/layout/UpdateDialog.vue');
const chatPage = read('../src/renderer/pages/ChatPage.vue');
const selftestList = read('selftest-static-list.txt');

// 提取 Vue SFC 内指定函数体（顶格 } 结束，内层块均带缩进——与既有代码形态匹配）。
function extractFnBody(src: string, fnName: string): string {
  const m = src.match(new RegExp(`function ${fnName}\\([^)]*\\)[^{]*\\{([\\s\\S]*?)\\n\\}`));
  assert.ok(m, `未找到函数 ${fnName}()`);
  return m[1];
}

console.log('\n=== X3-① UpdateDialog.onKeydown 消费分支含 preventDefault，且位于 isTopmost 让位之后、dismissUpdate 之前 ===');
const onKeydown = extractFnBody(updateDialog, 'onKeydown');
check('消费分支含 e.preventDefault()（本组件消费时标记，ChatPage defaultPrevented 守卫随即让位）', () => {
  assert.ok(onKeydown.includes('e.preventDefault()'), 'onKeydown 消费分支缺 e.preventDefault()（R14-F1 双吞根因未修）');
});
check('preventDefault 位于 isTopmost 让位检查之后（让位时不 preventDefault，A9 层级链不回归）', () => {
  const yieldIdx = onKeydown.indexOf('!escHandle.isTopmost()');
  const preventIdx = onKeydown.indexOf('e.preventDefault()');
  assert.ok(yieldIdx !== -1, 'isTopmost 让位检查缺失（A9/D14-F5 形态漂移）');
  assert.ok(preventIdx > yieldIdx, 'preventDefault 须在 isTopmost 让位之后（让位分支不得吞 Esc）');
});
check('preventDefault 位于 dismissUpdate() 之前（先标记后消费，防中途 return 漏标）', () => {
  const preventIdx = onKeydown.indexOf('e.preventDefault()');
  const dismissIdx = onKeydown.indexOf('updateStore.dismissUpdate()');
  assert.ok(dismissIdx !== -1, 'dismissUpdate() 消费调用缺失');
  assert.ok(preventIdx !== -1 && preventIdx < dismissIdx, 'preventDefault 须在 dismissUpdate() 之前');
});
check('Escape + dialogVisible 守卫先于 preventDefault（弹窗不可见时按键不吞 ChatPage 急停的 Esc）', () => {
  const guardIdx = onKeydown.indexOf("e.key !== 'Escape'");
  const visibleIdx = onKeydown.indexOf('!updateStore.dialogVisible');
  const preventIdx = onKeydown.indexOf('e.preventDefault()');
  assert.ok(guardIdx !== -1 && visibleIdx !== -1, 'Escape/dialogVisible 守卫缺失');
  assert.ok(preventIdx > guardIdx && preventIdx > visibleIdx, 'preventDefault 须在两守卫之后（不可见期不 preventDefault）');
});

console.log('\n=== X3-② A9 让位链形态不回归 ===');
check('让位分支（isTopmost false → return，不消费不记 dismissed）原样保留', () => {
  assert.ok(
    updateDialog.includes('if (escHandle && !escHandle.isTopmost()) return;'),
    '让位 return 形态漂移',
  );
});
check('onKeydown 内 preventDefault 仅出现一次（消费分支单点，让位/守卫分支零混入）', () => {
  const count = (onKeydown.match(/e\.preventDefault\(\)/g) || []).length;
  assert.equal(count, 1, `preventDefault 出现 ${count} 次，预期 1 次`);
});

console.log('\n=== X3-③ 修复前提：ChatPage defaultPrevented 守卫位于 abort 之前（方案①的让位出口） ===');
const onGlobalKeydown = extractFnBody(chatPage, 'onGlobalKeydown');
check('onGlobalKeydown 含 e.defaultPrevented 守卫且先于 void abort()（UpdateDialog preventDefault 后急停即让位）', () => {
  const preventGuardIdx = onGlobalKeydown.indexOf('e.defaultPrevented');
  const abortIdx = onGlobalKeydown.indexOf('void abort()');
  assert.ok(preventGuardIdx !== -1, 'e.defaultPrevented 守卫缺失（方案①前提失效）');
  assert.ok(abortIdx !== -1, 'void abort() 急停调用缺失');
  assert.ok(preventGuardIdx < abortIdx, 'defaultPrevented 守卫须在 abort 之前');
});

console.log('\n=== X3-④ selftest 清单登记 ===');
check('selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(
    selftestList.includes('scripts/tdd-update-dialog-esc-verify.ts'),
    '清单未登记（尾部追加一行）',
  );
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
