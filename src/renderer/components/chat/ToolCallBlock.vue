<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Message } from '../../../shared/types/session';
import { isDiffContent, renderDiffHtml, renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ message: Message }>();
const expanded = ref(false);

const parsedJson = computed<Record<string, unknown> | null>(() => {
  try {
    return JSON.parse(props.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }
});

const isDiff = computed(() => props.message.eventType === 'tool_result' && isDiffContent(props.message.content));
const isJson = computed(() => props.message.eventType === 'tool_use' && !!parsedJson.value);
const renderedDiff = computed(() => (isDiff.value ? renderDiffHtml(props.message.content) : ''));
const renderedMarkdown = computed(() => renderMarkdown(props.message.content));
</script>

<template>
  <div class="tool-call" @click="expanded = !expanded">
    <div class="tool-call__header">
      <span class="tool-call__icon">🔧</span>
      <span class="tool-call__label">{{ message.eventType }}</span>
      <span v-if="isJson && parsedJson?.name" class="tool-call__name">{{ parsedJson.name }}</span>
      <span class="tool-call__toggle">{{ expanded ? '收起' : '展开' }}</span>
    </div>
    <div v-if="expanded" class="tool-call__body">
      <div v-if="isJson && parsedJson" class="tool-call__json">
        <div class="tool-call__json-row"><strong>工具</strong>: {{ parsedJson.name }}</div>
        <div class="tool-call__json-row"><strong>输入</strong>:</div>
        <pre>{{ JSON.stringify(parsedJson.input ?? parsedJson, null, 2) }}</pre>
      </div>
      <div v-else-if="isDiff" class="tool-call__diff markdown-body" v-html="renderedDiff" />
      <div v-else class="tool-call__markdown markdown-body" v-html="renderedMarkdown" />
    </div>
    <div v-if="message.costUsd != null" class="tool-call__meta">
      ${{ message.costUsd.toFixed(4) }}
      <span v-if="message.durationMs"> · {{ (message.durationMs / 1000).toFixed(1) }}s</span>
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

.tool-call__name {
  border: 1px solid var(--color-border);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.tool-call__toggle {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__body {
  border-top: 1px solid var(--color-border);
  padding: 12px 14px;
  max-height: 420px;
  overflow: auto;
}

.tool-call__json-row {
  margin-bottom: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__body pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__markdown :deep(p) {
  margin: 0 0 8px;
}

.tool-call__markdown :deep(.code-block) {
  margin: 10px 0;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
  background: #0d1117;
}

.tool-call__markdown :deep(.code-block__header),
.tool-call__diff :deep(.code-block__header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: #1a1e2e;
  border-bottom: 1px solid var(--color-border);
  font-size: 12px;
  color: var(--color-text-muted);
}

.tool-call__markdown :deep(.code-block__copy),
.tool-call__diff :deep(.code-block__copy) {
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 8px;
}

.tool-call__markdown :deep(.code-block code) {
  display: block;
  padding: 12px 16px;
  overflow-x: auto;
  font-size: 13px;
  line-height: 1.6;
}

.tool-call__diff :deep(.d2h-wrapper) {
  overflow-x: auto;
}

.tool-call__diff :deep(.d2h-file-header) {
  display: none;
}

.tool-call__meta {
  padding: 6px 14px;
  border-top: 1px solid var(--color-border);
  font-size: 11px;
  color: var(--color-text-muted);
}
</style>
