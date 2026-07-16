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

const taskStore = useTaskStore();
const sessionStore = useSessionStore();
const interactionStore = useInteractionStore();
const { startListening } = useTaskQueue();

const newTaskPrompt = ref('');
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

// Queue is active (running, waiting, or continuing) → disable drag reorder
const dragDisabled = computed(
  () => queueStatus.value === 'running' || queueStatus.value === 'waiting' || queueStatus.value === 'continuing',
);

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

onMounted(() => {
  cleanup = startListening();
  loadTasks();
});

onUnmounted(() => {
  cleanup?.();
});

function loadTasks() {
  if (sessionStore.activeSession) {
    taskStore.loadTasks(sessionStore.activeSession.id);
  }
}

async function handleAddTask() {
  if (!sessionStore.activeSession || !newTaskPrompt.value.trim()) return;
  await taskStore.addTask(sessionStore.activeSession.id, newTaskPrompt.value.trim());
  newTaskPrompt.value = '';
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

function handleDragReorder() {
  if (!sessionStore.activeSession) return;
  const taskIds = taskStore.tasks.map((t) => t.id);
  taskStore.reorderTasks(sessionStore.activeSession.id, taskIds);
}
</script>

<template>
  <aside class="task-panel">
    <!-- Tab 切换：排队任务 / 子Agent -->
    <div class="task-panel__tabs">
      <button
        type="button"
        class="tab"
        :class="{ 'tab--active': sessionStore.rightTab === 'queue' }"
        @click="sessionStore.setRightTab('queue')"
      >
        排队任务
      </button>
      <button
        type="button"
        class="tab"
        :class="{ 'tab--active': sessionStore.rightTab === 'subagent' }"
        @click="sessionStore.setRightTab('subagent')"
      >
        子Agent
        <span v-if="subAgentGroups.length" class="tab__badge">{{ subAgentGroups.length }}</span>
      </button>
      <button
        type="button"
        class="tab"
        :class="{ 'tab--active': sessionStore.rightTab === 'background' }"
        @click="sessionStore.setRightTab('background')"
      >
        后台任务
        <span v-if="backgroundTaskCount" class="tab__badge">{{ backgroundTaskCount }}</span>
      </button>
    </div>

    <!-- 排队任务面板 -->
    <div v-show="sessionStore.rightTab === 'queue'" class="task-panel__pane">
      <header class="task-panel__header">
        <div>
          <p class="eyebrow">Queue</p>
          <h2>任务队列</h2>
        </div>
        <div class="task-panel__controls">
          <button v-if="queueStatus === 'idle' || queueStatus === 'paused'" type="button" class="btn btn--primary" title="开始执行队列中的任务" @click="handleStart">开始</button>
          <button v-if="queueStatus === 'running' || queueStatus === 'waiting' || queueStatus === 'continuing'" type="button" class="btn btn--warn" title="暂停倒计时与队列执行" @click="handlePause">暂停</button>
          <button v-if="queueStatus === 'paused'" type="button" class="btn btn--primary" title="恢复队列执行" @click="handleResume">恢复</button>
        </div>
      </header>

      <!-- Countdown -->
      <div v-if="queueStatus === 'waiting' && taskStore.queueState.countdownRemaining > 0" class="countdown">
        任务已完成，{{ taskStore.queueState.countdownRemaining }}s 内可继续追加指令
      </div>

      <!-- Continuing -->
      <div v-if="queueStatus === 'continuing'" class="countdown countdown--continuing">
        继续执行当前任务...
      </div>

      <!-- Task List with drag reorder -->
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
            />
          </template>
        </VueDraggable>
        <div v-if="!taskStore.tasks.length" class="task-panel__empty">等待添加任务</div>
      </div>

      <!-- Add Task -->
      <div class="task-panel__add">
        <div class="add-row">
          <span class="add-label">排队指令</span>
          <span
            class="add-info"
            title="运行中的任务不会被新指令打断；新指令会在当前任务结束并等待倒计时后执行。倒计时（秒数可在配置页设置）内输入会作为对当前任务的补充继续执行。"
          >ⓘ</span>
        </div>
        <textarea
          v-model="newTaskPrompt"
          placeholder="输入要排队发送给 AI 的下一条指令"
          rows="3"
          title="输入要排队发送给 AI 的下一条指令（回车添加到队列末尾）"
          @keydown.enter.prevent="handleAddTask"
        />
        <button type="button" :disabled="!newTaskPrompt.trim()" title="添加到队列末尾" @click="handleAddTask">添加</button>
      </div>
    </div>

    <!-- 子Agent 面板 -->
    <div v-show="sessionStore.rightTab === 'subagent'" class="task-panel__pane task-panel__pane--subagent">
      <div v-if="!subAgentGroups.length" class="task-panel__empty">暂无子 Agent 过程</div>
      <template v-else>
        <div class="subagent-list">
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
      </template>
    </div>

    <!-- C：后台任务面板（task_* 编排：后台 Bash / Monitor / 后台子 Agent） -->
    <div v-show="sessionStore.rightTab === 'background'" class="task-panel__pane task-panel__pane--subagent">
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
    </div>
  </aside>
</template>

<style scoped>
.task-panel {
  display: flex;
  width: var(--task-panel-width);
  min-width: var(--task-panel-width);
  flex-direction: column;
  background: var(--color-panel);
  border-left: 1px solid var(--color-border-strong);
}

/* Tab 切换条 */
.task-panel__tabs {
  display: flex;
  gap: 4px;
  padding: 8px 12px 0;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.tab {
  position: relative;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 8px 14px;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
  transition: color 0.15s, background 0.15s, transform var(--duration-fast) var(--ease-out);
}

.tab:hover {
  color: var(--color-text);
}

.tab--active {
  color: var(--color-accent-strong);
  background: var(--color-panel-soft);
}

.tab--active::after {
  content: '';
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: -1px;
  height: 2px;
  background: var(--color-accent-strong);
  border-radius: 2px;
}

.tab__badge {
  display: inline-grid;
  place-items: center;
  min-width: 16px;
  height: 16px;
  margin-left: 4px;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.625rem;
  font-weight: 700;
}

/* 面板容器：占满剩余高度，内部各自滚动 */
.task-panel__pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.task-panel__pane--subagent {
  overflow-y: auto;
  padding: 12px;
}

.task-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 60px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.task-panel__header h2 {
  margin: 2px 0 0;
  font-size: 0.9375rem;
  font-weight: 650;
}

.eyebrow {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  text-transform: uppercase;
}

.task-panel__controls {
  display: flex;
  gap: 6px;
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
  border-bottom: 1px solid var(--color-border);
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
  color: var(--color-accent-strong);
  font-size: 0.8125rem;
  text-align: center;
}

.countdown--continuing {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}

.task-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.task-panel__empty {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  padding: 18px 16px;
  text-align: center;
}

.task-panel__add {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.add-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.add-label {
  color: var(--color-text-muted);
  font-size: 0.75rem;
  font-weight: 600;
}

.add-info {
  display: inline-grid;
  place-items: center;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  cursor: help;
  user-select: none;
}

.task-panel__add textarea {
  min-width: 0;
  width: 100%;
  min-height: 72px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 8px 10px;
  resize: none;
  outline: none;
  font-size: 0.8125rem;
}

.task-panel__add button {
  align-self: flex-end;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
  padding: 8px 14px;
  font-weight: 700;
  font-size: 0.8125rem;
}

.task-panel__add button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
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
</style>
