// tdd-contextbutton-hold-composable-verify.ts
// A6（D04-F1，P2）契约钉：ContextButton 长按压缩迁移到 useHoldAction composable。
//
// 根因：ContextButton 保留旧内联长按实现（自管 rAF/定时器/指针处理），缺 use-hold-action
// 「清零轮 A 项」的两道防护——①窗口失焦（Alt+Tab）取消：长按中切窗松手，OS 把 pointerup
// 路由给其他应用，rAF 到点仍 emit('compress') 误发不可撤销的 /compact；②sending 翻转取消：
// 长按进行中回合开跑不取消，满 1s 误发。use-hold-action 已沉淀全部修复（window blur 监听、
// 按钮 blur、键盘长按、卸载清理），仅 SessionToolbar 中断按钮接线。
//
// 修复语义：ContextButton 1:1 参照 SessionToolbar 中断按钮接线迁移到 composable——自管
// hold 机制（HOLD_DURATION_MS/holdStart/rAF/setPointerCapture/isPointerOutside）全部删除；
// 模板指针绑定形态保留（@pointermove="moveHold" 等，P2-20 契约面）；新增键盘/blur 绑定与
// watch(props.disabled) sending 翻转取消（resetHold 幂等，绝不触发 compress）。
//
// 运行：npx tsx scripts/tdd-contextbutton-hold-composable-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const ctx = readFileSync(new URL('../src/renderer/components/chat/ContextButton.vue', import.meta.url), 'utf8');
const toolbar = readFileSync(new URL('../src/renderer/components/chat/SessionToolbar.vue', import.meta.url), 'utf8');

console.log('\n=== A6-①：ContextButton 引用 composable（自管机制删除） ===');
check('useHoldAction 接线：destructuring 含指针五件套/键盘两件/onBlur/resetHold', () => {
  assert.match(ctx, /import \{ useHoldAction \} from '\.\.\/\.\.\/composables\/use-hold-action';/, '缺 composable import');
  const idx = ctx.indexOf('= useHoldAction(() => emit(\'compress\')');
  assert.ok(idx > -1, '缺 useHoldAction(() => emit(compress)) 调用');
  const head = ctx.slice(ctx.indexOf('const {'), idx);
  for (const k of ['holding', 'holdProgress', 'onPointerDown: startHold', 'onPointerMove: moveHold', 'onPointerUp: endHold', 'onKeydown', 'onKeyup', 'onBlur', 'resetHold']) {
    assert.ok(head.includes(k), `destructuring 缺 ${k}`);
  }
});
check('自管 hold 机制全部删除（rAF/计时器/指针捕获/坐标判定移交 composable）', () => {
  assert.ok(!ctx.includes('HOLD_DURATION_MS'), '残留 HOLD_DURATION_MS');
  assert.ok(!ctx.includes('holdStart'), '残留 holdStart');
  assert.ok(!ctx.includes('requestAnimationFrame'), '残留自管 requestAnimationFrame');
  assert.ok(!ctx.includes('setPointerCapture'), '残留 setPointerCapture（composable 承担）');
  assert.ok(!ctx.includes('isPointerOutside'), '残留 isPointerOutside（composable 承担）');
  assert.ok(!ctx.includes('function startHold'), '残留旧 startHold');
});

console.log('\n=== A6-②：模板绑定（P2-20 指针形态保留 + 新增键盘/blur） ===');
check('指针绑定形态保留（pointerdown.prevent/move/up/leave/cancel）', () => {
  assert.match(ctx, /@pointerdown\.prevent="startHold"/);
  assert.match(ctx, /@pointermove="moveHold"/);
  assert.match(ctx, /@pointerup="endHold"/);
  assert.match(ctx, /@pointerleave="resetHold"/);
  assert.match(ctx, /@pointercancel="resetHold"/);
});
check('新增键盘长按与 blur 绑定（可达性 + 失焦取消路径）', () => {
  assert.match(ctx, /@keydown="onHoldKeydown"/, '缺 @keydown');
  assert.match(ctx, /@keyup="onHoldKeyup"/, '缺 @keyup');
  assert.match(ctx, /@blur="onHoldBlur"/, '缺 @blur');
});

console.log('\n=== A6-③：sending 翻转取消 ===');
check('watch(props.disabled) 翻 true → resetHold（长按中回合开跑取消，绝不触发 compress）', () => {
  assert.match(ctx, /watch\(\(\) => props\.disabled, \(v\) => \{\s*if \(v\) resetHold\(\);/, '缺 sending（disabled）翻转取消 watch');
});
check('SessionToolbar 接线不回退：ContextButton :disabled="sending" @compress', () => {
  assert.match(toolbar, /<ContextButton :disabled="sending" @compress="emit\('compress'\)" \/>/, 'SessionToolbar 接线形态变化');
});

console.log('\n=== A6-④：横幅/弹层既有逻辑不回退 ===');
check('compactedJustNow 横幅 watch 与卸载清理保留', () => {
  assert.match(ctx, /showCompactBanner/, '缺压缩横幅');
  assert.match(ctx, /if \(bannerTimer\) \{ clearTimeout\(bannerTimer\); bannerTimer = null; \}/, '缺横幅定时器清理');
  assert.match(ctx, /onBeforeUnmount/, '缺卸载清理');
});
check('圆环进度环绑定 holdProgress（红色进度环不回退）', () => {
  assert.match(ctx, /:stroke-dasharray="`\$\{holdProgress\} \$\{100 - holdProgress\}`"/, '缺进度环绑定');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
