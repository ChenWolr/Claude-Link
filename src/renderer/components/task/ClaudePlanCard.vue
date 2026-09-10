<script setup lang="ts">
// ClaudePlanCard.vue
// Claude 计划任务只读卡片：展示 TodoWrite 与 TaskCreate/Update/List 的计划快照。
// 独立于手动排队任务（task-store / tasks 表）。状态来自 Claude SDK 事件，用户不可编辑。
//
// 设计要点：
//  - pending 空心圆 / in_progress 半填充圆 / completed（文本划线，仅 span）
//  - in_progress 显示 activeForm，其他显示 content
//  - Task 显示 subject，可展开 activeForm（当前）/description/blockedBy
//  - 全只读：无 checkbox、无编辑框、无拖拽排序
//  - 完成项删除线只作用于直属文本 span，不划过图标和徽章

import { ref, computed } from 'vue';
import { useClaudePlanStore } from '../../stores/claude-plan-store';
import type { ClaudeTodoItem, ClaudePlanTask } from '../../../shared/types/claude-plan';

const planStore = useClaudePlanStore();

const plan = computed(() => planStore.activePlan);

const todoCount = computed(() => plan.value?.todos.length ?? 0);
const todoCompleted = computed(() => plan.value?.todos.filter((t) => t.status === 'completed').length ?? 0);
const taskCount = computed(() => plan.value?.tasks.length ?? 0);
const hasPlan = computed(() => todoCount.value > 0 || taskCount.value > 0);

// 展开的任务 ID 集合
const expandedTaskIds = ref<Set<string>>(new Set());

function toggleTask(taskId: string): void {
  const next = new Set(expandedTaskIds.value);
  if (next.has(taskId)) {
    next.delete(taskId);
  } else {
    next.add(taskId);
  }
  expandedTaskIds.value = next;
}

function isTaskExpanded(taskId: string): boolean {
  return expandedTaskIds.value.has(taskId);
}

// Todo 显示文本：in_progress 显示 activeForm，其他显示 content
function todoText(item: ClaudeTodoItem): string {
  return item.status === 'in_progress' && item.activeForm ? item.activeForm : item.content;
}

// Task 状态标签
function taskStatusLabel(status: ClaudePlanTask['status']): string {
  switch (status) {
    case 'pending': return '待开始';
    case 'in_progress': return '进行中';
    case 'completed': return '已完成';
    case 'failed': return '失败';
    case 'killed': return '已终止';
    case 'paused': return '已暂停';
    default: return status;
  }
}

function taskStatusClass(status: ClaudePlanTask['status']): string {
  switch (status) {
    case 'in_progress': return 'plan-task__status--running';
    case 'completed': return 'plan-task__status--done';
    case 'failed':
    case 'killed': return 'plan-task__status--error';
    case 'paused': return 'plan-task__status--paused';
    default: return '';
  }
}
</script>

<template>
  <div class="claude-plan-card">
    <div v-if="!hasPlan" class="claude-plan-card__empty">
      Claude 尚未创建计划任务
    </div>
    <template v-else>
      <!-- TodoWrite 清单 -->
      <div v-if="todoCount > 0" class="plan-todos">
        <div class="plan-todos__header">
          <svg class="plan-todos__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <rect x="2.5" y="3" width="11" height="10" rx="1.5" />
            <path d="M5.5 7l1.5 1.5 3-3" />
          </svg>
          <span class="plan-todos__title">清单</span>
          <span class="plan-todos__count">{{ todoCompleted }}/{{ todoCount }}</span>
        </div>
        <ul class="plan-todos__list">
          <li
            v-for="(item, i) in plan!.todos"
            :key="i"
            class="plan-todo-item"
            :class="`plan-todo-item--${item.status}`"
          >
            <span class="plan-todo-item__icon" aria-hidden="true">
              <!-- completed: check circle -->
              <svg v-if="item.status === 'completed'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <path d="M5.5 8l1.8 1.8L11 6" />
              </svg>
              <!-- in_progress: circle with half fill (spinner-like) -->
              <svg v-else-if="item.status === 'in_progress'" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
                <path d="M8 2a6 6 0 0 1 0 12z" fill="currentColor" stroke="none" />
              </svg>
              <!-- pending: empty circle -->
              <svg v-else viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="8" cy="8" r="6" />
              </svg>
            </span>
            <span class="plan-todo-item__text" :class="{ 'plan-todo-item__text--done': item.status === 'completed' }">{{ todoText(item) }}</span>
          </li>
        </ul>
      </div>

      <!-- TaskCreate/Update 任务列表 -->
      <div v-if="taskCount > 0" class="plan-tasks">
        <div class="plan-tasks__header">
          <svg class="plan-tasks__icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M3 4h10M3 8h10M3 12h6" />
            <circle cx="13" cy="12" r="1.2" fill="currentColor" stroke="none" />
          </svg>
          <span class="plan-tasks__title">任务</span>
          <span class="plan-tasks__count">{{ taskCount }}</span>
        </div>
        <ul class="plan-tasks__list">
          <li
            v-for="task in plan!.tasks"
            :key="task.id"
            class="plan-task"
          >
            <button
              type="button"
              class="plan-task__header"
              :class="{ 'plan-task__header--open': isTaskExpanded(task.id) }"
              @click="toggleTask(task.id)"
            >
              <span class="plan-task__dot" :class="`plan-task__dot--${task.status}`" aria-hidden="true"></span>
              <span class="plan-task__subject" :class="{ 'plan-task__subject--done': task.status === 'completed' }">{{ task.subject }}</span>
              <span class="plan-task__status" :class="taskStatusClass(task.status)">{{ taskStatusLabel(task.status) }}</span>
              <span v-if="task.activeForm || task.description || task.blockedBy.length" class="plan-task__arrow" aria-hidden="true">›</span>
            </button>
            <div v-if="isTaskExpanded(task.id) && (task.activeForm || task.description || task.blockedBy.length)" class="plan-task__body">
              <div v-if="task.activeForm" class="plan-task__row">当前：{{ task.activeForm }}</div>
              <div v-if="task.description" class="plan-task__row">{{ task.description }}</div>
              <div v-if="task.blockedBy.length" class="plan-task__row">被阻塞：{{ task.blockedBy.join(', ') }}</div>
            </div>
          </li>
        </ul>
      </div>
    </template>
  </div>
