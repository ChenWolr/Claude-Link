<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { useTaskStore } from '../../stores/task-store';
import { useSessionStore } from '../../stores/session-store';
import { useTaskQueue } from '../../composables/use-task-queue';
import TaskItem from './TaskItem.vue';

const taskStore = useTaskStore();
const sessionStore = useSessionStore();
const { startListening } = useTaskQueue();

const newTaskPrompt = ref('');
let cleanup: (() => void) | null = null;

const queueStatus = computed(() => taskStore.queueState.status);

// Queue is active (running, waiting, or continuing) → disable drag reorder
const dragDisabled = computed(
  () => queueStatus.value === 'running' || queueStatus.value === 'waiting' || queueStatus.value === 'continuing',
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
    window.alert('请先在底部选择「工作空间」目录，再启动任务队列。');
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
    window.alert('请先在底部选择「工作空间」目录，再继续任务队列。');
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

.task-panel__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border);
}

.task-panel__header h2 {
  margin: 2px 0 0;
  font-size: 16px;
  font-weight: 650;
}

.eyebrow {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 11px;
  text-transform: uppercase;
}

.task-panel__controls {
  display: flex;
  gap: 6px;
}

.btn {
  border-radius: var(--radius-sm);
  padding: 5px 12px;
  font-size: 12px;
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
  font-size: 13px;
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
  font-size: 13px;
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
  font-size: 12px;
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
  font-size: 11px;
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
  font-size: 13px;
}

.task-panel__add button {
  align-self: flex-end;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 8px 14px;
  font-weight: 700;
  font-size: 13px;
}

.task-panel__add button:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}
</style>
