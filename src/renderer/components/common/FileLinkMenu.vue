<script setup lang="ts">
// FileLinkMenu.vue（P6-B，2026-11-21 translate-fix-and-ui-points 计划）
// .md-file-link 右键上下文菜单全局单例载体：App.vue 与 FilePreviewDrawer 并列挂载，七处委托组件
// （MessageBubble / ToolCallBlock / ThinkingBlock / StreamRenderer / TranslationViewport /
// TaskQueuePanel / FilePreviewDrawer）经 useFileLinkMenuStore().open(path, clientX, clientY) 弹出。
// 行为契约（00 唯一事实源）：菜单项自上而下恰 5 项（预览 / 用系统默认程序打开 / 选择打开方式… /
// 在文件夹中显示 / 复制路径）；fs:stat 预检存在性——exists=false → 前四项禁用 + 顶部「文件不存在」
// 提示行，复制路径恒可用；Esc / 菜单外点 / 滚动(capture) / resize 关闭（不悬浮滞留；滚动路径
// 带打开后 200ms 宽限窗——用户裁决 2026-11-22，见 onWinScroll / SCROLL_GRACE_MS）。
// 合并裁决 R2：菜单项全平台渲染，无渲染层平台分支——非 Windows 的「选择打开方式…」由主进程
// changes-panel.openChooseDialog 既有响应承担（message 进 notice 行）；渲染层无 process/platform
// 可用面（网页版映射检查单第 3/4 问）。
// 层级：Teleport body + fixed + z-index 2000（低于 global-toast 3000、高于一切内容层；对齐
// InteractionPrompt / ToolDiffDialog 的 Teleport 先例）。菜单是瞬时小浮层，不接入 use-esc-stack
// ——Esc 经 window keydown 打开时挂 / 关闭时卸（对齐 ToolCallBlock filemenu 先例）。
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { storeToRefs } from 'pinia';
import { useFileLinkMenuStore } from '../../stores/file-link-menu-store';

const store = useFileLinkMenuStore();
const { visible, x, y, exists, notice } = storeToRefs(store);

const menuEl = ref<HTMLElement | null>(null);
// 定位（左上角 px）：open 传入的 clientX/clientY 经视口边缘 clamp——渲染后按 offsetWidth/Height
// 实测修正一次（初帧菜单未测量按 0 估算，nextTick 收敛），防右键屏幕右/下缘时菜单溢出屏；
// 极窄视口下 max(0,·) 兜底防负坐标。
const pos = ref({ left: 0, top: 0 });

function clampPos(): void {
  const w = menuEl.value?.offsetWidth ?? 0;
  const h = menuEl.value?.offsetHeight ?? 0;
  pos.value = {
    left: Math.max(0, Math.min(x.value, window.innerWidth - 16 - w)),
    top: Math.max(0, Math.min(y.value, window.innerHeight - 16 - h)),
  };
}

// 提示行文本：store.notice（文件不存在 / 动作失败 message / 已复制）为主；
// exists=false 而 notice 未落位的瞬时窗兜底「文件不存在」（与 store 同文案，防空白提示区）。
const noticeText = computed(() => notice.value || (exists.value === false ? '文件不存在' : ''));

