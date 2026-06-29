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
//   code_execution_tool_result → 'tool:code_execution'

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
    case 'code_execution_tool_result':
      return 'tool:code_execution';
    case 'mcp_tool_use':
      return `tool:${part.name}`;
    case 'mcp_tool_result':
      return 'tool:result';
    default:
      return null;
  }
}

// tool_use 且为「会派生子 agent」的工具时，提取友好标题，用于右侧「子Agent」Tab 的分组标题
// 与主流程锚点，避免出现「子任务1/子任务2」。Agent/Task 必然派生子 agent；Skill 在 context:fork、
// Workflow 在多 agent 编排时也会派生（其 tool_use_id 被子 agent 事件的 parent_tool_use_id 引用），
// 一并提取标题。title 字段只在产生子 agent 时被消费，不产生时设置也无副作用。
export function extractSubAgentTitle(part: CliMessageContentPart): string | null {
  if (part.type !== 'tool_use') return null;
  const input = part.input as Record<string, unknown>;
  let raw: unknown;
  switch (part.name) {
    case 'Agent':
    case 'Task':
      raw = input.description;
      break;
    case 'Skill':
      raw = input.name;
      break;
    case 'Workflow':
      raw = input.description ?? input.name;
      break;
    default:
      return null;
  }
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}
