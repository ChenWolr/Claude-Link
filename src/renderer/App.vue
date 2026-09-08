<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import ImageLightbox from './components/chat/ImageLightbox.vue';
import DiffDialog from './components/changes/DiffDialog.vue';
import ToolDiffDialog from './components/chat/ToolDiffDialog.vue';
import { useConfigStore, lastSaveFailed } from './stores/config-store';
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
let stopGlobalCommandChanges: (() => void) | null = null;

// Electron 经典坑：渲染窗口对 OS 文件拖入的默认动作是导航到 file:///（窗口被替换/白屏）。
// 仅文件拖放（dataTransfer.types 含 Files）会触发该导航；文本拖放到 textarea 需保留默认行为
// （让浏览器插入文本），故不再无条件 preventDefault。业务消费由 ChatPage 在 .chat-page 容器上处理。
function suppressDragNavigation(e: DragEvent): void {
  const types = e.dataTransfer?.types;
  if (types && Array.from(types).includes('Files')) {
    e.preventDefault();
  }
}

// H1（F5 重做）：设置保存失败跨卸载可感知。ConfigPage 的局部 saveStatus 随页面卸载失效、
// 其 watch 随 setup 停止——用户已离开设置页时全局 toast 是唯一可达的展示位。只在
// false→true 边沿弹一次；标志由 ConfigPage performInit 重存清位（成功由 config-store
// saveConfig 清；失败由 A1 在 catch 清，恢复下一次失败的边沿）。A3：文案中性化——
// 用户在场时「重进设置页将恢复」承诺不适配（在场有页内 saveStatus）；且标志回到 false
// 时若 toast 仍在显示则提前隐藏，不傻等 5s 自然到期。
const saveFailedToastVisible = ref(false);
let saveFailedToastTimer: ReturnType<typeof setTimeout> | null = null;
watch(lastSaveFailed, (failed) => {
  if (failed) {
    saveFailedToastVisible.value = true;
    if (saveFailedToastTimer) clearTimeout(saveFailedToastTimer);
    saveFailedToastTimer = setTimeout(() => { saveFailedToastVisible.value = false; }, 5000);
  } else if (saveFailedToastVisible.value) {
    // 重存/后续保存成功：提前撤销失败提示，缩短「已恢复」前的误导窗口。
    saveFailedToastVisible.value = false;
    if (saveFailedToastTimer) clearTimeout(saveFailedToastTimer);
    saveFailedToastTimer = null;
  }
});

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
  // D4：全局兜底快照热刷新广播——暂态会话覆盖 / 空命令已物化会话回填（当前活跃会话作为消费上下文传入，
  // 避免 command-store ↔ session-store 的 store 间依赖）。不经 isSessionActive 守卫，暂态也能收到。
  stopGlobalCommandChanges = window.claudeLink.onGlobalCommandsChanged((payload) =>
    commandStore.applyGlobalFallback(payload.snapshot, sessionStore.activeSession),
  );
});

onBeforeUnmount(() => {
  document.removeEventListener('dragover', suppressDragNavigation);
  document.removeEventListener('drop', suppressDragNavigation);
  stopListening();
  if (stopExportProgress) stopExportProgress();
  if (stopCommandChanges) stopCommandChanges();
  if (stopGlobalCommandChanges) stopGlobalCommandChanges();
  if (saveFailedToastTimer) clearTimeout(saveFailedToastTimer);
});
</script>

<template>
  <AppLayout>
    <router-view />
    <InteractionPrompt />
    <ImageLightbox />
    <DiffDialog />
    <ToolDiffDialog />
    <div v-if="saveFailedToastVisible" class="global-toast global-toast--error">设置保存失败，部分修改可能未保存</div>
  </AppLayout>
</template>

<style scoped>
/* H1：全局保存失败 toast——固定顶部居中，盖在所有路由内容之上（App.vue 无其它全局浮层样式）。 */
.global-toast {
  position: fixed;
  top: 1rem;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3000;
  border-radius: var(--radius-md);
  padding: 0.625rem 0.875rem;
  font-size: 0.8125rem;
  box-shadow: var(--ring-light), var(--elevation-2);
}

.global-toast--error {
  border: 1px solid var(--color-fail-strong);
  background: color-mix(in srgb, var(--color-fail) 12%, var(--color-panel));
  color: var(--color-fail-strong);
}
</style>
