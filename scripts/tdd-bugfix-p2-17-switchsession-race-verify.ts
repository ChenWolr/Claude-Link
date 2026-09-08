// tdd-bugfix-p2-17-switchsession-race-verify.ts
// P2-17 契约钉：switchSession 并发竞态——慢响应覆盖新会话消息列表。
//
// 修复语义：getSessionMessages await 后校验 activeSession?.id === session.id 再赋值
// messages 与 turnStartIndex，否则丢弃本次结果（对照 materializeActiveTransient 既有守卫）。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-17-switchsession-race-verify.ts

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 可控 deferred IPC stub。
const pending = new Map<string, Array<(v: unknown[]) => void>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = {
  claudeLink: {
    analyzeTopic: async () => null,
    getSessionMessages: (sid: string) =>
      new Promise<unknown[]>((resolve) => {
        const q = pending.get(sid) ?? [];
        q.push(resolve);
        pending.set(sid, q);
      }),
    onContextUpdate: () => () => { /* no-op */ },
  },
};
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = useSessionStore();
const sessA = { id: 'sess-A', name: 'A' } as never;
const sessB = { id: 'sess-B', name: 'B' } as never;

(async () => {
  const p1 = store.switchSession(sessA); // A：IPC 挂起
  const p2 = store.switchSession(sessB); // B：IPC 挂起
  // 先放行 B（快），再放行 A（慢，后到）。
  pending.get('sess-B')?.[0](['msg-B1', 'msg-B2']);
  await p2;
  pending.get('sess-A')?.[0](['msg-A-slow', 'stale-1', 'stale-2']);
  await p1;
  await new Promise((r) => setTimeout(r, 50));

  check('① 慢响应不覆盖新会话 messages（B 列表保持）',
    store.messages.length === 2 && store.messages[0] === 'msg-B1',
    JSON.stringify(store.messages));
  check('② activeSession 仍为 B', store.activeSession?.id === 'sess-B');

  // 正常单会话切换回归：无并发时 messages 正常载入。
  const p3 = store.switchSession(sessA);
  pending.get('sess-A')?.[1](['msg-A1', 'msg-A2']);
  await p3;
  check('③ 无竞态时正常载入（回归不变）', store.messages.length === 2 && store.messages[0] === 'msg-A1',
    JSON.stringify(store.messages));

  // 结构守卫。
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/renderer/stores/session-store.ts'), 'utf8');
  const at = src.indexOf('async switchSession');
  const body = src.slice(at, src.indexOf('async deleteSession', at));
  check('④ switchSession await 后有 activeSession 身份守卫',
    /this\.activeSession\?\.id !== session\.id\) return;/.test(body));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
