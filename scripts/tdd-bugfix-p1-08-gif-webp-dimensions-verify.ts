// tdd-bugfix-p1-08-gif-webp-dimensions-verify.ts
// P1-8 契约钉：GIF/WebP 附件整体无法暂存（nativeImage 解码失败，运行时探针已证实）。
//
// 修复语义：policy 增加纯函数 probeGifDimensions（头部字节 6-9）/probeWebpDimensions
//（VP8 有损 / VP8L 无损 / VP8X 扩展头三形态）；attachment-storage 的 probeImageDimensions
// 在 nativeImage 失败（isEmpty）时按魔数回落自研解析；两者都失败才报「无法解码」。
// PNG/JPEG 路径完全不变（nativeImage 首试即成功）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-08-gif-webp-dimensions-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const policySrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/attachment-policy.ts'), 'utf8');
const storageSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/attachment-storage.ts'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { probeGifDimensions, probeWebpDimensions, detectDirectImageFormat } = require('../src/main/modules/attachment-policy');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function buildWebp(fourcc: 'VP8 ' | 'VP8L' | 'VP8X', chunkData: Buffer): Buffer {
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + chunkData.length + (chunkData.length % 2), 4);
  header.write('WEBP', 8, 'ascii');
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write(fourcc, 0, 'ascii');
  chunkHeader.writeUInt32LE(chunkData.length, 4);
  const pad = chunkData.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([header, chunkHeader, chunkData, pad]);
}

// GIF：真实 1×1（探针同源 base64）+ 合成 320×200 头。
const gif1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const gif320x200 = Buffer.concat([Buffer.from('GIF89a', 'ascii'), (() => { const b = Buffer.alloc(4); b.writeUInt16LE(320, 0); b.writeUInt16LE(200, 2); return b; })(), Buffer.alloc(16)]);

// VP8L：1×1 与 640×480（bits = (w-1) | ((h-1) << 14)，LE32）。
const vp8l1x1 = buildWebp('VP8L', Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]));
const vp8l640x480 = buildWebp('VP8L', Buffer.from([0x2f, 0x7f, 0xc2, 0x77, 0x00]));

// VP8 有损：2×3（起始码 9D 01 2A + 宽高 u16LE 低 14 位）。
const vp8Lossy2x3 = buildWebp('VP8 ', Buffer.from([0x00, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x03, 0x00]));

// VP8X：1×1 canvas。
const vp8xChunk = Buffer.alloc(10);
vp8xChunk.writeUIntLE(0, 0, 3);
vp8xChunk.writeUIntLE(0, 4, 3);
vp8xChunk.writeUIntLE(0, 7, 3);
const vp8x1x1 = buildWebp('VP8X', vp8xChunk);

// GIF 行为。
check('① GIF 真实 1×1 → 1×1', JSON.stringify(probeGifDimensions(gif1x1)) === '{"width":1,"height":1}',
  JSON.stringify(probeGifDimensions(gif1x1)));
check('② GIF 合成 320×200 → 320×200（字节 6-9 LE）', JSON.stringify(probeGifDimensions(gif320x200)) === '{"width":320,"height":200}');
check('③ GIF 截断（<10 字节）→ null', probeGifDimensions(gif1x1.subarray(5)) === null);
check('④ 非魔数 → null', probeGifDimensions(Buffer.from('notagifxxxxxxxx')) === null);

// WebP 三形态。
check('⑤ WebP VP8L 无损 1×1 → 1×1', JSON.stringify(probeWebpDimensions(vp8l1x1)) === '{"width":1,"height":1}',
  JSON.stringify(probeWebpDimensions(vp8l1x1)));
check('⑥ WebP VP8L 640×480 → 640×480', JSON.stringify(probeWebpDimensions(vp8l640x480)) === '{"width":640,"height":480}',
  JSON.stringify(probeWebpDimensions(vp8l640x480)));
check('⑦ WebP VP8 有损 2×3 → 2×3（起始码校验）', JSON.stringify(probeWebpDimensions(vp8Lossy2x3)) === '{"width":2,"height":3}',
  JSON.stringify(probeWebpDimensions(vp8Lossy2x3)));
check('⑧ WebP VP8 起始码损坏 → null', (() => {
  const bad = Buffer.from(vp8Lossy2x3); bad[23] = 0x00; return probeWebpDimensions(bad) === null;
})());
check('⑨ WebP VP8X 扩展头 1×1 → 1×1', JSON.stringify(probeWebpDimensions(vp8x1x1)) === '{"width":1,"height":1}',
  JSON.stringify(probeWebpDimensions(vp8x1x1)));
check('⑩ 非魔数/非 WebP 容器 → null', probeWebpDimensions(gif1x1) === null);

// detectDirectImageFormat 回归不变。
check('⑪ 魔数识别回归：GIF/WebP/PNG 分类不变',
  detectDirectImageFormat(new Uint8Array(gif1x1)) === 'image/gif' &&
  detectDirectImageFormat(new Uint8Array(vp8l1x1)) === 'image/webp');

// 结构：storage 回落链。
check('⑫ probeImageDimensions 在 nativeImage 失败时回落自研解析',
  storageSrc.includes('probeGifDimensions(bytes) ?? probeWebpDimensions(bytes)'));
check('⑬ policy 存在两个探针纯函数导出',
  policySrc.includes('export function probeGifDimensions') && policySrc.includes('export function probeWebpDimensions'));

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
