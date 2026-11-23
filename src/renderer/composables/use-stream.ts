import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';

// hb12-CHR-01：节流（首条立即 + 50ms 间隔 + trailing）——流式增量高频触发时每 50ms 至多
// 上屏一次（替代原「每次都重排 50ms 防抖」：长流式下末帧延迟无上界），trailing 保证停更后
// 最后一帧不丢；空串直通（清 pending/timer 立即让位给已落库消息，不出现「流式块 + 已落库
// 消息」短暂重复）。像素 4 字节/帧级别的重渲频率也由此受控（StreamRenderer v-enrich 高频重渲）。
// P5 渲染层（2026-11-19 UI 五点批次）从 useStream() 内提升至模块级并 export——纯工厂不闭包
// 任何组件状态，提升是纯搬移（displayContent/displayThinking/displayTool 行为零变化）；
// 翻译译文独立节流（use-translation-display）复用同一工厂（同 50ms 口径），不与流式上屏
// 共用实例（互不串流）。01 §5.4②「makeThrottle 加 export 一字改动」的落地形态：原函数为
// useStream 内嵌套函数声明，export 语法上只能落模块级，故整体上提（语义等价，申报留痕）。
export function makeThrottle(set: (v: string) => void): (v: string) => void {
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

export function useStream() {
  const store = useSessionStore();
  const displayContent = ref('');
  const displayThinking = ref('');
  const displayTool = ref('');

  // hb12-CHR-01：节流（首条立即 + 50ms 间隔 + trailing）——流式增量高频触发时每 50ms 至多
  // 上屏一次（替代原「每次都重排 50ms 防抖」：长流式下末帧延迟无上界），trailing 保证停更后
  // 最后一帧不丢；空串直通（清 pending/timer 立即让位给已落库消息，不出现「流式块 + 已落库
  // 消息」短暂重复）。像素 4 字节/帧级别的重渲频率也由此受控（StreamRenderer v-enrich 高频重渲）。
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
