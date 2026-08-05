// tdd-stall-watchdog-verify.ts
// 卡死看门狗行为测试：纯逻辑 + store 状态 + renderer 映射。
// 运行：npx tsx scripts/tdd-stall-watchdog-verify.ts
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { classifyStall, DEFAULT_STALL_THRESHOLDS, isBusinessStallActivityKind } from '../src/shared/stall-watchdog';
import {
  apiRetryErrorLabel,
  apiRetrySummary,
  createApiRetryState,
  recordApiRetry,
  recordApiRetryExhausted,
  recordApiRetryRecovery,
  recordApiRetryUserStop,
  toApiRetryTerminalDetails,
  type ApiRetryState,
} from '../src/shared/api-retry-state';
import { isSubAgentToolUse } from '../src/shared/process-kind';
import type { CliApiRetryTerminalFallbackEvent, CliMessageContentPart, CliStalledEvent, CliSystemInfoEvent } from '../src/shared/types/cli';
import { useSessionStore } from '../src/renderer/stores/session-store';
import {
  applyApiRetryEvent,
  applyApiRetryTerminalFallbackEvent,
  applyPersistedMessageEvent,
  applyStalledEvent,
} from '../src/renderer/composables/use-chat';
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
    lastContextWindow: null,
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

console.log('\n=== API retry：权威状态机 ===');

function retryState(limit = 10): ApiRetryState {
  return createApiRetryState(limit);
}

check('初始状态为空闲且没有重试或终态', () => {
  assert.deepEqual(retryState(), {
    phase: 'idle',
    retryCount: 0,
    retryLimit: 10,
    startedAt: null,
    lastRetryAt: null,
    nextRetryAt: null,
    accumulatedDelayMs: 0,
    lastError: null,
    lastErrorStatus: null,
    terminalKind: null,
    endedAt: null,
  });
});

check('SDK 第 1～10 次 retryAttempt 都保持 retrying，第 10 次仍保留下一次重试排期', () => {
  let state = retryState();
  for (let i = 1; i <= 10; i += 1) {
    const result = recordApiRetry(state, {
      now: i * 1_000,
      retryAttempt: i,
      retryDelayMs: 2_000,
      error: 'server_error',
      errorStatus: 529,
    });
    state = result.state;
    assert.equal(state.phase, 'retrying');
    assert.equal(state.retryCount, i);
    assert.equal(state.nextRetryAt, i * 1_000 + 2_000);
    assert.equal(state.terminalKind, null);
    assert.equal(state.endedAt, null);
    assert.equal(result.becameExhausted, false);
  }
});

check('最终错误确认后才耗尽，二次确认幂等', () => {
  const retrying = recordApiRetry(retryState(), {
    now: 10_000,
    retryAttempt: 10,
    retryDelayMs: 2_000,
  }).state;
  const exhausted = recordApiRetryExhausted(retrying, 11_000);
  assert.equal(exhausted.becameExhausted, true);
  assert.equal(exhausted.state.phase, 'terminal');
  assert.equal(exhausted.state.terminalKind, 'exhausted');
  assert.equal(exhausted.state.retryCount, 10);
  assert.equal(exhausted.state.nextRetryAt, null);
  assert.equal(exhausted.state.endedAt, 11_000);
  const repeated = recordApiRetryExhausted(exhausted.state, 12_000);
  assert.equal(repeated.becameExhausted, false);
  assert.strictEqual(repeated.state, exhausted.state);
});

check('SDK retryAttempt 可跳号投影，无效或缺失时回退为递增计数', () => {
  const jumped = recordApiRetry(retryState(), {
    now: 1_000,
    retryAttempt: 7,
    retryDelayMs: 2_000,
  }).state;
  assert.equal(jumped.retryCount, 7);
  const invalid = recordApiRetry(jumped, { now: 2_000, retryAttempt: 0 }).state;
  assert.equal(invalid.retryCount, 8);
  const missing = recordApiRetry(invalid, { now: 3_000 }).state;
  assert.equal(missing.retryCount, 9);
  const fractional = recordApiRetry(missing, { now: 4_000, retryAttempt: 9.5 }).state;
  assert.equal(fractional.retryCount, 10);
});

