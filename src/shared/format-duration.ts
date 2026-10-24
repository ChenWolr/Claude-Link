// format-duration.ts
// 回复耗时（durationMs）→ 展示文案的共享纯函数，仅主流程使用：TurnTimer 实时/完成态与气泡脚注共用。
// 另含 formatSentAt（2026-10-22 六问题计划 P1 点 S3）：用户消息发送时刻（created_at ISO 字符串）
// → 「发送于」脚注文案，见文末。
// 子 Agent 组耗时用 subagent-groups.ts 的 formatDuration（秒一档，无分：秒），工具行耗时在
// ToolCallBlock 内联格式化，三者口径不互通。
//
// 规则：< 60s 显示一位小数秒（如 3.7s），≥ 60s 显示分:秒（如 1:23），hb10-TM-06：≥3600s 显示
// H:MM:SS（如 2:05:03，长回合可读）。非有限值 / ≤0 兜底 0.0s。
// 这样 TurnTimer 运行中计时与结束后气泡脚注的耗时数字口径一致，不会出现「运行中 3.7s、结束后 3.70s」的割裂。

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  if (s >= 3600) {
    const h = Math.floor(s / 3600);
    const rm = Math.floor((s % 3600) / 60);
    const rs = Math.floor(s % 60);
    return `${h}:${String(rm).padStart(2, '0')}:${String(rs).padStart(2, '0')}`;
  }
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}:${String(rs).padStart(2, '0')}`;
}

/** hb10-TM-05：回合结束时刻展示（TurnTimer 完成态与气泡脚注共用单源）：
 *  当天显示 HH:mm:ss，跨天显示 M/d HH:mm（消除跨天歧义，秒已无参照意义）。无效值返回空串。 */
export function formatEndedAt(ts: number | null | undefined, now: number = Date.now()): string {
  if (ts == null || !Number.isFinite(ts) || ts <= 0) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const sameDay = new Date(now).toDateString() === d.toDateString();
  if (!sameDay) {
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** S3（2026-10-22 六问题计划 P1）：用户消息发送时刻展示（气泡脚注「发送于」单源）。
 *  入参是 ISO 8601 字符串（DB created_at 经 normalizeDbTime 规范为带 Z 的 UTC，或内存乐观消息
 *  的 toISOString 毫秒级），与 formatEndedAt（epoch ms 入参，TurnTimer 在用、签名不动）口径一致
 *  但类型不同，故独立成函数：当天 HH:mm（分钟级，发送时刻秒无参照意义），跨天 M/d HH:mm。
 *  空 / Date.parse 为 NaN 返回空串（诚实不造数，调用处 v-if 不渲染、无空行残留）。 */
export function formatSentAt(iso: string | null | undefined): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const d = new Date(ts);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const sameDay = new Date().toDateString() === d.toDateString();
  if (!sameDay) {
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
