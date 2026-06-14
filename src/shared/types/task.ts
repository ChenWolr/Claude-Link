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
