// tdd-diff-search-verify.ts
// diff 搜索纯函数契约：按逻辑行匹配、按渲染侧聚合，并支持循环导航。
// 运行：npx tsx scripts/tdd-diff-search-verify.ts
import { strict as assert } from 'node:assert';
import {
  applySearchRanges,
  buildDiffSearchMatches,
  groupSearchMatchesByLine,
  moveSearchIndex,
} from '../src/renderer/utils/diff-search';
import type { SearchableToken } from '../src/renderer/utils/diff-search';
import type { ParsedDiffFile } from '../src/renderer/utils/diff-parser';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const file: ParsedDiffFile = {
  path: 'x.ts',
  binary: false,
  groups: [
    { k: 'ctx', L: [{ n: 10, t: 'Alpha alpha' }], R: [{ n: 12, t: 'Alpha alpha' }] },
    { k: 'mod', L: [{ n: 11, t: 'left ALPHA alpha' }], R: [{ n: 13, t: 'right alpha' }] },
    { k: 'add', L: [], R: [{ n: 14, t: 'added alpha' }] },
    { k: 'del', L: [{ n: 12, t: 'deleted Alpha' }], R: [] },
    { k: 'ws', L: [{ n: 13, t: 'x  y alpha' }], R: [{ n: 15, t: 'x y ALPHA' }] },
    { k: 'skip', L: [], R: [], skipCount: 8 },
    { k: 'ctx', L: [{ n: 22, t: 'a  b' }], R: [{ n: 24, t: 'a  b' }] },
  ],
};

check('普通文本搜索不区分大小写，同行返回全部非重叠结果', () => {
  const matches = buildDiffSearchMatches(file, 'alpha');
  assert.equal(matches.length, 9);
  assert.deepEqual(matches.slice(0, 2).map((m) => [m.start, m.end, m.occurrence]), [
    [0, 5, 0],
    [6, 11, 1],
  ]);
  assert.deepEqual(matches.map((m) => m.side), [
    'both', 'both', 'left', 'left', 'right', 'right', 'left', 'left', 'right',
  ]);
});

check('Unicode 大小写匹配使用原文索引，不因折叠扩长而错位', () => {
  const unicodeFile: ParsedDiffFile = {
    path: 'unicode.ts',
    binary: false,
    groups: [{ k: 'add', L: [], R: [{ n: 1, t: 'İX' }] }],
  };
  const xMatches = buildDiffSearchMatches(unicodeFile, 'x');
  assert.deepEqual(xMatches.map((m) => [m.start, m.end]), [[1, 2]]);

  const dottedIMatches = buildDiffSearchMatches(unicodeFile, 'İ');
  assert.deepEqual(dottedIMatches.map((m) => [m.start, m.end]), [[0, 1]]);
});

check('Unicode 不区分大小写匹配希腊普通 sigma 与终结 sigma', () => {
  const sigmaFile: ParsedDiffFile = {
    path: 'sigma.ts',
    binary: false,
    groups: [{ k: 'add', L: [], R: [{ n: 1, t: 'ς' }] }],
  };
  const matches = buildDiffSearchMatches(sigmaFile, 'Σ');
  assert.deepEqual(matches.map((m) => [m.start, m.end]), [[0, 1]]);
});

check('查询按普通文本处理，正则元字符必须完整转义', () => {
  const regexFile: ParsedDiffFile = {
    path: 'regex.ts',
    binary: false,
    groups: [{ k: 'add', L: [], R: [{ n: 1, t: 'a+b a.b [x] \\d' }] }],
  };
  assert.deepEqual(buildDiffSearchMatches(regexFile, 'a+b').map((m) => [m.start, m.end]), [[0, 3]]);
  assert.deepEqual(buildDiffSearchMatches(regexFile, 'a.b').map((m) => [m.start, m.end]), [[4, 7]]);
  assert.deepEqual(buildDiffSearchMatches(regexFile, '[x]').map((m) => [m.start, m.end]), [[8, 11]]);
  assert.deepEqual(buildDiffSearchMatches(regexFile, '\\d').map((m) => [m.start, m.end]), [[12, 14]]);
});

