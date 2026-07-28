import type { CliEvent, CliDetectionResult } from './cli';
import type { AttachmentSummary } from './attachment';

export const IPC_CHANNELS = {
  CLI_DETECT: 'cli:detect',
  CLI_GET_STATUS: 'cli:getStatus',
  CONFIG_GET: 'config:get',
  CONFIG_SAVE: 'config:save',
  CONFIG_CLEAR: 'config:clear',
  CONFIG_STORAGE_INFO: 'config:storageInfo',
  CONFIG_IMPORT_SETTINGS: 'config:importSettings',
  CONFIG_PICK_SETTINGS_FILE: 'config:pickSettingsFile',
  CONFIG_AUTO_DETECT: 'config:autoDetect',
  CONFIG_TEST_CONNECTION: 'config:testConnection',
  TEST_CONNECTION_EVENT: 'testConnection:event',
  TEST_CONNECTION_ABORT: 'testConnection:abort',
  WORKSPACE_PICK_DIR: 'workspace:pickDir',
  WORKSPACE_LIST_RECENT: 'workspace:listRecent',
  WORKSPACE_ADD_RECENT: 'workspace:addRecent',
  MODELS_FETCH: 'models:fetch',
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_GET: 'session:get',
  SESSION_DELETE: 'session:delete',
  SESSION_UPDATE: 'session:update',
  SESSION_UPDATE_MODEL_OVERRIDE: 'session:updateModelOverride',
  SESSION_SEARCH: 'session:search',
  SESSION_ANALYZE_TOPIC: 'session:analyzeTopic',
  MESSAGE_GET_BY_SESSION: 'message:getBySession',
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_EVENT: 'chat:event',
  PERMISSION_REQUEST: 'permission:request',
  PERMISSION_RESPOND: 'permission:respond',
  INTERACTION_REQUEST: 'interaction:request',
  INTERACTION_RESPOND: 'interaction:respond',
  INTERACTION_CANCEL: 'interaction:cancel',
  INTERACTION_GET_PENDING: 'interaction:getPending',
  INTERACTION_HISTORY_GET: 'interaction:history:get',
  INTERACTION_HISTORY_RECORD: 'interaction:history:record',
  CONTEXT_UPDATE: 'context:update',
  // 会话改动面板：列出 workingDir 的 git 改动 + 按需取单文件 diff（不抓快照，按需 git diff）。
  CHANGES_LIST: 'changes:list',
  CHANGES_DIFF: 'changes:diff',
  TASK_ADD: 'task:add',
  TASK_REMOVE: 'task:remove',
  TASK_GET_ALL: 'task:getAll',
  TASK_REORDER: 'task:reorder',
  TASK_INTERRUPT: 'task:interrupt',
  TASK_RETRY: 'task:retry',
  QUEUE_START: 'queue:start',
  QUEUE_PAUSE: 'queue:pause',
  QUEUE_RESUME: 'queue:resume',
  QUEUE_GET_STATE: 'queue:getState',
  QUEUE_EVENT: 'queue:event',
  QUEUE_USER_MESSAGE: 'queue:userMessage',
  // 附件：选择 / 暂存字节（粘贴·拖放）/ 受控预览 / 移除草稿。
  // 统一发送载荷 ChatSendPayload 经 CHAT_SEND / TASK_ADD / QUEUE_USER_MESSAGE 透传，不另设通道。
  ATTACHMENT_PICK: 'attachment:pick',
  ATTACHMENT_STAGE_BYTES: 'attachment:stageBytes',
  ATTACHMENT_PREVIEW: 'attachment:preview',
  ATTACHMENT_REMOVE_DRAFT: 'attachment:removeDraft',
  // 克隆历史消息附件为草稿（异步发送失败后重新编辑用）。
  ATTACHMENT_CLONE_MESSAGE: 'attachment:cloneMessage',
  // 会话导出 JPEG 长图（v3）。可见 renderer ↔ 主进程 ↔ 隐藏 export renderer。
  EXPORT_IMAGE_START: 'export-image:start',
  EXPORT_IMAGE_PROGRESS: 'export-image:progress',
  EXPORT_RENDER_GET_JOB: 'export-render:getJob',
  EXPORT_RENDER_CAPTURE_SELF: 'export-render:captureSelf',
  EXPORT_RENDER_PROGRESS: 'export-render:progress',
  EXPORT_RENDER_WRITE_PAGE_CHUNK: 'export-render:writePageChunk',
  EXPORT_RENDER_FINISH: 'export-render:finish',
  // v4.1 PNG 长图页协议（renderer → 主进程）。JPEG 路径沿用上面 4 个通道不变。
  EXPORT_RENDER_PROBE_SELF: 'export-render:probeSelf',
  EXPORT_RENDER_BEGIN_PAGE: 'export-render:beginPage',
  EXPORT_RENDER_FINISH_PAGE: 'export-render:finishPage',
} as const;

export const DEFAULT_TASK_DELAY_SECONDS = 60;
export const STREAM_DEBOUNCE_MS = 50;
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

/** 粘贴/拖放入参：把 renderer 的 Blob bytes 交给主进程暂存（不传文件路径）。 */
export interface StageAttachmentBytesInput {
  sessionId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}

/** 受控预览请求：主进程校验会话归属后返回有界缩略图/原图 bytes，不返回路径。 */
export interface AttachmentPreviewRequest {
  sessionId: string;
  attachmentId: string;
  thumbnail: boolean;
}

/** 文件选择结果：逐项返回成功摘要与失败原因（部分成功不丢错误，便于 UI 集中提示）。 */
export interface PickAttachmentsResult {
  attachments: AttachmentSummary[];
  errors: Array<{ filename: string; message: string }>;
}

