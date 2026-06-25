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
      toolTimer = setTimeout(() => {
        displayTool.value = content;
      }, 50);
    },
    { immediate: true },
  );

  return { displayContent, displayThinking, displayTool };
}
