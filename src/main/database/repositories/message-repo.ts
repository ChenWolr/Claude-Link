import { v4 as uuidv4 } from 'uuid';
import type { Message } from '../../../shared/types/session';
import type { RenderableMessage } from '../../../shared/types/export-image';
import { getConnection } from '../connection';
import { normalizeDbTime } from '../../../shared/time';
import * as attachmentRepo from './attachment-repo';

interface MessageRow {
  id: string;
  session_id: string;
  role: Message['role'];
  content: string;
  raw_event: string | null;
  event_type: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  parent_task_id: string | null;
  process_kind: string | null;
  parent_agent_id: string | null;
  tool_use_id: string | null;
  title: string | null;
  is_error: number;
  created_at: string;
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    rawEvent: row.raw_event,
    eventType: row.event_type,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    parentTaskId: row.parent_task_id,
    processKind: row.process_kind,
    parentAgentId: row.parent_agent_id,
    toolUseId: row.tool_use_id,
    title: row.title,
    isError: !!row.is_error,
    createdAt: normalizeDbTime(row.created_at),
  };
}

/** 批量填充消息附件（无附件的消息赋空数组，避免消费处再 ?? []）。 */
function fillMessageAttachments(messages: Message[]): void {
  if (messages.length === 0) return;
  const map = attachmentRepo.getAttachmentsByMessageIds(messages.map((m) => m.id));
  for (const m of messages) m.attachments = map.get(m.id) ?? [];
}

function fillRenderableAttachments(messages: RenderableMessage[]): void {
  if (messages.length === 0) return;
  const map = attachmentRepo.getAttachmentsByMessageIds(messages.map((m) => m.id));
  for (const m of messages) m.attachments = map.get(m.id) ?? [];
}

export interface CreateMessageInput {
  sessionId: string;
  role: Message['role'];
  content: string;
  eventType?: string | null;
  rawEvent?: string | null;
  parentTaskId?: string | null;
  // 过程类型分类键（见 src/shared/process-kind.ts）。
  processKind?: string | null;
  // 子 agent 归属（assistant 消息的 parent_tool_use_id）。
  parentAgentId?: string | null;
  // 工具调用 ID（tool_use / tool_result 配对）。
  toolUseId?: string | null;
  // 子 agent 友好标题。
  title?: string | null;
  // 工具结果是否失败（tool_result.is_error）。
  isError?: boolean;
  /** 受校验的消息 ID（renderer 乐观消息与 DB 消息共用同一 ID）；缺省则生成 uuid。 */
  id?: string;
  /** 按显示顺序的草稿附件 ID；非空时在同一事务内关联。 */
  attachments?: string[];
  /**
   * 是否在关联后把附件 status 升为 message。
   * 默认 true（流式 assistant 等路径无附件时无影响）。
   * CHAT_SEND 传 false：等 SDK query 真正启动成功后再升格，失败可保持 draft 重试。
   */
  promoteAttachments?: boolean;
}

// createMessage 委托 createMessageWithAttachments：无附件时事务内 link 跳过，行为与历史一致，
// 但统一支持受校验 id 与附件关联，避免发送链路绕过附件事务。
export function createMessage(input: CreateMessageInput): Message {
  return createMessageWithAttachments(input);
}

