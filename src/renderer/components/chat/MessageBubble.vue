<script setup lang="ts">
import { computed } from 'vue';
import type { Message } from '../../../shared/types/session';
import { renderMarkdown } from '../../utils/markdown';
import { enrichMarkdown as vEnrich } from '../../directives/enrich-markdown';

const props = defineProps<{ message: Message }>();

const renderedContent = computed(() => renderMarkdown(props.message.content));
</script>

<template>
  <div :class="['bubble', `bubble--${message.role}`]">
    <div class="bubble__role">{{ message.role === 'user' ? '你' : 'Claude' }}</div>
    <div class="bubble__content markdown-body" v-html="renderedContent" v-enrich />
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
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent), var(--elevation-1);
}

/* 助手消息：左对齐气泡（微信式分层）。panel-soft 底 + 边框与 bg 拉开层次；
   左侧 accent 色条作为「Claude 回复」强标识，让每条回复边界一眼可辨（claude-link
   无头像行，需靠色条+容器替代 openhanako 的头像锚点）。 */
.bubble--assistant {
  align-self: flex-start;
  max-width: 85%;
  padding: 12px 16px;
  background: var(--color-panel-soft);
  border: 1px solid var(--color-border);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-md);
  box-shadow: var(--ring-light), var(--elevation-1);
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
  box-shadow: var(--ring-light), var(--elevation-1);
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

/* 助手正文行高加大到 1.75，长回复阅读更舒展（对齐 openhanako）。 */
.bubble--assistant .bubble__content {
  line-height: 1.75;
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
