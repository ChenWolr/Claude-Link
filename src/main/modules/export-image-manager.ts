// 会话导出 JPEG 长图：主进程管理器（v3 第 6/7/8/11/12/13 节）。
// 职责：单飞 job、阶段机、数据库快照 projection、隐藏 export BrowserWindow 生命周期、
// 单段 capturePage + toPNG、JPEG 分块临时文件顺序写入、统一 cleanup、启动残留清理。
// 阶段二：fixture 闭环（捕获→拼接→JPEG→分块写临时文件→finish），不含保存对话框（阶段四）。

import { app, BrowserWindow, dialog, ipcMain, session } from 'electron';
import { mkdtemp, readdir, stat, rm } from 'fs/promises';
import { constants as fsConstants, openSync, closeSync, writeSync, copyFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { Worker } from 'worker_threads';
import type { WebContents } from 'electron';
import { IPC_CHANNELS, THEME_PALETTES } from '../../shared/constants';
import {
  JPEG_PAGE_MAX_BYTES,
  buildExportFilename,
  buildSegmentCopyGeometry,
  checkPngMemoryBudget,
  checkSnapshotBudget,
  computeProgressPercent,
  validatePngCaptureRequest,
  validatePngFinishRequest,
} from '../../shared/export-image';
import type {
  CaptureSelfRequest,
  CaptureSelfResponse,
  CodecMessage,
  CodecWorkerMessage,
  ExportImageFormat,
  ExportImagePhase,
  ExportImageProgressPayload,
  ExportImageResult,
  ExportJobSnapshot,
  ExportPageBeginRequest,
  ExportPageBeginResponse,
  ExportPageFinishRequest,
  ExportPageFinishResponse,
  ExportRenderFinishPayload,
  PageChunkPayload,
  PngCaptureSelfRequest,
  PngCaptureSelfResponse,
  PngProbeSelfRequest,
  PngProbeSelfResponse,
  RenderableMessage,
} from '../../shared/types/export-image';
import { getConfig } from './config-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import { logger } from '../utils/logger';

const SEGMENT_PNG_MAX_BYTES = 64 * 1024 * 1024; // 单段 PNG 字节上限
const TEMP_PREFIX = 'claude-link-export-';
const STALE_DIR_TTL_MS = 24 * 60 * 60 * 1000; // 24h
// R3 看门狗：JPEG 沿用固定 90s；PNG 长图按段 ack/页保存重置（慢但有进展不误杀），绝对硬顶防真死循环。
const WATCHDOG_RESET_MS = 90 * 1000;       // 每次段 ack/页保存后重置的窗口
const WATCHDOG_ABSOLUTE_MS = 5 * 60 * 1000; // 单 job 绝对硬顶（5 分钟）

interface PageFile {
  path: string;
  fd: number;
  writtenBytes: number;
  expectedTotal: number | null;
  lastSequence: number;
}

// PNG 单页进行态：主进程冻结的几何/段推进状态，worker 只接收已校验几何。
interface PngPageState {
  page: number;
  pageHeightCss: number;
  viewportWidthCss: number;
  viewportHeightCss: number;
  expectedCursorCss: number;   // 期望的下一段 cursor（容差 ±1/100 CSS px）
  nextSegment: number;         // 期望的下一段 segment 号
  outputPath: string;          // 主进程生成的 page-XXXX.png 路径
  bitmapWidthPx: number;       // probe 冻结物理宽（首段须一致）
  scaleY: number;              // probe 冻结比例
  totalHeightPx: number;       // round(pageHeightCss × scaleY)
}

interface ActiveJob {
  jobId: string;
  origin: WebContents;
  exportWindow: BrowserWindow;
  tempDir: string;
  phase: ExportImagePhase;
  snapshot: ExportJobSnapshot;
  format: ExportImageFormat;
  pageFiles: Map<number, PageFile>;
  // v4.1 PNG：worker 句柄 + 当前页状态（仅 PNG 路径用，JPEG 为 null）。
  codecWorker: Worker | null;
  currentPngPage: PngPageState | null;
  terminal: boolean;
  doneResolve?: (result: ExportImageResult) => void;
  doneReject?: (e: Error) => void;
  finishTimer: NodeJS.Timeout;   // R3：reset 看门狗；超时触发 failJob
  absoluteDeadlineMs: number;    // R3：绝对硬顶时间戳
}

let active: ActiveJob | null = null;

function isActive(): boolean {
  return active !== null;
}

function emitProgress(payload: ExportImageProgressPayload): void {
  if (!active) return;
  // 只转发给仍存活的 origin。
  const origin = active.origin;
  if (!origin.isDestroyed()) {
    origin.send(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS, payload);
  }
}

function makeProgress(partial: Omit<ExportImageProgressPayload, 'percent' | 'jobId' | 'sessionId' | 'sessionName'> & { percent?: number }): void {
  if (!active) return;
  const percent = partial.percent ?? computeProgressPercent(partial.phase, 0, 0);
  emitProgress({
    jobId: active.jobId,
    sessionId: active.snapshot.sessionId,
    sessionName: active.snapshot.sessionName,
    percent: percent < 0 ? 0 : percent,
    ...partial,
  } as ExportImageProgressPayload);
}

// —— 运行时校验 ——
function isOriginSender(sender: WebContents): boolean {
  // origin 必须是当前 job 的 origin WebContents（顶层 frame 由 invoke 保证）。
  return !!active && active.origin === sender && !sender.isDestroyed();
}

function isExportSender(sender: WebContents): boolean {
  return !!active && active.exportWindow.webContents === sender && !sender.isDestroyed();
}

// —— R3 看门狗：reset（段 ack/页保存触发）+ 绝对硬顶 ——
function resetWatchdog(reason: string): void {
  if (!active || active.terminal) return;
  if (Date.now() >= active.absoluteDeadlineMs) {
    void failJob(`导出超过绝对时限（${WATCHDOG_ABSOLUTE_MS / 1000}s）`);
    return;
  }
  clearTimeout(active.finishTimer);
  active.finishTimer = setTimeout(() => { void failJob(`导出段超时（${reason}后 ${WATCHDOG_RESET_MS / 1000}s 无进展）`); }, WATCHDOG_RESET_MS);
}

// —— codec worker 生命周期 ——
// 单 slot 请求/回复配对：capture 单飞，主进程一次只发一个 segment/finish，worker 每消息必回一个。
let pendingWorkerReply: { resolve: (m: CodecWorkerMessage) => void; reject: (e: Error) => void } | null = null;

function workerEntryPath(): string {
  // dev: out/main；packaged: app.asar.unpacked/main（asarUnpack 后 __dirname 自动指向解包路径）。
  return join(__dirname, 'exportImageCodecWorker.js');
}

function ensureCodecWorker(): Worker | null {
  if (!active) return null;
  if (active.codecWorker) return active.codecWorker;
  let w: Worker;
  try {
    w = new Worker(workerEntryPath());
  } catch (e) {
    void failJob(`codec worker 启动失败：${String((e as Error)?.message || e)}`);
    return null;
  }
  w.on('message', (m: CodecWorkerMessage) => {
    if (pendingWorkerReply) { const p = pendingWorkerReply; pendingWorkerReply = null; p.resolve(m); }
    if (m.type === 'error') {
      void failJob(`codec worker 错误：${m.code} — ${m.message}`);
    } else if (m.type === 'segment-accepted' || m.type === 'page-saved') {
      resetWatchdog(m.type);
    }
  });
  w.on('error', (e) => {
    if (pendingWorkerReply) { pendingWorkerReply.reject(e); pendingWorkerReply = null; }
    void failJob(`codec worker error：${String((e as Error)?.message || e)}`);
  });
  w.on('exit', (code) => {
    if (pendingWorkerReply) { pendingWorkerReply.reject(new Error(`worker exit ${code}`)); pendingWorkerReply = null; }
    if (active && !active.terminal && code !== 0) {
      void failJob(`codec worker 异常退出 code=${code}`);
    }
  });
  active.codecWorker = w;
  return w;
}

function terminateCodecWorker(): void {
  if (!active?.codecWorker) return;
  const w = active.codecWorker;
  active.codecWorker = null;
  pendingWorkerReply = null;
  try { w.postMessage({ type: 'abort', jobId: active.jobId, page: active.currentPngPage?.page ?? 0, reason: 'cleanup' } satisfies CodecMessage); } catch { /* ignore */ }
  setTimeout(() => { try { void w.terminate(); } catch { /* ignore */ } }, 200);
}

async function sendToWorker(msg: CodecMessage): Promise<CodecWorkerMessage> {
  const w = ensureCodecWorker();
  if (!w) throw new Error('codec worker 不可用');
  return new Promise((resolve, reject) => {
    pendingWorkerReply = { resolve, reject };
    try { w.postMessage(msg); }
    catch (e) { pendingWorkerReply = null; reject(e as Error); }
  });
}

// —— 受控 DOM 几何读取：固定脚本字符串，不接受 renderer 传入 ——
const DOM_GEOMETRY_SCRIPT = `(() => ({
  scrollY: window.scrollY,
  innerWidth: window.innerWidth,
  innerHeight: window.innerHeight,
  totalHeight: Math.max(
    document.body.scrollHeight, document.body.offsetHeight,
    document.documentElement.scrollHeight, document.documentElement.offsetHeight
  )
}))()`;

interface DomGeometry { scrollY: number; innerWidth: number; innerHeight: number; totalHeight: number; }

async function readExportDomGeometry(win: BrowserWindow): Promise<DomGeometry | { error: string }> {
  if (win.isDestroyed()) return { error: 'window-gone' };
  try {
    const g = await win.webContents.executeJavaScript(DOM_GEOMETRY_SCRIPT, true) as DomGeometry;
    if (![g.scrollY, g.innerWidth, g.innerHeight, g.totalHeight].every(Number.isFinite)) {
      return { error: 'geometry 非有限' };
    }
    if (g.innerWidth <= 0 || g.innerHeight <= 0 || g.totalHeight <= 0) return { error: 'geometry 非正' };
    return g;
  } catch (e) {
    return { error: String((e as Error)?.message || e) };
  }
}

// —— PNG probe：渲染完整页 + 稳定后，读真实视口/位图比例（预算反推用）——
async function pngProbeSelfImpl(_request: PngProbeSelfRequest): Promise<PngProbeSelfResponse> {
  if (!active) return { ok: false, code: 'no-job', message: '没有进行中的导出任务' };
  if (active.format !== 'png') return { ok: false, code: 'wrong-format', message: 'probe 仅 PNG 模式' };
  const win = active.exportWindow;
  if (win.isDestroyed()) return { ok: false, code: 'window-gone', message: '导出窗口已销毁' };
  const g = await readExportDomGeometry(win);
  if ('error' in g) return { ok: false, code: 'geometry', message: g.error };
  const [w, h] = win.getContentSize();
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: w, height: h }, { stayHidden: true, stayAwake: true });
  if (!img || img.isEmpty()) return { ok: false, code: 'empty-capture', message: 'probe capturePage 返回空图' };
  const bmp = img.getSize();
  const scaleY = bmp.height / g.innerHeight;
  return { ok: true, viewportWidthCss: g.innerWidth, viewportHeightCss: g.innerHeight, bitmapWidthPx: bmp.width, bitmapHeightPx: bmp.height, scaleY };
}

