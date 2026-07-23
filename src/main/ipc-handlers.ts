// ipc-handlers.ts
// IPC handler 注册中心：渲染进程 ↔ 主进程的桥梁。
//
// 注册 config / cli / session / message / chat / task / queue 全部 IPC handler。
// 渲染进程经 preload 的 window.claudeLink.xxx() → ipcRenderer.invoke → 此处 ipcMain.handle 路由到对应模块。

import { BrowserWindow, dialog, ipcMain, app } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
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
import { spawnForChat, sendMessage, killProcess, getActiveProcess, markSessionDeleted, respondToPermissionRequest } from './modules/chat-backend';
import { getPendingInteractionPrompts, respondToInteractionPrompt } from './modules/interaction-prompts';
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
import * as attachmentRepo from './database/repositories/attachment-repo';
import { cleanupSessionAttachments } from './modules/attachment-service';
import { createInteractionHistory, getInteractionHistory } from './database/repositories/interaction-history-repo';
import { listChanges, getChangeDiff } from './modules/changes-panel';
import { registerExportImageHandlers } from './modules/export-image-manager';
import { detectDirectImageFormat, validateChatSendPayloadShape } from './modules/attachment-policy';
import {
  stageAttachment,
  getAttachmentPreview,
  removeDraftAttachment,
  assertAttachmentsReadyForSend,
} from './modules/attachment-service';
import type { ChatSendPayload, SendMessageResult, AttachmentSummary } from '../shared/types/attachment';
import type { StageAttachmentBytesInput, AttachmentPreviewRequest } from '../shared/types/ipc';

let mainWindow: BrowserWindow;

