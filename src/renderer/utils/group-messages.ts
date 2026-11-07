// group-messages.ts
// 消息 → 渲染分组（openhanako 风格：整回合过程合并成 fold）。
// 主流程（MessageList）与子 Agent 面板（TaskQueuePanel）共用同一规则。
//
// 规则（对齐 openhanako desktop/src/react/components/chat/process-fold.ts）：
//   - 折叠单位近似为「连续过程记录」；正文分三类：
//     · user 消息 → 独立 message 项（天然回合边界）；
//     · assistant 正文 text → 短叙事（≤PROCESS_NARRATION_TEXT_LIMIT，非回合最终）并入 fold；
//       回合最终文本（protectedFinalTextIds 标记）与长正文 → 独立 message 项（打断 fold）；
//   - 相邻 assistant 正文段显示层合并（2026-11-06 点2，先于一切分组）：原始输入序上「真正相邻」
//     （中间无任何消息，含渲染时被过滤的冗余 system 行——它仍是消息实体、构成夹隔）、
//     同 parentAgentId、非 isError 的正文段合成单一单元（content 恰一换行拼接、无多余空行）；
//     合成单元沿用**末段**行字段仅替换 content——末段 id 保证 turn-diff 卡锚（回合末正文 id）
//     与流式去重 turnIds 命中不回归；受保护/短叙事等分组语义在合并单元上评估。
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

/** 合并谓词：assistant 正文文本段且非错误正文（isError 正文不参与合并、并作为间隔阻断前后段）。 */
function isMergeableBodyText(m: RenderableMessage): boolean {
  return isAssistantBodyText(m) && m.isError !== true;
}

/** 段间拼接：恰一个换行分隔；前段末尾已带换行（含 \r\n）不再叠加（不产生多余空行）。 */
function joinTextSegments(prev: string, next: string): string {
  return prev.endsWith('\n') ? prev + next : prev + '\n' + next;
}

/**
 * 相邻 assistant 正文文本段显示层合并（2026-11-06 点2，输入预处理）：
 * 同一消息流中「真正相邻」（中间无 user/tool_use/tool_result/thinking/system 等任何消息——
 * 按原始输入序判定，含渲染时被过滤的冗余 system 行，天然作为间隔）、同 parentAgentId、
 * 非 isError 的正文段 ≥2 条 → 合成一个渲染单元，跨段表格/列表在同一 markdown 渲染内愈合。
 * 拼接保证换行分隔且无多余空行；合成单元沿用**末段**的行字段（id/createdAt/endedAt/durationMs/
 * costUsd/…）仅替换 content——末段 id 保证 MessageList 的 turn-diff 卡片锚点（回合最终正文 id，
 * mapFinalTextToTurnStart 以原始行末段 id 为键）与流式去重 turnIds 命中（turnStartIndex 起算的
 * 本回合 id 集含末段 id）不回归。attachments 防御性聚合：任一段带附件快照时按序拼接（导出链以
 * 原始行 flatMap 计数核对 .msg-att，丢附件会触发 attachment-render-mismatch 失败）。单段/不满足
 * 条件的段原样返回（引用不变），单段回合与现状逐字节一致。
 */
function mergeAdjacentAssistantTexts(messages: RenderableMessage[]): RenderableMessage[] {
  const out: RenderableMessage[] = [];
  let run: RenderableMessage[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    if (run.length === 1) {
      out.push(run[0]);
    } else {
      const last = run[run.length - 1];
      let content = run[0].content;
      for (let i = 1; i < run.length; i += 1) content = joinTextSegments(content, run[i].content);
      const hasAttachments = run.some((m) => (m.attachments ?? []).length > 0);
      out.push(hasAttachments
        ? { ...last, content, attachments: run.flatMap((m) => m.attachments ?? []) }
        : { ...last, content });
    }
    run = [];
  };
  for (const m of messages) {
    if (!isMergeableBodyText(m)) {
      flush();
      out.push(m); // 非可合并消息（user/tool/thinking/system/isError 正文）按原样原位保留，天然构成合并间隔
      continue;
    }
    if (run.length > 0 && run[0].parentAgentId !== m.parentAgentId) flush(); // 同 parentAgentId 守卫（防御性：三调用面现状均预过滤）
    run.push(m);
  }
  flush();
  return out;
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
  // 2026-11-06 点2：相邻正文段先合并（显示层；落库/调用方输入零变化），再进既有分组——
  // 受保护最终文本/短叙事折叠等分组语义在合并后单元上评估（合并单元通常为长正文→独立气泡）。
  const merged = mergeAdjacentAssistantTexts(messages);
  const protectedIds = protectedFinalTextIds(merged);
  const items: RenderItem[] = [];
  let fold: Extract<RenderItem, { type: 'fold' }> | null = null;
  const close = () => {
    if (fold) {
      fold.stats = computeStats(fold.messages);
      items.push(fold);
      fold = null;
    }
  };
  for (const msg of merged) {
    // R2：冗余 system 过程不在聊天流渲染——permission / interaction_response 由交互弹窗承载
    //（问题 5），system:informational 通用横幅无阅读语义（问题 2），均仍落库留审计；
    // system:api_retry 已改瞬态状态卡不落库，此处兜底修复前老库残留行（Bug4）。
    // 在此单一瓶颈过滤，同时覆盖主流程（MessageList）与子 Agent 面板（TaskQueuePanel→ProcessGroup）。
    if (isRedundantSystemProcessKind(msg.processKind)) continue;
    // 独立 message 项（打断 fold）：
    //   · review-v2 P1：init_write_skipped 是 /init 的独立文件副作用诊断，须独立展示（不进 fold）；
    //   · F5 复验发现：interaction_cancelled 是「弹窗被系统取消」的用户可见反馈（计划 §2.5.4
    //     红色系统消息），折进过程组会被淹没，须独立成条（MessageBubble bubble--error 红样式）；
    //   · hb10-CHR-V01：短错误正文（isError 且 ≤100 字符，如 reasoning_replay 失败气泡）同样
    //     豁免折叠——折进过程组会被淹没，独立成条保持可见；
    //   · user 消息是回合边界；
    //   · assistant 正文的「回合最终文本」受保护、「长正文」是结论性回复，均打断 fold。
    const isBreak =
      msg.processKind === 'system:init_write_skipped' ||
      msg.processKind === 'system:interaction_cancelled' ||
      // hb13-v B10.3：system:error 独立成条不被折没（失败原因可见性）；system:aborted 不在
      // 豁免清单内——中断/回合结束提示仍随过程折进 fold（fold 展开时灰字可见，折叠态收起）。
      msg.processKind === 'system:error' ||
      // reasoning_replay 自动重试提示：韧性层的用户可见反馈，须独立展示（不进 fold）。
      msg.processKind === 'system:auto_retry' ||
      (msg.isError === true && isAssistantBodyText(msg) && msg.content.trim().length <= PROCESS_NARRATION_TEXT_LIMIT) ||
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