export interface ChatEventPayload {
  sessionId: string;
  event: CliEvent;
}

export interface PermissionOption {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
  danger?: boolean;
}

export interface PermissionRequestPayload {
  id: string;
  sessionId: string;
  toolName: string;
  toolUseId: string;
  title: string;
  description?: string;
  input: Record<string, unknown>;
  options: PermissionOption[];
  suggestions?: unknown[];
}

export interface PermissionResponsePayload {
  id: string;
  optionId: string;
}

export type InteractionPromptKind = 'permission' | 'single-choice' | 'multi-choice' | 'text' | 'long-text' | 'form' | 'confirm';
export type InteractionPreviewKind = 'text' | 'markdown' | 'code' | 'diff' | 'table';

export interface InteractionPromptAction {
  id: string;
  label: string;
  description?: string;
  primary?: boolean;
  danger?: boolean;
}

export interface InteractionPromptPresentation {
  layout?: 'dialog' | 'sidebar' | 'sheet';
  density?: 'compact' | 'default' | 'comfortable';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  accent?: string;
  showPreview?: boolean;
}

export interface InteractionPromptPreview {
  type: InteractionPreviewKind;
  content?: string;
  language?: string;
  headers?: string[];
  rows?: string[][];
}

export interface InteractionPromptOption {
  id: string;
  label: string;
  description?: string;
  value?: unknown;
  primary?: boolean;
  danger?: boolean;
  preview?: string | InteractionPromptPreview;
}

export interface InteractionFormField {
  id: string;
  label: string;
  type: 'text' | 'textarea' | 'select' | 'checkbox';
  required?: boolean;
  placeholder?: string;
  defaultValue?: string | boolean;
  options?: InteractionPromptOption[];
}

export interface InteractionPromptQuestion {
  id: string;
  title: string;
  description?: string;
  source?: string;
  options: InteractionPromptOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherLabel?: string;
  defaultOptionIds?: string[];
}

export interface InteractionPromptPayload {
  id: string;
  sessionId: string;
  kind: InteractionPromptKind;
  title: string;
  description?: string;
  source?: string;
  toolName?: string;
  toolUseId?: string;
  input?: Record<string, unknown>;
  options?: InteractionPromptOption[];
  questions?: InteractionPromptQuestion[];
  fields?: InteractionFormField[];
  multiSelect?: boolean;
  allowOther?: boolean;
  otherLabel?: string;
  defaultOptionIds?: string[];
  suggestions?: unknown[];
  presentation?: InteractionPromptPresentation;
}
export interface InteractionPromptResponsePayload {
  id: string;
  action: 'submit' | 'cancel';
  selectedOptionIds?: string[];
  questionAnswers?: Record<string, { selectedOptionIds?: string[]; otherText?: string }>;
  fieldValues?: Record<string, string | boolean>;
  otherText?: string;
}

export interface InteractionPromptCancelPayload {
  id: string;
  sessionId: string;
}

// V3-3：交互历史持久化。每次用户提交/取消交互弹窗落库一条，
// 切换会话或重启后仍可在 InteractionPrompt 底部"交互历史"区回看。
export interface InteractionHistoryEntry {
  id: string;
  sessionId: string;
  title: string;
  kind: string;
  summary: string | null;
  action: 'submit' | 'cancel';
  createdAt: string;
}

export interface RecordInteractionHistoryInput {
  sessionId: string;
  title: string;
  kind: string;
  summary?: string | null;
  action: 'submit' | 'cancel';
}

export interface ContextStatsPayload {
  sessionId: string;
  inputTokens: number;       // 上下文用量（input+cache）
  outputTokens: number;      // 上一轮生成量（参考）
  windowSize: number;        // 上下文窗口（默认 200000）
  model: string | null;      // 当前会话模型
  compactedJustNow?: boolean; // CC 自动压缩事件
}

export type QueueEventType =
  | 'task_started'
  | 'task_progress'
  | 'task_completed'
  | 'task_failed'
  | 'countdown_started'
  | 'countdown_tick'
  | 'countdown_cancelled'
  | 'task_continuing'
  | 'user_message_created'
  | 'queue_paused'
  | 'queue_completed';

export interface QueueEventPayload {
  sessionId: string;
  type: QueueEventType;
  taskId?: string;
  data?: Record<string, unknown>;
}

// 流式测试连接事件：main 进程 spawn CLI 后，逐事件推送给渲染进程的弹框。
// phase 状态机：connecting(已启动,等待端点) → connected(收到init,端点可达) →
//   streaming(assistant 文本增量) → done(成功/失败判定) / error(spawn/超时错误)。
export type TestConnectionPhase = 'connecting' | 'connected' | 'streaming' | 'done' | 'error';

export interface TestConnectionEventPayload {
  phase: TestConnectionPhase;
  /** connected: CLI init 回显的实际模型 */
  model?: string;
  /** streaming: 本次增量文本 */
  delta?: string;
  /** done: 是否连接成功 */
  success?: boolean;
  /** done/error: 给用户看的结论文案 */
  message?: string;
  /** done/error: 排查用的详情（退出码/stderr/原始片段） */
  detail?: string;
  /** done: 耗时毫秒 */
  durationMs?: number;
  // —— 问题 3 明文回显（新增）——
  /** claude-link 本次解析出、写进 --model 与 settings.local.json 的实际模型名 */
  requestedModel?: string;
  /** claude-link 本次写入的端点 */
  usedBaseUrl?: string;
}

export type CliDetectionResultAlias = CliDetectionResult;
