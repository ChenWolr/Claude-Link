import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';

export function useStream() {
  const store = useSessionStore();
  const displayContent = ref('');

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  watch(
    () => store.streamingContent,
    (content) => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        displayContent.value = content;
      }, 50);
    },
    { immediate: true },
  );

  return { displayContent };
}
