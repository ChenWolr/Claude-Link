// tdd-bugfix-p2-18-notification-click-verify.ts
// P2-18 契约钉：通知无 click 处理器 → 点击系统 toast 无反应。
//
// 修复语义：Notification 增加 on('click') → 聚焦主窗（restore/show/focus）。聚焦能力经
// setNotificationFocusHook 回调注入（notifier 不 import index，避免循环依赖）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-18-notification-click-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const notifier = read('src/main/modules/session-completion-notifier.ts');
const index = read('src/main/index.ts');

check('① Notification 挂 on(click) 处理器', () => {
  assert.match(notifier, /notification\.on\('click', \(\) =>/);
});
// hb12-SHL-03 最小同步：focusHook 调用改带 sessionId（点击通知切换到对应会话），「click 内调注入 hook」语义保持。
check('② click 内调用注入的 focusHook（带 sessionId）', () => {
  const at = notifier.indexOf("notification.on('click'");
  assert.ok(notifier.slice(at, at + 300).includes('focusHook?.(sessionId)'));
});
check('③ 导出 setNotificationFocusHook 注入口', () => {
  assert.match(notifier, /export function setNotificationFocusHook/);
});
// hb12-SHL-03 最小同步：hook 签名改带 sessionId——点击通知聚焦主窗并导航到对应会话
//（showMainWindow 调用在回调体内，注入防循环依赖语义保持）。
check('④ index 启动时注入带 sessionId 的 focusHook（回调注入，无循环依赖）', () => {
  assert.match(index, /setNotificationFocusHook\(\(sessionId\) => \{/);
  // hb13-v 批C 收窄：showMainWindow(); 在 focusHook 回调体内匹配（原全文件匹配可被他处误命中）。
  const hookIdx = index.indexOf('setNotificationFocusHook((sessionId) => {');
  assert.ok(hookIdx > -1, '未找到 focusHook 注入');
  const hookBody = index.slice(hookIdx, hookIdx + 400);
  assert.match(hookBody, /showMainWindow\(\);/, 'focusHook 回调体内缺 showMainWindow 调用');
  assert.doesNotMatch(notifier, /from '\.\.\/index'|from '\.\.\/main\/index'/);
});
check('⑤ 通知失败只记日志不阻断业务（既有语义保留）', () => {
  assert.match(notifier, /会话系统通知失败/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
