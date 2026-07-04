// use-chat.ts
// CLI 流事件处理：把 process-manager 转发的 stream-json 事件分流到 session-store。
//
// stream_event: thinking_delta → appendThinking（思考），text_delta → appendStream（正文），
//   signature_delta 忽略；message: 清流 + 持久化各 part（text / tool_use / tool_result / thinking）；
// result: 补 result 文本（防丢）+ 挂费用/耗时。
// 这里是"Claude 思考/输入/输出原封不动接收展示"的核心实现（之前 thinking_delta 被完全丢弃）。

import { computed, ref, watch } from 'vue';
import { useSessionStore } from '../stores/session-store';
import type { BackgroundTask } from '../stores/session-store';
import type { ChatEventPayload } from '../../shared/types/ipc';
import type { CliEvent, CliMessageContentPart, CliResultEvent, CliSystemInitEvent, CliSystemInfoEvent, CliPermissionEvent, CliStalledEvent } from '../../shared/types/cli';
import { processKindFromPart, extractSubAgentTitle } from '../../shared/process-kind';
import { isDisplayableSystemInfo } from '../../shared/system-info';
import type { Message } from '../../shared/types/session';

// 根因修复：全局单例。useChat 只初始化一次（在 App.vue），监听生命周期与 app 等长。
// ChatPage 卸载/重挂载不影响监听——sending 从 store getter 派生，error 用 store.error。
// sendMessage/abort 可在任意组件调（通过 useChat() 复用单例）。
let chatSingleton: ReturnType<typeof createChat> | null = null;

// C：把进度类事件（tool_progress / compacting / task_*）映射到 store。纯函数（不依赖闭包），可单测。
// task_notification 终态：先 upsert 终态卡片，4 秒后移除（淡出，避免列表残留已完成任务）。
export function applyStalledEvent(store: ReturnType<typeof useSessionStore>, sessionId: string, event: CliStalledEvent): void {
  store.markStalled(sessionId, {
    sinceMs: event.sinceMs,
    gapMs: event.gapMs,
    lastKind: event.lastKind,
    pendingAgentId: event.pendingAgentId,
    zone: event.zone,
    stallCount: event.stallCount,
  });
}

export function applyProgressEvent(store: ReturnType<typeof useSessionStore>, event: CliEvent): void {
  if (event.type === 'tool_progress') {
    if (event.toolUseId) store.setToolProgress(event.toolUseId, event.elapsedSeconds);
    return;
  }
  if (event.type === 'system') {
    if (event.subtype === 'compacting') {
      store.setCompacting(true);
      return;
    }
    // Bug4：压缩结束（compact_result，compactResult=success/failed）→ 复位压缩指示；
    // 之前 setCompacting(true) 后从无 reset。同时避免它落库成「系统提示」。
    if (event.subtype === 'compact_result') {
      store.setCompacting(false);
      return;
    }
    // requesting（SDK 发起 API 请求）：纯瞬态心跳式信号，无需展示也无需状态，落到此 no-op。
    if (
      event.subtype === 'task_started' ||
      event.subtype === 'task_progress' ||
      event.subtype === 'task_notification'
    ) {
      const task: BackgroundTask = {
        taskId: event.taskId,
        toolUseId: event.toolUseId,
        description: event.description,
        taskType: event.taskType,
        status: event.status,
        usage: event.usage,
        lastToolName: event.lastToolName,
        summary: event.summary,
      };
      store.upsertBackgroundTask(task);
      if (event.subtype === 'task_notification') {
        const tid = event.taskId;
        setTimeout(() => store.removeBackgroundTask(tid), 4000);
      }
      return;
    }
  }
}

