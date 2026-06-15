<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';

const sessionStore = useSessionStore();
const configStore = useConfigStore();
const showModelDropdown = ref(false);
const customModelInput = ref('');
const dropdownRef = ref<HTMLElement | null>(null);

const currentModel = computed(() => {
  if (sessionStore.activeSession?.modelOverride) {
    return sessionStore.activeSession.modelOverride;
  }
  return sessionStore.activeSession?.model ?? configStore.config.defaultModel;
});

const displayModel = computed(() => {
  const override = sessionStore.activeSession?.modelOverride;
  const model = override || currentModel.value;
  const mapping = configStore.modelMappings[model];
  // 显示"类型 → 实际模型"（如 sonnet → glm-5.2）；无映射时只显示类型
  return mapping ? `${model} → ${mapping}` : override ? override : `默认: ${model}`;
});

// 当 fetchModels 拉不到列表（第三方/国产模型端点通常无 /models）时，
// 提供 sonnet/haiku/opus 三个别名——CLI 原生支持，配合 advancedJson 里的
// ANTHROPIC_DEFAULT_*_MODEL 映射 env 转成实际模型。
const FALLBACK_MODELS: Array<{ id: string; name: string }> = [
  { id: 'sonnet', name: 'Sonnet（默认 · 均衡）' },
  { id: 'haiku', name: 'Haiku（快速）' },
  { id: 'opus', name: 'Opus（强力）' },
];

const modelOptions = computed<Array<{ id: string; name: string }>>(() =>
  configStore.models.length > 0 ? configStore.models : FALLBACK_MODELS,
);

async function selectModel(modelId: string) {
  if (!sessionStore.activeSession) return;
  // 复用 store 封装：内部已处理 sessions 数组同步与 activeSession 刷新
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
  await configStore.fetchModels();
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
    <button type="button" class="model-selector__button" title="切换当前会话使用的模型" @click="showModelDropdown = !showModelDropdown">
      {{ displayModel }}
    </button>
    <div v-if="showModelDropdown" class="model-dropdown">
      <button type="button" class="model-dropdown__item model-dropdown__default" @click="clearModelOverride">
        默认: {{ configStore.config.defaultModel }}
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
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}

.model-selector__button:hover {
  color: var(--color-text);
}

/* 下拉向上展开：ModelSelector 处于输入框上方工具栏，避免溢出窗口底部 */
.model-dropdown {
  position: absolute;
  right: 0;
  bottom: 100%;
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
}

.model-dropdown__item {
  border: 0;
  background: transparent;
  color: var(--color-text);
  padding: 8px 12px;
  font-size: 13px;
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
  font-size: 12px;
}

.model-dropdown__custom button {
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--color-accent);
  color: #07120d;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 600;
}
</style>
