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
  /** 组内最早消息 createdAt（ms），客户端实时计时基准。 */
  startMs: number | null;
  /** 冻结耗时（秒）：已完成组 = 父 Task 工具 tool_result.createdAt − startMs（真实完成跨度）；
   *  未完成组 = computeElapsedSeconds 兜底（实时 tool_progress / durationMs / 首尾差）。 */
  frozenSeconds: number | null;
  /** 该子 Agent 是否已完成：父 Task 工具的 tool_result（toolUseId === parentAgentId）已到达。 */
  completed: boolean;
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
  /** Bug2：子 agent 实时思考快照（agentId → 文本）。子 agent 第一条消息要等它思考完一整轮才到达，
   * 此前 parentAgentId 消息为空、组不存在，思考中的 ThinkingBlock 无处挂载（Tab 空白）。用此快照预建组，
   * 让思考从第一秒起就可见；落库消息到达后自然并入同一组。 */
  liveThinkingByAgent?: Record<string, string>;
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
// 每组复用主流程分组规则；发送中按 hideText/hideThinking 过滤本回合已落库内容。
// 问题 4（彻底修复）：每组「是否完成 + 真实完成时刻」由其父 Task 工具的 tool_result 决定
// （toolUseId === parentAgentId），而非主回合结束。冻结耗时 = 完成 tool_result.createdAt − startMs，
// 既不偏短（不像旧首尾差漏算收尾）也不偏长（不像主回合结束多算等待）。
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

  // Bug2：为「已有实时思考但尚无落库消息」的子 agent 预建组。子 agent 第一条 message 要等它思考完一整轮
  // 才到达，在此之前组不存在，思考中的 ThinkingBlock 无处挂载 → Tab 空白。用实时思考快照补建空组，
  // 让思考从第一秒起可见；后续落库消息到达后并入同一组（key 相同）。
  if (opts.liveThinkingByAgent) {
    for (const id of Object.keys(opts.liveThinkingByAgent)) {
      if (!map.has(id)) {
        map.set(id, []);
        order.push(id);
      }
    }
  }

  // 父 Task 工具 tool_result 的 createdAt = 子 Agent 真正完成时刻。只扫描当前 turn，
  // 与上方分组范围保持一致，避免历史 toolUseId（极端复用/脏数据）误把本轮子 Agent 标记完成。
  // 嵌套修复：L2 子 agent（A 内部再派 B）的完成 tool_result 带 parentAgentId（=A 的 id），
  // 旧逻辑用 !m.parentAgentId 只数主流程 tool_result → 嵌套子 agent 永远标「未完成」。
  // 改为：只要 tool_result 的 toolUseId 命中本回合任一子 agent 派生 id（即 order 里的 parentAgentId），
  // 就记完成——L1（parentAgentId=null）与 L2（parentAgentId=A）都能正确标 completed + 真实跨度。
  const subAgentIds = new Set(order);
  const completionMsByAgent = new Map<string, number>();
  for (let i = opts.turnStartIndex; i < allMessages.length; i += 1) {
    const m = allMessages[i];
    if (m.eventType === 'tool_result' && m.toolUseId && subAgentIds.has(m.toolUseId)) {
      const ms = new Date(m.createdAt).getTime();
      if (Number.isFinite(ms)) completionMsByAgent.set(m.toolUseId, ms);
    }
  }

  return order.map((id) => {
    const msgs = map.get(id)!;
    const rawItems = groupMessagesForRender(msgs);
    const items = filterCurrentTurnItems(rawItems, {
      sending: opts.sending,
      hideText: opts.hideText,
      hideThinking: opts.hideThinking,
      turnStartIndex: opts.turnStartIndex,
      allMessages,
    });
    const startMs = (() => {
      const ts = msgs
        .map((m) => new Date(m.createdAt).getTime())
        .filter((t) => Number.isFinite(t));
      return ts.length ? Math.min(...ts) : null;
    })();
    const completionMs = completionMsByAgent.get(id) ?? null;
    const completed = completionMs !== null;
    // 已完成：真实完成跨度（完成 tool_result.createdAt − startMs）；否则 computeElapsedSeconds 兜底。
    const frozenSeconds =
      completed && startMs !== null
        ? Math.max(0, (completionMs - startMs) / 1000)
        : computeElapsedSeconds(msgs, opts.toolProgress);
    // 问题 4：running 改为「逐组」语义——回合发送中且自身未完成才算运行；一旦父 tool_result 到达即停。
    const running = opts.sending && !completed;
    return {
      parentAgentId: id,
      title: opts.titleByToolUseId.get(id) || '子Agent',
      items,
      durationText: formatDuration(frozenSeconds),
      startMs,
      frozenSeconds,
      completed,
      running,
    };
  });
}
