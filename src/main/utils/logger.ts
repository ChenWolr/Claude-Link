import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { getLogsDir } from './paths';

function writeLog(level: string, message: string): void {
  const line = `[${new Date().toISOString()}] [${level}] ${message}`;

  if (level === 'ERROR') {
    console.error(line);
  } else if (level === 'WARN') {
    console.warn(line);
  } else {
    console.log(line);
  }

  if (!app.isPackaged) {
    return;
  }

  try {
    fs.appendFileSync(path.join(getLogsDir(), 'claude-link.log'), `${line}\n`, 'utf8');
  } catch (error) {
    console.error('[LOGGER] Failed to write log file', error);
  }
}

export const logger = {
  info(message: string): void {
    writeLog('INFO', message);
  },
  // 低级别诊断日志：post-turn 探针失败/守卫拒绝等纯旁路路径用它，不刷屏、不打断回合收尾。
  debug(message: string): void {
    writeLog('DEBUG', message);
  },
  warn(message: string): void {
    writeLog('WARN', message);
  },
  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${message}: ${error.stack ?? error.message}` : message;
    writeLog('ERROR', detail);
  },
};
