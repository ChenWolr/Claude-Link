// follow-scroll.ts — 内滚动窗口「贴底跟随」状态机（纯逻辑：无 Vue、无 DOM API，
// 只依赖 ScrollBox 形状，便于 tdd 脚本在 node 里用普通对象模拟）。
// 供 ThinkingBlock 展开态使用：流式生成时窗口 tail -f 式贴底；用户上滚超过阈值即
// 暂停跟随（绝不拽人）并浮出「回到最新」；滚回底部或点浮标恢复。完成后（live=false）
// 是纯阅读态，不再自动滚动、不显示浮标。

export interface ScrollBox {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/** 距底小于该值视为「贴底」：容忍亚像素与最后半行 */
export const FOLLOW_THRESHOLD_PX = 32;

export function distanceFromBottom(box: ScrollBox): number {
  // 隐藏元素（display:none，v-show 收起）三个值全 0，钳到 0 保证 stick 不被负值干扰
  return Math.max(0, box.scrollHeight - box.scrollTop - box.clientHeight);
}

export interface FollowController {
  readonly live: boolean;
  readonly stick: boolean;
  /** 用户滚动后调用（scroll 事件）：按当前距底同步 stick */
  onUserScroll(): void;
  /** 内容追加渲染后调用：贴底则滚到底跟随；用户上滚中则原地不动 */
  onContentGrown(): void;
  /** 流式开始/结束切换；进入 live 时 stick 重置为 true（首段追加即跟随） */
  setLive(live: boolean): void;
  /** 「回到最新」点击：强制贴底并恢复跟随 */
  jumpToLatest(): void;
  /** 浮标可见性：仅流式期间且用户已离开底部 */
  pillVisible(): boolean;
}

export function createFollowController(box: ScrollBox, threshold: number = FOLLOW_THRESHOLD_PX): FollowController {
  const state = { live: false, stick: true };
  function refresh(): void {
    state.stick = distanceFromBottom(box) < threshold;
  }
  return {
    get live() { return state.live; },
    get stick() { return state.stick; },
    onUserScroll: refresh,
    onContentGrown() {
      if (!state.live) return;
      if (state.stick) box.scrollTop = box.scrollHeight; // 写入触发 scroll → onUserScroll 自洽
      refresh();
    },
    setLive(live: boolean) {
      state.live = live;
      if (live) state.stick = true;
    },
    jumpToLatest() {
      state.stick = true;
      box.scrollTop = box.scrollHeight;
      refresh();
    },
    pillVisible() {
      return state.live && !state.stick;
    },
  };
}
