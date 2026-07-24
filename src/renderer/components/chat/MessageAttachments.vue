<script setup lang="ts">
// 历史消息附件渲染：图片缩略图（点击进现有灯箱取原图）+ 文件卡片。
// 预览经 preload 受控 IPC 取有界 bytes → Blob URL；卸载/列表变化/会话切换时 revoke。
// 附件文件丢失/损坏时显示「附件不可用」占位，不抛错、不让整条消息渲染失败。
// 不持有文件系统路径/bytes，不直接调用 Node API。
import { onBeforeUnmount, reactive, watch } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { openImageLightbox } from '../../composables/useImageLightbox';
import type { AttachmentSummary } from '../../../shared/types/attachment';

const props = defineProps<{
  attachments: AttachmentSummary[];
  exportMode?: boolean;
}>();

const sessionStore = useSessionStore();

// attachmentId -> Blob URL。卸载/列表变化/会话切换时 revoke。
const urlByAttachmentId = new Map<string, string>();
const errorByAttachmentId = reactive<Record<string, string>>({});
const loading = reactive<Record<string, boolean>>({});
let alive = true;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function fileBadge(mimeType: string): string {
  const mime = mimeType.toLowerCase();
  if (mime === 'application/pdf') return 'PDF';
  if (mime.startsWith('text/') || mime.includes('markdown') || mime.includes('json') || mime.includes('csv') || mime.includes('yaml') || mime.includes('xml')) return 'TXT';
  if (mime.startsWith('image/')) return 'IMG';
  return 'FILE';
}

function revokeAll(): void {
  for (const url of urlByAttachmentId.values()) URL.revokeObjectURL(url);
  urlByAttachmentId.clear();
}

// 预览：thumbnail=false 取原图进灯箱（灯箱支持缩放，缩略图会糊）；预览失败进入「不可用」占位。
async function previewAttachment(att: AttachmentSummary, thumbnail: boolean): Promise<string | null> {
  const sid = sessionStore.activeSession?.id;
  if (!sid) return null;
  try {
    const res = await window.claudeLink.getAttachmentPreview({ sessionId: sid, attachmentId: att.id, thumbnail });
    return URL.createObjectURL(new Blob([res.bytes], { type: res.mimeType }));
  } catch {
    return null;
  }
}

// 图片缩略图：优先取缩略图展示；点击进入灯箱时按需取原图。导出模式不加载（隐藏 renderer 复用文件卡片）。
async function openPreview(att: AttachmentSummary, trigger: HTMLElement): Promise<void> {
  if (errorByAttachmentId[att.id]) return;
  let url = urlByAttachmentId.get(att.id);
  if (!url) {
    if (loading[att.id]) return;
    loading[att.id] = true;
    try {
      url = (await previewAttachment(att, false)) ?? undefined;
      if (!url) {
        errorByAttachmentId[att.id] = '附件不可用';
        return;
      }
      if (!alive) {
        URL.revokeObjectURL(url);
        return;
      }
      urlByAttachmentId.set(att.id, url);
    } finally {
      loading[att.id] = false;
    }
  }
  openImageLightbox(url, att.filename, trigger);
}

// 附件列表变化：撤销已不在列表的 URL。
watch(
  () => props.attachments.map((a) => a.id).join('\n'),
  () => {
    const ids = new Set(props.attachments.map((a) => a.id));
    for (const [id, url] of [...urlByAttachmentId]) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urlByAttachmentId.delete(id);
      }
    }
  },
);
// 会话切换：撤销全部 URL 与错误态。
watch(
  () => sessionStore.activeSession?.id,
  () => {
    revokeAll();
    for (const k of Object.keys(errorByAttachmentId)) delete errorByAttachmentId[k];
    for (const k of Object.keys(loading)) delete loading[k];
  },
);

onBeforeUnmount(() => {
  alive = false;
  revokeAll();
});
</script>

<template>
  <div v-if="attachments.length" class="msg-attachments">
    <template v-for="att in attachments" :key="att.id">
      <!-- 附件不可用占位：文件丢失/预览失败时保留消息、明确状态，不抛错。 -->
      <div v-if="errorByAttachmentId[att.id]" class="msg-att msg-att--unavailable">
        <span class="msg-att__icon" aria-hidden="true">⚠️</span>
        <span class="msg-att__meta">
          <span class="msg-att__name msg-att__name--dim" :title="att.filename">{{ att.filename }}</span>
          <span class="msg-att__unavail">{{ errorByAttachmentId[att.id] }}</span>
        </span>
      </div>
      <!-- 图片缩略图：点击进灯箱取原图放大。导出模式退化为文件卡片（不加载原图、不弹灯箱）。 -->
      <button
        v-else-if="att.kind === 'image' && !exportMode"
        type="button"
        class="msg-att msg-att--image"
        :title="`预览 ${att.filename}`"
        :aria-label="`预览图片 ${att.filename}`"
        @click="openPreview(att, $event.currentTarget as HTMLElement)"
      >
        <span class="msg-att__icon" aria-hidden="true">🖼</span>
        <span class="msg-att__meta">
          <span class="msg-att__name">{{ att.filename }}</span>
          <span class="msg-att__size">{{ formatSize(att.sizeBytes) }}<template v-if="att.width && att.height"> · {{ att.width }}×{{ att.height }}</template></span>
        </span>
        <span v-if="loading[att.id]" class="msg-att__hint">读取中…</span>
      </button>
      <!-- 文件卡片（含导出模式下的图片退化展示）：仅显示类型/名称/大小，不调系统程序打开。 -->
      <div v-else class="msg-att msg-att--file">
        <span class="msg-att__badge" aria-hidden="true">{{ fileBadge(att.mimeType) }}</span>
        <span class="msg-att__meta">
          <span class="msg-att__name" :title="att.filename">{{ att.filename }}</span>
          <span class="msg-att__size">{{ formatSize(att.sizeBytes) }}</span>
        </span>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 附件行：位于消息文字下方，横向排列、可换行；每个附件独立卡片边框。 */
.msg-attachments {
  display: flex;
  flex-wrap: wrap;
  gap: 0.375rem;
  margin-top: 0.4375rem;
}

.msg-att {
  display: flex;
  align-items: center;
  gap: 0.4375rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-panel-soft);
  padding: 0.3125rem 0.5625rem;
  max-width: 15rem;
  min-width: 0;
}

.msg-att--image {
  cursor: pointer;
  background: transparent;
}

.msg-att--image:hover {
  border-color: var(--color-accent);
}

.msg-att--unavailable {
  opacity: 0.72;
  border-style: dashed;
}

.msg-att__icon {
  flex-shrink: 0;
  font-size: 1rem;
  line-height: 1;
}

.msg-att__badge {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 2rem;
  height: 1.5rem;
  padding: 0 0.375rem;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--color-accent) 16%, var(--color-panel));
  color: var(--color-accent-strong);
  font-size: 0.625rem;
  font-weight: 700;
  letter-spacing: 0.04em;
}

.msg-att__meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.msg-att__name {
  font-size: 0.75rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 9.5rem;
}

.msg-att__name--dim {
  color: var(--color-text-muted);
}

.msg-att__size {
  font-size: 0.625rem;
  color: var(--color-text-muted);
}

.msg-att__hint {
  font-size: 0.625rem;
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.msg-att__unavail {
  font-size: 0.6875rem;
  color: var(--color-warn-strong);
}
</style>
