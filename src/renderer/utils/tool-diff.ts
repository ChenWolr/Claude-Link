// 从 Edit / MultiEdit / Write 的 tool_use 入参合成「片段意图」unified diff，供 ToolCallBlock 触发
// ToolDiffDialog（与改动面板同款 DiffBody 渲染器）弹窗展示。
//
// 背景：Claude Code 的 Write/Edit tool_result 只是一句成功提示
// （"The file X has been updated successfully. (file state is current…)"），不含 diff；
// 但 tool_use 入参本身已携带 old_string/new_string（Edit/MultiEdit）或 content（Write），
// 足以反推一段意图 diff。
//
// 这是「片段意图 diff」：表达本次工具想改什么，不是文件相对 git 的真实净改动。
// 真实全文件 diff 由右侧「改动」面板按需 git diff 提供（不在此处抓改前快照，避免时序竞态）。

// 行级 LCS 与 buildTwoFilePatch 已原样提取到 src/shared/diff-core.ts（纯机械搬移，零行为变化），
// 此处 import 供 synthesizeToolDiff 使用并 re-export（现有导出签名不变，导入方零改动）。

import { TOOL_DIFF_TOOL_NAMES } from '../../shared/process-kind';
import { buildTwoFilePatch } from '../../shared/diff-core';

export { buildTwoFilePatch } from '../../shared/diff-core';

export type ToolDiffKind = 'edit' | 'multiedit' | 'write';

export interface ToolDiffResult {
  kind: ToolDiffKind;
  filePath: string;
  /** unified diff 文本，经 openToolDiffDialog 弹窗展示（可被 parseUnifiedDiff 解析）。恒非空串：无变化时 synthesizeToolDiff 返回 null。 */
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

// 从 Edit/MultiEdit/Write 的 tool_use 入参合成「片段意图」unified diff。
// 返回 null：非这三类工具、入参非对象、或无变化（old===new / 空 Write）。
export function synthesizeToolDiff(toolName: string, input: unknown): ToolDiffResult | null {
  if (input == null || typeof input !== 'object') return null;
  const name = toolName.trim();
  if (!(TOOL_DIFF_TOOL_NAMES as readonly string[]).includes(name)) return null;
  const fields = input as EditLikeInput & MultiEditInput & WriteInput;
  const filePath = asString(fields.file_path);

  if (EDIT_TOOL_NAMES.has(name)) {
    const patch = buildTwoFilePatch(filePath, asString(fields.old_string), asString(fields.new_string));
    return patch.diff ? { kind: 'edit', filePath, ...patch } : null;
  }

  if (MULTIEDIT_TOOL_NAMES.has(name)) {
    // 无文件内偏移，逐条 edit 各成一段 patch 拼接，由 splitUnifiedDiff 拆段后在 ToolDiffDialog 逐段切换展示。
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
