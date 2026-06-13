<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useConfigStore } from '../../stores/config-store';

const sessionStore = useSessionStore();
const configStore = useConfigStore();
const showModelDropdown = ref(false);
const customModelInput = ref('');

const currentModel = computed(() => {
  if (sessionStore.activeSession?.modelOverride) {
    return sessionStore.activeSession.modelOverride;
  }
  return sessionStore.activeSession?.model ?? configStore.config.defaultModel;
});

const displayModel = computed(() => {
  const override = sessionStore.activeSession?.modelOverride;
  return override ? override : `默认: ${currentModel.value}`;
});

async function selectModel(modelId: string) {
  if (!sessionStore.activeSession) return;
  await window.claudeLink.updateModelOverride(sessionStore.activeSession.id, modelId);
  await sessionStore.loadSessions();
  if (sessionStore.activeSession) {
    const updated = sessionStore.sessions.find(s => s.id === sessionStore.activeSession!.id);
    if (updated) sessionStore.activeSession = updated;
  }
  showModelDropdown.value = false;
}

async function clearModelOverride() {
  if (!sessionStore.activeSession) return;
  await window.claudeLink.updateModelOverride(sessionStore.activeSession.id, null);
  await sessionStore.loadSessions();
  if (sessionStore.activeSession) {
    const updated = sessionStore.sessions.find(s => s.id === sessionStore.activeSession!.id);
    if (updated) sessionStore.activeSession = updated;
  }
  showModelDropdown.value = false;
}

async function applyCustomModel() {
  if (!customModelInput.value.trim()) return;
  await selectModel(customModelInput.value.trim());
  customModelInput.value = '';
}

onMounted(async () => {
  await configStore.loadConfig();
  await configStore.fetchModels();
});
</script>

<template>
  <header class="app-header">
    <div>
      <p class="app-header__label">当前会话</p>
      <h2>{{ sessionStore.activeSession?.name ?? '未选择会话' }}</h2>
    </div>
    <div class="model-selector">
      <button type="button" class="model-selector__button" @click="showModelDropdown = !showModelDropdown">
        {{ displayModel }}
      </button>
      <div v-if="showModelDropdown" class="model-dropdown">
        <button type="button" class="model-dropdown__item model-dropdown__default" @click="clearModelOverride">
          默认: {{ configStore.config.defaultModel }}
        </button>
        <button
          v-for="model in configStore.models"
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
  </header>
</template>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 72px;
  padding: 0 24px;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-panel);
}

.app-header__label {
  margin: 0;
  color: var(--color-text-muted);
  font-size: 12px;
}

.app-header h2 {
  margin: 2px 0 0;
  font-size: 18px;
  font-weight: 650;
}

.model-selector {
  position: relative;
}

.model-selector__button {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
  padding: 8px 10px;
  font-size: 12px;
  cursor: pointer;
}

.model-dropdown {
  position: absolute;
  right: 0;
  top: 100%;
  z-index: 100;
  min-width: 220px;
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
