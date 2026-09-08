// tdd-bugfix-p2-13-retry-attachments-verify.ts
// P2-13 契约钉：卡死恢复「重发」静默丢失原消息全部附件。
//
// 修复语义：retryLastTurn 重发前调 cloneMessageAttachments 克隆原消息附件为新草稿，随
// sendMessage 提交（并同步进 draft store 供乐观卡片渲染）；克隆失败回落纯文本并提示；
// 原消息无附件跳过克隆（与旧行为一致）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-13-retry-attachments-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const useChat = fs.readFileSync(path.join(repoRoot, 'src/renderer/composables/use-chat.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① retryLastTurn 调 cloneMessageAttachments 克隆原附件', () => {
  const body = useChat.slice(useChat.indexOf('async function retryLastTurn'));
  assert.ok(body.includes('cloneMessageAttachments'), '须调用克隆 IPC');
});
check('② 克隆结果进 draft store（乐观卡片渲染）', () => {
  const body = useChat.slice(useChat.indexOf('async function retryLastTurn'));
  assert.ok(body.includes('addAttachments'), '克隆附件须入 draft store');
});
check('③ 克隆失败回落纯文本重发并提示', () => {
  const body = useChat.slice(useChat.indexOf('async function retryLastTurn'));
  assert.ok(body.includes('附件恢复失败，已按纯文本重发'));
  assert.ok(body.includes('catch'));
});
check('④ 无附件时跳过克隆（attachmentIds.length > 0 门控）', () => {
  const body = useChat.slice(useChat.indexOf('async function retryLastTurn'));
  assert.ok(body.includes('last.attachmentIds.length > 0'));
});
check('⑤ sendMessage 收到克隆出的 attachmentIds（不再恒传空数组）', () => {
  const body = useChat.slice(useChat.indexOf('async function retryLastTurn'));
  assert.ok(/sendMessage\(\{ text: last\.content, attachmentIds,/.test(body));
  assert.doesNotMatch(body, /attachmentIds: \[\], clientMessageId/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
