<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { useTaskStore } from '../../stores/task-store';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { useTaskQueue } from '../../composables/use-task-queue';
import { aggregateSubAgentGroups, buildTitleByToolUseId, formatDuration, type SubAgentGroup } from '../../utils/subagent-groups';
import { useNow } from '../../composables/use-now';
import TaskItem from './TaskItem.vue';
import ProcessGroup from '../chat/ProcessGroup.vue';
import MessageBubble from '../chat/MessageBubble.vue';
import ThinkingBlock from '../chat/ThinkingBlock.vue';
import ChangesPanel from '../changes/ChangesPanel.vue';
import { useChangesStore } from '../../stores/changes-store';
import { openDiffDialog } from '../../composables/useDiffDialog';
import ClaudePlanCard from './ClaudePlanCard.vue';
import { useClaudePlanStore } from '../../stores/claude-plan-store';

const taskStore = useTaskStore();
const sessionStore = useSessionStore();
const interactionStore = useInteractionStore();
const changesStore = useChangesStore();
const planStore = useClaudePlanStore();
const changesCount = computed(() => changesStore.changedCount);
const { startListening } = useTaskQueue();

const expandedGroups = ref<Set<string>>(new Set());
// 问题 7：用户显式折叠的组（优先级最高，运行中也保持收起）。
const collapsedGroups = ref<Set<string>>(new Set());
// 问题 6：客户端实时计时——sending 期间每 100ms 跳动，子 Agent 运行中耗时实时更新。
const { now } = useNow(() => sessionStore.sending);
// 问题 4（彻底修复）兜底：仅当回合结束却「未完成」（未收到父 Task 工具 tool_result，如中断/异常端点）
// 时，才把该组的 live 最终值快照下来冻结——避免回退到偏短的 createdAt 首尾差。正常完成的组用
// frozenSeconds（= 完成 tool_result.createdAt − startMs，真实跨度），不走这里。下一回合清空防串扰。
const lastLiveByGroup = ref<Record<string, number>>({});
// Bug2：取某子 agent 的实时思考文本（stream_event thinking_delta 按 parentToolUseId 路由来的）。
// 思考中在组体顶部显 ThinkingBlock；子 agent message 落库后由 store 清空，回落到落库思考气泡。
function subAgentThinkingText(agentId: string): string {
  return sessionStore.activeSubAgentThinking[agentId] ?? '';
}
// 计时展示：已完成组 → 真实完成跨度（frozenSeconds）；运行中组 → 客户端实时跳动；
// 回合结束但未完成（中断）→ 兜底冻结 live。逐组判定，并发子 Agent 各自在自身完成时停表，互不串扰。
function subAgentDurationText(g: SubAgentGroup): string {
  // 已完成（父 Task 工具 tool_result 已到达）：真实完成跨度，稳定且准确。
  if (g.completed && g.frozenSeconds != null) return formatDuration(g.frozenSeconds);
  // 运行中（回合 sending 且未完成）：客户端实时跳动到自身完成。
  if (sessionStore.sending && g.startMs) {
    const live = (now.value - g.startMs) / 1000;
    return formatDuration(Math.max(live, g.frozenSeconds ?? 0));
  }
  // 回合结束但未收到父 tool_result（中断/异常）：用冻结的 live 最终值，避免回退偏短。
  const frozenLive = lastLiveByGroup.value[g.parentAgentId];
  if (frozenLive != null) return formatDuration(frozenLive);
  return g.durationText;
}
let cleanup: (() => void) | null = null;

const queueStatus = computed(() => taskStore.queueState.status);

// C：后台任务（task_*）列表与计数。
const backgroundTaskList = computed(() => Object.values(sessionStore.backgroundTasks));
const backgroundTaskCount = computed(() => backgroundTaskList.value.length);
function taskIcon(taskType?: string): string {
  if (taskType === 'local_bash') return '⌨️';
  if (taskType === 'local_agent' || taskType === 'remote_agent') return '🤖';
  return '🔁';
}

// Queue running → disable drag reorder（waiting 倒计时期间放开：执行时按 sort_order 现取队首）
const dragDisabled = computed(() => queueStatus.value === 'running' || queueStatus.value === 'continuing');

function isSubAgentGroupExpanded(id: string, running: boolean): boolean {
  // 问题 7：用户显式折叠优先——即使运行中也保持收起。
  if (collapsedGroups.value.has(id)) return false;
  return expandedGroups.value.has(id) || running;
}

function subAgentStatusText(g: SubAgentGroup): string {
  if (g.running) return '进行中';
  return g.completed ? '已完成' : '未完成';
}

