<script setup lang="ts">
import { ref } from 'vue';
import type { Message } from '../../../shared/types/session';

defineProps<{ message: Message }>();
const expanded = ref(false);
</script>

<template>
  <div class="tool-call" @click="expanded = !expanded">
    <div class="tool-call__header">
      <span class="tool-call__icon">🔧</span>
      <span class="tool-call__label">{{ message.eventType }}</span>
      <span class="tool-call__toggle">{{ expanded ? '收起' : '展开' }}</span>
    </div>
    <div v-if="expanded" class="tool-call__body">
      <pre>{{ message.content }}</pre>
    </div>
    <div v-if="message.costUsd != null" class="tool-call__meta">
      ${{ message.costUsd.toFixed(4) }}
    </div>
  </div>
</template>

<style scoped>
.tool-call {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  cursor: pointer;
  overflow: hidden;
}

.tool-call__header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
}

.tool-call__icon {
  font-size: 14px;
}

.tool-call__label {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-accent-strong);
}

.tool-call__toggle {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__body {
  border-top: 1px solid var(--color-border);
  padding: 12px 14px;
  max-height: 300px;
  overflow: auto;
}

.tool-call__body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__meta {
  padding: 6px 14px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
