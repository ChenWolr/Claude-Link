<script setup lang="ts">
// v4.1 导出格式选择弹窗。AppHeader 分享按钮先开此弹窗，用户选 JPEG/PNG 后再 start。
// 复用 theme/interaction tokens；文案诚实：两种格式超长会话都按安全边界分多张，不承诺无限单图。
// 依据：docs/superpowers/plans/2026-07-21-export-image-v41-png-worker.md §7 Task 12。
import { ref, watch, nextTick, onMounted, onBeforeUnmount } from 'vue';
import type { ExportImageFormat } from '@shared/types/export-image';

const props = defineProps<{ open: boolean; busy?: boolean }>();
const emit = defineEmits<{
  (e: 'confirm', format: ExportImageFormat): void;
  (e: 'cancel'): void;
}>();

const selected = ref<ExportImageFormat>('jpeg');
const cardRef = ref<HTMLDivElement | null>(null);

function reset(): void { selected.value = 'jpeg'; }
function onKey(e: KeyboardEvent): void {
  if (!props.open) return;
  if (e.key === 'Escape') { e.preventDefault(); emit('cancel'); }
  else if (e.key === 'Enter') { e.preventDefault(); confirm(); }
  else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); selected.value = 'png'; }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); selected.value = 'jpeg'; }
}
function confirm(): void {
  if (props.busy) return;
  emit('confirm', selected.value);
}

watch(() => props.open, (open) => {
  if (open) { reset(); void nextTick(() => cardRef.value?.focus()); }
});

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div
      v-if="open"
      class="export-fmt-overlay"
      role="presentation"
      @click.self="emit('cancel')"
    >
      <div
        ref="cardRef"
        class="export-fmt-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-fmt-title"
        tabindex="-1"
      >
        <h3 id="export-fmt-title" class="export-fmt-title">导出长图格式</h3>
        <p class="export-fmt-sub">选择导出格式。超长会话两种格式都按安全边界分多张，不存在无限单张。</p>

        <div class="export-fmt-options" role="radiogroup" aria-labelledby="export-fmt-title">
          <button
            type="button"
            class="export-fmt-option"
            role="radio"
            :aria-checked="selected === 'jpeg'"
            :class="{ 'is-selected': selected === 'jpeg' }"
            @click="selected = 'jpeg'"
            @dblclick="selected = 'jpeg'; confirm()"
          >
            <div class="export-fmt-option__head">
              <span class="export-fmt-option__radio" aria-hidden="true"></span>
              <span class="export-fmt-option__name">高画质 JPEG</span>
              <span class="export-fmt-option__tag">默认</span>
            </div>
            <p class="export-fmt-option__desc">文件更小，适合日常分享；沿用当前高质量导出（0.92），超长时按安全边界分页。</p>
          </button>

          <button
            type="button"
            class="export-fmt-option"
            role="radio"
            :aria-checked="selected === 'png'"
            :class="{ 'is-selected': selected === 'png' }"
            @click="selected = 'png'"
            @dblclick="selected = 'png'; confirm()"
          >
            <div class="export-fmt-option__head">
              <span class="export-fmt-option__radio" aria-hidden="true"></span>
              <span class="export-fmt-option__name">无损 PNG 长图</span>
              <span class="export-fmt-option__tag export-fmt-option__tag--png">更长</span>
            </div>
            <p class="export-fmt-option__desc">保留渲染后每个像素，优先生成更长的完整图片；文件更大，超出内存或单页限制时仍会分页。</p>
          </button>
        </div>

        <div class="export-fmt-actions">
          <button type="button" class="export-fmt-btn export-fmt-btn--ghost" :disabled="busy" @click="emit('cancel')">取消</button>
          <button type="button" class="export-fmt-btn export-fmt-btn--primary" :disabled="busy" @click="confirm">
            {{ busy ? '准备中…' : '开始导出' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.export-fmt-overlay {
  position: fixed;
  inset: 0;
  background: var(--interaction-overlay-bg, rgba(0, 0, 0, 0.45));
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 9000;
  padding: 1rem;
}
.export-fmt-card {
  width: min(440px, 100%);
  background: var(--color-panel-soft, #1e1e24);
  color: var(--color-text, #e6e6e6);
  border-radius: var(--radius-lg, 14px);
  box-shadow: var(--elevation-3, 0 12px 40px rgba(0, 0, 0, 0.5));
  padding: 1.25rem 1.25rem 1rem;
  outline: none;
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
}
.export-fmt-title { margin: 0 0 0.25rem; font-size: 1.05rem; font-weight: 600; }
.export-fmt-sub { margin: 0 0 0.9rem; font-size: 0.8rem; opacity: 0.7; line-height: 1.45; }
.export-fmt-options { display: flex; flex-direction: column; gap: 0.5rem; }
.export-fmt-option {
  text-align: left;
  display: block;
  width: 100%;
  padding: 0.7rem 0.8rem;
  border-radius: var(--radius-md, 10px);
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.1));
  background: var(--color-panel, rgba(255, 255, 255, 0.03));
  color: inherit;
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s;
}
.export-fmt-option:hover { background: var(--color-panel-hover, rgba(255, 255, 255, 0.06)); }
.export-fmt-option:focus-visible {
  outline: 2px solid var(--color-accent, #4c9aff);
  outline-offset: 2px;
}
.export-fmt-option.is-selected {
  border-color: var(--color-accent, #4c9aff);
  background: var(--color-accent-soft, rgba(76, 154, 255, 0.12));
}
.export-fmt-option__head { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.25rem; }
.export-fmt-option__radio {
  width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid var(--color-border-strong, rgba(255, 255, 255, 0.35));
  flex-shrink: 0;
  position: relative;
}
.export-fmt-option.is-selected .export-fmt-option__radio { border-color: var(--color-accent, #4c9aff); }
.export-fmt-option.is-selected .export-fmt-option__radio::after {
  content: ''; position: absolute; inset: 2px; border-radius: 50%;
  background: var(--color-accent, #4c9aff);
}
.export-fmt-option__name { font-weight: 600; font-size: 0.92rem; }
.export-fmt-option__tag {
  margin-left: auto; font-size: 0.7rem; padding: 0.05rem 0.4rem; border-radius: 6px;
  background: rgba(255, 255, 255, 0.08); opacity: 0.8;
}
.export-fmt-option__tag--png { background: rgba(76, 154, 255, 0.18); color: var(--color-accent, #4c9aff); }
.export-fmt-option__desc { margin: 0; font-size: 0.78rem; opacity: 0.7; line-height: 1.45; }
.export-fmt-actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1rem; }
.export-fmt-btn {
  padding: 0.45rem 1rem; border-radius: var(--radius-md, 8px);
  border: 1px solid transparent; cursor: pointer; font-size: 0.85rem; font-weight: 500;
}
.export-fmt-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.export-fmt-btn--ghost {
  background: transparent; border-color: var(--color-border, rgba(255, 255, 255, 0.15));
  color: inherit;
}
.export-fmt-btn--ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.05); }
.export-fmt-btn--primary {
  background: var(--color-accent, #4c9aff); color: #fff;
}
.export-fmt-btn--primary:hover:not(:disabled) { filter: brightness(1.08); }
@media (prefers-reduced-motion: reduce) {
  .export-fmt-option, .export-fmt-btn { transition: none; }
}
</style>
