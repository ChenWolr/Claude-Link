// tdd-bugfix-topic-thinking-leak-verify.ts
// 自动命名思考泄漏契约钉（2026-09-09）：新会话自动命名失效定案——GLM-5.2/5.3 等思考型模型
// 经 sub2api 网关会把思考过程逐字泄漏进首个 text 块，且思考烧光 max_tokens:50 被截断
// （stop_reason:"max_tokens"），标题落库为 "The user wants me to"（线上 DB 实况）。
// thinking.type:"disabled" 被智谱拒绝/网关吞掉，厂商方言（reasoning_effort）实测有害
// （deepseek 被瞎映射、mimo 直接崩溃）——唯一安全档位是 Anthropic 协议最小思考预算
// budget_tokens:1024（2026-09-09 实测 7 模型×2 网关矩阵，见计划文档）。
//
// 修复语义（topic-analyzer 验收梯）：
// ① 请求体改走梯子：首梯 thinking enabled@1024 + max_tokens 2000；答卷被拒 → 二梯 4096/8000；
//    首梯 HTTP 4xx（疑似 thinking 字段不兼容）→ legacy 形态（无 thinking 字段）重试；
//    超时/5xx/网络错误/JSON 解析失败 → 不重试，直达首句兜底。全流程最多 2 次 HTTP。
// ② 答卷验收（厂商中立）：stop_reason 仅认 end_turn；text 非空；text 与 thinking 块
//    不得重复（逐字或前 40 字符相同）；主题不得以元语言开场（The user…/我需要… 软判据）。
// ③ 纯逻辑抽 src/shared/topic-analyzer-core.ts（零运行时依赖，契约脚本直接 import 单测）。
// ④ F4/H3 既有契约不破：updateSession(name:) 恰好 2 处出口、isAutoNameSlot 写前门 ≥ 2 处。
//
// 契约：本脚本 A 节行为断言（import core 纯函数）+ B 节主进程静态钉 + C 节渲染层零改动钉。
//
// 运行：npx tsx scripts/tdd-bugfix-topic-thinking-leak-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  TOPIC_ATTEMPT_LADDER,
  TOPIC_ATTEMPT_LEGACY,
  TOPIC_PROMPT_PREFIX,
  buildTopicRequestBody,
  extractTopicCandidate,
  nextAttemptSpec,
  type TopicResponseShape,
} from '../src/shared/topic-analyzer-core';

