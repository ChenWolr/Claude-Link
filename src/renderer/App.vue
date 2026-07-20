<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import ImageLightbox from './components/chat/ImageLightbox.vue';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useExportImageStore } from './stores/export-image-store';
import { useChat } from './composables/use-chat';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../shared/constants';
import { applyThemePalette, applyFontScale } from './utils/apply-theme';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const exportImageStore = useExportImageStore();
const { startListening, stopListening } = useChat();
let stopExportProgress: (() => void) | null = null;

onMounted(async () => {
  await configStore.loadConfig();
  const root = document.documentElement;
  const palette = THEME_PALETTES.find((p) => p.id === configStore.config.themePaletteId);
  if (palette) applyThemePalette(palette, root);
  // 字体大小：根据 config.fontScale 动态设置 --font-size-base，所有 rem 单位随此缩放。
  applyFontScale(configStore.config.fontScale, FONT_SCALE_SIZES, root);
  // 根因修复：chat:event 监听在 App.vue 全局注册，生命周期与 app 等长。
  // ChatPage 卸载（路由跳转到配置页/会话管理页）不影响监听，后台执行的会话事件不丢失。
  startListening();
  // bindContextUpdates 也在全局注册，避免 ChatPage 卸载后 context:update 监听丢失。
  sessionStore.bindContextUpdates();
  // 导出进度监听也在全局注册一次：切换路由/会话不影响进行中的导出 job。
  stopExportProgress = window.claudeLink.onImageExportProgress((p) => exportImageStore.applyProgress(p));
});

onBeforeUnmount(() => {
  stopListening();
  if (stopExportProgress) stopExportProgress();
});
</script>

<template>
  <AppLayout>
    <router-view />
    <InteractionPrompt />
    <ImageLightbox />
  </AppLayout>
</template>
