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

export type CliMessageContentPart =
  | CliMessageContentTextPart
  | CliMessageContentToolUsePart
  | CliMessageContentToolResultPart
  | CliMessageContentThinkingPart
  | CliMessageContentRedactedThinkingPart
  | CliMessageContentServerToolUsePart
  | CliMessageContentWebSearchToolResultPart
  | CliMessageContentWebFetchToolResultPart;

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
    content_block?: { type: 'thinking' | 'text' | 'tool_use'; [k: string]: unknown };
    delta: {
      type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta' | 'citations_delta';
      text?: string;
      partial_json?: string;
      thinking?: string;
      signature?: string;
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

// 系统横幅类事件（CC 的 system 子类型，非 init）。落库 processKind = system:<subtype>。
export interface CliSystemInfoEvent {
  type: 'system';
  subtype: 'informational' | 'compact_boundary' | 'plugin_install';
  text?: string;
  level?: 'info' | 'warn';
}

// 权限事件：自动拒绝 / 权限询问。落库 processKind = permission。
export interface CliPermissionEvent {
  type: 'system';
  subtype: 'permission_denied';
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
  | CliAbortedEvent;

export interface CliDetectionResult {
  installed: boolean;
  path: string | null;
  version: string | null;
}