export function createMessageWithAttachments(input: CreateMessageInput): Message {
  const db = getConnection();
  const id = input.id ?? uuidv4();
  const attachmentIds = input.attachments ?? [];
  const promoteAttachments = input.promoteAttachments !== false;

  const {
    sessionId,
    role,
    content,
    eventType = null,
    rawEvent = null,
    parentTaskId = null,
    processKind = null,
    parentAgentId = null,
    toolUseId = null,
    title = null,
    isError = false,
  } = input;

  const insert = db.prepare(
    `INSERT INTO messages (id, session_id, role, content, event_type, raw_event, parent_task_id,
                           process_kind, parent_agent_id, tool_use_id, title, is_error)
     VALUES (@id, @sessionId, @role, @content, @eventType, @rawEvent, @parentTaskId,
             @processKind, @parentAgentId, @toolUseId, @title, @isError)`,
  );

  const transaction = db.transaction(() => {
    insert.run({
      id,
      sessionId,
      role,
      content,
      eventType,
      rawEvent,
      parentTaskId,
      processKind,
      parentAgentId,
      toolUseId,
      title,
      isError: isError ? 1 : 0,
    });
    if (attachmentIds.length > 0) {
      attachmentRepo.linkAttachmentsToMessage(id, attachmentIds);
      if (promoteAttachments) {
        attachmentRepo.markAttachmentsStatus(attachmentIds, 'message');
      }
    }
  });
  transaction();

  // 无附件时不额外查询（流式回复高频路径）；有附件时回读摘要供调用方返回。
  const attachments = attachmentIds.length > 0
    ? (attachmentRepo.getAttachmentsByMessageIds([id]).get(id) ?? [])
    : [];

  return {
    id,
    sessionId,
    role,
    content,
    rawEvent,
    eventType,
    costUsd: null,
    durationMs: null,
    parentTaskId,
    processKind,
    parentAgentId,
    toolUseId,
    title,
    isError,
    createdAt: new Date().toISOString(),
    attachments,
  };
}

/** 删除单条消息（message_attachments 级联删；attachments 行与物理文件保留，供失败重试）。 */
export function deleteMessage(id: string): void {
  getConnection().prepare('DELETE FROM messages WHERE id = ?').run(id);
}

export function getMessagesBySession(sessionId: string): Message[] {
  const rows = getConnection()
    // created_at 是秒级精度（列默认 datetime('now')），同一回合的多个 part 常落在同一秒，
    // 仅按 created_at 排序在历史回读时顺序不确定，会把 tool_result 排到 tool_use 之前/错位，
    // 破坏连续同类合并与多段正文穿插。加 rowid（隐式自增，= 插入顺序）作确定性 tiebreaker，
    // 保证回读顺序与实时落库顺序一致（计划验证 #5）。
    .prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(sessionId) as MessageRow[];
  const messages = rows.map(toMessage);
  fillMessageAttachments(messages);
  return messages;
}

export function getMessagesByTask(taskId: string): Message[] {
  const rows = getConnection()
    .prepare('SELECT * FROM messages WHERE parent_task_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(taskId) as MessageRow[];
  const messages = rows.map(toMessage);
  fillMessageAttachments(messages);
  return messages;
}

// —— 导出专用 projection ——
// 只选择 RenderableMessage 字段（不含 raw_event / parent_task_id 等图片渲染不需要的大列），
// 沿用与聊天历史一致的 ORDER BY created_at, rowid 稳定顺序。仅主流程（parent_agent_id IS NULL）
// 由调用方过滤；此处返回全部，让 snapshot 组装统一处理。附件摘要一并填充供导出快照使用。
interface ExportMessageRow {
  id: string;
  session_id: string;
  role: Message['role'];
  content: string;
  event_type: string | null;
  cost_usd: number | null;
  duration_ms: number | null;
  process_kind: string | null;
  parent_agent_id: string | null;
  tool_use_id: string | null;
  title: string | null;
  is_error: number;
  created_at: string;
}

function toRenderable(row: ExportMessageRow): RenderableMessage {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    content: row.content,
    eventType: row.event_type,
    costUsd: row.cost_usd,
    durationMs: row.duration_ms,
    processKind: row.process_kind,
    parentAgentId: row.parent_agent_id,
    toolUseId: row.tool_use_id,
    title: row.title,
    isError: !!row.is_error,
    createdAt: normalizeDbTime(row.created_at),
  };
}

export function getRenderableMessagesBySession(sessionId: string): RenderableMessage[] {
  const rows = getConnection()
    .prepare(
      `SELECT id, session_id, role, content, event_type, cost_usd, duration_ms,
              process_kind, parent_agent_id, tool_use_id, title, is_error, created_at
       FROM messages WHERE session_id = ? ORDER BY created_at ASC, rowid ASC`,
    )
    .all(sessionId) as ExportMessageRow[];
  const list = rows.map(toRenderable);
  fillRenderableAttachments(list);
  return list;
}
