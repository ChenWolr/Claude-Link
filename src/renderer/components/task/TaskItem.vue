<script setup lang="ts">
import { ref, computed, reactive, watch, onBeforeUnmount } from 'vue';
import { closeImageLightbox, openImageLightbox, useImageLightbox } from '../../composables/useImageLightbox';
import type { AttachmentSummary } from '../../../shared/types/attachment';
import type { Task } from '../../../shared/types/task';
import TaskStatusBadge from './TaskStatusBadge.vue';

// v3：列表只可能出现 pending 任务（执行过即沉入「已执行」历史），故本卡为 pending 专用：
// 无 running/failed/completed 分支、无中断/重试入口（失败重试走主会话「重新编辑发送」）。
const props = defineProps<{
  task: Task;
  /** ETA 文案（taskEtaText 纯函数产出；null 不渲染行） */
  eta?: string | null;
  /** 本会话回合执行中（禁拖拽 + 禁立即执行） */
  sending?: boolean;
  /** 队列熔断待命（禁立即执行） */
  queuePaused?: boolean;
  /** 队列开关关闭（禁立即执行） */
  queueEnabled?: boolean;
}>();
const emit = defineEmits<{
  delete: [taskId: string];
  pause: [taskId: string];
  resume: [taskId: string];
  runnow: [taskId: string];
}>();

const expanded = ref(false);

// ── 附件图片预览（复用 AttachmentDraftList 范式 + 全局 ImageLightbox 单例）──
// 预览经受控 IPC（attachment:preview，网页版桥接表同键）取 bytes → Blob URL；
// 灯箱/原图/缩略图 URL 生命周期见各函数注释。
const { state: lightboxState } = useImageLightbox();
// 缩略图 Blob URL（attachmentId -> url，响应式，模板 <img> 直接绑定）
const thumbUrls = reactive<Record<string, string>>({});
// 原图 Blob URL（非响应式，不参与模板渲染）
const fullUrls = new Map<string, string>();
const thumbLoading = reactive<Record<string, boolean>>({}); // 缩略图读取态（静默，失败退化 placeholder）
const loading = reactive<Record<string, boolean>>({});      // 原图灯箱读取态（在飞去重）
const errors = reactive<Record<string, string>>({});        // 原图预览失败（静默保留，允许重试）
// 组件存活标志：IPC 在飞期间卡可能随任务删除卸载，卸载后回跳的 promise 不得建 URL/开灯箱。
let alive = true;

// IPC 跨 realm 传来的 bytes 类型为 Uint8Array<ArrayBufferLike>，不能直接当 BlobPart（可能 SharedArrayBuffer）；
// 复制成当前 realm 的 ArrayBuffer 再交给 Blob（对齐 AttachmentDraftList）。
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function revokeAll(): void {
  for (const url of fullUrls.values()) URL.revokeObjectURL(url);
  for (const id of Object.keys(thumbUrls)) {
    URL.revokeObjectURL(thumbUrls[id]);
    delete thumbUrls[id];
  }
  fullUrls.clear();
}

// revoke 单个原图 URL，但跳过灯箱正在显示的那张（否则灯箱变 broken image）；
// 被跳过的那张由组件卸载（revokeAll 无条件收）兜底回收。
function safeRevokeFull(id: string, url: string): void {
  if (lightboxState.value?.src === url) return;
  URL.revokeObjectURL(url);
  fullUrls.delete(id);
}

// 缩略图：展开 / 附件出现时取 thumbnail=true 渲染 <img>。失败静默（退化 placeholder 文件名）。
async function loadThumb(att: AttachmentSummary): Promise<void> {
  if (thumbUrls[att.id] || thumbLoading[att.id]) return;
  thumbLoading[att.id] = true;
  try {
    // sessionId 取任务自带字段（非 activeSession.id）：任务必属其所在会话，抗切会话竞态。
    const res = await window.claudeLink.getAttachmentPreview({ sessionId: props.task.sessionId, attachmentId: att.id, thumbnail: true });
    // await 期间任务可能被删除/整替（附件消失）：丢弃过期结果，防孤儿 URL 泄漏至卸载。
    if (!alive || !props.task.attachments.some((a) => a.id === att.id)) return;
    thumbUrls[att.id] = URL.createObjectURL(new Blob([toBlobPart(res.bytes)], { type: res.mimeType }));
  } catch {
    // 静默：退化 placeholder 文件名，无弹窗、无 console.error
  } finally {
    delete thumbLoading[att.id];
  }
}

