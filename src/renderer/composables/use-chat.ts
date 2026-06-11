import { ref } from 'vue';
import { useSessionStore } from '../stores/session-store';
import type { ChatEventPayload } from '../../shared/types/ipc';
import type { CliEvent } from '../../shared/types/cli';

export function useChat() {
  const store = useSessionStore();
  const sending = ref(false);
  const error = ref<string | null>(null);

  let cleanup: (() => void) | null = null;

  function startListening(): void {
    cleanup?.();
    cleanup = window.claudeLink.onChatEvent(handleEvent);
  }

  function stopListening(): void {
    cleanup?.();
    cleanup = null;
    window.claudeLink.removeChatListener();
  }

  function handleEvent(payload: ChatEventPayload): void {
    if (!store.activeSession || payload.sessionId !== store.activeSession.id) return;
    handleCliEvent(payload.event);
  }

  function handleCliEvent(event: CliEvent): void {
    switch (event.type) {
      case 'stream_event': {
        const text = event.event?.delta?.text;
        if (text) {
          store.appendStream(text);
        }
        break;
      }
      case 'message': {
        store.clearStream();
        const textPart = event.content?.find((c) => c.type === 'text');
        if (textPart && 'text' in textPart) {
          store.addMessage({
            id: crypto.randomUUID(),
            sessionId: store.activeSession!.id,
            role: event.role,
            content: textPart.text,
            rawEvent: null,
            eventType: 'message',
            costUsd: null,
            durationMs: null,
            parentTaskId: null,
            createdAt: new Date().toISOString(),
          });
        }
        break;
      }
      case 'result': {
        store.clearStream();
        sending.value = false;
        break;
      }
      case 'init': {
        break;
      }
    }
  }

  async function sendMessage(text: string): Promise<void> {
    if (!store.activeSession || !text.trim()) return;

    error.value = null;
    sending.value = true;

    store.addMessage({
      id: crypto.randomUUID(),
      sessionId: store.activeSession.id,
      role: 'user',
      content: text.trim(),
      rawEvent: null,
      eventType: 'message',
      costUsd: null,
      durationMs: null,
      parentTaskId: null,
      createdAt: new Date().toISOString(),
    });

    try {
      startListening();
      await window.claudeLink.sendMessage(store.activeSession.id, text.trim());
    } catch (e) {
      error.value = e instanceof Error ? e.message : '发送失败';
      sending.value = false;
    }
  }

  async function abort(): Promise<void> {
    if (!store.activeSession) return;
    try {
      await window.claudeLink.abortChat(store.activeSession.id);
    } finally {
      sending.value = false;
      stopListening();
    }
  }

  return { sending, error, sendMessage, abort, startListening, stopListening };
}
