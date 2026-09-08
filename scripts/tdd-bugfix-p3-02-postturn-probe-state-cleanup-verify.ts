// tdd-bugfix-p3-02-postturn-probe-state-cleanup-verify.ts
// P3-2 契约钉：postTurnProbeState 键随会话删除永久残留（markSessionDeleted「单一收口」遗漏）。
//
// 修复语义：markSessionDeleted 在 cancelPostTurnProbe 之后显式 postTurnProbeState.delete(sessionId)
//（cancel 只 bump 代际不删键；残留键携带 child=null 的旧代际与冷却时间戳，属 20+ 项收口清单遗漏）。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-02-postturn-probe-state-cleanup-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const backend = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/modules/sdk-backend.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① markSessionDeleted 内显式 delete postTurnProbeState 键', () => {
  const at = backend.indexOf('export function markSessionDeleted');
  const body = backend.slice(at, at + 2200);
  assert.match(body, /postTurnProbeState\.delete\(sessionId\)/);
});
check('② 清理位于 cancelPostTurnProbe 之后（先取消在飞探针再删状态）', () => {
  const at = backend.indexOf('export function markSessionDeleted');
  const body = backend.slice(at, at + 2200);
  assert.ok(body.indexOf('cancelPostTurnProbe(sessionId)') < body.indexOf('postTurnProbeState.delete(sessionId)'));
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
