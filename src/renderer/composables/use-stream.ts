import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';

export function useStream() {
  const store = useSessionStore();
  const displayContent = ref('');
  const displayThinking = ref('');

  let contentTimer: ReturnType<typeof setTimeout> | null = null;
  let thinkingTimer: ReturnType<typeof setTimeout> | null = null;

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

  return { displayContent, displayThinking };
}
