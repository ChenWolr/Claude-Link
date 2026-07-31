// api.ts
// preload 桥：通过 contextBridge 把 IPC 调用暴露为 window.claudeLink（35 个方法）。
// 渲染进程 window.claudeLink.xxx() → ipcRenderer.invoke(IPC_CHANNELS.XXX) → ipc-handlers 的对应 handler。

import { ipcRenderer } from 'electron';
import type { AppConfig, ModelInfo, DetectedClaudeConfig } from '../shared/types/config';
import type { Session, Message } from '../shared/types/session';
import type { Task, QueueState } from '../shared/types/task';
import type { AttachmentSummary, AttachmentPreviewResponse, ChatSendPayload, SendMessageResult } from '../shared/types/attachment';
import type { ChatEventPayload, QueueEventPayload, TestConnectionEventPayload, ContextStatsPayload, InteractionPromptCancelPayload, InteractionPromptPayload, InteractionPromptResponsePayload, InteractionHistoryEntry, RecordInteractionHistoryInput, StageAttachmentBytesInput, AttachmentPreviewRequest, PickAttachmentsResult } from '../shared/types/ipc';
import type { CliDetectionResult } from '../shared/types/cli';
import { IPC_CHANNELS } from '../shared/constants';
import type { ChangesListResult, ChangesDiffResult } from '../shared/types/changes';

export interface ClaudeLinkAPI {
  detectCli: () => Promise<CliDetectionResult>;
  getCliStatus: () => Promise<CliDetectionResult>;
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  clearConfig: () => Promise<AppConfig>;
  getStorageInfo: () => Promise<{ userData: string; config: string; workspaces: string; db: string }>;
  importSettings: (filePath: string) => Promise<{
    apiKey?: string;
    apiBaseUrl?: string;
    defaultModel?: string;
    advancedJson: string;
  }>;
  pickSettingsFile: () => Promise<string | null>;
  autoDetectClaudeConfig: () => Promise<DetectedClaudeConfig>;
  testConnection: (model: string | null) => Promise<void>;
  abortTestConnection: () => Promise<void>;
  onTestConnectionEvent: (callback: (payload: TestConnectionEventPayload) => void) => () => void;
  removeTestConnectionListener: () => void;
  pickWorkspaceDir: () => Promise<string | null>;
  listRecentWorkspaces: () => Promise<string[]>;
  addRecentWorkspace: (dir: string) => Promise<string[]>;
  fetchModels: (provider: AppConfig['provider'], apiKey: string, apiBaseUrl?: string) => Promise<ModelInfo[]>;
  listSessions: () => Promise<Session[]>;
  createSession: (name: string) => Promise<Session>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionMessages: (sessionId: string) => Promise<Message[]>;
  deleteSession: (id: string) => Promise<void>;
  updateSession: (
    id: string,
    data: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel'>>,
  ) => Promise<Session | null>;
  searchSessions: (query: string) => Promise<Session[]>;
  analyzeTopic: (sessionId: string, firstMessage: string) => Promise<string | null>;
  updateModelOverride: (id: string, modelOverride: string | null) => Promise<Session | null>;
  sendMessage: (sessionId: string, payload: ChatSendPayload) => Promise<SendMessageResult>;
  abortChat: (sessionId: string) => Promise<void>;
  onChatEvent: (callback: (payload: ChatEventPayload) => void) => () => void;
  removeChatListener: () => void;
  onInteractionRequest: (callback: (payload: InteractionPromptPayload) => void) => () => void;
  onInteractionCancel: (callback: (payload: InteractionPromptCancelPayload) => void) => () => void;
  getPendingInteractions: () => Promise<InteractionPromptPayload[]>;
  respondInteraction: (response: InteractionPromptResponsePayload) => Promise<void>;
  getInteractionHistory: (sessionId: string) => Promise<InteractionHistoryEntry[]>;
  recordInteractionHistory: (input: RecordInteractionHistoryInput) => Promise<void>;
  onContextUpdate: (callback: (payload: ContextStatsPayload) => void) => () => void;
  removeContextListener: () => void;
  listChanges: (workingDir: string | null, touchedPaths: string[]) => Promise<ChangesListResult>;
  getChangeDiff: (workingDir: string | null, path: string) => Promise<ChangesDiffResult>;
  addTask: (sessionId: string, payload: ChatSendPayload) => Promise<Task>;
  removeTask: (taskId: string) => Promise<void>;
  getTasks: (sessionId: string) => Promise<Task[]>;
  reorderTasks: (sessionId: string, taskIds: string[]) => Promise<Task[]>;
  interruptTask: (taskId: string) => Promise<void>;
  retryTask: (taskId: string) => Promise<Task>;
  startQueue: (sessionId: string) => Promise<void>;
  pauseQueue: (sessionId: string) => Promise<void>;
  resumeQueue: (sessionId: string) => Promise<void>;
  getQueueState: (sessionId: string) => Promise<QueueState>;
  queueUserMessage: (sessionId: string, payload: ChatSendPayload) => Promise<QueueState>;
  getClaudePlanState: (sessionId: string) => Promise<import('../shared/types/claude-plan').ClaudePlanState | null>;
  pickAttachments: (sessionId: string) => Promise<PickAttachmentsResult>;
  stageAttachmentBytes: (input: StageAttachmentBytesInput) => Promise<AttachmentSummary>;
  getAttachmentPreview: (request: AttachmentPreviewRequest) => Promise<AttachmentPreviewResponse>;
  removeDraftAttachment: (sessionId: string, attachmentId: string) => Promise<void>;
  cloneMessageAttachments: (sessionId: string, messageId: string) => Promise<AttachmentSummary[]>;
  onQueueEvent: (callback: (payload: QueueEventPayload) => void) => () => void;
  removeQueueListener: () => void;
  startImageExport: (sessionId: string, format: import('../shared/types/export-image').ExportImageFormat) => Promise<{ ok: true; jobId: string } | { ok: false; code: string; message: string }>;
  onImageExportProgress: (callback: (payload: import('../shared/types/export-image').ExportImageProgressPayload) => void) => () => void;
}

