// 会话导出 JPEG 长图：纯逻辑（文件名、turn 分组、可见权重、分页拆分、像素预算、尾段裁剪、进度）。
// 无 Vue / Electron / DOM 副作用，Node selftest 可直接导入。
// 依据：docs/glittery-hatching-neumann-v3.md 第 4 / 8 / 9 / 10 / 11 / 12 / 13 节。

import type { RenderableMessage } from './types/export-image';
import type {
  ExportImagePhase,
  ExportImageProgressPayload,
  ExportImageResult,
  PageRange,
  PaginateResult,
  PaginationBudget,
  PixelBudgetInput,
  PixelBudgetResult,
  SegmentHeightInput,
  SegmentHeightResult,
  SegmentPlacementInput,
  SegmentPlacementResult,
  SnapshotBudgetInput,
  SnapshotBudgetResult,
  StableUnit,
  StableUnitInput,
} from './types/export-image';

// —— 冻结预算（阶段零 Spike 验证，保守值不推翻）——
export const DEFAULT_EXPORT_BUDGET: PaginationBudget = {
  targetWeight: 10000,
  imageWeight: 6000,
  maxPageCount: 100,
  maxPageHeightCss: 16000, // 由像素预算反推的单页 CSS 高度上限（见 checkPixelBudget）
};

// 单页像素预算阈值（v3 第 8.4 节）。检查原始值，不先 clamp。
export const PIXEL_DIMENSION_MAX = 30000;
export const PIXEL_COUNT_MAX = 24_000_000;
export const WORKING_SET_MAX_BYTES = 256 * 1024 * 1024; // 256 MiB
export const SEGMENT_COUNT_MAX = 120;

// 快照预算阈值（v3 第 11.3 节）。
export const SNAPSHOT_MESSAGE_MAX = 50_000;
export const SNAPSHOT_MESSAGE_BYTES_MAX = 16 * 1024 * 1024; // 单条 UTF-8 文本 16 MiB
export const SNAPSHOT_TOTAL_BYTES_MAX = 64 * 1024 * 1024; // 总可见文本 + data URL 64 MiB
export const SNAPSHOT_IMAGE_MAX = 2000;

// JPEG / 分块常量。
export const JPEG_QUALITY = 0.92;
export const JPEG_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB
export const JPEG_PAGE_MAX_BYTES = 64 * 1024 * 1024; // 单页 JPEG 64 MiB

// =====================================================================
// 1. RenderableMessage 投影
// =====================================================================

/** 把完整 Message（或同形对象）投影为最小 RenderableMessage，剥离 rawEvent / parentTaskId。 */
export function toRenderable<T extends RenderableMessage>(msg: T): RenderableMessage {
  return {
    id: msg.id,
    sessionId: msg.sessionId,
    role: msg.role,
    content: msg.content,
    eventType: msg.eventType,
    costUsd: msg.costUsd,
    durationMs: msg.durationMs,
    processKind: msg.processKind,
    parentAgentId: msg.parentAgentId,
    toolUseId: msg.toolUseId,
    title: msg.title,
    isError: msg.isError,
    createdAt: msg.createdAt,
  };
}

// =====================================================================
// 2. 文件名净化（v3 第 4.4 节 + 第 15.1 节契约）
// =====================================================================

