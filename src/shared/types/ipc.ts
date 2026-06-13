import type { CliEvent, CliDetectionResult } from './cli';

export const IPC_CHANNELS = {
  CLI_DETECT: 'cli:detect',
  CLI_GET_STATUS: 'cli:getStatus',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_CLEAR: 'config:clear',
  MODELS_FETCH: 'models:fetch',
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_GET: 'session:get',
  SESSION_DELETE: 'session:delete',
  SESSION_UPDATE: 'session:update',
  SESSION_SEARCH: 'session:search',
  MESSAGE_GET_BY_SESSION: 'message:getBySession',
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_EVENT: 'chat:event',
  TASK_ADD: 'task:add',
  TASK_REMOVE: 'task:remove',
  TASK_GET_ALL: 'task:getAll',
  TASK_REORDER: 'task:reorder',
  TASK_INTERRUPT: 'task:interrupt',
  QUEUE_START: 'queue:start',
  QUEUE_PAUSE: 'queue:pause',
  QUEUE_RESUME: 'queue:resume',
  QUEUE_GET_STATE: 'queue:getState',
  QUEUE_EVENT: 'queue:event',
} as const;

export const DEFAULT_TASK_DELAY_SECONDS = 60;
export const STREAM_DEBOUNCE_MS = 50;
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export interface ChatEventPayload {
  sessionId: string;
  event: CliEvent;
}

export type QueueEventType =
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'countdown_started'
  | 'countdown_tick'
  | 'countdown_cancelled'
  | 'queue_paused'
  | 'queue_completed';

export interface QueueEventPayload {
  sessionId: string;
  type: QueueEventType;
  taskId?: string;
  data?: Record<string, unknown>;
}

export type CliDetectionResultAlias = CliDetectionResult;
