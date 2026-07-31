<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useImageLightbox } from '../../composables/useImageLightbox';

const { state, close } = useImageLightbox();
const closeButton = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
let focusRestored = true;

// 缩放/平移：滚轮缩放（1x–8x）+ 左键拖拽平移 + 双击在 1x/3x 间切换。
// 未放大（scale<=1）时不接管 mousedown，保留原"点遮罩空白关闭"语义。
const scale = ref(1);
const translateX = ref(0);
const translateY = ref(0);
const MIN_SCALE = 1;
const MAX_SCALE = 8;
let dragging = false;
let startClientX = 0;
let startClientY = 0;
let startTranslateX = 0;
let startTranslateY = 0;

function resetTransform(): void {
  scale.value = 1;
  translateX.value = 0;
  translateY.value = 0;
  dragging = false;
}

function onWheel(e: WheelEvent): void {
  // @wheel.prevent 已注册为非 passive 监听，可安全 preventDefault 阻止页面缩放/滚动。
  const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
  scale.value = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((scale.value * factor).toFixed(4))));
}

function onDoubleClick(e: MouseEvent): void {
  e.preventDefault();
  if (scale.value !== 1) {
    resetTransform();
  } else {
    scale.value = 3;
  }
}

function onMouseDown(e: MouseEvent): void {
  if (e.button !== 0 || scale.value <= 1) return;
  dragging = true;
  startClientX = e.clientX;
  startClientY = e.clientY;
  startTranslateX = translateX.value;
  startTranslateY = translateY.value;
  e.preventDefault();
}

function onMouseMove(e: MouseEvent): void {
  if (!dragging) return;
  translateX.value = startTranslateX + (e.clientX - startClientX);
  translateY.value = startTranslateY + (e.clientY - startClientY);
}

function onMouseUp(): void {
  dragging = false;
}

function restoreFocus(): void {
  if (focusRestored) return;
  focusRestored = true;
  const target = previouslyFocused;
  previouslyFocused = null;
  if (target?.isConnected) target.focus();
}

function onKey(event: KeyboardEvent): void {
  if (!state.value) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    close();
    return;
  }
  if (event.key !== 'Tab') return;
  const dialog = document.querySelector<HTMLElement>('.image-lightbox[role="dialog"]');
  if (!dialog) return;
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>('button, [tabindex="0"]'));
  if (focusable.length === 0) return;
  const current = document.activeElement as HTMLElement | null;
  const index = current ? focusable.indexOf(current) : -1;
  const next = event.shiftKey
    ? focusable[(index - 1 + focusable.length) % focusable.length]
    : focusable[(index + 1) % focusable.length];
  event.preventDefault();
  next.focus();
}

watch(state, async (value) => {
  if (value) {
    // 每次打开复位缩放/平移，避免上次残留。
    resetTransform();
    previouslyFocused = value.trigger
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    focusRestored = false;
    await nextTick();
    closeButton.value?.focus();
  } else {
    await nextTick();
    restoreFocus();
  }
});

onMounted(() => {
  window.addEventListener('keydown', onKey);
  // 拖拽平移：mousemove/up 挂 window，鼠标移出图片仍可追踪到释放。
  window.addEventListener('mousemove', onMouseMove);
  window.addEventListener('mouseup', onMouseUp);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('mousemove', onMouseMove);
  window.removeEventListener('mouseup', onMouseUp);
  restoreFocus();
});
</script>

<template>
  <Teleport to="body">
    <div
      v-if="state"
      class="image-lightbox"
      role="dialog"
      aria-modal="true"
      aria-label="图片预览"
      @click="close"
    >
      <img
        :src="state.src"
        class="image-lightbox__img"
        :class="{ 'is-zoomed': scale > 1 }"
        :alt="state.alt"
        :style="{ transform: `translate(${translateX}px, ${translateY}px) scale(${scale})` }"
        @click.stop
        @wheel.prevent="onWheel"
        @dblclick="onDoubleClick"
        @mousedown="onMouseDown"
      />
      <button ref="closeButton" class="image-lightbox__close" type="button" aria-label="关闭图片预览" @click.stop="close">×</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 蒙层裁剪：放大后图片超出视口部分被裁掉，不溢出产生滚动条（基础布局在 main.css）。 */
.image-lightbox {
  overflow: hidden;
}

.image-lightbox__img {
  transform-origin: center center;
  /* 缩放跟手：不设 transition，滚轮即时响应。 */
}

.image-lightbox__img.is-zoomed {
  cursor: grab;
}

.image-lightbox__img.is-zoomed:active {
  cursor: grabbing;
}
</style>
