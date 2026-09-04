import { defineStore } from 'pinia';
import type { Task, QueueState, QueueOverview, ExecutedTaskInfo } from '../../shared/types/task';
import type { Message } from '../../shared/types/session';
import type { QueueEventPayload } from '../../shared/types/ipc';
import type { ChatSendPayload, AttachmentSummary } from '../../shared/types/attachment';
import { useSessionStore } from './session-store';

// v3 队列 store：tasks/executed/queueState 三项为「当前活动会话」的视图，
// 全量权威来自 loadOverview（会话切换时拉取）与 state_changed 快照；
// 非活动会话的视图类事件被过滤（多会话隔离），markRunning/markStopped 本就按会话键控、始终生效。
export const useTaskStore = defineStore('task', {
  state: () => ({
    tasks: [] as Task[],
    executed: [] as ExecutedTaskInfo[],
    queueState: {
      sessionId: '',
      status: 'standby',
      standbyReason: null,
      countdownRemaining: 0,
      currentTaskId: null,
    } as QueueState,
    error: null as string | null,
  }),
  actions: {
    // 会话切换/挂载时拉全量：状态 + pending 任务 + 本次已执行历史（三项整体替换）。
    async loadOverview(sessionId: string) {
      try {
        const overview: QueueOverview = await window.claudeLink.getQueueOverview(sessionId);
        this.tasks = overview.tasks;
        this.executed = overview.executed;
        this.queueState = overview.state;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载队列失败';
      }
    },
    // Task 5：addTask 收 ChatSendPayload（附件草稿由 draftStore 提供）。
    // 主进程返回 { task, tasks }，以返回的 tasks 为顺序权威整体替换。
    // 成功返回 true 并清旧错误；失败置 error 并返回 false（供调用方决定是否清草稿）。
    async addTask(sessionId: string, payload: ChatSendPayload): Promise<boolean> {
      try {
        this.error = null;
        const { tasks } = await window.claudeLink.addTask(sessionId, payload);
        this.tasks = tasks;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '添加任务失败';
        return false;
      }
    },
    // 删除：以主进程返回的新任务列表替换（主进程侧已按语义 #10 收口倒计时）。
    async removeTask(taskId: string) {
      try {
        this.tasks = await window.claudeLink.removeTask(taskId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '删除任务失败';
      }
    },
    async reorderTasks(sessionId: string, taskIds: string[]) {
      try {
        const reordered = await window.claudeLink.reorderTasks(sessionId, taskIds);
        this.tasks = reordered;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '排序任务失败';
      }
    },
    // 暂停/恢复：以主进程返回的新任务列表替换（恢复路径已在主进程侧 arm）。
    async setTaskPaused(taskId: string, paused: boolean) {
      try {
        this.error = null;
        this.tasks = await window.claudeLink.setTaskPaused(taskId, paused);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '暂停/恢复任务失败';
      }
    },
    // 立即执行：成功以 overview 整体替换三项；失败置 error（notice 由面板兜底展示）并返回 false。
    async runTaskNow(taskId: string, _sessionId: string): Promise<boolean> {
      try {
        this.error = null;
        const overview = await window.claudeLink.runTaskNow(taskId);
        this.tasks = overview.tasks;
        this.executed = overview.executed;
        this.queueState = overview.state;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '立即执行失败';
        return false;
      }
    },
    // 全部恢复：同 runTaskNow 的 overview 替换语义。
    async resumeAll(sessionId: string): Promise<boolean> {
      try {
        this.error = null;
        const overview = await window.claudeLink.resumeAllQueue(sessionId);
        this.tasks = overview.tasks;
        this.executed = overview.executed;
        this.queueState = overview.state;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '全部恢复失败';
        return false;
      }
    },
    handleQueueEvent(payload: QueueEventPayload) {
      const sessionStore = useSessionStore();
      const isActive = payload.sessionId === sessionStore.activeSession?.id;
      switch (payload.type) {
        // 所有状态迁移的权威快照通道：整体替换 queueState。
        case 'state_changed': {
          if (!isActive) break;
          const state = payload.data?.state as QueueState | undefined;
          if (state) this.queueState = { ...state };
          break;
        }
        // tick 兼作 ETA 秒跳。
        case 'countdown_started':
        case 'countdown_tick': {
          if (!isActive) break;
          const remaining =
            payload.type === 'countdown_started'
              ? (payload.data?.seconds as number)
              : (payload.data?.remaining as number);
          if (typeof remaining === 'number') this.queueState.countdownRemaining = remaining;
          break;
        }
        case 'task_started': {
          // markRunning 按会话键控、幂等：后台会话的队列回合也要正确反映 sending。
          sessionStore.markRunning(payload.sessionId);
          if (!isActive) break;
          this.tasks = this.tasks.filter((t) => t.id !== payload.taskId);
          this.executed.unshift({
            taskId: payload.taskId ?? '',
            prompt: (payload.data?.prompt as string) ?? '',
            attachments: (payload.data?.attachments as AttachmentSummary[]) ?? [],
            outcome: 'running',
            settledAt: new Date().toISOString(),
          });
          break;
        }
        case 'task_settled': {
          // 中断路径（无 result 事件）依赖 task_settled 收口 sending——markStopped 幂等，
          // 非 success 才调；成功绿灯由 result 事件驱动，不在此碰。
          if (payload.data?.outcome !== 'success') {
            sessionStore.markStopped(payload.sessionId);
          }
          if (!isActive) break;
          const entry = this.executed.find((e) => e.taskId === payload.taskId && e.outcome === 'running');
          if (entry) {
            entry.outcome = (payload.data?.outcome as ExecutedTaskInfo['outcome']) ?? 'success';
            entry.settledAt = new Date().toISOString();
          }
          break;
        }
        case 'queue_halted': {
          if (!isActive) break;
          this.tasks.forEach((t) => {
            t.paused = true;
          });
          break;
        }
        case 'user_message_created': {
          // 队列任务到点/立即执行在主进程创建稳定 user message 后经此事件回传，
          // 按 id upsert 进会话消息（sessionStore 自行按消息归属路由，后台会话也要入列）。
          const msg = payload.data?.message as Message | undefined;
          if (msg) sessionStore.addMessage(msg);
          break;
        }
      }
    },
  },
});
