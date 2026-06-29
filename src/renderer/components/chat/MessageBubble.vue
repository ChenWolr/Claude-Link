<script setup lang="ts">
import { computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import { renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ message: Message }>();

const renderedContent = computed(() => renderMarkdown(props.message.content));
</script>

<template>
  <div :class="['bubble', `bubble--${message.role}`]">
    <div class="bubble__role">{{ message.role === 'user' ? '你' : 'Claude' }}</div>
    <div class="bubble__content markdown-body" v-html="renderedContent" />
    <div v-if="message.costUsd != null || message.durationMs" class="bubble__meta">
      <template v-if="message.costUsd != null">${{ message.costUsd.toFixed(4) }}</template>
      <template v-if="message.durationMs">{{ message.costUsd != null ? ' · ' : '' }}{{ (message.durationMs / 1000).toFixed(1) }}s</template>
    </div>
  </div>
</template>

<style scoped>
.bubble {
  max-width: 75%;
  padding: 12px 16px;
  border-radius: var(--radius-md);
}

.bubble--user {
  align-self: flex-end;
  background: var(--color-accent);
  color: #07120d;
}

.bubble--assistant {
  align-self: flex-start;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
}

.bubble--system {
  align-self: center;
  background: transparent;
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  max-width: 90%;
  font-size: 0.8125rem;
}

.bubble--tool {
  align-self: flex-start;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  max-width: 90%;
}

.bubble__role {
  font-size: 0.6875rem;
  font-weight: 700;
  text-transform: uppercase;
  margin-bottom: 6px;
  opacity: 0.7;
}

.bubble--assistant .bubble__role,
.bubble--tool .bubble__role {
  color: var(--color-accent-strong);
}

.bubble__content {
  word-break: break-word;
  line-height: 1.5;
}

.bubble__content :deep(p) {
  margin: 0 0 0.25rem;
}

.bubble__content :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(pre) {
  margin: 0;
}

.bubble__meta {
  margin-top: 6px;
  font-size: 0.6875rem;
  opacity: 0.6;
}
</style>