function toggleSubAgentGroup(id: string, running: boolean): void {
  const open = isSubAgentGroupExpanded(id, running);
  const nextExp = new Set(expandedGroups.value);
  const nextCol = new Set(collapsedGroups.value);
  if (open) {
    nextExp.delete(id);
    nextCol.add(id);
  } else {
    nextCol.delete(id);
    nextExp.add(id);
  }
  expandedGroups.value = nextExp;
  collapsedGroups.value = nextCol;
}

// 子 Agent 分组：纯逻辑抽到 subagent-groups.ts（由 tdd-subagent-verify.ts 行为测试覆盖）。
// 方案 A：只聚合 turnStartIndex 之后的子 agent 消息（保留 DB 历史，仅控制 Tab 显示当前回合）。
const subAgentGroups = computed(() =>
  aggregateSubAgentGroups(sessionStore.messages, {
    turnStartIndex: sessionStore.turnStartIndex,
    sending: sessionStore.sending,
    // 子 Agent Tab 没有对应的全局流式预览；不能用主流程 streamingContent/thinking 去重，
    // 否则会把子 Agent 已落库的错误/文本隐藏，只剩 running dots。
    hideText: false,
    hideThinking: false,
    toolProgress: sessionStore.toolProgress,
    titleByToolUseId: buildTitleByToolUseId(sessionStore.messages),
    // Bug2：实时思考快照——让尚无落库消息的子 agent 也建组，思考中即可见 ThinkingBlock。
    liveThinkingByAgent: sessionStore.activeSubAgentThinking,
  }),
);

// 问题 4 watch（须在 subAgentGroups 定义之后注册，回调里读取其值）：回合 sending 由 true→false
// 瞬间，仅对「未完成」的组（未收到父 tool_result，如中断/异常）快照 live 最终值。已完成的组用
// frozenSeconds，无需快照。sending 重新 true 时清空，防跨回合串扰。
watch(
  () => sessionStore.sending,
  (sending) => {
    if (sending) {
      lastLiveByGroup.value = {};
      return;
    }
    const end = Date.now();
    const snap: Record<string, number> = {};
    for (const g of subAgentGroups.value) {
      if (g.completed || !g.startMs) continue;
      const live = (end - g.startMs) / 1000;
      snap[g.parentAgentId] = Math.max(live, g.frozenSeconds ?? 0);
    }
    lastLiveByGroup.value = snap;
  },
);

// 主流程锚点点击 → 切到子Agent Tab 并定位：滚动 + 短暂高亮目标组。
watch(
  () => sessionStore.focusedSubAgentId,
  (id) => {
    if (!id) return;
    nextTick(() => {
      const el = document.getElementById(`subagent-${id}`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        el.classList.add('subagent-group--focused');
        setTimeout(() => el.classList.remove('subagent-group--focused'), 1600);
      }
      sessionStore.clearFocusedSubAgent();
    });
  },
);

// —— 方案 B：右侧活动栏（图标轨 + 总览/筛选）——
// rightTab 扩展 'all'（默认四类总览同屏）；点轨按钮切单类，再点同类回 all。
type RightFilter = 'all' | 'plan' | 'queue' | 'subagent' | 'background' | 'changes';
const isAll = computed(() => sessionStore.rightTab === 'all');

function setFilter(f: RightFilter): void {
  // 折叠态下点 rail 分类图标 → 先展开总览再切筛选，避免"点了没反应"。
  if (sessionStore.overviewCollapsed) sessionStore.overviewCollapsed = false;
  // 再点当前激活的同类 → 回 all（与预览一致）；点「全部」恒回 all。
  if (f === 'all' || sessionStore.rightTab === f) {
    sessionStore.setRightTab('all');
  } else {
    sessionStore.setRightTab(f);
  }
}

const headTitle = computed(() => {
  switch (sessionStore.rightTab) {
    case 'plan': return 'Claude 计划';
    case 'queue': return '排队任务';
    case 'subagent': return '子Agent';
    case 'background': return '后台任务';
    case 'changes': return '改动';
    default: return '活动总览';
  }
});
const headEyebrow = computed(() => {
  switch (sessionStore.rightTab) {
    case 'plan': return 'Plan';
    case 'queue': return 'Queue';
    case 'subagent': return 'Sub-agents';
    case 'background': return 'Background';
    case 'changes': return 'Changes';
    default: return 'Overview';
  }
});

// 运行中的子 Agent 数（指标强调 + 轨 badge live 态）。
const runningSubAgentCount = computed(() => subAgentGroups.value.filter((g) => g.running).length);

