// tdd-bugfix-opt6-session-switch-scroll-verify.ts
// OPT-6 两缺陷（审计「设计不完备」）：
// ① 切会话复位缺失——nearBottom 是组件级跨会话残留态，上一会话上滚未到底时切到新会话
//   不滚底（基线行为回退）；
// ② ResizeObserver 只观察 el.firstElementChild（首条消息，身份随内容变化）——非首条图片/
//   KaTeX 异步撑高兜不住。
//
// 修复语义：① watch activeSession.id 变化 → 重置 nearBottom=true 并滚底；
// ② 模板加内层内容 wrapper（message-list__inner），ResizeObserver 观察它——内容整体撑高
//   都触发跟底。
//
// 运行：npx tsx scripts/tdd-bugfix-opt6-session-switch-scroll-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/MessageList.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① 会话切换重置跟底：watch activeSession id → nearBottom=true + 滚底', () => {
  const at = src.indexOf("watch(\r\n  () => sessionStore.activeSession?.id")
    >= 0 ? src.indexOf("watch(\r\n  () => sessionStore.activeSession?.id") : src.indexOf('activeSession?.id');
  assert.ok(at > -1, '未找到 activeSession?.id 的 watch');
  const seg = src.slice(at, at + 500);
  assert.match(seg, /nearBottom\.value = true/);
  assert.match(seg, /scrollToBottom\(\)/);
});

check('② 模板含内层内容 wrapper（message-list__inner + ref）', () => {
  assert.match(src, /<div ref="innerRef" class="message-list__inner">/);
});

check('③ ResizeObserver 观察内层 wrapper（不再只观察 firstElementChild）', () => {
  assert.match(src, /resizeObserver\.observe\(inner(?:Ref\.value)?\)/);
  assert.doesNotMatch(src, /observe\(el\.firstElementChild\)/);
  assert.doesNotMatch(src, /firstElementChild/);
});

check('④ 既有跟底约束不回退（nearBottom 门 + 回底按钮保留）', () => {
  assert.match(src, /if \(!nearBottom\.value\) return;/);
  assert.match(src, /back-to-bottom/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