check('ctx 左右文本相同只生成逻辑结果，保留旧/新行号并标记 both', () => {
  const matches = buildDiffSearchMatches(file, 'alpha').filter((m) => m.lineKey === '0:0');
  assert.equal(matches.length, 2, '两个文本命中，而不是左右各复制成四个结果');
  assert.ok(matches.every((m) => m.side === 'both'));
  assert.ok(matches.every((m) => m.oldLine === 10 && m.newLine === 12));
});

check('mod/ws 分别搜索左右，add 只搜右侧，del 只搜左侧，skip 不搜索', () => {
  const matches = buildDiffSearchMatches(file, 'alpha');
  const byLine = new Map<string, string[]>();
  for (const match of matches) {
    const sides = byLine.get(match.lineKey) ?? [];
    sides.push(match.side);
    byLine.set(match.lineKey, sides);
  }
  assert.deepEqual(byLine.get('1:0'), ['left', 'left', 'right']);
  assert.deepEqual(byLine.get('2:0'), ['right']);
  assert.deepEqual(byLine.get('3:0'), ['left']);
  assert.deepEqual(byLine.get('4:0'), ['left', 'right']);
  assert.equal(byLine.has('5:0'), false);

  const modLeft = matches.find((m) => m.lineKey === '1:0' && m.side === 'left');
  assert.deepEqual([modLeft?.oldLine, modLeft?.newLine], [11, 13]);
  const added = matches.find((m) => m.lineKey === '2:0');
  assert.deepEqual([added?.oldLine, added?.newLine], [null, 14]);
  const deleted = matches.find((m) => m.lineKey === '3:0');
  assert.deepEqual([deleted?.oldLine, deleted?.newLine], [12, null]);
});

check('空查询无结果；查询空格不 trim，双空格可被搜索', () => {
  assert.deepEqual(buildDiffSearchMatches(file, ''), []);
  const spaces = buildDiffSearchMatches(file, '  ');
  assert.equal(spaces.length, 2, 'ws 左侧与 ctx 逻辑行各有一个双空格命中');
  assert.deepEqual(spaces.map((m) => [m.lineKey, m.side, m.start, m.end]), [
    ['4:0', 'left', 1, 3],
    ['6:0', 'both', 1, 3],
  ]);
});

check('ID 对相同查询的不同大小写稳定，且同批结果唯一', () => {
  const lower = buildDiffSearchMatches(file, 'alpha');
  const upper = buildDiffSearchMatches(file, 'ALPHA');
  assert.deepEqual(upper.map((m) => m.id), lower.map((m) => m.id));
  assert.equal(new Set(lower.map((m) => m.id)).size, lower.length);
});

check('null 文件没有结果', () => {
  assert.deepEqual(buildDiffSearchMatches(null, 'alpha'), []);
});

check('按渲染行聚合：both 同一范围同时进入 old:N 和 new:N 索引', () => {
  const matches = buildDiffSearchMatches(file, 'alpha');
  const index = groupSearchMatchesByLine(matches);
  assert.deepEqual(index.left.get('old:10'), [
    { matchId: matches[0]!.id, start: 0, end: 5 },
    { matchId: matches[1]!.id, start: 6, end: 11 },
  ]);
  assert.deepEqual(index.right.get('new:12'), index.left.get('old:10'));
  assert.equal(index.left.has('old:14'), false, 'add 不得进入左侧索引');
  assert.equal(index.right.has('new:16'), false, 'del 不得虚构新行索引');
  assert.equal(index.left.get('old:11')?.length, 2);
  assert.equal(index.right.get('new:13')?.length, 1);
  assert.equal(index.left.has('0:0'), false, '内部 lineKey 不得作为渲染索引键');
});

check('行号索引明确使用 old:1/new:1，不暴露内部 lineKey', () => {
  const match = {
    id: 'm1',
    side: 'both' as const,
    oldLine: 1,
    newLine: 1,
    lineKey: '0:0',
    start: 0,
    end: 2,
    occurrence: 0,
  };
  const index = groupSearchMatchesByLine([match]);
  const expected = [{ matchId: 'm1', start: 0, end: 2 }];
  assert.deepEqual(index.left.get('old:1'), expected);
  assert.deepEqual(index.right.get('new:1'), expected);
  assert.equal(index.left.has('0:0'), false);
  assert.equal(index.right.has('0:0'), false);
});

