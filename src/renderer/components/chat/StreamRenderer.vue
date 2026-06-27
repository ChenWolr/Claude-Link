<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ content: string }>();

const renderedContent = computed(() => renderMarkdown(props.content));
</script>

<template>
  <div class="stream">
    <div class="stream__role">Claude</div>
    <div class="stream__content markdown-body" v-html="renderedContent" /><span class="cursor">▊</span>
  </div>
</template>

<style scoped>
.stream {
  align-self: flex-start;
  max-width: 75%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
}

.stream__role {
  font-size: 11px;
  font-weight: 700;
  color: var(--color-accent-strong);
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
}

.stream__content {
  word-break: break-word;
  line-height: 1.5;
}

.stream__content :deep(p) {
  margin: 0 0 4px;
}

.stream__content :deep(p:last-child) {
  margin-bottom: 0;
}

.cursor {
  animation: blink 1s step-end infinite;
  color: var(--color-accent-strong);
}

@keyframes blink {
  50% {
    opacity: 0;
  }
}
</style>
