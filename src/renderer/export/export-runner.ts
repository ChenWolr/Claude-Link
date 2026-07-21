// 导出捕获/拼接/编码循环（隐藏 export renderer 内执行）。
// v4.1：按 job.format 分支。
//   JPEG：沿用 v3 —— captureSelf 拿 PNG bytes → placeSegment → OffscreenCanvas → convertToBlob → writePageChunk。
//   PNG ：probeSelf → beginPage → scrollTo → captureSelf（主进程直接送 worker，只回几何）→ finishPage。
//         不创建 OffscreenCanvas、不收 PNG bytes、不 drawImage、不 convertToBlob、不分块写。
// 复用 shared/export-image.ts 的 placeSegment（JPEG 尾段裁剪）与常量。
// 依据：docs/superpowers/plans/2026-07-21-export-image-v41-png-worker.md §6 Task 10。

import { reactive } from 'vue';
import { JPEG_CHUNK_BYTES, JPEG_QUALITY, placeSegment, checkPixelBudget, deriveMaxPageHeightByMemory, DEFAULT_EXPORT_BUDGET } from '@shared/export-image';
import type {
  ExportImagePhase,
  PngCaptureSelfResponse,
  ThemePalette,
} from '@shared/types/export-image';
import { groupMessagesForRender, type RenderItem } from '../utils/group-messages';
import { applyThemePalette } from '../utils/apply-theme';
import { FONT_SCALE_SIZES } from '@shared/constants';

// 单页 CSS 高度上限（保守取 1500，配合每页像素预算检查；阶段四每段捕获后用实测比例复核）。
// Task 11 会按格式预算（PNG 内存预算）替换为动态值。
const PAGE_HEIGHT_CSS = 1500;
const MAX_PAGES = DEFAULT_EXPORT_BUDGET.maxPageCount; // 100

export const runnerState = reactive({
  phase: 'preparing' as ExportImagePhase,
  items: [] as RenderItem[],
  sessionName: '',
  exportedAt: '',
});

function applyTheme(palette: ThemePalette, fontScale: string): void {
  applyThemePalette(palette);
  const root = document.documentElement;
  root.style.setProperty('--font-size-base', FONT_SCALE_SIZES[fontScale] ?? '16px');
}

function twoFrames(): Promise<void> {
  return new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => res())));
}

async function waitStable(): Promise<void> {
  await Promise.resolve();
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch { /* ignore */ }
  }
  let prev = -1;
  for (let i = 0; i < 8; i++) {
    await twoFrames();
    const h = document.documentElement.scrollHeight;
    if (h === prev) return;
    prev = h;
  }
}

/** 测量 MessageList scroller 内每个渲染项的高度（item = 分页原子单元）。 */
function measureItemHeights(): number[] {
  const scroller = document.querySelector('.message-list__scroller');
  if (!scroller) return [];
  const scrollerRect = scroller.getBoundingClientRect();
  const heights: number[] = [];
  for (let i = 0; i < scroller.children.length; i++) {
    const child = scroller.children[i] as HTMLElement;
    const r = child.getBoundingClientRect();
    if (r.height <= 0) continue;
    heights.push(Math.round(r.bottom - scrollerRect.top));
  }
  const itemHeights: number[] = [];
  for (let i = 0; i < heights.length; i++) {
    const top = i === 0 ? 0 : heights[i - 1];
    itemHeights.push(heights[i] - top);
  }
  return itemHeights;
}

/** 按 item 累积高度切页（item 为原子单元；单个 item 超限自成一项，由多段捕获）。 */
function splitPages(itemCount: number, itemHeights: number[], overhead: number, maxHeight: number): { start: number; end: number }[] {
  const pages: { start: number; end: number }[] = [];
  let start = 0;
  let acc = 0;
  for (let i = 0; i < itemCount; i++) {
    const h = itemHeights[i] ?? 0;
    if (i > start && overhead + acc + h > maxHeight) {
      pages.push({ start, end: i });
      start = i;
      acc = 0;
    }
    acc += h;
  }
  pages.push({ start, end: itemCount });
  return pages;
}

function report(
  api: NonNullable<Window['exportLink']>,
  jobId: string,
  partial: { phase: ExportImagePhase; page: number; totalPages: number; segment: number; segmentsInPage: number; message: string; percent?: number },
): void {
  runnerState.phase = partial.phase;
  api.reportProgress({ jobId, sessionId: '', sessionName: runnerState.sessionName, percent: partial.percent ?? 0, ...partial });
}

