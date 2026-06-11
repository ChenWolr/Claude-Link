import { app } from 'electron';
import path from 'path';

export function getDbPath(): string {
  return path.join(app.getPath('userData'), 'claude-link.db');
}

export function getLogsDir(): string {
  return app.getPath('userData');
}
