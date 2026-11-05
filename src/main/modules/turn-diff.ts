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
//   - git-baseline（2026-11-02 首改 git 基线计划 §4-P1）：首改（区间前无 before 快照）且 git HEAD
//     基线可得时，以「首次解析时点冻结的 HEAD 内容」（V16 turn_file_git_baselines 表，repo 见
//     turn-file-git-baseline-repo；冻结 = INSERT OR IGNORE 一次性写入，此后 commit 前移/重启恒读
//     冻结值）为 before 出正式 unified diff（diffFull 同源，mode='git-baseline'）。负结果（非 git/
//     未跟踪/含 \0/超时）落 content IS NULL 行永久免重试，回退 first-change 意图合成（输出逐字节
//     与无基线时一致——回归红线）。
//   - reconstructed（2026-11-05 轮 diff 质量升级计划 §2.3）：首改（无 before 快照、无 git 基线）且
//     轮内为纯 Edit/MultiEdit 写（无 Write、input 链完整可解析）时，从轮末快照 after 反向撤销全部
//     编辑意图重建轮初内容（正向重放校验兜底错位猜测），以重建值为 before 出 diffFull 同源正式
//     unified diff——真行号、上下文真实可展开；重建不可行（删除型/校验不过/含 Write/input 断链）
//     时回落意图合成，既有各 mode 输出路径逐字节不变（回归红线）。插入位置：git 基线之后、
//     意图合成之前（真 VCS 事实优先于重建，重建优先于合成）。
//
// 分层纪律：aggregateFromCheckpoints / computeFileDiff 为纯函数（不触 DB，可直测）；DB 侧
// （deriveTurnRanges / listSummaries / getPatch）只读查询；异常由 ipc-handlers 的 handler
// try/catch 兜底，不向渲染层抛未捕获异常。

import { getConnection } from '../database/connection';
import * as checkpointRepo from '../database/repositories/turn-file-checkpoint-repo';
import type { TurnFileCheckpointRow } from '../database/repositories/turn-file-checkpoint-repo';
import { getGitBaseline, setGitBaseline } from '../database/repositories/turn-file-git-baseline-repo';
import { runGitRaw } from './changes-panel';
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

/** 聚合分组用的 path 归一比较键：win32 折叠反斜杠为正斜杠（POSIX 不折叠——反斜杠是合法文件名
 *  字符）→ cwd 存在且非绝对时解析为绝对（win32 绝对 = 盘符前缀或 `//` 开头即 UNC 折叠后形态）
 *  → NFC → win32 大小写折叠（POSIX 不折叠——大小写敏感文件系统上 A.ts/a.ts 是两个文件）。
 *  platform 参数仅供测试注入（默认 process.platform），保证双分支可直测。
 *  已知残余：含 `..` 段的相对路径不做 realpath 级消解；working_dir 为 NULL 的会话相对路径不解析。 */
