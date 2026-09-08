// tdd-bugfix-p3-07-mask-short-key-verify.ts
// P3-7 契约钉：maskApiKey 对 ≤4 字符 key 完全泄露（slice(-4) 无下限）。
// 修复语义：≤8 字符（trim 后）返回纯 'sk-…****'，不尾随任何原文。
// 运行：npx tsx scripts/tdd-bugfix-p3-07-mask-short-key-verify.ts

import { strict as assert } from 'node:assert';
import { maskApiKey } from '../src/shared/provider-library';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 空串 → 空串（回归）', () => assert.equal(maskApiKey(''), ''));
check('② 1 字符 → 纯占位', () => assert.equal(maskApiKey('a'), 'sk-…****'));
check('③ 4 字符 → 纯占位（原完全泄露）', () => {
  const m = maskApiKey('abcd');
  assert.equal(m, 'sk-…****');
  assert.ok(!m.includes('abcd'));
});
check('④ 8 字符 → 纯占位（边界含）', () => assert.equal(maskApiKey('12345678'), 'sk-…****'));
check('⑤ 9 字符 → 尾 4 位照常', () => assert.equal(maskApiKey('123456789'), 'sk-…****6789'));
check('⑥ 32 字符 → 尾 4 位照常（回归）', () => assert.equal(maskApiKey('sk-ant-real-secret-9527'), 'sk-…****9527'));
check('⑦ 首尾空白先 trim 再判长（纯空格=空串）', () => assert.equal(maskApiKey('   '), ''));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
