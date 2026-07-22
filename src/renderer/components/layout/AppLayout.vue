<script setup lang="ts">
// 应用骨架：左侧栏（会话）+ 中间工作区 + 右侧任务队列。
// 左右两侧栏宽度可拖拽调整；聊天区与两侧栏保留间距；窗口缩放时中间工作区等比伸缩。
import { ref, onMounted, onUnmounted } from 'vue';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';
import TaskQueuePanel from '../task/TaskQueuePanel.vue';

const isTaskPanelOpen = ref(true);

// 可拉伸侧栏宽度（px）。默认值与原 --sidebar-width/--task-panel-width 一致。
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 460;
const TASK_MIN = 240;
const TASK_MAX = 560;
const sidebarWidth = ref(240);
// 右侧栏新增 ~48px 图标轨，默认宽度 320→340 补偿内容区横向空间。
const taskWidth = ref(340);

// 拖拽逻辑：在手柄上 mousedown 记录起点，document 上 mousemove 更新宽度，mouseup 解绑。
let dragging: 'sidebar' | 'task' | null = null;
let startX = 0;
let startWidth = 0;

function onSidebarResizeStart(e: MouseEvent) {
  dragging = 'sidebar';
  startX = e.clientX;
  startWidth = sidebarWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
}
function onTaskResizeStart(e: MouseEvent) {
  dragging = 'task';
  startX = e.clientX;
  startWidth = taskWidth.value;
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';
  e.preventDefault();
}
function onMouseMove(e: MouseEvent) {
  if (!dragging) return;
  if (dragging === 'sidebar') {
    // 左侧栏：鼠标右移 → 变宽
    const w = startWidth + (e.clientX - startX);
    sidebarWidth.value = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));
  } else if (dragging === 'task') {
    // 右侧栏：鼠标左移 → 变宽
    const w = startWidth - (e.clientX - startX);
    taskWidth.value = Math.min(TASK_MAX, Math.max(TASK_MIN, w));
  }
}
function onMouseUp() {
  if (!dragging) return;
  dragging = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onMounted(() => {
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});
onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
});
</script>

<template>
  <div
    class="app-shell"
    :style="{ '--sidebar-width': sidebarWidth + 'px', '--task-panel-width': taskWidth + 'px' }"
  >
    <AppSidebar />
    <div class="resize-handle resize-handle--sidebar" @mousedown="onSidebarResizeStart" title="拖动调整侧栏宽度" />

    <section class="workspace">
      <AppHeader />
      <main class="workspace-main">
        <slot />
      </main>
    </section>

    <template v-if="isTaskPanelOpen">
      <div class="resize-handle resize-handle--task" @mousedown="onTaskResizeStart" title="拖动调整队列宽度" />
      <TaskQueuePanel />
    </template>
    <button v-else class="reopen-task-panel" type="button" @click="isTaskPanelOpen = true">队列</button>
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  width: 100vw;
  height: 100vh;
  background: var(--color-bg);
}

.workspace {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

/* 聊天区与两侧栏保留间距（窗口缩放时工作区等比伸缩由 flex:1 自然承担） */
.workspace-main {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
  padding: 0 16px;
}

/* 拖拽手柄：贴在侧栏边缘的窄条，hover 高亮 */
.resize-handle {
  flex-shrink: 0;
  width: 5px;
  cursor: col-resize;
  background: transparent;
  transition: background 0.12s;
  z-index: 20;
}
.resize-handle:hover,
.resize-handle:active {
  background: var(--color-accent);
}

.reopen-task-panel {
  position: fixed;
  right: 12px;
  top: 84px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  box-shadow: var(--elevation-2), var(--ring-light);
  color: var(--color-text);
  padding: 8px 10px;
}
</style>
