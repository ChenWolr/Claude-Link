// tdd-bugfix-p2-20-hold-pointer-capture-verify.ts
// P2-20 契约钉：触屏长按圆环滑出不可取消 → 手指离开仍发 /compact。
//
// 记账更正（B4 契约普查 2026-09-08）：本脚本原头注释宣称「startHold 中 setPointerCapture
// 后，滑出触发隐式 pointerleave 取消长按」——该指针模型已被 round2 §4.6 真窗实证推翻
// （Pointer Events 规范：捕获期间指针视为始终位于捕获元素上，**不触发**隐式
// pointerleave）。滑出误发的真正修复在同链 tdd-bugfix-p2-20-hold-boundary-verify.ts
// （pointerup/pointermove 与按钮 rect 的边界判定）；本脚本仅钉 capture/release 接线形态
// （结构契约，触屏交互本身记入 §5 人工清单）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-20-hold-pointer-capture-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/components/chat/ContextButton.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① startHold 内 setPointerCapture（失败静默降级）', () => {
  const body = src.slice(src.indexOf('function startHold'));
  assert.match(body, /setPointerCapture\(e\.pointerId\)/);
  assert.match(body, /catch/, 'capture 失败须 try/catch 静默降级');
});
check('② pointerup 显式释放捕获', () => {
  assert.match(src, /function endHold/);
  assert.match(src, /releasePointerCapture\(e\.pointerId\)/);
});
check('③ 模板 pointerup 绑 endHold；leave/cancel 仍绑 resetHold（回归）', () => {
  assert.match(src, /@pointerup="endHold"/);
  assert.match(src, /@pointerleave="resetHold"/);
  assert.match(src, /@pointercancel="resetHold"/);
});
check('④ 1 秒长按语义不变（HOLD_DURATION_MS 保留）', () => {
  assert.match(src, /HOLD_DURATION_MS = 1000/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
