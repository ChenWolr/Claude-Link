// tdd-layout-contract-verify.ts
// 配置页布局接线契约（结构文本契约）：钉住「配置页不再用 aspect-ratio:3/2 锁死工作区、
// 不再用 ResizeObserver 实测舞台、内容列宽统一绑定 min(100%, var(--chat-bottom-max-width))、
// 工作区 flex:1 填满舞台剩余高度」这一套消除「最大化 vs 还原不一致」的接线不变量。
// 运行：npx tsx scripts/tdd-layout-contract-verify.ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const src = readFileSync(join(__dirname, '../src/renderer/pages/ConfigPage.vue'), 'utf8');

check('配置页不再锁 aspect-ratio（3:2 锁死已移除）', () => {
  // 匹配真实 CSS 声明（aspect-ratio: 带冒号），不误伤注释里的「aspect-ratio」文字。
  assert.ok(!/aspect-ratio\s*:/i.test(src), '仍含 aspect-ratio 声明——工作区仍被锁死比例');
});

check('配置页不再用 ResizeObserver 实测舞台尺寸', () => {
  // 匹配真实构造调用（new ResizeObserver / ResizeObserver(），不误伤注释文字。
  assert.ok(!/new\s+ResizeObserver\s*\(/.test(src), '仍含 new ResizeObserver——保留 JS 往返列宽逻辑');
});

check('配置页不再用 min(舞台宽, 舞台高×1.5) 双变量公式', () => {
  assert.ok(!/Math\.min\(w,\s*h\s*\*\s*1\.5\)/.test(src), '仍含 Math.min(w, h*1.5)——保留双变量取小');
});

check('内容列宽绑定统一 800px 契约 min(100%, var(--chat-bottom-max-width))', () => {
  assert.ok(
    src.includes("'--col-w': 'min(100%, var(--chat-bottom-max-width))'"),
    '--col-w 未绑定到 min(100%, var(--chat-bottom-max-width))',
  );
});

check('工作区 .workbench 用 flex:1 填满舞台剩余高度', () => {
  assert.ok(
    /\.workbench\s*\{[^}]*flex:\s*1[^}]*\}/s.test(src),
    '.workbench 未用 flex:1 填满（可能仍是 flex:none）',
  );
});

check('settings-inner 不再用 5% 百分比 gutter（改固定 2rem）', () => {
  assert.ok(!/padding:\s*1\.5rem\s*5%/.test(src), '仍用 5% 百分比 gutter');
  assert.ok(/padding:\s*1\.5rem\s*2rem\s*1\.75rem/.test(src), 'padding 未收敛到 2rem 固定值');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
