// turn-file-diff.ts
// 轮末文件改动（turn-diff，计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan
// §3.4 原文）：turnDiff:listSummaries / turnDiff:filePatch 两 invoke 通道的载荷类型。
// 单一真相源：主进程聚合模块 src/main/modules/turn-diff.ts 产形，preload / web-bridge / 渲染层
// 三处共用本类型（type-only，无运行时代码）。

export type TurnFileDiffMode = 'full' | 'first-change' | 'unavailable';

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
