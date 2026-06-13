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
    <div v-if="message.costUsd != null" class="bubble__meta">
      ${{ message.costUsd.toFixed(4) }}
      <span v-if="message.durationMs"> · {{ (message.durationMs / 1000).toFixed(1) }}s</span>
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
  background: #2563eb;
  color: #fff;
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
  font-size: 13px;
}

.bubble--tool {
  align-self: flex-start;
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  max-width: 90%;
}

.bubble__role {
  font-size: 11px;
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
  line-height: 1.6;
}

.bubble__content :deep(p) {
  margin: 0 0 8px;
}

.bubble__content :deep(p:last-child) {
  margin-bottom: 0;
}

.bubble__content :deep(pre) {
  margin: 0;
}

.bubble__meta {
  margin-top: 6px;
  font-size: 11px;
  opacity: 0.6;
}
</style>
