// tdd-bugfix-p2-21-upstream-fatal-latch-verify.ts
// P2-21 契约钉：upstream_fatal 优雅窗内迟到 api_retry 重复快败（重复 error 事件+重复系统消息落库）。
//
// 修复语义：SessionEntry 增加一次性闩 upstreamFatalAborted——快败处置前置位；api_retry 处理
// 入口查闩命中即丢弃。闩随 entry 生命周期（每回合新 entry），天然不跨回合残留。
//
// 修复轮（审计 p2-21「全结构无行为 seam」）：闩生命周期提取为纯逻辑
// shared/api-retry-state.ts 的 shouldDropLateApiRetry / markUpstreamFatalAborted，
// sdk-backend 接线调用；本脚本补行为断言——置位后迟到 api_retry 被丢弃、
// 每回合新 entry 重建后不复位（旧 entry 置位不外溢）、null entry 安全。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-21-upstream-fatal-latch-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  markUpstreamFatalAborted,
  shouldDropLateApiRetry,
  type UpstreamFatalLatchCarrier,
} from '../src/shared/api-retry-state';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── 行为 seam（闩生命周期纯逻辑） ──
check('行为A 置位后迟到 api_retry 被丢弃（shouldDropLateApiRetry 命中）', () => {
  const entry: UpstreamFatalLatchCarrier = {};
  assert.equal(shouldDropLateApiRetry(entry), false, '未置位时不丢弃');
  markUpstreamFatalAborted(entry);
  assert.equal(shouldDropLateApiRetry(entry), true, '置位后迟到事件必须被丢弃');
});
check('行为B 每回合新 entry 重建后不复位（旧 entry 置位不外溢到新 entry）', () => {
  const oldEntry: UpstreamFatalLatchCarrier = {};
  markUpstreamFatalAborted(oldEntry);
  const freshEntry: UpstreamFatalLatchCarrier = {};
  assert.equal(shouldDropLateApiRetry(freshEntry), false, '新 entry（新回合）必须不带闩');
});
check('行为C null/undefined entry 安全（迟到事件路径无 entry 可挂）', () => {
  assert.equal(shouldDropLateApiRetry(null), false);
  assert.equal(shouldDropLateApiRetry(undefined), false);
});

// ── 结构契约（接线不变量） ──
check('① SessionEntry 声明一次性闩 upstreamFatalAborted', () => {
  assert.match(backend, /upstreamFatalAborted\?: boolean;/);
});
check('② 快败处置前置位闩（markUpstreamFatalAborted 先于 abort 调用）', () => {
  const at = backend.indexOf('const nonRetryableNow = isNonRetryableUpstreamError(upstream.kind) && isCurrentEntry(sessionId, entry);');
  assert.ok(at > -1);
  const latchSet = backend.indexOf('markUpstreamFatalAborted(entry);', at);
  const abortAt = backend.indexOf('abortNonRetryableUpstream(sessionId, mainWindow, entry, upstream);', at);
  assert.ok(latchSet > -1 && latchSet < abortAt, '置位必须先于 abort 调用');
});
check('③ api_retry 入口查闩命中即丢弃（shouldDropLateApiRetry + continue，置位点之前）', () => {
  const latchCheck = backend.indexOf('if (shouldDropLateApiRetry(entry)) {');
  const latchSet = backend.indexOf('markUpstreamFatalAborted(entry);');
  assert.ok(latchCheck > -1 && latchCheck < latchSet, '入口检查须在处置置位之前');
  assert.ok(backend.slice(latchCheck, latchCheck + 300).includes('continue'));
});
check('④ 闩随 entry 生命周期（无模块级跨回合 Set/Map 残留清理需求）', () => {
  // entry 是每回合 createEntry() 新建对象；断言实现挂在 entry 上而非模块级 Map。
  assert.doesNotMatch(backend, /const upstreamFatalLatch\w* = new (Set|Map)/);
});
check('⑤ 既有三层防护不回退（isCurrentEntry 守卫保留）', () => {
  const at = backend.indexOf('const nonRetryableNow = isNonRetryableUpstreamError(upstream.kind) && isCurrentEntry(sessionId, entry);');
  assert.ok(at > -1, 'isCurrentEntry 守卫保留在 nonRetryableNow 判定中');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
