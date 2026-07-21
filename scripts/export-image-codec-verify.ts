// v4.1 PNG codec 纯 Node 验证（不经 Electron / worker_threads）。
// 直接驱动 export-image-codec-worker 导出的 codec 状态机函数：
//   2×100px 拼成 200px；尾段 clamp 每行恰好一次；失败分支（宽变/空/越界/乱序）；输出可再解码；输出高度可超 32767px。
// 运行：npx tsx scripts/export-image-codec-verify.ts（由 npm run selftest 串联）。

import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { codecBegin, codecSegment, codecFinish, codecAbort } from '../src/main/modules/export-image-codec-worker';
import { buildSegmentCopyGeometry } from '../src/shared/export-image';
import type { CodecMessage, SegmentCopyGeometry } from '../src/shared/types/export-image';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const tmpDir = mkdtempSync(join(tmpdir(), 'claude-link-codec-verify-'));
function pagePath(name: string): string { return join(tmpDir, name); }

// 构造一张 width×height 的纯色 PNG（Buffer）。
function solidPng(width: number, height: number, rgba: [number, number, number, number]): Buffer {
  const png = new PNG({ width, height });
  for (let i = 0; i < width * height; i++) {
    png.data[i * 4] = rgba[0];
    png.data[i * 4 + 1] = rgba[1];
    png.data[i * 4 + 2] = rgba[2];
    png.data[i * 4 + 3] = rgba[3];
  }
  return PNG.sync.write(png);
}

// 把 PNG bytes 复制成独立 ArrayBuffer（模拟主进程 byteOffset-safe transfer）。
function toAb(buf: Buffer): ArrayBuffer {
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
}

// 用 CSS 几何算 worker 几何。
function geom(cursor: number, actualScrollY: number, vw: number, vh: number, totalH: number, bw: number, bh: number): SegmentCopyGeometry {
  const r = buildSegmentCopyGeometry({ cursorCss: cursor, actualScrollYCss: actualScrollY, viewportWidthCss: vw, viewportHeightCss: vh, totalHeightCss: totalH, bitmapWidthPx: bw, bitmapHeightPx: bh });
  assert(r.ok, 'geom ok');
  return r.geometry;
}

// —— Step 1：2×100px 段拼成 200px ——
{
  console.log('\n--- Task 8 Step 1: 2×100 → 200px ---');
  const W = 100, VH = 100, TOTAL = 200;
  const out = pagePath('page-0001.png');
  const begin = codecBegin({ type: 'begin', jobId: 'j1', page: 1, outputPath: out, pageHeightCss: TOTAL, viewportWidthCss: W, viewportHeightCss: VH, bitmapWidthPx: W, totalHeightPx: TOTAL });
  check('begin → begun', begin.reply.type === 'begun' && begin.state !== null);
  const st = begin.state!;
  const s1 = codecSegment(st, { type: 'segment', jobId: 'j1', page: 1, segment: 1, png: toAb(solidPng(W, VH, [10, 0, 0, 255])), geometry: geom(0, 0, W, VH, TOTAL, W, VH) });
  check('seg1 accepted', s1.type === 'segment-accepted');
  const s2 = codecSegment(st, { type: 'segment', jobId: 'j1', page: 1, segment: 2, png: toAb(solidPng(W, VH, [20, 0, 0, 255])), geometry: geom(100, 100, W, VH, TOTAL, W, VH) });
  check('seg2 accepted', s2.type === 'segment-accepted');
  const fin = codecFinish(st, { type: 'finish', jobId: 'j1', page: 1 });
  check('finish → page-saved 100×200', fin.type === 'page-saved' && fin.widthPx === 100 && fin.heightPx === 200);
  check('输出文件存在', existsSync(out));
  const dec = PNG.sync.read(readFileSync(out));
  check('输出解码 width=100 height=200', dec.width === 100 && dec.height === 200);
  check('第 0 行=段1 色(10)', dec.data[0] === 10);
  check('第 100 行=段2 色(20)', dec.data[100 * 100 * 4] === 20);
}

