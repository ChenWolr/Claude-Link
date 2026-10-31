<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch, type Ref } from 'vue';
import AppLayout from './components/layout/AppLayout.vue';
import InteractionPrompt from './components/chat/InteractionPrompt.vue';
import ImageLightbox from './components/chat/ImageLightbox.vue';
import DiffDialog from './components/changes/DiffDialog.vue';
import ToolDiffDialog from './components/chat/ToolDiffDialog.vue';
import UpdateDialog from './components/layout/UpdateDialog.vue';
import FilePickerDialog from './components/common/FilePickerDialog.vue';
import { useConfigStore, lastSaveFailed } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useProviderStore } from './stores/provider-store';
import { useExportImageStore } from './stores/export-image-store';
import { useUpdateStore } from './stores/update-store';
import { useChat } from './composables/use-chat';
import { useCommandStore } from './stores/command-store';
import { useTaskStore } from './stores/task-store';
import { THEME_PALETTES, FONT_SCALE_SIZES } from '../shared/constants';
import { BUILD_REV } from '../shared/build-info';
import { applyThemePalette, applyFontScale } from './utils/apply-theme';

const configStore = useConfigStore();
const sessionStore = useSessionStore();
const providerStore = useProviderStore();
const exportImageStore = useExportImageStore();
const commandStore = useCommandStore();
const taskStore = useTaskStore();
const updateStore = useUpdateStore();
const { startListening, stopListening } = useChat();
let stopExportProgress: (() => void) | null = null;
let stopExportTargetRequest: (() => void) | null = null;
let stopCommandChanges: (() => void) | null = null;
let stopGlobalCommandChanges: (() => void) | null = null;
let stopQueueEvents: (() => void) | null = null;
let stopBridgeSessionsUpserted: (() => void) | null = null;
let stopSessionsChanged: (() => void) | null = null;
let stopWorkspacesChanged: (() => void) | null = null;

// B（2026-10-30）：网页版渲染产物滞后可见化。web-bridge 收到的主进程 welcome buildRev 与渲染
// bundle 的 BUILD_REV 不一致 ⟺ 网页版在吃上次构建产物（dev 未重建 / 主进程与产物错代）。
// 桌面端恒不渲染（__claudeLinkWebBridge 标记门控）；横条可关闭，同一 rev 对经 localStorage 记住不再弹。
// 仅诊断、不阻塞任何操作。
const isWebRuntime = typeof window !== 'undefined' && (window as any).__claudeLinkWebBridge === true;
const REV_WARN_DISMISS_KEY = 'clWebRevWarnDismissed';
const revWarnDismissed = ref(false);
// holder 用 shallowRef（对象包一层避免 Vue 类型层把 Ref 展开成 string，也避免运行时深层响应化）：
// null → ref 的迁移由异步 import 的 .then 完成，若非响应式 let 承接，首次渲染（import 未完成时）
// 算出的 false 会被 computed 永久缓存、横条永不出现（实现偏差，报告申报）。
const bridgeRevHolder = shallowRef<{ rev: Ref<string> } | null>(null);
if (isWebRuntime) {
  // 动态 import：桌面端不加载 web-bridge chunk（与 turn-diff-store 的 web 独占注册同款）。
  void import('./web/web-bridge')
    .then((mod) => { bridgeRevHolder.value = { rev: mod.welcomedBuildRevRef }; })
    .catch(() => { bridgeRevHolder.value = null; });
}
const welcomedRev = computed(() => bridgeRevHolder.value?.rev.value ?? '');
const revPair = computed(() => `${welcomedRev.value}|${BUILD_REV}`);
function readDismissed(): string {
  try { return localStorage.getItem(REV_WARN_DISMISS_KEY) ?? ''; } catch { return ''; }
}
const showRevWarn = computed(() => isWebRuntime && welcomedRev.value !== '' && welcomedRev.value !== BUILD_REV
  && !revWarnDismissed.value && readDismissed() !== revPair.value);
