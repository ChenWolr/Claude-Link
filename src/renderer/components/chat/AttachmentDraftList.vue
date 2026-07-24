<script setup lang="ts">
// 输入框上方的附件草稿列表：图片缩略图按钮 + 文件卡片 + 移除。
// 放在 .chat-composer 之前；自身不设横向满宽背景/边框/阴影，每个附件卡片只有自身边框。
// 不持有文件系统路径/bytes；预览经 preload 受控 IPC 取有界缩略图，生成 Blob URL 进现有灯箱。
import { onBeforeUnmount, reactive, watch } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { useChatDraftStore } from '../../stores/chat-draft-store';
import { closeImageLightbox, openImageLightbox, useImageLightbox } from '../../composables/useImageLightbox';
import { attachmentBadge } from '../../utils/attachment';
import type { AttachmentSummary } from '../../../shared/types/attachment';

const props = defineProps<{
  attachments: AttachmentSummary[];
}>();

const sessionStore = useSessionStore();
const draftStore = useChatDraftStore();
const { state: lightboxState } = useImageLightbox();

// attachmentId -> Blob URL（图片原图预览用）。卸载/列表变化/切换会话时 revoke。
const objectUrls = new Map<string, string>();
const loading = reactive<Record<string, boolean>>({});
const errors = reactive<Record<string, string>>({});
// 组件存活标志：previewImage 的 IPC 在飞期间组件可能卸载（如发送清空草稿致 v-if=false），
// 卸载后回到的 promise 不应再开灯箱/建 URL（否则跨组件幽灵灯箱 + URL 泄漏）。
let alive = true;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function revokeAll(): void {
  for (const url of objectUrls.values()) URL.revokeObjectURL(url);
  objectUrls.clear();
}

// revoke 单个 URL，但跳过灯箱正在显示的那张（否则灯箱变 broken image）。
// 被跳过的 URL 由切会话（session-watch 先关灯箱再 revokeAll）/ 组件卸载兜底回收。
function safeRevoke(id: string, url: string): void {
  if (lightboxState.value?.src === url) return;
  URL.revokeObjectURL(url);
  objectUrls.delete(id);
}

// 图片缩略图点击：经 IPC 取原图 → Blob URL → 复用现有灯箱（含焦点陷阱/Esc/遮罩关闭/缩放）。
// 取原图而非 512 缩略图：灯箱支持放大查看，缩略图放大后会模糊。
async function previewImage(att: AttachmentSummary, trigger: HTMLElement): Promise<void> {
  const sid = sessionStore.activeSession?.id;
  if (!sid) return;
  if (loading[att.id]) return; // 防双击：避免 IPC 在飞时重复请求 + 首个 Blob URL 泄漏
  let url = objectUrls.get(att.id);
  if (!url) {
    loading[att.id] = true;
    delete errors[att.id]; // 清旧错误，允许失败后再次点击重试
    try {
      const res = await window.claudeLink.getAttachmentPreview({ sessionId: sid, attachmentId: att.id, thumbnail: false });
      // await 期间可能已切会话或组件已卸载（发送清空草稿致 v-if=false）：丢弃过期结果，
      // 避免跨会话幽灵灯箱与卸载后 URL 泄漏。
      if (!alive || sessionStore.activeSession?.id !== sid) return;
      url = URL.createObjectURL(new Blob([res.bytes], { type: res.mimeType }));
      objectUrls.set(att.id, url);
    } catch {
      errors[att.id] = '预览不可用';
      return;
    } finally {
      loading[att.id] = false;
    }
  }
  openImageLightbox(url, att.filename, trigger);
}

async function removeAttachment(att: AttachmentSummary): Promise<void> {
  const sid = sessionStore.activeSession?.id;
  if (!sid) return;
  try {
    await draftStore.removeAttachment(sid, att.id);
    delete errors[att.id];
    // objectUrls 的回收交给 list-watch（safeRevoke，跳过灯箱占用）。
  } catch (err) {
    errors[att.id] = err instanceof Error ? err.message : '移除失败';
  }
}

