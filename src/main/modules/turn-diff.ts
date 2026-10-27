// turn-diff.ts
// 轮末文件改动聚合（计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan
// §3.4 / §4-P4）：从 turn_file_checkpoints（P1 repo）+ messages 表推导的回合区间，聚合出每轮
// 每文件的轻量摘要（± 计数、写次数、mode），patch 正文经 turnDiff:filePatch 单文件懒加载重算。
//
// 口径（编排器 plan-notes N2/N3 裁定）：
//   - N2 轮区间：主进程从 messages 表推导——主流程 user 消息按 rowid 升序分界，第 i 回合 =
//     [该 user rowid, 下一主流程 user rowid)，末回合上界 +∞，turnStartMessageId = 该 user 消息 id；
//     listSummaries 不依赖渲染层传区间（与渲染层同口径），filePatch 由渲染层显式传
//     turnStartMessageId/endMessageId（messages.id → rowid 查询转区间）。
//     主流程 user 消息识别依据：role='user' 且 parent_agent_id IS NULL——message-repo.
//     findLastTurnMainFlowAssistantId 的 walk 判据（「parentAgentId 守卫先于 user 边界」）与
//     渲染层 group-messages（主流程只取 parentAgentId 为 null 的行）+ turn-boundary.
//     computeTurnStartIndex（该过滤集内按 role==='user' 分界）同口径。
//   - N3 ± 计数：一律从截断前的完整 patch 统计（diffFull 与本模块合成器同口径），
//     patch 正文超 MAX_DIFF_LINES 截断并置 truncated。
//   - first-change（本会话首次改写：区间前无该 path 可用 disk 快照）：按区间内该 path 各行
//     input_json 顺序合成编辑意图 hunk（Write→content 整文件 vs 空串 / Edit→old_string→
//     new_string / MultiEdit→edits[] 逐条），每片段经 diff-core buildTwoFilePatch 生成 hunk
//     顺序拼接（单一文件头 + 多 hunk，parseUnifiedDiff 可解析形态）；无可用 input
//     （input_json 缺失或 input_truncated=1，全部行皆不可用）→ 该文件降级 'unavailable'。
//
// 分层纪律：aggregateFromCheckpoints / computeFileDiff 为纯函数（不触 DB，可直测）；DB 侧
// （deriveTurnRanges / listSummaries / getPatch）只读查询；异常由 ipc-handlers 的 handler
// try/catch 兜底，不向渲染层抛未捕获异常。

import { getConnection } from '../database/connection';
import * as checkpointRepo from '../database/repositories/turn-file-checkpoint-repo';
import type { TurnFileCheckpointRow } from '../database/repositories/turn-file-checkpoint-repo';
import { buildTwoFilePatch, diffFull } from '../../shared/diff-core';
import { MAX_DIFF_LINES } from '../../shared/process-kind';
import type { TurnFileDiffItem, TurnFileDiffMode, TurnFileDiffTurnSummary } from '../../shared/types/turn-file-diff';

/** 回合区间：rowid 半开区间 [startRow, endRow)；endRow=null 表示到会话末尾（+∞）。 */
export interface TurnRange {
  turnStartMessageId: string;
  startRow: number;
  endRow: number | null;
}

/** 单文件聚合结果（含 patch 正文）：摘要聚合只取前四项，懒加载通道全取。 */
export interface TurnFileDiffFileResult {
  mode: TurnFileDiffMode;
  additions: number;
  deletions: number;
  writeCount: number;
  patch: string;
  truncated: boolean;
}

/** turnDiff:filePatch 回包（'unavailable' 时 patch=''、truncated=false，不抛错）。 */
export interface TurnFilePatchResult {
  mode: TurnFileDiffMode;
  patch: string;
  truncated: boolean;
}

/** 行是否可作 after/before 来源：disk 快照、非二进制、after_content 为字符串。 */
function isUsableDiskRow(row: TurnFileCheckpointRow): boolean {
  return row.snapshot_state === 'disk' && row.binary === 0 && typeof row.after_content === 'string';
}

/** input JSON 文本 → 对象（解析失败/非对象返回 null：截断前缀等非法 JSON）。 */
function parseInputObject(jsonText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 截断前缀等非法 JSON：视为无 input
  }
  return null;
}

interface SynthResult {
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}

/**
 * first-change 合成：按行序从各行 input_json 提取编辑意图片段（input 缺失/截断的行跳过，
 * 全部行皆不可用 → null 降级 unavailable），每片段 buildTwoFilePatch 生成 hunk，顺序拼接为
 * 「单一文件头 + 多 hunk」patch；± 从截断前的全部片段累计（N3），正文按 MAX_DIFF_LINES 截断。
 * 输入可用但所有片段零变更 → 回空 patch（first-change 语义仍成立）。
 */
