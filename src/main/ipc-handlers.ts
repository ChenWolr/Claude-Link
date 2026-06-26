// ipc-handlers.ts
// IPC handler 注册中心：渲染进程 ↔ 主进程的桥梁。
//
// 注册 config / cli / session / message / chat / task / queue 全部 IPC handler。
// 渲染进程经 preload 的 window.claudeLink.xxx() → ipcRenderer.invoke → 此处 ipcMain.handle 路由到对应模块。

import { BrowserWindow, dialog, ipcMain, app } from 'electron';
import type { AppConfig } from '../shared/types/config';
import type { Session } from '../shared/types/session';
import { IPC_CHANNELS } from '../shared/constants';
import { clearConfig, getConfig, importSettingsFile, saveConfig } from './modules/config-manager';
import { detectClaudeConfig } from './modules/claude-config-detector';
import { runTestConnectionStream, abortTestConnection } from './modules/connection-tester';
import { listRecentWorkspaces, addRecentWorkspace } from './modules/workspace-history';
import { resolveDefaultModel } from '../shared/settings-parser';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';
import { spawnForChat, sendMessage, killProcess, getActiveProcess, markSessionDeleted } from './modules/chat-backend';
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
  ipcMain.handle(IPC_CHANNELS.CONFIG_STORAGE_INFO, async () => {
    const userData = app.getPath('userData');
    return {
      userData,
      config: `${userData}/claude-link-config.json`,
      workspaces: `${userData}/claude-link-workspaces.json`,
      db: `${userData}/claude-link.db`,
    };
  });
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
  ipcMain.handle(IPC_CHANNELS.CONFIG_TEST_CONNECTION, async (_event, model: string | null) => {
    runTestConnectionStream(model ?? null, mainWindow);
  });
  ipcMain.handle(IPC_CHANNELS.TEST_CONNECTION_ABORT, async () => abortTestConnection());

  // Workspace（工作空间）：选目录 + 最近历史。Claude Code 基于某目录运行，会话可绑定并复用历史目录。
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_PICK_DIR, async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      title: '选择 Claude Code 运行目录（工作空间）',
    });
    if (result.canceled || !result.filePaths.length) return null;
    const dir = result.filePaths[0];
    addRecentWorkspace(dir);
    return dir;
  });
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_RECENT, async () => listRecentWorkspaces());
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ADD_RECENT, async (_event, dir: string) => addRecentWorkspace(dir));
  ipcMain.handle(
    IPC_CHANNELS.MODELS_FETCH,
    async (_event, provider: AppConfig['provider'], apiKey: string, apiBaseUrl?: string) =>
      fetchAvailableModels(provider, apiKey, apiBaseUrl),
  );

  // Sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => sessionRepo.listSessions());
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, name: string) => {
    const config = getConfig();
    return sessionRepo.createSession(name, resolveDefaultModel(config.advancedJson));
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, id: string) => sessionRepo.getSession(id));
  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_event, id: string) => {
    // 删会话必须先让正在跑的 SDK query 停下来，否则它会变孤儿继续往已被级联删空的
    // messages 表 INSERT，外键失败回滚同步阻塞主进程，导致所有输入框假死。
    // 1) 先标记已删：runQuery 下轮迭代检测到立即自停（无需等 interrupt 生效）。
    // 2) 再 interrupt + 给 SDK 一点时间响应（interrupt 是异步 stdin 帧，非立即）。
    // 3) 最后删库。
    markSessionDeleted(id);
    killProcess(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    return sessionRepo.deleteSession(id);
  });
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
        messageRepo.createMessage({ sessionId, role: 'user', content: message, eventType: 'message' });
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
        messageRepo.createMessage({ sessionId, role: 'user', content: message, eventType: 'message' });
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