function dismissRevWarn(): void {
  revWarnDismissed.value = true;
  try { localStorage.setItem(REV_WARN_DISMISS_KEY, revPair.value); } catch { /* 隐私模式：仅本次生效 */ }
}

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

// A4（D01-F3 + D02-F8）：sessionStore.error 全局出口——删除/搜索/改名/会话内切模型等失败此前
// 全程静默（渲染层消费点为零，D01-F3 复核修正）。非空时弹 3.5s 全局错误 toast（复用 H1 的
// .global-toast--error 样式），文案「操作失败：<摘要>」截断至 ~80 字符；连续失败以最新文案
// 重置计时；空串/null 不弹（成功路径零打扰）；不动 config/changes 既有出口。
// X16（R01-F1）：watch 源改为 [error, errorSeq]——Vue 对 primitive 同值不触发，同文案连续
// 失败（删除失败→立即重试→再失败）此前不再弹；store 写入点统一走 fail()（写 error 同时自增
// errorSeq，值语义不变），seq 变化即触发本回调、再次弹 toast 并重置计时。
const SESSION_ERROR_TOAST_MS = 3500;
const SESSION_ERROR_TEXT_MAX = 80;
const sessionErrorToastVisible = ref(false);
const sessionErrorToastText = ref('');
let sessionErrorToastTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => [sessionStore.error, sessionStore.errorSeq] as const, ([err]) => {
  if (!err) return;
  sessionErrorToastText.value = `操作失败：${err.length > SESSION_ERROR_TEXT_MAX ? `${err.slice(0, SESSION_ERROR_TEXT_MAX)}…` : err}`;
  sessionErrorToastVisible.value = true;
  if (sessionErrorToastTimer) clearTimeout(sessionErrorToastTimer);
  sessionErrorToastTimer = setTimeout(() => { sessionErrorToastVisible.value = false; }, SESSION_ERROR_TOAST_MS);
});

// X15（R02-F2）：providerStore.error 全局出口——与上方 A4 sessionStore.error 同构。load 失败
// 此前零用户可见出口：设置页误显「还没有供应商」空态（ProviderManager 空态区分另见该组件），
// 会话选择器触发器因 hb10-PRV-02 防误跳守卫静默 no-op。常量直接复用上方 A4 的
// SESSION_ERROR_TOAST_MS / SESSION_ERROR_TEXT_MAX（同文件单源；本点白名单收窄不另建共享常量）。
const providerErrorToastVisible = ref(false);
const providerErrorToastText = ref('');
let providerErrorToastTimer: ReturnType<typeof setTimeout> | null = null;
watch(() => providerStore.error, (err) => {
  if (!err) return;
  providerErrorToastText.value = `操作失败：${err.length > SESSION_ERROR_TEXT_MAX ? `${err.slice(0, SESSION_ERROR_TEXT_MAX)}…` : err}`;
  providerErrorToastVisible.value = true;
  if (providerErrorToastTimer) clearTimeout(providerErrorToastTimer);
  providerErrorToastTimer = setTimeout(() => { providerErrorToastVisible.value = false; }, SESSION_ERROR_TOAST_MS);
});

