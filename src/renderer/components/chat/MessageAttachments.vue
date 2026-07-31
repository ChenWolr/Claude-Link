<script setup lang="ts">
// 历史消息附件渲染：图片缩略图（点击进现有灯箱取原图）+ 文件卡片。
// 预览经 preload 受控 IPC 取有界 bytes → Blob URL；卸载/列表变化/会话切换时 revoke。
// 附件文件丢失/损坏时显示「附件不可用」占位，不抛错、不让整条消息渲染失败。
// 不持有文件系统路径/bytes，不直接调用 Node API。
import { onBeforeUnmount, reactive, watch } from 'vue';
import { useSessionStore } from '../../stores/session-store';
import { openImageLightbox } from '../../composables/useImageLightbox';
import { attachmentBadge } from '../../utils/attachment';
import type { AttachmentSummary } from '../../../shared/types/attachment';
import type { ExportAttachmentSnapshot } from '../../../shared/types/export-image';

type DisplayAttachment = AttachmentSummary | ExportAttachmentSnapshot;

const props = defineProps<{
  attachments: DisplayAttachment[];
  exportMode?: boolean;
}>();

const sessionStore = useSessionStore();
const isSnapshotAttachment = (att: DisplayAttachment): att is ExportAttachmentSnapshot => !('id' in att);
const snapshotKeys = new WeakMap<object, string>();
let nextSnapshotKey = 0;
const attachmentKey = (att: DisplayAttachment): string => {
  if (!isSnapshotAttachment(att)) return att.id;
  let key = snapshotKeys.get(att);
  if (!key) {
    key = `export:${nextSnapshotKey++}`;
    snapshotKeys.set(att, key);
  }
  return key;
};

// 原图 Blob URL（attachmentId -> url）：点击缩略图时按需取原图进灯箱。非响应式（不参与模板渲染）。
const urlByAttachmentId = new Map<string, string>();
// 缩略图 Blob URL（响应式，模板 <img> 绑定）。挂载/附件出现时取 thumbnail=true；导出模式不加载。
const thumbByAttachmentId = reactive<Record<string, string>>({});
const errorByAttachmentId = reactive<Record<string, string>>({});
const loading = reactive<Record<string, boolean>>({});       // 原图灯箱读取态
const thumbLoading = reactive<Record<string, boolean>>({});   // 缩略图读取态（静默，失败退化 badge）
let alive = true;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// IPC 跨 realm 传来的 bytes 类型为 Uint8Array<ArrayBufferLike>，不能直接当 BlobPart（可能 SharedArrayBuffer）。
// 复制成当前 realm 的 ArrayBuffer 再交给 Blob，规避 TS/DOM 类型与跨 realm 风险。
function toBlobPart(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function revokeAll(): void {
  for (const url of urlByAttachmentId.values()) URL.revokeObjectURL(url);
  for (const id of Object.keys(thumbByAttachmentId)) {
    URL.revokeObjectURL(thumbByAttachmentId[id]);
    delete thumbByAttachmentId[id];
  }
  urlByAttachmentId.clear();
}

// 预览：thumbnail=false 取原图进灯箱（灯箱支持缩放，缩略图会糊）；预览失败进入「不可用」占位。
async function fetchPreviewUrl(att: DisplayAttachment, thumbnail: boolean): Promise<string | null> {
  const sid = sessionStore.activeSession?.id;
  if (!sid || isSnapshotAttachment(att)) return null;
  try {
    const res = await window.claudeLink.getAttachmentPreview({ sessionId: sid, attachmentId: att.id, thumbnail });
    return URL.createObjectURL(new Blob([toBlobPart(res.bytes)], { type: res.mimeType }));
  } catch {
    return null;
  }
}

// 缩略图：挂载/附件出现时取 thumbnail=true 渲染 <img>。导出模式不加载（隐藏 renderer 复用文件卡片）。
// 失败静默退化 badge（不占位为「不可用」——只有点击取原图失败才占位，避免缩略图抖动到错误态）。
async function loadThumb(att: DisplayAttachment): Promise<void> {
  if (props.exportMode || isSnapshotAttachment(att) || thumbByAttachmentId[attachmentKey(att)] || thumbLoading[attachmentKey(att)]) return;
  const sid = sessionStore.activeSession?.id;
  if (!sid) return;
  thumbLoading[attachmentKey(att)] = true;
  try {
    const url = await fetchPreviewUrl(att, true);
    if (!alive || sessionStore.activeSession?.id !== sid || !url) return;
    thumbByAttachmentId[attachmentKey(att)] = url;
  } catch {
    // 静默退化
  } finally {
    thumbLoading[attachmentKey(att)] = false;
  }
}

// 图片缩略图：点击进入灯箱时按需取原图。导出模式不加载（隐藏 renderer 复用文件卡片）。
async function openPreview(att: DisplayAttachment, trigger: HTMLElement): Promise<void> {
  if (isSnapshotAttachment(att)) return;
  if (errorByAttachmentId[attachmentKey(att)]) return;
  let url = urlByAttachmentId.get(attachmentKey(att));
  if (!url) {
    if (loading[attachmentKey(att)]) return;
    loading[attachmentKey(att)] = true;
    try {
      url = (await fetchPreviewUrl(att, false)) ?? undefined;
      if (!url) {
        errorByAttachmentId[attachmentKey(att)] = '附件不可用';
        return;
      }
      if (!alive) {
        URL.revokeObjectURL(url);
        return;
      }
      urlByAttachmentId.set(attachmentKey(att), url);
    } finally {
      loading[attachmentKey(att)] = false;
    }
  }
  openImageLightbox(url, att.filename, trigger);
}

// 附件列表变化（immediate：历史加载即取缩略图）：
// 撤销已不在列表的 URL（原图 + 缩略图），并为新出现的非导出图片加载缩略图。
watch(
  () => props.attachments.map((att) => `${attachmentKey(att)}:${att.kind}`).join('\n'),
  () => {
    const ids = new Set(props.attachments.filter((a): a is AttachmentSummary => !isSnapshotAttachment(a)).map((a) => a.id));
    for (const [id, url] of [...urlByAttachmentId]) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(url);
        urlByAttachmentId.delete(id);
      }
    }
    for (const id of Object.keys(thumbByAttachmentId)) {
      if (!ids.has(id)) {
        URL.revokeObjectURL(thumbByAttachmentId[id]);
        delete thumbByAttachmentId[id];
      }
    }
    for (const att of props.attachments) {
      const key = attachmentKey(att);
      if (props.exportMode && isSnapshotAttachment(att) && att.kind === 'image' && att.preview && !thumbByAttachmentId[key]) {
        thumbByAttachmentId[key] = URL.createObjectURL(
          new Blob([toBlobPart(att.preview.bytes)], { type: att.preview.mimeType }),
        );
      } else if (att.kind === 'image' && !thumbByAttachmentId[key]) {
        void loadThumb(att);
      }
    }
  },
  { immediate: true },
);
// 会话切换：撤销全部 URL 与错误态。
watch(
  () => sessionStore.activeSession?.id,
  () => {
    revokeAll();
    for (const k of Object.keys(errorByAttachmentId)) delete errorByAttachmentId[k];
    for (const k of Object.keys(loading)) delete loading[k];
    for (const k of Object.keys(thumbLoading)) delete thumbLoading[k];
  },
);

