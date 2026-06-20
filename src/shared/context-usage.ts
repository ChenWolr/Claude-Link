import type { CliUsage } from './types/cli';

// 上下文用量 = 本次请求送入的全部 token（input + 两种 cache）。
// output_tokens 不计入上下文（那是生成量）。缺字段按 0。
export function extractContextTokens(usage: CliUsage | undefined): number {
  if (!usage) return 0;
  const input = usage.input_tokens ?? 0;
  const cacheCreate = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  return input + cacheCreate + cacheRead;
}
