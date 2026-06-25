<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';
import { useChat } from '../composables/use-chat';
import { useStream } from '../composables/use-stream';
import { useTaskStore } from '../stores/task-store';
import MessageList from '../components/chat/MessageList.vue';
import ChatInput from '../components/chat/ChatInput.vue';
import SessionToolbar from '../components/chat/SessionToolbar.vue';

const store = useSessionStore();
const taskStore = useTaskStore();
const { sending, error, sendMessage, abort, startListening, stopListening } = useChat();
const { displayContent, displayThinking, displayTool } = useStream();

// 内联提示（如"未选择工作空间"），自动消失。
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(msg: string) {
  notice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, 4000);
}

onMounted(() => {
  store.loadSessions();
  store.bindContextUpdates();
});

// 切换会话时清掉上一会话残留的错误横幅与提示。error 是 useChat 单例 ref，
// switchSession 清不到它（只清 store.error），否则一次报错后切任何会话横幅都挂着。
watch(
  () => store.activeSession?.id,
  () => {
    error.value = null;
    notice.value = null;
  },
);

onUnmounted(() => {
  stopListening();
  if (noticeTimer) clearTimeout(noticeTimer);
});

// 工作空间必选：Claude Code 基于某目录运行，未选工作空间禁止发送。
function ensureWorkspace(): boolean {
  if (store.activeSession?.workingDir) return true;
  showNotice('请先在底部选择「工作空间」目录，才能运行 Claude Code。');
  return false;
}

async function handleSend(text: string) {
  if (!store.activeSession) return;
  if (!ensureWorkspace()) return;

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

async function handleCompress() {
  if (!store.activeSession) return;
  if (!ensureWorkspace()) return;
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
      <MessageList :messages="store.messages" :streaming-content="displayContent" :streaming-thinking="displayThinking" :streaming-tool="displayTool" :sending="sending" />

      <div v-if="notice" class="notice">
        <span>⚠️ {{ notice }}</span>
      </div>
      <div v-if="error" class="chat-error">
        <span>❌ {{ error }}</span>
      </div>

      <ChatInput :disabled="sending" @send="handleSend" />
      <SessionToolbar :sending="sending" @abort="abort" @compress="handleCompress" />
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
  position: relative;
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
  cursor: pointer;
}

.notice,
.chat-error {
  max-width: 800px;
  margin: 0 auto;
  width: 100%;
  padding: 8px 24px;
  box-sizing: border-box;
}

.notice span,
.chat-error span {
  display: block;
  border-radius: var(--radius-md);
  padding: 8px 14px;
  font-size: 13px;
}

.notice span {
  border: 1px solid rgba(204, 163, 61, 0.5);
  background: rgba(204, 163, 61, 0.12);
  color: #e0c36a;
}

.chat-error span {
  border: 1px solid rgba(239, 100, 97, 0.5);
  background: rgba(239, 100, 97, 0.12);
  color: #f08887;
}
</style>
