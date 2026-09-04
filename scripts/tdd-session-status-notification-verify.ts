// tdd-session-status-notification-verify.ts
// 会话状态灯 + 失焦完成通知契约测试：纯函数行为 + 真实转换器 + store 行为 + 异步竞态 + 源码接线。
// 运行：npx tsx scripts/tdd-session-status-notification-verify.ts
// 不 import Electron、不启动窗口；源码接线用 readFileSync 钉住跨文件不变量。
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { isErrorCliResult, isSuccessfulCliResult } from '../src/shared/session-completion';
import { convertResultMessage } from '../src/shared/result-converter';
import {
  resolveSessionDisplayStatus,
  sessionDisplayStatusMeta,
} from '../src/shared/session-display-status';
import { buildSessionNotification } from '../src/shared/session-notification';
import type { CliEvent, CliResultEvent, CliApiRetryTerminalFallbackEvent, CliSystemInfoEvent } from '../src/shared/types/cli';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { useTaskStore } from '../src/renderer/stores/task-store';
import { useChat } from '../src/renderer/composables/use-chat';
import {
  applyApiRetryEvent,
  applyApiRetryTerminalFallbackEvent,
  applyPersistedMessageEvent,
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
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

// 名称不能以「会话」开头：use-chat 的 addMessage 会对首条 user 消息触发 analyzeTopic IPC。
function session(id: string): Session {
  return {
    id,
    name: `S-${id}`,
    cliSessionId: null,
    model: 'sonnet',
    modelOverride: null,
    workingDir: null,
    permissionMode: 'default',
    maxTurns: 0,
    createdAt: '2026-08-05T00:00:00.000Z',
    updatedAt: '2026-08-05T00:00:00.000Z',
    lastContextTokens: null,
    lastContextUpdatedAt: null,
    lastContextWindow: null,
  };
}

function resultEvent(overrides: Partial<CliResultEvent>): CliResultEvent {
  return {
    type: 'result',
    subtype: 'success',
    result: 'done',
    total_cost_usd: 0,
    duration_ms: 100,
    num_turns: 1,
    session_id: 'cc-session',
    is_error: false,
    ...overrides,
  };
}

// 主进程落库终态消息（system 角色）的渲染层投影。
function systemMessage(id: string, processKind: string): Message {
  return {
    id,
    sessionId: 's1',
    role: 'system',
    content: 'terminal',
    rawEvent: null,
    eventType: 'system',
    costUsd: null,
    durationMs: null,
    parentTaskId: null,
    processKind,
    parentAgentId: null,
    toolUseId: null,
    title: null,
    isError: false,
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

// 主进程 api_retry 排期瞬态事件（forwardTransient 投影）。
function apiRetryEvent(overrides: Partial<CliSystemInfoEvent> = {}): CliSystemInfoEvent {
  return {
    type: 'system',
    subtype: 'api_retry',
    retryCount: 10,
    retryLimit: 10,
    nextRetryAt: 5_000,
    retryDelayMs: 2_000,
    errorStatus: 529,
    error: 'overloaded',
    ...overrides,
  };
}

// 主进程 DB 写终态失败时的 fallback 事件（api_retry_terminal）。
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

async function main(): Promise<void> {
console.log('\n=== isSuccessfulCliResult / isErrorCliResult：成功与错误终态判定 ===');
check('成功 result（is_error=false, subtype=success）→ 成功、非错误', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({})), true);
  assert.equal(isErrorCliResult(resultEvent({})), false);
});
check('is_error=true 但显式 success subtype → 按成功处理（与旧 isErrResult 取反一致）', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: true, subtype: 'success' })), true);
  assert.equal(isErrorCliResult(resultEvent({ is_error: true, subtype: 'success' })), false);
});
check('error_during_execution（用户中断正常收尾）→ 不成功也不判错误', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: true, subtype: 'error_during_execution' })), false);
  assert.equal(isErrorCliResult(resultEvent({ is_error: true, subtype: 'error_during_execution' })), false);
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: false, subtype: 'error_during_execution' })), false);
});
check('is_error=true + 非 success subtype（error）→ 失败且判错误', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: true, subtype: 'error' })), false);
  assert.equal(isErrorCliResult(resultEvent({ is_error: true, subtype: 'error' })), true);
});
check('is_error=true + subtype=undefined（第三方端点缺 subtype）→ 失败且判错误', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: true, subtype: undefined })), false);
  assert.equal(isErrorCliResult(resultEvent({ is_error: true, subtype: undefined })), true);
});
check('is_error=true + 其它失败 subtype（error_max_turns）→ 失败且判错误', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: true, subtype: 'error_max_turns' })), false);
  assert.equal(isErrorCliResult(resultEvent({ is_error: true, subtype: 'error_max_turns' })), true);
});
check('is_error=false + subtype=undefined → 非错误（兼容策略：无错误标记即成功）', () => {
  assert.equal(isSuccessfulCliResult(resultEvent({ is_error: false, subtype: undefined })), true);
  assert.equal(isErrorCliResult(resultEvent({ is_error: false, subtype: undefined })), false);
});
check('普通 error / aborted / 非 result 事件 → 均不成功', () => {
  assert.equal(isSuccessfulCliResult({ type: 'error', message: 'boom' } as CliEvent), false);
  assert.equal(isSuccessfulCliResult({ type: 'aborted', message: '已中断' } as CliEvent), false);
  assert.equal(isSuccessfulCliResult({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'x' } } } as CliEvent), false);
  assert.equal(isErrorCliResult({ type: 'error', message: 'boom' } as CliEvent), false);
  assert.equal(isErrorCliResult({ type: 'aborted', message: '已中断' } as CliEvent), false);
});

