// turn-file-diff.ts
// 轮末文件改动（turn-diff，计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan
// §3.4 原文）：turnDiff:listSummaries / turnDiff:filePatch 两 invoke 通道的载荷类型。
// 单一真相源：主进程聚合模块 src/main/modules/turn-diff.ts 产形，preload / web-bridge / 渲染层
// 三处共用本类型（type-only，无运行时代码）。

// mode（p5 2026-10-27 增 'intent'）：full=磁盘快照对比；first-change=快照在但无 before（首改，
// 按编辑意图合成）；intent=快照缺失（二进制含 \0 / 读盘 failed）时按 tool_use 入参合成的编辑意图
// diff（与工具行逐次 diff 同源）；unavailable=快照与意图均不可用（入参缺失/被截断）。
export type TurnFileDiffMode = 'full' | 'first-change' | 'intent' | 'unavailable';

export interface TurnFileDiffItem {
  path: string;
  additions: number;
  deletions: number;
  writeCount: number;
  mode: TurnFileDiffMode;
}

export interface TurnFileDiffTurnSummary {
  turnStartMessageId: string;
  items: TurnFileDiffItem[];
}
