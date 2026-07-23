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
  // 任务附件摘要（图片/文件）。老任务无附件时为 undefined，消费处用 ?? [] 兜底。
  attachments?: AttachmentSummary[];
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
