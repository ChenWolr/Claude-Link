<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import ImageLightbox from './components/chat/ImageLightbox.vue';
import DiffDialog from './components/changes/DiffDialog.vue';
import ToolDiffDialog from './components/chat/ToolDiffDialog.vue';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useExportImageStore } from './stores/export-image-store';
import { useChat } from './composables/use-chat';
import { useCommandStore } from './stores/command-store';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../shared/constants';
import { applyThemePalette, applyFontScale } from './utils/apply-theme';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const exportImageStore = useExportImageStore();
const commandStore = useCommandStore();
const { startListening, stopListening } = useChat();
let stopExportProgress: (() => void) | null = null;
let stopCommandChanges: (() => void) | null = null;

// Electron 经典坑：渲染窗口对 OS 文件拖入的默认动作是导航到 file:///（窗口被替换/白屏）。
// 仅文件拖放（dataTransfer.types 含 Files）会触发该导航；文本拖放到 textarea 需保留默认行为
// （让浏览器插入文本），故不再无条件 preventDefault。业务消费由 ChatPage 在 .chat-page 容器上处理。
function suppressDragNavigation(e: DragEvent): void {
  const types = e.dataTransfer?.types;
  if (types && Array.from(types).includes('Files')) {
    e.preventDefault();
  }
}

onMounted(async () => {
  document.addEventListener('dragover', suppressDragNavigation);
  document.addEventListener('drop', suppressDragNavigation);
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
  // 原生 Slash Commands：命令变化全局订阅（ChatPage 卸载/后台会话不丢事件）。主进程 COMMANDS_CHANGED
  // 推送的 snapshot 按 sessionId 全量替换进 command-store。
  stopCommandChanges = window.claudeLink.onCommandChanged((payload) => commandStore.replaceFromEvent(payload));
});

onBeforeUnmount(() => {
  document.removeEventListener('dragover', suppressDragNavigation);
  document.removeEventListener('drop', suppressDragNavigation);
  stopListening();
  if (stopExportProgress) stopExportProgress();
  if (stopCommandChanges) stopCommandChanges();
});
</script>

<template>
  <AppLayout>
    <router-view />
    <InteractionPrompt />
    <ImageLightbox />
    <DiffDialog />
    <ToolDiffDialog />
  </AppLayout>
</template>
