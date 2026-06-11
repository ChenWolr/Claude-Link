<script setup lang="ts">
import type { ModelInfo } from '../../../shared/types/config';

const model = defineModel<string>({ required: true });
defineProps<{
  models: ModelInfo[];
  loading: boolean;
}>();

defineEmits<{
  refresh: [];
}>();
</script>

<template>
  <label class="field">
    <span>模型</span>
    <div class="input-row">
      <select v-model="model">
        <option value="claude-sonnet-4-6">claude-sonnet-4-6</option>
        <option v-for="item in models" :key="item.id" :value="item.id">
          {{ item.name }}
        </option>
      </select>
      <button type="button" :disabled="loading" @click="$emit('refresh')">
        {{ loading ? '刷新中' : '刷新' }}
      </button>
    </div>
  </label>
</template>

<style scoped>
.field {
  display: grid;
  gap: 8px;
}

.field span {
  color: var(--color-text-muted);
  font-size: 13px;
}

.input-row {
  display: flex;
  gap: 8px;
}

select {
  min-width: 0;
  flex: 1;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 12px;
}

button {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 0 14px;
  font-weight: 700;
}

button:disabled {
  cursor: wait;
  opacity: 0.7;
}
</style>
