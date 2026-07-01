<script setup lang="ts">
import { computed } from 'vue';

const model = defineModel<string>({ required: true });
const props = defineProps<{ mappings?: Record<string, string> }>();

// 若当前 model 是有映射的别名，显示"→ 实际模型"提示
const mappingHint = computed(() => (props.mappings && props.mappings[model.value]) || '');
</script>

<template>
  <label class="field">
    <span>模型</span>
    <input
      v-model="model"
      type="text"
      placeholder="模型 ID 或别名 sonnet/haiku/opus/fable"
      autocomplete="off"
      spellcheck="false"
    />
    <small v-if="mappingHint" class="field-hint field-hint--mapped">→ {{ mappingHint }}</small>
    <small v-else class="field-hint">手动填写模型 ID 或别名（sonnet/haiku/opus）；会话内可在顶栏切换。</small>
  </label>
</template>

<style scoped>
.field {
  display: grid;
  gap: 0.5rem;
}

.field span {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
}

input {
  min-width: 0;
  width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 0.625rem 0.75rem;
  font-size: 0.8125rem;
}

.field-hint {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.field-hint--mapped {
  color: var(--color-accent-strong);
}
</style>
