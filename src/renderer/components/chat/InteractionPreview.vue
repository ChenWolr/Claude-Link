<script setup lang="ts">
import { computed, ref } from 'vue';
import { html as diffToHtml } from 'diff2html';
import hljs from 'highlight.js';
import MarkdownIt from 'markdown-it';
import type { InteractionPromptPreview } from '../../../shared/types/ipc';

const props = defineProps<{
  preview?: string | InteractionPromptPreview;
  compact?: boolean;
}>();

const copied = ref(false);
const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true,
  highlight(code, language) {
    const lang = language && hljs.getLanguage(language) ? language : 'plaintext';
    return hljs.highlight(code, { language: lang }).value;
  },
});

const normalized = computed<InteractionPromptPreview | null>(() => {
  if (!props.preview) return null;
  if (typeof props.preview === 'string') return { type: 'text', content: props.preview };
  if (props.preview.type === 'table') {
    return { type: 'table', headers: props.preview.headers ?? [], rows: props.preview.rows ?? [] };
  }
  return props.preview;
});

const copyText = computed(() => {
  const preview = normalized.value;
  if (!preview) return '';
  if (preview.type === 'table') {
    const rows = [preview.headers ?? [], ...(preview.rows ?? [])].filter((row) => row.length);
    return rows.map((row) => row.join('\t')).join('\n');
  }
  return preview.content ?? '';
});

const renderedMarkdown = computed(() => markdown.render(normalized.value?.content ?? ''));
const renderedCode = computed(() => {
  const preview = normalized.value;
  const code = preview?.content ?? '';
  const language = preview?.language && hljs.getLanguage(preview.language) ? preview.language : 'plaintext';
  return hljs.highlight(code, { language }).value;
});
const renderedDiff = computed(() => diffToHtml(normalized.value?.content ?? '', {
  drawFileList: false,
  matching: 'lines',
  outputFormat: 'line-by-line',
}));

async function copyPreview(): Promise<void> {
  if (!copyText.value) return;
  await navigator.clipboard?.writeText(copyText.value);
  copied.value = true;
  window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}
</script>

<template>
  <aside class="interaction-preview" :class="{ 'interaction-preview--compact': compact }" aria-label="选项预览">
    <div class="interaction-preview__bar">
      <div>
        <div class="interaction-preview__label">Preview</div>
        <small v-if="normalized?.type === 'code' && normalized.language">{{ normalized.language }}</small>
        <small v-else-if="normalized">{{ normalized.type }}</small>
      </div>
      <button type="button" class="interaction-preview__copy" :disabled="!copyText" @click="copyPreview">
        {{ copied ? '已复制' : '复制' }}
      </button>
    </div>

    <div v-if="!normalized" class="interaction-preview__empty">当前选项没有预览内容</div>
    <div v-else-if="normalized.type === 'markdown'" class="interaction-preview__markdown" v-html="renderedMarkdown" />
    <pre v-else-if="normalized.type === 'code'" class="interaction-preview__content interaction-preview__content--code"><code v-html="renderedCode" /></pre>
    <div v-else-if="normalized.type === 'diff'" class="interaction-preview__diff" v-html="renderedDiff" />
    <div v-else-if="normalized.type === 'table'" class="interaction-preview__table-wrap">
      <table>
        <thead v-if="normalized.headers?.length">
          <tr><th v-for="header in normalized.headers" :key="header">{{ header }}</th></tr>
        </thead>
        <tbody>
          <tr v-for="(row, rowIndex) in normalized.rows" :key="rowIndex">
            <td v-for="(cell, cellIndex) in row" :key="cellIndex">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <pre v-else class="interaction-preview__content">{{ normalized.content }}</pre>
  </aside>
</template>

<style scoped>
.interaction-preview {
  min-width: 0;
  overflow: hidden;
  border: 1px solid color-mix(in srgb, var(--color-accent-strong) 18%, var(--color-border));
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
}

.interaction-preview--compact .interaction-preview__content,
.interaction-preview--compact .interaction-preview__markdown,
.interaction-preview--compact .interaction-preview__diff,
.interaction-preview--compact .interaction-preview__table-wrap {
  max-height: 16.25rem;
}

.interaction-preview__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.625rem 0.75rem 0.5rem;
  border-bottom: 1px solid var(--color-border);
}

.interaction-preview__label {
  color: var(--color-accent-strong);
  font-size: 0.625rem;
  font-weight: 850;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.interaction-preview__bar small {
  color: var(--color-text-muted);
  font-size: 0.6875rem;
}

.interaction-preview__copy {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0.3125rem 0.5625rem;
  background: var(--color-panel-soft);
  color: var(--color-text);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.interaction-preview__copy:disabled {
  cursor: not-allowed;
  opacity: 0.5;
}

.interaction-preview__content,
.interaction-preview__markdown,
.interaction-preview__diff,
.interaction-preview__table-wrap {
  max-height: 22.5rem;
  overflow: auto;
  padding: 0.75rem;
}

.interaction-preview__content {
  margin: 0;
  color: var(--color-text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 0.75rem;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.interaction-preview__content--code {
  background: color-mix(in srgb, var(--color-accent) 6%, var(--color-panel-soft));
}

.interaction-preview__diff {
  border-left: 3px solid var(--color-accent-strong);
  color: var(--color-text);
  font-size: 0.75rem;
}

.interaction-preview__markdown {
  color: var(--color-text);
  font-size: 0.8125rem;
  line-height: 1.6;
}

.interaction-preview__markdown :deep(code) {
  border-radius: var(--radius-xs);
  padding: 0.0625rem 0.3125rem;
  background: color-mix(in srgb, var(--color-accent) 8%, var(--color-panel-soft));
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.interaction-preview__markdown :deep(pre code) {
  display: block;
  padding: 0.625rem;
}

.interaction-preview__markdown :deep(h1),
.interaction-preview__markdown :deep(h2),
.interaction-preview__markdown :deep(h3),
.interaction-preview__markdown :deep(h4) {
  margin: 0.5rem 0;
  color: var(--color-accent-strong);
}

.interaction-preview__markdown :deep(a) {
  color: var(--color-accent-strong);
}

.interaction-preview__table-wrap table {
  width: 100%;
  border-collapse: collapse;
  color: var(--color-text);
  font-size: 0.75rem;
}

.interaction-preview__table-wrap th,
.interaction-preview__table-wrap td {
  padding: 0.4375rem 0.5rem;
  border: 1px solid var(--color-border);
  text-align: left;
}

.interaction-preview__table-wrap th {
  color: var(--color-accent-strong);
  background: color-mix(in srgb, var(--color-accent) 6%, var(--color-panel-soft));
}

.interaction-preview__empty {
  padding: 1.125rem 0.75rem;
  color: var(--color-text-muted);
  font-size: 0.75rem;
  line-height: 1.5;
}
</style>