check('SDK retryLimit 覆盖本地默认并同时决定计数钳制与最终耗尽', () => {
  const smaller = recordApiRetry(retryState(10), {
    now: 1_000,
    retryAttempt: 3,
    retryLimit: 3,
  }).state;
  assert.equal(smaller.retryCount, 3);
  assert.equal(smaller.retryLimit, 3);
  assert.equal(recordApiRetryExhausted(smaller, 2_000).becameExhausted, true);

  const larger = recordApiRetry(retryState(10), {
    now: 1_000,
    retryAttempt: 20,
    retryLimit: 20,
  }).state;
  assert.equal(larger.retryCount, 20);
  assert.equal(larger.retryLimit, 20);
  assert.equal(recordApiRetryExhausted(larger, 2_000).becameExhausted, true);
});

check('真实模型活动恢复一次，普通 idle 不产生恢复', () => {
  const idle = retryState();
  const idleRecovery = recordApiRetryRecovery(idle, 500);
  assert.equal(idleRecovery.becameRecovered, false);
  assert.strictEqual(idleRecovery.state, idle);
  assert.equal(idleRecovery.terminalState, null);

  const retrying = recordApiRetry(idle, {
    now: 1_000,
    retryDelayMs: 3_000,
    error: 'overloaded',
    errorStatus: 529,
  }).state;
  const recovered = recordApiRetryRecovery(retrying, 2_500);
  assert.equal(recovered.becameRecovered, true);
  assert.notStrictEqual(recovered.terminalState, recovered.state);
  assert.equal(recovered.terminalState?.phase, 'terminal');
  assert.equal(recovered.terminalState?.terminalKind, 'recovered');
  assert.equal(recovered.terminalState?.retryCount, 1);
  assert.equal(recovered.terminalState?.endedAt, 2_500);
  assert.equal(recovered.state.phase, 'idle');
  assert.equal(recovered.state.retryCount, 0);
  assert.equal(recovered.state.terminalKind, null);

  const nextEpisode = recordApiRetry(recovered.state, { now: 3_000, retryDelayMs: 1_000 });
  assert.equal(nextEpisode.state.phase, 'retrying');
  assert.equal(nextEpisode.state.retryCount, 1);
  assert.equal(nextEpisode.becameExhausted, false);
});

check('用户停止只在 retrying 生效', () => {
  const idle = retryState();
  const idleStop = recordApiRetryUserStop(idle, 500);
  assert.equal(idleStop.becameStopped, false);
  assert.strictEqual(idleStop.state, idle);

  const retrying = recordApiRetry(idle, {
    now: 1_000,
    retryDelayMs: undefined,
    error: undefined,
    errorStatus: null,
  }).state;
  const stopped = recordApiRetryUserStop(retrying, 1_500);
  assert.equal(stopped.becameStopped, true);
  assert.equal(stopped.state.phase, 'terminal');
  assert.equal(stopped.state.terminalKind, 'user_stopped');
  assert.equal(stopped.state.endedAt, 1_500);
});

