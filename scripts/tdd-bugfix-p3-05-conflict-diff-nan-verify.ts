// tdd-bugfix-p3-05-conflict-diff-nan-verify.ts
// P3-5 契约钉：合并冲突文件（UU）在改动面板行号全 NaN——jsdiff 对 combined `@@@` 头解析出
// NaN oldStart/newStart。
//
// 修复语义：parseUnifiedDiff 校验首 hunk 行号 Number.isFinite，不合法时整文件降级为
// 「纯 +/- 行着色、无行号（n=null）」视图并带 conflict 标记；DiffDialog header 提示
//「合并冲突文件，建议在编辑器中解决」。普通 unified diff 回归不变。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-05-conflict-diff-nan-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseUnifiedDiff } from '../src/renderer/utils/diff-parser';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// diff --cc（combined）样例：jsdiff 解析 oldStart=NaN。
const CONFLICT = [
  'diff --cc a.txt',
  'index 1111111,2222222..3333333',
  '--- a/a.txt',
  '+++ b/a.txt',
  '@@@@ -1,3 -1,3 +1,7 @@@@',
  '  both line 1',
  '  both line 2',
  '++<<<<<<< HEAD',
  ' +ours line',
  '++>>>>>>> feature',
  '  both line 3',
].join('\n');

check('① combined `@@@` 头不再产出 NaN 行号组（降级 conflict 标记）', () => {
  const parsed = parseUnifiedDiff(CONFLICT);
  assert.ok(parsed, '应可解析');
  assert.equal(parsed!.conflict, true);
  for (const g of parsed!.groups) {
    for (const line of [...g.L, ...g.R]) {
      assert.equal(line.n, null, '降级视图行号必须为 null');
    }
  }
});
check('② 降级视图保留 +/- 着色语义（有 del/add 组且内容在）', () => {
  const parsed = parseUnifiedDiff(CONFLICT)!;
  const text = JSON.stringify(parsed.groups);
  assert.ok(text.includes('ours line'));
  assert.ok(text.includes('<<<<<<< HEAD'));
  assert.ok(parsed.groups.some((g) => g.k === 'add' || g.k === 'del' || g.k === 'mod' || g.k === 'ws'));
});
check('③ meta 行（diff --cc / index）不进内容组', () => {
  const parsed = parseUnifiedDiff(CONFLICT)!;
  const text = JSON.stringify(parsed.groups);
  assert.ok(!text.includes('diff --cc'));
  assert.ok(!text.includes('index 1111111'));
});
check('④ 普通 unified diff 回归：正常行号 + 无 conflict 标记', () => {
  const normal = ['--- a/f.txt', '+++ b/f.txt', '@@ -1,2 +1,2 @@', ' old', '-gone', '+new', ' tail'].join('\n');
  const parsed = parseUnifiedDiff(normal)!;
  assert.ok(!parsed.conflict);
  const allN = parsed.groups.flatMap((g) => [...g.L, ...g.R]).filter((l) => l.n != null);
  assert.ok(allN.length > 0, '正常 diff 行号应存在');
});

// 结构：DiffDialog header 提示。
const dialog = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/components/changes/DiffDialog.vue'), 'utf8');
check('⑤ DiffDialog header 有合并冲突提示', () => {
  assert.match(dialog, /合并冲突文件，建议在编辑器中解决/);
  assert.match(dialog, /isConflict/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