// Claude 计划指标：TodoWrite + Task 完成数/总数。
const planTodoCount = computed(() => planStore.activePlan?.todos.length ?? 0);
const planTodoCompleted = computed(() => planStore.activePlan?.todos.filter((t) => t.status === 'completed').length ?? 0);
const planTaskCount = computed(() => planStore.activePlan?.tasks.length ?? 0);
const planTaskCompleted = computed(() => planStore.activePlan?.tasks.filter((t) => t.status === 'completed').length ?? 0);
const planTotalCount = computed(() => planTodoCount.value + planTaskCount.value);
// F10: 合计完成数（todos + tasks），用于指标/徽章一致
const planDone = computed(() => planTodoCompleted.value + planTaskCompleted.value);
const planMetric = computed<{ text: string; active: boolean }>(() => {
  const n = planTotalCount.value;
  if (n === 0) return { text: '无', active: false };
  return { text: `${planDone.value}/${n}`, active: planDone.value < n };
});

// 状态指标条（§4）：四格始终占位，标签与值分行，禁用 · 串句换行。
const queueMetric = computed<{ text: string; active: boolean }>(() => {
  switch (queueStatus.value) {
    case 'running': return { text: '执行中', active: true };
    case 'waiting': {
      const cd = taskStore.queueState.countdownRemaining;
      return { text: cd > 0 ? `等待 ${cd}s` : '等待中', active: true };
    }
    case 'paused': return { text: '已暂停', active: true };
    case 'continuing': return { text: '续写中', active: true };
    default: return { text: '空闲', active: false };
  }
});
const subAgentMetric = computed<{ text: string; active: boolean }>(() => {
  const total = subAgentGroups.value.length;
  if (!total) return { text: '无', active: false };
  const running = runningSubAgentCount.value;
  return { text: running > 0 ? `${running} 运行中` : `${total} 组`, active: running > 0 };
});
const backgroundMetric = computed<{ text: string; active: boolean }>(() => {
  const n = backgroundTaskCount.value;
  return { text: n > 0 ? `${n} 个任务` : '无', active: n > 0 };
});
const changesMetric = computed<{ text: string; active: boolean }>(() => {
  const n = changesCount.value;
  return { text: n > 0 ? `${n} 个文件` : '无', active: n > 0 };
});

// 总览改动摘要：复用 changesStore；单类才挂载完整 ChangesPanel。
const CHANGES_SUMMARY_CAP = 5;
const changesSummaryFiles = computed(() => changesStore.files.slice(0, CHANGES_SUMMARY_CAP));
function changeStatusLabel(status: string): string {
  const map: Record<string, string> = { M: '改', A: '增', D: '删', R: '移', '??': '新', U: '冲' };
  return map[status] ?? status;
}
// 总览摘要行点击 → 弹出 DiffDialog（与 ChangesPanel 行点击走同一弹窗）。
function openSummaryFile(path: string, e: Event): void {
  openDiffDialog(path, e.currentTarget instanceof HTMLElement ? e.currentTarget : null);
}

onMounted(() => {
  cleanup = startListening();
  loadTasks();
  // 面板常驻（默认 all 总览），改动数据须随挂载即拉，供轨 badge / 指标格 / 总览摘要。
  void changesStore.refresh();
});

onUnmounted(() => {
  cleanup?.();
});

function loadTasks() {
  if (sessionStore.activeSession) {
    taskStore.loadTasks(sessionStore.activeSession.id);
  }
}

// Task 7B：构造完整 ChatSendPayload（text + attachmentIds + clientMessageId）；成功才清草稿，失败保留。
// 任务入队已改由 ChatPage 生成中发送承担（面板 composer 已删），以下三个 composer 相关函数移除。

async function handleRetry(taskId: string) {
  await taskStore.retryTask(taskId);
}

async function handleStart() {
  if (!sessionStore.activeSession) return;
  if (!sessionStore.activeSession.workingDir) {
    await interactionStore.requestConfirm({
      title: '提示',
      message: '请先在底部选择「工作空间」目录，再启动任务队列。',
      confirmText: '知道了',
      mode: 'alert',
    });
    return;
  }
  await taskStore.startQueue(sessionStore.activeSession.id);
}

async function handlePause() {
  if (!sessionStore.activeSession) return;
  await taskStore.pauseQueue(sessionStore.activeSession.id);
}

async function handleResume() {
  if (!sessionStore.activeSession) return;
  if (!sessionStore.activeSession.workingDir) {
    await interactionStore.requestConfirm({
      title: '提示',
      message: '请先在底部选择「工作空间」目录，再继续任务队列。',
      confirmText: '知道了',
      mode: 'alert',
    });
    return;
  }
  await taskStore.resumeQueue(sessionStore.activeSession.id);
}