export function pathKey(p: string, cwd: string | null, platform: NodeJS.Platform = process.platform): string {
  let s = p.trim();
  if (platform === 'win32') s = s.replace(/\\/g, '/');
  const isAbs = platform === 'win32' ? /^[a-zA-Z]:\//.test(s) || s.startsWith('//') : s.startsWith('/');
  if (!isAbs && cwd) {
    const c = (platform === 'win32' ? cwd.replace(/\\/g, '/') : cwd).replace(/\/+$/, '');
    s = `${c}/${s.replace(/^\.?\//, '')}`;
  }
  s = s.normalize('NFC');
  return platform === 'win32' ? s.toLowerCase() : s;
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
  replaceAll?: boolean; // Edit/MultiEdit 顶层 input.replace_all === true（write 片段恒 false；
  //   Multiedit 子项无此字段）。2026-11-05 计划 §2.3 增：仅 reconstructTurnBefore 消费，
  //   synthesizeFirstChange 不读——既有合成行为零变化。
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
      if (content !== null) fragments.push({ kind: 'write', old: '', new: content, replaceAll: false });
    } else if (tool === 'edit') {
      const oldString = typeof input.old_string === 'string' ? input.old_string : null;
      const newString = typeof input.new_string === 'string' ? input.new_string : null;
      if (oldString !== null && newString !== null) {
        fragments.push({ kind: 'edit', old: oldString, new: newString, replaceAll: input.replace_all === true });
      }
    } else if (tool === 'multiedit' || tool === 'multi_edit') {
      // replace_all 只认顶层 input（Multiedit 子项无此字段）——2026-11-05 计划 §2.3 口径。
      const rowReplaceAll = input.replace_all === true;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue;
        const oldString = (edit as Record<string, unknown>).old_string;
        const newString = (edit as Record<string, unknown>).new_string;
        if (typeof oldString === 'string' && typeof newString === 'string') {
          fragments.push({ kind: 'edit', old: oldString, new: newString, replaceAll: rowReplaceAll });
        }
      }
    }
    // notebookedit 行有意不产片段（白名单加入 NotebookEdit 后此处可达，勿「顺手补分支」）：
    // 其入参只有 new_source/cell_id，无改前内容，合成必然撒谎；无 before 快照时由
    // computeFileDiff 落 'unavailable'（诚实降级）。其它未知工具名同样不合成（防御性忽略）。
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
 * 首改轮内反向重建轮初内容（2026-11-05 轮 diff 质量升级计划 §2.3，不导出、经 computeFileDiff
 * 驱测）：对「本回合纯 Edit/MultiEdit 写、轮末快照 after 已知」的行集，从 after 反向撤销全部编辑
 * 意图得轮初内容。重建本质是**错位猜测**（同一片段在文档多处出现时，反向首替位置可能与真实
 * 编辑位置不同），由**正向重放校验兜底**：重建值经片段正序重放必须逐字节回到 after，否则视为
 * 猜错放弃（null）——宁缺毋假，放弃时回落 first-change 意图合成（输出与既有逐字节一致）。
 *
 * 前置否决（全有或全无，任一行命中即 null）：
 *   - 任一行 tool_name（trim+小写）为 'write'——Write 整文件替换后轮初内容不可知；
 *   - 任一行 input_json 缺失或 input_truncated=1——链条断一环即不可重建；
 *   - parseInputObject 返回 null 的行——非法 JSON 同样断链。
 *
 * 片段提取与 synthesizeFirstChange 完全同源（edit: old_string/new_string；multiedit/multi_edit:
 * edits[] 逐条、非法项跳过；replaceAll 取顶层 input.replace_all === true——Multiedit 子项无此字段）。
 * 无片段（行全被跳过，如全部为未知工具名）→ null。old_string === new_string（无变化 Edit）反向/
 * 正向恒等 → 重建成功（diff 为空属真实无变化，可接受）。
 */
