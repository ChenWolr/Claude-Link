// tdd-subagent-verify.ts
// T08/T10 行为测试：子 Agent Tab 的纯聚合/过滤/耗时逻辑（subagent-groups.ts）。
// 项目无 jest/vitest，沿用 tdd-*-verify.ts 的 node:assert + 自统计模式。
// 运行：npx tsx scripts/tdd-subagent-verify.ts
import { readFileSync } from 'node:fs';
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
import { computeStats } from '../src/renderer/utils/group-messages';
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

console.log('\n=== completed / 逐组完成（问题 4：按自身完成冻结，非主回合结束）===');
check('父 Task tool_result 到达 → completed=true，frozenSeconds=完成跨度，running 立即停', () => {
  // 子 Agent 首条消息 00:00；父 Task 工具 tool_result（主流程，toolUseId === parentAgentId）于 00:03 完成。
  const all = [
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tuInner', content: '{}', createdAt: '2026-06-29T00:00:00.000Z' }),
    msg({ id: 'pr1', eventType: 'tool_result', processKind: 'tool:Agent', toolUseId: 'agentA', content: 'done', createdAt: '2026-06-29T00:00:03.000Z' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].completed, true);
  assert.equal(groups[0].frozenSeconds, 3); // 完成 tool_result.createdAt − startMs（真实跨度）
  assert.equal(groups[0].running, false);   // 已完成即停，即使主回合 sending=true
});
check('未到达父 tool_result → completed=false，running 随主回合 sending', () => {
  const all = [
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tuInner', content: '{}', createdAt: '2026-06-29T00:00:00.000Z' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].completed, false);
  assert.equal(groups[0].running, true);
});
check('子 Agent 内部工具结果（toolUseId ≠ parentAgentId）不算完成', () => {
  // 内部 tool_result 的 toolUseId 是 tuInner，不等于 agentA → 不触发完成。
  const all = [
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tuInner', content: '{}' }),
    msg({ id: 'sa2', parentAgentId: 'agentA', eventType: 'tool_result', processKind: 'tool:Bash', toolUseId: 'tuInner', content: 'ok' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].completed, false);
  assert.equal(groups[0].running, true);
});
check('历史 turn 的同名 tool_result 不会误标当前子 Agent 完成', () => {
  const all = [
    msg({ id: 'old_done', eventType: 'tool_result', processKind: 'tool:Agent', toolUseId: 'agentA', content: 'old', createdAt: '2026-06-29T00:00:01.000Z' }),
    msg({ id: 'main', eventType: 'message', processKind: null, content: 'new turn' }),
    msg({ id: 'sa1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tuInner', content: '{}', createdAt: '2026-06-29T00:01:00.000Z' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 2, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
  });
  assert.equal(groups[0].completed, false);
  assert.equal(groups[0].running, true);
});

console.log('\n=== 计时展示契约 ===');
check('TaskQueuePanel 只保留一处子Agent耗时文本', () => {
  const tqp = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');
  assert.equal(tqp.includes('subagent-group__meta'), false);
  assert.equal(tqp.includes('subAgentDurationText(g)'), true);
});
check('TaskQueuePanel 未完成组不误显示「已完成」', () => {
  const tqp = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');
  assert.equal(tqp.includes('subAgentStatusText(g)'), true);
  assert.equal(tqp.includes("g.completed ? '已完成' : '未完成'"), true);
});
check('子Agent 正文/总结气泡在右侧栏内横向撑满', () => {
  const tqp = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');
  assert.match(tqp, /\.subagent-group__body\s+:deep\(\.bubble\)\s*\{[^}]*width:\s*100%;[^}]*align-self:\s*stretch;/s);
});

console.log('\n=== computeStats 工具统计边界（问题：联网搜索/无结果工具是否计入） ===');
check('多次联网搜索（WebSearch tool_use）全部计入 toolCount', () => {
  // 用户场景：一轮 5-6 次联网搜索，统计不应少算。
  const ms = [
    msg({ id: 'w1', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'w2', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu2', content: '{}' }),
    msg({ id: 'w3', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu3', content: '{}' }),
    msg({ id: 'w4', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu4', content: '{}' }),
    msg({ id: 'w5', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu5', content: '{}' }),
  ];
  assert.equal(computeStats(ms).toolCount, 5);
});
check('服务端工具（server_tool_use 落库 eventType=tool_use）计入 toolCount', () => {
  // server_tool_use 在 handleMessagePartsFull 落库为 eventType 'tool_use'，须计入。
  const ms = [
    msg({ id: 's1', eventType: 'tool_use', processKind: 'tool:web_search', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 's2', eventType: 'tool_use', processKind: 'tool:web_fetch', toolUseId: 'tu2', content: '{}' }),
  ];
  assert.equal(computeStats(ms).toolCount, 2);
});
check('tool_result 不重复计入 toolCount', () => {
  // 1 个 tool_use + 1 个配对 tool_result → toolCount 仍为 1（只数调用，不数结果）。
  const ms = [
    msg({ id: 'u1', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'r1', eventType: 'tool_result', processKind: 'tool:result', toolUseId: 'tu1', content: 'ok' }),
  ];
  assert.equal(computeStats(ms).toolCount, 1);
});
check('无结果工具（tool_use 无配对 tool_result）计入 toolCount 且 running=true', () => {
  // 用户担心「子任务工具不显示等待结果」：即便无结果，调用本身也要计数并标进行中。
  const ms = [
    msg({ id: 'u1', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'u2', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu2', content: '{}' }),
  ];
  const stats = computeStats(ms);
  assert.equal(stats.toolCount, 2);
  assert.equal(stats.running, true);
});
check('全部配对结果 → running=false', () => {
  const ms = [
    msg({ id: 'u1', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'r1', eventType: 'tool_result', processKind: 'tool:result', toolUseId: 'tu1', content: 'ok' }),
  ];
  assert.equal(computeStats(ms).running, false);
});
check('混合思考 + 工具（含联网搜索）计数互不干扰', () => {
  // 子 Agent 常见形态：1 思考 + 4 工具（其中联网搜索）→ toolCount=4, thinkingCount=1。
  const ms = [
    msg({ id: 't1', eventType: 'thinking', processKind: 'thinking', content: '想' }),
    msg({ id: 'u1', eventType: 'tool_use', processKind: 'tool:Read', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'u2', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu2', content: '{}' }),
    msg({ id: 'u3', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu3', content: '{}' }),
    msg({ id: 'u4', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu4', content: '{}' }),
  ];
  const stats = computeStats(ms);
  assert.equal(stats.toolCount, 4);
  assert.equal(stats.thinkingCount, 1);
});
check('子 Agent 内工具聚合到对应组且计数正确', () => {
  // 主流程 + 两个子 Agent（agentA 3 工具、agentB 2 工具），各组独立计数不串扰。
  const all = [
    msg({ id: 'main_u', eventType: 'tool_use', processKind: 'tool:Agent', toolUseId: 'agentA', content: '{}' }),
    msg({ id: 'a1', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu1', content: '{}' }),
    msg({ id: 'a2', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:WebSearch', toolUseId: 'tu2', content: '{}' }),
    msg({ id: 'a3', parentAgentId: 'agentA', eventType: 'tool_use', processKind: 'tool:Read', toolUseId: 'tu3', content: '{}' }),
    msg({ id: 'b1', parentAgentId: 'agentB', eventType: 'tool_use', processKind: 'tool:Bash', toolUseId: 'tu4', content: '{}' }),
    msg({ id: 'b2', parentAgentId: 'agentB', eventType: 'tool_use', processKind: 'tool:Grep', toolUseId: 'tu5', content: '{}' }),
  ];
  const groups = aggregateSubAgentGroups(all, {
    turnStartIndex: 0, sending: false, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map([['agentA', '调研'], ['agentB', '实现']]),
  });
  assert.equal(groups.length, 2);
  const a = groups.find((g) => g.parentAgentId === 'agentA')!;
  const b = groups.find((g) => g.parentAgentId === 'agentB')!;
  // 每组的 fold stats 应正确反映组内工具数。
  const aFold = a.items.find((it) => it.type === 'fold');
  const bFold = b.items.find((it) => it.type === 'fold');
  assert.ok(aFold && aFold.type === 'fold' && aFold.stats.toolCount === 3, `agentA toolCount=${aFold && aFold.type === 'fold' ? aFold.stats.toolCount : '?'}`);
  assert.ok(bFold && bFold.type === 'fold' && bFold.stats.toolCount === 2, `agentB toolCount=${bFold && bFold.type === 'fold' ? bFold.stats.toolCount : '?'}`);
});

console.log('\n=== 工具结果落库根因（问题 6：SDK user 消息转发 + tool_use 主键取 id）===');
check('cli-shared tool_use 主键取 part.id（兼容 tool_use_id）', () => {
  const cs = readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');
  // Anthropic ToolUseBlock 主键是 id（非 tool_use_id）；落库必须优先取 part.id。
  assert.equal(cs.includes('part.id ?? part.tool_use_id'), true);
});
check('server_tool_use 同样兼容 tool_use_id 兜底', () => {
  const cs = readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');
  const uc = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  assert.equal(cs.includes('标准 server_tool_use 主键是 id；兼容少数代理端点用 tool_use_id'), true);
  assert.equal(uc.includes('标准 server_tool_use 主键是 id；兼容少数代理端点用 tool_use_id'), true);
});
check('use-chat tool_use 主键取 part.id（渲染层镜像同修）', () => {
  const uc = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  assert.equal(uc.includes('part.id ?? part.tool_use_id'), true);
});
check('sdk-backend 转发泛化 *_tool_result 的 user 消息（不再整类丢弃）', () => {
  const sb = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  assert.equal(sb.includes("type === 'user'"), true);
  assert.equal(sb.includes("part.type === 'tool_result' || part.type.endsWith('_tool_result')"), true);
  assert.equal(sb.includes('cliEvent.content.filter(isToolResultPart)'), true);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
