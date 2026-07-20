// 导出捕获/拼接/编码循环（隐藏 export renderer 内执行）。
// 阶段三：真实消息组件渲染（MessageList exportMode + groupMessagesForRender），按 item 实测高度分页。
// 复用 shared/export-image.ts 的 placeSegment（尾段裁剪）与 JPEG 常量。
// 阶段四会把"简单按高度分页"换成 paginate() 两遍分页 + 保存对话框。

import { reactive } from 'vue';
import { JPEG_CHUNK_BYTES, JPEG_QUALITY, placeSegment, checkPixelBudget, DEFAULT_EXPORT_BUDGET } from '@shared/export-image';
import type { ExportImagePhase, ThemePalette } from '@shared/types/export-image';
import { groupMessagesForRender, type RenderItem } from '../utils/group-messages';
import { applyThemePalette } from '../utils/apply-theme';
import { FONT_SCALE_SIZES } from '@shared/constants';

// 单页 CSS 高度上限（保守取 1500，配合每页像素预算检查；阶段四每段捕获后用实测比例复核）。
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
  // scroller 直接子元素 = 各 ProcessGroup/MessageBubble 根（.process-fold / .bubble）。
  for (let i = 0; i < scroller.children.length; i++) {
    const child = scroller.children[i] as HTMLElement;
    const r = child.getBoundingClientRect();
    if (r.height <= 0) continue;
    heights.push(Math.round(r.bottom - scrollerRect.top));
  }
  // 转为逐项高度（相邻边界差），最后一项以外。
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

  // 复用现有分组：对完整主流程消息只调用一次 groupMessagesForRender，得到不可变 RenderItem[]。
  const items = groupMessagesForRender(job.messages);
  if (items.length === 0) {
    await api.finish({ kind: 'failed', jobId: job.jobId, code: 'empty', message: '无可导出内容' });
    return;
  }

  // 先渲染全部 item，测量每项高度 + 固定开销（header/card/padding）。
  runnerState.items = items;
  report(api, job.jobId, { phase: 'planning', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: '正在排版长图…' });
  await waitStable();
  const itemHeights = measureItemHeights();
  const docHeightAll = document.documentElement.scrollHeight;
  const itemsContentHeight = itemHeights.reduce((s, h) => s + h, 0);
  const overhead = Math.max(0, docHeightAll - itemsContentHeight);

  const pages = splitPages(items.length, itemHeights, overhead, PAGE_HEIGHT_CSS);
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
    const pageHeight = document.documentElement.scrollHeight;
    report(api, job.jobId, {
      phase: 'capturing',
      page: pi + 1,
      totalPages: pages.length,
      segment: 0,
      segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))),
      message: `正在导出第 ${pi + 1} / ${pages.length} 张…`,
    });

    let canvas: OffscreenCanvas | null = null;
    let cursor = 0;
    let segIdx = 0;
    let drawnScaleX = 0;
    let drawnWidth = 0;

    while (cursor < pageHeight) {
      window.scrollTo(0, cursor);
      await twoFrames();
      const actualScroll = window.scrollY;
      const cap = await api.captureSelf({ jobId: job.jobId, page: pi + 1, segment: segIdx + 1 });
      if (!cap.ok) {
        await api.finish({ kind: 'failed', jobId: job.jobId, code: cap.code, message: cap.message });
        return;
      }
      const placement = placeSegment({
        cursorCss: cursor,
        actualScrollYCss: actualScroll,
        viewportWidthCss: viewportW,
        viewportHeightCss: viewportH,
        totalHeightCss: pageHeight,
        bitmapWidthPx: cap.bitmapWidth,
        bitmapHeightPx: cap.bitmapHeight,
      });
      if (!placement.ok) {
        await api.finish({ kind: 'failed', jobId: job.jobId, code: 'placement', message: placement.reason || 'placement 失败' });
        return;
      }
      if (!canvas) {
        drawnScaleX = placement.scaleX;
        drawnWidth = Math.round(viewportW * placement.scaleX);
        const pagePhysHeight = Math.round(pageHeight * placement.scaleY);
        // 每页像素预算检查（实测比例）。单 item 页超限即原子单元超限。
        const segRgba = drawnWidth * cap.bitmapHeight * 4;
        const budget = checkPixelBudget({ physicalWidth: drawnWidth, physicalHeight: pagePhysHeight, segmentCount: Math.ceil(pageHeight / viewportH), maxSegmentRgbaBytes: segRgba });
        if (!budget.ok) {
          const single = page.end - page.start <= 1;
          await api.finish({ kind: 'failed', jobId: job.jobId, code: single ? 'atomic-unit-over-budget' : 'page-over-budget', message: single ? '单条消息或过程组过长，无法安全生成图片' : `第 ${pi + 1} 页超像素预算：${budget.reason}` });
          return;
        }
        canvas = new OffscreenCanvas(drawnWidth, pagePhysHeight);
      }
      if (Math.abs(placement.scaleX - drawnScaleX) > 1e-3 || cap.bitmapWidth !== drawnWidth) {
        await api.finish({ kind: 'failed', jobId: job.jobId, code: 'scale-changed', message: '段间比例不一致' });
        return;
      }
      const ctx = canvas.getContext('2d')!;
      const bmp = await createImageBitmap(new Blob([cap.png as Uint8Array], { type: 'image/png' }));
      ctx.drawImage(bmp, 0, placement.sourceStartPx, cap.bitmapWidth, placement.drawHeightPx, 0, placement.destStartPx, cap.bitmapWidth, placement.drawHeightPx);
      cursor = placement.nextCursorCss;
      segIdx += 1;
      report(api, job.jobId, {
        phase: 'capturing',
        page: pi + 1,
        totalPages: pages.length,
        segment: segIdx,
        segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))),
        message: `正在导出第 ${pi + 1} / ${pages.length} 张 · 第 ${segIdx} 段`,
      });
    }

    report(api, job.jobId, { phase: 'encoding', page: pi + 1, totalPages: pages.length, segment: segIdx, segmentsInPage: Math.max(1, Math.ceil(pageHeight / Math.max(1, viewportH))), message: `正在生成第 ${pi + 1} / ${pages.length} 张 JPEG…` });
    console.log(`[runner] page ${pi + 1}: segments=${segIdx} pageHeight=${pageHeight}`);
    const blob = await (canvas as OffscreenCanvas).convertToBlob({ type: 'image/jpeg', quality: JPEG_QUALITY });
    if (blob.type !== 'image/jpeg') {
      await api.finish({ kind: 'failed', jobId: job.jobId, code: 'jpeg-mime', message: `convertToBlob 返回 ${blob.type}` });
      return;
    }
    const buf = new Uint8Array(await blob.arrayBuffer());
    let offset = 0;
    let seq = 0;
    while (offset < buf.length) {
      const end = Math.min(offset + JPEG_CHUNK_BYTES, buf.length);
      const chunk = new Uint8Array(buf.subarray(offset, end));
      await api.writePageChunk({ jobId: job.jobId, page: pi + 1, sequence: seq, offset, totalBytes: buf.length, bytes: chunk });
      offset = end;
      seq += 1;
    }
    canvas = null;
  }

  await api.finish({ kind: 'done', jobId: job.jobId, pageImages: pages.length });
}
