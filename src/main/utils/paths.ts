import { app } from 'electron';
import path from 'path';

export function getDbPath(): string {
  return path.join(app.getPath('userData'), 'claude-link.db');
}

export function getLogsDir(): string {
  return app.getPath('userData');
}

// 附件根目录：userData/attachments。按会话隔离子目录，物理文件不进工作区、不进 git。
export function getAttachmentsDir(): string {
  return path.join(app.getPath('userData'), 'attachments');
}

export function getSessionAttachmentsDir(sessionId: string): string {
  return path.join(getAttachmentsDir(), sessionId);
}
