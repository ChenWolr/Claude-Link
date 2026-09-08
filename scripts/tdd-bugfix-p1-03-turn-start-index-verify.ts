// tdd-bugfix-p1-03-turn-start-index-verify.ts
// P1-3 契约钉：队列回合不更新 turnStartIndex → 流式去重把上一回合/全部历史正文与思考隐藏到回合结束。
//
// 根因：开启流式去重（hideText）时 turnIds 从 turnStartIndex 起算；队列驱动的回合没有任何
// 路径更新 turnStartIndex（驻留会话 B 时保持 0/旧值）→ 整段历史被判为「当前回合流式内容」隐藏。
//
// 修复语义：抽单一纯函数 computeTurnStartIndex（shared），直发（use-chat）、切回恢复
//（session-store.switchSession）、队列回合（task-store 的 user_message_created 分支）三处同一口径。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-03-turn-start-index-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ── 1. 纯函数行为（shared/turn-boundary）──
let computeTurnStartIndex: ((messages: Array<{ role: string }>) => number) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  computeTurnStartIndex = require('../src/shared/turn-boundary').computeTurnStartIndex;
} catch {
  computeTurnStartIndex = null;
}
const fn = computeTurnStartIndex as ((messages: Array<{ role: string }>) => number) | null;

check('① shared/turn-boundary 导出 computeTurnStartIndex', fn !== null);
if (fn) {
  const m = (role: string) => ({ role });
  check('② 空消息 → 0', fn([]) === 0);
  check('③ 无 user 消息 → messages.length（全部视为历史，不隐藏）', fn([m('assistant'), m('system')]) === 2);
  check('④ 尾部 user → length', fn([m('assistant'), m('user')]) === 2);
  check('⑤ 多 user → 最后一条 user 的下一位置', fn([m('user'), m('assistant'), m('user'), m('assistant')]) === 3);
  check('⑥ 尾部非 user → 最后 user 之后', fn([m('user'), m('assistant'), m('tool')]) === 1);
}

// ── 2. 结构契约：三处接线 ──
let taskStore = '';
let useChat = '';
let sessionStore = '';
try {
  taskStore = read('src/renderer/stores/task-store.ts');
  useChat = read('src/renderer/composables/use-chat.ts');
  sessionStore = read('src/renderer/stores/session-store.ts');
} catch (err) {
  console.error('源码读取失败', err);
  process.exit(1);
}

// user_message_created 分支：addMessage 之后须重算 turnStartIndex（带归属校验）。
const umcIdx = taskStore.indexOf("case 'user_message_created':");
const umcBody = umcIdx >= 0 ? taskStore.slice(umcIdx, taskStore.indexOf('}', taskStore.indexOf('break;', umcIdx))) : '';
check('⑦ task-store user_message_created 分支在 addMessage 后重算 turnStartIndex（activeSession 归属校验内）',
  umcBody.includes('addMessage(msg)') &&
  umcBody.indexOf('computeTurnStartIndex') > umcBody.indexOf('addMessage(msg)') &&
  umcBody.includes('activeSession'), umcBody.slice(0, 200));
check('⑧ use-chat 直发回合边界改用 computeTurnStartIndex（不再直接 messages.length）',
  /store\.turnStartIndex\s*=\s*computeTurnStartIndex\(store\.messages\)/.test(useChat));
check('⑨ switchSession 恢复处改用 computeTurnStartIndex（删除内联 lastUserIndex 计算）',
  sessionStore.includes('computeTurnStartIndex') && !sessionStore.includes('lastUserIndex'));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
