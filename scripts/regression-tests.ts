import { strict as assert } from 'node:assert';
import MarkdownIt from 'markdown-it';

import { runMigrations } from '../src/main/database/migrations';
import { buildAnthropicApiUrl } from '../src/main/modules/api-url';
import {
  OTHER_INTERACTION_OPTION_ID,
  SUPPORTED_USER_DIALOG_KINDS,
  buildAskUserQuestionInteractionPayload,
  buildAskUserQuestionResult,
  buildElicitationInteractionPayload,
  buildPermissionInteractionPayload,
  buildGenericInteractionPayload,
  buildWizardAskUserQuestionPayload,
  dialogResultFromInteraction,
  elicitationResultFromInteraction,
  interactionHistoryEntryFromResponse,
  mapPermissionInteractionResponse,
  normalizeInteractionPreview,
  shouldUseVirtualOptions,
} from '../src/main/modules/sdk-interactions';
import { buildClaudeSettingsProjection } from '../src/main/modules/claude-settings-projection';
import { isMissingConversationResumeError } from '../src/main/modules/sdk-errors';
import { applyPermissionUpdates, buildPermissionSettings, coercePermissionUpdatesToSession, isToolSessionAllowed, withToolSessionAllow } from '../src/main/modules/sdk-permissions';
import { parseClaudeSettings } from '../src/main/modules/settings-importer';
import { syncFormToAdvancedJson } from '../src/shared/settings-parser';
import { normalizeSearchText } from '../src/main/utils/search-normalizer';
import { applyExternalLinkTarget, applyImageProtocolFilter, createPreviewMarkdownRenderer, isDiffContent, renderDiffHtml, renderDiffHtmlWithRenderer, renderMarkdown } from '../src/renderer/utils/markdown';
import { synthesizeToolDiff } from '../src/renderer/utils/tool-diff';
import { extractSubAgentTitle, TOOL_DIFF_TOOL_NAMES } from '../src/shared/process-kind';
import { parseStatusPorcelainV1Z, parseNumstatZ, normalizeStatus, truncateDiff } from '../src/main/modules/changes-panel';
import { parseUnifiedDiff, splitUnifiedDiff } from '../src/renderer/utils/diff-parser';
import {
  diffWordRanges,
  diffWordsOrFlat,
  DIFF_WORD_MAX_LINE_LENGTH,
  DIFF_WORD_MAX_SEGMENTS,
  DIFF_WORD_MIN_SIMILARITY,
} from '../src/renderer/utils/diff-words';
import { buildSplitRows, planSplitVisible } from '../src/renderer/utils/diff-render';
import { shouldSkipMermaidErrorRetry, summarizeMermaidAccessibleTitle } from '../src/renderer/directives/enrich-markdown';
import {
  getNavigationDisposition,
  isAllowedAppNavigation,
  isAllowedMarkdownImageUrl,
  shouldOpenExternally,
} from '../src/shared/external-links';
import {
  ATTACHMENT_DEFAULT_INSTRUCTION,
  MAX_FILE_BYTES,
  MAX_IMAGE_BYTES,
  MAX_TOTAL_BYTES,
  classifyAttachment,
  computeBase64Bytes,
  isEmptySubmission,
  isPathReadableDocument,
  isSupportedDirectImage,
  sanitizeAttachmentFilename,
  validateAttachmentBytes,
  validateAttachmentSize,
  validateImageDimensions,
  validateSendBudget,
  validateChatSendPayloadShape,
} from '../src/main/modules/attachment-policy';
import { prepareAttachmentPrompt } from '../src/main/modules/attachment-prompt-builder';
import { attachmentBadge } from '../src/renderer/utils/attachment';
import type { AttachmentRecord, ChatSendPayload } from '../src/shared/types/attachment';

// Task1：附件策略纯函数契约（MIME/魔数/归类/大小/总预算/Base64/文件名安全化/空提交）。
function testAttachmentPolicyContracts(): void {
  // —— 1. 直接图片 MIME：四类通过，SVG/BMP/TIFF 等不进直传 ——
  for (const m of ['image/jpeg', 'image/png', 'image/gif', 'image/webp']) {
    assert.equal(isSupportedDirectImage(m), true, `应支持直传图片 MIME: ${m}`);
  }
  for (const m of ['image/svg+xml', 'image/bmp', 'image/tiff', 'image/x-icon', 'application/pdf']) {
    assert.equal(isSupportedDirectImage(m), false, `不应作为直传图片 MIME: ${m}`);
  }

  // —— 2. 魔数：正确魔数通过，错误魔数（伪装图片）失败 ——
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const jpegBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]);
  const gifBytes = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0]);
  const webpBytes = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50, 0]);
  const imageFixtures: Array<{ name: string; bytes: Uint8Array; mime: string }> = [
    { name: 'png', bytes: pngBytes, mime: 'image/png' },
    { name: 'jpeg', bytes: jpegBytes, mime: 'image/jpeg' },
    { name: 'gif', bytes: gifBytes, mime: 'image/gif' },
    { name: 'webp', bytes: webpBytes, mime: 'image/webp' },
  ];
  for (const f of imageFixtures) {
    const ok = validateAttachmentBytes({ filename: `a.${f.name}`, mimeType: f.mime, bytes: f.bytes });
    assert.equal(ok.ok, true, `${f.name} 正确魔数应通过`);
  }
  const fakeImage = new Uint8Array([0x00, 0x11, 0x22, 0x33, 0x44]);
  const fakeResult = validateAttachmentBytes({ filename: 'a.png', mimeType: 'image/png', bytes: fakeImage });
  if (!fakeResult.ok) {
    assert.ok(fakeResult.message.includes('a.png'), '失败信息须含可展示文件名');
  } else {
    assert.fail('错误魔数伪装 png 应失败');
  }

  // —— 3. 可读文档扩展名 / MIME ——
  for (const ext of ['.txt', '.md', '.ts', '.js', '.vue', '.json', '.yaml', '.yml', '.csv', '.ipynb', '.pdf']) {
    assert.equal(isPathReadableDocument('application/octet-stream', `report${ext}`), true, `扩展名 ${ext} 应为可读文档`);
  }
  assert.equal(isPathReadableDocument('application/pdf', 'doc'), true, 'application/pdf 应为可读文档');
  for (const ext of ['.exe', '.zip', '.docx', '.dll', '.so']) {
    assert.equal(isPathReadableDocument('application/octet-stream', `bin${ext}`), false, `扩展名 ${ext} 不应为可读文档`);
  }

  // —— 4. 分类：图片/文档/普通文件 ——
  assert.equal(classifyAttachment('a.png', 'image/png'), 'image');
  assert.equal(classifyAttachment('a.jpg', 'image/jpeg'), 'image');
  assert.equal(classifyAttachment('report.pdf', 'application/pdf'), 'document');
  assert.equal(classifyAttachment('notes.txt', 'text/plain'), 'document');
  assert.equal(classifyAttachment('App.ts', 'application/octet-stream'), 'document');
  assert.equal(classifyAttachment('logo.svg', 'image/svg+xml'), 'document', 'svg 归 document（可 Read），不进直传');
  assert.equal(classifyAttachment('arch.zip', 'application/zip'), 'file');
  assert.equal(classifyAttachment('setup.exe', 'application/octet-stream'), 'file');

  // —— 5. 数量上限：10 通过，第 11 个失败 ——
  const ten = Array.from({ length: 10 }, () => ({ kind: 'file' as const, sizeBytes: 100 }));
  assert.equal(validateSendBudget(ten).ok, true, '10 个附件应通过');
  const eleven = Array.from({ length: 11 }, () => ({ kind: 'file' as const, sizeBytes: 100 }));
  assert.equal(validateSendBudget(eleven).ok, false, '11 个附件应失败');

  // —— 6. 单文件大小边界 ——
  assert.equal(validateAttachmentSize('image', MAX_IMAGE_BYTES, 'a.png').ok, true, '图片至上限应通过');
  assert.equal(validateAttachmentSize('image', MAX_IMAGE_BYTES + 1, 'a.png').ok, false, '图片超上限应失败');
  assert.equal(validateAttachmentSize('file', MAX_FILE_BYTES, 'a.bin').ok, true, '文件至上限应通过');
  assert.equal(validateAttachmentSize('file', MAX_FILE_BYTES + 1, 'a.bin').ok, false, '文件超上限应失败');

  // —— 7. 总字节预算失败返回可读中文 ——
  const over = validateSendBudget([
    { kind: 'file', sizeBytes: MAX_FILE_BYTES },
    { kind: 'file', sizeBytes: MAX_FILE_BYTES },
  ]);
  if (!over.ok) {
    assert.ok(over.message.length > 0, '总字节超限须返回可读中文');
  } else {
    assert.fail('总字节超限应失败');
  }

  // —— 8. 图片预算按 Base64 编码后长度（而非原始字节）——
  const rawBytes = 12 * 1024 * 1024;
  const encoded = computeBase64Bytes(rawBytes);
  assert.equal(encoded, Math.ceil(rawBytes / 3) * 4);
  assert.equal(
    validateSendBudget([{ kind: 'image', sizeBytes: rawBytes, encodedImageBytes: encoded }]).ok,
    true,
    '提供 encodedImageBytes 时应以编码后长度为准且可通过',
  );
  // 原始 sizeBytes 极小，但 encodedImageBytes 巨大 → 必须失败，证明用的是编码后长度。
  const encodedOver = validateSendBudget([
    { kind: 'image', sizeBytes: 1, encodedImageBytes: MAX_TOTAL_BYTES + 1 },
  ]);
  if (!encodedOver.ok) {
    assert.ok(encodedOver.message.length > 0);
  } else {
    assert.fail('图片预算须按编码后长度判定，而非原始字节');
  }

  // —— 9. 文件名安全化：basename / .. / 斜杠 / 控制字符 / 空兜底 ——
  assert.equal(sanitizeAttachmentFilename('dir/sub/a.png'), 'a.png', '须只保留 basename');
  assert.equal(sanitizeAttachmentFilename('..\\evil.txt'), 'evil.txt', '须剔除路径分隔符与 ..');
  assert.equal(sanitizeAttachmentFilename('a\x00b\x01c.png'), 'abc.png', '须剔除控制字符');
  assert.equal(sanitizeAttachmentFilename('..'), 'attachment', '.. 单独须兜底');
  assert.equal(sanitizeAttachmentFilename(''), 'attachment', '空文件名须兜底');
  assert.equal(sanitizeAttachmentFilename('   '), 'attachment', '全空白须兜底');

  // —— 10. 空提交判定：有附件允许，二者皆空拒绝 ——
  assert.equal(isEmptySubmission('', ['att-1']), false, '有附件不算空提交');
  assert.equal(isEmptySubmission('', []), true, '无文字无附件为空提交');
  assert.equal(isEmptySubmission('   ', []), true, '纯空白为空提交');
  assert.equal(isEmptySubmission('hi', []), false, '有文字不为空');

  // —— 图片尺寸最长边上限 ——
  assert.equal(validateImageDimensions({ width: 8000, height: 6000 }).ok, true, '最长边 8000 应通过');
  assert.equal(validateImageDimensions({ width: 8001, height: 100 }).ok, false, '最长边超 8000 应失败');

  // —— 默认指令常量 ——
  assert.equal(ATTACHMENT_DEFAULT_INSTRUCTION, '请阅读并分析这些附件。');

  // —— PDF 魔数复核：真 PDF 通过，伪装 PDF 失败 ——
  const realPdf = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0]);
  assert.equal(
    validateAttachmentBytes({ filename: 'a.pdf', mimeType: 'application/pdf', bytes: realPdf }).ok,
    true,
    '真 PDF 魔数应通过',
  );
  const fakePdf = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
  assert.equal(
    validateAttachmentBytes({ filename: 'a.pdf', mimeType: 'application/pdf', bytes: fakePdf }).ok,
    false,
    '伪装 PDF 应失败',
  );
}

// Task3：统一发送载荷 ChatSendPayload 形状校验（CHAT_SEND/TASK_ADD/QUEUE_USER_MESSAGE 共用）。
// 纯函数行为契约：合法通过；缺字段/超限/重复/坏 UUID/空提交拒绝；附件-only（空文字）允许。
function testChatSendPayloadShapeContracts(): void {
  const check = (p: unknown) => validateChatSendPayloadShape(p);
  // 合法 v4 UUID（version nibble=4，variant nibble∈8/9/a/b）。
  const UUID = '11111111-1111-4111-8111-111111111111';

  assert.equal(check({ text: 'hi', attachmentIds: [], clientMessageId: UUID }).ok, true, '合法载荷应通过');
  assert.equal(check({ text: '', attachmentIds: ['a', 'b'], clientMessageId: UUID }).ok, true, '附件-only（空文字）应允许');

  assert.equal(check(null).ok, false, 'null 应拒绝');
  assert.equal(check(undefined).ok, false, 'undefined 应拒绝');
  assert.equal(check('str').ok, false, '非对象应拒绝');
  assert.equal(check({ attachmentIds: [], clientMessageId: UUID }).ok, false, '缺 text 应拒绝');
  assert.equal(check({ text: 'hi', clientMessageId: UUID }).ok, false, '缺 attachmentIds 应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: 'x', clientMessageId: UUID }).ok, false, 'attachmentIds 非数组应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: [1, 2], clientMessageId: UUID }).ok, false, 'attachmentIds 含非字符串应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: Array(11).fill('a'), clientMessageId: UUID }).ok, false, '附件超 10 应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: ['a', 'a'], clientMessageId: UUID }).ok, false, '重复附件 ID 应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: [], clientMessageId: 'not-a-uuid' }).ok, false, '非法 clientMessageId 应拒绝');
  assert.equal(check({ text: 'hi', attachmentIds: [], clientMessageId: '' }).ok, false, '空 clientMessageId 应拒绝');
  assert.equal(check({ text: '', attachmentIds: [], clientMessageId: UUID }).ok, false, '文字与附件均空应拒绝');

  // 附件 IPC + preload + handler 源码接线契约。
  const fs = require('node:fs') as typeof import('node:fs');
  const ipcTypes = fs.readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
  const preloadApi = fs.readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  const ipcHandlers = fs.readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const useChat = fs.readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  const taskStore = fs.readFileSync(new URL('../src/renderer/stores/task-store.ts', import.meta.url), 'utf8');

  // 4 个附件通道
  assert.ok(ipcTypes.includes("ATTACHMENT_PICK: 'attachment:pick'"), '须有 ATTACHMENT_PICK 通道');
  assert.ok(ipcTypes.includes("ATTACHMENT_STAGE_BYTES: 'attachment:stageBytes'"), '须有 ATTACHMENT_STAGE_BYTES 通道');
  assert.ok(ipcTypes.includes("ATTACHMENT_PREVIEW: 'attachment:preview'"), '须有 ATTACHMENT_PREVIEW 通道');
  assert.ok(ipcTypes.includes("ATTACHMENT_REMOVE_DRAFT: 'attachment:removeDraft'"), '须有 ATTACHMENT_REMOVE_DRAFT 通道');
  assert.ok(ipcTypes.includes('StageAttachmentBytesInput') && ipcTypes.includes('AttachmentPreviewRequest'), '须定义两个附件入参类型');

  // preload 暴露 4 方法 + 3 发送改 ChatSendPayload
  assert.ok(preloadApi.includes('pickAttachments:'), 'preload 须暴露 pickAttachments');
  assert.ok(preloadApi.includes('stageAttachmentBytes:'), 'preload 须暴露 stageAttachmentBytes');
  assert.ok(preloadApi.includes('getAttachmentPreview:'), 'preload 须暴露 getAttachmentPreview');
  assert.ok(preloadApi.includes('removeDraftAttachment:'), 'preload 须暴露 removeDraftAttachment');
  assert.ok(/sendMessage:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(preloadApi), 'sendMessage 须接收 ChatSendPayload');
  assert.ok(/addTask:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(preloadApi), 'addTask 须接收 ChatSendPayload');
  assert.ok(/queueUserMessage:\s*\(sessionId:\s*string,\s*payload:\s*ChatSendPayload\)/.test(preloadApi), 'queueUserMessage 须接收 ChatSendPayload');

  // 三发送 handler 改 ChatSendPayload 并做形状 + 归属校验
  assert.ok(/CHAT_SEND, async \(_event, sessionId: string, payload: ChatSendPayload\)/.test(ipcHandlers), 'CHAT_SEND handler 须接收 ChatSendPayload');
  assert.ok(/TASK_ADD, async \(_event, sessionId: string, payload: ChatSendPayload\)/.test(ipcHandlers), 'TASK_ADD handler 须接收 ChatSendPayload');
  assert.ok(/QUEUE_USER_MESSAGE, async \(_event, sessionId: string, payload: ChatSendPayload\)/.test(ipcHandlers), 'QUEUE_USER_MESSAGE handler 须接收 ChatSendPayload');
  const sendHandlerCount = (ipcHandlers.match(/validateChatSendPayloadShape\(payload\)/g) || []).length;
  assert.ok(sendHandlerCount >= 3, `三发送 handler 须各调 validateChatSendPayloadShape（实际 ${sendHandlerCount}）`);
  const readyCheckCount = (ipcHandlers.match(/assertAttachmentsReadyForSend\(sessionId, payload\.attachmentIds\)/g) || []).length;
  assert.ok(readyCheckCount >= 3, `三发送 handler 须各调 assertAttachmentsReadyForSend（实际 ${readyCheckCount}）`);

  // 4 附件 handler 注册（按源码字面量匹配，与既有 changes 测试一致）
  assert.ok(ipcHandlers.includes('IPC_CHANNELS.ATTACHMENT_PICK'), '须注册 ATTACHMENT_PICK handler');
  assert.ok(ipcHandlers.includes('IPC_CHANNELS.ATTACHMENT_STAGE_BYTES'), '须注册 ATTACHMENT_STAGE_BYTES handler');
  assert.ok(ipcHandlers.includes('IPC_CHANNELS.ATTACHMENT_PREVIEW'), '须注册 ATTACHMENT_PREVIEW handler');
  assert.ok(ipcHandlers.includes('IPC_CHANNELS.ATTACHMENT_REMOVE_DRAFT'), '须注册 ATTACHMENT_REMOVE_DRAFT handler');
  // 选择器用 dialog + 主进程读字节 + 魔数探测，不把路径返回 renderer
  assert.ok(ipcHandlers.includes('dialog.showOpenDialog'), 'ATTACHMENT_PICK 须用主进程 dialog');
  assert.ok(/path\.basename\(filePath\)/.test(ipcHandlers), '须只取 basename，不泄露完整路径');
  assert.ok(ipcHandlers.includes('detectDirectImageFormat(bytes)'), '须据魔数探测真实图片格式');

  // Task 5：use-chat.sendMessage / task-store.addTask / queueUserMessage 改为接收 ChatSendPayload；
  // payload 由 ChatPage 统一构造（见 testAttachmentDraftUiContracts）。
  assert.ok(/sendMessage\(payload: ChatSendPayload\)/.test(useChat), 'use-chat sendMessage 须接收 ChatSendPayload');
  assert.ok(/addTask\(sessionId: string, payload: ChatSendPayload\)/.test(taskStore), 'task-store addTask 须接收 ChatSendPayload');
  assert.ok(/queueUserMessage\(sessionId: string, payload: ChatSendPayload\)/.test(taskStore), 'task-store queueUserMessage 须接收 ChatSendPayload');
}