// —— PNG begin page：读几何 + 建 outputPath + 起 worker + 下 begin ——
async function pngBeginPageImpl(request: ExportPageBeginRequest): Promise<ExportPageBeginResponse> {
  if (!active) return { ok: false, code: 'no-job', message: '没有进行中的导出任务' };
  if (active.format !== 'png') return { ok: false, code: 'wrong-format', message: 'beginPage 仅 PNG 模式' };
  if (request.format !== 'png') return { ok: false, code: 'bad-format', message: 'beginPage 请求格式非 png' };
  if (!Number.isInteger(request.page) || request.page < 1) return { ok: false, code: 'bad-page', message: '非法页码' };
  const win = active.exportWindow;
  if (win.isDestroyed()) return { ok: false, code: 'window-gone', message: '导出窗口已销毁' };
  const g = await readExportDomGeometry(win);
  if ('error' in g) return { ok: false, code: 'geometry', message: g.error };

  // 比例由本页 probe 冻结（若调用方未先 probe，则用 capturePage 一次实测兜底）。
  const [cw, ch] = win.getContentSize();
  const probe = await win.webContents.capturePage({ x: 0, y: 0, width: cw, height: ch }, { stayHidden: true, stayAwake: true });
  if (!probe || probe.isEmpty()) return { ok: false, code: 'empty-capture', message: 'begin capturePage 返回空图' };
  const bmp = probe.getSize();
  const scaleY = bmp.height / g.innerHeight;
  const totalHeightPx = Math.round(g.totalHeight * scaleY);
  // 主进程权威执行 PNG 内存预算（不信任 renderer）。
  const pngBudget = checkPngMemoryBudget(bmp.width, totalHeightPx);
  if (!pngBudget.ok) {
    return { ok: false, code: 'png-over-budget', message: `PNG 单页超内存预算：${pngBudget.reason}` } satisfies ExportPageBeginResponse;
  }

  const outputPath = join(active.tempDir, `page-${String(request.page).padStart(4, '0')}.png`);
  active.currentPngPage = {
    page: request.page,
    pageHeightCss: g.totalHeight,
    viewportWidthCss: g.innerWidth,
    viewportHeightCss: g.innerHeight,
    expectedCursorCss: 0,
    nextSegment: 1,
    outputPath,
    bitmapWidthPx: bmp.width,
    scaleY,
    totalHeightPx,
  };
  resetWatchdog('beginPage');
  const reply = await sendToWorker({
    type: 'begin', jobId: active.jobId, page: request.page, outputPath,
    pageHeightCss: g.totalHeight, viewportWidthCss: g.innerWidth, viewportHeightCss: g.innerHeight,
    bitmapWidthPx: bmp.width, totalHeightPx,
  });
  if (reply.type !== 'begun') {
    return { ok: false, code: reply.type === 'error' ? reply.code : 'worker', message: reply.type === 'error' ? reply.message : 'worker 未 begun' };
  }
  return { ok: true, page: request.page, pageHeightCss: g.totalHeight, viewportWidthCss: g.innerWidth, viewportHeightCss: g.innerHeight };
}

