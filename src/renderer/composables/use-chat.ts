import { ref } from 'vue';
import { useSessionStore } from '../stores/session-store';
import type { ChatEventPayload } from '../../shared/types/ipc';
import type { CliEvent, CliMessageContentPart, CliResultEvent } from '../../shared/types/cli';

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
        handleMessageParts(event.content ?? [], event.role);
        break;
      }
      case 'result': {
        store.clearStream();
        ensureResultMessage(event);
        attachResultMetadata(event);
        sending.value = false;
        break;
      }
      case 'init': {
        break;
      }
    }
  }

  function handleMessageParts(parts: CliMessageContentPart[], role: 'user' | 'assistant'): void {
    for (const part of parts) {
      if (part.type === 'text' && 'text' in part) {
        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role,
          content: part.text,
          rawEvent: null,
          eventType: 'message',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
        continue;
      }

      if (part.type === 'tool_use') {
        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role: 'assistant',
          content: JSON.stringify({
            name: part.name,
            input: part.input,
            toolUseId: part.tool_use_id ?? null,
          }, null, 2),
          rawEvent: null,
          eventType: 'tool_use',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
        continue;
      }

      if (part.type === 'tool_result') {
        const resultText = typeof part.content === 'string'
          ? part.content
          : JSON.stringify(part.content ?? '', null, 2);

        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role: 'tool',
          content: resultText,
          rawEvent: null,
          eventType: 'tool_result',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
      }
    }
  }

  // 当 Claude 把最终回答放在 result.result 而非前置 message 文本 part 时，
  // 本回合不会有 assistant 文本消息，需要用 result 文本补一条，否则回答丢失。
  function ensureResultMessage(event: CliResultEvent): void {
    const resultText = event.result?.trim();
    if (!resultText) return;
    if (turnHasAssistantText()) return;

    store.addMessage({
      id: crypto.randomUUID(),
      sessionId: store.activeSession!.id,
      role: 'assistant',
      content: resultText,
      rawEvent: null,
      eventType: 'message',
      costUsd: null,
      durationMs: null,
      parentTaskId: null,
      createdAt: new Date().toISOString(),
    });
  }

  // 从最新消息向前回溯，直到本回合的用户消息为止，判断是否已产生 assistant 文本。
  function turnHasAssistantText(): boolean {
    const messages = store.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user') return false;
      if (message.role === 'assistant' && message.eventType === 'message') return true;
    }
    return false;
  }

  // 把费用/耗时挂到本回合最后一条 assistant 消息上（文本或 tool_use 均可），
  // 这样纯工具回合也能展示 cost/duration；回溯到上一回合的用户消息即停止。
  function attachResultMetadata(event: CliResultEvent): void {
    const messages = store.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user') break;
      if (message.role === 'assistant') {
        message.costUsd = event.total_cost_usd ?? null;
        message.durationMs = event.duration_ms ?? null;
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
