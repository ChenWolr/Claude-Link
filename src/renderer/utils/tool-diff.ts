// 从 Edit / MultiEdit / Write 的 tool_use 入参合成 unified diff，供 ToolCallBlock 复用
// markdown.ts 的 renderDiffHtml 显示。
//
// 背景：Claude Code 的 Write/Edit tool_result 只是一句成功提示
// （"The file X has been updated successfully. (file state is current…)"），
// 不含 diff；官方 TUI 的 diff 是客户端拍快照对比算出来的，不随 stream-json 下发。
// 但 tool_use 入参本身已携带 old_string/new_string（Edit）或 content（Write），
// 足以在渲染层反推一段 unified diff。本模块就是这件纯逻辑：不读文件、不碰 IPC。

export type ToolDiffKind = 'edit' | 'multiedit' | 'write';

export interface ToolDiffResult {
  kind: ToolDiffKind;
  filePath: string;
  /** unified diff 文本，可直接喂 renderDiffHtml。无变化时为空串（调用方据此判空）。 */
  diff: string;
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

// 行级 LCS 的 DP 表单元数上限。old/new 都非空且乘积超此值时退化为「全删+全增」，
// 避免 O(n*m) 在超大 old_string 上爆内存。Write（旧侧空）走早退不进 DP，不受影响。
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

  // 回溯：相等取 context 并双进；否则按 DP 较优方向取 del（进 i）或 add（进 j）。
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

// 把 old/new 文本合成单文件的 unified diff（含 @@ hunk、最多 context 行上下文）。
// 无变更返回 ''。空侧用 0 起始行号（git 惯例：纯新增 -0,0 / 纯删除 +0,0）。
function buildTwoFilePatch(filePath: string, oldText: string, newText: string, context = 3): string {
  const ops = lineDiff(toLines(oldText), toLines(newText));
  const changeIndices: number[] = [];
  for (let k = 0; k < ops.length; k++) {
    if (ops[k].op !== 'context') changeIndices.push(k);
  }
  if (changeIndices.length === 0) return '';

  const headerPath = normalizePath(filePath);
  const out: string[] = [`--- a/${headerPath}`, `+++ b/${headerPath}`];

  // 把变更聚合成不重叠的 hunk 区间（每个变更各带 context 行，相邻/重叠合并）。
  const hunks: Array<[number, number]> = [];
  let currentStart = Math.max(0, changeIndices[0] - context);
  let currentEnd = Math.min(ops.length - 1, changeIndices[0] + context);
  for (let k = 1; k < changeIndices.length; k++) {
    const start = Math.max(0, changeIndices[k] - context);
    const end = Math.min(ops.length - 1, changeIndices[k] + context);
    if (start <= currentEnd + 1) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      hunks.push([currentStart, currentEnd]);
      currentStart = start;
      currentEnd = end;
    }
  }
  hunks.push([currentStart, currentEnd]);

  // 每个 op 索引对应的 old/new 行号（1-based）：到该行前累计的旧/新侧行数 + 1。
  const oldLineNo = new Array<number>(ops.length);
  const newLineNo = new Array<number>(ops.length);
  let oldCount = 0;
  let newCount = 0;
  for (let k = 0; k < ops.length; k++) {
    oldLineNo[k] = oldCount + 1;
    newLineNo[k] = newCount + 1;
    if (ops[k].op === 'del' || ops[k].op === 'context') oldCount++;
    if (ops[k].op === 'add' || ops[k].op === 'context') newCount++;
  }

  for (const [start, end] of hunks) {
    let oldSpan = 0;
    let newSpan = 0;
    const body: string[] = [];
    for (let k = start; k <= end; k++) {
      const op = ops[k];
      const prefix = op.op === 'add' ? '+' : op.op === 'del' ? '-' : ' ';
      body.push(prefix + op.text);
      if (op.op === 'del' || op.op === 'context') oldSpan++;
      if (op.op === 'add' || op.op === 'context') newSpan++;
    }
    const oldStart = oldSpan === 0 ? 0 : oldLineNo[start];
    const newStart = newSpan === 0 ? 0 : newLineNo[start];
    out.push(`@@ -${oldStart},${oldSpan} +${newStart},${newSpan} @@`);
    out.push(...body);
  }
  return out.join('\n');
}

// 从 Edit/MultiEdit/Write 的 tool_use 入参合成 unified diff。
// 返回 null 表示：非这三类工具、入参缺失、或无变化（old===new / 空 Write）。
export function synthesizeToolDiff(toolName: string, input: unknown): ToolDiffResult | null {
  if (input == null || typeof input !== 'object') return null;
  const name = toolName.trim();
  const fields = input as EditLikeInput & MultiEditInput & WriteInput;
  const filePath = asString(fields.file_path);

  if (EDIT_TOOL_NAMES.has(name)) {
    const diff = buildTwoFilePatch(filePath, asString(fields.old_string), asString(fields.new_string));
    return diff ? { kind: 'edit', filePath, diff } : null;
  }

  if (MULTIEDIT_TOOL_NAMES.has(name)) {
    // 每条 edit 各成一段 patch（无文件内偏移，无法合并成单一 hunk），
    // 拼接后 diff2html 渲染为同名文件的多张卡片，逐条展示。
    const parts: string[] = [];
    for (const edit of asEdits(fields.edits)) {
      const diff = buildTwoFilePatch(filePath, edit.old_string, edit.new_string);
      if (diff) parts.push(diff);
    }
    if (parts.length === 0) return null;
    return { kind: 'multiedit', filePath, diff: parts.join('\n') };
  }

  if (WRITE_TOOL_NAMES.has(name)) {
    // Write：没有改前快照，旧侧置空，整段按新增展示（新建/覆盖都视作全增）。
    const diff = buildTwoFilePatch(filePath, '', asString(fields.content));
    return diff ? { kind: 'write', filePath, diff } : null;
  }

  return null;
}
