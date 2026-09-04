<script setup lang="ts">
import { ref, computed } from 'vue';
import type { Task } from '../../../shared/types/task';
import TaskStatusBadge from './TaskStatusBadge.vue';

// v3：列表只可能出现 pending 任务（执行过即沉入「已执行」历史），故本卡为 pending 专用：
// 无 running/failed/completed 分支、无中断/重试入口（失败重试走主会话「重新编辑发送」）。
const props = defineProps<{
  task: Task;
  /** ETA 文案（taskEtaText 纯函数产出；null 不渲染行） */
  eta?: string | null;
  /** 本会话回合执行中（禁拖拽 + 禁立即执行） */
  sending?: boolean;
  /** 队列熔断待命（禁立即执行） */
  queuePaused?: boolean;
  /** 队列开关关闭（禁立即执行） */
  queueEnabled?: boolean;
}>();
const emit = defineEmits<{
  delete: [taskId: string];
  pause: [taskId: string];
  resume: [taskId: string];
  runnow: [taskId: string];
}>();

const expanded = ref(false);

// 「立即执行」置灰原因（优先级从高到低，与主进程 runTaskNow 守卫一一对应）。
// computed：暂停/恢复等 props 变化时 title 必须随之更新。
const runNowTitle = computed(() => {
  if (props.task.paused) return '已暂停的任务请先恢复';
  if (props.queueEnabled === false) return '队列开关已关闭';
  if (props.queuePaused) return '队列已暂停，恢复队列后可执行';
  if (props.sending) return '当前会话有任务执行中，结束后可立即执行';
  return '跳过倒计时，立即把该任务移出队列并作为普通消息发送';
});
</script>

<template>
  <div class="task-item">
    <div class="task-item__header" title="点击查看 / 收起详情" @click="expanded = !expanded">
      <span class="task-item__drag" @click.stop>⠿</span>
      <TaskStatusBadge :status="task.status" />
      <span v-if="task.paused" class="task-item__paused-chip">⏸ 已暂停</span>
      <span class="task-item__prompt">{{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}</span>
      <span v-if="task.attachments.length" class="task-item__atts-chip" :title="task.attachments.map((a) => a.filename).join('\n')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        {{ task.attachments.length }}
      </span>
    </div>
    <div v-if="eta" class="task-item__eta">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
      <span>{{ eta }}</span>
    </div>
    <div class="task-item__actions">
      <button
        v-if="task.status === 'pending'"
        type="button"
        class="action action--accent"
        :disabled="task.paused || sending || queuePaused || !queueEnabled"
        :title="runNowTitle"
        @click="emit('runnow', task.id)"
      >立即执行</button>
      <button v-if="task.status === 'pending' && !task.paused" type="button" class="action action--muted" @click="emit('pause', task.id)">暂停</button>
      <button v-if="task.status === 'pending' && task.paused" type="button" class="action action--accent" @click="emit('resume', task.id)">恢复</button>
      <button v-if="task.status === 'pending'" type="button" class="action action--muted" @click="emit('delete', task.id)">删除</button>
      <button type="button" class="action" @click="expanded = !expanded">{{ expanded ? '收起' : '详情' }}</button>
    </div>
    <div v-if="expanded" class="task-item__detail">
      <div class="task-item__full-prompt">{{ task.prompt }}</div>
      <template v-if="task.attachments.length > 0">
        <div class="task-item__att-files">
          <span v-for="a in task.attachments" :key="a.id" class="task-item__att-file" :title="a.filename">{{ a.filename }}</span>
        </div>
        <div class="task-item__atts-note">附件 {{ task.attachments.length }} 个（执行时随消息一并发送）</div>
      </template>
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

/* 头行附件 chip：回形针 + 数量，title 列全部文件名 */
.task-item__atts-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  padding: 1px 7px;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}

.task-item__atts-chip svg {
  width: 11px;
  height: 11px;
}

/* ETA 行：时钟图标 + 文字，统一 muted */
.task-item__eta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.task-item__eta svg {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
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

.action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action--muted {
  color: var(--color-text-muted);
  opacity: 0.6;
}

.action--accent {
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
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

.task-item__att-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

.task-item__att-file {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.task-item__atts-note {
  margin-top: 5px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
</style>
