// tdd-session-delete-draft-cleanup-verify.ts
// B11（D01-F6）契约钉：删除会话终态同步清 chat-draft-store 草稿。
//
// 病根：session-store.deleteSession 清理了 sessionStreams/stalledInfo/apiRetryInfo/commandStore/
// planStore 等十余项 per-session 状态，唯独漏 useChatDraftStore——文字草稿 textBySession[id] 与
// 附件摘要登记 attachmentsBySession[id]（AttachmentSummary 内存态）滞留至应用重启。切换会话保留
// 草稿是有意设计（chat-draft-store 头注释「切换会话不清理旧 key」），删除是终态却同样保留，
// 属同一清理清单的遗漏项。
//
// 修复：deleteSession 成功路径（await window.claudeLink.deleteSession 之后、catch 之前）调
// chatDraftStore.discardDraft(id) 连 key 一并移除；失败路径（catch 回滚）不动草稿。
// 暂态 id 与会话 id 两种键形态同 key 一次覆盖——暂态物化沿用 renderer 生成的同一 id
//（session-repo createSession 的 id 参数 + SESSION_CREATE spec.id 透传），不存在第二 key。
//
// 本契约锁：①-④ 删除成功后草稿（文字/附件登记）连 key 移除且其他会话草稿不受影响（行为）；
// ⑤-⑥ 删除失败草稿原样保留（行为，边界）；⑦ 失败写 error（回滚链在位，行为）；
// ⑧ 清草稿调用必须位于成功路径（await 之后、catch 之前，结构）；⑨ discardDraft 连 key 移除
// 两 map（区别于 clearAfterAccepted 清值留 key，结构）；⑩ 暂态物化同 id 机制钉（结构）；
// ⑪ selftest 清单登记。
//
// 运行：npx tsx scripts/tdd-session-delete-draft-cleanup-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

// 可控 IPC stub：deleteSession 按开关决定成败（deleteSession 链上唯一 IPC；command/plan/draft
// 三个 store 的 clear 均为纯内存删除，无需更多 stub）。
let deleteShouldFail = false;
let failMessage = '';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = {
  claudeLink: {
    deleteSession: async (sid: string) => {
      if (deleteShouldFail) throw new Error(failMessage);
      return { id: sid, ok: true };
    },
    onContextUpdate: () => () => { /* no-op */ },
  },
};
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useChatDraftStore } = require('../src/renderer/stores/chat-draft-store');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

