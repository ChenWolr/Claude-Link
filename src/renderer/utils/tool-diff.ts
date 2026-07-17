// 从 Edit / MultiEdit / Write 的 tool_use 入参合成「片段意图」unified diff，供 ToolCallBlock 复用
// markdown.ts 的 renderDiffHtml 显示。
//
// 背景：Claude Code 的 Write/Edit tool_result 只是一句成功提示
// （"The file X has been updated successfully. (file state is current…)"），不含 diff；
// 但 tool_use 入参本身已携带 old_string/new_string（Edit/MultiEdit）或 content（Write），
// 足以反推一段意图 diff。
//
// 这是「片段意图 diff」：表达本次工具想改什么，不是文件相对 git 的真实净改动。
// 真实全文件 diff 由右侧「改动」面板按需 git diff 提供（不在此处抓改前快照，避免时序竞态）。

import { TOOL_DIFF_TOOL_NAMES, MAX_DIFF_LINES } from '../../shared/process-kind';

export type ToolDiffKind = 'edit' | 'multiedit' | 'write';

export interface ToolDiffResult {
  kind: ToolDiffKind;
  filePath: string;
  /** unified diff 文本，可直接喂 renderDiffHtml。无变化时为空串。 */
  diff: string;
  /** 变更行数（-/+ 合计，含被截断部分），供折叠态徽标与截断提示用。 */
  changeCount: number;
  /** 新增 / 删除行数（含被截断部分，供折叠态 +/− 徽标，不受截断影响）。 */
  additions: number;
  deletions: number;
  /** 是否因超过 MAX_DIFF_LINES 被截断（仅展示前部分）。 */
  truncated: boolean;
}

interface EditLikeInput {
  file_path?: unknown;
  old_string?: unknown;
  new_string?: unknown;
}

interface MultiEditInput {
  file_path?: unknown;
  edits?: unknown;
}

interface WriteInput {
  file_path?: unknown;
  content?: unknown;
}

const EDIT_TOOL_NAMES = new Set(['Edit', 'edit']);
const MULTIEDIT_TOOL_NAMES = new Set(['MultiEdit', 'multiedit', 'multi_edit']);
const WRITE_TOOL_NAMES = new Set(['Write', 'write']);
// 入口过滤：与右侧改动面板的触碰集采集共用同一份工具名集合（src/shared/process-kind）。
const TOOL_DIFF_NAMES = new Set(TOOL_DIFF_TOOL_NAMES);

// 行级 LCS 的 DP 表单元数上限。经前缀/后缀裁剪后只对差异中段跑 DP，此上限仅兜底极端情况。
const LCS_CELL_CAP = 200_000;

type DiffOp = 'context' | 'add' | 'del';
interface DiffLine {
  op: DiffOp;
  text: string;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asEdits(value: unknown): { old_string: string; new_string: string }[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => ({
    old_string: asString((entry as { old_string?: unknown })?.old_string),
    new_string: asString((entry as { new_string?: unknown })?.new_string),
  }));
}

// 统一反斜杠→正斜杠（Windows 路径在 diff 头里更好看），去首尾空白；空回退 'file'。
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
function buildTwoFilePatch(filePath: string, oldText: string, newText: string, context = 3): PatchResult {
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

// 从 Edit/MultiEdit/Write 的 tool_use 入参合成「片段意图」unified diff。
// 返回 null：非这三类工具、入参非对象、或无变化（old===new / 空 Write）。
export function synthesizeToolDiff(toolName: string, input: unknown): ToolDiffResult | null {
  if (input == null || typeof input !== 'object') return null;
  const name = toolName.trim();
  if (!TOOL_DIFF_NAMES.has(name)) return null;
  const fields = input as EditLikeInput & MultiEditInput & WriteInput;
  const filePath = asString(fields.file_path);

  if (EDIT_TOOL_NAMES.has(name)) {
    const patch = buildTwoFilePatch(filePath, asString(fields.old_string), asString(fields.new_string));
    return patch.diff ? { kind: 'edit', filePath, ...patch } : null;
  }

  if (MULTIEDIT_TOOL_NAMES.has(name)) {
    // 无文件内偏移，逐条 edit 各成一段 patch 拼接，diff2html 渲染为同名文件多张卡片。
    const parts: string[] = [];
    let changeCount = 0;
    let additions = 0;
    let deletions = 0;
    let truncated = false;
    for (const edit of asEdits(fields.edits)) {
      const patch = buildTwoFilePatch(filePath, edit.old_string, edit.new_string);
      if (patch.diff) {
        parts.push(patch.diff);
        changeCount += patch.changeCount;
        additions += patch.additions;
        deletions += patch.deletions;
        truncated = truncated || patch.truncated;
      }
    }
    if (parts.length === 0) return null;
    return { kind: 'multiedit', filePath, diff: parts.join('\n'), changeCount, additions, deletions, truncated };
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    // Write 无旧内容，整段按新增展示（片段意图；真实新建/覆盖区分见右侧「改动」面板的 git diff）。
    const patch = buildTwoFilePatch(filePath, '', asString(fields.content));
    return patch.diff ? { kind: 'write', filePath, ...patch } : null;
  }

  return null;
}
