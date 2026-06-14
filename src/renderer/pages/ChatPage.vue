<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue';
import { useSessionStore } from '../stores/session-store';
import { useChat } from '../composables/use-chat';
import { useStream } from '../composables/use-stream';
import { useTaskStore } from '../stores/task-store';
import MessageList from '../components/chat/MessageList.vue';
import ChatInput from '../components/chat/ChatInput.vue';
import CommandToolbar from '../components/chat/CommandToolbar.vue';

const store = useSessionStore();
const taskStore = useTaskStore();
const { sending, sendMessage, abort, startListening, stopListening } = useChat();
const { displayContent } = useStream();

const modelOverrideDraft = ref('');

const effectiveModel = computed(() => {
  const session = store.activeSession;
  if (!session) return '';
  return session.modelOverride || session.model;
});

watch(
  () => store.activeSession?.id,
  () => {
    modelOverrideDraft.value = store.activeSession?.modelOverride ?? '';
  },
  { immediate: true },
);

async function saveModelOverride() {
  await store.updateActiveSessionModelOverride(modelOverrideDraft.value);
}

async function clearModelOverride() {
  modelOverrideDraft.value = '';
  await store.updateActiveSessionModelOverride(null);
}

onMounted(() => {
  store.loadSessions();
});

onUnmounted(() => {
  stopListening();
});

async function handleSend(text: string) {
  if (!store.activeSession) return;
  const status = taskStore.queueState.status;

  // 倒计时期间补充输入 → 续写当前任务上下文，重置倒计时
  if (status === 'waiting') {
    await taskStore.queueUserMessage(store.activeSession.id, text);
    return;
  }

  // 任务执行中（running / continuing）→ 排队为下一条指令，不打断当前任务
  if (status === 'running' || status === 'continuing') {
    await taskStore.addTask(store.activeSession.id, text);
    return;
  }

  await sendMessage(text);
}

async function handleSendCommand(command: string) {
  await sendMessage(command);
}

async function handleCompress() {
  if (!store.activeSession) return;
  await sendMessage('/compact');
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
      <div class="session-model-bar">
        <span>当前模型：{{ effectiveModel }}</span>
        <input
          v-model="modelOverrideDraft"
          type="text"
          placeholder="会话模型 override，例如 claude-opus-4-8（留空用默认）"
          @keydown.enter.prevent="saveModelOverride"
        />
        <button type="button" @click="saveModelOverride">应用</button>
        <button type="button" @click="clearModelOverride">清空</button>
      </div>
      <MessageList :messages="store.messages" :streaming-content="displayContent" />
      <CommandToolbar @send-command="handleSendCommand" @compress="handleCompress" />
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

.session-model-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 800px;
  margin: 0 auto;
  border-bottom: 1px solid var(--color-border);
  padding: 8px 24px;
  color: var(--color-text-muted);
  font-size: 12px;
}

.session-model-bar span {
  white-space: nowrap;
}

.session-model-bar input {
  min-width: 220px;
  flex: 1;
  max-width: 420px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 6px 8px;
  font-size: 12px;
}

.session-model-bar button {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  color: var(--color-text);
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
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
