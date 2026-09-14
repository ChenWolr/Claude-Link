import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';

export function useStream() {
  const store = useSessionStore();
  const displayContent = ref('');
  const displayThinking = ref('');
  const displayTool = ref('');

  // hb12-CHR-01：节流（首条立即 + 50ms 间隔 + trailing）——流式增量高频触发时每 50ms 至多
  // 上屏一次（替代原「每次都重排 50ms 防抖」：长流式下末帧延迟无上界），trailing 保证停更后
  // 最后一帧不丢；空串直通（清 pending/timer 立即让位给已落库消息，不出现「流式块 + 已落库
  // 消息」短暂重复）。像素 4 字节/帧级别的重渲频率也由此受控（StreamRenderer v-enrich 高频重渲）。
  function makeThrottle(set: (v: string) => void): (v: string) => void {
    const INTERVAL = 50;
    let lastFire = 0;
    let pending: string | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    return (value: string) => {
      if (value === '') {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        pending = null;
        set('');
        return;
      }
      const now = Date.now();
      const elapsed = now - lastFire;
      if (elapsed >= INTERVAL) {
        lastFire = now;
        set(value);
        return;
      }
      pending = value;
      if (!timer) {
        timer = setTimeout(() => {
          timer = null;
          lastFire = Date.now();
          const v = pending;
          pending = null;
          if (v !== null) set(v);
        }, INTERVAL - elapsed);
      }
    };
  }
  const pushContent = makeThrottle((v) => {
    displayContent.value = v;
  });
  const pushThinking = makeThrottle((v) => {
    displayThinking.value = v;
  });
  const pushTool = makeThrottle((v) => {
    displayTool.value = v;
  });

  watch(
    () => store.streamingContent,
    (content) => {
      pushContent(content);
    },
    { immediate: true },
  );

  watch(
    () => store.streamingThinking,
    (content) => {
      pushThinking(content);
    },
    { immediate: true },
  );

  watch(
    () => store.streamingTool,
    (content) => {
      pushTool(content);
    },
    { immediate: true },
  );

  return { displayContent, displayThinking, displayTool };
}
