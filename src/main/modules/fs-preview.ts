// fs-preview.ts
// 文件预览面板只读读取模块（2026-11-04 计划 round-001 p1）：FS_READ_PREVIEW 通道的实现真相源。
// 渲染层不直接读磁盘：文本 ≤256KB 截断返回、二进制扩展按分类上限截停后 base64 返回，
// 全程强制 workspace 边界校验（fail-closed）——本通道经 ipc-registry 注册表暴露给网页客户端，
// handler 不校验 = 网页端可读任意磁盘文件，故校验在模块内而非调用方。
// containment 走 realpath 规范化（symlink/junction 跟链后的真实位置必须仍在允许根内）。
//
// 上限表（超出即拒绝，请用外部程序打开）：
//   文本 MAX_TEXT 256KB ｜ image 8MB ｜ media 8MB ｜ pdf 24MB ｜ docx 8MB ｜ xlsx 8MB ｜ pptx 30MB
//
// 约束：仅 import node:fs/promises + node:path + shared 类型，禁 import electron——
// 契约脚本 scripts/tdd-file-preview-verify.ts 以 tsx 直测本模块导出（main 进程模块无 electron 依赖）。
// UTF-16 BOM 文本预览（2026-11-05 计划 §2.6）：文本分支读盘后先过 BOM 感知解码器
//（shared/text-decode），UTF-16LE/BE（带 BOM）转码返回；UTF-8 / 拒绝路径逻辑零改动。

