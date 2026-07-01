export interface Session {
  id: string;
  name: string;
  cliSessionId: string | null;
  model: string;
  modelOverride: string | null;
  workingDir: string | null;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
  lastContextTokens: number | null;
  lastContextUpdatedAt: string | null;
  // 该会话从 SDK result.modelUsage.contextWindow 拿到的真实上下文窗口（持久化）。
  // 切换会话重建 contextStats 时优先用它，避免回落到 200k 兜底。null 表示尚未连通过。
  lastContextWindow: number | null;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  rawEvent: string | null;
  eventType: string | null;
  costUsd: number | null;
  durationMs: number | null;
  parentTaskId: string | null;
  // 过程类型最小颗粒度分类键（见 src/shared/process-kind.ts）。text 正文为 null。
  processKind: string | null;
  // 子 agent 归属：来自 assistant 消息的 parent_tool_use_id。非空 → 该消息属子 agent，
  // 不进主聊天流，抽到右侧「子Agent」Tab；主流程对应位置只留锚点。
  parentAgentId: string | null;
  // 工具调用 ID：tool_use 与其 tool_result 配对合并的依据。
  toolUseId: string | null;
  // 子 agent 的友好标题（Agent/Task 工具 input.description），用于 Tab 分组标题与锚点。
  title: string | null;
  // 工具结果是否失败（tool_result.is_error）。仅 tool 角色消息有意义，其余恒为 false。
  isError: boolean;
  createdAt: string;
}
