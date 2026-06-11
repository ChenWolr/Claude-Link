export interface CliInitEvent {
  type: 'init';
  session_id: string;
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
  content?: string;
}

export type CliMessageContentPart =
  | CliMessageContentTextPart
  | CliMessageContentToolUsePart
  | CliMessageContentToolResultPart;

export interface CliMessageEvent {
  type: 'message';
  role: 'user' | 'assistant';
  content: CliMessageContentPart[];
}

export interface CliStreamEvent {
  type: 'stream_event';
  event: {
    delta: {
      type: 'text_delta' | 'input_json_delta';
      text?: string;
      partial_json?: string;
    };
  };
}

export interface CliResultEvent {
  type: 'result';
  subtype: 'success' | 'error';
  result: string;
  total_cost_usd: number;
  duration_ms: number;
  num_turns: number;
  session_id: string;
  is_error: boolean;
}

export type CliEvent = CliInitEvent | CliMessageEvent | CliStreamEvent | CliResultEvent;

export interface CliDetectionResult {
  installed: boolean;
  path: string | null;
  version: string | null;
}
