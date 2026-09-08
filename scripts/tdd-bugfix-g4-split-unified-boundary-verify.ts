// tdd-bugfix-g4-split-unified-boundary-verify.ts
// G4（P2）契约钉：splitUnifiedDiff 的回退分段 `split(/\n(?=--- )/)` 对任何行首 `--- ` 都切段——
// hunk 内以 `--- ` 开头的**被删行**（内容如 `-- 分隔线` / `--- divider`）被误当新段起点，
// 产出残缺段（无 +++ 头），parseUnifiedDiff 只取首个 patch 后其余段渲染破损。
//
// 修复语义：段边界加严——`--- ` 行须为文件头形态（非空路径标记）且**紧随 `+++ ` 行**才构成
// 段起点；`diff --git ` 分界路径不变。
//
// 运行：npx tsx scripts/tdd-bugfix-g4-split-unified-boundary-verify.ts

import { strict as assert } from 'node:assert';
import { splitUnifiedDiff } from '../src/renderer/utils/diff-parser';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 合成多段（每段 ---/+++ 配对）仍正确拆分', () => {
  const text = [
    '--- a/file1.txt',
    '+++ b/file1.txt',
    '@@ -1,2 +1,2 @@',
    '-old',
    '+new',
    '--- a/file2.txt',
    '+++ b/file2.txt',
    '@@ -1,1 +1,1 @@',
    '-x',
    '+y',
  ].join('\n');
  const segments = splitUnifiedDiff(text);
  assert.equal(segments.length, 2, `segments=${segments.length}`);
  assert.ok(segments[0].startsWith('--- a/file1.txt'));
  assert.ok(segments[1].startsWith('--- a/file2.txt'));
});

check('② hunk 内以 `--- ` 开头的被删行不再误切段', () => {
  // 被删行内容 `-- divider` 的原始行即 `--- divider`（与文件头同形），但其下一行不是
  // `+++ ` 头——加严后不构成段边界（现实现会误切出无 +++ 头的残缺段）。
  const text = [
    '--- a/notes.md',
    '+++ b/notes.md',
    '@@ -1,3 +1,3 @@',
    ' context',
    '--- divider',
    ' context2',
  ].join('\n');
  const segments = splitUnifiedDiff(text);
  assert.equal(segments.length, 1, `segments=${segments.length}（误切段会产出无 +++ 头的残缺段）`);
  assert.ok(segments[0].includes('--- divider'), '被删行内容必须原样保留在段内');
});

check('③ diff --git 多文件分界路径不回退', () => {
  const text = [
    'diff --git a/x.ts b/x.ts',
    'index aaa..bbb 100644',
    '--- a/x.ts',
    '+++ b/x.ts',
    'diff --git a/y.ts b/y.ts',
    'index ccc..ddd 100644',
    '--- a/y.ts',
    '+++ b/y.ts',
  ].join('\n');
  const segments = splitUnifiedDiff(text);
  assert.equal(segments.length, 2, `segments=${segments.length}`);
  assert.ok(segments[1].startsWith('diff --git a/y.ts'));
});

check('④ 单段 passthrough（无边界）', () => {
  const text = '--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-a\n+b';
  const segments = splitUnifiedDiff(text);
  assert.equal(segments.length, 1);
});

check('⑤ 空输入 → []', () => {
  assert.deepEqual(splitUnifiedDiff('   '), []);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