// Task4：prepareAttachmentPrompt 构造契约 + CHAT_SEND / sdk-backend 接线。
async function testAttachmentPromptBuilderContracts(): Promise<void> {
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const os = await import('node:os');
  const { readFileSync } = await import('node:fs');

  const UUID = '22222222-2222-4222-8222-222222222222';
  const sessionId = 'sess-attachment-prompt-1';
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-link-att-prompt-'));
  const sessionRoot = path.join(tmpRoot, sessionId);

  const pngBytes = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe,
    0xd4, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45,
    0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
  ]);

  function makeRecord(partial: Partial<AttachmentRecord> & Pick<AttachmentRecord, 'id' | 'kind' | 'filename' | 'mimeType'>): AttachmentRecord {
    return {
      id: partial.id,
      sessionId,
      kind: partial.kind,
      filename: partial.filename,
      mimeType: partial.mimeType,
      sizeBytes: partial.sizeBytes ?? 32,
      width: partial.width,
      height: partial.height,
      previewAvailable: partial.previewAvailable ?? partial.kind === 'image',
      status: partial.status ?? 'draft',
      sha256: partial.sha256 ?? 'abc',
      storageKey: partial.storageKey ?? `${sessionId}/${partial.id}/${partial.filename}`,
    };
  }

  async function writeFixture(attachmentId: string, filename: string, bytes: Buffer): Promise<string> {
    const abs = path.join(sessionRoot, attachmentId, filename);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, bytes);
    return abs;
  }

  try {
    // 1) 纯文字 → string prompt，无 additionalDirectories
    {
      const payload: ChatSendPayload = { text: '  只发文字  ', attachmentIds: [], clientMessageId: UUID };
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload,
        attachments: [],
        attachmentPaths: {},
      });
      assert.equal(typeof prepared.prompt, 'string', '纯文字须返回 string prompt');
      assert.equal(prepared.prompt, '只发文字');
      assert.equal(prepared.displayText, '只发文字');
      assert.deepEqual(prepared.additionalDirectories, []);
      assert.deepEqual(prepared.attachmentIds, []);
    }

    // 2) 文档路径型：string prompt，含受控路径说明 + additionalDirectories
    {
      const docId = 'att-doc-1';
      const abs = await writeFixture(docId, 'report.pdf', Buffer.from('%PDF-1.4 fixture'));
      const record = makeRecord({
        id: docId,
        kind: 'document',
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 16,
      });
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload: { text: '请总结', attachmentIds: [docId], clientMessageId: UUID },
        attachments: [record],
        attachmentPaths: { [docId]: abs },
      });
      assert.equal(typeof prepared.prompt, 'string', '无图片时须返回 string prompt');
      const promptText = prepared.prompt as string;
      assert.ok(promptText.includes('report.pdf'), '须含展示文件名');
      assert.ok(promptText.includes(abs), '须含受控绝对路径');
      assert.ok(promptText.includes('Read'), '须提示使用 Read 工具');
      assert.ok(promptText.includes('请总结'), '用户文字不得丢失');
      assert.equal(prepared.displayText, '请总结', 'displayText 仅为用户文字');
      assert.ok(!prepared.displayText.includes(abs), 'displayText 不得含路径');
      assert.ok(!prepared.displayText.includes(ATTACHMENT_DEFAULT_INSTRUCTION), 'displayText 不得含默认指令');
      assert.deepEqual(prepared.additionalDirectories, [sessionRoot]);
      assert.ok(!promptText.includes(record.storageKey) || promptText.includes(abs), '不得单独泄露 storageKey 语义以外的键');
    }

    // 3) 附件-only 文档：SDK 文本含默认指令，displayText 仍为空
    {
      const docId = 'att-doc-2';
      const abs = await writeFixture(docId, 'notes.txt', Buffer.from('hello notes'));
      const record = makeRecord({
        id: docId,
        kind: 'document',
        filename: 'notes.txt',
        mimeType: 'text/plain',
        sizeBytes: 11,
      });
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload: { text: '   ', attachmentIds: [docId], clientMessageId: UUID },
        attachments: [record],
        attachmentPaths: { [docId]: abs },
      });
      assert.equal(typeof prepared.prompt, 'string');
      assert.ok((prepared.prompt as string).includes(ATTACHMENT_DEFAULT_INSTRUCTION), '附件-only 须在 SDK 文本块使用默认说明');
      assert.equal(prepared.displayText, '', '附件-only 的 displayText 须为空串');
    }

    // 4) 图片：AsyncIterable，仅一条 user message；image 在 text 前；parent_tool_use_id=null
    {
      const imgId = 'att-img-1';
      const abs = await writeFixture(imgId, 'shot.png', pngBytes);
      const record = makeRecord({
        id: imgId,
        kind: 'image',
        filename: 'shot.png',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
        width: 1,
        height: 1,
      });
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload: { text: '图里有什么', attachmentIds: [imgId], clientMessageId: UUID },
        attachments: [record],
        attachmentPaths: { [imgId]: abs },
      });
      assert.equal(typeof prepared.prompt, 'object', '有图片时须返回 AsyncIterable');
      assert.equal(prepared.displayText, '图里有什么');
      assert.ok(!prepared.displayText.includes(ATTACHMENT_DEFAULT_INSTRUCTION));

      const messages: unknown[] = [];
      for await (const msg of prepared.prompt as AsyncIterable<unknown>) {
        messages.push(msg);
      }
      assert.equal(messages.length, 1, '异步流只能 yield 一条 user message');
      const userMsg = messages[0] as {
        type: string;
        parent_tool_use_id: string | null;
        message: { role: string; content: Array<Record<string, unknown>> };
      };
      assert.equal(userMsg.type, 'user');
      assert.equal(userMsg.parent_tool_use_id, null, 'parent_tool_use_id 须为 null');
      assert.equal(userMsg.message.role, 'user');
      const content = userMsg.message.content;
      assert.ok(Array.isArray(content) && content.length >= 2, '须至少有 image + text 块');
      assert.equal(content[0]?.type, 'image', 'image 块须在 text 块之前');
      const imageSource = (content[0] as { source?: { type?: string; media_type?: string; data?: string } }).source;
      assert.equal(imageSource?.type, 'base64');
      assert.equal(imageSource?.media_type, 'image/png');
      assert.ok(typeof imageSource?.data === 'string' && imageSource.data.length > 0, '须有 base64 data');
      assert.ok(!imageSource?.data?.startsWith('data:'), 'Base64 不得带 data: 前缀');
      const textBlock = content.find((part) => part.type === 'text') as { text?: string } | undefined;
      assert.ok(textBlock?.text?.includes('图里有什么'), '文字与图片同时存在时文字不得丢失');
      assert.ok(!textBlock?.text?.includes(imageSource?.data ?? '___'), '文本块不得内嵌图片 Base64');
      assert.deepEqual(prepared.additionalDirectories, [sessionRoot]);

      // Task 7B：prompt 须可重复迭代（runQuery resume 重试会二次消费，不可丢图）
      const secondRun: unknown[] = [];
      for await (const msg of prepared.prompt as AsyncIterable<unknown>) {
        secondRun.push(msg);
      }
      assert.equal(secondRun.length, 1, 'Task 7B：同一 prompt 二次迭代仍须 yield 一条');
      const secondMsg = secondRun[0] as { message: { content: Array<Record<string, unknown>> } };
      assert.equal((secondMsg.message.content[0] as { type?: string }).type, 'image', '二次迭代的图片块仍须在首位');
    }

    // 5) 图片-only：SDK 文本用默认说明，displayText 为空
    {
      const imgId = 'att-img-2';
      const abs = await writeFixture(imgId, 'only.png', pngBytes);
      const record = makeRecord({
        id: imgId,
        kind: 'image',
        filename: 'only.png',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
      });
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload: { text: '', attachmentIds: [imgId], clientMessageId: UUID },
        attachments: [record],
        attachmentPaths: { [imgId]: abs },
      });
      assert.equal(prepared.displayText, '');
      const messages: Array<{ message: { content: Array<{ type: string; text?: string }> } }> = [];
      for await (const msg of prepared.prompt as AsyncIterable<(typeof messages)[number]>) {
        messages.push(msg);
      }
      const text = messages[0]?.message.content.find((part) => part.type === 'text')?.text ?? '';
      assert.equal(text, ATTACHMENT_DEFAULT_INSTRUCTION);
    }

    // 6) 空提交拒绝
    {
      let threw = false;
      try {
        await prepareAttachmentPrompt({
          sessionId,
          payload: { text: '  ', attachmentIds: [], clientMessageId: UUID },
          attachments: [],
          attachmentPaths: {},
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, '空文字且无附件须抛错');
    }

    // 7) 路径越出会话根目录须拒绝
    {
      const docId = 'att-doc-escape';
      const outside = path.join(tmpRoot, 'other-session', 'x.txt');
      await fs.mkdir(path.dirname(outside), { recursive: true });
      await fs.writeFile(outside, 'nope');
      const record = makeRecord({
        id: docId,
        kind: 'file',
        filename: 'x.txt',
        mimeType: 'text/plain',
        sizeBytes: 4,
      });
      let threw = false;
      try {
        await prepareAttachmentPrompt({
          sessionId,
          payload: { text: '读一下', attachmentIds: [docId], clientMessageId: UUID },
          attachments: [record],
          attachmentPaths: { [docId]: outside },
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, '非会话受控路径须拒绝');
    }

    // 8) 图片+文档混合：AsyncIterable，image 在前，文本含路径说明与用户文字
    {
      const imgId = 'att-mix-img';
      const docId = 'att-mix-doc';
      const imgAbs = await writeFixture(imgId, 'mix.png', pngBytes);
      const docAbs = await writeFixture(docId, 'mix.md', Buffer.from('# mix'));
      const imgRec = makeRecord({
        id: imgId,
        kind: 'image',
        filename: 'mix.png',
        mimeType: 'image/png',
        sizeBytes: pngBytes.byteLength,
      });
      const docRec = makeRecord({
        id: docId,
        kind: 'document',
        filename: 'mix.md',
        mimeType: 'text/markdown',
        sizeBytes: 5,
      });
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload: { text: '混合分析', attachmentIds: [imgId, docId], clientMessageId: UUID },
        attachments: [imgRec, docRec],
        attachmentPaths: { [imgId]: imgAbs, [docId]: docAbs },
      });
      assert.equal(typeof prepared.prompt, 'object', '混合含图须走 AsyncIterable');
      assert.equal(prepared.displayText, '混合分析');
      const messages: Array<{ message: { content: Array<Record<string, unknown>> } }> = [];
      for await (const msg of prepared.prompt as AsyncIterable<(typeof messages)[number]>) {
        messages.push(msg);
      }
      assert.equal(messages.length, 1);
      const content = messages[0]!.message.content;
      assert.equal(content[0]?.type, 'image', '混合时 image 仍须在前');
      const text = (content.find((p) => p.type === 'text') as { text?: string } | undefined)?.text ?? '';
      assert.ok(text.includes('混合分析'), '混合时用户文字不得丢');
      assert.ok(text.includes('mix.md') && text.includes(docAbs), '混合时路径说明须在文本块');
      assert.ok(!text.includes(ATTACHMENT_DEFAULT_INSTRUCTION), '有用户文字时不需默认指令');
    }

    // 9) payload.ids 与 attachments 不一致须拒绝
    {
      const docId = 'att-id-mismatch';
      const abs = await writeFixture(docId, 'm.txt', Buffer.from('x'));
      const record = makeRecord({
        id: docId,
        kind: 'document',
        filename: 'm.txt',
        mimeType: 'text/plain',
        sizeBytes: 1,
      });
      let threw = false;
      try {
        await prepareAttachmentPrompt({
          sessionId,
          payload: { text: 'x', attachmentIds: ['other-id'], clientMessageId: UUID },
          attachments: [record],
          attachmentPaths: { [docId]: abs },
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, 'payload.attachmentIds 与 attachments 不一致须拒绝');
    }

    // 10) path-only 文件缺失须拒绝
    {
      const docId = 'att-missing-file';
      const abs = path.join(sessionRoot, docId, 'gone.pdf');
      // 故意不写文件，只给路径
      const record = makeRecord({
        id: docId,
        kind: 'document',
        filename: 'gone.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 10,
      });
      let threw = false;
      try {
        await prepareAttachmentPrompt({
          sessionId,
          payload: { text: '读', attachmentIds: [docId], clientMessageId: UUID },
          attachments: [record],
          attachmentPaths: { [docId]: abs },
        });
      } catch {
        threw = true;
      }
      assert.equal(threw, true, 'path-only 文件不存在须拒绝');
    }

    // 11) 源码接线：CHAT_SEND 状态机 / 互斥 / 并集目录 / 队列显式拒绝
    {
      const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
      const sdkBackend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
      const cliShared = readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');
      const taskQueue = readFileSync(new URL('../src/main/modules/task-queue-engine.ts', import.meta.url), 'utf8');
      const builder = readFileSync(new URL('../src/main/modules/attachment-prompt-builder.ts', import.meta.url), 'utf8');
      const messageRepo = readFileSync(new URL('../src/main/database/repositories/message-repo.ts', import.meta.url), 'utf8');

      assert.ok(ipcHandlers.includes('prepareAttachmentPrompt'), 'CHAT_SEND 须调用 prepareAttachmentPrompt');
      assert.ok(ipcHandlers.includes('createMessageWithAttachments'), 'CHAT_SEND 须用 createMessageWithAttachments 落库');
      assert.ok(ipcHandlers.includes('payload.clientMessageId'), '落库 id 须使用 clientMessageId');
      assert.ok(ipcHandlers.includes('prepared.displayText'), '落库 content 须使用 displayText');
      assert.ok(ipcHandlers.includes('当前回合仍在执行'), '活 query 时须在持久化前拒绝');
      assert.ok(/getActiveProcess\(sessionId\)/.test(ipcHandlers), '须检测 active process');
      assert.ok(ipcHandlers.includes('chatSendLocks'), '须有会话级发送互斥');
      assert.ok(ipcHandlers.includes('promoteAttachments: false'), '落库时附件不得立刻升格 message');
      assert.ok(ipcHandlers.includes("markAttachmentsStatus(prepared.attachmentIds, 'message')"), 'spawn/send 成功后才升格 message');
      assert.ok(ipcHandlers.includes('deleteMessage'), '同步失败须回滚消息');
      // Task 7B：TASK_ADD / QUEUE_USER_MESSAGE 已支持附件（旧的"尚未支持"反向断言移除）。
      // 详细契约见 testAttachmentTask7BContracts。
      assert.ok(ipcHandlers.includes('createTaskWithAttachments'), 'TASK_ADD 须用 createTaskWithAttachments 落库带附件任务');

      // 顺序：在 CHAT_SEND handler 体内检查（避免 indexOf 命中 import 行）
      const chatSendStart = ipcHandlers.indexOf('IPC_CHANNELS.CHAT_SEND');
      assert.ok(chatSendStart >= 0, '须注册 CHAT_SEND');
      const chatSendBody = ipcHandlers.slice(chatSendStart, chatSendStart + 4500);
      const idxActive = chatSendBody.indexOf('getActiveProcess(sessionId)');
      const idxPrepare = chatSendBody.indexOf('prepareAttachmentPrompt');
      const idxCreate = chatSendBody.indexOf('createMessageWithAttachments');
      const idxSpawn = chatSendBody.indexOf('spawnForChat(sessionId');
      const idxPromote = chatSendBody.indexOf("markAttachmentsStatus(prepared.attachmentIds, 'message')");
      assert.ok(idxActive >= 0 && idxPrepare > idxActive, 'prepare 须在 active 检查之后');
      assert.ok(idxCreate > idxPrepare, '落库须在 prepare 之后');
      assert.ok(idxSpawn > idxCreate, 'spawn 须在落库之后');
      assert.ok(idxPromote > idxSpawn, '升格 message 须在 spawn/send 成功之后');

      assert.ok(messageRepo.includes('promoteAttachments'), 'message-repo 须支持 promoteAttachments');
      assert.ok(messageRepo.includes('export function deleteMessage'), 'message-repo 须提供 deleteMessage 回滚');

      assert.ok(cliShared.includes('additionalDirectories?: string[]'), 'SpawnOptions 须含 additionalDirectories');
      assert.ok(sdkBackend.includes('opts.additionalDirectories'), 'buildSdkOptions 须合并 opts.additionalDirectories');
      assert.ok(sdkBackend.includes('permissions.additionalDirectories'), 'buildSdkOptions 须并集用户 permissions 目录');
      assert.ok(sdkBackend.includes('pendingFirstPrompt.has(sessionId)'), 'spawnForChat 须拒绝覆盖已有 pending');
      assert.ok(sdkBackend.includes('没有待发送的 SDK 入口') || sdkBackend.includes('请先 spawnForChat'), 'sendMessage 无 pending 须抛错');
      assert.ok(sdkBackend.includes('prompt: SdkPrompt') || sdkBackend.includes('prompt: string | AsyncIterable'), 'sdk-backend 须接受 SdkPrompt');
      assert.ok(/export function sendMessage\(sessionId: string, message: SdkPrompt\)/.test(sdkBackend), 'sendMessage 须接受 SdkPrompt');
      assert.ok(/export function spawnForTask\([\s\S]*prompt: SdkPrompt/.test(sdkBackend), 'spawnForTask 须接受 SdkPrompt');
      // 回合启动/流消费的所有异常都必须经过统一收口，不能让 entries 永久占坑。
      assert.ok(/async function runQuery\([\s\S]*?finally\s*\{[\s\S]*?deleteEntry\(sessionId, entry\)/.test(sdkBackend), 'runQuery 须用 finally 清理当前 entry');
      assert.ok(sdkBackend.includes('buildSdkOptions(opts, sessionId, mainWindow, entry)'), 'runQuery 须构建 SDK options');
      assert.ok(ipcHandlers.includes("killProcess(sessionId, 'session_cleanup')"), 'CHAT_SEND 启动链同步失败须清理 entry');
      assert.ok(ipcHandlers.includes('spawned'), 'CHAT_SEND 须记录 spawn 是否已占坑');
      assert.ok(/if \(type === 'result'\)[\s\S]*?deleteEntry\(sessionId, entry\);[\s\S]*?emitExit\(0\);[\s\S]*?return;/.test(sdkBackend), 'result 终态须先释放 entry 再通知退出');
      assert.ok(/if \(isCurrentEntry\(sessionId, entry\) && !gotResult\)[\s\S]*?deleteEntry\(sessionId, entry\);[\s\S]*?emitExit/.test(sdkBackend), '流末合成终态须先释放 entry 再通知退出');
      assert.ok(sdkBackend.includes('let exitEmitted = false'), 'SDK query exit 回调须幂等');
      assert.ok(/executeNextTask\([\s\S]*?spawnForTask\([\s\S]*?catch \(err\)[\s\S]*?task_failed/.test(taskQueue), '队列 spawn 同步失败须转为 task_failed');
      assert.ok(/continueWithUserMessage\([\s\S]*?let spawned = false[\s\S]*?killProcess\(sessionId, 'queue'\)/.test(taskQueue), '队列续接 spawn/send 同步失败须清理 entry');
      assert.ok(/continueWithUserMessage\([\s\S]*?promoteAttachments: false[\s\S]*?deleteMessage\(userMessage\.id\)[\s\S]*?markAttachmentsStatus\(prepared\.attachmentIds, 'draft'\)/.test(taskQueue), '队列续接失败须回滚消息并恢复附件草稿');
      const continueBody = taskQueue.slice(taskQueue.indexOf('export async function continueWithUserMessage'), taskQueue.indexOf('export function skipCountdown'));
      assert.ok(continueBody.indexOf("sendMessage(sessionId, prepared.prompt)") < continueBody.indexOf("state.status = 'continuing'"), '队列续接须在 query 接收后才切 continuing');
      assert.ok(continueBody.indexOf("sendMessage(sessionId, prepared.prompt)") < continueBody.indexOf("emitQueueEvent(mainWindow, sessionId, 'countdown_cancelled')"), '队列续接须在 query 接收后才通知取消倒计时');
      assert.ok(builder.includes("parent_tool_use_id: null"), '构造的 user message 须 parent_tool_use_id=null');
      assert.ok(builder.includes('ATTACHMENT_DEFAULT_INSTRUCTION'), 'builder 须使用默认指令常量');
      assert.ok(builder.includes('MAX_ENCODED_IMAGE_REQUEST_BYTES') || builder.includes('30 * 1024 * 1024'), '须有图片编码请求预算');
      assert.ok(builder.includes('assertPayloadAttachmentIdsMatch') || builder.includes('附件列表与发送载荷'), '须校验 payload ids 与 attachments');
      // user 回显过滤仍在：只转发 tool_result part，避免与本地用户消息重复
      assert.ok(sdkBackend.includes("type === 'user'"), '须保留 user 消息分支');
      assert.ok(sdkBackend.includes('isToolResultPart'), 'user 回显仍只转发 tool_result');
    }
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
}

// Task5：第四版附件 UI 接线契约（源码结构断言）。
function testAttachmentDraftUiContracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const chatPage = readFileSync(new URL('../src/renderer/pages/ChatPage.vue', import.meta.url), 'utf8');
  const chatInput = readFileSync(new URL('../src/renderer/components/chat/ChatInput.vue', import.meta.url), 'utf8');
  const toolbar = readFileSync(new URL('../src/renderer/components/chat/SessionToolbar.vue', import.meta.url), 'utf8');
  const draftList = readFileSync(new URL('../src/renderer/components/chat/AttachmentDraftList.vue', import.meta.url), 'utf8');
  const draftStore = readFileSync(new URL('../src/renderer/stores/chat-draft-store.ts', import.meta.url), 'utf8');
  const appVue = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');

  // 1) AttachmentDraftList 出现在 .chat-composer 之前
  const idxList = chatPage.indexOf('<AttachmentDraftList');
  const idxComposer = chatPage.indexOf('class="chat-composer"');
  assert.ok(idxList >= 0, 'ChatPage 须挂载 AttachmentDraftList');
  assert.ok(idxComposer >= 0, 'ChatPage 须有 .chat-composer');
  assert.ok(idxList < idxComposer, '附件草稿列表须在 .chat-composer 之前');

  // 2) 拖放高亮 class（非常驻边框）
  assert.ok(chatPage.includes("'chat-composer--drag'"), '须有拖放高亮 class');

  // 3) ChatPage 构造 ChatSendPayload + 三路径路由
  assert.ok(/function buildPayload\(\)/.test(chatPage), 'ChatPage 须有 buildPayload 构造载荷');
  assert.ok(/clientMessageId: crypto\.randomUUID\(\)/.test(chatPage), 'payload 须带 clientMessageId');
  assert.ok(chatPage.includes('taskStore.queueUserMessage(sessionId, payload)'), 'waiting 须走 queueUserMessage(payload)');
  assert.ok(chatPage.includes('taskStore.addTask(sessionId, payload)'), 'running/continuing 须走 addTask(payload)');
  assert.ok(chatPage.includes('sendMessage(payload)'), 'idle 须走 sendMessage(payload)');
  assert.ok(chatPage.includes('draftStore.clearAfterAccepted(sessionId)'), '成功后才清草稿');
  // 失败路径不清草稿：clearAfterAccepted 必须在 ok 分支内（在其后无无条件调用）
  const clearIdx = chatPage.indexOf('draftStore.clearAfterAccepted(sessionId)');
  const okIdx = chatPage.indexOf('if (ok)');
  assert.ok(okIdx >= 0 && clearIdx > okIdx, '清草稿须在 ok 分支内（失败保留）');

  // 4) ChatInput 受控 + 附件-only 发送（拖放/粘贴已上移到 ChatPage 容器）
  assert.ok(/modelValue: string/.test(chatInput), 'ChatInput 须受控 modelValue');
  assert.ok(/hasAttachments\?: boolean/.test(chatInput), 'ChatInput 须有 hasAttachments');
  assert.ok(/send: \[\]/.test(chatInput), 'send 须为无参事件（父清草稿）');
  assert.ok(/disabled \|\| \(!modelValue\.trim\(\) && !hasAttachments\)/.test(chatInput), '发送条件须允许附件-only');

  // 4b) 拖放/粘贴在 ChatPage 容器级（不依赖 textarea 焦点，落点覆盖整个聊天区）
  assert.ok(chatPage.includes('onPageDrop'), 'ChatPage 须有 onPageDrop');
  assert.ok(chatPage.includes('onPagePaste'), 'ChatPage 须有 onPagePaste');
  assert.ok(chatPage.includes('dragCounter'), 'ChatPage 须有拖放计数 dragCounter');
  assert.ok(/@drop="onPageDrop"/.test(chatPage), '.chat-page 须绑 @drop');
  assert.ok(/@paste="onPagePaste"/.test(chatPage), '.chat-page 须绑 @paste');
  // 粘贴截取所有 file 项（不卡 image/*），交主进程校验；有 file 才 preventDefault，文本透传
  const pasteBlock = chatPage.slice(chatPage.indexOf('onPagePaste'), chatPage.indexOf('onPagePaste') + 700);
  assert.ok(pasteBlock.includes("item.kind === 'file'"), '粘贴须截取所有 file 项');
  assert.ok(!/startsWith\('image\/'\)/.test(pasteBlock), '粘贴不得只限 image/*');
  assert.ok(pasteBlock.includes('e.preventDefault()'), '有 file 项时须 preventDefault');
  assert.ok(!pasteTextSwallowsText(pasteBlock), '粘贴不应无条件 preventDefault 吞文本');
  // 拖放仅 Files 类型才高亮/拦截
  assert.ok(/includes\('Files'\)/.test(chatPage), '拖放判断须限定 Files 类型');

  // 4c) App.vue 全局 dragover/drop 兜底（防 Electron 把窗口导航到 file:///）
  assert.ok(appVue.includes('dragover') && appVue.includes('drop'), 'App.vue 须注册全局 dragover/drop 兜底');
  assert.ok(/addEventListener\('dragover'/.test(appVue), 'App.vue 须 addEventListener dragover');
  assert.ok(/addEventListener\('drop'/.test(appVue), 'App.vue 须 addEventListener drop');
  assert.ok(/preventDefault\(\)/.test(appVue), 'App.vue 须 preventDefault 屏蔽文件导航');

  // 5) SessionToolbar 添加按钮在权限控件之后
  const permIdx = toolbar.indexOf('permissionRef') >= 0 ? toolbar.indexOf('权限') : toolbar.indexOf('权限');
  const addIdx = toolbar.indexOf('attachment-add-btn');
  assert.ok(addIdx >= 0, 'SessionToolbar 须有添加文件按钮');
  assert.ok(permIdx >= 0 && addIdx > permIdx, '添加文件须在权限控件之后');
  assert.ok(toolbar.includes("addAttachment: []"), 'SessionToolbar 须 emit addAttachment');

  // 6) AttachmentDraftList：删除 stop propagation + 复用 lightbox + revoke
  assert.ok(draftList.includes('@click.stop'), '删除按钮须 stop propagation');
  assert.ok(draftList.includes('openImageLightbox'), '须复用现有灯箱');
  assert.ok(draftList.includes('URL.revokeObjectURL'), '须 revoke Blob URL');
  assert.ok(draftList.includes('getAttachmentPreview'), '缩略图经 IPC 取有界预览');
  // 列表自身不设满宽 border/background 包住全部附件（仅限 .attachment-draft-list 规则块内）
  assert.ok(!/\.attachment-draft-list\s*\{[^}]*border:/.test(draftList), '列表容器不得有自身 border');

  // 7) draft store：按会话隔离 + 成功才清 + 不存 bytes
  assert.ok(draftStore.includes('textBySession') && draftStore.includes('attachmentsBySession'), '草稿须按会话隔离');
  assert.ok(draftStore.includes('clearAfterAccepted'), '须有成功后清空');
  assert.ok(!draftStore.includes('arrayBuffer'), 'draft store 不得保存 bytes');
}

// 粘贴块若「无条件 e.preventDefault()」（在截取图片判断之前就 preventDefault）则判为吞文本。
function pasteTextSwallowsText(block: string): boolean {
  const preventIdx = block.indexOf('e.preventDefault()');
  if (preventIdx < 0) return false;
  const before = block.slice(0, preventIdx);
  // preventDefault 必须出现在「确认有图片文件」分支内（出现 files.length > 0 之类判断之后）。
  return !/files\.length\s*>\s*0/.test(before);
}

// Task6：历史附件渲染 + clientMessageId 统一契约（源码结构断言）。
function testAttachmentHistoryContracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const msgBubble = readFileSync(new URL('../src/renderer/components/chat/MessageBubble.vue', import.meta.url), 'utf8');
  const msgAttachments = readFileSync(new URL('../src/renderer/components/chat/MessageAttachments.vue', import.meta.url), 'utf8');
  const useChat = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  const sessionStore = readFileSync(new URL('../src/renderer/stores/session-store.ts', import.meta.url), 'utf8');
  const msgRepo = readFileSync(new URL('../src/main/database/repositories/message-repo.ts', import.meta.url), 'utf8');

  // 1) RenderableMessage.content 仍是 string（附件走独立关联，不进正文）
  const renderableType = readFileSync(new URL('../src/shared/types/export-image.ts', import.meta.url), 'utf8');
  assert.ok(/content: string;/.test(renderableType), 'RenderableMessage.content 须为 string');
  assert.ok(/attachments\?: AttachmentSummary\[\]/.test(renderableType), 'RenderableMessage 须有可选 attachments');

  // 2) MessageBubble：正文 markdown + 附件组件（文字后附件）；空 content 不渲染空 markdown 容器
  assert.ok(msgBubble.includes('MessageAttachments'), 'MessageBubble 须渲染 MessageAttachments');
  const contentIdx = msgBubble.indexOf('v-html="renderedContent"');
  const attIdx = msgBubble.indexOf('<MessageAttachments');
  assert.ok(contentIdx >= 0 && attIdx > contentIdx, '附件须渲染在正文之后');
  assert.ok(msgBubble.includes('hasContent'), '空 content 须有 hasContent 守卫（不渲染空 markdown）');
  // copy 包含文件名，不含路径/Base64/ID
  assert.ok(msgBubble.includes('[附件]'), 'copy 须含附件文件名标记');
  assert.ok(!msgBubble.includes('sha256') && !msgBubble.includes('storageKey'), 'copy 不得含路径/哈希/ID');

  // 3) MessageAttachments：Blob URL 生命周期 + 不可用占位 + 灯箱复用
  assert.ok(msgAttachments.includes('URL.revokeObjectURL'), 'MessageAttachments 须 revoke Blob URL');
  assert.ok(msgAttachments.includes('onBeforeUnmount'), '卸载时须清理');
  assert.ok(msgAttachments.includes('getAttachmentPreview'), '预览须经 IPC');
  assert.ok(msgAttachments.includes('openImageLightbox'), '图片须复用现有灯箱');
  assert.ok(msgAttachments.includes('附件不可用'), '须含「附件不可用」占位分支');
  assert.ok(msgAttachments.includes('errorByAttachmentId'), '须维护 error map（预览失败占位）');

  // 4) use-chat：乐观消息 id = clientMessageId（统一乐观/DB，避免双气泡）
  assert.ok(/persistMessage\(\{[\s\S]*?id: payload\.clientMessageId/.test(useChat), '乐观 user 消息 id 须用 clientMessageId');
  assert.ok(useChat.includes('useChatDraftStore'), 'sendMessage 须取草稿摘要做乐观附件渲染');
  // 成功时不再重复添加主进程返回的 user 消息（沿用乐观消息）
  const sendBlock = useChat.slice(useChat.indexOf('async function sendMessage'), useChat.indexOf('async function sendMessage') + 1800);
  assert.ok(!sendBlock.includes('result.attachments.forEach'), '成功后不得重复插入返回的 user 附件消息');

  // 5) session-store：有文字走 LLM 概括；附件-only 直接用文件名作标题（不喂 LLM，避免误回复客套话）
  assert.ok(sessionStore.includes('attachments?.[0]?.filename'), '附件-only 须取首个 filename');
  assert.ok(/else if \(firstName\)/.test(sessionStore), '附件-only 须分支处理');
  assert.ok(/updateSession\(sessionId, \{ name: topic \}/.test(sessionStore), '附件-only 须直接更新标题不经 LLM');
  assert.ok(/analyzeTopic\(sessionId, textContent\)/.test(sessionStore), '有文字时才走 LLM 概括');

  // 6) message-repo：批量填充附件（getMessagesBySession/getRenderableMessagesBySession 无 N+1）
  const fillCount = (msgRepo.match(/getAttachmentsByMessageIds/g) || []).length;
  assert.ok(fillCount >= 2, `历史加载须批量填充附件（实际 ${fillCount} 处）`);
}

// 附件徽标：按文件名后缀（用户期望"对应后缀格式"），mimeType 仅无后缀时兜底。
function testAttachmentBadgeContracts(): void {
  assert.equal(attachmentBadge('a.pdf'), 'PDF');
  assert.equal(attachmentBadge('a.txt'), 'TXT');
  assert.equal(attachmentBadge('notes.md'), 'MD');
  assert.equal(attachmentBadge('shot.png'), 'PNG');
  assert.equal(attachmentBadge('photo.jpg'), 'JPG');
  assert.equal(attachmentBadge('photo.jpeg'), 'JPG');
  assert.equal(attachmentBadge('anim.gif'), 'GIF');
  assert.equal(attachmentBadge('img.webp'), 'WEBP');
  assert.equal(attachmentBadge('data.json'), 'JSON');
  assert.equal(attachmentBadge('sheet.csv'), 'CSV');
  assert.equal(attachmentBadge('App.ts'), 'TS');
  assert.equal(attachmentBadge('main.tsx'), 'TSX');
  assert.equal(attachmentBadge('index.js'), 'JS');
  assert.equal(attachmentBadge('config.yaml'), 'YAML');
  assert.equal(attachmentBadge('App.vue'), 'VUE');
  assert.equal(attachmentBadge('book.ipynb'), 'NB');
  // 未知后缀：原样大写截断
  assert.equal(attachmentBadge('weird.xyz'), 'XYZ');
  // 大小写不敏感
  assert.equal(attachmentBadge('A.PDF'), 'PDF');
  assert.equal(attachmentBadge('B.Jpg'), 'JPG');
  // 无后缀：按 mimeType 兜底
  assert.equal(attachmentBadge('noext', 'text/plain'), 'TXT');
  assert.equal(attachmentBadge('noext', 'application/pdf'), 'PDF');
  assert.equal(attachmentBadge('noext', 'image/png'), 'IMG');
  assert.equal(attachmentBadge('noext'), 'FILE');
}

// Task 7A：真实缩略图 <img>、Blob bytes 复制成 ArrayBuffer、混合粘贴不吞文字、
// document 级 drop 仅拦 Files、批量选择逐项结果（成功项 + 安全错误）。
function testAttachmentTask7AContracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const draftList = readFileSync(new URL('../src/renderer/components/chat/AttachmentDraftList.vue', import.meta.url), 'utf8');
  const msgAttachments = readFileSync(new URL('../src/renderer/components/chat/MessageAttachments.vue', import.meta.url), 'utf8');
  const chatPage = readFileSync(new URL('../src/renderer/pages/ChatPage.vue', import.meta.url), 'utf8');
  const chatInput = readFileSync(new URL('../src/renderer/components/chat/ChatInput.vue', import.meta.url), 'utf8');
  const appVue = readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');
  const preloadApi = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const ipcTypes = readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
  const attachmentService = readFileSync(new URL('../src/main/modules/attachment-service.ts', import.meta.url), 'utf8');
  const useChat = readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');

  // 1) 图片卡片真实渲染 <img> 缩略图（非仅徽标）
  assert.ok(draftList.includes('att-card__thumb-img'), 'AttachmentDraftList 图片卡片须渲染 <img> 缩略图');
  assert.ok(/<img[\s\S]*?att-card__thumb-img/.test(draftList), 'AttachmentDraftList 须有 <img> 缩略图元素');
  assert.ok(msgAttachments.includes('msg-att__thumb-img'), 'MessageAttachments 图片卡片须渲染 <img> 缩略图');
  assert.ok(/<img[\s\S]*?msg-att__thumb-img/.test(msgAttachments), 'MessageAttachments 须有 <img> 缩略图元素');

  // 2) Blob bytes 经复制成当前 realm ArrayBuffer 构造（规避 Uint8Array<ArrayBufferLike> 不能直接当 BlobPart）
  assert.ok(draftList.includes('toBlobPart'), 'AttachmentDraftList 须用 toBlobPart 复制 bytes');
  assert.ok(msgAttachments.includes('toBlobPart'), 'MessageAttachments 须用 toBlobPart 复制 bytes');
  assert.ok(/Uint8Array\.from\(bytes\)\.buffer/.test(draftList), 'toBlobPart 须复制成当前 realm ArrayBuffer');

  // 3) 缩略图与原图分两套 URL 管理（thumbnail:true 卡片 / thumbnail:false 灯箱），各自 revoke
  assert.ok(/thumbnail:\s*true/.test(draftList) && /thumbnail:\s*false/.test(draftList), 'AttachmentDraftList 须区分缩略图与原图请求');
  assert.ok(msgAttachments.includes('fetchPreviewUrl(att, true)') && msgAttachments.includes('fetchPreviewUrl(att, false)'), 'MessageAttachments 须区分缩略图与原图请求');
  assert.ok(draftList.includes('thumbUrls'), 'AttachmentDraftList 须独立管理缩略图 URL');
  assert.ok(msgAttachments.includes('thumbByAttachmentId'), 'MessageAttachments 须独立管理缩略图 URL');

  // 4) 混合剪贴板：图片进附件后，同一次 paste 的文字仍插入 textarea（不吞文字）
  assert.ok(chatInput.includes('insertTextAtSelection'), 'ChatInput 须暴露 insertTextAtSelection');
  assert.ok(chatInput.includes('defineExpose'), 'ChatInput 须 defineExpose insertTextAtSelection');
  const pasteBlock = chatPage.slice(chatPage.indexOf('onPagePaste'), chatPage.indexOf('onPagePaste') + 700);
  assert.ok(pasteBlock.includes("getData('text/plain')"), '粘贴有图片时须读取 text/plain');
  assert.ok(pasteBlock.includes('insertTextAtSelection'), '粘贴有图片时须把文字插入 textarea');
  assert.ok(chatPage.includes('chatInputRef'), 'ChatPage 须持有 ChatInput 实例引用');

  // 5) document 级 drop 守卫仅对 Files preventDefault（文本拖放保留默认行为，可落入 textarea）
  assert.ok(/Array\.from\(types\)\.includes\('Files'\)/.test(appVue), 'App.vue drop 守卫须仅 Files 时 preventDefault');

  // 6) 批量选择逐项结果：成功项 + 失败项（错误文案来自业务校验，不带内部路径）
  assert.ok(ipcTypes.includes('PickAttachmentsResult'), 'ipc.ts 须定义 PickAttachmentsResult');
  assert.ok(/PickAttachmentsResult\b/.test(preloadApi), 'preload pickAttachments 须返回 PickAttachmentsResult');
  assert.ok(ipcHandlers.includes('PickAttachmentsResult'), 'ATTACHMENT_PICK handler 须返回逐项结果');
  assert.ok(ipcHandlers.includes('errors.push({ filename,'), 'handler 须逐项收集失败原因');
  const pickBlock = chatPage.slice(chatPage.indexOf('onPickAttachments'), chatPage.indexOf('onPickAttachments') + 600);
  assert.ok(pickBlock.includes('attachments') && pickBlock.includes('errors'), 'ChatPage 须解构 attachments/errors');
  assert.ok(pickBlock.includes('showNotice'), '部分失败须集中提示');

  // 7) Step 5 异步失败恢复：从历史消息克隆附件为草稿 + 回填文字，不自动重发/切模型
  assert.ok(attachmentService.includes('cloneMessageAttachmentsToDraft'), 'attachment-service 须有 cloneMessageAttachmentsToDraft');
  assert.ok(attachmentService.includes('readStoredAttachmentBytes'), '克隆须读原文件 bytes');
  assert.ok(attachmentService.includes('sum.sessionId !== sessionId'), '克隆须校验附件归属当前会话（跨会话防护）');
  assert.ok(attachmentService.includes('removeDraftAttachment'), '克隆任一失败须回滚已产生的 draft');
  assert.ok(ipcTypes.includes('ATTACHMENT_CLONE_MESSAGE'), 'ipc.ts 须有 ATTACHMENT_CLONE_MESSAGE 通道');
  assert.ok(preloadApi.includes('cloneMessageAttachments'), 'preload 须暴露 cloneMessageAttachments');
  assert.ok(ipcHandlers.includes('ATTACHMENT_CLONE_MESSAGE'), 'handler 须注册 ATTACHMENT_CLONE_MESSAGE');
  assert.ok(useChat.includes('lastFailedBySession'), 'use-chat 须按会话记录失败消息（lastFailedBySession）');
  assert.ok(useChat.includes('captureFailedMessage'), 'error 置位时须捕获失败消息（覆盖队列任务/waiting 续接路径）');
  assert.ok(!useChat.includes('lastSentBySession'), 'Task 7B 修复：旧的 lastSentBySession（仅主发送写入）须移除');
  assert.ok(chatPage.includes('重新编辑发送'), '错误横幅须有「重新编辑发送」按钮');
  const retryStart = chatPage.indexOf('async function retryLastFailed');
  const retryEnd = chatPage.indexOf('async function handleCompress', retryStart);
  const retryBody = retryStart >= 0 && retryEnd > retryStart ? chatPage.slice(retryStart, retryEnd) : '';
  assert.ok(retryBody.includes('cloneMessageAttachments'), '重新编辑须克隆附件');
  assert.ok(retryBody.includes('draftStore.setText'), '重新编辑须回填文字到草稿');
  assert.ok(retryBody.includes('delete lastFailedBySession.value'), '重新编辑后须清当前会话的 lastFailedBySession');
  assert.ok(!retryBody.includes('sendMessage'), '重新编辑不得自动重发（须用户手动发送）');
}

// Task 7B：任务队列附件 + waiting 续接附件 + 稳定 clientMessageId + retry 的接线契约（源码结构断言）。
function testAttachmentTask7BContracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const ipcTypes = readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
  const preloadApi = readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  const engine = readFileSync(new URL('../src/main/modules/task-queue-engine.ts', import.meta.url), 'utf8');
  const sdkBackend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  const taskRepo = readFileSync(new URL('../src/main/database/repositories/task-repo.ts', import.meta.url), 'utf8');
  const attService = readFileSync(new URL('../src/main/modules/attachment-service.ts', import.meta.url), 'utf8');
  const builder = readFileSync(new URL('../src/main/modules/attachment-prompt-builder.ts', import.meta.url), 'utf8');
  const taskStore = readFileSync(new URL('../src/renderer/stores/task-store.ts', import.meta.url), 'utf8');
  const taskDraftStore = readFileSync(new URL('../src/renderer/stores/task-draft-store.ts', import.meta.url), 'utf8');
  const queuePanel = readFileSync(new URL('../src/renderer/components/task/TaskQueuePanel.vue', import.meta.url), 'utf8');
  const taskTypes = readFileSync(new URL('../src/shared/types/task.ts', import.meta.url), 'utf8');

  // 1) TASK_ADD 落库带附件 + 稳定 clientMessageId；TASK_REMOVE 零引用清理；TASK_RETRY 全链路
  assert.ok(ipcHandlers.includes('createTaskWithAttachments'), 'TASK_ADD 须用 createTaskWithAttachments 落库');
  assert.ok(/createTaskWithAttachments\([\s\S]*payload\.clientMessageId/.test(ipcHandlers), 'TASK_ADD 须透传 payload.clientMessageId');
  assert.ok(ipcHandlers.includes('cleanupDetachedAttachments'), 'TASK_REMOVE 须用 cleanupDetachedAttachments 清理零引用附件');
  assert.ok(ipcTypes.includes('TASK_RETRY'), 'ipc.ts 须有 TASK_RETRY 通道');
  assert.ok(ipcHandlers.includes('TASK_RETRY'), 'handler 须注册 TASK_RETRY');
  assert.ok(ipcHandlers.includes('taskRepo.retryTask'), 'TASK_RETRY 须调 taskRepo.retryTask');
  assert.ok(preloadApi.includes('retryTask'), 'preload 须暴露 retryTask');

  // 2) QUEUE_USER_MESSAGE 改收 payload + await continueWithUserMessage（不再裸 string / 不再拒绝附件）
  assert.ok(/continueWithUserMessage\(sessionId, payload, mainWindow\)/.test(ipcHandlers), 'QUEUE_USER_MESSAGE 须把 payload 透传给 continueWithUserMessage');
  assert.ok(!ipcHandlers.includes('等待续接附件尚未支持'), 'Task 7B：QUEUE_USER_MESSAGE 不再拒绝附件');
  assert.ok(!ipcHandlers.includes('任务队列附件尚未支持'), 'Task 7B：TASK_ADD 不再拒绝附件');

  // 3) 引擎：executeNextTask async + prepare + 稳定 ID + 幂等 user message；continueWithUserMessage async + payload
  assert.ok(/async function executeNextTask/.test(engine), 'executeNextTask 须为 async');
  assert.ok(engine.includes('prepareAttachmentPrompt'), 'executeNextTask 须 prepare 带附件 prompt');
  assert.ok(engine.includes('setTaskClientMessageId'), '老任务首执行须生成并持久化 clientMessageId');
  assert.ok(engine.includes('getMessagesByTask'), '须按 parent_task_id 查已有 user message 实现幂等');
  assert.ok(/spawnForTask\([\s\S]*prepared\.prompt/.test(engine), 'executeNextTask 须把 prepared.prompt 传给 spawnForTask');
  assert.ok(engine.includes('prepared.additionalDirectories'), 'executeNextTask 须透传 additionalDirectories');
  assert.ok(/const executionGeneration = generation[\s\S]*child\.on\('exit'[\s\S]*isQueueGenerationActive\(sessionId, executionGeneration\)/.test(engine), 'task retry/interrupt 后旧 child exit 不得覆盖新执行状态');
  assert.ok(/async function continueWithUserMessage[\s\S]*payload: ChatSendPayload/.test(engine), 'continueWithUserMessage 须 async + 收 ChatSendPayload');
  assert.ok(engine.includes('user_message_created'), '引擎创建 user message 后须 emit user_message_created 事件');
  assert.ok(engine.includes('runNextTask'), 'executeNextTask 改 async 后须有 runNextTask 包装防 unhandled rejection');

  // 4) resume 统一：resolveCliSessionId（内存优先 + DB fallback）
  assert.ok(sdkBackend.includes('export function resolveCliSessionId'), 'sdk-backend 须导出 resolveCliSessionId');
  assert.ok(/resumeSessionId \|\| resolveCliSessionId\(sessionId\)/.test(sdkBackend), 'runQuery 须用 resolveCliSessionId 兜底');

  // 5) 图片 prompt 可重复迭代（[Symbol.asyncIterator]，支持 stale-resume 二次消费）
  assert.ok(builder.includes('[Symbol.asyncIterator]'), 'prompt 须为可重复迭代对象（[Symbol.asyncIterator]）');

  // 6) task-repo：retryTask（仅 failed/cancelled）+ setTaskClientMessageId
  assert.ok(taskRepo.includes('export function retryTask'), 'task-repo 须导出 retryTask');
  assert.ok(/retryTask[\s\S]*status IN \('failed', 'cancelled'\)/.test(taskRepo), 'retryTask 须仅对 failed/cancelled 生效');
  assert.ok(taskRepo.includes('export function setTaskClientMessageId'), 'task-repo 须导出 setTaskClientMessageId');

  // 7) attachment-service：cleanupDetachedAttachments（零引用才删）
  assert.ok(attService.includes('export async function cleanupDetachedAttachments'), 'attachment-service 须导出 cleanupDetachedAttachments');
  assert.ok(/cleanupDetachedAttachments[\s\S]*getAttachmentReferenceCount/.test(attService), 'cleanupDetachedAttachments 须按引用计数判定');

  // 8) renderer：task-store retry + user_message_created upsert；task-draft-store 独立
  assert.ok(taskStore.includes('async retryTask'), 'task-store 须有 retryTask action');
  assert.ok(taskStore.includes("case 'user_message_created'"), 'task-store 须处理 user_message_created 事件');
  assert.ok(taskStore.includes('sessionStore.addMessage(msg)'), 'user_message_created 须 upsert 进会话消息');
  assert.ok(taskDraftStore.includes("defineStore('taskDraft'"), '须有独立 task-draft-store（按会话隔离任务草稿）');

  // 9) TaskQueuePanel：构造完整 payload（不再裸 string）+ 附件 composer + retry 接线
  assert.ok(/clientMessageId: crypto\.randomUUID\(\)/.test(queuePanel), 'TaskQueuePanel 须构造带 clientMessageId 的 payload');
  assert.ok(queuePanel.includes('taskDraft.clearAfterAccepted'), 'TaskQueuePanel 成功后才清草稿');
  assert.ok(queuePanel.includes('AttachmentDraftList'), 'TaskQueuePanel 须挂载 AttachmentDraftList');
  assert.ok(queuePanel.includes('pickTaskAttachments'), 'TaskQueuePanel 须有附件选择入口');
  assert.ok(queuePanel.includes('@retry="handleRetry"'), 'TaskItem 须接 retry 事件');

  // 10) Task 类型：clientMessageId + attachments 必需数组
  assert.ok(taskTypes.includes('clientMessageId: string | null'), 'Task 类型须有 clientMessageId');
  assert.ok(/attachments: AttachmentSummary\[\]/.test(taskTypes), 'Task.attachments 须为必需数组');
}

function testProcessKindSubAgentTitleNarrowing(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const processKind = fs.readFileSync(new URL('../src/shared/process-kind.ts', import.meta.url), 'utf8');
  assert.ok(
    /isSubAgentToolUse\([^)]*\):\s*part is Extract<[^>]+\{ type: 'tool_use' \}/.test(processKind),
    'isSubAgentToolUse 须声明 tool_use 类型谓词再访问 input/name',
  );
  assert.equal(
    extractSubAgentTitle({ type: 'tool_use', name: 'Agent', input: { description: '检查附件导出' } }),
    '检查附件导出',
    'tool_use 子 Agent 须从 input 提取标题',
  );
  assert.equal(
    extractSubAgentTitle({ type: 'text', text: '普通正文' }),
    null,
    '非 tool_use part 不得读取 name/input',
  );
}

function testExportAttachmentSmokeContracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const smoke = readFileSync(new URL('../src/main/modules/export-image-smoke.ts', import.meta.url), 'utf8');
  const mainIndex = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const viteConfig = readFileSync(new URL('../electron.vite.config.ts', import.meta.url), 'utf8');
  assert.ok(mainIndex.includes("app.setPath('userData', smokeUserDataDir)"), 'export smoke 须在主入口隔离 userData');
  assert.ok(mainIndex.includes('claude-link-smoke-${process.pid}-${randomUUID()}'), 'export smoke 须使用进程唯一缓存目录，禁止递归删除固定用户目录');
  assert.ok(mainIndex.indexOf('app.setPath') < mainIndex.indexOf('app.whenReady()'), 'export smoke userData 须在业务初始化前配置');
  assert.ok(viteConfig.includes("index: resolve('src/main/index.ts')"), 'Electron 主进程须保持稳定入口目录，避免 __dirname 资源路径漂移');
  for (const relative of ['config-manager.ts', 'workspace-history.ts', 'window-state.ts']) {
    const source = readFileSync(new URL(`../src/main/modules/${relative}`, import.meta.url), 'utf8');
    assert.ok(/function getStore\(\)/.test(source), `${relative} 须延迟创建 electron-store`);
    assert.ok(!/const store = new ElectronStoreCtor/.test(source), `${relative} 不得在静态 import 阶段创建 electron-store`);
  }
  const manager = readFileSync(new URL('../src/main/modules/export-image-manager.ts', import.meta.url), 'utf8');
  assert.ok(/smokeDest[\s\S]*job\.smoke/.test(manager), '普通导出不得信任 smoke 保存目录环境变量');
  assert.ok(smoke.includes('smoke-image.png') && smoke.includes('smoke-note.txt') && smoke.includes('attachmentOnly'), 'export smoke 须覆盖图片、文件和附件-only fixture');
  assert.ok(smoke.includes('missing-preview.png') && smoke.includes('previewUnavailable'), 'export smoke 须覆盖缺失 preview 且不失败');
  assert.ok(smoke.includes('validateExportSnapshot(start.snapshot)'), 'export smoke 须校验实际送入 hidden renderer 的快照');
  assert.ok(smoke.includes('width: 640') && smoke.includes('height: 320'), 'export smoke 须用长边超过 512 的图片覆盖真实缩放');
  assert.ok(!smoke.includes('snapshotContract = {'), 'export smoke 不得用写死布尔值冒充快照断言');
  const exportRunner = readFileSync(new URL('../src/renderer/export/export-runner.ts', import.meta.url), 'utf8');
  assert.ok(exportRunner.includes("hasOwnProperty.call(window, 'claudeLink')"), 'hidden renderer smoke 须运行时确认完整 preload API 未暴露');
  assert.ok(exportRunner.includes('.msg-att__thumb-img') && exportRunner.includes('.msg-att--file') && exportRunner.includes('.msg-att--unavailable'), 'hidden renderer smoke 须确认三类附件 DOM 已进入捕获页面');
  assert.ok(smoke.includes('validatePng') && smoke.includes('validateJpeg'), 'export smoke 须验证 PNG/JPEG 可解码');
  assert.ok(smoke.includes('preview.width !== 512') && smoke.includes('preview.height !== 256'), 'export smoke 须验证大图实际缩放到 512 长边 PNG');
  assert.ok(smoke.includes('storageKey') && smoke.includes('sha256'), 'export smoke 须检查内部字段未进入快照');
}

function testAttachmentTask8Contracts(): void {
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  const sessionRepo = readFileSync(new URL('../src/main/database/repositories/session-repo.ts', import.meta.url), 'utf8');
  const attachmentService = readFileSync(new URL('../src/main/modules/attachment-service.ts', import.meta.url), 'utf8');
  const attachmentStorage = readFileSync(new URL('../src/main/modules/attachment-storage.ts', import.meta.url), 'utf8');
  const mainIndex = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8');
  const ipcHandlers = readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const exportAttachments = readFileSync(new URL('../src/main/modules/export-attachment-snapshot.ts', import.meta.url), 'utf8');
  const messageAttachments = readFileSync(new URL('../src/renderer/components/chat/MessageAttachments.vue', import.meta.url), 'utf8');

  // 会话搜索契约（用户需求）：只按会话标题匹配，不聚合消息内容或附件（含草稿/任务附件）。
  assert.ok(
    /sessions\.filter\(\(session\) => normalizeSearchText\(session\.name\)\.includes\(normalizedQuery\)\)/.test(sessionRepo),
    '搜索须只按会话标题匹配',
  );
  assert.ok(!/GROUP BY session_id/.test(sessionRepo), '搜索不得聚合消息内容/附件（标题-only）');
  assert.ok(/refs\.message > 0[\s\S]*'message'[\s\S]*refs\.task > 0[\s\S]*'task'/.test(attachmentService), 'draft reconcile 须消息引用优先、任务引用其次');
  assert.ok(/reconcileDraftAttachments[\s\S]*cleanupOrphanAttachments/.test(mainIndex), '启动清理须先 reconcile 后 orphan');
  assert.ok(/catch \(error\)[\s\S]*rm\(tmpPath, \{ force: true \}\)/.test(attachmentStorage), '写入失败须自行删除 .part');
  assert.ok(attachmentStorage.includes('lstat') && attachmentStorage.includes('symbolic link'), '附件存储须拒绝符号链接路径');
  assert.ok(attachmentStorage.includes('cleanupStalePartFiles'), 'orphan 清理须处理过期 .part 和空目录');
  assert.ok(/cleanupQueue\(id\)[\s\S]*markSessionDeleted\(id\)[\s\S]*deleteSession/.test(ipcHandlers), '会话删除须先 cleanupQueue 并保留迟到写入守卫');
  assert.ok(exportAttachments.includes('previewUnavailable: true'), '导出 preview 失败须形成占位而非中断');
  assert.ok(!exportAttachments.includes('storageKey') && !exportAttachments.includes('sha256'), '导出最小投影不得携带路径或哈希');
  assert.ok(/props\.exportMode[\s\S]*isSnapshotAttachment[\s\S]*att\.preview/.test(messageAttachments), 'hidden renderer 须只读 snapshot preview');
  assert.ok(/att\.previewUnavailable[\s\S]*附件不可用/.test(messageAttachments), '导出 snapshot 缺失 preview 须显示附件不可用占位');
  assert.ok(/isSnapshotAttachment\(att\)[\s\S]*:\s*att\.id/.test(messageAttachments), '普通历史附件 key 须直接返回 att.id，禁止递归 attachmentKey');
}

function testApiUrlBuilder(): void {
  assert.equal(buildAnthropicApiUrl('https://api.anthropic.com', 'models').toString(), 'https://api.anthropic.com/v1/models');
  assert.equal(buildAnthropicApiUrl('https://api.anthropic.com/v1', 'models').toString(), 'https://api.anthropic.com/v1/models');
  assert.equal(buildAnthropicApiUrl('https://example.com/', '/messages').toString(), 'https://example.com/v1/messages');
  assert.equal(buildAnthropicApiUrl('https://example.com/v1/', 'messages').toString(), 'https://example.com/v1/messages');
}

function testSettingsImportPreservesNestedJson(): void {
  const imported = parseClaudeSettings(JSON.stringify({
    apiKey: 'sk-test',
    apiBaseUrl: 'https://example.com/v1',
    model: 'claude-opus-4-8',
    permissions: { allow: ['Bash(npm run typecheck)'] },
    hooks: [{ event: 'Stop', command: 'notify' }],
    alwaysThinkingEnabled: true,
  }));

  assert.equal(imported.apiKey, 'sk-test');
  assert.equal(imported.apiBaseUrl, 'https://example.com/v1');
  assert.equal(imported.defaultModel, 'claude-opus-4-8');
  assert.deepEqual(JSON.parse(imported.advancedJson), {
    permissions: { allow: ['Bash(npm run typecheck)'] },
    hooks: [{ event: 'Stop', command: 'notify' }],
    alwaysThinkingEnabled: true,
  });
}

function testClaudeSettingsProjectionPreservesAdvancedSettings(): void {
  const settings = buildClaudeSettingsProjection({
    apiKey: 'sk-test',
    apiBaseUrl: 'https://example.com/v1',
    permissionMode: 'plan',
    advancedJson: JSON.stringify({
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2', NUMERIC_IGNORED: 123 },
      permissions: { allow: ['Read'] },
      hooks: [{ event: 'Stop', command: 'notify' }],
      alwaysThinkingEnabled: true,
    }),
  } as never);

  assert.deepEqual(settings.hooks, [{ event: 'Stop', command: 'notify' }]);
  assert.equal(settings.alwaysThinkingEnabled, true);
  assert.deepEqual(settings.permissions, { defaultMode: 'plan', allow: ['Read'] });
  assert.deepEqual(settings.env, {
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.2',
    ANTHROPIC_API_KEY: 'sk-test',
    ANTHROPIC_BASE_URL: 'https://example.com/v1',
  });
}

function testSearchNormalizer(): void {
  assert.equal(normalizeSearchText('会 话\n1\t'), '会话1');
  assert.ok(normalizeSearchText('会话 1').includes(normalizeSearchText('会话1')));
}

function testMarkdownExternalLinks(): void {
  const markdownLink = renderMarkdown('[Example](https://example.com)');
  assert.ok(markdownLink.includes('target="_blank"'));
  assert.ok(markdownLink.includes('rel="noopener noreferrer"'));

  const linkifiedUrl = renderMarkdown('https://example.com');
  assert.ok(linkifiedUrl.includes('target="_blank"'));
  assert.ok(linkifiedUrl.includes('rel="noopener noreferrer"'));

  // 页内锚点 / mailto / 相对路径不应加 target=_blank：
  // 锚点加 _blank 会被 setWindowOpenHandler 静默 deny，破坏页内滚动；
  // mailto/tel 应走系统协议处理器，而非 window.open 路径。
  const anchorLink = renderMarkdown('[锚点](#section)');
  assert.ok(!anchorLink.includes('target="_blank"'));
  const mailtoLink = renderMarkdown('[联系](mailto:test@example.com)');
  assert.ok(!mailtoLink.includes('target="_blank"'));
  const relativeLink = renderMarkdown('[相对](./other)');
  assert.ok(!relativeLink.includes('target="_blank"'));

  const customMarkdown = new MarkdownIt();
  customMarkdown.core.ruler.after('inline', 'existing-link-attributes', (state) => {
    const linkOpen = state.tokens
      .flatMap((token) => token.children ?? [])
      .find((token) => token.type === 'link_open');
    linkOpen?.attrSet('target', '');
    linkOpen?.attrSet('rel', 'author noopener author');
  });
  customMarkdown.renderer.rules.link_open = (tokens, index, options, _env, renderer) => {
    tokens[index].attrSet('data-existing-rule', 'called');
    return renderer.renderToken(tokens, index, options);
  };
  applyExternalLinkTarget(customMarkdown);
  const customLink = customMarkdown.render('[Example](https://example.com)');
  assert.ok(customLink.includes('target=""'));
  assert.ok(customLink.includes('rel="author noopener noreferrer"'));
  assert.ok(customLink.includes('data-existing-rule="called"'));
}

function testInteractionPreviewMarkdownLinkTargetWiring(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const preview = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');

  assert.ok(
    /import\s*\{[^}]*\bcreatePreviewMarkdownRenderer\b[^}]*\}\s*from\s*'[^']*\/utils\/markdown';/.test(preview),
    'InteractionPreview 须从 markdown utils 导入共享 Preview MarkdownIt 工厂',
  );
  assert.ok(preview.includes('createPreviewMarkdownRenderer'), 'InteractionPreview 须使用共享 Preview MarkdownIt 工厂');
}

function testExternalLinks(): void {
  assert.equal(shouldOpenExternally('https://example.com'), true);
  assert.equal(shouldOpenExternally('http://example.com'), true);
  assert.equal(shouldOpenExternally('mailto:test@example.com'), true);
  assert.equal(shouldOpenExternally('tel:+8612345'), true);
  assert.equal(shouldOpenExternally('HTTPS://example.com'), true);
  assert.equal(shouldOpenExternally('MAILTO:test@example.com'), true);
  assert.equal(shouldOpenExternally('ftp://example.com/file'), false);
  assert.equal(shouldOpenExternally('custom:payload'), false);
  assert.equal(shouldOpenExternally('javascript:alert(1)'), false);
  assert.equal(shouldOpenExternally('data:text/html,x'), false);
  assert.equal(shouldOpenExternally('file:///D:/secret.txt'), false);
  assert.equal(shouldOpenExternally('not a url'), false);
  assert.equal(shouldOpenExternally('/settings'), false);
  assert.equal(shouldOpenExternally('https://'), false);
  assert.equal(shouldOpenExternally('https://[::1'), false);
  assert.equal(shouldOpenExternally(''), false);

  const devRendererUrl = 'http://localhost:5173/';
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', devRendererUrl), true);
  assert.equal(isAllowedAppNavigation('HTTP://LOCALHOST:5173/settings', devRendererUrl), true);
  assert.equal(isAllowedAppNavigation('http://localhost.evil.example:5173/', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5174/settings', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('https://localhost:5173/settings', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://[::1', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('javascript:alert(1)', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('blob:http://localhost:5173/id', devRendererUrl), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', 'http://[::1'), false);
  assert.equal(isAllowedAppNavigation('http://localhost:5173/settings', ''), false);

  assert.equal(getNavigationDisposition('http://localhost:5173/settings', devRendererUrl), 'allow');
  assert.equal(getNavigationDisposition('https://example.com', devRendererUrl), 'open-external');
  assert.equal(getNavigationDisposition('mailto:test@example.com', devRendererUrl), 'open-external');
  assert.equal(getNavigationDisposition('blob:http://localhost:5173/id', devRendererUrl), 'block');
  assert.equal(getNavigationDisposition('file:///D:/app/index.html'), 'block');
  assert.equal(getNavigationDisposition('javascript:alert(1)', devRendererUrl), 'block');

  const customRendererUrl = 'https://127.0.0.1:4312/';
  assert.equal(isAllowedAppNavigation('https://127.0.0.1:4312/another?x=1#part', customRendererUrl), true);
  assert.equal(isAllowedAppNavigation('http://127.0.0.1:4312/another', customRendererUrl), false);
  assert.equal(isAllowedAppNavigation('file:///D:/app/index.html'), false);
  assert.equal(isAllowedAppNavigation('https://example.com'), false);
}

function testMissingConversationResumeErrorDetection(): void {
  assert.equal(
    isMissingConversationResumeError(
      new Error('Claude Code returned an error result: No conversation found with session ID: 026eb341-6b20-4c1e-a3f9-2fe659d37a6f'),
    ),
    true,
  );
  assert.equal(isMissingConversationResumeError(new Error('No active SDK query for session abc')), false);
}

function testMigrationsHandlePartiallyAppliedContextColumns(): void {
  const sessionColumns = new Set([
    'id',
    'name',
    'cli_session_id',
    'model',
    'working_dir',
    'permission_mode',
    'max_turns',
    'model_override',
    'last_context_tokens',
    'created_at',
    'updated_at',
  ]);
  const messageColumns = new Set([
    'id',
    'session_id',
    'role',
    'content',
    'raw_event',
    'event_type',
    'cost_usd',
    'duration_ms',
    'parent_task_id',
    'created_at',
  ]);
  let schemaVersion = 2;

  const addColumn = (table: string, column: string): void => {
    const columns = table === 'sessions' ? sessionColumns : messageColumns;
    if (columns.has(column)) {
      throw new Error(`duplicate column name: ${column}`);
    }
    columns.add(column);
  };

  const db = {
    exec(sql: string) {
      for (const [, table, column] of sql.matchAll(/ALTER TABLE (sessions|messages) ADD COLUMN (\w+)/g)) {
        addColumn(table, column);
      }
    },
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('SELECT version FROM schema_version')) {
            return { version: schemaVersion };
          }
          throw new Error(`Unexpected get SQL: ${sql}`);
        },
        all() {
          if (sql.includes('PRAGMA table_info(sessions)')) {
            return Array.from(sessionColumns, (name) => ({ name }));
          }
          if (sql.includes('PRAGMA table_info(messages)')) {
            return Array.from(messageColumns, (name) => ({ name }));
          }
          if (sql.includes('PRAGMA table_info(tasks)')) {
            // tasks 已含 client_message_id（v5），自愈块跳过 ALTER。
            return ['id', 'session_id', 'prompt', 'status', 'sort_order', 'client_message_id', 'created_at', 'updated_at'].map((name) => ({ name }));
          }
          throw new Error(`Unexpected all SQL: ${sql}`);
        },
        run(version: number) {
          schemaVersion = version;
        },
      };
    },
  };

  assert.doesNotThrow(() => runMigrations(db as never));
  assert.equal(schemaVersion, 8);
  assert.ok(sessionColumns.has('provider_override'), 'V8：迁移后须补 provider_override 列');
  assert.ok(sessionColumns.has('last_context_tokens'));
  assert.ok(sessionColumns.has('last_context_updated_at'));
  assert.ok(sessionColumns.has('thinking_level'), 'V7：迁移后须补 thinking_level 列');
}

// Task2：附件三表迁移契约（attachments / message_attachments / task_attachments）。
// 模拟 schemaVersion=3 老库，跑迁移后须新建附件三表与索引、升到 v4、DDL 带 ON DELETE CASCADE，重复跑幂等。
function testAttachmentMigrationsCreateTablesAndAreIdempotent(): void {
  const createdTables = new Set<string>();
  const createdIndexes = new Set<string>();
  const allExecSql: string[] = [];
  // 预填 v3 老库已有列，模拟升级前的真实状态（自愈块据此跳过 ADD COLUMN）。
  const sessionsColumns = new Set([
    'id', 'name', 'cli_session_id', 'model', 'working_dir', 'permission_mode', 'max_turns',
    'model_override', 'last_context_tokens', 'last_context_updated_at', 'last_context_window',
    'created_at', 'updated_at',
  ]);
  const messagesColumns = new Set([
    'id', 'session_id', 'role', 'content', 'raw_event', 'event_type', 'cost_usd', 'duration_ms',
    'parent_task_id', 'process_kind', 'parent_agent_id', 'tool_use_id', 'title', 'is_error', 'created_at',
  ]);
  // Task 7B：tasks 老库（v3/v4）无 client_message_id，迁移须自愈补加。
  const tasksColumns = new Set([
    'id', 'session_id', 'prompt', 'status', 'sort_order', 'result', 'cost_usd', 'duration_ms',
    'error_message', 'started_at', 'completed_at', 'created_at', 'updated_at',
  ]);
  let schemaVersion = 3;

  const db = {
    exec(sql: string) {
      allExecSql.push(sql);
      for (const [, tbl] of sql.matchAll(/CREATE TABLE IF NOT EXISTS\s+(\w+)/g)) createdTables.add(tbl);
      for (const [, idx] of sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS\s+(\w+)/g)) createdIndexes.add(idx);
      for (const [, tbl, col] of sql.matchAll(/ALTER TABLE (sessions|messages|tasks) ADD COLUMN (\w+)/g)) {
        if (tbl === 'sessions') sessionsColumns.add(col);
        else if (tbl === 'messages') messagesColumns.add(col);
        else if (tbl === 'tasks') tasksColumns.add(col);
      }
    },
    prepare(sql: string) {
      return {
        get() {
          if (sql.includes('SELECT version FROM schema_version')) return { version: schemaVersion };
          throw new Error(`Unexpected get SQL: ${sql}`);
        },
        all() {
          if (sql.includes('PRAGMA table_info(sessions)')) return [...sessionsColumns].map((name) => ({ name }));
          if (sql.includes('PRAGMA table_info(messages)')) return [...messagesColumns].map((name) => ({ name }));
          if (sql.includes('PRAGMA table_info(tasks)')) return [...tasksColumns].map((name) => ({ name }));
          throw new Error(`Unexpected all SQL: ${sql}`);
        },
        run(version: number) {
          schemaVersion = version;
        },
      };
    },
  };

  assert.doesNotThrow(() => runMigrations(db as never));
  assert.equal(schemaVersion, 8, '迁移后 schema version 须升到 8（V8 供应商 override + 别名清洗）');
  assert.ok(sessionsColumns.has('provider_override'), 'V8：老库迁移须补 provider_override 列');
  assert.ok(allExecSql.some((sql) => sql.includes('model_override = NULL')), 'V8：须执行 model_override 别名清洗 SQL');
  assert.ok(createdTables.has('attachments'), '须建 attachments 表');
  assert.ok(createdTables.has('message_attachments'), '须建 message_attachments 关联表');
  assert.ok(createdTables.has('task_attachments'), '须建 task_attachments 关联表');
  assert.ok(createdIndexes.has('idx_attachments_session'));
  assert.ok(createdIndexes.has('idx_message_attachments_attachment'));
  assert.ok(createdIndexes.has('idx_task_attachments_attachment'));
  assert.ok(createdIndexes.has('idx_tasks_client_message_id'), 'Task 7B：须建 tasks.client_message_id 部分唯一索引');

  const execText = allExecSql.join('\n');
  assert.ok(execText.includes('ON DELETE CASCADE'), '附件表 DDL 须含 ON DELETE CASCADE');
  assert.ok(
    /attachments[\s\S]*REFERENCES\s+sessions\s*\(\s*id\s*\)\s+ON DELETE CASCADE/i.test(execText),
    'attachments 须外键引用 sessions 并 CASCADE',
  );

  // 重复迁移不抛错（CREATE TABLE IF NOT EXISTS 幂等）。
  assert.doesNotThrow(() => runMigrations(db as never));
  // 老库原有列仍存在（自愈块不破坏既有列）。
  assert.ok(sessionsColumns.has('last_context_window'));
  assert.ok(messagesColumns.has('process_kind'));
  assert.ok(tasksColumns.has('client_message_id'), 'Task 7B：tasks 须自愈补 client_message_id 列');
}

function testPermissionPromptIntegration(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sdkBackend = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  const ipcTypes = fs.readFileSync(new URL('../src/shared/types/ipc.ts', import.meta.url), 'utf8');
  const cliTypes = fs.readFileSync(new URL('../src/shared/types/cli.ts', import.meta.url), 'utf8');
  const preloadApi = fs.readFileSync(new URL('../src/preload/api.ts', import.meta.url), 'utf8');
  const ipcHandlers = fs.readFileSync(new URL('../src/main/ipc-handlers.ts', import.meta.url), 'utf8');
  const appVue = fs.readFileSync(new URL('../src/renderer/App.vue', import.meta.url), 'utf8');

  // 统一交互弹窗是唯一权限/交互通道；遗留 PERMISSION_REQUEST/PERMISSION_RESPOND 通道、
  // PermissionRequestPayload、preload onPermissionRequest/respondPermission 已作为死代码清理（plan-v1 §5 阶段3）。
  assert.ok(!ipcTypes.includes('PERMISSION_REQUEST'), '遗留 PERMISSION_REQUEST 通道须已清理');
  assert.ok(!ipcTypes.includes('PERMISSION_RESPOND'), '遗留 PERMISSION_RESPOND 通道须已清理');
  assert.ok(!ipcTypes.includes('PermissionRequestPayload'), '遗留 PermissionRequestPayload 须已清理');
  assert.ok(!preloadApi.includes('onPermissionRequest'), '遗留 preload onPermissionRequest 须已清理');
  assert.ok(!preloadApi.includes('respondPermission'), '遗留 preload respondPermission 须已清理');
  assert.ok(ipcTypes.includes('INTERACTION_REQUEST'));
  assert.ok(ipcTypes.includes('INTERACTION_RESPOND'));
  assert.ok(ipcTypes.includes('INTERACTION_CANCEL'));
  assert.ok(ipcTypes.includes('InteractionPromptPayload'));
  assert.ok(cliTypes.includes("'permission_request' | 'permission_denied'"));
  assert.ok(preloadApi.includes('onInteractionRequest'));
  assert.ok(preloadApi.includes('onInteractionCancel'));
  assert.ok(preloadApi.includes('respondInteraction'));
  assert.ok(ipcHandlers.includes('respondToInteractionPrompt'));
  assert.ok(/canUseTool\s*[:=]\s*createPermissionHandler\(sessionId,\s*mainWindow,\s*opts\.workingDir/.test(sdkBackend), 'canUseTool 须接线 createPermissionHandler 并传 workingDir（供改前快照解析相对路径）');
  assert.ok(sdkBackend.includes('supportedDialogKinds'));
  assert.ok(sdkBackend.includes('onUserDialog'));
  assert.ok(sdkBackend.includes('requestInteraction'));
  assert.ok(appVue.includes('<InteractionPrompt />'));

  // ── Task 3：恢复 Claude Code 原生 settings / CLAUDE.md 来源（计划 Task 3 Step 1 契约）──
  const optionsSrc = fs.readFileSync(new URL('../src/main/modules/sdk-command-options.ts', import.meta.url), 'utf8');
  const writerSrc = fs.readFileSync(new URL('../src/main/modules/settings-writer.ts', import.meta.url), 'utf8');
  assert.ok(!/settingSources:\s*\[\]/.test(sdkBackend), '生产 query 不得强制禁用 user/project/local 原生来源');
  assert.ok(!/settingSources:\s*\[\]/.test(optionsSrc), 'probe options 不得强制禁用 user/project/local 原生来源');
  assert.ok(/resolveSettings/.test(sdkBackend), '应接入 SDK resolveSettings 诊断（Task 3 Step 5）');
  assert.ok(/buildNativeSdkOptionsCore/.test(sdkBackend), '生产 query/probe 应共用统一核心 options 构造（Task 3 Step 3）');
  assert.ok(sdkBackend.includes('cwd'), 'sdk-backend 应使用 cwd');
  assert.ok(writerSrc.includes("layer: 'local'"), 'settings-writer 应声明只写 local 层');
  // review-v1 F5：原生 settings 诊断必须接入 IPC 三处（通道常量 + preload 方法 + ipc-handler）。
  assert.ok(ipcTypes.includes('SETTINGS_GET_DIAGNOSTIC'), 'ipc.ts 应定义 settings 诊断通道常量');
  assert.ok(ipcTypes.includes('NativeSettingsDiagnostic'), 'ipc.ts 应定义可克隆 NativeSettingsDiagnostic 类型');
  assert.ok(preloadApi.includes('getNativeSettingsDiagnostic'), 'preload 应暴露 getNativeSettingsDiagnostic');
  assert.ok(ipcHandlers.includes('SETTINGS_GET_DIAGNOSTIC'), 'ipc-handlers 应注册 SETTINGS_GET_DIAGNOSTIC handler');
  assert.ok(ipcHandlers.includes('getNativeSettingsDiagnostic'), 'ipc-handlers 应调用 getNativeSettingsDiagnostic（主进程函数不再死代码）');
  const configStoreSrc = fs.readFileSync(new URL('../src/renderer/stores/config-store.ts', import.meta.url), 'utf8');
  const configPageSrc = fs.readFileSync(new URL('../src/renderer/pages/ConfigPage.vue', import.meta.url), 'utf8');
  assert.ok(configStoreSrc.includes('loadNativeSettingsDiagnostic'), 'renderer store 应消费 settings 诊断 API');
  assert.ok(configPageSrc.includes('loadNativeSettingsDiagnostic'), 'ConfigPage 应触发 settings 诊断加载');
  assert.ok(configPageSrc.includes('nativeSettingsDiagnostic'), 'ConfigPage 应展示 settings 诊断摘要');
  const e2eSettingsSrc = fs.readFileSync(new URL('../scripts/claude-code-command-e2e-verify.ts', import.meta.url), 'utf8');
  const contextHelper = e2eSettingsSrc.match(/function collectContextMarkerResult[\s\S]*?\n}/)?.[0] ?? '';
  assert.ok(contextHelper, 'settings E2E 应有 CLAUDE.md 上下文验证 helper');
  assert.ok(!contextHelper.includes('USER_CLAUDE_CONTEXT_MARKER') && !contextHelper.includes('PROJECT_CLAUDE_CONTEXT_MARKER'), 'query prompt 不得直接包含 CLAUDE.md 目标标记');
  assert.ok(/watch\(\s*\(\)\s*=>\s*store\.config\.workingDirectory/.test(configPageSrc), 'ConfigPage 应监听工作目录变化并刷新诊断');
  assert.ok(configStoreSrc.includes('nativeSettingsDiagnosticRequestId'), 'settings 诊断应有请求代际号');
  assert.ok(/requestId[\s\S]*config\.workingDirectory[\s\S]*nativeSettingsDiagnostic/.test(configStoreSrc), '诊断结果写回前应校验请求代际与当前工作目录');
  assert.ok(/saveConfig[\s\S]*loadNativeSettingsDiagnostic\(this\.config\.workingDirectory\)/.test(configStoreSrc), '配置保存落盘后应刷新 settings 诊断，避免展示过期 effective settings');

  // ── Task 8：命令来源 provenance 跨进程契约 + UI 来源徽章 + 历史不变量 ──
  // 命令诊断 IPC 三处接线（mirror Task 3 settings 诊断：通道常量 + 类型 + preload + handler）。
  assert.ok(ipcTypes.includes('COMMANDS_GET_DIAGNOSTIC'), 'ipc.ts 应定义命令诊断通道常量 COMMANDS_GET_DIAGNOSTIC');
  assert.ok(ipcTypes.includes('CommandProvenance'), 'ipc.ts 应 re-export CommandProvenance 类型');
  assert.ok(preloadApi.includes('getCommandDiagnostics'), 'preload 应暴露 getCommandDiagnostics');
  assert.ok(ipcHandlers.includes('COMMANDS_GET_DIAGNOSTIC'), 'ipc-handlers 应注册 COMMANDS_GET_DIAGNOSTIC handler');
  assert.ok(ipcHandlers.includes('getCommandProvenance'), 'ipc-handlers 应调用 getCommandProvenance（主进程函数不再死代码）');
  // 命令诊断必须只读、无副作用——不得 markSessionActive/触发 probe（区别于 COMMANDS_GET）。
  const registrySrc = fs.readFileSync(new URL('../src/main/modules/sdk-command-registry.ts', import.meta.url), 'utf8');
  assert.ok(registrySrc.includes('getCommandProvenance(sessionId: string): CommandProvenance'), 'registry 应有 getCommandProvenance 方法（只读派生）');
  assert.ok(/getCommandProvenance[\s\S]*?不触发 probe|只读[\s\S]*?无副作用/.test(registrySrc), 'getCommandProvenance 须明确只读无副作用（不触发 probe）');
  // 历史不变量：provenance 诊断是 transient 状态，不被当成聊天消息持久化（与 commands_changed 同语义）。
  // local_command_output 主进程单一落库已在 §4 钉住；此处强化命令诊断不经 renderer 二次落库。
  const useChatSrcT8 = fs.readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  assert.ok(!useChatSrcT8.includes('getCommandDiagnostics'), 'renderer 聊天流不得消费命令诊断 API（诊断是 UI 状态，非聊天消息，不二次落库）');
  // UI 来源徽章：ChatInput 区分 builtin/Skill/project/plugin，不让 source=sdk 被误读为官方 builtin；
  // unknown 作为可见差异状态（计数展示，不被当 builtin 完成）。
  const chatInputSrc = fs.readFileSync(new URL('../src/renderer/components/chat/ChatInput.vue', import.meta.url), 'utf8');
  assert.ok(chatInputSrc.includes('slash-menu__origin'), 'ChatInput 应有来源徽章元素 slash-menu__origin');
  assert.ok(chatInputSrc.includes('originLabel'), 'ChatInput 应有 originLabel 来源文案映射');
  assert.ok(chatInputSrc.includes('Claude Code 内置'), '来源徽章应区分 builtin（Claude Code 内置）');
  assert.ok(chatInputSrc.includes('用户 Skill'), '来源徽章应区分 user-skill（用户 Skill）');
  assert.ok(/unknownCount[\s\S]*?来源未知/.test(chatInputSrc), 'ChatInput 应展示 unknown 命令计数（来源未知作为可见差异状态）');
  // command-store 诊断状态：按 sessionId 缓存，静默失败不抛页面（mirror load 模式）。
  const commandStoreSrc = fs.readFileSync(new URL('../src/renderer/stores/command-store.ts', import.meta.url), 'utf8');
  assert.ok(commandStoreSrc.includes('diagnosticsBySession'), 'command-store 应缓存 diagnosticsBySession');
  assert.ok(commandStoreSrc.includes('loadDiagnostics'), 'command-store 应有 loadDiagnostics action');
  assert.ok(commandStoreSrc.includes('activeDiagnostics'), 'command-store 应有 activeDiagnostics getter');
  assert.ok(commandStoreSrc.includes('getCommandDiagnostics'), 'command-store loadDiagnostics 应调用 getCommandDiagnostics API');
  const commandMatrixSrc = fs.readFileSync(new URL('../scripts/claude-code-command-matrix.ts', import.meta.url), 'utf8');
  assert.ok(commandMatrixSrc.includes('PENDING_MATRIX_OUT_FILE'), 'runtime-only 命令应有待补规格输出路径');
  assert.ok(commandMatrixSrc.includes('writeFileSync'), 'runtime-only 命令应持久化待补矩阵规格');
  // review-v1 F6：query 与 probe 共用统一 settings 构造（buildClaudeLinkSettingsBlock），
  // 工厂把显式 settings 放入 Options.settings，杜绝两条路径各自重复构造 settings。
  assert.ok(sdkBackend.includes('buildClaudeLinkSettingsBlock'), 'sdk-backend 应有统一 settings 块构造函数（F6）');
  assert.ok(
    (sdkBackend.match(/buildClaudeLinkSettingsBlock\(config,\s*sessionId,\s*opts,\s*thinkingConfig,\s*requestedAlias(?:,\s*(?:override|modelOverride))?\)/g) ?? []).length >= 2,
    '生产 query 与 probe 必须调用同一个 buildClaudeLinkSettingsBlock（F6：杜绝配置漂移）',
  );
  assert.ok(optionsSrc.includes('settings?: Record<string, unknown>'), '统一 options 工厂输入应含显式 settings（F6）');
  assert.ok(optionsSrc.includes('options.settings = input.settings'), '工厂应把显式 settings 放入 Options.settings（F6）');
  assert.ok(optionsSrc.includes('options.additionalDirectories = input.additionalDirectories'), '工厂应把 additionalDirectories 放入 Options（F6）');

  // ── Task 4：统一原生命令 query、结果和取消语义（计划 Task 4 Step 1/3/4/5 契约）──
  const useChatCmd = fs.readFileSync(new URL('../src/renderer/composables/use-chat.ts', import.meta.url), 'utf8');
  const sdkInteractions = fs.readFileSync(new URL('../src/main/modules/sdk-interactions.ts', import.meta.url), 'utf8');
  // §4：local_command_output 主进程单一落库（role:system + processKind），renderer 按 persisted_message upsert 不二次落库。
  assert.ok(sdkBackend.includes('persistLocalCommandOutput'), 'local_command_output 应由主进程单一落库（persistLocalCommandOutput）');
  assert.ok(sdkBackend.includes("processKind: 'system:local_command_output'"), 'local_command_output 落库 processKind 须为 system:local_command_output');
  assert.ok(/persistLocalCommandOutput[\s\S]*?role: 'system'[\s\S]*?persisted_message/.test(sdkBackend), 'local_command_output 落库后须推 persisted_message 让 renderer upsert');
  assert.ok(sdkBackend.includes("subtype === 'local_command_output'"), 'runQuery 须识别 local_command_output 子类型并单一落库');
  // §4：commands_changed 全量替换（REPLACE，不 concat，source:'changed'）。
  assert.ok(sdkBackend.includes("subtype === 'commands_changed'"), 'runQuery 须识别 commands_changed 子类型');
  assert.ok(/replace\(sessionId,\s*rawCommands,\s*'changed'/.test(sdkBackend), 'commands_changed 须全量替换（source:changed，不 concat）');
  // §1/§4：renderer 命令结果去重——result.result 与 local_command_output 内容相同时不二次落库。
  assert.ok(useChatCmd.includes('hasLocalCommandOutputMessage'), 'renderer 应有 local_command_output 去重判断');
  assert.ok(useChatCmd.includes("'system:local_command_output'"), '去重须匹配 processKind system:local_command_output');
  assert.ok(/ensureResultMessage[\s\S]*?hasLocalCommandOutputMessage/.test(useChatCmd), 'ensureResultMessage 须调用去重避免命令结果二次落库');
  // §3：统一命令执行入口——命令与普通消息同一 runQuery/buildSdkOptions，prompt 原样透传，无命令 prompt 翻译器。
  assert.ok(ipcHandlers.includes('sendMessage(sessionId, prepared.prompt)'), 'CHAT_SEND 须用原样 prepared.prompt，不得翻译命令文本');
  assert.ok(/async function runQuery\([\s\S]*?prompt: SdkPrompt/.test(sdkBackend), 'runQuery 须接收原始 prompt（命令与普通消息同一入口）');
  assert.ok(sdkBackend.includes('startSdkQuery(prompt, sdkOptions)'), 'runQuery 须把原始 prompt 原样传给 SDK query（无中间翻译）');
  assert.ok(!sdkBackend.includes('translateSlashCommand') && !sdkBackend.includes('commandToPrompt'), '不得存在命令 prompt 翻译器（绕过 SDK 的近似实现）');
  // §4：终态与取消——流末无 result 合成 aborted 复位 sending；中断走 aborted（不弹错误）；executable 缺失中文错误。
  assert.ok(sdkBackend.includes("type: 'aborted'"), 'runQuery 须合成 aborted 终态（流末无 result / 中断）');
  assert.ok(sdkBackend.includes('已中断'), '用户中断须发 aborted（不弹错误，与 SDK 执行出错解耦）');
  assert.ok(sdkBackend.includes('未检测到本地 Claude Code'), 'executable 缺失须发中文错误，不伪装成功');
  assert.ok(/killProcess[\s\S]*?interruptedQueries\.add/.test(sdkBackend), 'killProcess 须记入 interruptedQueries 让 runQuery 走 aborted 分支');
  // §5：取消与 deny 解耦——reason:'user' 记「用户拒绝」；abort/缺省记中性「已取消」，防 transcript 误 deny。
  assert.ok(sdkInteractions.includes("response.reason === 'user'"), '权限响应须按 reason 分映（user vs abort）');
  assert.ok(sdkInteractions.includes('用户拒绝了该工具调用'), 'reason:user 须记 deny「用户拒绝」语义');
  assert.ok(sdkInteractions.includes('工具调用已取消'), 'reason:abort/缺省须记中性 deny「已取消」（不指控用户）');
  // §1：e2e harness 钉住 /init 真实落盘契约（bypassPermissions + 真实 key，plan 模式不落盘）。
  const e2eCmdSrc = fs.readFileSync(new URL('../scripts/claude-code-command-e2e-verify.ts', import.meta.url), 'utf8');
  assert.ok(e2eCmdSrc.includes("permissionMode: 'bypassPermissions'"), '/init E2E 须用 bypassPermissions 让 Write 真实执行（plan 模式只产计划不落盘）');
  // review P1-4：凭据检测须覆盖 env + settings（user/project/local）的 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN，不只 settings.json。
  assert.ok(e2eCmdSrc.includes('resolveInitCredentials'), '/init E2E 凭据检测须用 resolveInitCredentials 统一解析（P1-4）');
  assert.ok(e2eCmdSrc.includes('ANTHROPIC_AUTH_TOKEN'), '/init E2E 凭据检测须覆盖 ANTHROPIC_AUTH_TOKEN，不只 ANTHROPIC_API_KEY（P1-4）');
  // review-v4 F3：resolveInitCredentials 接收 cwd（async）并检查多层 settings；无凭据时走 SKIP 分支（不得 plan 假成功）。
  assert.ok(/await resolveInitCredentials\([\s\S]*?\)[\s\S]*?SKIP/.test(e2eCmdSrc), '/init E2E 无凭据时须 SKIP，不得用 plan 假成功冒充（P1-4 / review-v4 F3）');
  assert.ok(e2eCmdSrc.includes('local-settings'), 'resolveInitCredentials 须检查 local settings（review-v4 F3）');
  assert.ok(e2eCmdSrc.includes("writeFileSync(path.join(initCwd"), '/init E2E 须在 cwd 放真实文件让 /init 有内容可分析（空目录不落盘）');
  // review P1-3：清理须用 safeRmSync 带退避重试，EBUSY 不覆盖已通过的核心断言。
  assert.ok(e2eCmdSrc.includes('safeRmSync'), 'e2E 清理须用 safeRmSync 带退避重试（P1-3）');
  assert.ok(/safeRmSync[\s\S]*?不影响核心断言/.test(e2eCmdSrc), 'safeRmSync 清理失败须只 log 不 throw，不覆盖核心断言（P1-3）');
  // Task 4 review P1-1：主进程持久化层命令结果去重——result.result 与本回合 local_command_output
  // 正文相同时不重复落库（去重下沉到 persistCliEvent，与 renderer hasLocalCommandOutputMessage 同形）。
  const cliSharedSrc = fs.readFileSync(new URL('../src/main/modules/cli-shared.ts', import.meta.url), 'utf8');
  assert.ok(cliSharedSrc.includes('currentTurnHasLocalCommandOutput'), '主进程 result 落库须检查 local_command_output 去重（P1-1）');
  assert.ok(/currentTurnHasLocalCommandOutput\(sessionId,\s*text\)/.test(cliSharedSrc), 'result case 须调用 local_command_output 去重判定（P1-1）');
  assert.ok(/system:local_command_output[\s\S]*?\.trim\(\) === needle/.test(cliSharedSrc), '主进程去重须与 renderer 同形（正文 trim 相同才跳过，P1-1）');
  // Task 4 review P1-2：killProcess 对 user/watchdog 显式发幂等 aborted（entry 移除后 runQuery
  // 流末兜底与 catch 段 !isCurrentEntry 都不会再发，须由 killProcess 补发，防后台会话 sending 不复位）。
  assert.ok(/reason === 'user' \|\| reason === 'watchdog'/.test(sdkBackend), 'killProcess 须对 user/watchdog reason 判定发 aborted（P1-2）');
  assert.ok(/reason === 'user' \|\| reason === 'watchdog'[\s\S]*?forwardEvent[\s\S]*?type: 'aborted'/.test(sdkBackend), 'killProcess 须在移除 entry 后 forwardEvent aborted（P1-2）');
  // review P2-1：/compact 须用 warmup+resume 有上下文场景，移除 typeof result==='string' 放宽。
  assert.ok(/warmup[\s\S]*?resume: cliSid/.test(e2eCmdSrc), '/compact 须 warmup 产生上下文再 resume 压缩（P2-1）');
  // review-v9 §3 收窄：禁令只作用于 verifyCompactEvidence（成功判据不得用 typeof result 放宽）；
  // 其它场景（如 sideEffect 文件路径诊断）允许以类型安全方式提取 result 文本。
  const compactFn = e2eCmdSrc.match(/async function verifyCompactEvidence[\s\S]*?\n}/);
  assert.ok(compactFn, 'verifyCompactEvidence 函数体未找到');
  assert.ok(
    !/typeof run\.termination\?\.result === 'string'/.test(compactFn[0]),
    '/compact 成功判据不得用 typeof result===string 放宽（空字符串也命中，P2-1）',
  );
  // review-v2 F1：/compact 收紧为只认 compact_boundary / compact_result:'success'。
  // 旧 hasStatus（任意 system:status）/ 非空 local_command_output 不再当成功证据（status:'compacting'
  // 仅表示开始压缩，compact_result:'failed' 明确未压缩）。共享 helper verifyCompactEvidence 供 --command/--replacements 复用。
  assert.ok(/verifyCompactEvidence/.test(e2eCmdSrc), '/compact 须经 verifyCompactEvidence 共享 helper 验证真实压缩证据（review-v2 F1）');
  assert.ok(/compact_result === 'success'/.test(e2eCmdSrc), '/compact 须断言 compact_result:\'success\' 作为成功证据（review-v2 F1 收紧）');
  assert.ok(!/hasBoundary \|\| hasLocalOutput \|\| hasStatus/.test(e2eCmdSrc), '/compact 不得保留旧的 hasBoundary||hasLocalOutput||hasStatus 泛化断言（review-v2 F1 已收紧）');
  // review P1-6：取消/启动失败/executable 缺失/权限拒绝真实场景。
  assert.ok(e2eCmdSrc.includes('abortAfterMs'), 'e2e 须有用户取消场景 abortAfterMs（P1-6）');
  assert.ok(/executable 缺失[\s\S]*?不伪造成功/.test(e2eCmdSrc), 'e2e 须有 executable 缺失不伪造成功场景（P1-6）');
  assert.ok(/plan 模式 \/init[\s\S]*?不得落盘/.test(e2eCmdSrc), 'e2e 须有 plan /init 权限拒绝不落盘场景（P1-6）');
  // ── Task 4 review-v2 ──
  // P1-1 + review-v4 P1-1：/init harness wall-clock 与 CLI API_TIMEOUT_MS 解耦（旧 300s 同值导致竞争，
  // abort 压制真实 result）。用 harnessInitDeadlineMs（API_TIMEOUT_MS + 余量）；result 断言不放宽。
  assert.ok(e2eCmdSrc.includes('harnessInitDeadlineMs'), '/init E2E 超时须用 harnessInitDeadlineMs 解耦 wall-clock 与 API_TIMEOUT_MS（review-v4 P1-1）');
  assert.ok(!e2eCmdSrc.includes('timeoutMs: 300000'), '/init 不得保留硬编码 timeoutMs: 300000（review-v4 P1-1 解耦）');
  assert.ok(/run\.termination[\s\S]*?超时=.*启动错误=/.test(e2eCmdSrc), '/init 失败须记录 timedOut/queryError/事件序列供诊断，不放宽 result 断言（review-v2 P1-1）');
  // P1-3：harness 合成事件与 SDK 原始事件分离，取消断言不靠 harness 合成放宽。
  assert.ok(e2eCmdSrc.includes('syntheticEvents'), 'e2e 须分离 syntheticEvents（harness 合成）与 events（SDK 原始）（review-v2 P1-3）');
  assert.ok(/syntheticEvents[\s\S]*?不计入通过条件/.test(e2eCmdSrc), 'syntheticEvents 不得计入取消断言通过条件（review-v2 P1-3）');
  assert.ok(/run\.queryError[\s\S]*?run\.timedOut/.test(e2eCmdSrc), '启动失败须用 queryError/timedOut 区分，不靠 harness 合成 aborted（review-v2 P1-3）');
  // review-v2 P1-3 修复：普通文本/用户取消 cwd 须存在（否则 SDK failed to launch，被 synthetic aborted
  // / abortAfterMs !timedOut 掩盖，暴露为流末无 result 假象）。review-v5 起 cwd 在 runCommandMode 顶部统一创建。
  assert.ok(/const plainCwd = path\.join\(root, 'plain'\)/.test(e2eCmdSrc), '普通文本 E2E 须定义 plainCwd（防 failed to launch 被 synthetic 掩盖，review-v2 P1-3）');
  assert.ok(/普通文本原样进入 query[\s\S]*?plainCwd/.test(e2eCmdSrc), '普通文本块须以 plainCwd 为 cwd');
  assert.ok(/const abortCwd = path\.join\(root, 'abort'\)/.test(e2eCmdSrc), '用户取消 E2E 须定义 abortCwd（防 failed to launch 被 abortAfterMs !timedOut 掩盖，review-v2 P1-3）');
  assert.ok(/用户取消（abort）[\s\S]*?abortCwd/.test(e2eCmdSrc), '用户取消块须以 abortCwd 为 cwd');
  // P1-4：真实用户 deny 交互（canUseTool 返回 deny），非 plan 模式拦截。
  assert.ok(e2eCmdSrc.includes('canUseTool: async'), 'e2e 须有真实 canUseTool deny 交互测试（review-v2 P1-4）');
  assert.ok(/denyCount > 0/.test(e2eCmdSrc), 'deny 测试须断言 canUseTool 被调用（权限请求产生）（review-v2 P1-4）');
  assert.ok(/与 abort 路径分离/.test(e2eCmdSrc), 'deny 测试须与 abort 路径终态区分（review-v2 P1-4）');
  // P1-2：matrix --require-runtime-match 在 baseline 过期/缺失时自动重新采集（版本绑定当前 executable/SDK）。
  const matrixSrc = fs.readFileSync(new URL('../scripts/claude-code-command-matrix.ts', import.meta.url), 'utf8');
  const baselineSrc = fs.readFileSync(new URL('../scripts/claude-code-command-baseline.ts', import.meta.url), 'utf8');
  assert.ok(baselineSrc.includes('export async function collectBaselineToFile'), 'baseline 须 export collectBaselineToFile 供 matrix 复用（review-v2 P1-2）');
  assert.ok(matrixSrc.includes('collectBaselineToFile'), 'matrix 须 import collectBaselineToFile（review-v2 P1-2）');
  assert.ok(/needsRegen[\s\S]*?collectBaselineToFile/.test(matrixSrc), 'matrix 须在 baseline 过期/缺失时自动重新采集，不依赖旧缓存时间戳（review-v2 P1-2）');
  // ── Task 4 review-v4 ──
  // P1-3：baseline 入口 IIFE 必须 require.main === module 守卫。matrix import collectBaselineToFile 复用
  // 采集时若入口在导入期即执行，会以调用方无关的 RUN_NATIVE 打 SKIP 并 process.exit(0) 劫持 matrix 进程
  // （selftest:native 里 matrix --require-runtime-match 无 env，断言从未运行却整体 exit 0 假绿）。
  assert.ok(/require\.main === module[\s\S]*?void \(async \(\) =>/.test(baselineSrc), 'baseline 入口须 require.main 守卫，被 matrix 导入时不执行入口（review-v4 P1-3）');
  // ── Task 4 review-v3 ──
  // P1-1/P1-2：/init 与普通文本失败须输出完整 result 诊断（subtype/errors/terminal_reason/api_error_status/
  // stop_reason/result 文本/事件序列/文件状态），定位端点/认证/maxTurns 根因；is_error===false 保持强制不放宽。
  assert.ok(e2eCmdSrc.includes('resultDiagnostic'), 'e2e 须有 resultDiagnostic 输出完整 result 诊断（review-v3 P1-1/P1-2）');
  assert.ok(
    /subtype=\$\{head\(t\?\.subtype\)\}[\s\S]*?stop_reason=\$\{head\(t\?\.stop_reason\)\}[\s\S]*?api_error_status=\$\{head\(t\?\.api_error_status\)\}[\s\S]*?errors=\$\{head\(t\?\.errors\)\}/.test(e2eCmdSrc),
    'resultDiagnostic 须输出 subtype/stop_reason/api_error_status/errors 等完整字段（review-v3 P1-1）',
  );
  assert.ok(/不得 is_error[\s\S]*?resultDiagnostic/.test(e2eCmdSrc), '/init/普通文本 is_error 断言失败须带 resultDiagnostic 完整诊断（review-v3 P1-1/P1-2）');
  // ── Task 4 review-v4 ──
  // /init 与普通文本 success fixture 必须显式给足 maxTurns，不能继承 helper 默认 1 或固定 20
  // 而在模型仍有 tool_use 时被 error_max_turns 截断；普通文本 success 路径必须是 result + is_error=false，
  // 未安排 cancel 时不得让真实 aborted 作为成功。
  assert.ok(/\/init[\s\S]*?maxTurns:\s*50/.test(e2eCmdSrc), '/init success E2E 须显式 maxTurns:50（review-v4 P1-1：20 不足会 error_max_turns）');
  assert.ok(/普通文本[\s\S]*?maxTurns:\s*10/.test(e2eCmdSrc), '普通文本 success E2E 须显式 maxTurns:10（review-v4 P1-2：不得继承 helper 默认 1）');
  assert.ok(/普通文本[\s\S]*?assert\.equal\(run\.termination\?\.type,\s*'result'/.test(e2eCmdSrc), '普通文本 success E2E 须强制真实 result 终态（不得把 aborted 当成功，review-v4 P1-2）');
  assert.ok(/普通文本[\s\S]*?assert\.equal\(run\.termination\?\.is_error,\s*false/.test(e2eCmdSrc), '普通文本 success E2E 须强制 result.is_error=false（review-v4 P1-2）');
}

function testPermissionInteractionAdapter(): void {
  const sdkSuggestion = { type: 'addRules' as const, rules: [{ toolName: 'Bash' }], behavior: 'allow' as const, destination: 'localSettings' as const };
  const sessionSuggestion = { ...sdkSuggestion, destination: 'session' as const };
  const payload = buildPermissionInteractionPayload('session-1', 'Bash', { command: 'npm run typecheck' }, {
    toolUseID: 'tool-1',
    signal: new AbortController().signal,
    suggestions: [sdkSuggestion],
    description: '需要运行类型检查',
  });

  assert.equal(payload.kind, 'permission');
  assert.equal(payload.toolName, 'Bash');
  assert.equal(payload.toolUseId, 'tool-1');
  assert.deepEqual(payload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(payload.suggestions, [sessionSuggestion]);
  assert.deepEqual(payload.defaultOptionIds, []);

  const invalidSuggestionPayload = buildPermissionInteractionPayload('session-1', 'Bash', { command: 'npm run typecheck' }, {
    toolUseID: 'tool-invalid',
    signal: new AbortController().signal,
    suggestions: [{ tool: 'Bash' }],
  });
  assert.deepEqual(invalidSuggestionPayload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(invalidSuggestionPayload.suggestions, [{ type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' }]);

  const noSuggestionPayload = buildPermissionInteractionPayload('session-1', 'WebFetch', { url: 'https://example.com' }, {
    toolUseID: 'tool-webfetch',
    signal: new AbortController().signal,
  });
  assert.deepEqual(noSuggestionPayload.options?.map((option) => option.id), ['allow', 'allow-session', 'deny']);
  assert.deepEqual(noSuggestionPayload.suggestions, [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }]);

  const permInput = { command: 'npm run typecheck' };
  // P0：allow/allow-session 必须回传 updatedInput（原样 input），否则 SDK 运行时 ZodError 阻断所有工具。
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow'] }, permInput), {
    behavior: 'allow',
    updatedInput: permInput,
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'submit', selectedOptionIds: ['allow-session'] }, permInput), {
    behavior: 'allow',
    updatedInput: permInput,
    updatedPermissions: [sessionSuggestion],
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(noSuggestionPayload, { id: noSuggestionPayload.id, action: 'submit', selectedOptionIds: ['allow-session'] }, { url: 'https://example.com' }), {
    behavior: 'allow',
    updatedInput: { url: 'https://example.com' },
    updatedPermissions: [{ type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' }],
    toolUseID: 'tool-webfetch',
  });
  // cancel 按来源分映（plan-v1 §3.2）：用户主动拒绝 → 「用户拒绝」；系统取消/缺省 → 中性「已取消」。
  // 系统取消不能记成「用户拒绝」喂给模型——否则 resume 时模型读到这条 is_error tool_result 会认定用户
  // 拒绝过该工具，本会话后续不再调用（并发会话权限误 deny 的根因）。
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel', reason: 'user' }, permInput), {
    behavior: 'deny',
    message: '用户拒绝了该工具调用',
    toolUseID: 'tool-1',
  });
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel', reason: 'abort' }, permInput), {
    behavior: 'deny',
    message: '工具调用已取消',
    toolUseID: 'tool-1',
  });
  // 缺省 reason 防御性按中性处理：宁可不指控用户，也不把非用户意图错记为用户拒绝。
  assert.deepEqual(mapPermissionInteractionResponse(payload, { id: payload.id, action: 'cancel' }, permInput), {
    behavior: 'deny',
    message: '工具调用已取消',
    toolUseID: 'tool-1',
  });
}

function testPermissionSettingsMergeAndSessionCoercion(): void {
  // Task 3 Step 4：用户未显式选非默认 mode（= 'default'）时，不得强制写 defaultMode 覆盖原生文件。
  const base = buildPermissionSettings({
    permissionMode: 'default',
    advancedJson: JSON.stringify({ permissions: { allow: ['Read'], ask: ['Bash(git status)'], additionalDirectories: ['D:/work'] } }),
  });
  assert.deepEqual(base, { allow: ['Read'], ask: ['Bash(git status)'], additionalDirectories: ['D:/work'] });
  // 显式非默认 mode 才强制写 defaultMode（Claude Link 显式设置优先级最高）。
  assert.deepEqual(buildPermissionSettings({ permissionMode: 'acceptEdits', advancedJson: null }), { defaultMode: 'acceptEdits' });
  const syncedDefault = syncFormToAdvancedJson(JSON.stringify({ permissions: { defaultMode: 'plan' } }), {
    apiKey: '', apiBaseUrl: 'https://api.anthropic.com', permissionMode: 'default',
  });
  assert.deepEqual(JSON.parse(syncedDefault), {}, '表单默认权限不得把 defaultMode 写回 advancedJson 覆盖原生层');

  assert.deepEqual(applyPermissionUpdates(base, [
    { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' },
  ]).allow, ['Read']);

  const normalized = coercePermissionUpdatesToSession([
    { type: 'addRules', rules: [{ toolName: 'WebSearch' }], behavior: 'allow', destination: 'localSettings' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'git push*' }], behavior: 'ask', destination: 'session' },
    { type: 'removeRules', rules: [{ toolName: 'Bash', ruleContent: 'git status' }], behavior: 'ask', destination: 'session' },
    { type: 'setMode', mode: 'dontAsk', destination: 'session' },
    { type: 'addDirectories', directories: ['D:/tmp'], destination: 'session' },
    { type: 'removeDirectories', directories: ['D:/work'], destination: 'session' },
  ]);
  assert.deepEqual(normalized.map((update) => update.destination), ['session', 'session', 'session', 'session', 'session', 'session', 'session']);

  const merged = applyPermissionUpdates(base, normalized);
  assert.equal(merged.defaultMode, 'dontAsk');
  assert.deepEqual(merged.allow, ['Read', 'WebSearch', 'WebFetch(domain:example.com)']);
  assert.deepEqual(merged.ask, ['Bash(git push*)']);
  assert.deepEqual(merged.additionalDirectories, ['D:/tmp']);

  const replaced = applyPermissionUpdates(base, [{ type: 'replaceRules', rules: [{ toolName: 'Glob' }], behavior: 'allow', destination: 'session' }]);
  assert.deepEqual(replaced.allow, ['Glob']);

  assert.deepEqual(withToolSessionAllow('WebFetch', [
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
  ]), [
    { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
    { type: 'addRules', rules: [{ toolName: 'WebFetch' }], behavior: 'allow', destination: 'session' },
  ]);
}

function testAskUserQuestionInteractionAdapter(): void {
  const question = {
    question: 'Which approach should we use?',
    header: 'Approach',
    multiSelect: false,
    options: [
      { label: 'A', description: 'First option' },
      { label: 'B', description: 'Second option', preview: 'Preview B' },
    ],
  };
  const payload = buildAskUserQuestionInteractionPayload('session-1', question, 0, 'tool-ask');

  assert.equal(payload.kind, 'single-choice');
  assert.equal(payload.source, 'Approach');
  assert.deepEqual(payload.defaultOptionIds, []);
  assert.equal(payload.allowOther, true);
  assert.equal(payload.options?.at(-1)?.id, OTHER_INTERACTION_OPTION_ID);
  assert.equal(payload.options?.[1].preview, 'Preview B');

  const recommendedPayload = buildAskUserQuestionInteractionPayload('session-1', {
    ...question,
    options: [
      { label: 'A', description: 'First option' },
      { label: 'B (Recommended)', description: 'Second option' },
    ],
  }, 0, 'tool-ask-recommended');
  assert.deepEqual(recommendedPayload.defaultOptionIds, ['option-1']);

  const result = buildAskUserQuestionResult([question], [{
    payload,
    response: { id: payload.id, action: 'submit', selectedOptionIds: ['option-1'] },
  }]);

  assert.deepEqual(result.answers, { 'Which approach should we use?': 'B' });
  assert.deepEqual(result.annotations, { 'Which approach should we use?': { preview: 'Preview B' } });
}

function testInteractionPromptV2V3Contracts(): void {
  const markdown = normalizeInteractionPreview('**Plan**\n\n- Ship it', 'markdown');
  assert.deepEqual(markdown, { type: 'markdown', content: '**Plan**\n\n- Ship it' });
  const code = normalizeInteractionPreview({ type: 'code', content: 'const x = 1;', language: 'ts' });
  assert.deepEqual(code, { type: 'code', content: 'const x = 1;', language: 'ts' });
  const table = normalizeInteractionPreview({ type: 'table', headers: ['A'], rows: [['B']] });
  assert.deepEqual(table, { type: 'table', headers: ['A'], rows: [['B']] });

  assert.equal(shouldUseVirtualOptions(Array.from({ length: 30 }, (_, index) => ({ id: String(index), label: String(index) }))), false);
  assert.equal(shouldUseVirtualOptions(Array.from({ length: 80 }, (_, index) => ({ id: String(index), label: String(index) }))), true);
}

function testInteractionPromptWizardAndHistoryContracts(): void {
  const questions = [
    {
      question: 'Pick a runtime?',
      header: 'Runtime',
      multiSelect: false,
      options: [
        { label: 'Node', description: 'Use Node.js' },
        { label: 'Bun', description: 'Use Bun' },
      ],
    },
    {
      question: 'Pick checks?',
      header: 'Checks',
      multiSelect: true,
      options: [
        { label: 'Types', description: 'Run typecheck' },
        { label: 'Tests', description: 'Run tests' },
      ],
    },
  ];
  const wizard = buildWizardAskUserQuestionPayload('session-1', questions, 'tool-wizard', 'fixed-id');
  assert.equal(wizard.kind, 'form');
  assert.equal(wizard.questions?.length, 2);
  assert.equal(wizard.questions?.[1].multiSelect, true);
  assert.equal(wizard.questions?.[0].options.at(-1)?.id, OTHER_INTERACTION_OPTION_ID);

  const result = buildAskUserQuestionResult(questions, [{
    payload: wizard,
    response: {
      id: wizard.id,
      action: 'submit',
      questionAnswers: {
        q0: { selectedOptionIds: ['option-1'] },
        q1: { selectedOptionIds: ['option-0', OTHER_INTERACTION_OPTION_ID], otherText: 'Lint' },
      },
    },
  }]);
  assert.deepEqual(result.answers, {
    'Pick a runtime?': 'Bun',
    'Pick checks?': 'Types, Lint',
  });

  const history = interactionHistoryEntryFromResponse(wizard, {
    id: wizard.id,
    action: 'submit',
    fieldValues: { note: 'approved', urgent: true },
  });
  assert.equal(history.promptId, 'fixed-id');
  assert.equal(history.kind, 'form');
  assert.equal(history.action, 'submit');
  assert.deepEqual(history.fieldValues, { note: 'approved', urgent: true });
}

function testGenericDialogTextAndFormContracts(): void {
  const textPayload = buildGenericInteractionPayload('session-1', 'free_text', {
    title: 'Explain why?',
    inputType: 'text',
  }, 'tool-text');
  assert.equal(textPayload.kind, 'text');
  assert.equal(textPayload.title, 'Explain why?');
  assert.deepEqual(dialogResultFromInteraction({ id: textPayload.id, action: 'submit', otherText: 'Because it is safer' }), {
    response: 'Because it is safer',
  });

  const formPayload = buildGenericInteractionPayload('session-1', 'collect_params', {
    title: 'Collect params',
    requestedSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', title: 'Name' },
        dryRun: { type: 'boolean', title: 'Dry run' },
        mode: { type: 'string', title: 'Mode', enum: ['fast', 'safe'] },
      },
    },
  });
  assert.equal(formPayload.kind, 'form');
  assert.deepEqual(formPayload.fields?.map((field) => [field.id, field.type, field.required]), [
    ['name', 'text', true],
    ['dryRun', 'checkbox', false],
    ['mode', 'select', false],
  ]);
  assert.deepEqual(dialogResultFromInteraction({ id: formPayload.id, action: 'submit', fieldValues: { name: 'Chen', dryRun: true, mode: 'safe' } }), {
    name: 'Chen',
    dryRun: true,
    mode: 'safe',
  });
}

function testAskUserQuestionMultiSelectAndOther(): void {
  const questions = [
    {
      question: 'Which features do you want to enable?',
      header: 'Features',
      multiSelect: true,
      options: [
        { label: 'Logs', description: 'Enable logs' },
        { label: 'Metrics', description: 'Enable metrics' },
      ],
    },
    {
      question: 'Which library should we use?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'Built-in', description: 'Use platform APIs' },
        { label: 'Package', description: 'Install dependency' },
      ],
    },
  ];
  const firstPayload = buildAskUserQuestionInteractionPayload('session-1', questions[0], 0);
  const secondPayload = buildAskUserQuestionInteractionPayload('session-1', questions[1], 1);
  const result = buildAskUserQuestionResult(questions, [
    { payload: firstPayload, response: { id: firstPayload.id, action: 'submit', selectedOptionIds: ['option-0', 'option-1'] } },
    { payload: secondPayload, response: { id: secondPayload.id, action: 'submit', selectedOptionIds: [OTHER_INTERACTION_OPTION_ID], otherText: 'Use local helper' } },
  ]);

  assert.equal(result.answers['Which features do you want to enable?'], 'Logs, Metrics');
  assert.equal(result.answers['Which library should we use?'], 'Use local helper');
  assert.equal(result.response, 'Use local helper');

  const combined = buildAskUserQuestionResult([questions[0]], [
    { payload: firstPayload, response: { id: firstPayload.id, action: 'submit', selectedOptionIds: ['option-0', OTHER_INTERACTION_OPTION_ID], otherText: 'Tracing' } },
  ]);
  assert.equal(combined.answers['Which features do you want to enable?'], 'Logs, Tracing');
  assert.ok(SUPPORTED_USER_DIALOG_KINDS.includes('plan_mode'));
}

// T13/M4：onElicitation 的 url 模式（MCP 浏览器 OAuth）。
function testElicitationUrlMode(): void {
  // url 模式 → confirm 框，input 带 url，用户复制去浏览器完成授权。
  const urlPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'github',
    message: 'Authorize GitHub',
    mode: 'url',
    url: 'https://github.com/login/oauth/authorize?client_id=abc',
    elicitationId: 'elicit-1',
  });
  assert.equal(urlPayload.kind, 'confirm');
  assert.equal(urlPayload.toolUseId, 'elicit-1');
  assert.equal((urlPayload.input as { url?: string }).url, 'https://github.com/login/oauth/authorize?client_id=abc');
  assert.deepEqual(urlPayload.options?.map((option) => option.id), ['confirm']);

  // form 模式 → 通用表单（不退化为 url 确认框）。
  const formPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'db',
    message: 'Configure DB',
    mode: 'form',
    requestedSchema: {
      type: 'object',
      required: ['host'],
      properties: { host: { type: 'string', title: 'Host' } },
    },
  });
  assert.equal(formPayload.kind, 'form');
  assert.deepEqual(formPayload.fields?.map((field) => [field.id, field.required]), [['host', true]]);

  // text 模式（无 mode）→ 通用文本输入。
  const textPayload = buildElicitationInteractionPayload('session-1', {
    serverName: 'notes',
    message: 'Enter a note',
  });
  assert.equal(textPayload.kind, 'text');
}

// T12/M3：onElicitation submit → accept，非 submit → cancel。
// （decline 语义保留给将来 UI 增加「拒绝」按钮时再放开——先写失败测试再放开，不测不可达分支。）
function testElicitationCancelMapping(): void {
  // submit → accept（带 content：fieldValues 优先，否则 otherText）。
  const accepted = elicitationResultFromInteraction({ id: 'r1', action: 'submit', fieldValues: { answer: 'yes' } });
  assert.equal(accepted.action, 'accept');
  assert.deepEqual(accepted.content, { answer: 'yes' });

  const acceptedOther = elicitationResultFromInteraction({ id: 'r1b', action: 'submit', otherText: 'typed' });
  assert.deepEqual(acceptedOther.content, { response: 'typed' });

  // 非 submit（用户关闭/中断）→ cancel。
  assert.equal(elicitationResultFromInteraction({ id: 'r3', action: 'cancel' }).action, 'cancel');
}

// T14/M5：status 子类型扩展（compact_result/compact_error/requesting 不再静默丢弃）。
function testStatusSubtypeCoverage(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const cliTypes = fs.readFileSync(new URL('../src/shared/types/cli.ts', import.meta.url), 'utf8');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

  // cli.ts 类型覆盖新增三个 status 相关 subtype。
  assert.ok(cliTypes.includes("'compact_result'"));
  assert.ok(cliTypes.includes("'compact_error'"));
  assert.ok(cliTypes.includes("'requesting'"));
  assert.ok(cliTypes.includes('compactResult?'));
  assert.ok(cliTypes.includes('compactError?'));

  // sdk-backend 转发 compact_result / compact_error / requesting。
  assert.ok(sb.includes("subtype: 'compact_result'"));
  assert.ok(sb.includes('compact_result !== undefined'));
  assert.ok(sb.includes("sdkMsg.status === 'requesting'"));
}

function testAllowSessionPermissionsSurviveNextSdkQuery(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

  // allow-session 返回的 updatedPermissions 不能只交给当前 query；claude-link 后续消息会新建 query + resume，
  // 必须按 app session 缓存并在下一次 buildSdkOptions 的 settings.permissions 中重新注入。
  assert.ok(sb.includes('sessionPermissionUpdates'));
  assert.ok(sb.includes('rememberSessionPermissionUpdates(sessionId'));
  assert.ok(sb.includes('applySessionPermissionUpdates(sessionId'));
  assert.ok(sb.includes('sessionPermissionUpdates.delete(sessionId)'));
}

function testToolSessionAllowedShortCircuit(): void {
  // 根因：CLI 在 --permission-prompt-tool stdio（headless）模式下，不据 canUseTool 返回的
  // updatedPermissions(destination:'session') 跳过后续同工具 prompt，导致同一会话同一工具反复弹窗。
  // claude-link 须在 canUseTool 弹窗前本地短路已授权工具。本测试锁定短路判定语义。

  // 1) allow-session 路径（withToolSessionAllow 保证补一条裸 allow + coerce 成 session）产出的规则，
  //    必须能被 isToolSessionAllowed 识别为「整工具已授权」，否则短路永不触发 = bug 复现。
  const allowSessionUpdates = coercePermissionUpdatesToSession(
    withToolSessionAllow('Bash', [
      { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'localSettings' },
    ]),
  );
  assert.equal(isToolSessionAllowed(allowSessionUpdates, 'Bash'), true);
  // 未授权的工具不被短路。
  assert.equal(isToolSessionAllowed(allowSessionUpdates, 'Read'), false);

  // 2) 仅细粒度规则（带 ruleContent）不构成整工具放行——避免对同工具其它输入误放行。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm install:*' }], behavior: 'allow', destination: 'session' },
  ], 'Bash'), false);

  // 3) 非 session 目的地（如 localSettings）不计入会话短路。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'localSettings' },
  ], 'Bash'), false);

  // 4) deny 规则不算授权。
  assert.equal(isToolSessionAllowed([
    { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
  ], 'Bash'), false);

  // 5) 空/undefined 不短路。
  assert.equal(isToolSessionAllowed(undefined, 'Bash'), false);
  assert.equal(isToolSessionAllowed([], 'Bash'), false);

  // 6) 短路确实接入 createPermissionHandler（弹窗前调用 isToolSessionAllowed）。
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  assert.ok(
    sb.includes('isToolSessionAllowed(sessionBook, toolName)'),
    'createPermissionHandler 必须在弹窗前用 isToolSessionAllowed 短路本会话已授权工具',
  );
}

