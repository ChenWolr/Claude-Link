<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useTaskStore } from '../../stores/task-store';
import { useSessionStore } from '../../stores/session-store';
import { useTaskQueue } from '../../composables/use-task-queue';
import TaskItem from './TaskItem.vue';

const taskStore = useTaskStore();
const sessionStore = useSessionStore();
const { startListening } = useTaskQueue();

const newTaskPrompt = ref('');
let cleanup: (() => void) | null = null;

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
  await taskStore.startQueue(sessionStore.activeSession.id);
}

async function handlePause() {
  if (!sessionStore.activeSession) return;
  await taskStore.pauseQueue(sessionStore.activeSession.id);
}

async function handleResume() {
  if (!sessionStore.activeSession) return;
  await taskStore.resumeQueue(sessionStore.activeSession.id);
}

async function handleDelete(taskId: string) {
  await taskStore.removeTask(taskId);
}

async function handleInterrupt(taskId: string) {
  await taskStore.interruptTask(taskId);
}

const queueStatus = taskStore.queueState.status;
</script>

<template>
  <aside class="task-panel">
    <header class="task-panel__header">
      <div>
        <p class="eyebrow">Queue</p>
        <h2>任务队列</h2>
      </div>
      <div class="task-panel__controls">
        <button v-if="queueStatus === 'idle' || queueStatus === 'paused'" type="button" class="btn btn--primary" @click="handleStart">开始</button>
        <button v-if="queueStatus === 'running' || queueStatus === 'waiting'" type="button" class="btn btn--warn" @click="handlePause">暂停</button>
        <button v-if="queueStatus === 'paused'" type="button" class="btn btn--primary" @click="handleResume">恢复</button>
      </div>
    </header>

    <!-- Countdown -->
    <div v-if="queueStatus === 'waiting' && taskStore.queueState.countdownRemaining > 0" class="countdown">
      下一个任务将在 {{ taskStore.queueState.countdownRemaining }}s 后开始
    </div>

    <!-- Task List -->
    <div class="task-list">
      <TaskItem
        v-for="task in taskStore.tasks"
        :key="task.id"
        :task="task"
        @delete="handleDelete"
        @interrupt="handleInterrupt"
      />
      <div v-if="!taskStore.tasks.length" class="task-panel__empty">等待添加任务</div>
    </div>

    <!-- Add Task -->
    <div class="task-panel__add">
      <textarea
        v-model="newTaskPrompt"
        placeholder="输入任务描述..."
        rows="2"
        @keydown.enter.prevent="handleAddTask"
      />
      <button type="button" :disabled="!newTaskPrompt.trim()" @click="handleAddTask">添加</button>
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
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--color-border);
}

.task-panel__add textarea {
  min-width: 0;
  flex: 1;
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
