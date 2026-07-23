// 附件校验纯策略：MIME + 魔数 + 扩展名 + 大小 + 图片尺寸 + 总传输预算。
// 纯函数，无 Electron/Node 副作用；regression 脚本与主进程 IPC/service 共用同一份判定逻辑。
// 附件数量、大小、MIME 常量统一在此定义，避免跨层重复（见 CLAUDE.md「关键设计决策」）。
import type { AttachmentKind } from '../../shared/types/attachment';

export const MAX_ATTACHMENTS_PER_SEND = 10;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
export const MAX_IMAGE_LONG_EDGE = 8000;
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

function formatBytes(n: number): string {
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
  return base.length > 0 ? base : 'attachment';
}

/** 判定一次提交是否完全为空（无文字且无附件）——空提交应被发送链路拒绝。 */
export function isEmptySubmission(text: string, attachmentIds: readonly string[]): boolean {
  return (text ?? '').trim() === '' && attachmentIds.length === 0;
}
