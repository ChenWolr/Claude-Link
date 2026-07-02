// time.ts
// DB 时间戳规范化（shared 纯函数，主进程各 repo 读回时间字段时统一调用）。
//
// 背景：SQLite datetime('now') 返回 "YYYY-MM-DD HH:MM:SS"（UTC，但无时区标记）。
// 前端 new Date(raw) 会按「本地时区」解析——UTC+8 下比真实 UTC 早 8 小时。而本回合内存消息
// 用的是 new Date().toISOString()（带 Z，正确 UTC）。两者一旦在 store 里混合（典型：子 Agent
// 运行中切会话再切回，历史消息被 DB 重读为无 Z，新到的内存消息带 Z），做差计时（如
// subagent-groups 的 frozenSeconds = completionMs − startMs）就会多出整整 8 小时
// （实测「补查广州天气」显示 29011.6s ≈ 28800s 时区 + 211s 真实耗时）。
//
// 解法：各 repo（message/task/session/interaction-history）读回时间字段时统一调 normalizeDbTime，
// 把 SQLite datetime 补成 ISO UTC（带 Z），与内存基准对齐，根治时区误差。
// null 入参原样返回（适配 nullable 列，如 task.started_at）。

/**
 * 把 SQLite datetime('now') 的 "YYYY-MM-DD HH:MM:SS"（UTC 无 Z）规范化为 ISO 8601 UTC（带 Z）。
 * 已带时区后缀（Z / ±HH:MM）或非 datetime 形态原样返回；null 原样返回 null。
 */
export function normalizeDbTime(raw: string): string;
export function normalizeDbTime(raw: string | null): string | null;
export function normalizeDbTime(raw: string | null): string | null {
  if (!raw) return raw;
  if (
    /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/.test(raw) &&
    !/[zZ]$/.test(raw) &&
    !/[+-]\d{2}:?\d{2}$/.test(raw)
  ) {
    return `${raw.replace(' ', 'T')}Z`;
  }
  return raw;
}
