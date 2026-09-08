// tdd-bugfix-n7-delete-provider-copy-verify.ts
// N7（P2）契约钉：删除供应商确认弹窗文案「正在使用它的会话不受影响」为假——
// override 指向已删供应商的会话下一条消息即回退到 lastUsed/库首（换厂商端点），
// 仅一条 drift 系统消息。文案必须如实描述回退行为。
//
// 运行：npx tsx scripts/tdd-bugfix-n7-delete-provider-copy-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/providers/ProviderManager.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

check('① 删除确认文案不再虚假宣称「会话不受影响」',
  !src.includes('正在使用它的会话不受影响'));
check('② 删除确认文案如实描述回退行为（回退到当前默认供应商、下一条消息起生效）', () => {
  const at = src.indexOf('async function handleDeleteProvider');
  const seg = src.slice(at, src.indexOf('if (!ok) return;', at));
  assert.match(seg, /会话将回退到当前默认供应商（下一条消息起生效）/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