// 切换会话：关闭灯箱（旧会话图不再相关）+ 撤销全部 URL + 清错误/读取态。
watch(
  () => sessionStore.activeSession?.id,
  () => {
    closeImageLightbox();
    revokeAll();
    for (const k of Object.keys(errors)) delete errors[k];
    for (const k of Object.keys(loading)) delete loading[k];
  },
);
// 附件列表变化：撤销已不在列表的 URL（safeRevoke 跳过灯箱占用，保留仍有效的避免重复请求）。
watch(
  () => props.attachments.map((a) => a.id).join('\n'),
  () => {
    const ids = new Set(props.attachments.map((a) => a.id));
    for (const [id, url] of [...objectUrls]) {
      if (!ids.has(id)) safeRevoke(id, url);
    }
  },
);

onBeforeUnmount(() => {
  alive = false;
  closeImageLightbox();
  revokeAll();
});
</script>

<template>
  <div v-if="attachments.length" class="attachment-draft-list">
    <div
      v-for="att in attachments"
      :key="att.id"
      :class="['att-card', `att-card--${att.kind}`]"
    >
      <button
        v-if="att.kind === 'image'"
        type="button"
        class="att-card__thumb"
        :title="`预览 ${att.filename}`"
        :aria-label="`预览图片 ${att.filename}`"
        @click="previewImage(att, $event.currentTarget as HTMLElement)"
      >
        <span class="att-card__file-badge" aria-hidden="true">{{ attachmentBadge(att.filename, att.mimeType) }}</span>
        <span class="att-card__name">{{ att.filename }}</span>
        <span v-if="loading[att.id]" class="att-card__hint">读取中…</span>
      </button>
      <div v-else class="att-card__file">
        <span class="att-card__file-badge" aria-hidden="true">{{ attachmentBadge(att.filename, att.mimeType) }}</span>
        <span class="att-card__file-meta">
          <span class="att-card__name" :title="att.filename">{{ att.filename }}</span>
          <span class="att-card__size">{{ formatSize(att.sizeBytes) }}</span>
        </span>
      </div>
      <button
        type="button"
        class="att-card__remove"
        :title="`移除 ${att.filename}`"
        :aria-label="`移除附件 ${att.filename}`"
        @click.stop="removeAttachment(att)"
      >×</button>
      <span v-if="errors[att.id]" class="att-card__err">{{ errors[att.id] }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 列表：横向排列、可换行；不设满宽背景/边框/阴影，不包住全部附件的大卡片。 */
.attachment-draft-list {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  width: 100%;
  max-width: var(--chat-bottom-max-width);
  margin: 0.5rem auto 0;
  padding: 0 var(--chat-bottom-pad-x);
  box-sizing: border-box;
}

.att-card {
  position: relative;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  padding: 0.3125rem 0.5rem;
  box-shadow: var(--ring-light);
  max-width: 13rem;
}

.att-card__thumb {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  border: 0;
  background: transparent;
  color: var(--color-text);
  padding: 0;
  cursor: pointer;
  min-width: 0;
}

.att-card__thumb:hover {
  color: var(--color-accent-strong);
}

.att-card__file {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  min-width: 0;
}

.att-card__file-badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  height: 1.5rem;
  padding: 0 0.375rem;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel-soft));
  color: var(--color-accent-strong);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.att-card__file-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.att-card__name {
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 8rem;
}

.att-card__size {
  font-size: 0.625rem;
  color: var(--color-text-muted);
}

.att-card__hint {
  font-size: 0.625rem;
  color: var(--color-text-muted);
}

.att-card__remove {
  flex-shrink: 0;
  border: 0;
  border-radius: 50%;
  width: 1.125rem;
  height: 1.125rem;
  line-height: 1;
  background: color-mix(in srgb, var(--color-text) 14%, transparent);
  color: var(--color-text-muted);
  cursor: pointer;
}

.att-card__remove:hover {
  background: var(--color-danger);
  color: #fff;
}

.att-card__err {
  position: absolute;
  left: 0.5rem;
  bottom: -1.0625rem;
  font-size: 0.625rem;
  color: var(--color-fail-strong);
  white-space: nowrap;
}
</style>
