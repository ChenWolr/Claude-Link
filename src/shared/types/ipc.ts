import type { CliEvent, CliDetectionResult } from './cli';
import type { AttachmentSummary } from './attachment';
import type { ContextUsageSource, ContextUsageFreshness, ContextSamplePhase } from '../context-usage';
import type { ThinkingLevel } from './thinking';
import type { PermissionMode } from '../permission-resolver';

// 命令快照类型 re-export：payload/快照在 ./command 定义，这里对外统一出口（main/preload/renderer 共用）。
export type {
  CommandChangedPayload,
  CommandGlobalChangedPayload,
  SessionCommandSnapshot,
  SdkCommand,
  CommandSnapshotStatus,
  CommandSnapshotSource,
  CommandProvenance,
} from './command';

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
  // 流式测试连接通道已删除（测试收敛到 PROVIDER_TEST_MODEL 行内直返）。
  // Task 3 Step 5：原生 settings 诊断（resolveSettings 摘要，脱敏：只回来源/路径/键名，绝不含值）。
  SETTINGS_GET_DIAGNOSTIC: 'settings:getDiagnostic',
  WORKSPACE_PICK_DIR: 'workspace:pickDir',
  WORKSPACE_LIST_RECENT: 'workspace:listRecent',
  WORKSPACE_ADD_RECENT: 'workspace:addRecent',
  WORKSPACE_REMOVE_RECENT: 'workspace:removeRecent',
  // 多供应商模型库（设置页=可选项库；密钥明文只在 save/test 时进主进程，出主进程只有掩码视图）。
  PROVIDER_LIST: 'config:listProviders',
  PROVIDER_SAVE: 'config:saveProvider',
  PROVIDER_DELETE: 'config:deleteProvider',
  PROVIDER_RESTORE: 'config:restoreProvider',
  PROVIDER_QUERY_MODELS: 'config:queryProviderModels',
  PROVIDER_TEST_MODEL: 'config:testProviderModel',
  // 主→渲染推送：库内容变更（增删改/撤销）后通知所有缓存方（设置页 + 会话选择器）刷新。
  PROVIDERS_CHANGED: 'providers:changed',
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
  // 批次二 #3：运行中回合中途切权限档（streaming input 控制请求，setPermissionMode）。
  CHAT_SET_PERMISSION_MODE: 'chat:setPermissionMode',
  CHAT_EVENT: 'chat:event',
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
  // 点文件「打开」：shell.openPath 用系统默认程序打开，失败时 Windows 降级弹「打开方式」对话框（仓库根解析 + 越界守卫，绝不 resolve(workingDir, rel)）。
  CHANGES_OPEN_FILE: 'changes:openFile',
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
  // Claude 计划快照：按会话读取 TodoWrite / Task 工具的计划状态。
  CLAUDE_PLAN_GET: 'claude-plan:get',
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
  // 原生 Slash Commands 命令快照：主进程按 sessionId 维护并清洗；renderer 拉取 + 监听全量替换。
  // 独立于 CHAT_EVENT——命令能力是 transient 状态，不被当成聊天消息持久化。
  COMMANDS_GET: 'commands:get',
  COMMANDS_CHANGED: 'commands:changed',
  // D4：全局兜底快照热刷新广播（globalFallback 变化时主→渲染推送）。不经 isSessionActive 守卫——
  // 暂态会话不在 activeSessions，但正是它最需要这路广播；renderer 自行决定覆盖/回填。
  COMMANDS_GLOBAL_CHANGED: 'commands:globalChanged',
  // Task 8：命令来源 provenance 诊断（从已清洗快照派生的脱敏视图：origin/availability 计数 +
  // unknown/hidden 命令名，不含 Query 句柄或原始数据）。只读、无副作用，不触发 probe。
  COMMANDS_GET_DIAGNOSTIC: 'commands:getDiagnostic',
} as const;

export const DEFAULT_TASK_DELAY_SECONDS = 60;
export const STREAM_DEBOUNCE_MS = 50;
export const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

