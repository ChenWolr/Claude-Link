// tdd-subagent-verify.ts
// T08/T10 行为测试：子 Agent Tab 的纯聚合/过滤/耗时逻辑（subagent-groups.ts）。
// 项目无 jest/vitest，沿用 tdd-*-verify.ts 的 node:assert + 自统计模式。
// 运行：npx tsx scripts/tdd-subagent-verify.ts
import { strict as assert } from 'node:assert';
import {
  aggregateSubAgentGroups,
  buildTitleByToolUseId,
  computeElapsedSeconds,
  currentTurnMessages,
  filterCurrentTurnItems,
  formatDuration,
  isInCurrentTurn,
} from '../src/renderer/utils/subagent-groups';
import type { Message } from '../src/shared/types/session';

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

function msg(partial: Partial<Message> & { id: string }): Message {
  return {
    id: partial.id,
    sessionId: partial.sessionId ?? 's1',
    role: partial.role ?? 'assistant',
    content: partial.content ?? '',
    rawEvent: null,
    eventType: partial.eventType ?? 'message',
    costUsd: null,
    durationMs: partial.durationMs ?? null,
    parentTaskId: null,
    processKind: partial.processKind ?? null,
    parentAgentId: partial.parentAgentId ?? null,
    toolUseId: partial.toolUseId ?? null,
    title: partial.title ?? null,
    isError: false,
    createdAt: partial.createdAt ?? '2026-06-29T00:00:00.000Z',
  };
}

console.log('\n=== formatDuration ===');
check('null → 「—」', () => {
  assert.equal(formatDuration(null), '—');
});
check('数字 → 保留 1 位小数 + s', () => {
  assert.equal(formatDuration(1.5), '1.5s');
  assert.equal(formatDuration(0), '0.0s');
});

console.log('\n=== computeElapsedSeconds：耗时来源优先级 ===');
check('running 工具实时 tool_progress 优先（取最大）', () => {
  const ms = [msg({ id: 'm1', toolUseId: 't1', durationMs: 5000 })];
  // toolProgress 有值时，即使 durationMs 也有值，也只用实时
  assert.equal(computeElapsedSeconds(ms, { t1: 3 }), 3);
});
check('无实时 → durationMs 累加 / 1000', () => {
  const ms = [msg({ id: 'm1', toolUseId: 't1', durationMs: 1000 }), msg({ id: 'm2', toolUseId: 't2', durationMs: 500 })];
  assert.equal(computeElapsedSeconds(ms, {}), 1.5);
});
check('无 durationMs → createdAt 时间戳首尾差 / 1000', () => {
  const ms = [
    msg({ id: 'm1', createdAt: '2026-06-29T00:00:00.000Z' }),
    msg({ id: 'm2', createdAt: '2026-06-29T00:00:02.500Z' }),
  ];
  assert.equal(computeElapsedSeconds(ms, {}), 2.5);
});
check('三者皆无（单条无耗时消息）→ null', () => {
  assert.equal(computeElapsedSeconds([msg({ id: 'm1' })], {}), null);
  assert.equal(computeElapsedSeconds([], {}), null);
});

console.log('\n=== currentTurnMessages / isInCurrentTurn ===');
check('currentTurnMessages 切片 turnStartIndex 之后', () => {
  const all = [msg({ id: 'a' }), msg({ id: 'b' }), msg({ id: 'c' })];
  assert.deepEqual(currentTurnMessages(all, 1).map((m) => m.id), ['b', 'c']);
});
check('isInCurrentTurn：边界正确', () => {
  const all = [msg({ id: 'a' }), msg({ id: 'b' })];
  assert.equal(isInCurrentTurn(all[1], all, 1), true);
  assert.equal(isInCurrentTurn(all[0], all, 1), false);
  assert.equal(isInCurrentTurn(all[0], all, 0), true);
});

