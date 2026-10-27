// 行级 diff 核心纯函数：从 src/renderer/utils/tool-diff.ts 原样提取（纯机械搬移，零逻辑/常量改动），
// 供渲染层 tool-diff.ts（re-export，现有导入方零改动）与主进程回合文件改动聚合（turn-diff）双端同源复用。
// 职责：两段文本 → 单文件 unified diff（含 @@ hunk、MAX_DIFF_LINES 截断）与 ± 计数。

import { MAX_DIFF_LINES } from './process-kind';

// 行级 LCS 的 DP 表单元数上限。经前缀/后缀裁剪后只对差异中段跑 DP，此上限仅兜底极端情况。
const LCS_CELL_CAP = 200_000;

type DiffOp = 'context' | 'add' | 'del';
interface DiffLine {
  op: DiffOp;
  text: string;
}

// 统一反斜杠→正斜杠（Windows 路径在 diff 头里更好看），去首尾空白与前导斜杠（POSIX 绝对路径的 / 也会被剥掉，仅影响 diff 头显示文本）；空回退 'file'。
function normalizePath(path: string): string {
  const normalized = path.trim().replace(/\\+/g, '/').replace(/^\/+/, '');
  return normalized || 'file';
}

// 按行切分；去掉末尾换行产生的空尾元素，避免 diff 多一条空行；空串 → []。
function toLines(text: string): string[] {
  if (text === '') return [];
  const stripped = text.endsWith('\n') ? text.slice(0, -1) : text;
  return stripped.split('\n');
}

// 行级最长公共子序列 diff。返回带 op 标记的行序列（add=新侧，del=旧侧，context=公共）。
function lineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const n = oldLines.length;
  const m = newLines.length;
  if (n === 0) return newLines.map((text) => ({ op: 'add' as const, text }));
  if (m === 0) return oldLines.map((text) => ({ op: 'del' as const, text }));

  if (n * m > LCS_CELL_CAP) {
    // 退化为整段替换：先删 old，再加 new。保留「改前/改后」语义，放弃行级对齐。
    return [
      ...oldLines.map((text) => ({ op: 'del' as const, text })),
      ...newLines.map((text) => ({ op: 'add' as const, text })),
    ];
  }

  // dp[i][j] = oldLines[i..] 与 newLines[j..] 的 LCS 长度。从右下往左上填，复用下一行。
  const dp: Uint32Array[] = new Array(n + 1);
  for (let i = 0; i <= n; i++) dp[i] = new Uint32Array(m + 1);
  for (let i = n - 1; i >= 0; i--) {
    const row = dp[i];
    const next = dp[i + 1];
    const ai = oldLines[i];
    for (let j = m - 1; j >= 0; j--) {
      row[j] =
        ai === newLines[j]
          ? next[j + 1] + 1
          : next[j] >= row[j + 1]
            ? next[j]
            : row[j + 1];
    }
  }

  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ op: 'context', text: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ op: 'del', text: oldLines[i] });
      i++;
    } else {
      out.push({ op: 'add', text: newLines[j] });
      j++;
    }
  }
  while (i < n) {
    out.push({ op: 'del', text: oldLines[i] });
    i++;
  }
  while (j < m) {
    out.push({ op: 'add', text: newLines[j] });
    j++;
  }
  return out;
}

interface PatchResult {
  diff: string;
  changeCount: number;
  additions: number;
  deletions: number;
  truncated: boolean;
}

