<script setup lang="ts">
import { ref, computed, nextTick } from 'vue';
import { useRoute } from 'vue-router';
import { useSessionStore } from '../../stores/session-store';
import { useTaskStore } from '../../stores/task-store';
import { useExportImageStore } from '../../stores/export-image-store';

const route = useRoute();
const sessionStore = useSessionStore();
const taskStore = useTaskStore();
const exportStore = useExportImageStore();
const activeSession = computed(() => sessionStore.activeSession);

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
// - 会话不在发送或队列执行态（running/continuing）；
// - 没有其他图片导出任务正在运行。
const canExport = computed(() => {
  if (route.name !== 'chat') return false;
  if (!activeSession.value) return false;
  if (sessionStore.sending) return false;
  const q = taskStore.queueState.status;
  if (q === 'running' || q === 'continuing') return false;
  if (exportStore.running) return false;
  return true;
});
const exportBusyTooltip = computed(() => {
  if (!exportStore.running) return '';
  return `正在导出长图… ${exportStore.percent}%`;
});

async function handleExport() {
  if (!canExport.value || !activeSession.value) return;
  await exportStore.start(activeSession.value.id, activeSession.value.name);
}
</script>

<template>
  <header class="app-header">
    <div class="app-header__title">
      <p class="app-header__label">当前会话</p>
      <div v-if="activeSession" class="app-header__name">
        <input
          v-if="editing"
          ref="inputRef"
          v-model="draftName"
          class="app-header__name-input"
          maxlength="80"
          @keydown.enter.prevent="commitEdit"
          @keydown.esc="cancelEdit"
          @blur="commitEdit"
        />
        <template v-else>
          <h2 :title="activeSession.name">{{ activeSession.name }}</h2>
          <button type="button" class="app-header__rename" title="重命名会话" @click="startEdit">✎</button>
        </template>
      </div>
      <h2 v-else>未选择会话</h2>
    </div>
    <button
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

.app-header__rename {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  cursor: pointer;
  padding: 2px 4px;
  opacity: 0.6;
}

.app-header__rename:hover {
  opacity: 1;
  color: var(--color-accent-strong);
}

/* 分享（导出长图）按钮：纯图标，最右侧。启用态 accent 描边，busy 态脉冲，完成态短暂高亮。 */
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
