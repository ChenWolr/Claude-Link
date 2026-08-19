// tdd-process-fold-verify.ts
// 行为测试：过程折叠（group-messages.ts）对齐 openhanako process-fold 的规则。
// 核心：短过程叙事文本不打断 fold、回合最终文本受保护、长正文/user 消息打断、连续过程折叠阈值。
// 运行：npx tsx scripts/tdd-process-fold-verify.ts
import { strict as assert } from 'node:assert';
import {
  groupMessagesForRender,
  computeStats,
  isFoldable,
  MIN_FOLD,
  PROCESS_NARRATION_TEXT_LIMIT,
} from '../src/renderer/utils/group-messages';
import type { RenderableMessage } from '../src/shared/types/export-image';

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

let seq = 0;
function msg(partial: Partial<RenderableMessage>): RenderableMessage {
  seq += 1;
  return {
    id: partial.id ?? `m${seq}`,
    sessionId: 's1',
    role: partial.role ?? 'assistant',
    content: partial.content ?? '',
    eventType: partial.eventType ?? 'message',
    costUsd: null,
    durationMs: null,
    processKind: partial.processKind ?? null,
    parentAgentId: null,
    toolUseId: partial.toolUseId ?? null,
    title: null,
    isError: false,
    createdAt: '2026-08-19T00:00:00.000Z',
  };
}

function userText(id: string, content: string): RenderableMessage {
  return msg({ id, role: 'user', content, eventType: 'message', processKind: null });
}
function narration(id: string, content: string): RenderableMessage {
  return msg({ id, role: 'assistant', content, eventType: 'message', processKind: null });
}
function toolUse(id: string, toolUseId: string): RenderableMessage {
  return msg({ id, role: 'assistant', content: '{}', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId });
}
function toolResult(id: string, toolUseId: string): RenderableMessage {
  return msg({ id, role: 'tool', content: 'ok', eventType: 'tool_result', processKind: 'tool:Bash', toolUseId });
}

console.log('\n=== 常量契约 ===');
check('PROCESS_NARRATION_TEXT_LIMIT 对齐 openhanako=100', () => {
  assert.equal(PROCESS_NARRATION_TEXT_LIMIT, 100);
});
check('MIN_FOLD=3', () => {
  assert.equal(MIN_FOLD, 3);
});

console.log('\n=== 短叙事文本进 fold + 最终文本保护 ===');
{
  const items = groupMessagesForRender([
    userText('u1', '提交代码'),
    narration('t1', '提交 1：新增 IPC 通道'),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    narration('t2', '提交 2：会话 store 新增 action'),
    toolUse('use2', 'tool2'),
    toolResult('res2', 'tool2'),
    narration('final', '完成，4 个提交已落地'),
  ]);
  check('输出 3 项（user / fold / 最终文本）', () => {
    assert.equal(items.length, 3);
  });
  check('首项是 user 消息', () => {
    assert.equal(items[0]!.type, 'message');
    assert.equal(items[0]!.type === 'message' ? items[0].message.role : '', 'user');
  });
  check('短叙事文本与工具合并成一个 fold（6 条）', () => {
    const item = items[1]!;
    assert.equal(item.type, 'fold');
    if (item.type === 'fold') assert.equal(item.messages.length, 6);
  });
  check('fold 内叙事文本按原顺序穿插（位置 0/3）', () => {
    const item = items[1]!;
    if (item.type === 'fold') {
      assert.equal(item.messages[0]!.content, '提交 1：新增 IPC 通道');
      assert.equal(item.messages[3]!.content, '提交 2：会话 store 新增 action');
    }
  });
  check('回合最终文本受保护、独立成 message 项', () => {
    const item = items[2]!;
    assert.equal(item.type, 'message');
    if (item.type === 'message') assert.equal(item.message.content, '完成，4 个提交已落地');
  });
}

console.log('\n=== 长正文打断 fold ===');
{
  const longText = '长'.repeat(PROCESS_NARRATION_TEXT_LIMIT + 1);
  const items = groupMessagesForRender([
    userText('u1', 'x'),
    narration('long', longText),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    narration('final', '结束'),
  ]);
  check('长正文独立成 message 项、打断 fold', () => {
    assert.equal(items.length, 4);
    assert.equal(items[1]!.type, 'message');
    assert.equal(items[2]!.type, 'fold');
  });
}

console.log('\n=== 多回合：每回合最终文本各自受保护 ===');
{
  const items = groupMessagesForRender([
    userText('u1', 'a'),
    narration('final-a', '回合 A 结论'),
    userText('u2', 'b'),
    narration('final-b', '回合 B 结论'),
  ]);
  check('两个回合的短最终文本都独立成 message 项（无 fold）', () => {
    assert.deepEqual(
      items.map((i) => i.type),
      ['message', 'message', 'message', 'message'],
    );
  });
}

console.log('\n=== 连续过程折叠阈值（回归） ===');
check('isFoldable：≥3 折叠 / <3 展开', () => {
  assert.equal(isFoldable(2), false);
  assert.equal(isFoldable(3), true);
  assert.equal(isFoldable(0), false);
});
check('连续纯过程合并成一个 fold', () => {
  const items = groupMessagesForRender([
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
    toolUse('use2', 'tool2'),
    toolResult('res2', 'tool2'),
  ]);
  assert.equal(items.length, 1);
  assert.equal(items[0]!.type, 'fold');
});

console.log('\n=== computeStats 不计叙事文本 ===');
check('叙事文本不计入 tool/thinking 计数', () => {
  const stats = computeStats([
    narration('t1', '旁白'),
    toolUse('use1', 'tool1'),
    toolResult('res1', 'tool1'),
  ]);
  assert.equal(stats.toolCount, 1);
  assert.equal(stats.thinkingCount, 0);
  assert.equal(stats.running, false);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
