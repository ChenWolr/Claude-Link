// 会话导出 JPEG 长图：共享类型（主进程 ↔ 隐藏导出 renderer ↔ 可见 renderer 共用）。
// 设计依据：docs/glittery-hatching-neumann-v3.md。
// 本文件只放类型，无运行时逻辑、无 Vue/Electron/DOM 副作用，Node selftest 可直接导入。

import type { ThemePalette } from '../constants';

// —— 最小渲染契约 ——
// 完整数据库 Message 是它的超集（多 rawEvent / parentTaskId 等图片渲染不需要的字段）。
// store、group-messages、复用组件只要求 RenderableMessage，不伪造缺失字段，也不发送 rawEvent。
export interface RenderableMessage {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  eventType: string | null;
  costUsd: number | null;
  durationMs: number | null;
  processKind: string | null;
  parentAgentId: string | null;
  toolUseId: string | null;
  title: string | null;
  isError: boolean;
  createdAt: string;
}

// —— 进度状态机（判别联合，不使用多个松散 boolean）——
// 见 v3 第 10 节。idle 为可见 renderer 初始态；其余为一次导出 job 的阶段。
export type ExportImagePhase =
  | 'idle'
  | 'preparing'
  | 'planning'
  | 'capturing'
  | 'encoding'
  | 'waitingForDestination'
  | 'saving'
  | 'done'
  | 'cancelled'
  | 'error';

// 进度事件：主进程 → 可见 renderer（EXPORT_IMAGE_PROGRESS），
// 以及隐藏 renderer → 主进程（EXPORT_RENDER_PROGRESS）共用同一形状。
export interface ExportImageProgressPayload {
  jobId: string;
  sessionId: string;
  sessionName: string;
  phase: ExportImagePhase;
  page: number;        // 当前页（1-based；planning 阶段为 0）
  totalPages: number;  // 总页数；planning/不确定阶段为 0
  segment: number;     // 当前段（1-based）
  segmentsInPage: number;
  percent: number;     // 0–100；planning 阶段忽略（不确定进度）
  message: string;     // 用户文案
}

// —— 终态结果（saved / cancelled / failed 必须判别联合，不混淆）——
export type ExportImageResult =
  | { status: 'saved'; paths: string[] }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; message: string };

// —— 快照：点击导出瞬间冻结的不可变数据，传给隐藏 renderer ——
export interface ExportJobSnapshot {
  jobId: string;
  sessionId: string;
  sessionName: string;          // 已净化的会话名（用于文件名 + 标题）
  sessionCreatedAt: string;
  exportedAt: string;           // 导出开始时的本地时间戳（文件名用）
  themePaletteId: string;
  themePalette: ThemePalette;   // 冻结完整色板
  fontScale: string;            // 字号档位 small/medium/large
  // v4.1：导出格式由主进程在 start 时冻结，renderer 不可改。JPEG 走 v3 Canvas 路径，PNG 走 pngjs+worker。
  format: ExportImageFormat;
  // 主流程消息（parentAgentId===null），不含 rawEvent/parentTaskId；
  // 子 Agent 详情不进主聊天长图。
  messages: RenderableMessage[];
}

// —— 分页 ——
// 稳定可见渲染单元（分页原子单元）。由 groupMessagesForRender 的 RenderItem 加类型前缀 ID 得到。
// 过程 fold 是一个原子单元（fold 内消息和已配对 tool use/result 本期不单独分页）。
export interface StableUnit {
  kind: 'message' | 'fold';
  stableId: string;   // 'msg:<id>' | 'fold:<firstId>'，全局唯一
  turnIndex: number;  // 所属对话轮（从 user 边界划分；首条非 user 的前置归 turn 0）
  weight: number;     // 可见权重（可见字符数；图片按 imageWeight 估算）
  message?: RenderableMessage;   // kind==='message' 时存在
  messages?: RenderableMessage[]; // kind==='fold' 时存在
}

// 页的稳定单元半开区间 [startUnitIndex, endUnitIndex)，引用同一份不可变 StableUnit[]。
export interface PageRange {
  startUnitIndex: number;
  endUnitIndex: number;
}

// 稳定单元构建入参：分组后的渲染项（与 renderer 的 RenderItem 结构兼容，由隐藏 renderer 适配传入）。
// message 项 messages 长度为 1；fold 项 messages 长度 ≥1。firstMessageId 用于稳定 ID。
export interface StableUnitInput {
  kind: 'message' | 'fold';
  firstMessageId: string;
  messages: RenderableMessage[];
}

