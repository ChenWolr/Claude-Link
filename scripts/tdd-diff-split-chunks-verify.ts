// tdd-diff-split-chunks-verify.ts
// buildSplitChunks 契约：把 ParsedDiffFile.groups 拍成 SplitLayout（左右完整行 + 对齐块）。
// 关键：相邻 del+add 识别为 edit（M:N）；纯增 leftSize=0；纯删 rightSize=0；same 等长。
// 运行：npx tsx scripts/tdd-diff-split-chunks-verify.ts
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { buildSplitChunks } from '../src/renderer/utils/diff-render';
import { parseUnifiedDiff, type ParsedDiffFile } from '../src/renderer/utils/diff-parser';

let pass = 0; let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const LH = 22;
function mkFile(groups: ParsedDiffFile['groups']): ParsedDiffFile {
  return { path: 'x', groups, binary: false };
}

check('纯 ctx → 单 same chunk，左右等长', () => {
  const f = mkFile([{ k: 'ctx', L: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }], R: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }] }]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks.length, 1);
  assert.equal(lay.chunks[0]!.kind, 'same');
  assert.equal(lay.chunks[0]!.leftSize, 2);
  assert.equal(lay.chunks[0]!.rightSize, 2);
  assert.equal(lay.chunks[0]!.size, 2);
  assert.equal(lay.chunks[0]!.navIndex, null);
  assert.equal(lay.leftLines.length, 2);
  assert.equal(lay.rightLines.length, 2);
  assert.equal(lay.riverHeight, 2 * LH);
});

check('纯增 add → 单 add chunk，leftSize=0', () => {
  const f = mkFile([{ k: 'add', L: [], R: [{ n: 1, t: 'x' }, { n: 2, t: 'y' }] }]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks[0]!.kind, 'add');
  assert.equal(lay.chunks[0]!.leftSize, 0);
  assert.equal(lay.chunks[0]!.rightSize, 2);
  assert.equal(lay.chunks[0]!.size, 2);
  assert.equal(lay.chunks[0]!.navIndex, 0);
  assert.equal(lay.leftLines.length, 0);
  assert.equal(lay.rightLines.length, 2);
});

check('纯删 del → 单 del chunk，rightSize=0', () => {
  const f = mkFile([{ k: 'del', L: [{ n: 1, t: 'x' }], R: [] }]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks[0]!.kind, 'del');
  assert.equal(lay.chunks[0]!.leftSize, 1);
  assert.equal(lay.chunks[0]!.rightSize, 0);
});

check('mod 1:1 → edit chunk，左右各 1', () => {
  const f = mkFile([{ k: 'mod', L: [{ n: 1, t: 'old', segs: [] }], R: [{ n: 1, t: 'new', segs: [] }] }]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks[0]!.kind, 'edit');
  assert.equal(lay.chunks[0]!.leftSize, 1);
  assert.equal(lay.chunks[0]!.rightSize, 1);
  assert.equal(lay.chunks[0]!.navIndex, 0);
});

check('相邻 del+add（不等长 M:N）→ 合并为单个 edit chunk', () => {
  const f = mkFile([
    { k: 'del', L: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }], R: [] },
    { k: 'add', L: [], R: [{ n: 1, t: 'c' }] },
  ]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks.length, 1, '相邻 del+add 须合并为 1 个 edit chunk');
  assert.equal(lay.chunks[0]!.kind, 'edit');
  assert.equal(lay.chunks[0]!.leftSize, 2);
  assert.equal(lay.chunks[0]!.rightSize, 1);
  assert.equal(lay.chunks[0]!.size, 2);
});