check('停止/耗尽终态幂等，恢复后允许同一 Query 开启新 retry episode', () => {
  const retrying = recordApiRetry(retryState(), { now: 1_000, retryDelayMs: 2_000 }).state;
  const recoveredTerminal = recordApiRetryRecovery(retrying, 1_500).terminalState;
  assert.ok(recoveredTerminal);
  const recoveredNext = recordApiRetry(createApiRetryState(retrying.retryLimit), {
    now: 2_000,
    retryDelayMs: 1_000,
  });
  assert.equal(recoveredNext.state.phase, 'retrying');
  assert.equal(recoveredNext.state.retryCount, 1);
  assert.equal(recoveredNext.becameExhausted, false);
  const terminals = [
    recordApiRetryUserStop(retrying, 1_500).state,
    recordApiRetryExhausted(
      recordApiRetry(retryState(1), { now: 1_000, retryDelayMs: 2_000 }).state,
      1_500,
    ).state,
  ];

  for (const terminal of terminals) {
    const lateRetry = recordApiRetry(terminal, { now: 2_000, retryDelayMs: 4_000 });
    const lateRecovery = recordApiRetryRecovery(terminal, 2_500);
    const lateStop = recordApiRetryUserStop(terminal, 3_000);
    assert.strictEqual(lateRetry.state, terminal);
    assert.equal(lateRetry.becameExhausted, false);
    assert.equal(lateRetry.state.phase, 'terminal', 'v2-F2：terminal 后迟到 retry 必须保持 terminal（主进程据此丢弃）');
    assert.strictEqual(lateRecovery.state, terminal);
    assert.equal(lateRecovery.terminalState, null);
    assert.equal(lateRecovery.becameRecovered, false);
    assert.strictEqual(lateStop.state, terminal);
    assert.equal(lateStop.becameStopped, false);
  }
});

check('竞态：显式耗尽后迟到 recovery 不覆盖 exhausted 终态', () => {
  const exhausted = recordApiRetryExhausted(
    recordApiRetry(retryState(1), {
      now: 1_000,
      retryDelayMs: 2_000,
      error: 'overloaded',
      errorStatus: 529,
    }).state,
    1_500,
  ).state;
  const lateRecovery = recordApiRetryRecovery(exhausted, 2_000);
  assert.strictEqual(lateRecovery.state, exhausted);
  assert.equal(lateRecovery.state.terminalKind, 'exhausted');
  assert.equal(lateRecovery.state.endedAt, 1_500);
  assert.equal(lateRecovery.terminalState, null);
  assert.equal(lateRecovery.becameRecovered, false);
});

check('竞态：用户停止后迟到 retry 不增加次数', () => {
  const retrying = recordApiRetry(retryState(), {
    now: 1_000,
    retryDelayMs: 2_000,
    error: 'rate_limit',
    errorStatus: 429,
  }).state;
  const stopped = recordApiRetryUserStop(retrying, 1_500).state;
  const lateRetry = recordApiRetry(stopped, {
    now: 2_000,
    retryDelayMs: 4_000,
    error: 'overloaded',
    errorStatus: 529,
  });
  assert.strictEqual(lateRetry.state, stopped);
  assert.equal(lateRetry.state.terminalKind, 'user_stopped');
  assert.equal(lateRetry.state.retryCount, 1);
  assert.equal(lateRetry.becameExhausted, false);
});

check('缺失字段不阻塞计数，负延迟不累计，正延迟持续累计', () => {
  const first = recordApiRetry(retryState(), {
    now: 1_000,
    retryDelayMs: -1,
    error: undefined,
    errorStatus: undefined,
  }).state;
  assert.equal(first.retryCount, 1);
  assert.equal(first.accumulatedDelayMs, 0);
  assert.equal(first.nextRetryAt, null);
  assert.equal(first.lastError, null);
  assert.equal(first.lastErrorStatus, null);

  const second = recordApiRetry(first, {
    now: 2_000,
    retryDelayMs: 4_000,
    error: 'rate_limit',
    errorStatus: 429,
  }).state;
  const third = recordApiRetry(second, {
    now: 7_000,
    retryDelayMs: 1_500,
  }).state;
  assert.equal(third.accumulatedDelayMs, 5_500);
  assert.equal(third.nextRetryAt, 8_500);
  assert.equal(third.lastError, 'rate_limit');
  assert.equal(third.lastErrorStatus, 429);
});

check('errorStatus 的 null 清除旧状态，undefined 保留旧状态', () => {
  const withStatus = recordApiRetry(retryState(), {
    now: 1_000,
    errorStatus: 529,
  }).state;
  const clearedStatus = recordApiRetry(withStatus, {
    now: 2_000,
    errorStatus: null,
  }).state;
  assert.equal(clearedStatus.lastErrorStatus, null);

  const preservedStatus = recordApiRetry(withStatus, {
    now: 2_000,
    errorStatus: undefined,
  }).state;
  assert.equal(preservedStatus.lastErrorStatus, 529);
});