</template>

<style scoped>
.claude-plan-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.claude-plan-card__empty {
  color: var(--color-text-muted);
  font-size: 0.85em;
  padding: 12px 4px;
  text-align: center;
}

/* TodoWrite 清单 */
.plan-todos__header,
.plan-tasks__header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 4px 4px;
}

.plan-todos__icon,
.plan-tasks__icon {
  width: 14px;
  height: 14px;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.plan-todos__title,
.plan-tasks__title {
  font-size: 0.8em;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.plan-todos__count,
.plan-tasks__count {
  font-size: 0.75em;
  color: var(--color-text-muted);
  margin-left: auto;
}

.plan-todos__list,
.plan-tasks__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

/* Todo 条目 */
.plan-todo-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}

.plan-todo-item:hover {
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}

.plan-todo-item__icon {
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-top: 1px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.plan-todo-item__icon svg {
  width: 14px;
  height: 14px;
}

.plan-todo-item--completed .plan-todo-item__icon {
  color: var(--color-success);
}

.plan-todo-item--in_progress .plan-todo-item__icon {
  color: var(--color-accent);
}

.plan-todo-item--pending .plan-todo-item__icon {
  color: var(--color-text-muted);
}

.plan-todo-item__text {
  font-size: 0.85em;
  line-height: 1.4;
  color: var(--color-text);
  word-break: break-word;
}

/* 完成项删除线：只作用于直属文本 span，不划过图标和徽章 */
.plan-todo-item__text--done {
  text-decoration: line-through;
  color: var(--color-text-muted);
}

/* Task 条目 */
.plan-task__header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  background: none;
  cursor: pointer;
  border-radius: var(--radius-sm);
  text-align: left;
  font: inherit;
  color: inherit;
}

.plan-task__header:hover {
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}

.plan-task__dot {
  flex-shrink: 0;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-muted);
}

.plan-task__dot--in_progress {
  background: var(--color-accent);
  animation: plan-dot-pulse 1.5s ease-in-out infinite;
}

.plan-task__dot--completed {
  background: var(--color-success);
}

.plan-task__dot--failed,
.plan-task__dot--killed {
  background: var(--color-danger);
}

.plan-task__dot--paused {
  background: var(--color-warn);
}

@keyframes plan-dot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@media (prefers-reduced-motion: reduce) {
  .plan-task__dot--in_progress {
    animation: none;
  }
}

.plan-task__subject {
  font-size: 0.85em;
  line-height: 1.4;
  color: var(--color-text);
  word-break: break-word;
  flex: 1;
  min-width: 0;
}

.plan-task__subject--done {
  text-decoration: line-through;
  color: var(--color-text-muted);
}

.plan-task__status {
  font-size: 0.7em;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
}

.plan-task__status--running {
  background: color-mix(in srgb, var(--color-accent) 10%, transparent);
  color: var(--color-accent-strong);
}

.plan-task__status--done {
  background: color-mix(in srgb, var(--color-success) 10%, transparent);
  color: var(--color-success-strong);
}

.plan-task__status--error {
  background: color-mix(in srgb, var(--color-danger) 10%, transparent);
  color: var(--color-danger);
}

.plan-task__status--paused {
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  color: var(--color-warn-strong);
}

.plan-task__arrow {
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 0.85em;
  transition: transform 0.15s ease;
}

.plan-task__header--open .plan-task__arrow {
  transform: rotate(90deg);
}

.plan-task__body {
  padding: 4px 8px 6px 24px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.plan-task__row {
  font-size: 0.78em;
  color: var(--color-text-muted);
  line-height: 1.4;
  word-break: break-word;
}
</style>
