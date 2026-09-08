// 附件校验纯策略：MIME + 魔数 + 扩展名 + 大小 + 图片尺寸 + 总传输预算。
// 纯函数，无 Electron/Node 副作用；regression 脚本与主进程 IPC/service 共用同一份判定逻辑。
// 附件数量、大小、MIME 常量统一在此定义，避免跨层重复（见 CLAUDE.md「关键设计决策」）。
import type { AttachmentKind, ChatSendPayload } from '../../shared/types/attachment';

export const MAX_ATTACHMENTS_PER_SEND = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_LONG_EDGE = 8000;
/**
 * P1-7 读盘守卫阈值：ATTACHMENT_PICK / 拖放粘贴在读入内存前先按此值早退（超限文件
 * 不进 Buffer/arrayBuffer，防数 GB 文件把主进程/renderer 打爆）。取两档上限的覆盖最大值
 * （max(图片 10MiB, 文件 30MiB) 再留余量）；精确的 10/30MiB 区分仍由 validateAttachmentBytes 裁定。
 */
export const ATTACHMENT_READ_GUARD_BYTES = 32 * 1024 * 1024;
/** 无文字时的默认 SDK 指令：只进入 SDK prompt，绝不写入 messages.content，也不在 UI 展示。 */
export const ATTACHMENT_DEFAULT_INSTRUCTION = '请阅读并分析这些附件。';

/** 附件输入构造错误：空提交、伪装图片、超限等。仅 SDK 输入构造与 IPC 校验使用。 */
export class AttachmentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AttachmentInputError';
  }
}

/** 可直接送入模型的栅格图片 MIME（markdown-it/Anthropic image block 均支持这四种）。 */
const DIRECT_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** 可被 Claude Code Read 工具读取的「常见文档」扩展名（文本/源码/数据/笔记本）。 */
const READABLE_DOCUMENT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.pdf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.vue', '.svelte', '.astro',
  '.json', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.csv', '.tsv', '.ipynb',
  '.py', '.pyi', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cc',
  '.cs', '.go', '.rs', '.rb', '.php', '.swift', '.scala', '.clj',
  '.sh', '.bash', '.zsh', '.ps1', '.bat',
  '.sql', '.graphql', '.gql',
  '.html', '.htm', '.css', '.scss', '.less',
  // svg 作为可读文档（XML 文本），不作为直接图片送模型。
  '.xml', '.svg',
]);

function normalizeMimeType(mimeType: string): string {
  return (mimeType ?? '').trim().toLowerCase();
}

