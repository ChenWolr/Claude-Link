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
const { sending, error, sendMessage, abort } = useChat();
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
  // 根因修复：监听已在 App.vue 全局注册，这里只刷新当前会话数据（重拉 messages）。
  // bindContextUpdates 也在 App.vue 注册，不在这里调。
  store.refreshActiveSession();
});

// 切换会话时清掉上一会话残留的错误横幅与提示。
watch(
  () => store.activeSession?.id,
  () => {
    error.value = null;
    notice.value = null;
  },
);

onUnmounted(() => {
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
    // 根因修复：监听已在 App.vue 全局注册，无需在新建会话时重新注册。
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

      <div class="chat-composer">
        <ChatInput :disabled="sending" @send="handleSend" />
        <SessionToolbar :sending="sending" @abort="abort" @compress="handleCompress" />
      </div>
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
  /* 全宽：让垂直滚动条贴右侧边栏（任务面板）。内容限宽下放到 MessageList scroller
     的动态 padding 与 .chat-composer 的 max-width，避免此处限宽把滚动条挤到列中央。 */
}

/* 底部浮岛：圆角卡片包住输入+工具栏，替代原贯穿色带（参考 openhanako .input-wrapper）。
   自身 max-width 限宽居中、对齐上方消息内容列；上下留白让卡片浮起。 */
.chat-composer {
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  width: 100%;
  max-width: var(--chat-bottom-max-width);
  margin: 0.5rem auto var(--chat-bottom-pad-x);
  background: var(--color-panel);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  /* 浮岛：最强投影 + 顶部高光，真正"浮"在消息流之上（Layered Console 浮层范式）。 */
  box-shadow: var(--elevation-3), var(--ring-light);
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
  font-size: 0.75rem;
  font-weight: 700;
}

.empty-state h1 {
  margin: 0;
  font-size: 1.5rem;
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
  color: var(--color-on-accent);
  box-shadow: var(--ring-light-accent);
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
  font-size: 0.8125rem;
  box-shadow: var(--ring-light);
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
