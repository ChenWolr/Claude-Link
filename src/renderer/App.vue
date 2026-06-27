<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useChat } from './composables/use-chat';
import { THEME_PALETTES } from '../shared/constants';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const { startListening, stopListening } = useChat();

onMounted(async () => {
  await configStore.loadConfig();
  const palette = THEME_PALETTES.find((p) => p.id === configStore.config.themePaletteId);
  if (palette) {
    const root = document.documentElement;
    root.style.setProperty('--color-bg', palette.colors.bg);
    root.style.setProperty('--color-panel', palette.colors.panel);
    root.style.setProperty('--color-panel-soft', palette.colors.panelSoft);
    root.style.setProperty('--color-border', palette.colors.border);
    root.style.setProperty('--color-text', palette.colors.text);
    root.style.setProperty('--color-text-muted', palette.colors.textMuted);
    root.style.setProperty('--color-accent', palette.colors.accent);
    root.style.setProperty('--color-accent-strong', palette.colors.accentStrong);
    root.style.setProperty('--color-danger', palette.colors.danger);
  }
  // 根因修复：chat:event 监听在 App.vue 全局注册，生命周期与 app 等长。
  // ChatPage 卸载（路由跳转到配置页/会话管理页）不影响监听，后台执行的会话事件不丢失。
  startListening();
  // bindContextUpdates 也在全局注册，避免 ChatPage 卸载后 context:update 监听丢失。
  sessionStore.bindContextUpdates();
});

onBeforeUnmount(() => {
  stopListening();
});
</script>

<template>
  <AppLayout>
    <router-view />
    <InteractionPrompt />
  </AppLayout>
</template>