/** SESSION_CREATE 的可选物化参数：暂态会话首条消息发送前由 renderer 携带。 */
export interface SessionCreateSpec {
  /** 暂态会话 id（renderer 预生成）：物化沿用同一 id，草稿/附件/乐观消息无需迁移 key。 */
  id?: string;
  workingDir?: string | null;
  providerOverride?: string;
  modelOverride?: string;
  /** 暂态期间选定的权限档（null = 跟随全局默认）；主进程按 SESSION_UPDATE 同语义白名单透传。 */
  permissionMode?: PermissionMode | null;
  /** 暂态期间选定的思考强度（null = 跟随全局默认）；白名单语义同上。 */
  thinkingLevel?: ThinkingLevel | null;
  /** 暂态期间无行暂存的附件 id：物化建行后绑定为 draft 记录。 */
  bindTransientAttachmentIds?: string[];
}

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
  // cancel 的来源：'user' = 用户主动拒绝（Esc/拒绝按钮）；'abort' = 系统取消（signal abort/窗口关闭/会话删除/IPC 失败）。
  // permission 映射据此区分——系统取消不能记成「用户拒绝该工具」喂给模型，否则模型在 resume 时读到该
  // tool_result(is_error) 会认定用户拒绝过该工具，本会话后续不再调用（并发误 deny 根因，见 plan-v1 §2-3）。
  // 缺省按 'abort'（中性）处理：宁可不指控用户，也不把非用户意图错记为用户拒绝。
  reason?: 'user' | 'abort';
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
  // ── 旧字段（过渡兼容，勿再当当前窗口主值）──
  inputTokens: number;       // 语义已降级为 turn usage（input+cache），保留仅供旧展示兜底
  outputTokens: number;      // 上一轮生成量（参考）
  windowSize: number;        // 上下文窗口容量（真实值或 200k 兜底）
  model: string | null;      // 当前会话模型
  compactedJustNow?: boolean; // CC 自动压缩事件（仅允许出现在压缩后 fresh payload）
  // ── 代际（review-v3 High-2，发布契约必填）──
  // 产生本 payload 的 query 代际（主进程 entry.queryInstance，全局单调递增）。
  // renderer 据此拒收旧回合迟到 payload 与缺代际的可疑 payload。
  queryGeneration: number;
  // 采样时间（Date.now()）：runtime 快照为捕获时刻，/context 终态为 result 时刻（review-v3 §5.1-3）。
  // 采样阶段（review-v4 High-1）：runtime 快照为 query-start/post-turn/post-compaction；
  // 非快照 payload（turn usage/pending/native 对账）为 null。
  refreshedAt: number | null;
  samplePhase: ContextSamplePhase | null;
  // ── 新 canonical 字段（Task 7/8；review-v3 §6.3 + review-v4 Medium-2 全量收紧必填）──
  // 当前窗口主值：可信时来自 SDK getContextUsage().totalTokens 或 native /context used。
  // 契约：所有 canonical 字段必须存在，无数据用 null；缺字段即协议错误（renderer 拒收）。
  currentContextUsedTokens: number | null;
  contextWindowCapacityTokens: number | null;
  currentContextUsedPercent: number | null;
  currentContextRemainingTokens: number | null;
  currentContextRemainingPercent: number | null;
  // turn usage 分解（仅参考，不得驱动圆环）
  turnInputTokens: number | null;
  turnCacheReadTokens: number | null;
  turnCacheCreationTokens: number | null;
  turnOutputTokens: number | null;
  // 来源/新鲜度/一致性（必填：主进程构造路径全部显式填写，renderer 不猜测默认值）
  source: ContextUsageSource;
  freshness: ContextUsageFreshness;
  consistency: 'reconciled' | 'mismatch' | 'unavailable';
  diagnostic: string | null;
  // ── 压缩账单（compact metadata display，纯附加全可选）──
  // 引擎在 compact_boundary 免费附带的账单：压缩前/后 token、清出量、耗时、触发方式。
  // 只在 compactedJustNow 成立的 payload 上挂载（post-compaction 快照 + post-turn 探针两处），
  // 且要求账单代际 === 本回合代际（旧回合账单不跨回合）。不进入 CANONICAL_REQUIRED_FIELDS。
  compactFromTokens?: number;
  compactToTokens?: number;
  compactDroppedTokens?: number;
  compactDurationMs?: number;
  compactTrigger?: string;
}

/**
 * 原生 settings 诊断摘要（Task 3 Step 5，SDK resolveSettings 的可克隆脱敏视图）。
 * 只回来源级联（source + path）、可见 CLAUDE.md 候选、effective 键名——绝不回传 effective 的值
 * （可能含 env/API key 等秘密），日志与 IPC 一律脱敏。
 */
export interface NativeSettingsDiagnostic {
  cwd: string;
  /** 来源级联（低→高优先级）：managed / user / project / local / flag 等。 */
  sources: Array<{ source: string; path?: string }>;
  /** 从 cwd 向上可发现的 CLAUDE.md 候选（CC 会加载的上下文文件）。 */
  claudeMdCandidates: string[];
  /** effective settings 的顶层键名摘要（只取键，不含值）。 */
  effectiveKeys: string[];
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

// 流式测试连接事件（TestConnectionPhase / TestConnectionEventPayload）已随弹框测试删除：
// 测试收敛到 PROVIDER_TEST_MODEL（模型行内按钮，invoke 直返 ProviderModelTestResult）。

export type CliDetectionResultAlias = CliDetectionResult;
