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
import { prepareAttachmentPrompt } from './modules/attachment-prompt-builder';
import type { ChatSendPayload, SendMessageResult, AttachmentSummary } from '../shared/types/attachment';
import type { StageAttachmentBytesInput, AttachmentPreviewRequest, PickAttachmentsResult } from '../shared/types/ipc';

let mainWindow: BrowserWindow;

/** 会话级发送互斥：防止并发 CHAT_SEND 双落库/覆盖 pending。 */
const chatSendLocks = new Set<string>();

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
    // Task 4：校验 → prepare → 落库（附件保持 draft）→ spawn/send → 成功后升格 message。
    // spawn/send 同步失败则回滚消息关联，附件仍 draft，可原样重试（禁止再插第二条用户消息）。
    let locked = false;
    let createdMessageId: string | null = null;
    let attachmentIdsForRollback: string[] = [];
    try {
      const shape = validateChatSendPayloadShape(payload);
      if (!shape.ok) throw new Error(shape.message);

      const session = sessionRepo.getSession(sessionId);
      if (!session) {
        throw new Error(`Session ${sessionId} not found`);
      }

      // 会话级互斥 + 活 query 拒绝，均在落库前。
      if (chatSendLocks.has(sessionId) || getActiveProcess(sessionId)) {
        throw new Error('当前回合仍在执行，请等待结束或中断后重试');
      }
      chatSendLocks.add(sessionId);
      locked = true;

      const resolved = assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
      const prepared = await prepareAttachmentPrompt({
        sessionId,
        payload,
        attachments: resolved.records,
        attachmentPaths: resolved.paths,
      });
      attachmentIdsForRollback = prepared.attachmentIds;

      // 落库时不升格附件 status，等 query 入口真正占坑成功后再 mark message。
      const created = messageRepo.createMessageWithAttachments({
        id: payload.clientMessageId,
        sessionId,
        role: 'user',
        content: prepared.displayText,
        eventType: 'message',
        attachments: prepared.attachmentIds,
        promoteAttachments: false,
      });
      createdMessageId = created.id;

      // spawn 占坑；若已有 pending/active 会抛错 → 走回滚。
      spawnForChat(sessionId, mainWindow, {
        model: session.model,
        modelOverride: session.modelOverride,
        workingDir: session.workingDir,
        maxTurns: session.maxTurns,
        permissionMode: session.permissionMode,
        resumeSessionId: session.cliSessionId,
        additionalDirectories: prepared.additionalDirectories,
      });
      // sendMessage 同步路径只负责把 pending 交给 runQuery；真正 SDK 失败走事件流，不在此 IPC 回滚。
      sendMessage(sessionId, prepared.prompt);

      // query 入口已建立：附件升格为 message。
      if (prepared.attachmentIds.length > 0) {
        attachmentRepo.markAttachmentsStatus(prepared.attachmentIds, 'message');
      }

      // 返回最新摘要（status 已升格）。
      const attachments =
        prepared.attachmentIds.length > 0
          ? (attachmentRepo.getAttachmentsByMessageIds([created.id]).get(created.id) ?? created.attachments ?? [])
          : [];
      const result: SendMessageResult = {
        messageId: created.id,
        attachments,
      };
      return result;
    } catch (error) {
      // 同步失败回滚：删消息（级联 message_attachments），附件行保持 draft，允许同 ID 外的新 clientMessageId 重试。
      // 注意：不在此复用 clientMessageId 重插——renderer 重试应生成新 clientMessageId（Task 6 对齐乐观 ID）。
      if (createdMessageId) {
        try {
          messageRepo.deleteMessage(createdMessageId);
        } catch (rollbackErr) {
          logger.error('Failed to rollback message after chat send failure', rollbackErr);
        }
        // 关联已随消息级联删除；显式确保附件仍为 draft（create 时本就未升格）。
        if (attachmentIdsForRollback.length > 0) {
          try {
            attachmentRepo.markAttachmentsStatus(attachmentIdsForRollback, 'draft');
          } catch (statusErr) {
            logger.error('Failed to restore attachment draft status after rollback', statusErr);
          }
        }
      }
      logger.error('Failed to send message', error);
      throw error;
    } finally {
      if (locked) chatSendLocks.delete(sessionId);
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
    // Task 7 前：非空附件显式拒绝，禁止静默丢附件只存 text。
    const shape = validateChatSendPayloadShape(payload);
    if (!shape.ok) throw new Error(shape.message);
    if (payload.attachmentIds.length > 0) {
      throw new Error('任务队列附件尚未支持，请先发送普通聊天或清空附件后再添加任务。');
    }
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
    // Task 7 前：非空附件显式拒绝，禁止 waiting 续接静默丢附件。
    const shape = validateChatSendPayloadShape(payload);
    if (!shape.ok) throw new Error(shape.message);
    if (payload.attachmentIds.length > 0) {
      throw new Error('等待续接附件尚未支持，请先清空附件或等待 Task 7 完成后再试。');
    }
    assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
    continueWithUserMessage(sessionId, payload.text.trim(), mainWindow);
    return getQueueState(sessionId);
  });

  // 附件 IPC：选择 / 暂存字节（粘贴·拖放）/ 受控预览 / 移除草稿。
  // 文件读取与校验全部在主进程；renderer 只拿不透明附件 ID 与受控预览 bytes。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_PICK, async (_event, sessionId: string): Promise<PickAttachmentsResult> => {
    const session = sessionRepo.getSession(sessionId);
    if (!session) throw new Error('会话不存在');
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      title: '选择附件（图片 / 文档 / 文件）',
    });
    if (result.canceled || !result.filePaths.length) return { attachments: [], errors: [] };

    const attachments: AttachmentSummary[] = [];
    const errors: Array<{ filename: string; message: string }> = [];
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
        attachments.push(summary);
      } catch (e) {
        // 逐项收集失败：部分成功时 UI 仍展示成功项 + 集中提示失败项（错误文案来自业务校验，不含内部路径）。
        errors.push({ filename, message: e instanceof Error ? e.message : String(e) });
      }
    }
    return { attachments, errors };
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
