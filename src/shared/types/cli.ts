export interface CliInitEvent {
  type: 'init';
  session_id: string;
}

// 新版 CC stream-json 用 {type:'system',subtype:'init'} 形态（带 model 等）。
export interface CliSystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  model?: string;
}

export interface CliMessageContentTextPart {
  type: 'text';
  text: string;
  // web search 等服务端工具返回的引用来源（依赖后端实现 server tools；当前代理端点不触发）。
  // 仅保留类型，渲染后置——避免引用信息无处承载。对应流式 CliStreamEvent.delta.citation。
  citations?: Array<{ type: string; url?: string; title?: string; [k: string]: unknown }>;
}

export interface CliMessageContentToolUsePart {
  type: 'tool_use';
  name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
}

export interface CliMessageContentToolResultPart {
  type: 'tool_result';
  tool_use_id?: string;
  // CC 真实事件里 content 可能是 string，也可能是 [{type:'text',text}] 等数组
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  // 工具执行失败标记（Bash 非零退出、Edit 未命中、权限拒绝等）。用于 UI 标红失败工具。
  is_error?: boolean;
}

export interface CliMessageContentThinkingPart {
  type: 'thinking';
  thinking: string;
  signature?: string;
}

export interface CliMessageContentRedactedThinkingPart {
  type: 'redacted_thinking';
  data?: string;
}

// 服务端工具（由 API 侧执行，区别于客户端 tool_use）：web_search / web_fetch 等。
// processKind 仍归 tool:<name>，与普通工具统一渲染。
export interface CliMessageContentServerToolUsePart {
  type: 'server_tool_use';
  name: string;
  input: Record<string, unknown>;
  id?: string;
}

export interface CliMessageContentWebSearchToolResultPart {
  type: 'web_search_tool_result';
  tool_use_id?: string;
  content?: unknown;
}

export interface CliMessageContentWebFetchToolResultPart {
  type: 'web_fetch_tool_result';
  tool_use_id?: string;
  content?: unknown;
}

// 服务端 code execution（沙箱执行代码）结果块，与 web_search_tool_result 同族。
// 依赖后端实现 Anthropic server tools；当前代理端点不触发，补全类型避免静默丢弃。
export interface CliMessageContentCodeExecutionToolResultPart {
  type: 'code_execution_tool_result';
  tool_use_id?: string;
  content?: unknown;
}

// L6：MCP 工具调用/结果块。MCP 工具名形如 mcp__<server>__<tool>，与普通 tool_use 同族。
// 当前代理端点不触发，补全类型避免静默丢弃；persistMessageParts 已有兜底日志兜住新形态。
export interface CliMessageContentMcpToolUsePart {
  type: 'mcp_tool_use';
  name: string;
  input: Record<string, unknown>;
  tool_use_id?: string;
  server_name?: string;
}

export interface CliMessageContentMcpToolResultPart {
  type: 'mcp_tool_result';
  tool_use_id?: string;
  content?: string | Array<{ type: string; text?: string; [k: string]: unknown }>;
  is_error?: boolean;
}

export type CliMessageContentPart =
  | CliMessageContentTextPart
  | CliMessageContentToolUsePart
  | CliMessageContentToolResultPart
  | CliMessageContentThinkingPart
  | CliMessageContentRedactedThinkingPart
  | CliMessageContentServerToolUsePart
  | CliMessageContentWebSearchToolResultPart
  | CliMessageContentWebFetchToolResultPart
  | CliMessageContentCodeExecutionToolResultPart
  | CliMessageContentMcpToolUsePart
  | CliMessageContentMcpToolResultPart;

export interface CliUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CliMessageEvent {
  type: 'message';
  role: 'user' | 'assistant';
  content: CliMessageContentPart[];
  usage?: CliUsage;
  // 子 agent（Task/Agent 工具）消息透传的 parent_tool_use_id：用于把子 agent 过程
  // 归属到主流程的对应工具，抽到右侧"子Agent"Tab，主聊天流只留锚点。
  parentToolUseId?: string;
}

