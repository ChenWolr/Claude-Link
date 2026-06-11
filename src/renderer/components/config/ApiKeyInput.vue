<script setup lang="ts">
import { ref } from 'vue';

const model = defineModel<string>({ required: true });
const visible = ref(false);
</script>

<template>
  <label class="field">
    <span>API Key</span>
    <div class="input-row">
      <input v-model="model" :type="visible ? 'text' : 'password'" placeholder="sk-ant-..." />
      <button type="button" @click="visible = !visible">{{ visible ? '隐藏' : '显示' }}</button>
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

input {
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
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0 12px;
}
</style>
