<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';
import { useChat } from '../composables/use-chat';
import { useStream } from '../composables/use-stream';
import { useTaskStore } from '../stores/task-store';
import { useChatDraftStore } from '../stores/chat-draft-store';
import MessageList from '../components/chat/MessageList.vue';
import ChatInput from '../components/chat/ChatInput.vue';
import SessionToolbar from '../components/chat/SessionToolbar.vue';
import AttachmentDraftList from '../components/chat/AttachmentDraftList.vue';
import ExportImageOverlay from '../components/chat/ExportImageOverlay.vue';
import type { ChatSendPayload, AttachmentSummary } from '../../shared/types/attachment';

const store = useSessionStore();
const taskStore = useTaskStore();
const draftStore = useChatDraftStore();
const { sending, error, lastFailedBySession, sendMessage, abort } = useChat();
// 当前会话最近一次【失败】的 user 消息（按会话隔离）：error 置位时抓取，重新编辑据此恢复到主草稿。
const lastFailedCurrent = computed(() => {
  const sid = store.activeSession?.id;
  return sid ? lastFailedBySession.value[sid] ?? null : null;
});
const { displayContent, displayThinking, displayTool } = useStream();

// 内联提示（如"未选择工作空间"/附件暂存失败），自动消失。
const notice = ref<string | null>(null);
let noticeTimer: ReturnType<typeof setTimeout> | null = null;
function showNotice(msg: string) {
  notice.value = msg;
  if (noticeTimer) clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    notice.value = null;
  }, 4000);
}

// 草稿（按会话隔离）：直接绑 store 的响应式 computed，store 任何变化（添加/删除/清空）自动反映，
// 不再用手动 ref 副本 + syncDraft（旧做法在 AttachmentDraftList 直接删 store 后副本不更新，致 × 无效）。
const activeSessionId = computed(() => store.activeSession?.id ?? '');
const draftText = computed<string>({
  get: () => (activeSessionId.value ? draftStore.getText(activeSessionId.value) : ''),
  set: (v) => {
    if (activeSessionId.value) draftStore.setText(activeSessionId.value, v);
  },
});
const draftAttachments = computed<AttachmentSummary[]>(() =>
  activeSessionId.value ? draftStore.getAttachments(activeSessionId.value) : [],
);

// 拖放高亮：文件拖入聊天区时，给 .chat-composer 加一条临时 accent 描边（非常驻边框）。
const dragActive = ref(false);

// ChatInput 实例引用：粘贴混合剪贴板时，把文字插入 textarea 选区（图片进附件、文字不吞）。
const chatInputRef = ref<InstanceType<typeof ChatInput> | null>(null);

onMounted(() => {
  store.loadSessions();
  // 根因修复：监听已在 App.vue 全局注册，这里只刷新当前会话数据（重拉 messages）。
  store.refreshActiveSession();
});

