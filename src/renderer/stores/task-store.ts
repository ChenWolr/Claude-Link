import { defineStore } from 'pinia';
import type { Task, QueueState } from '../../shared/types/task';
import type { Message } from '../../shared/types/session';
import type { QueueEventPayload } from '../../shared/types/ipc';
import type { ChatSendPayload } from '../../shared/types/attachment';
import { useSessionStore } from './session-store';

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
    // Task 5：addTask 收 ChatSendPayload（附件草稿由 draftStore 提供）。
    // 成功返回 true 并清旧错误；失败置 error 并返回 false（供调用方决定是否清草稿）。
    async addTask(sessionId: string, payload: ChatSendPayload): Promise<boolean> {
      try {
        this.error = null;
        const task = await window.claudeLink.addTask(sessionId, payload);
        this.tasks.push(task);
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '添加任务失败';
        return false;
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
    // Task 7B：重试 failed/cancelled 任务 → pending；本地同步清结果字段（附件 links + 稳定 ID 由主进程保留）。
    async retryTask(taskId: string) {
      try {
        this.error = null;
        await window.claudeLink.retryTask(taskId);
        const t = this.tasks.find((x) => x.id === taskId);
        if (t) {
          t.status = 'pending';
          t.errorMessage = null;
          t.result = null;
          t.costUsd = null;
          t.durationMs = null;
          t.startedAt = null;
          t.completedAt = null;
        }
      } catch (error) {
        this.error = error instanceof Error ? error.message : '重试任务失败';
      }
    },
    // Task 5：续接收 ChatSendPayload（附件草稿由 draftStore 提供）。
    // 成功返回 true 并清旧错误；失败置 error 并返回 false。
    async queueUserMessage(sessionId: string, payload: ChatSendPayload): Promise<boolean> {
      try {
        this.error = null;
        this.queueState = await window.claudeLink.queueUserMessage(sessionId, payload);
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '继续任务失败';
        return false;
      }
    },
    handleQueueEvent(payload: QueueEventPayload) {
      // R6（问题 1+2 健壮性）：队列驱动的回合不经 use-chat.sendMessage，渲染层不会 markRunning，
      // 导致 sending 恒 false、计时器/动画不显示。在队列事件边界同步执行态：开始/续写置 running，
      // 队列结束置 stopped。markRunning/markStopped 均幂等、per-session，安全。
      const sessionStore = useSessionStore();
      switch (payload.type) {
        case 'task_started': {
          const task = this.tasks.find((t) => t.id === payload.taskId);
          if (task) task.status = 'running';
          this.queueState.status = 'running';
          this.queueState.currentTaskId = payload.taskId ?? null;
          sessionStore.markRunning(payload.sessionId);
          break;
        }
        case 'task_completed':
        case 'task_failed': {
          const t = this.tasks.find((t) => t.id === payload.taskId);
          if (t) t.status = payload.type === 'task_completed' ? 'completed' : 'failed';
          this.queueState.currentTaskId = null;
          // 中断收口的 task_completed（interruptTask 带 interrupted:true）：被杀回合不再有
          // result/aborted CHAT_EVENT 兜底（两段式 abort 兜底路径下 runQuery 的 catch 因
          // entry 已移除走 !isCurrentEntry 分支，只 emitExit 不发事件），sending 会永久
          // 卡住。此处按中断语义补 markStopped（幂等）；自然完成的绿灯由 result 事件
          // 负责，不带 interrupted 标记，不会误降级。
          if (payload.type === 'task_completed' && (payload.data as { interrupted?: boolean } | undefined)?.interrupted) {
            sessionStore.markStopped(payload.sessionId);
          }
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
          sessionStore.markRunning(payload.sessionId);
          break;
        }
        case 'user_message_created': {
          // Task 7B：task 执行/waiting 续接在主进程创建稳定 user message 后经此事件回传，
          // 按 id upsert 进会话消息（不重复落 DB），让用户看到任务对应的提问气泡。
          const msg = payload.data?.message as Message | undefined;
          if (msg) sessionStore.addMessage(msg);
          break;
        }
        case 'queue_paused': {
          this.queueState.status = 'paused';
          break;
        }
        case 'queue_completed': {
          this.queueState.status = 'idle';
          this.queueState.countdownRemaining = 0;
          // F2：队列收口只负责自己的 queueState，不得覆盖真实聊天终态——
          // 最后一次成功 result 已置 completed（绿灯）时保留；retry 真正耗尽的
          // network_interrupted（常红）同样保留（exhausted 后迟到的 queue_completed
          // 不得清常红）；否则（失败/中断/无 result 的队列耗尽）按既有语义
          // markStopped 回 idle。不能反过来无条件 markCompleted：队列也可能因
          // prepare/spawn/task 失败而耗尽，完成灯必须由成功 result 驱动。
          const current = sessionStore.sessionStatus[payload.sessionId];
          if (current !== 'completed' && current !== 'network_interrupted') {
            sessionStore.markStopped(payload.sessionId);
          }
          break;
        }
      }
    },
  },
});
