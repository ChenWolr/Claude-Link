<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';

const props = withDefaults(defineProps<{ disabled?: boolean }>(), { disabled: false });
const sessionStore = useSessionStore();
const configStore = useConfigStore();
const showModelDropdown = ref(false);
const customModelInput = ref('');
const dropdownRef = ref<HTMLElement | null>(null);

// Claude Code 类型别名优先级：sonnet 最常用作兜底默认。
const ALIASES = ['sonnet', 'haiku', 'opus', 'fable'] as const;

// 每个别名的展示元信息（定位说明 + 图标 key）。仅 UI 展示用，不影响底层 modelOverride。
type ModelIconKey = 'star' | 'zap' | 'gem' | 'flame';
const ALIAS_META: Record<string, { desc: string; icon: ModelIconKey }> = {
  sonnet: { desc: '默认推荐，通用均衡', icon: 'star' },
  haiku:  { desc: '轻量快速，简单任务', icon: 'zap' },
  opus:   { desc: '最强推理，复杂任务', icon: 'gem' },
  fable:  { desc: '新一代模型，实验性', icon: 'flame' },
};

// 图标 SVG path（24×24，stroke 风格，与权限面板一致）。
const MODEL_ICON_PATHS: Record<ModelIconKey, string> = {
  star:  'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z',
  zap:   'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
  gem:   'M2 9l4-6h12l4 6-10 13z M11 3 8 9l4 13 M13 3l3 6-4 13',
  flame: 'M12 2c0 4-4 5-4 9a4 4 0 0 0 8 0c0-2-1-3-2-4 0 1-1 2-2 2 0-3 2-5 0-7z',
};
const RESET_PATH = 'M3 12a9 9 0 1 0 3-6.7L3 8 M3 3v5h5';
const CHECK_PATH = 'M20 6 9 17l-5-5';

// 有效默认别名：取配置里首个已映射的别名，都没有则 'sonnet'。
// （与主进程 resolveDefaultModel 同规则；不再用死的 config.defaultModel。）
const effectiveDefault = computed(() => {
  const mappings = configStore.modelMappings;
  for (const a of ALIASES) {
    if (mappings[a]) return a;
  }
  return 'sonnet';
});

const currentModel = computed(
  () => sessionStore.activeSession?.modelOverride || sessionStore.activeSession?.model || effectiveDefault.value,
);

// 触发按钮只显示实际模型名（如 glm-5.1）。动态读 configStore.modelMappings。
const displayModel = computed(() => {
  const override = sessionStore.activeSession?.modelOverride;
  const alias = override || sessionStore.activeSession?.model || effectiveDefault.value;
  return configStore.modelMappings[alias] || alias;
});

const defaultModelName = computed(() => configStore.modelMappings[effectiveDefault.value] || effectiveDefault.value);

// 卡片选项：已映射别名显示真实模型名 + 定位说明；未映射的显示别名 + 走 CLI 默认提示。
const modelOptions = computed<Array<{ id: string; label: string; desc: string; icon: ModelIconKey; mapped: boolean }>>(() => {
  const mappings = configStore.modelMappings;
  const meta = (alias: string) => ALIAS_META[alias] ?? { desc: '', icon: 'star' as ModelIconKey };
  const opts: Array<{ id: string; label: string; desc: string; icon: ModelIconKey; mapped: boolean }> = [];
  const seen = new Set<string>();
  for (const alias of ALIASES) {
    if (mappings[alias]) {
      const m = meta(alias);
      opts.push({ id: alias, label: mappings[alias], desc: `${alias} · ${m.desc}`, icon: m.icon, mapped: true });
      seen.add(alias);
    }
  }
  for (const alias of ALIASES) {
    if (!seen.has(alias)) {
      const m = meta(alias);
      opts.push({ id: alias, label: alias, desc: `${alias} · 未映射，走 CLI 默认`, icon: m.icon, mapped: false });
    }
  }
  return opts;
});

async function selectModel(modelId: string) {
  if (!sessionStore.activeSession) return;
  await sessionStore.updateActiveSessionModelOverride(modelId);
  showModelDropdown.value = false;
}

async function clearModelOverride() {
  if (!sessionStore.activeSession) return;
  await sessionStore.updateActiveSessionModelOverride(null);
  showModelDropdown.value = false;
}

