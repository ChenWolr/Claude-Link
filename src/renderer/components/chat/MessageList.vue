<script setup lang="ts">
import { ref, watch, nextTick } from 'vue';
import type { Message } from '../../../shared/types/session';
import MessageBubble from './MessageBubble.vue';
import StreamRenderer from './StreamRenderer.vue';
import ToolCallBlock from './ToolCallBlock.vue';

const props = defineProps<{
  messages: Message[];
  streamingContent: string;
}>();

const container = ref<HTMLElement | null>(null);

watch(
  () => [props.messages.length, props.streamingContent],
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
</script>

<template>
  <div ref="container" class="message-list">
    <template v-for="msg in messages" :key="msg.id">
      <ToolCallBlock v-if="isToolCall(msg)" :message="msg" />
      <MessageBubble v-else :message="msg" />
    </template>
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
  gap: 16px;
}
</style>
