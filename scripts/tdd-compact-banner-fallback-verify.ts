// tdd-compact-banner-fallback-verify.ts
// 问题⑤（2026-09-27 六使用问题）疑似自动压缩误导文案 TDD 验证脚本：
//   L1–L5  行为用例——formatCompactionSummary 无账单数字 fallback 按 trigger 分流（node 实测）；
//   C1     源码契约——context-usage.ts fallback 三元分流形态。
// 事实：App 零程序自动压缩（/compact 唯一发送点用户驱动；引擎 transcript 压缩事件 18 起全
// manual、auto 为 0）；主误导源 = 无账单数字时的 fallback 文案对任何 trigger 写死
//「Claude Code 已自动压缩上下文」。有数字分支早已按 trigger 区分。
// 撞钉申报：tdd-context-usage-verify.ts 空 trigger 断言随本改动最小同步（5db45f7 先例）。
// 运行：npx tsx scripts/tdd-compact-banner-fallback-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatCompactionSummary } from '../src/shared/context-usage';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

console.log('\n=== L1–L5 · 压缩横幅 fallback 文案分流（node 实测） ===');

check('L1 无数字 + 无 trigger → 「上下文已压缩」（不写死「自动」）', () => {
  const r = formatCompactionSummary({});
  assert.equal(r.hasNumbers, false);
  assert.equal(r.title, '上下文已压缩', `实际：${r.title}`);
});
check('L2 无数字 + trigger manual → 「上下文已压缩」（实测 18/18 全 manual，误导主源）', () => {
  const r = formatCompactionSummary({ trigger: 'manual' });
  assert.equal(r.hasNumbers, false);
  assert.equal(r.title, '上下文已压缩', `实际：${r.title}`);
});
check('L3 无数字 + trigger auto → 保留「Claude Code 已自动压缩上下文」', () => {
  const r = formatCompactionSummary({ trigger: 'auto' });
  assert.equal(r.hasNumbers, false);
  assert.equal(r.title, 'Claude Code 已自动压缩上下文', `实际：${r.title}`);
});
check('L4 有数字 + auto/manual 文案不变（既有分流不受影响）', () => {
  const auto = formatCompactionSummary({ fromTokens: 91043, toTokens: 1650, droppedTokens: 89393, trigger: 'auto' });
  assert.ok(auto.title.startsWith('已自动压缩上下文：'), `实际：${auto.title}`);
  const manual = formatCompactionSummary({ fromTokens: 47672, toTokens: 1398, droppedTokens: 46274, trigger: 'manual' });
  assert.ok(manual.title.startsWith('已压缩上下文：'), `实际：${manual.title}`);
  assert.ok(!manual.title.includes('自动'));
});
check('L5 任何文案不含 undefined/NaN（既有守卫保活）', () => {
  for (const c of [{}, { trigger: 'manual' }, { trigger: 'auto' }, { fromTokens: 1, trigger: 'manual' }]) {
    const r = formatCompactionSummary(c);
    assert.ok(!/undefined|NaN/.test(r.title), `${JSON.stringify(c)} → ${r.title}`);
  }
});

// ── C1 · 源码契约 ──

const src = readFileSync(join(__dirname, '../src/shared/context-usage.ts'), 'utf8');

console.log('\n=== C1 · context-usage.ts 源码契约 ===');

check('C1 fallback 按 trigger 三元分流字面存在', () => {
  assert.ok(
    src.includes("c.trigger === 'auto' ? 'Claude Code 已自动压缩上下文' : '上下文已压缩'"),
    'fallback 缺按 trigger 的三元分流',
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
