<script setup lang="ts">
// ThinkingBlock —— openhanako 风格的轻量思考行。
// 一行「💭 思考完成 / 思考中 ···」，点击展开看内容。流式时默认展开。
import { computed, ref } from 'vue';
import { renderMarkdown } from '../../utils/markdown';

const props = defineProps<{ content: string; streaming?: boolean; sealed?: boolean; defaultOpen?: boolean }>();

const open = ref(props.defaultOpen ?? !!props.streaming);
const rendered = computed(() => renderMarkdown(props.content));
const preview = computed(() => props.content.replace(/\s+/g, ' ').trim().slice(0, 90));
const active = computed(() => props.streaming || props.sealed === false);
</script>

<template>
  <div class="think-row">
    <button type="button" class="think-row__head" :class="{ 'think-row__head--open': open }" @click="open = !open">
      <span class="think-row__icon">💭</span>
      <span class="think-row__label">{{ active ? '思考中' : '思考完成' }}</span>
      <span v-if="active" class="think-row__dots">···</span>
      <span v-else-if="!open && preview" class="think-row__preview">{{ preview }}…</span>
      <span class="think-row__arrow">›</span>
    </button>
    <div v-if="open" class="think-row__body markdown-body" v-html="rendered" />
  </div>
</template>

<style scoped>
.think-row {
  width: 100%;
}

.think-row__head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 8px;
  font-size: 13px;
  color: var(--color-text-muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  text-align: left;
  font-family: inherit;
  border-radius: var(--radius-sm);
  transition: background 0.15s, color 0.15s;
}

.think-row__head:hover {
  color: var(--color-text);
  background: color-mix(in srgb, var(--color-text) 6%, transparent);
}

.think-row__icon {
  font-size: 14px;
  flex-shrink: 0;
}

.think-row__label {
  font-weight: 500;
  white-space: nowrap;
  flex-shrink: 0;
}

.think-row__dots {
  color: var(--color-accent-strong);
  letter-spacing: 0.12em;
  font-weight: 700;
}

.think-row__preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  opacity: 0.7;
}

.think-row__arrow {
  margin-left: auto;
  flex-shrink: 0;
  color: var(--color-text-muted);
  font-size: 12px;
  transition: transform 0.15s;
}

.think-row__head--open .think-row__arrow {
  transform: rotate(90deg);
}

.think-row__body {
  padding: 8px 10px 10px;
  margin: 2px 0 2px 6px;
  border-left: 2px solid var(--color-border);
  font-size: 13px;
  color: var(--color-text);
  line-height: 1.5;
  word-break: break-word;
}

.think-row__body :deep(p) {
  margin: 0 0 4px;
}

.think-row__body :deep(p:last-child) {
  margin-bottom: 0;
}
</style>
