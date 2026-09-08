// tdd-bugfix-p2-08-diff-dialog-blocking-verify.ts
// P2-8 契约钉：他会话 pending 弹窗（或本地 confirm）静默阻断当前会话 diff 弹窗。
//
// 修复语义：interaction-store 增加按当前会话可见的 getter（与 InteractionPrompt.currentRequests
// 同一谓词：本会话远程 + 本地 confirm（sessionId=''）全局可见），useToolDiffDialog/useDiffDialog
// 两处让位判定改用它——他会话 pending 不阻断、本会话/本地仍阻断。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-08-diff-dialog-blocking-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// 无头 renderer 环境 stub（P1-4 同手法）。
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = { claudeLink: { analyzeTopic: async () => null, getSessionMessages: async () => [] } };
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useInteractionStore } = require('../src/renderer/stores/interaction-store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const store = useInteractionStore();
const sessionStore = useSessionStore();
sessionStore.activeSession = { id: 'sess-A', name: 'A' } as never;

function req(id: string, sessionId: string) {
  return { id, sessionId, kind: 'permission', title: 't' } as never;
}

store.enqueueRemote(req('r-b', 'sess-B'));
check('① 他会话（B）的 pending 不在当前会话可见集', store.visibleRequestsForActiveSession.length === 0,
  JSON.stringify(store.visibleRequestsForActiveSession.map((r: { id: string }) => r.id)));

store.enqueueRemote(req('r-a', 'sess-A'));
check('② 本会话（A）的 pending 在可见集', store.visibleRequestsForActiveSession.some((r: { id: string }) => r.id === 'r-a'));

store.enqueueLocal(req('local-1', ''));
check('③ 本地 confirm（sessionId 空）全局可见', store.visibleRequestsForActiveSession.some((r: { id: string }) => r.id === 'local-1'));

sessionStore.activeSession = null;
check('④ activeSession=null 时只显示本地 confirm', store.visibleRequestsForActiveSession.length === 1 &&
  store.visibleRequestsForActiveSession[0].id === 'local-1');

// 结构：两处让位判定改用新 getter。
const repoRoot = path.resolve(__dirname, '..');
const tool = fs.readFileSync(path.join(repoRoot, 'src/renderer/composables/useToolDiffDialog.ts'), 'utf8');
const diff = fs.readFileSync(path.join(repoRoot, 'src/renderer/composables/useDiffDialog.ts'), 'utf8');
check('⑤ useToolDiffDialog 让位判定改用 visibleRequestsForActiveSession',
  tool.includes('visibleRequestsForActiveSession') && !tool.includes('.requests.length > 0'));
check('⑥ useDiffDialog 让位判定改用 visibleRequestsForActiveSession',
  diff.includes('visibleRequestsForActiveSession') && !diff.includes('.requests.length > 0'));
const storeSrc = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/interaction-store.ts'), 'utf8');
check('⑦ store getter 谓词与 InteractionPrompt 同形（!sessionId || === activeSession.id）',
  /!r\.sessionId \|\| r\.sessionId === sid/.test(storeSrc));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
