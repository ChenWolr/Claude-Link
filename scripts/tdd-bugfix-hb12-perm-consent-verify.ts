// scripts/tdd-bugfix-hb12-perm-consent-verify.ts
// hb12 P2-4【权限批】契约（hb12-PERM-01 文案步 / PERM-05 系统取消落历史）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-perm-consent-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const sdkInter = read('src/main/modules/sdk-interactions.ts');
const backend = read('src/main/modules/sdk-backend.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① PERM-01：文案明示整工具语义。
check('① PERM-01：allow-session 选项 desc 明示「不限参数」整工具放行', () => {
  assert.match(sdkInter, /本会话内放行该工具的所有调用（不限参数）。/, '文案未明示整工具语义');
  assert.doesNotMatch(sdkInter, /接受 Claude Code 给出的会话级权限建议。/, '旧含糊文案残留');
});

// ② PERM-01：无建议场景选项不强制出现。
check('② PERM-01：hasSdkSuggestions 判据——无建议场景无「总是允许」项', () => {
  assert.match(sdkInter, /hasSdkSuggestions/, '缺建议存在性判据');
  const idx = sdkInter.indexOf('const hasSdkSuggestions');
  const body = sdkInter.slice(idx, idx + 300);
  assert.match(body, /options\.suggestions\.length > 0/, '判据未读 options.suggestions');
  const useIdx = sdkInter.indexOf('...(hasSdkSuggestions', idx);
  assert.ok(useIdx > idx, '选项展开未用 hasSdkSuggestions 门控');
});

// ③ PERM-05：系统取消统一落历史。
check('③ PERM-05：killProcess 取消路径落 interaction_history（cancel + reason）', () => {
  const idx = backend.indexOf('hb12-PERM-05');
  const body = backend.slice(idx, idx + 900);
  assert.match(body, /createInteractionHistoryRecord\(/, '缺落库调用');
  assert.match(body, /action: 'cancel',/, '缺 cancel 动作');
  assert.match(body, /系统取消（\$\{reason\}），未答复/, '缺 reason 摘要');
  const histIdx = body.indexOf('createInteractionHistoryRecord(');
  const cancelIdx = body.indexOf('cancelInteractionsForSession(sessionId);');
  assert.ok(cancelIdx > histIdx, '落历史必须先于实际取消（取消后 pending 已空拿不到 payload）');
});

// ④ PERM-05：import 接线。
check('④ PERM-05：createInteractionHistoryRecord + getPendingInteractionPrompts import', () => {
  assert.match(backend, /createInteractionHistory as createInteractionHistoryRecord/, '缺 repo import');
  assert.match(backend, /getPendingInteractionPrompts } from '\.\/interaction-prompts';/, '缺 pending 查询 import');
});

// ⑤ hb13-v B9（F4）：渲染崩溃 + 10min 超时两条系统取消路径同走落库通道（消除「仅 killProcess
// 落历史」缺口）；submitError 行内提示 + initSelection 清除。
check('⑤ B9：render-crashed/timeout 两取消路径落库 + submitError 行内提示与清除', () => {
  const prompts = read('src/main/modules/interaction-prompts.ts');
  assert.match(prompts, /import \{ createInteractionHistory \} from '\.\.\/database\/repositories\/interaction-history-repo';/, '缺 repo import');
  const cancelIdx = prompts.indexOf('export function cancelAllPendingInteractions');
  const cancelBody = prompts.slice(cancelIdx, prompts.indexOf('\n}', cancelIdx));
  assert.match(cancelBody, /recordCancelHistory\(\[\.\.\.pendingInteractionRequests\.values\(\)\], 'render-crashed'\)/, 'render-process-gone 路径未落库');
  assert.ok(cancelBody.indexOf('recordCancelHistory') < cancelBody.indexOf('pending.resolve'), '落库必须先于实际取消（对齐 killProcess 顺序）');
  const ageIdx = prompts.indexOf('const ageTimer = setTimeout(');
  const ageBody = prompts.slice(ageIdx, ageIdx + 700);
  assert.match(ageBody, /recordCancelHistory\(\[\{ sessionId: payload\.sessionId, payload \}\], 'timeout'\)/, '10min 超时路径未落库');
  const promptVue = read('src/renderer/components/chat/InteractionPrompt.vue');
  assert.match(promptVue, /<p v-if="submitError" class="interaction-dialog__submit-error" role="alert">\{\{ submitError \}\}<\/p>/, 'submitError 未接入模板');
  const initIdx = promptVue.indexOf('function initSelection');
  const initBody = promptVue.slice(initIdx, initIdx + 500);
  assert.match(initBody, /submitError\.value = null;/, 'initSelection 未清除上次提交失败提示');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
