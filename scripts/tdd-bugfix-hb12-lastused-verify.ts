// scripts/tdd-bugfix-hb12-lastused-verify.ts
// hb12 P2-6【lastUsed 批】契约：saveConfig 剥离 lastUsedProviderId/lastUsedModelId（双防线）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-lastused-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const cm = fs.readFileSync(path.join(repoRoot, 'src/main/modules/config-manager.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

check('saveConfig 剥离 lastUsedProviderId/lastUsedModelId（防陈旧回写）', () => {
  const idx = cm.indexOf('export function saveConfig');
  const body = cm.slice(idx, idx + 2600);
  assert.match(body, /delete \(storage as Partial<StoredConfig>\)\.lastUsedProviderId;/, '缺 lastUsedProviderId 剥离');
  assert.match(body, /delete \(storage as Partial<StoredConfig>\)\.lastUsedModelId;/, '缺 lastUsedModelId 剥离');
  // 勿扩展：workingDirectory/cliPath/cliVersion 不在剥离清单（hb12 否决扩展剥离）
  assert.ok(!body.includes('delete (storage as Partial<StoredConfig>).workingDirectory;'), '误剥离 workingDirectory（扩展被否决）');
  assert.ok(!body.includes('delete (storage as Partial<StoredConfig>).cliPath;'), '误剥离 cliPath');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
