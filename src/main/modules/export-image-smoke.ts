// 阶段二 fixture smoke（仅 env CLAUDE_LINK_EXPORT_SMOKE=<消息条数> 时运行，不进正常启动路径）。
// 种子一个会话 + N 条消息，依次跑 JPEG 与 PNG 两个真实 job（smoke:true），等 done，校验临时产物，
// 写结果 JSON 到 D:\software\Cache，清理后退出。验证主进程管理器 + 隐藏窗口 + IPC + 捕获/拼接/编码全链路（含 v4.1 PNG worker 路径）。
// v4.1：PNG 路径校验 PNG magic / .png 扩展名 / pngjs 可解码 / 尺寸非零；JPEG 沿用 v3 校验。

import { app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import type { WebContents } from 'electron';
import { PNG } from 'pngjs';
import { cleanupActiveJob, startImageExport } from './export-image-manager';
import type { ExportImageFormat, ExportJobSnapshot } from '../../shared/types/export-image';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import * as attachmentRepo from '../database/repositories/attachment-repo';
import { stageAttachment } from './attachment-service';
import { removeAttachmentFile } from './attachment-storage';
import { logger } from '../utils/logger';

const RESULT_DIR = 'D:\\software\\Cache\\claude-link-spike';
const RESULT_PATH = join(RESULT_DIR, 'phase2-smoke-result.json');

export async function runExportSmokeIfRequested(origin: WebContents | undefined): Promise<void> {
  const raw = process.env.CLAUDE_LINK_EXPORT_SMOKE;
  const count = raw ? Math.max(2, Math.min(120, parseInt(raw, 10) || 30)) : 0;
  logger.info(`[smoke] runExportSmokeIfRequested count=${count} hasOrigin=${!!origin}`);
  if (!count || !origin) return;

  const result: Record<string, unknown> = { count, started: true, ts: new Date().toISOString() };
  try {
    // 种子会话 + N 条消息（user/assistant 交替，制造多轮）。
    const session = sessionRepo.createSession('导出smoke会话', 'sonnet');
    const png = new PNG({ width: 640, height: 320 });
    for (let y = 0; y < png.height; y++) {
      for (let x = 0; x < png.width; x++) {
        const offset = (y * png.width + x) * 4;
        png.data[offset] = x < png.width / 2 ? 0xe5 : 0x2f;
        png.data[offset + 1] = y < png.height / 2 ? 0x4b : 0xb3;
        png.data[offset + 2] = x < png.width / 2 ? 0x64 : 0xd4;
        png.data[offset + 3] = 0xff;
      }
    }
    const pngBytes = PNG.sync.write(png);
    const image = await stageAttachment({
      id: randomUUID(),
      sessionId: session.id,
      filename: 'smoke-image.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(pngBytes),
    });
    const document = await stageAttachment({
      id: randomUUID(),
      sessionId: session.id,
      filename: 'smoke-note.txt',
      mimeType: 'text/plain',
      bytes: new TextEncoder().encode('Task 9 export attachment smoke fixture'),
    });
    const imageMessage = messageRepo.createMessageWithAttachments({
      sessionId: session.id,
      role: 'user',
      content: '文字与图片附件 smoke',
      eventType: 'message',
      attachments: [image.id],
    });
    messageRepo.createMessageWithAttachments({
      sessionId: session.id,
      role: 'user',
      content: '',
      eventType: 'message',
      attachments: [document.id],
    });
    // 独立图片 fixture 再复制为消息附件；缺失 preview 由删除物理文件后的预览失败路径覆盖。
    const missingImage = await stageAttachment({
      id: randomUUID(),
      sessionId: session.id,
      filename: 'missing-preview.png',
      mimeType: 'image/png',
      bytes: new Uint8Array(pngBytes),
    });
    messageRepo.createMessageWithAttachments({
      sessionId: session.id,
      role: 'user',
      content: '缺失预览附件 smoke',
      eventType: 'message',
      attachments: [missingImage.id],
    });
    const missingRecord = attachmentRepo.getAttachment(missingImage.id);
    if (!missingRecord) throw new Error('missing preview fixture record not found');
    await removeAttachmentFile(missingRecord.storageKey);
    result.fixture = {
      imageMessageId: imageMessage.id,
      attachmentOnly: true,
      imageFilename: image.filename,
      documentFilename: document.filename,
      missingPreviewFilename: missingImage.filename,
    };
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const content = role === 'user' ? `用户提问 ${i}：请详细介绍。` : `助手回答 ${i}：` + '这是一段较长的回答内容，用于撑高页面触发分段与多页。'.repeat(8);
      messageRepo.createMessage({ sessionId: session.id, role, content, eventType: 'message' });
    }
    result.sessionId = session.id;

    // 依次跑 JPEG 与 PNG（单飞，前一个 cleanup 后再跑下一个）。
    result.jpeg = await runOneFormat(origin, session.id, 'jpeg');
    result.png = await runOneFormat(origin, session.id, 'png');
    result.ok = !!(result.jpeg as { ok?: boolean }).ok && !!(result.png as { ok?: boolean }).ok;
  } catch (e) {
    result.ok = false;
    result.error = String((e as Error)?.stack || e);
    logger.error('[export-smoke] error', e);
    try { await cleanupActiveJob(); } catch { /* ignore */ }
  } finally {
    await writeResult(result);
    app.quit();
  }
}

