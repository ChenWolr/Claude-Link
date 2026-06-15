// ipc-handlers.ts
// IPC handler 注册中心：渲染进程 ↔ 主进程的桥梁。
//
// 注册 config / cli / session / message / chat / task / queue 全部 IPC handler。
// 渲染进程经 preload 的 window.claudeLink.xxx() → ipcRenderer.invoke → 此处 ipcMain.handle 路由到对应模块。

import { BrowserWindow, dialog, ipcMain } from 'electron';
import type { AppConfig } from '../shared/types/config';
import type { Session } from '../shared/types/session';
import { IPC_CHANNELS } from '../shared/constants';
import { clearConfig, getConfig, importSettingsFile, saveConfig } from './modules/config-manager';
import { detectClaudeConfig } from './modules/claude-config-detector';
import { testConnection } from './modules/connection-tester';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';
import { spawnForChat, sendMessage, killProcess, getActiveProcess } from './modules/process-manager';
import {
  startQueue,
  pauseQueue,
  resumeQueue,
  interruptTask,
  getQueueState,
  continueWithUserMessage,
} from './modules/task-queue-engine';
import { analyzeTopic } from './modules/topic-analyzer';
import { logger } from './utils/logger';
import * as sessionRepo from './database/repositories/session-repo';
import * as messageRepo from './database/repositories/message-repo';
import * as taskRepo from './database/repositories/task-repo';

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
  ipcMain.handle(IPC_CHANNELS.CONFIG_IMPORT_SETTINGS, async (_event, filePath: string) => {
    return importSettingsFile(filePath);
  });
  ipcMain.handle(IPC_CHANNELS.CONFIG_PICK_SETTINGS_FILE, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
      title: '选择 Claude Code settings.json',
    });
    if (result.canceled || !result.filePaths.length) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(IPC_CHANNELS.CONFIG_AUTO_DETECT, async () => detectClaudeConfig());
  ipcMain.handle(IPC_CHANNELS.CONFIG_TEST_CONNECTION, async () => testConnection());
  ipcMain.handle(
    IPC_CHANNELS.MODELS_FETCH,
    async (_event, provider: AppConfig['provider'], apiKey: string, apiBaseUrl?: string) =>
      fetchAvailableModels(provider, apiKey, apiBaseUrl),
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
  ipcMain.handle(IPC_CHANNELS.SESSION_SEARCH, async (_event, query: string) =>
    sessionRepo.searchSessions(query),
  );
  ipcMain.handle(
    IPC_CHANNELS.SESSION_UPDATE_MODEL_OVERRIDE,
    async (_event, id: string, modelOverride: string | null) =>
      sessionRepo.updateModelOverride(id, modelOverride),
  );
  ipcMain.handle(
    IPC_CHANNELS.SESSION_ANALYZE_TOPIC,
    async (_event, sessionId: string, firstMessage: string) => {
      const result = await analyzeTopic(sessionId, firstMessage);
      return result;
    },
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

      const existingProcess = getActiveProcess(sessionId);
      if (existingProcess) {
        sendMessage(sessionId, message);
        messageRepo.createMessage(sessionId, 'user', message, 'message');
      } else {
        spawnForChat(sessionId, mainWindow, {
          model: session.model,
          modelOverride: session.modelOverride,
          workingDir: session.workingDir,
          maxTurns: session.maxTurns,
          permissionMode: session.permissionMode,
          resumeSessionId: session.cliSessionId,
        });
        // CLI 以 stream-json 输入模式启动，进程不会自动读取本次提示；
        // 必须把首条消息写入 stdin，否则 Claude 收不到、界面表现为卡住。
        sendMessage(sessionId, message);
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

  // Tasks
  ipcMain.handle(IPC_CHANNELS.TASK_ADD, async (_event, sessionId: string, prompt: string) => {
    const tasks = taskRepo.getTasksBySession(sessionId);
    const sortOrder = tasks.length;
    return taskRepo.createTask(sessionId, prompt, sortOrder);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_REMOVE, async (_event, taskId: string) => {
    taskRepo.deleteTask(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_GET_ALL, async (_event, sessionId: string) => {
    return taskRepo.getTasksBySession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_REORDER, async (_event, sessionId: string, taskIds: string[]) => {
    taskRepo.reorderTasks(sessionId, taskIds);
    return taskRepo.getTasksBySession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_INTERRUPT, async (_event, taskId: string) => {
    const task = taskRepo.getTask(taskId);
    if (task) {
      interruptTask(taskId, task.sessionId, mainWindow);
    }
  });

  // Queue
  ipcMain.handle(IPC_CHANNELS.QUEUE_START, async (_event, sessionId: string) => {
    startQueue(sessionId, mainWindow);
    return getQueueState(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_PAUSE, async (_event, sessionId: string) => {
    pauseQueue(sessionId, mainWindow);
    return getQueueState(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_RESUME, async (_event, sessionId: string) => {
    resumeQueue(sessionId, mainWindow);
    return getQueueState(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_STATE, async (_event, sessionId: string) => {
    return getQueueState(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_USER_MESSAGE, async (_event, sessionId: string, message: string) => {
    continueWithUserMessage(sessionId, message, mainWindow);
    return getQueueState(sessionId);
  });
}