// —— Step 2：尾段 clamp，每行 ID 恰好一次（3 段，250 总高，末段 actualScrollY 被夹到 150）——
{
  console.log('\n--- Task 8 Step 2: tail clamp, rows unique ---');
  const W = 100, VH = 100, TOTAL = 250;
  const out = pagePath('page-0002.png');
  const st = codecBegin({ type: 'begin', jobId: 'j2', page: 1, outputPath: out, pageHeightCss: TOTAL, viewportWidthCss: W, viewportHeightCss: VH, bitmapWidthPx: W, totalHeightPx: TOTAL }).state!;
  // 每段按「文档行号」着色：segRow r → 色 = (docBase + r) & 0xff，docBase = 该段视口顶端的文档行。
  // 这样无论段如何映射，输出第 r 行恒为色 r，可一次校验全部 250 行无重复无漏。
  const docRowPng = (docBase: number) => {
    const png = new PNG({ width: W, height: VH });
    for (let r = 0; r < VH; r++) { const c = (docBase + r) & 0xff; for (let x = 0; x < W; x++) { const o = (r * W + x) * 4; png.data[o] = c; png.data[o + 3] = 255; } }
    return PNG.sync.write(png);
  };
  codecSegment(st, { type: 'segment', jobId: 'j2', page: 1, segment: 1, png: toAb(docRowPng(0)), geometry: geom(0, 0, W, VH, TOTAL, W, VH) });
  codecSegment(st, { type: 'segment', jobId: 'j2', page: 1, segment: 2, png: toAb(docRowPng(100)), geometry: geom(100, 100, W, VH, TOTAL, W, VH) });
  // 末段：cursor 200，actualScrollY 被 clamp 到 150（maxScroll=150）；段位图显示文档行 150..249。
  codecSegment(st, { type: 'segment', jobId: 'j2', page: 1, segment: 3, png: toAb(docRowPng(150)), geometry: geom(200, 150, W, VH, TOTAL, W, VH) });
  const fin = codecFinish(st, { type: 'finish', jobId: 'j2', page: 1 });
  check('finish 250 高', fin.type === 'page-saved' && fin.heightPx === 250);
  const dec = PNG.sync.read(readFileSync(out));
  check('输出 100×250', dec.width === 100 && dec.height === 250);
  // 输出第 r 行恒为色 r（每文档行恰好出现一次）。
  let rowsUnique = true;
  for (let r = 0; r < TOTAL; r++) {
    if (dec.data[r * W * 4] !== (r & 0xff)) { rowsUnique = false; break; }
  }
  check('每行 ID 恰好一次（无重复无漏）', rowsUnique);
}

