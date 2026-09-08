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
check('② click 内调用注入的 focusHook', () => {
  const at = notifier.indexOf("notification.on('click'");
  assert.ok(notifier.slice(at, at + 300).includes('focusHook?.()'));
});
check('③ 导出 setNotificationFocusHook 注入口', () => {
  assert.match(notifier, /export function setNotificationFocusHook/);
});
check('④ index 启动时注入 showMainWindow（回调注入，无循环依赖）', () => {
  assert.match(index, /setNotificationFocusHook\(showMainWindow\)/);
  assert.doesNotMatch(notifier, /from '\.\.\/index'|from '\.\.\/main\/index'/);
});
check('⑤ 通知失败只记日志不阻断业务（既有语义保留）', () => {
  assert.match(notifier, /会话系统通知失败/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