export function createApi(): ClaudeLinkAPI {
  return {
    detectCli: () => ipcRenderer.invoke(IPC_CHANNELS.CLI_DETECT),
    getCliStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CLI_GET_STATUS),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_GET),
    saveConfig: (config) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_SAVE, config),
    clearConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_CLEAR),
    getStorageInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.CONFIG_STORAGE_INFO) as Promise<{
        userData: string;
        config: string;
        workspaces: string;
        db: string;
      }>,
    importSettings: (filePath) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_IMPORT_SETTINGS, filePath),
    pickSettingsFile: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_PICK_SETTINGS_FILE) as Promise<string | null>,
    autoDetectClaudeConfig: () => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_AUTO_DETECT) as Promise<DetectedClaudeConfig>,
    testConnection: (model) => ipcRenderer.invoke(IPC_CHANNELS.CONFIG_TEST_CONNECTION, model ?? null),
    abortTestConnection: () => ipcRenderer.invoke(IPC_CHANNELS.TEST_CONNECTION_ABORT),
    pickWorkspaceDir: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_PICK_DIR) as Promise<string | null>,
    listRecentWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_RECENT) as Promise<string[]>,
    addRecentWorkspace: (dir) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_RECENT, dir) as Promise<string[]>,
    onTestConnectionEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: TestConnectionEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.TEST_CONNECTION_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.TEST_CONNECTION_EVENT, listener);
    },
    removeTestConnectionListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.TEST_CONNECTION_EVENT),
    fetchModels: (provider, apiKey, apiBaseUrl) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_FETCH, provider, apiKey, apiBaseUrl),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
    createSession: (name) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, name),
    getSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, id),
    getSessionMessages: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_GET_BY_SESSION, sessionId),
    deleteSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id),
    updateSession: (id, data) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, id, data),
    searchSessions: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SEARCH, query),
    analyzeTopic: (sessionId, firstMessage) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_ANALYZE_TOPIC, sessionId, firstMessage),
    updateModelOverride: (id, modelOverride) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE_MODEL_OVERRIDE, id, modelOverride),
    sendMessage: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, sessionId, payload),
    abortChat: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT, sessionId),
    onChatEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.CHAT_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.CHAT_EVENT, listener);
    },
    removeChatListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.CHAT_EVENT),
    onInteractionRequest: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: InteractionPromptPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.INTERACTION_REQUEST, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.INTERACTION_REQUEST, listener);
    },
    onInteractionCancel: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: InteractionPromptCancelPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.INTERACTION_CANCEL, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.INTERACTION_CANCEL, listener);
    },
    getPendingInteractions: () => ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_GET_PENDING) as Promise<InteractionPromptPayload[]>,
    respondInteraction: (response) => ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_RESPOND, response),
    getInteractionHistory: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_HISTORY_GET, sessionId) as Promise<InteractionHistoryEntry[]>,
    recordInteractionHistory: (input) => ipcRenderer.invoke(IPC_CHANNELS.INTERACTION_HISTORY_RECORD, input),
    onContextUpdate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ContextStatsPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.CONTEXT_UPDATE, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.CONTEXT_UPDATE, listener);
    },
    removeContextListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.CONTEXT_UPDATE),
    listChanges: (workingDir, touchedPaths) => ipcRenderer.invoke(IPC_CHANNELS.CHANGES_LIST, workingDir, touchedPaths),
    getChangeDiff: (workingDir, path) => ipcRenderer.invoke(IPC_CHANNELS.CHANGES_DIFF, workingDir, path),
    addTask: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.TASK_ADD, sessionId, payload),
    removeTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_REMOVE, taskId),
    getTasks: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_ALL, sessionId),
    reorderTasks: (sessionId, taskIds) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASK_REORDER, sessionId, taskIds) as Promise<Task[]>,
    interruptTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_INTERRUPT, taskId),
    retryTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RETRY, taskId) as Promise<Task>,
    startQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_START, sessionId),
    pauseQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PAUSE, sessionId),
    resumeQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_RESUME, sessionId),
    getQueueState: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATE, sessionId),
    queueUserMessage: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_USER_MESSAGE, sessionId, payload),
    getClaudePlanState: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PLAN_GET, sessionId) as Promise<import('../shared/types/claude-plan').ClaudePlanState | null>,
    pickAttachments: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_PICK, sessionId) as Promise<PickAttachmentsResult>,
    stageAttachmentBytes: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_STAGE_BYTES, input) as Promise<AttachmentSummary>,
    getAttachmentPreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_PREVIEW, request) as Promise<AttachmentPreviewResponse>,
    removeDraftAttachment: (sessionId, attachmentId) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_REMOVE_DRAFT, sessionId, attachmentId),
    cloneMessageAttachments: (sessionId, messageId) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_CLONE_MESSAGE, sessionId, messageId) as Promise<AttachmentSummary[]>,
    onQueueEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: QueueEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.QUEUE_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.QUEUE_EVENT, listener);
    },
    removeQueueListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.QUEUE_EVENT),
    // 会话导出 JPEG 长图（v3）：可见 renderer 请求开始 + 接收进度。图片数据不经过可见 renderer。
    startImageExport: (sessionId: string, format: import('../shared/types/export-image').ExportImageFormat) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IMAGE_START, sessionId, format),
    onImageExportProgress: (callback: (payload: import('../shared/types/export-image').ExportImageProgressPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/types/export-image').ExportImageProgressPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS, listener);
    },
  };
}

