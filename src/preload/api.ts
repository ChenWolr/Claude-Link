// api.ts
// preload 桥：通过 contextBridge 把 IPC 调用暴露为 window.claudeLink（35 个方法）。
// 渲染进程 window.claudeLink.xxx() → ipcRenderer.invoke(IPC_CHANNELS.XXX) → ipc-handlers 的对应 handler。

import { ipcRenderer } from 'electron';
import type { AppConfig, ModelInfo, DetectedClaudeConfig } from '../shared/types/config';
import type { Session, Message } from '../shared/types/session';
import type { Task, QueueState } from '../shared/types/task';
import type { ChatEventPayload, QueueEventPayload, TestConnectionEventPayload, ContextStatsPayload } from '../shared/types/ipc';
import type { CliDetectionResult } from '../shared/types/cli';
import { IPC_CHANNELS } from '../shared/constants';

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
    data: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns'>>,
  ) => Promise<Session | null>;
  searchSessions: (query: string) => Promise<Session[]>;
  analyzeTopic: (sessionId: string, firstMessage: string) => Promise<string | null>;
  updateModelOverride: (id: string, modelOverride: string | null) => Promise<Session | null>;
  sendMessage: (sessionId: string, message: string) => Promise<void>;
  abortChat: (sessionId: string) => Promise<void>;
  onChatEvent: (callback: (payload: ChatEventPayload) => void) => () => void;
  removeChatListener: () => void;
  onContextUpdate: (callback: (payload: ContextStatsPayload) => void) => () => void;
  removeContextListener: () => void;
  addTask: (sessionId: string, prompt: string) => Promise<Task>;
  removeTask: (taskId: string) => Promise<void>;
  getTasks: (sessionId: string) => Promise<Task[]>;
  reorderTasks: (sessionId: string, taskIds: string[]) => Promise<Task[]>;
  interruptTask: (taskId: string) => Promise<void>;
  startQueue: (sessionId: string) => Promise<void>;
  pauseQueue: (sessionId: string) => Promise<void>;
  resumeQueue: (sessionId: string) => Promise<void>;
  getQueueState: (sessionId: string) => Promise<QueueState>;
  queueUserMessage: (sessionId: string, message: string) => Promise<QueueState>;
  onQueueEvent: (callback: (payload: QueueEventPayload) => void) => () => void;
  removeQueueListener: () => void;
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
    sendMessage: (sessionId, message) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, sessionId, message),
    abortChat: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT, sessionId),
    onChatEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.CHAT_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.CHAT_EVENT, listener);
    },
    removeChatListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.CHAT_EVENT),
    onContextUpdate: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ContextStatsPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.CONTEXT_UPDATE, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.CONTEXT_UPDATE, listener);
    },
    removeContextListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.CONTEXT_UPDATE),
    addTask: (sessionId, prompt) => ipcRenderer.invoke(IPC_CHANNELS.TASK_ADD, sessionId, prompt),
    removeTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_REMOVE, taskId),
    getTasks: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_ALL, sessionId),
    reorderTasks: (sessionId, taskIds) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASK_REORDER, sessionId, taskIds) as Promise<Task[]>,
    interruptTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_INTERRUPT, taskId),
    startQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_START, sessionId),
    pauseQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_PAUSE, sessionId),
    resumeQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_RESUME, sessionId),
    getQueueState: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATE, sessionId),
    queueUserMessage: (sessionId, message) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_USER_MESSAGE, sessionId, message),
    onQueueEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: QueueEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.QUEUE_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.QUEUE_EVENT, listener);
    },
    removeQueueListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.QUEUE_EVENT),
  };
}