export interface PaginationBudget {
  targetWeight: number;       // 初始贪心目标权重（默认 10000）
  imageWeight: number;        // 单张图片估算权重（默认 6000）
  maxPageCount: number;       // 页数上限（默认 100）
  maxPageHeightCss: number;   // 单页 CSS 高度上限（捕获前由实测像素预算换算）
}

export type PaginateResult =
  | { ok: true; pages: PageRange[] }
  | {
      ok: false;
      code: 'too-many-pages' | 'atomic-unit-over-budget';
      message: string;
      expectedPages?: number;
      unitStableId?: string;
    };

// —— 像素预算（v3 第 8.4 节）——
export interface PixelBudgetInput {
  physicalWidth: number;
  physicalHeight: number;
  segmentCount: number;          // 原始分段数（检查前不 clamp）
  maxSegmentRgbaBytes: number;   // 最大单段 RGBA 字节数
}
export interface PixelBudgetResult {
  ok: boolean;
  reason?: string;
}

// —— 快照预算（v3 第 11.3 节，创建隐藏窗口前检查）——
export interface SnapshotBudgetInput {
  messageCount: number;
  // 每条消息的 UTF-8 字节数
  messageUtf8Bytes: number[];
  // 估算图片张数
  imageCount: number;
}
export interface SnapshotBudgetResult {
  ok: boolean;
  reason?: string;
}

// —— 单段几何（v3 第 8.1 / 8.2 节）——
export interface SegmentHeightInput {
  workAreaHeightCss: number; // 原始可见窗口所在 display 的 workArea 高度
}
export interface SegmentHeightResult {
  segmentHeightCss: number;
}

// 尾段裁剪：把一段已捕获的位图按 CSS 半开区间映射到物理像素区间。
export interface SegmentPlacementInput {
  cursorCss: number;          // 尚未绘制的文档游标（CSS px）
  actualScrollYCss: number;   // 实际滚动位置（CSS px）
  viewportWidthCss: number;   // 当前视口宽度（CSS px）
  viewportHeightCss: number;  // 当前视口高度（CSS px）
  totalHeightCss: number;     // 文档总高度（CSS px）
  bitmapWidthPx: number;      // 本段 PNG 解码后的物理宽
  bitmapHeightPx: number;     // 本段 PNG 解码后的物理高
}
export interface SegmentPlacementResult {
  ok: boolean;
  reason?: string;
  sourceOffsetCss: number;
  drawHeightCss: number;
  nextCursorCss: number;
  scaleX: number;
  scaleY: number;
  sourceStartPx: number;
  destStartPx: number;
  destEndPx: number;
  drawHeightPx: number;
}

// —— JPEG 分块 IPC（隐藏 renderer → 主进程，2 MiB 分块，有背压）——
export interface PageChunkPayload {
  jobId: string;
  page: number;         // 1-based
  sequence: number;     // 分块序号，从 0 严格递增
  offset: number;       // 在该页 JPEG 中的字节偏移
  totalBytes: number;   // 该页 JPEG 总字节数
  bytes: Uint8Array;    // 单块二进制（≤ 2 MiB）
}

// —— 隐藏 renderer 完成报告（判别联合，finish 只能调用一次）——
export type ExportRenderFinishPayload =
  | { kind: 'done'; jobId: string; pageImages: number }
  | { kind: 'failed'; jobId: string; code: string; message: string };

// 隐藏 renderer 捕获一段的请求参数（renderer → 主进程 EXPORT_RENDER_CAPTURE_SELF）。
export interface CaptureSelfRequest {
  jobId: string;
  page: number;
  segment: number;
  // 不含 rect：主进程从绑定窗口 getContentSize 自行生成全视口 rect，不接受 renderer 自定义。
}

// 主进程返回单段 PNG 二进制（不转 Base64）。
export type CaptureSelfResponse =
  | { ok: true; png: Uint8Array; bitmapWidth: number; bitmapHeight: number }
  | { ok: false; code: string; message: string };

// =====================================================================
// v4.1：PNG 长图（Node/pngjs + worker_threads）共享类型
// JPEG 继续沿用 v3 的 CaptureSelfResponse / PageChunkPayload；PNG 走下列页协议。
// 设计依据：docs/superpowers/plans/2026-07-21-export-image-v41-png-worker.md §3 Task 5。
// =====================================================================

/** 导出格式。主进程在 start 时冻结，全链路不可被 renderer 改写。 */
export type ExportImageFormat = 'jpeg' | 'png';

