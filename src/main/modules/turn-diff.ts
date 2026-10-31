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
//     拼接为单一文件头 + 多 hunk（parseUnifiedDiff 可解析形态）；片段先按 mrow 升序稳定排序
//     （治多工具并发落库时 t.id 序 ≠ 消息序的乱序）→ 虚拟文档链锚定（Write 建链/Edit 命中
//     定位、未命中追加尾部）→ hunk 头按锚定行号整体平移（治局部行号每块从 1 重复）→ 按
//     锚定行号升序输出（文件位置序）；context 参数可透传（hunk 上下文行数，默认 3）；
//     after 为 null 且入参可用时按意图合成（mode 'intent'，± 与 patch 皆来自合成结果）；
//     无可用 input（input_json 缺失或 input_truncated=1，全部行皆不可用）→ 该文件降级
//     'unavailable'。
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

interface SynthFragment {
  kind: 'write' | 'edit';
  old: string; // write 片段恒为 ''
  new: string; // write 片段 = content
}

/** 字符串内换行符个数（虚拟文档行数推导用）。 */
function countLF(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
  return n;
}

const HUNK_HEADER_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/;

/** 片段局部 hunk 头（行号恒从 1 起）平移到文件锚定位置：@@ -a,b +c,d @@ → @@ -(a+anchor-1),b +(c+anchor-1),d @@。 */
function offsetHunkHeaders(lines: readonly string[], anchor: number): string[] {
  const shift = anchor - 1;
  return lines.map((line) => {
    const m = HUNK_HEADER_RE.exec(line);
    if (!m) return line;
    return `@@ -${Number(m[1]) + shift},${Number(m[2])} +${Number(m[3]) + shift},${Number(m[4])} @@`;
  });
}

/** 首个 hunk 头的 newStart（整文档 diff 分支的排序锚）。 */
function firstNewStart(lines: readonly string[]): number {
  for (const line of lines) {
    const m = HUNK_HEADER_RE.exec(line);
    if (m) return Number(m[3]);
  }
  return 0;
}

/**
 * first-change 合成（虚拟文档链，2026-10-30 意图合成器重写 §2.2）：行先按 mrow 升序稳定排序
 * （ES2019+ sort 稳定：mrow 相同保持 t.id 序，治多工具并发落库乱序），再按行序从 input_json
 * 提取编辑意图片段（input 缺失/截断的行跳过，全部行皆不可用 → null 降级 unavailable）。
 * 片段逐条推进一份内存虚拟文档（doc，null=前置内容未知）：Write 建链/整替换，Edit 命中 doc
 * 则按首现位置锚定替换、未命中（或 doc 未知）追加到尾部下一行（确定性兜底）——由此拿到每片段
 * 的文件内真实锚定行号；片段局部 hunk 头（行号恒从 1 起）按锚点整体平移，最后按锚定行号升序
 * **稳定**输出（同 anchor 保持片段时序，MultiEdit 天然保序）——治乱序与「每块行号从 1 重复」。
 * ± 从截断前的全部片段累计（N3；回合内多次 Write 时第二片起对虚拟文档 diff 计净变更，H3 有意修正），
 * 正文按 MAX_DIFF_LINES 截断。输入可用但所有片段零变更 → 回空 patch（first-change 语义仍成立）。
 */
