<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useImageLightbox } from '../../composables/useImageLightbox';

const { state, close } = useImageLightbox();
const closeButton = ref<HTMLButtonElement | null>(null);
let previouslyFocused: HTMLElement | null = null;
let focusRestored = true;

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

onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey);
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
      <img :src="state.src" class="image-lightbox__img" :alt="state.alt" @click.stop />
      <button ref="closeButton" class="image-lightbox__close" type="button" aria-label="关闭图片预览" @click.stop="close">×</button>
    </div>
  </Teleport>
</template>
