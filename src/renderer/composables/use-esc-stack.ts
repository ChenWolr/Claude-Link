// use-esc-stack.ts
// A9（D06-F1 + D14-F5）：全局 ESC 层级裁决注册表——一次 Esc 只作用于视觉最上层的遮罩。
//
// 各全屏遮罩（灯箱/更新弹窗/导出格式/文件选择/两个 Diff 弹窗/交互弹窗）在「打开态」注册一层
//（pushEscLayer(priority)），关闭/卸载时释放（release 幂等，异常卸载由 onUnmounted 兜底）；
// 带 Esc 分支的 window keydown handler 据 isTopmost()（无更高优先级层在场）决定是否响应。
// priority 与各遮罩真实 z-index 同表（ESC_LAYER_PRIORITY；例外：mcpDialog 1199 与 .mcp-mask
// CSS 1200 解耦，见常量表内注释）——裁决顺序恒等于视觉遮挡顺序，与打开先后无关（灯箱后开、
// 权限弹窗先开时灯箱仍在上）。
//
// 边界：只改「何时响应」，不改「响应后语义」——interaction-cancel 纯函数与 reason 映射
// 零改动；栈内无更高层时各 handler 行为与现状完全一致。diff 层 1250 高于交互层 1200
//（X2/R06-F2）：diff 在场时交互弹窗让位——三者都 Teleport 到 body，同 z 下后挂载的
// diff 遮罩恒绘制于交互遮罩之上，Esc/Enter/箭头只作用于视觉最上层的 diff。

export interface EscLayerHandle {
  /** 是否允许响应 Esc：本层之上无更高优先级遮罩在场。 */
  isTopmost(): boolean;
  /** 释放本层（关闭/卸载时调用），幂等。 */
  release(): void;
}

const escLayers = new Map<symbol, number>();

/** 各遮罩 Esc 优先级（除 mcpDialog 外与其真实 z-index 同值；单源对齐视觉遮挡顺序）。 */
export const ESC_LAYER_PRIORITY = {
  updateDialog: 1100,
  interaction: 1200,
  // r3-F7/R6：MCP 设置页弹窗（McpSettings 添加/编辑 + 导入 JSON）——1199 低于 interaction 1200：
  // MCP 弹窗与待决交互弹窗并存时 interaction 严格更高，Esc 只关交互层（消除 1200/1200 同级
  // 各自称顶、一次 Esc 连关两层）；MCP 弹窗单独在场时行为不变（isTopmost 只看有无更高层）；
  // 与 diffDialog 1250 的关系不变（1250 仍更高）。Esc 裁决层级与 CSS z-index 解耦——.mcp-mask
  // 遮罩 CSS z-index 仍为 1200，本表只裁决 Esc 让位、不参与绘制。
  mcpDialog: 1199,
  // X2（R06-F2）：diff 两层提到 1250——高于交互层 1200（同 z 下 diff 遮罩恒盖住交互弹窗），
  // 与两个 diff 组件遮罩 CSS 的 z-index 同步。
  diffDialog: 1250,
  toolDiffDialog: 1250,
  exportFormat: 9000,
  // 原生弹窗统一改造 T2：自绘 FilePickerDialog 蒙层 9100——高于导出格式 9000、低于灯箱 9999。
  // 导出流程中格式弹窗先开（选 JPEG/PNG）、目标选择弹窗后开（选保存位置），两层可同时在场；
  // 后开的目标弹窗视觉在上（z-index 9100），Esc 应先关它；灯箱（查看图片中触发导出）仍最高。
  filePicker: 9100,
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
