// dialog-shell-geometry.ts
// 弹窗壳纯几何函数（计划 2026-10-14 §2 P4）：居中 / 视口全钳 / 拖动平移 / 8 向缩放。
//
// 零依赖约束：本文件**不得 import vue**（契约脚本 scripts/tdd-dialog-shell-geometry.ts 以 tsx 直测，
// 且 E 组静态断言禁止出现 vue 导入语句）。
// 消费方：use-dialog-shell.ts（DOM 接线）与 P9 DiffDialog/ToolDiffDialog（直接复用 dragRect/resizeRect）。
//
// 统一不变式：所有产出 rect 完整落在视口内（left ≥ pad、top ≥ pad、right ≤ vw-pad、bottom ≤ vh-pad）
// ——标题栏必须可点回，不允许部分出视口（「明确不做」之外的硬保证）。

export interface DialogRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface RectConstraints {
  minW: number;
  minH: number;
  /** 视口内边距，默认 8 */
  pad?: number;
}

export type ResizeDir = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/** 视口可用外包络：宽 ≤ vw-2pad、高 ≤ vh-2pad（视口比 min+2pad 还小时让位给视口，保证完整可见） */
function fitBounds(vw: number, vh: number, c: RectConstraints): { pad: number; maxW: number; maxH: number } {
  const pad = c.pad ?? 8;
  return { pad, maxW: vw - 2 * pad, maxH: vh - 2 * pad };
}

/**
 * 1. 视口全钳：宽高先抬到 minW/minH、再压进视口（vw-2pad / vh-2pad）；
 *    left/top 全钳到 [pad, vw-width-pad]，弹窗任何时刻完整可见（标题栏可点回）。
 */
export function clampRectToViewport(
  rect: DialogRect,
  vw: number,
  vh: number,
  c: RectConstraints,
): DialogRect {
  const { pad, maxW, maxH } = fitBounds(vw, vh, c);
  const width = Math.min(Math.max(rect.width, c.minW), maxW);
  const height = Math.min(Math.max(rect.height, c.minH), maxH);
  return {
    left: clamp(rect.left, pad, vw - width - pad),
    top: clamp(rect.top, pad, vh - height - pad),
    width,
    height,
  };
}

/**
 * 2. 居中 + 视口钳制（pad 默认 24）。内部以 minW/minH=0 只做视口钳制；
 *    调用方（useDialogShell）随后会用真实约束再过一遍 clampRectToViewport。
 */
export function centerRect(naturalW: number, naturalH: number, vw: number, vh: number, pad = 24): DialogRect {
  return clampRectToViewport(
    {
      left: (vw - naturalW) / 2,
      top: (vh - naturalH) / 2,
      width: naturalW,
      height: naturalH,
    },
    vw,
    vh,
    { minW: 0, minH: 0, pad },
  );
}

/**
 * 3. 拖动：平移 (dx, dy) 后整体走 clampRectToViewport——拖出边界即钳回，永不部分出视口。
 */
export function dragRect(
  rect: DialogRect,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
  c: RectConstraints,
): DialogRect {
  return clampRectToViewport(
    { ...rect, left: rect.left + dx, top: rect.top + dy },
    vw,
    vh,
    c,
  );
}

/**
 * 4. 8 向缩放：
 *    - e/s 向：宽/高按 [min, 视口上限] 钳制（e 上限 = vw-pad-left、s 上限 = vh-pad-top）；
 *    - n/w 向：宽/高 = 固定对侧边 - 新边长，先钳制再反推 left/top——因此钳制触底时
 *      left/top 自然锚定不再移动（如 w 收缩到 minW 后 left 不再右移）；
 *      n/w 放大触视口边界同理锚定（把手顶到边界即停，不把对侧推走）；
 *    - 末尾再过一遍 clampRectToViewport 兜底：仅在 rect 无法放入视口的退化输入下生效，
 *      正常路径为恒等变换，不破坏上述锚定语义。
 */
export function resizeRect(
  rect: DialogRect,
  dir: ResizeDir,
  dx: number,
  dy: number,
  vw: number,
  vh: number,
  c: RectConstraints,
): DialogRect {
  const { pad } = fitBounds(vw, vh, c);
  let { left, top, width, height } = rect;

  // 水平轴（含 e 或 w）
  if (dir.includes('e')) {
    // 右边移动：left 固定，上限 = 视口右边界
    width = clamp(rect.width + dx, c.minW, vw - pad - rect.left);
  } else if (dir.includes('w')) {
    // 左边移动：right 固定，上限 = 视口左边界
    width = clamp(rect.width - dx, c.minW, rect.left + rect.width - pad);
    left = rect.left + rect.width - width; // 反向补偿；width 触底后本式不再变化 → left 锚定
  }

  // 垂直轴（含 n 或 s）
  if (dir.includes('n')) {
    height = clamp(rect.height - dy, c.minH, rect.top + rect.height - pad);
    top = rect.top + rect.height - height; // 同上，触底后 top 锚定
  } else if (dir.includes('s')) {
    height = clamp(rect.height + dy, c.minH, vh - pad - rect.top);
  }

  return clampRectToViewport({ left, top, width, height }, vw, vh, c);
}
