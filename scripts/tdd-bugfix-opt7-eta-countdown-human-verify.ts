// tdd-bugfix-opt7-eta-countdown-human-verify.ts
// OPT-7 收尾（审计㉕）：taskEtaText countdown 首位仍裸秒「300s 后执行」，与同屏人类可读
// 横幅（formatCountdownHuman）两种口径。首位过 formatCountdownHuman——<60s 秒级不变
//（既有契约钉 42s/0s 不受影响），≥60s 按分钟取整。
//
// 运行：npx tsx scripts/tdd-bugfix-opt7-eta-countdown-human-verify.ts

import { strict as assert } from 'node:assert';
import { taskEtaText, formatCountdownHuman } from '../src/shared/queue-eta';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const base = { status: 'countdown' as const, countdownRemaining: 42, intervalSeconds: 300, runnableIndex: 0 };

check('① countdown 首位 ≥60s 过人类可读（300s → 5 分钟）', () => {
  assert.equal(taskEtaText({ paused: false }, { ...base, countdownRemaining: 300 }), '5 分钟 后执行');
});
check('② countdown 首位 <60s 秒级不变（42s 回归）', () => {
  assert.equal(taskEtaText({ paused: false }, { ...base, countdownRemaining: 42 }), '42s 后执行');
});
check('③ 负数钳 0（0s 回归）', () => {
  assert.equal(taskEtaText({ paused: false }, { ...base, countdownRemaining: -3 }), '0s 后执行');
});
check('④ formatCountdownHuman 口径一致（300 → 5 分钟）', () => {
  assert.equal(formatCountdownHuman(300), '5 分钟');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