function testThinkingDisplaySummarizedEnabled(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const sb = fs.readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');
  const resolver = fs.readFileSync(new URL('../src/shared/thinking-resolver.ts', import.meta.url), 'utf8');

  // 思考强度档位经 resolveThinkingConfig 注入 Options.thinking（替换原硬编码）。
  // 每档统一 adaptive + summarized：新模型默认可能 omitted，显式 summarized 才能稳定收到可展示的 thinking 摘要。
  assert.ok(sb.includes('thinking: thinkingConfig.thinking'), 'buildSdkOptions 用 thinkingConfig 注入 thinking');
  assert.ok(
    resolver.includes("type: 'adaptive'") && resolver.includes("display: 'summarized'"),
    'resolver 各档统一 adaptive + summarized',
  );
}

// ── Markdown 排版契约 ────────────────────────────────────────────────
// P1：解析器对核心块级元素的 HTML 输出回归锁（解析本就正确，锁住防回归）。
function testMarkdownParserEmitsCoreBlocks(): void {
  const table = renderMarkdown('| h1 | h2 |\n|----|----|\n| a | b |');
  assert.ok(table.includes('<table>'));
  assert.ok(table.includes('<th>'));
  assert.ok(renderMarkdown('## 标题').includes('<h2>'));
  assert.ok(renderMarkdown('> 备注').includes('<blockquote>'));
  assert.ok(renderMarkdown('- a\n- b').includes('<ul>'));
  assert.ok(renderMarkdown('1. a\n2. b').includes('<ol>'));
  assert.ok(renderMarkdown('a\n\n---\n\nb').includes('<hr'));
  assert.ok(renderMarkdown('用 `x` 命令').includes('<code>'));
  assert.ok(renderMarkdown('![图](http://x/y.png)').includes('<img'));
}