function synthesizeFirstChange(
  path: string,
  rows: readonly TurnFileCheckpointRow[],
  context = 3,
): SynthResult | null {
  const ordered = [...rows].sort((a, b) => a.mrow - b.mrow); // ES2019+ sort 稳定：mrow 相同保持 t.id 序
  const fragments: SynthFragment[] = [];
  for (const row of ordered) {
    if (!row.input_json || row.input_truncated === 1) continue;
    const input = parseInputObject(row.input_json);
    if (input === null) continue;
    const tool = row.tool_name.trim().toLowerCase();
    if (tool === 'write') {
      const content = typeof input.content === 'string' ? input.content : null;
      if (content !== null) fragments.push({ kind: 'write', old: '', new: content });
    } else if (tool === 'edit') {
      const oldString = typeof input.old_string === 'string' ? input.old_string : null;
      const newString = typeof input.new_string === 'string' ? input.new_string : null;
      if (oldString !== null && newString !== null) fragments.push({ kind: 'edit', old: oldString, new: newString });
    } else if (tool === 'multiedit' || tool === 'multi_edit') {
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue;
        const oldString = (edit as Record<string, unknown>).old_string;
        const newString = (edit as Record<string, unknown>).new_string;
        if (typeof oldString === 'string' && typeof newString === 'string') {
          fragments.push({ kind: 'edit', old: oldString, new: newString });
        }
      }
    }
    // 其它工具名不合成（记录器只收 TOOL_DIFF_TOOL_NAMES，理论不可达，防御性忽略）。
  }
  if (fragments.length === 0) return null;

  let doc: string | null = null; // null = 前置内容未知
  let additions = 0;
  let deletions = 0;
  let truncated = false;
  let header: string[] | null = null;
  const placed: Array<{ anchor: number; hunkLines: string[] }> = [];
  for (const frag of fragments) {
    let r: ReturnType<typeof buildTwoFilePatch>;
    let anchor: number | null;
    if (frag.kind === 'write') {
      if (doc === null) {
        r = buildTwoFilePatch(path, '', frag.new, context); // 回合首个写：old 侧未知按空
        anchor = 1;
      } else {
        r = buildTwoFilePatch(path, doc, frag.new, context); // 回合内再次 Write = 整文件替换
        anchor = null; // 整文档 diff，行号天然真实，无需偏移
      }
      doc = frag.new;
    } else {
      if (doc !== null && doc.includes(frag.old)) {
        const charIdx = doc.indexOf(frag.old);           // 首次出现替换（对齐 CLI Edit 语义）
        anchor = 1 + countLF(doc.slice(0, charIdx));     // 1-based 文件行号
        doc = doc.slice(0, charIdx) + frag.new + doc.slice(charIdx + frag.old.length);
      } else {
        anchor = doc === null || doc === '' ? 1 : countLF(doc) + 2; // 追加到尾部下一行
        doc = doc === null || doc === '' ? frag.new : doc + '\n' + frag.new;
      }
      r = buildTwoFilePatch(path, frag.old, frag.new, context);
    }
    if (r.diff === '') continue; // 零变更片段不贡献（现有语义保留）
    additions += r.additions;    // N3：± 恒为截断前全量累计
    deletions += r.deletions;
    // 片段自身超 MAX_DIFF_LINES 被 buildTwoFilePatch 内部截断 → 整体即截断（N3：± 仍为截断前全量）。
    if (r.truncated) truncated = true;
    const lines = r.diff.split('\n');
    if (header === null) {
      // 同一 path 各片段的 ---/+++ 头一致，取首个片段的头（buildTwoFilePatch 已做路径归一）。
      header = [lines[0] ?? '', lines[1] ?? ''];
    }
    let hunkLines = lines.slice(2);
    if (anchor !== null) hunkLines = offsetHunkHeaders(hunkLines, anchor);
    placed.push({ anchor: anchor ?? firstNewStart(hunkLines), hunkLines });
  }
  if (header === null || placed.length === 0) {
    return { patch: '', additions: 0, deletions: 0, truncated: false }; // 全部零变更（现有语义保留）
  }
  placed.sort((a, b) => a.anchor - b.anchor); // 稳定排序：同 anchor 保持片段时序（MultiEdit 保序）

  const out: string[] = [...header];
  let emitted = 0;
  outer: for (const section of placed) {
    if (emitted >= MAX_DIFF_LINES) {
      truncated = true;
      break;
    }
    for (const line of section.hunkLines) {
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
  context = 3,
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
    // p5（2026-10-27）：快照全缺（二进制/加密含 \0 或读盘 failed）不再早退——按编辑意图合成兜底
    //（与工具行「查看改动对比」同源 input_json + 同一 buildTwoFilePatch；± 为截断前累计，N3）。
    // 入参也缺失/截断（synth null）才维持 unavailable。
    const synth = synthesizeFirstChange(path, inRange, context);
    if (synth === null) {
      return { mode: 'unavailable', additions: 0, deletions: 0, writeCount, patch: '', truncated: false };
    }
    return { mode: 'intent', additions: synth.additions, deletions: synth.deletions, writeCount, patch: synth.patch, truncated: synth.truncated };
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
    const r = diffFull(before, after, path, context);
    return { mode: 'full', additions: r.additions, deletions: r.deletions, writeCount, patch: r.patch, truncated: r.truncated };
  }
  const synth = synthesizeFirstChange(path, inRange, context);
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
 * 查不到 → 上界 +∞（N2 裁定）。context 为 hunk 上下文行数（默认 3，弹窗「全文」档传大值）。
 * 'unavailable' 返回 mode 与空 patch，不抛错。
 */
export function getPatch(
  sessionId: string,
  turnStartMessageId: string,
  endMessageId: string | null,
  path: string,
  context = 3,
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
  const r = computeFileDiff(rows, start.r, endRow, path, context);
  return { mode: r.mode, patch: r.patch, truncated: r.truncated };
}
