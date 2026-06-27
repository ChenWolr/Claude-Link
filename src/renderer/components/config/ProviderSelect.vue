<script setup lang="ts">
import type { AppConfig } from '../../../shared/types/config';

const model = defineModel<AppConfig['provider']>({ required: true });

const providers: Array<{ value: AppConfig['provider']; label: string }> = [
  { value: 'anthropic', label: 'Anthropic' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'bedrock', label: 'Amazon Bedrock' },
  { value: 'vertex', label: 'Google Vertex AI' },
];
</script>

<template>
  <label class="field">
    <span>供应商</span>
    <select v-model="model">
      <option v-for="provider in providers" :key="provider.value" :value="provider.value">
        {{ provider.label }}
      </option>
    </select>
  </label>
</template>

<style scoped>
.field {
  display: grid;
  gap: 8px;
}

.field span {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

select {
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 12px;
}
</style>