console.log('\n=== F1：真实转换器 convertResultMessage 保留 subtype，错误不伪装成功 ===');
check('is_error=true + subtype=undefined 经转换后仍为 undefined → 判失败（修复前会被补成 success）', () => {
  const converted = convertResultMessage({ type: 'result', is_error: true, subtype: undefined });
  assert.equal(converted.subtype, undefined);
  assert.equal(isSuccessfulCliResult(converted), false);
  assert.equal(isErrorCliResult(converted), true);
});
check('is_error=false + subtype=success 经转换后判成功', () => {
  const converted = convertResultMessage({ type: 'result', is_error: false, subtype: 'success' });
  assert.equal(converted.subtype, 'success');
  assert.equal(isSuccessfulCliResult(converted), true);
  assert.equal(isErrorCliResult(converted), false);
});
check('is_error=false + subtype=undefined 经转换后按非错误处理（成功）', () => {
  const converted = convertResultMessage({ type: 'result', is_error: false });
  assert.equal(converted.subtype, undefined);
  assert.equal(isSuccessfulCliResult(converted), true);
});
check('is_error=true + subtype=error_max_turns 经转换后判失败', () => {
  const converted = convertResultMessage({ type: 'result', is_error: true, subtype: 'error_max_turns' });
  assert.equal(isSuccessfulCliResult(converted), false);
  assert.equal(isErrorCliResult(converted), true);
});
check('error_during_execution 经转换后：不完成、不判错误（中断）', () => {
  const converted = convertResultMessage({ type: 'result', is_error: true, subtype: 'error_during_execution' });
  assert.equal(isSuccessfulCliResult(converted), false);
  assert.equal(isErrorCliResult(converted), false);
});

console.log('\n=== session-store：状态灯生命周期 ===');
check('markRunning 置 running、清旧 completed', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
  store.markCompleted('s1');
  assert.equal(store.sessionStatus['s1'], 'completed');
  store.markRunning('s1');
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
});
check('markCompleted 置 completed、移出 runningSessions、清理运行期数据', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.sessionStreams['s1'] = { content: 'c', thinking: 't', tool: '' };
  store.turnStartedAt['s1'] = 1_000;
  store.stalledInfo['s1'] = { sinceMs: 0, gapMs: 1, lastKind: 'message', pendingAgentId: null, zone: 'model', stallCount: 1 };
  store.apiRetryInfo['s1'] = { retryCount: 1, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null, stopping: false };
  store.subAgentStreamingThinking['s1'] = { agent: 'thinking' };
  store.markCompleted('s1');
  assert.equal(store.sessionStatus['s1'], 'completed');
  assert.equal(store.runningSessions.includes('s1'), false);
  assert.equal(store.sessionStreams['s1'], undefined);
  assert.equal(store.turnStartedAt['s1'], undefined);
  assert.equal(store.stalledInfo['s1'], undefined);
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.subAgentStreamingThinking['s1'], undefined);
});
check('markStopped（失败/中断/aborted）只删运行态、不写 completed', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.markStopped('s1');
  assert.equal(store.sessionStatus['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
});
check('未出现在映射中的会话为 idle（无状态点）', () => {
  const store = useSessionStore();
  store.$reset();
  assert.equal(store.sessionStatus['fresh-session'], undefined);
});

console.log('\n=== 展示状态解析：resolveSessionDisplayStatus 完整表 ===');
check('完整表：idle/running/retrying/completed/network_interrupted', () => {
  assert.equal(resolveSessionDisplayStatus(undefined, false), 'idle');
  assert.equal(resolveSessionDisplayStatus('running', false), 'running');
  assert.equal(resolveSessionDisplayStatus('running', true), 'retrying');
  assert.equal(resolveSessionDisplayStatus('completed', false), 'completed');
  assert.equal(resolveSessionDisplayStatus('network_interrupted', false), 'network_interrupted');
});
check('retrying 覆盖 running（红闪优先于黄闪）', () => {
  assert.equal(resolveSessionDisplayStatus('running', true), 'retrying');
});
check('completed/network_interrupted 终态优先于残留 retry 瞬态', () => {
  assert.equal(resolveSessionDisplayStatus('completed', true), 'completed');
  assert.equal(resolveSessionDisplayStatus('network_interrupted', true), 'network_interrupted');
});
check('展示元数据：四态文案与闪烁标志（颜色留在 CSS 层）', () => {
  assert.deepEqual(sessionDisplayStatusMeta('idle'), { label: '', blinking: false });
  assert.deepEqual(sessionDisplayStatusMeta('running'), { label: '执行中', blinking: true });
  assert.deepEqual(sessionDisplayStatusMeta('retrying'), { label: '网络异常，正在重试', blinking: true });
  assert.deepEqual(sessionDisplayStatusMeta('completed'), { label: '任务已完成', blinking: false });
  assert.deepEqual(sessionDisplayStatusMeta('network_interrupted'), { label: '网络异常，已中断', blinking: false });
});

console.log('\n=== retry 红闪与耗尽常红：store 状态流 ===');
check('markRunning → markApiRetrying：仍在 runningSessions，但展示为 retrying', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.markApiRetrying('s1', { retryCount: 1, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null });
  assert.equal(store.runningSessions.includes('s1'), true);
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.sessionDisplayStatus('s1'), 'retrying');
});
check('recovered 清 retry 后回 running（黄闪）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.markApiRetrying('s1', { retryCount: 1, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null });
  applyPersistedMessageEvent(store, 's1', systemMessage('m-recovered', 'system:api_retry_recovered'));
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
  assert.equal(store.sessionDisplayStatus('s1'), 'running');
});
check('exhausted persisted message → markNetworkInterrupted 常红（红灯不闪）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.markApiRetrying('s1', { retryCount: 10, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null });
  applyPersistedMessageEvent(store, 's1', systemMessage('m-exhausted', 'system:api_retry_exhausted'));
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
  assert.equal(store.sessionDisplayStatus('s1'), 'network_interrupted');
});
check('exhausted fallback 同样进入 network_interrupted 且保留兜底卡片', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 10 }));
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('exhausted'));
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
  assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'exhausted');
  assert.equal(store.apiRetryInfo['s1'], undefined);
});
check('exhausted 后迟到 markStopped（失败 result/error/aborted）不清常红', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  store.markStopped('s1');
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
});
check('exhausted 后迟到成功（markCompleted）不覆盖常红', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  store.markCompleted('s1');
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
});
check('network_interrupted 经 queue_completed 仍常红', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  taskStore.queueState = { sessionId: 's1', status: 'running', currentTaskId: null, lastCompletedTaskId: null, countdownRemaining: 0, pendingCount: 0 };
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'queue_completed' });
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
});
check('network_interrupted 经 markRunning 回 running（黄闪）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  store.markRunning('s1');
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
});
check('network_interrupted 经下一项 task_started（markRunning）回 running', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  taskStore.queueState = { sessionId: 's1', status: 'idle', currentTaskId: null, lastCompletedTaskId: null, countdownRemaining: 0, pendingCount: 1 };
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'task_started', taskId: 't2' });
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
});
check('user_stopped / 普通失败 / aborted 不设置常红', () => {
  const store = useSessionStore();
  store.$reset();
  // 用户停止：清 retry + markStopped → idle，不常红。
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m-stopped', 'system:api_retry_stopped'));
  assert.equal(store.sessionStatus['s1'], undefined);
  // 普通失败 result：markStopped → idle。
  store.markRunning('s2');
  store.markStopped('s2');
  assert.equal(store.sessionStatus['s2'], undefined);
  // aborted / watchdog 中断：markStopped → idle。
  store.markRunning('s3');
  store.markStopped('s3');
  assert.equal(store.sessionStatus['s3'], undefined);
});
check('后台 session exhausted 不影响当前 session 状态', () => {
  const store = useSessionStore();
  store.$reset();
  store.activeSession = session('sA');
  store.markRunning('sA');
  store.markRunning('sB');
  applyPersistedMessageEvent(store, 'sB', { ...systemMessage('m-bg', 'system:api_retry_exhausted'), sessionId: 'sB' });
  assert.equal(store.sessionStatus['sB'], 'network_interrupted');
  assert.equal(store.runningSessions.includes('sB'), false);
  assert.equal(store.sessionStatus['sA'], 'running');
  assert.equal(store.runningSessions.includes('sA'), true);
});

