// process-kind.ts（shared）
// 过程类型的最小颗粒度分类键。被主进程（落库）与渲染层（实时 addMessage）共用，
// 保证两条路径对同一个 part 产出相同的 processKind，从而历史回读与实时显示分组一致。
//
// 分类规则（见 docs/claude-code-skill-kind-wirth.md「过程类型穷举」）：
//   text              → null（正文，唯一「结果」，独立气泡，打断过程组）
//   thinking          → 'thinking'
//   redacted_thinking → 'redacted_thinking'
//   tool_use          → 'tool:<name>'（每个工具各自一类，最小颗粒度）
//   server_tool_use   → 'tool:<name>'
//   tool_result       → 'tool:result'（调用方在已知工具名时应覆盖为 tool:<name>；
//                       否则由渲染层按 toolUseId 回查配对的 tool_use 合并到同组）
//   web_search_tool_result → 'tool:web_search'
//   web_fetch_tool_result  → 'tool:web_fetch'

import type { CliMessageContentPart } from './types/cli';

export function processKindFromPart(part: CliMessageContentPart): string | null {
  switch (part.type) {
    case 'text':
      return null;
    case 'thinking':
      return 'thinking';
    case 'redacted_thinking':
      return 'redacted_thinking';
    case 'tool_use':
      return `tool:${part.name}`;
    case 'server_tool_use':
      return `tool:${part.name}`;
    case 'tool_result':
      return 'tool:result';
    case 'web_search_tool_result':
      return 'tool:web_search';
    case 'web_fetch_tool_result':
      return 'tool:web_fetch';
    default:
      return null;
  }
}

// tool_use 且为子 agent（Agent/Task 工具）时，从 input.description 提取友好标题。
// 用于右侧「子Agent」Tab 的分组标题与主流程锚点，避免出现「子任务1/子任务2」。
export function extractSubAgentTitle(part: CliMessageContentPart): string | null {
  if (part.type !== 'tool_use') return null;
  if (part.name !== 'Agent' && part.name !== 'Task') return null;
  const desc = (part.input as { description?: unknown }).description;
  return typeof desc === 'string' && desc.trim() ? desc.trim() : null;
}
