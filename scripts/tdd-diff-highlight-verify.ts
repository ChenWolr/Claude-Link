// tdd-diff-highlight-verify.ts
// diff-highlight 纯函数契约：语言推断 + hljs HTML→token 解析。
// 运行：npx tsx scripts/tdd-diff-highlight-verify.ts
import { strict as assert } from 'node:assert';
import { extToLang, highlightLineToTokens, mergeTokensWithDiff } from '../src/renderer/utils/diff-highlight';
import type { DiffSeg } from '../src/renderer/utils/diff-parser';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

check('extToLang: 常见扩展名映射到 hljs language', () => {
  assert.equal(extToLang('a.ts'), 'typescript');
  assert.equal(extToLang('a.js'), 'javascript');
  assert.equal(extToLang('a.py'), 'python');
  assert.equal(extToLang('a.json'), 'json');
  assert.equal(extToLang('a.md'), 'markdown');
  assert.equal(extToLang('a.vue'), 'xml');
});

check('extToLang: 未知扩展名/无扩展名 → plaintext', () => {
  assert.equal(extToLang('a.xyzunknown'), 'plaintext');
  assert.equal(extToLang('README'), 'plaintext');
  assert.equal(extToLang(''), 'plaintext');
});

check('highlightLineToTokens: 简单代码行切成 token 且 cls 非空', () => {
  const toks = highlightLineToTokens('const x = 1;', 'typescript');
  assert.ok(toks.length >= 1, '至少 1 个 token');
  // 'const' 应被识别为 keyword（hljs-keyword）
  const constTok = toks.find((t) => t.text === 'const');
  assert.ok(constTok, '须切出 const 文本节点');
  assert.ok(constTok!.cls.includes('hljs-keyword'), `const 须标 hljs-keyword，实际 ${constTok!.cls}`);
});

check('highlightLineToTokens: 合并相邻同 cls 的纯文本节点', () => {
  const toks = highlightLineToTokens('hello world', 'plaintext');
  // plaintext 下整行一个 token
  assert.equal(toks.length, 1, 'plaintext 整行单 token');
  assert.equal(toks[0]!.text, 'hello world');
});

check('highlightLineToTokens: 空行兜底单 token', () => {
  const toks = highlightLineToTokens('', 'typescript');
  assert.ok(toks.length >= 1);
  assert.equal(toks[0]!.text, '');
});

check('highlightLineToTokens: 未注册 language → plaintext 兜底不抛错', () => {
  const toks = highlightLineToTokens('x = 1', 'totally-not-a-language');
  assert.ok(toks.length >= 1);
});

check('mergeTokensWithDiff: 无 segs → 全 eq 透传 cls', () => {
  const toks = [{ text: 'ab', cls: 'hljs-keyword' }];
  const out = mergeTokensWithDiff(toks, undefined);
  assert.equal(out.length, 1);
  assert.equal(out[0]!.diff, 'eq');
  assert.equal(out[0]!.cls, 'hljs-keyword');
});

check('mergeTokensWithDiff: segs 把字符标成 del/ins/eq', () => {
  const toks = [{ text: 'abc', cls: '' }];
  // 重组回 'abc'：a=eq, b=del, c=eq
  const segs: DiffSeg[] = [{ s: 'eq', x: 'a' }, { s: 'del', x: 'b' }, { s: 'eq', x: 'c' }];
  const out = mergeTokensWithDiff(toks, segs);
  assert.deepEqual(out.map((o) => o.text), ['a', 'b', 'c']);
  assert.deepEqual(out.map((o) => o.diff), ['eq', 'del', 'eq']);
});

check('不变量: token 拼接恒等于原文（含 < > & " 等特殊字符）', () => {
  const cases = ['const x: number = 1;', 'a < b && c > d', 's = "str";', '// a < b > c', '<div class="x">', ''];
  for (const code of cases) {
    const toks = highlightLineToTokens(code, 'typescript');
    const joined = toks.map((t) => t.text).join('');
    assert.equal(joined, code, `token 拼接须等于原文（${JSON.stringify(code)}），实际 ${JSON.stringify(joined)}`);
  }
});

check('highlightLineToTokens: HTML 实体反转义，不残留 &lt; &gt; &amp;', () => {
  const toks = highlightLineToTokens('a < b && c > d', 'typescript');
  const joined = toks.map((t) => t.text).join('');
  assert.ok(!joined.includes('&lt;'), '不得残留 &lt;');
  assert.ok(!joined.includes('&gt;'), '不得残留 &gt;');
  assert.ok(!joined.includes('&amp;'), '不得残留 &amp;');
  assert.ok(joined.includes('<'), '须还原 <');
  assert.ok(joined.includes('&&'), '须还原 &&');
  assert.ok(joined.includes('>'), '须还原 >');
});

check('highlightLineToTokens: 超长行护栏 → 不高亮、不抛错、原样返回', () => {
  const long = 'x'.repeat(2001);
  const toks = highlightLineToTokens(long, 'typescript');
  assert.equal(toks.length, 1);
  assert.equal(toks[0]!.cls, '');
  assert.equal(toks[0]!.text, long);
});

console.log(`\ndiff-highlight: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
