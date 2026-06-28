// progress-events.ts
// C（进度状态层）：SDK observability 进度消息 → CliEvent 的纯转换函数。
// 独立纯模块（无 electron / DB 依赖），便于 tsx 行为测试；sdk-backend import 复用，
// 避免转换函数内联在主进程模块里导致测试无法 import（regression-tests.ts 同样不 import sdk-backend）。
import type { CliToolProgressEvent, CliTaskEvent } from './types/cli';

// SDK tool_progress（工具运行中周期进度，worker 本地计时器）→ CliToolProgressEvent。
export function convertToolProgress(sdkMsg: Record<string, unknown>): CliToolProgressEvent {
  return {
    type: 'tool_progress',
    toolUseId: typeof sdkMsg.tool_use_id === 'string' ? sdkMsg.tool_use_id : '',
    toolName: typeof sdkMsg.tool_name === 'string' ? sdkMsg.tool_name : undefined,
    parentToolUseId: typeof sdkMsg.parent_tool_use_id === 'string' ? sdkMsg.parent_tool_use_id : undefined,
    elapsedSeconds: typeof sdkMsg.elapsed_time_seconds === 'number' ? sdkMsg.elapsed_time_seconds : 0,
  };
}

// SDK task_started / task_progress / task_notification（后台 Bash / Monitor / 后台子 Agent 编排）
// → CliTaskEvent。usage 字段 snake_case → camelCase。
export function convertTaskEvent(
  subtype: 'task_started' | 'task_progress' | 'task_notification',
  sdkMsg: Record<string, unknown>,
): CliTaskEvent {
  const usageRaw = sdkMsg.usage as
    | { total_tokens?: number; tool_uses?: number; duration_ms?: number }
    | undefined;
  return {
    type: 'system',
    subtype,
    taskId: typeof sdkMsg.task_id === 'string' ? sdkMsg.task_id : '',
    toolUseId: typeof sdkMsg.tool_use_id === 'string' ? sdkMsg.tool_use_id : undefined,
    description: typeof sdkMsg.description === 'string' ? sdkMsg.description : undefined,
    taskType:
      typeof sdkMsg.task_type === 'string' ? (sdkMsg.task_type as CliTaskEvent['taskType']) : undefined,
    status: typeof sdkMsg.status === 'string' ? (sdkMsg.status as CliTaskEvent['status']) : undefined,
    usage: usageRaw
      ? {
          totalTokens: typeof usageRaw.total_tokens === 'number' ? usageRaw.total_tokens : undefined,
          toolUses: typeof usageRaw.tool_uses === 'number' ? usageRaw.tool_uses : undefined,
          durationMs: typeof usageRaw.duration_ms === 'number' ? usageRaw.duration_ms : undefined,
        }
      : undefined,
    lastToolName: typeof sdkMsg.last_tool_name === 'string' ? sdkMsg.last_tool_name : undefined,
    summary: typeof sdkMsg.summary === 'string' ? sdkMsg.summary : undefined,
  };
}
