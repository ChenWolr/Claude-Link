// use-hold-action.ts
// 长按动作 composable（问题⑥）：按住 durationMs（默认 1000ms）后触发一次 onComplete，
// holdProgress 0–100 供按钮内横向填充/进度环消费。形态抽取自 ContextButton 长按压缩实现。
//
// 指针语义（P2-20 同款）：pointerdown 由调用方 .prevent 吃掉原生 click（单击不再触发按钮
// 默认行为）；setPointerCapture 失败（旧环境）静默降级——捕获期间 pointerleave 被抑制，
// 滑出取消由 move/up 的坐标判定显式实现，pointerleave/pointercancel 兜底取消。
// 键盘语义：Space/Enter 且 !repeat 按下启动（preventDefault 防页面滚动与按钮原生激活），
// 松开未满即取消。
// 失焦语义（清零轮 A 项补全，两条路径均已覆盖）：①键盘长按中焦点被同窗口内其他元素夺走
// = 按钮 blur（@blur → onBlur）；②指针/键盘长按中整个窗口失焦（Alt+Tab 等）= window blur
// 监听（setup 时挂、卸载时成对移除）——@pointerdown.prevent 下按钮不持焦，窗口失焦时元素
// blur 不会派发，该路径必须走 window 级监听。两路统一 resetHold 取消（幂等）。
// 生命周期：进度满 onComplete 后停留 150ms 再复位（用户看清打满）；期间继续按住不重复
// 触发（rAF 已停摆）；onBeforeUnmount 清理 rAF/定时器 + 移除 window blur 监听防残留。
import { getCurrentInstance, onBeforeUnmount, ref } from 'vue';

export interface UseHoldActionOptions {
  durationMs?: number;
}

export function useHoldAction(onComplete: () => void, options: UseHoldActionOptions = {}) {
  const durationMs = options.durationMs ?? 1000;
  const holding = ref(false);
  const holdProgress = ref(0); // 0–100
  let holdStart = 0;
  let holdRaf = 0;
  let doneTimer: ReturnType<typeof setTimeout> | null = null;

  function resetHold(): void {
    if (holdRaf) { cancelAnimationFrame(holdRaf); holdRaf = 0; }
    if (doneTimer) { clearTimeout(doneTimer); doneTimer = null; }
    holding.value = false;
    holdProgress.value = 0;
  }

  function beginHold(): void {
    if (holding.value) return;
    holding.value = true;
    holdProgress.value = 0;
    holdStart = performance.now();
    const tick = () => {
      const p = Math.min(100, ((performance.now() - holdStart) / durationMs) * 100);
      holdProgress.value = p;
      if (p >= 100) {
        holdProgress.value = 100;
        holdRaf = 0;
        onComplete();
        if (doneTimer) clearTimeout(doneTimer);
        doneTimer = setTimeout(resetHold, 150);
        return;
      }
      holdRaf = requestAnimationFrame(tick);
    };
    holdRaf = requestAnimationFrame(tick);
  }

  // 捕获期间 pointerleave 不派发：滑出判定只能靠坐标（clientX/Y 与 rect 比对）。
  function isPointerOutside(e: PointerEvent): boolean {
    const el = e.currentTarget as HTMLElement | null;
    if (!el) return false;
    const rect = el.getBoundingClientRect();
    return e.clientX < rect.left || e.clientX > rect.right
      || e.clientY < rect.top || e.clientY > rect.bottom;
  }

  function onPointerDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    // 捕获指针使 pointerup/pointermove 在指针滑出后仍派发到本元素（失败静默降级）。
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* no-op */
    }
    beginHold();
  }

  function onPointerMove(e: PointerEvent): void {
    if (!holding.value) return;
    if (isPointerOutside(e)) resetHold();
  }

  function onPointerUp(e: PointerEvent): void {
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 捕获已隐式释放/未捕获 */
    }
    // 未满即松开 → 取消无动作（onComplete 只由进度满路径触发一次）。
    resetHold();
  }

  function onPointerLeave(): void {
    resetHold();
  }

  function onPointerCancel(): void {
    resetHold();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.repeat) return;
    if (e.key !== ' ' && e.key !== 'Enter') return;
    e.preventDefault();
    beginHold();
  }

  function onKeyup(e: KeyboardEvent): void {
    if (e.key !== ' ' && e.key !== 'Enter') return;
    resetHold();
  }

  // 焦点失焦（blur，清零轮 A 项改写）：按钮级 @blur 覆盖「键盘长按中焦点被同窗口内其他元素
  // 夺走」（keyup 不会回到本按钮，满时长会误触发）；「整个窗口失焦」路径由 setup 时挂的
  // window blur 监听覆盖（见下方注册处——@pointerdown.prevent 下按钮本不持焦，窗口失焦时
  // 元素 blur 不派发，必须走 window 级监听）。两路统一 resetHold 取消（幂等：未持有时
  // no-op，重复 blur 不产生重复回调）。
  function onBlur(): void {
    resetHold();
  }

  // getCurrentInstance 守卫：允许在组件外（纯函数测试）安全使用，组件内才挂卸载清理。
  // 窗口失焦补全（清零轮 A 项）：setup 即挂 window blur 监听——resetHold 幂等，非持有期
  // 触发是 no-op，常驻监听无副作用；卸载时成对移除 + 复位。typeof window 守卫：node 契约
  // 测试/SSR 环境无 window 时不注册不报错。
  if (typeof window !== 'undefined') {
    window.addEventListener('blur', resetHold);
  }
  if (getCurrentInstance()) {
    onBeforeUnmount(() => {
      if (typeof window !== 'undefined') window.removeEventListener('blur', resetHold);
      resetHold();
    });
  }

  return {
    holding,
    holdProgress,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerLeave,
    onPointerCancel,
    onKeydown,
    onKeyup,
    onBlur,
    resetHold,
  };
}