check('循环导航处理首尾、初始索引、大步长和空结果', () => {
  assert.equal(moveSearchIndex(-1, 1, 3), 0);
  assert.equal(moveSearchIndex(0, -1, 3), 2);
  assert.equal(moveSearchIndex(2, 1, 3), 0);
  assert.equal(moveSearchIndex(1, 5, 3), 0);
  assert.equal(moveSearchIndex(1, -5, 3), 2);
  assert.equal(moveSearchIndex(0, 1, 0), -1);
});

const searchableTokens: SearchableToken[] = [
  { text: 'const', cls: 'hljs-keyword', diff: 'eq' },
  { text: ' value', cls: 'hljs-title', diff: 'ins' },
  { text: ' = old', cls: '', diff: 'del' },
];

check('搜索范围可跨两个 token，切分后拼接原文不变并标记当前命中', () => {
  const out = applySearchRanges(searchableTokens, [{ matchId: 'm1', start: 3, end: 8 }], 'm1');
  assert.deepEqual(out.map((token) => token.text), ['con', 'st', ' va', 'lue', ' = old']);
  assert.equal(out.map((token) => token.text).join(''), searchableTokens.map((token) => token.text).join(''));
  assert.deepEqual(out.filter((token) => token.matchId === 'm1').map((token) => token.text), ['st', ' va']);
  assert.ok(out.filter((token) => token.matchId === 'm1').every((token) => token.current === true));
});

check('无搜索范围时保留 token 内容与元数据', () => {
  const out = applySearchRanges(searchableTokens, [], null);
  assert.deepEqual(out, searchableTokens);
});

check('跨 token 命中保留各片段原有 cls 与 diff', () => {
  const out = applySearchRanges(searchableTokens, [{ matchId: 'm2', start: 4, end: 12 }], null);
  assert.deepEqual(
    out.filter((token) => token.matchId === 'm2').map(({ text, cls, diff, current }) => ({ text, cls, diff, current })),
    [
      { text: 't', cls: 'hljs-keyword', diff: 'eq', current: false },
      { text: ' value', cls: 'hljs-title', diff: 'ins', current: false },
      { text: ' ', cls: '', diff: 'del', current: false },
    ],
  );
});

check('越界范围会 clamp，且不丢字、不生成零长度片段', () => {
  const out = applySearchRanges(
    searchableTokens,
    [
      { matchId: 'before', start: -8, end: 2 },
      { matchId: 'after', start: 14, end: 99 },
      { matchId: 'empty', start: 8, end: 8 },
      { matchId: 'outside', start: 99, end: 120 },
    ],
    'after',
  );
  assert.equal(out.map((token) => token.text).join(''), searchableTokens.map((token) => token.text).join(''));
  assert.ok(out.every((token) => token.text.length > 0));
  assert.deepEqual(out.filter((token) => token.matchId === 'before').map((token) => token.text).join(''), 'co');
  assert.deepEqual(out.filter((token) => token.matchId === 'after').map((token) => token.text).join(''), 'old');
  assert.ok(out.filter((token) => token.matchId === 'after').every((token) => token.current === true));
  assert.equal(out.some((token) => token.matchId === 'empty' || token.matchId === 'outside'), false);
});

check('同 token 十万密集范围线性切分，保持文本与逐段 matchId', () => {
  const count = 100_000;
  const text = 'x'.repeat(count);
  const ranges = Array.from({ length: count }, (_, index) => ({
    matchId: `dense-${index}`,
    start: index,
    end: index + 1,
  }));
  const startedAt = performance.now();
  const out = applySearchRanges([{ text, cls: 'dense', diff: 'eq' }], ranges, 'dense-99999');
  const elapsedMs = performance.now() - startedAt;
  assert.equal(out.length, count);
  assert.equal(out.map((token) => token.text).join(''), text);
  assert.equal(out[0]?.matchId, 'dense-0');
  assert.equal(out[count - 1]?.matchId, 'dense-99999');
  assert.equal(out[count - 1]?.current, true);
  assert.ok(elapsedMs < 1_500, `十万密集范围耗时 ${elapsedMs.toFixed(1)}ms，疑似仍为平方复杂度`);
});

console.log(`\ndiff-search: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
