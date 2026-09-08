// tdd-bugfix-p1-04-addmessage-guard-verify.ts
// P1-4 契约钉：后台队列任务的 user 消息串入当前会话（幽灵气泡 + 可能用 B 内容改 A 标题）。
//
// 根因：task-store 的 user_message_created 无条件 sessionStore.addMessage(msg)；
// addMessage 无 msg.sessionId === activeSession.id 归属校验——驻留会话 A 时后台会话 B 的
// 队列消息直接进 A 的 messages（幽灵气泡）；isNew+user 数=1 判定还会触发 analyzeTopic
// 用 B 的内容改 A 的标题。
//
// 修复语义：addMessage 入口单点归属守卫（非活动会话消息直接拒绝）；常规 active 会话写入
// 不变（谓词恒真）；activeSession 为 null（暂态草稿）时拒绝一切远端消息写入。
// 切回 B 时消息由 DB 重载补齐，不丢数据。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-04-addmessage-guard-verify.ts

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

// ── 1. 行为：真实 session-store（pinia 无头实例）──
// 无头环境 stub：addMessage 对首条 user 消息触发 analyzeTopic（renderer 专用全局）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = {
  claudeLink: {
    analyzeTopic: async () => null,
    getSessionMessages: async () => [],
  },
};
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

function mkMsg(id: string, sessionId: string, role: 'user' | 'assistant') {
  return {
    id, sessionId, role, content: `内容-${id}`, rawEvent: null, eventType: 'message',
    costUsd: null, durationMs: null, parentTaskId: null, processKind: null,
    parentAgentId: null, toolUseId: null, title: null, isError: false, createdAt: '',
  } as never;
}

const store = useSessionStore();
// 活动会话 A（名字故意以「会话」开头，模拟自动命名态——外来 user 消息不得触发 analyzeTopic）。
store.activeSession = { id: 'sess-A', name: '会话 1' } as never;

store.addMessage(mkMsg('a1', 'sess-A', 'user'));
check('① 活动会话消息正常入列', store.messages.length === 1 && store.messages[0].id === 'a1');

// 后台会话 B 的队列消息：守卫后必须被拒绝（幽灵气泡根因）。
store.addMessage(mkMsg('b1', 'sess-B', 'user'));
check('② 非活动会话消息不入列（幽灵气泡消失）', store.messages.length === 1,
  `messages=${store.messages.length}`);

// 暂态草稿（activeSession=null）：拒绝一切远端消息。
store.activeSession = null;
store.addMessage(mkMsg('a2', 'sess-A', 'assistant'));
check('③ activeSession 为 null 时拒绝一切远端消息', store.messages.length === 1,
  `messages=${store.messages.length}`);

// 恢复活动会话 A：同 id upsert（retry/重放复用稳定 id）仍正常。
store.activeSession = { id: 'sess-A', name: '会话 1' } as never;
store.addMessage(mkMsg('a1', 'sess-A', 'user'));
check('④ 活动（原地 upsert）不受守卫影响', store.messages.length === 1 && store.messages[0].id === 'a1');

// ── 2. 结构契约：单点守卫在 addMessage 入口（upsert 之前）──
const src = read('src/renderer/stores/session-store.ts');
const addBodyStart = src.indexOf('    addMessage(message: Message) {');
const addBody = addBodyStart >= 0
  ? src.slice(addBodyStart, src.indexOf('\n    ', addBodyStart + 10) + 400)
  : '';
check('⑤ addMessage 入口存在归属守卫（sessionId !== activeSession?.id 即 return）',
  /message\.sessionId\s*!==\s*this\.activeSession\?\.id/.test(addBody));

// task-store 不再承担归属过滤责任之外的双写路径（保持单点收敛，不回退为逐调用点判断）。
const taskStore = read('src/renderer/stores/task-store.ts');
check('⑥ task-store user_message_created 仍直接交 addMessage（守卫收敛在 store 单点）',
  taskStore.includes('sessionStore.addMessage(msg)'));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