// P1：.markdown-body 必须为核心元素提供样式。此前仅 a / .code-block / diff 有样式，
// 其余裸奔——顺德天气表格即因缺表格 CSS 而丑陋。读取 main.css 断言关键选择器存在。
// 先红后绿：补 CSS 前这些断言全失败。
function testMarkdownBodyCssCoversCoreElements(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');

  // 表格：必须显式排除 diff 专用表 .d2h-diff-table（它有独立调校，不能被通用表规则覆盖）。
  assert.ok(css.includes('.markdown-body table:not(.d2h-diff-table)'), '缺表格样式（顺德天气 bug 根因）');
  assert.ok(css.includes('.markdown-body table:not(.d2h-diff-table) thead'), '缺表头样式');
  assert.ok(css.includes('.markdown-body blockquote'), '缺引用样式');
  assert.ok(css.includes('.markdown-body h1'), '缺标题样式');
  assert.ok(css.includes('.markdown-body h2'), '缺 h2 样式');
  assert.ok(css.includes('.markdown-body ul'), '缺无序列表样式');
  assert.ok(css.includes('.markdown-body ol'), '缺有序列表样式');
  assert.ok(css.includes('.markdown-body hr'), '缺分割线样式');
  assert.ok(css.includes('.markdown-body code:not(pre code)'), '缺行内 code 样式（须排除 pre 内块级 code）');
  assert.ok(css.includes('.markdown-body img'), '缺图片样式');
}

