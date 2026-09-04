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

// 调度器状态（v3 语义，每会话独立）：standby=待命（不计时不出队）/ countdown=倒计时中 /
// running=回合执行中（普通发送/插话/队列任务出队皆同）。
export type QueueStateStatus = 'standby' | 'countdown' | 'running';

// standby 的原因（描述「为什么待命」）；回合开始即成历史（置 null），不持久化、重启丢失。
export type QueueStandbyReason = 'restart' | 'halt_failed' | 'halt_interrupted' | 'switch_off' | null;

export interface QueueState {
  sessionId: string;
  status: QueueStateStatus;
  standbyReason: QueueStandbyReason;
  countdownRemaining: number;
  currentTaskId: string | null;
}

/** 已执行任务的结果态：出队即入历史（outcome 先为 running），回合收尾时定终态。 */
export type ExecutedOutcome = 'running' | 'success' | 'failed' | 'interrupted';

/** 「本次已执行」历史条目（方案 A：纯内存、本次运行期、重启清零、上限 50 条）。 */
export interface ExecutedTaskInfo {
  taskId: string;
  prompt: string;
  attachments: AttachmentSummary[];
  outcome: ExecutedOutcome;
  settledAt: string;
}

/** 队列面板全量数据：状态快照 + 待执行任务（含 paused，按 sort_order）+ 本次已执行历史（新→旧）。 */
export interface QueueOverview {
  state: QueueState;
  tasks: Task[];
  executed: ExecutedTaskInfo[];
}
