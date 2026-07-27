// 附件 → Agent SDK prompt 构造器。
// 只负责把已校验的附件记录/路径转成 SDK 输入与 additionalDirectories；
// 不碰 IPC、不写数据库、不改 UI。图片走 image base64 块，文档/文件走受控路径说明。
// 本文件刻意不依赖 electron / attachment-storage，便于 regression 在 Node 下直接导入。
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

import type { AttachmentRecord, ChatSendPayload } from '../../shared/types/attachment';
import {
  ATTACHMENT_DEFAULT_INSTRUCTION,
  AttachmentInputError,
  computeBase64Bytes,
  isEmptySubmission,
  isSupportedDirectImage,
  validateSendBudget,
} from './attachment-policy';

/** SDK query 接受的 prompt：纯文字走 string；含图片时走只 yield 一次的用户消息流。 */
export type SdkPrompt = string | AsyncIterable<SDKUserMessage>;

export interface PreparedAttachmentPrompt {
  prompt: SdkPrompt;
  additionalDirectories: string[];
  attachmentIds: string[];
  /** 写入 messages.content / 乐观消息 / 标题的用户原文；附件-only 时为 ''，绝不含默认指令/路径/Base64。 */
  displayText: string;
}

type ImageMediaType = 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';

type TextContentBlock = { type: 'text'; text: string };
type ImageContentBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: ImageMediaType; data: string };
};
type UserContentBlock = TextContentBlock | ImageContentBlock;

