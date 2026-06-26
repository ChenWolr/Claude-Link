// group-messages.ts
// 消息 → 渲染分组（openhanako 风格：整回合过程合并成 fold）。
// 主流程（MessageList）与子 Agent 面板（TaskQueuePanel）共用同一规则。
//
// 规则（对齐 openhanako desktop/src/react/components/chat/process-fold.ts）：
//   - processKind === null（正文 text）→ 独立 message 项，打断 fold（保留多段正文原位）；
//   - 连续的过程消息（thinking / tool_use / tool_result / system）合并成一个 fold，
//     折叠成一行居中摘要「✨ Claude 忙活了一阵子 · N 个工具 · N 次思考」；
//   - fold 内 tool_use 与其 tool_result 按 toolUseId 配对（ToolCallBlock 行内合并）；
//   - 少于 MIN_FOLD 条过程的 fold 不折叠（直接展开行式），避免很短也收起；
//   - 调用方负责先按 parentAgentId 过滤（主流程只取 null，子 Agent 面板只取非 null）。

import type { Message } from '../../shared/types/session';

export interface FoldStats {
  toolCount: number;
  thinkingCount: number;
  /** 是否有进行中的工具（tool_use 无配对 tool_result）。 */
  running: boolean;
}

export type RenderItem =
  | { key: string; type: 'message'; message: Message }
  | { key: string; type: 'fold'; messages: Message[]; stats: FoldStats };

/** 连续多少条过程才折叠成居中摘要（少于则直接展开行式）。对齐 openhanako MIN_PROCESS_MESSAGES_TO_FOLD。 */
export const MIN_FOLD = 3;

export function computeStats(messages: Message[]): FoldStats {
  let toolCount = 0;
  let thinkingCount = 0;
  const uses = new Set<string>();
  const results = new Set<string>();
  for (const m of messages) {
    if (m.eventType === 'thinking' || m.processKind === 'thinking' || m.processKind === 'redacted_thinking') {
      thinkingCount += 1;
    }
    if (m.eventType === 'tool_use') {
      toolCount += 1;
      if (m.toolUseId) uses.add(m.toolUseId);
    }
    if (m.eventType === 'tool_result' && m.toolUseId) results.add(m.toolUseId);
  }
  let running = false;
  for (const id of uses) if (!results.has(id)) running = true;
  return { toolCount, thinkingCount, running };
}

export function groupMessagesForRender(messages: Message[]): RenderItem[] {
  const items: RenderItem[] = [];
  let fold: Extract<RenderItem, { type: 'fold' }> | null = null;
  const close = () => {
    if (fold) {
      fold.stats = computeStats(fold.messages);
      items.push(fold);
      fold = null;
    }
  };
  for (const msg of messages) {
    if (msg.processKind === null) {
      close();
      items.push({ key: msg.id, type: 'message', message: msg });
      continue;
    }
    if (!fold) {
      fold = { key: msg.id, type: 'fold', messages: [], stats: { toolCount: 0, thinkingCount: 0, running: false } };
    }
    fold.messages.push(msg);
  }
  close();
  return items;
}

/** fold 是否可折叠（≥MIN_FOLD 条过程才折叠，否则直接展开行式）。 */
export function isFoldable(messageCount: number): boolean {
  return messageCount >= MIN_FOLD;
}