function synthesizeFirstChange(path: string, rows: readonly TurnFileCheckpointRow[]): SynthResult | null {
  const fragments: Array<{ old: string; new: string }> = [];
  for (const row of rows) {
    if (!row.input_json || row.input_truncated === 1) continue;
    const input = parseInputObject(row.input_json);
    if (input === null) continue;
    const tool = row.tool_name.trim().toLowerCase();
    if (tool === 'write') {
      const content = typeof input.content === 'string' ? input.content : null;
      if (content !== null) fragments.push({ old: '', new: content });
    } else if (tool === 'edit') {
      const oldString = typeof input.old_string === 'string' ? input.old_string : null;
      const newString = typeof input.new_string === 'string' ? input.new_string : null;
      if (oldString !== null && newString !== null) fragments.push({ old: oldString, new: newString });
    } else if (tool === 'multiedit' || tool === 'multi_edit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue;
        const oldString = (edit as Record<string, unknown>).old_string;
        const newString = (edit as Record<string, unknown>).new_string;
        if (typeof oldString === 'string' && typeof newString === 'string') {
          fragments.push({ old: oldString, new: newString });
        }
      }
    }
    // 其它工具名不合成（记录器只收 TOOL_DIFF_TOOL_NAMES，理论不可达，防御性忽略）。
  }
  if (fragments.length === 0) return null;

  let additions = 0;
  let deletions = 0;
  let header: string[] | null = null;
  let truncated = false;
  const hunkSections: string[][] = [];
  for (const fragment of fragments) {
    const r = buildTwoFilePatch(path, fragment.old, fragment.new);
    if (r.diff === '') continue; // 零变更片段（如 Write 空内容）不贡献
    additions += r.additions;
    deletions += r.deletions;
    // 片段自身超 MAX_DIFF_LINES 被 buildTwoFilePatch 内部截断 → 整体即截断（N3：± 仍为截断前全量）。
    if (r.truncated) truncated = true;
    const lines = r.diff.split('\n');
    if (header === null) {
      // 同一 path 各片段的 ---/+++ 头一致，取首个片段的头（buildTwoFilePatch 已做路径归一）。
      header = [lines[0] ?? '', lines[1] ?? ''];
    }
    hunkSections.push(lines.slice(2));
  }
  if (header === null || hunkSections.length === 0) {
    return { patch: '', additions: 0, deletions: 0, truncated: false };
  }

  const out: string[] = [...header];
  let emitted = 0;
  outer: for (const section of hunkSections) {
    if (emitted >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    for (const line of section) {
      if (line === '') continue;
      if (line.startsWith('@@')) {
        out.push(line);
        continue;
      }
      // 正文行（' '/'+'/'-' 前缀）：超 MAX_DIFF_LINES 截断并置 truncated（N3）。
      if (emitted >= MAX_DIFF_LINES) {
        truncated = true;
        break outer;
      }
      out.push(line);
      emitted += 1;
    }
  }
  return { patch: out.join('\n'), additions, deletions, truncated };
}

/**
 * 纯函数：单文件聚合（供 aggregateFromCheckpoints 与 getPatch 共用）。
 * rows = listBySession 全 session 行；区间 [startRow, endRow)（endRow=null 到 +∞）之外的行忽略。
 * after/before 一律按 mrow（消息序）最大者选取，与落库时序（异步读盘完成序）解耦——同轮多次写
 * 乱序落库时仍取轮末/前轮末快照。
 */
export function computeFileDiff(
  rows: readonly TurnFileCheckpointRow[],
  startRow: number,
  endRow: number | null,
  path: string,
): TurnFileDiffFileResult {
  const upper = endRow === null ? Number.POSITIVE_INFINITY : endRow;
  const inRange: TurnFileCheckpointRow[] = [];
  for (const row of rows) {
    if (row.path === path && row.mrow >= startRow && row.mrow < upper) inRange.push(row);
  }
  const writeCount = inRange.length;
  if (writeCount === 0) {
    // 区间内无行：aggregate 不会对该 path 产 item；防御性返回 unavailable。
    return { mode: 'unavailable', additions: 0, deletions: 0, writeCount: 0, patch: '', truncated: false };
  }
  // after：区间内 mrow（消息序）最大的一条可用 disk 快照的 after_content（binary/failed 行不作
  // 来源；快照异步读盘完成序可能与消息序不一致，故不按数组序覆盖、按 mrow 取轮末快照）。
  let after: string | null = null;
  let maxMrow = Number.NEGATIVE_INFINITY;
  for (const row of inRange) {
    if (row.mrow > maxMrow && isUsableDiskRow(row)) {
      after = row.after_content;
      maxMrow = row.mrow;
    }
  }
  if (after === null) {
    return { mode: 'unavailable', additions: 0, deletions: 0, writeCount, patch: '', truncated: false };
  }
  // before：startRow 之前（全 session 范围）mrow 最大的一条可用 disk 快照（同样与落库时序解耦）。
  let before: string | null = null;
  let beforeMaxMrow = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (row.path === path && row.mrow < startRow && row.mrow > beforeMaxMrow && isUsableDiskRow(row)) {
      before = row.after_content;
      beforeMaxMrow = row.mrow;
    }
  }
  if (before !== null) {
    const r = diffFull(before, after, path);
    return { mode: 'full', additions: r.additions, deletions: r.deletions, writeCount, patch: r.patch, truncated: r.truncated };
  }
  const synth = synthesizeFirstChange(path, inRange);
  if (synth === null) {
    return { mode: 'unavailable', additions: 0, deletions: 0, writeCount, patch: '', truncated: false };
  }
  return { mode: 'first-change', additions: synth.additions, deletions: synth.deletions, writeCount, patch: synth.patch, truncated: synth.truncated };
}

