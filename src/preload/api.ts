import { ipcRenderer } from 'electron';
import type { AppConfig, ModelInfo } from '../shared/types/config';
import type { Session, Message } from '../shared/types/session';
import type { Task, QueueState } from '../shared/types/task';
import type { ChatEventPayload, QueueEventPayload } from '../shared/types/ipc';
import type { CliDetectionResult } from '../shared/types/cli';
import { IPC_CHANNELS } from '../shared/constants';

export interface ClaudeLinkAPI {
  detectCli: () => Promise<CliDetectionResult>;
  getCliStatus: () => Promise<CliDetectionResult>;
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  clearConfig: () => Promise<AppConfig>;
  fetchModels: (provider: AppConfig['provider'], apiKey: string) => Promise<ModelInfo[]>;
  listSessions: () => Promise<Session[]>;
  createSession: (name: string) => Promise<Session>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionMessages: (sessionId: string) => Promise<Message[]>;
  deleteSession: (id: string) => Promise<void>;
  updateSession: (
    id: string,
    data: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns'>>,
  ) => Promise<Session | null>;
  sendMessage: (sessionId: string, message: string) => Promise<void>;
  abortChat: (sessionId: string) => Promise<void>;
  onChatEvent: (callback: (payload: ChatEventPayload) => void) => () => void;
  removeChatListener: () => void;
  addTask: (sessionId: string, prompt: string) => Promise<Task>;
  removeTask: (taskId: string) => Promise<void>;
  getTasks: (sessionId: string) => Promise<Task[]>;
  reorderTasks: (sessionId: string, taskIds: string[]) => Promise<Task[]>;
  interruptTask: (taskId: string) => Promise<void>;
  startQueue: (sessionId: string) => Promise<void>;
  pauseQueue: (sessionId: string) => Promise<void>;
  resumeQueue: (sessionId: string) => Promise<void>;
  getQueueState: (sessionId: string) => Promise<QueueState>;
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
    fetchModels: (provider, apiKey) => ipcRenderer.invoke(IPC_CHANNELS.MODELS_FETCH, provider, apiKey),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
    createSession: (name) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, name),
    getSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, id),
    getSessionMessages: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_GET_BY_SESSION, sessionId),
    deleteSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id),
    updateSession: (id, data) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, id, data),
    sendMessage: (sessionId, message) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, sessionId, message),
    abortChat: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT, sessionId),
    onChatEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: ChatEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.CHAT_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.CHAT_EVENT, listener);
    },
    removeChatListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.CHAT_EVENT),
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
    onQueueEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: QueueEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.QUEUE_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.QUEUE_EVENT, listener);
    },
    removeQueueListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.QUEUE_EVENT),
  };
}
