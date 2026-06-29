// subagent-groups.ts
// 子 Agent Tab（TaskQueuePanel）的纯聚合/过滤/耗时逻辑。
// 从 TaskQueuePanel.vue 抽出，使其可被行为测试覆盖（项目无 jest/vitest，靠 tdd-*-verify.ts）。
//
// 三类逻辑：
//   - computeElapsedSeconds：耗时来源优先级（实时 tool_progress → durationMs 累加 → createdAt 时间戳差）
//   - filterCurrentTurnItems：发送中隐藏本回合已落库 text/thinking（与 MessageList turn-boundary 同思路）
//   - aggregateSubAgentGroups：从 turnStartIndex 之后聚合 parentAgentId 消息成组（方案 A：保留 DB 历史，仅控制 Tab 显示）

import type { Message } from '../../shared/types/session';
import { computeStats, groupMessagesForRender, type RenderItem } from './group-messages';

export function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—';
  return `${seconds.toFixed(1)}s`;
}

// 耗时来源优先级：running 工具的实时 tool_progress（最高优先，秒级整数）→ 已完成消息 durationMs 累加 →
// 消息 createdAt 时间戳首尾差（兜底，无 usage 时）。三者皆无 → null（显示「—」）。
export function computeElapsedSeconds(
  messages: Message[],
  toolProgress: Record<string, number>,
): number | null {
  const liveSeconds = messages
    .map((m) => (m.toolUseId ? toolProgress[m.toolUseId] : undefined))
    .filter((s): s is number => typeof s === 'number');
  if (liveSeconds.length > 0) return Math.max(...liveSeconds);

  const durationMs = messages.reduce((sum, m) => sum + (m.durationMs ?? 0), 0);
  if (durationMs > 0) return durationMs / 1000;

  const timestamps = messages
    .map((m) => new Date(m.createdAt).getTime())
    .filter((t) => Number.isFinite(t));
  if (timestamps.length >= 2) {
    return (Math.max(...timestamps) - Math.min(...timestamps)) / 1000;
  }
  return null;
}

export function currentTurnMessages(allMessages: Message[], turnStartIndex: number): Message[] {
  return allMessages.slice(turnStartIndex);
}

export function isInCurrentTurn(message: Message, allMessages: Message[], turnStartIndex: number): boolean {
  return currentTurnMessages(allMessages, turnStartIndex).some((m) => m.id === message.id);
}

export interface CurrentTurnFilterOptions {
  sending: boolean;
  hideText: boolean;
  hideThinking: boolean;
  turnStartIndex: number;
  allMessages: Message[];
}

// 发送中且对应流式非空时，隐藏本回合已落库的 text/thinking，避免与流式块重复显示。
// 非 in-turn 消息不动；fold 内 thinking 被过滤后重算 stats（保证 running/计数准确）。
export function filterCurrentTurnItems(items: RenderItem[], opts: CurrentTurnFilterOptions): RenderItem[] {
  if (!opts.sending || (!opts.hideText && !opts.hideThinking)) return items;

  const filtered: RenderItem[] = [];
  for (const item of items) {
    if (item.type === 'message') {
      if (opts.hideText && isInCurrentTurn(item.message, opts.allMessages, opts.turnStartIndex)) continue;
      filtered.push(item);
      continue;
    }

    const messages = item.messages.filter((m) => {
      if (!isInCurrentTurn(m, opts.allMessages, opts.turnStartIndex)) return true;
      if (opts.hideThinking && m.eventType === 'thinking') return false;
      return true;
    });
    if (messages.length > 0) {
      filtered.push({ ...item, messages, stats: computeStats(messages) });
    }
  }
  return filtered;
}

export interface SubAgentGroup {
  parentAgentId: string;
  title: string;
  items: RenderItem[];
  durationText: string;
  running: boolean;
}

export interface SubAgentGroupOptions {
  turnStartIndex: number;
  sending: boolean;
  hideText: boolean;
  hideThinking: boolean;
  toolProgress: Record<string, number>;
  /** 主流程 tool_use → title 映射（子 agent 分组标题来源）。 */
  titleByToolUseId: Map<string, string>;
}

export function buildTitleByToolUseId(allMessages: Message[]): Map<string, string> {
  const titleByToolUseId = new Map<string, string>();
  for (const m of allMessages) {
    if (m.eventType === 'tool_use' && m.toolUseId && m.title) {
      titleByToolUseId.set(m.toolUseId, m.title);
    }
  }
  return titleByToolUseId;
}

// 方案 A：只聚合 turnStartIndex 之后的子 agent 消息成组（保留 DB 历史，仅控制 Tab 显示当前回合）。
// 每组复用主流程分组规则；发送中按 hideText/hideThinking 过滤本回合已落库内容；running 取末组或 fold.running。
export function aggregateSubAgentGroups(allMessages: Message[], opts: SubAgentGroupOptions): SubAgentGroup[] {
  const map = new Map<string, Message[]>();
  const order: string[] = [];
  for (let i = opts.turnStartIndex; i < allMessages.length; i += 1) {
    const m = allMessages[i];
    if (!m.parentAgentId) continue;
    if (!map.has(m.parentAgentId)) {
      map.set(m.parentAgentId, []);
      order.push(m.parentAgentId);
    }
    map.get(m.parentAgentId)!.push(m);
  }

  return order.map((id, idx) => {
    const msgs = map.get(id)!;
    const rawItems = groupMessagesForRender(msgs);
    const items = filterCurrentTurnItems(rawItems, {
      sending: opts.sending,
      hideText: opts.hideText,
      hideThinking: opts.hideThinking,
      turnStartIndex: opts.turnStartIndex,
      allMessages,
    });
    const running = opts.sending && (idx === order.length - 1 || items.some((item) => item.type === 'fold' && item.stats.running));
    return {
      parentAgentId: id,
      title: opts.titleByToolUseId.get(id) || '子Agent',
      items,
      durationText: formatDuration(computeElapsedSeconds(msgs, opts.toolProgress)),
      running,
    };
  });
}