// 导出模式开关：退出导出模式后补加载此前跳过的缩略图。
watch(
  () => props.exportMode,
  (isExport) => {
    if (!isExport) {
      for (const att of props.attachments) {
        if (att.kind === 'image' && !thumbByAttachmentId[attachmentKey(att)]) void loadThumb(att);
      }
    }
  },
);

onBeforeUnmount(() => {
  alive = false;
  revokeAll();
});
</script>

<template>
  <div v-if="attachments.length" class="msg-attachments">
    <template v-for="att in attachments" :key="attachmentKey(att)">
      <!-- 附件不可用占位：文件丢失/预览失败时保留消息、明确状态，不抛错。 -->
      <div
        v-if="errorByAttachmentId[attachmentKey(att)] || (isSnapshotAttachment(att) && att.previewUnavailable)"
        class="msg-att msg-att--unavailable"
      >
        <span class="msg-att__icon" aria-hidden="true">⚠️</span>
        <span class="msg-att__meta">
          <span class="msg-att__name msg-att__name--dim" :title="att.filename">{{ att.filename }}</span>
          <span class="msg-att__unavail">{{ errorByAttachmentId[attachmentKey(att)] || '附件不可用' }}</span>
        </span>
      </div>
      <!-- 导出模式只读 snapshot 里的 PNG bytes，不调用 preload。 -->
      <div v-else-if="exportMode && att.kind === 'image' && thumbByAttachmentId[attachmentKey(att)]" class="msg-att msg-att--image">
        <img class="msg-att__thumb-img" :src="thumbByAttachmentId[attachmentKey(att)]" :alt="att.filename" />
        <span class="msg-att__meta">
          <span class="msg-att__name">{{ att.filename }}</span>
          <span class="msg-att__size">{{ formatSize(att.sizeBytes) }}</span>
        </span>
      </div>
      <!-- 图片缩略图：点击进灯箱取原图放大。 -->
      <button
        v-else-if="att.kind === 'image' && !exportMode"
        type="button"
        class="msg-att msg-att--image"
        :title="`预览 ${att.filename}`"
        :aria-label="`预览图片 ${att.filename}`"
        @click="openPreview(att, $event.currentTarget as HTMLElement)"
      >
        <img
          v-if="thumbByAttachmentId[attachmentKey(att)]"
          class="msg-att__thumb-img"
          :src="thumbByAttachmentId[attachmentKey(att)]"
          :alt="att.filename"
        />
        <span v-else class="msg-att__badge" aria-hidden="true">{{ attachmentBadge(att.filename, att.mimeType) }}</span>
        <span class="msg-att__meta">
          <span class="msg-att__name">{{ att.filename }}</span>
          <span class="msg-att__size">{{ formatSize(att.sizeBytes) }}<template v-if="att.width && att.height"> · {{ att.width }}×{{ att.height }}</template></span>
        </span>
        <span v-if="loading[attachmentKey(att)]" class="msg-att__hint">读取中…</span>
      </button>
      <!-- 文件卡片（含导出模式下的图片退化展示）：仅显示类型/名称/大小，不调系统程序打开。 -->
      <div v-else class="msg-att msg-att--file">
        <span class="msg-att__badge" aria-hidden="true">{{ attachmentBadge(att.filename, att.mimeType) }}</span>
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

.msg-att__thumb-img {
  width: 3rem;
  height: 3rem;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
  background: var(--color-panel);
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