/**
 * 纯函数：全回合聚合。turnRanges 之外（mrow 不落任何区间）的行忽略；每区间按 path 归并
 * （items 顺序 = path 在行序中首次出现序，确定性）；空 items 的轮不出现在返回。
 */
export function aggregateFromCheckpoints(
  rows: readonly TurnFileCheckpointRow[],
  turnRanges: readonly TurnRange[],
): TurnFileDiffTurnSummary[] {
  const out: TurnFileDiffTurnSummary[] = [];
  for (const range of turnRanges) {
    const upper = range.endRow === null ? Number.POSITIVE_INFINITY : range.endRow;
    const byPath = new Map<string, TurnFileCheckpointRow[]>();
    for (const row of rows) {
      if (row.mrow >= range.startRow && row.mrow < upper) {
        const list = byPath.get(row.path);
        if (list) list.push(row);
        else byPath.set(row.path, [row]);
      }
    }
    const items: TurnFileDiffItem[] = [];
    for (const path of byPath.keys()) {
      const r = computeFileDiff(rows, range.startRow, range.endRow, path);
      items.push({ path, additions: r.additions, deletions: r.deletions, writeCount: r.writeCount, mode: r.mode });
    }
    if (items.length > 0) out.push({ turnStartMessageId: range.turnStartMessageId, items });
  }
  return out;
}

/**
 * 轮区间推导（N2，供 listSummaries 与渲染层对照）：主流程 user 消息（role='user' 且
 * parent_agent_id IS NULL，识别依据见文件头注释）按 rowid 升序，第 i 回合 startRow=该 user
 * rowid、endRow=下一主流程 user rowid、末回合 endRow=null、turnStartMessageId=该 user 消息 id。
 */
export function deriveTurnRanges(sessionId: string): TurnRange[] {
  const rows = getConnection()
    .prepare(
      `SELECT id, rowid AS r FROM messages
       WHERE session_id = ? AND role = 'user' AND parent_agent_id IS NULL
       ORDER BY rowid ASC`,
    )
    .all(sessionId) as Array<{ id: string; r: number }>;
  const out: TurnRange[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i]!;
    const next = i + 1 < rows.length ? rows[i + 1]! : null;
    out.push({
      turnStartMessageId: cur.id,
      startRow: cur.r,
      endRow: next ? next.r : null,
    });
  }
  return out;
}

/** listSummaries 组装（handler 直调）：listBySession + 主进程推导轮区间 + 纯函数聚合。 */
export function listSummaries(sessionId: string): TurnFileDiffTurnSummary[] {
  const rows = checkpointRepo.listBySession(sessionId);
  if (rows.length === 0) return [];
  return aggregateFromCheckpoints(rows, deriveTurnRanges(sessionId));
}

/**
 * 单文件懒加载重算（handler 直调）：turnStartMessageId/endMessageId 经 messages 表 rowid 查询
 * 转区间。turnStart 查不到 → {mode:'unavailable', patch:'', truncated:false}；endMessageId
 * 查不到 → 上界 +∞（N2 裁定）。'unavailable' 返回 mode 与空 patch，不抛错。
 */
export function getPatch(
  sessionId: string,
  turnStartMessageId: string,
  endMessageId: string | null,
  path: string,
): TurnFilePatchResult {
  const db = getConnection();
  const start = db
    .prepare('SELECT rowid AS r FROM messages WHERE id = ? AND session_id = ? LIMIT 1')
    .get(turnStartMessageId, sessionId) as { r: number } | undefined;
  if (!start) return { mode: 'unavailable', patch: '', truncated: false };
  let endRow: number | null = null;
  if (typeof endMessageId === 'string' && endMessageId) {
    const end = db
      .prepare('SELECT rowid AS r FROM messages WHERE id = ? AND session_id = ? LIMIT 1')
      .get(endMessageId, sessionId) as { r: number } | undefined;
    if (end) endRow = end.r; // 查不到 → 保持 +∞
  }
  const rows = checkpointRepo.listBySession(sessionId);
  const r = computeFileDiff(rows, start.r, endRow, path);
  return { mode: r.mode, patch: r.patch, truncated: r.truncated };
}