// —— PNG capture：主进程捕获 + toPNG + 几何 + 送 worker（不回 PNG bytes）——
async function pngCaptureSelfImpl(request: PngCaptureSelfRequest): Promise<PngCaptureSelfResponse> {
  if (!active) return { ok: false, code: 'no-job', message: '没有进行中的导出任务' };
  const pg = active.currentPngPage;
  if (!pg) return { ok: false, code: 'no-page', message: '当前无 PNG 页（未 beginPage）' };
  const guard = validatePngCaptureRequest(request, pg);
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message };
  const win = active.exportWindow;
  if (win.isDestroyed()) return { ok: false, code: 'window-gone', message: '导出窗口已销毁' };

  // 读真实 scrollY（renderer scrollTo 后的实际位置，可能被 clamp）。
  const g = await readExportDomGeometry(win);
  if ('error' in g) return { ok: false, code: 'geometry', message: g.error };
  const actualScrollY = g.scrollY;

  const [cw, ch] = win.getContentSize();
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: cw, height: ch }, { stayHidden: true, stayAwake: true });
  if (!img || img.isEmpty()) return { ok: false, code: 'empty-capture', message: 'capturePage 返回空图' };
  const bmp = img.getSize();
  if (bmp.width !== pg.bitmapWidthPx) {
    return { ok: false, code: 'width-changed', message: `段宽 ${bmp.width} != 冻结 ${pg.bitmapWidthPx}` };
  }
  const pngBuf = img.toPNG();
  if (pngBuf.length > SEGMENT_PNG_MAX_BYTES) {
    return { ok: false, code: 'segment-too-large', message: `单段 PNG ${pngBuf.length} 超上限` };
  }
  const geomRes = buildSegmentCopyGeometry({
    cursorCss: request.cursorCss,
    actualScrollYCss: actualScrollY,
    viewportWidthCss: pg.viewportWidthCss,
    viewportHeightCss: pg.viewportHeightCss,
    totalHeightCss: pg.pageHeightCss,
    bitmapWidthPx: bmp.width,
    bitmapHeightPx: bmp.height,
  });
  if (!geomRes.ok) return { ok: false, code: 'placement', message: geomRes.reason };

  // byteOffset-safe transfer：拷成独立 ArrayBuffer 再转移。
  const ab = pngBuf.buffer.slice(pngBuf.byteOffset, pngBuf.byteOffset + pngBuf.length);
  const reply = await sendToWorker({
    type: 'segment', jobId: active.jobId, page: pg.page, segment: request.segment, png: ab, geometry: geomRes.geometry,
  });
  if (reply.type !== 'segment-accepted') {
    return { ok: false, code: reply.type === 'error' ? reply.code : 'worker', message: reply.type === 'error' ? reply.message : 'worker 未 ack' };
  }
  // 推进 cursor/段号：下一段期望 cursor = 本段 destEndPx 回 CSS。
  pg.expectedCursorCss = geomRes.geometry.destEndPx / pg.scaleY;
  pg.nextSegment += 1;
  return {
    ok: true,
    segment: request.segment,
    nextCursorCss: pg.expectedCursorCss,
    actualScrollYCss: actualScrollY,
    bitmapWidthPx: bmp.width,
    bitmapHeightPx: bmp.height,
  };
}

