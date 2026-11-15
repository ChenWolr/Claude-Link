// tdd-queue-tasks-sync-verify.ts
// UI13-P1「队列任务列表跨端同步」契约（docs/plans/2026-11-14-ui13-batch/03-test-cases.md P1 节，
// T1-A~I 九条；实现方案以同目录 01-impl-details.md P1 节为准）。
// 覆盖：①协议扩展（QueueEventType 含 tasks_changed）；②六个 CRUD handler 成功路径广播接线；
// ③载荷形状（sessionId + type + 全量 pending 数组）；④渲染层消费（isActive 过滤 + Array.isArray
// 守卫 + 全量整替）；⑤既有引擎语义回归门（内联 spawn v3 脚本）；⑥双端帧序一致性（末帧胜、
// 幂等替换无空帧）；⑦网页断线重连补拉（realign 序列 loadOverview）。
// 运行：npx tsx scripts/tdd-queue-tasks-sync-verify.ts（退出码 0 = 全绿）。
//
// 转写申报（T1-C/T1-G 载荷行为直测降级说明）：broadcastTasksChanged 的 DB 依赖面
// （task-repo → connection → utils/paths 经 electron app.getPath 取库路径）在 tsx/Node 下
// 不可 stub（模块命名空间在引擎加载时定型，patch 不传导；无 electron 运行时无库路径）——
// 按派发词许可退化为「结构钉 + 渲染层 store 消费面行为直测」；帧级端到端证据由 P12
// W-queue-sync E2E 背书（03 统计表口径）。
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { setActivePinia, createPinia } from 'pinia';
import type { QueueEventPayload } from '../src/shared/types/ipc';

const repoRoot = path.resolve(new URL('.', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), '..');
const read = (rel: string): string => readFileSync(path.join(repoRoot, rel), 'utf8');

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    passed += 1;
    console.log(`  PASS ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  FAIL ${name} — ${(e instanceof Error ? e.message : String(e)).slice(0, 240)}`);
  }
}
function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const ipcSource = read('src/shared/types/ipc.ts');
const handlersSource = read('src/main/ipc-handlers.ts');
const engineSource = read('src/main/modules/task-queue-engine.ts');
const storeSource = read('src/renderer/stores/task-store.ts');
const bridgeSource = read('src/renderer/web/web-bridge.ts');

/** 截取 source 中 signature 起点的顶层函数体（到下一个顶层 function/export）。 */
function fnBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  const nextExport = source.indexOf('\nexport ', start + 1);
  const candidates = [next, nextExport].filter((i) => i > start);
  const end = candidates.length ? Math.min(...candidates) : source.length;
  return source.slice(start, end);
}

/** 截取 ipc-handlers.ts 中某 IPC 通道 handler 的注册体（到下一个 regInvokeHandler）。 */
function handlerBody(source: string, channelKey: string): string {
  const start = source.indexOf(`regInvokeHandler(IPC_CHANNELS.${channelKey},`);
  if (start < 0) return '';
  const next = source.indexOf('regInvokeHandler(IPC_CHANNELS.', start + 10);
  return source.slice(start, next < 0 ? source.length : next);
}

// ── T1-A：协议扩展——QueueEventType 联合含 'tasks_changed'（结构钉）──
check('T1-A QueueEventType 联合含 tasks_changed 字面量', () => {
  const start = ipcSource.indexOf('export type QueueEventType');
  assert(start > -1, '未定位 QueueEventType 定义');
  const end = ipcSource.indexOf(';', start);
  assert(end > start, '未定位 QueueEventType 联合终止');
  const union = ipcSource.slice(start, end);
  assert(union.includes("'tasks_changed'"), "QueueEventType 联合缺 'tasks_changed'");
});

