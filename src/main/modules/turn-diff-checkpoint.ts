// turn-diff-checkpoint.ts
// 主进程 checkpoint 记录器（计划 2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan §4-P3）：
// 写文件类工具（TOOL_DIFF_TOOL_NAMES）每次成功落盘，把工具结果时的文件 after 快照落库
// turn_file_checkpoints（repo 见 database/repositories/turn-file-checkpoint-repo.ts）。
//
// 挂点与纪律（对齐 turn-projection 旁路）：sdk-backend 的 forwardEvent 在推送后、persistCliEvent
// 之前以独立 try 调 noteCheckpointEvent——内部全 try/catch 吞错，旁路异常绝不上抛、绝不阻塞
// 转发/落库链。forwardTransient 不挂（瞬态事件不落库，也不参与快照）。
//
// 事件形状（shared/types/cli.ts 实际形态）：
//   tool_use 经两条路到达——stream_event（content_block_start 带 id/name，input_json_delta 累积）
//   与 message（CliMessageContentToolUsePart 带全量 input）；tool_result 只经 message
//  （CliMessageContentToolResultPart：tool_use_id / is_error）。故 noteCheckpointEvent 入参收
//   CliEvent 全集（计划文档写 CliStreamEvent，实际 CliStreamEvent 上永远看不到 tool_result——
//   以 cli.ts 实际形状为准收窄为按 event.type 分流）。
//
// 时序契约：forwardEvent 内 noteCheckpointEvent（同步只登记/起异步续体）→ persistCliEvent 同步落
// messages 行 → 快照续体（fs.promises.readFile await 之后）才查 messages 行拿 message_id。同步落库
// 先于任何异步续体执行，正常路径必命中；若仍未落库（落库失败/被跳过）→ console.warn 放弃该条，
// 不等待、不重试。
//
// 子 agent 写工具同样记录（不按 parentAgentId 过滤）：子 agent 消息 rowid 落在主回合区间内，
// 聚合语义正确（ZCode 同样按 checkpoint 归轮）。stream 侧仅按 parentToolUseId 做 index 命名空间
//（对齐 turn-projection R2 规则，防主/子 index 空间互踩），不做任何过滤。
//
// 生命周期：内存暂存按 sessionId 隔离；会话删除时 markSessionDeleted 收口调 disposeSession 清 Map
//（DB 行靠 sessions ON DELETE CASCADE）。

import * as fs from 'node:fs';
import { getConnection } from '../database/connection';
import * as checkpointRepo from '../database/repositories/turn-file-checkpoint-repo';
import { TOOL_DIFF_TOOL_NAMES } from '../../shared/process-kind';
import type { CliEvent, CliMessageEvent, CliMessageContentToolResultPart, CliMessageContentToolUsePart, CliStreamEvent } from '../../shared/types/cli';

/** tool_use 入参累积上限（字符数）：与 turn-projection.ts STREAM_TOOL_VALUE_LIMIT 同值（512KiB）。
 *  turn-projection 在计划 §8「明确不动」清单内，不引其常量，此处同值 + 注释对齐。 */
const INPUT_JSON_LIMIT = 512 * 1024;
/** after_content 快照上限（字符数）：>2MiB 截断并置 after_truncated（计划 §3.1 / 实现标准 10）。 */
const AFTER_CONTENT_LIMIT = 2 * 1024 * 1024;

/** diff 工具名归一集（trim+lowercase）：Edit/MultiEdit/Write 各别名归一后比对，原始名原样落库。 */
const DIFF_TOOL_NAMES_LOWER = new Set(
  (TOOL_DIFF_TOOL_NAMES as readonly string[]).map((n) => n.trim().toLowerCase()),
);

/** 暂存的写工具调用：等对应 tool_result 到达时读盘快照。 */
interface PendingUse {
  /** 工具原始名（原样落库 tool_name）。 */
  toolName: string;
  /** 从 input 解析出的目标文件路径。 */
  path: string;
  /** input JSON 文本（累积或全量，超限截断前缀）。 */
  inputJson: string;
  inputTruncated: boolean;
}

/** stream 累积块：content_block_start 登记（仅 diff 工具），input_json_delta 累积，stop 结算。 */
interface StreamBlock {
  toolUseId: string;
  toolName: string;
  buf: string;
  truncated: boolean;
}

/** sessionId → toolUseId → 暂存写工具调用。 */
const pendings = new Map<string, Map<string, PendingUse>>();
/** sessionId → nsKey（`${parentToolUseId ?? ''}#${index}`，turn-projection R2 同规则）→ stream 累积块。 */
const streamBlocks = new Map<string, Map<string, StreamBlock>>();

/** 带上限追加（对齐 turn-projection appendCapped 语义）：超限截断并置 truncated（截断后不再追加，标志粘滞）。 */
function appendCapped(current: string, chunk: string, limit: number): { text: string; truncated: boolean } {
  if (current.length >= limit) return { text: current, truncated: true };
  const next = current + chunk;
  if (next.length <= limit) return { text: next, truncated: false };
  return { text: next.slice(0, limit), truncated: true };
}

