<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useConfigStore } from '../stores/config-store';
import ProviderSelect from '../components/config/ProviderSelect.vue';
import ApiKeyInput from '../components/config/ApiKeyInput.vue';
import ModelSelect from '../components/config/ModelSelect.vue';

const store = useConfigStore();
const toast = ref<string | null>(null);
const toastType = ref<'success' | 'error'>('success');

onMounted(async () => {
  await store.loadConfig();
  await store.detectCli();
});

async function handleSave() {
  try {
    await store.saveConfig();
    toastType.value = 'success';
    toast.value = '配置已保存';
  } catch {
    toastType.value = 'error';
    toast.value = store.error ?? '保存失败';
  }

  setTimeout(() => {
    toast.value = null;
  }, 3000);
}

async function handleFetchModels() {
  await store.fetchModels();
  if (store.models.length > 0 && store.config.defaultModel === '') {
    store.config.defaultModel = store.models[0].id;
  }
}
</script>

<template>
  <section class="config-page">
    <header class="config-page__header">
      <div>
        <p class="eyebrow">Settings</p>
        <h1>配置</h1>
      </div>
    </header>

    <!-- CLI Status Banner -->
    <div v-if="store.detectingCli" class="banner banner--info">正在检测 Claude Code CLI...</div>
    <div v-else-if="store.cliStatus?.installed" class="banner banner--ok">
      ✅ Claude Code CLI 已安装 — {{ store.cliStatus.version }} ({{ store.cliStatus.path }})
    </div>
    <div v-else class="banner banner--warn">
      ⚠️ 未检测到 Claude Code CLI。请先安装：npm install -g @anthropic-ai/claude-code
    </div>

    <div v-if="toast" :class="['toast', `toast--${toastType}`]">{{ toast }}</div>
    <div v-if="store.error && !toast" class="toast toast--error">{{ store.error }}</div>

    <form class="config-form" @submit.prevent="handleSave">
      <ProviderSelect v-model="store.config.provider" />
      <ApiKeyInput v-model="store.config.apiKey" />
      <ModelSelect
        v-model="store.config.defaultModel"
        :models="store.models"
        :loading="store.fetchingModels"
        @refresh="handleFetchModels"
      />

      <label class="field">
        <span>权限模式</span>
        <select v-model="store.config.permissionMode">
          <option value="default">default</option>
          <option value="acceptEdits">acceptEdits</option>
          <option value="plan">plan</option>
          <option value="bypassPermissions">bypassPermissions</option>
        </select>
      </label>

      <label class="field">
        <span>任务间延迟（秒）</span>
        <input v-model.number="store.config.taskDelaySeconds" type="number" min="0" />
      </label>

      <label class="field">
        <span>最大轮次</span>
        <input v-model.number="store.config.maxTurns" type="number" min="1" />
      </label>

      <button class="save-button" type="submit" :disabled="store.savingConfig">
        {{ store.savingConfig ? '保存中...' : '保存配置' }}
      </button>
    </form>
  </section>
</template>

<style scoped>
.config-page {
  max-width: 640px;
  padding: 32px;
}

.config-page__header {
  margin-bottom: 24px;
}

.config-page__header h1 {
  margin: 4px 0 0;
  font-size: 24px;
}

.eyebrow {
  margin: 0;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.banner {
  border-radius: var(--radius-md);
  padding: 12px 16px;
  margin-bottom: 20px;
  font-size: 13px;
}

.banner--ok {
  border: 1px solid #2a6e4a;
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.banner--warn {
  border: 1px solid #8a6d2b;
  background: rgba(204, 163, 61, 0.12);
  color: #e0c36a;
}

.banner--info {
  border: 1px solid var(--color-border);
  background: var(--color-panel-soft);
  color: var(--color-text-muted);
}

.toast {
  border-radius: var(--radius-md);
  padding: 10px 14px;
  margin-bottom: 16px;
  font-size: 13px;
}

.toast--success {
  border: 1px solid #2a6e4a;
  background: rgba(58, 166, 117, 0.12);
  color: #5fd6a0;
}

.toast--error {
  border: 1px solid #8a3b3b;
  background: rgba(239, 100, 97, 0.12);
  color: #f08887;
}

.config-form {
  display: grid;
  gap: 20px;
}

.field {
  display: grid;
  gap: 8px;
}

.field span {
  color: var(--color-text-muted);
  font-size: 13px;
}

select,
input[type='number'] {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 12px;
}

.save-button {
  margin-top: 8px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 12px;
  font-size: 15px;
  font-weight: 700;
}

.save-button:disabled {
  cursor: wait;
  opacity: 0.7;
}
</style>
