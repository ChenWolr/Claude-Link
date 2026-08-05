// tdd-session-status-notification-verify.ts
// 会话状态灯 + 失焦完成通知契约测试：纯函数行为 + 真实转换器 + store 行为 + 异步竞态 + 源码接线。
// 运行：npx tsx scripts/tdd-session-status-notification-verify.ts
// 不 import Electron、不启动窗口；源码接线用 readFileSync 钉住跨文件不变量。
import { strict as assert } from 'node:assert';
import { setActivePinia, createPinia } from 'pinia';
import { readFileSync } from 'node:fs';
import { isErrorCliResult, isSuccessfulCliResult } from '../src/shared/session-completion';
import { convertResultMessage } from '../src/shared/result-converter';
import type { CliEvent, CliResultEvent } from '../src/shared/types/cli';
import { useSessionStore } from '../src/renderer/stores/session-store';
import { useTaskStore } from '../src/renderer/stores/task-store';
import { useChat } from '../src/renderer/composables/use-chat';
import type { Session } from '../src/shared/types/session';

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

console.log('\n=== F2：queue_completed 不清掉已完成的绿灯 ===');
check('markRunning → markCompleted → queue_completed：绿灯保留（修复前被 markStopped 清掉）', () => {
  const store = useSessionStore();
  const taskStore = useTaskStore();
  store.$reset();
  taskStore.$reset();
  store.markRunning('s1');
  store.markCompleted('s1');
  taskStore.queueState = { sessionId: 's1', status: 'running', currentTaskId: null, lastCompletedTaskId: null, countdownRemaining: 0, pendingCount: 0 };
  taskStore.handleQueueEvent({ sessionId: 's1', type: 'queue_completed' });
  assert.equal(taskStore.queueState.status, 'idle');
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

console.log('\n=== 源码接线契约 ===');
const sessionStore = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
const useChatSource = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
const taskStoreSource = readFileSync(new URL('../src/renderer/stores/task-store.ts', import.meta.url), 'utf8');
const sidebar = readFileSync(new URL('../src/renderer/components/layout/AppSidebar.vue', import.meta.url), 'utf8');
const sdkBackend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
const cliShared = readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');

check('session-store 声明 sessionStatus 状态映射（running | completed）', () => {
  assert.ok(sessionStore.includes("sessionStatus: {} as Record<string, 'running' | 'completed'>"));
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
check('task-store queue_completed 对 completed 会话跳过 markStopped（F2）', () => {
  assert.ok(taskStoreSource.includes("sessionStore.sessionStatus[payload.sessionId] !== 'completed'"));
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
check('AppSidebar 三态类 + 状态点 + pulse 动画', () => {
  assert.ok(sidebar.includes("'session-link--running'"));
  assert.ok(sidebar.includes("'session-link--completed'"));
  assert.ok(sidebar.includes('class="session-link__status"'));
  assert.ok(sidebar.includes('session-status-pulse'));
  assert.ok(sidebar.includes('aria-label'));
});
check('AppSidebar 状态点带辅助技术可读的 aria-label/title（不只依赖颜色）', () => {
  assert.ok(sidebar.includes(':aria-label='));
  assert.ok(sidebar.includes('role="img"'));
});
check('F4：reduced-motion 块位于状态灯基础动画声明与 keyframes 之后（覆盖顺序有效）', () => {
  const mediaIdx = sidebar.indexOf('@media (prefers-reduced-motion: reduce)');
  const pulseIdx = sidebar.indexOf('animation: session-status-pulse 1.2s ease-in-out infinite');
  const keyframesEnd = sidebar.indexOf('@keyframes session-status-pulse');
  assert.ok(mediaIdx > -1 && pulseIdx > -1, 'media 与 pulse 声明必须存在');
  assert.ok(mediaIdx > pulseIdx, `media(${mediaIdx}) 应在 pulse 声明(${pulseIdx})之后`);
  assert.ok(mediaIdx > keyframesEnd, `media(${mediaIdx}) 应在 keyframes(${keyframesEnd})之后`);
});
check('sdk-backend 接入 notifier 且只对成功 result 触发', () => {
  assert.ok(sdkBackend.includes("import { notifySessionCompleted } from './session-completion-notifier';"));
  assert.ok(sdkBackend.includes("event.type === 'result' && isSuccessfulCliResult(event)"));
  assert.ok(sdkBackend.includes('notifySessionCompleted(mainWindow, sessionId)'));
});
check('session-completion-notifier 标题用会话标题、正文固定「任务已完成」', () => {
  const notifier = readFileSync(new URL('../src/main/modules/session-completion-notifier.ts', import.meta.url), 'utf8');
  assert.ok(notifier.includes("new Notification({ title: session.name, body: '任务已完成' })"));
  assert.ok(notifier.includes('Notification.isSupported()'));
  assert.ok(notifier.includes('mainWindow.isFocused()'));
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
}
void main();
