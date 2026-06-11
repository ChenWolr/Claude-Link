import type { QueueEventPayload } from '../../shared/types/ipc';
import { useTaskStore } from '../stores/task-store';

export function useTaskQueue() {
  const store = useTaskStore();

  function startListening(): () => void {
    return window.claudeLink.onQueueEvent((payload: QueueEventPayload) => {
      store.handleQueueEvent(payload);
    });
  }

  return { startListening };
}
