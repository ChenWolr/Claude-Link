// tdd-bugfix-p2-02-upstream-errors-verify.ts
// P2-2 契约钉：分类器缺口——`invalid_request`/`oauth_org_not_allowed` 短码未映射 +
// 嵌套 JSON（{"type":"error","error":{...}}）不识别（TYPE_RE 只取首个 "type"，命中外层
// "error" 值 → unknown）。
//
// 修复语义：① KIND_BY_CODE 补 invalid_request（新 kind，请求级确定性错误，NON_RETRYABLE）
// 与 oauth_org_not_allowed（归 authentication，本就 NON_RETRYABLE）；② type 提取改 matchAll，
// 取第一个命中 KIND_BY_CODE 的值。rate_limit/overloaded 不该快败的既有语义不动。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-02-upstream-errors-verify.ts

import { strict as assert } from 'node:assert';
import {
  classifyUpstreamError,
  isNonRetryableUpstreamError,
  upstreamFatalMessage,
  type UpstreamErrorClassification,
} from '../src/shared/upstream-errors';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 160)}`); }
}

check('① 短码 invalid_request → 新 kind 且 NON_RETRYABLE', () => {
  const c = classifyUpstreamError('invalid_request');
  assert.equal(c.kind, 'invalid_request');
  assert.equal(isNonRetryableUpstreamError(c.kind), true);
});
check('② 短码 oauth_org_not_allowed → authentication 且 NON_RETRYABLE', () => {
  const c = classifyUpstreamError('oauth_org_not_allowed');
  assert.equal(c.kind, 'authentication');
  assert.equal(isNonRetryableUpstreamError(c.kind), true);
});
check('③ 嵌套 JSON 外层 type=error 不再遮蔽内层 model_not_found', () => {
  const c = classifyUpstreamError('{"type":"error","error":{"type":"model_not_found","message":"Model \\"glm-5.2\\" is not supported"}}');
  assert.equal(c.kind, 'model_not_found');
  assert.equal(c.modelId, 'glm-5.2');
});
check('④ 嵌套 JSON 内层 invalid_request_error → invalid_request', () => {
  const c = classifyUpstreamError('{"type":"error","error":{"type":"invalid_request","message":"bad params"}}');
  assert.equal(c.kind, 'invalid_request');
  assert.equal(isNonRetryableUpstreamError(c.kind), true);
});
check('⑤ 回归：非嵌套 type=model_not_found 仍正确', () => {
  const c = classifyUpstreamError('{"error":{"type":"model_not_found","message":"nope"}}');
  assert.equal(c.kind, 'model_not_found');
});
check('⑥ 回归：rate_limit 不判为 NON_RETRYABLE（快败语义不动）', () => {
  const c = classifyUpstreamError('rate_limit');
  assert.equal(c.kind, 'rate_limit');
  assert.equal(isNonRetryableUpstreamError(c.kind), false);
});
check('⑦ 回归：纯网络错误文本仍归 network', () => {
  const c = classifyUpstreamError('fetch failed: ECONNREFUSED');
  assert.equal(c.kind, 'network');
});
check('⑧ invalid_request 有专属用户文案', () => {
  const c: UpstreamErrorClassification = classifyUpstreamError('{"type":"error","error":{"type":"invalid_request","message":"bad"}}');
  const msg = upstreamFatalMessage(c, '测试供应商', 'glm-5.2');
  assert.ok(msg.includes('invalid_request'), msg);
  assert.ok(msg.includes('重试不会好转') || msg.includes('确定性'), msg);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
