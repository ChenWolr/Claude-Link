// tdd-subagent-stream-routing-verify.ts
// A1（D05-F1，P1）契约钉：子 Agent 流式 delta 按 parentToolUseID 分流。
//
// 根因：use-chat.ts 的 stream_event 分支仅对 thinking_delta 按 event.parentToolUseId 分流
// （Bug2），text_delta 与 input_json_delta 无条件进主流程累加器（appendStream/appendToolStream）
// ——子 agent 正文污染主流程流式气泡；纯编排回合（turnHadText=false）finalize 时被固化成
// parentAgentId:null 的幻影主流程消息（内存态）；后台分支 handleBackgroundEvent 对子 agent
// delta 同样不设防，切回时经快照灌回主流式累加器。
//
// 修复语义：text_delta 与 thinking 同法路由到「子Agent」Tab 实时快照（appendSubAgentText，
// message 落库后按 agentId 精确清）；input_json_delta 子 agent 增量丢弃（完整 tool_use 随
// message 落库进组，实时入参预览无消费方）；后台快照排除一切带 parentToolUseId 的增量；
// 主流程（无 parentToolUseId）路由不变。
//
// 运行：npx tsx scripts/tdd-subagent-stream-routing-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
import { aggregateSubAgentGroups } from '../src/renderer/utils/subagent-groups';
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

const useChat = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const storeSrc = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
const tqp = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');
const groupsSrc = readFileSync(new URL('../src/renderer/utils/subagent-groups.ts', import.meta.url), 'utf8');

// ── ① 行为：session-store 子 Agent 实时正文累加器（pinia 无头实例）──
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).window = {
  claudeLink: {
    analyzeTopic: async () => null,
    getSessionMessages: async () => [],
  },
};
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

console.log('\n=== ① session-store：appendSubAgentText / clearSubAgentText / activeSubAgentText ===');
check('appendSubAgentText 按 agentId 累加；activeSubAgentText 读活动会话映射', () => {
  const store = useSessionStore();
  store.activeSession = { id: 'sess-A1', name: '会话 A1' } as never;
  store.appendSubAgentText('sess-A1', 'agentX', '你好');
  store.appendSubAgentText('sess-A1', 'agentX', '，世界');
  store.appendSubAgentText('sess-A1', 'agentY', '另一组');
  assert.equal(store.activeSubAgentText['agentX'], '你好，世界');
  assert.equal(store.activeSubAgentText['agentY'], '另一组');
});
check('clearSubAgentText(agentId) 单清；其余 agent 不受影响', () => {
  const store = useSessionStore();
  store.activeSession = { id: 'sess-A2', name: '会话 A2' } as never;
  store.appendSubAgentText('sess-A2', 'agentX2', 'tail');
  store.appendSubAgentText('sess-A2', 'agentY2', 'keep');
  store.clearSubAgentText('sess-A2', 'agentX2');
  assert.equal(store.activeSubAgentText['agentX2'], undefined);
  assert.equal(store.activeSubAgentText['agentY2'], 'keep');
});
check('clearSubAgentText() 全清该会话；其他会话映射隔离', () => {
  const store = useSessionStore();
  store.activeSession = { id: 'sess-A3', name: '会话 A3' } as never;
  store.appendSubAgentText('sess-A3', 'agentX3', 'a');
  store.appendSubAgentText('sess-B3', 'agentX3', 'b');
  store.clearSubAgentText('sess-A3');
  assert.deepEqual(store.activeSubAgentText, {});
  assert.equal(store.subAgentStreamingText['sess-B3']['agentX3'], 'b');
});

console.log('\n=== ② session-store：终态清理连带清实时正文（与 thinking 同清理点） ===');
check('markCompleted / markStopped / markNetworkInterrupted 清 subAgentStreamingText', () => {
  const store = useSessionStore();
  store.appendSubAgentText('sess-C', 'agentX', '残留');
  store.markCompleted('sess-C');
  assert.equal(store.subAgentStreamingText['sess-C'], undefined, 'markCompleted 后应清空');
  store.appendSubAgentText('sess-C', 'agentX', '残留');
  store.markStopped('sess-C');
  assert.equal(store.subAgentStreamingText['sess-C'], undefined, 'markStopped 后应清空');
  store.appendSubAgentText('sess-C', 'agentX', '残留');
  store.markNetworkInterrupted('sess-C');
  assert.equal(store.subAgentStreamingText['sess-C'], undefined, 'markNetworkInterrupted 后应清空');
});
check('deleteSession 清理点含 subAgentStreamingText[id]（结构断言，避免幽灵复活）', () => {
  assert.ok(storeSrc.includes('delete this.subAgentStreamingText[id];'), 'deleteSession 清理缺 subAgentStreamingText');
});
check('四处终态清理点均与 thinking 成对出现（markCompleted/markNetworkInterrupted/markStopped + deleteSession）', () => {
  const thinkCount = (storeSrc.match(/delete this\.subAgentStreamingThinking\[/g) || []).length;
  const textCount = (storeSrc.match(/delete this\.subAgentStreamingText\[id\]|delete this\.subAgentStreamingText\[sessionId\]/g) || []).length;
  assert.equal(textCount, thinkCount, `thinking 清理 ${thinkCount} 处 vs text 清理 ${textCount} 处`);
});

console.log('\n=== ③ subagent-groups：liveTextByAgent 预建组（与 liveThinkingByAgent 同法） ===');
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
check('仅有 live 正文、尚无落库消息的子 agent 预建空组', () => {
  const groups = aggregateSubAgentGroups([], {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
    liveTextByAgent: { agentT: '正在输出…' },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].parentAgentId, 'agentT');
  assert.equal(groups[0].running, true);
});
check('live text 与 live thinking 并存时归入同一组（不重复建组）', () => {
  const groups = aggregateSubAgentGroups([], {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
    liveThinkingByAgent: { agentT: '想' },
    liveTextByAgent: { agentT: '写' },
  });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].parentAgentId, 'agentT');
});
check('不传 liveTextByAgent 时行为与现状一致（可选参数向后兼容）', () => {
  const groups = aggregateSubAgentGroups([], {
    turnStartIndex: 0, sending: true, hideText: false, hideThinking: false,
    toolProgress: {}, titleByToolUseId: new Map(),
    liveThinkingByAgent: { agentT: '想' },
  });
  assert.equal(groups.length, 1);
});

