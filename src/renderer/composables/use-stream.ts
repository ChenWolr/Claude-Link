import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';

export function useStream() {
  const store = useSessionStore();
  const displayContent = ref('');
  const displayThinking = ref('');
  const displayTool = ref('');

  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  let toolTimer: ReturnType<typeof setTimeout> | null = null;

  watch(
    () => store.streamingContent,
    (content) => {
      if (contentTimer) clearTimeout(contentTimer);
      // 清空立即生效（不防抖）：回合结束/工具落库后流式归零，需立刻让出显示给已落库消息，
      // 否则防抖 50ms 窗口内会出现「流式块 + 已落库消息」短暂重复。
      if (content === '') {
        displayContent.value = '';
        return;
      }
      contentTimer = setTimeout(() => {
        displayContent.value = content;
      }, 50);
    },
    { immediate: true },
  );

  watch(
    () => store.streamingThinking,
    (content) => {
      if (thinkingTimer) clearTimeout(thinkingTimer);
      if (content === '') {
        displayThinking.value = '';
        return;
      }
      thinkingTimer = setTimeout(() => {
        displayThinking.value = content;
      }, 50);
    },
    { immediate: true },
  );

  watch(
    () => store.streamingTool,
    (content) => {
      if (toolTimer) clearTimeout(toolTimer);
      if (content === '') {
        displayTool.value = '';
        return;
      }
      toolTimer = setTimeout(() => {
        displayTool.value = content;
      }, 50);
    },
    { immediate: true },
  );

  return { displayContent, displayThinking, displayTool };
}
