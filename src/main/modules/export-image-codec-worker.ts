// v4.1 PNG codec worker（worker_threads 入口）。
// 职责：接收主进程生成的段 PNG ArrayBuffer + 已校验几何，逐段 PNG.sync.read → 按行 copy 进整页 RGBA → 丢弃；
// finish 时 PNG.sync.write 编码，原子写（.tmp→rename）主进程生成的当前页路径。
// 设计：流式 decode-discard（不保留 NativeImage[]/完整段数组/decoded parts 到页尾），峰值 ≈ 整页 RGBA + 单段解码。
// 依据：docs/superpowers/plans/2026-07-21-export-image-v41-png-worker.md §4 Task 7；
//       阶段零冻结：同步编码阻塞 >>250ms（必须 worker），峰值因子 5.5。
//
// 导出的 codec* 纯状态机函数供 scripts/export-image-codec-verify.ts 直接驱动（不经 worker_threads）。
// 底部 parentPort 接线仅在作为 worker 加载时生效，import 不会触发。

import { parentPort } from 'worker_threads';
import { closeSync, openSync, renameSync, unlinkSync, writeSync, existsSync } from 'fs';
import { PNG } from 'pngjs';
import { copySegmentRows } from '../../shared/export-image';
import type { CodecMessage, CodecWorkerMessage, SegmentCopyGeometry } from '../../shared/types/export-image';

// 整页状态。full 直接复用 PNG.data（零额外分配）。
export interface CodecPageState {
  jobId: string;
  page: number;
  outputPath: string;
  bitmapWidthPx: number;
  totalHeightPx: number;
  png: PNG | null;            // 持有 .data = 整页 RGBA
  full: Buffer;               // = png.data 的引用别名（便于 copySegmentRows）
  segBitmapHeightPx: number;  // 首段冻结的段位图高，后续段须在容差内
  nextSegment: number;        // 下一个期望 segment 号（1-based）
  nextDestEndPx: number;      // 期望的下一段 destStartPx（= 上段 destEndPx，连续性）
  segmentCount: number;
  finished: boolean;
}

const SCALE_TOLERANCE_PX = 1; // 段间位图高容差（物理像素）