async function handleDelete(taskId: string) {
  await taskStore.removeTask(taskId);
}

async function handleInterrupt(taskId: string) {
  await taskStore.interruptTask(taskId);
}

async function handlePauseTask(taskId: string) {
  await taskStore.setTaskPaused(taskId, true);
}

async function handleResumeTask(taskId: string) {
  await taskStore.setTaskPaused(taskId, false);
}

function handleDragReorder() {
  if (!sessionStore.activeSession) return;
  const taskIds = taskStore.tasks.map((t) => t.id);
  taskStore.reorderTasks(sessionStore.activeSession.id, taskIds);
}
</script>

<template>
  <aside class="task-panel" :class="{ 'task-panel--collapsed': sessionStore.overviewCollapsed }">
    <div class="task-panel__main">
      <!-- 顶栏：标题随筛选变化 + 清除筛选（仅非总览） -->
      <header class="task-panel__head">
        <div class="task-panel__heading">
          <p class="eyebrow">{{ headEyebrow }}</p>
          <h2>{{ headTitle }}</h2>
        </div>
        <button v-if="!isAll" type="button" class="clear-pill" title="回到全部总览" @click="setFilter('all')">清除筛选</button>
      </header>

      <!-- 状态指标条（2×N 网格，禁用 · 串句换行） -->
      <div class="status-metrics">
        <button type="button" class="status-metric" :class="{ 'status-metric--active': planMetric.active }" :title="`只看计划（${planMetric.text}）`" @click="setFilter('plan')">
          <span class="status-metric__label">计划</span>
          <span class="status-metric__value">{{ planMetric.text }}</span>
        </button>
        <button type="button" class="status-metric" :class="{ 'status-metric--active': queueMetric.active }" :title="`只看队列（${queueMetric.text}）`" @click="setFilter('queue')">
          <span class="status-metric__label">队列</span>
          <span class="status-metric__value">{{ queueMetric.text }}</span>
        </button>
        <button type="button" class="status-metric" :class="{ 'status-metric--active': subAgentMetric.active }" :title="`只看子Agent（${subAgentMetric.text}）`" @click="setFilter('subagent')">
          <span class="status-metric__label">子Agent</span>
          <span class="status-metric__value">{{ subAgentMetric.text }}</span>
        </button>
        <button type="button" class="status-metric" :class="{ 'status-metric--active': backgroundMetric.active }" :title="`只看后台（${backgroundMetric.text}）`" @click="setFilter('background')">
          <span class="status-metric__label">后台</span>
          <span class="status-metric__value">{{ backgroundMetric.text }}</span>
        </button>
        <button type="button" class="status-metric" :class="{ 'status-metric--active': changesMetric.active }" :title="`只看改动（${changesMetric.text}）`" @click="setFilter('changes')">
          <span class="status-metric__label">改动</span>
          <span class="status-metric__value">{{ changesMetric.text }}</span>
        </button>
      </div>

      <!-- 排队控制条 + 倒计时（仅 queue 筛选） -->
      <div v-if="sessionStore.rightTab === 'queue'" class="queue-bar">
        <div class="task-panel__controls">
          <button v-if="queueStatus === 'idle' || queueStatus === 'paused'" type="button" class="btn btn--primary" title="开始执行队列中的任务" @click="handleStart">开始</button>
          <button v-if="queueStatus === 'running' || queueStatus === 'waiting' || queueStatus === 'continuing'" type="button" class="btn btn--warn" title="暂停倒计时与队列执行" @click="handlePause">暂停</button>
          <button v-if="queueStatus === 'paused'" type="button" class="btn btn--primary" title="恢复队列执行" @click="handleResume">恢复</button>
        </div>
        <div v-if="queueStatus === 'waiting' && taskStore.queueState.countdownRemaining > 0" class="countdown">
          任务已完成，{{ taskStore.queueState.countdownRemaining }}s 内可继续追加指令
        </div>
        <div v-if="queueStatus === 'continuing'" class="countdown countdown--continuing">
          继续执行当前任务...
        </div>
      </div>

      <!-- 内容区：总览各类纵向堆叠，单类只渲染对应数据源 -->
      <div class="task-panel__scroll">
        <!-- § Claude 计划（TodoWrite / Task 工具） -->
        <section v-if="isAll || sessionStore.rightTab === 'plan'" class="tp-section" :class="{ 'tp-section--overview': isAll }">
          <div v-if="isAll" class="tp-section__head">
            <span class="tp-section__title">Claude 计划</span>
            <span v-if="planTotalCount" class="tp-section__count">{{ planDone }}/{{ planTotalCount }}</span>
            <button type="button" class="tp-section__goto" @click="setFilter('plan')">只看此类</button>
          </div>
          <ClaudePlanCard v-if="planTotalCount" />
          <div v-else class="task-panel__empty">Claude 尚未创建计划</div>
        </section>

        <!-- § 排队任务 -->
        <section v-if="isAll || sessionStore.rightTab === 'queue'" class="tp-section" :class="{ 'tp-section--overview': isAll }">
          <div v-if="isAll" class="tp-section__head">
            <span class="tp-section__title">排队任务</span>
            <span v-if="taskStore.tasks.length" class="tp-section__count">{{ taskStore.tasks.length }}</span>
            <button type="button" class="tp-section__goto" @click="setFilter('queue')">只看此类</button>
          </div>
          <div class="task-list">
            <VueDraggable
              v-model="taskStore.tasks"
              :disabled="dragDisabled"
              handle=".task-item__drag"
              item-key="id"
              @end="handleDragReorder"
            >
              <template #item="{ element: task }">
                <TaskItem
                  :task="task"
                  @delete="handleDelete"
                  @interrupt="handleInterrupt"
                  @retry="handleRetry"
                  @pause="handlePauseTask"
                  @resume="handleResumeTask"
                />
              </template>
            </VueDraggable>
            <div v-if="!taskStore.tasks.length" class="task-panel__empty">暂无排队任务；开启队列任务后，回复生成中在会话框发送即入队</div>
          </div>
        </section>

        <!-- § 子Agent -->
        <section v-if="isAll || sessionStore.rightTab === 'subagent'" class="tp-section" :class="{ 'tp-section--overview': isAll }">
          <div v-if="isAll" class="tp-section__head">
            <span class="tp-section__title">子Agent</span>
            <span v-if="subAgentGroups.length" class="tp-section__count">{{ subAgentGroups.length }}</span>
            <button type="button" class="tp-section__goto" @click="setFilter('subagent')">只看此类</button>
          </div>
          <div v-if="!subAgentGroups.length" class="task-panel__empty">暂无子 Agent 过程</div>
          <div v-else class="subagent-list">
            <div
              v-for="g in subAgentGroups"
              :id="`subagent-${g.parentAgentId}`"
              :key="g.parentAgentId"
              class="subagent-group"
            >
              <button
                type="button"
                class="subagent-group__header"
                :class="{ 'subagent-group__header--open': isSubAgentGroupExpanded(g.parentAgentId, g.running) }"
                @click="toggleSubAgentGroup(g.parentAgentId, g.running)"
              >
                <span class="subagent-group__icon">🤖</span>
                <span class="subagent-group__title">{{ g.title }}</span>
                <span class="subagent-group__duration">⏱{{ subAgentDurationText(g) }}</span>
                <span class="subagent-group__status" :class="{ 'subagent-group__status--running': g.running }">
                  {{ subAgentStatusText(g) }}
                  <span v-if="g.running" class="subagent-running-dots" aria-hidden="true">
                    <span></span><span></span><span></span>
                  </span>
                </span>
                <span class="subagent-group__arrow">›</span>
              </button>
              <div v-if="isSubAgentGroupExpanded(g.parentAgentId, g.running)" class="subagent-group__body">
                <ThinkingBlock v-if="subAgentThinkingText(g.parentAgentId)" :content="subAgentThinkingText(g.parentAgentId)" streaming />
                <template v-for="item in g.items" :key="item.key">
                  <ProcessGroup v-if="item.type === 'fold'" :messages="item.messages" :stats="item.stats" :active="g.running" />
                  <MessageBubble v-else :message="item.message" />
                </template>
              </div>
            </div>
          </div>
        </section>

        <!-- § 后台任务（task_* 编排：后台 Bash / Monitor / 后台子 Agent） -->
        <section v-if="isAll || sessionStore.rightTab === 'background'" class="tp-section" :class="{ 'tp-section--overview': isAll }">
          <div v-if="isAll" class="tp-section__head">
            <span class="tp-section__title">后台任务</span>
            <span v-if="backgroundTaskCount" class="tp-section__count">{{ backgroundTaskCount }}</span>
            <button type="button" class="tp-section__goto" @click="setFilter('background')">只看此类</button>
          </div>
          <div v-if="!backgroundTaskList.length" class="task-panel__empty">暂无后台任务</div>
          <div v-else class="subagent-list">
            <div v-for="t in backgroundTaskList" :key="t.taskId" class="subagent-group">
              <div class="subagent-group__header">
                <span class="subagent-group__icon">{{ taskIcon(t.taskType) }}</span>
                <span class="subagent-group__title">{{ t.description || t.taskId }}</span>
                <span class="subagent-group__status" :class="{ 'subagent-group__status--running': !t.status }">
                  {{ t.status ? t.status : '运行中' }}
                </span>
              </div>
              <div class="subagent-group__body">
                <div v-if="t.lastToolName" class="bg-task__row">最近工具：{{ t.lastToolName }}</div>
                <div v-if="t.usage?.durationMs" class="bg-task__row">耗时：{{ (t.usage.durationMs / 1000).toFixed(1) }}s</div>
                <div v-if="t.usage?.toolUses" class="bg-task__row">工具调用：{{ t.usage.toolUses }}</div>
                <div v-if="t.summary" class="bg-task__row">{{ t.summary }}</div>
              </div>
            </div>
          </div>
        </section>

        <!-- § 改动：总览精简摘要，单类完整 ChangesPanel -->
        <section v-if="isAll || sessionStore.rightTab === 'changes'" class="tp-section" :class="{ 'tp-section--overview': isAll }">
          <div v-if="isAll" class="tp-section__head">
            <span class="tp-section__title">改动</span>
            <span v-if="changesCount" class="tp-section__count">{{ changesCount }}</span>
            <button type="button" class="tp-section__goto" @click="setFilter('changes')">只看此类</button>
          </div>
          <ChangesPanel v-if="!isAll" />
          <ul v-else-if="changesCount" class="tp-changes-summary">
            <li v-for="f in changesSummaryFiles" :key="f.path">
              <button type="button" class="tp-changes-row" :title="`查看 ${f.path} 的对比`" @click="openSummaryFile(f.path, $event)">
                <span class="tp-changes-status" :data-status="f.status">{{ changeStatusLabel(f.status) }}</span>
                <span class="tp-changes-path">{{ f.path }}</span>
              </button>
            </li>
            <li v-if="changesCount > changesSummaryFiles.length" class="tp-changes-more">
              还有 {{ changesCount - changesSummaryFiles.length }} 个，<button type="button" class="tp-changes-goto" @click="setFilter('changes')">查看全部</button>
            </li>
          </ul>
          <div v-else class="task-panel__empty">工作目录无改动</div>
        </section>
      </div>
    </div>

    <!-- 图标轨：贴面板最右侧；SVG stroke 结构图标，禁止 emoji 作结构图标 -->
    <nav class="rail" aria-label="活动分类">
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': isAll }"
        :aria-pressed="sessionStore.rightTab === 'all'"
        aria-label="全部四类"
        title="全部四类"
        @click="setFilter('all')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="4.2" height="4.2" rx="1" />
          <rect x="9.3" y="2.5" width="4.2" height="4.2" rx="1" />
          <rect x="2.5" y="9.3" width="4.2" height="4.2" rx="1" />
          <rect x="9.3" y="9.3" width="4.2" height="4.2" rx="1" />
        </svg>
      </button>
      <span class="rail__divider" aria-hidden="true"></span>
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': sessionStore.rightTab === 'plan' }"
        :aria-pressed="sessionStore.rightTab === 'plan'"
        aria-label="Claude 计划"
        title="Claude 计划"
        @click="setFilter('plan')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" />
          <path d="M5.5 7l1.5 1.5L10.5 5.5" />
          <path d="M5.5 11h5" />
        </svg>
        <span v-if="planTotalCount" class="rail__badge" :class="{ 'rail__badge--live': planMetric.active }">{{ planDone }}/{{ planTotalCount }}</span>
      </button>
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': sessionStore.rightTab === 'queue' }"
        :aria-pressed="sessionStore.rightTab === 'queue'"
        aria-label="排队任务"
        title="排队任务"
        @click="setFilter('queue')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5.4 4h8M5.4 8h8M5.4 12h8" />
          <circle cx="2.6" cy="4" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="2.6" cy="8" r="0.9" fill="currentColor" stroke="none" />
          <circle cx="2.6" cy="12" r="0.9" fill="currentColor" stroke="none" />
        </svg>
        <span v-if="taskStore.tasks.length" class="rail__badge">{{ taskStore.tasks.length }}</span>
      </button>
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': sessionStore.rightTab === 'subagent' }"
        :aria-pressed="sessionStore.rightTab === 'subagent'"
        aria-label="子Agent"
        title="子Agent"
        @click="setFilter('subagent')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="8" cy="5.6" r="2.4" />
          <path d="M3.2 13.6c0-2.6 2.2-4.2 4.8-4.2s4.8 1.6 4.8 4.2" />
        </svg>
        <span v-if="subAgentGroups.length" class="rail__badge" :class="{ 'rail__badge--live': runningSubAgentCount > 0 }">{{ subAgentGroups.length }}</span>
      </button>
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': sessionStore.rightTab === 'background' }"
        :aria-pressed="sessionStore.rightTab === 'background'"
        aria-label="后台任务"
        title="后台任务"
        @click="setFilter('background')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M2 8h2.8l1.8-4.4 2.8 8.8L11.2 8H14" />
        </svg>
        <span v-if="backgroundTaskCount" class="rail__badge">{{ backgroundTaskCount }}</span>
      </button>
      <button
        type="button"
        class="rail__btn"
        :class="{ 'rail__btn--active': sessionStore.rightTab === 'changes' }"
        :aria-pressed="sessionStore.rightTab === 'changes'"
        aria-label="改动"
        title="改动"
        @click="setFilter('changes')"
      >
        <svg class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M4.5 2h4.8l3.2 3.2V14H4.5z" />
          <path d="M9.3 2v3.2h3.2" />
          <path d="M8 8.6v3.4M6.3 10.3h3.4" />
        </svg>
        <span v-if="changesCount" class="rail__badge">{{ changesCount }}</span>
      </button>
      <!-- 折叠活动总览（保留 rail 图标轨）：» 向右折叠 / « 向左展开 -->
      <button
        type="button"
        class="rail__btn rail__btn--collapse"
        :class="{ 'rail__btn--active': sessionStore.overviewCollapsed }"
        :aria-expanded="!sessionStore.overviewCollapsed"
        :aria-label="sessionStore.overviewCollapsed ? '展开活动总览' : '折叠活动总览'"
        :title="sessionStore.overviewCollapsed ? '展开活动总览' : '向右折叠活动总览'"
        @click="sessionStore.toggleOverviewCollapsed()"
      >
        <!-- 展开态：» 双箭头指右 = 把总览向右收起 -->
        <svg v-if="!sessionStore.overviewCollapsed" class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M5.5 4 9 8l-3.5 4M9.5 4 13 8l-3.5 4" />
        </svg>
        <!-- 折叠态：« 双箭头指左 = 把总览向左展开 -->
        <svg v-else class="rail__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10.5 4 7 8l3.5 4M6.5 4 3 8l3.5 4" />
        </svg>
      </button>
    </nav>
  </aside>