export function registerIpcHandlers(mainWindowRef: BrowserWindow): void {
  mainWindow = mainWindowRef;

  // CLI
  ipcMain.handle(IPC_CHANNELS.CLI_DETECT, async () => detectCli(true));
  ipcMain.handle(IPC_CHANNELS.CLI_GET_STATUS, async () => getCachedCliStatus() ?? detectCli());

  // 会话改动面板：列出 workingDir 的 git 改动 + 按需取单文件 diff（不抓快照，按需 git diff）。
  ipcMain.handle(IPC_CHANNELS.CHANGES_LIST, async (_event, workingDir: string | null, touchedPaths: string[]) =>
    listChanges(workingDir, touchedPaths));
  ipcMain.handle(IPC_CHANNELS.CHANGES_DIFF, async (_event, workingDir: string | null, path: string) =>
    getChangeDiff(workingDir, path));

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
    // 附件：先收集 storageKey（删库后级联清 attachments 行，物理文件需另行清理）。
    const attachmentStorageKeys = attachmentRepo.listStorageKeysBySession(id);
    markSessionDeleted(id);
    killProcess(id);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = sessionRepo.deleteSession(id);
    // DB 级联删除完成后清理物理文件；失败只记警告，由下次 orphan cleanup 重试。
    await cleanupSessionAttachments(id, attachmentStorageKeys).catch((e) =>
      logger.error(`cleanupSessionAttachments for ${id} failed`, e),
    );
    return result;
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
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, sessionId: string, payload: ChatSendPayload) => {
    try {
      // Task 3：发送载荷统一为 ChatSendPayload（text + attachmentIds + clientMessageId）。
      // 附件输入构造（图片内容块 / Read 路径）在 Task 4 接入；此处先按纯文本走既有链路。
      // attachmentIds 在 Task 3 阶段恒为空，仍做归属 + draft 校验，供 Task 4/7 复用。
      const shape = validateChatSendPayloadShape(payload);
      if (!shape.ok) throw new Error(shape.message);

      const session = sessionRepo.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }
      assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
      const message = payload.text.trim();

      const existingProcess = getActiveProcess(sessionId);
      let createdMessageId = '';
      if (existingProcess) {
        sendMessage(sessionId, message);
        const created = messageRepo.createMessage({ sessionId, role: 'user', content: message, eventType: 'message' });
        createdMessageId = created.id;
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
        const created = messageRepo.createMessage({ sessionId, role: 'user', content: message, eventType: 'message' });
        createdMessageId = created.id;
      }
      // attachments 在 Task 3 阶段恒空；Task 6 由 clientMessageId 统一乐观消息与数据库消息。
      const result: SendMessageResult = { messageId: createdMessageId, attachments: [] };
      return result;
    } catch (error) {
      logger.error('Failed to send message', error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async (_event, sessionId: string) => {
    killProcess(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSION_RESPOND, async (_event, response) => {
    respondToPermissionRequest(response);
  });

  ipcMain.handle(IPC_CHANNELS.INTERACTION_RESPOND, async (_event, response) => {
    respondToInteractionPrompt(response);
  });

  ipcMain.handle(IPC_CHANNELS.INTERACTION_GET_PENDING, async () => getPendingInteractionPrompts());

  // V3-3：交互历史持久化。输入做最小校验，防止渲染进程传畸形数据撞 NOT NULL 约束。
  ipcMain.handle(IPC_CHANNELS.INTERACTION_HISTORY_GET, async (_event, sessionId: string) => {
    if (typeof sessionId !== 'string' || !sessionId) return [];
    return getInteractionHistory(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.INTERACTION_HISTORY_RECORD, async (_event, input) => {
    if (!input || typeof input !== 'object') return;
    const { sessionId, title, kind, action } = input as Record<string, unknown>;
    if (typeof sessionId !== 'string' || !sessionId) return;
    if (typeof title !== 'string' || !title) return;
    if (typeof kind !== 'string' || !kind) return;
    if (action !== 'submit' && action !== 'cancel') return;
    createInteractionHistory({
      sessionId,
      title,
      kind,
      summary: typeof (input as { summary?: unknown }).summary === 'string' ? (input as { summary: string }).summary : null,
      action,
    });
  });

  // Tasks
  ipcMain.handle(IPC_CHANNELS.TASK_ADD, async (_event, sessionId: string, payload: ChatSendPayload) => {
    // Task 3：任务载荷统一为 ChatSendPayload；附件关联（task_attachments）在 Task 7 接入，
    // 此处先按纯文本 prompt 建任务。attachmentIds 恒空，仍做归属 + draft 校验。
    const shape = validateChatSendPayloadShape(payload);
    if (!shape.ok) throw new Error(shape.message);
    assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
    const tasks = taskRepo.getTasksBySession(sessionId);
    const sortOrder = tasks.length;
    return taskRepo.createTask(sessionId, payload.text.trim(), sortOrder);
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

  ipcMain.handle(IPC_CHANNELS.QUEUE_USER_MESSAGE, async (_event, sessionId: string, payload: ChatSendPayload) => {
    // Task 3：续接载荷统一为 ChatSendPayload；附件 prompt 构造在 Task 7 接入，
    // 此处先按纯文本续接。attachmentIds 恒空，仍做归属 + draft 校验。
    const shape = validateChatSendPayloadShape(payload);
    if (!shape.ok) throw new Error(shape.message);
    assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
    continueWithUserMessage(sessionId, payload.text.trim(), mainWindow);
    return getQueueState(sessionId);
  });

  // 附件 IPC：选择 / 暂存字节（粘贴·拖放）/ 受控预览 / 移除草稿。
  // 文件读取与校验全部在主进程；renderer 只拿不透明附件 ID 与受控预览 bytes。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_PICK, async (_event, sessionId: string): Promise<AttachmentSummary[]> => {
    const session = sessionRepo.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '选择附件（图片 / 文档 / 文件）',
    });
    if (result.canceled || !result.filePaths.length) return [];

    const summaries: AttachmentSummary[] = [];
    const errors: string[] = [];
    for (const filePath of result.filePaths) {
      const filename = path.basename(filePath);
      try {
        const buf = await fsp.readFile(filePath);
        const bytes = new Uint8Array(buf);
        // 据魔数识别真实图片格式，避免靠扩展名把伪装图片当 image 直传。
        const detected = detectDirectImageFormat(bytes);
        const summary = await stageAttachment({
          id: randomUUID(),
          sessionId,
          filename,
          mimeType: detected ?? '',
          bytes,
        });
        summaries.push(summary);
      } catch (e) {
        errors.push(`${filename}：${e instanceof Error ? e.message : String(e)}`);
      }
    }
    // 全部失败才抛错；部分成功则返回成功项（失败项已在主进程日志可查，Task 5 UI 接入后集中提示）。
    if (!summaries.length && errors.length) {
      throw new Error(`附件添加失败：\n${errors.join('\n')}`);
    }
    return summaries;
  });

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_STAGE_BYTES,
    async (_event, input: StageAttachmentBytesInput): Promise<AttachmentSummary> => {
      if (
        !input ||
        typeof input.sessionId !== 'string' ||
        typeof input.filename !== 'string' ||
        !(input.bytes instanceof Uint8Array)
      ) {
        throw new Error('附件暂存参数无效');
      }
      const session = sessionRepo.getSession(input.sessionId);
      if (!session) throw new Error('会话不存在');
      // 主进程重新校验：不信任 renderer 传来的大小/MIME，由 policy 二次裁定。
      const detected = detectDirectImageFormat(input.bytes);
      return stageAttachment({
        id: randomUUID(),
        sessionId: input.sessionId,
        filename: input.filename,
        mimeType: detected ?? input.mimeType ?? '',
        bytes: input.bytes,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_PREVIEW,
    async (_event, request: AttachmentPreviewRequest) => getAttachmentPreview(request),
  );

  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_REMOVE_DRAFT, async (_event, sessionId: string, attachmentId: string) => {
    await removeDraftAttachment(sessionId, attachmentId);
  });

  // 会话导出 JPEG 长图（v3）：注册主窗口开始 + 隐藏 renderer 专用 IPC。
  registerExportImageHandlers();
}
