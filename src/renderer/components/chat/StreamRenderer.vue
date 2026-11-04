<script setup lang="ts">
import { computed } from 'vue';
import { renderMarkdown } from '../../utils/markdown';
import { useFilePreview } from '../../composables/useFilePreview';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';

const props = defineProps<{ content: string }>();

const renderedContent = computed(() => renderMarkdown(props.content));

// fix-2 F5：流式态正文的文件链接点击委托，与 MessageBubble.vue 的 onContentClick 同实现
//（文件内自含、不跨组件抽公共——最小影响面）。markdown.ts link_open 规则把 .md-file-link 的
// href 置 javascript:void(0)：没有委托时流式期间（shared 渲染面）的文件链接是死按钮。
function onContentClick(e: MouseEvent): void {
  const el = (e.target as HTMLElement | null)?.closest?.('.md-file-link') as HTMLElement | null;
  if (!el) return;
  const p = el.getAttribute('data-clip-path');
  if (p) useFilePreview().open(p);
}
</script>

<template>
  <div class="stream">
    <div class="stream__role">Claude</div>
    <div class="stream__content markdown-body" v-html="renderedContent" v-enrich @click="onContentClick" /><span class="cursor">▊</span>
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
  box-shadow: var(--ring-light), var(--elevation-1);
}

.stream__role {
  font-size: 0.6875rem;
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
  margin: 0 0 0.25rem;
}

.stream__content :deep(p:last-child) {
  margin-bottom: 0;
}

/* fix-2 F5：文件链接按钮化样式，与 MessageBubble.vue 的两组 :deep(.md-file-link) 同款——
   accent 色 + 点状下划线标示「可点开预览」，与普通网页外链区分；v-html 内容须 :deep 穿透，
   hover 切实线下划线给明确可点反馈。 */
.stream__content :deep(.md-file-link) {
  color: var(--color-accent-strong);
  font-weight: 500;
  cursor: pointer;
  text-decoration: underline dotted;
  text-decoration-color: color-mix(in srgb, var(--color-accent) 55%, transparent);
  text-underline-offset: 4px;
}

.stream__content :deep(.md-file-link:hover) {
  text-decoration-style: solid;
  color: var(--color-accent);
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
