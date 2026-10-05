// use-esc-stack.ts
// A9（D06-F1 + D14-F5）：全局 ESC 层级裁决注册表——一次 Esc 只作用于视觉最上层的遮罩。
//
// 各全屏遮罩（灯箱/更新弹窗/导出格式/两个 Diff 弹窗/交互弹窗）在「打开态」注册一层
//（pushEscLayer(priority)），关闭/卸载时释放（release 幂等，异常卸载由 onUnmounted 兜底）；
// 带 Esc 分支的 window keydown handler 据 isTopmost()（无更高优先级层在场）决定是否响应。
// priority 与各遮罩真实 z-index 同表（ESC_LAYER_PRIORITY）——裁决顺序恒等于视觉遮挡顺序，
// 与打开先后无关（灯箱后开、权限弹窗先开时灯箱仍在上）。
//
// 边界：只改「何时响应」，不改「响应后语义」——interaction-cancel 纯函数与 reason 映射
// 零改动；栈内无更高层时各 handler 行为与现状完全一致。同优先级互不遮蔽（DiffDialog/
// ToolDiffDialog/InteractionPrompt 同为 1200，并存时行为与现状相同）。

export interface EscLayerHandle {
  /** 是否允许响应 Esc：本层之上无更高优先级遮罩在场。 */
  isTopmost(): boolean;
  /** 释放本层（关闭/卸载时调用），幂等。 */
  release(): void;
}

const escLayers = new Map<symbol, number>();

/** 各遮罩 Esc 优先级 = 其真实 z-index（单源对齐视觉遮挡顺序）。 */
export const ESC_LAYER_PRIORITY = {
  updateDialog: 1100,
  interaction: 1200,
  diffDialog: 1200,
  toolDiffDialog: 1200,
  exportFormat: 9000,
  imageLightbox: 9999,
} as const;

/** 打开态遮罩注册一层，返回句柄供 Esc handler 询问栈顶与卸载清理。 */
export function pushEscLayer(priority: number): EscLayerHandle {
  const key = Symbol('esc-layer');
  escLayers.set(key, priority);
  let released = false;
  return {
    isTopmost(): boolean {
      const mine = escLayers.get(key);
      if (mine === undefined) return false;
      for (const p of escLayers.values()) {
        if (p > mine) return false;
      }
      return true;
    },
    release(): void {
      if (released) return;
      released = true;
      escLayers.delete(key);
    },
  };
}

/** 测试/调试只读视图：当前注册层数。 */
export function escLayerCount(): number {
  return escLayers.size;
}
