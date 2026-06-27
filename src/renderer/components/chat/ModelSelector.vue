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

// 只显示实际模型名（如 glm-5.1），不显示"别名 → 实际"。
// 动态读 configStore.modelMappings，用户改映射此处跟着变（非写死）。
const displayModel = computed(() => {
  const override = sessionStore.activeSession?.modelOverride;
  const alias = override || sessionStore.activeSession?.model || effectiveDefault.value;
  return configStore.modelMappings[alias] || alias;
});

// 可选项：用户在配置里映射过的别名优先展示（带"别名 → 实际模型"），
// 未映射的标准别名也列出（CLI 走默认）。这是"选已配置模型"的核心。
const modelOptions = computed<Array<{ id: string; name: string }>>(() => {
  const mappings = configStore.modelMappings;
  const opts: Array<{ id: string; name: string }> = [];
  const seen = new Set<string>();
  for (const alias of ALIASES) {
    if (mappings[alias]) {
      opts.push({ id: alias, name: `${alias} → ${mappings[alias]}` });
      seen.add(alias);
    }
  }
  for (const alias of ALIASES) {
    if (!seen.has(alias)) opts.push({ id: alias, name: alias });
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
    <button type="button" class="model-selector__button" :disabled="props.disabled" title="切换当前会话使用的模型" @click="showModelDropdown = !showModelDropdown">
      {{ displayModel }}
    </button>
    <div v-if="showModelDropdown" class="model-dropdown">
      <button type="button" class="model-dropdown__item model-dropdown__default" @click="clearModelOverride">
        默认: {{ effectiveDefault }}{{ configStore.modelMappings[effectiveDefault] ? ` → ${configStore.modelMappings[effectiveDefault]}` : '' }}
      </button>
      <button
        v-for="model in modelOptions"
        :key="model.id"
        type="button"
        :class="['model-dropdown__item', { active: model.id === currentModel }]"
        @click="selectModel(model.id)"
      >
        {{ model.name || model.id }}
      </button>
      <div class="model-dropdown__custom">
        <input v-model="customModelInput" placeholder="自定义模型名" />
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
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 4px 10px;
  font-size: 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}

.model-selector__button:hover {
  color: var(--color-text);
}

.model-selector__button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.model-selector__button:disabled:hover {
  color: var(--color-text-muted);
}

/* 下拉向上展开：ModelSelector 位于底部会话工具栏，避免溢出窗口底部 */
.model-dropdown {
  position: absolute;
  right: 0;
  bottom: calc(100% + 4px);
  z-index: 100;
  min-width: 220px;
  margin-bottom: 4px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 8px 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
}

.model-dropdown__item {
  border: 0;
  background: transparent;
  color: var(--color-text);
  padding: 8px 12px;
  font-size: 0.8125rem;
  cursor: pointer;
  text-align: left;
}

.model-dropdown__item:hover {
  background: var(--color-panel-soft);
}

.model-dropdown__item.active {
  color: var(--color-accent-strong);
}

.model-dropdown__default {
  color: var(--color-text-muted);
  border-bottom: 1px solid var(--color-border);
  margin-bottom: 4px;
  padding-bottom: 10px;
}

.model-dropdown__custom {
  display: flex;
  gap: 6px;
  padding: 8px 12px;
  border-top: 1px solid var(--color-border);
  margin-top: 4px;
}

.model-dropdown__custom input {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 6px 8px;
  font-size: 0.75rem;
}

.model-dropdown__custom button {
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: #07120d;
  padding: 6px 10px;
  font-size: 0.75rem;
  font-weight: 600;
}
</style>
