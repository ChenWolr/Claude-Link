<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { useTaskStore } from '../../stores/task-store';
import { useSessionStore } from '../../stores/session-store';
import { useInteractionStore } from '../../stores/interaction-store';
import { useTaskQueue } from '../../composables/use-task-queue';
import type { Message } from '../../../shared/types/session';
import { groupMessagesForRender } from '../../utils/group-messages';
import TaskItem from './TaskItem.vue';
import ProcessGroup from '../chat/ProcessGroup.vue';
import MessageBubble from '../chat/MessageBubble.vue';

const taskStore = useTaskStore();
const sessionStore = useSessionStore();
const interactionStore = useInteractionStore();
const { startListening } = useTaskQueue();

const newTaskPrompt = ref('');
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

// 子 Agent 分组：把 parentAgentId !== null 的消息按 parentAgentId 聚合，标题取自主流程对应
// Agent/Task 工具组（toolUseId === parentAgentId）的 title（即 description），禁用"子任务N"编号。
// 每组内部复用主流程的分组规则（连续同类 / 因果配对 / 正文独立气泡）。
const subAgentGroups = computed(() => {
  const map = new Map<string, Message[]>();
  const order: string[] = [];
  for (const m of sessionStore.messages) {
    if (!m.parentAgentId) continue;
    if (!map.has(m.parentAgentId)) {
      map.set(m.parentAgentId, []);
      order.push(m.parentAgentId);
    }
    map.get(m.parentAgentId)!.push(m);
  }
  // 主流程 Agent/Task 工具组（tool_use + title）→ 子 agent 标题。
  const titleByToolUseId = new Map<string, string>();
  for (const m of sessionStore.messages) {
    if (m.eventType === 'tool_use' && m.toolUseId && m.title) {
      titleByToolUseId.set(m.toolUseId, m.title);
    }
  }
  return order.map((id, idx) => {
    const msgs = map.get(id)!;
    return {
      parentAgentId: id,
      title: titleByToolUseId.get(id) || '子Agent',
      items: groupMessagesForRender(msgs),
      // 进行中：当前会话在发送，且这是最后出现的子 agent 组。
      running: sessionStore.sending && idx === order.length - 1,
    };
  });
});

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
        <!-- 快速跳转：多个并行子 agent 时，点具体某个直接定位到对应组 -->
        <div v-if="subAgentGroups.length > 1" class="subagent-jump">
          <button
            v-for="g in subAgentGroups"
            :key="`jump-${g.parentAgentId}`"
            type="button"
            class="subagent-jump__chip"
            :title="`定位到「${g.title}」`"
            @click="sessionStore.focusSubAgent(g.parentAgentId)"
          >
            <span class="subagent-jump__dot" :class="{ 'subagent-jump__dot--running': g.running }"></span>
            <span class="subagent-jump__name">{{ g.title }}</span>
          </button>
        </div>
        <div class="subagent-list">
        <div
          v-for="g in subAgentGroups"
          :id="`subagent-${g.parentAgentId}`"
          :key="g.parentAgentId"
          class="subagent-group"
        >
          <div class="subagent-group__header">
            <span class="subagent-group__icon">🤖</span>
            <span class="subagent-group__title">{{ g.title }}</span>
            <span class="subagent-group__status" :class="{ 'subagent-group__status--running': g.running }">
              {{ g.running ? '进行中' : '已完成' }}
            </span>
          </div>
          <div class="subagent-group__body">
            <template v-for="item in g.items" :key="item.key">
              <ProcessGroup v-if="item.type === 'fold'" :messages="item.messages" :stats="item.stats" />
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
  border-left: 1px solid var(--color-border);
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
  transition: color 0.15s, background 0.15s;
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
  color: #07120d;
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
  color: #07120d;
}

.btn--warn {
  border: 1px solid #eab308;
  background: rgba(234, 179, 8, 0.1);
  color: #facc15;
}

.countdown {
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-border);
  background: rgba(58, 166, 117, 0.06);
  color: var(--color-accent-strong);
  font-size: 0.8125rem;
  text-align: center;
}

.countdown--continuing {
  background: rgba(58, 166, 117, 0.12);
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
  color: #07120d;
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

/* 快速跳转条（多个并行子 agent 时出现） */
.subagent-jump {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  margin-bottom: 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  position: sticky;
  top: 0;
  z-index: 1;
}

.subagent-jump__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: 999px;
  background: var(--color-panel);
  color: var(--color-text);
  padding: 4px 10px;
  font-size: 0.75rem;
  cursor: pointer;
  max-width: 160px;
  transition: border-color 0.15s, color 0.15s;
}

.subagent-jump__chip:hover {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}

.subagent-jump__dot {
  flex-shrink: 0;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-text-muted);
}

.subagent-jump__dot--running {
  background: var(--color-accent-strong);
}

.subagent-jump__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.subagent-group {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
  scroll-margin-top: 12px;
  transition: box-shadow 0.3s, border-color 0.3s;
}

.subagent-group--focused {
  border-color: var(--color-accent-strong);
  box-shadow: 0 0 0 2px rgba(var(--color-accent-rgb, 58, 166, 117), 0.25);
}

.subagent-group__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel-soft);
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

.subagent-group__status {
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

.subagent-group__body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}

/* C：后台任务详情行 */
.bg-task__row {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  padding: 2px 0;
}

.subagent-group__body :deep(.process-group),
.subagent-group__body :deep(.message-bubble) {
  max-width: 100%;
}
</style>