export async function runExport(): Promise<void> {
  const api = window.exportLink;
  if (!api) return;
  const job = await api.getJob();
  if (!job) {
    await api.finish({ kind: 'failed', jobId: '', code: 'no-job', message: '无 job 绑定' });
    return;
  }
  runnerState.sessionName = job.sessionName;
  runnerState.exportedAt = job.exportedAt;
  applyTheme(job.themePalette, job.fontScale);

  const items = groupMessagesForRender(job.messages);
  if (items.length === 0) {
    await api.finish({ kind: 'failed', jobId: job.jobId, code: 'empty', message: '无可导出内容' });
    return;
  }

  runnerState.items = items;
  report(api, job.jobId, { phase: 'planning', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: '正在排版长图…' });
  await waitStable();
  const itemHeights = measureItemHeights();
  const docHeightAll = document.documentElement.scrollHeight;
  const itemsContentHeight = itemHeights.reduce((s, h) => s + h, 0);
  const overhead = Math.max(0, docHeightAll - itemsContentHeight);

  // PNG 规划：先 probe 实测比例，用内存预算反推单页 CSS 高度上限（远大于 JPEG 的 1500）。
  let maxPageHeight = PAGE_HEIGHT_CSS;
  if (job.format === 'png') {
    const probe = await api.probeSelf({ jobId: job.jobId });
    if (!probe.ok) {
      await api.finish({ kind: 'failed', jobId: job.jobId, code: probe.code, message: probe.message });
      return;
    }
    maxPageHeight = deriveMaxPageHeightByMemory(probe.scaleY, probe.viewportWidthCss);
  }
  const pages = splitPages(items.length, itemHeights, overhead, maxPageHeight);
  if (pages.length > MAX_PAGES) {
    await api.finish({ kind: 'failed', jobId: job.jobId, code: 'too-many-pages', message: `预计需要 ${pages.length} 张图片，超过上限 ${MAX_PAGES} 张` });
    return;
  }

  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  for (let pi = 0; pi < pages.length; pi++) {
    const page = pages[pi];
    runnerState.items = items.slice(page.start, page.end);
    await waitStable();

    const ok = job.format === 'png'
      ? await capturePngPage(api, job.jobId, pi, pages.length)
      : await captureJpegPage(api, job.jobId, pi, pages.length, viewportW, viewportH);
    if (!ok) return;
  }

  await api.finish({ kind: 'done', jobId: job.jobId, pageImages: pages.length });
}

/** JPEG 单页：captureSelf(png bytes) → placeSegment → OffscreenCanvas → JPEG 分块写。返回 true=成功。 */
async function captureJpegPage(
  api: NonNullable<Window['exportLink']>,
  jobId: string,
  pi: number,
  pagesCount: number,
  viewportW: number,
  viewportH: number,
): Promise<boolean> {
  const pageHeight = document.documentElement.scrollHeight;
  report(api, jobId, {
    phase: 'capturing', page: pi + 1, totalPages: pagesCount, segment: 0,
    segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))),
    message: `正在导出第 ${pi + 1} / ${pagesCount} 张…`,
  });

  let canvas: OffscreenCanvas | null = null;
  let cursor = 0;
  let segIdx = 0;
  let drawnScaleX = 0;
  let drawnWidth = 0;

  while (cursor < pageHeight) {
    window.scrollTo(0, cursor);
    await twoFrames();
    const cap = await api.captureSelf({ jobId, page: pi + 1, segment: segIdx + 1 });
    if (!cap.ok) {
      await api.finish({ kind: 'failed', jobId, code: cap.code, message: cap.message });
      return false;
    }
    if (!('png' in cap)) {
      await api.finish({ kind: 'failed', jobId, code: 'wrong-format', message: 'JPEG 页收到非 JPEG 响应' });
      return false;
    }
    const placement = placeSegment({
      cursorCss: cursor,
      actualScrollYCss: window.scrollY,
      viewportWidthCss: viewportW,
      viewportHeightCss: viewportH,
      totalHeightCss: pageHeight,
      bitmapWidthPx: cap.bitmapWidth,
      bitmapHeightPx: cap.bitmapHeight,
    });
    if (!placement.ok) {
      await api.finish({ kind: 'failed', jobId, code: 'placement', message: placement.reason || 'placement 失败' });
      return false;
    }
    if (!canvas) {
      drawnScaleX = placement.scaleX;
      drawnWidth = Math.round(viewportW * placement.scaleX);
      const pagePhysHeight = Math.round(pageHeight * placement.scaleY);
      const segRgba = drawnWidth * cap.bitmapHeight * 4;
      const budget = checkPixelBudget({ physicalWidth: drawnWidth, physicalHeight: pagePhysHeight, segmentCount: Math.ceil(pageHeight / viewportH), maxSegmentRgbaBytes: segRgba });
      if (!budget.ok) {
        await api.finish({ kind: 'failed', jobId, code: 'page-over-budget', message: `第 ${pi + 1} 页超像素预算：${budget.reason}` });
        return false;
      }
      canvas = new OffscreenCanvas(drawnWidth, pagePhysHeight);
    }
    if (Math.abs(placement.scaleX - drawnScaleX) > 1e-3 || cap.bitmapWidth !== drawnWidth) {
      await api.finish({ kind: 'failed', jobId, code: 'scale-changed', message: '段间比例不一致' });
      return false;
    }
    const ctx = canvas.getContext('2d')!;
    const bmp = await createImageBitmap(new Blob([cap.png as Uint8Array], { type: 'image/png' }));
    ctx.drawImage(bmp, 0, placement.sourceStartPx, cap.bitmapWidth, placement.drawHeightPx, 0, placement.destStartPx, cap.bitmapWidth, placement.drawHeightPx);
    cursor = placement.nextCursorCss;
    segIdx += 1;
    report(api, jobId, {
      phase: 'capturing', page: pi + 1, totalPages: pagesCount, segment: segIdx,
      segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))),
      message: `正在导出第 ${pi + 1} / ${pagesCount} 张 · 第 ${segIdx} 段`,
    });
  }

  report(api, jobId, { phase: 'encoding', page: pi + 1, totalPages: pagesCount, segment: segIdx, segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))), message: `正在生成第 ${pi + 1} / ${pagesCount} 张 JPEG…` });
  const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
  if (blob.type !== 'image/jpeg') {
    await api.finish({ kind: 'failed', jobId, code: 'jpeg-mime', message: `convertToBlob 返回 ${blob.type}` });
    return false;
  }
  const buf = new Uint8Array(await blob.arrayBuffer());
  let offset = 0;
  let seq = 0;
  while (offset < buf.length) {
    const end = Math.min(offset + JPEG_CHUNK_BYTES, buf.length);
    const chunk = new Uint8Array(buf.subarray(offset, end));
    await api.writePageChunk({ jobId, page: pi + 1, sequence: seq, offset, totalBytes: buf.length, bytes: chunk });
    offset = end;
    seq += 1;
  }
  canvas = null;
  return true;
}