const repoRoot = path.resolve(__dirname, '..');
const analyzer = fs.readFileSync(path.join(repoRoot, 'src/main/modules/topic-analyzer.ts'), 'utf8');
const sessionStore = fs.readFileSync(path.join(repoRoot, 'src/renderer/stores/session-store.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: (() => void) | boolean): void {
  try {
    if (typeof cond === 'function') cond();
    else if (!cond) throw new Error('断言为假');
    pass += 1; console.log(`  ✅ ${name}`);
  }
  catch (e) { fail += 1; console.log(`  ✗ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

console.log('=== A1. 梯子形状与官方约束 ===');
{
  check('首梯 = thinking enabled@1024 + max_tokens 2000',
    () => assert.deepStrictEqual(TOPIC_ATTEMPT_LADDER[0], { thinking: { type: 'enabled', budget_tokens: 1024 }, maxTokens: 2000 }));
  check('二梯 = thinking enabled@4096 + max_tokens 8000',
    () => assert.deepStrictEqual(TOPIC_ATTEMPT_LADDER[1], { thinking: { type: 'enabled', budget_tokens: 4096 }, maxTokens: 8000 }));
  check('legacy 形态 = 无 thinking + max_tokens 2000',
    () => assert.deepStrictEqual(TOPIC_ATTEMPT_LEGACY, { thinking: null, maxTokens: 2000 }));
  check('官方约束：全梯 maxTokens > budget_tokens',
    TOPIC_ATTEMPT_LADDER.every((s) => s.thinking === null || s.maxTokens > s.thinking.budget_tokens));
}

console.log('=== A2. 请求体构造（方言禁令 + 提示词模板） ===');
{
  const body = JSON.parse(buildTopicRequestBody('test-model', '首句'.repeat(100), TOPIC_ATTEMPT_LADDER[0])) as Record<string, unknown>;
  const allowedKeys = ['model', 'max_tokens', 'thinking', 'messages'];
  check('键集合 ⊆ [model, max_tokens, thinking, messages]（无 reasoning_effort 等方言字段）',
    () => assert.ok(Object.keys(body).every((k) => allowedKeys.includes(k)), `实际键：${Object.keys(body).join(',')}`));
  check('首梯含 thinking enabled@1024 与 max_tokens 2000',
    () => assert.deepStrictEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 }) || assert.strictEqual(body.max_tokens, 2000));
  const messages = body.messages as Array<{ role: string; content: string }>;
  check('messages 恰 1 条 user 消息，content 以提示词前缀开头',
    () => {
      assert.strictEqual(messages.length, 1);
      assert.strictEqual(messages[0].role, 'user');
      assert.ok(messages[0].content.startsWith(TOPIC_PROMPT_PREFIX));
    });
  check('超长首句被截到 500 字符',
    () => {
      const long = JSON.parse(buildTopicRequestBody('m', '甲'.repeat(600), TOPIC_ATTEMPT_LADDER[0])) as { messages: Array<{ content: string }> };
      assert.strictEqual(long.messages[0].content, `${TOPIC_PROMPT_PREFIX}${'甲'.repeat(500)}`);
    });
  const legacyBody = JSON.parse(buildTopicRequestBody('m', 'x', TOPIC_ATTEMPT_LEGACY)) as Record<string, unknown>;
  check('legacy 形态产物不含 thinking 键', !('thinking' in legacyBody));
}

console.log('=== A3. 答卷验收判据（8 例） ===');
{
  check('① end_turn + 独立 thinking + text → ok（topic=任务未执行）',
    () => {
      const v = extractTopicCandidate({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '用户在问队列倒计时结束后任务为什么没有自动执行，我需要检查配置' },
          { type: 'text', text: '任务未执行' },
        ],
      });
      assert.deepStrictEqual(v, { ok: true, topic: '任务未执行', reason: 'ok' });
    });
  check('② end_turn + 仅 text（无 thinking 块）→ ok',
    () => {
      const v = extractTopicCandidate({ stop_reason: 'end_turn', content: [{ type: 'text', text: '队列未执行' }] });
      assert.strictEqual(v.ok, true);
    });
  check('③ text 与 thinking 逐字相同 → 拒（text_duplicates_thinking）',
    () => {
      const v = extractTopicCandidate({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: '任务未执行' },
          { type: 'text', text: '任务未执行' },
        ],
      });
      assert.strictEqual(v.reason, 'text_duplicates_thinking');
    });
  check('④ text 与 thinking 前 40 字符相同 → 拒（泄漏形态，前缀恰 40 字边界）',
    () => {
      const head = '队列倒计时结束后任务没有自动执行的问题需要检查执行器配置与日志逐一排除可能原因详';
      assert.strictEqual(head.length, 40);
      const v = extractTopicCandidate({
        stop_reason: 'end_turn',
        content: [
          { type: 'thinking', thinking: `${head}思考稿尾部内容AAA` },
          { type: 'text', text: `${head}正文尾部内容BBB` },
        ],
      });
      assert.strictEqual(v.reason, 'text_duplicates_thinking');
    });
  check('⑤ stop_reason = max_tokens → 拒（stop_not_end_turn，截断形态）',
    () => {
      const v = extractTopicCandidate({ stop_reason: 'max_tokens', content: [{ type: 'text', text: 'The user wants me to' }] });
      assert.strictEqual(v.reason, 'stop_not_end_turn');
    });
  check('⑥ text 空串 → 拒（empty_text）',
    () => {
      const v = extractTopicCandidate({ stop_reason: 'end_turn', content: [{ type: 'text', text: '   ' }] });
      assert.strictEqual(v.reason, 'empty_text');
    });
  check('⑦ 无 text 块 → 拒（no_text，mimo 空正文形态）',
    () => {
      const v = extractTopicCandidate({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '只有思考' }] });
      assert.strictEqual(v.reason, 'no_text');
    });
  check('⑧ 元语言开场（The user wants…，无 thinking 块）→ 拒（meta_preamble）',
    () => {
      const v = extractTopicCandidate({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The user wants me to summarize' }] });
      assert.strictEqual(v.reason, 'meta_preamble');
    });
}

console.log('=== A4. 升档策略（有界：全流程最多 2 次 HTTP） ===');
{
  check('答卷被拒 → 二梯（4096/8000）',
    () => assert.strictEqual(nextAttemptSpec(0, 'validation'), TOPIC_ATTEMPT_LADDER[1]));
  check('首梯 HTTP 4xx → legacy 形态（无 thinking 字段）',
    () => assert.strictEqual(nextAttemptSpec(0, 'http_4xx'), TOPIC_ATTEMPT_LEGACY));
  check('超时/5xx/网络错误 → 不重试（null）',
    () => assert.strictEqual(nextAttemptSpec(0, 'transport'), null));
  check('二梯失败 → 不再升档（null，直达兜底）',
    () => assert.strictEqual(nextAttemptSpec(1, 'validation'), null));
}

console.log('=== B. topic-analyzer.ts 静态钉（主进程） ===');
{
  const writeCount = (analyzer.match(/sessionRepo\.updateSession\(sessionId, \{ name:/g) || []).length;
  check(`updateSession(name:) 恰好 2 处出口（实际 ${writeCount} 处，F4 契约互证）`, writeCount === 2);
  const gateCount = (analyzer.match(/if \(isAutoNameSlot\(sessionId\)\)/g) || []).length;
  check(`isAutoNameSlot 写前门 ≥ 2 处（实际 ${gateCount} 处）`, gateCount >= 2);
  check('resolveSessionModel 解析链保留', analyzer.includes('resolveSessionModel'));
  check('老链路兜底 resolveConfiguredDefaultModel 保留', analyzer.includes('resolveConfiguredDefaultModel'));
  check('源文件不含 reasoning_effort（方言禁令）', !analyzer.includes('reasoning_effort'));
  check('纯逻辑从 shared/topic-analyzer-core 导入（防两处实现分叉）',
    /from '\.\.\/\.\.\/shared\/topic-analyzer-core'/.test(analyzer));
  check('makeHttpRequest 10s 超时保留', analyzer.includes('makeHttpRequest(url, requestBody, headers, 10000)'));
}

console.log('=== C. session-store.ts 零改动钉（渲染层） ===');
{
  check('analyzeTopic(sessionId, textContent) 调用形态不变', sessionStore.includes('analyzeTopic(sessionId, textContent)'));
  check('首条触发条件 filter((m) => m.role === \'user\').length === 1 保留',
    sessionStore.includes("filter((m) => m.role === 'user').length === 1"));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