function reconstructTurnBefore(after: string, rows: readonly TurnFileCheckpointRow[]): string | null {
  const ordered = [...rows].sort((a, b) => a.mrow - b.mrow); // 同 synthesizeFirstChange：mrow 升序稳定
  const fragments: SynthFragment[] = [];
  for (const row of ordered) {
    const tool = row.tool_name.trim().toLowerCase();
    if (tool === 'write') return null; // Write 整替换后轮初不可知
    if (!row.input_json || row.input_truncated === 1) return null; // 链条断一环即不可重建
    const input = parseInputObject(row.input_json);
    if (input === null) return null; // 非法 JSON 同样断链
    if (tool === 'edit') {
      const oldString = typeof input.old_string === 'string' ? input.old_string : null;
      const newString = typeof input.new_string === 'string' ? input.new_string : null;
      if (oldString !== null && newString !== null) {
        fragments.push({ kind: 'edit', old: oldString, new: newString, replaceAll: input.replace_all === true });
      }
    } else if (tool === 'multiedit' || tool === 'multi_edit') {
      const rowReplaceAll = input.replace_all === true;
      const edits = Array.isArray(input.edits) ? input.edits : [];
      for (const edit of edits) {
        if (edit === null || typeof edit !== 'object') continue;
        const oldString = (edit as Record<string, unknown>).old_string;
        const newString = (edit as Record<string, unknown>).new_string;
        if (typeof oldString === 'string' && typeof newString === 'string') {
          fragments.push({ kind: 'edit', old: oldString, new: newString, replaceAll: rowReplaceAll });
        }
      }
    }
    // 其它未知工具名不产片段（同 synthesizeFirstChange 白名单口径）；全部行皆无片段 → 下方 null。
  }
  if (fragments.length === 0) return null;

  // 反向：doc = after，片段逆序撤销（replaceAll 全替 / 否则仅替换首次出现）。
  let doc = after;
  for (let i = fragments.length - 1; i >= 0; i--) {
    const frag = fragments[i]!;
    if (frag.new === '') return null; // 删除型无法定位插入点
    if (frag.replaceAll === true) {
      doc = doc.split(frag.new).join(frag.old);
      continue;
    }
    const at = doc.indexOf(frag.new);
    if (at < 0) return null; // new 未命中：意图与 after 不符
    doc = doc.slice(0, at) + frag.old + doc.slice(at + frag.new.length);
  }

  // 正向校验兜底错位猜测：重建值经片段正序重放，必须逐字节回到 after。
  let doc2 = doc;
  for (const frag of fragments) {
    if (frag.replaceAll === true) {
      doc2 = doc2.split(frag.old).join(frag.new);
      continue;
    }
    const at = doc2.indexOf(frag.old);
    if (at < 0) return null; // old 未命中：重建值不可信
    doc2 = doc2.slice(0, at) + frag.new + doc2.slice(at + frag.old.length);
  }
  return doc2 === after ? doc : null;
}

/**
 * 纯函数：单文件聚合（供 aggregateFromCheckpoints 与 getPatch 共用）。
 * rows = listBySession 全 session 行；区间 [startRow, endRow)（endRow=null 到 +∞）之外的行忽略。
 * 行过滤按 pathKey 归一键比较（cwd 为会话工作目录，可能 null）——同一文件的拼写变体
 * （大小写/斜杠/相对绝对/NFC）命中同一集合；区间内外（after/before 来源）一律按此口径。
 * after/before 一律按 mrow（消息序）最大者选取，与落库时序（异步读盘完成序）解耦——同轮多次写
 * 乱序落库时仍取轮末/前轮末快照。
 * 第 7 参 gitBaseline（2026-11-02 计划 §4-P1，缺省 null）：首改（before 无会话内快照）且 after
 * 存在时，若调用方已解析到非 null 非空串的 git HEAD 基线，则以基线为 before 出正式 unified diff
 * （mode='git-baseline'，diffFull 同源）。基线解析/冻结在 resolveGitBaseline（DB+git 侧）完成，
 * 本函数保持纯函数只消费；null（缺省）时一切既有输出不变（回归红线）。
 * reconstructed（2026-11-05 计划 §2.3）：git 基线分支之后、意图合成之前插入——首改且无基线时
 * 先试 reconstructTurnBefore(after, inRange)（轮内纯 Edit/MultiEdit、无 Write、input 链完整，
 * 反向重建 + 正向重放校验通过），成功以重建值为 before 出 diffFull 正式 diff；失败落回意图合成，
 * 既有四 mode（full/first-change/intent/unavailable 及带基线时 git-baseline）输出路径逐字节不变
 *（回归红线）。
 */