// —— PNG finish page：送 worker finish + 校验落盘 ——
async function pngFinishPageImpl(request: ExportPageFinishRequest): Promise<ExportPageFinishResponse> {
  if (!active) return { ok: false, code: 'no-job', message: '没有进行中的导出任务' };
  const pg = active.currentPngPage;
  if (!pg) return { ok: false, code: 'no-page', message: '当前无 PNG 页' };
  const guard = validatePngFinishRequest(request, pg);
  if (!guard.ok) return { ok: false, code: guard.code, message: guard.message };
  resetWatchdog('finishPage-pre');
  const reply = await sendToWorker({ type: 'finish', jobId: active.jobId, page: pg.page });
  if (reply.type !== 'page-saved') {
    return { ok: false, code: reply.type === 'error' ? reply.code : 'worker', message: reply.type === 'error' ? reply.message : 'worker 未 page-saved' };
  }
  // 校验文件存在 + 非空 + 扩展名。
  try {
    const st = statSync(pg.outputPath);
    if (!st.isFile() || st.size === 0) return { ok: false, code: 'bad-output', message: '输出文件空或非文件' };
  } catch (e) {
    return { ok: false, code: 'output-missing', message: String((e as Error)?.message || e) };
  }
  resetWatchdog('finishPage-post');
  // 记入 pageFiles 以便 finish 时统一保存（复用 JPEG 的 performSave 路径）。
  active.pageFiles.set(pg.page, { path: pg.outputPath, fd: -1, writtenBytes: reply.bytes, expectedTotal: reply.bytes, lastSequence: 0 });
  active.currentPngPage = null;
  return { ok: true, page: pg.page, widthPx: reply.widthPx, heightPx: reply.heightPx, bytes: reply.bytes };
}

// —— 启动残留清理：删除 > 24h 的 claude-link-export-* 目录 ——
export async function cleanupStaleTempDirs(): Promise<void> {
  const tmp = app.getPath('temp');
  let entries: string[] = [];
  try {
    entries = await readdir(tmp);
  } catch {
    return;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((n) => n.startsWith(TEMP_PREFIX))
      .map(async (n) => {
        const dir = join(tmp, n);
        try {
          const st = await stat(dir);
          if (!st.isDirectory()) return;
          if (now - st.mtimeMs > STALE_DIR_TTL_MS) {
            await rm(dir, { recursive: true, force: true });
            logger.info(`[export] 清理残留临时目录 ${n}`);
          }
        } catch {
          // 忽略单个目录失败。
        }
      }),
  );
}

// —— 单段捕获：主进程对绑定的 export WebContents 调用 capturePage ——
async function captureSelfImpl(request: CaptureSelfRequest): Promise<CaptureSelfResponse> {
  if (!active) return { ok: false, code: 'no-job', message: '没有进行中的导出任务' };
  if (active.terminal || active.phase === 'done' || active.phase === 'error' || active.phase === 'cancelled') {
    return { ok: false, code: 'wrong-phase', message: `任务已结束（${active.phase}）` };
  }
  // 阶段由实际操作驱动（避免与 fire-and-forget 进度消息竞争）：捕获即进入 capturing。
  if (active.phase !== 'capturing') active.phase = 'capturing';
  const win = active.exportWindow;
  if (win.isDestroyed()) return { ok: false, code: 'window-gone', message: '导出窗口已销毁' };
  const [w, h] = win.getContentSize();
  if (w <= 0 || h <= 0) return { ok: false, code: 'bad-viewport', message: `视口尺寸非法 ${w}x${h}` };
  const rect = { x: 0, y: 0, width: w, height: h };
  const img = await win.webContents.capturePage(rect, { stayHidden: true, stayAwake: true });
  if (!img || img.isEmpty()) {
    return { ok: false, code: 'empty-capture', message: 'capturePage 返回空图' };
  }
  const bitmap = img.getSize();
  const png = img.toPNG(); // 同步，主进程短暂占用
  if (png.length > SEGMENT_PNG_MAX_BYTES) {
    return { ok: false, code: 'segment-too-large', message: `单段 PNG ${png.length} 超过上限` };
  }
  void request; // page/segment 仅用于 renderer 侧进度，主进程不依赖
  return { ok: true, png: png as unknown as Uint8Array, bitmapWidth: bitmap.width, bitmapHeight: bitmap.height };
}

