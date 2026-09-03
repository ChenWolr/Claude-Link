<script setup lang="ts">
import { ref, watch } from 'vue';
import type { Task } from '../../../shared/types/task';
import TaskStatusBadge from './TaskStatusBadge.vue';

const props = defineProps<{ task: Task }>();
const emit = defineEmits<{
  delete: [taskId: string];
  interrupt: [taskId: string];
  retry: [taskId: string];
  pause: [taskId: string];
  resume: [taskId: string];
}>();

const expanded = ref(false);

// Auto-expand when task starts running
watch(() => props.task.status, (newStatus) => {
  if (newStatus === 'running') {
    expanded.value = true;
  }
});
</script>

<template>
  <div :class="['task-item', { 'task-item--running': task.status === 'running' }]">
    <div class="task-item__header" title="点击查看 / 收起详情" @click="expanded = !expanded">
      <span class="task-item__drag" @click.stop>⠿</span>
      <TaskStatusBadge :status="task.status" />
      <span v-if="task.paused && task.status === 'pending'" class="task-item__paused-chip">⏸ 已暂停</span>
      <span class="task-item__prompt">{{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}</span>
    </div>
    <div class="task-item__actions">
      <button v-if="task.status === 'running'" type="button" class="action action--danger" @click="emit('interrupt', task.id)">中断</button>
      <button v-if="task.status === 'failed' || task.status === 'cancelled'" type="button" class="action action--accent" @click="emit('retry', task.id)">重试</button>
      <button v-if="task.status === 'pending' && !task.paused" type="button" class="action action--muted" @click="emit('pause', task.id)">暂停</button>
      <button v-if="task.status === 'pending' && task.paused" type="button" class="action action--accent" @click="emit('resume', task.id)">恢复</button>
      <button v-if="task.status === 'pending'" type="button" class="action action--muted" @click="emit('delete', task.id)">删除</button>
      <button type="button" class="action" @click="expanded = !expanded">{{ expanded ? '收起' : '详情' }}</button>
    </div>
    <div v-if="expanded" class="task-item__detail">
      <div class="task-item__full-prompt">{{ task.prompt }}</div>
      <div v-if="task.attachments.length > 0" class="task-item__atts">
        <strong>附件:</strong> {{ task.attachments.length }} 个 · {{ task.attachments[0]?.filename }}{{ task.attachments.length > 1 ? ' 等' : '' }}
      </div>
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
  box-shadow: var(--ring-light), var(--elevation-1);
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.task-item--running {
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 6%, transparent);
}

.task-item__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-item__drag {
  cursor: grab;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  user-select: none;
}

.task-item__prompt {
  min-width: 0;
  flex: 1;
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-item__paused-chip {
  flex-shrink: 0;
  border: 1px solid var(--color-warn);
  border-radius: var(--radius-pill);
  color: var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  padding: 1px 8px;
  font-size: 0.625rem;
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
  font-size: 0.6875rem;
}

.action--danger {
  border-color: var(--color-danger);
  color: var(--color-danger);
}

.action--muted {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.action--accent {
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
}

.task-item__atts {
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}

.task-item__detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.task-item__full-prompt {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
  line-height: 1.5;
  max-height: 200px;
  overflow-y: auto;
}

.task-item__result {
  margin-top: 8px;
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.task-item__error {
  margin-top: 8px;
  color: var(--color-danger);
  font-size: 0.75rem;
}

.task-item__meta {
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
</style>
