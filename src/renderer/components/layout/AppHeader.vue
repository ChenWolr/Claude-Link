<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useTaskStore } from '../../stores/task-store';
import { useExportImageStore } from '../../stores/export-image-store';
import ExportImageFormatDialog from '../export/ExportImageFormatDialog.vue';
import type { ExportImageFormat } from '@shared/types/export-image';

const route = useRoute();
const router = useRouter();
const sessionStore = useSessionStore();
const taskStore = useTaskStore();
const exportStore = useExportImageStore();
const activeSession = computed(() => sessionStore.activeSession);

// 顶栏标题按路由切换：chat 页显示「当前会话 + 会话标题」，配置/会话管理页显示各自页面标题。
// 会话标题只属于聊天页；进入配置页后左上角不应再出现会话名，而应显示「配置」。
const isChat = computed(() => route.name === 'chat');

// 会话管理入口（B3，裁决 B-C4 双路由渲染）：chat 页点击进 /sessions，会话管理页点击回 /
// （toggle 语义对齐原型与 D1-03 方案；title/aria「会话管理」与 pageTitle 同源文案）。
function toggleSessionsPage(): void {
  router.push(route.name === 'sessions' ? '/' : '/sessions');
}
const pageTitle = computed(() => {
  if (route.name === 'config') return '配置';
  if (route.name === 'sessions') return '会话管理';
  return '';
});

// 标题重命名：点击 ✎ 进入内联编辑，Enter/blur 保存，Esc 取消。
const editing = ref(false);
const draftName = ref('');
const inputRef = ref<HTMLInputElement | null>(null);

async function startEdit() {
  if (!activeSession.value) return;
  draftName.value = activeSession.value.name;
  editing.value = true;
  await nextTick();
  inputRef.value?.focus();
  inputRef.value?.select();
}

async function commitEdit() {
  if (!editing.value) return;
  editing.value = false;
  const name = draftName.value.trim();
  if (name && activeSession.value && name !== activeSession.value.name) {
    await sessionStore.renameActiveSession(name);
  }
}

function cancelEdit() {
  editing.value = false;
}

// 分享（导出长图）按钮启用条件（v3 第 4.1 节）：
// - 当前路由是 chat；存在活动会话；
// - 会话不在发送中、队列引擎不在 running 态（standby/countdown 允许导出）；
// - 没有其他图片导出任务正在运行。
const canExport = computed(() => {
  if (route.name !== 'chat') return false;
  if (!activeSession.value) return false;
  if (sessionStore.sending) return false;
  const q = taskStore.queueState.status;
  if (q === 'running') return false;
  if (exportStore.running) return false;
  return true;
});
const exportBusyTooltip = computed(() => {
  if (!exportStore.running) return '';
  return `正在导出长图… ${exportStore.percent}%`;
});

async function handleExport() {
  if (!canExport.value || !activeSession.value) return;
  // v4.1：分享先开格式选择弹窗，确认后再 start。
  fmtDialogOpen.value = true;
}

