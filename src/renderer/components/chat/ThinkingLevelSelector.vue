<script setup lang="ts">
// 会话级思考强度选择器：复刻 SessionToolbar 权限面板的内联下拉模式（项目无通用 Dropdown 组件）。
// 触发按钮显示当前档位图标（null=自动/跟随全局默认）；点击向上展开卡片选项；click outside / Escape 关闭。
// 选中后调 sessionStore.setActiveSessionThinkingLevel，与 setActiveSessionPermissionMode 同构。
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';
import type { ThinkingLevel } from '../../../shared/types/thinking';

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const showMenu = ref(false);
const menuRef = ref<HTMLElement | null>(null);

// 档位元信息：value 对齐 ThinkingLevel 联合；label/desc 仅 UI 展示。
// desc 文案为中性描述（§1.6：effort 对 thinking_tokens 的实际影响待批次 B 实测后再细化）。
interface ThinkingOption {
  value: ThinkingLevel;
  label: string;
  desc: string;
  danger?: boolean;
}
const LEVELS: ThinkingOption[] = [
  { value: 'auto',      label: '自动',   desc: '跟随全局默认档位' },
  { value: 'low',       label: '低',     desc: '快速响应，成本最低' },
  { value: 'medium',    label: '中',     desc: '平衡（默认推荐）' },
  { value: 'high',      label: '高',     desc: '更深入分析' },
  { value: 'xhigh',     label: '超高',   desc: '复杂推理' },
  { value: 'max',       label: '极限',   desc: '最高强度，成本最高' },
  { value: 'ultracode', label: '工作流', desc: 'xhigh + 动态工作流编排（Beta）', danger: true },
];

const CHECK_PATH = 'M20 6 9 17l-5-5';

// 当前档位：会话 thinkingLevel（null→'auto'）。'auto' 时 tooltip 追加全局默认档名。
const activeValue = computed<ThinkingLevel>(() => sessionStore.activeSession?.thinkingLevel ?? 'auto');
const activeOption = computed<ThinkingOption>(
  () => LEVELS.find((l) => l.value === activeValue.value) ?? LEVELS[0],
);
const isCustom = computed(() => activeValue.value !== 'auto');

// 'auto' 时显示全局默认档名，让用户知道「自动」实际是哪一档。
const globalDefaultLabel = computed(() => {
  const g = configStore.config.defaultThinkingLevel;
  return LEVELS.find((l) => l.value === g)?.label ?? '中';
});

const triggerTitle = computed(
  () => `思考强度：${activeOption.value.label}${activeValue.value === 'auto' ? `（跟随全局默认：${globalDefaultLabel.value}）` : `（${activeOption.value.desc}）`}`,
);

async function onSelect(level: ThinkingLevel) {
  showMenu.value = false;
  await sessionStore.setActiveSessionThinkingLevel(level);
}

function handleClickOutside(event: MouseEvent) {
  if (showMenu.value && menuRef.value && !menuRef.value.contains(event.target as Node)) {
    showMenu.value = false;
  }
}
function handleEscape() {
  if (showMenu.value) showMenu.value = false;
}

onMounted(() => {
  // configStore 已在 ConfigPage/ModelSelector 加载；此处仅保险读取全局默认档名。
  void configStore.config;
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEscape);
});
onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEscape);
});
</script>

<template>
  <div ref="menuRef" class="tl-selector">
    <button
      type="button"
      :class="['tl-btn', { 'tl-btn--custom': isCustom }]"
      :disabled="props.disabled"
      :title="triggerTitle"
      @click="showMenu = !showMenu"
    >
      {{ activeOption.label }} <span class="tl-caret">▾</span>
    </button>
    <div v-if="showMenu" class="tl-menu">
      <button
        v-for="opt in LEVELS"
        :key="opt.value"
        type="button"
        :class="['tl-item', { 'tl-item--active': opt.value === activeValue, 'tl-item--danger': opt.danger }]"
        @click="onSelect(opt.value)"
      >
        <span class="tl-item__text">
          <span class="tl-item__label">
            {{ opt.label }}
            <small v-if="opt.value === 'auto'" class="tl-item__sub">（全局默认：{{ globalDefaultLabel }}）</small>
          </span>
          <span class="tl-item__desc">{{ opt.desc }}</span>
        </span>
        <svg
          v-if="opt.value === activeValue"
          class="tl-item__check"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path :d="CHECK_PATH" />
        </svg>
      </button>
    </div>
  </div>
</template>

<style scoped>
.tl-selector {
  position: relative;
}

.tl-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}

.tl-btn:hover {
  border-color: var(--color-accent);
}

.tl-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.tl-caret {
  opacity: 0.6;
  font-size: 0.625rem;
}

/* 非自动档：触发按钮加 accent 边框，提示本会话已设自定义思考强度 */
.tl-btn--custom {
  border-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  color: var(--color-accent-strong);
}

/* 下拉向上展开（与权限/模型面板一致），尺寸用 rem 随字号档位等比缩放 */
.tl-menu {
  position: absolute;
  right: 0;
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

.tl-item {
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

.tl-item:hover,
.tl-item--active {
  background: var(--color-panel-soft);
}

/* ultracode 危险态：warn 边框提示成本最高 / Beta */
.tl-item--danger {
  border: 1px solid color-mix(in srgb, var(--color-warn) 45%, transparent);
}

.tl-item__text {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  min-width: 0;
  flex: 1;
}

.tl-item__label {
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.2;
}

.tl-item__sub {
  font-weight: 400;
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.tl-item__desc {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.3;
  white-space: normal;
}

.tl-item__check {
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
