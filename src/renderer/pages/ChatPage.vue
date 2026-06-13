<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../stores/session-store';
import { useChat } from '../composables/use-chat';
import { useStream } from '../composables/use-stream';
import MessageList from '../components/chat/MessageList.vue';
import ChatInput from '../components/chat/ChatInput.vue';

const store = useSessionStore();
const { sending, sendMessage, abort, startListening, stopListening } = useChat();
const { displayContent } = useStream();

onMounted(() => {
  store.loadSessions();
});

onUnmounted(() => {
  stopListening();
});

async function handleSend(text: string) {
  await sendMessage(text);
}

async function handleNewSession() {
  const session = await store.createSession(`会话 ${store.sessions.length + 1}`);
  if (session) {
    await store.switchSession(session);
    startListening();
  }
}
</script>

<template>
  <section class="chat-page">
    <template v-if="store.activeSession">
      <MessageList :messages="store.messages" :streaming-content="displayContent" />
      <ChatInput :disabled="sending" @send="handleSend" />
      <button v-if="sending" class="abort-button" type="button" @click="abort">中断</button>
    </template>
    <template v-else>
      <div class="empty-state">
        <p class="empty-state__eyebrow">Chat</p>
        <h1>选择或创建一个会话</h1>
        <p>聊天区将在这里显示消息流和 Claude Code 执行详情。</p>
        <button type="button" class="new-session-button" @click="handleNewSession">+ 新会话</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.chat-page {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.empty-state {
  display: grid;
  min-height: 100%;
  align-content: center;
  justify-items: center;
  padding: 32px;
  text-align: center;
}

.empty-state__eyebrow {
  margin: 0 0 8px;
  color: var(--color-accent-strong);
  font-size: 12px;
  font-weight: 700;
}

.empty-state h1 {
  margin: 0;
  font-size: 24px;
}

.empty-state p {
  max-width: 520px;
  margin: 12px 0 0;
  color: var(--color-text-muted);
}

.new-session-button {
  margin-top: 20px;
  border: 0;
  border-radius: var(--radius-md);
  background: var(--color-accent);
  color: #07120d;
  padding: 10px 24px;
  font-weight: 700;
}

.abort-button {
  position: fixed;
  bottom: 90px;
  right: 340px;
  border: 1px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: rgba(239, 100, 97, 0.12);
  color: var(--color-danger);
  padding: 8px 16px;
  font-size: 13px;
}
</style>
