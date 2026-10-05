// tdd-provider-keyless-headers-verify.ts
// B7（D02-F5）key-less 放行纯逻辑：buildModelsRequestHeaders 凭据头门控（行为断言）。
// 有 key → Anthropic 风格 x-api-key + anthropic-version / OpenAI 回退 Bearer；
// 空 key（key-less 档案，认证走端点侧白名单/外部登录态）→ 两风格均省略凭据头
//（空头无意义，个别网关见空凭据头反 401），anthropic-version 属协议版本头非凭据，保留。
//
// 配套契约：tdd-provider-keyless-clear-verify.ts（②放行删拦截 + ③门控结构的文本钉）。
// 运行：npx tsx scripts/tdd-provider-keyless-headers-verify.ts

import { strict as assert } from 'node:assert';
import { buildModelsRequestHeaders } from '../src/main/modules/model-resolver';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

console.log('\n=== B7（D02-F5）：key-less 凭据头门控纯逻辑 ===');

console.log('-- 有 key：凭据头齐全 --');
const keyed = buildModelsRequestHeaders('sk-test-123');
check('Anthropic 头含 x-api-key', () => {
  assert.equal(keyed.anthropic['x-api-key'], 'sk-test-123', `实得 ${JSON.stringify(keyed.anthropic)}`);
});
check('Anthropic 头含 anthropic-version', () => {
  assert.equal(keyed.anthropic['anthropic-version'], '2023-06-01', `实得 ${JSON.stringify(keyed.anthropic)}`);
});
check('OpenAI 回退头为 Bearer <key>', () => {
  assert.equal(keyed.openai.Authorization, 'Bearer sk-test-123', `实得 ${JSON.stringify(keyed.openai)}`);
});
check('风格不串：Anthropic 头无 Authorization、OpenAI 头无 x-api-key', () => {
  assert.ok(!('Authorization' in keyed.anthropic), 'Anthropic 头不应含 Authorization');
  assert.ok(!('x-api-key' in keyed.openai), 'OpenAI 头不应含 x-api-key');
});

console.log('-- 空 key（key-less 档案）：凭据头省略 --');
const keyless = buildModelsRequestHeaders('');
check('Anthropic 头省略 x-api-key（IP 白名单网关免凭据可通）', () => {
  assert.ok(!('x-api-key' in keyless.anthropic), `实得 ${JSON.stringify(keyless.anthropic)}`);
});
check('anthropic-version 协议头保留（非凭据）', () => {
  assert.equal(keyless.anthropic['anthropic-version'], '2023-06-01', `实得 ${JSON.stringify(keyless.anthropic)}`);
});
check('OpenAI 回退头为空对象（无 Bearer 空串）', () => {
  assert.deepEqual(keyless.openai, {}, `实得 ${JSON.stringify(keyless.openai)}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
