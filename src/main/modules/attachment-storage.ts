// 附件物理文件存储边界：原子写入、SHA-256、缩略图/预览读取、物理删除、孤儿键枚举。
// 只负责文件系统操作，不访问 SQLite（元数据由 attachment-repo 管理）。
// 图片解码/缩略图用 Electron nativeImage，不引入 sharp 等额外依赖。
// 注意：本模块依赖 electron（nativeImage），裸 import 只能在主进程运行；脚本如需导入须先 stub electron（先例 scripts/tdd-bugfix-p2-12-part-cleanup-guard-verify.ts 劫持 Module._load）。
import { createHash } from 'node:crypto';
import { promises as fsp, statSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { nativeImage } from 'electron';

import {
  detectDirectImageFormat,
  isSupportedDirectImage,
  sanitizeAttachmentFilename,
  probeGifDimensions,
  probeWebpDimensions,
} from './attachment-policy';
import type {
  AttachmentPreviewResponse,
  AttachmentRecord,
  StoredAttachmentFile,
} from '../../shared/types/attachment';
import { getAttachmentsDir } from '../utils/paths';

export interface StagedAttachmentInput {
  /** 附件 ID（由调用方生成——IPC 路径由 handler、克隆路径由 service——并复用于 repo 记录，组成 storageKey 的中间段）。 */
  id: string;
  sessionId: string;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}

/** 缩略图最长边固定 512px。 */
const THUMBNAIL_LONG_EDGE = 512;

// ── hb12-ATT-06（EXIF 半边，二轮补救）─────────────────────────────────
// nativeImage 不应用 EXIF orientation（Electron 官方文档证实）：带方向标记的 JPEG 缩略图
// 会保持传感器原始方向。最小解析 JPEG APP1/TIFF 的 orientation 标签（0x0112，不引依赖），
// 再用手写位图变换转正后交给既有缩放流程；CMYK 半边维持留档待真机样张（hb12 附录 D）。

/** 读 JPEG 的 EXIF orientation（1-8）；非 JPEG / 无 EXIF / 解析异常一律返回 1（不转正）。 */
function readJpegExifOrientation(bytes: Uint8Array): number {
  try {
    if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return 1;
    let off = 2;
    while (off + 4 <= bytes.length) {
      if (bytes[off] !== 0xff) {
        off += 1;
        continue;
      }
      const marker = bytes[off + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2; // 无长度段标记
        continue;
      }
      if (marker === 0xda) break; // SOS：EXIF 必在其前
      const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
      if (segLen < 2 || off + 2 + segLen > bytes.length) return 1;
      if (marker === 0xe1) {
        // APP1："Exif\0\0" 后接 TIFF 头（II=小端 / MM=大端）。注意 tiff 变量实指 "Exif\0\0"
        // 起始（下校验即 'E'..'f'），TIFF 头在其后 6 字节（tiff+6）。
        const tiff = off + 4;
        if (
          tiff + 8 > bytes.length ||
          bytes[tiff] !== 0x45 || bytes[tiff + 1] !== 0x78 || bytes[tiff + 2] !== 0x69 ||
          bytes[tiff + 3] !== 0x66 || bytes[tiff + 4] !== 0x00 || bytes[tiff + 5] !== 0x00
        ) {
          return 1;
        }
        const little = bytes[tiff + 6] === 0x49 && bytes[tiff + 7] === 0x49;
        const big = bytes[tiff + 6] === 0x4d && bytes[tiff + 7] === 0x4d;
        if (!little && !big) return 1;
        const u16 = (p: number): number => (little ? bytes[p] | (bytes[p + 1] << 8) : (bytes[p] << 8) | bytes[p + 1]);
        const u32 = (p: number): number =>
          little
            ? (bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16) | (bytes[p + 3] << 24)) >>> 0
            : (((bytes[p] << 24) | (bytes[p + 1] << 16) | (bytes[p + 2] << 8) | bytes[p + 3]) >>> 0);
        // hb13-v A6：IFD0 偏移在 TIFF 头第 4-7 字节，即 tiff+6+4 = tiff+10——旧实现读
        // u32(tiff+4) 落在 "Exif\0\0" 尾 + 字节序字符上，全部带方向 JPEG 恒解析为 1
        //（uprightBitmap 死代码，转正从未生效）。合成样张阳性对照已验证本表达式。
        const ifd0 = tiff + 6 + u32(tiff + 10);
        if (ifd0 + 2 > bytes.length) return 1;
        const count = u16(ifd0);
        for (let i = 0; i < count; i += 1) {
          const entry = ifd0 + 2 + i * 12;
          if (entry + 12 > bytes.length) return 1;
          if (u16(entry) === 0x0112) {
            const v = u16(entry + 8);
            return v >= 1 && v <= 8 ? v : 1;
          }
        }
        return 1;
      }
      off += 2 + segLen;
    }
  } catch {
    // 任何解析异常按无旋转处理
  }
  return 1;
}