console.log('\n=== F1：同一 Query 多 retry episode，旧 terminal fallback 必须失效 ===');
check('F1：episode 1 fallback recovered → episode 2 首个 api_retry：旧 fallback 立即清除', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('recovered'));
  assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'recovered');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 1 }));
  assert.equal(store.apiRetryTerminalFallback['s1'], undefined, '新 episode 首个 api_retry 必须清除上一 episode 的 fallback');
  assert.equal(store.apiRetryInfo['s1']?.retryCount, 1);
});
check('F1：episode 1 fallback recovered → episode 2 persisted exhausted：最终常红且 fallback 为空', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('recovered'));
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 1 }));
  applyPersistedMessageEvent(store, 's1', systemMessage('m-ex-2', 'system:api_retry_exhausted'));
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
  assert.equal(store.apiRetryTerminalFallback['s1'], undefined, 'episode 2 persisted 终态落库后不得重新出现 episode 1 的旧 fallback');
  assert.equal(store.apiRetryInfo['s1'], undefined);
});
check('F1：episode 1 fallback exhausted → markRunning 新回合：旧 fallback 清除（既有行为保持）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('exhausted'));
  store.markRunning('s1');
  assert.equal(store.apiRetryTerminalFallback['s1'], undefined);
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
});
check('F1：同一 episode 连续多次 api_retry 不影响权威 retry count/limit', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 3, retryLimit: 10 }));
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 7, retryLimit: 10 }));
  assert.equal(store.apiRetryInfo['s1']?.retryCount, 7);
  assert.equal(store.apiRetryInfo['s1']?.retryLimit, 10);
  assert.equal(store.apiRetryTerminalFallback['s1'], undefined);
});

console.log('\n=== F2（v2）：terminal 后迟到 api_retry 双层拒绝 ===');
check('F2：network_interrupted 后迟到 api_retry 不产生 apiRetryInfo、不清 fallback', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryTerminalFallbackEvent(store, 's1', apiRetryTerminalFallbackEvent('recovered'));
  applyPersistedMessageEvent(store, 's1', systemMessage('m-ex', 'system:api_retry_exhausted'));
  assert.equal(store.sessionStatus['s1'], 'network_interrupted');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 5 }));
  assert.equal(store.apiRetryInfo['s1'], undefined, 'terminal 后迟到 retry 不得重建重试卡');
  assert.equal(store.sessionStatus['s1'], 'network_interrupted', '常红保持');
  assert.equal(store.sessionDisplayStatus('s1'), 'network_interrupted');
});
check('F2：completed 后迟到 api_retry 不产生 apiRetryInfo、绿灯保持', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  store.markCompleted('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  assert.equal(store.apiRetryInfo['s1'], undefined);
  assert.equal(store.sessionStatus['s1'], 'completed');
  assert.equal(store.sessionDisplayStatus('s1'), 'completed');
});
check('F2：running 中 api_retry 仍正常红闪（合法路径不被守卫挡住）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 2 }));
  assert.equal(store.apiRetryInfo['s1']?.retryCount, 2);
  assert.equal(store.sessionDisplayStatus('s1'), 'retrying');
  assert.equal(store.runningSessions.includes('s1'), true);
});
check('F2：新回合 markRunning 后合法 retry 正常红闪（常红→回黄→再红闪）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  applyPersistedMessageEvent(store, 's1', systemMessage('m1', 'system:api_retry_exhausted'));
  store.markRunning('s1'); // 新回合清常红
  applyApiRetryEvent(store, 's1', apiRetryEvent({ retryCount: 1 }));
  assert.equal(store.sessionDisplayStatus('s1'), 'retrying');
  assert.equal(store.apiRetryInfo['s1']?.retryCount, 1);
});

