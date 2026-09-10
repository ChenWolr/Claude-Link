// format-duration.ts
// 回复耗时（durationMs）→ 展示文案的共享纯函数，仅主流程使用：TurnTimer 实时/完成态与气泡脚注共用。
// 子 Agent 组耗时用 subagent-groups.ts 的 formatDuration（秒一档，无分：秒），工具行耗时在
// ToolCallBlock 内联格式化，三者口径不互通。
//
// 规则：< 60s 显示一位小数秒（如 3.7s），≥ 60s 显示分:秒（如 1:23）。非有限值 / ≤0 兜底 0.0s。
// 这样 TurnTimer 运行中计时与结束后气泡脚注的耗时数字口径一致，不会出现「运行中 3.7s、结束后 3.70s」的割裂。

export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '0.0s';
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rs = Math.floor(s % 60);
  return `${m}:${String(rs).padStart(2, '0')}`;
}