/** 按 EXIF orientation 对位图做像素级转正（每像素 4 字节整组搬运，通道序无关）。
 *  orientation 1/越界返回 null（无需变换）；数据不足（理论不可达）也返回 null 兜底不转。 */
function uprightBitmap(
  img: ReturnType<typeof nativeImage.createFromBuffer>,
  orientation: number,
): { data: Buffer; width: number; height: number } | null {
  if (orientation <= 1 || orientation > 8) return null;
  const { width: w, height: h } = img.getSize();
  if (w <= 0 || h <= 0) return null;
  const src = img.toBitmap();
  if (src.length < w * h * 4) return null;
  const swap = orientation >= 5; // 5-8：宽高互换
  const nw = swap ? h : w;
  const nh = swap ? w : h;
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      let dx = x;
      let dy = y;
      switch (orientation) {
        case 2: dx = w - 1 - x; break; // 水平镜像
        case 3: dx = w - 1 - x; dy = h - 1 - y; break; // 旋转 180°
        case 4: dy = h - 1 - y; break; // 垂直镜像
        case 5: dx = y; dy = x; break; // 转置
        case 6: dx = h - 1 - y; dy = x; break; // 90° CW
        case 7: dx = h - 1 - y; dy = w - 1 - x; break; // 反转置
        case 8: dx = y; dy = w - 1 - x; break; // 90° CCW
        default: break;
      }
      const s = (y * w + x) * 4;
      const d = (dy * nw + dx) * 4;
      out[d] = src[s];
      out[d + 1] = src[s + 1];
      out[d + 2] = src[s + 2];
      out[d + 3] = src[s + 3];
    }
  }
  return { data: out, width: nw, height: nh };
}

/** storageKey 为相对附件根的 POSIX 风格键：<sessionId>/<attachmentId>/<safeFilename>，由主进程生成。 */
function buildStorageKey(sessionId: string, attachmentId: string, safeFilename: string): string {
  return [sessionId, attachmentId, safeFilename].join('/');
}

/** 把 storageKey 解析为绝对路径，并校验仍在附件根目录下（防越界/穿越）。 */
export function resolveAbsolutePath(storageKey: string): string {
  const root = path.resolve(getAttachmentsDir());
  const abs = path.resolve(root, storageKey);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`附件存储键越界: ${storageKey}`);
  }
  return abs;
}