// —— 分块写入：顺序、严格 offset/sequence 校验 ——
async function writePageChunkImpl(payload: PageChunkPayload): Promise<void> {
  if (!active) throw new Error('没有进行中的导出任务');
  if (active.terminal || active.phase === 'done' || active.phase === 'error' || active.phase === 'cancelled') {
    throw new Error(`任务已结束（${active.phase}）`);
  }
  // 阶段由实际操作驱动：写分块即进入 encoding。
  if (active.phase !== 'encoding') active.phase = 'encoding';
  const page = payload.page;
  if (!Number.isInteger(page) || page < 1) throw new Error('非法页码');
  const bytes = payload.bytes;
  if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw new Error('分块非二进制或为空');
  if (bytes.length > 2 * 1024 * 1024 + 1024) throw new Error('分块超过 2 MiB');

  let pf = active.pageFiles.get(page);
  if (!pf) {
    const path = join(active.tempDir, `page-${String(page).padStart(4, '0')}.jpg`);
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC, 0o600);
    pf = { path, fd, writtenBytes: 0, expectedTotal: null, lastSequence: -1 };
    active.pageFiles.set(page, pf);
  }
  // 严格 sequence 递增、offset 连续。
  if (payload.sequence !== pf.lastSequence + 1) {
    throw new Error(`分块序号不连续：期望 ${pf.lastSequence + 1}，收到 ${payload.sequence}`);
  }
  if (payload.offset !== pf.writtenBytes) {
    throw new Error(`分块 offset 不连续：期望 ${pf.writtenBytes}，收到 ${payload.offset}`);
  }
  if (pf.expectedTotal === null) pf.expectedTotal = payload.totalBytes;
  else if (pf.expectedTotal !== payload.totalBytes) {
    throw new Error(`totalBytes 变化：${pf.expectedTotal} → ${payload.totalBytes}`);
  }
  await writeBytes(pf.fd, bytes, pf.writtenBytes);
  pf.writtenBytes += bytes.length;
  pf.lastSequence = payload.sequence;
  if (pf.writtenBytes > JPEG_PAGE_MAX_BYTES) {
    throw new Error(`单页 JPEG 超过 ${JPEG_PAGE_MAX_BYTES} 字节`);
  }
}

// 把 Uint8Array 写到 fd 指定偏移（用 writeSync 的 position 重载，保证顺序与排他；2MiB 同步写可接受）。
async function writeBytes(fd: number, bytes: Uint8Array, offset: number): Promise<void> {
  let written = 0;
  while (written < bytes.length) {
    const n = writeSync(fd, bytes, written, bytes.length - written, offset + written);
    if (n <= 0) throw new Error('写入 0 字节');
    written += n;
  }
}

// —— finish：终态 ——
async function handleFinishImpl(payload: ExportRenderFinishPayload): Promise<void> {
  if (!active) return;
  if (active.terminal) return; // 终态后迟到调用拒绝
  if (payload.jobId !== active.jobId) return; // 迟到
  clearTimeout(active.finishTimer);

  if (payload.kind === 'done') {
    // 关闭所有页文件句柄，校验写入完整性。
    const pages: { page: number; path: string; bytes: number }[] = [];
    for (const [page, pf] of active.pageFiles) {
      if (pf.fd >= 0) { try { closeSync(pf.fd); } catch { /* ignore */ } }
      if (pf.expectedTotal !== null && pf.writtenBytes !== pf.expectedTotal) {
        await failJob(`第 ${page} 页字节数不匹配：写入 ${pf.writtenBytes} / 期望 ${pf.expectedTotal}`);
        return;
      }
      pages.push({ page, path: pf.path, bytes: pf.writtenBytes });
    }
    active.pageFiles.clear();
    pages.sort((a, b) => a.page - b.page);

    // 阶段四：保存对话框 + 排他移动 + 冲突处理。result 为判别联合（saved/cancelled/failed）。
    active.phase = 'waitingForDestination';
    makeProgress({ phase: 'waitingForDestination', page: pages.length, totalPages: pages.length, segment: 0, segmentsInPage: 0, message: '请选择保存位置…' });
    const result = await performSave(active, pages);
    if (result.status === 'saved') {
      active.phase = 'done';
      makeProgress({ phase: 'done', page: pages.length, totalPages: pages.length, segment: 0, segmentsInPage: 0, percent: 100, message: `导出完成（${result.paths.length} 张）` });
    } else if (result.status === 'cancelled') {
      active.phase = 'cancelled';
      makeProgress({ phase: 'cancelled', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: '已取消保存' });
    } else {
      active.phase = 'error';
      makeProgress({ phase: 'error', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: result.message });
    }
    logger.info(`[export] job ${active.jobId} 终态：${result.status}`);
    const resolve = active.doneResolve;
    await cleanup('finished');
    if (resolve) resolve(result);
  } else {
    await failJob(`导出失败：${payload.code} — ${payload.message}`);
  }
}

