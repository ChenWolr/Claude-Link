<script setup lang="ts">
// 会话底部工具栏：工作空间 / 模型 / 权限 三个带标签的控件 + 删除/中断。
// 按用户要求，所有"会话内容"相关的控件都放在底部（输入区附近），而非顶部。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import ProviderModelSelector from './ProviderModelSelector.vue';
import ThinkingLevelSelector from './ThinkingLevelSelector.vue';
import ContextButton from './ContextButton.vue';
import type { Session } from '../../../shared/types/session';

defineProps<{
  sending?: boolean;
}>();

const emit = defineEmits<{
  abort: [];
  compress: [];
  addAttachment: [];
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

// 从最近目录历史永久删除一条（只移除历史记录，不影响磁盘目录）。菜单保持展开，便于连续删除多条。
async function removeRecent(dir: string) {
  await sessionStore.removeRecentWorkspace(dir);
}

async function clearWorkspace() {
  showWorkspaceMenu.value = false;
  await sessionStore.setActiveSessionWorkingDir(null);
}

// 权限模式：value 对齐 Claude Code 原生字面值（default/acceptEdits/plan/bypassPermissions），
// 仅在 SDK 注入时生效；label/desc/icon 仅用于 UI 展示，不影响底层。
type PermIconKey = 'shield' | 'list' | 'bolt' | 'rocket';

const PERMISSIONS: Array<{
  value: Session['permissionMode'];
  label: string;
  desc: string;
  icon: PermIconKey;
}> = [
  { value: 'default',           label: '默认模式', desc: '禁用手动确认等操作，适合普通使用',         icon: 'shield' },
  { value: 'plan',              label: '规划模式', desc: '仅使用规划工具，生成计划用户审批后执行',   icon: 'list' },
  { value: 'acceptEdits',       label: '代理模式', desc: '自动提交无创建/编辑，减少人为干预',         icon: 'bolt' },
  { value: 'bypassPermissions', label: '自动模式', desc: '无任何限制，越过所有权限检查【谨慎使用】', icon: 'rocket' },
];

// 图标 SVG path（24×24，stroke 风格统一；触发按钮与面板项共用）。
const PERM_ICON_PATHS: Record<PermIconKey, string> = {
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  list:   'M8 6h13 M8 12h13 M8 18h13 M3 6h.01 M3 12h.01 M3 18h.01',
  bolt:   'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  rocket: 'M4.5 16.5 5 19l2.5-.5 M14.5 4.5 18 8 M12 2c3.5 2 6 5.5 6 10 0 2-1 4-1 4H7s-1-2-1-4c0-4.5 2.5-8 6-10z',
};
const CHECK_PATH = 'M20 6 9 17l-5-5';

// 权限面板
const showPermissionMenu = ref(false);
const permissionRef = ref<HTMLElement | null>(null);

const activePermission = computed(
  () => PERMISSIONS.find((p) => p.value === activeSession.value?.permissionMode) ?? PERMISSIONS[0],
);

async function onPermissionChange(mode: Session['permissionMode']) {
  showPermissionMenu.value = false;
  await sessionStore.setActiveSessionPermissionMode(mode);
}

function handleClickOutside(event: MouseEvent) {
  const target = event.target as Node;
  if (showWorkspaceMenu.value && workspaceRef.value && !workspaceRef.value.contains(target)) {
    showWorkspaceMenu.value = false;
  }
  if (showPermissionMenu.value && permissionRef.value && !permissionRef.value.contains(target)) {
    showPermissionMenu.value = false;
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
      <ContextButton :disabled="sending" @compress="emit('compress')" />
    </div>

    <!-- 工作空间 -->
    <div ref="workspaceRef" class="ctl">
      <svg class="ctl__label-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M3 6l2-2h5l2 2h9v12H3z" />
      </svg>
      <button
        type="button"
        :class="['ctl__btn', { 'ctl__btn--warn': !activeSession.workingDir }]"
        :disabled="sending"
        :title="activeSession.workingDir ?? '未选择工作空间（运行前必须选择）'"
        @click="showWorkspaceMenu = !showWorkspaceMenu"
      >
        {{ workspaceLabel }} <span class="caret">▾</span>
      </button>
      <div v-if="showWorkspaceMenu" class="menu">
        <button type="button" class="menu__item menu__item--accent" @click="pickDirectory">📁 选择目录…</button>
        <template v-if="sessionStore.recentWorkspaces.length">
          <div class="menu__section">最近使用</div>
          <div class="menu__recent-list">
            <div
              v-for="dir in sessionStore.recentWorkspaces"
              :key="dir"
              class="menu__row"
              :class="{ 'menu__row--active': dir === activeSession.workingDir }"
            >
              <button
                type="button"
                class="menu__item menu__item--dir"
                :title="dir"
                @click="chooseRecent(dir)"
              >
                {{ dir.replace(/\\/g, '/').split('/').filter(Boolean).slice(-2).join('/') || dir }}
              </button>
              <button
                type="button"
                class="menu__row-delete"
                :title="`从历史删除：${dir}`"
                aria-label="删除目录"
                @click.stop="removeRecent(dir)"
              >
                ✕
              </button>
            </div>
          </div>
        </template>
        <button v-if="activeSession.workingDir" type="button" class="menu__item menu__item--muted" @click="clearWorkspace">
          清除工作空间
        </button>
      </div>
    </div>

    <!-- 模型：供应商 × 模型二级级联（向上弹出；整个会话统一当前实际模型） -->
    <div class="ctl">
      <svg class="ctl__label-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 5h14v14H5z M9 9h6v6H9z" />
      </svg>
      <ProviderModelSelector :disabled="sending" />
    </div>

    <!-- 思考强度：每会话切档（低=快速响应 … 工作流=xhigh+动态编排）；默认跟随全局配置 -->
    <div class="ctl">
      <svg class="ctl__label-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M9 18h6 M10 22h4 M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 6 8c0 1 .23 2.23 1.5 3.5.76.76 1.23 1.52 1.41 2.5" />
      </svg>
      <ThinkingLevelSelector :disabled="sending" />
    </div>

    <!-- 权限：触发按钮显示当前模式，点击向上展开卡片面板 -->
    <div ref="permissionRef" class="ctl">
      <svg class="ctl__label-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 11h14v10H5z M8 11V7a4 4 0 0 1 8 0v4" />
      </svg>
      <button
        type="button"
        class="ctl__btn"
        :disabled="sending"
        :title="`本会话 Claude Code 权限模式（${activePermission.value}）`"
        @click="showPermissionMenu = !showPermissionMenu"
      >
        {{ activePermission.label }} <span class="caret">▾</span>
      </button>
      <div v-if="showPermissionMenu" class="perm-menu">
        <button
          v-for="p in PERMISSIONS"
          :key="p.value"
          type="button"
          :class="['perm-item', { 'perm-item--active': p.value === activeSession.permissionMode }]"
          @click="onPermissionChange(p.value)"
        >
          <span class="perm-item__icon">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="PERM_ICON_PATHS[p.icon]" /></svg>
          </span>
          <span class="perm-item__text">
            <span class="perm-item__label">{{ p.label }}</span>
            <span class="perm-item__desc">{{ p.desc }}</span>
          </span>
          <svg
            v-if="p.value === activeSession.permissionMode"
            class="perm-item__check"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path :d="CHECK_PATH" />
          </svg>
        </button>
      </div>
    </div>

    <!-- 添加文件：权限控件右侧，位置固定紧靠权限；只发事件，粘贴/拖放由 ChatPage 容器处理。
         DOM 序在「中断」之前：中断的 ctl--right(margin-left:auto) 只把自身推到最右，
         不会把添加文件一起带走（否则发送时添加文件会跑到中断右边）。 -->
    <div class="ctl">
      <button
        type="button"
        class="ctl__btn attachment-add-btn"
        :disabled="sending"
        title="添加文件、图片；也支持粘贴和拖入"
        @click="emit('addAttachment')"
      >
        <svg class="ctl__add-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21.44 11.05 12.25 20.24a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.41a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>
    </div>

    <!-- 操作：仅发送中显示中断；ctl--right 推到最右，不影响左侧添加文件位置。 -->
    <div v-if="sending" class="ctl ctl--right">
      <button type="button" class="ctl__btn ctl__btn--abort" @click="emit('abort')">■ 中断</button>
    </div>
  </div>
</template>

<style scoped>
.session-toolbar {
  display: flex;
  align-items: center;
  gap: 1rem;
  flex-wrap: wrap;
  /* 浮岛内部工具栏行：宽度由外层 .chat-composer 统一约束（与 ChatInput 同宽）。
     去掉自带背景融入卡片；保留较小上内边距衔接输入行，底部留白收尾。 */
  width: 100%;
  padding: 6px var(--chat-bottom-pad-x) 10px;
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

.ctl__label-icon {
  flex-shrink: 0;
  width: 0.875rem;
  height: 0.875rem;
  fill: none;
  stroke: var(--color-text-muted);
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
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
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.ctl__btn:hover {
  border-color: var(--color-accent);
}

.ctl__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ctl__btn:disabled:hover {
  border-color: var(--color-border);
}

.ctl__btn--warn {
  border-color: color-mix(in srgb, var(--color-warn) 50%, transparent);
  color: var(--color-warn-strong);
}

.ctl__btn--danger {
  color: var(--color-danger);
  border-color: color-mix(in srgb, var(--color-fail) 50%, transparent);
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
  font-size: 0.625rem;
}

.menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.25rem);
  z-index: 100;
  min-width: 15rem;
  max-width: 22.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 1px;
  box-shadow: var(--elevation-3), var(--ring-light);
}

.menu__item {
  border: 0;
  background: transparent;
  color: var(--color-text);
  padding: 0.4375rem 0.625rem;
  font-size: 0.75rem;
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
  font-size: 0.625rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* 最近目录列表：最多展示 4 条，超出滚动（全局滚动条悬停显现）。 */
.menu__recent-list {
  max-height: 7rem; /* 4 × 1.75rem 固定行高 */
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.menu__row {
  display: flex;
  align-items: center;
  min-height: 1.75rem;
  border-radius: var(--radius-sm);
}

.menu__row:hover {
  background: var(--color-panel-soft);
}

.menu__row--active .menu__item--dir {
  color: var(--color-accent-strong);
}

.menu__item--dir {
  flex: 1;
  min-width: 0;
  height: 1.75rem;
  display: flex;
  align-items: center;
  padding-top: 0;
  padding-bottom: 0;
}

.menu__item--dir,
.menu__item--dir:hover {
  background: transparent;
}

.menu__row-delete {
  flex-shrink: 0;
  width: 1.5rem;
  height: 1.5rem;
  margin-right: 0.25rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
  line-height: 1;
  cursor: pointer;
}

.menu__row-delete:hover {
  color: var(--color-danger);
  background: color-mix(in srgb, var(--color-danger) 12%, transparent);
}

/* 添加文件按钮内的小图标（回形针），与权限图标同 stroke 风格 */
.ctl__add-icon {
  flex-shrink: 0;
  width: 0.875rem;
  height: 0.875rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.85;
}

/* 权限弹出面板：尺寸用 rem，随字号档位等比缩放（迁移批次 2） */
.perm-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 0.25rem);
  z-index: 100;
  min-width: 18.75rem;
  max-width: 23.75rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.375rem;
  display: flex;
  flex-direction: column;
  gap: 0.125rem;
  box-shadow: var(--elevation-3), var(--ring-light);
}

.perm-item {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  width: 100%;
  padding: 0.5rem 0.625rem;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease, transform var(--duration-fast) var(--ease-out);
}

.perm-item:hover,
.perm-item--active {
  background: var(--color-panel-soft);
}

.perm-item__icon {
  flex-shrink: 0;
  width: 2rem;
  height: 2rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: color-mix(in srgb, var(--color-text) 12%, var(--color-panel));
  color: var(--color-text);
}

.perm-item__icon svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.perm-item__text {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  min-width: 0;
  flex: 1;
}

.perm-item__label {
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.2;
}

.perm-item__desc {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.3;
  white-space: normal;
}

.perm-item__check {
  flex-shrink: 0;
  width: 1rem;
  height: 1rem;
  color: var(--color-accent);
  fill: none;
  stroke: currentColor;
  stroke-width: 2.5;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