const DIRECT_IMAGE_MEDIA = new Set<string>(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

/** 规格建议的图片编码后请求预算（与产品总附件 50MB 解耦）。 */
const MAX_ENCODED_IMAGE_REQUEST_BYTES = 30 * 1024 * 1024;

function asImageMediaType(mimeType: string): ImageMediaType {
  const normalized = mimeType.trim().toLowerCase();
  if (!DIRECT_IMAGE_MEDIA.has(normalized)) {
    throw new AttachmentInputError(`不支持的图片类型：${mimeType}`);
  }
  return normalized as ImageMediaType;
}

function normalizeAbs(p: string): string {
  const resolved = path.resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/** storageKey 相对段规范化（不要 path.resolve，否则会拼 cwd）。 */
function normalizeStorageKeyTail(storageKey: string): string {
  const withSep = storageKey.replace(/\\/g, '/').split('/').filter(Boolean).join(path.sep);
  return process.platform === 'win32' ? withSep.toLowerCase() : withSep;
}

/**
 * 强校验路径必须精确对应 storageKey（sessionId/attachmentId/filename），
 * 且位于会话附件根之下。不使用 lastIndexOf(sessionId) 启发式，也不依赖 electron userData。
 * 返回 { absolutePath, sessionRoot }。
 */
function resolveAndAssertAttachmentPath(
  sessionId: string,
  record: AttachmentRecord,
  rawPath: string | undefined,
): { absolutePath: string; sessionRoot: string } {
  if (!rawPath || typeof rawPath !== 'string') {
    throw new AttachmentInputError(`附件「${record.filename}」缺少有效存储路径。`);
  }
  const storageKey = record.storageKey.replace(/\\/g, '/');
  const expectedPrefix = `${sessionId}/`;
  if (!storageKey.startsWith(expectedPrefix) || storageKey.split('/').length < 3) {
    throw new AttachmentInputError(`附件「${record.filename}」存储键无效。`);
  }
  if (!storageKey.startsWith(`${sessionId}/${record.id}/`)) {
    throw new AttachmentInputError(`附件「${record.filename}」存储键与附件 ID 不一致。`);
  }

  const absolutePath = path.resolve(rawPath);
  const absNorm = normalizeAbs(absolutePath);
  const keyTail = normalizeStorageKeyTail(storageKey);
  // absolutePath 必须以完整 storageKey 相对段结尾，防止 C:\evil\<sessionId>\secret 一类越权。
  if (absNorm !== keyTail && !absNorm.endsWith(path.sep + keyTail) && !absNorm.endsWith(keyTail)) {
    throw new AttachmentInputError(`附件「${record.filename}」路径与受控存储不一致。`);
  }

  // sessionRoot = absolutePath 去掉 /attachmentId/filename 后的目录（含 sessionId）
  const sessionRoot = path.resolve(absolutePath, '..', '..');
  const sessionRootName = path.basename(sessionRoot);
  if (process.platform === 'win32') {
    if (sessionRootName.toLowerCase() !== sessionId.toLowerCase()) {
      throw new AttachmentInputError(`附件「${record.filename}」不在当前会话的受控目录内。`);
    }
  } else if (sessionRootName !== sessionId) {
    throw new AttachmentInputError(`附件「${record.filename}」不在当前会话的受控目录内。`);
  }

  // containment：relative 不得跳出 sessionRoot
  const rel = path.relative(sessionRoot, absolutePath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new AttachmentInputError(`附件「${record.filename}」不在当前会话的受控目录内。`);
  }

  return { absolutePath, sessionRoot: path.resolve(sessionRoot) };
}

function buildFileInstruction(filename: string, absolutePath: string): string {
  return `附件 \`${filename}\` 位于 \`${absolutePath}\`，请使用 Read 工具读取。`;
}

/**
 * 组装 SDK 文本块：
 * - 有文件说明时先写路径说明；
 * - 有用户文字时追加用户文字；
 * - 无用户文字时追加默认指令（只进 SDK，不进 displayText）。
 */
function buildSdkText(userText: string, fileInstructions: string[]): string {
  const chunks: string[] = [];
  if (fileInstructions.length > 0) {
    chunks.push(fileInstructions.join('\n'));
  }
  if (userText) {
    chunks.push(userText);
  } else {
    chunks.push(ATTACHMENT_DEFAULT_INSTRUCTION);
  }
  return chunks.join('\n\n');
}

function assertPayloadAttachmentIdsMatch(
  payloadIds: string[],
  attachments: AttachmentRecord[],
): void {
  if (payloadIds.length !== attachments.length) {
    throw new AttachmentInputError('附件列表与发送载荷不一致。');
  }
  for (let i = 0; i < payloadIds.length; i += 1) {
    if (payloadIds[i] !== attachments[i]?.id) {
      throw new AttachmentInputError('附件列表与发送载荷顺序或内容不一致。');
    }
  }
}

/**
 * 根据已校验附件构造 SDK prompt。
 * - 无附件：原样返回 trim 后的文字字符串；
 * - 无图片（仅文档/文件）：字符串 prompt（路径说明 + 用户文字/默认指令）；
 * - 有图片：只 yield 一条 SDKUserMessage 的异步流（image 块在前，文本块在后）。
 */
export async function prepareAttachmentPrompt(input: {
  sessionId: string;
  payload: ChatSendPayload;
  attachments: AttachmentRecord[];
  attachmentPaths: Record<string, string>;
}): Promise<PreparedAttachmentPrompt> {
  const { sessionId, payload, attachments, attachmentPaths } = input;
  const displayText = (payload.text ?? '').trim();
  const payloadIds = Array.isArray(payload.attachmentIds) ? payload.attachmentIds : [];

  assertPayloadAttachmentIdsMatch(payloadIds, attachments);

  const attachmentIds = attachments.map((item) => item.id);
  if (isEmptySubmission(displayText, attachmentIds)) {
    throw new AttachmentInputError('请输入文字或添加附件后再发送。');
  }

  if (attachments.length === 0) {
    return {
      prompt: displayText,
      additionalDirectories: [],
      attachmentIds: [],
      displayText,
    };
  }

  const resolvedPaths: string[] = [];
  const sessionRoots = new Set<string>();
  for (const record of attachments) {
    const { absolutePath, sessionRoot } = resolveAndAssertAttachmentPath(
      sessionId,
      record,
      attachmentPaths[record.id],
    );
    resolvedPaths.push(absolutePath);
    sessionRoots.add(sessionRoot);
  }

  const images: Array<{ record: AttachmentRecord; absolutePath: string }> = [];
  const pathFiles: Array<{ record: AttachmentRecord; absolutePath: string }> = [];
  attachments.forEach((record, index) => {
    const absolutePath = resolvedPaths[index]!;
    if (record.kind === 'image' && isSupportedDirectImage(record.mimeType)) {
      images.push({ record, absolutePath });
    } else {
      pathFiles.push({ record, absolutePath });
    }
  });

  // path-only：发送前确认文件仍在，避免“发送成功”后到 Read 才失败。
  for (const { record, absolutePath } of pathFiles) {
    try {
      await fsp.access(absolutePath);
    } catch {
      throw new AttachmentInputError(`附件「${record.filename}」无法读取，可能已被删除或损坏。`);
    }
  }

  const fileInstructions = pathFiles.map(({ record, absolutePath }) =>
    buildFileInstruction(record.filename, absolutePath),
  );

  // 先用元数据做预算预检（快速失败）；有图片时读盘后再用真实字节复核。
  const metaBudgetItems: Array<{ kind: AttachmentRecord['kind']; sizeBytes: number; encodedImageBytes?: number }> = [];
  for (const { record } of images) {
    metaBudgetItems.push({
      kind: 'image',
      sizeBytes: record.sizeBytes,
      encodedImageBytes: computeBase64Bytes(record.sizeBytes),
    });
  }
  for (const { record } of pathFiles) {
    metaBudgetItems.push({ kind: record.kind, sizeBytes: record.sizeBytes });
  }
  const metaBudget = validateSendBudget(metaBudgetItems);
  if (!metaBudget.ok) throw new AttachmentInputError(metaBudget.message);

  const additionalDirectories = [...sessionRoots];

  // 无图片：保持字符串 prompt 旧路径（resume/cwd 行为不变）。
  if (images.length === 0) {
    return {
      prompt: buildSdkText(displayText, fileInstructions),
      additionalDirectories,
      attachmentIds,
      displayText,
    };
  }

  // 有图片：读盘 → 真实字节预算 → base64（不带 data: 前缀）→ 单条 AsyncIterable 用户消息。
  const imageBlocks: ImageContentBlock[] = [];
  const realBudgetItems: Array<{ kind: AttachmentRecord['kind']; sizeBytes: number; encodedImageBytes?: number }> = [];
  let encodedImageTotal = 0;

  for (const { record, absolutePath } of images) {
    let bytes: Buffer;
    try {
      bytes = await fsp.readFile(absolutePath);
    } catch {
      throw new AttachmentInputError(`附件「${record.filename}」无法读取，可能已被删除或损坏。`);
    }
    if (bytes.byteLength <= 0) {
      throw new AttachmentInputError(`附件「${record.filename}」内容为空。`);
    }
    const encoded = computeBase64Bytes(bytes.byteLength);
    encodedImageTotal += encoded;
    realBudgetItems.push({
      kind: 'image',
      sizeBytes: bytes.byteLength,
      encodedImageBytes: encoded,
    });
    const mediaType = asImageMediaType(record.mimeType);
    imageBlocks.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: bytes.toString('base64'),
      },
    });
  }
  for (const { record } of pathFiles) {
    realBudgetItems.push({ kind: record.kind, sizeBytes: record.sizeBytes });
  }
  const realBudget = validateSendBudget(realBudgetItems);
  if (!realBudget.ok) throw new AttachmentInputError(realBudget.message);
  if (encodedImageTotal > MAX_ENCODED_IMAGE_REQUEST_BYTES) {
    throw new AttachmentInputError(
      `图片编码后约 ${Math.ceil(encodedImageTotal / (1024 * 1024))} MB，超过约 30 MB 请求上限，请减少图片或压缩后重试。`,
    );
  }

  const textForSdk = buildSdkText(displayText, fileInstructions);
  const content: UserContentBlock[] = [...imageBlocks, { type: 'text', text: textForSdk }];

  const userMessage: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content,
    },
  };

  // 可重复迭代的 AsyncIterable：每次 [Symbol.asyncIterator]() 都新建一个生成器，
  // 确保 runQuery 的 resume 失败重试二次消费 prompt 时（sdk-backend.ts）不丢图片。
  // Task 7B：task/waiting 路径与 stale-resume 后第二次 query 都依赖此可重复性。
  const repeatablePrompt: AsyncIterable<SDKUserMessage> = {
    async *[Symbol.asyncIterator]() {
      yield userMessage;
    },
  };

  return {
    prompt: repeatablePrompt,
    additionalDirectories,
    attachmentIds,
    displayText,
  };
}
