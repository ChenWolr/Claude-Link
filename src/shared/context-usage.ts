import type { CliUsage } from './types/cli';
import type { CliEvent, CliSystemInfoEvent } from './types/cli';

// 上下文用量 = 本次请求送入的全部 token（input + 两种 cache）。
// output_tokens 不计入上下文（那是生成量）。缺字段按 0。
export function extractContextTokens(usage: CliUsage | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return input + cacheCreate + cacheRead;
}

// CC 自动压缩事件检测结果。compactedJustNow=true 表示本次流里发生了自动压缩。
// fromTokens/toTokens 预留给未来 CC 若在 compact_boundary 事件里携带压缩前后 token 数；
// 当前 CliSystemInfoEvent 类型只保证 text/level，没有 token 字段，故暂不解析。
export interface CompactionResult {
  compactedJustNow: true;
  fromTokens?: number;
  toTokens?: number;
}

// 检测一个 CliEvent 是否为 CC 自动压缩事件（system + subtype 'compact_boundary'）。
// 返回 CompactionResult（带 compactedJustNow:true）或 null（非压缩事件）。
// process-manager 收到此结果后，会 emit CONTEXT_UPDATE 带 compactedJustNow=true，
// ContextButton 据此弹横幅回显「Claude Code 已自动压缩上下文」。
export function detectCompaction(event: CliEvent): CompactionResult | null {
  if (event.type !== 'system') return null;
  const sys = event as CliSystemInfoEvent;
  if (sys.subtype !== 'compact_boundary') return null;
  return { compactedJustNow: true };
}