// ── T1-B：六个 CRUD handler 成功路径广播接线（结构钉）──
check('T1-B 六个任务 handler 成功路径均有 tasks_changed 广播（DB 写后、失败路径零调用）', () => {
  const spec: Array<{ ch: string; writeAnchor: string }> = [
    { ch: 'TASK_ADD', writeAnchor: 'createTaskWithAttachments(' },
    { ch: 'TASK_REMOVE', writeAnchor: 'cleanupDetachedAttachments(' },
    { ch: 'TASK_REORDER', writeAnchor: 'reorderTasks(' },
    { ch: 'TASK_SET_PAUSED', writeAnchor: 'setTaskPaused(' },
    { ch: 'TASK_RUN_NOW', writeAnchor: 'runTaskNow(' },
    { ch: 'QUEUE_RESUME_ALL', writeAnchor: 'resumeAllTasks(' },
  ];
  for (const { ch, writeAnchor } of spec) {
    const body = handlerBody(handlersSource, ch);
    assert(body.length > 0, `${ch} handler 未定位`);
    const bIdx = body.indexOf('broadcastTasksChanged(');
    assert(bIdx > -1, `${ch} 成功路径缺 broadcastTasksChanged 调用`);
    const wIdx = body.indexOf(writeAnchor);
    assert(wIdx > -1, `${ch} 未定位 DB 写锚点 ${writeAnchor}`);
    assert(bIdx > wIdx, `${ch} 广播先于 DB 写（携带陈旧列表）`);
    const throwIdx = body.indexOf('throw');
    if (throwIdx > -1) {
      assert(throwIdx < bIdx, `${ch} 失败路径之后仍有广播（抛错分支被广播）`);
    }
  }
});

// ── T1-C：载荷形状（结构钉：广播源 + 通道 + 全量 pending 过滤）──
check("T1-C broadcastTasksChanged 载荷形状（queue:event / sessionId / 'tasks_changed' / 全量 pending）", () => {
  const fn = fnBody(engineSource, 'export function broadcastTasksChanged(');
  assert(fn.length > 0, 'task-queue-engine 未导出 broadcastTasksChanged');
  assert(fn.includes('emitQueueEvent('), 'broadcastTasksChanged 未走 emitQueueEvent 单发射源');
  assert(fn.includes("'tasks_changed'"), "载荷缺 type: 'tasks_changed'");
  assert(fn.includes('getTasksBySession('), '载荷未取该会话全量任务（getTasksBySession）');
  assert(fn.includes("filter((t) => t.status === 'pending')"), '载荷未过滤 pending（非全量 pending 列表）');
  // 通道面：engine 的 emitQueueEvent 收口 push-bus QUEUE_EVENT（'queue:event'）。
  const emitFn = fnBody(engineSource, 'function emitQueueEvent(');
  assert(emitFn.includes('pushToMainWindow(IPC_CHANNELS.QUEUE_EVENT'), 'emitQueueEvent 未收口 QUEUE_EVENT 通道');
  // 载荷接口面：QueueEventPayload 含 sessionId + type + data。
  const payloadStart = ipcSource.indexOf('export interface QueueEventPayload');
  const payloadEnd = ipcSource.indexOf('}', payloadStart);
  const payloadBlock = ipcSource.slice(payloadStart, payloadEnd);
  assert(payloadBlock.includes('sessionId: string;'), 'QueueEventPayload 缺 sessionId');
  assert(payloadBlock.includes('type: QueueEventType;'), 'QueueEventPayload 缺 type');
  assert(payloadBlock.includes('data?: Record<string, unknown>;'), 'QueueEventPayload 缺 data');
});

// ── T1-D：渲染层消费——tasks_changed case + 全量幂等整替（结构钉 + 行为直测）──
check('T1-D handleQueueEvent 含 tasks_changed case 且全量整替（非增量合并）', () => {
  assert(storeSource.includes("case 'tasks_changed':"), 'task-store 缺 tasks_changed case');
  const body = fnBody(storeSource, "case 'tasks_changed':");
  assert(body.length > 0, 'tasks_changed case 体未截取');
  assert(body.includes('this.tasks = tasks;'), 'case 未以载荷 tasks 整体替换 this.tasks');
  assert(!/this\.tasks\.(push|concat|splice|unshift)/.test(body), 'case 含增量合并（push/concat/splice）形态');
  assert(body.includes('Array.isArray(tasks)'), 'case 缺 Array.isArray 守卫');
});