check('终态详情、摘要和错误标签保持稳定', () => {
  const retrying = recordApiRetry(retryState(), {
    now: 1_000,
    retryDelayMs: 2_000,
    error: 'rate_limit',
    errorStatus: 429,
  }).state;
  assert.equal(toApiRetryTerminalDetails(retrying), null);
  const recovered = recordApiRetryRecovery(retrying, 4_000).terminalState;
  assert.ok(recovered);
  assert.deepEqual(toApiRetryTerminalDetails(recovered), {
    version: 1,
    kind: 'recovered',
    retryCount: 1,
    retryLimit: 10,
    startedAt: 1_000,
    endedAt: 4_000,
    elapsedMs: 3_000,
    accumulatedDelayMs: 2_000,
    lastError: 'rate_limit',
    lastErrorStatus: 429,
    currentReplyOnly: true,
  });
  assert.equal(apiRetrySummary('recovered', 1), '上游服务已恢复，共自动重试 1 次，正在继续生成回复。');
  assert.equal(apiRetrySummary('user_stopped', 2), '上游服务连接异常，用户在第 2 次重试后停止了本次回复。');
  assert.equal(apiRetrySummary('exhausted', 10), '上游服务连续重试 10 次仍不可用，本次回复已停止。');
  assert.equal(apiRetryErrorLabel('rate_limit'), '请求受限');
  assert.equal(apiRetryErrorLabel('unknown'), '连接异常');
  assert.equal(apiRetryErrorLabel(undefined), '连接异常');
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

console.log('\n=== session-store / renderer：API retry 权威投影 ===');

function apiRetryEvent(overrides: Partial<CliSystemInfoEvent> = {}): CliSystemInfoEvent {
  return {
    type: 'system',
    subtype: 'api_retry',
    retryCount: 1,
    retryLimit: 10,
    nextRetryAt: 5_000,
    retryDelayMs: 2_000,
    errorStatus: 529,
    error: 'overloaded',
    ...overrides,
  };
}

check('applyApiRetryEvent 直接采用权威 count，7 后收到 3 显示 3', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1'); // retry 事件属于运行中回合（v2-F2 守卫要求）
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 7 }));
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 3, retryDelayMs: 1_000 }));
  assert.equal(store.activeApiRetryInfo?.retryCount, 3);
  assert.equal(store.activeApiRetryInfo?.retryLimit, 10);
  assert.equal(store.activeApiRetryInfo?.retryDelayMs, 1_000);
});

check('后台 session 的 retry 状态与前台隔离，切回后 getter 显示', () => {
  const store = useSessionStore();
  store.$reset();
  const s1 = session('s1');
  const s2 = session('s2');
  store.activeSession = s1;
  store.markRunning('s1');
  store.markRunning('s2');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  applyApiRetryEvent(store, 's2', apiRetryEvent({ retryCount: 6, error: 'rate_limit' }));
  assert.equal(store.activeApiRetryInfo?.retryCount, 2);
  assert.equal(store.apiRetryInfo['s2']?.retryCount, 6);
  store.activeSession = s2;
  assert.equal(store.activeApiRetryInfo?.retryCount, 6);
  assert.equal(store.activeApiRetryInfo?.error, 'rate_limit');
});

check('persisted_message exhausted 按 id 幂等插入当前会话、清 retry 并进入常红', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 10 }));
  const persisted = {
    ...message('retry-terminal'),
    sessionId: 's1',
    role: 'system' as const,
    processKind: 'system:api_retry_exhausted',
  };
  applyPersistedMessageEvent(store, 's1', persisted);
  applyPersistedMessageEvent(store, 's1', { ...persisted, content: 'updated terminal' });
  assert.equal(store.messages.filter((item) => item.id === persisted.id).length, 1);
  assert.equal(store.messages.find((item) => item.id === persisted.id)?.content, 'updated terminal');
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
  assert.equal(store.sessionStatus['s1'], 'network_interrupted', 'exhausted 必须进入常红');
  assert.equal(store.sessionDisplayStatus('s1'), 'network_interrupted');
});