// 缩略图点击：经 IPC 取原图 → Blob URL → 复用全局灯箱单例（Esc/遮罩/焦点陷阱与聊天附件一致）。
async function previewImage(att: AttachmentSummary, trigger: HTMLElement): Promise<void> {
  if (loading[att.id]) return; // 防双击：避免 IPC 在飞时重复请求 + 首个 Blob URL 泄漏
  let url = fullUrls.get(att.id);
  if (!url) {
    loading[att.id] = true;
    delete errors[att.id]; // 清旧错误，允许失败后再次点击重试
    try {
      const res = await window.claudeLink.getAttachmentPreview({ sessionId: props.task.sessionId, attachmentId: att.id, thumbnail: false });
      // await 期间任务删除/整替：丢弃过期结果，不开幽灵灯箱、不建孤儿 URL。
      if (!alive || !props.task.attachments.some((a) => a.id === att.id)) return;
      url = URL.createObjectURL(new Blob([toBlobPart(res.bytes)], { type: res.mimeType }));
      fullUrls.set(att.id, url);
    } catch {
      errors[att.id] = '预览不可用';
      return;
    } finally {
      loading[att.id] = false;
    }
  }
  openImageLightbox(url, att.filename, trigger);
}

// 展开才加载缩略图（折叠卡零 IPC 零 Blob）；幂等守卫在 loadThumb 内（已加载/在飞直接 return）。
watch(expanded, (v) => {
  if (!v) return;
  for (const att of props.task.attachments) {
    if (att.kind === 'image' && att.previewAvailable) void loadThumb(att);
  }
});

// 任务整替/附件变化（P1 tasks_changed 换新对象时 :key=task.id 不重建卡，attachments 引用换新
// 触发本 watch）：撤销已消失附件的 URL（原图 safeRevokeFull 跳过灯箱占用、缩略图直接 revoke）；
// 详情已展开时为新出现的图片附件补载。watch 源是 id:kind 串，同集整替不触发（零多余 IPC）。
watch(
  () => props.task.attachments.map((a) => `${a.id}:${a.kind}`).join('\n'),
  () => {
    const ids = new Set(props.task.attachments.map((a) => a.id));
    for (const [id, url] of [...fullUrls]) {
      if (!ids.has(id)) safeRevokeFull(id, url);
    }
    for (const id of Object.keys(thumbUrls)) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(thumbUrls[id]);
        delete thumbUrls[id];
      }
    }
    if (expanded.value) {
      for (const att of props.task.attachments) {
        if (att.kind === 'image' && att.previewAvailable) void loadThumb(att);
      }
    }
  },
);

onBeforeUnmount(() => {
  alive = false;
  // 本卡打开的灯箱（src 属于本卡 URL）才随卸载关闭，避免 A 卡卸载关掉 B 卡刚打开的灯箱；
  // 判据须在 revokeAll 之前取（revokeAll 会清空两个 URL 池）。
  const shown = lightboxState.value?.src ?? '';
  const ownedByThisCard = [...fullUrls.values(), ...Object.values(thumbUrls)].includes(shown);
  revokeAll();
  if (ownedByThisCard) closeImageLightbox();
});

// 「立即执行」置灰原因（优先级从高到低）；queuePaused 的禁用是渲染层策略，主进程 runTaskNow
// 无对应守卫（仅 pending/开关/忙碌三道闸），两者并非一一对应。
// computed：暂停/恢复等 props 变化时 title 必须随之更新。
const runNowTitle = computed(() => {
  if (props.queueEnabled === false) return '队列开关已关闭';
  if (props.queuePaused) return '队列已暂停，恢复队列后可执行';
  if (props.sending) return '当前会话有任务执行中，结束后可立即执行';
  return '跳过倒计时，立即把该任务移出队列并作为普通消息发送';
});
</script>

