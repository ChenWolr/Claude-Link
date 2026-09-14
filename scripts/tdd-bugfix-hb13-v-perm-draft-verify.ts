// scripts/tdd-bugfix-hb13-v-perm-draft-verify.ts
// hb13-v A8【权限】契约：弹窗草稿缓存跨请求污染修复验证。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-perm-interact.md F2，误授权风险面）：
//   草稿保存 watch 把 activeRequest 放进源数组且回调读 flush 时的 activeRequest.value——
//   A→B 弹窗换位时 flush 读到的已是 B，把 A 的选择写进 B 的 id，B 恢复 A 的预选
//  （权限弹窗预选上一单 allow，误按 Enter 即放行）。
// 修法：watch 源仅草稿字段；以 initSelection 入口捕获的 displayedRequestId（捕获期 id）
// 为键写回自身 id；null 不写；initSelection 恢复前键校验天然成立（get(request.id)）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-perm-draft-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const prompt = fs.readFileSync(path.join(repoRoot, 'src/renderer/components/chat/InteractionPrompt.vue'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① watch 源不得含 activeRequest（污染向量移除）。
check('① 草稿 watch 源仅草稿字段（activeRequest 已移出源数组）', () => {
  const watchIdx = prompt.indexOf('// hb12-PERM-04：草稿变化即入缓存');
  assert.ok(watchIdx > -1, '未找到草稿 watch 段');
  const seg = prompt.slice(watchIdx, watchIdx + 900);
  assert.match(seg, /watch\(\s*\[selectedIds, otherText, questionAnswers, fieldValues\] as const/, 'watch 源形态不符');
  assert.ok(!/activeRequest\] as const/.test(seg), 'watch 源仍含 activeRequest（A→B 换位污染向量）');
});

// ② 回调以捕获期 id 为键 + null 守卫。
check('② watch 回调：displayedRequestId 键守卫（null 不写）+ 写回自身 id', () => {
  const watchIdx = prompt.indexOf('// hb13-v A8：写回自身 id');
  assert.ok(watchIdx > -1, '未找到 A8 修复注释锚');
  const seg = prompt.slice(watchIdx, watchIdx + 1200);
  assert.match(seg, /let displayedRequestId: string \| null = null;/, '缺捕获期 id 声明');
  assert.match(seg, /if \(!displayedRequestId\) return;/, '缺 null 守卫');
  assert.match(seg, /draftCache\.set\(displayedRequestId,/, '缓存写入未用捕获期 id 作键');
  assert.ok(!/draftCache\.set\(req\.id/.test(seg), '残留 flush 期 activeRequest 读键形态');
});

// ③ initSelection 入口先刷新捕获期 id，再做变更；恢复前键校验（既有 PERM-04 钉保持）。
check('③ initSelection：入口先置 displayedRequestId，恢复仍按 get(request.id)', () => {
  const fnIdx = prompt.indexOf('function initSelection');
  const fnEnd = prompt.indexOf('\n}', fnIdx);
  const body = prompt.slice(fnIdx, fnEnd > -1 ? fnEnd : undefined);
  const guardIdx = body.indexOf('displayedRequestId = request.id;');
  const getIdx = body.indexOf('draftCache.get(request.id)');
  assert.ok(guardIdx > -1, 'initSelection 缺 displayedRequestId 刷新');
  assert.ok(getIdx > guardIdx, 'id 刷新必须在缓存读取/状态变更之前');
  assert.match(body, /const cached = draftCache\.get\(request\.id\);/, '恢复前键校验形态丢失（hb12-PERM-04 钉）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