/** 检查已存在的路径组件，拒绝通过符号链接把附件操作导出根目录。 */
async function assertNoSymlinkPath(abs: string): Promise<void> {
  const root = path.resolve(getAttachmentsDir());
  const relative = path.relative(root, abs);
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`附件路径包含不允许的 symbolic link: ${part}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function inferMimeType(mimeType: string | undefined, bytes: Uint8Array): string {
  const detected = detectDirectImageFormat(bytes);
  if (detected) return detected;
  if (mimeType && mimeType.trim()) return mimeType.trim().toLowerCase();
  return 'application/octet-stream';
}

/**
 * 原子写入附件文件：先写 .part 临时文件再 rename，避免半文件进入 DB。
 * 用户原始路径上的符号链接在调用方 readFile 阶段已被解引用，落盘的是真实内容。
 * 不在此处解码图片尺寸（由 probeImageDimensions 独立完成，避免与写入耦合）。
 */
export async function writeAttachmentFile(input: StagedAttachmentInput): Promise<StoredAttachmentFile> {
  const { id, sessionId, filename, bytes } = input;
  const safeFilename = sanitizeAttachmentFilename(filename);
  const storageKey = buildStorageKey(sessionId, id, safeFilename);
  const absolutePath = resolveAbsolutePath(storageKey);

  await assertNoSymlinkPath(absolutePath);
  await fsp.mkdir(path.dirname(absolutePath), { recursive: true });
  await assertNoSymlinkPath(path.dirname(absolutePath));
  const tmpPath = `${absolutePath}.part`;
  try {
    await fsp.writeFile(tmpPath, bytes);
    await fsp.rename(tmpPath, absolutePath);
  } catch (error) {
    await fsp.rm(tmpPath, { force: true }).catch(() => {});
    throw error;
  }

  // 写后重读计算 SHA-256（以落盘真实内容为准，而非内存 bytes）。
  const reread = await fsp.readFile(absolutePath);
  const sha256 = createHash('sha256').update(reread).digest('hex');

  return {
    storageKey,
    absolutePath,
    sizeBytes: reread.byteLength,
    sha256,
  };
}

/**
 * 解码图片拿像素尺寸；非受支持图片或解码不出时返回 null（由调用方按不支持图片处理）。
 * P1-8：nativeImage（Electron 35）实测解不出 GIF/WebP（探针 scripts/p1-08-nativeimage-probe.js
 * 证实 isEmpty），按魔数回落自研解析（policy 纯函数）；两者都失败才返回 null。
 * PNG/JPEG 路径完全不变（nativeImage 首试即成功，不走回落）。
 */
export function probeImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!detectDirectImageFormat(bytes)) return null;
  const img = nativeImage.createFromBuffer(Buffer.from(bytes));
  const size = img.getSize();
  if (size.width > 0 && size.height > 0) return { width: size.width, height: size.height };
  return probeGifDimensions(bytes) ?? probeWebpDimensions(bytes);
}

/** 读取附件原始 bytes（克隆用；不做缩略图/mime 推断，按落盘原样读）。 */
export async function readStoredAttachmentBytes(record: AttachmentRecord): Promise<Uint8Array> {
  const absolutePath = resolveAbsolutePath(record.storageKey);
  await assertNoSymlinkPath(absolutePath);
  const buf = await fsp.readFile(absolutePath);
  return new Uint8Array(buf);
}

/** 读取受控预览：图片缩略图（最长边 512px，转 PNG）或原图 bytes（缺省无读侧预检，大小上限仅由
 *  图片暂存 10MiB 上限 MAX_IMAGE_BYTES 间接保证；预览链不传 maxBytes，导出链才显式传入）；
 *  绝不返回绝对路径。
 *  hb10 P2-10：可选 maxBytes 读前预检——statSync 文件尺寸超限直接抛错（上层降级 previewUnavailable），
 *  不再把超预算文件整读进内存。缺省不预检，既有两参调用方零影响。 */
export async function readStoredAttachmentPreview(
  record: AttachmentRecord,
  thumbnail: boolean,
  maxBytes?: number,
): Promise<AttachmentPreviewResponse> {
  const absolutePath = resolveAbsolutePath(record.storageKey);
  await assertNoSymlinkPath(absolutePath);
  if (maxBytes !== undefined) {
    const st = statSync(absolutePath);
    if (st.size > maxBytes) {
      throw new Error(`附件预览超预算：${st.size} > ${maxBytes} 字节`);
    }
  }
  const bytes = await fsp.readFile(absolutePath);
  const mime = inferMimeType(record.mimeType, bytes);

  if (thumbnail && isSupportedDirectImage(mime)) {
    const img = nativeImage.createFromBuffer(bytes);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      // hb12-ATT-06（EXIF 半边）：nativeImage 不应用 EXIF orientation——先按标签位图转正，
      // 再以转正后的宽高做既有 512 最长边缩放。非 JPEG/无标记/解析失败 orientation=1 →
      // 不变换，行为与此前完全一致。CMYK 半边维持留档待真机样张（hb12 附录 D）。
      const orientation = readJpegExifOrientation(bytes);
      const upright = uprightBitmap(img, orientation);
      const baseW = upright?.width ?? size.width;
      const baseH = upright?.height ?? size.height;
      const longest = Math.max(baseW, baseH);
      const scale = longest > THUMBNAIL_LONG_EDGE ? THUMBNAIL_LONG_EDGE / longest : 1;
      const tw = Math.max(1, Math.round(baseW * scale));
      const th = Math.max(1, Math.round(baseH * scale));
      const source = upright
        ? nativeImage.createFromBitmap(upright.data, { width: upright.width, height: upright.height })
        : img;
      const png = source.resize({ width: tw, height: th }).toPNG();
      return {
        attachmentId: record.id,
        mimeType: 'image/png',
        bytes: new Uint8Array(png),
        width: tw,
        height: th,
        isThumbnail: true,
      };
    }
  }
  // hb10-ATT-02：nativeImage 解码失败（GIF/WebP 多帧等）→ policy 探针取尺寸后仍返回原图，
  // 渲染层用既有 object-fit CSS 缩放展示，不再无界直出。（hb13-v B10.5：原「未缩略」标记
  // 字段渲染层零消费者，已删除——原「渲染层半边」不存在。）
  const probed = probeImageDimensions(bytes);
  if (probed) {
    return {
      attachmentId: record.id,
      mimeType: mime,
      bytes: new Uint8Array(bytes),
      width: probed.width,
      height: probed.height,
      isThumbnail: false,
    };
  }

  return {
    attachmentId: record.id,
    mimeType: mime,
    bytes: new Uint8Array(bytes),
    width: record.width,
    height: record.height,
    isThumbnail: false,
  };
}

/** 删除物理文件，并尝试回收空的上层目录（attachmentId / session 目录）。 */
export async function removeAttachmentFile(storageKey: string): Promise<void> {
  const absolutePath = resolveAbsolutePath(storageKey);
  await assertNoSymlinkPath(absolutePath);
  await fsp.rm(absolutePath, { force: true });

  const root = path.resolve(getAttachmentsDir());
  let dir = path.dirname(absolutePath);
  for (let i = 0; i < 2; i += 1) {
    if (path.resolve(dir) === root) break;
    try {
      const entries = await fsp.readdir(dir);
      if (entries.length === 0) {
        await fsp.rmdir(dir);
        dir = path.dirname(dir);
      } else {
        break;
      }
    } catch {
      break;
    }
  }
}

/** 删除超过安全年龄的遗留 .part 文件，并回收遍历后发现的空目录。
 *  P2-12：registeredStorageKeys——DB 已登记的 storageKey 集合（生产调用方传
 *  attachmentRepo.listAllStorageKeys()，为完整键 `<sessionId>/<attachmentId>/<filename>`）。
 *  N10：守卫按完整键（path.relative(root, full) 的 POSIX 形态）比对——叶子文件名命中不算数；
 *  命中的 `.part` 结尾文件是「键即登记键的合法附件」（落盘名 report.part 的原子写临时名为
 *  report.part.part），不得删除；真临时 .part（不在 DB）照删。缺省 null = 无登记信息、
 *  行为与旧版一致。 */
export async function cleanupStalePartFiles(
  minAgeMs = 60 * 60 * 1000,
  registeredStorageKeys?: Iterable<string> | null,
): Promise<void> {
  const root = path.resolve(getAttachmentsDir());
  const cutoff = Date.now() - minAgeMs;
  const registered = registeredStorageKeys ? new Set(registeredStorageKeys) : null;

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.part')) {
        const stat = await fsp.stat(full).catch(() => null);
        if (stat && stat.mtimeMs <= cutoff) {
          // P2-12：完整 storageKey（POSIX 相对键）命中 DB 登记集合 → 是键即登记键的合法附件，保留。
          // N10：必须比全键而非叶子文件名——叶子名命中不构成保护（与孤儿清扫「全键比对」同形）。
          const posixKey = path.relative(root, full).split(path.sep).join('/');
          if (registered?.has(posixKey)) continue;
          await fsp.rm(full, { force: true });
        }
      }
    }
    if (path.resolve(dir) !== root) {
      const remaining = await fsp.readdir(dir).catch(() => ['unreadable']);
      if (remaining.length === 0) await fsp.rmdir(dir).catch(() => {});
    }
  }

  await walk(root);
}

/** 枚举附件根下所有已落盘文件的 storageKey（孤儿清理用，跳过 .part 临时文件）。 */
export async function listStoredAttachmentKeys(): Promise<string[]> {
  const root = getAttachmentsDir();
  const keys: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && !entry.name.endsWith('.part')) {
        keys.push(path.relative(root, full).split(path.sep).join('/'));
      }
    }
  }

  await walk(root);
  return keys;
}