onMounted(async () => {
  document.addEventListener('dragover', suppressDragNavigation);
  document.addEventListener('drop', suppressDragNavigation);
  // 根因修复：chat:event 监听在 App.vue 全局注册，生命周期与 app 等长。
  // ChatPage 卸载（路由跳转到配置页/会话管理页）不影响监听，后台执行的会话事件不丢失。
  // R9（round-001）：startListening 只依赖 window.claudeLink.onChatEvent（无 config 依赖），
  // 上移到 loadConfig 之前——首载「先订阅后拉快照」（P5 恢复接线/SA-3 竞态协议）从「统计性
  // 保证」变为确定性保证：任何后续快照/概览拉取发生时 CHAT_EVENT 订阅必已就绪。
  startListening();
  await configStore.loadConfig();
  const root = document.documentElement;
  const palette = THEME_PALETTES.find((p) => p.id === configStore.config.themePaletteId);
  if (palette) applyThemePalette(palette, root);
  // 字体大小：根据 config.fontScale 动态设置 --font-size-base，所有 rem 单位随此缩放。
  applyFontScale(configStore.config.fontScale, FONT_SCALE_SIZES, root);
  // bindContextUpdates 也在全局注册，避免 ChatPage 卸载后 context:update 监听丢失。
  sessionStore.bindContextUpdates();
  // 更新状态全局单订阅（R2-R5）：update-store 是渲染层唯一 onUpdateStateChanged 订阅者，
  // 侧栏徽标 / 关于 tab / UpdateDialog 都消费它；本行只在挂载时执行一次（幂等）。
  updateStore.init();
  // 导出进度监听也在全局注册一次：切换路由/会话不影响进行中的导出 job。
  stopExportProgress = window.claudeLink.onImageExportProgress((p) => exportImageStore.applyProgress(p));
  // T5 导出目标协商：主进程请求选择保存目标 → FilePickerDialog（全局单订阅者，切路由不丢）。
  stopExportTargetRequest = window.claudeLink.onExportTargetRequested((req) => { void exportImageStore.handleExportTargetRequest(req); });
  // 原生 Slash Commands：命令变化全局订阅（ChatPage 卸载/后台会话不丢事件）。主进程 COMMANDS_CHANGED
  // 推送的 snapshot 按 sessionId 全量替换进 command-store。
  stopCommandChanges = window.claudeLink.onCommandChanged((payload) => commandStore.replaceFromEvent(payload));
  // D4：全局兜底快照热刷新广播——暂态会话覆盖 / 空命令已物化会话回填（当前活跃会话作为消费上下文传入，
  // 避免 command-store ↔ session-store 的 store 间依赖；skillOverrides 亦由调用方传入，避免
  // command-store ↔ config-store 依赖）。不经 isSessionActive 守卫，暂态也能收到。
  // Skill 管理：globalSnapshot 存引擎全局探测的未过滤快照，供配置页「Skill 管理」页消费。
  stopGlobalCommandChanges = window.claudeLink.onGlobalCommandsChanged((payload) => {
    commandStore.globalSnapshot = payload.snapshot;
    commandStore.applyGlobalFallback(payload.snapshot, sessionStore.activeSession, configStore.config.skillOverrides);
  });
  // 冷启动补拉（2026-09-15）：COMMANDS_GLOBAL_CHANGED 为一次性推送，早于本订阅注册即永久丢失；
  // 订阅就绪后主动拉一次全局兜底快照，覆盖「用户从不进 Skill 页」的全路由场景（暂态会话兜底
  // 快照也尽早到位）。幂等在 ensureGlobalSnapshot 内（ready/empty/stale 定态快照直接返回，loading/degraded/error 放行重拉，广播已到则 no-op）。
  void commandStore.ensureGlobalSnapshot();
  // 队列事件全局注册（与 chat:event 同模式）：TaskQueuePanel 在非 chat 路由卸载后，
  // markRunning / markStopped（中断收口）/ user_message_created（队列任务消息入列）等
  // 带副作用的队列事件仍须被处理——后台队列执行不因切页丢事件。
  stopQueueEvents = window.claudeLink.onQueueEvent((payload) => taskStore.handleQueueEvent(payload));
  // A3（D01-F2/D12-F4）：桥接运行期自动建会话信号全局注册——store 内 500ms 去抖重拉列表，
  // 新桥接会话 ≤1s 进侧栏；完成通知点击在列表刷新后可命中会话。
  stopBridgeSessionsUpserted = window.claudeLink.onBridgeSessionsUpserted((payload) => {
    sessionStore.markBridgeSessionUpserted(payload.sessionId);
  });
  // 「网页访问」P2 4a / P4（docs/plans/2026-10-20-web-access-plan.md §3-P4-4）：跨端会话列表
  // 同步通用信号（SESSIONS_CHANGED）全局订阅——桌面与网页渲染层同代码同生效。store 内 500ms
  // 独立去抖重拉列表；delete 命中当前活动会话先本地切回暂态（主进程已删，不再调删除 API）。
  stopSessionsChanged = window.claudeLink.onSessionsChanged((payload) => {
    sessionStore.handleSessionsChanged(payload);
  });
  // P2 目录历史跨端同步（2026-10-24 web-sync 计划 §2.2）：WORKSPACES_CHANGED 信号全局订阅——
  // 桌面/网页任一端增删最近目录后收到信号重拉 listRecentWorkspaces（幂等读，无载荷竞态）。
  stopWorkspacesChanged = window.claudeLink.onWorkspacesChanged(() => {
    void sessionStore.loadRecentWorkspaces();
  });
});

