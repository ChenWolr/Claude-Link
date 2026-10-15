// use-dialog-shell.ts
// 弹窗壳 DOM 接线 composable（计划 2026-10-14 §2 P4）：拖动 / 8 向缩放 / 视口重钳 / 复位居中。
//
// 分层：几何钳制全部委托 dialog-shell-geometry.ts 纯函数（契约脚本静态断言防两套实现漂移）；
// 本文件只做 DOM 事件接线与状态。
//
// 使用方规范（P5-P9）：
//   const shell = useDialogShell(visible, cardRef, { minW: 560, minH: 360 });
//   const shellStyle = shell.style;            // ComputedRef 须解包为 script 顶层
//   模板：卡片 :style="shellStyle"，标题栏 @pointerdown="shell.beginDrag" @dblclick="shell.resetToCenter"，
//         卡片尾 <DialogResizeHandles :binder="shell" />。
//
// 不做位置持久化（计划「明确不做」）：visible false→true 边沿重置为居中。

import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  watch,
  type ComputedRef,
  type Ref,
} from 'vue';
import {
  centerRect,
  clampRectToViewport,
  dragRect,
  resizeRect,
  type DialogRect,
  type RectConstraints,
  type ResizeDir,
} from './dialog-shell-geometry';

export interface UseDialogShellOptions {
  minW: number;
  minH: number;
  /** 缺省 → 打开时测量卡片自然尺寸（offsetWidth/offsetHeight 布局尺寸） */
  initialSize?: { width?: number; height?: number };
}

/** 手柄组件的最小接入接口（duck-typed：useDialogShell 返回值天然满足；ToolDiffDialog 自管 rect 也实现它） */
export interface ResizeHandleBinder {
  beginResize(dir: ResizeDir, e: PointerEvent): void;
}

export interface DialogShell {
  rect: Ref<DialogRect | null>;
  /** rect null → {}（未测量，卡片回退 CSS 静态定位）；非空 → { left, top, width, height } px 字符串 */
  style: ComputedRef<Record<string, string>>;
  beginDrag(e: PointerEvent): void;
  beginResize(dir: ResizeDir, e: PointerEvent): void;
  /** 按当前 width/height 重居中（双击标题栏复位） */
  resetToCenter(): void;
}

// 拖动豁免：目标落在这些元素/类内不启动拖动（关闭按钮、输入框等照常可点）
const DRAG_IGNORE_SELECTOR = 'button, input, select, textarea, a, [contenteditable], .dlg-no-drag';
const RESIZE_DEBOUNCE_MS = 80;
const BUSY_CLASS = 'dlg-shell-busy';
/** rect 未测量帧的空 style（卡片回退 CSS 静态定位）——显式类型化避免 {} 联合推断不兼容 */
const EMPTY_STYLE: Record<string, string> = {};

export function useDialogShell(
  visible: Ref<boolean>,
  cardRef: Ref<HTMLElement | null>,
  opts: UseDialogShellOptions,
): DialogShell {
  const rect = ref<DialogRect | null>(null);

  const constraints = (): RectConstraints => ({ minW: opts.minW, minH: opts.minH, pad: 8 });

  const style = computed<Record<string, string>>(() => {
    const r = rect.value;
    if (!r) return EMPTY_STYLE;
    return {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
    };
  });

  // ── 打开/关闭：测量 → 居中 → 钳制；关闭置 null（重开重置） ──
  watch(visible, async (v) => {
    if (!v) {
      rect.value = null;
      return;
    }
    await nextTick();
    let w = opts.initialSize?.width ?? 0;
    let h = opts.initialSize?.height ?? 0;
    if (!w || !h) {
      const el = cardRef.value;
      if (el) {
        // 布局尺寸（offsetWidth/offsetHeight）不含 transform——带 scale 的进场动画 from 帧
        //（如 mcp-modal-in scale(0.98)）不再污染自然尺寸测量。
        if (!w) w = el.offsetWidth;
        if (!h) h = el.offsetHeight;
      }
    }
    if (w <= 0 || h <= 0) return; // 测量失败保持 rect null——卡片回退 CSS 静态定位
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    rect.value = clampRectToViewport(centerRect(w, h, vw, vh), vw, vh, constraints());
  });

  // ── 拖动/缩放会话：pointermove/up 挂 window（不用 setPointerCapture——跨元素拖动 window 监听更稳） ──
  let session: { kind: 'drag' | 'resize'; dir: ResizeDir; startX: number; startY: number; startRect: DialogRect } | null =
    null;

  function onPointerMove(e: PointerEvent): void {
    if (!session || !rect.value) return;
    const dx = e.clientX - session.startX;
    const dy = e.clientY - session.startY;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const c = constraints();
    rect.value =
      session.kind === 'drag'
        ? dragRect(session.startRect, dx, dy, vw, vh, c)
        : resizeRect(session.startRect, session.dir, dx, dy, vw, vh, c);
  }

  function onPointerUp(): void {
    endSession();
  }

  function startSession(s: NonNullable<typeof session>): void {
    session = s;
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);
    document.body.classList.add(BUSY_CLASS); // classList 幂等：重复 add/remove 无副作用
  }

  function endSession(): void {
    if (!session) return;
    session = null;
    window.removeEventListener('pointermove', onPointerMove);
    window.removeEventListener('pointerup', onPointerUp);
    window.removeEventListener('pointercancel', onPointerUp);
    document.body.classList.remove(BUSY_CLASS);
  }

  function beginDrag(e: PointerEvent): void {
    if (!rect.value) return; // 未测量帧（回退 CSS 定位态）不允许拖
    if (e.button !== 0) return; // 仅主键拖动
    const target = e.target as Element | null;
    if (target && target.closest(DRAG_IGNORE_SELECTOR)) return;
    e.preventDefault();
    startSession({ kind: 'drag', dir: 'se', startX: e.clientX, startY: e.clientY, startRect: { ...rect.value } });
  }

  function beginResize(dir: ResizeDir, e: PointerEvent): void {
    if (!rect.value) return;
    if (e.button !== 0) return;
    e.preventDefault();
    startSession({ kind: 'resize', dir, startX: e.clientX, startY: e.clientY, startRect: { ...rect.value } });
  }

  function resetToCenter(): void {
    const r = rect.value;
    if (!r) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    rect.value = clampRectToViewport(centerRect(r.width, r.height, vw, vh), vw, vh, constraints());
  }

  // ── 窗口 resize：80ms 防抖重钳（DiffDialog 先例） ──
  let resizeTimer: ReturnType<typeof setTimeout> | null = null;
  function onWindowResize(): void {
    if (resizeTimer !== null) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      resizeTimer = null;
      if (!rect.value) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      rect.value = clampRectToViewport(rect.value, vw, vh, constraints());
    }, RESIZE_DEBOUNCE_MS);
  }
  window.addEventListener('resize', onWindowResize);

  // ── 卸载兜底：移除 window 监听与 body 类 ──
  onBeforeUnmount(() => {
    endSession();
    if (resizeTimer !== null) {
      clearTimeout(resizeTimer);
      resizeTimer = null;
    }
    window.removeEventListener('resize', onWindowResize);
  });

  return { rect, style, beginDrag, beginResize, resetToCenter };
}