// P1：工具结果里的 markdown 段落间距必须用 rem（跟 --font-size-base 三档缩放），
// 不能是固定 px——否则 large 档位下不放大。先红后绿。
function testToolCallBlockMarkdownParagraphUsesRem(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  assert.ok(!src.includes('0 0 6px'), 'ToolCallBlock 的 .markdown-body p 间距仍用固定 px，应改 rem');
  assert.ok(src.includes('0 0 0.375rem'), 'ToolCallBlock 的 .markdown-body p 间距应为 0 0 0.375rem');
}

// 任务列表：- [ ] / - [x] 必须渲染成勾选框（当前 markdown-it 无 task-list 插件，输出字面 [ ]）。
function testMarkdownTaskListCheckboxes(): void {
  const out = renderMarkdown('- [ ] todo\n- [x] done');
  assert.ok(out.includes('task-list-item'), '任务列表项需带 task-list-item class');
  assert.ok(out.includes('<input'), '任务列表需渲染 checkbox input');
  assert.ok(out.includes('type="checkbox"'), 'checkbox 需为 type=checkbox');
  assert.ok(out.includes('checked'), '已勾选项 [x] 需渲染为 checked');

  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.ok(css.includes('.markdown-body .task-list-item'), '缺任务列表项样式（去圆点/对齐勾选框）');
}

// 数学公式：$...$ 行内 / $$...$$ 块级需经 KaTeX 渲染（当前 markdown-it 无数学支持，输出字面 $）。
function testMarkdownMathKatex(): void {
  const inline = renderMarkdown('公式 $E=mc^2$ 在文中');
  assert.ok(inline.includes('katex'), '行内公式需经 KaTeX 渲染（含 katex class）');
  const block = renderMarkdown('$$\\sum_{i=1}^n x_i$$');
  assert.ok(block.includes('katex'), '块级公式需经 KaTeX 渲染');
}

// Mermaid：```mermaid 代码块需产出自定义容器（携带原始源 data-mermaid）供前端懒渲染，
// 而非回落为 plaintext 普通代码块。SVG 实际渲染需 DOM+mermaid 运行时，归 GUI 目视。
function testMarkdownMermaidEmitsContainer(): void {
  const out = renderMarkdown('```mermaid\ngraph TD\nA-->B\n```');
  assert.ok(out.includes('mermaid-block'), 'mermaid 块需产出自定义容器 mermaid-block');
  assert.ok(out.includes('data-mermaid'), '容器需携带原始 mermaid 源 data-mermaid 供前端渲染');
  assert.ok(!out.includes('>plaintext<'), 'mermaid 不应回落为 plaintext 代码块');
}

// 图片灯箱：![alt](url) 的 <img> 需带 md-img 钩子（供前端点击放大），当前是裸 <img>。
// 模态交互需 DOM，归 GUI 目视；契约只锁定钩子注入。
function testMarkdownImageLightboxHook(): void {
  const out = renderMarkdown('![图](http://x/y.png)');
  assert.ok(out.includes('md-img'), '图片需带 md-img 钩子供灯箱识别');
  assert.ok(out.includes('http://x/y.png'), '图片 src 须保留');
}

function testMarkdownFenceStructure(): void {
  const raw = `const value = "<&'";\n`;
  const code = renderMarkdown(`\`\`\`ts\n${raw}\`\`\``);
  assert.equal((code.match(/class="code-block"/g) ?? []).length, 1, '普通 fence 只能有一层 code-block');
  assert.ok(!/<pre><code[^>]*>\s*<div class="code-block"/.test(code), '普通 fence 不能把块级 div 包进 code');
  assert.ok(code.includes('language-ts'), '已知语言须保留高亮语言');
  assert.ok(code.includes('&lt;'), '代码中的 < 须转义');

  const unknown = renderMarkdown('```not-a-language\nhello\n```');
  assert.ok(unknown.includes('language-plaintext'), '未知语言须回退 plaintext');

  const diff = renderMarkdown('```diff\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```');
  assert.ok(diff.includes('code-block--diff'));
  assert.ok(!/<pre><code[^>]*>\s*<div class="code-block code-block--diff"/.test(diff), 'diff 不能被默认 fence 再包装');
  assert.equal((diff.match(/class="[^"]*\bd2h-wrapper\b[^"]*"/g) ?? []).length, 1, 'diff2html wrapper 只能有一层');

  const patch = renderMarkdown('```patch\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n```');
  assert.ok(patch.includes('code-block--diff'), 'patch 须复用 diff renderer');

  const mermaidSource = `graph TD\nA["<&'\\\""]-->B\n`;
  const mermaid = renderMarkdown(`\`\`\`mermaid\n${mermaidSource}\`\`\``);
  assert.equal((mermaid.match(/class="mermaid-block"/g) ?? []).length, 1);
  assert.ok(!/<pre><code[^>]*>\s*<div class="mermaid-block"/.test(mermaid), 'Mermaid 不能被默认 fence 再包装');
  assert.ok(mermaid.includes('data-mermaid='));
  assert.ok(mermaid.includes('&lt;'));
  assert.ok(mermaid.includes('&#39;'));
  assert.ok(mermaid.includes('&#10;'));
}

function testInvalidDiffFallsBackToText(): void {
  const invalid = '-old\n+new\n';
  const out = renderDiffHtml(invalid);
  assert.ok(out.includes('<pre><code>'), 'diff2html 空输出时须回退可见源码');
  assert.ok(out.includes('-old'));
  assert.ok(out.includes('+new'));

  // 通过注入抛异常的 renderer 直接覆盖产品 catch 分支，不锁死第三方库的异常行为。
  const throwingRenderer = (() => {
    throw new Error('synthetic renderer failure');
  }) as Parameters<typeof renderDiffHtmlWithRenderer>[1];
  const fallback = renderDiffHtmlWithRenderer('<& source', throwingRenderer);
  assert.equal(fallback, '<pre><code>&lt;&amp; source</code></pre>', 'renderer 抛异常时须回退可见源码');
}

function testMarkdownRenderProfiles(): void {
  const source = '```mermaid\ngraph TD\nA-->B\n```\n\n![图](https://example.com/x.png)';
  const rich = renderMarkdown(source, 'rich');
  assert.ok(rich.includes('mermaid-block'), 'rich profile 应启用 Mermaid DOM 增强钩子');
  assert.ok(rich.includes('md-img'), 'rich profile 图片应启用灯箱钩子');

  const staticHtml = renderMarkdown(source, 'static');
  assert.ok(!staticHtml.includes('mermaid-block'), 'static profile 不应生成无法增强的 Mermaid 占位');
  assert.ok(staticHtml.includes('code-block'), 'static profile 应把 Mermaid 保留为可复制代码块');
  assert.ok(!staticHtml.includes('md-img'), 'static profile 图片不应伪装成可打开灯箱');

  const fs = require('node:fs') as typeof import('node:fs');
  const tool = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  const thinking = fs.readFileSync(new URL('../src/renderer/components/chat/ThinkingBlock.vue', import.meta.url), 'utf8');
  assert.ok(tool.includes("renderMarkdown(resultContent.value, 'static')"));
  assert.ok(thinking.includes("renderMarkdown(props.content, 'static')"));
}

function testMarkdownSecurityAndProtocolContracts(): void {
  const rawHtml = renderMarkdown('<script>alert(1)</script>');
  assert.ok(!rawHtml.includes('<script>'));
  for (const unsafe of ['javascript:alert(1)', 'vbscript:msgbox(1)', 'data:text/html,x', 'file:///D:/secret']) {
    assert.ok(!renderMarkdown(`[x](${unsafe})`).includes('<a '), `危险链接必须拒绝: ${unsafe}`);
  }
  assert.ok(renderMarkdown('![x](data:image/png;base64,AAAA)').includes('<img'), '明确允许栅格 data image');
  assert.ok(!renderMarkdown('![x](data:image/svg+xml,<svg/>)').includes('<img'), '拒绝 SVG data URL');
  assert.equal(shouldOpenExternally('tel:+8612345'), true, 'tel 链接应与 renderer 注释一致走系统协议');
}