const fmtDialogOpen = ref(false);
async function onFormatConfirm(format: ExportImageFormat): Promise<void> {
  fmtDialogOpen.value = false;
  if (!activeSession.value) return;
  await exportStore.start(activeSession.value.id, activeSession.value.name, format);
}
function onFormatCancel(): void {
  fmtDialogOpen.value = false;
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__left">
      <div class="app-header__title">
      <template v-if="isChat">
        <p class="app-header__label">当前会话</p>
        <div v-if="activeSession" class="app-header__name">
          <!-- .stop 阻断冒泡：sending 中重命名按 Esc 取消编辑，不得冒泡到 ChatPage 急停误触发中断。 -->
          <input
            v-if="editing"
            ref="inputRef"
            v-model="draftName"
            class="app-header__name-input"
            maxlength="80"
            aria-label="重命名会话"
            @keydown.enter.prevent="commitEdit"
            @keydown.esc.stop="cancelEdit"
            @blur="commitEdit"
          />
          <template v-else>
            <h2 :title="activeSession.name">{{ activeSession.name }}</h2>
            <!-- B6 重命名钮图标化（pencil 线稿）：title/aria 双钉「重命名会话」，行为矩阵不变（点击 startEdit）。 -->
            <button type="button" class="app-header__rename" title="重命名会话" aria-label="重命名会话" @click="startEdit">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
            </button>
          </template>
        </div>
        <h2 v-else>未选择会话</h2>
      </template>
      <h2 v-else class="app-header__page-title">{{ pageTitle }}</h2>
    </div>
    </div>
    <div class="app-header__right">
      <!-- 会话管理入口（B3）：chat 页点击进 /sessions，会话管理页点击回 /（toggle 语义）。 -->
      <button
        v-if="isChat || route.name === 'sessions'"
        type="button"
        class="app-header__manage"
        title="会话管理"
        aria-label="会话管理"
        @click="toggleSessionsPage"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m16 6 4 14" /><path d="M12 6v14" /><path d="M8 8v12" /><path d="M4 4v16" />
        </svg>
      </button>
      <button
        v-if="isChat"
        type="button"
        class="app-header__share"
      :class="{ 'app-header__share--busy': exportStore.running, 'app-header__share--done': exportStore.phase === 'done' }"
      :disabled="!canExport"
      :title="exportBusyTooltip || (canExport ? '导出为长图' : '导出为长图')"
      @click="handleExport"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="18" cy="5" r="3" />
        <circle cx="6" cy="12" r="3" />
        <circle cx="18" cy="19" r="3" />
        <line x1="8.59" y1="13.51" x2="15.42" y2="17.49" />
        <line x1="15.41" y1="6.51" x2="8.59" y2="10.49" />
      </svg>
    </button>
    </div>
    <ExportImageFormatDialog
      :open="fmtDialogOpen"
      :busy="exportStore.running"
      @confirm="onFormatConfirm"
      @cancel="onFormatCancel"
    />
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  height: 56px;
  padding: 0 24px;
  border-bottom: 1px solid var(--color-border-strong);
  background: var(--color-panel);
}

.app-header__title {
  min-width: 0;
}

.app-header__label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.app-header__name {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 1px;
}

.app-header__title h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 60vw;
}

.app-header__name-input {
  font-size: 1rem;
  font-weight: 650;
  color: var(--color-text);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-accent);
  border-radius: var(--radius-sm);
  padding: 2px 8px;
  outline: none;
  max-width: 60vw;
}

/* 重命名钮（B6 图标化）：pencil 线稿钮；文字色/opacity/hover 原规则零改动（仅加 inline-flex 对齐与 svg 线稿规则）。 */
.app-header__rename {
  display: inline-flex;
  align-items: center;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  cursor: pointer;
  padding: 2px 4px;
  opacity: 0.6;
}

.app-header__rename svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.app-header__rename:hover {
  opacity: 1;
  color: var(--color-accent-strong);
}

/* 左组（B4 重排）：标题区贴左；flex:1 承接标题贴左、右组贴右（.app-header 仍 space-between）。 */
.app-header__left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  flex: 1;
}

/* 右组（B3 落地）：会话管理钮 + 分享钮并排（B4 重排后此容器仅承载右端两钮）。 */
.app-header__right {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

/* 会话管理入口钮（B3）：复制分享钮 34×34 图标钮基座（border/panel-soft/hover accent 提亮），
   不含导出语义专属的 busy/done 修饰与 pulse 动画。 */
.app-header__manage {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.app-header__manage svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.app-header__manage:hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-soft));
}

/* 分享（导出长图）按钮：纯图标，最右侧。hover 提亮为 accent 描边，busy 态脉冲，完成态短暂高亮。 */
.app-header__share {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  padding: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s, background 0.15s;
}
.app-header__share svg {
  width: 17px;
  height: 17px;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.app-header__share:not(:disabled):hover {
  color: var(--color-accent-strong);
  border-color: color-mix(in srgb, var(--color-accent) 50%, var(--color-border));
  background: color-mix(in srgb, var(--color-accent) 10%, var(--color-panel-soft));
}
.app-header__share:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.app-header__share--busy {
  color: var(--color-accent-strong);
  border-color: var(--color-accent);
  animation: share-pulse 1.2s infinite ease-in-out;
}
.app-header__share--done {
  color: var(--color-accent-strong);
  border-color: var(--color-accent);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel-soft));
}
@keyframes share-pulse {
  0%, 100% { opacity: 0.55; }
  50% { opacity: 1; }
}

@media (prefers-reduced-motion: reduce) {
  .app-header__share--busy {
    animation: none !important;
  }
}
</style>
