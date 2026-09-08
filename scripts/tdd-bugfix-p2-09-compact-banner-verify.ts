// tdd-bugfix-p2-09-compact-banner-verify.ts
// P2-9 契约钉：①compactedJustNow 探针标记只认命令文本不校验压缩成败——失败的 /compact 也弹
// 「已压缩」成功横幅；②即时 fresh 与探针 fresh 各弹一次（双横幅）。
//
// 修复语义：runQuery 回合作用域 turnHadCompactSuccess 标志仅在 compact_result==='success' 时
// 置位（探针标记唯一来源）；即时 fresh 实际送达（onFreshSent 回调）置 postCompactionFreshSent，
// 探针不再重复带标记。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-09-compact-banner-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 回合作用域声明 turnHadCompactSuccess / postCompactionFreshSent', () => {
  assert.match(backend, /let turnHadCompactSuccess = false;/);
  assert.match(backend, /let postCompactionFreshSent = false;/);
});
check('② compact_result 成功处置位 turnHadCompactSuccess（探针标记唯一来源）', () => {
  const at = backend.indexOf("if (sdkMsg.compact_result === 'success')");
  const win = backend.slice(at, at + 600);
  assert.ok(win.includes('turnHadCompactSuccess = true'), win.slice(0, 200));
});
check('③ 探针 compactedJustNow 不再读命令文本，改看成功标志', () => {
  const at = backend.indexOf('const compactedJustNow =');
  const line = backend.slice(at, backend.indexOf(';', at));
  assert.ok(line.includes('turnHadCompactSuccess'), line);
  assert.ok(!line.includes('initCommandText'), line);
});
check('④ 双横幅：探针标记叠加 !postCompactionFreshSent', () => {
  const at = backend.indexOf('const compactedJustNow =');
  const line = backend.slice(at, backend.indexOf(';', at));
  assert.ok(line.includes('!postCompactionFreshSent'), line);
});
check('⑤ 即时 fresh 实际送达才置 postCompactionFreshSent（onFreshSent 回调）', () => {
  assert.match(backend, /onFreshSent\?: \(\) => void/);
  assert.match(backend, /onFreshSent\?\.\(\)/);
  const at = backend.indexOf('onFreshSent: () => { postCompactionFreshSent = true; }');
  assert.ok(at > -1);
});
check('⑥ 失败/挂载守卫：compactedJustNow 仅在 fresh（used != null）时挂载', () => {
  assert.match(backend, /opts\.compactedJustNow && used != null/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
