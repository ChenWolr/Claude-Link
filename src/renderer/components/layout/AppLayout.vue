<script setup lang="ts">
// 应用骨架：左侧栏（会话）+ 中间工作区 + 右侧任务队列。
// 左右两侧栏宽度可拖拽调整；聊天区与两侧栏保留间距；窗口缩放时中间工作区等比伸缩。
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { useRoute } from 'vue-router';
import AppHeader from './AppHeader.vue';
import AppSidebar from './AppSidebar.vue';
import TaskQueuePanel from '../task/TaskQueuePanel.vue';
import { useSessionStore } from '../../stores/session-store';
import { useTaskStore } from '../../stores/task-store';

const sessionStore = useSessionStore();
const taskStore = useTaskStore();

// B4 两级断点（K6）面板半：≤1100 强制收活动面板。JS matchMedia 而非纯 CSS——
// 唤回条显隐是行为态；标志仅视口态，渲染层合法（五问 2）。
// 〔边界申报：≤800 侧栏 overlay 半（mqSidebar/sidebarForceHidden/sidebarOverlayOpen/AppHeader
// toggle 钮）与 AppSidebar B1-B3/B6 重排同属 slate 回路未落盘工作，无 selftest 清单钉，本点不实施。〕
const mqPanel = window.matchMedia('(max-width: 1100px)');
const panelForceHidden = ref(mqPanel.matches);      // 初值取 matches，窄窗首绘无闪变
const panelRecalled = ref(false);                   // ≤1100 下用户点击唤回的覆盖标志（B-C1）

function onMqPanelChange(e: MediaQueryListEvent) { panelForceHidden.value = e.matches; if (!e.matches) panelRecalled.value = false; }
// 兜底复位（与 onMqPanelChange 内复位双保险，防漏接 change 时序）
watch(panelForceHidden, (hidden) => { if (!hidden) panelRecalled.value = false; });

// UI13-P4：侧栏折叠态（内存态，store 持有）——折叠时隐藏左侧栏拖宽手柄（sidebarWidth ref 不动，
// 展开恢复用户此前拖拽宽度；折叠宽由 AppSidebar .sidebar--collapsed 固定 48px 覆盖）。

// 右侧活动栏（队列/子Agent/后台/改动）是会话工作区的一部分：仅 chat 路由渲染；
// 配置页/会话管理页隐藏（AppHeader 同款路由感知，右栏此前遗漏）。
// 队列事件监听已全局化到 App.vue，面板卸载不影响后台队列事件处理。
const route = useRoute();
const isChatRoute = computed(() => route.name === 'chat');

// 可拉伸侧栏宽度（px）。sidebar 默认 240 与原 --sidebar-width 一致；task 默认经 320→340 调整（见下），不再等于 variables.css 的 --task-panel-width: 320px（该变量仅存兜底）。
const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 460;
const TASK_MIN = 240;
const TASK_MAX = 560;
// D1（八问题批次 2026-11-15）：宽度持久化四键之二（折叠双键在 session-store LS_COLLAPSE）——
// 读点=ref 初始化经 readWidth（非有限数/越 min-max 回落默认；min/max 与拖拽钳制同一常量，
// 拖宽纳入持久化），写点=onMouseUp 拖拽收尾单点写回（try/catch 静默；拖动中不写，省 IO 且
// 避免中间值入库）。刷新/重启/网页刷新后保留（桌面按 userData partition、网页按 origin 隔离）。
const LS_WIDTH = { sidebar: 'cl.sidebarWidth', task: 'cl.taskPanelWidth' } as const;
function readWidth(key: string, fallback: number, min: number, max: number): number {
  try { const v = Number(localStorage.getItem(key)); return Number.isFinite(v) && v >= min && v <= max ? v : fallback; } catch { return fallback; }
}
const sidebarWidth = ref(readWidth(LS_WIDTH.sidebar, 240, SIDEBAR_MIN, SIDEBAR_MAX));
// 右侧栏新增 ~48px 图标轨，默认宽度 320→340 补偿内容区横向空间。
// （340 默认为既有契约钉 selftest-settings-mapping/tdd-rightpanel-route-gate；持久化读回紧随
// 其后单次赋值——无记录时 readWidth 即回 340，行为与直读形态等价。）
const taskWidth = ref(340);
taskWidth.value = readWidth(LS_WIDTH.task, 340, TASK_MIN, TASK_MAX);

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
  // D1：拖拽收尾把终值写回 localStorage（仅本次拖拽目标键，单点写回；try/catch 静默——
  // 隐私模式 setItem 抛错时宽度仍在本会话内存生效）。
  if (dragging === 'sidebar') {
    try { localStorage.setItem(LS_WIDTH.sidebar, String(sidebarWidth.value)); } catch { /* 静默 */ }
  } else if (dragging === 'task') {
    try { localStorage.setItem(LS_WIDTH.task, String(taskWidth.value)); } catch { /* 静默 */ }
  }
  dragging = null;
  document.body.style.cursor = '';
  document.body.style.userSelect = '';
}

