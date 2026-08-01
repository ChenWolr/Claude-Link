// diff-render.ts
// DiffBody（渲染器）与 DiffDialog（壳：header 计数 / 改动导航）共用的纯渲染辅助函数。
// 全部基于 ParsedDiffFile（diff-parser 输出）做派生计算，无 DOM/Vue 依赖。
//
// 这些函数对应 prototypes/diff-viewer.html 里的 buildInlineRows / inlineVisiblePlan /
// countChanges / isHunkGroup / navCount，逐段搬过来并参数化（context 由调用方传）。

import type { DiffGroup, DiffLine, DiffSeg, ParsedDiffFile } from './diff-parser';

/** 该组是否算「改动」（参与改动导航 nav 与高亮）。ctx/skip 永远不算；ws 算改动。 */
export function isHunkGroup(g: DiffGroup): boolean {
  return g.k !== 'ctx' && g.k !== 'skip';
}

/** 统计 +/- 行数（header 摘要与侧栏计数用）。ws 总算改动（与原型 countChanges 一致）。 */
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
  type: 'ctx' | 'add' | 'del' | 'skip';
  n: number | null;
  line: DiffLine;
  changed: boolean;
  /** 仅 skip 行：相邻 hunk 间 git 跳过的行数（渲染「⋯ N 行」分隔） */
  skipCount?: number;
}

/**
 * 把分组结构摊平为内联模式的单栏行序列。
 * - ctx → 各行原样，未改动。
 * - add → 其 R 行，改动；del → 其 L 行，改动。
 * - mod/ws（1:1）→ 先旧行(del)后新行(add)，两行都改动。
 */