console.log('\n=== ④ use-chat：前台 stream_event 分流形态（handleCliEvent） ===');
const cliIdx = useChat.indexOf('function handleCliEvent');
const cliBody = useChat.slice(cliIdx, useChat.indexOf('function persistSystemEvent'));
check('text_delta 带 parentToolUseId → appendSubAgentText（与 thinking 分流同法）', () => {
  assert.match(cliBody, /if \(event\.parentToolUseId && store\.activeSession\) \{\s*store\.appendSubAgentText\(store\.activeSession\.id, event\.parentToolUseId, delta\.text\);/, 'text_delta 缺子 agent 分流');
});
check('text_delta 主流程（无 parentToolUseId）仍走 appendStream', () => {
  const textBranch = cliBody.slice(cliBody.indexOf('} else if (delta.text) {'));
  assert.match(textBranch, /store\.appendStream\(delta\.text\);/, '主流程正文分支缺失');
});
check('input_json_delta 带 parentToolUseId 不进主流程 streamingTool', () => {
  const jsonIdx = cliBody.indexOf("delta.type === 'input_json_delta'");
  const jsonEnd = cliBody.indexOf('} else if (delta.text) {', jsonIdx);
  const jsonBranch = cliBody.slice(jsonIdx, jsonEnd);
  assert.match(jsonBranch, /!event\.parentToolUseId && delta\.partial_json/, 'input_json_delta 缺 parentToolUseId 排除守卫');
});
check('appendSubAgentText 调用与 appendStream 互斥（else 链）', () => {
  const textIdx = cliBody.indexOf('} else if (delta.text) {');
  const textBranch = cliBody.slice(textIdx, cliBody.indexOf('break;', textIdx));
  const subIdx = textBranch.indexOf('store.appendSubAgentText');
  const mainIdx = textBranch.indexOf('store.appendStream');
  const elseIdx = textBranch.indexOf('} else {', subIdx);
  assert.ok(subIdx > -1 && mainIdx > subIdx && elseIdx > subIdx && elseIdx < mainIdx, '分流不在 if/else 互斥结构内');
});

console.log('\n=== ⑤ use-chat：后台 stream_event 排除子 agent delta（快照灌回防线） ===');
const bgIdx = useChat.indexOf('function handleBackgroundEvent');
const bgBody = useChat.slice(bgIdx, useChat.indexOf('function handleCliEvent'));
check('后台 stream_event case 带 parentToolUseId 直接丢弃（不进 appendBackgroundStream）', () => {
  const seIdx = bgBody.indexOf("case 'stream_event':");
  const seEnd = bgBody.indexOf("case 'stalled':", seIdx);
  const seBranch = bgBody.slice(seIdx, seEnd);
  const guardIdx = seBranch.indexOf('if (event.parentToolUseId) break;');
  const bgAppendIdx = seBranch.indexOf('appendBackgroundStream');
  assert.ok(guardIdx > -1, '后台 stream_event 缺 parentToolUseId 丢弃守卫');
  assert.ok(bgAppendIdx > guardIdx, '丢弃守卫必须先于 appendBackgroundStream');
});

console.log('\n=== ⑥ use-chat：message 落库清该 agent 实时思考/正文（回落到落库气泡） ===');
check('message 分支 clearSubAgentThinking 与 clearSubAgentText 并现（同 agentId）', () => {
  const msgIdx = useChat.indexOf('function handleCliEvent');
  const body = useChat.slice(msgIdx, useChat.indexOf('function finalizeAssistantStream'));
  assert.match(body, /store\.clearSubAgentThinking\(store\.activeSession\.id, agentId\);\s*store\.clearSubAgentText\(store\.activeSession\.id, agentId\);/, 'message 到达缺实时正文清理');
});

console.log('\n=== ⑦ TaskQueuePanel：子 Agent Tab 渲染实时正文 ===');
check('subAgentLiveText 接 activeSubAgentText；分组传 liveTextByAgent', () => {
  assert.match(tqp, /function subAgentLiveText\(agentId: string\): string \{\s*return sessionStore\.activeSubAgentText\[agentId\] \?\? '';/, '缺 subAgentLiveText 接线');
  assert.match(tqp, /liveTextByAgent: sessionStore\.activeSubAgentText,/, '分组缺 liveTextByAgent 传参');
});
check('组体内渲染实时正文节点（markdown 渲染 + v-enrich）', () => {
  assert.match(tqp, /class="subagent-live-text markdown-body"/, '缺实时正文渲染节点');
  assert.match(tqp, /v-html="renderMarkdown\(subAgentLiveText\(g\.parentAgentId\)\)"/, '实时正文未走 markdown 渲染');
  assert.match(tqp, /enrichMarkdown as vEnrich|const vEnrich = enrichMarkdown/, '缺 v-enrich 指令注册');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