<template>
  <div class="task-item">
    <div class="task-item__header" title="点击查看 / 收起详情" @click="expanded = !expanded">
      <span class="task-item__drag" @click.stop>⠿</span>
      <TaskStatusBadge :status="task.status" />
      <span v-if="task.paused" class="task-item__paused-chip">⏸ 已暂停</span>
      <span class="task-item__prompt">{{ task.prompt.slice(0, 80) }}{{ task.prompt.length > 80 ? '...' : '' }}</span>
      <span v-if="task.attachments.length" class="task-item__atts-chip" :title="task.attachments.map((a) => a.filename).join('\n')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
        {{ task.attachments.length }}
      </span>
    </div>
    <div v-if="eta" class="task-item__eta">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3.5 2" />
      </svg>
      <span>{{ eta }}</span>
    </div>
    <div class="task-item__actions">
      <button
        v-if="task.status === 'pending'"
        type="button"
        class="action action--accent"
        :disabled="sending || queuePaused || !queueEnabled"
        :title="runNowTitle"
        @click="emit('runnow', task.id)"
      >立即执行</button>
      <button v-if="task.status === 'pending' && !task.paused" type="button" class="action action--solid" @click="emit('pause', task.id)">暂停</button>
      <button v-if="task.status === 'pending' && task.paused" type="button" class="action action--accent" @click="emit('resume', task.id)">恢复</button>
      <button v-if="task.status === 'pending'" type="button" class="action action--solid" @click="emit('delete', task.id)">删除</button>
      <button type="button" class="action" @click="expanded = !expanded">{{ expanded ? '收起' : '详情' }}</button>
    </div>
    <div v-if="expanded" class="task-item__detail">
      <div class="task-item__full-prompt">{{ task.prompt }}</div>
      <template v-if="task.attachments.length > 0">
        <div class="task-item__att-files">
          <template v-for="a in task.attachments" :key="a.id">
            <!-- 图片且预览可用：缩略图按钮（点击开全局灯箱看原图） -->
            <button
              v-if="a.kind === 'image' && a.previewAvailable"
              type="button"
              class="task-item__att-thumb"
              :title="`预览 ${a.filename}`"
              @click="previewImage(a, $event.currentTarget as HTMLElement)"
            >
              <img v-if="thumbUrls[a.id]" :src="thumbUrls[a.id]" :alt="a.filename" />
              <span v-else class="task-item__att-thumb-placeholder">{{ a.filename }}</span>
            </button>
            <!-- 非图片 / 预览不可用 / 加载失败：维持文件名文本行 -->
            <span v-else class="task-item__att-file" :title="a.filename">{{ a.filename }}</span>
          </template>
        </div>
        <div class="task-item__atts-note">附件 {{ task.attachments.length }} 个（执行时随消息一并发送）</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.task-item {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 10px 12px;
  box-shadow: var(--ring-light), var(--elevation-1);
  transition: border-color var(--duration-fast) var(--ease-out), background var(--duration-fast) var(--ease-out), box-shadow var(--duration-fast) var(--ease-out);
}

.task-item__header {
  display: flex;
  align-items: center;
  gap: 8px;
}

.task-item__drag {
  cursor: grab;
  color: var(--color-text-muted);
  font-size: 0.875rem;
  user-select: none;
}

.task-item__prompt {
  min-width: 0;
  flex: 1;
  font-size: 0.8125rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.task-item__paused-chip {
  flex-shrink: 0;
  border: 1px solid var(--color-warn);
  border-radius: var(--radius-pill);
  color: var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  padding: 1px 8px;
  font-size: 0.625rem;
}

/* 头行附件 chip：回形针 + 数量，title 列全部文件名 */
.task-item__atts-chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  color: var(--color-text-muted);
  padding: 1px 7px;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
}

.task-item__atts-chip svg {
  width: 11px;
  height: 11px;
}

/* ETA 行：时钟图标 + 文字，统一 muted */
.task-item__eta {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-variant-numeric: tabular-nums;
}

.task-item__eta svg {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
}

.task-item__actions {
  display: flex;
  gap: 4px;
  margin-top: 6px;
}

.action {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  padding: 3px 8px;
  font-size: 0.6875rem;
}

.action:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.action--solid {
  color: var(--color-text);
}

.action--solid:hover:not(:disabled) {
  border-color: var(--color-accent-strong);
  color: var(--color-accent-strong);
}

.action--accent {
  border-color: var(--color-accent);
  color: var(--color-accent-strong);
}

.task-item__detail {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.task-item__full-prompt {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.8125rem;
  line-height: 1.5;
  max-height: 200px;
  overflow-y: auto;
}

.task-item__att-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}

/* 详情区缩略图：2.5rem 方块（对齐 .att-card__thumb-img），token 全走主题变量 */
.task-item__att-thumb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-panel-soft);
  padding: 0;
  cursor: pointer;
  overflow: hidden;
}

.task-item__att-thumb:hover {
  border-color: var(--color-accent);
}

.task-item__att-thumb img {
  display: block;
  width: 2.5rem;
  height: 2.5rem;
  object-fit: cover;
}

.task-item__att-thumb-placeholder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 2.5rem;
  height: 2.5rem;
  padding: 0 3px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.5625rem;
  color: var(--color-text-muted);
}

.task-item__att-file {
  display: inline-block;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 1px 6px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
}

.task-item__atts-note {
  margin-top: 5px;
  font-size: 0.6875rem;
  color: var(--color-text-muted);
}
</style>
