// tdd-bugfix-p3-09-tmp-cleanup-verify.ts
// P3-9 契约钉：设置原子写失败残留 `.tmp` 垃圾文件（每次保存唯一名，失败后累积）。
//
// 修复语义：writeFileSync/rename 失败时 best-effort fs.rmSync(tmp, {force:true})（自身 try
// 包裹，清理失败不影响主错误上抛）。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-09-tmp-cleanup-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/settings-writer.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 写入失败路径 rmSync 清 .tmp（force）', () => {
  const at = src.indexOf('const tmp = path.join(dir,');
  const seg = src.slice(at, at + 700);
  assert.match(seg, /rmSync\(tmp, \{ force: true \}\)/);
});
check('② 清理自身 try 包裹（清理失败不影响主错误）', () => {
  const at = src.indexOf('rmSync(tmp');
  const seg = src.slice(at - 120, at + 120);
  assert.match(seg, /catch/);
});
check('③ 主错误仍上抛（外层 catch 记日志语义不变）', () => {
  const at = src.indexOf('throw writeErr;');
  assert.ok(at > -1);
});
check('④ 内容未变跳过写盘的既有短路保留（回归）', () => {
  assert.match(src, /=== content\) return \{ ok: true/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
