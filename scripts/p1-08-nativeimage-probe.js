// p1-08-nativeimage-probe.js
// P1-8 Step 0 运行时探针：真实 Electron 运行时验证 nativeImage.createFromBuffer 对
// GIF / WebP（VP8L 无损 / VP8X 扩展头）能否解码（isEmpty 即失败）。
// 运行：npx electron scripts/p1-08-nativeimage-probe.js（无窗口，探完即退）
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

// 经典 1×1 透明 GIF87a… 实为 GIF89a 头（'GIF89a'），逻辑尺寸字节 6-9 = 01 00 01 00。
const GIF_1x1 = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// 按规范手工构造的最小 VP8L（无损 WebP）1×1：
// RIFF + WEBP + 'VP8L' chunk；chunk data = 签名 0x2f + 14bit(width-1=0) + 14bit(height-1=0) + alpha bit + version(3bit) = 5 字节全零尾。
function buildVp8l1x1() {
  const chunkData = Buffer.from([0x2f, 0x00, 0x00, 0x00, 0x00]);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + chunkData.length + (chunkData.length % 2), 4);
  header.write('WEBP', 8, 'ascii');
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8L', 0, 'ascii');
  chunkHeader.writeUInt32LE(chunkData.length, 4);
  const pad = chunkData.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([header, chunkHeader, chunkData, pad]);
}

// 按规范手工构造的 VP8X（扩展头，带 canvas 尺寸）1×1（无实际图像数据块——解码器应至少能读出尺寸或判失败）：
function buildVp8x1x1() {
  const chunkData = Buffer.alloc(10);
  chunkData.writeUInt32LE(0, 0); // flags + reserved（24bit 保留）
  chunkData.writeUIntLE(1 - 1, 4, 3); // canvas width-1 (24bit LE)
  chunkData.writeUIntLE(1 - 1, 7, 3); // canvas height-1 (24bit LE)
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(4 + 8 + chunkData.length + (chunkData.length % 2), 4);
  header.write('WEBP', 8, 'ascii');
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('VP8X', 0, 'ascii');
  chunkHeader.writeUInt32LE(chunkData.length, 4);
  const pad = chunkData.length % 2 ? Buffer.from([0x00]) : Buffer.alloc(0);
  return Buffer.concat([header, chunkHeader, chunkData, pad]);
}

// PNG 对照组（必须可解码，证明探针自身有效）。
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

app.whenReady().then(() => {
  const samples = {
    gif_1x1: GIF_1x1,
    webp_vp8l_1x1: buildVp8l1x1(),
    webp_vp8x_1x1: buildVp8x1x1(),
    png_1x1_control: PNG_1x1,
  };
  const result = {};
  for (const [name, buf] of Object.entries(samples)) {
    try {
      const img = nativeImage.createFromBuffer(buf);
      const empty = img.isEmpty();
      const size = empty ? null : img.getSize();
      result[name] = { byteLength: buf.length, isEmpty: empty, size };
    } catch (err) {
      result[name] = { byteLength: buf.length, threw: String(err) };
    }
  }
  const out = JSON.stringify(result, null, 2);
  console.log('P1-8 PROBE RESULT ' + out);
  try {
    fs.mkdirSync(path.join(__dirname, '..', 'out'), { recursive: true });
    fs.writeFileSync(path.join(__dirname, '..', 'out', 'p1-08-nativeimage-probe.json'), out);
  } catch { /* 落盘失败不影响 stdout 证据 */ }
  app.quit();
});
