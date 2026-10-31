// turn-diff-attach.ts
// 轮末文件改动卡片（TurnFileChangesCard）的挂载锚点推导（计划 §4-P5）：把「回合最终
// assistant 正文」映射到其所属回合的 [turnStartMessageId, endMessageId) 区间，供 MessageList
// 在该正文气泡之后挂卡片，行点击经 turn-diff-store 懒加载该回合的单文件 patch。
//
// 口径对齐 group-messages.protectedFinalTextIds（按主流程 user 消息分回合、取每回合最后一条
// assistant 正文 text）但独立编写、不 import 其私有函数；与主进程 turn-diff.ts 的回合区间
// 推导（注释 N2）同口径：第 i 回合 = [该回合首条主流程 user 消息, 下一回合首条主流程 user
// 消息)，末回合上界 +∞（endMessageId=null）。
//
// 约定：调用方保证传入的是已过滤 parentAgentId 的主流程消息列表（MessageList 的
// mainFlowMessages），函数内不重复过滤。纯函数（无 Vue/DOM 依赖）。

import type { RenderableMessage } from '../../shared/types/export-image';

/** 单条挂载映射：卡片所属回合的起止消息 id（endMessageId=null 表示末回合，到会话末尾）。 */
export interface TurnDiffAttach {
  turnStartMessageId: string;
  endMessageId: string | null;
}

/**
 * 按 user 消息分回合，产出「回合最终 assistant 正文消息 id → 回合区间」映射。
 * - key = 该回合最后一条 assistant 正文 text（role='assistant'、eventType='message'、
 *   processKind=null）的消息 id；
 * - value.turnStartMessageId = 本回合首条 user 消息 id；
 * - value.endMessageId = 下回合首条 user 消息 id（末回合 null）；
 * - 回合内无 assistant 正文 → 不产出键（该回合无挂载锚点，卡片无处可挂）。
 */
export function mapFinalTextToTurnStart(messages: ReadonlyArray<RenderableMessage>): Map<string, TurnDiffAttach> {
  const map = new Map<string, TurnDiffAttach>();
  // 当前回合首条 user 消息 id（首条 user 之前的历史正文无回合锚点，不产出键）。
  let turnStartId: string | null = null;
  // 当前回合最后一条 assistant 正文 text 的消息 id。
  let latestTextId: string | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      // 回合收口：上一回合有「首条 user + 最终正文」才产出键，endMessageId=本条（下回合首条）user id。
      if (turnStartId !== null && latestTextId !== null) {
        map.set(latestTextId, { turnStartMessageId: turnStartId, endMessageId: m.id });
      }
      turnStartId = m.id;
      latestTextId = null;
      continue;
    }
    if (m.role === 'assistant' && m.eventType === 'message' && m.processKind === null) {
      latestTextId = m.id;
    }
  }
  // 末回合收口：endMessageId=null（到会话末尾）。
  if (turnStartId !== null && latestTextId !== null) {
    map.set(latestTextId, { turnStartMessageId: turnStartId, endMessageId: null });
  }
  return map;
}
