import { defineStore } from 'pinia';
import type { Task, QueueState } from '../../shared/types/task';
import type { QueueEventPayload } from '../../shared/types/ipc';

export const useTaskStore = defineStore('task', {
  state: () => ({
    tasks: [] as Task[],
    queueState: { status: 'idle', countdownRemaining: 0, pendingCount: 0, sessionId: '', currentTaskId: null, lastCompletedTaskId: null } as QueueState,
    error: null as string | null,
  }),
  actions: {
    async loadTasks(sessionId: string) {
      try {
        this.tasks = await window.claudeLink.getTasks(sessionId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载任务失败';
      }
    },
    async addTask(sessionId: string, prompt: string) {
      try {
        const task = await window.claudeLink.addTask(sessionId, prompt);
        this.tasks.push(task);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '添加任务失败';
      }
    },
    async removeTask(taskId: string) {
      try {
        await window.claudeLink.removeTask(taskId);
        this.tasks = this.tasks.filter((t) => t.id !== taskId);
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
    async startQueue(sessionId: string) {
      try {
        await window.claudeLink.startQueue(sessionId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '启动队列失败';
      }
    },
    async pauseQueue(sessionId: string) {
      try {
        await window.claudeLink.pauseQueue(sessionId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '暂停队列失败';
      }
    },
    async resumeQueue(sessionId: string) {
      try {
        await window.claudeLink.resumeQueue(sessionId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '恢复队列失败';
      }
    },
    async interruptTask(taskId: string) {
      try {
        await window.claudeLink.interruptTask(taskId);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '中断任务失败';
      }
    },
    async queueUserMessage(sessionId: string, message: string) {
      try {
        this.queueState = await window.claudeLink.queueUserMessage(sessionId, message);
      } catch (error) {
        this.error = error instanceof Error ? error.message : '继续任务失败';
      }
    },
    handleQueueEvent(payload: QueueEventPayload) {
      switch (payload.type) {
        case 'task_started': {
          const task = this.tasks.find((t) => t.id === payload.taskId);
          if (task) task.status = 'running';
          this.queueState.status = 'running';
          this.queueState.currentTaskId = payload.taskId ?? null;
          break;
        }
        case 'task_completed':
        case 'task_failed': {
          const t = this.tasks.find((t) => t.id === payload.taskId);
          if (t) t.status = payload.type === 'task_completed' ? 'completed' : 'failed';
          this.queueState.currentTaskId = null;
          break;
        }
        case 'countdown_tick': {
          this.queueState.countdownRemaining = (payload.data?.remaining as number) ?? 0;
          this.queueState.status = 'waiting';
          break;
        }
        case 'countdown_cancelled': {
          this.queueState.countdownRemaining = 0;
          break;
        }
        case 'task_continuing': {
          this.queueState.status = 'continuing';
          break;
        }
        case 'queue_paused': {
          this.queueState.status = 'paused';
          break;
        }
        case 'queue_completed': {
          this.queueState.status = 'idle';
          this.queueState.countdownRemaining = 0;
          break;
        }
      }
    },
  },
});
