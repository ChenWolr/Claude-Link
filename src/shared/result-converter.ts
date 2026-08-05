// result-converter.ts
// SDK result → CliResultEvent 转换（纯函数，不依赖 Electron，可被 selftest 直接行为测试）。
// 原实现位于 sdk-backend.ts 内部，因 F1 需要「原始 SDK 输入走完整转换后再断言终态语义」而提取到共享层。

import type { CliResultEvent } from './types/cli';

// SDK result → CliResultEvent（字段一一对应）。
export function convertResultMessage(sdkMsg: Record<string, unknown>): CliResultEvent {
  const rawErrors = Array.isArray(sdkMsg.errors) ? sdkMsg.errors : [];
  const errors = rawErrors
    .map((item) => (typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as { message?: unknown }).message === 'string' ? (item as { message: string }).message : ''))
    .filter((item) => item.trim().length > 0);
  return {
    type: 'result',
    // F1：保留真实 subtype——只有原始值是字符串才写入，缺失（undefined/null）保持 undefined。
    // 严禁无条件 ?? 'success'：第三方端点 is_error=true 但无 subtype 时，若补成 success 会被
    // isSuccessfulCliResult 误判为成功（错误亮绿灯 + 弹「任务已完成」通知）。
    subtype: typeof sdkMsg.subtype === 'string' ? (sdkMsg.subtype as string) : undefined,
    result: (sdkMsg.result as string) ?? '',
    total_cost_usd: (sdkMsg.total_cost_usd as number) ?? 0,
    duration_ms: (sdkMsg.duration_ms as number) ?? 0,
    num_turns: (sdkMsg.num_turns as number) ?? 0,
    session_id: (sdkMsg.session_id as string) ?? '',
    is_error: Boolean(sdkMsg.is_error),
    ...(errors.length > 0 ? { errors } : {}),
    terminalReason: typeof sdkMsg.terminal_reason === 'string' ? sdkMsg.terminal_reason : undefined,
    apiErrorStatus: typeof sdkMsg.api_error_status === 'number' ? sdkMsg.api_error_status : null,
    stopReason: typeof sdkMsg.stop_reason === 'string' ? sdkMsg.stop_reason : null,
    usage: (sdkMsg.usage as CliResultEvent['usage']) ?? undefined,
    modelUsage: (sdkMsg.modelUsage as CliResultEvent['modelUsage']) ?? undefined,
  };
}
