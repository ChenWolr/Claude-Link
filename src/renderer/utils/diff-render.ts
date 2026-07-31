// diff-render.ts
// DiffBody（渲染器）与 DiffDialog（壳：header 计数 / 改动导航）共用的纯渲染辅助函数。
// 全部基于 ParsedDiffFile（diff-parser 输出）做派生计算，无 DOM/Vue 依赖。
//
// 这些函数对应 prototypes/diff-viewer.html 里的 buildInlineRows / inlineVisiblePlan /
// countChanges / isHunkGroup / navCount，逐段搬过来并参数化（ignoreWs/context 由调用方传）。

import type { DiffGroup, DiffLine, DiffSeg, ParsedDiffFile } from './diff-parser';

/** 该组是否算「改动」（参与改动导航 nav 与高亮）。ctx 永远不算；ws 在忽略空白时不算。 */
export function isHunkGroup(g: DiffGroup, ignoreWs: boolean): boolean {
  return g.k !== 'ctx' && !(g.k === 'ws' && ignoreWs);
}

/** 统计 +/- 行数（header 摘要与侧栏计数用）。ws 总算改动（与原型 countChanges 一致，不受 ignoreWs 影响）。 */
export function countChanges(f: ParsedDiffFile): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const g of f.groups) {
    if (g.k === 'add') add += g.R.length;
    else if (g.k === 'del') del += g.L.length;
    else if (g.k === 'mod' || g.k === 'ws') {
      del += g.L.length;
      add += g.R.length;
    }
  }
  return { add, del };
}

export interface InlineRow {
  type: 'ctx' | 'add' | 'del';
  n: number | null;
  line: DiffLine;
  changed: boolean;
}

/**
 * 把分组结构摊平为内联模式的单栏行序列。
 * - ctx /（忽略空白时的 ws）→ 各行原样，未改动。
 * - add → 其 R 行，改动；del → 其 L 行，改动。
 * - mod/ws（1:1）→ 先旧行(del)后新行(add)，两行都改动。
 */
export function buildInlineRows(f: ParsedDiffFile, ignoreWs: boolean): InlineRow[] {
  const rows: InlineRow[] = [];
  for (const g of f.groups) {
    if (g.k === 'ctx' || (g.k === 'ws' && ignoreWs)) {
      const L = g.L;
      g.R.forEach((rl, i) => rows.push({ type: 'ctx', n: rl ? rl.n : L[i] ? L[i].n : null, line: rl ?? L[i], changed: false }));
    } else if (g.k === 'add') {
      for (const r of g.R) rows.push({ type: 'add', n: r.n, line: r, changed: true });
    } else if (g.k === 'del') {
      for (const l of g.L) rows.push({ type: 'del', n: l.n, line: l, changed: true });
    } else if (g.k === 'mod' || g.k === 'ws') {
      // mod/ws 恒 1:1：先旧后新，两行均标改动（内联合并视图）。
      rows.push({ type: 'del', n: g.L[0].n, line: g.L[0], changed: true });
      rows.push({ type: 'add', n: g.R[0].n, line: g.R[0], changed: true });
    }
  }
  return rows;
}

/**
 * 内联可见性规划：每行到最近改动行的双向距离，距离 ≤ N 的未改动行也显示（改动上下文）。
 * 返回与 rows 等长的可见布尔数组。
 */
export function inlineVisiblePlan(rows: InlineRow[], n: number): boolean[] {
  const len = rows.length;
  const dL = new Array<number>(len).fill(Infinity);
  let d = Infinity;
  for (let i = 0; i < len; i++) {
    d = rows[i].changed ? 0 : d + 1;
    dL[i] = d;
  }
  const dR = new Array<number>(len).fill(Infinity);
  d = Infinity;
  for (let i = len - 1; i >= 0; i--) {
    d = rows[i].changed ? 0 : d + 1;
    dR[i] = d;
  }
  return rows.map((r, i) => r.changed || Math.min(dL[i], dR[i]) <= n);
}

/** 并排模式改动组数 = 改动导航总数（split 的 nav 上限）。 */
export function countSplitHunks(f: ParsedDiffFile, ignoreWs: boolean): number {
  let n = 0;
  for (const g of f.groups) if (isHunkGroup(g, ignoreWs)) n++;
  return n;
}

/** 内联模式改动段数 = 改动导航总数（含改动的可见连续段数）。 */
export function countInlineHunks(f: ParsedDiffFile, ignoreWs: boolean, context: number): number {
  const rows = buildInlineRows(f, ignoreWs);
  const vis = inlineVisiblePlan(rows, context);
  let c = 0;
  let i = 0;
  while (i < rows.length) {
    const v = vis[i];
    const s = i;
    while (i < rows.length && vis[i] === v) i++;
    if (v && rows.slice(s, i).some((r) => r.changed)) c++;
  }
  return c;
}