// —— 导出窗口 surface ——
// 隐藏导出窗口（additionalArguments 注入 --claude-link-surface=export）只暴露最小 window.exportLink，
// 不接触主窗口完整 API（会话 CRUD / 聊天发送 / 任务队列 / 配置写入）。
// 主进程仍按 sender/frame/URL/job 校验每次调用，surface 参数不是唯一授权条件。
import type {
  CaptureSelfRequest,
  CaptureSelfResponse,
  ExportJobSnapshot,
  ExportPageBeginRequest,
  ExportPageBeginResponse,
  ExportPageFinishRequest,
  ExportPageFinishResponse,
  ExportRenderFinishPayload,
  PageChunkPayload,
  PngCaptureSelfRequest,
  PngCaptureSelfResponse,
  PngProbeSelfRequest,
  PngProbeSelfResponse,
} from '../shared/types/export-image';
export interface ExportLinkAPI {
  surface: () => 'export';
  /** 取得与本窗口绑定的 job 快照（主进程按 sender 匹配当前 job）。 */
  getJob: () => Promise<ExportJobSnapshot | null>;
  /** 请求主进程捕获本窗口当前视口。JPEG 返回 PNG bytes；PNG 只回几何（段直接送 worker）。 */
  captureSelf: (request: CaptureSelfRequest | PngCaptureSelfRequest) => Promise<CaptureSelfResponse | PngCaptureSelfResponse>;
  /** 顺序发送单页 JPEG 分块（2 MiB，有背压）。仅 JPEG 路径。 */
  writePageChunk: (payload: Omit<PageChunkPayload, 'bytes'> & { bytes: Uint8Array }) => Promise<void>;
  /** v4.1 PNG：探测真实视口/位图比例（预算反推用）。仅 PNG 路径。 */
  probeSelf: (request: PngProbeSelfRequest) => Promise<PngProbeSelfResponse>;
  /** v4.1 PNG：开始一页（主进程建 outputPath + 起 worker + 下 begin）。仅 PNG 路径。 */
  beginPage: (request: ExportPageBeginRequest) => Promise<ExportPageBeginResponse>;
  /** v4.1 PNG：完成一页（worker 最终编码 + 写临时文件）。仅 PNG 路径。 */
  finishPage: (request: ExportPageFinishRequest) => Promise<ExportPageFinishResponse>;
  /** 上报排版/捕获/编码进度（renderer → 主进程）。 */
  reportProgress: (payload: import('../shared/types/export-image').ExportImageProgressPayload) => void;
  /** 完成报告（done/failed 判别联合，只能调用一次）。 */
  finish: (payload: ExportRenderFinishPayload) => Promise<void>;
}

export function createExportApi(): ExportLinkAPI {
  return {
    surface: () => 'export',
    getJob: () => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_GET_JOB),
    captureSelf: (request) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_CAPTURE_SELF, request),
    writePageChunk: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_WRITE_PAGE_CHUNK, payload),
    probeSelf: (request) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_PROBE_SELF, request),
    beginPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_BEGIN_PAGE, request),
    finishPage: (request) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_FINISH_PAGE, request),
    reportProgress: (payload) => {
      // 单向推送，fire-and-forget；主进程做背压与限频。
      ipcRenderer.send(IPC_CHANNELS.EXPORT_RENDER_PROGRESS, payload);
    },
    finish: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_FINISH, payload),
  };
}