console.log('\n=== F2(v3)：task_settled 不清掉已完成的绿灯 ===');
check('markRunning → markCompleted → task_settled(success)：绿灯保留（结算成功不碰聊天终态）', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markRunning('s1');
  store.markCompleted('s1');
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'task_settled', taskId: 't1', data: { outcome: 'success' } });
  assert.equal(store.sessionStatus['s1'], 'completed');
  assert.equal(store.runningSessions.includes('s1'), false);
});
check('队列耗尽但无成功 result（失败/中断）→ 不得 completed', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markRunning('s1');
  store.markStopped('s1'); // 模拟失败/中断终态（错误 result 或 aborted 已回 idle）
  taskStore.queueState = { sessionId: 's1', status: 'running', currentTaskId: null, lastCompletedTaskId: null, countdownRemaining: 0, pendingCount: 0 };
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'queue_completed' });
  assert.equal(store.sessionStatus['s1'], undefined);
  assert.equal(store.runningSessions.includes('s1'), false);
});
check('队列还有下一项时，下一项 task_started 的 markRunning 可靠回黄灯', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markCompleted('s1'); // 上一项成功后的绿灯
  taskStore.queueState = { sessionId: 's1', status: 'waiting', currentTaskId: null, lastCompletedTaskId: 't1', countdownRemaining: 2, pendingCount: 1 };
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'task_started', taskId: 't2' });
  assert.equal(store.sessionStatus['s1'], 'running');
  assert.equal(store.runningSessions.includes('s1'), true);
});