async function applyCustomModel() {
  if (!customModelInput.value.trim()) return;
  await selectModel(customModelInput.value.trim());
  customModelInput.value = '';
}

function handleClickOutside(event: MouseEvent) {
  if (showModelDropdown.value && dropdownRef.value && !dropdownRef.value.contains(event.target as Node)) {
    showModelDropdown.value = false;
  }
}

function handleEscape() {
  if (showModelDropdown.value) {
    showModelDropdown.value = false;
  }
}

onMounted(async () => {
  await configStore.loadConfig();
  document.addEventListener('click', handleClickOutside);
  document.addEventListener('keydown', handleEscape);
});

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside);
  document.removeEventListener('keydown', handleEscape);
});
</script>

<template>
  <div ref="dropdownRef" class="model-selector">
    <button
      type="button"
      class="model-selector__button"
      :disabled="props.disabled"
      title="切换当前会话使用的模型"
      @click="showModelDropdown = !showModelDropdown"
    >
      {{ displayModel }} <span class="caret">▾</span>
    </button>
    <div v-if="showModelDropdown" class="model-menu">
      <!-- 恢复默认 -->
      <button type="button" class="model-item model-item--default" @click="clearModelOverride">
        <span class="model-item__icon model-item__icon--muted">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="RESET_PATH" /></svg>
        </span>
        <span class="model-item__text">
          <span class="model-item__label">默认</span>
          <span class="model-item__desc">恢复全局默认（{{ defaultModelName }}）</span>
        </span>
      </button>
      <div class="model-menu__sep" />
      <!-- 别名模型列表 -->
      <button
        v-for="m in modelOptions"
        :key="m.id"
        type="button"
        :class="['model-item', { 'model-item--active': m.id === currentModel, 'model-item--unmapped': !m.mapped }]"
        @click="selectModel(m.id)"
      >
        <span class="model-item__icon">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path :d="MODEL_ICON_PATHS[m.icon]" /></svg>
        </span>
        <span class="model-item__text">
          <span class="model-item__label">{{ m.label }}</span>
          <span class="model-item__desc">{{ m.desc }}</span>
        </span>
        <svg
          v-if="m.id === currentModel"
          class="model-item__check"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path :d="CHECK_PATH" />
        </svg>
      </button>
      <!-- 自定义模型名 -->
      <div class="model-custom">
        <input v-model="customModelInput" placeholder="自定义模型名" @keydown.enter="applyCustomModel" />
        <button type="button" @click="applyCustomModel">应用</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.model-selector {
  position: relative;
}

.model-selector__button {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  max-width: 12.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.3125rem 0.625rem;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.model-selector__button:hover {
  border-color: var(--color-accent);
}

.model-selector__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.caret {
  opacity: 0.6;
  font-size: 0.625rem;
}

/* 下拉向上展开：ModelSelector 位于底部会话工具栏，避免溢出窗口底部。
   尺寸用 rem，随字号档位等比缩放（迁移批次 2）。 */
.model-menu {
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

.model-item {
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

.model-item:hover,
.model-item--active {
  background: var(--color-panel-soft);
}

/* 默认项与列表之间的分隔线（1px 像素对齐，保留 px） */
.model-menu__sep {
  height: 1px;
  margin: 0.25rem 0.375rem;
  background: var(--color-border);
}

.model-item__icon {
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

.model-item__icon svg {
  width: 1rem;
  height: 1rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 2;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.model-item__icon--muted {
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.model-item__text {
  display: flex;
  flex-direction: column;
  gap: 0.0625rem;
  min-width: 0;
  flex: 1;
}

.model-item__label {
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.2;
}

.model-item__desc {
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  line-height: 1.3;
  white-space: normal;
}

.model-item--unmapped .model-item__label {
  color: var(--color-text-muted);
}

.model-item__check {
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

.model-custom {
  display: flex;
  gap: 0.375rem;
  padding: 0.5rem 0.625rem;
  margin-top: 0.25rem;
  border-top: 1px solid var(--color-border);
}

.model-custom input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.375rem 0.5rem;
  font-size: 0.75rem;
}

.model-custom input:focus {
  outline: none;
  border-color: var(--color-accent);
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--color-accent) 18%, transparent);
}

.model-custom button {
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
  padding: 0.375rem 0.625rem;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}

.model-custom button:hover {
  background: var(--color-accent-strong);
}
</style>