(async () => {
  const store = useSessionStore();
  const drafts = useChatDraftStore();

  const att = (id: string, sid: string) => ({
    id,
    sessionId: sid,
    kind: 'image' as const,
    filename: `${id}.png`,
    mimeType: 'image/png',
    sizeBytes: 1024,
    previewAvailable: true,
    status: 'draft' as const,
  });

  // —— 场景一：删除成功 → 被删会话草稿（文字 + 附件摘要登记）连 key 移除，他 会话不受影响。
  drafts.setText('sess-keep', '保留会话的文字草稿');
  drafts.addAttachments('sess-keep', [att('att-keep', 'sess-keep')]);
  drafts.setText('sess-del', '被删会话的文字草稿');
  drafts.addAttachments('sess-del', [att('att-del-1', 'sess-del'), att('att-del-2', 'sess-del')]);

  deleteShouldFail = false;
  await store.deleteSession('sess-del');

  check('① 删除成功：文字草稿 key 移除（不留空串残留）',
    !('sess-del' in drafts.textBySession),
    `textBySession keys=${JSON.stringify(Object.keys(drafts.textBySession))}`);
  check('② 删除成功：附件摘要登记 key 移除（暂态附件内存态不滞留）',
    !('sess-del' in drafts.attachmentsBySession),
    `attachmentsBySession keys=${JSON.stringify(Object.keys(drafts.attachmentsBySession))}`);
  check('③ 删除成功：其他会话草稿原样保留',
    drafts.getText('sess-keep') === '保留会话的文字草稿' && drafts.getAttachments('sess-keep').length === 1,
    `text=${drafts.getText('sess-keep')} atts=${drafts.getAttachments('sess-keep').length}`);

  // —— 场景二：暂态起源会话——物化沿用同一 id，草稿 key 即会话 id，删除同样一次覆盖。
  drafts.setText('0d1f2e3a-transient-origin', '暂态期间写的草稿');
  drafts.addAttachments('0d1f2e3a-transient-origin', [att('att-transient', '0d1f2e3a-transient-origin')]);
  await store.deleteSession('0d1f2e3a-transient-origin');
  check('④ 暂态起源会话（物化同 id）：草稿两种键形态一并清',
    !('0d1f2e3a-transient-origin' in drafts.textBySession) &&
    !('0d1f2e3a-transient-origin' in drafts.attachmentsBySession),
    `keys=${JSON.stringify(Object.keys(drafts.textBySession))}/${JSON.stringify(Object.keys(drafts.attachmentsBySession))}`);

  // —— 场景三：删除失败 → 草稿不动（保留供重试），error 写入（回滚链在位）。
  deleteShouldFail = true;
  failMessage = '删除会话失败（测试注入）';
  drafts.setText('sess-fail', '失败会话的文字草稿');
  drafts.addAttachments('sess-fail', [att('att-fail', 'sess-fail')]);
  await store.deleteSession('sess-fail');
  check('⑤ 删除失败：文字草稿保留',
    drafts.getText('sess-fail') === '失败会话的文字草稿',
    `text=${JSON.stringify(drafts.getText('sess-fail'))}`);
  check('⑥ 删除失败：附件摘要登记保留',
    drafts.getAttachments('sess-fail').length === 1,
    `atts=${drafts.getAttachments('sess-fail').length}`);
  check('⑦ 删除失败：error 写入（回滚链在位）',
    store.error === failMessage, `error=${JSON.stringify(store.error)}`);

  // —— 结构钉：清草稿调用必须位于 deleteSession 成功路径（await 之后、catch 之前）。
  const src = read('src/renderer/stores/session-store.ts');
  const dsIdx = src.indexOf('async deleteSession(id: string) {');
  const dsEnd = src.indexOf('async deleteSessions(', dsIdx);
  check('⑧ 定位 deleteSession 函数体', dsIdx > -1 && dsEnd > dsIdx);
  if (dsIdx > -1 && dsEnd > dsIdx) {
    const body = src.slice(dsIdx, dsEnd);
    const awaitIdx = body.indexOf('await window.claudeLink.deleteSession(id);');
    const clearIdx = body.indexOf('useChatDraftStore().discardDraft(id);');
    const catchIdx = body.indexOf('} catch (error) {');
    check('⑧ 清草稿在成功路径：await 之后、catch 之前（失败回滚不清）',
      awaitIdx > -1 && clearIdx > awaitIdx && catchIdx > clearIdx,
      `awaitIdx=${awaitIdx} clearIdx=${clearIdx} catchIdx=${catchIdx}`);
  }

  // —— 结构钉：discardDraft 连 key 移除两 map（区别于 clearAfterAccepted 清值留 key）。
  const ds = read('src/renderer/stores/chat-draft-store.ts');
  check('⑨ discardDraft 存在且 delete 两个 key',
    /discardDraft\(sessionId: string\): void \{[\s\S]*?delete this\.textBySession\[sessionId\];\s*delete this\.attachmentsBySession\[sessionId\];\s*\},/.test(ds),
    '缺 discardDraft 或未连 key 移除 textBySession/attachmentsBySession');

  // —— 机制钉：暂态物化沿用同一 id（「暂态 id 与会话 id 同 key」的根据，两种形态一次覆盖的前提）。
  const sessionRepo = read('src/main/database/repositories/session-repo.ts');
  check('⑩ createSession 沿用调用方 id（暂态物化不换 key）',
    /const sessionId = id \?\? uuidv4\(\);/.test(sessionRepo),
    'session-repo 缺 id ?? uuidv4() 形态');

  // —— 登记钉：selftest 清单包含本脚本。
  const list = read('scripts/selftest-static-list.txt');
  check('⑪ selftest 清单已登记本脚本', list.includes('tdd-session-delete-draft-cleanup-verify.ts'));

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