console.log('\n=== F3：发送等待 IPC 时切换会话，失败只停本次发送的会话 ===');
await checkAsync('A 发送期间切到 B，A 的 IPC reject 只停 A、B 绿灯保留（修复前会错停 B）', async () => {
  const store = useSessionStore();
  store.$reset();
  let rejectSend: ((e: Error) => void) | null = null;
  const prevWindow = (globalThis as { window?: unknown }).window;
  // 可控 reject 的 IPC stub：resolve 时机由测试决定，模拟「等待 IPC 期间切换会话」。
  (globalThis as Record<string, unknown>).window = {
    claudeLink: {
      sendMessage: () => new Promise((_resolve, reject) => { rejectSend = reject; }),
    },
  };
  try {
    const chat = useChat();
    store.activeSession = session('sA');
    const p = chat.sendMessage({ text: 'hello', attachmentIds: [], clientMessageId: 'cm1' });
    assert.equal(store.sessionStatus['sA'], 'running');
    // 乐观 user 消息归属 A（同步段内 activeSession 仍是 A）。
    assert.ok(store.messages.some((m) => m.sessionId === 'sA' && m.role === 'user'), '乐观消息应归属 A');
    // 等待 IPC 期间切到 B（B 原本是绿灯的已完成会话）。
    store.activeSession = session('sB');
    store.sessionStatus['sB'] = 'completed';
    rejectSend!(new Error('boom'));
    const ok = await p;
    assert.equal(ok, false);
    assert.equal(store.sessionStatus['sA'], undefined, 'A 发送失败应回 idle');
    assert.equal(store.runningSessions.includes('sA'), false, 'A 不应残留在 runningSessions');
    assert.equal(store.sessionStatus['sB'], 'completed', 'B 的绿灯不得被 A 的失败清掉');
    assert.equal(store.runningSessions.includes('sB'), false, 'B 运行态不得被误动');
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});

console.log('\n=== F2（v2-F1）：删除会话 IPC 失败回滚只恢复静态真实状态 ===');
await checkAsync('删除失败：network_interrupted 静态终态恢复，活状态（running/retry/流式/计时/stalled/思考）不恢复', async () => {
  const store = useSessionStore();
  store.$reset();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as Record<string, unknown>).window = {
    claudeLink: {
      deleteSession: () => Promise.reject(new Error('db boom')),
    },
  };
  try {
    const s1 = session('s1');
    store.sessions = [s1];
    store.activeSession = s1;
    store.messages = [systemMessage('m1', 'system:api_retry_exhausted')];
    store.markRunning('s1');
    store.apiRetryInfo['s1'] = { retryCount: 3, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null, stopping: false };
    store.apiRetryTerminalFallback['s1'] = { kind: 'recovered', summary: 's', details: apiRetryTerminalFallbackEvent('recovered').details };
    store.sessionStreams['s1'] = { content: 'c', thinking: 't', tool: '' };
    store.stalledInfo['s1'] = { sinceMs: 0, gapMs: 1, lastKind: 'message', pendingAgentId: null, zone: 'model', stallCount: 1 };
    store.turnStartedAt['s1'] = 1234;
    store.subAgentStreamingThinking['s1'] = { agent: 'thinking' };
    store.sessionStatus['s1'] = 'network_interrupted';
    await store.deleteSession('s1');
    // 静态、仍然真实的展示态恢复：
    assert.equal(store.sessions.length, 1, '会话列表应回滚');
    assert.equal(store.activeSession?.id, 's1', 'activeSession 应回滚');
    assert.equal(store.messages.length, 1, 'messages 应随 activeSession 回滚');
    assert.equal(store.sessionStatus['s1'], 'network_interrupted', '静态常红应恢复');
    assert.equal(store.apiRetryTerminalFallback['s1']?.kind, 'recovered', '常红对应的 fallback 可保留');
    // 主进程已不可逆终止 query/queue/retry（先 markSessionDeleted/killProcess 再 deleteSession），
    // 活状态一律不得恢复，否则形成幽灵运行态：
    assert.equal(store.runningSessions.includes('s1'), false, 'runningSessions 不得恢复');
    assert.equal(store.apiRetryInfo['s1'], undefined, 'retry banner 不得恢复');
    assert.equal(store.sessionStreams['s1'], undefined, '流式快照不得恢复');
    assert.equal(store.turnStartedAt['s1'], undefined, '回合计时不得恢复');
    assert.equal(store.stalledInfo['s1'], undefined, 'stalled 不得恢复');
    assert.equal(store.subAgentStreamingThinking['s1'], undefined, '子 agent 思考快照不得恢复');
    assert.notEqual(store.error, null, '应提示删除失败');
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
await checkAsync('删除失败：删除前 running/retrying 会话恢复为 idle（不显示幽灵黄闪/红闪）', async () => {
  const store = useSessionStore();
  store.$reset();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as Record<string, unknown>).window = {
    claudeLink: {
      deleteSession: () => Promise.reject(new Error('db boom')),
    },
  };
  try {
    store.sessions = [session('s1')];
    store.activeSession = session('s1');
    store.markRunning('s1');
    store.apiRetryInfo['s1'] = { retryCount: 2, retryLimit: 10, nextRetryAt: 0, retryDelayMs: 0, errorStatus: null, error: null, stopping: false };
    await store.deleteSession('s1');
    assert.equal(store.sessions.length, 1, '会话列表应回滚');
    assert.equal(store.sessionStatus['s1'], undefined, 'running 不得恢复，回 idle');
    assert.equal(store.runningSessions.includes('s1'), false, 'runningSessions 不得恢复');
    assert.equal(store.apiRetryInfo['s1'], undefined, 'retrying 不得恢复');
    assert.equal(store.sessionDisplayStatus('s1'), 'idle');
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
await checkAsync('删除失败：completed 绿灯静态终态恢复，其他会话运行态不受影响', async () => {
  const store = useSessionStore();
  store.$reset();
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as Record<string, unknown>).window = {
    claudeLink: {
      deleteSession: () => Promise.reject(new Error('db boom')),
    },
  };
  try {
    store.sessions = [session('s1'), session('s2')];
    store.activeSession = session('s2');
    store.markCompleted('s1'); // s1 绿灯
    store.markRunning('s2'); // s2 running
    await store.deleteSession('s1');
    assert.equal(store.sessions.length, 2, '会话列表应回滚');
    assert.equal(store.sessionStatus['s1'], 'completed', '静态绿灯应恢复');
    assert.equal(store.runningSessions.includes('s1'), false, 's1 活状态不得恢复');
    assert.equal(store.sessionStatus['s2'], 'running', '其他会话运行态不受影响');
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
check('F2：deleteSession 成功路径仍清理全部 per-session 运行态', () => {
  const sessionStore = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
  for (const stmt of [
    'delete this.sessionStreams[id]',
    'delete this.stalledInfo[id]',
    'delete this.apiRetryInfo[id]',
    'delete this.apiRetryTerminalFallback[id]',
    'delete this.subAgentStreamingThinking[id]',
    'delete this.sessionStatus[id]',
    'delete this.turnStartedAt[id]',
  ]) {
    assert.ok(sessionStore.includes(stmt), `删除会话必须清理：${stmt}`);
  }
});
check('v2-F1 契约：主进程 SESSION_DELETE 先 cleanupQueue/markSessionDeleted/killProcess 后 deleteSession（IPC reject ≠ 主进程未动）', () => {
  const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const cleanupIdx = ipcHandlers.indexOf('cleanupQueue(id)');
  const deletedIdx = ipcHandlers.indexOf('markSessionDeleted(id)');
  const killIdx = ipcHandlers.indexOf("killProcess(id, 'session_cleanup')");
  const repoIdx = ipcHandlers.indexOf('sessionRepo.deleteSession(id)');
  assert.ok(cleanupIdx >= 0 && deletedIdx > cleanupIdx && killIdx > deletedIdx && repoIdx > killIdx,
    '顺序必须：cleanupQueue → markSessionDeleted → killProcess → deleteSession');
});

console.log('\n=== v2-F3：abort finally 绑定回合 generation ===');
await checkAsync('旧 abort IPC 返回后才创建 finally timer，不误停已开始的新回合', async () => {
  const store = useSessionStore();
  store.$reset();
  let resolveAbort: (() => void) | null = null;
  const prevWindow = (globalThis as { window?: unknown }).window;
  (globalThis as Record<string, unknown>).window = {
    claudeLink: {
      abortChat: () => new Promise<void>((resolve) => { resolveAbort = resolve; }),
    },
  };
  try {
    const chat = useChat();
    store.activeSession = session('s1');
    // 回合 1 运行中，用户点击停止（乐观 markStopped + await abortChat IPC 挂起）。
    store.markRunning('s1');
    const p = chat.abort();
    assert.equal(store.runningSessions.includes('s1'), false, '乐观 markStopped 应立即复位');
    // 旧 abort IPC 挂起期间，用户立即发送新回合（sendMessage → markRunning）。
    store.markRunning('s1');
    assert.equal(store.sessionStatus['s1'], 'running');
    // 旧 abort IPC 返回，finally timer 才创建（捕获的是旧 generation）。
    resolveAbort!();
    await p;
    // 等待 1.2s 兜底窗口 + 余量：旧 finally 必须 no-op，不得误停新回合。
    await new Promise((r) => setTimeout(r, 1_400));
    assert.equal(store.runningSessions.includes('s1'), true, '新回合不得被旧 finally 误停');
    assert.equal(store.sessionStatus['s1'], 'running', '新回合黄灯保持');
  } finally {
    if (prevWindow === undefined) delete (globalThis as Record<string, unknown>).window;
    else (globalThis as Record<string, unknown>).window = prevWindow;
  }
});
check('v2-F3：markRunning 递增回合 generation（abort finally 绑定依据）', () => {
  const store = useSessionStore();
  store.$reset();
  store.markRunning('s1');
  const g1 = store.turnGeneration['s1'];
  assert.equal(typeof g1, 'number', 'markRunning 必须写 generation');
  store.markRunning('s1');
  assert.ok(store.turnGeneration['s1']! > g1!, 'markRunning 必须递增 generation');
});
check('v2-F3：deleteSession 清理回合 generation', () => {
  const sessionStore = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
  assert.ok(sessionStore.includes('delete this.turnGeneration[id]'));
});
check('v2-F3：use-chat 兜底捕获 generation 并比较（旧回合 finally 到点 no-op）', () => {
  const useChatSource = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  assert.ok(useChatSource.includes('const generation = store.turnGeneration[sid] ?? 0;'));
  assert.ok(useChatSource.includes("(store.turnGeneration[sid] ?? 0) !== generation"));
  assert.ok(useChatSource.includes('ensureAbortFinally(sid);'), 'abort 必须在 await IPC 前注册 finally');
});

console.log('\n=== F3：失焦系统通知判定 buildSessionNotification 行为 ===');
check('F3：通知开关关闭 / 平台不支持 / 窗口销毁 / 窗口聚焦 / 会话不存在 → 均不通知', () => {
  const base = { notifyEnabled: true, notificationSupported: true, windowDestroyed: false, windowFocused: false, sessionName: 'S-1' };
  assert.equal(buildSessionNotification({ ...base, notifyEnabled: false }, '网络异常，已中断'), null);
  assert.equal(buildSessionNotification({ ...base, notificationSupported: false }, '网络异常，已中断'), null);
  assert.equal(buildSessionNotification({ ...base, windowDestroyed: true }, '网络异常，已中断'), null);
  assert.equal(buildSessionNotification({ ...base, windowFocused: true }, '网络异常，已中断'), null);
  assert.equal(buildSessionNotification({ ...base, sessionName: null }, '网络异常，已中断'), null);
});
check('F3：notifyOnLeave 开关关闭优先于平台/焦点/会话判定（一律静默）', () => {
  // 即使其它条件全部满足，只要开关关闭就不通知。
  assert.equal(
    buildSessionNotification({ notifyEnabled: false, notificationSupported: true, windowDestroyed: false, windowFocused: false, sessionName: 'S' }, '任务已完成'),
    null,
  );
});
check('F3：窗口销毁优先于聚焦判定（destroyed 一律不通知）', () => {
  assert.equal(
    buildSessionNotification({ notifyEnabled: true, notificationSupported: true, windowDestroyed: true, windowFocused: false, sessionName: 'S' }, 'x'),
    null,
  );
});
check('F3：失焦且会话存在 → 载荷精确为会话标题 + 指定正文（两种通知种类）', () => {
  assert.deepEqual(
    buildSessionNotification({ notifyEnabled: true, notificationSupported: true, windowDestroyed: false, windowFocused: false, sessionName: '会话 A' }, '网络异常，已中断'),
    { title: '会话 A', body: '网络异常，已中断' },
  );
  assert.deepEqual(
    buildSessionNotification({ notifyEnabled: true, notificationSupported: true, windowDestroyed: false, windowFocused: false, sessionName: '会话 A' }, '任务已完成'),
    { title: '会话 A', body: '任务已完成' },
  );
});
check('F3：标题来自最新 session.name（非用户输入拼接），正文固定不随标题变', () => {
  const p = buildSessionNotification({ notifyEnabled: true, notificationSupported: true, windowDestroyed: false, windowFocused: false, sessionName: 'S-123' }, '网络异常，已中断');
  assert.equal(p?.title, 'S-123');
  assert.equal(p?.body, '网络异常，已中断');
});
check('F3：notifier 实际使用共享纯函数决策并构造 Notification', () => {
  const notifier = readFileSync(new URL('../src/main/modules/session-completion-notifier.ts', import.meta.url), 'utf8');
  assert.ok(notifier.includes("import { buildSessionNotification } from '../../shared/session-notification';"));
  assert.ok(notifier.includes('buildSessionNotification('));
  assert.ok(notifier.includes('new Notification({ title: payload.title, body: payload.body })'));
  // 配置开关 notifyOnLeave 必须接入纯函数决策（getConfig().notifyOnLeave → notifyEnabled）。
  assert.ok(notifier.includes('notifyEnabled: getConfig().notifyOnLeave'));
  assert.ok(notifier.includes("import { getConfig } from './config-manager';"));
});

console.log('\n=== 源码接线契约 ===');
const sessionStore = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
const useChatSource = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const taskStoreSource = readFileSync(new URL('../src/renderer/stores/task-store.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/renderer/components/layout/AppSidebar.vue', import.meta.url), 'utf8');
const sdkBackend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
const cliShared = readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');

check('session-store 声明 sessionStatus 状态映射（SessionStatus：running/completed/network_interrupted）', () => {
  assert.ok(sessionStore.includes('sessionStatus: {} as Record<string, SessionStatus>'));
  assert.ok(sessionStore.includes("'network_interrupted'"));
});
check('session-store 提供 sessionDisplayStatus 统一解析 getter', () => {
  assert.ok(sessionStore.includes('sessionDisplayStatus(state)'));
  assert.ok(sessionStore.includes('resolveSessionDisplayStatus'));
  assert.ok(sessionStore.includes("Boolean(state.apiRetryInfo[sessionId])"));
});
check('markRunning 置 running、清旧 completed', () => {
  assert.ok(sessionStore.includes("delete this.sessionStatus[sessionId];"));
  assert.ok(sessionStore.includes("this.sessionStatus[sessionId] = 'running';"));
});
check('markCompleted 置 completed 并清理运行态', () => {
  assert.ok(sessionStore.includes("this.sessionStatus[sessionId] = 'completed';"));
});
check('markStopped 清理方向：不写 completed（completed 赋值只出现在 markCompleted）', () => {
  assert.ok(sessionStore.includes('delete this.sessionStatus[sessionId];'));
  const completedWrites = sessionStore.split("this.sessionStatus[sessionId] = 'completed';").length - 1;
  assert.equal(completedWrites, 1, `completed 赋值应恰好 1 次（markCompleted），实际 ${completedWrites}`);
});
check('deleteSession 清理状态灯与回合计时', () => {
  assert.ok(sessionStore.includes('delete this.sessionStatus[id];'));
  assert.ok(sessionStore.includes('delete this.turnStartedAt[id];'));
});
check('use-chat 当前会话 result 成功调 markCompleted、失败调 markStopped（同一共享判定）', () => {
  assert.ok(useChatSource.includes('store.markCompleted(store.activeSession.id);'));
  assert.ok(useChatSource.includes('store.markStopped(store.activeSession.id);'));
  assert.ok(useChatSource.includes('if (isSuccessfulCliResult(event)) {'));
  assert.ok(useChatSource.includes('const isErrResult = isErrorCliResult(event);'), '错误展示须用统一 isErrorCliResult');
});
check('use-chat 后台会话 result 成功调 markCompleted(sid)', () => {
  assert.ok(useChatSource.includes('store.markCompleted(sid);'));
});
check('use-chat 错误/中断分支保持 markStopped（markCompleted 仅出现在两个 result 分支）', () => {
  const markCompletedCount = useChatSource.split('store.markCompleted(').length - 1;
  assert.equal(markCompletedCount, 2, `store.markCompleted 调用应恰好出现 2 次（当前+后台 result），实际 ${markCompletedCount}`);
});
check('use-chat sendMessage 捕获稳定 sessionId（F3）', () => {
  assert.ok(useChatSource.includes('const sessionId = store.activeSession.id;'));
  assert.ok(useChatSource.includes('store.markRunning(sessionId);'));
  assert.ok(useChatSource.includes('store.markStopped(sessionId);'), 'catch 必须用稳定 sessionId 而非 activeSession');
});
check('task-store task_settled 成功不碰终态、非 success 走 markStopped（v3 等价 F2）', () => {
  // 成功结算只更新历史（无 markCompleted/markStopped 调用）；非 success 才 markStopped 兜底。
  const settledBranch = taskStoreSource.slice(taskStoreSource.indexOf("case 'task_settled'"), taskStoreSource.indexOf("case 'queue_halted'"));
  assert.ok(settledBranch.includes("markStopped(payload.sessionId)"), '非 success 结算须 markStopped（中断兜底）');
  assert.ok(!settledBranch.includes('markCompleted'), '结算成功不得驱动绿灯（绿灯由 result 事件权威驱动）');
  assert.ok(!taskStoreSource.includes("'queue_completed'"), 'v3：旧队列收口事件分支应移除');
});
check('cli-shared result 落库跳过与 renderer 共用 isErrorCliResult（F1）', () => {
  assert.ok(cliShared.includes('isErrorCliResult(r)'));
  assert.ok(!cliShared.includes("subtype !== 'success' && subtype !== undefined"), '旧 isErrResult 判定应移除');
});
check('sdk-backend 从共享层导入 convertResultMessage，不再本地补 subtype=success（F1）', () => {
  assert.ok(sdkBackend.includes("import { convertResultMessage } from '../../shared/result-converter';"));
  assert.ok(!sdkBackend.includes('function convertResultMessage'), '本地转换函数应移除');
  assert.ok(!sdkBackend.includes("(sdkMsg.subtype as string) ?? 'success'"), '无条件 ?? success 应移除');
});
check('AppSidebar 四态类 + 状态点 + pulse 动画', () => {
  assert.ok(sidebar.includes("'session-link--running'"));
  assert.ok(sidebar.includes("'session-link--retrying'"));
  assert.ok(sidebar.includes("'session-link--completed'"));
  assert.ok(sidebar.includes("'session-link--network-interrupted'"));
  assert.ok(sidebar.includes('class="session-link__status"'));
  assert.ok(sidebar.includes('session-status-pulse'));
  assert.ok(sidebar.includes('aria-label'));
});
check('AppSidebar 四态颜色经 --session-status-color token 控制（warn/danger/success）', () => {
  assert.ok(sidebar.includes('--session-status-color: var(--color-warn)'));
  assert.ok(sidebar.includes('--session-status-color: var(--color-danger)'));
  assert.ok(sidebar.includes('--session-status-color: var(--color-success)'));
  // 静态态显式 animation:none；running/retrying 共用同一条 pulse keyframes（不复制两套）。
  const pulseDecls = sidebar.split('animation: session-status-pulse 1.2s ease-in-out infinite').length - 1;
  assert.equal(pulseDecls, 1, `pulse 动画声明应恰好 1 条，实际 ${pulseDecls}`);
  assert.ok(sidebar.includes('session-link__status--network-interrupted'));
  assert.ok(sidebar.includes('animation: none'));
});
check('AppSidebar 状态点带辅助技术可读的 aria-label/title（不只依赖颜色）', () => {
  assert.ok(sidebar.includes(':aria-label='));
  assert.ok(sidebar.includes('role="img"'));
  assert.ok(sidebar.includes('sessionDisplayStatusMeta'));
  assert.ok(sidebar.includes('statusLabel(session.id)'));
});
check('session-display-status 共享模块含四态可访问文案', () => {
  const sds = readFileSync(new URL('../src/shared/session-display-status.ts', import.meta.url), 'utf8');
  assert.ok(sds.includes("'执行中'"));
  assert.ok(sds.includes("'网络异常，正在重试'"));
  assert.ok(sds.includes("'任务已完成'"));
  assert.ok(sds.includes("'网络异常，已中断'"));
});
check('F4：reduced-motion 块位于状态灯基础动画声明与 keyframes 之后（覆盖顺序有效）', () => {
  const mediaIdx = sidebar.indexOf('@media (prefers-reduced-motion: reduce)');
  const pulseIdx = sidebar.indexOf('animation: session-status-pulse 1.2s ease-in-out infinite');
  const keyframesEnd = sidebar.indexOf('@keyframes session-status-pulse');
  assert.ok(mediaIdx > -1 && pulseIdx > -1, 'media 与 pulse 声明必须存在');
  assert.ok(mediaIdx > pulseIdx, `media(${mediaIdx}) 应在 pulse 声明(${pulseIdx})之后`);
  assert.ok(mediaIdx > keyframesEnd, `media(${mediaIdx}) 应在 keyframes(${keyframesEnd})之后`);
});
check('sdk-backend 接入 notifier 且只对成功 result 触发完成通知', () => {
  assert.ok(sdkBackend.includes("import { notifySessionCompleted, notifySessionNetworkInterrupted } from './session-completion-notifier';"));
  assert.ok(sdkBackend.includes("event.type === 'result' && isSuccessfulCliResult(event)"));
  assert.ok(sdkBackend.includes('notifySessionCompleted(mainWindow, sessionId)'));
});
check('finishApiRetryExhausted 中 persistApiRetryTerminal 位于网络通知之前', () => {
  const fn = sdkBackend.slice(sdkBackend.indexOf('function finishApiRetryExhausted('), sdkBackend.indexOf('function isToolResultPart('));
  const persistIdx = fn.indexOf('persistApiRetryTerminal(sessionId, mainWindow, exhausted.state)');
  const notifyIdx = fn.indexOf('notifySessionNetworkInterrupted(mainWindow, sessionId)');
  assert.ok(persistIdx >= 0, 'exhausted 分支必须调用 persistApiRetryTerminal');
  assert.ok(notifyIdx > persistIdx, `网络通知(${notifyIdx}) 应位于 persist(${persistIdx}) 之后`);
});
check('网络中断通知只出现在 becameExhausted 唯一边沿（全局唯一调用点）', () => {
  const fn = sdkBackend.slice(sdkBackend.indexOf('function finishApiRetryExhausted('), sdkBackend.indexOf('function isToolResultPart('));
  const ifIdx = fn.indexOf('if (exhausted.becameExhausted)');
  const notifyIdx = fn.indexOf('notifySessionNetworkInterrupted(mainWindow, sessionId)');
  assert.ok(ifIdx >= 0 && notifyIdx > ifIdx, '通知必须位于 becameExhausted === true 分支内');
  const callCount = sdkBackend.split('notifySessionNetworkInterrupted(mainWindow, sessionId)').length - 1;
  assert.equal(callCount, 1, `调用点应恰好 1 处，实际 ${callCount}`);
});
check('finishApiRetryRecovery 与 killProcess 不调用网络中断通知', () => {
  const recoveryFn = sdkBackend.slice(sdkBackend.indexOf('function finishApiRetryRecovery('), sdkBackend.indexOf('function finishApiRetryExhausted('));
  const killFn = sdkBackend.slice(sdkBackend.indexOf('export function killProcess('), sdkBackend.indexOf('export function killAllProcesses('));
  assert.ok(!recoveryFn.includes('notifySessionNetworkInterrupted'), 'recovery 不得触发网络中断通知');
  assert.ok(!killFn.includes('notifySessionNetworkInterrupted'), 'killProcess（user/watchdog/queue）不得触发网络中断通知');
});
check('session-completion-notifier 公共守卫输入 + 两个语义化包装函数', () => {
  const notifier = readFileSync(new URL('../src/main/modules/session-completion-notifier.ts', import.meta.url), 'utf8');
  assert.ok(notifier.includes('new Notification({ title: payload.title, body: payload.body })'));
  assert.ok(notifier.includes('Notification.isSupported()'));
  assert.ok(notifier.includes('mainWindow.isFocused()'));
  assert.ok(notifier.includes('mainWindow.isDestroyed()'));
  assert.ok(notifier.includes('sessionRepo.getSession(sessionId)'));
  assert.ok(notifier.includes("export function notifySessionCompleted(mainWindow: BrowserWindow, sessionId: string)"));
  assert.ok(notifier.includes("export function notifySessionNetworkInterrupted(mainWindow: BrowserWindow, sessionId: string)"));
  assert.ok(notifier.includes("'任务已完成'"));
  assert.ok(notifier.includes("'网络异常，已中断'"));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
}
void main();