export function computeFileDiff(
  rows: readonly TurnFileCheckpointRow[],
  startRow: number,
  endRow: number | null,
  path: string,
  context = 3,
  cwd: string | null = null,
  gitBaseline: string | null = null,
): TurnFileDiffFileResult {
  const upper = endRow === null ? Number.POSITIVE_INFINITY : endRow;
  const targetKey = pathKey(path, cwd); // 目标键提前归一一次，不在循环里重复归一
  const inRange: TurnFileCheckpointRow[] = [];
  for (const row of rows) {
    if (pathKey(row.path, cwd) === targetKey && row.mrow >= startRow && row.mrow < upper) inRange.push(row);
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
  // before：startRow 之前（全 session 范围）mrow 最大的一条可用 disk 快照（同样与落库时序解耦；
  // 行过滤同按 pathKey 归一键命中全组——before 行拼写与目标拼写不同也可作来源）。
  let before: string | null = null;
  let beforeMaxMrow = Number.NEGATIVE_INFINITY;
  for (const row of rows) {
    if (pathKey(row.path, cwd) === targetKey && row.mrow < startRow && row.mrow > beforeMaxMrow && isUsableDiskRow(row)) {
      before = row.after_content;
      beforeMaxMrow = row.mrow;
    }
  }
  if (before !== null) {
    const r = diffFull(before, after, path, context);
    return { mode: 'full', additions: r.additions, deletions: r.deletions, writeCount, patch: r.patch, truncated: r.truncated };
  }
  // git HEAD 基线（2026-11-02 计划 §4-P1）：首改（会话内无 before 快照）且调用方传入已冻结的
  // git 基线（非 null 非空串）时，以基线为 before 出正式 unified diff（mode='git-baseline'）。
  // null（缺省）时落到下方 first-change 意图合成，输出与既有逐字节一致（回归红线）。
  if (gitBaseline !== null && gitBaseline !== '') {
    const r = diffFull(gitBaseline, after, path, context);
    return { mode: 'git-baseline', additions: r.additions, deletions: r.deletions, writeCount, patch: r.patch, truncated: r.truncated };
  }
  // 首改轮内反向重建（2026-11-05 计划 §2.3）：插入位置在 git 基线（真 VCS 事实）之后、意图合成
  // 之前——顺序不变量：git 基线 > 重建 > 意图合成。轮内纯 Edit/MultiEdit 且可从 after 反向重建
  // 轮初内容（正向重放校验通过）时，以重建值为 before 出 diffFull 同源正式 unified diff
  //（mode='reconstructed'，真行号、上下文可展开）。重建不可行（删除型/含 Write/input 断链/校验
  // 不过）→ 落回下方意图合成，既有输出路径逐字节不变（回归红线）。
  const beforeRebuilt = reconstructTurnBefore(after, inRange);
  if (beforeRebuilt !== null) {
    const r = diffFull(beforeRebuilt, after, path, context);
    return { mode: 'reconstructed', additions: r.additions, deletions: r.deletions, writeCount, patch: r.patch, truncated: r.truncated };
  }
  const synth = synthesizeFirstChange(path, inRange, context);
  if (synth === null) {
    return { mode: 'unavailable', additions: 0, deletions: 0, writeCount, patch: '', truncated: false };
  }
  return { mode: 'first-change', additions: synth.additions, deletions: synth.deletions, writeCount, patch: synth.patch, truncated: synth.truncated };
}

/**
 * 纯函数：全回合聚合。turnRanges 之外（mrow 不落任何区间）的行忽略；每区间按 pathKey 归一键
 * 归并（同文件拼写变体合为一组；display = 该键首次入组行的 path 原文，Map 插入序即行序首次
 * 出现序，items 顺序确定性）；cwd 为会话工作目录（可能 null，透传给行过滤归一）；空 items 的
 * 轮不出现在返回。
 */
export function aggregateFromCheckpoints(
  rows: readonly TurnFileCheckpointRow[],
  turnRanges: readonly TurnRange[],
  cwd: string | null = null,
): TurnFileDiffTurnSummary[] {
  const out: TurnFileDiffTurnSummary[] = [];
  for (const range of turnRanges) {
    const upper = range.endRow === null ? Number.POSITIVE_INFINITY : range.endRow;
    const byPath = new Map<string, { display: string; rows: TurnFileCheckpointRow[] }>();
    for (const row of rows) {
      if (row.mrow >= range.startRow && row.mrow < upper) {
        const key = pathKey(row.path, cwd);
        const group = byPath.get(key);
        if (group) group.rows.push(row);
        else byPath.set(key, { display: row.path, rows: [row] });
      }
    }
    const items: TurnFileDiffItem[] = [];
    for (const group of byPath.values()) {
      // display 原文参与 diff 头路径（行为不变）；行过滤按归一键命中全组。
      const r = computeFileDiff(rows, range.startRow, range.endRow, group.display, 3, cwd);
      items.push({ path: group.display, additions: r.additions, deletions: r.deletions, writeCount: r.writeCount, mode: r.mode });
    }
    if (items.length > 0) out.push({ turnStartMessageId: range.turnStartMessageId, items });
  }
  return out;
}

// ── 首改 git HEAD 基线（2026-11-02 计划 §4-P1）─────────────────────────────

// L1 读缓存：防 listSummaries 循环内重复 SELECT/spawn。键 `${sessionId}|${targetKey}`，
// 值 string | null（null = 负结果同样命中缓存）。模块级（进程生命周期）；重启语义由 V16 落库保证。
// 进程生命周期无淘汰，单条上限受 maxBuffer=8MiB 隐式约束。
const gitBaselineL1 = new Map<string, string | null>();

/** 自测专用：清 L1 缓存（scripts/tdd-turn-file-diff-verify.ts F-base⑤ 模拟重启语义）。 */
export function clearGitBaselineL1ForTests(): void {
  gitBaselineL1.clear();
}

/**
 * 解析首改文件的 git HEAD 基线（冻结语义，计划 §4-P1.2）：
 * 1. L1 命中（含 null 负结果）→ 直接返回；
 * 2. 库行有值（string 正基线 / null 负结果）→ 写 L1 直接返回，**不碰 git**（冻结语义：首次解析
 *    时点已定格，此后 commit 前移 HEAD、重启、任何时候再看都读冻结值）；查库自身异常 → 当无行继续；
 * 3. 无行：cwd 为 null → 冻结 null；
 * 4. `git rev-parse --show-toplevel` 失败（git 缺失/spawn 失败/超时/非 0/空输出）→ 冻结 null；
 * 5. 按 pathKey 同款折叠求 root 相对正斜杠路径（targetKey 已是该折叠域的绝对归一键）；前缀不
 *    匹配（文件在仓库外/`..` 越界/大小写不同盘符等）→ 冻结 null；rel='' 表示目标是仓库根目录，
 *    交给 git show 自然失败 → 负结果；
 * 6. `git show HEAD:<rel>` 失败（reject/非 0）或 stdout 含 \0（二进制 blob）或为空串（空输出按
 *    负结果，不作为空文件基线——计划 §4-P1.1「非空非空串」口径）→ 冻结 null；
 * 7. 成功内容 ≤2MiB → 落库冻结 + L1 + 返回；>2MiB → **不落库**（防大 blob 撑库），仅写 L1 返回
 *    （本会话内有效，重启后重试解析——计划 §5 边界）。
 * 整个函数不向外抛异常（所有 git/lib 调用逐段 try/catch，异常路径一律落冻结 null）。
 */
export async function resolveGitBaseline(
  sessionId: string,
  path: string,
  cwd: string | null,
  targetKey: string,
): Promise<string | null> {
  void path; // 签名保留 path 与行过滤调用方对齐；折叠一律走 targetKey（已是绝对归一键）
  const l1Key = `${sessionId}|${targetKey}`;
  const cached = gitBaselineL1.get(l1Key);
  if (cached !== undefined) return cached;
  /** 冻结：落库（best-effort，落库异常不阻断——L1 仍保本进程语义）+ 写 L1 + 返回。 */
  const freeze = (content: string | null): string | null => {
    try {
      setGitBaseline(sessionId, targetKey, content);
    } catch {
      // 落库失败不向外抛：L1 兜底本进程，进程重启后重试解析
    }
    gitBaselineL1.set(l1Key, content);
    return content;
  };
  // 2. 库行优先（冻结语义）：有行（string 或 null）直接采信，不碰 git。
  try {
    const frozenRow = getGitBaseline(sessionId, targetKey);
    if (frozenRow !== undefined) {
      gitBaselineL1.set(l1Key, frozenRow);
      return frozenRow;
    }
  } catch {
    // 查库异常：当无行继续（走下方 git 解析 + 负结果路径冻结）
  }
  // 3. 无 cwd 可解析：冻结 null。
  if (cwd === null) return freeze(null);
  // 4. 仓库根探测：reject（git 缺失/spawn 失败/超时）/ code!==0 / stdout trim 为空 → 冻结 null。
  let root = '';
  try {
    const r = await runGitRaw(cwd, ['rev-parse', '--show-toplevel']);
    if (r.code !== 0) return freeze(null);
    root = r.stdout.trim();
    if (root === '') return freeze(null);
  } catch {
    return freeze(null);
  }
  // 5. pathKey 同款折叠（win32：反斜杠→正斜杠 + lowercase；NFC）求 root 相对正斜杠路径。
  //    注意折叠域 = pathKey 的折叠域：targetKey 已是该域的绝对归一键，无需再解析相对段。
  const fold = (p: string): string => {
    let s = p.trim();
    if (process.platform === 'win32') s = s.replace(/\\/g, '/').toLowerCase();
    return s.normalize('NFC');
  };
  const rootF = fold(root);
  const prefix = rootF.endsWith('/') ? rootF : `${rootF}/`;
  const absF = fold(targetKey);
  // 前缀不匹配（文件在仓库外/`..` 越界/大小写不同盘符等）→ 冻结 null。
  if (absF !== rootF && !absF.startsWith(prefix)) return freeze(null);
  const rel = absF === rootF ? '' : absF.slice(prefix.length);
  // 6/7. 取 HEAD blob：失败/含 \0/空串 → 冻结 null；成功 ≤2MiB 落库冻结，>2MiB 仅写 L1
  //（2MiB 按 UTF-8 字节数计，2026-11-03 review P3-1——content.length 是 UTF-16 code units，
  // CJK 内容字节预算被稀释约 2 倍）。
  try {
    const r = await runGitRaw(root, ['show', `HEAD:${rel}`]);
    if (r.code !== 0) return freeze(null);
    const content = r.stdout;
    if (content.includes('\0') || content === '') return freeze(null);
    if (Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024) {
      // >2MiB 不落库（防大 blob 撑库）：仅 L1（本会话内有效），重启后重试解析（计划 §5 边界）。
      // >8MiB（runGitRaw maxBuffer 上限）文本 blob 会 reject 走负结果永久冻结，仅 2–8MiB 带「仅 L1、重启后重试」。
      gitBaselineL1.set(l1Key, content);
      return content;
    }
    return freeze(content);
  } catch {
    return freeze(null);
  }
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

/** listSummaries 组装（handler 直调，p1 起 async——git 基线解析含 git 子进程调用）：
 *  listBySession + 主进程推导轮区间 + 纯函数聚合（aggregateFromCheckpoints 签名与行为零改动），
 *  随后仅对 mode='first-change' 的 item 并发解析 git HEAD 基线（单条 2s 超时封顶：超时保持原
 *  first-change 值，后台解析继续落库不影响）；命中非空者以同源 computeFileDiff 重算并原地替换
 *  item 的 mode/additions/deletions/writeCount，未命中保持原值，items 顺序不变。
 *  cwd 取 sessions.working_dir（查无行/NULL → null，退化为纯词法归一），供相对路径变体合并。 */
export async function listSummaries(sessionId: string): Promise<TurnFileDiffTurnSummary[]> {
  const rows = checkpointRepo.listBySession(sessionId);
  if (rows.length === 0) return [];
  const cwdRow = getConnection()
    .prepare('SELECT working_dir FROM sessions WHERE id = ?')
    .get(sessionId) as { working_dir: string | null } | undefined;
  const cwd = cwdRow?.working_dir ?? null;
  const ranges = deriveTurnRanges(sessionId);
  const summaries = aggregateFromCheckpoints(rows, ranges, cwd);
  const rangeByTurn = new Map<string, TurnRange>();
  for (const range of ranges) rangeByTurn.set(range.turnStartMessageId, range);
  await Promise.all(
    summaries.flatMap((summary) =>
      summary.items.map(async (item) => {
        if (item.mode !== 'first-change') return;
        const range = rangeByTurn.get(summary.turnStartMessageId);
        if (!range) return; // 防御：summaries 的轮必来自 ranges，不应发生
        // 单条 2s 超时封顶：超时按 null（保持原 first-change 值）；resolveGitBaseline 不被取消，
        // 后台继续完成解析与落库（下次调用即命中冻结行）。timer unref：不阻延进程退出。
        const baseline = await Promise.race([
          resolveGitBaseline(sessionId, item.path, cwd, pathKey(item.path, cwd)),
          new Promise<null>((resolveNull) => {
            const timer = setTimeout(() => resolveNull(null), 2000);
            timer.unref();
          }),
        ]);
        if (baseline === null || baseline === '') return;
        const r = computeFileDiff(rows, range.startRow, range.endRow, item.path, 3, cwd, baseline);
        item.mode = r.mode;
        item.additions = r.additions;
        item.deletions = r.deletions;
        item.writeCount = r.writeCount;
      }),
    ),
  );
  return summaries;
}

/**
 * 单文件懒加载重算（handler 直调，p1 起 async——首改可能触发 git 基线解析）：
 * turnStartMessageId/endMessageId 经 messages 表 rowid 查询转区间。turnStart 查不到 →
 * {mode:'unavailable', patch:'', truncated:false}；endMessageId 查不到 → 上界 +∞（N2 裁定）。
 * context 为 hunk 上下文行数（默认 3，弹窗「全文」档传大值）。
 * 首改增强（2026-11-02 计划 §4-P1）：首次计算 mode='first-change' 时解析 git HEAD 基线
 * （targetKey 与行过滤同口径 = pathKey(path, cwd)），baseline 非空非空串 → 带基线重算一次返回
 * （mode='git-baseline'）；否则（null/''——负结果冻结或超时）原样返回 first-change。
 * 'unavailable' 返回 mode 与空 patch，不抛错。
 */
export async function getPatch(
  sessionId: string,
  turnStartMessageId: string,
  endMessageId: string | null,
  path: string,
  context = 3,
): Promise<TurnFilePatchResult> {
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
  // cwd 同 listSummaries 口径：sessions.working_dir（查无行/NULL → null）。渲染层传回的 item.path
  // 是组内某行原文，pathKey 归一后必命中同组（拼写变体亦可查中）。
  const cwdRow = db
    .prepare('SELECT working_dir FROM sessions WHERE id = ?')
    .get(sessionId) as { working_dir: string | null } | undefined;
  const cwd = cwdRow?.working_dir ?? null;
  const rows = checkpointRepo.listBySession(sessionId);
  const r = computeFileDiff(rows, start.r, endRow, path, context, cwd, null);
  if (r.mode === 'first-change') {
    const baseline = await resolveGitBaseline(sessionId, path, cwd, pathKey(path, cwd));
    if (baseline !== null && baseline !== '') {
      const rb = computeFileDiff(rows, start.r, endRow, path, context, cwd, baseline);
      return { mode: rb.mode, patch: rb.patch, truncated: rb.truncated };
    }
  }
  return { mode: r.mode, patch: r.patch, truncated: r.truncated };
}
