// turn-boundary.ts
// 回合边界纯函数（P1-3）：直发（use-chat）、切回恢复（session-store.switchSession）、
// 队列回合（task-store 的 user_message_created）三处共用同一 turnStartIndex 口径，
// MessageList 流式去重的 turnIds 从该索引起算。

import type { Message } from './types/session';

/**
 * 计算回合起始索引：最后一条主流程 user 消息的下一位置（本回合 assistant 内容的左边界）。
 * 无 user 消息时返回 messages.length（全部视为历史，不参与当前回合去重）；
 * 空消息数组即返回 0。
 */
export function computeTurnStartIndex(messages: ReadonlyArray<Pick<Message, 'role'>>): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return i + 1;
  }
  return messages.length;
}

/**
 * 流式去重谓词（P1-5 收窄 + N12 前缀化）：已落库消息 content 以流式块为「被覆盖」关系判定——
 * streamingContent 以已落库内容为**前缀（或相等）**即隐藏该已落库气泡。
 *
 * 背景：P1-5 的「完全一致」谓词覆盖不了后台会话流式快照残留——切回时快照=已落库前缀+新尾巴，
 * 永不相等 → 双显（N12）。前缀匹配一并消掉该链路；空串不构成前缀（防空内容通配误隐藏）。
 * 已知边界（审计 P1-5 条目）：同回合两段正文前段恰为后段前缀的瞬态误隐藏——自愈
 * （落库即清后段落分离），触发罕见，可接受。
 */
export function shouldHidePersistedForStreaming(persistedContent: string, streamingContent: string): boolean {
  if (!persistedContent || !streamingContent) return false;
  return streamingContent.startsWith(persistedContent);
}