</template>

<style scoped>
.task-panel {
  display: flex;
  flex-direction: row;
  width: var(--task-panel-width);
  min-width: var(--task-panel-width);
  background: var(--color-panel);
  border-left: 1px solid var(--color-border-strong);
}

/* 折叠态：仅保留 rail 图标轨（48px），隐藏活动总览主体。
   不加 width 过渡——否则会拖慢 AppLayout resize 手柄的实时调宽。 */
.task-panel--collapsed {
  width: 48px;
  min-width: 48px;
}

.task-panel--collapsed .task-panel__main {
  display: none;
}

/* 主区：内容在左 */
.task-panel__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

/* 顶栏 */
.task-panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.task-panel__heading h2 {
  margin: 2px 0 0;
  font-size: 0.9375rem;
  font-weight: 650;
}

.eyebrow {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.clear-pill {
  flex-shrink: 0;
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  border-radius: 999px;
  padding: 3px 10px;
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.clear-pill:hover {
  color: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
}

/* 状态指标条：2×2 网格，绝不用 · 串句换行 */
.status-metrics {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-accent) 5%, transparent);
  flex-shrink: 0;
}

.status-metric {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  text-align: left;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}

.status-metric:hover {
  border-color: var(--color-accent-strong);
}

.status-metric--active {
  border-color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
}

