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

export type CliMessageContentPart =
  | CliMessageContentTextPart
  | CliMessageContentToolUsePart
  | CliMessageContentToolResultPart
  | CliMessageContentThinkingPart
  | CliMessageContentRedactedThinkingPart;

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
}

export interface CliStreamEvent {
  type: 'stream_event';
  event: {
    type?: string;
    index?: number;
    content_block?: { type: 'thinking' | 'text' | 'tool_use'; [k: string]: unknown };
    delta: {
      type: 'text_delta' | 'input_json_delta' | 'thinking_delta' | 'signature_delta';
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

export type CliEvent =
  | CliInitEvent
  | CliSystemInitEvent
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