/** PNG 单页：beginPage → scrollTo → captureSelf(几何) → finishPage。不创建 Canvas。返回 true=成功。 */
async function capturePngPage(
  api: NonNullable<Window['exportLink']>,
  jobId: string,
  pi: number,
  pagesCount: number,
): Promise<boolean> {
  const begin = await api.beginPage({ jobId, page: pi + 1, totalPages: pagesCount, format: 'png' });
  if (!begin.ok) {
    await api.finish({ kind: 'failed', jobId, code: begin.code, message: begin.message });
    return false;
  }
  const pageHeight = begin.pageHeightCss;
  const viewportH = begin.viewportHeightCss;
  const segmentsInPage = Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH)));

  report(api, jobId, {
    phase: 'capturing', page: pi + 1, totalPages: pagesCount, segment: 0, segmentsInPage,
    message: `正在导出第 ${pi + 1} / ${pagesCount} 张（PNG）…`,
  });

  let cursor = 0;
  let segIdx = 0;
  while (cursor < pageHeight - 0.5) {
    window.scrollTo(0, cursor);
    await twoFrames();
    const cap = await api.captureSelf({ jobId, page: pi + 1, segment: segIdx + 1, cursorCss: cursor }) as PngCaptureSelfResponse;
    if (!cap.ok) {
      await api.finish({ kind: 'failed', jobId, code: cap.code, message: cap.message });
      return false;
    }
    if (cap.nextCursorCss <= cursor) {
      await api.finish({ kind: 'failed', jobId, code: 'no-progress', message: `段未推进 cursor：${cursor} → ${cap.nextCursorCss}` });
      return false;
    }
    cursor = cap.nextCursorCss;
    segIdx += 1;
    report(api, jobId, {
      phase: 'capturing', page: pi + 1, totalPages: pagesCount, segment: segIdx, segmentsInPage,
      message: `正在导出第 ${pi + 1} / ${pagesCount} 张（PNG）· 第 ${segIdx} 段`,
    });
  }

  report(api, jobId, {
    phase: 'encoding', page: pi + 1, totalPages: pagesCount, segment: segIdx, segmentsInPage,
    message: `正在编码第 ${pi + 1} / ${pagesCount} 张 PNG…`,
  });
  const fin = await api.finishPage({ jobId, page: pi + 1 });
  if (!fin.ok) {
    await api.finish({ kind: 'failed', jobId, code: fin.code, message: fin.message });
    return false;
  }
  return true;
}