// Windows 非法字符（< > : " / \ | ? *）。不含空格、连字符、控制字符——空格收拢、控制字符单独删。
const WIN_ILLEGAL = /[<>:"/\\|?*]/g;
// Windows 保留名（不分大小写），命名时需规避。
const WIN_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const NAME_MAX_CODEPOINTS = 80;

/** 净化会话名为合法 Windows 文件名片段。空名称回退 'session'。 */
export function sanitizeSessionName(rawName: string): string {
  // 1) 去掉 Windows 非法字符（空格不在内）。
  let name = (rawName ?? '').replace(WIN_ILLEGAL, '');
  // 2) 收拢所有空白（含 \t \n \r 等）为单空格。
  name = name.replace(/\s+/g, ' ');
  // 3) 去掉剩余控制字符（0x00-0x1F、0x7F）。
  name = name.replace(/[\x00-\x1f\x7f]/g, '');
  // 4) 删除首尾点号和空格（Windows 不允许尾部点/空格）。
  name = name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (WIN_RESERVED.test(name)) name = name + '_';
  // 5) 限制为 80 个 Unicode code point（按码点，不按 UTF-16 单元）。
  const codepoints = Array.from(name);
  if (codepoints.length > NAME_MAX_CODEPOINTS) name = codepoints.slice(0, NAME_MAX_CODEPOINTS).join('');
  if (name.length === 0) name = 'session';
  return name;
}

const FILENAME_TS = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/;

/** 生成导出文件名。单张：会话名-YYYYMMDD-HHmmss.jpg；多张：-01-of-N.jpg（至少两位）。 */
export function buildExportFilename(
  sessionName: string,
  timestamp: string,
  page?: number,
  totalPages?: number,
): string {
  const base = sanitizeSessionName(sessionName);
  if (!FILENAME_TS.test(timestamp)) {
    throw new Error(`buildExportFilename: 非法时间戳 ${timestamp}（期望 YYYYMMDD-HHmmss）`);
  }
  if (page !== undefined && totalPages !== undefined && totalPages > 1) {
    // 至少两位（与 v3 示例 01-of-03 一致），超过 99 页自动扩宽。
    const width = Math.max(2, String(totalPages).length);
    const pageStr = String(page).padStart(width, '0');
    const totalStr = String(totalPages).padStart(width, '0');
    return `${base}-${timestamp}-${pageStr}-of-${totalStr}.jpg`;
  }
  return `${base}-${timestamp}.jpg`;
}

// =====================================================================
// 3. 可见权重 + turn 划分（v3 第 4.3 / 9 节 + 第 15.2 节契约）
// =====================================================================

const IMG_TAG_RE = /!\[[^\]]*\]\([^)]+\)/g;

/** 估算单条消息的可见权重：可见字符数 + 图片数 × imageWeight。 */
export function estimateMessageWeight(msg: RenderableMessage, imageWeight: number): number {
  const text = msg.content ?? '';
  const imgCount = (text.match(IMG_TAG_RE) || []).length;
  // 去掉 markdown 图片语法本身的字符噪声，按可见正文长度计。
  const stripped = text.replace(IMG_TAG_RE, '');
  return stripped.length + imgCount * imageWeight;
}

/** 主流程（parentAgentId===null）按 user 消息边界划分对话轮。
 *  首条非 user 的前置消息与首条 user 消息同处 turn 0（prelude/首轮）。
 *  返回每条消息的 turnIndex；后续每个 user 边界 +1。 */
export function splitTurnIndices(messages: RenderableMessage[]): number[] {
  const out = new Array<number>(messages.length).fill(0);
  let turn = 0;
  for (let i = 0; i < messages.length; i++) {
    if (i > 0 && messages[i].role === 'user' && messages[i].parentAgentId === null) {
      turn += 1;
    }
    out[i] = turn;
  }
  return out;
}

// =====================================================================
// 4. 稳定单元（v3 第 7.2 / 9 节）
// =====================================================================

const MSG_PREFIX = 'msg:';
const FOLD_PREFIX = 'fold:';