// 切换会话时清掉上一会话残留的错误横幅与提示、复位拖放态与计数（草稿视图由 computed 自动切换）。
watch(
  () => store.activeSession?.id,
  () => {
    error.value = null;
    notice.value = null;
    dragActive.value = false;
    dragCounter = 0;
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

// 文件选择器：主进程选文件 → 暂存到 userData → 加入草稿（computed 自动刷新视图）。
// 选文件只需暂存，不要求工作空间（与拖放/粘贴一致）；工作空间在发送时才校验。
async function onPickAttachments() {
  if (!store.activeSession) return;
  const sessionId = store.activeSession.id;
  try {
    const { attachments, errors } = await window.claudeLink.pickAttachments(sessionId);
    if (attachments.length > 0) {
      draftStore.addAttachments(sessionId, attachments);
    }
    // 部分失败：成功项已入草稿，失败项集中提示（错误文案来自主进程业务校验，不含内部路径）。
    if (errors.length > 0) {
      showNotice(`部分文件未能添加：${errors.map((err) => `${err.filename}：${err.message}`).join('；')}`);
    }
  } catch (e) {
    showNotice(e instanceof Error ? e.message : '添加文件失败');
  }
}

// 粘贴/拖放：把 File 字节经 stageAttachmentBytes 暂存（不把 bytes 放进长期 state）。
async function stageFiles(files: File[]) {
  if (!store.activeSession || files.length === 0) return;
  const sessionId = store.activeSession.id;
  const failures: string[] = [];
  const staged: AttachmentSummary[] = [];
  for (const file of files) {
    try {
      const buf = await file.arrayBuffer();
      const summary = await window.claudeLink.stageAttachmentBytes({
        sessionId,
        // 截图粘贴等场景 file.name 可能为空：按 MIME 推一个兜底名（主进程仍会安全化）。
        filename: file.name?.trim() || (file.type ? `paste.${file.type.split('/')[1] ?? 'bin'}` : 'attachment'),
        mimeType: file.type,
        bytes: new Uint8Array(buf),
      });
      staged.push(summary);
    } catch (e) {
      failures.push(`${file.name || '附件'}：${e instanceof Error ? e.message : '暂存失败'}`);
    }
  }
  if (staged.length > 0) {
    draftStore.addAttachments(sessionId, staged);
  }
  if (failures.length > 0) {
    showNotice(`部分文件未能添加：${failures.join('；')}`);
  }
}

// 文件拖放：绑在 .chat-page 容器（落点覆盖消息列表/附件区/输入卡片），不依赖 textarea 焦点。
// 全局 dragover/drop 兜底已在 App.vue 注册（无条件 preventDefault，防 Electron 把窗口导航到 file:///），
// 这里只做业务消费：仅对 Files 类型 preventDefault 并高亮。
function hasFileDrag(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files');
}
let dragCounter = 0;
function onPageDragEnter(e: DragEvent): void {
  if (!hasFileDrag(e) || !store.activeSession) return;
  e.preventDefault();
  dragCounter += 1;
  dragActive.value = true;
}
function onPageDragOver(e: DragEvent): void {
  if (!hasFileDrag(e) || !store.activeSession) return;
  e.preventDefault();
}
function onPageDragLeave(_e: DragEvent): void {
  // 不用 hasFileDrag 守卫：Chromium 离开窗口的那次 dragleave 可能不带 Files types，
  // 守卫会致计数永不归零、高亮卡死。只有 Files 的 enter 才加计数，这里无条件减。
  dragCounter -= 1;
  if (dragCounter <= 0) {
    dragCounter = 0;
    dragActive.value = false;
  }
}
function onPageDrop(e: DragEvent): void {
  if (!hasFileDrag(e)) return;
  e.preventDefault();
  dragCounter = 0;
  dragActive.value = false;
  if (!store.activeSession) {
    showNotice('请先选择或创建一个会话，再添加文件。');
    return;
  }
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) void stageFiles(files);
}

// 粘贴：容器级（不依赖 textarea 焦点）；截取所有 file 项交主进程校验（图片/文件均可）。
// 无 file 项时不 preventDefault，剪贴板文本继续透传到 textarea。
function onPagePaste(e: ClipboardEvent): void {
  if (!store.activeSession) return;
  const items = e.clipboardData?.items;
  if (!items) return;
  const files: File[] = [];
  for (const item of items) {
    if (item.kind === 'file') {
      const file = item.getAsFile();
      if (file) files.push(file);
    }
  }
  if (files.length > 0) {
    e.preventDefault();
    void stageFiles(files);
    // 同一次剪贴板里的文字也要保留：图片进附件，文字仍插入 textarea，避免被图片处理器吞掉。
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text) chatInputRef.value?.insertTextAtSelection(text);
  }
}

// 统一构造发送载荷；按队列状态路由三条路径。仅主进程成功接受才清草稿，失败保留以供重试。
function buildPayload(): ChatSendPayload | null {
  if (!activeSessionId.value) return null;
  const text = draftText.value.trim();
  const attachmentIds = draftAttachments.value.map((a) => a.id);
  if (!text && attachmentIds.length === 0) return null;
  return { text, attachmentIds, clientMessageId: crypto.randomUUID() };
}

// 发送重入锁：textarea 的 disabled prop 下一 tick 才生效，同 tick 内的二次 Enter 会重入；
// buildPayload 每次新 clientMessageId、主进程不去重 → 双发。inflight 在 await 期间挡重入。
let sendInflight = false;
async function handleSend() {
  if (!store.activeSession) return;
  if (sendInflight) return;
  if (!ensureWorkspace()) return;
  const payload = buildPayload();
  if (!payload) return;

  sendInflight = true;
  const sessionId = store.activeSession.id;
  // 路由须限定「队列状态属于当前会话」：queueState 是全局单例，后台另一会话在跑时
  // status 可能是 running，但与当前会话无关 → 不能把当前会话消息塞进任务队列。
  const isQueueSession = taskStore.queueState.sessionId === sessionId;
  const status = taskStore.queueState.status;
  let ok = false;

  try {
    // 倒计时期间补充输入 → 续写当前任务上下文，重置倒计时
    if (isQueueSession && status === 'waiting') {
      ok = await taskStore.queueUserMessage(sessionId, payload);
    } else if (isQueueSession && (status === 'running' || status === 'continuing')) {
      // 任务执行中 → 排队为下一条指令，不打断当前任务
      ok = await taskStore.addTask(sessionId, payload);
    } else {
      ok = await sendMessage(payload);
    }
  } finally {
    sendInflight = false;
  }

  if (ok) {
    draftStore.clearAfterAccepted(sessionId);
  } else {
    // 失败：保留文字与附件草稿；错误横幅由 error / taskStore.error 承载，这里补一条 notice 兜底。
    const msg = taskStore.error || error.value;
    if (msg) showNotice(msg);
  }
}

