import type { BrowserWindow } from 'electron';
import type { Readable } from 'stream';
import type { CliEvent } from '../../shared/types/cli';
import { IPC_CHANNELS } from '../../shared/constants';
import { logger } from '../utils/logger';

export interface StreamParser {
  destroy(): void;
}

export function createStreamParser(
  sessionId: string,
  stdout: Readable,
  mainWindow: BrowserWindow,
): StreamParser {
  let buffer = '';
  let destroyed = false;

  const flush = (line: string): void => {
    const trimmed = line.trim();
    if (!trimmed || destroyed) return;

    try {
      const event = JSON.parse(trimmed) as CliEvent;
      mainWindow.webContents.send(IPC_CHANNELS.CHAT_EVENT, { sessionId, event });
    } catch {
      logger.warn(`Stream parser: invalid JSON line (${trimmed.slice(0, 120)})`);
    }
  };

  stdout.on('data', (chunk: Buffer) => {
    if (destroyed) return;

    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      flush(line);
    }
  });

  stdout.on('end', () => {
    if (buffer && !destroyed) {
      flush(buffer);
      buffer = '';
    }
  });

  return {
    destroy(): void {
      destroyed = true;
      buffer = '';
    },
  };
}
