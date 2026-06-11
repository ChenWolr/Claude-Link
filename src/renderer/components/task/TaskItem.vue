<script setup lang="ts">
import { ref } from 'vue';
import type { Task } from '../../../shared/types/task';
import TaskStatusBadge from './TaskStatusBadge.vue';

const props = defineProps<{ task: Task }>();
const emit = defineEmits<{
  delete: [taskId: string];
  interrupt: [taskId: string];
}>();

const expanded = ref(false);
</script>

<template>
  <div :class="['task-item', { 'task-item--running': task.status === 'running' }]">
    <div class="task-item__header">
      <span class="task-item__drag">⠿</span>
      <TaskStatusBadge :status="task.status" />
      <span class="task-item__prompt">{{ task.prompt.slice(0, 60) }}{{ task.prompt.length > 60 ? '...' : '' }}</span>
    </div>
    <div class="task-item__actions">
      <button v-if="task.status === 'running'" type="button" class="action action--danger" @click="emit('interrupt', task.id)">中断</button>
      <button v-if="task.status === 'pending'" type="button" class="action action--muted" @click="emit('delete', task.id)">删除</button>
      <button type="button" class="action" @click="expanded = !expanded">{{ expanded ? '收起' : '详情' }}</button>
    </div>
    <div v-if="expanded" class="task-item__detail">
      <div class="task-item__full-prompt">{{ task.prompt }}</div>
      <div v-if="task.result" class="task-item__result">
        <strong>结果:</strong> {{ task.result.slice(0, 300) }}
      </div>
      <div v-if="task.errorMessage" class="task-item__error">{{ task.errorMessage }}</div>
      <div v-if="task.costUsd != null" class="task-item__meta">
        费用: ${{ task.costUsd.toFixed(4) }}
        <template v-if="task.durationMs"> · 耗时: {{ (task.durationMs / 1000).toFixed(1) }}s</template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.task-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 10px 12px;
}

.task-item--running {
  border-color: var(--color-accent);
  background: rgba(58, 166, 117, 0.06);
}

.task-item__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-item__drag {
  cursor: grab;
  color: var(--color-text-muted);
  font-size: 14px;
  user-select: none;
}

.task-item__prompt {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-item__actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.action {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  padding: 3px 8px;
  font-size: 11px;
}

.action--danger {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.action--muted {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.task-item__detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.task-item__full-prompt {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 13px;
  line-height: 1.5;
}

.task-item__result {
  margin-top: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.task-item__error {
  margin-top: 8px;
  color: var(--color-danger);
  font-size: 12px;
}

.task-item__meta {
  margin-top: 6px;
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