export interface CliStreamEvent {
  type: 'stream_event';
  event: {
    type?: string;
    index?: number;
    content_block?: { type: 'thinking' | 'text' | 'tool_use' | 'redacted_thinking'; [k: string]: unknown };
    delta: {
      // L7：补 compaction_content_delta（CC 自动压缩摘要的流式增量），其余为已知 delta。
      type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta' | 'citations_delta' | 'compaction_content_delta';
      text?: string;
      partial_json?: string;
      thinking?: string;
      signature?: string;
      // citations_delta 携带的单条引用增量（依赖 web search 后端）。当前仅保留类型，渲染后置。
      citation?: { type: string; url?: string; title?: string; [k: string]: unknown };
    };
  };
}

export interface CliResultEvent {
  type: 'result';
  // CC 真实 subtype：success / error_max_turns / error_during_execution（含中断）/
  // error_max_budget_usd / error_max_structured_output_retries / error 等。
  subtype: 'success' | 'error' | 'error_max_turns' | 'error_during_execution' | string;
  result: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  session_id: string;
  is_error: boolean;
  usage?: CliUsage;
  // H2：SDK result 的 modelUsage，含真实 contextWindow（供 ContextButton 占比，避免按默认 200000 失真）。
  modelUsage?: Record<string, { contextWindow?: number }>;
}

export interface CliErrorEvent {
  type: 'error';
  message: string;
  code?: number | null;
}

// 中断/结束的本地合成事件（process-manager 在 interrupted 或 0 退出无 result 时发出）。
export interface CliAbortedEvent {
  type: 'aborted';
  message: string;
}

// tool_progress：工具运行中周期进度（SDK worker 本地计时器周期 emit）。瞬态不落库。
export interface CliToolProgressEvent {
  type: 'tool_progress';
  toolUseId: string;
  toolName?: string;
  parentToolUseId?: string;
  elapsedSeconds: number;
}

// task_*：后台任务编排（后台 Bash / Monitor / 后台子 Agent）。system 子类型，瞬态不落库。
export interface CliTaskEvent {
  type: 'system';
  subtype: 'task_started' | 'task_progress' | 'task_notification';
  taskId: string;
  toolUseId?: string;
  description?: string;
  taskType?: 'local_bash' | 'local_agent' | 'remote_agent';
  status?: 'completed' | 'failed' | 'stopped';
  usage?: { totalTokens?: number; toolUses?: number; durationMs?: number };
  lastToolName?: string;
  summary?: string;
}

// 系统横幅类事件（CC 的 system 子类型，非 init）。落库 processKind = system:<subtype>。
export interface CliSystemInfoEvent {
  type: 'system';
  subtype: 'informational' | 'compact_boundary' | 'plugin_install' | 'permission_request' | 'interaction_response' | 'api_retry' | 'compacting' | 'compact_result' | 'compact_error' | 'requesting';
  text?: string;
  level?: 'info' | 'warn';
  // api_retry 专属：API 重试进度（限流/过载/鉴权失败等，每次重试前发出）。
  // error 取值：authentication_failed / rate_limit / overloaded / invalid_request / server_error 等。
  attempt?: number;
  max_retries?: number;
  error?: string;
  // M5：压缩结果（status.compact_result）。'success' | 'failed'。
  compactResult?: 'success' | 'failed';
  // M5：压缩失败原因（status.compact_error）。
  compactError?: string;
}

// 权限事件：权限询问 / 自动拒绝。落库 processKind = permission。
export interface CliPermissionEvent {
  type: 'system';
  subtype: 'permission_request' | 'permission_denied';
  tool_name?: string;
  tool_use_id?: string;
  message?: string;
}

export type CliEvent =
  | CliInitEvent
  | CliSystemInitEvent
  | CliSystemInfoEvent
  | CliPermissionEvent
  | CliMessageEvent
  | CliStreamEvent
  | CliResultEvent
  | CliErrorEvent
  | CliAbortedEvent
  | CliToolProgressEvent
  | CliTaskEvent;

export interface CliDetectionResult {
  installed: boolean;
  path: string | null;
  version: string | null;
}