// ── T1-E：isActive 会话过滤（结构钉 + 行为直测；既有 state_changed 过滤同测不破）──
check('T1-E tasks_changed 分支沿用 isActive 过滤（非当前会话帧不污染）', () => {
  const body = fnBody(storeSource, "case 'tasks_changed':");
  assert(body.includes('if (!isActive) break;'), 'tasks_changed case 内缺 isActive 守卫');
  // 既有 state_changed 过滤回归钉（不因本点回退）。
  const stateBody = fnBody(storeSource, "case 'state_changed':");
  assert(stateBody.includes('if (!isActive) break;'), '既有 state_changed isActive 过滤被破坏');
});

// ── 行为直测底座：pinia store + 活动会话注入 ──
interface TaskLike {
  id: string;
  status: string;
  paused: boolean;
}
function frame(sessionId: string, tasks: unknown, type = 'tasks_changed'): QueueEventPayload {
  return {
    sessionId,
    type,
    taskId: undefined,
    data: { tasks },
  } as unknown as QueueEventPayload;
}

// 动态 import 保持与既有 tdd-* 脚本同形（tsx CJS 互操作下取 default 命名空间）。
async function setupStores(): Promise<{
  taskStore: { tasks: TaskLike[]; handleQueueEvent: (p: QueueEventPayload) => void; queueState: Record<string, unknown> };
}> {
  const taskMod = (await import('../src/renderer/stores/task-store')) as unknown as Record<string, unknown>;
  const taskExports = ((taskMod.default ?? taskMod) as Record<string, unknown>).useTaskStore as () => never;
  const sessionMod = (await import('../src/renderer/stores/session-store')) as unknown as Record<string, unknown>;
  const sessionExports = ((sessionMod.default ?? sessionMod) as Record<string, unknown>).useSessionStore as () => never;
  setActivePinia(createPinia());
  type SessionStore = { activeSession: unknown };
  const sessionStore = sessionExports() as unknown as SessionStore;
  sessionStore.activeSession = { id: 's1' };
  type TaskStore = { tasks: TaskLike[]; handleQueueEvent: (p: QueueEventPayload) => void; queueState: Record<string, unknown> };
  const taskStore = taskExports() as unknown as TaskStore;
  return { taskStore };
}

const json = (v: unknown): string => JSON.stringify(v);