export function buildInlineRows(f: ParsedDiffFile): InlineRow[] {
  const rows: InlineRow[] = [];
  for (const g of f.groups) {
    if (g.k === 'skip') {
      // 相邻 hunk 间跳过的行 → skip 行（始终可见 + 阻断 context 距离，渲染「⋯ N 行」分隔）
      rows.push({ type: 'skip', n: null, line: { n: null, t: '' }, changed: false, skipCount: g.skipCount ?? 0 });
    } else if (g.k === 'ctx') {
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
    if (rows[i].type === 'skip') { d = Infinity; dL[i] = Infinity; continue; } // skip 阻断跨 hunk 距离
    d = rows[i].changed ? 0 : d + 1;
    dL[i] = d;
  }
  const dR = new Array<number>(len).fill(Infinity);
  d = Infinity;
  for (let i = len - 1; i >= 0; i--) {
    if (rows[i].type === 'skip') { d = Infinity; dR[i] = Infinity; continue; }
    d = rows[i].changed ? 0 : d + 1;
    dR[i] = d;
  }
  return rows.map((r, i) => r.type === 'skip' || r.changed || Math.min(dL[i], dR[i]) <= n);
}

/** 并排模式改动组数 = 改动导航总数（split 的 nav 上限）。 */
export function countSplitHunks(f: ParsedDiffFile): number {
  let n = 0;
  for (const g of f.groups) if (isHunkGroup(g)) n++;
  return n;
}

/** 内联模式改动段数 = 改动导航总数（含改动的可见连续段数）。 */
export function countInlineHunks(f: ParsedDiffFile, context: number): number {
  const rows = buildInlineRows(f);
  const vis = inlineVisiblePlan(rows, context);
  let c = 0;
  let i = 0;
  while (i < rows.length) {
    if (rows[i].type === 'skip') { i++; continue; } // skip 推进，不算改动段（否则内层断开但外层不推进 → 死循环）
    const v = vis[i];
    const s = i;
    while (i < rows.length && vis[i] === v && rows[i].type !== 'skip') i++; // skip 断开分段
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
  /** same=未改(ctx) / add / del / mod（mod 与 ws 合并配色，按 mod）/ skip（hunk 间分隔） */
  kind: 'same' | 'add' | 'del' | 'mod' | 'skip';
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
  /** 仅 skip 行：相邻 hunk 间跳过的行数（渲染「⋯ N 行」分隔） */
  skipCount?: number;
}

/**
 * 把 groups 拍平为左右等长的成对行数组（对齐在数据层完成，无需运行时偏移）。
 * - ctx → 每行 same（L[i]/R[i] 各取一行；行号 L 旧 / R 新）
 * - add → 左 null + 右行；del → 左行 + 右 null
 * - mod/ws（恒 1:1）→ 左右各一行，带 LCS segs（同时 chunkStart+chunkEnd）
 * 替代 DiffBody 模板里的 pad=Math.max(L,R) 循环 + 占位逻辑。
 */
export function buildSplitRows(f: ParsedDiffFile): SplitRow[] {
  const rows: SplitRow[] = [];
  let nav = 0;
  f.groups.forEach((g, gi) => {
    const isHunk = isHunkGroup(g);
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

    if (g.k === 'skip') {
      rows.push({ kind: 'skip', groupIndex: gi, navIndex: null, chunkStart: false, chunkEnd: false, left: null, right: null, skipCount: g.skipCount ?? 0 });
    } else if (g.k === 'ctx') {
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

// ===== split chunk 模型（contrast 风格：左右各自完整渲染 + chunk 对齐 + 偏移 + 桥）=====
// 与上方 buildSplitRows（null 占位静态对齐）并存；split 渲染层切到本模型。inline 不受影响。

export type SplitChunkKind = 'same' | 'add' | 'del' | 'edit';

export interface SplitChunk {
  kind: SplitChunkKind;
  leftStart: number;
  rightStart: number;
  leftSize: number;
  rightSize: number;
  size: number;
  navIndex: number | null;
}

export interface SplitLayout {
  leftLines: DiffLine[];
  rightLines: DiffLine[];
  chunks: SplitChunk[];
  /** river 总高度（px）。lineHeight 由调用方传（DiffBody 传 --diff-line-h，默认 22）。 */
  riverHeight: number;
}

/**
 * 把 ParsedDiffFile.groups 拍成 SplitLayout：左右栏各自完整行序列 + 对齐块。
 * - ctx → same（leftSize=rightSize=L.length）
 * - add → add（leftSize=0）
 * - del → del（rightSize=0）
 * - mod/ws → edit（1:1，恒 leftSize=rightSize=1）
 * - **相邻 del group + add group（中间无 ctx/skip/mod）→ 合并为单个 edit chunk（M:N）**
 *   （classifyRun 已把不等长改动拆成相邻 del+add；此处把它们在渲染层重新识别为一个 edit）
 * - skip → 不产出 chunk（hunk 间分隔由 DiffBody 另行渲染「⋯ N 行」）
 * navIndex 仅对改动块（add/del/edit）递增；same 为 null。
 */
export function buildSplitChunks(
  f: ParsedDiffFile,
  lineHeight = 22,
): SplitLayout {
  const leftLines: DiffLine[] = [];
  const rightLines: DiffLine[] = [];
  const chunks: SplitChunk[] = [];
  let nav = 0;

  const pushLines = (L: DiffLine[], R: DiffLine[]): { l0: number; r0: number } => {
    const l0 = leftLines.length;
    const r0 = rightLines.length;
    for (const x of L) leftLines.push(x);
    for (const x of R) rightLines.push(x);
    return { l0, r0 };
  };

  for (let i = 0; i < f.groups.length; i++) {
    const g = f.groups[i]!;
    if (g.k === 'skip') continue;

    // 相邻 del+add → 合并 edit（M:N）
    if (g.k === 'del' && i + 1 < f.groups.length && f.groups[i + 1]!.k === 'add') {
      const next = f.groups[i + 1]!;
      const { l0, r0 } = pushLines(g.L, next.R);
      chunks.push({
        kind: 'edit',
        leftStart: l0,
        rightStart: r0,
        leftSize: g.L.length,
        rightSize: next.R.length,
        size: Math.max(g.L.length, next.R.length),
        navIndex: nav++,
      });
      i++; // 消费掉相邻的 add
      continue;
    }

    if (g.k === 'ctx') {
      const { l0, r0 } = pushLines(g.L, g.R);
      chunks.push({
        kind: 'same', leftStart: l0, rightStart: r0,
        leftSize: g.L.length, rightSize: g.R.length,
        size: Math.max(g.L.length, g.R.length), navIndex: null,
      });
    } else if (g.k === 'add') {
      const { l0, r0 } = pushLines([], g.R);
      chunks.push({
        kind: 'add', leftStart: l0, rightStart: r0,
        leftSize: 0, rightSize: g.R.length, size: g.R.length, navIndex: nav++,
      });
    } else if (g.k === 'del') {
      const { l0, r0 } = pushLines(g.L, []);
      chunks.push({
        kind: 'del', leftStart: l0, rightStart: r0,
        leftSize: g.L.length, rightSize: 0, size: g.L.length, navIndex: nav++,
      });
    } else {
      // mod/ws（恒 1:1）
      const { l0, r0 } = pushLines(g.L, g.R);
      chunks.push({
        kind: 'edit', leftStart: l0, rightStart: r0,
        leftSize: g.L.length, rightSize: g.R.length,
        size: Math.max(g.L.length, g.R.length), navIndex: nav++,
      });
    }
  }

  const totalRows = chunks.reduce((a, c) => a + c.size, 0);
  return { leftLines, rightLines, chunks, riverHeight: totalRows * lineHeight };
}

// ===== 焦点对齐偏移 + 动态桥几何（阶段 2：magic scrolling）=====

export interface Offsets { left: number; right: number; }

/**
 * 移植 contrast scrollY 的焦点 1/3 对齐：焦点 = 视口顶部下 1/3 处。
 * 找焦点所在 chunk，让该 chunk 左右两侧在 river 空间对齐——
 *   base = (riverStart - sideStart) × lineHeight  （让侧顶部对齐 river 顶部）
 *   + percent × (size - sideSize) × lineHeight     （按 chunk 内进度，较窄侧往下推）
 * 焦点超出范围 → {0,0}。
 */
export function computeOffsets(
  chunks: SplitChunk[],
  scrollTop: number,
  viewportH: number,
  lineHeight: number,
): Offsets {
  const focalPoint = Math.floor(viewportH / 3) + scrollTop;
  const focalLine = Math.floor(Math.max(0, focalPoint) / lineHeight);

  let riverLine = 0;
  let target: SplitChunk | null = null;
  let riverStart = 0;
  for (const c of chunks) {
    if (focalLine >= riverLine && focalLine < riverLine + c.size) {
      target = c; riverStart = riverLine; break;
    }
    riverLine += c.size;
  }
  if (!target) return { left: 0, right: 0 };

  const size = target.size || 1;
  const percent = (focalPoint / lineHeight - riverStart) / size;

  const left = (riverStart - target.leftStart) * lineHeight
             + percent * (size - target.leftSize) * lineHeight;
  const right = (riverStart - target.rightStart) * lineHeight
              + percent * (size - target.rightSize) * lineHeight;
  return { left, right };
}

/**
 * 单个桥的几何（随 offsets 变化）。移植 contrast drawBridge L380-420（去掉 1px 微调）。
 * 返回 SVG polygon 的 4 点 + 容器 top/height。viewBox=0 0 100 100，preserveAspectRatio=none 横向拉伸。
 */
export function bridgePolygon(
  c: SplitChunk,
  offsets: Offsets,
  lineHeight: number,
): { kind: SplitChunk['kind']; top: number; height: number; points: string } {
  const leftTop = c.leftStart * lineHeight + offsets.left;
  const rightTop = c.rightStart * lineHeight + offsets.right;
  const leftBottom = leftTop + Math.max(c.leftSize, 1) * lineHeight;
  const rightBottom = rightTop + Math.max(c.rightSize, 1) * lineHeight;
  const top = Math.min(leftTop, rightTop);
  const bottom = Math.max(leftBottom, rightBottom);
  const height = Math.max(bottom - top, 2);
  const p = (x: number, y: number) => `${x},${Math.round((y - top) * 10) / 10}`;
  const points = [p(0, leftTop), p(100, rightTop), p(100, rightBottom), p(0, leftBottom)].join(' ');
  return { kind: c.kind, top, height, points };
}