check('相邻 del+add 但中间隔了 ctx → 不合并，各自独立 chunk', () => {
  const f = mkFile([
    { k: 'del', L: [{ n: 1, t: 'a' }], R: [] },
    { k: 'ctx', L: [{ n: 2, t: 'm' }], R: [{ n: 2, t: 'm' }] },
    { k: 'add', L: [], R: [{ n: 3, t: 'c' }] },
  ]);
  const lay = buildSplitChunks(f);
  // del(ctx)add → del chunk + same chunk + add chunk（不合并）
  assert.equal(lay.chunks.length, 3);
  assert.equal(lay.chunks[0]!.kind, 'del');
  assert.equal(lay.chunks[1]!.kind, 'same');
  assert.equal(lay.chunks[2]!.kind, 'add');
});

check('navIndex 只对改动块递增，same 不占号', () => {
  const f = mkFile([
    { k: 'ctx', L: [{ n: 1, t: 'a' }], R: [{ n: 1, t: 'a' }] },
    { k: 'add', L: [], R: [{ n: 2, t: 'b' }] },
    { k: 'ctx', L: [{ n: 3, t: 'c' }], R: [{ n: 3, t: 'c' }] },
    { k: 'del', L: [{ n: 4, t: 'd' }], R: [] },
  ]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks[0]!.navIndex, null); // same
  assert.equal(lay.chunks[1]!.navIndex, 0);    // add
  assert.equal(lay.chunks[2]!.navIndex, null); // same
  assert.equal(lay.chunks[3]!.navIndex, 1);    // del
});

check('leftStart/rightStart 在多块场景累进正确', () => {
  const f = mkFile([
    { k: 'ctx', L: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }], R: [{ n: 1, t: 'a' }, { n: 2, t: 'b' }] },
    { k: 'add', L: [], R: [{ n: 3, t: 'c' }] },
  ]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks[0]!.leftStart, 0);
  assert.equal(lay.chunks[0]!.rightStart, 0);
  // 第二块：ctx 占了左 2 行右 2 行
  assert.equal(lay.chunks[1]!.leftStart, 2);
  assert.equal(lay.chunks[1]!.rightStart, 2);
});

check('skip group → 哨兵 chunk（左右栏各占 1 行，带 skipCount，让后续 chunk 的 Y 计算自然正确）', () => {
  const f = mkFile([
    { k: 'ctx', L: [{ n: 1, t: 'a' }], R: [{ n: 1, t: 'a' }] },
    { k: 'skip', L: [], R: [], skipCount: 5 },
    { k: 'add', L: [], R: [{ n: 7, t: 'b' }] },
  ]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks.length, 3, 'ctx + skip 哨兵 + add = 3 块');
  const skip = lay.chunks[1]!;
  assert.equal(skip.kind, 'skip');
  assert.equal(skip.size, 1, '哨兵占 1 行高');
  assert.equal(skip.leftSize, 1);
  assert.equal(skip.rightSize, 1);
  assert.equal(skip.navIndex, null);
  assert.equal(skip.skipCount, 5);
  // 哨兵占位：左栏 = ctx1 + 哨兵1（add 不加左）；右栏 = ctx1 + 哨兵1 + add1
  assert.equal(lay.leftLines.length, 2);
  assert.equal(lay.rightLines.length, 3);
  // 哨兵占位让 add chunk 的 rightStart 跳过哨兵（=2）→ rightStart×LH 仍是其真实 Y
  assert.equal(lay.chunks[2]!.rightStart, 2);
  // riverHeight 含哨兵：same(1) + skip(1) + add(1) = 3 行
  assert.equal(lay.riverHeight, 3 * LH);
});