// —— Step 3：失败分支 ——
{
  console.log('\n--- Task 8 Step 3: failure branches ---');
  // 宽度变化
  {
    const out = pagePath('fail-width.png');
    const st = codecBegin({ type: 'begin', jobId: 'j3', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    codecSegment(st, { type: 'segment', jobId: 'j3', page: 1, segment: 1, png: toAb(solidPng(100, 100, [1, 0, 0, 255])), geometry: geom(0, 0, 100, 100, 200, 100, 100) });
    const s2 = codecSegment(st, { type: 'segment', jobId: 'j3', page: 1, segment: 2, png: toAb(solidPng(101, 100, [2, 0, 0, 255])), geometry: geom(100, 100, 101, 100, 200, 101, 100) });
    check('段宽变化 → error', s2.type === 'error' && s2.code === 'width-changed');
    codecAbort(st);
  }
  // 空 PNG
  {
    const out = pagePath('fail-empty.png');
    const st = codecBegin({ type: 'begin', jobId: 'j4', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    const s = codecSegment(st, { type: 'segment', jobId: 'j4', page: 1, segment: 1, png: new ArrayBuffer(0), geometry: geom(0, 0, 100, 100, 200, 100, 100) });
    check('空 PNG → error', s.type === 'error' && s.code === 'empty-png');
    codecAbort(st);
  }
  // 越界 geometry（source 超过 bitmap 高）
  {
    const out = pagePath('fail-overflow.png');
    const st = codecBegin({ type: 'begin', jobId: 'j5', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    // 构造 sourceStartPx=95, drawHeightPx=10 → sourceEnd 105 > bitmap 100
    const badGeom: SegmentCopyGeometry = { sourceStartPx: 95, sourceEndPx: 105, destStartPx: 0, destEndPx: 10, drawHeightPx: 10, bitmapWidthPx: 100, bitmapHeightPx: 100 };
    const s = codecSegment(st, { type: 'segment', jobId: 'j5', page: 1, segment: 1, png: toAb(solidPng(100, 100, [3, 0, 0, 255])), geometry: badGeom });
    check('source 越界 → error', s.type === 'error' && s.code === 'source-overflow');
    codecAbort(st);
  }
  // 乱序 segment
  {
    const out = pagePath('fail-order.png');
    const st = codecBegin({ type: 'begin', jobId: 'j6', page: 1, outputPath: out, pageHeightCss: 300, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 300 }).state!;
    codecSegment(st, { type: 'segment', jobId: 'j6', page: 1, segment: 1, png: toAb(solidPng(100, 100, [1, 0, 0, 255])), geometry: geom(0, 0, 100, 100, 300, 100, 100) });
    const s3 = codecSegment(st, { type: 'segment', jobId: 'j6', page: 1, segment: 3, png: toAb(solidPng(100, 100, [3, 0, 0, 255])), geometry: geom(200, 200, 100, 100, 300, 100, 100) });
    check('乱序 segment → error', s3.type === 'error' && s3.code === 'segment-out-of-order');
    codecAbort(st);
  }
  // finish 前无段
  {
    const out = pagePath('fail-noseg.png');
    const st = codecBegin({ type: 'begin', jobId: 'j7', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    const f = codecFinish(st, { type: 'finish', jobId: 'j7', page: 1 });
    check('finish 前无段 → error', f.type === 'error' && f.code === 'finish-before-segment');
  }
  // 重复 finish
  {
    const out = pagePath('fail-dupfinish.png');
    const st = codecBegin({ type: 'begin', jobId: 'j7b', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    codecSegment(st, { type: 'segment', jobId: 'j7b', page: 1, segment: 1, png: toAb(solidPng(100, 100, [1, 0, 0, 255])), geometry: geom(0, 0, 100, 100, 200, 100, 100) });
    const f1 = codecFinish(st, { type: 'finish', jobId: 'j7b', page: 1 });
    check('首次 finish → page-saved', f1.type === 'page-saved');
    const f2 = codecFinish(st, { type: 'finish', jobId: 'j7b', page: 1 });
    check('重复 finish → duplicate-finish', f2.type === 'error' && f2.code === 'duplicate-finish');
  }
  // PNG 解码失败（损坏 ArrayBuffer）
  {
    const out = pagePath('fail-decode.png');
    const st = codecBegin({ type: 'begin', jobId: 'j7c', page: 1, outputPath: out, pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 }).state!;
    const corrupt = Buffer.alloc(256, 0xaa); // 非 PNG 字节
    const s = codecSegment(st, { type: 'segment', jobId: 'j7c', page: 1, segment: 1, png: toAb(corrupt), geometry: geom(0, 0, 100, 100, 200, 100, 100) });
    check('损坏 PNG → png-decode-failed', s.type === 'error' && s.code === 'png-decode-failed');
  }
  // begin 非法 outputPath（非 .png）
  {
    const r = codecBegin({ type: 'begin', jobId: 'j7d', page: 1, outputPath: pagePath('not-a-png.txt'), pageHeightCss: 200, viewportWidthCss: 100, viewportHeightCss: 100, bitmapWidthPx: 100, totalHeightPx: 200 });
    check('begin 非 .png outputPath → bad-output-path', r.reply.type === 'error' && r.reply.code === 'bad-output-path');
  }
}

// —— Step 4：输出可再解码（已在 Step 1/2 隐含覆盖，此处显式断言非 PNG magic 失败）——
{
  console.log('\n--- Task 8 Step 4: output re-decodable ---');
  const buf = readFileSync(pagePath('page-0001.png'));
  check('PNG magic 正确', buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47);
}

// —— Step 5：输出高度可超 32767px（Node fixture，宽 100，段高 4000，10 段 → 40000px）——
{
  console.log('\n--- Task 8 Step 5: height > 32767px ---');
  const W = 100, SEG_H = 4000, TOTAL = 40000, SEG_COUNT = 10;
  const out = pagePath('page-tall.png');
  const st = codecBegin({ type: 'begin', jobId: 'j8', page: 1, outputPath: out, pageHeightCss: TOTAL, viewportWidthCss: W, viewportHeightCss: SEG_H, bitmapWidthPx: W, totalHeightPx: TOTAL }).state!;
  for (let s = 0; s < SEG_COUNT; s++) {
    const cursor = s * SEG_H;
    const actualScrollY = cursor; // 无 clamp（每段整视口）
    const r = codecSegment(st, { type: 'segment', jobId: 'j8', page: 1, segment: s + 1, png: toAb(solidPng(W, SEG_H, [(s * 20) & 0xff, 0, 0, 255])), geometry: geom(cursor, actualScrollY, W, SEG_H, TOTAL, W, SEG_H) });
    if (r.type !== 'segment-accepted') { check(`seg ${s + 1} accepted`, false, r.type); break; }
  }
  const fin = codecFinish(st, { type: 'finish', jobId: 'j8', page: 1 });
  check('finish 40000 高', fin.type === 'page-saved' && fin.heightPx === 40000);
  if (fin.type === 'page-saved') {
    const dec = PNG.sync.read(readFileSync(out));
    check('输出 100×40000（超 Canvas 32767 单边）', dec.width === 100 && dec.height === 40000 && 40000 > 32767);
  }
}

try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n=== export-image-codec-verify 结果：${pass} 通过 / ${fail} 失败 ===`);
if (fail > 0) process.exit(1);