check('persisted_message recovered 与 user_stopped 都清 retry，recovered 继续 running、stopped 回 idle', () => {
  for (const processKind of ['system:api_retry_recovered', 'system:api_retry_stopped'] as const) {
    const store = useSessionStore();
    store.$reset();
    store.activeSession = session('s1');
    store.markRunning('s1');
    applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 3 }));
    applyPersistedMessageEvent(store, 's1', {
      ...message(`terminal-${processKind}`),
      sessionId: 's1',
      role: 'system' as const,
      processKind,
    });
    assert.equal(store.apiRetryInfo['s1'], undefined);
    assert.equal(store.runningSessions.includes('s1'), processKind === 'system:api_retry_recovered');
    // recovered 不是完成：基础状态仍是 running（黄闪）；user_stopped 回 idle（不常红）。
    if (processKind === 'system:api_retry_recovered') {
      assert.equal(store.sessionStatus['s1'], 'running');
      assert.equal(store.sessionDisplayStatus('s1'), 'running');
    } else {
      assert.equal(store.sessionStatus['s1'], undefined);
    }
  }
});

check('普通 persisted_message 不清除进行中的 API retry', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 3 }));
  applyPersistedMessageEvent(store, 's1', {
    ...message('ordinary-system'),
    sessionId: 's1',
    role: 'system' as const,
    processKind: 'system:informational',
  });
  assert.equal(store.apiRetryInfo['s1']?.retryCount, 3);
  assert.equal(store.runningSessions.includes('s1'), true);
});

function apiRetryTerminalFallbackEvent(
  kind: CliApiRetryTerminalFallbackEvent['kind'],
): CliApiRetryTerminalFallbackEvent {
  return {
    type: 'api_retry_terminal',
    kind,
    summary: `terminal:${kind}`,
    details: {
      version: 1,
      kind,
      retryCount: kind === 'exhausted' ? 10 : 2,
      retryLimit: 10,
      startedAt: 1_000,
      endedAt: 4_000,
      elapsedMs: 3_000,
      accumulatedDelayMs: 2_000,
      lastError: 'overloaded',
      lastErrorStatus: 529,
      currentReplyOnly: true,
    },
    persisted: false,
  };
}

check('api_retry_terminal fallback exhausted 保留兜底并进入常红（与 persisted 路径同义）', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 10 }));
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('exhausted'));
  assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'exhausted');
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
  assert.equal(store.sessionStatus['s1'], 'network_interrupted', 'fallback exhausted 必须常红');
});

check('api_retry_terminal fallback recovered 保留兜底但不停止回合（回黄闪）', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('recovered'));
  assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'recovered');
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), true);
  assert.equal(store.sessionStatus['s1'], 'running', 'fallback recovered 继续 running');
});

check('api_retry_terminal fallback user_stopped 保留兜底并停止当前回合（回 idle）', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('user_stopped'));
  assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'user_stopped');
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
  assert.equal(store.sessionStatus['s1'], undefined, 'fallback user_stopped 回 idle 不常红');
});

check('exhausted 常红抗迟到：markStopped 不清、markRunning 回黄灯', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 10 }));
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('exhausted'));
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
  // exhausted 后迟到的失败 result / error / aborted / 中断 finally 都走 markStopped。
  store.markStopped('s1');
  assert.equal(store.sessionStatus['s1'], 'network_interrupted', '迟到 markStopped 不得清常红');
  // 下一次新回合 markRunning 清除常红回黄灯。
  store.markRunning('s1');
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.sessionDisplayStatus('s1'), 'running');
});

check('停止 IPC 失败时可显式清除保留的 retry 状态', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('s1');
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  store.markApiRetryStopping('s1');
  store.markStopped('s1', { preserveApiRetry: true });
  assert.equal(store.apiRetryInfo['s1']?.stopping, true);
  store.clearApiRetrying('s1');
  assert.equal(store.apiRetryInfo['s1'], undefined);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