check('真实双 hunk diff → parser 与 split chunk 透传精确 skipCount', () => {
  const parsed = parseUnifiedDiff(`diff --git a/x.ts b/x.ts
index 1111111..2222222 100644
--- a/x.ts
+++ b/x.ts
@@ -1,2 +1,2 @@
-old1
+new1
 context1
@@ -10,2 +10,2 @@
-old2
+new2
 context2
`);
  assert.ok(parsed, '真实 unified diff 须可解析');
  const skipGroup = parsed.groups.find((g) => g.k === 'skip');
  assert.equal(skipGroup?.skipCount, 7, '第二 hunk oldStart 10 - 前一 hunk oldEnd 3 = 7');

  const lay = buildSplitChunks(parsed);
  const skip = lay.chunks.find((c) => c.kind === 'skip');
  assert.ok(skip, 'split layout 须保留 parser 的 skip');
  assert.equal(skip.skipCount, 7);
  assert.equal(skip.leftSize, 1);
  assert.equal(skip.rightSize, 1);
  assert.equal(skip.navIndex, null);
});

check('split 左右提示文字须锚定横向可视区', () => {
  const source = readFileSync('src/renderer/components/changes/DiffBody.vue', 'utf8');
  assert.match(source, /leftKindArr\[i\] === 'skip'[\s\S]*leftSkipCount\[i\][\s\S]*行未变更/, '左栏须渲染 skipCount 文案');
  assert.match(source, /rightKindArr\[i\] === 'skip'[\s\S]*rightSkipCount\[i\][\s\S]*行未变更/, '右栏须渲染 skipCount 文案');
  assert.equal(source.match(/class="ctx-gap__label"/g)?.length, 2, 'split 左右提示文字须各有一个独立内层标签');
  assert.match(source, /\.diff-row--split \.ctx-gap__label\s*\{[\s\S]*position:\s*sticky;[\s\S]*left:\s*0;/, 'split 提示文字须 sticky 锚定 pane 可视区');
});

check('连续多对 del+add → 多个独立 edit chunk（验证 i++ 消费）', () => {
  const f = mkFile([
    { k: 'del', L: [{ n: 1, t: 'a1' }], R: [] },
    { k: 'add', L: [], R: [{ n: 1, t: 'b1' }] },
    { k: 'del', L: [{ n: 2, t: 'a2' }], R: [] },
    { k: 'add', L: [], R: [{ n: 2, t: 'b2' }] },
  ]);
  const lay = buildSplitChunks(f);
  assert.equal(lay.chunks.length, 2, '两对 del+add 须产 2 个 edit');
  assert.deepEqual(lay.chunks.map((c) => c.kind), ['edit', 'edit']);
  assert.deepEqual(lay.chunks.map((c) => c.navIndex), [0, 1]);
});

check('合并 edit 后左右栏行内容正确', () => {
  const f = mkFile([
    { k: 'del', L: [{ n: 1, t: 'old1' }, { n: 2, t: 'old2' }], R: [] },
    { k: 'add', L: [], R: [{ n: 1, t: 'new1' }] },
  ]);
  const lay = buildSplitChunks(f);
  assert.deepEqual(lay.leftLines.map((l) => l.t), ['old1', 'old2'], '左栏须含 del 的旧行');
  assert.deepEqual(lay.rightLines.map((l) => l.t), ['new1'], '右栏须含 add 的新行');
});

check('混合场景 riverHeight 累加 + 左右栏行数可不等', () => {
  const f = mkFile([
    { k: 'ctx', L: [{ n: 1, t: 'c' }], R: [{ n: 1, t: 'c' }] },
    { k: 'del', L: [{ n: 2, t: 'a' }, { n: 3, t: 'b' }], R: [] },
    { k: 'add', L: [], R: [{ n: 2, t: 'x' }] },
  ]);
  const lay = buildSplitChunks(f);
  // same(size1) + edit(size2) → river = 3 行
  assert.equal(lay.riverHeight, 3 * LH, 'riverHeight 须 = sum(size)×LH');
  assert.equal(lay.leftLines.length, 3, '左栏 = ctx1 + del2');
  assert.equal(lay.rightLines.length, 2, '右栏 = ctx1 + add1（删多增少）');
});

console.log(`\ndiff-split-chunks: ${pass} pass, ${fail} fail`);
process.exit(fail > 0 ? 1 : 0);