// —— 保存：单张另存为 / 多张目录选择；排他移动（不覆盖）；smoke 用 CLAUDE_LINK_EXPORT_SMOKE_DEST 绕过对话框 ——
async function performSave(job: ActiveJob, pages: { page: number; path: string; bytes: number }[]): Promise<ExportImageResult> {
  const { sessionName, exportedAt, format } = job.snapshot;
  const smokeDest = process.env.CLAUDE_LINK_EXPORT_SMOKE_DEST;
  const originWin = BrowserWindow.fromWebContents(job.origin) ?? undefined;
  const extRe = format === 'png' ? /\.(png)$/i : /\.(jpe?g)$/i;
  const filterName = format === 'png' ? 'PNG' : 'JPEG';
  const filterExts = format === 'png' ? ['png'] : ['jpg', 'jpeg'];
  const defaultExt = format === 'png' ? 'png' : 'jpg';

  // 多张：目录选择；单张：另存为。
  const multi = pages.length > 1;
  let targetDir = '';
  let singleTarget: string | null = null;

  if (smokeDest) {
    targetDir = smokeDest;
  } else if (multi) {
    const r = await dialog.showOpenDialog(originWin, {
      title: '选择导出图片保存目录',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths.length) return { status: 'cancelled' };
    targetDir = r.filePaths[0];
  } else {
    const r = await dialog.showSaveDialog(originWin, {
      title: '保存导出图片',
      defaultPath: buildExportFilename(sessionName, exportedAt, undefined, undefined, format),
      filters: [{ name: filterName, extensions: filterExts }],
    });
    if (r.canceled || !r.filePath) return { status: 'cancelled' };
    singleTarget = r.filePath;
  }

  job.phase = 'saving';
  makeProgress({ phase: 'saving', page: pages.length, totalPages: pages.length, segment: 0, segmentsInPage: 0, message: `正在保存 ${pages.length} 张图片…` });

  try {
    if (!multi) {
      let target = smokeDest ? join(targetDir, buildExportFilename(sessionName, exportedAt, undefined, undefined, format)) : singleTarget!;
      if (!extRe.test(target)) target += '.' + defaultExt;
      await moveExclusive(pages[0].path, target);
      return { status: 'saved', paths: [target] };
    }
    const saved: string[] = [];
    for (let i = 0; i < pages.length; i++) {
      const fn = buildExportFilename(sessionName, exportedAt, i + 1, pages.length, format);
      const target = join(targetDir, fn);
      try {
        await moveExclusive(pages[i].path, target);
        saved.push(target);
      } catch (e) {
        // 部分写入失败：报告已成功与未写入，不宣称全部完成。
        return { status: 'failed', code: 'conflict', message: `保存失败：${target}（${String((e as Error)?.message || e)}）；已保存 ${saved.length}/${pages.length} 张` };
      }
    }
    return { status: 'saved', paths: saved };
  } catch (e) {
    return { status: 'failed', code: 'write', message: String((e as Error)?.message || e) };
  }
}

/** 排他移动：copyFileSync(COPYFILE_EXCL) 目标已存在则失败（不覆盖，无 TOCTOU），跨卷安全；成功后删源。 */
async function moveExclusive(src: string, dest: string): Promise<void> {
  if (existsSync(dest)) {
    throw new Error(`目标已存在：${dest}`);
  }
  copyFileSync(src, dest, fsConstants.COPYFILE_EXCL);
  try { unlinkSync(src); } catch { /* 源删除失败不影响结果 */ }
}

async function failJob(message: string): Promise<void> {
  if (!active) return;
  if (active.terminal) return;
  active.terminal = true;
  active.phase = 'error';
  clearTimeout(active.finishTimer);
  makeProgress({ phase: 'error', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, percent: 0, message });
  logger.error(`[export] job ${active.jobId} 失败：${message}`);
  if (active.doneReject) active.doneReject(new Error(message));
  await cleanup('failed');
}

// —— 统一 cleanup ——
async function cleanup(_reason: string): Promise<void> {
  if (!active) return;
  const job = active;
  active = null;
  // 终止 codec worker（PNG 路径）。
  if (job.codecWorker) {
    const w = job.codecWorker;
    job.codecWorker = null;
    pendingWorkerReply = null;
    try { w.postMessage({ type: 'abort', jobId: job.jobId, page: job.currentPngPage?.page ?? 0, reason: 'cleanup' } satisfies CodecMessage); } catch { /* ignore */ }
    try { void w.terminate(); } catch { /* ignore */ }
  }
  // 关闭页文件句柄（JPEG 真实 fd；PNG 页 fd=-1 跳过）。
  for (const pf of job.pageFiles.values()) {
    if (pf.fd >= 0) { try { closeSync(pf.fd); } catch { /* ignore */ } }
  }
  job.pageFiles.clear();
  // 销毁隐藏窗口。
  try {
    if (!job.exportWindow.isDestroyed()) job.exportWindow.destroy();
  } catch { /* ignore */ }
  // 删除临时目录（阶段二 smoke 在 resolve 后由外部触发 cleanup；此处兜底）。
  try {
    await rm(job.tempDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  clearTimeout(job.finishTimer);
}

/** 供 smoke / 阶段四显式清理当前 job（保留临时文件可先检查再清理）。 */
export async function cleanupActiveJob(): Promise<void> {
  await cleanup('explicit');
}

// —— 启动导出 ——
export interface StartExportOptions {
  /** smoke 模式：跳过发送态检查，完成时 resolve donePromise（阶段二自动验证用）。 */
  smoke?: boolean;
}

export type StartExportResult =
  | { ok: true; jobId: string; done: Promise<ExportImageResult> }
  | { ok: false; code: string; message: string };

export async function startImageExport(
  origin: WebContents,
  sessionId: string,
  format: ExportImageFormat = 'jpeg',
  options: StartExportOptions = {},
): Promise<StartExportResult> {
  if (isActive()) {
    return { ok: false, code: 'busy', message: '已有导出任务正在运行' };
  }
  // 校验 origin。
  if (origin.isDestroyed()) {
    return { ok: false, code: 'bad-origin', message: '发起窗口已销毁' };
  }

  // 读取会话 + 消息 + 配置快照。
  const sessionRow = sessionRepo.getSession(sessionId);
  if (!sessionRow) {
    return { ok: false, code: 'no-session', message: '会话不存在或已删除' };
  }
  const allMessages = messageRepo.getRenderableMessagesBySession(sessionId);
  // 主流程：parentAgentId === null。子 Agent 详情不进主聊天长图。
  const messages: RenderableMessage[] = allMessages.filter((m) => m.parentAgentId === null);
  if (messages.length === 0) {
    return { ok: false, code: 'empty', message: '当前会话没有可导出的消息' };
  }

  // 快照预算校验。
  const utf8Bytes = messages.map((m) => Buffer.byteLength(m.content ?? '', 'utf8'));
  const imageCount = messages.reduce((s, m) => s + (m.content?.match(/!\[[^\]]*\]\([^)]+\)/g)?.length ?? 0), 0);
  const snapshotBudget = checkSnapshotBudget({ messageCount: messages.length, messageUtf8Bytes: utf8Bytes, imageCount });
  if (!snapshotBudget.ok) {
    return { ok: false, code: 'snapshot-budget', message: snapshotBudget.reason ?? '快照超预算' };
  }

  const config = getConfig();
  const themePaletteId = config.themePaletteId;
  const themePalette = THEME_PALETTES.find((p) => p.id === themePaletteId) ?? THEME_PALETTES[0];
  const fontScale = config.fontScale;

  const jobId = randomUUID();
  const tempDir = await mkdtemp(join(app.getPath('temp'), TEMP_PREFIX));
  const now = new Date();
  const exportedAt = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;

  const snapshot: ExportJobSnapshot = {
    jobId,
    sessionId,
    sessionName: sessionRow.name,
    sessionCreatedAt: sessionRow.createdAt,
    exportedAt,
    themePaletteId,
    themePalette,
    fontScale,
    // v4.1：格式由主进程在 start 时冻结，全链路不可被 renderer 改写。
    format,
    messages,
  };

  // 创建隐藏 export 窗口。
  const exportSession = session.fromPartition(`claude-link-export-${jobId}`, { cache: false });
  const exportWindow = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 896,
    height: 1000,
    frame: false,
    resizable: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      paintWhenInitiallyHidden: true,
      additionalArguments: ['--claude-link-surface=export'],
      session: exportSession,
    },
  });
  // 禁止 window.open / 外部导航 / 下载 / 权限请求。
  exportWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  exportSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  exportWindow.webContents.on('render-process-gone', (_e, details) => {
    logger.error(`[export] 渲染进程消失：${details.reason}`);
    void failJob(`导出渲染进程崩溃：${details.reason}`);
  });
  exportWindow.webContents.on('console-message', (_e, _level, message) => {
    logger.info(`[export-renderer] ${message}`);
  });
  exportWindow.webContents.on('did-finish-loading', () => {
    logger.info(`[export] 隐藏窗口 did-finish-loading`);
  });
  exportWindow.webContents.on('did-fail-load', (_e, code, desc) => {
    logger.error(`[export] 隐藏窗口 did-fail-load ${code} ${desc}`);
  });
  exportWindow.webContents.on('preload-error', (_e, p, err) => {
    logger.error(`[export] preload-error ${p}: ${String(err && (err as Error).message || err)}`);
  });

  active = {
    jobId,
    origin,
    exportWindow,
    tempDir,
    phase: 'preparing',
    snapshot,
    format: snapshot.format,
    pageFiles: new Map(),
    codecWorker: null,
    currentPngPage: null,
    terminal: false,
    absoluteDeadlineMs: Date.now() + WATCHDOG_ABSOLUTE_MS,
    finishTimer: setTimeout(() => { void failJob(`导出超时（${WATCHDOG_RESET_MS / 1000} 秒无进展）`); }, WATCHDOG_RESET_MS),
  };

  // 完成 promise：resolve 终态结果（saved/cancelled/failed）。
  const done = new Promise<ExportImageResult>((res, rej) => {
    active!.doneResolve = res;
    active!.doneReject = rej;
  });

  // origin 关闭 → 终止 job。
  origin.once('destroyed', () => { void failJob('发起窗口已关闭'); });

  // 加载 export 页。
  const loadErr = await loadExportPage(exportWindow);
  if (loadErr) {
    await failJob(`导出窗口加载失败：${loadErr}`);
    return { ok: false, code: 'load-failed', message: loadErr };
  }
  // 固定版心视口：896 × 1000（阶段四按 workArea 段高公式调整）。
  exportWindow.setContentSize(896, 1000);

  makeProgress({ phase: 'preparing', page: 0, totalPages: 0, segment: 0, segmentsInPage: 0, message: '正在准备会话…' });

  return { ok: true, jobId, done };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