// 异步发送失败（provider 拒图等）后「重新编辑发送」：从历史消息克隆附件为新草稿 + 回填文字，
// 清错误交给用户改模型/编辑后手动发送（新 clientMessageId）。不自动重发、不切模型。
async function retryLastFailed() {
  const last = lastFailedCurrent.value;
  const sessionId = store.activeSession?.id;
  if (!last || !sessionId) return;
  // 文字回填独立于附件恢复：即使附件恢复失败或无附件，也先把文字放回草稿。
  if (last.content) draftStore.setText(sessionId, last.content);
  let recovered = 0;
  try {
    const cloned = await window.claudeLink.cloneMessageAttachments(sessionId, last.id);
    recovered = cloned.length;
    if (recovered > 0) draftStore.addAttachments(sessionId, cloned);
  } catch (e) {
    showNotice(`附件恢复失败：${e instanceof Error ? e.message : String(e)}`);
  }
  error.value = null;
  delete lastFailedBySession.value[sessionId];
  if (recovered === 0 && !last.content) {
    showNotice('该消息没有可恢复的文字或附件');
  }
}

async function handleCompress() {
  if (!store.activeSession) return;
  if (!ensureWorkspace()) return;
  // /compact 不携带附件，独立 payload；成功后不清草稿（压缩命令语义）。
  await sendMessage({ text: '/compact', attachmentIds: [], clientMessageId: crypto.randomUUID() });
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
  <section
    class="chat-page"
    @dragenter="onPageDragEnter"
    @dragover="onPageDragOver"
    @dragleave="onPageDragLeave"
    @drop="onPageDrop"
    @paste="onPagePaste"
  >
    <template v-if="store.activeSession">
      <MessageList :messages="store.messages" :streaming-content="displayContent" :streaming-thinking="displayThinking" :streaming-tool="displayTool" :sending="sending" />
      <ExportImageOverlay />

      <div v-if="notice" class="notice">
        <span>⚠️ {{ notice }}</span>
      </div>
      <div v-if="error" class="chat-error">
        <span>❌ {{ error }}<button v-if="lastFailedCurrent" type="button" class="chat-error__retry" @click="retryLastFailed">重新编辑发送</button></span>
      </div>

      <!-- 附件草稿：位于 .chat-composer 上方，自身无横向外层边框 -->
      <AttachmentDraftList :attachments="draftAttachments" />

      <div class="chat-composer" :class="{ 'chat-composer--drag': dragActive }">
        <ChatInput
          ref="chatInputRef"
          :model-value="draftText"
          :has-attachments="draftAttachments.length > 0"
          :disabled="sending"
          @update:model-value="(v: string) => (draftText = v)"
          @send="handleSend"
        />
        <SessionToolbar :sending="sending" @abort="abort" @compress="handleCompress" @add-attachment="onPickAttachments" />
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

/* 拖放高亮：仅文件拖入期间加一条 accent 描边，不新增常驻边框。 */
.chat-composer--drag {
  border-color: var(--color-accent);
  box-shadow: var(--elevation-3), var(--ring-light), 0 0 0 2px color-mix(in srgb, var(--color-accent) 35%, transparent);
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

.chat-error__retry {
  margin-left: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--color-accent) 50%, transparent);
  background: color-mix(in srgb, var(--color-accent) 14%, transparent);
  color: var(--color-accent-strong);
  border-radius: var(--radius-sm);
  padding: 2px 10px;
  font-size: 0.75rem;
  cursor: pointer;
}

.chat-error__retry:hover {
  background: color-mix(in srgb, var(--color-accent) 24%, transparent);
}

.notice span {
  border: 1px solid color-mix(in srgb, var(--color-warn) 50%, transparent);
  background: color-mix(in srgb, var(--color-warn) 12%, transparent);
  color: var(--color-warn-strong);
}

.chat-error span {
  border: 1px solid color-mix(in srgb, var(--color-fail) 50%, transparent);
  background: color-mix(in srgb, var(--color-fail) 12%, transparent);
  color: var(--color-fail-strong);
}
</style>
