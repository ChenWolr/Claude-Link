// tdd-queue-rework-verify.ts
// 队列任务改造（2026-09-03）源码契约：配置开关+分钟制间隔 / 生成中主输入入队 / 回合结束自动执行 /
// 任务级暂停顺延（paused 列）/ 面板 composer 删除。纯源码+纯函数断言，不依赖 Electron 运行时。
import { readFileSync, existsSync } from 'node:fs';
import {
  sanitizeTaskDelayMinutes,
  resolveQueueDelaySeconds,
  DEFAULT_TASK_DELAY_MINUTES,
} from '../src/shared/queue-config';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');
let passed = 0;
let failed = 0;
function check(name: string, ok: boolean): void {
  if (ok) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

// ── 1) shared/queue-config：分钟制清洗与换算（纯函数行为断言）──
{
  check('默认间隔分钟 = 5', DEFAULT_TASK_DELAY_MINUTES === 5);
  check('sanitize(undefined) 回落 5', sanitizeTaskDelayMinutes(undefined) === 5);
  check('sanitize(null) 回落 5', sanitizeTaskDelayMinutes(null) === 5);
  check('sanitize("abc") 回落 5', sanitizeTaskDelayMinutes('abc') === 5);
  check('sanitize(NaN) 回落 5', sanitizeTaskDelayMinutes(NaN) === 5);
  check('sanitize(0) 收敛 1（最低 1 分钟）', sanitizeTaskDelayMinutes(0) === 1);
  check('sanitize(-3) 收敛 1', sanitizeTaskDelayMinutes(-3) === 1);
  check('sanitize(2.9) 向下取整 2', sanitizeTaskDelayMinutes(2.9) === 2);
  check('sanitize(60) 原样 60', sanitizeTaskDelayMinutes(60) === 60);
  check('sanitize(61) 夹取 60', sanitizeTaskDelayMinutes(61) === 60);
  check('sanitize(100) 夹取 60', sanitizeTaskDelayMinutes(100) === 60);
  check('resolve(5) = 300s', resolveQueueDelaySeconds(5) === 300);
  check('resolve(非法) = 300s（清洗后默认）', resolveQueueDelaySeconds('x') === 300);
  check('resolve(0) = 60s（清洗后 1 分钟）', resolveQueueDelaySeconds(0) === 60);
}

// ── 2) 配置字段类型与落盘链（类型/主进程默认/清洗/渲染层默认/持久化字段）──
{
  const configTypes = read('../src/shared/types/config.ts');
  check('AppConfig 有 queueEnabled: boolean', /queueEnabled: boolean/.test(configTypes));
  check('AppConfig 有 taskDelayMinutes: number', /taskDelayMinutes: number/.test(configTypes));

  const cm = read('../src/main/modules/config-manager.ts');
  check('主进程默认 queueEnabled: false', /queueEnabled: false/.test(cm));
  check('主进程默认 taskDelayMinutes 引用常量', /taskDelayMinutes: DEFAULT_TASK_DELAY_MINUTES/.test(cm));
  check('getConfig 清洗 queueEnabled（?? false 兜底）', /queueEnabled: config\.queueEnabled \?\? false/.test(cm));
  check('getConfig 清洗 taskDelayMinutes', /taskDelayMinutes: sanitizeTaskDelayMinutes\(config\.taskDelayMinutes\)/.test(cm));

  const cs = read('../src/renderer/stores/config-store.ts');
  check('渲染层默认 queueEnabled: false', /queueEnabled: false/.test(cs));
  check('渲染层默认 taskDelayMinutes', /taskDelayMinutes: DEFAULT_TASK_DELAY_MINUTES/.test(cs));

  const cp = read('../src/renderer/pages/ConfigPage.vue');
  check('PERSISTED_FIELDS 含 queueEnabled', cp.includes("'queueEnabled'"));
  check('PERSISTED_FIELDS 含 taskDelayMinutes', cp.includes("'taskDelayMinutes'"));
  const idxToggle = cp.indexOf('开启队列任务');
  const idxMinutes = cp.indexOf('队列任务间隔（分钟）');
  check('配置页有「开启队列任务」开关', idxToggle >= 0);
  check('配置页有「队列任务间隔（分钟）」', idxMinutes >= 0);
  check('开关位于间隔配置上方', idxToggle >= 0 && idxMinutes > idxToggle);
  check('配置页移除旧「队列任务间隔（秒）」字段', !cp.includes('队列任务间隔（秒）'));
  check('配置页不再绑定 taskDelaySeconds 输入', !cp.includes('store.config.taskDelaySeconds'));
  check('配置页失焦夹取（clampTaskDelayMinutes）', /function clampTaskDelayMinutes/.test(cp) && cp.includes('@blur="clampTaskDelayMinutes"'));
  check('taskDelaySeconds 遗留字段已整体移除', !configTypes.includes('taskDelaySeconds') && !cm.includes('taskDelaySeconds') && !cs.includes('taskDelaySeconds'));
}

// ── 3) DB 迁移与 task-repo：任务级暂停（paused 列，不动 status CHECK）──
{
  const mig = read('../src/main/database/migrations.ts');
  check('CURRENT_SCHEMA_VERSION = 9', /CURRENT_SCHEMA_VERSION = 9/.test(mig));
  check('V9 补列 paused INTEGER NOT NULL DEFAULT 0', /ADD COLUMN paused INTEGER NOT NULL DEFAULT 0/.test(mig));

  const repo = read('../src/main/database/repositories/task-repo.ts');
  check('getPendingTasks 过滤 paused = 0', /AND paused = 0/.test(repo));
  check('导出 setTaskPaused', /export function setTaskPaused/.test(repo));
  const setPausedBody = repo.slice(repo.indexOf('export function setTaskPaused'));
  check('setTaskPaused 仅对 pending 生效', /status = 'pending'/.test(setPausedBody));
  check('setTaskPaused 零命中返回 null', /changes === 0\) return null/.test(setPausedBody));
  check('toTask 映射 paused 布尔', /paused: Boolean\(row\.paused\)/.test(repo));

  const taskTypes = read('../src/shared/types/task.ts');
  check('Task 类型有 paused: boolean', /paused: boolean/.test(taskTypes));
}