console.log('\n=== filterCurrentTurnItems：本回合去重 ===');
check('非发送态 → 原样返回（不过滤）', () => {
  const all = [msg({ id: 't1', eventType: 'message', processKind: null, content: 'hi', createdAt: '2026-06-29T00:00:00.000Z' })];
  const items = filterCurrentTurnItems(
    [{ key: 't1', type: 'message', message: all[0] }],
    { sending: false, hideText: true, hideThinking: true, turnStartIndex: 0, allMessages: all },
  );
  assert.equal(items.length, 1);
});
check('发送中 + hideText → 隐藏本回合 message 项', () => {
  const inTurn = msg({ id: 't1', eventType: 'message', processKind: null, content: 'hi' });
  const all = [inTurn];
  const items = filterCurrentTurnItems(
    [{ key: 't1', type: 'message', message: inTurn }],
    { sending: true, hideText: true, hideThinking: false, turnStartIndex: 0, allMessages: all },
  );
  assert.equal(items.length, 0);
});
check('本回合 message 但非 hideText → 保留', () => {
  const inTurn = msg({ id: 't1', eventType: 'message', processKind: null, content: 'hi' });
  const all = [inTurn];
  const items = filterCurrentTurnItems(
    [{ key: 't1', type: 'message', message: inTurn }],
    { sending: true, hideText: false, hideThinking: true, turnStartIndex: 0, allMessages: all },
  );
  assert.equal(items.length, 1);
});
check('非本回合 message → 即使 hideText 也保留（历史不动）', () => {
  const old = msg({ id: 't0', eventType: 'message', processKind: null, content: 'old' });
  const all = [old];
  const items = filterCurrentTurnItems(
    [{ key: 't0', type: 'message', message: old }],
    { sending: true, hideText: true, hideThinking: true, turnStartIndex: 1, allMessages: all },
  );
  assert.equal(items.length, 1);
});
check('fold 内本回合 thinking 被过滤 + stats 重算', () => {
  // fold 含两条 thinking（本回合），发送中 hideThinking → 全过滤后 fold 消失
  const t1 = msg({ id: 't1', eventType: 'thinking', processKind: 'thinking', content: 'think1' });
  const t2 = msg({ id: 't2', eventType: 'thinking', processKind: 'thinking', content: 'think2' });
  const all = [t1, t2];
  const foldItem = { key: 't1', type: 'fold' as const, messages: [t1, t2], stats: { toolCount: 0, thinkingCount: 2, running: false } };
  const items = filterCurrentTurnItems(
    [foldItem],
    { sending: true, hideText: false, hideThinking: true, turnStartIndex: 0, allMessages: all },
  );
  assert.equal(items.length, 0);
});
check('fold 内 thinking 全被过滤但还有 tool_use → fold 保留且 stats 重算', () => {
  const think = msg({ id: 't1', eventType: 'thinking', processKind: 'thinking', content: 'think' });
  const use = msg({ id: 't2', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}' });
  const all = [think, use];
  const foldItem = { key: 't1', type: 'fold' as const, messages: [think, use], stats: { toolCount: 1, thinkingCount: 1, running: true } };
  const items = filterCurrentTurnItems(
    [foldItem],
    { sending: true, hideText: false, hideThinking: true, turnStartIndex: 0, allMessages: all },
  );
  assert.equal(items.length, 1);
  const fold = items[0];
  assert.equal(fold.type, 'fold');
  if (fold.type === 'fold') {
    assert.equal(fold.stats.thinkingCount, 0);
    assert.equal(fold.stats.toolCount, 1);
  }
});

console.log('\n=== aggregateSubAgentGroups：方案 A（仅本回合 + turnStartIndex 切片） ===');
check('只聚合 turnStartIndex 之后的 parentAgentId 消息', () => {
  const all = [
    msg({ id: 'main1', eventType: 'message', processKind: null, content: 'q' }),
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', content: '{}' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 1, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map([['agentA', '调研子任务']]),
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].parentAgentId, 'agentA');
  assert.equal(groups[0].title, '调研子任务');
});
check('turnStartIndex 之前的子 agent 消息不进组（方案 A：保留历史不显示）', () => {
  const all = [
    msg({ id: 'old', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', content: '{}' }),
    msg({ id: 'main1', eventType: 'message', processKind: null, content: 'q' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 1, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups.length, 0);
});
check('durationText 来自耗时计算；无耗时显示「—」', () => {
  const all = [msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}' })];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].durationText, '—');
});
check('running 工具的实时耗时进入 durationText', () => {
  const all = [msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}' })];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: { tu1: 7 }, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].durationText, '7.0s');
  assert.equal(groups[0].running, true);
});

console.log('\n=== startMs / frozenSeconds（问题 6：客户端实时计时基准） ===');
check('startMs = 组内最早 createdAt；frozenSeconds = 耗时计算结果', () => {
  const all = [
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}', createdAt: '2026-06-29T00:00:05.000Z' }),
    msg({ id: 'sa2', parentAgentId: 'agentA', eventType: 'tool_result', processKind: 'tool:Bash', toolUseId: 'tu1', content: 'ok', createdAt: '2026-06-29T00:00:02.000Z' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].startMs, new Date('2026-06-29T00:00:02.000Z').getTime());
  assert.equal(groups[0].frozenSeconds, 3); // 时间戳首尾差 3s
});
check('无效 createdAt → startMs=null', () => {
  const all = [msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}', createdAt: 'not-a-date' })];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].startMs, null);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
