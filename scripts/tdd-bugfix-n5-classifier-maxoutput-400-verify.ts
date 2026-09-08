// tdd-bugfix-n5-classifier-maxoutput-400-verify.ts
// N5（P2）契约钉：分类器缺 `max_output_tokens` 映射 + HTTP 400 无状态映射——
// SDK 错误枚举含 max_output_tokens（sdk.d.ts），api-retry-state.ts 连标签都备好了，
// 唯独 KIND_BY_CODE 没接；确定性错误烧满全部重试后误报「网络中断」。
//
// 修复语义：① KIND_BY_CODE 补 max_output_tokens:'invalid_request'（确定性错误，快败）；
// ② 状态码兜底补 400→'invalid_request'；③ reasoning_replay 的 400 前置特例
//（isReasoningReplayApiError）仍在状态码兜底之前，不被 400 映射误伤。
//
// 运行：npx tsx scripts/tdd-bugfix-n5-classifier-maxoutput-400-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyUpstreamError, isNonRetryableUpstreamError } from '../src/shared/upstream-errors';

const repoRoot = path.resolve(__dirname, '..');
const src = fs.readFileSync(path.join(repoRoot, 'src/shared/upstream-errors.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── 行为 ──
check('① 短错误码 max_output_tokens → invalid_request（确定性，快败）', () => {
  const c = classifyUpstreamError('max_output_tokens');
  assert.equal(c.kind, 'invalid_request', String(c.kind));
  assert.equal(isNonRetryableUpstreamError(c.kind), true);
});
check('② 未知文本 + HTTP 400 → invalid_request（状态兜底）', () => {
  const c = classifyUpstreamError('upstream rejected the payload', 400);
  assert.equal(c.kind, 'invalid_request', String(c.kind));
});
check('③ reasoning_replay 前置特例不被 400 映射误伤', () => {
  const text = 'API Error: 400 The `reasoning_content` in the thinking mode must be passed back to the API.';
  const c = classifyUpstreamError(text, 400);
  assert.equal(c.kind, 'reasoning_replay', String(c.kind));
});
check('④ 既有状态映射不回退（404/401/429/500 抽样）', () => {
  assert.equal(classifyUpstreamError('Not Found', 404).kind, 'model_not_found');
  assert.equal(classifyUpstreamError('Unauthorized', 401).kind, 'authentication');
  assert.equal(classifyUpstreamError('Too Many Requests', 429).kind, 'rate_limit');
  assert.equal(classifyUpstreamError('Bad Gateway', 502).kind, 'server_error');
});

// ── 结构（接线注释：400 特例先于状态兜底）──
check('⑤ 源码中 reasoning_replay 特例仍在状态码推断块之前', () => {
  const preAt = src.indexOf('isReasoningReplayApiError(text)');
  const statusAt = src.indexOf('if (typeof status === \'number\')');
  assert.ok(preAt > -1 && statusAt > preAt, `pre=${preAt} status=${statusAt}`);
});
check('⑥ KIND_BY_CODE 含 max_output_tokens 条目', () => {
  assert.match(src, /max_output_tokens:\s*'invalid_request'/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
