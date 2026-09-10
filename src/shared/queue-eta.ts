// queue-eta.ts
// 队列任务 ETA 文案纯函数：渲染层（TaskItem ETA 行）与契约测试共用，无副作用、不依赖 Electron。
// v3 语义以本文件与 task-queue-engine.ts 注释为准，行为由 scripts/tdd-queue-semantics-v3-verify.ts 锁定（原规格文档已不在仓库）。

export type QueueSchedulerStatus = 'standby' | 'countdown' | 'running';

export interface TaskEtaTask {
  paused: boolean;
}

export interface TaskEtaContext {
  status: QueueSchedulerStatus;
  /** 倒计时剩余秒数（仅 status==='countdown' 时有意义） */
  countdownRemaining: number;
  /** 队列间隔秒数：resolveQueueDelaySeconds(taskDelayMinutes) */
  intervalSeconds: number;
  /** 该任务在「未暂停 pending」序列中的位次（0 起）；-1 = 不在序列（已暂停或非法入参） */
  runnableIndex: number;
}

/** fmt 辅助：<60s 秒级展示，否则按分钟取整。 */
function fmt(sec: number): string {
  if (sec < 60) return `${sec}s`;
  return `${Math.round(sec / 60)} 分钟`;
}

/** OPT-7：裸秒 → 人类可读（<60s 秒级；否则分钟四舍五入；负数钳 0）。面板倒计时复用。 */
export function formatCountdownHuman(sec: number): string {
  return fmt(Math.max(0, sec));
}

/**
 * 计算单个任务卡上的 ETA 文案；不需要展示时返回 null。
 * 规则按序短路（§1 规格）：
 *  1. 已暂停 → 暂停文案；未暂停但不在可执行序列（runnableIndex<0）→ null；
 *  2. running：首位「当前回合结束后倒计时 N 执行」；第 k+1 位「最早约 (k+1)*interval 后（第 k+1 位）」；
 *  3. countdown：首位 live 文案过 formatCountdownHuman 口径（<60s 秒级、≥60s 分钟取整，负数钳 0）；第 k+1 位「最早约 cd + k*interval 后（第 k+1 位）」；
 *  4. standby：待命文案（常规熔断会先暂停全部 pending 被规则 1 拦截；例外：消息创建失败路径的
 *     halt_* 与熔断后新入队任务未暂停，会显示本条待命文案）。
 */
export function taskEtaText(task: TaskEtaTask, ctx: TaskEtaContext): string | null {
  if (task.paused) return '已暂停 · 点恢复后重新计时';
  const idx = ctx.runnableIndex;
  if (!Number.isFinite(idx) || idx < 0) return null;

  // interval 非法（非有限 / ≤0）回落 300s。
  const interval = Number.isFinite(ctx.intervalSeconds) && ctx.intervalSeconds > 0 ? ctx.intervalSeconds : 300;
  const cd = Number.isFinite(ctx.countdownRemaining) ? Math.max(ctx.countdownRemaining, 0) : 0;

  switch (ctx.status) {
    case 'running':
      if (idx === 0) return `当前回合结束后倒计时 ${fmt(interval)} 执行`;
      return `最早约 ${fmt((idx + 1) * interval)} 后（第 ${idx + 1} 位）`;
    case 'countdown':
      // OPT-7 收尾：首位过人类可读口径（<60s 秒级、≥60s 分钟取整），与同屏倒计时横幅同源。
      if (idx === 0) return `${formatCountdownHuman(cd)} 后执行`;
      return `最早约 ${fmt(cd + idx * interval)} 后（第 ${idx + 1} 位）`;
    case 'standby':
      return '待命 · 完成一次会话或点恢复后调度';
    default:
      return null;
  }
}