.status-metric__label {
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.status-metric__value {
  font-size: 0.75rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  color: var(--color-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.status-metric--active .status-metric__value {
  color: var(--color-accent-strong);
}

/* 排队控制条（仅 queue） */
.queue-bar {
  flex-shrink: 0;
  border-bottom: 1px solid var(--color-border);
}

.task-panel__controls {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
}

.btn {
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  font-size: 0.75rem;
  font-weight: 600;
}

.btn--primary {
  border: 0;
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
}

.btn--warn {
  border: 1px solid var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  color: var(--color-warn-strong);
}

.countdown {
  padding: 10px 16px;
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
  color: var(--color-accent-strong);
  font-size: 0.8125rem;
  text-align: center;
}

.countdown--continuing {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

/* 内容滚动区：总览四类纵向堆叠，单类只渲染对应数据源 */
.task-panel__scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.tp-section {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.tp-section--overview {
  padding-bottom: 4px;
}

.tp-section__head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 2px;
}

.tp-section__title {
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.tp-section__count {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 5px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
  color: var(--color-text);
  font-size: 0.625rem;
  font-weight: 700;
}

.tp-section__goto {
  margin-left: auto;
  border: 0;
  background: transparent;
  color: var(--color-accent-strong);
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
  transition: background 0.15s;
}

.tp-section__goto:hover {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
}

.task-list {
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 2px 2px 4px;
}

.task-panel__empty {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  padding: 14px 12px;
  text-align: center;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
}

/* 总览改动摘要（精简列表，进单类看完整 diff） */
.tp-changes-summary {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tp-changes-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 6px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.tp-changes-row:hover {
  background: var(--color-panel-soft);
}

.tp-changes-row:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: -2px;
}

.tp-changes-status {
  flex-shrink: 0;
  display: inline-grid;
  place-items: center;
  width: 18px;
  height: 18px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--color-text) 10%, transparent);
  color: var(--color-text);
  font-size: 0.625rem;
  font-weight: 700;
}

.tp-changes-path {
  min-width: 0;
  font-size: 0.75rem;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.tp-changes-more {
  display: flex;
  align-items: center;
  gap: 2px;
  padding: 4px 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.tp-changes-goto {
  border: 0;
  background: transparent;
  color: var(--color-accent-strong);
  font-size: 0.6875rem;
  font-weight: 600;
  cursor: pointer;
  padding: 0;
}

/* 图标轨：贴面板最右侧 */
.rail {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 10px 4px;
  width: 48px;
  border-left: 1px solid var(--color-border);
  background: var(--color-panel-soft);
}

.rail__divider {
  width: 24px;
  height: 1px;
  margin: 2px 0;
  background: var(--color-border);
}

.rail__btn {
  position: relative;
  display: grid;
  place-items: center;
  width: 38px;
  height: 38px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s, background 0.15s, border-color 0.15s;
}

.rail__btn:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-accent) 8%, transparent);
}

.rail__btn--active {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  border-color: var(--color-accent-strong);
}

/* 折叠按钮：顶到 rail 底部（侧栏右下角） */
.rail__btn--collapse {
  margin-top: auto;
}

.rail__icon {
  width: 20px;
  height: 20px;
}

.rail__badge {
  position: absolute;
  top: -2px;
  right: -2px;
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.625rem;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}

.rail__badge--live {
  background: var(--color-warn-strong);
  color: #fff;
}

/* 子 Agent 分组 */
.subagent-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.subagent-group {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
  scroll-margin-top: 12px;
  box-shadow: var(--ring-light), var(--elevation-1);
  transition: box-shadow 0.3s, border-color 0.3s;
}

.subagent-group--focused {
  border-color: var(--color-accent-strong);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 25%, transparent);
}

.subagent-group__header {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 0;
  border-bottom: 1px solid transparent;
  background: var(--color-panel-soft);
  color: inherit;
  font-family: inherit;
  text-align: left;
  cursor: pointer;
}

.subagent-group__header--open {
  border-bottom-color: var(--color-border);
}

.subagent-group__icon {
  flex-shrink: 0;
}

.subagent-group__title {
  flex: 1;
  min-width: 0;
  font-size: 0.8125rem;
  font-weight: 650;
  color: var(--color-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-group__duration {
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.subagent-group__status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid var(--color-border);
}

.subagent-group__status--running {
  color: var(--color-accent-strong);
  border-color: var(--color-accent-strong);
}

.subagent-running-dots {
  display: inline-flex;
  gap: 2px;
  align-items: center;
}

.subagent-running-dots span {
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: currentColor;
  animation: subagent-dot-pulse 1.4s infinite ease-in-out both;
}

.subagent-running-dots span:nth-child(2) {
  animation-delay: 0.16s;
}

.subagent-running-dots span:nth-child(3) {
  animation-delay: 0.32s;
}

.subagent-group__arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform 0.15s;
}

.subagent-group__header--open .subagent-group__arrow {
  transform: rotate(90deg);
}

.subagent-group__body {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

@keyframes subagent-dot-pulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

/* C：后台任务详情行 */
.bg-task__row {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  padding: 2px 0;
}

.subagent-group__body :deep(.process-fold) {
  max-width: 100%;
}

.subagent-group__body :deep(.bubble) {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  align-self: stretch;
}

@media (prefers-reduced-motion: reduce) {
  .subagent-running-dots span {
    animation: none;
  }
}
</style>