// 把 old/new 文本合成单文件的 unified diff（含 @@ hunk、最多 context 行上下文）。
// 先裁公共前缀/后缀，只对差异中段跑 LCS——大文件小改动时 DP 规模从 O(n*m) 降到差异区域。
// 生成体超过 MAX_DIFF_LINES 时按 hunk/行截断，spans 按保留体重算，保持 unified diff 合法。
// 无变更返回 { diff: '', changeCount: 0, additions: 0, deletions: 0, truncated: false }。
export function buildTwoFilePatch(filePath: string, oldText: string, newText: string, context = 3): PatchResult {
  const a = toLines(oldText);
  const b = toLines(newText);

  const minLen = Math.min(a.length, b.length);
  let prefix = 0;
  while (prefix < minLen && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < minLen - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;

  const midOps = lineDiff(a.slice(prefix, a.length - suffix), b.slice(prefix, b.length - suffix));
  const totalChanges = midOps.filter((o) => o.op !== 'context').length;
  if (totalChanges === 0) return { diff: '', changeCount: 0, additions: 0, deletions: 0, truncated: false };
  let additions = 0;
  let deletions = 0;
  for (const op of midOps) {
    if (op.op === 'add') additions++;
    else if (op.op === 'del') deletions++;
  }

  // 前后各取最多 context 行（来自被裁掉的公共 prefix 尾 / suffix 头）作展示上下文。
  const preContext = a.slice(Math.max(0, prefix - context), prefix);
  const sufContext = a.slice(a.length - suffix, a.length - suffix + Math.min(suffix, context));
  const ops: DiffLine[] = [
    ...preContext.map((text) => ({ op: 'context' as const, text })),
    ...midOps,
    ...sufContext.map((text) => ({ op: 'context' as const, text })),
  ];

  const headerPath = normalizePath(filePath);
  // 每个 op 索引对应的 old/new 行号（1-based）。base = preContext 之前的公共行数（旧/新相同）。
  const base = prefix - preContext.length;
  const oldLineNo = new Array<number>(ops.length);
  const newLineNo = new Array<number>(ops.length);
  let oldCount = base;
  let newCount = base;
  for (let k = 0; k < ops.length; k++) {
    oldLineNo[k] = oldCount + 1;
    newLineNo[k] = newCount + 1;
    if (ops[k].op === 'del' || ops[k].op === 'context') oldCount++;
    if (ops[k].op === 'add' || ops[k].op === 'context') newCount++;
  }

  // 变更索引 → 聚合 hunk（各带 context 行，相邻/重叠合并）。
  const changeIdx: number[] = [];
  for (let k = 0; k < ops.length; k++) if (ops[k].op !== 'context') changeIdx.push(k);
  const hunks: Array<[number, number]> = [];
  let curStart = Math.max(0, changeIdx[0] - context);
  let curEnd = Math.min(ops.length - 1, changeIdx[0] + context);
  for (let k = 1; k < changeIdx.length; k++) {
    const start = Math.max(0, changeIdx[k] - context);
    const end = Math.min(ops.length - 1, changeIdx[k] + context);
    if (start <= curEnd + 1) curEnd = Math.max(curEnd, end);
    else {
      hunks.push([curStart, curEnd]);
      curStart = start;
      curEnd = end;
    }
  }
  hunks.push([curStart, curEnd]);

  const totalBodyLines = hunks.reduce((acc, [s, e]) => acc + (e - s + 1), 0);
  const out: string[] = [`--- a/${headerPath}`, `+++ b/${headerPath}`];
  let emitted = 0;
  for (const [start, end] of hunks) {
    const body: string[] = [];
    let oldSpan = 0;
    let newSpan = 0;
    for (let k = start; k <= end; k++) {
      if (emitted >= MAX_DIFF_LINES) break;
      const op = ops[k];
      body.push((op.op === 'add' ? '+' : op.op === 'del' ? '-' : ' ') + op.text);
      emitted++;
      if (op.op === 'del' || op.op === 'context') oldSpan++;
      if (op.op === 'add' || op.op === 'context') newSpan++;
    }
    const oldStart = oldSpan === 0 ? 0 : oldLineNo[start];
    const newStart = newSpan === 0 ? 0 : newLineNo[start];
    out.push(`@@ -${oldStart},${oldSpan} +${newStart},${newSpan} @@`);
    out.push(...body);
    if (emitted >= MAX_DIFF_LINES) break;
  }

  return { diff: out.join('\n'), changeCount: totalChanges, additions, deletions, truncated: emitted < totalBodyLines };
}

// 完整文件 diff（回合文件改动聚合用）：两份全文 → 单份 unified patch。
// patch 正文超过 MAX_DIFF_LINES 时按 buildTwoFilePatch 既有截断规则截断并置 truncated=true；
// additions/deletions 按「以 '+'/'-' 开头且非 '+++'/'---' 头的行」口径从截断前完整 patch 统计
//（buildTwoFilePatch 对 add/del op 的计数与该口径恒等——每个 op 恰好产出一行 '+'/'-'，
//  文件头 '--- '/'+++ ' 均以三连字符开头被口径排除）——编排器口径 plan-notes.md N3。
export function diffFull(before: string, after: string, path: string): { patch: string; additions: number; deletions: number; truncated: boolean } {
  const result = buildTwoFilePatch(path, before, after);
  return { patch: result.diff, additions: result.additions, deletions: result.deletions, truncated: result.truncated };
}
