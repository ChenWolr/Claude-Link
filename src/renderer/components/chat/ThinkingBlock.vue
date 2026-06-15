<script setup lang="ts">
import { computed, ref } from 'vue';
import { renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ content: string; streaming?: boolean }>();

const open = ref(false);
const rendered = computed(() => renderMarkdown(props.content));
const preview = computed(() => props.content.replace(/\s+/g, ' ').trim().slice(0, 50));
</script>

<template>
  <div class="thinking">
    <button type="button" class="thinking__toggle" @click="open = !open">
      <span class="thinking__icon">{{ open ? '▼' : '▶' }}</span>
      <span class="thinking__label">{{ streaming ? '思考中…' : '思考过程' }}</span>
      <span v-if="!open && preview" class="thinking__preview">{{ preview }}…</span>
    </button>
    <div v-if="open" class="thinking__content markdown-body" v-html="rendered" />
  </div>
</template>

<style scoped>
.thinking {
  align-self: flex-start;
  max-width: 80%;
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  overflow: hidden;
}

.thinking__toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  padding: 8px 12px;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.thinking__toggle:hover {
  color: var(--color-text);
}

.thinking__icon {
  font-size: 10px;
}

.thinking__label {
  font-weight: 600;
  white-space: nowrap;
}

.thinking__preview {
  color: var(--color-text-muted);
  opacity: 0.7;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}

.thinking__content {
  padding: 8px 12px 12px;
  border-top: 1px dashed var(--color-border);
  color: var(--color-text-muted);
  font-size: 12px;
  line-height: 1.6;
  word-break: break-word;
}

.thinking__content :deep(p) {
  margin: 0 0 6px;
}

.thinking__content :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
