// queue-config.ts
// 队列任务执行节奏的共享契约：间隔分钟制的清洗与换算。
// 主进程（config-manager 脏值清洗 / task-queue-engine 倒计时）与渲染层（ConfigPage 输入失焦夹取）
// 共用同一实现，避免三处各写一份边界判断。

export const DEFAULT_TASK_DELAY_MINUTES = 5;
export const MIN_TASK_DELAY_MINUTES = 1;
export const MAX_TASK_DELAY_MINUTES = 60;

/**
 * 清洗用户填写的队列间隔（分钟）：非有限数字（null/undefined/NaN/不可解析字符串）回落默认 5；
 * 小数向下取整；随后夹取到 [1, 60]。
 */
export function sanitizeTaskDelayMinutes(raw: unknown): number {
  // null/空白串显式回落默认：Number(null)/Number('') 会静默变 0，再被夹成最低 1 分钟，
  // 违背「非法回落默认 5」的清洗意图（UI 清空输入框经 v-model.number 正是空串）。
  if (raw === null || (typeof raw === 'string' && raw.trim() === '')) return DEFAULT_TASK_DELAY_MINUTES;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_TASK_DELAY_MINUTES;
  const floored = Math.floor(n);
  if (floored < MIN_TASK_DELAY_MINUTES) return MIN_TASK_DELAY_MINUTES;
  if (floored > MAX_TASK_DELAY_MINUTES) return MAX_TASK_DELAY_MINUTES;
  return floored;
}

/** 间隔分钟 → 倒计时秒（引擎内部仍按秒调度，countdown_tick 的秒数展示不变）。 */
export function resolveQueueDelaySeconds(minutes: unknown): number {
  return sanitizeTaskDelayMinutes(minutes) * 60;
}
