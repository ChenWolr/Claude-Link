<script setup lang="ts">
const model = defineModel<string>({ required: true });
</script>

<template>
  <label class="field">
    <span>模型</span>
    <input
      v-model="model"
      type="text"
      placeholder="直接输入模型 ID，例如 claude-sonnet-4-6"
      autocomplete="off"
      spellcheck="false"
    />
    <small class="field-hint">手动填写模型 ID；会话内仍可在顶栏临时切换模型。</small>
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

input {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 10px 12px;
  font-size: 13px;
}

.field-hint {
  color: var(--color-text-muted);
  font-size: 12px;
}
</style>