function assertTaskListCompletionCss(css: string): void {
  const rulePattern = /([^{}]+)\{([^{}]*)\}/g;
  const completedRoot = '.markdown-body .task-list-item:has(input:checked)';
  const rootDeclarations: string[] = [];
  let childHasLineThrough = false;

  for (const match of css.matchAll(rulePattern)) {
    const selectors = match[1].split(',').map((selector) => selector.trim());
    const declarations = match[2];
    if (selectors.includes(completedRoot)) rootDeclarations.push(declarations);
    if (selectors.some((selector) => selector.startsWith(`${completedRoot} >`))
      && /text-decoration\s*:\s*line-through(?:\s|;|$)/.test(declarations)) {
      childHasLineThrough = true;
    }
  }

  assert.ok(rootDeclarations.length > 0, '须存在 .task-list-item:has(input:checked) 根规则');
  assert.ok(
    rootDeclarations.every((declarations) => !/text-decoration\s*:/.test(declarations)),
    '完成态任一根规则均不得用 text-decoration（会误伤链接/代码）',
  );
  assert.ok(childHasLineThrough, '完成态删除线须限定到直属文本子元素');
}

function testTaskListReadOnlyContract(): void {
  const out = renderMarkdown('- [ ] todo\n- [x] done');
  assert.ok(out.includes('disabled'), '消息中的任务 checkbox 必须只读');
  assert.ok(out.includes('checked'), '完成项须保留 checked');

  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.doesNotThrow(() => assertTaskListCompletionCss(css));

  const badFixture = `
    .markdown-body .task-list-item:has(input:checked) { color: gray; }
    .markdown-body .task-list-item:has(input:checked) { text-decoration: line-through; }
    .markdown-body .task-list-item:has(input:checked) > label { text-decoration: line-through; }
  `;
  assert.throws(
    () => assertTaskListCompletionCss(badFixture),
    /任一根规则均不得用 text-decoration/,
    '检测器须累积并拒绝任一根规则删除线，不能让后出现的安全根规则覆盖违规证据',
  );
}

// 2.1: 行首未闭合 $$ 不得把后续整段正文吞成 KaTeX 块（@traptitech/markdown-it-katex 的 math_block
// 原实现 found=false 时仍 push math_block 吞到 EOF）。合法单行/多行 $$...$$ 仍须渲染。
function testMarkdownBlockMathDoesNotSwallowUnclosed(): void {
  const legal = [
    renderMarkdown('$$x^2$$'),
    renderMarkdown('$$\nx^2\n$$'),
  ];
  for (const out of legal) assert.ok(out.includes('katex-block'), '合法单行/多行块级公式仍应经 KaTeX 渲染');

  for (const marker of ['$$PID', '$$50', '$$var', '$$']) {
    const out = renderMarkdown(`Line1\n\n${marker}\n\nNew paragraph here.`);
    assert.ok(out.includes('<p>Line1</p>'), `未闭合 ${marker} 前的段落须保留`);
    assert.ok(out.includes('<p>New paragraph here.</p>'), `未闭合 ${marker} 不得吞掉后文独立 p`);
    assert.ok(!out.includes('katex-block'), `未闭合 ${marker} 不应产成 katex-block`);
  }
}

function testImageLightboxAccessibilityWiring(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const lightbox = fs.readFileSync(new URL('../src/renderer/components/chat/ImageLightbox.vue', import.meta.url), 'utf8');
  const state = fs.readFileSync(new URL('../src/renderer/composables/useImageLightbox.ts', import.meta.url), 'utf8');
  const enrich = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  const closeRule = css.match(/\.image-lightbox__close\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.ok(lightbox.includes('role="dialog"'));
  assert.ok(lightbox.includes('aria-modal="true"'));
  assert.ok(lightbox.includes('ref="closeButton"'));
  assert.ok(lightbox.includes(':alt="state.alt"'));
  assert.ok(state.includes('trigger: HTMLElement | null'));
  assert.ok(!state.includes('trigger.focus()'), '焦点恢复应由 ImageLightbox 组件单点负责，composable 只清理状态');
  assert.ok(/value\.trigger\s*\?\?/.test(lightbox), '打开灯箱时须优先保存显式 trigger');
  assert.ok(lightbox.includes('document.activeElement instanceof HTMLElement'), '无 trigger 时须回退当前 activeElement');
  assert.ok(/else\s*\{\s*await nextTick\(\);\s*restoreFocus\(\);/.test(lightbox), '关闭后须等待 Teleport v-if 移除再恢复焦点');
  assert.ok(lightbox.includes('target.focus()'), '关闭灯箱后组件须恢复触发图片焦点');
  assert.match(closeRule, /min-width:\s*(?:44px|2\.75rem)/, '关闭按钮须显式保证最小 44px 宽度');
  assert.match(closeRule, /min-height:\s*(?:44px|2\.75rem)/, '关闭按钮须显式保证最小 44px 高度');
  assert.match(closeRule, /top:\s*calc\([^;]*env\(safe-area-inset-top\)/, '关闭按钮 top 须考虑安全区');
  assert.match(closeRule, /right:\s*calc\([^;]*env\(safe-area-inset-right\)/, '关闭按钮 right 须考虑安全区');
  assert.ok(enrich.includes("image.setAttribute('tabindex', '0')"));
  assert.ok(enrich.includes("image.setAttribute('role', 'button')"));
  assert.ok(enrich.includes("event.key !== 'Enter' && event.key !== ' '"));
}

function testDiffContentDetectionContracts(): void {
  const standard = '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new';
  assert.equal(isDiffContent(standard), true, '标准 unified diff 应识别');
  assert.equal(isDiffContent(`处理说明在前面\n\n${standard}`), true, '带前言的 unified diff 应识别');
  assert.equal(isDiffContent('diff --git a/file.txt b/file.txt\nindex 123..456 100644'), true, 'diff --git 文件头应独立识别');
  assert.equal(isDiffContent('--- a/path with spaces.txt\n+++ b/path with spaces.txt\n@@ -1 +1 @@\n-old\n+new'), true, '文件头路径含空格仍应识别');
  assert.equal(isDiffContent('--- 章节分隔\n这只是普通散文\n+++ 强调内容'), false, '普通 ---/+++ 散文不应误判');
  assert.equal(isDiffContent('--- a/file.txt\n+++ b/file.txt\n没有 hunk'), false, '缺少 @@ hunk 不应识别');
}

function assertReducedMotionCoverage(files: Array<{ name: string; text: string }>): void {
  const required = new Set<string>();
  const covered = new Set<string>();
  const animationRule = /([^{}]+)\{([^{}]*)\}/g;
  const collectMediaBodies = (text: string): string[] => {
    const bodies: string[] = [];
    const mediaStart = /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g;
    for (const match of text.matchAll(mediaStart)) {
      const open = (match.index ?? 0) + match[0].length - 1;
      let depth = 0;
      for (let i = open; i < text.length; i += 1) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}' && --depth === 0) {
          bodies.push(text.slice(open + 1, i));
          break;
        }
      }
    }
    return bodies;
  };

  for (const { text } of files) {
    for (const match of text.matchAll(animationRule)) {
      const declarations = match[2];
      if (!/(?:animation\s*:|animation-iteration-count\s*:)\s*[^;}]*\binfinite\b/.test(declarations)) continue;
      for (const selector of match[1].split(',').map((value) => value.trim())) {
        if (selector && !selector.startsWith('@')) required.add(selector);
      }
    }
    for (const body of collectMediaBodies(text)) {
      for (const match of body.matchAll(animationRule)) {
        if (/(?:animation\s*:|animation-iteration-count\s*:)\s*none\b/.test(match[2])) {
          for (const selector of match[1].split(',').map((value) => value.trim())) {
            if (selector && !selector.startsWith('@')) covered.add(selector);
          }
        }
      }
    }
  }
  const missing = [...required].filter((selector) => !covered.has(selector));
  assert.deepEqual(missing, [], `以下 infinite 动画选择器未被 prefers-reduced-motion 覆盖：${missing.join(', ')}`);
}

function testReducedMotionStopsInfiniteAnimations(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const path = require('node:path') as typeof import('node:path');
  const { fileURLToPath } = require('node:url') as typeof import('node:url');
  const root = fileURLToPath(new URL('../src/renderer/', import.meta.url));
  const files: Array<{ name: string; text: string }> = [];
  (function walk(d: string): void {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(css|vue)$/.test(e.name)) files.push({ name: p, text: fs.readFileSync(p, 'utf8') });
    }
  })(root);

  assertReducedMotionCoverage(files);
  assert.throws(
    () => assertReducedMotionCoverage([{ name: 'synthetic.css', text: `
      .compound-a, .compound-b span { animation-iteration-count: infinite; }
      @media (prefers-reduced-motion: reduce) {
        .compound-a { animation: none; }
      }
    ` }]),
    /compound-b/,
    '检测器须覆盖 animation-iteration-count 与复合 selector，不能只扫描 animation 简写',
  );
}

function testMarkdownImageInLinkNotButtonized(): void {
  const out = renderMarkdown('[![alt](https://e.com/i.png)](https://e.com/page)');
  const linkInner = out.match(/<a [^>]*>([\s\S]*?)<\/a>/)?.[1] ?? '';
  assert.ok(linkInner.includes('<img'), '链接内嵌图片应保留 <img>');
  assert.ok(linkInner.includes('loading="lazy"'), '链接内嵌图片仍须懒加载');
  assert.ok(!/\bclass="[^"]*md-img/.test(linkInner), '链接内嵌图片不应带 md-img（避免按钮化嵌套 <a> 且 preventDefault 劫持链接导航）');
  const bare = renderMarkdown('![图](https://e.com/i.png)');
  assert.ok(bare.includes('md-img'), '裸图片仍须带 md-img（灯箱钩子不回归）');
  assert.ok(bare.includes('loading="lazy"'), '裸图片仍须懒加载');
}

function testMarkdownImageProtocolFilter(): void {
  const allowed = [
    'http://e.com/i.png',
    'HTTPS://e.com/i.JPG',
    'data:image/png;base64,AAAA',
    'DATA:IMAGE/JPEG,AAAA',
    'data:image/gif;base64,AAAA',
    'data:image/webp;base64,AAAA',
  ];
  for (const url of allowed) assert.equal(isAllowedMarkdownImageUrl(url), true, `应允许图片 URL: ${url}`);
  for (const mime of ['jpg', 'bmp', 'x-icon']) {
    assert.equal(isAllowedMarkdownImageUrl(`data:image/${mime};base64,AAAA`), false, `markdown-it 不支持的 data:image/${mime} 应拒绝`);
  }

  const rejected = [
    'ftp://e.com/i.png',
    'file:///D:/secret.png',
    'data:text/plain,hello',
    'data:image/svg,<svg/>',
    'data:image/svg+xml,<svg/>',
    'DATA:IMAGE/SVG,<svg/>',
    'DATA:IMAGE/SVG+XML,<svg/>',
    'data:image/png',
    'data:image/png;base64',
    'data:image/png;base64,',
    'not a url',
    'https://',
    '',
  ];
  for (const url of rejected) assert.equal(isAllowedMarkdownImageUrl(url), false, `应拒绝图片 URL: ${url}`);

  assert.ok(!renderMarkdown('![alt](ftp://e.com/i.png)').includes('<img'), '非 http(s)/栅格 data 图片协议须被拦截');
  assert.ok(renderMarkdown('![alt](https://e.com/i.png)').includes('<img'), 'http 图片仍允许');
  const mainImage = renderMarkdown('![alt](data:image/png;base64,AAAA)');
  assert.ok(mainImage.includes('<img'), 'data:image 栅格图仍允许');
  assert.ok(mainImage.includes('loading="lazy"'), '主 renderMarkdown 图片须保留 lazy loading');

  const independentMarkdown = new MarkdownIt();
  applyImageProtocolFilter(independentMarkdown);
  assert.ok(independentMarkdown.render('![ok](data:image/webp;base64,AAAA)').includes('<img'), '独立 MarkdownIt 安装 helper 后应允许栅格 data image');
  assert.ok(!independentMarkdown.render('![blocked](ftp://e.com/i.png)').includes('<img'), '独立 MarkdownIt 安装 helper 后应拒绝 ftp image');
  assert.ok(!independentMarkdown.render('![blocked](data:image/svg+xml,<svg/>)').includes('<img'), '独立 MarkdownIt 安装 helper 后应拒绝 SVG data image');

  const previewMarkdown = createPreviewMarkdownRenderer();
  assert.ok(previewMarkdown.render('![ok](https://e.com/i.png)').includes('<img'), 'Preview renderer 应允许 http 图片');
  assert.ok(!previewMarkdown.render('![blocked](ftp://e.com/i.png)').includes('<img'), 'Preview renderer 应拒绝 ftp 图片');
  assert.ok(!previewMarkdown.render('![blocked](DATA:IMAGE/SVG+XML,<svg/>)').includes('<img'), 'Preview renderer 应拒绝大小写不敏感 SVG+XML data 图片');
  assert.ok(previewMarkdown.render('![ok](data:image/png;base64,AAAA)').includes('<img'), 'Preview renderer 应允许 png data 图片');

  const fs = require('node:fs') as typeof import('node:fs');
  const markdownSource = fs.readFileSync(new URL('../src/renderer/utils/markdown.ts', import.meta.url), 'utf8');
  const previewSource = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');
  assert.ok(markdownSource.includes('applyImageProtocolFilter(md);'), '主 renderer 须安装共享图片协议过滤 helper');
  assert.ok(previewSource.includes('createPreviewMarkdownRenderer()'), 'InteractionPreview 须使用共享 Preview MarkdownIt 工厂');
}

function testInteractionPreviewDiffFallback(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/InteractionPreview.vue', import.meta.url), 'utf8');
  assert.ok(src.includes('renderDiffHtml'), 'InteractionPreview 须复用 renderDiffHtml（带空输出回退）');
  assert.ok(!/from\s+'diff2html'/.test(src), 'InteractionPreview 不应直接依赖 diff2html（绕过回退保护）');
  assert.ok(renderDiffHtml('', { matching: 'lines' }).includes('<pre><code>'), '空 diff 经 matching:lines 须回退 <pre><code>');
}

function testMarkdownIndentedCodeUsesContainer(): void {
  const out = renderMarkdown('段落\n\n    let x = 1\n\n后文');
  assert.ok(out.includes('class="code-block"'), '4 空格缩进代码块须走统一 code-block 容器（含 header/复制/高亮）');
  assert.ok(out.includes('code-block__copy'), '缩进代码块须带复制按钮');
  assert.ok(out.includes('language-plaintext'), '缩进代码块无语言信息，须标 plaintext');
  assert.ok(!/<pre><code>let x = 1/.test(out), '缩进代码块不能再是裸 <pre><code>');
}

function testMermaidRendersBlocksSerially(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(!/Promise\.all\s*\(\s*blocks\.map/.test(src), 'mermaid 各 diagram 类型的 db 为单例，并发 clear 会互相覆盖，多块须串行');
  assert.ok(/for\s*\(\s*const\s+block\s+of\s+blocks/.test(src), 'renderMermaidBlocks 须用 for..of 串行 await');
  assert.ok(/let\s+mermaidQueue/.test(src), '须有模块级 mermaid 队列做跨容器互斥');
  assert.ok(/mermaidQueue\s*=\s*mermaidQueue\.then/.test(src), '队列须链式串行（跨容器 mounted 互斥）');
}

function testMermaidErrorRetryAndAccessibleTitleContracts(): void {
  assert.equal(shouldSkipMermaidErrorRetry('error', 'same', 'same'), true);
  assert.equal(shouldSkipMermaidErrorRetry('error', 'old', 'new'), false);
  assert.equal(shouldSkipMermaidErrorRetry('rendered', 'same', 'same'), false);
  assert.equal(summarizeMermaidAccessibleTitle(''), 'Mermaid 图表');
  assert.equal(summarizeMermaidAccessibleTitle('  graph\n TD\tA-->B  '), 'graph TD A-->B');
  const title = summarizeMermaidAccessibleTitle('😀'.repeat(80), 10);
  assert.equal([...title].length, 10);
  assert.ok(!title.includes('\uD800') && !title.includes('\uDC00'));
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('createElementNS'), 'Mermaid SVG title 须使用 SVG namespace 创建');
  assert.ok(src.includes('<title>') || src.includes("createElementNS(SVG_NS, 'title')"), 'Mermaid SVG 须注入 title');
  assert.ok(src.includes("setAttribute('role', 'img')"), 'Mermaid SVG 须设置 role=img');
  assert.ok(src.includes("setAttribute('aria-labelledby'"), 'Mermaid SVG 须以 aria-labelledby 接线到 title');
  assert.ok(src.includes('renderCounter') && /renderCounter[\s\S]{0,180}(生命周期|重置|唯一)/.test(src), 'renderCounter 须解释生命周期单调唯一 ID 不重置原因');
}

function testMermaidDeadPreRuleRemoved(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.ok(!css.includes('pre:has(> .mermaid-block)'), 'mermaid-block 由 fence 裸输出无 <pre> 祖先，pre:has(> .mermaid-block) 是死规则，须删除');
  assert.ok(!css.includes('中和 markdown-it 在 highlight 返回外层包'), '过时注释须更新');
  assert.ok(css.includes('.markdown-body .mermaid-block'), 'mermaid-block 容器样式须保留');
}

function testImageLightboxZIndexTokenized(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  const rule = css.match(/\.image-lightbox\s*\{([^}]*)\}/);
  assert.ok(rule, '.image-lightbox 规则须存在');
  assert.ok(/z-index:\s*var\(--[\w-]*z-index\)/.test(rule![1]), '灯箱 z-index 须接入 overlay token，不得用裸魔法数');
  const tokens = fs.readFileSync(new URL('../src/renderer/assets/styles/interaction-tokens.css', import.meta.url), 'utf8');
  assert.ok(/--[\w-]*overlay[\w-]*z-index\s*:/.test(tokens), '须在 overlay token 体系定义灯箱 z-index');
}

function testChatBlockKeyboardAccessibility(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const tool = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  const template = tool.match(/<template>([\s\S]*?)<\/template>/)?.[1] ?? '';
  const extractOpeningTagByClass = (className: string): string => {
    const tags = template.match(/<[^/!][^>]*>/g) ?? [];
    return tags.find(tag => new RegExp(`\\bclass=["'][^"']*\\b${className}\\b[^"']*["']`).test(tag)) ?? '';
  };
  const hasAttribute = (tag: string, name: string, value?: string): boolean => {
    const match = tag.match(new RegExp(`(?:^|\\s)${name}(?:=(?:"([^"]*)"|'([^']*)'))?(?=\\s|/?>)`));
    return !!match && (value === undefined || (match[1] ?? match[2]) === value);
  };
  const headTag = extractOpeningTagByClass('tool-row__head');
  const anchorTag = extractOpeningTagByClass('tool-row__anchor');
  const bodyTag = extractOpeningTagByClass('tool-row__body');
  const controls = template.match(/<div\s+class=["']tool-row__controls["']>([\s\S]*?)<\/div>/)?.[1] ?? '';

  assert.ok(/\bconst\s+bodyId\s*=\s*useId\(\s*\)/.test(tool), 'ToolCallBlock 须调用 useId 生成唯一 body id');
  assert.ok(template.includes('<div class="tool-row__controls">'), 'ToolCallBlock 须用非交互 flex wrapper 包住工具行控件');
  assert.ok(headTag.startsWith('<button'), 'ToolCallBlock head 须是原生 button');
  assert.ok(hasAttribute(headTag, ':aria-expanded', 'expanded'), 'ToolCallBlock head 须暴露 aria-expanded');
  assert.ok(hasAttribute(headTag, ':aria-controls', 'bodyId'), 'ToolCallBlock head 须用 aria-controls 指向 body');
  assert.ok(hasAttribute(headTag, '@click', 'toggleExpand'), 'ToolCallBlock head 须切换 expanded（toggleExpand，导出模式守卫）');
  assert.ok(anchorTag.startsWith('<button'), '子 Agent anchor 须是原生 button');
  assert.ok(hasAttribute(anchorTag, '@click', 'focusSubAgent'), '子 Agent anchor 须调用 focusSubAgent');
  assert.equal((controls.match(/<button\b/g) ?? []).length, 2, 'ToolCallBlock 控件 wrapper 内须恰有 head 与子 Agent 两个 button');
  assert.ok(/^\s*<button\b[\s\S]*<\/button>\s*<button\b/.test(controls), 'head 与子 Agent anchor 须是不嵌套的兄弟 button');
  assert.ok(!hasAttribute(headTag, 'role', 'button') && !hasAttribute(anchorTag, 'role', 'button'), 'ToolCallBlock 原生按钮不得冗余 role=button');
  assert.ok(!hasAttribute(headTag, 'tabindex') && !hasAttribute(anchorTag, 'tabindex'), 'ToolCallBlock 原生按钮不得手写 tabindex');
  assert.ok(!/@keydown\.(?:enter|space)\b/.test(headTag) && !/@keydown\.(?:enter|space)\b/.test(anchorTag), 'ToolCallBlock 原生按钮不得手写 Enter/Space 模拟');
  assert.ok(bodyTag.startsWith('<div'), 'ToolCallBlock body 须是 div');
  assert.ok(hasAttribute(bodyTag, 'v-show', 'expanded'), 'ToolCallBlock body 须常驻 DOM 并由 expanded 控制显示，避免 aria-controls 悬空');
  assert.ok(hasAttribute(bodyTag, ':id', 'bodyId'), 'ToolCallBlock body 须绑定唯一 id');
  const process = fs.readFileSync(new URL('../src/renderer/components/chat/ProcessGroup.vue', import.meta.url), 'utf8');
  assert.ok(process.includes(':aria-expanded="open"'), 'ProcessGroup 折叠按钮须 aria-expanded');
  assert.ok(process.includes('aria-controls'), 'ProcessGroup 须 aria-controls 指向 panel');
  assert.ok(process.includes('useId'), 'ProcessGroup 须用 useId 生成唯一 panel id');
  assert.ok(process.includes(':id="panelId"'), 'ProcessGroup panel 须绑定唯一 id');
  const thinking = fs.readFileSync(new URL('../src/renderer/components/chat/ThinkingBlock.vue', import.meta.url), 'utf8');
  assert.ok(thinking.includes(':aria-expanded="open"'), 'ThinkingBlock 折叠按钮须 aria-expanded');
  assert.ok(thinking.includes('aria-controls'), 'ThinkingBlock 须 aria-controls 指向 body');
  assert.ok(thinking.includes('useId'), 'ThinkingBlock 须用 useId 生成唯一 body id');
  assert.ok(thinking.includes(':id="bodyId"'), 'ThinkingBlock body 须绑定唯一 id');
  assert.ok(thinking.includes('v-show="open"'), 'ThinkingBlock body 须常驻 DOM，避免 aria-controls 悬空');
}

function testMermaidLifecycleGuards(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/directives/enrich-markdown.ts', import.meta.url), 'utf8');
  assert.ok(src.includes('mermaidPromise = null'), 'Mermaid import 失败后必须允许后续重试');
  assert.ok(src.includes('root.isConnected'), '异步返回后须检查 root 是否仍在文档中');
  assert.ok(src.includes('root.contains(block)'), '异步返回后须检查 block 是否仍属于当前 root');
  assert.ok(src.includes('data-mermaid-source'), '渲染任务须记录启动时源码');
  assert.ok(src.includes('data-mermaid-state'), 'Mermaid 状态需区分 loading/rendered/error');
  assert.ok(src.includes('bindFunctions'), '须执行 Mermaid 返回的 bindFunctions');
}

// Edit/Write/MultiEdit 的 tool_result 只是一句成功提示（无 diff），ToolCallBlock 改为
// 从 tool_use 入参（old_string/new_string 或 content）合成 unified diff 反推显示。
// 这里锁定合成逻辑契约 + ToolCallBlock 接线。
function testToolDiffSynthesisContracts(): void {
  // Edit：old_string→new_string 合成 diff
  const edit = synthesizeToolDiff('Edit', { file_path: 'aaaa.txt', old_string: 'aaaa', new_string: 'bbb' });
  assert.ok(edit, 'Edit 须合成 diff');
  assert.equal(edit!.kind, 'edit');
  assert.ok(edit!.diff.includes('--- a/aaaa.txt'), 'Edit diff 须带 a/ 头');
  assert.ok(edit!.diff.includes('+++ b/aaaa.txt'), 'Edit diff 须带 b/ 头');
  assert.ok(edit!.diff.includes('-aaaa'), 'Edit diff 须含删除的 old_string');
  assert.ok(edit!.diff.includes('+bbb'), 'Edit diff 须含新增的 new_string');
  assert.ok(/@@\s+-1,1\s+\+1,1\s+@@/.test(edit!.diff), 'Edit diff 须带 hunk 头');

  // Edit 含公共行：行级 LCS 把公共行作为 context（前导空格），只标红改动的 aaa→bbb
  const ctx = synthesizeToolDiff('Edit', {
    file_path: 'f.txt',
    old_string: 'line1\naaa\nline3',
    new_string: 'line1\nbbb\nline3',
  });
  assert.ok(ctx!.diff.includes(' line1'), '公共行须作为 context 保留');
  assert.ok(ctx!.diff.includes('-aaa') && ctx!.diff.includes('+bbb'), '只标注改动的行');
  assert.ok(!ctx!.diff.includes('-line1') && !ctx!.diff.includes('+line1'), '公共行不得标成增删');

  // Write：旧侧空（无快照），整段按新增展示，对应 git「新建文件」-0,0 头
  const write = synthesizeToolDiff('Write', { file_path: 'new.txt', content: 'hello\nworld\n' });
  assert.ok(write, 'Write 须合成 diff');
  assert.equal(write!.kind, 'write');
  assert.ok(write!.diff.includes('-0,0'), 'Write 须以空旧侧（-0,0）表示新增');
  assert.ok(write!.diff.includes('+hello') && write!.diff.includes('+world'), 'Write 内容须全为新增行');

  // MultiEdit：多条 edit 各成一段 patch（无文件内偏移无法合并）
  const multi = synthesizeToolDiff('MultiEdit', {
    file_path: 'm.txt',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'c', new_string: 'd' },
    ],
  });
  assert.ok(multi, 'MultiEdit 须合成 diff');
  assert.equal(multi!.kind, 'multiedit');
  assert.equal((multi!.diff.match(/^--- a\/m\.txt$/gm) ?? []).length, 2, '两条 edit 须各带文件头');
  assert.ok(multi!.diff.includes('-a') && multi!.diff.includes('+b') && multi!.diff.includes('-c') && multi!.diff.includes('+d'));

  // MultiEdit：无变化的 edit 被跳过，仅保留有变化的
  const multiPartial = synthesizeToolDiff('MultiEdit', {
    file_path: 'm.txt',
    edits: [
      { old_string: 'a', new_string: 'b' },
      { old_string: 'same', new_string: 'same' },
    ],
  });
  assert.equal((multiPartial!.diff.match(/^--- a\/m\.txt$/gm) ?? []).length, 1, '无变化的 edit 须跳过');

  // 无变化 / 空 / 非编辑类工具 → null
  assert.equal(synthesizeToolDiff('Edit', { file_path: 'x', old_string: 'same', new_string: 'same' }), null, 'old===new 须返回 null');
  assert.equal(synthesizeToolDiff('Write', { file_path: 'x', content: '' }), null, '空 content 须返回 null');
  assert.equal(synthesizeToolDiff('Bash', { command: 'ls' }), null, '非编辑工具须返回 null');
  assert.equal(synthesizeToolDiff('Read', { file_path: 'x' }), null, 'Read 须返回 null');
  assert.equal(synthesizeToolDiff('Edit', null), null, '入参为 null 须返回 null');

  // 反斜杠路径归一为正斜杠（diff 头更整洁，diff2html 文件名显示正常）
  const win = synthesizeToolDiff('Edit', { file_path: 'D:\\dir\\f.txt', old_string: 'a', new_string: 'b' });
  assert.ok(win!.diff.includes('a/D:/dir/f.txt'), '反斜杠路径须归一为正斜杠');

  // 片段 diff 的计数字段（变更行数 -/+ 合计；含截断部分，供折叠态 +/− 徽标）。
  assert.equal(edit!.changeCount, 2, 'changeCount 须为变更行数');
  assert.equal(edit!.additions, 1, 'additions 须为新增行数');
  assert.equal(edit!.deletions, 1, 'deletions 须为删除行数');

  // ── 截断（P3）：超 MAX_DIFF_LINES 标 truncated，changeCount 仍计全量，diff 仍可渲染 ──
  const huge = Array.from({ length: 3000 }, (_, i) => `row ${i}`).join('\n');
  const trunc = synthesizeToolDiff('Write', { file_path: 'h.txt', content: huge });
  assert.equal(trunc!.truncated, true, '巨型 Write 须标 truncated');
  assert.equal(trunc!.changeCount, 3000, '截断后 changeCount 仍计全量');
  assert.ok(trunc!.diff.split('\n').length <= 2010, '截断后 diff 行数须受限（≤2000 体 + 文件头）');

  // round-trip：合成 diff 经 renderDiffHtml 须被 diff2html 正常渲染，不回退裸源码
  const html = renderDiffHtml(edit!.diff);
  assert.ok(html.includes('d2h-file-wrapper'), '合成 diff 须被 diff2html 正常渲染');
  assert.ok(!html.includes('<pre><code>'), '合成 diff 不应回退到裸 <pre><code>');

  // 工具结果以 side-by-side（左改前 / 右改后）展示：默认 inline 不得带两栏结构，
  // sideBySide:true 须产 d2h-file-side-diff 两栏。
  assert.ok(!html.includes('d2h-file-side-diff'), '默认 inline 不得带两栏结构');
  const sbs = renderDiffHtml(edit!.diff, { sideBySide: true });
  assert.ok(sbs.includes('d2h-file-side-diff'), 'sideBySide 须产两栏结构 d2h-file-side-diff');
  assert.ok(sbs.includes('d2h-file-wrapper'), 'side-by-side 仍须正常渲染（含 d2h-file-wrapper）');

  // ToolCallBlock 接线契约：须导入并调用 synthesizeToolDiff
  const fs = require('node:fs') as typeof import('node:fs');
  const src = fs.readFileSync(new URL('../src/renderer/components/chat/ToolCallBlock.vue', import.meta.url), 'utf8');
  assert.ok(src.includes('synthesizeToolDiff'), 'ToolCallBlock 须导入 synthesizeToolDiff');
  assert.ok(/synthesizeToolDiff\([^)]*\)/.test(src), 'ToolCallBlock 须调用 synthesizeToolDiff');
  // 消息详情 diff 改为弹窗：接入 openToolDiffDialog，不再内嵌 diff2html 渲染
  assert.ok(src.includes('openToolDiffDialog'), 'ToolCallBlock 须接入 openToolDiffDialog 弹出对比弹窗');
  assert.ok(!src.includes('renderDiffHtml'), 'ToolCallBlock 不得再内嵌 renderDiffHtml');
  assert.ok(!src.includes('ResizeObserver') && !src.includes('SIDE_BY_SIDE_MIN_WIDTH'), 'ToolCallBlock 不再内嵌两栏测量（ResizeObserver/SIDE_BY_SIDE_MIN_WIDTH 已移除）');
  // §4.1：Edit/Write/MultiEdit 合成 diff 优先于 isDiff 真分支（openDiff 里 toolDiff 在 isDiff 之前）
  assert.ok(/openDiff\(\)[\s\S]*?if \(toolDiff\.value\)[\s\S]*?if \(isDiff\.value/.test(src), '合成 diff 须优先于 isDiff 真分支');
  // §3.2：折叠态 +/− 行数徽标
  assert.ok(src.includes('tool-row__diffcounts') && src.includes('diffCounts'), '折叠态须有 +/− 行数徽标');
  // §3.3：截断提示
  assert.ok(src.includes('tool-row__truncated') && src.includes('toolDiff?.truncated'), '截断须有提示');

  // diff2html 基础 CSS 须引入（两栏布局 + +/- 底色全靠它）；main.css 用更高特异性覆盖主题化部分
  const main = fs.readFileSync(new URL('../src/renderer/main.ts', import.meta.url), 'utf8');
  assert.ok(main.includes('diff2html/bundles/css/diff2html.min.css'), 'main.ts 须引入 diff2html 基础 CSS');
  // §3.4：+/- 行底色须 token 化（覆盖 diff2html 的 --d2h-*-bg-color 变量），为深色主题前置兜底
  const css = fs.readFileSync(new URL('../src/renderer/assets/styles/main.css', import.meta.url), 'utf8');
  assert.ok(css.includes('--d2h-del-bg-color') && css.includes('--d2h-ins-bg-color'), 'main.css 须 token 化 +/- 行底色');
  assert.ok(/--d2h-del-bg-color:\s*color-mix/.test(css), '+/- 底色须经 color-mix 接入主题 token');
  assert.ok(/var\(--color-danger\)/.test(css) && /var\(--color-accent\)/.test(css), '+/- 底色须接入 danger/accent token');
}

