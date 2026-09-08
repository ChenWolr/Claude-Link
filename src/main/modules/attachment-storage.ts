// 附件物理文件存储边界：原子写入、SHA-256、缩略图/预览读取、物理删除、孤儿键枚举。
// 只负责文件系统操作，不访问 SQLite（元数据由 attachment-repo 管理）。
// 图片解码/缩略图用 Electron nativeImage，不引入 sharp 等额外依赖。
// 注意：本模块依赖 electron（nativeImage），只能在主进程运行，不可被 regression 脚本导入。
import { createHash } from 'node:crypto';
import { promises as fsp, type Dirent } from 'node:fs';
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
  /** 附件 ID（由 service 生成并复用于 repo 记录，组成 storageKey 的中间段）。 */
  id: string;
  sessionId: string;
  filename: string;
  mimeType?: string;
  bytes: Uint8Array;
}

/** 缩略图最长边固定 512px。 */
const THUMBNAIL_LONG_EDGE = 512;

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

/** 读取受控预览：图片缩略图（最长边 512px，转 PNG）或原图有界 bytes；绝不返回绝对路径。 */
export async function readStoredAttachmentPreview(
  record: AttachmentRecord,
  thumbnail: boolean,
): Promise<AttachmentPreviewResponse> {
  const absolutePath = resolveAbsolutePath(record.storageKey);
  await assertNoSymlinkPath(absolutePath);
  const bytes = await fsp.readFile(absolutePath);
  const mime = inferMimeType(record.mimeType, bytes);

  if (thumbnail && isSupportedDirectImage(mime)) {
    const img = nativeImage.createFromBuffer(bytes);
    const size = img.getSize();
    if (size.width > 0 && size.height > 0) {
      const longest = Math.max(size.width, size.height);
      const scale = longest > THUMBNAIL_LONG_EDGE ? THUMBNAIL_LONG_EDGE / longest : 1;
      const tw = Math.max(1, Math.round(size.width * scale));
      const th = Math.max(1, Math.round(size.height * scale));
      const png = img.resize({ width: tw, height: th }).toPNG();
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