// ── 4) 引擎：分钟制间隔 + 自动启动钩子 + 倒计时空槽收口 ──
{
  const engine = read('../src/main/modules/task-queue-engine.ts');
  const cnt = (engine.match(/startCountdown\(sessionId, mainWindow, resolveQueueDelaySeconds\(config\.taskDelayMinutes\)\)/g) ?? []).length;
  check('两处任务推进均换用分钟制换算（advanceAfterTask + 续写 exit）', cnt >= 2);
  check('引擎不再消费 taskDelaySeconds', !engine.includes('config.taskDelaySeconds'));
  check('导出 maybeAutoStartQueue', /export function maybeAutoStartQueue/.test(engine));
  const autoBody = engine.slice(engine.indexOf('export function maybeAutoStartQueue'), engine.indexOf('export function cancelWaitingIfDrained'));
  check('自动启动守卫：队列非 idle 不接管', /status !== 'idle'/.test(autoBody));
  check('自动启动守卫：开关关闭不启动', /config\.queueEnabled/.test(autoBody));
  check('自动启动守卫：活动回合存在不启动', /getActiveProcess\(sessionId\)/.test(autoBody));
  check('自动启动守卫：无可执行任务不启动', autoBody.includes('getPendingTasks(sessionId)') && /pending\.length === 0\) return/.test(autoBody));
  check('导出 cancelWaitingIfDrained', /export function cancelWaitingIfDrained/.test(engine));
  check('续写链路 continueWithUserMessage 保留', /export async function continueWithUserMessage/.test(engine));
}

