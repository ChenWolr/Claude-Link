// group-messages.ts
// 消息 → 渲染分组（openhanako 风格：整回合过程合并成 fold）。
// 主流程（MessageList）与子 Agent 面板（TaskQueuePanel）共用同一规则。
//
// 规则（对齐 openhanako desktop/src/react/components/chat/process-fold.ts）：
//   - 折叠单位近似为「连续过程记录」；正文分三类：
//     · user 消息 → 独立 message 项（天然回合边界）；
//     · assistant 正文 text → 短叙事（≤PROCESS_NARRATION_TEXT_LIMIT，非回合最终）并入 fold；
//       回合最终文本（protectedFinalTextIds 标记）与长正文 → 独立 message 项（打断 fold）；
//   - 连续过程（thinking / tool_use / tool_result / system）合并成一个 fold，
//     折叠成一行居中摘要「✨ Claude 忙活了一阵子 · N 个工具 · N 次思考」；
//   - fold 内 tool_use 与其 tool_result 按 toolUseId 配对（ToolCallBlock 行内合并）；
//   - 少于 MIN_FOLD 条过程的 fold 不折叠（直接展开行式），避免很短也收起；
//   - 调用方负责先按 parentAgentId 过滤（主流程只取 null，子 Agent 面板只取非 null）。

import type { RenderableMessage } from '../../shared/types/export-image';
import { isRedundantSystemProcessKind } from '../../shared/system-info';

export interface FoldStats {
  toolCount: number;
  thinkingCount: number;
  /** 是否有进行中的工具（tool_use 无配对 tool_result）。 */
  running: boolean;
}

// RenderItem 基于 RenderableMessage 最小契约；完整 Message 是其超集，调用方传 Message[] 仍兼容。
export type RenderItem =
  | { key: string; type: 'message'; message: RenderableMessage }
  | { key: string; type: 'fold'; messages: RenderableMessage[]; stats: FoldStats };

/** 连续多少条过程才折叠成居中摘要（少于则直接展开行式）。对齐 openhanako MIN_PROCESS_MESSAGES_TO_FOLD。 */
export const MIN_FOLD = 3;

/** 短过程叙事文本上限（字符数）。对齐 openhanako PROCESS_NARRATION_TEXT_LIMIT。 */
export const PROCESS_NARRATION_TEXT_LIMIT = 100;

/** 是否为 assistant 正文 text（区别于 tool_use / thinking / system 过程记录）。 */
function isAssistantBodyText(m: RenderableMessage): boolean {
  return m.role === 'assistant' && m.eventType === 'message' && m.processKind === null;
}

/** 是否为短过程叙事文本（正文，但长度短到可视为过程旁白，不打断 fold）。 */
function isShortNarration(m: RenderableMessage): boolean {
  return isAssistantBodyText(m) && m.content.trim().length <= PROCESS_NARRATION_TEXT_LIMIT;
}

// 对齐 openhanako protectedFinalTextIndexes：按 user 消息分回合，标记每回合最后一条
// assistant 正文 text 为「受保护最终文本」——它是回合的结论性总结，必须独立展示、不得折叠。
function protectedFinalTextIds(messages: RenderableMessage[]): Set<string> {
  const protectedIds = new Set<string>();
  let latestTextId: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      if (latestTextId) protectedIds.add(latestTextId);
      latestTextId = null;
      continue;
    }
    if (isAssistantBodyText(m)) latestTextId = m.id;
  }
  if (latestTextId) protectedIds.add(latestTextId);
  return protectedIds;
}

export function computeStats(messages: RenderableMessage[]): FoldStats {
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

export function groupMessagesForRender(messages: RenderableMessage[]): RenderItem[] {
  const protectedIds = protectedFinalTextIds(messages);
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
    // R2（问题 5）：权限询问 + 交互回执已由交互弹窗承载，不在聊天流重复渲染（仍落库留审计）。
    // 在此单一瓶颈过滤，同时覆盖主流程（MessageList）与子 Agent 面板（TaskQueuePanel→ProcessGroup）。
    if (isRedundantSystemProcessKind(msg.processKind)) continue;
    // 独立 message 项（打断 fold）：
    //   · review-v2 P1：init_write_skipped 是 /init 的独立文件副作用诊断，须独立展示（不进 fold）；
    //   · F5 复验发现：interaction_cancelled 是「弹窗被系统取消」的用户可见反馈（计划 §2.5.4
    //     红色系统消息），折进过程组会被淹没，须独立成条（MessageBubble bubble--error 红样式）；
    //   · user 消息是回合边界；
    //   · assistant 正文的「回合最终文本」受保护、「长正文」是结论性回复，均打断 fold。
    const isBreak =
      msg.processKind === 'system:init_write_skipped' ||
      msg.processKind === 'system:interaction_cancelled' ||
      msg.role === 'user' ||
      (isAssistantBodyText(msg) && (protectedIds.has(msg.id) || !isShortNarration(msg)));
    if (isBreak) {
      close();
      items.push({ key: msg.id, type: 'message', message: msg });
      continue;
    }
    // 其余进 fold：过程（tool_use / tool_result / thinking / 非冗余 system）＋ 短过程叙事文本。
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
