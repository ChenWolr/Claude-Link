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
    // A2/A3 共用恢复门状态位（02-impl-details-renderer §2.2）：loadOverview 成功过门的会话按
    // id 记 ready；failed 标记（拉取失败/超时）本点仅声明读侧——写入点在 A3 点的
    // ensureOverviewReady（门全量：3s 超时兜底 + 启动/切会话接线）。queueStateKnown 读侧对
    // 「failed 已挂」返回 false，与 A3 保守侧语义一致。
    overviewReadyBySession: {} as Record<string, boolean>,
    overviewFailedBySession: {} as Record<string, boolean>,
    error: null as string | null,
  }),
  actions: {
    // A2 发送路由判据输入（00 行为规范 A2.5：状态源=主进程权威快照/事件，渲染层不臆断）：
    // 该会话队列状态已知 = loadOverview 成功过门 且 失败标记未挂。未知会话在 queueEnabled
    // 时由 A2 判据保守入队（02 §1.4 边界值表：入队后消息以 pending 任务存在，面板可见可恢复）。
    queueStateKnown(sessionId: string): boolean {
      return this.overviewReadyBySession[sessionId] === true && this.overviewFailedBySession[sessionId] !== true;
    },
    // 会话切换/挂载时拉全量：状态 + pending 任务 + 本次已执行历史（三项整体替换）。
    // 返回 boolean：成功 true/失败 false（P34 修复：供 ensureOverviewReady 以返回值判过门结果，
    // 不再依赖共享 error 位——removeTask/reorder/setPaused 失败残留 error 不误标成功拉取；
    // 既有直调消费面（TaskQueuePanel void / web-bridge realign）返回值可忽略、零改动）。
    async loadOverview(sessionId: string): Promise<boolean> {
      try {
        const overview: QueueOverview = await window.claudeLink.getQueueOverview(sessionId);
        this.tasks = overview.tasks;
        this.executed = overview.executed;
        this.queueState = overview.state;
        // A2 恢复门写入（02 §2.2 loadOverview 字面要求）：成功过门标记按会话键控。
        // 失败路径不写（ready 不置位 → queueStateKnown=false → A2 保守侧入队）；
        // 直接调用者（TaskQueuePanel watch / web-bridge realign）同过此门，天然复用。
        this.overviewReadyBySession[sessionId] = true;
        this.overviewFailedBySession[sessionId] = false;
        return true;
      } catch (error) {
        this.error = error instanceof Error ? error.message : '加载队列失败';
        return false;
      }
    },
    // A3 刷新恢复门（00 行为规范 A3-1/3；02-impl-details-renderer §2.2 代码形态逐字对照）：
    // 启动/切会话时确保该会话队列概览已拉取过门。已过门（含失败放行）不重拉；3s 超时兜底
    // 置 failed+ready（主进程超时/异常不得永久禁言输入框）；loadOverview 失败经返回值区分
    // failed（P34：共享 error 位受无关操作残留污染，不作判据）。失败/超时放行后
    // queueStateKnown=false → A2 判据保守侧（queueEnabled 时入队）。
    async ensureOverviewReady(sessionId: string): Promise<void> {
      if (this.overviewReadyBySession[sessionId]) return; // 已过门（含失败放行）不重拉
      let settled = false;
      // 3s 超时兜底：主进程超时/异常不得永久禁言输入框（契约 A3-3）
      const timeout = new Promise<void>((r) => setTimeout(() => {
        if (!settled) {
          settled = true;
          this.overviewFailedBySession[sessionId] = true;
          this.overviewReadyBySession[sessionId] = true;
        }
        r();
      }, 3000));
      const fetchOverview = (async () => {
        let loadOk = false;
        try {
          loadOk = await this.loadOverview(sessionId); // 失败时 loadOverview 内部置 error 返回 false、不抛
        } finally {
          if (!settled) {
            settled = true;
            // loadOverview 成功与否以返回值区分（P34）：失败 → failed=true → A2 保守侧；成功 → known
            this.overviewFailedBySession[sessionId] = !loadOk;
            this.overviewReadyBySession[sessionId] = true;
          }
        }
      })();
      await Promise.race([fetchOverview, timeout]);
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
          // hb12-QUE-04：倒计时全长快照（etaFor 倒计时期优先快照，不受 tick 漂移影响）。
          if (payload.type === 'countdown_started' && typeof remaining === 'number') {
            this.queueState.intervalSeconds = remaining;
          }
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
        // X10 followup（2026-10-07）：自愈恢复（主进程 maybeResumeAfterAutoRetry 的
        // resumeAllPending）不经 IPC 返回值——此事件是渲染层 paused 翻转的唯一信号，
        // 与 queue_halted 的置 true 完全对称（徽标消失、etaFor/runnableCount 自动恢复）。
        case 'queue_auto_resumed': {
          if (!isActive) break;
          this.tasks.forEach((t) => {
            t.paused = false;
          });
          break;
        }
        case 'tasks_changed': {
          // UI13-P1：任一端 CRUD 后的全量权威列表（含顺序与暂停态），仅当前面板会话生效。
          // 空数组合法（删到最后一个任务），勿用 length 守卫误吞；发起端 invoke 回包与
          // 本事件同源同值，任意顺序等价（幂等整替、无回退/闪烁）。
          if (!isActive) break;
          const tasks = payload.data?.tasks as Task[] | undefined;
          if (Array.isArray(tasks)) this.tasks = tasks;
          break;
        }
        case 'user_message_created': {
          // 队列任务到点/立即执行在主进程创建稳定 user message 后经此事件回传，按 id upsert
          // 进会话消息（addMessage 带归属守卫：P1-4 后台/已删会话的消息直接拒绝、不落渲染层存储不串入当前列表，后台会话切回时由 DB 重载补齐）。
          const msg = payload.data?.message as Message | undefined;
          if (msg) {
            sessionStore.addMessage(msg);
            // P1-3：队列驱动的回合没有直发链路的 turnStartIndex 写入点——消息入列后按
            // 共享口径重算回合边界，否则流式去重会把上一回合/全部历史正文与思考隐藏到回合结束。
            if (msg.sessionId === sessionStore.activeSession?.id) {
              sessionStore.recomputeTurnStartIndex();
            }
          }
          break;
        }
      }
    },
  },
});