function createChat() {
  const store = useSessionStore();
  // sending 改为从 store getter 派生（computed），不再用 local ref。
  // 这样 ChatPage 卸载/重挂载时，sending 始终从 store.runningSessions 反映，不会丢失。
  const sending = computed(() => store.sending);
  const error = ref<string | null>(null);

  let cleanup: (() => void) | null = null;
  // try-finally 兜底：按 sessionId 记录“中断强制复位”定时器（替代原单例 timer）。
  // 与单例的本质区别：
  //  1) per-session：每个会话独立兜底，切会话不会丢掉别的会话的 finally。
  //  2) 不被切会话清掉：watch(activeSession) 不再触碰它——修复“中断后切走→兜底丢失→永久 sending”。
  //  3) 幂等：finally 内先查 runningSessions，已停则 no-op，多路径清理也安全。
  // 语义：try = 等 SDK 发回 result/error/aborted（到达即 clearAbortTimer = finally 提前满足）；
  //      finally = 超时强制 markStopped（无论 SDK 中断信号是否真生效、结束事件是否回来、是否切会话）。
  const abortTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const ABORT_FINALLY_MS = 1200;
  function clearAbortTimer(sessionId: string): void {
    const t = abortTimers.get(sessionId);
    if (t) {
      clearTimeout(t);
      abortTimers.delete(sessionId);
    }
  }
  function clearAllAbortTimers(): void {
    for (const t of abortTimers.values()) clearTimeout(t);
    abortTimers.clear();
  }
  // finally 兜底：到点必然把该会话复位为已停止。
  // 当前会话额外清全局流式 + finalize 保留已生成内容；后台会话的 per-session 快照由 markStopped 自带清理。
  function ensureAbortFinally(sid: string): void {
    if (abortTimers.has(sid)) return; // 已在兜底窗口内，不重复
    const timer = setTimeout(() => {
      abortTimers.delete(sid);
      // 幂等守卫：正常路径已清过 runningSessions，这里 no-op。
      if (!store.runningSessions.includes(sid)) return;
      const isCurrent = !!store.activeSession && store.activeSession.id === sid;
      if (isCurrent) {
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
        resetTurnCache();
      }
      store.markStopped(sid);
    }, ABORT_FINALLY_MS);
    abortTimers.set(sid, timer);
  }

  // 本回合缓存（力度②：message 事件为唯一真相）：
  //  - turnHad* 标志：标记「主流程（parentAgentId === null）」是否已通过 message 事件落过
  //    text/thinking/tool_use。必须只反映主流程：finalize 的流式兜底是为补主流程丢失的内容，
  //    若被子 Agent 的 part 置位，会错误抑制主流程兜底（内容丢失）。
  //    finalize 仅在「主流程没有 message 事件、只有流式」的边缘情况（中断/异常端点）兜底落库，
  //    避免与已落内容重复。模型无关：流式端点与不发 delta 的端点都不丢过程。
  let turnHadToolUse = false;
  let turnHadText = false;
  let turnHadThinking = false;
  function resetTurnCache(): void {
    turnHadToolUse = false;
    turnHadText = false;
    turnHadThinking = false;
  }

  // 统一构造并落库一条消息（带过程分类四字段）。渲染层 addMessage 纯内存，
  // 与主进程 createMessage 落库各走一路；两者用同一 processKindFromPart 保证分类一致。
  function persistMessage(partial: {
    content: string;
    role: Message['role'];
    eventType: string;
    processKind?: string | null;
    parentAgentId?: string | null;
    toolUseId?: string | null;
    title?: string | null;
    isError?: boolean;
  }): void {
    if (!store.activeSession) return;
    store.addMessage({
      id: crypto.randomUUID(),
      sessionId: store.activeSession.id,
      role: partial.role,
      content: partial.content,
      rawEvent: null,
      eventType: partial.eventType,
      costUsd: null,
      durationMs: null,
      parentTaskId: null,
      processKind: partial.processKind ?? null,
      parentAgentId: partial.parentAgentId ?? null,
      toolUseId: partial.toolUseId ?? null,
      title: partial.title ?? null,
      isError: partial.isError === true,
      createdAt: new Date().toISOString(),
    });
  }

  // 根因修复：watcher 不再绑定到 ChatPage 生命周期（单例在 App.vue 初始化）。
  // 切换会话时同步 error + resetTurnCache，sending 由 store getter 自动反映。
  watch(
    () => store.activeSession?.id,
    (newId) => {
      // 故意不清 abortTimers：中断兜底按 sessionId 绑定，切会话不得丢弃别的会话的 finally
      //（否则中断后切走 → 兜底丢失 → 该会话永久 sending）。仅同步当前视图的 error/回合缓存。
      void newId;
      error.value = null;
      resetTurnCache();
    },
  );

  // 根因修复：全局监听，在 App.vue onMounted 调一次。生命周期与 app 等长。
  function startListening(): void {
    window.claudeLink.removeChatListener();
    cleanup?.();
    cleanup = window.claudeLink.onChatEvent(handleEvent);
  }

  function stopListening(): void {
    cleanup?.();
    cleanup = null;
    window.claudeLink.removeChatListener();
    clearAllAbortTimers();
  }

  function isStallRecoveryEvent(event: CliEvent): boolean {
    if (event.type === 'stream_event' || event.type === 'message' || event.type === 'tool_progress') return true;
    if (event.type === 'system') return event.subtype !== 'init';
    return false;
  }
  function clearStalledForSession(sessionId: string, event: CliEvent): void {
    if (!isStallRecoveryEvent(event)) return;
    store.clearStalled(sessionId);
    // Bug4/Bug5：真实业务事件（流式/消息/工具进度/非 init system）= API 已恢复，清掉重试指示器；
    // api_retry 自身是要计数的对象，不清自己。
    if (!(event.type === 'system' && event.subtype === 'api_retry')) {
      store.clearApiRetrying(sessionId);
    }
  }

  // 问题 1：不再丢弃非当前会话的事件。后台执行的会话事件需要处理：
  // - stream_event: 写入 sessionStreams 快照（切回时恢复流式预览）
  // - result/error/aborted: markStopped + 清快照（如果是当前会话还走正常结束流程）
  // - message/system: 主进程已落库，切回时 getSessionMessages 重载；渲染层只处理当前会话
  function handleEvent(payload: ChatEventPayload): void {
    const isCurrent = !!store.activeSession && payload.sessionId === store.activeSession.id;
    clearStalledForSession(payload.sessionId, payload.event);
    if (!isCurrent) {
      handleBackgroundEvent(payload);
      return;
    }
    handleCliEvent(payload.event);
  }

  // 问题 1：处理后台（非当前）会话的事件。只处理流式累积和结束标记，
  // 不处理 message/system（主进程已落库，切回时重载）。
  function handleBackgroundEvent(payload: ChatEventPayload): void {
    const sid = payload.sessionId;
    const event = payload.event;
    switch (event.type) {
      case 'stream_event': {
        const delta = event.event?.delta;
        if (!delta) break;
        if (delta.type === 'thinking_delta' && delta.thinking) {
          store.appendBackgroundStream(sid, 'thinking', delta.thinking);
        } else if (delta.type === 'input_json_delta' && delta.partial_json) {
          store.appendBackgroundStream(sid, 'tool', delta.partial_json);
        } else if (delta.text) {
          store.appendBackgroundStream(sid, 'content', delta.text);
        }
        break;
      }
      case 'stalled': {
        // 后台会话卡死也要记录；用户切回该会话时 StalledBanner 可立即显形。
        applyStalledEvent(store, sid, event);
        break;
      }
      case 'system': {
        // Bug4/Bug5：api_retry 不再落库，后台会话也要计数，切回时 ApiRetryBanner 能显示。
        // 其余 system 子类型主进程已落库，切回时重载，这里跳过。
        if (event.subtype === 'api_retry') {
          const r = event as CliSystemInfoEvent;
          store.markApiRetrying(sid, { max: r.max_retries, error: r.error });
        }
        break;
      }
      case 'result':
      case 'error':
      case 'aborted': {
        // 后台会话执行结束：清该会话中断兜底（try 成功 = finally 提前满足）+ 标记停止 + 清理快照
        clearAbortTimer(sid);
        store.markStopped(sid);
        break;
      }
      // message/init: 主进程已落库，切回时 getSessionMessages 重载，这里跳过
    }
  }

  function handleCliEvent(event: CliEvent): void {
    switch (event.type) {
      case 'stream_event': {
        const delta = event.event?.delta;
        if (!delta) break;
        if (delta.type === 'thinking_delta' && delta.thinking) {
          // Bug2：带 parentToolUseId 的是子 agent 思考，路由到对应「子Agent」Tab 实时快照；
          // 主流程思考仍进全局 streamingThinking。
          if (event.parentToolUseId && store.activeSession) {
            store.appendSubAgentThinking(store.activeSession.id, event.parentToolUseId, delta.thinking);
          } else {
            store.appendThinking(delta.thinking);
          }
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
        // 力度②：`message` 事件是唯一真相——全量落库 text/thinking/tool_use/tool_result/
        // redacted_thinking，保留多段正文原位（边说边做边说各自独立气泡穿插过程组）。
        // streaming 仅作实时预览，不参与持久化。模型无关：不发 delta 的端点也靠 message
        // 事件完整落库。与流式块的重复由 MessageList 的 turn-boundary 去重处理（发送中且
        // 对应流式非空时隐藏本回合已落库 text/thinking，回合结束流式清空后接管显示）。
        const role = event.role;
        const agentId = event.parentToolUseId ?? null;
        handleMessagePartsFull(event.content ?? [], role, agentId);
        // Bug2：子 agent 的完整 message 已落库（含思考/正文），清掉它的实时思考快照，避免与落库重复。
        if (agentId && store.activeSession) store.clearSubAgentThinking(store.activeSession.id, agentId);
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
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();

        // 错误回合（非中断）的 result 文本是失败原因：只走 error 横幅，不当 assistant 正文
        // 落库（否则与横幅重复展示 + 把错误文案当成回答污染历史）。主进程 persistCliEvent
        // 的 result 分支用同一 isErrResult 判断同步跳过，DB 与内存保持一致。
        if (!isErrResult) ensureResultMessage(event);
        attachResultMetadata(event);
        if (isErrResult) {
          error.value = resultErrorText(event);
        }
        // 根因修复：markStopped 移除 runningSessions，sending getter 自动变 false。
        if (store.activeSession) {
          clearAbortTimer(store.activeSession.id);
          store.markStopped(store.activeSession.id);
        }
        resetTurnCache();
        break;
      }
      case 'error': {
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
        error.value = event.message;
        if (store.activeSession) {
          clearAbortTimer(store.activeSession.id);
          store.markStopped(store.activeSession.id);
        }
        resetTurnCache();
        break;
      }
      case 'aborted': {
        // 中断/异常结束：保留已生成的流式内容为持久化消息，再复位
        finalizeAssistantStream();
        store.clearStream();
        store.clearThinking();
        store.clearToolStream();
        if (store.activeSession) {
          clearAbortTimer(store.activeSession.id);
          store.markStopped(store.activeSession.id);
        }
        resetTurnCache();
        break;
      }
      case 'tool_progress': {
        // C：工具运行进度 → store 瞬态状态（ToolCallBlock 显示实时耗时）。
        applyProgressEvent(store, event);
        break;
      }
      case 'system': {
        // Bug4/Bug5：api_retry 走瞬态重试指示器（不落库、不进聊天流），用本回合累计计数原地递增。
        if (event.subtype === 'api_retry') {
          const r = event as CliSystemInfoEvent;
          if (store.activeSession) {
            store.markApiRetrying(store.activeSession.id, { max: r.max_retries, error: r.error });
          }
          break;
        }
        // C：进度类/瞬态 system 子类型（compacting/task_*/requesting/compact_result）→ store 瞬态状态，不落库。
        // Bug4：requesting（SDK 每回合发起 API 请求时发）和 compact_result 原本落到 persistSystemEvent，
        // 这两个 subtype 无专用 defaultText → fallback「系统提示」+ processKind 未过滤 → 每回合冒无意义系统消息。
        if (
          event.subtype === 'compacting' ||
          event.subtype === 'compact_result' ||
          event.subtype === 'requesting' ||
          event.subtype === 'task_started' ||
          event.subtype === 'task_progress' ||
          event.subtype === 'task_notification'
        ) {
          applyProgressEvent(store, event);
          break;
        }
        // 其余 system 子类型（informational/compact_boundary/permission_* 等）落库为过程消息。
        persistSystemEvent(event);
        break;
      }
      case 'stalled': {
        // 主进程看门狗判定无响应：记录卡死信息，StalledBanner 显形。
        // 不动 sending（回合仍在「运行」，只是无响应）；markStopped 时横幅自动消失。
        if (store.activeSession) applyStalledEvent(store, store.activeSession.id, event);
        break;
      }
      case 'init': {
        break;
      }
    }
  }

  // 全量落库一个 message 事件的 content（力度②：唯一真相）。user/assistant 共用。
  // 保留 parts 原始顺序——多段 text 各自独立气泡、穿插在工具/thinking 过程组之间（设计决策 #6）。
  // assistant 的 text/thinking/tool_use 落库时置 turnHad* 标志，供 finalize 兜底去重判断。
  function handleMessagePartsFull(
    parts: CliMessageContentPart[],
    role: 'user' | 'assistant',
    parentAgentId: string | null,
  ): void {
    const isAssistant = role === 'assistant';
    // turnHad* 标志只反映主流程：finalize 的流式兜底是为补主流程内容，子 Agent 的 part 不应
    // 置位（否则会抑制主流程兜底，造成主流程流式正文/思考/工具丢失）。
    const isMainFlow = isAssistant && parentAgentId === null;
    for (const part of parts) {
      if (part.type === 'thinking' && 'thinking' in part) {
        if (isMainFlow) turnHadThinking = true;
        persistMessage({ role: 'assistant', eventType: 'thinking', content: part.thinking, processKind: 'thinking', parentAgentId });
        continue;
      }
      if (part.type === 'redacted_thinking') {
        // redacted_thinking 也是 message 事件落库的思考，必须置位，否则 finalize 会把
        // streamingThinking 再落一条，与 redacted 占位消息重复。
        if (isMainFlow) turnHadThinking = true;
        persistMessage({ role: 'assistant', eventType: 'thinking', content: '（此段思考已被安全策略隐藏）', processKind: 'redacted_thinking', parentAgentId });
        continue;
      }
      if (part.type === 'text' && 'text' in part) {
        if (isMainFlow) turnHadText = true;
        persistMessage({ role, eventType: 'message', content: part.text, processKind: null, parentAgentId });
        continue;
      }
      if (part.type === 'tool_use') {
        if (isMainFlow) turnHadToolUse = true;
        persistMessage({
          role: 'assistant',
          eventType: 'tool_use',
          content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
          processKind: processKindFromPart(part),
          parentAgentId,
          // 问题 6：Anthropic ToolUseBlock 主键是 id（非 tool_use_id）；优先取 id，否则 tool_use_id 兜底。
          toolUseId: part.id ?? part.tool_use_id ?? null,
          title: extractSubAgentTitle(part),
        });
        // 工具入参流式预览（streamingTool）到此为止：message 事件带的是完整 tool_use，
        // 已落库为 ProcessGroup（sending 期间不去重，会正常显示）。若不清空 streamingTool，
        // 它会与已落库的工具组同时显示（重复），且多工具回合会把多个工具入参 JSON 串连。
        // 这里清空，让"已落库工具组"接管显示；下一个工具的 input_json_delta 重新从空累积。
        store.clearToolStream();
        continue;
      }
      if (part.type === 'server_tool_use') {
        if (isMainFlow) turnHadToolUse = true;
        persistMessage({
          role: 'assistant',
          eventType: 'tool_use',
          content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
          processKind: processKindFromPart(part),
          parentAgentId,
          // 问题 6：标准 server_tool_use 主键是 id；兼容少数代理端点用 tool_use_id。
          toolUseId: part.id ?? part.tool_use_id ?? null,
        });
        store.clearToolStream();
        continue;
      }
      if (
        part.type === 'tool_result' ||
        part.type === 'web_search_tool_result' ||
        part.type === 'web_fetch_tool_result' ||
        part.type === 'code_execution_tool_result'
      ) {
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
        const toolUseId = part.tool_use_id ?? null;
        persistMessage({
          role: 'tool',
          eventType: 'tool_result',
          content: resultText,
          processKind: processKindFromPart(part),
          parentAgentId,
          toolUseId,
          isError: part.type === 'tool_result' ? part.is_error === true : false,
        });
        // C：工具结果到达，清除该工具的实时耗时（避免遗留）。
        if (toolUseId) store.clearToolProgress(toolUseId);
      } else if (part.type === 'mcp_tool_use') {
        // L6：MCP 工具调用（与 tool_use 同形）。
        if (isMainFlow) turnHadToolUse = true;
        persistMessage({
          role: 'assistant',
          eventType: 'tool_use',
          content: JSON.stringify({ name: part.name, input: part.input }, null, 2),
          processKind: processKindFromPart(part),
          parentAgentId,
          // 问题 6：与 tool_use 同理，主键取 id（兼容 tool_use_id）。
          toolUseId: part.id ?? part.tool_use_id ?? null,
          title: extractSubAgentTitle(part),
        });
        store.clearToolStream();
      } else if (part.type === 'mcp_tool_result') {
        // L6：MCP 工具结果（与 tool_result 同形，含 is_error）。
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
        const toolUseId = part.tool_use_id ?? null;
        persistMessage({
          role: 'tool',
          eventType: 'tool_result',
          content: resultText,
          processKind: processKindFromPart(part),
          parentAgentId,
          toolUseId,
          isError: part.is_error === true,
        });
        if (toolUseId) store.clearToolProgress(toolUseId);
      } else {
        // 兜底：未识别的 content block 类型不静默丢弃，记日志便于发现协议新形态。
        console.warn('[handleMessagePartsFull] 未识别的 content block 类型，已跳过：', (part as { type: string }).type);
      }
    }
  }

  function resultErrorText(event: CliResultEvent): string {
    const resultText = event.result?.trim();
    if (resultText) return resultText;
    if (event.errors && event.errors.length > 0) return event.errors.join('\n');
    const parts: string[] = [];
    if (event.terminalReason) parts.push(`终止原因：${event.terminalReason}`);
    if (event.apiErrorStatus != null) parts.push(`API 状态：HTTP ${event.apiErrorStatus}`);
    else if (event.apiErrorStatus === null) parts.push('API 状态：连接错误或无状态码');
    if (event.stopReason) parts.push(`停止原因：${event.stopReason}`);
    return parts.join('\n') || 'SDK 执行失败，但未返回具体错误内容。';
  }

  // 回合结束兜底（力度②）：text/thinking/tool_use 已由 message 事件即时落库，这里只在
  // 「主流程没有 message 事件、只有流式累积」的边缘情况（中断/异常端点不发 message 事件）
  // 把残留流式落库，避免与已落内容重复（用 turnHad* 标志判断，仅反映主流程）。
  // 兜底固定归属主流程（parentAgentId = null）：streaming 累加器主/子 Agent 共享、无法按来源
  // 区分，但兜底语义就是补主流程内容；若用「最后一条 message 的 parentAgentId」会在子 Agent
  // 最后到达时把主流程流式错配到子 Agent Tab（主流程内容丢失）。
  function finalizeAssistantStream(): void {
    if (!store.activeSession) return;

    if (store.streamingThinking && !turnHadThinking) {
      persistMessage({ role: 'assistant', eventType: 'thinking', content: store.streamingThinking, processKind: 'thinking', parentAgentId: null });
    }
    if (store.streamingContent && !turnHadText) {
      persistMessage({ role: 'assistant', eventType: 'message', content: store.streamingContent, processKind: null, parentAgentId: null });
    }
    if (store.streamingTool && !turnHadToolUse) {
      persistMessage({ role: 'assistant', eventType: 'tool_use', content: store.streamingTool, processKind: 'tool:unknown', parentAgentId: null });
    }
  }

  // system 子类型事件（非 init）落库为过程消息：informational/compact_boundary/plugin_install
  // → system:<subtype>；permission_denied → permission。主进程同样落库，这里供本回合实时显示。
  function persistSystemEvent(event: CliEvent): void {
    if (event.type !== 'system') return;
    const e = event as CliSystemInitEvent | CliSystemInfoEvent | CliPermissionEvent;
    if (e.subtype === 'init') return;
    if (e.subtype === 'permission_denied' || e.subtype === 'permission_request') {
      const p = e as CliPermissionEvent;
      const toolName = p.tool_name ? `：${p.tool_name}` : '';
      persistMessage({
        role: 'system',
        eventType: 'system',
        content: p.message || (p.subtype === 'permission_request' ? `等待权限确认${toolName}` : `权限被拒绝${toolName}`),
        processKind: 'permission',
        toolUseId: p.tool_use_id ?? null,
      });
      return;
    }
    const info = e as CliSystemInfoEvent;
    // api_retry：SDK 不带 text，需自己拼「重试中（第 N/M 次）」动态文案。
    let text = info.text;
    if (!text && info.subtype === 'api_retry') {
      const attempt = info.attempt ?? '?';
      const max = info.max_retries ?? '?';
      const err = info.error ? `（${info.error}）` : '';
      text = `API 重试中（第 ${attempt}/${max} 次）${err}`;
    }
    // 问题 5：空文本的 informational 横幅不展示（每回合噪音「ℹ️ 系统提示」）。
    if (!isDisplayableSystemInfo(info.subtype, text)) return;
    const defaultText =
      info.subtype === 'compact_boundary' ? '上下文已达压缩边界'
        : info.subtype === 'plugin_install' ? '插件安装'
          : info.subtype === 'interaction_response' ? '用户已完成交互选择'
            : '系统提示';
    persistMessage({
      role: 'system',
      eventType: 'system',
      content: text || defaultText,
      processKind: `system:${info.subtype}`,
    });
  }

  // 当 Claude 把最终回答放在 result.result 而非前置 message 文本 part 时，
  // 本回合不会有 assistant 文本消息，需要用 result 文本补一条，否则回答丢失。
  function ensureResultMessage(event: CliResultEvent): void {
    const resultText = event.result?.trim();
    if (!resultText) return;
    if (turnHasAssistantText()) return;

    persistMessage({ role: 'assistant', eventType: 'message', content: resultText, processKind: null });
  }

  // 从最新消息向前回溯，直到本回合的用户消息为止，判断主流程是否已产生 assistant 文本。
  // 必须排除子 Agent 消息（parentAgentId !== null）：result.result 是主流程的回答，
  // 若把子 Agent 产生的正文也算上，会在"主流程无正文、最终回答只在 result 里、且本回合
  // 跑过子 Agent"时误判为已有正文，导致 ensureResultMessage 跳过补落、主流程回答丢失。
  function turnHasAssistantText(): boolean {
    const messages = store.messages;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user') return false;
      if (
        message.role === 'assistant' &&
        message.eventType === 'message' &&
        !message.parentAgentId
      ) {
        return true;
      }
    }
    return false;
  }

  // 把费用/耗时挂到本回合最后一条 assistant 消息上（文本或 tool_use 均可），
  // 这样纯工具回合也能展示 cost/duration；回溯到上一回合的用户消息即停止。
  function attachResultMetadata(event: CliResultEvent): void {
    const messages = store.messages;
    // 问题 2：第三方端点（如 glm-5.2）可能不回报 duration_ms，用客户端计时（本回合开始→现在）
    // 兜底，保证气泡始终能展示「花了多少时间」。result 到达时 turnStartedAt 尚未清除。
    const sid = store.activeSession?.id;
    const startedAt = sid ? store.turnStartedAt[sid] : null;
    const clientMs = startedAt ? Date.now() - startedAt : null;
    // R1（二次修复）：sdk-backend 把缺失的 total_cost_usd/duration_ms 补成 0（非 undefined），
    // `??` 对 0 不生效会屏蔽客户端兜底。改用真值判断：>0 用端点值，否则 cost 置 null（不显示
    // $0.0000）、duration 回落客户端计时（用户「把最终时间映射到耗时」诉求）。
    const cost = event.total_cost_usd;
    const duration = event.duration_ms;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === 'user') break;
      if (message.role === 'assistant') {
        message.costUsd = typeof cost === 'number' && cost > 0 ? cost : null;
        message.durationMs = typeof duration === 'number' && duration > 0 ? duration : clientMs;
        break;
      }
    }
  }

  async function sendMessage(text: string): Promise<void> {
    if (!store.activeSession || !text.trim()) return;

    // 新回合开始：作废上一回合 abort 残留的超时兜底，避免它到点把本次 sending 错误复位。
    clearAbortTimer(store.activeSession.id);
    resetTurnCache();
    error.value = null;
    // 根因修复：markRunning 加入 runningSessions，sending getter 自动变 true。
    store.markRunning(store.activeSession.id);

    persistMessage({ role: 'user', eventType: 'message', content: text.trim(), processKind: null });
    // 力度② turn 边界：本回合 assistant 消息从此索引开始。MessageList 据此在发送中
    // （且对应流式非空）隐藏本回合已落库的 text/thinking，避免与流式块重复显示。
    store.turnStartIndex = store.messages.length;

    try {
      // 监听已在 App.vue 全局注册，这里不重复 startListening。
      await window.claudeLink.sendMessage(store.activeSession.id, text.trim());
    } catch (e) {
      error.value = e instanceof Error ? e.message : '发送失败';
      if (store.activeSession) store.markStopped(store.activeSession.id);
    }
  }

  // 中断当前回合（try-finally 兜底确保最终停止）。
  // try：不立即 stopListening——*nix 上 SIGINT 后 CC 会发回 result(error_during_execution)，
  //   含费用/耗时元数据，应让它到达而非丢弃；收到 result/error/aborted 即 clearAbortTimer（finally 提前满足）。
  // finally：ensureAbortFinally 到点强制 markStopped——无论 SDK 中断信号是否真生效、
  //   结束事件是否回来（Windows 硬杀会丢 result）、用户是否切会话，都必然复位为已停止。
  async function abort(): Promise<void> {
    if (!store.activeSession) return;
    const sid = store.activeSession.id;
    clearAbortTimer(sid); // 清旧兜底（防重复 / 上一回合残留）
    // 乐观更新：点击中断瞬间立即复位 running + 清当前流式，UI 立即停止"执行中"。
    // Windows 硬杀时 SDK 的 result/aborted 事件常丢失，不能再等 1200ms 兜底才反馈。
    // 后续 result/aborted 若到达，markStopped 幂等 no-op。
    finalizeAssistantStream();
    store.clearStream();
    store.clearThinking();
    store.clearToolStream();
    resetTurnCache();
    store.markStopped(sid);
    try {
      await window.claudeLink.abortChat(sid);
    } catch {
      // ignore：finally 不依赖 abortChat 成功
    }
    // 兜底保留作为最终保险（乐观路径已 markStopped，这里 no-op）
    ensureAbortFinally(sid);
  }

  // 卡死恢复：重发最后一条用户消息（abort 旧 query → 新 query + resume）。
  // 复用既有 sendMessage/abortChat IPC，无需新通道。
  // 已知特性（设计取舍，非 bug）：
  //  1) sendMessage 会再持久化一条 user 消息 → 历史里出现重复的同一提问气泡。
  //     这是「显式重问」语义（stall 后重新发起一回合），而非静默续传，保留可见性。
  //  2) 主进程 killProcess 会立即把旧 entry 标为 aborting 并移出 active entries，
  //     因此重试不再依赖固定等待来避免 message dropped；这里的短延迟只用于事件排序缓冲。
  //  3) lastUserText 假定「卡死的回合已持久化自己的 user 消息」——sendMessage 始终如此。
  function lastUserText(): string | null {
    const msgs = store.messages;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i].role === 'user') return msgs[i].content;
    }
    return null;
  }
  async function retryLastTurn(): Promise<void> {
    if (!store.activeSession) return;
    const sid = store.activeSession.id;
    // 重入锁：仅在确有卡死标记时重试（横幅可见 ⟺ stalledInfo[sid] 已置）。
    // 防止用户连点重试导致多次 abortChat + 多次 sendMessage（重复用户气泡 + 重复 query）。
    if (!store.stalledInfo[sid]) return;
    const last = lastUserText();
    store.clearStalled(sid);
    if (!last) return;
    try {
      await window.claudeLink.abortChat(sid);
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 200));
    await sendMessage(last);
  }

  return { sending, error, sendMessage, abort, retryLastTurn, startListening, stopListening };
}

// 根因修复：useChat 返回全局单例。监听在 App.vue onMounted 注册一次，
// 生命周期与 app 等长，ChatPage 卸载/重挂载不影响监听与 sending 状态。
export function useChat() {
  if (!chatSingleton) {
    chatSingleton = createChat();
  }
  return chatSingleton;
}
