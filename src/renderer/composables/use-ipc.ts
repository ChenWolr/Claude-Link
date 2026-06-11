import type { ChatEventPayload } from '../../shared/types/ipc';

export function useIpc() {
  function onChatEvent(callback: (payload: ChatEventPayload) => void): () => void {
    return window.claudeLink.onChatEvent(callback);
  }

  function removeChatListener(): void {
    window.claudeLink.removeChatListener();
  }

  return { onChatEvent, removeChatListener };
}
