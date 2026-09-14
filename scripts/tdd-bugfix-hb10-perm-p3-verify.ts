// scripts/tdd-bugfix-hb10-perm-p3-verify.ts
// hb10 P3 PERM 批契约（PERM-02/03/04/05/06/07/08/V02/V04；PERM-05 与 hb12-PERM-05 落库合流部分随 hb12 契约验收）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-perm-p3-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const store = read('src/renderer/stores/session-store.ts');
const iStore = read('src/renderer/stores/interaction-store.ts');
const prompt = read('src/renderer/components/chat/InteractionPrompt.vue');
const sdkInter = read('src/main/modules/sdk-interactions.ts');
const sdkPerm = read('src/main/modules/sdk-permissions.ts');
const promptsMain = read('src/main/modules/interaction-prompts.ts');
const mainIndex = read('src/main/index.ts');
const sidebar = read('src/renderer/components/layout/AppSidebar.vue');
const toolbar = read('src/renderer/components/chat/SessionToolbar.vue');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① PERM-02。
check('① PERM-02：setActiveSessionPermissionMode 捕获稳定 sessionId + 回写前比对', () => {
  const idx = store.indexOf('async setActiveSessionPermissionMode(');
  const body = store.slice(idx, store.indexOf('\n    },', idx));
  assert.match(body, /const sessionId = this\.activeSession\.id;/, '缺稳定 sessionId 捕获');
  assert.match(body, /this\.activeSession\?\.id === sessionId/, '回写前缺比对（竞态窗发错会话）');
  assert.match(body, /setRunningPermissionMode\(sessionId, mode\)/, '控制请求未用稳定 sessionId');
});

// ② PERM-03。
check('② PERM-03：30s 对账 reconcile + IPC 失败不本地移除 + 失败不前进队列', () => {
  assert.match(iStore, /async reconcile\(\): Promise<void> \{/, '缺 reconcile action');
  assert.match(iStore, /getPendingInteractions\(\)/, 'reconcile 未拉 GET_PENDING');
  const rrIdx = iStore.indexOf('async respondAndRemove');
  const rrBody = iStore.slice(rrIdx, rrIdx + 900);
  assert.ok(!rrBody.includes('} finally {'), 'respondAndRemove 仍 finally 无条件移除（IPC 失败静默丢答案）');
  assert.match(prompt, /setInterval\(/, '缺 30s 对账轮询');
  assert.match(prompt, /30_000/, '轮询间隔非 30s');
  assert.match(prompt, /submitError\.value =/, '缺失败提示（请求留队可重试）');
  const catchAdv = prompt.match(/console\.error\('Interaction submit failed', err\);[\s\S]{0,120}/)?.[0] ?? '';
  assert.ok(!catchAdv.includes('advanceQueueUI()'), 'submit 失败仍前进队列（请求留队后视图错位）');
});

// ③ PERM-04。
check('③ PERM-04：ask 形状 payload 映射 allow（复用 buildAskUserQuestionResult）', () => {
  const idx = sdkInter.indexOf('export function mapPermissionInteractionResponse');
  const body = sdkInter.slice(idx, sdkInter.indexOf('export function isAskUserQuestionPayload'));
  assert.match(body, /isAskUserQuestionPayload\(payload/, '缺 ask 形状判定');
  assert.match(body, /buildAskUserQuestionResult\(/, '缺答案组装');
  const askIdx = body.indexOf('isAskUserQuestionPayload(payload');
  const denyIdx = body.indexOf("behavior: 'deny'");
  assert.ok(denyIdx > askIdx, 'ask 分支必须先于 deny 兜底');
});

// ④ PERM-05。
check('④ PERM-05：pendingRemoteCountBySession getter + 侧栏 ⏳ badge + 托盘 tooltip', () => {
  assert.match(iStore, /pendingRemoteCountBySession\(state\)/, 'interaction-store 缺 getter');
  assert.match(sidebar, /pendingRemoteCountBySession\[session\.id\]/, '侧栏缺 badge 判定');
  assert.match(sidebar, /⏳/, '侧栏缺 ⏳');
  assert.match(mainIndex, /setInteractionCountChangedHook\(\(\) => updateTrayPendingHint\(\)\);/, '托盘未订阅数量变化');
  assert.match(mainIndex, /Claude Link（⏳/, '托盘 tooltip 缺 ⏳ 文案');
});

// ⑤ PERM-06。
check('⑤ PERM-06：render-process-gone 兜底取消 + 10min 兜底超时 + cancelAllPendingInteractions', () => {
  const idx = mainIndex.indexOf('render-process-gone');
  const body = mainIndex.slice(idx, idx + 700);
  assert.match(body, /cancelAllPendingInteractions\(\);/, '崩溃回调缺兜底取消');
  assert.match(promptsMain, /PENDING_MAX_AGE_MS = 10 \* 60_000/, '缺 10min 兜底常量');
  assert.match(promptsMain, /export function cancelAllPendingInteractions\(\): void/, '缺导出');
  assert.match(promptsMain, /Interaction request expired after/, '缺超时日志');
});

// ⑥ PERM-07。
check('⑥ PERM-07：confirm 类补 URL 核对行（仅 input.url 存在时）', () => {
  assert.match(prompt, /activeRequest\.kind === 'confirm' && Boolean\(\(activeRequest\.input/, 'URL 行缺 confirm/url 双判定');
  assert.match(prompt, /interaction-url__value/, '缺 URL 值渲染');
});

// ⑦ PERM-08/V02。
check('⑦ PERM-08/V02：四档描述重写 + foot 补 bypass 生效提示', () => {
  assert.match(toolbar, /desc: '每次工具调用需手动确认'/, 'default 描述未重写');
  assert.match(toolbar, /desc: '仅规划，工具需审批'/, 'plan 描述未重写');
  assert.match(toolbar, /desc: '自动接受文件编辑，其余需确认'/, 'acceptEdits 描述未重写');
  assert.match(toolbar, /desc: '跳过所有权限确认【谨慎使用】'/, 'bypass 描述未重写');
  assert.match(toolbar, /bypass 需下一条消息生效/, 'foot 缺 bypass 生效提示');
});

// ⑧ PERM-V04。
check('⑧ PERM-V04：coerce 过滤 setMode 类建议（allow-session 不静默改档）', () => {
  const idx = sdkPerm.indexOf('export function coercePermissionUpdatesToSession');
  const body = sdkPerm.slice(idx, sdkPerm.indexOf('export function buildToolSessionAllowUpdate'));
  assert.match(body, /update\.type !== 'setMode'/, '缺 setMode 过滤');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