/** PNG 页开始请求（renderer → 主进程 EXPORT_RENDER_BEGIN_PAGE）。 */
export interface ExportPageBeginRequest {
  jobId: string;
  page: number;        // 1-based
  totalPages: number;
  format: ExportImageFormat;
}

/** PNG 页开始响应：主进程读 DOM 几何后回传，renderer 据此驱动滚动捕获循环。 */
export type ExportPageBeginResponse =
  | {
      ok: true;
      page: number;
      pageHeightCss: number;
      viewportWidthCss: number;
      viewportHeightCss: number;
    }
  | { ok: false; code: string; message: string };

/** PNG 探测：渲染完整页内容并稳定后，主进程读真实视口/位图比例，用于预算反推。 */
export interface PngProbeSelfRequest {
  jobId: string;
}
export type PngProbeSelfResponse =
  | {
      ok: true;
      viewportWidthCss: number;
      viewportHeightCss: number;
      bitmapWidthPx: number;
      bitmapHeightPx: number;
      scaleY: number;
    }
  | { ok: false; code: string; message: string };

/**
 * PNG 分支的 captureSelf：主进程捕获一段后**直接送 worker**，不把 PNG bytes 回 renderer。
 * 只回几何 + 推进后的 cursor，renderer 据此继续滚动。
 */
export interface PngCaptureSelfRequest {
  jobId: string;
  page: number;
  segment: number;
  cursorCss: number;
}
export type PngCaptureSelfResponse =
  | {
      ok: true;
      segment: number;
      nextCursorCss: number;
      actualScrollYCss: number;
      bitmapWidthPx: number;
      bitmapHeightPx: number;
    }
  | { ok: false; code: string; message: string };

/** PNG 页完成请求（renderer → 主进程 EXPORT_RENDER_FINISH_PAGE）：触发 worker 最终编码 + 写临时文件。 */
export interface ExportPageFinishRequest {
  jobId: string;
  page: number;
}
export type ExportPageFinishResponse =
  | { ok: true; page: number; widthPx: number; heightPx: number; bytes: number }
  | { ok: false; code: string; message: string };

/**
 * worker 行拷贝几何。由主进程用 placeSegment() 算好并校验后下发给 worker，worker 不重算、只按行 copy。
 * 半开区间：源 [sourceStartPx, sourceStartPx+drawHeightPx)，目的 [destStartPx, destEndPx)。
 */
export interface SegmentCopyGeometry {
  sourceStartPx: number;
  sourceEndPx: number;
  destStartPx: number;
  destEndPx: number;
  drawHeightPx: number;
  bitmapWidthPx: number;
  bitmapHeightPx: number;
}

// =====================================================================
// v4.1 codec worker 消息协议（主进程 ↔ worker，内部；不暴露给 renderer）
// worker 只接受主进程生成的内部消息，outputPath 必须是主进程生成的当前页临时路径。
// 依据：docs/superpowers/plans/2026-07-21-export-image-v41-png-worker.md §4 Task 7。
// =====================================================================

/** 主进程 → worker。begin 的 totalHeightPx/bitmapWidthPx 由主进程据 probe 实测比例预算并冻结。 */
export type CodecMessage =
  | {
      type: 'begin';
      jobId: string;
      page: number;
      outputPath: string;          // 主进程生成的当前页最终路径（worker 写 .tmp 再 rename）
      pageHeightCss: number;
      viewportWidthCss: number;
      viewportHeightCss: number;
      bitmapWidthPx: number;       // probe 冻结的物理宽（首段须一致）
      totalHeightPx: number;       // round(pageHeightCss × scaleY)，预分配整页 RGBA
    }
  | {
      type: 'segment';
      jobId: string;
      page: number;
      segment: number;             // 1-based，严格递增
      png: ArrayBuffer;            // transferable；主进程保证独立 ArrayBuffer（byteOffset 安全）
      geometry: SegmentCopyGeometry;
    }
  | { type: 'finish'; jobId: string; page: number }
  | { type: 'abort'; jobId: string; page: number; reason: string };

/** worker → 主进程。 */
export type CodecWorkerMessage =
  | { type: 'begun'; jobId: string; page: number; bitmapWidthPx: number; totalHeightPx: number }
  | { type: 'segment-accepted'; jobId: string; page: number; segment: number; nextDestEndPx: number }
  | { type: 'page-saved'; jobId: string; page: number; widthPx: number; heightPx: number; bytes: number }
  | { type: 'error'; jobId: string; page: number; code: string; message: string };
