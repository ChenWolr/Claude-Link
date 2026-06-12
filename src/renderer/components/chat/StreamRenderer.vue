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
  line-height: 1.6;
}

.stream__content :deep(p) {
  margin: 0 0 8px;
}

.stream__content :deep(p:last-child) {
  margin-bottom: 0;
}

.stream__content :deep(.code-block) {
  margin: 10px 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
  background: #0d1117;
}

.stream__content :deep(.code-block__header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: #1a1e2e;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text-muted);
}

.stream__content :deep(.code-block__copy) {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 8px;
}

.stream__content :deep(.code-block code) {
  display: block;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
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