/**
 * 从 input JSON 文本提取 file_path（字段别名 file_path/path，对齐 tool-diff.ts 的 file_path
 * 提取规则并按计划扩 path 别名）。JSON.parse 失败（截断前缀非法 JSON）时正则兜底——尽力而为：
 * first-change 合成对 input_json 本就是「缺失/截断照存」。
 */
function extractFilePath(jsonText: string): string {
  try {
    const obj = JSON.parse(jsonText) as Record<string, unknown>;
    const direct = obj != null && typeof obj === 'object' ? (obj.file_path ?? obj.path) : null;
    if (typeof direct === 'string') return direct;
  } catch {
    // 截断前缀非法 JSON：走正则兜底
  }
  const m = jsonText.match(/"(?:file_path|path)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (!m || m[1] === undefined) return '';
  try {
    const decoded = JSON.parse(`"${m[1]}"`) as unknown;
    return typeof decoded === 'string' ? decoded : m[1];
  } catch {
    return m[1];
  }
}

/** 暂存 pending（仅 diff 工具且解析出非空 file_path；未命中工具不暂存）。 */
function upsertPending(sessionId: string, toolUseId: string, toolName: string, inputJson: string, inputTruncated: boolean): void {
  if (!sessionId || !toolUseId) return;
  if (!DIFF_TOOL_NAMES_LOWER.has(toolName.trim().toLowerCase())) return;
  const filePath = extractFilePath(inputJson);
  if (!filePath) return;
  let m = pendings.get(sessionId);
  if (!m) {
    m = new Map<string, PendingUse>();
    pendings.set(sessionId, m);
  }
  m.set(toolUseId, { toolName: toolName.trim(), path: filePath, inputJson, inputTruncated });
}

/** stream 事件分流：content_block_start 登记 / input_json_delta 累积 / content_block_stop 结算暂存。 */
function noteStreamEventCheckpoint(sessionId: string, event: CliStreamEvent): void {
  const se = event.event;
  if (!se) return;
  const nsKey = `${event.parentToolUseId ?? ''}#${typeof se.index === 'number' ? se.index : ''}`;
  if (se.type === 'content_block_start') {
    if (typeof se.index !== 'number') return;
    const blocks = streamBlocks.get(sessionId);
    const block = se.content_block;
    if (block && block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : '';
      if (name && DIFF_TOOL_NAMES_LOWER.has(name.trim().toLowerCase())) {
        const blockId = typeof block.id === 'string' && block.id ? block.id : `#${se.index}`;
        if (!blocks) {
          streamBlocks.set(sessionId, new Map<string, StreamBlock>());
        }
        streamBlocks.get(sessionId)!.set(nsKey, { toolUseId: blockId, toolName: name, buf: '', truncated: false });
        return;
      }
    }
    // 非 tool_use / 非目标工具占用该 index：清掉可能残留的旧映射，防串块（turn-projection 同款）。
    blocks?.delete(nsKey);
    return;
  }
  if (se.type === 'content_block_stop') {
    if (typeof se.index !== 'number') return;
    const blocks = streamBlocks.get(sessionId);
    const blk = blocks?.get(nsKey);
    if (!blk) return;
    blocks?.delete(nsKey);
    // 累积结束：解析入参 → 暂存 pending（等 tool_result 消费）。
    upsertPending(sessionId, blk.toolUseId, blk.toolName, blk.buf, blk.truncated);
    return;
  }
  const delta = se.delta;
  if (se.type === 'content_block_delta' && delta && delta.type === 'input_json_delta' && delta.partial_json) {
    if (typeof se.index !== 'number') return;
    const blk = streamBlocks.get(sessionId)?.get(nsKey);
    if (!blk) return;
    const r = appendCapped(blk.buf, delta.partial_json, INPUT_JSON_LIMIT);
    blk.buf = r.text;
    blk.truncated = blk.truncated || r.truncated;
  }
}

/** message 事件分流：tool_use part 暂存（全量 input），tool_result part 消费。 */
function noteMessageEventCheckpoint(sessionId: string, event: CliMessageEvent): void {
  if (!Array.isArray(event.content)) return;
  for (const part of event.content) {
    if (!part || typeof part !== 'object') continue;
    // 逐 part try（round-002 M-A5）：单 part 异常（如 tool_use.name 非字符串致 upsertPending 内
    // trim 抛错）只跳过该 part，不中止同事件后续 part（含更靠后的 tool_result）；吞错语义与
    // 外层 noteCheckpointEvent 一致（旁路可丢，绝不上抛）。
    try {
      if (part.type === 'tool_use') {
        const toolUsePart = part as CliMessageContentToolUsePart;
        const input = toolUsePart.input;
        if (input == null || typeof input !== 'object') continue;
        // 主键取 id、tool_use_id 兜底（对齐 persistMessageParts / cli.ts 注释规则）。
        const toolUseId = toolUsePart.id ?? toolUsePart.tool_use_id ?? '';
        const r = appendCapped('', JSON.stringify(input), INPUT_JSON_LIMIT);
        upsertPending(sessionId, toolUseId, toolUsePart.name, r.text, r.truncated);
      } else if (part.type === 'tool_result') {
        handleToolResultPart(sessionId, part as CliMessageContentToolResultPart);
      }
    } catch {
      // 单 part 可丢：异常静默忽略，继续处理同事件后续 part
    }
  }
}

/** tool_result 消费：无 pending / is_error 均不落库；成功 → 起异步快照续体（fire-and-forget）。 */
function handleToolResultPart(sessionId: string, part: CliMessageContentToolResultPart): void {
  const toolUseId = part.tool_use_id ?? '';
  if (!toolUseId) return;
  const m = pendings.get(sessionId);
  const pending = m?.get(toolUseId);
  if (!pending) return;
  m?.delete(toolUseId);
  if (m && m.size === 0) pendings.delete(sessionId);
  // is_error 为真 → 丢弃 pending、不落库（字段以 cli.ts 实际 is_error 为准；缺失视为成功）。
  if (part.is_error === true) return;
  void snapshotAndInsert(sessionId, toolUseId, pending);
}

/** 查 tool_result 已落库消息行 id（同 session+tool_use_id 最新一条；event_type 对齐 persistMessageParts）。 */
function findToolResultMessageId(sessionId: string, toolUseId: string): string | null {
  const db = getConnection();
  const row = db
    .prepare(
      `SELECT id FROM messages
       WHERE session_id = ? AND tool_use_id = ? AND event_type = 'tool_result'
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(sessionId, toolUseId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * 异步快照续体：读盘 → 判 binary（先于截断）→ 判截断 → 查 tool_result 消息行 → 幂等落库。
 * 任何异常（含 DB 异常）整体吞掉——旁路可丢，绝不阻塞事件流。
 */
async function snapshotAndInsert(sessionId: string, toolUseId: string, pending: PendingUse): Promise<void> {
  try {
    let afterContent: string | null = null;
    let afterTruncated = 0;
    let binary = 0;
    let snapshotState: 'disk' | 'failed' = 'disk';
    try {
      const raw = await fs.promises.readFile(pending.path, 'utf-8');
      // binary 判定先于截断（round-002 M-A3）：对 raw 全量查 \0——无论 \0 位于何处，含 \0 即
      // binary=1、after_content=NULL。若先截到 2MiB 前缀再查（旧序），\0 在 2MiB 之后的二进制
      // 文件会以 mojibake 文本落库（binary=0），与「内容含 \0 → binary=1」语义偏差。
      if (raw.includes('\0')) {
        binary = 1;
        afterContent = null;
      } else if (raw.length > AFTER_CONTENT_LIMIT) {
        afterContent = raw.slice(0, AFTER_CONTENT_LIMIT);
        afterTruncated = 1;
      } else {
        afterContent = raw;
      }
    } catch {
      // 读盘异常：failed 快照（聚合侧跳过该行）
      snapshotState = 'failed';
      afterContent = null;
      afterTruncated = 0;
      binary = 0;
    }

    // 落库前提：tool_result 消息行已在 messages 表（forwardEvent 同步链 persistCliEvent 先于本续体）。
    const messageId = findToolResultMessageId(sessionId, toolUseId);
    if (!messageId) {
      console.warn(
        `[turn-diff-checkpoint] tool_result 消息未落库，放弃 checkpoint（session=${sessionId}, toolUseId=${toolUseId}, path=${pending.path}）`,
      );
      return;
    }
    // 幂等：resume/重放同 toolUseId 已落过 → 跳过（防重复落库）。
    if (checkpointRepo.existsByToolUseId(sessionId, toolUseId)) return;
    checkpointRepo.insert({
      session_id: sessionId,
      message_id: messageId,
      path: pending.path,
      tool_name: pending.toolName,
      tool_use_id: toolUseId,
      input_json: pending.inputJson || null,
      input_truncated: pending.inputTruncated ? 1 : 0,
      after_content: afterContent,
      after_truncated: afterTruncated,
      binary,
      snapshot_state: snapshotState,
    });
  } catch {
    // 旁路纪律：checkpoint 记录异常绝不上抛（对齐 noteTurnEvent 纪律）
  }
}

/**
 * 唯一事件挂点（forwardEvent 在推送后追加调用；forwardTransient 不挂）。
 * 函数体整体 try/catch 吞错：旁路异常绝不上抛。
 */
export function noteCheckpointEvent(sessionId: string, ev: CliEvent): void {
  try {
    if (!sessionId || !ev || typeof ev !== 'object') return;
    if (ev.type === 'stream_event') {
      noteStreamEventCheckpoint(sessionId, ev);
    } else if (ev.type === 'message') {
      noteMessageEventCheckpoint(sessionId, ev);
    }
    // 其余事件类型（result/aborted/error/system/...）不进记录器。
  } catch {
    // checkpoint 可丢：异常静默忽略
  }
}

/** 立即清（会话删除 markSessionDeleted 收口调用）；DB 行靠 sessions ON DELETE CASCADE。 */
export function disposeSession(sessionId: string): void {
  pendings.delete(sessionId);
  streamBlocks.delete(sessionId);
}
