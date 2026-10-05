// tdd-bugfix-p2-20-hold-boundary-verify.ts
// P2-20 修正（审计 §3/R2 实测）：ContextButton 长按 capture 后滑出按钮**不触发**隐式
// pointerleave（Pointer Events 规范：捕获期间 pointer 视为始终位于捕获元素上）——
// 原注释模型错误；手指滑出后继续按住 ≥1s 仍会画满红圈误发 /compact（触屏误触主要路径）。
//
// 修复语义：
// ① pointerup（endHold）判定指针位置是否滑出按钮边界（e.clientX/Y 与 rect 比对）——
//    滑出 → resetHold 取消；未滑出 → 维持既有完成语义；
// ② pointermove 期间同样做边界判定——捕获使 leave 失效，滑出即取消长按（杀掉误发根因）；
// ③ startHold 的错误注释模型同步修正（不再宣称「捕获触发隐式 pointerleave」）。
//
// A6 同步（2026-09-30，5db45f7 先例最小同步）：ContextButton 长按迁移到 use-hold-action
// composable（D04-F1）——isPointerOutside 边界判定/滑出取消语义随实现移交 composable 承载
//（①②断言重定向到 use-hold-action.ts；该 composable 另有 tdd-hold-abort-verify.ts 行为级
// 覆盖），③④ 中模板绑定与注释形态断言保留/覆盖两文件。语义不变：捕获期间滑出即取消。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-20-hold-boundary-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const composable = fs.readFileSync(path.join(repoRoot, 'src/renderer/composables/use-hold-action.ts'), 'utf8');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/ContextButton.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 边界判定语义（composable）：isPointerOutside 按 clientX/Y 与 rect 比对，up 即 resetHold', () => {
  assert.match(composable, /function isPointerOutside\(e: PointerEvent\): boolean/);
  assert.match(composable, /getBoundingClientRect\(\)/);
  assert.match(composable, /clientX/);
  assert.match(composable, /clientY/);
  const upAt = composable.indexOf('function onPointerUp');
  const upBody = composable.slice(upAt, composable.indexOf('function onPointerLeave', upAt));
  assert.match(upBody, /resetHold\(\)/);
});

check('② pointermove 期间边界判定（捕获使 leave 失效，滑出即取消；composable 承载）', () => {
  const at = composable.indexOf('function onPointerMove');
  assert.ok(at > -1, '缺少 onPointerMove（pointermove 处理）');
  const body = composable.slice(at, composable.indexOf('function onPointerUp', at));
  assert.match(body, /isPointerOutside\(e\)/);
  assert.match(body, /resetHold\(\)/);
  assert.match(src, /@pointermove="moveHold"/);
});

check('③ 错误注释模型已修正（不再宣称 capture 触发隐式 pointerleave；两文件均不得残留）', () => {
  for (const s of [composable, src]) {
    assert.doesNotMatch(s, /触发隐式 pointerleave/);
    assert.doesNotMatch(s, /并触发隐式 pointerleave/);
  }
});

check('④ 既有接线不回退（useHoldAction 接线 / pointerup / pointerleave / pointercancel）', () => {
  assert.match(src, /useHoldAction\(\(\) => emit\('compress'\)\)/);
  assert.match(src, /@pointerup="endHold"/);
  assert.match(src, /@pointerleave="resetHold"/);
  assert.match(src, /@pointercancel="resetHold"/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