// ── 5) IPC + preload：TASK_SET_PAUSED + 自动启动挂点 ──
{
  const ipcTypes = read('../src/shared/types/ipc.ts');
  check('ipc.ts 有 TASK_SET_PAUSED 通道', /TASK_SET_PAUSED: 'task:setPaused'/.test(ipcTypes));
  check('QUEUE_USER_MESSAGE 通道保留（续写链路不动）', /QUEUE_USER_MESSAGE/.test(ipcTypes));

  const handlers = read('../src/main/ipc-handlers.ts');
  const chatSendBody = handlers.slice(handlers.indexOf('IPC_CHANNELS.CHAT_SEND'), handlers.indexOf('IPC_CHANNELS.CHAT_ABORT'));
  check('CHAT_SEND 回合 exit 挂自动启动钩子', /child\.on\('exit'[\s\S]*?maybeAutoStartQueue\(sessionId, mainWindow\)/.test(chatSendBody));
  check('注册 TASK_SET_PAUSED handler', handlers.includes('IPC_CHANNELS.TASK_SET_PAUSED'));
  const setPausedHandler = handlers.slice(handlers.indexOf('IPC_CHANNELS.TASK_SET_PAUSED'));
  check('暂停后无可执行任务立即收口倒计时', /cancelWaitingIfDrained/.test(setPausedHandler));
  check('恢复任务触发自动调���', /maybeAutoStartQueue/.test(setPausedHandler));
  const retryHandler = handlers.slice(handlers.indexOf('IPC_CHANNELS.TASK_RETRY'));
  check('TASK_RETRY 触发自动调度', /maybeAutoStartQueue/.test(retryHandler));
  check('QUEUE_USER_MESSAGE handler 保留', handlers.includes('IPC_CHANNELS.QUEUE_USER_MESSAGE'));

  const preload = read('../src/preload/api.ts');
  check('preload 暴露 setTaskPaused', /setTaskPaused: \(taskId: string, paused: boolean\) => Promise<Task>/.test(preload));
  check('preload setTaskPaused 接线 TASK_SET_PAUSED', /IPC_CHANNELS\.TASK_SET_PAUSED/.test(preload));
  check('startQueue 返回 QueueState（供 store 回写 sessionId）', /startQueue: \(sessionId: string\) => Promise<QueueState>/.test(preload));
}

// ── 6) 渲染层：ChatPage 解锁 + task-store 回写 + 面板删 composer + TaskItem 暂停 ──
{
  const chatPage = read('../src/renderer/pages/ChatPage.vue');
  check('ChatInput 禁用解绑为 sending && !queueEnabled', chatPage.includes(':disabled="sending && !queueEnabled"'));
  check('ChatPage 有 queueEnabled computed（读配置 store）', /const queueEnabled = computed/.test(chatPage) && /useConfigStore/.test(chatPage));
  check('waiting→queueUserMessage 三路路由保留', chatPage.includes('taskStore.queueUserMessage(sessionId, payload)'));
  check('running/continuing→addTask 路由保留', chatPage.includes('taskStore.addTask(sessionId, payload)'));
  check('生成中入队判据用 sending+queueEnabled（P1 修复：不依赖 queueState.sessionId）', /else if \(sending\.value && queueEnabled\.value\)/.test(chatPage));

  const ts = read('../src/renderer/stores/task-store.ts');
  check('startQueue 回写 queueState', /this\.queueState = await window\.claudeLink\.startQueue/.test(ts));
  check('handleQueueEvent 回写 sessionId', /this\.queueState\.sessionId = payload\.sessionId/.test(ts));
  check('handleQueueEvent 处理 countdown_started', /case 'countdown_started'/.test(ts));
  check('task-store 有 setTaskPaused action', /async setTaskPaused/.test(ts));

  const panel = read('../src/renderer/components/task/TaskQueuePanel.vue');
  check('面板删除 composer 容器', !panel.includes('task-panel__add'));
  check('面板不再引用任务草稿 store', !panel.includes('useTaskDraftStore'));
  check('面板不再有附件选择入口', !panel.includes('pickTaskAttachments'));
  check('面板 TaskItem 接 pause/resume 事件', panel.includes('@pause="handlePauseTask"') && panel.includes('@resume="handleResumeTask"'));
  const dd = panel.slice(panel.indexOf('const dragDisabled'), panel.indexOf('function isSubAgentGroupExpanded'));
  check('拖拽在 waiting 期间放开（仅 running/continuing 禁用）', !dd.includes("'waiting'"));

  const item = read('../src/renderer/components/task/TaskItem.vue');
  check('TaskItem 声明 pause/resume emits', /pause: \[taskId: string\]/.test(item) && /resume: \[taskId: string\]/.test(item));
  check('TaskItem 有暂停/恢复按钮', item.includes('>暂停</button>') && item.includes('>恢复</button>'));
  check('TaskItem 头部可点击查看详情', /task-item__header[\s\S]{0,120}@click="expanded = !expanded"/.test(item));
  check('TaskItem 已暂停标识', /已暂停/.test(item));

  check('task-draft-store 文件已删除', !existsSync(new URL('../src/renderer/stores/task-draft-store.ts', import.meta.url)));
}

// ── 7) 挂载：selftest:static 链尾 ──
{
  const pkg = JSON.parse(read('../package.json'));
  check('selftest:static 挂载 tdd-queue-rework-verify', pkg.scripts['selftest:static'].includes('tdd-queue-rework-verify'));
}

console.log(`tdd-queue-rework-verify: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