/** 把分组后的渲染项转成带类型前缀稳定 ID 的原子单元，并校验全局唯一。 */
export function buildStableUnits(
  items: StableUnitInput[],
  budget: PaginationBudget,
): { units: StableUnit[]; duplicateIds: string[] } {
  // 先按所有消息拉平算 turnIndex（主流程视角），再回填到每个单元。
  const flat: RenderableMessage[] = [];
  for (const it of items) flat.push(...it.messages);
  const turnOf = splitTurnIndices(flat);

  const units: StableUnit[] = [];
  const seen = new Set<string>();
  const duplicateIds: string[] = [];
  let flatIdx = 0;
  for (const it of items) {
    const stableId = (it.kind === 'message' ? MSG_PREFIX : FOLD_PREFIX) + it.firstMessageId;
    if (seen.has(stableId)) duplicateIds.push(stableId);
    else seen.add(stableId);
    const weight = it.messages.reduce((s, m) => s + estimateMessageWeight(m, budget.imageWeight), 0);
    const turnIndex = flatIdx < turnOf.length ? turnOf[flatIdx] : 0;
    const unit: StableUnit = { kind: it.kind, stableId, turnIndex, weight };
    if (it.kind === 'message') unit.message = it.messages[0];
    else unit.messages = it.messages;
    units.push(unit);
    flatIdx += it.messages.length;
  }
  return { units, duplicateIds };
}

/** 校验稳定单元 ID 全局唯一。 */
export function verifyStableUnitIds(units: StableUnit[]): { ok: boolean; duplicate: string | null } {
  const seen = new Set<string>();
  for (const u of units) {
    if (seen.has(u.stableId)) return { ok: false, duplicate: u.stableId };
    seen.add(u.stableId);
  }
  return { ok: true, duplicate: null };
}

// =====================================================================
// 5. 分页（v3 第 4.3 / 9 节 + 第 15.2 节契约）
// =====================================================================

/** 初始贪心分页（按完整 turn 对齐，目标权重 targetWeight）。仅用权重，不调用 measure。 */
export function planInitialPages(units: StableUnit[], budget: PaginationBudget): PageRange[] {
  if (units.length === 0) return [];
  const pages: PageRange[] = [];
  let start = 0;
  let accWeight = 0;
  let accTurn = units[0].turnIndex;
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    const startsNewTurn = u.turnIndex !== accTurn;
    // 当前页已非空，且下一单元开启新轮，且累计已超目标 → 在轮边界收尾。
    if (startsNewTurn && i > start && accWeight >= budget.targetWeight) {
      pages.push({ startUnitIndex: start, endUnitIndex: i });
      start = i;
      accWeight = 0;
    }
    accWeight += u.weight;
    accTurn = u.turnIndex;
  }
  pages.push({ startUnitIndex: start, endUnitIndex: units.length });
  return pages;
}

/** 测量回调签名：给定单元半开区间，返回 CSS 高度。 */
export type MeasureHeight = (range: PageRange) => number;

/** 二分查找最大的 k ∈ candidates（> start），使 measure([start,k)) ≤ maxHeight。
 *  假设 height 关于 k 非递减（单元内容为正高度）。找不到（即使最小 k 也超）返回 -1。 */
