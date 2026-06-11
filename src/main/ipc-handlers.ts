import { BrowserWindow, ipcMain } from 'electron';
import type { AppConfig } from '../shared/types/config';
import type { Session } from '../shared/types/session';
import { IPC_CHANNELS } from '../shared/constants';
import { clearConfig, getConfig, saveConfig } from './modules/config-manager';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';
import { spawnForChat, sendMessage, killProcess } from './modules/process-manager';
import { logger } from './utils/logger';
import * as sessionRepo from './database/repositories/session-repo';
import * as messageRepo from './database/repositories/message-repo';

let mainWindow: BrowserWindow;

export function registerIpcHandlers(mainWindowRef: BrowserWindow): void {
  mainWindow = mainWindowRef;

  // CLI
  ipcMain.handle(IPC_CHANNELS.CLI_DETECT, async () => detectCli(true));
  ipcMain.handle(IPC_CHANNELS.CLI_GET_STATUS, async () => getCachedCliStatus() ?? detectCli());

  // Config
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => getConfig());
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, partial: Partial<AppConfig>) => saveConfig(partial));
  ipcMain.handle(IPC_CHANNELS.CONFIG_CLEAR, async () => clearConfig());
  ipcMain.handle(IPC_CHANNELS.MODELS_FETCH, async (_event, provider: AppConfig['provider'], apiKey: string) =>
    fetchAvailableModels(provider, apiKey),
  );

  // Sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => sessionRepo.listSessions());
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, name: string) => {
    const config = getConfig();
    return sessionRepo.createSession(name, config.defaultModel);
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, id: string) => sessionRepo.getSession(id));
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, id: string) => sessionRepo.deleteSession(id));
  ipcMain.handle(
    IPC_CHANNELS.SESSION_UPDATE,
    async (_event, id: string, data: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns'>>) =>
      sessionRepo.updateSession(id, data),
  );

  // Messages
  ipcMain.handle(IPC_CHANNELS.MESSAGE_GET_BY_SESSION, async (_event, sessionId: string) =>
    messageRepo.getMessagesBySession(sessionId),
  );

  // Chat
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, sessionId: string, message: string) => {
    try {
      const session = sessionRepo.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      const existingProcess = getActiveProcessForSession(sessionId);
      if (existingProcess) {
        sendMessage(sessionId, message);
        messageRepo.createMessage(sessionId, 'user', message, 'message');
      } else {
        spawnForChat(sessionId, mainWindow, {
          model: session.model,
          workingDir: session.workingDir,
          maxTurns: session.maxTurns,
          permissionMode: session.permissionMode,
          resumeSessionId: session.cliSessionId,
        });
        messageRepo.createMessage(sessionId, 'user', message, 'message');
      }
    } catch (error) {
      logger.error('Failed to send message', error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async (_event, sessionId: string) => {
    killProcess(sessionId);
  });
}

function getActiveProcessForSession(_sessionId: string): null {
  return null;
}
