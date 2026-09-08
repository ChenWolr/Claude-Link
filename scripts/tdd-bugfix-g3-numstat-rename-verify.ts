// tdd-bugfix-g3-numstat-rename-verify.ts
// G3（P2）契约钉：parseNumstatZ 对 `git diff HEAD --numstat -z` 的重命名形态解析错误——
// 真实输出形态（本仓库 git 实证）：`2<TAB>0<TAB>NUL old.txt NUL new.txt NUL`，按 NUL 切分后
// 计数段路径为空串，随后两段依次为 oldPath/newPath。现实现正则 `(.*)$` 吃到空路径 →
// out.set('', 计数)，新路径无条目（改动面板重命名条目计数丢失、空键幽灵条目）。
//
// 修复语义：计数段路径为空串 → 跳过紧随的 oldPath 段、把计数并入其后的 newPath 键。
//
// 运行：npx tsx scripts/tdd-bugfix-g3-numstat-rename-verify.ts

import { strict as assert } from 'node:assert';
import { parseNumstatZ } from '../src/main/modules/changes-panel';

const NUL = String.fromCharCode(0);

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 重命名形态：计数并入 new 路径键（真实 git 输出形态）', () => {
  const out = parseNumstatZ(`2\t0\t${NUL}old.txt${NUL}new.txt${NUL}`);
  const entry = out.get('new.txt');
  assert.ok(entry, `new.txt 缺条目，keys=${JSON.stringify([...out.keys()])}`);
  assert.equal(entry?.additions, 2);
  assert.equal(entry?.deletions, 0);
  assert.equal(entry?.binary, false);
});

check('② 无空串幽灵键、无 old 路径键', () => {
  const out = parseNumstatZ(`2\t0\t${NUL}old.txt${NUL}new.txt${NUL}`);
  assert.equal(out.has(''), false, '不得有空串键');
  assert.equal(out.has('old.txt'), false, 'old 路径不得占用条目');
  assert.equal(out.size, 1, `size=${out.size}`);
});

check('③ 重命名+普通修改混合流', () => {
  const out = parseNumstatZ(`2\t0\t${NUL}old.txt${NUL}new.txt${NUL}3\t1\tkept.ts${NUL}`);
  assert.ok(out.get('new.txt'));
  assert.equal(out.get('kept.ts')?.additions, 3);
  assert.equal(out.get('kept.ts')?.deletions, 1);
  assert.equal(out.size, 2);
});

check('④ 普通条目/二进制条目行为不回退（回归）', () => {
  const out = parseNumstatZ(`5\t3\ta.ts${NUL}-\t-\tb.bin${NUL}`);
  assert.equal(out.get('a.ts')?.additions, 5);
  assert.equal(out.get('a.ts')?.binary, false);
  assert.equal(out.get('b.bin')?.binary, true);
  assert.equal(out.has(''), false);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