function validateExportSnapshot(snapshot: ExportJobSnapshot | undefined): Record<string, unknown> {
  if (!snapshot) throw new Error('smoke export snapshot unavailable');
  const attachments = snapshot.messages.flatMap((message) => message.attachments ?? []);
  const serializedAttachments = JSON.stringify(attachments);
  if (/storageKey|sha256|attachmentId|sessionId|data:image\//.test(serializedAttachments)) {
    throw new Error('export attachment snapshot contains internal fields or Base64 data URL');
  }

  const image = attachments.find((attachment) => attachment.filename === 'smoke-image.png');
  if (!image?.preview) throw new Error('smoke image preview missing from export snapshot');
  if (image.preview.mimeType !== 'image/png' || image.preview.width !== 512 || image.preview.height !== 256) {
    throw new Error(`smoke image preview was not resized to bounded PNG: ${image.preview.mimeType} ${image.preview.width}x${image.preview.height}`);
  }
  const document = attachments.find((attachment) => attachment.filename === 'smoke-note.txt');
  if (!document || document.preview) throw new Error('document metadata card is missing or contains preview bytes');
  const missing = attachments.find((attachment) => attachment.filename === 'missing-preview.png');
  if (!missing?.previewUnavailable || missing.preview) throw new Error('missing preview placeholder is not represented safely');

  return {
    minimalMetadata: true,
    previewUnavailable: true,
    noBase64OrPath: true,
    previewMaxLongEdge: Math.max(image.preview.width, image.preview.height),
    attachmentNames: attachments.map((attachment) => attachment.filename),
  };
}

async function runOneFormat(origin: WebContents, sessionId: string, format: ExportImageFormat): Promise<Record<string, unknown>> {
  const smokeDest = join(RESULT_DIR, `${format}-save-${Date.now()}`);
  process.env.CLAUDE_LINK_EXPORT_SMOKE_DEST = smokeDest;
  await fs.mkdir(smokeDest, { recursive: true });

  const out: Record<string, unknown> = { format, smokeDest };
  try {
    const start = await startImageExport(origin, sessionId, format, { smoke: true });
    if (!start.ok) { out.ok = false; out.startResult = start; await cleanupActiveJob(); return out; }
    out.jobId = start.jobId;
    out.snapshot = validateExportSnapshot(start.snapshot);
    const done = await start.done;
    out.exportStatus = done.status;
    if (done.status === 'saved') {
      const files = await fs.readdir(smokeDest);
      const details: Record<string, unknown>[] = [];
      let allValid = true;
      for (const f of files) {
        const buf = await fs.readFile(join(smokeDest, f));
        const v = format === 'png' ? validatePng(buf) : validateJpeg(buf);
        if (!v.valid) allValid = false;
        details.push({ name: f, bytes: buf.length, ...v });
      }
      out.savedFiles = details;
      out.allValid = allValid;
      out.ok = allValid && files.length > 0 && files.length === done.paths.length;
      out.savedPaths = done.paths;
    } else {
      out.ok = false;
      out.result = done;
    }
    await cleanupActiveJob();
    out.cleanedTempDir = true;
  } catch (e) {
    out.ok = false;
    out.error = String((e as Error)?.stack || e);
    try { await cleanupActiveJob(); } catch { /* ignore */ }
  }
  return out;
}

function validateJpeg(buf: Buffer): { valid: boolean; kind: 'jpeg' } {
  const valid = buf.length > 0 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
  return { valid, kind: 'jpeg' };
}

function validatePng(buf: Buffer): { valid: boolean; kind: 'png'; width?: number; height?: number; decodeError?: string } {
  const magicOk = buf.length > 0 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
  if (!magicOk) return { valid: false, kind: 'png', decodeError: 'PNG magic 错误' };
  try {
    const dec = PNG.sync.read(buf);
    return { valid: dec.width > 0 && dec.height > 0, kind: 'png', width: dec.width, height: dec.height };
  } catch (e) {
    return { valid: false, kind: 'png', decodeError: String((e as Error)?.message || e) };
  }
}

async function writeResult(result: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(RESULT_DIR, { recursive: true });
    await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2));
    logger.info(`[export-smoke] 结果写入 ${RESULT_PATH}`);
  } catch (e) {
    logger.error('[export-smoke] 写结果失败', e);
  }
}
