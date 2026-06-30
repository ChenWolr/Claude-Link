// tdd-stall-watchdog-verify.ts
// 卡死看门狗行为测试：纯逻辑 + store 状态 + renderer 映射。
// 运行：npx tsx scripts/tdd-stall-watchdog-verify.ts
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind } from '../src/shared/stall-watchdog';
import { isSubAgentToolUse } from '../src/shared/process-kind';
import type { CliMessageContentPart, CliStalledEvent } from '../src/shared/types/cli';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { applyStalledEvent } from '../src/renderer/composables/use-chat';
import type { Message, Session } from '../src/shared/types/session';

setActivePinia(createPinia());

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

function session(id: string): Session {
  return {
    id,
    name: id,
    cliSessionId: null,
    model: 'sonnet',
    modelOverride: null,
    workingDir: null,
    permissionMode: 'default',
    maxTurns: 0,
    createdAt: '2026-06-30T00:00:00.000Z',
    updatedAt: '2026-06-30T00:00:00.000Z',
    lastContextTokens: null,
    lastContextUpdatedAt: null,
  };
}

function message(id: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'assistant',
    content: 'thinking process',
    rawEvent: null,
    eventType: 'thinking',
    costUsd: null,
    durationMs: null,
    parentTaskId: null,
    processKind: 'thinking',
    parentAgentId: null,
    toolUseId: null,
    title: null,
    isError: false,
    createdAt: '2026-06-30T00:00:00.000Z',
  };
}

function stalled(overrides: Partial<CliStalledEvent> = {}): CliStalledEvent {
  return {
    type: 'stalled',
    sinceMs: 0,
    gapMs: DEFAULT_STALL_THRESHOLDS.modelGapMs,
    lastKind: 'message',
    pendingAgentId: null,
    zone: 'model',
    stallCount: 1,
    ...overrides,
  };
}

console.log('\n=== classifyStall：双区 + 硬中断 ===');
check('MODEL 区到阈值判卡死', () => {
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.modelGapMs, false).stalled, true);
});
check('TOOL 区使用 tool 阈值', () => {
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.modelGapMs, true).stalled, false);
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.toolPendingMs, true).zone, 'tool');
});
check('hardAbort 分 zone：MODEL 用 hardAutoAbortMs，TOOL 用 toolHardAbortMs', () => {
  // MODEL 区到 hardAutoAbortMs 触发；TOOL 区在 hardAutoAbortMs 不触发（未到 toolHardAbortMs）。
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.hardAutoAbortMs, false).hardAbort, true);
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.hardAutoAbortMs, true).hardAbort, false);
  // TOOL 区到 toolHardAbortMs 绝对上限才触发（兜子 Agent 死锁/死连接，合法长工具持续发 tool_progress 不会到这）。
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.toolHardAbortMs, true).hardAbort, true);
  assert.equal(classifyStall(0, DEFAULT_STALL_THRESHOLDS.toolHardAbortMs, true).zone, 'tool');
});

console.log('\n=== keep_alive / api_retry：不算业务活动 ===');
check('keep_alive 不重置业务静默计时', () => {
  assert.equal(isBusinessStallActivityKind('keep_alive'), false);
  assert.equal(isBusinessStallActivityKind('message'), true);
  assert.equal(isBusinessStallActivityKind('stream_event'), true);
});
check('api_retry 不算业务活动（重试是失败不是进展，否则重试风暴永判不出卡死）', () => {
  assert.equal(isBusinessStallActivityKind('api_retry'), false);
});
check('终态/合成事件不算业务活动', () => {
  assert.equal(isBusinessStallActivityKind('stalled'), false);
  assert.equal(isBusinessStallActivityKind('error'), false);
  assert.equal(isBusinessStallActivityKind('aborted'), false);
  assert.equal(isBusinessStallActivityKind('result'), false);
});

console.log('\n=== 子 Agent tool_use 识别 ===');
check('识别 Agent/Task/Workflow/Skill', () => {
  const names = ['Agent', 'Task', 'Workflow', 'Skill'];
  for (const name of names) {
    assert.equal(isSubAgentToolUse({ type: 'tool_use', name, input: {}, id: `toolu_${name}` }), true);
  }
});
check('普通工具和非 tool_use 不识别为子 Agent', () => {
  assert.equal(isSubAgentToolUse({ type: 'tool_use', name: 'Bash', input: {}, id: 'toolu_bash' }), false);
  assert.equal(isSubAgentToolUse({ type: 'text', text: 'hello' } as CliMessageContentPart), false);
});

console.log('\n=== session-store：stalled 只改横幅状态 ===');
check('markStalled 不停止 running、不改消息', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.messages = [message('m1')];
  store.markRunning('s1');
  applyStalledEvent(store, 's1', stalled({ pendingAgentId: 'toolu_agent', zone: 'tool' }));
  assert.equal(store.runningSessions.includes('s1'), true);
  assert.equal(store.messages.length, 1);
  assert.equal(store.activeStalledInfo?.pendingAgentId, 'toolu_agent');
  assert.equal(store.activeStalledInfo?.zone, 'tool');
});
check('clearStalled/markStopped 清理横幅状态', () => {
  const store = useSessionStore();
  store.clearStalled('s1');
  assert.equal(store.stalledInfo['s1'], undefined);
  applyStalledEvent(store, 's1', stalled());
  assert.ok(store.stalledInfo['s1']);
  store.markStopped('s1');
  assert.equal(store.stalledInfo['s1'], undefined);
});
check('后台会话 stalled 可先记录，切回后 getter 显示', () => {
  const store = useSessionStore();
  store.$reset();
  const s1 = session('s1');
  const s2 = session('s2');
  store.activeSession = s1;
  applyStalledEvent(store, 's2', stalled({ pendingAgentId: 'toolu_bg' }));
  assert.equal(store.activeStalledInfo, null);
  store.activeSession = s2;
  assert.equal(store.activeStalledInfo?.pendingAgentId, 'toolu_bg');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
