// scripts/tdd-bugfix-hb10-session-p3-verify.ts
// hb10 P3 SMG 批契约（SMG-01/02V01/03V02/05/06/07V04/08/09/12/V03；hb12-SMG-07 同函数顺带钉）。
//
// 逐条要点：
//  SMG-01+08      物化名透传：暂态改名 → 物化沿用；自动序号改 maxAutoSessionNumber+1（删会话不撞名）。
//  SMG-02/V01/09  topic-analyzer：res error/aborted 监听 + 总 Deadline 30s（断连/慢滴不悬挂）。
//  hb12-SMG-07    topic 响应 >1MiB destroy+reject（同函数顺带）。
//  SMG-07/V04     SESSION_ANALYZE_TOPIC/SESSION_UPDATE/SESSION_CREATE 入参校验（对齐 COMMANDS_GET）；
//                 topic-analyzer fallback 空串不写库。
//  SMG-03/V02     loadSessions 仅在无搜索词时清搜索态；主题回调轻量刷新（就地 patch，不整表 reload）；
//                 renameActiveSession/setActiveSessionProviderModel 同步 searchResults。
//  SMG-05         deleteSession 清 toolProgress/backgroundTasks/compacting/thinkingTokens 四瞬态。
//  SMG-06         首轮主题分析触发抽 maybeAnalyzeTopicForFirstUserMessage；switchSession 回补
//                 （物化期间切走漏触发）。
//  SMG-12/ENG-03  use-chat sendMessage catch 回滚乐观 user 消息（发送失败无幽灵气泡）。
//  SMG-V03        lastFailedBySession 随会话删除清理（use-chat watch sessions 差集）。
//  SMG-09         session-repo updateSession：自动形态名不得覆盖非自动名（IPC 竞态防线）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-session-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const store = read('src/renderer/stores/session-store.ts');
const chat = read('src/renderer/composables/use-chat.ts');
const analyzer = read('src/main/modules/topic-analyzer.ts');
const handlers = read('src/main/ipc-handlers.ts');
const sessionRepo = read('src/main/database/repositories/session-repo.ts');
const autoName = read('src/shared/auto-session-name.ts');
// 二轮补救：SMG-03 两搜索框同步钉
const sidebar = read('src/renderer/components/layout/AppSidebar.vue');
const sessionsPage = read('src/renderer/pages/SessionsPage.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① SMG-08：maxAutoSessionNumber 纯函数（行为级）。
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { maxAutoSessionNumber, isAutoSessionName } = require('../src/shared/auto-session-name') as {
  maxAutoSessionNumber: (names: readonly string[]) => number;
  isAutoSessionName: (n: string | null | undefined) => boolean;
};
check('① maxAutoSessionNumber：空集 0 / 混合取最大 / 非自动名忽略', () => {
  assert.equal(maxAutoSessionNumber([]), 0);
  assert.equal(maxAutoSessionNumber(['会话 1', '会话 7', '备份', '会话 3']), 7);
  assert.equal(maxAutoSessionNumber(['会话备份', '会话 3 会话']), 0, '非精确自动形态不得计入');
  assert.ok(isAutoSessionName('会话 12') && !isAutoSessionName('会话 12 会话'));
});

// ② SMG-01+08：物化名透传与序号。
// ② 物化：暂态非自动名透传；自动名用 maxAutoSessionNumber+1（不再 sessions.length+1）。
// hb13-v A5 必要同步：物化判定改 isMaterializableAutoName（isAutoSessionName ∪ 暂态默认名
// 「新会话」两形态并集）——旧钉 isAutoSessionName(transient.name) 恰钉住「新会话不匹配 →
// 自动命名全链失效」的缺陷形态；新谓词为旧意图（改名检测）的严格超集，非弱化。
check('② 物化：暂态非自动名透传；自动名用 maxAutoSessionNumber+1（不再 sessions.length+1）', () => {
  assert.match(store, /maxAutoSessionNumber/, 'session-store 缺 maxAutoSessionNumber import/使用');
  const idx = store.indexOf('async materializeActiveTransient');
  const body = store.slice(idx, store.indexOf('\n    },', idx));
  assert.match(body, /isMaterializableAutoName\(transient\.name\)/, '物化缺暂态改名判定（hb13-v A5 并集谓词）');
  assert.ok(!body.includes('this.sessions.length + 1'), '物化名仍用 sessions.length+1（删会话后撞名）');
  assert.match(body, /maxAutoSessionNumber\(this\.sessions\.map/, '物化名未按最大自动序号+1');
});

// ③ SMG-02/V01/hb12-SMG-07：topic-analyzer 三防线。
check('③ topic-analyzer：res error/aborted 监听 + 1MiB 响应上限 + 总 Deadline 30s + fallback 空串不写库', () => {
  const reqIdx = analyzer.indexOf('function makeHttpRequest');
  const reqBody = analyzer.slice(reqIdx, analyzer.indexOf('\n}', reqIdx + 10));
  assert.match(reqBody, /res\.on\('error', reject\)/, '缺 res error 监听（SMG-V01）');
  assert.match(reqBody, /res\.on\('aborted'/, "缺 res aborted 监听（SMG-02：Node22 断连只 emit aborted）");
  assert.match(reqBody, /TOPIC_RESPONSE_MAX_BYTES/, '缺响应字节上限（hb12-SMG-07）');
  assert.match(analyzer, /TOPIC_TOTAL_DEADLINE_MS\s*=\s*30_000|TOPIC_TOTAL_DEADLINE_MS\s*=\s*30 \* 1000/, '缺 30s 总 Deadline 常量');
  assert.match(analyzer, /Promise\.race\(\[makeHttpRequest/, 'analyzeTopic 缺 Deadline 竞速');
  const fbIdx = analyzer.indexOf('// 兜底：取首句前 15 个字符');
  const fbBody = analyzer.slice(fbIdx, analyzer.indexOf('\n}', fbIdx));
  assert.match(fbBody, /if \(!fallback\)\s*\{\s*return null;\s*\}/, 'fallback 空串未跳过写库（SMG-07）');
});

// ④ SMG-07/V04：IPC 入参校验。
check('④ SESSION_CREATE/SESSION_UPDATE/SESSION_ANALYZE_TOPIC：sessionId/文本入参 typeof+trim 校验', () => {
  const createIdx = handlers.indexOf('IPC_CHANNELS.SESSION_CREATE');
  const createBody = handlers.slice(createIdx, createIdx + 900);
  assert.match(createBody, /typeof name !== 'string' \| !name\.trim\(\)|typeof name !== 'string' && !name\.trim\(\)|typeof name !== 'string'|\!name\.trim\(\)/, 'SESSION_CREATE 缺 name 校验');
  const updIdx = handlers.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const updBody = handlers.slice(updIdx, updIdx + 1400);
  assert.match(updBody, /typeof id !== 'string'/, 'SESSION_UPDATE 缺 sessionId 校验');
  const topicIdx = handlers.indexOf('IPC_CHANNELS.SESSION_ANALYZE_TOPIC');
  const topicBody = handlers.slice(topicIdx, topicIdx + 900);
  assert.match(topicBody, /typeof sessionId !== 'string'/, 'SESSION_ANALYZE_TOPIC 缺 sessionId 校验');
  assert.match(topicBody, /firstMessage\.trim\(\)/, 'SESSION_ANALYZE_TOPIC 缺 firstMessage 非空校验');
});

// ⑤ SMG-03/V02：搜索态保持 + 轻量刷新。
check('⑤ loadSessions 条件清搜索态 + patchSessionInLists 轻量刷新 + 主题回调不再整表 reload', () => {
  const loadIdx = store.indexOf('async loadSessions()');
  const loadBody = store.slice(loadIdx, store.indexOf('\n    },', loadIdx));
  assert.match(loadBody, /if \(!this\.searchQuery\)/, 'loadSessions 仍无条件清搜索态');
  assert.match(store, /patchSessionInLists\(/, '缺 patchSessionInLists 轻量刷新 action');
  const topic1 = store.indexOf('window.claudeLink.analyzeTopic(sessionId, textContent)');
  const seg = store.slice(topic1, topic1 + 1400);
  assert.ok(!seg.includes('this.loadSessions()'), '主题回调仍整表 reload（搜索态被清）');
  assert.match(seg, /patchSessionInLists\(sessionId/, '主题回调缺就地 patch');
  // rename/providerModel 同步 searchResults。
  const renameIdx = store.indexOf('async renameActiveSession(');
  const renameBody = store.slice(renameIdx, store.indexOf('\n    },', renameIdx));
  assert.match(renameBody, /patchSessionInLists|searchResults/, 'renameActiveSession 缺搜索视图同步');
});

// ⑥ SMG-05：deleteSession 清四瞬态。
check('⑥ deleteSession：清 toolProgress/backgroundTasks/compacting/thinkingTokens（对齐 switchSession 清单）', () => {
  const idx = store.indexOf('async deleteSession(id: string) {');
  const end = store.indexOf('async deleteSessions(', idx);
  const body = store.slice(idx, end > idx ? end : undefined);
  assert.match(body, /this\.toolProgress = \{\};/, '缺 toolProgress 清理');
  assert.match(body, /this\.backgroundTasks = \{\};/, '缺 backgroundTasks 清理');
  assert.match(body, /this\.compacting = false;/, '缺 compacting 复位');
  assert.match(body, /this\.thinkingTokens = null;/, '缺 thinkingTokens 清理');
});

// ⑦ SMG-06：触发抽取 + switchSession 回补。
check('⑦ 首轮主题触发抽 maybeAnalyzeTopicForFirstUserMessage；switchSession 回补', () => {
  assert.match(store, /maybeAnalyzeTopicForFirstUserMessage\(/, '缺触发抽取 action');
  const swIdx = store.indexOf('async switchSession(');
  const swEnd = store.indexOf('\n    },', swIdx);
  const swBody = store.slice(swIdx, swEnd);
  assert.match(swBody, /maybeAnalyzeTopicForFirstUserMessage\(/, 'switchSession 缺回补调用');
});

// ⑧ SMG-12/ENG-03：发送失败回滚乐观消息。
check('⑧ sendMessage catch：回滚乐观 user 消息（幽灵气泡修复）', () => {
  const idx = chat.indexOf('async function sendMessage(payload: ChatSendPayload)');
  const body = chat.slice(idx, chat.indexOf('\n  }', idx));
  assert.match(body, /clientMessageId/, '回滚未按 clientMessageId 定位');
  const catchIdx = body.indexOf('} catch (e) {');
  const catchBody = body.slice(catchIdx);
  assert.match(catchBody, /findIndex\(\(m\) => m\.id === payload\.clientMessageId\)/, 'catch 缺乐观消息回滚');
  assert.match(catchBody, /computeTurnStartIndex\(store\.messages\)/, '回滚后未重算回合边界');
});

// ⑨ SMG-V03：lastFailedBySession 随删除清理。
check('⑨ use-chat：watch sessions 列表差集清理 lastFailedBySession（SMG-V03/ENG-09）', () => {
  assert.match(chat, /lastFailedBySession/, '缺 lastFailedBySession 状态');
  const idx = chat.indexOf('// hb10-SMG-V03');
  const body = chat.slice(idx, idx + 700);
  assert.match(body, /lastFailedBySession\.value\[/, '清理逻辑未作用于 lastFailedBySession');
});

// ⑩ SMG-09：session-repo 自动名覆盖守卫。
check('⑩ session-repo updateSession：自动形态名不得覆盖非自动名（IPC 竞态防线）', () => {
  assert.match(sessionRepo, /isAutoSessionName/, 'session-repo 缺 isAutoSessionName 守卫');
  const idx = sessionRepo.indexOf('export function updateSession(');
  const body = sessionRepo.slice(idx, idx + 2000);
  assert.match(body, /partial\.name !== undefined && isAutoSessionName\(partial\.name\)/, 'updateSession 缺自动名写入门');
  const guardIdx = body.indexOf('isAutoSessionName');
  const existingIdx = body.indexOf('isAutoSessionName(existing');
  assert.ok(existingIdx > guardIdx, '守卫缺「现名非自动才拒」比对');
});


// ⑪ hb12-SMG-03（2026-09-13 二轮补救）：两搜索框 query 与 store 双向同步；空态读 store。
check('⑪ SMG-03：搜索框 watch 同步 store.searchQuery；SessionsPage 空态读 store', () => {
  for (const [name, src] of [['AppSidebar', sidebar], ['SessionsPage', sessionsPage]] as const) {
    assert.match(
      src,
      /watch\(\s*\(\) => store\.searchQuery,\s*\(q\) => \{\s*searchQuery\.value = q;\s*\},?\s*\);/,
      name + ' 缺 store→本地 watch 同步',
    );
  }
  assert.match(sessionsPage, /store\.searchQuery \? '未找到匹配的会话'/, 'SessionsPage 空态须读 store.searchQuery');
});
console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