onMounted(() => {
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
  mqPanel.addEventListener('change', onMqPanelChange);
});
onUnmounted(() => {
  document.removeEventListener('mousemove', onMouseMove);
  document.removeEventListener('mouseup', onMouseUp);
  mqPanel.removeEventListener('change', onMqPanelChange);
});
</script>

<template>
  <div
    class="app-shell"
    :style="{ '--sidebar-width': sidebarWidth + 'px', '--task-panel-width': taskWidth + 'px' }"
  >
    <AppSidebar />
    <!-- UI13-P4：折叠期间手柄隐藏（v-if 门控，折叠态不可拖宽；sidebarWidth 不被折叠触碰，展开恢复） -->
    <div v-if="!sessionStore.sidebarCollapsed" class="resize-handle resize-handle--sidebar" @mousedown="onSidebarResizeStart" title="拖动调整侧栏宽度" />

    <section class="workspace">
      <AppHeader />
      <main class="workspace-main">
        <slot />
      </main>
    </section>

    <template v-if="isChatRoute && (!panelForceHidden || panelRecalled)">
      <!-- D1：折叠态手柄隐藏（v-if 门控）——右栏只剩 48px 图标轨，残条/死手柄（视觉 53px）消除；
           展开恢复手柄与记忆宽（taskWidth 不被折叠触碰）。 -->
      <div v-if="!sessionStore.overviewCollapsed" class="resize-handle resize-handle--task" @mousedown="onTaskResizeStart" title="拖动调整队列宽度" />
      <TaskQueuePanel />
    </template>
    <!-- B4：≤1100 断点强制隐藏后的唤回条 pill（裁决 B-C1 内联回唤；K6/D1-07 图标+队列+计数角标；
         计数源 taskStore.tasks=当前活动会话 pending 任务视图，0 计数角标不渲染、图标+「队列」恒显）。 -->
    <button
      v-else-if="isChatRoute && panelForceHidden && !panelRecalled"
      class="reopen-task-panel"
      type="button"
      aria-label="队列"
      @click="panelRecalled = true"
    >
      <svg class="reopen-task-panel__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2" /></svg>
      <span>队列</span>
      <span v-if="taskStore.tasks.length" class="reopen-task-panel__badge">{{ taskStore.tasks.length }}</span>
    </button>
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

/* B4 唤回条改 pill（K6/D1-07）：图标 + 队列 + 计数角标；位置沿用现状 right:12/top:84 */
.reopen-task-panel {
  position: fixed;
  right: 12px;
  top: 84px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  background: var(--color-panel-soft);
  box-shadow: var(--elevation-2), var(--ring-light);
  color: var(--color-text);
  padding: 6px 12px;
  cursor: pointer;
}
.reopen-task-panel__icon {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.reopen-task-panel__badge {
  min-width: 18px;
  height: 18px;
  display: grid;
  place-items: center;
  padding: 0 5px;
  border-radius: var(--radius-pill);
  background: var(--color-accent);
  color: var(--color-on-accent);
  font-size: 0.65625rem;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
}
</style>
