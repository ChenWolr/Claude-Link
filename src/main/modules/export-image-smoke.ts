// 阶段二 fixture smoke（仅 env CLAUDE_LINK_EXPORT_SMOKE=<消息条数> 时运行，不进正常启动路径）。
// 种子一个会话 + N 条消息，调用真实 startImageExport（smoke:true），等 done，校验临时 JPEG，
// 写结果 JSON 到 D:\software\Cache，清理后退出。验证主进程管理器 + 隐藏窗口 + IPC + 捕获/拼接/编码全链路。

import { app } from 'electron';
import { promises as fs } from 'fs';
import { join } from 'path';
import type { WebContents } from 'electron';
import { cleanupActiveJob, startImageExport } from './export-image-manager';
import * as sessionRepo from '../database/repositories/session-repo';
import * as messageRepo from '../database/repositories/message-repo';
import { logger } from '../utils/logger';

const RESULT_DIR = 'D:\\software\\Cache\\claude-link-spike';
const RESULT_PATH = join(RESULT_DIR, 'phase2-smoke-result.json');

export async function runExportSmokeIfRequested(origin: WebContents | undefined): Promise<void> {
  const raw = process.env.CLAUDE_LINK_EXPORT_SMOKE;
  const count = raw ? Math.max(2, Math.min(120, parseInt(raw, 10) || 30)) : 0;
  logger.info(`[smoke] runExportSmokeIfRequested count=${count} hasOrigin=${!!origin}`);
  if (!count || !origin) return;

  // 阶段四：设置 smoke 保存目录，绕过系统对话框，验证排他移动 + 结果联合。
  const smokeDest = join(RESULT_DIR, `phase4-save-${Date.now()}`);
  process.env.CLAUDE_LINK_EXPORT_SMOKE_DEST = smokeDest;
  await fs.mkdir(smokeDest, { recursive: true });

  const result: Record<string, unknown> = { count, started: true, ts: new Date().toISOString(), smokeDest };
  try {
    // 种子会话 + N 条消息（user/assistant 交替，制造多轮）。
    const session = sessionRepo.createSession('导出smoke会话', 'sonnet');
    for (let i = 0; i < count; i++) {
      const role = i % 2 === 0 ? 'user' : 'assistant';
      const content = role === 'user' ? `用户提问 ${i}：请详细介绍。` : `助手回答 ${i}：` + '这是一段较长的回答内容，用于撑高页面触发分段与多页。'.repeat(8);
      messageRepo.createMessage({ sessionId: session.id, role, content, eventType: 'message' });
    }
    result.sessionId = session.id;

    const start = await startImageExport(origin, session.id, { smoke: true });
    if (!start.ok) {
      result.ok = false;
      result.startResult = start;
      await writeResult(result);
      app.quit();
      return;
    }
    result.jobId = start.jobId;

    const done = await start.done;
    result.exportStatus = done.status;
    // 校验终态：saved 时 smokeDest 下应有合法 JPEG 文件。
    if (done.status === 'saved') {
      const files = await fs.readdir(smokeDest);
      let allValid = true;
      const details: Record<string, unknown>[] = [];
      for (const f of files) {
        const buf = await fs.readFile(join(smokeDest, f));
        const valid = buf.length > 0 && buf[0] === 0xff && buf[1] === 0xd8 && buf[buf.length - 2] === 0xff && buf[buf.length - 1] === 0xd9;
        if (!valid) allValid = false;
        details.push({ name: f, bytes: buf.length, validJpeg: valid });
      }
      result.savedFiles = details;
      result.allValidJpeg = allValid;
      result.ok = allValid && files.length > 0 && files.length === done.paths.length;
      result.savedPaths = done.paths;
    } else {
      result.ok = false;
      result.result = done;
    }
    await cleanupActiveJob();
    result.cleanedTempDir = true;
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

async function writeResult(result: Record<string, unknown>): Promise<void> {
  try {
    await fs.mkdir(RESULT_DIR, { recursive: true });
    await fs.writeFile(RESULT_PATH, JSON.stringify(result, null, 2));
    logger.info(`[export-smoke] 结果写入 ${RESULT_PATH}`);
  } catch (e) {
    logger.error('[export-smoke] 写结果失败', e);
  }
}
