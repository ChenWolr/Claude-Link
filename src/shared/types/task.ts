import type { AttachmentSummary } from './attachment';

export type TaskStatus = 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface Task {
  id: string;
  sessionId: string;
  prompt: string;
  status: TaskStatus;
  sortOrder: number;
  result: string | null;
  costUsd: number | null;
  durationMs: number | null;
  errorMessage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  // 任务附件摘要（图片/文件）。repo 恒定为数组（老任务填 []），消费处无需 ?? 兜底。
  attachments: AttachmentSummary[];
  // 稳定消息身份：入队时写入，执行/重试/重启复用同一 ID 创建 user message，避免重复消息。
  clientMessageId: string | null;
  // 任务级暂停标记：true = 暂停顺延（不参与队列调度，恢复后回到待执行序列）。
  // 仅对 status='pending' 有意义；repo 恒定填充（老任务 false）。
  paused: boolean;
}

export type QueueStateStatus = 'idle' | 'running' | 'waiting' | 'paused' | 'continuing';

export interface QueueState {
  sessionId: string;
  status: QueueStateStatus;
  currentTaskId: string | null;
  lastCompletedTaskId: string | null;
  countdownRemaining: number;
  pendingCount: number;
}