async function loadExportPage(win: BrowserWindow): Promise<string | null> {
  const devUrl = process.env['ELECTRON_RENDERER_URL'];
  try {
    if (devUrl) {
      await win.loadURL(`${devUrl}/export.html`);
    } else {
      await win.loadFile(join(__dirname, '../renderer/export.html'));
    }
    return null;
  } catch (e) {
    return String((e as Error)?.message || e);
  }
}

// —— IPC handler 注册（由 ipc-handlers 调用） ——
export function registerExportImageHandlers(): void {
  // EXPORT_IMAGE_START：来自可见 renderer 顶层 frame。format 白名单仅 jpeg|png。
  ipcMain.handle(IPC_CHANNELS.EXPORT_IMAGE_START, async (event, sessionId: string, format: unknown) => {
    if (!event.senderFrame || event.senderFrame.parent !== null) {
      return { ok: false, code: 'bad-frame', message: '非法 frame' };
    }
    if (format !== 'jpeg' && format !== 'png') {
      return { ok: false, code: 'bad-format', message: `非法导出格式：${String(format)}（仅 jpeg|png）` };
    }
    // 注意：smoke 模式由主进程内部直接调用 startImageExport（带 smoke:true），不经此 handler。
    const r = await startImageExport(event.sender, sessionId, format);
    if (!r.ok) return r;
    return { ok: true, jobId: r.jobId };
  });

  // EXPORT_RENDER_GET_JOB：仅当前 job 的 export 窗口可取。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_GET_JOB, async (event) => {
    if (!isExportSender(event.sender)) return null;
    logger.info(`[export] getJob 命中，消息数 ${active?.snapshot.messages.length ?? -1}`);
    return active?.snapshot ?? null;
  });

  // EXPORT_RENDER_CAPTURE_SELF：单飞，仅 capturing 阶段。JPEG 走 v3 captureSelfImpl；PNG 走 pngCaptureSelfImpl。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_CAPTURE_SELF, async (event, request: CaptureSelfRequest | PngCaptureSelfRequest) => {
    if (!isExportSender(event.sender)) {
      return { ok: false, code: 'bad-sender', message: '非法 sender' } satisfies CaptureSelfResponse | PngCaptureSelfResponse;
    }
    if (!request || typeof request.jobId !== 'string' || !Number.isInteger(request.page) || !Number.isInteger(request.segment)) {
      return { ok: false, code: 'bad-request', message: '非法请求参数' } satisfies CaptureSelfResponse | PngCaptureSelfResponse;
    }
    if (active?.format === 'png') {
      return await pngCaptureSelfImpl(request as PngCaptureSelfRequest);
    }
    return await captureSelfImpl(request as CaptureSelfRequest);
  });

  // v4.1 PNG 页协议（仅 PNG 模式生效，handler 内校验 format）。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_PROBE_SELF, async (event, request: PngProbeSelfRequest) => {
    if (!isExportSender(event.sender)) return { ok: false, code: 'bad-sender', message: '非法 sender' } satisfies PngProbeSelfResponse;
    if (!request || typeof request.jobId !== 'string') return { ok: false, code: 'bad-request', message: '非法请求参数' } satisfies PngProbeSelfResponse;
    return await pngProbeSelfImpl(request);
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_BEGIN_PAGE, async (event, request: ExportPageBeginRequest) => {
    if (!isExportSender(event.sender)) return { ok: false, code: 'bad-sender', message: '非法 sender' } satisfies ExportPageBeginResponse;
    if (!request || typeof request.jobId !== 'string' || !Number.isInteger(request.page)) return { ok: false, code: 'bad-request', message: '非法请求参数' } satisfies ExportPageBeginResponse;
    if (active && active.jobId !== request.jobId) return { ok: false, code: 'stale', message: '迟到 job' } satisfies ExportPageBeginResponse;
    return await pngBeginPageImpl(request);
  });

  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_FINISH_PAGE, async (event, request: ExportPageFinishRequest) => {
    if (!isExportSender(event.sender)) return { ok: false, code: 'bad-sender', message: '非法 sender' } satisfies ExportPageFinishResponse;
    if (!request || typeof request.jobId !== 'string' || !Number.isInteger(request.page)) return { ok: false, code: 'bad-request', message: '非法请求参数' } satisfies ExportPageFinishResponse;
    if (active && active.jobId !== request.jobId) return { ok: false, code: 'stale', message: '迟到 job' } satisfies ExportPageFinishResponse;
    return await pngFinishPageImpl(request);
  });

  // EXPORT_RENDER_WRITE_PAGE_CHUNK：顺序写临时文件。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_WRITE_PAGE_CHUNK, async (event, payload: PageChunkPayload) => {
    if (!isExportSender(event.sender)) throw new Error('非法 sender');
    if (!payload || typeof payload.jobId !== 'string') throw new Error('非法 payload');
    if (payload.bytes && typeof (payload.bytes as unknown) !== 'object') throw new Error('bytes 非二进制');
    await writePageChunkImpl(payload);
  });

  // EXPORT_RENDER_PROGRESS：renderer → 主进程，转发给 origin。
  ipcMain.on(IPC_CHANNELS.EXPORT_RENDER_PROGRESS, (event, payload: ExportImageProgressPayload) => {
    if (!isExportSender(event.sender)) return;
    if (!payload || payload.jobId !== active?.jobId) return; // 迟到过滤
    active.phase = payload.phase;
    makeProgress({ phase: payload.phase, page: payload.page, totalPages: payload.totalPages, segment: payload.segment, segmentsInPage: payload.segmentsInPage, percent: payload.percent, message: payload.message });
  });

  // EXPORT_RENDER_FINISH：判别联合，终态一次。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RENDER_FINISH, async (event, payload: ExportRenderFinishPayload) => {
    if (!isExportSender(event.sender)) return;
    if (!payload || payload.jobId !== active?.jobId) return;
    await handleFinishImpl(payload);
  });
}

/** app 退出时终止仍在运行的 job（main/index.ts before-quit 调用）。 */
export async function disposeExportImageOnQuit(): Promise<void> {
  if (active) {
    active.terminal = true;
    await cleanup('quit');
  }
}
