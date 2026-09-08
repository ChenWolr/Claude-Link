// tdd-bugfix-p2-07-question-cancel-copy-verify.ts
// P2-7 契约钉：选择题（AskUserQuestion）取消文案不中性——系统中断也记成「用户取消了选择题交互」。
//
// 修复语义：对齐 mapPermissionInteractionResponse——cancel 透传 reason，reason==='user' 保留
// 归因文案；'abort'/缺省用中性「提问交互已取消」。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-07-question-cancel-copy-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { mapAskUserQuestionCancel } from '../src/shared/interaction-cancel';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');
const interactions = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-interactions.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① reason=user → 归因文案保留', () => {
  assert.deepEqual(mapAskUserQuestionCancel('user'), { behavior: 'deny', message: '用户取消了选择题交互' });
});
check('② reason=abort → 中性文案', () => {
  assert.deepEqual(mapAskUserQuestionCancel('abort'), { behavior: 'deny', message: '提问交互已取消' });
});
check('③ reason 缺省 → 中性文案（宁可不指控用户）', () => {
  assert.deepEqual(mapAskUserQuestionCancel(undefined), { behavior: 'deny', message: '提问交互已取消' });
  assert.deepEqual(mapAskUserQuestionCancel(null), { behavior: 'deny', message: '提问交互已取消' });
});
check('④ backend 分映接入（outcome.kind 分派 + mapAskUserQuestionCancel 调用）', () => {
  assert.ok(backend.includes("if (outcome.kind === 'answered')"));
  assert.ok(backend.includes('mapAskUserQuestionCancel(outcome.reason)'));
  assert.ok(!backend.includes("message: '用户取消了选择题交互'"), '旧的一律归因文案应删除');
});
check('⑤ interactions 两处 cancel 均透传 reason', () => {
  const hits = interactions.match(/return \{ kind: 'cancel', reason: response\.reason \};/g) ?? [];
  assert.ok(hits.length >= 2, `hits=${hits.length}`);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