function getExtension(filename: string): string {
  const clean = filename ?? '';
  const dot = clean.lastIndexOf('.');
  if (dot < 0) return '';
  return clean.slice(dot).toLowerCase();
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${Math.round(n / (1024 * 1024))} MiB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KiB`;
  return `${n} B`;
}

export function isSupportedDirectImage(mimeType: string): boolean {
  return DIRECT_IMAGE_MIME.has(normalizeMimeType(mimeType));
}

/** 是否为可被 Claude Code Read 工具读取的文档（按 MIME 或扩展名判定，魔数由 validate 阶段复核）。 */
export function isPathReadableDocument(mimeType: string, filename: string): boolean {
  const mime = normalizeMimeType(mimeType);
  if (
    mime === 'application/pdf' ||
    mime === 'text/plain' || mime === 'text/markdown' ||
    mime === 'application/json' ||
    mime === 'application/x-yaml' || mime === 'application/yaml' ||
    mime.startsWith('text/')
  ) {
    return true;
  }
  return READABLE_DOCUMENT_EXTENSIONS.has(getExtension(filename));
}

export function classifyAttachment(filename: string, mimeType: string): AttachmentKind {
  if (isSupportedDirectImage(mimeType)) return 'image';
  // 扩展名是图片但 MIME 不在直传集合（如 image/svg+xml、image/bmp）→ 不归 image，落到 document/file。
  if (isPathReadableDocument(mimeType, filename)) return 'document';
  return 'file';
}

function bytesEqual(bytes: Uint8Array, offset: number, signature: number[]): boolean {
  if (offset + signature.length > bytes.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[offset + i] !== signature[i]) return false;
  }
  return true;
}

const SIGNATURE_PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIGNATURE_JPEG = [0xff, 0xd8, 0xff];
const SIGNATURE_GIF = [0x47, 0x49, 0x46, 0x38]; // "GIF8"
const SIGNATURE_RIFF = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const SIGNATURE_WEBP = [0x57, 0x45, 0x42, 0x50]; // "WEBP" @ offset 8
const SIGNATURE_PDF = [0x25, 0x50, 0x44, 0x46]; // "%PDF"

/** 据魔数判定真实栅格图片格式；返回 null 表示内容不是受支持的直传图片。 */
export function detectDirectImageFormat(
  bytes: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
  if (bytesEqual(bytes, 0, SIGNATURE_PNG)) return 'image/png';
  if (bytesEqual(bytes, 0, SIGNATURE_JPEG)) return 'image/jpeg';
  if (bytesEqual(bytes, 0, SIGNATURE_GIF)) return 'image/gif';
  if (bytesEqual(bytes, 0, SIGNATURE_RIFF) && bytesEqual(bytes, 8, SIGNATURE_WEBP)) return 'image/webp';
  return null;
}

export function isPdfMagic(bytes: Uint8Array): boolean {
  return bytesEqual(bytes, 0, SIGNATURE_PDF);
}

// ── P1-8：GIF/WebP 尺寸自研解析（纯函数）──
// 运行时探针结论（scripts/p1-08-nativeimage-probe.js，Electron 35 实测）：
// nativeImage.createFromBuffer 对 GIF 与 WebP（VP8L 无损 / VP8X 扩展头）全部 isEmpty（解码失败），
// PNG 对照组正常 → GIF/WebP 附件无法走 nativeImage 拿尺寸，须按魔数自研解析兜底。

/** GIF 逻辑尺寸：头部字节 6-9（LE16 宽、LE16 高）；动图取首帧画布逻辑尺寸（即该字段）。 */
export function probeGifDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 10 || !bytesEqual(bytes, 0, SIGNATURE_GIF)) return null;
  const width = bytes[6] | (bytes[7] << 8);
  const height = bytes[8] | (bytes[9] << 8);
  if (width <= 0 || height <= 0) return null;
  return { width, height };
}

/** WebP 尺寸：RIFF+WEBP 容器内按 chunk 四字符码分派（VP8 有损 / VP8L 无损 / VP8X 扩展头）。 */
export function probeWebpDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 20) return null;
  if (!bytesEqual(bytes, 0, SIGNATURE_RIFF) || !bytesEqual(bytes, 8, SIGNATURE_WEBP)) return null;
  const fourcc = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (fourcc === 'VP8 ') {
    // 有损关键帧：数据段偏移 20 起——3B 帧标签 + 3B 起始码(9D 01 2A) + 宽高各 u16LE 低 14 位。
    if (bytes.length < 30) return null;
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null;
    const width = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
    const height = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  if (fourcc === 'VP8L') {
    // 无损：数据段首字节签名 0x2f，随后 32 位——低 14 位 width-1，次 14 位 height-1。
    if (bytes.length < 25 || bytes[20] !== 0x2f) return null;
    const bits = bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24);
    // +1 后恒 ≥1（规范保证），无需再判空。
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (fourcc === 'VP8X') {
    // 扩展头：数据段（偏移 20 起）4-6 = canvas width-1（u24LE）、7-9 = canvas height-1（u24LE）。
    if (bytes.length < 30) return null;
    const width = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
    const height = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
    return width > 0 && height > 0 ? { width, height } : null;
  }
  return null;
}

/**
 * 按附件大小判定是否在单文件上限内（与字节内容解耦，便于 IPC 二次校验直接传字节数）。
 * 图片走 MAX_IMAGE_BYTES，文档/普通文件走 MAX_FILE_BYTES。
 */
export function validateAttachmentSize(
  kind: AttachmentKind,
  sizeBytes: number,
  filename: string,
): { ok: true } | { ok: false; message: string } {
  if (kind === 'image') {
    if (sizeBytes > MAX_IMAGE_BYTES) {
      return { ok: false, message: `图片「${filename}」超过 ${formatBytes(MAX_IMAGE_BYTES)} 上限。` };
    }
    return { ok: true };
  }
  if (sizeBytes > MAX_FILE_BYTES) {
    return { ok: false, message: `文件「${filename}」超过 ${formatBytes(MAX_FILE_BYTES)} 上限。` };
  }
  return { ok: true };
}

/**
 * 字节级校验：MIME/扩展名声明必须与内容魔数一致，拒绝只改扩展名的伪装图片/伪装 PDF。
 * 失败信息只含可展示文件名与原因，不暴露内部路径。
 */
export function validateAttachmentBytes(input: {
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): { ok: true; kind: AttachmentKind } | { ok: false; message: string } {
  const { filename, mimeType, bytes } = input;
  const sizeBytes = bytes.byteLength;
  const kind = classifyAttachment(filename, mimeType);

  if (kind === 'image') {
    const detected = detectDirectImageFormat(bytes);
    if (!detected) {
      return {
        ok: false,
        message: `附件「${filename}」的内容不是受支持的图片（仅支持 JPEG/PNG/GIF/WebP），请勿通过改扩展名伪装图片。`,
      };
    }
    const sizeCheck = validateAttachmentSize(kind, sizeBytes, filename);
    if (!sizeCheck.ok) return sizeCheck;
    return { ok: true, kind: 'image' };
  }

  // 非图片：声明为 PDF 时复核 %PDF- 魔数，拒绝伪装 PDF。
  const declaredPdf = getExtension(filename) === '.pdf' || normalizeMimeType(mimeType) === 'application/pdf';
  if (declaredPdf && !isPdfMagic(bytes)) {
    return { ok: false, message: `附件「${filename}」声明为 PDF 但内容不是有效的 PDF 文件。` };
  }

  const sizeCheck = validateAttachmentSize(kind, sizeBytes, filename);
  if (!sizeCheck.ok) return sizeCheck;
  return { ok: true, kind };
}

/** 校验图片解码后的像素尺寸：最长边不超过 MAX_IMAGE_LONG_EDGE。 */
export function validateImageDimensions(input: {
  width: number;
  height: number;
}): { ok: true } | { ok: false; message: string } {
  const longEdge = Math.max(input.width, input.height);
  if (longEdge > MAX_IMAGE_LONG_EDGE) {
    return { ok: false, message: `图片「最长边 ${longEdge}px」超过 ${MAX_IMAGE_LONG_EDGE}px 上限。` };
  }
  return { ok: true };
}

/** 估算字节序列 Base64 编码后的长度（图片走模型时按编码后长度计入传输预算）。 */
export function computeBase64Bytes(byteLength: number): number {
  return Math.ceil(byteLength / 3) * 4;
}

/**
 * 校验单次发送的整体预算：附件数量与总传输字节数。
 * 图片按 Base64 编码后长度计入（用 encodedImageBytes 或由 sizeBytes 推算），其余按原始字节。
 */
export function validateSendBudget(items: Array<{
  kind: AttachmentKind;
  sizeBytes: number;
  encodedImageBytes?: number;
}>): { ok: true } | { ok: false; message: string } {
  if (items.length > MAX_ATTACHMENTS_PER_SEND) {
    return {
      ok: false,
      message: `一次最多发送 ${MAX_ATTACHMENTS_PER_SEND} 个附件，当前 ${items.length} 个。`,
    };
  }
  let total = 0;
  for (const item of items) {
    total += item.kind === 'image'
      ? (item.encodedImageBytes ?? computeBase64Bytes(item.sizeBytes))
      : item.sizeBytes;
  }
  if (total > MAX_TOTAL_BYTES) {
    return {
      ok: false,
      message: `附件总传输量约 ${formatBytes(total)}，超过 ${formatBytes(MAX_TOTAL_BYTES)} 上限，请减少附件或拆分发送。`,
    };
  }
  return { ok: true };
}

/**
 * 安全化附件文件名：只保留 basename，剔除路径分隔符、`..` 穿越片段与控制字符。
 * 全部剔除后为空时返回 'attachment' 兜底（storageKey 中的 <attachmentId> 由 storage 层另拼）。
 */
export function sanitizeAttachmentFilename(filename: string): string {
  const raw = filename ?? '';
  const segments = raw.split(/[/\\]/);
  let base = segments[segments.length - 1] ?? '';
  base = base.replace(/\.\./g, '').replace(/[\x00-\x1f\x7f]/g, '').replace(/[/\\]/g, '').trim();
  // P3-11：Windows 保留设备名（CON.txt/NUL/COM1.md 等）在 Windows 上无法创建/写入且报错
  // 不解释——首段命中保留名时加 file_ 前缀改写。
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(base)) {
    base = `file_${base}`;
  }
  return base.length > 0 ? base : 'attachment';
}

/** 判定一次提交是否完全为空（无文字且无附件）——空提交应被发送链路拒绝。 */
export function isEmptySubmission(text: string, attachmentIds: readonly string[]): boolean {
  return (text ?? '').trim() === '' && attachmentIds.length === 0;
}

/** clientMessageId 必须是 UUID（renderer 用 crypto.randomUUID() 生成，v4）。 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 统一发送载荷的形状校验（CHAT_SEND / TASK_ADD / QUEUE_USER_MESSAGE 共用）。
 * 纯函数、不触达 DB：只保证载荷本身合法。附件归属与 draft 状态由 attachment-service 在主进程再校验。
 * 失败信息面向用户，不暴露内部路径/键。
 */
export function validateChatSendPayloadShape(
  payload: unknown,
): { ok: true } | { ok: false; message: string } {
  if (!payload || typeof payload !== 'object') return { ok: false, message: '发送载荷格式错误。' };
  const p = payload as Record<string, unknown>;
  if (typeof p.text !== 'string') return { ok: false, message: '发送载荷缺少有效的文字字段。' };
  if (!Array.isArray(p.attachmentIds)) return { ok: false, message: '发送载荷缺少附件列表。' };
  if (p.attachmentIds.some((id) => typeof id !== 'string')) {
    return { ok: false, message: '附件 ID 列表含非字符串项。' };
  }
  if (p.attachmentIds.length > MAX_ATTACHMENTS_PER_SEND) {
    return { ok: false, message: `一次最多发送 ${MAX_ATTACHMENTS_PER_SEND} 个附件。` };
  }
  if (new Set(p.attachmentIds as string[]).size !== (p.attachmentIds as string[]).length) {
    return { ok: false, message: '附件 ID 列表含重复项。' };
  }
  if (typeof p.clientMessageId !== 'string' || !UUID_RE.test(p.clientMessageId)) {
    return { ok: false, message: '发送载荷缺少有效的消息 ID。' };
  }
  if (isEmptySubmission(p.text, p.attachmentIds as string[])) {
    return { ok: false, message: '请输入文字或添加附件后再发送。' };
  }
  return { ok: true };
}

/** 类型守卫形式：供需要窄化 unknown 为 ChatSendPayload 的调用方使用。 */
export function isChatSendPayloadShape(payload: unknown): payload is ChatSendPayload {
  return validateChatSendPayloadShape(payload).ok;
}
