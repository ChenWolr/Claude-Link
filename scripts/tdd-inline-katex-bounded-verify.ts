// tdd-inline-katex-bounded-verify.ts
// 问题④（2026-09-27 六使用问题）内容超出会话框 TDD 验证脚本，main.css 源码契约：
//   C1–C4  行内 KaTeX 宽度约束规则字面 + 块级既有保护保活 + 封堵三层与 scroller 不动。
// 根因：.katex .base 为 inline-block + nowrap + min-content 原子块（katex.css），长行内公式
// 撑破气泡 → .message-list__scroller 出横向滚动条（默认透明滚动条，观感「截断在框外」）。
// main.css 此前只护了块级 .katex-display；本修复为行内 .katex 补同款约束（约束在公式内部
// 横向滚动，不外溢）。
// 运行：npx tsx scripts/tdd-inline-katex-bounded-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const css = readFileSync(join(__dirname, '../src/renderer/assets/styles/main.css'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

console.log('\n=== 问题④ · 行内 KaTeX 宽度约束契约 ===');

check('C1 行内 .katex 约束规则存在：inline-block + max-width:100% + overflow-x:auto + vertical-align:bottom', () => {
  const rule = css.match(/\.markdown-body \.katex\s*\{[^}]*\}/g)?.find((r) => r.includes('max-width: 100%')) ?? '';
  assert.ok(rule, '缺 .markdown-body .katex 宽度约束规则');
  assert.ok(rule.includes('display: inline-block;'), `缺 display: inline-block：${rule}`);
  assert.ok(rule.includes('max-width: 100%;'), `缺 max-width: 100%：${rule}`);
  assert.ok(rule.includes('overflow-x: auto;'), `缺 overflow-x: auto：${rule}`);
  assert.ok(rule.includes('vertical-align: bottom;'), `缺 vertical-align: bottom：${rule}`);
});

check('C2 既有块级保护保活：.katex-display overflow-x:auto 不动', () => {
  const rule = css.match(/\.markdown-body \.katex-display\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(rule.includes('overflow-x: auto'), `块级保护被动：${rule}`);
});

check('C3 既有 .katex 排版规则保活：font-size/color 行不并入约束规则', () => {
  const rules = css.match(/\.markdown-body \.katex\s*\{[^}]*\}/g) ?? [];
  const typographic = rules.find((r) => r.includes('font-size: 1.05em'));
  assert.ok(typographic, '既有 .katex font-size/color 规则丢失');
  assert.ok(!typographic.includes('max-width'), '排版规则被混入约束属性（应独立成条）');
});

check('C4 不动清单：.code-block 封堵三层与 .markdown-body 表格约束原样存在', () => {
  assert.ok(/\.markdown-body \.code-block\s*\{[^}]*overflow: hidden;/.test(css), '.code-block overflow:hidden 被动');
  assert.ok(/\.markdown-body \.code-block code\s*\{[^}]*overflow-x: auto;/.test(css), '.code-block code overflow-x 被动');
  assert.ok(/\.markdown-body table:not\(\.d2h-diff-table\)\s*\{[^}]*max-width: 100%;/.test(css), '表格 max-width 约束被动');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
