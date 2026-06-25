// use-chat.ts
// CLI 流事件处理：把 process-manager 转发的 stream-json 事件分流到 session-store。
//
// stream_event: thinking_delta → appendThinking（思考），text_delta → appendStream（正文），
//   signature_delta 忽略；message: 清流 + 持久化各 part（text / tool_use / tool_result / thinking）；
// result: 补 result 文本（防丢）+ 挂费用/耗时。
// 这里是"Claude 思考/输入/输出原封不动接收展示"的核心实现（之前 thinking_delta 被完全丢弃）。

import { ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';
import type { ChatEventPayload } from '../../shared/types/ipc';
import type { CliEvent, CliMessageContentPart, CliResultEvent } from '../../shared/types/cli';

export function useChat() {
  const store = useSessionStore();
  const sending = ref(false);
  const error = ref<string | null>(null);

  let cleanup: (() => void) | null = null;
  // abort 的软复位超时句柄。必须句柄化并在新回合/结束事件时清理，
  // 否则旧回合的定时器会在 1.2s 后把新回合的 sending 错误复位（跨回合串扰）。
  let abortTimer: ReturnType<typeof setTimeout> | null = null;
  function clearAbortTimer(): void {
    if (abortTimer) {
      clearTimeout(abortTimer);
      abortTimer = null;
    }
  }

  // 切换/删除会话时复位发送态。deleteSession 把 activeSession 置 null，若此时
  // sending=true（回复进行中），handleEvent 守卫会丢弃后续 result/aborted 事件，
  // 导致 sending 永不复位、输入框卡死。这里随 activeSession 变化强制复位。
  watch(
    () => store.activeSession?.id,
    () => {
      clearAbortTimer();
      sending.value = false;
      store.clearStream();
      store.clearThinking();
      store.clearToolStream();
    },
  );

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
        const delta = event.event?.delta;
        if (!delta) break;
        if (delta.type === 'thinking_delta' && delta.thinking) {
          store.appendThinking(delta.thinking);
        } else if (delta.type === 'signature_delta') {
          // 思考签名不展示
        } else if (delta.type === 'input_json_delta') {
          // 工具调用参数流式成型（partial_json 逐片），给用户"正在调用工具"的实时反馈。
          if (delta.partial_json) store.appendToolStream(delta.partial_json);
        } else if (delta.text) {
          store.appendStream(delta.text);
        }
        break;
      }
      case 'message': {
        // ── 修复：从源头杜绝流式与持久化重复 ────────────────────────
        // 背景：部分场景下 CLI 会先吐 `message`（完整内容）再吐 stream_event（增量 delta），
        // 旧逻辑收到 `message` 就 clearStream + 添加持久化消息，导致：
        //   1) 已积累的流式内容被立即清掉，用户看不到实时打字
        //   2) 后续到达的 stream_event 把内容重新堆到流式块，与刚添加的持久化消息重复显示
        // 新逻辑：assistant 的 text/thinking 永远只由流式块显示，`message` 只持久化
        // tool_use / tool_result / redacted_thinking（不与流式重叠）。回合结束时
        // `finalizeAssistantStream` 把流式累积的 text/thinking 转为持久化消息。
        // 用户消息照原样落库。
        const role = event.role;
        console.log('[diag message] role=', role, 'parts=', (event.content ?? []).map((p) => p.type));
        if (role === 'user') {
          handleMessageParts(event.content ?? [], role);
        } else {
          handleMessagePartsPersistOnly(event.content ?? []);
        }
        break;
      }
      case 'result': {
        // M1：错误回合（is_error 且非中断）不当作正常回答静默展示，把错误文本以 error 提示。
        // 注意：error_during_execution 在 *nix 上是"用户 SIGINT 中断"的正常收尾，
        // 绝不能当错误弹窗（否则违背 M4——中断被误报）。只有真正的失败 subtype 才报错。
        const subtype = event.subtype;
        const isUserInterrupt = subtype === 'error_during_execution';
        const isErrResult =
          !!event.is_error && !isUserInterrupt && subtype !== 'success' && subtype !== undefined;

        // 回合结束：先把流式累积的 thinking / content 转为持久化消息，
        // 再清掉流式状态，让 MessageList 从流式块切回持久化消息显示。
        console.log('[diag result] streamingThinking.len=', store.streamingThinking.length, 'streamingContent.len=', store.streamingContent.length);
        finalizeAssistantStream();
        console.log('[diag finalize done] messages.len=', store.messages.length, 'lastTypes=', store.messages.slice(-3).map((m) => m.eventType));
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();

        ensureResultMessage(event);
        attachResultMetadata(event);
        if (isErrResult && event.result?.trim()) {
          error.value = event.result.trim();
        }
        sending.value = false;
        clearAbortTimer();
        break;
      }
      case 'error': {
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
        error.value = event.message;
        sending.value = false;
        clearAbortTimer();
        break;
      }
      case 'aborted': {
        // 中断/异常结束：保留已生成的流式内容为持久化消息，再复位
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
        sending.value = false;
        clearAbortTimer();
        break;
      }
      case 'system':
      case 'init': {
        break;
      }
    }
  }

  // 回合中 message 事件的"部分落库"版本：只添加 user / tool_use / tool_result /
  // redacted_thinking。跳过 assistant text 与 thinking（它们由流式块实时显示，
  // 回合结束时由 finalizeAssistantStream 统一落库），避免与流式块重复显示同一段内容。
  function handleMessagePartsPersistOnly(parts: CliMessageContentPart[]): void {
    for (const part of parts) {
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
        const rawContent = (part as { content?: unknown }).content;
        const resultText =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .map((item) =>
                    item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
                      ? (item as { text: string }).text
                      : JSON.stringify(item, null, 2),
                  )
                  .join('\n')
              : JSON.stringify(rawContent ?? '', null, 2);
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
        continue;
      }
      if (part.type === 'redacted_thinking') {
        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role: 'assistant',
          content: '（此段思考已被安全策略隐藏）',
          rawEvent: null,
          eventType: 'thinking',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
      }
      // assistant text / thinking：跳过，回合结束时由 finalizeAssistantStream 落库
    }
  }

  // 回合结束时：把流式累积的 thinking / content 转为持久化消息（仅当回合内未通过
  // message 事件落库）。这是修复"流式事件批量到达导致用户看不到实时打字"的关键：
  // 流式块在回合期间实时可见，回合结束瞬间无缝切换为持久化消息。
  function finalizeAssistantStream(): void {
    if (!store.activeSession) return;
    const now = new Date().toISOString();
    if (store.streamingThinking) {
      store.addMessage({
        id: crypto.randomUUID(),
        sessionId: store.activeSession.id,
        role: 'assistant',
        content: store.streamingThinking,
        rawEvent: null,
        eventType: 'thinking',
        costUsd: null,
        durationMs: null,
        parentTaskId: null,
        createdAt: now,
      });
    }
    if (store.streamingContent) {
      store.addMessage({
        id: crypto.randomUUID(),
        sessionId: store.activeSession.id,
        role: 'assistant',
        content: store.streamingContent,
        rawEvent: null,
        eventType: 'message',
        costUsd: null,
        durationMs: null,
        parentTaskId: null,
        createdAt: now,
      });
    }
  }

  function handleMessageParts(parts: CliMessageContentPart[], role: 'user' | 'assistant'): void {
    for (const part of parts) {
      if (part.type === 'thinking' && 'thinking' in part) {
        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role: 'assistant',
          content: part.thinking,
          rawEvent: null,
          eventType: 'thinking',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
      // M5：思考被安全策略移除时 CC 发 redacted_thinking，给出占位提示而非静默丢弃。
      if (part.type === 'redacted_thinking') {
        store.addMessage({
          id: crypto.randomUUID(),
          sessionId: store.activeSession!.id,
          role: 'assistant',
          content: '（此段思考已被安全策略隐藏）',
          rawEvent: null,
          eventType: 'thinking',
          costUsd: null,
          durationMs: null,
          parentTaskId: null,
          createdAt: new Date().toISOString(),
        });
        continue;
      }
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
        // M6：content 可能是 string 或 [{type:'text',text}, ...]，数组需提取文本而非裸 JSON。
        const rawContent = (part as { content?: unknown }).content;
        const resultText =
          typeof rawContent === 'string'
            ? rawContent
            : Array.isArray(rawContent)
              ? rawContent
                  .map((item) =>
                    item && typeof item === 'object' && typeof (item as { text?: unknown }).text === 'string'
                      ? (item as { text: string }).text
                      : JSON.stringify(item, null, 2),
                  )
                  .join('\n')
              : JSON.stringify(rawContent ?? '', null, 2);

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

    // 新回合开始：作废上一回合 abort 残留的超时兜底，避免它把本次 sending 错误复位。
    clearAbortTimer();
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

  // 中断当前回合。M3：不立即 stopListening——nix 上 SIGINT 后 CC 会发回
  // result(error_during_execution)，含费用/耗时元数据，应让它到达而非丢弃。
  // 保留监听，直到收到 result/error/aborted 或超时兜底复位。
  async function abort(): Promise<void> {
    if (!store.activeSession) return;
    clearAbortTimer();
    try {
      await window.claudeLink.abortChat(store.activeSession.id);
    } catch {
      // ignore abort 失败
    }
    // 软复位窗口：给 CLI ~1.2s 发回结束事件；超时则强制复位（Windows 硬杀会丢 result）。
    // 句柄化：结束事件到达或下一回合开始时会被 clearAbortTimer 清掉，杜绝跨回合串扰。
    abortTimer = setTimeout(() => {
      abortTimer = null;
      if (sending.value) {
        sending.value = false;
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
      }
    }, 1200);
  }

  return { sending, error, sendMessage, abort, startListening, stopListening };
}