async function behaviorChecks(): Promise<void> {
  const { taskStore } = await setupStores();
  const A: TaskLike = { id: 't-a', status: 'pending', paused: false };
  const B: TaskLike = { id: 't-b', status: 'pending', paused: true };

  // ── T1-D 行为面：载荷整替 ──
  check('T1-D 行为：tasks_changed 帧到达后 tasks 与载荷全量深度相等', () => {
    taskStore.handleQueueEvent(frame('s1', [A, B]));
    assert(json(taskStore.tasks) === json([A, B]), `整替失败：${json(taskStore.tasks)}`);
  });

  // ── T1-E 行为面：非活动会话帧忽略 + 既有 state_changed 过滤不破 ──
  check('T1-E 行为：非当前会话 tasks_changed 帧被忽略；非当前会话 state_changed 亦被过滤', () => {
    const X: TaskLike = { id: 't-x', status: 'pending', paused: false };
    taskStore.handleQueueEvent(frame('s2', [X]));
    assert(json(taskStore.tasks) === json([A, B]), '非活动会话帧污染当前 tasks');
    const other = frame('s2', undefined, 'state_changed');
    (other.data as Record<string, unknown>).state = { sessionId: 's2', status: 'running' };
    taskStore.handleQueueEvent(other);
    assert(
      json(taskStore.queueState) !== json({ sessionId: 's2', status: 'running' }),
      '非活动会话 state_changed 污染当前 queueState（既有过滤回退）',
    );
  });

  // ── T1-G 行为面：末帧胜（并发快照序列收敛，无旧帧复活）──
  check('T1-G 行为：连续 add→remove 快照帧后末态与末帧深度相等（末帧胜）', () => {
    taskStore.handleQueueEvent(frame('s1', [A, B]));
    taskStore.handleQueueEvent(frame('s1', [B]));
    assert(json(taskStore.tasks) === json([B]), `末态应与末帧相等：${json(taskStore.tasks)}`);
    assert(taskStore.tasks.length === 1, `末态长度应为 1：${taskStore.tasks.length}`);
    assert(taskStore.tasks.every((t) => t.id !== 't-a'), '已删任务复活（旧帧污染）');
  });

  // ── T1-H 行为面：发起端幂等替换无空帧 ──
  check('T1-H 行为：同一载荷连续投递两次幂等替换，长度不出现中间 0 帧', () => {
    const payload: TaskLike[] = [A, B];
    taskStore.handleQueueEvent(frame('s1', payload));
    const lenAfterFirst = taskStore.tasks.length;
    taskStore.handleQueueEvent(frame('s1', payload));
    const lenAfterSecond = taskStore.tasks.length;
    assert(json(taskStore.tasks) === json(payload), '第二次替换后与载荷不等');
    assert(lenAfterFirst === 2 && lenAfterSecond === 2, `长度出现中间态：${lenAfterFirst}→${lenAfterSecond}`);
    assert(lenAfterSecond > 0, '出现空帧（先清空再填充形态）');
  });

  // ── T1-C 补充行为面（消费侧形状守卫）：非数组 tasks 载荷被 Array.isArray 守卫拒绝 ──
  check('T1-C 行为：tasks 非数组载荷不污染当前列表（Array.isArray 守卫）', () => {
    taskStore.handleQueueEvent(frame('s1', { not: 'an array' }));
    assert(json(taskStore.tasks) === json([A, B]), '非数组载荷替换了 tasks（守卫缺失）');
    taskStore.handleQueueEvent(frame('s1', []));
    assert(taskStore.tasks.length === 0, '空数组载荷应整替为空（length 守卫误吞）');
    // 还原状态供后续检查（无）。
  });
}

// ── T1-I：网页断线重连补拉（结构钉）──
check('T1-I realign 序列在 switchSession 重入后接当前会话队列重拉（loadOverview）', () => {
  const body = fnBody(bridgeSource, 'async function runRealignSequence(');
  assert(body.length > 0, 'web-bridge runRealignSequence 未定位');
  const switchIdx = body.indexOf('switchSession(');
  assert(switchIdx > -1, 'realign 序列缺 switchSession 重入');
  assert(body.includes('task-store'), 'realign 序列未引用 task-store');
  const loadIdx = body.indexOf('loadOverview(');
  assert(loadIdx > -1, 'realign 序列缺队列重拉（loadOverview）');
  assert(loadIdx > switchIdx, '队列重拉未挂在 switchSession 重入之后');
  assert(body.slice(loadIdx - 200, loadIdx).includes('activeSession'), '队列重拉缺活动会话判据');
});

// ── T1-F：既有引擎事件语义回归门（内联 spawn v3 脚本）──
check('T1-F 既有引擎语义回归门：tdd-queue-semantics-v3-verify.ts 退出码 0', () => {
  const r = spawnSync('npx', ['tsx', 'scripts/tdd-queue-semantics-v3-verify.ts'], {
    cwd: repoRoot,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  });
  if (r.status !== 0) {
    throw new Error(`v3 脚本退出码 ${r.status}：${String(r.stderr).slice(0, 200)}`);
  }
});

void behaviorChecks()
  .then(() => {
    console.log(`\n[tdd-queue-tasks-sync] passed=${passed} failed=${failed}`);
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((e) => {
    console.error(`[tdd-queue-tasks-sync] 运行异常：${e instanceof Error ? e.message : String(e)}`);
    console.log(`\n[tdd-queue-tasks-sync] passed=${passed} failed=${failed + 1}`);
    process.exit(1);
  });
