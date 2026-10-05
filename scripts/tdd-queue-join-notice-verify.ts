// tdd-queue-join-notice-verify.ts
// B3（D09-F7，P3）契约钉：入队成功即时反馈——「已加入队列，<ETA>」notice。
//
// 根因：sending 中发送走 taskStore.addTask，成功后仅 clearAfterAccepted（草稿静默清空），
// 用户消息本体要到任务出队、user_message_created 后才出现在聊天流——输入框瞬间清空 +
// 聊天流无新消息，容易被误读为「消息丢了/没发出去」（队列域最高频动线零反馈）。
//
// 修复语义：入队成功（addTask 返回 true）即经 ChatPage 既有 showNotice 给一条
// 「已加入队列，<ETA>」反馈，ETA 与任务卡同源（queue-eta.ts taskEtaText 纯函数 +
// queue-config resolveQueueDelaySeconds 回落，口径对齐 TaskQueuePanel.etaFor）；
// 直发路径（sendMessage）零变化——queued 标志只在入队分支置位。
//
// 运行：npx tsx scripts/tdd-queue-join-notice-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const chatPage = readFileSync(new URL('../src/renderer/pages/ChatPage.vue', import.meta.url), 'utf8');

console.log('\n=== B3（D09-F7）：入队成功即时反馈（已加入队列 + ETA） ===');
check('ChatPage 引入 taskEtaText（ETA 与任务卡同源纯函数）', () => {
  assert.match(chatPage, /import \{ taskEtaText \} from '\.\.\/\.\.\/shared\/queue-eta';/, '缺 taskEtaText 导入');
});
check('ChatPage 引入 resolveQueueDelaySeconds（interval 回落与 etaFor 同口径）', () => {
  assert.match(chatPage, /import \{ resolveQueueDelaySeconds \} from '\.\.\/\.\.\/shared\/queue-config';/, '缺 resolveQueueDelaySeconds 导入');
});
check('入队分支成功后置 queued 标志（直发分支不置）', () => {
  const idx = chatPage.indexOf('ok = await taskStore.addTask(sessionId, payload);');
  assert.ok(idx > -1, '缺 addTask 调用');
  const after = chatPage.slice(idx, idx + 400);
  assert.match(after, /queued = ok;/, 'addTask 成功后应置 queued = ok');
});
check('成功路径 notice 由 queued 门控（直发 ok 不触发）', () => {
  const idx = chatPage.indexOf('draftStore.clearAfterAccepted(sessionId);');
  assert.ok(idx > -1, '缺 clearAfterAccepted');
  const after = chatPage.slice(idx, idx + 900);
  assert.match(after, /if \(queued\)/, '成功路径应以 if (queued) 门控入队提示');
});
check('提示文案含「已加入队列」且拼接 ETA', () => {
  assert.match(chatPage, /已加入队列\$\{/, '缺「已加入队列，<eta>」文案形态');
});
check('ETA 计算调用 taskEtaText 且 runnableIndex 取未暂停序列末位（刚入队任务）', () => {
  const idx = chatPage.indexOf('taskEtaText({ paused: false }');
  assert.ok(idx > -1, '缺 taskEtaText 调用');
  const around = chatPage.slice(idx - 600, idx + 500);
  assert.match(around, /taskStore\.tasks\.filter\(\(t\) => !t\.paused\)/, 'runnable 序列应过滤未暂停');
  assert.match(around, /runnableIndex:\s*runnable\.length - 1/, 'runnableIndex 应为序列末位');
  assert.match(around, /intervalSeconds:\s*taskStore\.queueState\.intervalSeconds \?\? resolveQueueDelaySeconds/, 'interval 应回落 resolveQueueDelaySeconds');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