function bisectLargestFitting(
  start: number,
  candidates: number[],
  measure: MeasureHeight,
  maxHeight: number,
): number {
  if (candidates.length === 0) return -1;
  let lo = 0;
  let hi = candidates.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = candidates[mid];
    const h = measure({ startUnitIndex: start, endUnitIndex: k });
    if (h <= maxHeight) {
      best = k;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
}

/** 两遍分页：初始轮对齐贪心 + 实测高度超预算时二分（先轮边界、再原子单元边界）。
 *  measure 由调用方注入（renderer 用真实 DOM 高度；selftest 用确定性伪测量）。
 *  - 单个原子单元仍超预算 → atomic-unit-over-budget；
 *  - 自然页数超过 maxPageCount → too-many-pages（带 expectedPages）。 */
export function paginate(
  units: StableUnit[],
  measure: MeasureHeight,
  budget: PaginationBudget,
): PaginateResult {
  if (units.length === 0) return { ok: true, pages: [] };

  const maxHeight = budget.maxPageHeightCss;
  const worklist: PageRange[] = planInitialPages(units, budget);
  const result: PageRange[] = [];

  while (worklist.length > 0) {
    const range = worklist.shift()!;
    const h = measure(range);
    if (h <= maxHeight) {
      result.push(range);
      continue;
    }
    // 超预算。
    const unitCount = range.endUnitIndex - range.startUnitIndex;
    if (unitCount <= 1) {
      return {
        ok: false,
        code: 'atomic-unit-over-budget',
        message: '单条消息或过程组过长，无法安全生成图片',
        unitStableId: units[range.startUnitIndex].stableId,
      };
    }
    // 收集区间内的轮边界单元索引（turnIndex 相对前一单元变化处）。
    const turnBoundaries: number[] = [];
    for (let i = range.startUnitIndex + 1; i < range.endUnitIndex; i++) {
      if (units[i].turnIndex !== units[i - 1].turnIndex) turnBoundaries.push(i);
    }
    // 先尝试轮边界。
    let splitIdx = bisectLargestFitting(range.startUnitIndex, turnBoundaries, measure, maxHeight);
    if (splitIdx <= range.startUnitIndex) {
      // 轮边界没有合适前缀 → 退到原子单元边界。
      const unitBoundaries: number[] = [];
      for (let i = range.startUnitIndex + 1; i < range.endUnitIndex; i++) unitBoundaries.push(i);
      splitIdx = bisectLargestFitting(range.startUnitIndex, unitBoundaries, measure, maxHeight);
    }
    if (splitIdx <= range.startUnitIndex) {
      // 连首个单元单独都超预算 → 原子单元超限。
      return {
        ok: false,
        code: 'atomic-unit-over-budget',
        message: '单条消息或过程组过长，无法安全生成图片',
        unitStableId: units[range.startUnitIndex].stableId,
      };
    }
    // 严格缩小：两半都小于原区间（splitIdx 严格在区间内部）。
    worklist.push({ startUnitIndex: range.startUnitIndex, endUnitIndex: splitIdx });
    worklist.push({ startUnitIndex: splitIdx, endUnitIndex: range.endUnitIndex });
  }

  if (result.length > budget.maxPageCount) {
    return {
      ok: false,
      code: 'too-many-pages',
      message: `预计需要 ${result.length} 张图片，超过上限 ${budget.maxPageCount} 张`,
      expectedPages: result.length,
    };
  }

  return { ok: true, pages: result };
}

/** 校验分页计划不变量：首页从 0、相邻首尾相接、无空页、末页覆盖末尾。 */
export function verifyPagePlan(pages: PageRange[], totalUnits: number): { ok: boolean; reason?: string } {
  if (pages.length === 0) return totalUnits === 0 ? { ok: true } : { ok: false, reason: '空计划但存在单元' };
  if (pages[0].startUnitIndex !== 0) return { ok: false, reason: '首页未从 0 开始' };
  for (let i = 0; i < pages.length; i++) {
    const p = pages[i];
    if (p.endUnitIndex <= p.startUnitIndex) return { ok: false, reason: `第 ${i + 1} 页为空` };
    if (i > 0 && pages[i].startUnitIndex !== pages[i - 1].endUnitIndex) {
      return { ok: false, reason: `第 ${i} 页与第 ${i + 1} 页未首尾相接` };
    }
  }
  if (pages[pages.length - 1].endUnitIndex !== totalUnits) {
    return { ok: false, reason: '末页未覆盖到单元总数' };
  }
  return { ok: true };
}

/** 把各页单元 ID 扁平化，用于与原始可见单元 ID 序列比对（必须完全相等）。 */
export function flattenPageUnitIds(pages: PageRange[], units: StableUnit[]): string[] {
  const out: string[] = [];
  for (const p of pages) {
    for (let i = p.startUnitIndex; i < p.endUnitIndex; i++) out.push(units[i].stableId);
  }
  return out;
}

// =====================================================================
// 6. 像素预算（v3 第 8.4 节 + 第 15.3 节契约）
// =====================================================================

/** 检查原始值（不 clamp）：物理宽高、总像素、工作集、分段数。任一超限即不通过。 */
export function checkPixelBudget(input: PixelBudgetInput): PixelBudgetResult {
  if (input.physicalWidth <= 0 || input.physicalHeight <= 0) {
    return { ok: false, reason: '物理宽高非正' };
  }
  if (input.physicalWidth > PIXEL_DIMENSION_MAX || input.physicalHeight > PIXEL_DIMENSION_MAX) {
    return { ok: false, reason: `物理宽或高超过 ${PIXEL_DIMENSION_MAX}px` };
  }
  const pixels = input.physicalWidth * input.physicalHeight;
  if (pixels > PIXEL_COUNT_MAX) {
    return { ok: false, reason: `总像素 ${pixels} 超过 ${PIXEL_COUNT_MAX}` };
  }
  const workingSet = pixels * 10 + input.maxSegmentRgbaBytes;
  if (workingSet > WORKING_SET_MAX_BYTES) {
    return { ok: false, reason: `估算工作集 ${workingSet} 超过 ${WORKING_SET_MAX_BYTES}` };
  }
  if (input.segmentCount > SEGMENT_COUNT_MAX) {
    return { ok: false, reason: `分段数 ${input.segmentCount} 超过 ${SEGMENT_COUNT_MAX}` };
  }
  return { ok: true };
}

/** 根据实测像素比例 + 版心宽度，反推单页 CSS 高度上限。 */
export function deriveMaxPageHeightCss(scaleY: number, contentWidthCss: number): number {
  if (!(scaleY > 0) || !(contentWidthCss > 0)) return DEFAULT_EXPORT_BUDGET.maxPageHeightCss;
  const physicalWidth = Math.round(contentWidthCss * scaleY);
  const heightByPixels = Math.floor(PIXEL_COUNT_MAX / Math.max(1, physicalWidth));
  const heightByDim = PIXEL_DIMENSION_MAX;
  return Math.max(480, Math.min(heightByPixels, heightByDim));
}

// =====================================================================
// 7. 快照预算（v3 第 11.3 节）
// =====================================================================

export function checkSnapshotBudget(input: SnapshotBudgetInput): SnapshotBudgetResult {
  if (input.messageCount > SNAPSHOT_MESSAGE_MAX) {
    return { ok: false, reason: `消息数 ${input.messageCount} 超过 ${SNAPSHOT_MESSAGE_MAX}` };
  }
  if (input.messageUtf8Bytes.length !== input.messageCount) {
    return { ok: false, reason: 'messageUtf8Bytes 长度与 messageCount 不一致' };
  }
  let total = 0;
  for (const b of input.messageUtf8Bytes) {
    if (b > SNAPSHOT_MESSAGE_BYTES_MAX) {
      return { ok: false, reason: `单条消息 ${b} 字节超过 ${SNAPSHOT_MESSAGE_BYTES_MAX}` };
    }
    total += b;
  }
  if (total > SNAPSHOT_TOTAL_BYTES_MAX) {
    return { ok: false, reason: `总文本字节 ${total} 超过 ${SNAPSHOT_TOTAL_BYTES_MAX}` };
  }
  if (input.imageCount > SNAPSHOT_IMAGE_MAX) {
    return { ok: false, reason: `图片数 ${input.imageCount} 超过 ${SNAPSHOT_IMAGE_MAX}` };
  }
  return { ok: true };
}

// =====================================================================
// 8. 单段几何（v3 第 8.1 / 8.2 节 + 第 15.4 节契约）
// =====================================================================

/** 保守候选段高：min(4000, workArea-96)，clamp[480,4000]。 */
export function computeSegmentHeight(input: SegmentHeightInput): SegmentHeightResult {
  const candidate = Math.min(4000, Math.max(1, input.workAreaHeightCss - 96));
  const segmentHeightCss = Math.max(480, Math.min(4000, candidate));
  return { segmentHeightCss };
}

/** 尾段裁剪：CSS 半开区间 → 物理像素区间（一次取整绝对边界，不分别四舍五入高度）。 */
export function placeSegment(input: SegmentPlacementInput): SegmentPlacementResult {
  const { cursorCss, actualScrollYCss, viewportWidthCss, viewportHeightCss, totalHeightCss, bitmapWidthPx, bitmapHeightPx } = input;
  const base: SegmentPlacementResult = {
    ok: false, sourceOffsetCss: 0, drawHeightCss: 0, nextCursorCss: cursorCss,
    scaleX: 0, scaleY: 0, sourceStartPx: 0, destStartPx: 0, destEndPx: 0, drawHeightPx: 0,
  };
  if (viewportWidthCss <= 0 || viewportHeightCss <= 0) return { ...base, reason: '视口宽高非正' };
  if (bitmapWidthPx <= 0 || bitmapHeightPx <= 0) return { ...base, reason: '空位图' };

  const sourceOffsetCss = Math.max(0, cursorCss - actualScrollYCss);
  const remainingInView = viewportHeightCss - sourceOffsetCss;
  const remainingInDoc = totalHeightCss - cursorCss;
  const drawHeightCss = Math.min(remainingInView, remainingInDoc);
  if (drawHeightCss <= 0) {
    return { ...base, sourceOffsetCss, drawHeightCss, reason: 'nextCursor <= cursor（无可绘制高度）' };
  }
  const nextCursorCss = cursorCss + drawHeightCss;

  const scaleX = bitmapWidthPx / viewportWidthCss;
  const scaleY = bitmapHeightPx / viewportHeightCss;
  const sourceStartPx = Math.round((cursorCss - actualScrollYCss) * scaleY);
  const destStartPx = Math.round(cursorCss * scaleY);
  const destEndPx = Math.round(nextCursorCss * scaleY);
  const drawHeightPx = destEndPx - destStartPx;

  return { ok: true, sourceOffsetCss, drawHeightCss, nextCursorCss, scaleX, scaleY, sourceStartPx, destStartPx, destEndPx, drawHeightPx };
}

// =====================================================================
// 9. 进度（v3 第 10 节 + 第 15.5 节契约）
// =====================================================================

/** 计算捕获/编码阶段的单调百分比，限定 0–100。planning/preparing 阶段返回 -1（不确定）。 */
export function computeProgressPercent(
  phase: ExportImagePhase,
  completedSteps: number,
  totalSteps: number,
): number {
  if (phase === 'planning' || phase === 'preparing') return -1;
  if (totalSteps <= 0) return 0;
  const pct = Math.round((completedSteps / totalSteps) * 100);
  return Math.max(0, Math.min(100, pct));
}

/** 迟到事件过滤：jobId 与当前 job 不符 → 丢弃。 */
export function isStaleEvent(eventJobId: string, currentJobId: string | null): boolean {
  if (!currentJobId) return true;
  return eventJobId !== currentJobId;
}

/** 构造一条进度 payload（便于主进程统一发出）。 */
export function makeProgressPayload(
  partial: Omit<ExportImageProgressPayload, 'percent'> & { percent?: number },
): ExportImageProgressPayload {
  const percent = partial.percent ?? computeProgressPercent(partial.phase, 0, 0);
  return { ...partial, percent: percent < 0 ? 0 : percent };
}

// =====================================================================
// 10. 结果联合便捷构造
// =====================================================================

export const ExportResults = {
  saved: (paths: string[]): ExportImageResult => ({ status: 'saved', paths }),
  cancelled: (): ExportImageResult => ({ status: 'cancelled' }),
  failed: (code: string, message: string): ExportImageResult => ({ status: 'failed', code, message }),
};