onBeforeUnmount(() => {
  document.removeEventListener('dragover', suppressDragNavigation);
  document.removeEventListener('drop', suppressDragNavigation);
  stopListening();
  if (stopExportProgress) stopExportProgress();
  if (stopExportTargetRequest) stopExportTargetRequest();
  if (stopCommandChanges) stopCommandChanges();
  if (stopGlobalCommandChanges) stopGlobalCommandChanges();
  if (stopQueueEvents) stopQueueEvents();
  if (stopBridgeSessionsUpserted) stopBridgeSessionsUpserted();
  if (stopSessionsChanged) stopSessionsChanged();
  if (stopWorkspacesChanged) stopWorkspacesChanged();
  if (saveFailedToastTimer) clearTimeout(saveFailedToastTimer);
  if (sessionErrorToastTimer) clearTimeout(sessionErrorToastTimer);
  if (providerErrorToastTimer) clearTimeout(providerErrorToastTimer);
});
</script>

<template>
  <AppLayout>
    <div v-if="showRevWarn" class="web-rev-warn" role="status">
      <span class="web-rev-warn__text">⚠ 网页版渲染产物（rev {{ welcomedRev }}）与主进程（rev {{ BUILD_REV }}）不一致——开发模式请重新 <code>npm run build</code>；正式使用请更新应用</span>
      <button class="web-rev-warn__close" type="button" aria-label="关闭提示" @click="dismissRevWarn">✕</button>
    </div>
    <router-view />
    <InteractionPrompt />
    <ImageLightbox />
    <DiffDialog />
    <ToolDiffDialog />
    <UpdateDialog />
    <FilePickerDialog />
    <div v-if="saveFailedToastVisible" class="global-toast global-toast--error">设置保存失败，部分修改可能未保存</div>
    <div v-if="sessionErrorToastVisible" class="global-toast global-toast--error global-toast--stacked">{{ sessionErrorToastText }}</div>
    <div v-if="providerErrorToastVisible" class="global-toast global-toast--error global-toast--stacked-3">{{ providerErrorToastText }}</div>
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

/* A4：会话错误 toast 与保存失败 toast 同屏时纵向错开，避免重叠（双失败同瞬的边角）。 */
.global-toast--stacked {
  top: 3.5rem;
}

/* X15：供应商库错误 toast 再错开一档（三失败同瞬的边角；复用同一 toast 样式本体）。 */
.global-toast--stacked-3 {
  top: 6rem;
}

/* B：网页版产物滞后诊断横条（web 独占；不阻塞任何操作） */
.web-rev-warn {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 6px 0 4px;
  padding: 6px 10px;
  border: 1px solid var(--color-warn-strong);
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--color-warn) 12%, var(--color-panel));
  color: var(--color-text);
  font-size: 12px;
  line-height: 1.5;
}
.web-rev-warn__text { flex: 1; min-width: 0; }
.web-rev-warn code { font-family: var(--font-mono); font-size: 11.5px; }
.web-rev-warn__close {
  flex: 0 0 auto;
  border: 0;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 12px;
  padding: 2px 4px;
  border-radius: var(--radius-sm);
}
.web-rev-warn__close:hover { color: var(--color-text); background: color-mix(in srgb, var(--color-text) 8%, transparent); }
</style>
