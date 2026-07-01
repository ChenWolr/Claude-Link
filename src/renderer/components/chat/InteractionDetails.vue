<script setup lang="ts">
import { computed } from 'vue';

const props = defineProps<{
  input?: Record<string, unknown>;
}>();

const prettyInput = computed(() => {
  if (!props.input) return '';
  return JSON.stringify(props.input, null, 2);
});
</script>

<template>
  <details v-if="prettyInput" class="interaction-details">
    <summary>查看工具参数</summary>
    <pre>{{ prettyInput }}</pre>
  </details>
</template>

<style scoped>
.interaction-details {
  margin-top: 0.25rem;
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

.interaction-details summary {
  cursor: pointer;
}

.interaction-details pre {
  max-height: 11.25rem;
  margin: 0.5rem 0 0;
  overflow: auto;
  padding: 0.625rem;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.18);
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