// ===== 并排：成对行数组（contrast 风格，数据层对齐，无运行时偏移）=====

export interface SplitSide {
  n: number | null;
  t: string;
  segs?: DiffSeg[];
}

export interface SplitRow {
  /** same=未改(ctx) / add / del / mod（mod 与 ws 合并配色，按 mod） */
  kind: 'same' | 'add' | 'del' | 'mod';
  /** 所属 group 在 f.groups 中的下标 */
  groupIndex: number;
  /** 改动导航序号（仅改动行有）；same 行为 null */
  navIndex: number | null;
  /** 改动 chunk 首行（box-shadow 上边框） */
  chunkStart: boolean;
  /** 改动 chunk 末行（box-shadow 下边框） */
  chunkEnd: boolean;
  /** null = 左栏占位（对侧纯增时） */
  left: SplitSide | null;
  /** null = 右栏占位（对侧纯删时） */
  right: SplitSide | null;
}

/**
 * 把 groups 拍平为左右等长的成对行数组（对齐在数据层完成，无需运行时偏移）。
 * - ctx → 每行 same（L[i]/R[i] 各取一行；行号 L 旧 / R 新）
 * - add → 左 null + 右行；del → 左行 + 右 null
 * - mod/ws（恒 1:1）→ 左右各一行，带 LCS segs（同时 chunkStart+chunkEnd）
 * 替代 DiffBody 模板里的 pad=Math.max(L,R) 循环 + 占位逻辑。
 */
export function buildSplitRows(f: ParsedDiffFile, ignoreWs: boolean): SplitRow[] {
  const rows: SplitRow[] = [];
  let nav = 0;
  f.groups.forEach((g, gi) => {
    const isHunk = isHunkGroup(g, ignoreWs);
    const navIndex = isHunk ? nav++ : null;
    const push = (
      kind: SplitRow['kind'],
      l: DiffLine | null,
      r: DiffLine | null,
      chunkStart: boolean,
      chunkEnd: boolean,
    ): void => {
      const wrap = (ln: DiffLine | null): SplitSide | null =>
        ln ? { n: ln.n, t: ln.t, segs: ln.segs } : null;
      rows.push({ kind, groupIndex: gi, navIndex, chunkStart, chunkEnd, left: wrap(l), right: wrap(r) });
    };

    if (g.k === 'ctx') {
      const n = Math.max(g.L.length, g.R.length);
      for (let i = 0; i < n; i++) push('same', g.L[i] ?? null, g.R[i] ?? null, false, false);
    } else if (g.k === 'add') {
      g.R.forEach((r, i) => push('add', null, r, i === 0, i === g.R.length - 1));
    } else if (g.k === 'del') {
      g.L.forEach((l, i) => push('del', l, null, i === 0, i === g.L.length - 1));
    } else {
      // mod/ws 恒 1:1：单行，左右都真，带 segs
      push('mod', g.L[0], g.R[0], true, true);
    }
  });
  return rows;
}

export type SplitVisibleItem =
  | { kind: 'row'; row: SplitRow }
  | { kind: 'fold'; count: number; firstN: number | null; lastN: number | null; foldId: number };

/**
 * onlyChanges 关闭 → 全部行。
 * onlyChanges 开启 → 夹在两段改动间的连续 same 段收成 fold 分隔条；expanded 命中的 fold 直接吐 row（展开）。
 * 首/尾贴边的 same 段（只一侧有改动）不折叠，避免开头/结尾就折叠。
 */
export function planSplitVisible(
  rows: SplitRow[],
  onlyChanges: boolean,
  expanded: Set<number>,
): SplitVisibleItem[] {
  if (!onlyChanges) return rows.map((row) => ({ kind: 'row' as const, row }));
  const out: SplitVisibleItem[] = [];
  let foldId = 0;
  let i = 0;
  while (i < rows.length) {
    const row = rows[i]!;
    if (row.kind !== 'same') {
      out.push({ kind: 'row', row });
      i++;
      continue;
    }
    const start = i;
    while (i < rows.length && rows[i]!.kind === 'same') i++;
    const slice = rows.slice(start, i);
    const touchedBothSides = start > 0 && i < rows.length; // 夹在两段改动之间才折叠
    if (touchedBothSides && !expanded.has(foldId)) {
      const last = slice[slice.length - 1]!;
      out.push({
        kind: 'fold',
        count: slice.length,
        foldId: foldId++,
        firstN: slice[0]!.left?.n ?? slice[0]!.right?.n ?? null,
        lastN: last.left?.n ?? last.right?.n ?? null,
      });
    } else {
      if (touchedBothSides) foldId++; // 展开的 fold 也要消耗 foldId，保持 id 与 same 段一一对应、稳定
      for (const r of slice) out.push({ kind: 'row', row: r });
    }
  }
  return out;
}