function isFinitePositive(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

function err(jobId: string, page: number, code: string, message: string): CodecWorkerMessage {
  return { type: 'error', jobId, page, code, message };
}

/** begin：校验 + 预分配整页 RGBA。返回 CodecWorkerMessage（begun/error）。 */
export function codecBegin(msg: Extract<CodecMessage, { type: 'begin' }>): { reply: CodecWorkerMessage; state: CodecPageState | null } {
  if (!msg.jobId || !Number.isInteger(msg.page) || msg.page < 1) {
    return { reply: err(msg.jobId, msg.page, 'bad-begin', '非法 jobId/page'), state: null };
  }
  if (!isFinitePositive(msg.bitmapWidthPx) || !isFinitePositive(msg.totalHeightPx)) {
    return { reply: err(msg.jobId, msg.page, 'bad-begin-dims', 'bitmapWidthPx/totalHeightPx 非正或非有限'), state: null };
  }
  if (!msg.outputPath || !msg.outputPath.endsWith('.png')) {
    return { reply: err(msg.jobId, msg.page, 'bad-output-path', 'outputPath 必须是主进程生成的 .png 路径'), state: null };
  }
  const png = new PNG({ width: msg.bitmapWidthPx, height: msg.totalHeightPx });
  const state: CodecPageState = {
    jobId: msg.jobId,
    page: msg.page,
    outputPath: msg.outputPath,
    bitmapWidthPx: msg.bitmapWidthPx,
    totalHeightPx: msg.totalHeightPx,
    png,
    full: png.data,
    segBitmapHeightPx: 0,
    nextSegment: 1,
    nextDestEndPx: 0,
    segmentCount: 0,
    finished: false,
  };
  return { reply: { type: 'begun', jobId: msg.jobId, page: msg.page, bitmapWidthPx: msg.bitmapWidthPx, totalHeightPx: msg.totalHeightPx }, state };
}

/** segment：解码 + 校验 + 按行 copy + 丢弃。返回 CodecWorkerMessage（segment-accepted/error）。 */
export function codecSegment(state: CodecPageState | null, msg: Extract<CodecMessage, { type: 'segment' }>): CodecWorkerMessage {
  if (!state || state.finished) return err(msg.jobId, msg.page, 'no-page', '无活动页或已 finish');
  if (msg.jobId !== state.jobId || msg.page !== state.page) return err(msg.jobId, msg.page, 'job-page-mismatch', 'jobId/page 不匹配');
  if (msg.segment !== state.nextSegment) return err(msg.jobId, msg.page, 'segment-out-of-order', `期望 ${state.nextSegment}，收到 ${msg.segment}`);
  const ab = msg.png;
  if (!(ab instanceof ArrayBuffer) || ab.byteLength === 0) return err(msg.jobId, msg.page, 'empty-png', '空 PNG ArrayBuffer');

  let decoded: PNG;
  try {
    decoded = PNG.sync.read(Buffer.from(ab));
  } catch (e) {
    return err(msg.jobId, msg.page, 'png-decode-failed', String((e as Error)?.message || e));
  }
  if (decoded.width !== state.bitmapWidthPx) {
    return err(msg.jobId, msg.page, 'width-changed', `段宽 ${decoded.width} != 冻结 ${state.bitmapWidthPx}`);
  }
  if (state.segBitmapHeightPx === 0) {
    state.segBitmapHeightPx = decoded.height;
  } else if (Math.abs(decoded.height - state.segBitmapHeightPx) > SCALE_TOLERANCE_PX) {
    return err(msg.jobId, msg.page, 'scale-changed', `段位图高 ${decoded.height} 偏离首段 ${state.segBitmapHeightPx} 超容差`);
  }

  const g: SegmentCopyGeometry = msg.geometry;
  // 几何自洽 + 不越界（主进程已校验，worker 复核防篡改/漂移）。
  if (![g.sourceStartPx, g.sourceEndPx, g.destStartPx, g.destEndPx, g.drawHeightPx].every(Number.isFinite)) {
    return err(msg.jobId, msg.page, 'bad-geometry', '几何含非有限值');
  }
  if (g.drawHeightPx <= 0) return err(msg.jobId, msg.page, 'bad-geometry', 'drawHeightPx 非正');
  if (g.destStartPx !== state.nextDestEndPx) {
    return err(msg.jobId, msg.page, 'dest-discontiguous', `期望 destStartPx=${state.nextDestEndPx}，收到 ${g.destStartPx}`);
  }
  if (g.sourceStartPx + g.drawHeightPx > decoded.height) {
    return err(msg.jobId, msg.page, 'source-overflow', `source ${g.sourceStartPx}+${g.drawHeightPx} > bitmap ${decoded.height}`);
  }
  if (g.destEndPx > state.totalHeightPx) {
    return err(msg.jobId, msg.page, 'dest-overflow', `destEndPx ${g.destEndPx} > totalHeightPx ${state.totalHeightPx}`);
  }
  if (g.bitmapWidthPx !== state.bitmapWidthPx) {
    return err(msg.jobId, msg.page, 'geometry-width-mismatch', '几何 bitmapWidthPx 与冻结不一致');
  }

  copySegmentRows(state.full, decoded.data, g);
  // 立即丢弃段解码副本（峰值约束：不保留到页尾）。
  decoded.data.fill(0);

  state.nextSegment += 1;
  state.nextDestEndPx = g.destEndPx;
  state.segmentCount += 1;
  return { type: 'segment-accepted', jobId: msg.jobId, page: msg.page, segment: msg.segment, nextDestEndPx: state.nextDestEndPx };
}

/** finish：校验至少一段 + 编码 + 原子写。返回 CodecWorkerMessage（page-saved/error）。 */
export function codecFinish(state: CodecPageState | null, msg: Extract<CodecMessage, { type: 'finish' }>): CodecWorkerMessage {
  if (!state) return err(msg.jobId, msg.page, 'no-page', '无活动页');
  if (state.finished) return err(msg.jobId, msg.page, 'duplicate-finish', '重复 finish');
  if (msg.jobId !== state.jobId || msg.page !== state.page) return err(msg.jobId, msg.page, 'job-page-mismatch', 'jobId/page 不匹配');
  if (state.segmentCount === 0) return err(msg.jobId, msg.page, 'finish-before-segment', 'finish 前无成功段');
  if (!state.png) return err(msg.jobId, msg.page, 'no-png', 'PNG 对象缺失');

  let encoded: Buffer;
  try {
    encoded = PNG.sync.write(state.png);
  } catch (e) {
    return err(msg.jobId, msg.page, 'png-encode-failed', String((e as Error)?.message || e));
  }

  // 原子写：.tmp → rename。用 wx 排他创建，失败删 .tmp。
  const tmp = state.outputPath + '.tmp';
  if (existsSync(tmp)) {
    return err(msg.jobId, msg.page, 'tmp-exists', `临时文件已存在：${tmp}`);
  }
  let fd: number | null = null;
  try {
    fd = openSync(tmp, 'wx');
    let written = 0;
    while (written < encoded.length) {
      const n = writeSync(fd, encoded, written, encoded.length - written);
      if (n <= 0) throw new Error('写入 0 字节');
      written += n;
    }
    closeSync(fd);
    fd = null;
    renameSync(tmp, state.outputPath);
  } catch (e) {
    if (fd !== null) { try { closeSync(fd); } catch { /* ignore */ } }
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* ignore */ }
    return err(msg.jobId, msg.page, 'write-failed', String((e as Error)?.message || e));
  }

  state.finished = true;
  return { type: 'page-saved', jobId: msg.jobId, page: msg.page, widthPx: state.bitmapWidthPx, heightPx: state.totalHeightPx, bytes: encoded.length };
}

/** abort：释放状态。调用方负责 terminate worker。 */
export function codecAbort(state: CodecPageState | null): void {
  if (state && state.png) {
    state.png.data.fill(0);
    state.png = null;
  }
}

// —— worker 入口接线（仅在作为 worker 加载、parentPort 存在时生效）——
let workerState: CodecPageState | null = null;

if (parentPort) {
  parentPort.on('message', (msg: CodecMessage) => {
    try {
      if (msg.type === 'begin') {
        const { reply, state } = codecBegin(msg);
        workerState = state;
        parentPort!.postMessage(reply);
      } else if (msg.type === 'segment') {
        parentPort!.postMessage(codecSegment(workerState, msg));
      } else if (msg.type === 'finish') {
        const reply = codecFinish(workerState, msg);
        parentPort!.postMessage(reply);
        if (reply.type === 'page-saved' || reply.type === 'error') {
          codecAbort(workerState);
        }
      } else if (msg.type === 'abort') {
        codecAbort(workerState);
        workerState = null;
      }
    } catch (e) {
      parentPort!.postMessage(err(msg.jobId ?? '', msg.page ?? 0, 'exception', String((e as Error)?.message || e)));
    }
  });
}