import { open, readFile, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { decodeTextBuffer } from '../../shared/text-decode';
import type { FsPreviewBlobCategory, FsPreviewResult } from '../../shared/types/ipc';

/** 文本预览字节上限（256KB；超出截断，多字节 UTF-8 边界去尾部 U+FFFD）。 */
export const MAX_TEXT = 256 * 1024;
export const MAX_IMAGE = 8 * 1024 * 1024;
export const MAX_MEDIA = 8 * 1024 * 1024;
export const MAX_PDF = 24 * 1024 * 1024;
export const MAX_DOCX = 8 * 1024 * 1024;
export const MAX_XLSX = 8 * 1024 * 1024;
export const MAX_PPTX = 30 * 1024 * 1024;

/** 分类 → 字节上限（blob 超限拒绝，不读入内存只看 stat.size）。 */
const LIMIT_BY_CATEGORY: Record<FsPreviewBlobCategory, number> = {
  image: MAX_IMAGE,
  media: MAX_MEDIA,
  pdf: MAX_PDF,
  docx: MAX_DOCX,
  xlsx: MAX_XLSX,
  pptx: MAX_PPTX,
};

/** 分类 → 上限整数 MB（错误文案用，与 LIMIT_BY_CATEGORY 保持同源数量级）。 */
const MB_BY_CATEGORY: Record<FsPreviewBlobCategory, number> = {
  image: 8,
  media: 8,
  pdf: 24,
  docx: 8,
  xlsx: 8,
  pptx: 30,
};

/** blob 类扩展名分发表：扩展名（小写、无点）→ 分类 + MIME。未命中按文本读取处理。 */
export const EXT_CATEGORY: Record<string, { category: FsPreviewBlobCategory; mime: string }> = {
  png: { category: 'image', mime: 'image/png' },
  jpg: { category: 'image', mime: 'image/jpeg' },
  jpeg: { category: 'image', mime: 'image/jpeg' },
  gif: { category: 'image', mime: 'image/gif' },
  webp: { category: 'image', mime: 'image/webp' },
  bmp: { category: 'image', mime: 'image/bmp' },
  ico: { category: 'image', mime: 'image/x-icon' },
  mp4: { category: 'media', mime: 'video/mp4' },
  webm: { category: 'media', mime: 'video/webm' },
  mov: { category: 'media', mime: 'video/quicktime' },
  mp3: { category: 'media', mime: 'audio/mpeg' },
  wav: { category: 'media', mime: 'audio/wav' },
  flac: { category: 'media', mime: 'audio/flac' },
  ogg: { category: 'media', mime: 'audio/ogg' },
  m4a: { category: 'media', mime: 'audio/mp4' },
  weba: { category: 'media', mime: 'audio/webm' },
  pdf: { category: 'pdf', mime: 'application/pdf' },
  docx: { category: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { category: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  xls: { category: 'xlsx', mime: 'application/vnd.ms-excel' },
  pptx: { category: 'pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

/** 二进制启发式：前 8KB 含 0x00 即判二进制（与主进程既有附件判定口径一致的轻量版）。 */
export function isProbablyBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8 * 1024).includes(0);
}

/**
 * 只读预览一个文件。roots 为允许的 workspace 根集合（全局配置工作目录 ∪ 会话库工作目录），
 * 目标必须位于其中至少一根之内，否则 fail-closed。containment 在 stat 之后对目标与各根做
 * realpath 规范化再判（防根内 symlink/junction 指向根外的词法逃逸），win 大小写/分隔符归一
 * 由 path.relative 对规范化结果保证。
 */
export async function previewFile(absPath: unknown, opts: { roots: string[] }): Promise<FsPreviewResult> {
  // ① 入参形状与绝对路径守卫。
  if (typeof absPath !== 'string' || !absPath.trim() || !path.isAbsolute(absPath)) {
    return { ok: false, message: '路径无效' };
  }
  const resolved = path.resolve(absPath);
  const roots = Array.isArray(opts?.roots) ? opts.roots : [];
  try {
    // ② stat 分流提前（realpath 需要目标真实存在）：目录拒绝；不存在 → missing（渲染层可提示文件已被移动/删除）。
    const st = await stat(resolved);
    if (st.isDirectory()) return { ok: false, message: '目录不支持预览' };
    // ③ workspace 边界 fail-closed（realpath 规范化）：symlink/junction 跟链后的真实位置必须
    //   仍在允许根内（纯词法判据会被根内符号链接绕过）。逃逸判据=rel 恰为 '..' 或以
    //   '..'+path.sep 开头（宽判 startsWith('..') 会误伤根下名为 '..foo.txt' 的合法文件——
    //   Windows 合法文件名，rel 返回 '..foo.txt'）。
    const realTarget = await realpath(resolved);
    let inside = false;
    for (const root of roots) {
      if (typeof root !== 'string' || !root.trim()) continue;
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        continue; // 该根不存在/不可达，跳过该根
      }
      const rel = path.relative(realRoot, realTarget);
      if (rel !== '' && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel)) {
        inside = true;
        break;
      }
    }
    if (!inside) return { ok: false, message: '路径不在工作区内' };
    // ④ 扩展名分流（小写去点）；旧版 Office 二进制不在可预览集合，明确拒并给转存建议。
    const ext = path.extname(resolved).toLowerCase().replace(/^\./, '');
    if (ext === 'doc' || ext === 'ppt') {
      return { ok: false, message: '旧版 Office 格式不支持预览，请转存为新格式或用外部程序打开' };
    }
    // ⑤ blob 类：先按 stat.size 比对分类上限（超限拒绝、不读入内存），再整读 base64。
    const hit = EXT_CATEGORY[ext];
    if (hit) {
      const limit = LIMIT_BY_CATEGORY[hit.category];
      if (st.size > limit) {
        return { ok: false, message: `${ext} 过大（>${MB_BY_CATEGORY[hit.category]} MB），请用外部程序打开` };
      }
      const buf = await readFile(resolved);
      return { ok: true, kind: 'blob', category: hit.category, base64: buf.toString('base64'), mime: hit.mime, size: st.size };
    }
    // ⑥ 文本类（未命中分发表的扩展一律按文本）：只读前 MAX_TEXT+1 字节（+1 仅为判定截断）。
    const fh = await open(resolved, 'r');
    try {
      const buf = Buffer.alloc(MAX_TEXT + 1);
      const { bytesRead } = await fh.read(buf, 0, MAX_TEXT + 1, 0);
      // UTF-16 BOM 文本（2026-11-05 计划 §2.6）：BOM 感知解码器命中（binary:false 且 bom 非空）
      // → 转码文本直接返回（转码文本无残缺序列，不做 U+FFFD 尾修剪）。
      const decoded = decodeTextBuffer(buf.subarray(0, bytesRead));
      if (decoded.binary === false && decoded.bom !== null) {
        const truncated = decoded.text.length > MAX_TEXT || st.size > MAX_TEXT;
        return { ok: true, kind: 'text', content: decoded.text.slice(0, MAX_TEXT), size: st.size, truncated };
      }
      if (isProbablyBinary(buf.subarray(0, bytesRead))) return { ok: false, message: '二进制文件不支持预览' };
      if (st.size === 0) return { ok: true, kind: 'text', content: '', size: 0, truncated: false };
      const truncated = st.size > MAX_TEXT;
      let text = new TextDecoder('utf-8').decode(buf.subarray(0, Math.min(bytesRead, MAX_TEXT)));
      // 多字节 UTF-8 恰跨截断边界时非致命解码尾部产生一个 U+FFFD，去掉恰好一个（完整残缺序列只会有一个）。
      if (truncated && text.endsWith('\uFFFD')) text = text.slice(0, -1);
      return { ok: true, kind: 'text', content: text, size: st.size, truncated };
    } finally {
      await fh.close();
    }
  } catch (err) {
    // ⑦ fs 异常归一：ENOENT → missing（与 ② 同语义）；其余（EACCES/EBUSY 等）→ 温和失败文案。
    if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { ok: true, kind: 'missing' };
    const code = (err as NodeJS.ErrnoException | null)?.code;
    return { ok: false, message: `无法读取文件（${code ?? (err as Error)?.message ?? '未知错误'}）` };
  }
}