// ── 关闭机制（打开时挂 / 关闭时卸；close 幂等，双触发无害）──
// 用户裁决 2026-11-22（round-001 f4）：scroll 关闭路径加打开后 200ms 宽限窗——菜单弹出瞬间恰好
// MessageList 自动滚底（rAF/ResizeObserver 两路径）会经 capture scroll 立刻把菜单关掉（CDP A4-1
// 偶发红）。宽限只作用于 scroll 关闭路径；resize / pointerdown / Esc 三条路径不加宽限（原语义）。
const SCROLL_GRACE_MS = 200;
// 菜单本次打开时刻（performance.now() 单调口径；组件内无既有计时口径，取单调时钟防系统时间回拨
// 误判）：watch 打开分支刷新（含已打开重开=新窗）、关闭分支置 0 复位（见下方 watch）。
let openedAt = 0;
function onDocPointerDown(e: PointerEvent): void {
  // 菜单内 pointerdown（点击菜单项）不关——由动作自身决定关/留（对齐 ToolCallBlock.onFileMenuDocDown）。
  if ((e.target as Element | null)?.closest?.('.file-link-menu')) return;
  store.close();
}
function onWinKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') store.close();
}
function onWinScroll(): void {
  // 宽限窗（用户裁决 2026-11-22：打开后 200ms 内的自动滚底不关菜单——消除与 MessageList 自动
  // 滚底的竞态）：SCROLL_GRACE_MS 内提前 return；超宽限后的滚动仍立即关闭（契约措辞不变）。
  if (performance.now() - openedAt < SCROLL_GRACE_MS) return;
  store.close();
}
function onWinResize(): void {
  store.close();
}
function detach(): void {
  document.removeEventListener('pointerdown', onDocPointerDown);
  window.removeEventListener('keydown', onWinKeydown);
  window.removeEventListener('scroll', onWinScroll, true);
  window.removeEventListener('resize', onWinResize);
}
// watch([visible, x, y])（round-001 F-r1-4，2026-11-22）：菜单已 visible 时再 open()（合成事件/
// 键盘 Menu 键路径）只更新 x/y 不触发 visible → 菜单滞留旧坐标；纳入 x/y 后重开必重算 clamp。
// 重复 addEventListener 同函数引用+同 capture 幂等去重，重挂无副作用；visible=false 分支逻辑不变。
watch([visible, x, y], ([v]) => {
  if (v) {
    openedAt = performance.now(); // 宽限窗起点：每次打开刷新（含已打开重开——重开即新窗）
    clampPos(); // 初帧估算定位
    void nextTick(clampPos); // 渲染后按实测尺寸修正一次
    document.addEventListener('pointerdown', onDocPointerDown);
    window.addEventListener('keydown', onWinKeydown);
    // capture 覆盖内层滚动容器（scroll 不冒泡，capture 窗口级监听全部滚动目标）；passive 只读。
    window.addEventListener('scroll', onWinScroll, { capture: true, passive: true });
    window.addEventListener('resize', onWinResize);
  } else {
    openedAt = 0; // 关闭复位宽限窗
    detach();
  }
});
onBeforeUnmount(detach);
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      ref="menuEl"
      class="file-link-menu"
      role="menu"
      aria-label="文件操作菜单"
      :style="{ left: `${pos.left}px`, top: `${pos.top}px` }"
      @contextmenu.prevent
    >
      <div v-if="noticeText" class="flink-menu__notice" role="status">{{ noticeText }}</div>
      <button type="button" role="menuitem" class="flink-menu__item" :disabled="exists === false" @click="store.preview()">预览</button>
      <button type="button" role="menuitem" class="flink-menu__item" :disabled="exists === false" @click="store.openDefault()">用系统默认程序打开</button>
      <button type="button" role="menuitem" class="flink-menu__item" :disabled="exists === false" @click="store.openChoose()">选择打开方式…</button>
      <button type="button" role="menuitem" class="flink-menu__item" :disabled="exists === false" @click="store.showInExplorer()">在文件夹中显示</button>
      <button type="button" role="menuitem" class="flink-menu__item" @click="store.copyPath()">复制路径</button>
    </div>
  </Teleport>
</template>

<style scoped>
/* 菜单本体：fixed 浮层（坐标由 store 经 clamp 计算内联下发），视觉对齐 ToolCallBlock
   .tool-row__filemenu（panel 底 + border-strong + radius-md + elevation-2 下拉语言）。 */
.file-link-menu {
  position: fixed;
  z-index: 2000; /* 低于 global-toast 3000、高于一切内容层 */
  display: flex;
  flex-direction: column;
  min-width: 11rem;
  padding: 4px;
  gap: 2px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-panel);
  box-shadow: var(--elevation-2);
}

/* 提示行（role="status"）：文件不存在 / 动作失败 message / 已复制反馈；warn 语义色弱底。 */
.flink-menu__notice {
  padding: 4px 10px;
  font-size: 0.75rem;
  line-height: 1.4;
  color: var(--color-warn-strong);
  background: color-mix(in srgb, var(--color-warn) 10%, transparent);
  border-radius: var(--radius-sm);
}

/* 菜单项：对齐 .tool-row__filemenu button（all:unset 重置 + hover accent 混色）。 */
.flink-menu__item {
  all: unset;
  cursor: pointer;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  color: var(--color-text);
}
.flink-menu__item:hover {
  background: color-mix(in srgb, var(--color-accent) 12%, transparent);
  color: var(--color-accent-strong);
}
/* 禁用态（exists=false 的 1-4 项）：去 hover 反馈、降透明度、禁指针。 */
.flink-menu__item:disabled {
  cursor: default;
  opacity: 0.45;
  pointer-events: none;
}
</style>
