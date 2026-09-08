// max-turns.ts
// 「最大轮次」（--max-turns）的共享契约：默认值与清洗。
// 主进程（config-manager 读时清洗/落盘兜底）与渲染层（ConfigPage 输入失焦夹取）共用同一实现，
// 避免两处各写一份边界判断（对齐 queue-config 的 sanitizeTaskDelayMinutes 先例）。
// 三条执行链（直发 CHAT_SEND / 卡死·重放重发 / 任务队列）统一从 config 取值（getConfig().maxTurns），
// 本清洗保证 config 里的值恒为正整数，sdk-command-options 的 >0 守卫不会再静默丢旗标
// （丢旗标 = 会话无轮次上限运行，违背设置语义）。

export const DEFAULT_MAX_TURNS = 200;

/**
 * 清洗用户填写的最大轮次：null/空白串/非有限数字（NaN/undefined/不可解析字符串）回落默认 200；
 * ≤0 同样回落默认（UI 清空输入框经 v-model.number 是空串，Number('')=0 会伪装成合法下界）；
 * 小数向下取整。
 */
export function sanitizeMaxTurns(raw: unknown): number {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return DEFAULT_MAX_TURNS;
  }
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_MAX_TURNS;
  return Math.floor(n);
}
