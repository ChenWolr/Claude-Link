// use-now.ts
// 一个会在「激活期间」每 100ms 跳动的 now ref，供实时计时器（回复耗时 / 子 Agent 耗时）使用。
//
// 设计：传入 active() 判定函数。active 为真时启动 setInterval(100ms) 持续更新 now；
// 失活时停止，保留最后一次值。组件卸载时清理，杜绝泄漏。
// 这样计时器只在真正需要（发送中）时跳动，避免空闲时无谓的重渲染。

import { onUnmounted, ref, watch, type Ref } from 'vue';

export function useNow(active: () => boolean): { now: Ref<number> } {
  const now = ref(Date.now());
  let timer: ReturnType<typeof setInterval> | null = null;

  function start(): void {
    now.value = Date.now();
    if (timer) return;
    timer = setInterval(() => {
      now.value = Date.now();
    }, 100);
  }

  function stop(): void {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  watch(active, (on) => {
    if (on) start();
    else stop();
  }, { immediate: true });

  onUnmounted(stop);

  return { now };
}
