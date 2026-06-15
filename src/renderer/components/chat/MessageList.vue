<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ToolCallBlock from './ToolCallBlock.vue';
import ThinkingBlock from './ThinkingBlock.vue';

const props = defineProps<{
  messages: Message[];
  streamingContent: string;
  streamingThinking: string;
}>();

const container = ref<HTMLElement | null>(null);

watch(
  () => [props.messages.length, props.streamingContent, props.streamingThinking],
  async () => {
    await nextTick();
    if (container.value) {
      container.value.scrollTop = container.value.scrollHeight;
    }
  },
);

function isToolCall(msg: Message): boolean {
  return msg.eventType === 'tool_use' || msg.eventType === 'tool_result';
}

function isThinking(msg: Message): boolean {
  return msg.eventType === 'thinking';
}

function handleCopyClick(event: MouseEvent): void {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>('.code-block__copy');
  if (!button) return;

  const code = button.dataset.code;
  if (!code) return;

  navigator.clipboard
    .writeText(code)
    .then(() => {
      button.textContent = '已复制';
      button.classList.add('code-block__copy--copied');
      setTimeout(() => {
        button.textContent = '复制';
        button.classList.remove('code-block__copy--copied');
      }, 1500);
    })
    .catch(() => {
      button.textContent = '失败';
      setTimeout(() => {
        button.textContent = '复制';
      }, 1500);
    });
}
</script>

<template>
  <div ref="container" class="message-list" @click="handleCopyClick">
    <template v-for="msg in messages" :key="msg.id">
      <ThinkingBlock v-if="isThinking(msg)" :content="msg.content" />
      <ToolCallBlock v-else-if="isToolCall(msg)" :message="msg" />
      <MessageBubble v-else :message="msg" />
    </template>
    <ThinkingBlock v-if="streamingThinking" :content="streamingThinking" streaming />
    <StreamRenderer v-if="streamingContent" :content="streamingContent" />
  </div>
</template>

<style scoped>
.message-list {
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  padding: 20px 24px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 16px;
}
</style>
