<script setup lang="ts">
// 会话底部工具栏：工作空间 / 模型 / 权限 三个带标签的控件 + 删除/中断。
// 按用户要求，所有"会话内容"相关的控件都放在底部（输入区附近），而非顶部。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import ModelSelector from './ModelSelector.vue';
import ContextButton from './ContextButton.vue';
import type { Session } from '../../../shared/types/session';

defineProps<{
  sending?: boolean;
}>();

const emit = defineEmits<{
  abort: [];
  compress: [];
}>();

const sessionStore = useSessionStore();
const activeSession = computed(() => sessionStore.activeSession);

// 工作空间下拉
const showWorkspaceMenu = ref(false);
const workspaceRef = ref<HTMLElement | null>(null);

const workspaceLabel = computed(() => {
  const dir = activeSession.value?.workingDir;
  if (!dir) return '未选择';
  const parts = dir.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || dir;
});

async function pickDirectory() {
  const dir = await window.claudeLink.pickWorkspaceDir();
  showWorkspaceMenu.value = false;
  if (dir) await sessionStore.setActiveSessionWorkingDir(dir);
}

async function chooseRecent(dir: string) {
  showWorkspaceMenu.value = false;
  await sessionStore.setActiveSessionWorkingDir(dir);
}

async function clearWorkspace() {
  showWorkspaceMenu.value = false;
  await sessionStore.setActiveSessionWorkingDir(null);
}

// 权限模式
const PERMISSIONS: Array<{ value: Session['permissionMode']; label: string }> = [
  { value: 'default', label: 'default' },
  { value: 'acceptEdits', label: 'acceptEdits' },
  { value: 'plan', label: 'plan' },
  { value: 'bypassPermissions', label: 'bypass' },
];

async function onPermissionChange(e: Event) {
  const mode = (e.target as HTMLSelectElement).value as Session['permissionMode'];
  await sessionStore.setActiveSessionPermissionMode(mode);
}

function handleClickOutside(event: MouseEvent) {
  if (showWorkspaceMenu.value && workspaceRef.value && !workspaceRef.value.contains(event.target as Node)) {
    showWorkspaceMenu.value = false;
  }
}

onMounted(() => {
  sessionStore.loadRecentWorkspaces();
  document.addEventListener('click', handleClickOutside);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
});
</script>

<template>
  <div v-if="activeSession" class="session-toolbar">
    <!-- 上下文（真实用量环 + 压缩）：放第一个，圆环自解释，不加文字标签 -->
    <div class="ctl">
      <ContextButton @compress="emit('compress')" />
    </div>

    <!-- 工作空间 -->
    <div ref="workspaceRef" class="ctl">
      <span class="ctl__label">工作空间</span>
      <button
        type="button"
        :class="['ctl__btn', { 'ctl__btn--warn': !activeSession.workingDir }]"
        :title="activeSession.workingDir ?? '未选择工作空间（运行前必须选择）'"
        @click="showWorkspaceMenu = !showWorkspaceMenu"
      >
        {{ workspaceLabel }} <span class="caret">▾</span>
      </button>
      <div v-if="showWorkspaceMenu" class="menu">
        <button type="button" class="menu__item menu__item--accent" @click="pickDirectory">📁 选择目录…</button>
        <template v-if="sessionStore.recentWorkspaces.length">
          <div class="menu__section">最近使用</div>
          <button
            v-for="dir in sessionStore.recentWorkspaces"
            :key="dir"
            type="button"
            :class="['menu__item', { 'menu__item--active': dir === activeSession.workingDir }]"
            :title="dir"
            @click="chooseRecent(dir)"
          >
            {{ dir.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || dir }}
          </button>
        </template>
        <button v-if="activeSession.workingDir" type="button" class="menu__item menu__item--muted" @click="clearWorkspace">
          清除工作空间
        </button>
      </div>
    </div>

    <!-- 模型 -->
    <div class="ctl">
      <span class="ctl__label">模型</span>
      <ModelSelector />
    </div>

    <!-- 权限 -->
    <label class="ctl ctl--select" title="本会话 Claude Code 权限模式（--permission-mode）">
      <span class="ctl__label">权限</span>
      <select :value="activeSession.permissionMode" @change="onPermissionChange">
        <option v-for="p in PERMISSIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
      </select>
    </label>

    <!-- 操作：仅发送中显示中断；删除会话走左侧栏 -->
    <div v-if="sending" class="ctl ctl--right">
      <button type="button" class="ctl__btn ctl__btn--abort" @click="emit('abort')">■ 中断</button>
    </div>
  </div>
</template>

<style scoped>
.session-toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  flex-wrap: wrap;
  /* 占满聊天区宽度、内容左对齐，与 ChatInput 同宽（修 #1/#3）。 */
  width: 100%;
  /* 与 ChatInput 融为一个连续底部面板：去掉中间 border-top，统一水平 padding，
     仅保留较小上内边距衔接输入栏，底部留白收尾。 */
  padding: 6px var(--chat-bottom-pad-x) 10px;
  background: var(--color-panel);
}

.ctl {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.ctl--right {
  margin-left: auto;
}

.ctl__label {
  color: var(--color-text-muted);
  font-size: 11px;
  white-space: nowrap;
}

.ctl__btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 200px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 5px 10px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctl__btn:hover {
  border-color: var(--color-accent);
}

.ctl__btn--warn {
  border-color: rgba(204, 163, 61, 0.5);
  color: #e0c36a;
}

.ctl__btn--danger {
  color: var(--color-danger);
  border-color: rgba(239, 100, 97, 0.4);
}

.ctl__btn--danger-solid {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: #1a0606;
  font-weight: 700;
}

.ctl__btn--abort {
  background: var(--color-danger);
  border-color: var(--color-danger);
  color: #fff;
  font-weight: 700;
}

.caret {
  opacity: 0.6;
  font-size: 10px;
}

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 4px);
  z-index: 100;
  min-width: 240px;
  max-width: 360px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.menu__item {
  border: 0;
  background: transparent;
  color: var(--color-text);
  padding: 7px 10px;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.menu__item:hover {
  background: var(--color-panel-soft);
}

.menu__item--accent {
  color: var(--color-accent-strong);
  font-weight: 600;
}

.menu__item--active {
  color: var(--color-accent-strong);
}

.menu__item--muted {
  color: var(--color-text-muted);
}

.menu__section {
  padding: 6px 10px 2px;
  color: var(--color-text-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.ctl--select select {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 5px 8px;
  font-size: 12px;
  cursor: pointer;
}
</style>
