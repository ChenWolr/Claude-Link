import { ref } from 'vue';

export interface ImageLightboxState {
  src: string;
  alt: string;
  trigger: HTMLElement | null;
}

const state = ref<ImageLightboxState | null>(null);

export function openImageLightbox(url: string, alt = '', trigger: HTMLElement | null = null): void {
  if (!url) return;
  state.value = { src: url, alt, trigger };
}

export function closeImageLightbox(): void {
  state.value = null;
}

export function useImageLightbox() {
  return { state, close: closeImageLightbox };
}