// 消息详情 diff 弹窗（ToolDiffDialog）：多段拆分纯函数 + 接线契约。
// 消息里 Edit/Write/MultiEdit 的片段意图 diff 不再内嵌 diff2html，改为弹窗复用 DiffBody 渲染。
function testToolDiffDialogContracts(): void {
  // ── splitUnifiedDiff 行为 ──
  assert.deepEqual(splitUnifiedDiff(''), [], '空文本须拆成空数组');
  assert.deepEqual(splitUnifiedDiff('   \n  '), [], '纯空白须拆成空数组');

  // 单段：仅一个文件头 → 一段
  const single = '--- a/x.ts\n+++ b/x.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n';
  assert.equal(splitUnifiedDiff(single).length, 1, '单段须拆成 1 段');
  assert.ok(splitUnifiedDiff(single)[0]!.includes('-old'), '单段内容须完整保留');

  // 多段（MultiEdit 合成：每段 `--- a/...` 起）→ 按段数拆分
  const multi = '--- a/m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n--- a/m.txt\n+++ b/m.txt\n@@ -1,1 +1,1 @@\n-c\n+d\n';
  const multiSegs = splitUnifiedDiff(multi);
  assert.equal(multiSegs.length, 2, 'MultiEdit 两段须拆成 2 段');
  assert.ok(multiSegs[0]!.includes('-a') && multiSegs[0]!.includes('+b'), '第 1 段内容正确');
  assert.ok(multiSegs[1]!.includes('-c') && multiSegs[1]!.includes('+d'), '第 2 段内容正确');

  // git 多文件：按 `diff --git ` 分界
  const git = 'diff --git a/one.txt b/one.txt\nindex 111..222 100644\n--- a/one.txt\n+++ b/one.txt\n@@ -1 +1 @@\n-1\n+one\ndiff --git a/two.txt b/two.txt\nindex 333..444 100644\n--- a/two.txt\n+++ b/two.txt\n@@ -1 +1 @@\n-2\n+two\n';
  const gitSegs = splitUnifiedDiff(git);
  assert.equal(gitSegs.length, 2, 'git 多文件须拆成 2 段');
  assert.ok(gitSegs[0]!.startsWith('diff --git a/one.txt') && gitSegs[1]!.startsWith('diff --git a/two.txt'), 'git 段须以各自 diff --git 起');

  // ── 接线契约 ──
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const useToolDiffDialog = read('../src/renderer/composables/useToolDiffDialog.ts');
  assert.ok(useToolDiffDialog.includes('openToolDiffDialog') && useToolDiffDialog.includes('requests.length'), 'openToolDiffDialog 须在交互弹窗并存时 no-op（requests.length>0）');
  assert.ok(useToolDiffDialog.includes('splitUnifiedDiff'), 'useToolDiffDialog 须经 splitUnifiedDiff 拆段');

  const appVue = read('../src/renderer/App.vue');
  assert.ok(appVue.includes('<ToolDiffDialog'), 'App.vue 须挂载 <ToolDiffDialog />');

  const dialog = read('../src/renderer/components/chat/ToolDiffDialog.vue');
  assert.ok(dialog.includes("from '../changes/DiffBody.vue'"), 'ToolDiffDialog 须复用 DiffBody 渲染器');
  assert.ok(dialog.includes('parseUnifiedDiff'), 'ToolDiffDialog 须经 parseUnifiedDiff 解析本地 diff 文本');
  assert.ok(dialog.includes('diff-segments'), 'ToolDiffDialog 多段时须有段切换条');
  assert.ok(!/from ['"].*changes-store['"]/.test(dialog), 'ToolDiffDialog 不得 import changesStore');
  assert.ok(!dialog.includes('ensureDiff'), 'ToolDiffDialog 不得调用 ensureDiff（git 拉取）');
  // isDiff 回退分支（如 Bash git diff）标题回落 parsed.path，显示真实文件路径并恢复语法高亮。
  assert.ok(dialog.includes('effectiveTitle') && dialog.includes('parsed.value?.path'), 'ToolDiffDialog 标题须回落 parsed.path（isDiff 真 diff 显示真实文件路径）');
}

// 会话改动面板：纯解析函数 + 共享工具名集合契约（git 运行时行为靠端到端目视覆盖）。
function testChangesPanelContracts(): void {
  // status --porcelain=v1 -z 解析：普通改动 / 未跟踪 / 含空格路径 / 重命名（含第二段 oldPath）
  const status = parseStatusPorcelainV1Z('M  src/a.ts\0?? new.txt\0A  my file.ts\0R  renamed.ts\0old.ts\0');
  assert.equal(status.length, 4, '须解析出 4 条 status');
  assert.equal(normalizeStatus(status[0].xy), 'M');
  assert.equal(status[0].path, 'src/a.ts');
  assert.equal(normalizeStatus(status[1].xy), '??');
  assert.equal(status[1].path, 'new.txt');
  assert.equal(status[2].path, 'my file.ts', '含空格路径须完整保留');
  assert.equal(normalizeStatus(status[3].xy), 'R');
  assert.equal(status[3].path, 'renamed.ts');
  assert.equal(status[3].oldPath, 'old.ts', '重命名须读出第二段 oldPath');

  // numstat -z 解析：正常计数 + 二进制（-\t-）
  const numstat = parseNumstatZ('5\t3\ta.ts\0-\t-\tb.bin\0');
  assert.equal(numstat.get('a.ts')?.additions, 5);
  assert.equal(numstat.get('a.ts')?.deletions, 3);
  assert.equal(numstat.get('a.ts')?.binary, false);
  assert.equal(numstat.get('b.bin')?.binary, true, '-\t- 须判二进制');

  // 截断：超 maxLines 标 truncated 且输出行数受限
  const big = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const t = truncateDiff(big, 10);
  assert.equal(t.truncated, true, '超限须截断');
  assert.ok(t.diff.split('\n').length <= 10, '截断后行数不超 maxLines');
  assert.equal(truncateDiff('short', 10).truncated, false, '未超限不得截断');
  // 截断须在 hunk 边界（@@），不在 hunk 中段产残缺 span：两 hunk 切到 6 行保留首个完整 hunk
  const twoHunks = '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-old\n+new\n@@ -5,1 +5,1 @@\n-old2\n+new2\n';
  const t2 = truncateDiff(twoHunks, 6);
  assert.equal(t2.truncated, true, '两 hunk 超限须截断');
  assert.ok(t2.diff.includes('+new') && !t2.diff.includes('+new2'), '截断须在 hunk 边界保留首个完整 hunk');

  // 共享工具名集合（触碰集采集与片段 diff 入口过滤共用）
  assert.deepEqual(
    [...TOOL_DIFF_TOOL_NAMES].sort(),
    ['Edit', 'MultiEdit', 'Write', 'edit', 'multi_edit', 'multiedit', 'write'].sort(),
    'TOOL_DIFF_TOOL_NAMES 须覆盖两种大小写与 MultiEdit 别名',
  );

  // === unified-diff 纯解析器契约（diff-parser）===
  // fixture：ctx / 1:1 mod(词级 segs) / 不等长 M:N→del+add / 末尾 \ No newline
  const UNI = '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,6 +1,7 @@\n line1\n-foo = 1;\n+foo = 2;\n ctx2\n-old1\n-old2\n+new1\n+new2\n+new3\n ctx3\n\\ No newline at end of file\n';
  const parsed = parseUnifiedDiff(UNI);
  assert.ok(parsed, '有效 unified diff 须解析出 ParsedDiffFile');
  assert.equal(parsed!.binary, false, '文本 diff 不得标二进制');
  assert.equal(parsed!.path, 'src/x.ts', '路径须去 a// b// 前缀');

  const joinSegs = (segs: { x: string }[] | undefined): string => (segs ?? []).map((s) => s.x).join('');
  const kinds = parsed!.groups.map((g) => g.k);
  assert.deepEqual(kinds, ['ctx', 'mod', 'ctx', 'del', 'add', 'ctx'], '分组顺序与类型须为 ctx→mod→ctx→del→add→ctx');

  // ctx 行号：L 旧 / R 新；首段无前置改动，二者同号
  assert.equal(parsed!.groups[0].L[0].n, 1);
  assert.equal(parsed!.groups[0].R[0].n, 1);
  assert.equal(parsed!.groups[0].L[0].t, 'line1');

  // mod 恒 1:1 + 词级 segs 重组回原文 + L 侧无 ins / R 侧无 del
  const mod = parsed!.groups[1];
  assert.equal(mod.L.length, 1, 'mod 组 L 须恒 1 行');
  assert.equal(mod.R.length, 1, 'mod 组 R 须恒 1 行');
  assert.ok(mod.L[0].segs && mod.R[0].segs, 'mod 组行须带词级 segs');
  assert.equal(joinSegs(mod.L[0].segs), 'foo = 1;', 'L segs 须重组回旧行原文');
  assert.equal(joinSegs(mod.R[0].segs), 'foo = 2;', 'R segs 须重组回新行原文');
  assert.ok(!mod.L[0].segs!.some((s) => s.s === 'ins'), 'L 侧 segs 不得含 ins');
  assert.ok(!mod.R[0].segs!.some((s) => s.s === 'del'), 'R 侧 segs 不得含 del');

  // 不等长 M:N(2 del : 3 add) → 退化为 del 组 + add 组（保序，牺牲词级）
  const delG = parsed!.groups[3];
  const addG = parsed!.groups[4];
  assert.equal(delG.k, 'del');
  assert.equal(delG.L.length, 2);
  assert.equal(delG.R.length, 0);
  assert.equal(delG.L[0].t, 'old1');
  assert.equal(delG.L[1].n, 5);
  assert.equal(addG.k, 'add');
  assert.equal(addG.R.length, 3);
  assert.equal(addG.L.length, 0);
  assert.equal(addG.R.map((l) => l.t).join('|'), 'new1|new2|new3');

  // 末尾 \ No newline 须跳过：最后 ctx 只含 ctx3 一行，旧=6 新=7（前置 del2/add3 错位）
  const last = parsed!.groups[5];
  assert.equal(last.k, 'ctx');
  assert.equal(last.L.length, 1);
  assert.equal(last.L[0].t, 'ctx3');
  assert.equal(last.L[0].n, 6);
  assert.equal(last.R[0].n, 7);

  // 仅空白差异 → ws 组（trim 相等但原文不等），仍恒 1:1
  const ws = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a \n+a\n')!;
  assert.equal(ws.groups[0].k, 'ws', 'trim 等原文不等须判 ws');
  assert.equal(ws.groups[0].L.length, 1);
  assert.equal(ws.groups[0].R.length, 1);
  assert.ok(!ws.groups[0].L[0].segs!.some((s) => s.s === 'ins'), 'ws L 侧不得含 ins');

  // 全 add（新建文件，旧侧 /dev/null）→ 单 add 组，旧侧空
  const created = parseUnifiedDiff('--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hello\n+world\n')!;
  assert.equal(created.path, 'new.txt', '/dev/null 旧侧须取 newFileName 去前缀');
  assert.equal(created.groups[0].k, 'add');
  assert.equal(created.groups[0].L.length, 0);
  assert.equal(created.groups[0].R.map((l) => l.t).join('|'), 'hello|world');
  assert.equal(created.groups[0].R[0].n, 1);

  // 全 del（删除文件，新侧 /dev/null）→ 单 del 组，新侧空
  const removed = parseUnifiedDiff('--- a/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-deleted\n')!;
  assert.equal(removed.path, 'gone.ts');
  assert.equal(removed.groups[0].k, 'del');
  assert.equal(removed.groups[0].R.length, 0);
  assert.equal(removed.groups[0].L[0].t, 'deleted');

  // 空输入 / 非 diff 纯文本 → null
  assert.equal(parseUnifiedDiff(''), null);
  assert.equal(parseUnifiedDiff('   \n  '), null);
  assert.equal(parseUnifiedDiff('just some plain text\nno diff here'), null);

  // 二进制哨兵（无 hunk + Binary files differ）→ binary:true
  const bin = parseUnifiedDiff('Binary files a/x.png and b/x.png differ')!;
  assert.equal(bin.binary, true);
  assert.equal(bin.groups.length, 0);

  // 多 hunk → 相邻 hunk 间产 skip 组（git 跳过的未输出行，渲染「⋯ N 行」分隔，多处改动明确分块）
  const MULTI = '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-old\n+new\n b\n@@ -20,3 +20,3 @@\n c\n-old2\n+new2\n d\n';
  const multi = parseUnifiedDiff(MULTI)!;
  const skips = multi.groups.filter((g) => g.k === 'skip');
  assert.equal(skips.length, 1, '两 hunk 间须产 1 个 skip 组');
  assert.ok((skips[0]!.skipCount ?? 0) > 0, 'skip 组须记录跳过行数');
}

function testChangesPanelPlumbing(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');

  const ipc = read('../src/shared/types/ipc.ts');
  assert.ok(ipc.includes("CHANGES_LIST: 'changes:list'"), '须定义 CHANGES_LIST 通道');
  assert.ok(ipc.includes("CHANGES_DIFF: 'changes:diff'"), '须定义 CHANGES_DIFF 通道');
  assert.ok(!ipc.includes('TOOL_FILE_SNAPSHOT'), '快照通道须已退役');

  const handlers = read('../src/main/ipc-handlers.ts');
  assert.ok(handlers.includes('IPC_CHANNELS.CHANGES_LIST') && handlers.includes('listChanges'), '须注册 CHANGES_LIST handler');
  assert.ok(handlers.includes('IPC_CHANNELS.CHANGES_DIFF') && handlers.includes('getChangeDiff'), '须注册 CHANGES_DIFF handler');

  const preload = read('../src/preload/api.ts');
  assert.ok(preload.includes('listChanges') && preload.includes('getChangeDiff'), 'preload 须暴露 listChanges/getChangeDiff');
  assert.ok(!preload.includes('onToolFileSnapshot'), 'preload 快照方法须已移除');

  const panel = read('../src/main/modules/changes-panel.ts');
  assert.ok(panel.includes('GIT_TERMINAL_PROMPT') && panel.includes('timeout'), 'git 调用须禁用凭证交互并带超时');
  assert.ok(panel.includes('touchedPaths'), 'listChanges 须接收本会话 touchedPaths 标注编辑文件');
  assert.ok(panel.includes("'--', '/dev/null'"), '未跟踪 diff 须用 -- 终止选项防路径注入');
  // 二进制检测须锚行首（^Binary files），防文本 diff 内容行含该子串被误判二进制
  assert.ok(panel.includes('^(?:Binary files'), '二进制检测须锚行首，不得用裸子串匹配');
  // listChanges 须对 git 超时/maxBuffer 失败降级为 ok:false（不抛出），让面板显可读错误而非静默
  assert.ok(panel.includes('扫描改动失败'), 'listChanges 须对 git 失败返回 ok:false 带可读文案');
  // F：listChanges 的 status/numstat 须统一带 --no-pager（与 getChangeDiff 一致，防 pager 介入）
  assert.ok(/'--no-pager',\s*'status'/.test(panel), 'listChanges 的 status 须带 --no-pager');
  assert.ok(/'--no-pager',\s*'diff',\s*'HEAD',\s*'--numstat'/.test(panel), 'listChanges 的 numstat 须带 --no-pager');
  // G：MAX_DIFF_LINES 须为 shared 单一定义，main 与 renderer 都从 shared 取，不得本地 const 再定义
  assert.ok(panel.includes('MAX_DIFF_LINES') && panel.includes("from '../../shared/process-kind'"), 'changes-panel 须从 shared 取 MAX_DIFF_LINES');
  const toolDiff = read('../src/renderer/utils/tool-diff.ts');
  assert.ok(toolDiff.includes('MAX_DIFF_LINES') && toolDiff.includes("from '../../shared/process-kind'"), 'tool-diff 须从 shared 取 MAX_DIFF_LINES');
  assert.ok(!/\bconst\s+MAX_DIFF_LINES\b/.test(panel) && !/\bconst\s+MAX_DIFF_LINES\b/.test(toolDiff), 'MAX_DIFF_LINES 不得本地 const 再定义，须统一从 shared 取');

  const store = read('../src/renderer/stores/session-store.ts');
  assert.ok(store.includes("'changes'"), "rightTab 须含 'changes'");

  const taskPanel = read('../src/renderer/components/task/TaskQueuePanel.vue');
  assert.ok(taskPanel.includes("rightTab === 'changes'") && taskPanel.includes('<ChangesPanel'), '右侧任务栏须接入 改动 Tab 与 ChangesPanel');

  // === CHANGES_OPEN_FILE 通道三处同步 + 越界守卫（点文件「打开」走 shell.openPath）===
  assert.ok(ipc.includes("CHANGES_OPEN_FILE: 'changes:openFile'"), '须定义 CHANGES_OPEN_FILE 通道');
  assert.ok(handlers.includes('IPC_CHANNELS.CHANGES_OPEN_FILE') && handlers.includes('openChangeFile'), '须注册 CHANGES_OPEN_FILE handler');
  assert.ok(preload.includes('openChangeFile'), 'preload 须暴露 openChangeFile');
  // openChangeFile 须定义在 changes-panel.ts 内（复用未导出的 ensureRepo），import shell 用 openPath
  assert.ok(panel.includes(`import { shell } from 'electron'`), 'openChangeFile 须 import electron shell 用 openPath');
  assert.ok(panel.includes('export async function openChangeFile'), 'changes-panel 须导出 openChangeFile');
  assert.ok(panel.includes('isPathInsideRoot(abs, root)'), 'openChangeFile 越界守卫须经 isPathInsideRoot（normalize 统一分隔符防正斜杠 root 误判）');
  assert.ok(panel.includes('export function isPathInsideRoot'), 'changes-panel 须导出 isPathInsideRoot 纯函数');
  assert.ok(!panel.includes('path.resolve(workingDir, relPath)'), '不得 resolve(workingDir, relPath)（workingDir 可能是仓库子目录）');
  // ChangesOpenResult 判别联合须定义（ok 分支类型安全）
  const changesTypes = read('../src/shared/types/changes.ts');
  assert.ok(changesTypes.includes('export type ChangesOpenResult'), '须定义 ChangesOpenResult 类型');

  // === DiffDialog 接线（点文件 → 弹窗，取代内联展开）===
  assert.ok(fs.existsSync(new URL('../src/renderer/composables/useDiffDialog.ts', import.meta.url)), 'useDiffDialog 组合式须存在');
  const useDiffDialogSrc = read('../src/renderer/composables/useDiffDialog.ts');
  assert.ok(useDiffDialogSrc.includes('openDiffDialog') && useDiffDialogSrc.includes('requests.length'), 'openDiffDialog 须在交互弹窗并存时 no-op（requests.length>0）');
  const appVue = read('../src/renderer/App.vue');
  assert.ok(appVue.includes('<DiffDialog'), 'App.vue 须挂载 <DiffDialog />');
  const changesPanelSrc = read('../src/renderer/components/changes/ChangesPanel.vue');
  assert.ok(changesPanelSrc.includes('openDiffDialog'), 'ChangesPanel 行点击须接 openDiffDialog');
  assert.ok(!changesPanelSrc.includes('toggleExpand') && !changesPanelSrc.includes('expandedHtml'), 'ChangesPanel 须移除内联展开（toggleExpand/expandedHtml）');
  assert.ok(taskPanel.includes('openDiffDialog'), 'TaskQueuePanel 概览摘要须接 openDiffDialog');

  // 快照链路须已彻底退役（文件已删除）
  assert.ok(!fs.existsSync(new URL('../src/main/modules/file-snapshot.ts', import.meta.url)), 'file-snapshot.ts 须已删除');
  assert.ok(!fs.existsSync(new URL('../src/renderer/composables/use-tool-file-snapshots.ts', import.meta.url)), 'use-tool-file-snapshots.ts 须已删除');
}

function testDiffDialogSearchUiContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffDialogSrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffDialog.vue', import.meta.url),
    'utf8',
  );
  const diffBodySrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffBody.vue', import.meta.url),
    'utf8',
  );
  assert.match(diffDialogSrc, /ctrlKey[\s\S]*key\.toLowerCase\(\) === 'f'/, 'DiffDialog 须支持 Ctrl+F');
  assert.match(diffDialogSrc, /querySelectorAll<HTMLElement>\([\s\S]{0,160}input:not\(:disabled\)/, 'Tab trap 须包含搜索 input');
  assert.ok(diffDialogSrc.includes('class="diff-searchbar"'), 'DiffDialog 须有独立第二行搜索栏');
  assert.ok(diffDialogSrc.includes('差异过大，仅搜索已加载部分'), '截断时须明确搜索范围不完整');
  assert.match(diffDialogSrc, /@keydown="onSearchKeydown"/, '搜索输入须处理 Enter/Shift+Enter/Esc');
  assert.doesNotMatch(diffDialogSrc + diffBodySrc, /findInPage|TreeWalker|surroundContents/, 'diff 搜索不得使用页面级或命令式 DOM 高亮');
}

function testDiffDialogNoWrapContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffDialogSrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffDialog.vue', import.meta.url),
    'utf8',
  );
  const diffBodySrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffBody.vue', import.meta.url),
    'utf8',
  );
  const dialogScript = diffDialogSrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const dialogTemplate = diffDialogSrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
  const bodyScript = diffBodySrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const bodyTemplate = diffBodySrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';

  assert.doesNotMatch(dialogScript, /const\s+wrap\s*=\s*ref\(/, 'DiffDialog 不得保留换行状态');
  assert.doesNotMatch(dialogTemplate, /自动换行|>换行<|:wrap=/, 'DiffDialog 不得展示或下传换行功能');
  assert.doesNotMatch(bodyScript, /\bwrap:\s*boolean;/, 'DiffBody 不得接收换行 prop');
  assert.doesNotMatch(bodyTemplate, /is-wrap/, 'DiffBody 根节点不得绑定换行 class');
  assert.doesNotMatch(diffBodySrc, /\.diff-body\.is-wrap/, 'DiffBody 不得保留失效的换行样式');
}

function testDiffDialogSearchStateContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffDialogSrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffDialog.vue', import.meta.url),
    'utf8',
  );
  const script = diffDialogSrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const template = diffDialogSrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';

  assert.match(script, /import\s*\{\s*buildDiffSearchMatches,\s*moveSearchIndex\s*\}\s*from '\.\.\/\.\.\/utils\/diff-search';/, 'DiffDialog 须导入搜索结果构建与循环索引函数');
  assert.match(script, /type SearchScope = 'full' \| 'context';/, 'DiffDialog 须定义全文与当前上下文搜索范围');
  assert.match(script, /const searchOpen = ref\(false\);/, '搜索面板默认须关闭');
  assert.match(script, /const searchQuery = ref\(''\);/, '搜索词默认须为空');
  assert.match(script, /const searchScope = ref<SearchScope>\('full'\);/, '搜索范围默认须为全文');
  assert.match(script, /const currentSearchIndex = ref\(0\);/, '搜索索引须独立于改动导航索引');
  assert.match(script, /const searchInput = ref<HTMLInputElement \| null>\(null\);/, '须持有搜索输入框引用');
  assert.match(script, /const searchMatches = computed\(\(\) => buildDiffSearchMatches\(parsed\.value, searchQuery\.value\)\);/, '搜索结果须由当前 parsed 与 query 计算');
  assert.match(script, /const currentSearchMatch = computed\(\(\) => searchMatches\.value\[currentSearchIndex\.value\] \?\? null\);/, '当前搜索项须由独立索引取得');
  assert.match(script, /const searchCountText = computed\([\s\S]{0,240}'0 \/ 0'[\s\S]{0,240}\);/, '须提供搜索结果计数文本');

  assert.match(script, /watch\(\[searchQuery, parsed, searchScope\], \(\) => \{\s*currentSearchIndex\.value = 0;\s*\}\);/, '搜索词、diff 或范围变化时须复位索引');
  assert.match(script, /watch\(searchMatches, \(matches\) => \{[\s\S]{0,300}currentSearchIndex\.value[\s\S]{0,300}\}\);/, '搜索结果变化时须校正空结果与越界索引');

  assert.match(script, /async function openSearch\(\): Promise<void>[\s\S]{0,400}searchOpen\.value = true;[\s\S]{0,200}searchScope\.value === 'full'[\s\S]{0,120}fullText\.value = true;[\s\S]{0,160}await nextTick\(\);[\s\S]{0,120}searchInput\.value\?\.focus\(\);[\s\S]{0,120}searchInput\.value\?\.select\(\);/, '打开搜索须按全文范围切换 diff，并在 nextTick 后聚焦全选');
  assert.match(script, /function closeSearch\(\): void \{\s*searchOpen\.value = false;\s*\}/, '关闭搜索须只关闭面板，不清搜索词');
  assert.match(script, /function setSearchScope\(scope: SearchScope\): void[\s\S]{0,240}searchScope\.value = scope;[\s\S]{0,160}fullText\.value = scope === 'full';/, '切换搜索范围须同步全文 diff 状态');
  assert.match(script, /function gotoSearch\(delta: number\): void[\s\S]{0,240}moveSearchIndex\(currentSearchIndex\.value, delta, searchMatches\.value\.length\)/, '搜索导航须通过 moveSearchIndex 循环');
  assert.match(script, /function onSearchKeydown\(e: KeyboardEvent\): void[\s\S]{0,500}e\.key === 'Escape'[\s\S]{0,160}e\.preventDefault\(\);[\s\S]{0,120}e\.stopPropagation\(\);[\s\S]{0,120}closeSearch\(\);[\s\S]{0,240}e\.key === 'Enter'[\s\S]{0,160}e\.preventDefault\(\);[\s\S]{0,160}gotoSearch\(e\.shiftKey \? -1 : 1\);/, '搜索输入须支持 Esc 关闭与 Enter/Shift+Enter 循环导航');

  assert.match(script, /function setContext\(n: number\): void[\s\S]{0,240}fullText\.value = false;[\s\S]{0,160}searchOpen\.value[\s\S]{0,120}searchScope\.value = 'context';/, '用户选择上下文行数时，已打开搜索须同步为当前上下文');
  assert.match(script, /function setFullText\(\): void[\s\S]{0,240}fullText\.value = true;[\s\S]{0,160}searchOpen\.value[\s\S]{0,120}searchScope\.value = 'full';/, '用户选择全文时，已打开搜索须同步为全文范围');
  assert.match(template, /@click="setFullText"[^>]*>全文<\/button>/, '全文按钮须通过 setFullText 同步搜索范围');

  assert.match(script, /watch\(state, async \(s\) => \{[\s\S]{0,600}searchOpen\.value = false;[\s\S]{0,200}searchQuery\.value = '';[\s\S]{0,200}searchScope\.value = 'full';[\s\S]{0,200}currentSearchIndex\.value = 0;/, '每次打开弹窗须复位搜索状态');
  assert.match(template, /:search-matches="searchMatches"/, 'DiffDialog 须向 DiffBody 下传搜索结果');
  assert.match(template, /:current-search-match-id="currentSearchMatch\?\.id \?\? null"/, 'DiffDialog 须向 DiffBody 下传当前搜索 id');
}

function testDiffBodySearchProjectionContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffBodySrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffBody.vue', import.meta.url),
    'utf8',
  );

  const script = diffBodySrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const template = diffBodySrc.match(/<template>([\s\S]*)<\/template>/)?.[1] ?? '';
  assert.match(
    script,
    /import\s*\{\s*groupSearchMatchesByLine,\s*type DiffSearchMatch,\s*type DiffSearchRange,?\s*\}\s*from '\.\.\/\.\.\/utils\/diff-search';/,
    'DiffBody 须导入搜索分组函数与匹配/范围类型',
  );
  assert.match(script, /searchMatches\?:\s*DiffSearchMatch\[\];/, 'DiffBody 须接收可选 searchMatches');
  assert.match(script, /currentSearchMatchId\?:\s*string\s*\|\s*null;/, 'DiffBody 须接收可选 currentSearchMatchId');
  assert.match(
    script,
    /const searchLineIndex = computed\(\(\) =>[\s\S]{0,700}(?:const matches = props\.searchMatches \?\? \[\];[\s\S]{0,200})?groupSearchMatchesByLine\((?:props\.searchMatches \?\? \[\]|matches)\)[\s\S]{0,700}\);/,
    'DiffBody 须从 props 搜索结果计算行索引',
  );
  assert.match(
    script,
    /function leftSearchRanges\(n: number \| null\): DiffSearchRange\[\][\s\S]{0,300}searchLineIndex\.value\.left\.get\(`old:\$\{n\}`\)/,
    '左栏须按 old:行号读取搜索范围',
  );
  assert.match(
    script,
    /function rightSearchRanges\(n: number \| null\): DiffSearchRange\[\][\s\S]{0,300}searchLineIndex\.value\.right\.get\(`new:\$\{n\}`\)/,
    '右栏须按 new:行号读取搜索范围',
  );
  assert.match(
    script,
    /function inlineSearchRanges\(row: InlineRow\): DiffSearchRange\[\][\s\S]{0,300}row\.type === 'del'[\s\S]{0,160}leftSearchRanges\(row\.n\)[\s\S]{0,160}rightSearchRanges\(row\.n\)/,
    'inline 须让 del 读旧行、add/ctx 读新行',
  );
  assert.match(
    script,
    /function currentSearchForRanges\(ranges: DiffSearchRange\[\]\): string \| null[\s\S]{0,300}ranges\.some\([\s\S]{0,120}matchId === props\.currentSearchMatchId[\s\S]{0,120}props\.currentSearchMatchId[\s\S]{0,80}null/,
    '须只向命中当前项的行返回 currentSearchMatchId',
  );
  assert.match(
    script,
    /function searchMemoKey\(ranges: DiffSearchRange\[\]\): string[\s\S]{0,400}ranges\.map\([\s\S]{0,120}matchId[\s\S]{0,200}currentSearchForRanges\(ranges\)/,
    '搜索 memo key 须包含全部 matchId 与行级当前项状态',
  );

  const leftSplit = template.match(/<DiffLine\s+v-else[\s\S]{0,120}variant="split"\s+side="left"[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(leftSplit, /:search-ranges="leftSearchRanges\(ln\.n\)"/, 'split 左栏须下传旧行搜索范围');
  assert.match(leftSplit, /:current-search-match-id="currentSearchForRanges\(leftSearchRanges\(ln\.n\)\)"/, 'split 左栏须只下传行级当前搜索项');
  assert.match(leftSplit, /:data-search-line="ln\.n != null \? `old:\$\{ln\.n\}` : null"/, 'split 左栏须标记稳定 old:行号');

  const rightSplit = template.match(/<DiffLine\s+v-else[\s\S]{0,120}variant="split"\s+side="right"[\s\S]*?\/>/)?.[0] ?? '';
  assert.match(rightSplit, /:search-ranges="rightSearchRanges\(ln\.n\)"/, 'split 右栏须下传新行搜索范围');
  assert.match(rightSplit, /:current-search-match-id="currentSearchForRanges\(rightSearchRanges\(ln\.n\)\)"/, 'split 右栏须只下传行级当前搜索项');
  assert.match(rightSplit, /:data-search-line="ln\.n != null \? `new:\$\{ln\.n\}` : null"/, 'split 右栏须标记稳定 new:行号');

  const inlineLines = [...template.matchAll(/<DiffLine\s+v-for="\(r, i\) in seg\.rows"[\s\S]*?\/>/g)].map((match) => match[0]);
  assert.equal(inlineLines.length, 3, 'inline 展开 gap、change、ctx 三处 DiffLine 均须保留');
  inlineLines.forEach((line, index) => {
    const location = ['展开 gap', 'change', 'ctx'][index];
    assert.match(line, /:search-ranges="inlineSearchRanges\(r\)"/, `inline ${location} 须下传搜索范围`);
    assert.match(line, /:current-search-match-id="currentSearchForRanges\(inlineSearchRanges\(r\)\)"/, `inline ${location} 须只下传行级当前搜索项`);
    assert.match(line, /:data-search-line="r\.n != null \? `\$\{r\.type === 'del' \? 'old' : 'new'\}:\$\{r\.n\}` : null"/, `inline ${location} 须标记稳定侧别与行号`);
    assert.match(line, /v-memo="\[r\.line, r\.type, searchMemoKey\(inlineSearchRanges\(r\)\)\]"/, `inline ${location} memo 须纳入搜索状态`);
  });
}

function testDiffBodySplitNodeLifecycleContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffBodySrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffBody.vue', import.meta.url),
    'utf8',
  );
  const script = diffBodySrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';

  assert.match(
    script,
    /watch\(\s*splitScroll,[\s\S]{0,1600}\{\s*flush:\s*'post'\s*\},\s*\);/,
    'split 条件节点资源须由 post-flush ref watcher 管理',
  );
  assert.match(
    script,
    /el\.addEventListener\('wheel', onWheel, \{ passive: false \}\)[\s\S]{0,900}observer\.observe\(el\)/,
    '每次创建 split 节点须绑定 wheel 并观察同一节点',
  );
  assert.match(
    script,
    /onCleanup\(\(\) => \{[\s\S]{0,600}el\.removeEventListener\('wheel', onWheel\)[\s\S]{0,300}observer\.disconnect\(\)/,
    'split 节点销毁时须清理实际绑定节点及其 observer',
  );
  assert.doesNotMatch(
    script,
    /onMounted\([\s\S]{0,800}splitScroll\.value\?\.addEventListener\('wheel'/,
    '不得只在组件首次挂载时绑定条件 split 节点',
  );
  assert.match(
    script,
    /function recomputeSplitGeometry\(\): void \{[\s\S]{0,500}if \(!splitScroll\.value\) return;[\s\S]{0,500}recomputeMaxScroll\(\);[\s\S]{0,300}scheduleOffset\(\);/,
    'split 几何重算须要求真实节点，并同时刷新滚动范围与偏移',
  );
  assert.match(
    script,
    /watch\(splitLayout,\s*recomputeSplitGeometry,\s*\{\s*flush:\s*'post'\s*\}\);/,
    'layout 更新须在 DOM 刷新后通过统一入口重算 split 几何',
  );
  assert.match(script, /let stopVthumbDrag:\s*\(\(\) => void\) \| null = null;/, '须保存自定义滚动条拖动清理句柄');
  assert.match(
    script,
    /onCleanup\(\(\) => \{[\s\S]{0,500}stopVthumbDrag\?\.\(\);/,
    'split 节点销毁时须清理自定义滚动条拖动监听',
  );
  assert.match(
    script,
    /onBeforeUnmount\(\(\) => \{[\s\S]{0,400}stopVthumbDrag\?\.\(\);/,
    '组件卸载时须兜底清理自定义滚动条拖动监听',
  );
}

function testDiffBodySearchScrollContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const diffBodySrc = fs.readFileSync(
    new URL('../src/renderer/components/changes/DiffBody.vue', import.meta.url),
    'utf8',
  );
  const script = diffBodySrc.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)?.[1] ?? '';
  const functionBlock = (name: string): string => {
    const start = script.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `DiffBody 须定义 ${name}`);
    const bodyStart = script.indexOf('{', start);
    assert.notEqual(bodyStart, -1, `${name} 须有函数体`);
    let depth = 0;
    for (let i = bodyStart; i < script.length; i++) {
      if (script[i] === '{') depth++;
      else if (script[i] === '}' && --depth === 0) return script.slice(start, i + 1);
    }
    assert.fail(`${name} 函数体未闭合`);
  };

  const rowContains = functionBlock('rowContainsMatch');
  assert.match(rowContains, /row\.type === 'del'\s*&&\s*match\.side === 'left'\s*&&\s*row\.n === match\.oldLine/, 'inline del 须用 left + oldLine 定位');
  assert.match(rowContains, /row\.type === 'ctx'\s*&&\s*match\.side === 'both'\s*&&\s*row\.n === match\.newLine/, 'inline ctx 须用 both + newLine 定位');
  assert.match(rowContains, /row\.type === 'add'\s*&&\s*match\.side === 'right'\s*&&\s*row\.n === match\.newLine/, 'inline add 须用 right + newLine 定位');

  const revealInline = functionBlock('revealInlineMatch');
  assert.match(revealInline, /inlineSegs\.value[\s\S]*seg\.kind !== 'gap'[\s\S]*seg\.rows\.some\(\(row\) => rowContainsMatch\(row, match\)\)/, 'inline 须只检查 gap 内是否包含当前命中');
  assert.match(revealInline, /const next = new Set\(expandedGaps\.value\);[\s\S]*next\.add\(seg\.gapIndex\);[\s\S]*expandedGaps\.value = next;/, '展开命中 gap 须保留已有集合并仅 add 对应 id');
  assert.doesNotMatch(revealInline, /expandedGaps\.value\s*=\s*new Set\(\)/, '搜索定位不得清空已展开 gap');

  const selector = functionBlock('matchSelector');
  assert.match(selector, /`\[data-search-match="\$\{CSS\.escape\(matchId\)\}"\]`/, '搜索命中 selector 须用 CSS.escape 转义 id');
  const findTarget = functionBlock('findSearchTarget');
  assert.match(findTarget, /const pane = match\.side === 'left' \? leftPane\.value : rightPane\.value;[\s\S]*pane\?\.querySelector\(matchSelector\(match\.id\)\)/, 'split 须固定 left 查左 pane，right/both 查右 pane');

  const horizontal = functionBlock('ensureHorizontalVisible');
  assert.match(horizontal, /const margin = 12;/, '横向定位须保留 12px 可视边距');
  assert.match(horizontal, /targetRect\.left < paneRect\.left \+ margin[\s\S]*pane\.scrollLeft \+= targetRect\.left - paneRect\.left - margin;/, '命中越过左边界时须向左调整 scrollLeft');
  assert.match(horizontal, /targetRect\.right > paneRect\.right - margin[\s\S]*pane\.scrollLeft \+= targetRect\.right - paneRect\.right \+ margin;/, '命中越过右边界时须向右调整 scrollLeft');

  const scrollCurrent = functionBlock('scrollCurrentSearchMatch');
  assert.match(scrollCurrent, /const match = props\.searchMatches\?\.find\(\(candidate\) => candidate\.id === props\.currentSearchMatchId\);\s*if \(!match\) return;/, '自动定位须按 currentSearchMatchId 找当前 match，无命中即返回');
  const revealAt = scrollCurrent.indexOf('revealInlineMatch(match)');
  const tickAt = scrollCurrent.indexOf('await nextTick()');
  assert.ok(revealAt !== -1 && tickAt !== -1 && revealAt < tickAt, 'inline 须先展开命中 gap，再等待 DOM 更新');
  assert.match(scrollCurrent, /target\.closest\('\.line'\)[\s\S]*line\.closest\('\.pane-scroll'\)[\s\S]*pane\.scrollTo\(\{[\s\S]*top:[\s\S]*\}\);/, 'inline 须以原生 scrollTo 将命中行垂直居中');
  assert.match(scrollCurrent, /ensureHorizontalVisible\(pane, target\)/, 'inline 与 split 定位后须保证长行命中横向可见');
  assert.match(scrollCurrent, /const side = match\.side === 'left' \? 'left' : 'right';\s*const lineNumber = side === 'left' \? match\.oldLine : match\.newLine;\s*const lines = side === 'left' \? splitLayout\.value\?\.leftLines : splitLayout\.value\?\.rightLines;\s*const sideLineIndex = lines\?\.findIndex\(\(candidate\) => candidate\.n === lineNumber\) \?\? -1;/, 'split 须让 both 选右侧，并按 old/new 行号定位 layout 侧行索引');
  assert.match(scrollCurrent, /if \(!pane \|\| !splitLayout\.value \|\| sideLineIndex < 0\) return;\s*recomputeMaxScroll\(\);\s*scrollTop\.value = resolveSearchScrollTop\(\s*splitLayout\.value\.chunks,\s*side,\s*sideLineIndex,\s*pane\.clientHeight,\s*LH,\s*maxScrollTop\.value,\s*scrollTop\.value,\s*\);\s*scheduleOffset\(\);/, 'split 须先按新 DOM 刷新 maxScrollTop，再调用纯几何 helper 一次求解并调度 offset');
  assert.match(scrollCurrent, /searchScrollRaf = requestAnimationFrame\(async \(\) =>[\s\S]*await nextTick\(\);[\s\S]*props\.mode !== 'split' \|\| props\.currentSearchMatchId !== match\.id[\s\S]*findSearchTarget\(match\)[\s\S]*liveTarget\?\.closest\('\.line'\)[\s\S]*liveTarget\?\.closest\('\.pane'\)/, 'split 须在 offset 生效帧防 stale 后重新取 live target/line/pane');
  assert.match(scrollCurrent, /const correction = liveLineRect\.top - livePaneRect\.top\s*- \(livePane\.clientHeight - liveLineRect\.height\) \/ 2;/, 'split 二次校正须按真实 DOM 行中心与 pane 中心的偏差计算');
  assert.match(scrollCurrent, /Math\.min\(maxScrollTop\.value, scrollTop\.value \+ correction\)[\s\S]*scrollTop\.value = correctedScrollTop;[\s\S]*scheduleOffset\(\);[\s\S]*ensureHorizontalVisible\(livePane, liveTarget\);/, 'split 须钳制二次校正 scrollTop、重新调度 offset，并校正横向可见性');
  assert.doesNotMatch(scrollCurrent, /scrollIntoView/, 'split 自定义滚动不得调用 scrollIntoView');

  assert.match(
    script,
    /watch\(\s*\[\(\) => props\.currentSearchMatchId, \(\) => props\.mode, \(\) => props\.parsed\],\s*\(\) => \{\s*void scrollCurrentSearchMatch\(\);\s*\},\s*\{ flush: 'post' \},\s*\);/,
    '须 post-flush 监听当前搜索 id、mode 与 parsed 后触发自动定位',
  );
  assert.match(script, /import[\s\S]{0,500}resolveSearchScrollTop[\s\S]{0,300}from '\.\.\/\.\.\/utils\/diff-render';/, 'DiffBody 须从纯渲染辅助模块导入搜索滚动求解器');
  assert.match(script, /let searchScrollRaf = 0;/, '须持有搜索校正帧句柄');
  const unmount = script.slice(script.indexOf('onBeforeUnmount(() => {'));
  assert.match(unmount, /if \(searchScrollRaf\) cancelAnimationFrame\(searchScrollRaf\);/, '卸载时须取消搜索校正帧');
}

function testOpenWithFallbackContracts(): void {
  // 「打开」降级：shell.openPath 失败时 Windows 须弹原生「打开方式」对话框（修复注释空头承诺的 bug）
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const panel = read('../src/main/modules/changes-panel.ts');
  assert.ok(panel.includes('export function openWithCommand'), 'changes-panel 须导出 openWithCommand 纯函数（降级决策）');
  assert.ok(panel.includes('shell32.dll,OpenAs_RunDLL'), 'openWithCommand 须用 rundll32 OpenAs_RunDLL 弹打开方式');
  assert.ok(/openWithCommand\(abs\)/.test(panel), 'openChangeFile 须在 shell.openPath 失败时调 openWithCommand 降级');
  assert.ok(panel.includes('spawnOpenWithDialog'), 'openChangeFile 降级须经 spawnOpenWithDialog detached 启动');
  assert.ok(panel.includes("import { execFile, spawn } from 'child_process'"), 'changes-panel 须 import spawn 供降级启动');
  assert.ok(!/无默认.*系统弹.*打开方式/.test(panel), 'changes-panel 注释不得再含"无默认则系统弹打开方式"空头承诺');
  const diffDialogSrc = read('../src/renderer/components/changes/DiffDialog.vue');
  assert.ok(!/无默认.*系统弹.*打开方式/.test(diffDialogSrc), 'DiffDialog 注释不得再含"无默认则系统弹打开方式"空头承诺');
  assert.ok(/disabled.*currentFile\.status\s*===\s*'D'/.test(diffDialogSrc), 'DiffDialog 打开按钮须对 status=D 禁用');
  assert.ok(/},\s*4\d{3}\)/.test(diffDialogSrc), 'DiffDialog toast 时长须 ≥ 4000ms（失败反馈不得一闪而过）');
  assert.ok(panel.includes('export function isPathInsideRoot'), 'changes-panel 须导出 isPathInsideRoot（normalize 统一分隔符防正斜杠 root 误判）');
  assert.ok(/isPathInsideRoot\(abs,\s*root\)/.test(panel), 'openChangeFile 越界守卫须经 isPathInsideRoot');

  // === 全文选项（fullText）：上下文选择器的第五个选项（3/5/10/20/全文），开启后以极大上下文拉取整文件 diff，
  // 并排/内联各自照常渲染但全部行可见（inline 跳过 inlineVisiblePlan 不折叠）===
  assert.ok(diffDialogSrc.includes('fullText'), 'DiffDialog 须有 fullText 布尔开关');
  assert.ok(diffDialogSrc.includes('effectiveContext'), 'DiffDialog 须有 effectiveContext 计算属性（fullText 开启时用极大上下文拉取整文件）');
  assert.ok(diffDialogSrc.includes('FULL_CONTEXT'), 'DiffDialog 须定义 FULL_CONTEXT 常量');
  assert.ok(/fullText.*\?.*FULL_CONTEXT.*context\.value/.test(diffDialogSrc), 'effectiveContext 须在 fullText 开启时返回 FULL_CONTEXT');
  assert.ok(diffDialogSrc.includes('setContext'), 'DiffDialog 须有 setContext 函数（选数字时关闭全文）');
  assert.ok(diffDialogSrc.includes('全文'), 'DiffDialog 上下文选择器须有「全文」选项');
  assert.ok(/full-text/.test(diffDialogSrc), 'DiffDialog 须向 DiffBody 传 fullText prop');
  const diffBodySrc = read('../src/renderer/components/changes/DiffBody.vue');
  assert.ok(diffBodySrc.includes('fullText'), 'DiffBody 须有 fullText prop');
  assert.ok(/fullText.*\?.*rows\.map.*true/.test(diffBodySrc), 'DiffBody 须在 fullText 开启时跳过 inlineVisiblePlan（全部行可见，不折叠）');
}

// 工作空间历史删除契约：新 IPC 通道三处同步（IPC_CHANNELS 常量 / preload API / ipc handler）
// + store action + 工具栏删除按钮 + 最近目录 4 条封顶滚动容器。
function testWorkspaceHistoryRemoveContracts(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const ipc = read('../src/shared/types/ipc.ts');
  assert.ok(ipc.includes("WORKSPACE_REMOVE_RECENT: 'workspace:removeRecent'"), 'IPC_CHANNELS 须定义 WORKSPACE_REMOVE_RECENT');
  const preload = read('../src/preload/api.ts');
  assert.ok(preload.includes('removeRecentWorkspace: (dir: string) => Promise<string[]>'), 'preload ClaudeLinkAPI 须声明 removeRecentWorkspace');
  assert.ok(preload.includes('IPC_CHANNELS.WORKSPACE_REMOVE_RECENT'), 'preload 须 invoke WORKSPACE_REMOVE_RECENT');
  const handlers = read('../src/main/ipc-handlers.ts');
  assert.ok(handlers.includes('IPC_CHANNELS.WORKSPACE_REMOVE_RECENT'), 'ipc-handlers 须注册 WORKSPACE_REMOVE_RECENT handler');
  assert.ok(handlers.includes('removeRecentWorkspace(dir)'), 'ipc-handlers handler 须调用 removeRecentWorkspace');
  const history = read('../src/main/modules/workspace-history.ts');
  assert.ok(history.includes('export function removeRecentWorkspace'), 'workspace-history 须导出 removeRecentWorkspace');
  const store = read('../src/renderer/stores/session-store.ts');
  assert.ok(store.includes('async removeRecentWorkspace(dir: string)'), 'session-store 须有 removeRecentWorkspace action');
  assert.ok(store.includes('window.claudeLink.removeRecentWorkspace(dir)'), 'store 须经 window.claudeLink.removeRecentWorkspace 删除');
  const toolbar = read('../src/renderer/components/chat/SessionToolbar.vue');
  assert.ok(toolbar.includes('@click.stop="removeRecent(dir)"'), '目录行须有删除按钮（stop 防误选目录）');
  assert.ok(toolbar.includes('menu__recent-list'), '最近目录须包在滚动容器 menu__recent-list');
  assert.ok(/max-height:\s*7rem/.test(toolbar) && /overflow-y:\s*auto/.test(toolbar), '最近目录须 4 条封顶 + 溢出滚动');
}

async function main(): Promise<void> {
testDiffDialogSearchUiContracts();
testDiffDialogNoWrapContracts();
testDiffDialogSearchStateContracts();
testDiffBodySearchProjectionContracts();
testDiffBodySplitNodeLifecycleContracts();
testDiffBodySearchScrollContracts();
testOpenWithFallbackContracts();
testApiUrlBuilder();
testSettingsImportPreservesNestedJson();
testClaudeSettingsProjectionPreservesAdvancedSettings();
testSearchNormalizer();
testMarkdownExternalLinks();
testInteractionPreviewMarkdownLinkTargetWiring();
testExternalLinks();
testMissingConversationResumeErrorDetection();
testMigrationsHandlePartiallyAppliedContextColumns();
testAttachmentMigrationsCreateTablesAndAreIdempotent();
testPermissionPromptIntegration();
testPermissionInteractionAdapter();
testPermissionSettingsMergeAndSessionCoercion();
testAskUserQuestionInteractionAdapter();
testInteractionPromptV2V3Contracts();
testInteractionPromptWizardAndHistoryContracts();
testGenericDialogTextAndFormContracts();
testAskUserQuestionMultiSelectAndOther();
testElicitationUrlMode();
testElicitationCancelMapping();
testStatusSubtypeCoverage();
testAllowSessionPermissionsSurviveNextSdkQuery();
testToolSessionAllowedShortCircuit();
testThinkingDisplaySummarizedEnabled();
testMarkdownParserEmitsCoreBlocks();
testMarkdownBodyCssCoversCoreElements();
testToolCallBlockMarkdownParagraphUsesRem();
testMarkdownTaskListCheckboxes();
testMarkdownMathKatex();
testMarkdownMermaidEmitsContainer();
testMarkdownImageLightboxHook();
testMarkdownFenceStructure();
testInvalidDiffFallsBackToText();
testMarkdownRenderProfiles();
testMarkdownSecurityAndProtocolContracts();
testTaskListReadOnlyContract();
testMarkdownBlockMathDoesNotSwallowUnclosed();
testImageLightboxAccessibilityWiring();
testDiffContentDetectionContracts();
testToolDiffSynthesisContracts();
testToolDiffDialogContracts();
// 词级 LCS 引擎契约（diff-words.ts，纯函数行为）。
function testDiffWordLcsContracts(): void {
  const join = (segs: { x: string }[] | undefined): string => (segs ?? []).map((s) => s.x).join('');

  // 1. LCS 正确性：foo = 1; → foo = 2; 只 1/2 不同
  const r1 = diffWordRanges('foo = 1;', 'foo = 2;')!;
  assert.ok(r1, '常规改动应返回结果');
  assert.equal(join(r1.left), 'foo = 1;', 'left segs 须重组回旧行');
  assert.equal(join(r1.right), 'foo = 2;', 'right segs 须重组回新行');
  assert.ok(!r1.left.some((s) => s.s === 'ins'), 'left 不得含 ins');
  assert.ok(!r1.right.some((s) => s.s === 'del'), 'right 不得含 del');
  assert.ok(r1.left.some((s) => s.s === 'del'), 'left 须有 del(1)');
  assert.ok(r1.right.some((s) => s.s === 'ins'), 'right 须有 ins(2)');

  // 2. 相似度护栏：< 0.6 返回 null（宁可整行纯背景也别高亮错）
  assert.equal(diffWordRanges('abc', 'xyz'), null, '完全不同字符串相似度 0 → null');
  assert.equal(diffWordRanges('hello world', 'goodbye universe'), null, '低相似度 → null');

  // 3. 单行字符护栏：> 1000 → null
  const longA = 'a'.repeat(DIFF_WORD_MAX_LINE_LENGTH + 1);
  assert.equal(diffWordRanges(longA, longA + 'b'), null, '超长行护栏触发 → null');

  // 4. 段数护栏：> 240 → null
  const manySegs = Array.from({ length: DIFF_WORD_MAX_SEGMENTS + 1 }, (_, i) => `v${i}`).join(' ');
  assert.equal(diffWordRanges(manySegs, manySegs + ' extra'), null, '超段护栏触发 → null');

  // 5. 边界：空文本 / 纯空白差异（空白段恒 eq，不产 del/ins）
  const empty = diffWordsOrFlat('', '');
  assert.equal(join(empty.left), '', '空文本重组仍为空');
  assert.equal(join(empty.right), '', '空文本重组仍为空');
  const ws = diffWordRanges('a ', 'a')!;
  assert.ok(ws, '纯空白差异（相似度 1.0）应返回结果');
  assert.equal(join(ws.left), 'a ', '空白段须保留以重组原文');
  assert.equal(join(ws.right), 'a');
  assert.ok(!ws.left.some((s) => s.s === 'del'), '空白段恒 eq，不产 del');

  // 6. diffWordsOrFlat 降级：护栏命中 → 整行单 eq 段（segs 恒非空，避免空数组塌陷）
  const flat = diffWordsOrFlat('abc', 'xyz');
  assert.equal(flat.left.length, 1, '降级为单段');
  assert.equal(flat.left[0]!.s, 'eq', '降级段为 eq（无高亮）');
  assert.equal(join(flat.left), 'abc', '降级仍重组原文');

  // 7. 全等 → null（无差异不高亮）
  assert.equal(diffWordRanges('same', 'same'), null, '全等无差异 → null');
}

// 并排成对行数组契约（buildSplitRows / planSplitVisible，纯函数行为）。
function testSplitRowsContracts(): void {
  const UNI =
    '--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1,6 +1,7 @@\n line1\n-foo = 1;\n+foo = 2;\n ctx2\n-old1\n-old2\n+new1\n+new2\n+new3\n ctx3\n';
  const parsed = parseUnifiedDiff(UNI)!;
  const rows = buildSplitRows(parsed);

  // 1. 占位契约：left===null 当且仅当 add 行；right===null 当且仅当 del 行（成对行槽位一一对应）
  assert.ok(rows.every((r) => (r.left === null) === (r.kind === 'add')), 'left===null 当且仅当 add 行');
  assert.ok(rows.every((r) => (r.right === null) === (r.kind === 'del')), 'right===null 当且仅当 del 行');

  // 2. kind 四态齐备
  const kinds = new Set(rows.map((r) => r.kind));
  assert.ok(kinds.has('mod') && kinds.has('add') && kinds.has('del') && kinds.has('same'), '四态齐备');

  // 3. mod 行两侧带 segs（LCS 结果）
  const modRow = rows.find((r) => r.kind === 'mod')!;
  assert.ok(modRow.left?.segs && modRow.right?.segs, 'mod 行两侧须带 segs');

  // 4. add/del 占位方向
  const addRow = rows.find((r) => r.kind === 'add')!;
  assert.equal(addRow.left, null, 'add 行左侧须为 null 占位');
  assert.ok(addRow.right, 'add 行右侧须有内容');
  const delRow = rows.find((r) => r.kind === 'del')!;
  assert.equal(delRow.right, null, 'del 行右侧须为 null 占位');
  assert.ok(delRow.left, 'del 行左侧须有内容');

  // 5. onlyChanges 折叠：夹在两段改动间的连续 same 段收成 fold 分隔条
  const visible = planSplitVisible(rows, true, new Set<number>());
  const folds = visible.filter((v) => v.kind === 'fold');
  assert.ok(folds.length >= 1, 'onlyChanges 须把夹在改动间的 same 段折叠');
  // 首尾贴边的 same 段不折叠
  assert.ok(visible[0]?.kind === 'row', '首行不应是 fold（首个 same 段贴边不折叠）');

  // 6. M:N 不等长 → 退化成 del + add（无 mod，牺牲词级；classifyRun 最后分支，文档化行为须有契约）
  const mn = parseUnifiedDiff('--- a/x\n+++ b/x\n@@ -1,4 +1,5 @@\n ctx\n-old1\n-old2\n+new1\n+new2\n+new3\n ctx2\n')!;
  const mnRows = buildSplitRows(mn);
  assert.ok(!mnRows.some((r) => r.kind === 'mod'), 'M:N 不等长不得产 mod（退化为 del+add）');
  assert.ok(
    mnRows.some((r) => r.kind === 'del') && mnRows.some((r) => r.kind === 'add'),
    'M:N 退化须同时有 del 和 add',
  );
}

// 词级引擎与 jsdiff 解除耦合的源码文本契约。
function testDiffWordsDecouplesJsdiff(): void {
  const fs = require('node:fs') as typeof import('node:fs');
  const read = (rel: string): string => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
  const parser = read('../src/renderer/utils/diff-parser.ts');
  assert.ok(!/diffWordsWithSpace/.test(parser), 'parser 不得再 import jsdiff 的 diffWordsWithSpace（词级已迁出）');
  assert.ok(/import \{ parsePatch \} from 'diff'/.test(parser), 'parser 仍须 import parsePatch（行级解析保留）');
  assert.ok(/from ['"]\.\/diff-words['"]/.test(parser), 'parser 须经 ./diff-words 引入词级引擎');

  const engine = read('../src/renderer/utils/diff-words.ts');
  assert.ok(/Uint16Array/.test(engine), 'LCS 须用 Uint16Array DP');
  assert.ok(
    /DIFF_WORD_MAX_LINE_LENGTH|DIFF_WORD_MAX_SEGMENTS|DIFF_WORD_MIN_SIMILARITY/.test(engine),
    '三道护栏常量须导出',
  );
}

testChangesPanelContracts();
testChangesPanelPlumbing();
testDiffWordLcsContracts();
testSplitRowsContracts();
testDiffWordsDecouplesJsdiff();
testReducedMotionStopsInfiniteAnimations();
testMermaidLifecycleGuards();
testMarkdownImageInLinkNotButtonized();
testMarkdownImageProtocolFilter();
testInteractionPreviewDiffFallback();
testMarkdownIndentedCodeUsesContainer();
testMermaidRendersBlocksSerially();
testMermaidErrorRetryAndAccessibleTitleContracts();
testMermaidDeadPreRuleRemoved();
testImageLightboxZIndexTokenized();
testChatBlockKeyboardAccessibility();
testAttachmentPolicyContracts();
testChatSendPayloadShapeContracts();
await testAttachmentPromptBuilderContracts();
testAttachmentDraftUiContracts();
testAttachmentHistoryContracts();
testAttachmentBadgeContracts();
testAttachmentTask7AContracts();
testAttachmentTask7BContracts();
testProcessKindSubAgentTitleNarrowing();
testExportAttachmentSmokeContracts();
testAttachmentTask8Contracts();
testWorkspaceHistoryRemoveContracts();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
