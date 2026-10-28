// api.ts
// preload 桥：通过 contextBridge 把 IPC 调用暴露为 window.claudeLink（113 个方法，随下方 ClaudeLinkAPI 接口成员增减同步）。
// 渲染进程 window.claudeLink.xxx() → ipcRenderer.invoke(IPC_CHANNELS.XXX) → ipc-handlers 的对应 handler。

import { ipcRenderer } from 'electron';
import type { AppConfig, McpManagedServer, ModelInfo, ProviderLibrarySnapshot, ProviderProfileView, ProviderSaveInput } from '../shared/types/config';
import type { Session, Message } from '../shared/types/session';
import type { Task, QueueOverview } from '../shared/types/task';
import type { AttachmentSummary, AttachmentPreviewResponse, ChatSendPayload, SendMessageResult, CloneMessageAttachmentsResult } from '../shared/types/attachment';
import type { ChatEventPayload, QueueEventPayload, ContextStatsPayload, InteractionPromptCancelPayload, InteractionPromptPayload, InteractionPromptResponsePayload, InteractionHistoryEntry, RecordInteractionHistoryInput, StageAttachmentBytesInput, AttachmentPreviewRequest, PickAttachmentsResult, CommandChangedPayload, CommandGlobalChangedPayload, SessionCommandSnapshot, SessionCreateSpec, WebAccessInfoView } from '../shared/types/ipc';
import type { CliDetectionResult } from '../shared/types/cli';
import type { SkillProjectDirsPayload } from '../shared/types/command';
import type { BridgeConfigGetResult, BridgeConfigSaveInput, BridgeBindingView, BridgePlatformStatusEntry, WechatQrcodeStatusResult, BridgeFeishuTestResult } from '../shared/types/bridge';
import type { AppUpdateInfo, AppUpdateState } from '../shared/types/update';
import { IPC_CHANNELS } from '../shared/constants';
import type { ChangesListResult, ChangesDiffResult, ChangesOpenResult } from '../shared/types/changes';
import type { FsListResult, FsMkdirResult, FsRenameResult, FsRootsResult, FsShowResult, FsStatResult, FsTrashResult, ExportTargetRequest, ExportTargetResponse } from '../shared/types/fs-picker';
// SA-2：回合投影镜像类型的 stalled 字段复用 shared StallInfo（主进程 turn-projection.ts
// import 同一 shared 类型；type-only，无运行时引入）。
import type { StallInfo } from '../shared/stall-watchdog';

// ── MCP 管理载荷类型（P4；内联镜像主进程 src/main/modules/mcp/mcp-scanner.ts / mcp-probe.ts
//    的视图导出形状——preload 不 import 主进程模块，type 结构镜像，字段以该两文件实现为准。
//    §1.3 脱敏：视图 env/headers 只回 key 列表，值不进渲染层）──

/** 作用域条目视图（scanner.McpScopedServerView）：env/headers 只带 key 列表（masked*Keys）。 */
export interface McpScopedServerView {
  scope: 'user' | 'project';
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  /** 探活超时覆盖（毫秒，点1 全链透传的非敏感数值；点5 编辑回填数据源——scanner 视图条目
   *  携带时原样透传，无键缺省）。主进程 McpScopedServerView extends ParsedMcpEntry 同名镜像。 */
  timeoutMs?: number;
  maskedEnvKeys?: string[];
  maskedHeaderKeys?: string[];
}

/** 项目目录视图（scanner.McpProjectDirView）：与 Skill ProjectDirEntry 同构 + 本目录服务器。 */
export interface McpProjectDirView {
  path: string;
  name: string;
  isDefault: boolean;
  sessionCount: number;
  servers: McpScopedServerView[];
}

/** MCP Tab 快照（scanner.McpSnapshot）：用户级列表 + 项目目录列表（+ 可选用户级错误提示）。 */
export interface McpSnapshot {
  userServers: McpScopedServerView[];
  projectDirs: McpProjectDirView[];
  userScopeError?: string;
}

/** 单条探活入参（probe.McpProbeInput）：连接侧字段子集。 */
export interface McpProbeInput {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 单条探活结果（probe.McpProbeReport）。 */
export interface McpProbeReport {
  key: string;
  status: 'ok' | 'fail';
  toolCount: number;
  error?: string;
  probedAt: number;
}

/** probeMcpServers 请求体：all=管理库批量（60s 缓存逐 key 判定）/ single=按 name 现探
 *  （§1.3 渲染层零明文约束：渲染层只回传 name，明文 env/headers 由主进程自取已存条目）。 */
export type McpProbeTarget = { target: 'all' } | { target: 'single'; name: string };

/** mcp:managedSave 提交条目（主进程 src/main/modules/mcp/mcp-config.ts:McpManagedSaveEntry
 *  同构镜像——preload 不 import 主进程模块，结构以该文件为准）：McpManagedServer + 瞬态改名
 *  hint（payload 键 → 已存原键；主进程哨兵还原后剥离，绝不落盘、绝不出现在渲染层类型面）。 */
export interface McpManagedSaveEntry extends McpManagedServer {
  envRenameFrom?: Record<string, string>;
  headersRenameFrom?: Record<string, string>;
}

/** mcp:writeScoped 提交条目（主进程 src/main/modules/mcp/mcp-writer.ts:ScopedMcpEntry 同构
 *  镜像——preload 不 import 主进程模块，结构以该文件为准）：瞬态改名 hint（payload 键 → 已存
 *  原键）供主进程哨兵还原定位原值，还原后剥离、绝不落盘。 */
export interface McpScopedWriteEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 探活超时覆盖（毫秒，点5 表单装填；主进程 mcp-writer.ts:ScopedMcpEntry 同名镜像——
   *  合法（1..120000 整数）才写键，非法/缺省不写，与 sanitize 同口径）。 */
  timeoutMs?: number;
  envRenameFrom?: Record<string, string>;
  headersRenameFrom?: Record<string, string>;
}

/** mcp:writeScoped 请求体：user → ~/.claude.json（dir 忽略，userHome 由主进程自取）；
 *  project → <dir>/.mcp.json（dir 必填，须属已知项目目录集——主进程按 snapshot 同源目录集
 *  校验，防任意路径写）。 */
export interface McpWriteScopedPayload {
  scope: 'user' | 'project';
  dir?: string;
  entry: McpScopedWriteEntry;
  mode: 'upsert' | 'remove';
}

/** mcp:exportScoped 请求体：导出当前作用域全部服务器定义为 {"mcpServers":{…}} JSON 并由
 *  主进程写入系统剪贴板（§1.3 渲染层零明文——JSON 与 env/headers 明文不出主进程，回包只有
 *  count）。project 的 dir 必填，须属已知项目目录集（主进程与 writeScoped 同源校验）。 */
export interface McpExportScopedPayload {
  scope: 'managed' | 'user' | 'project';
  dir?: string;
}

/** mcp:parseMcpJson 回包条目（主进程 src/main/modules/mcp/mcp-config.ts:ParsedMcpEntry 同构
 *  镜像——preload 不 import 主进程模块，字段以该文件实现为准：name/transport/command/args/
 *  env/url/headers/timeoutMs 八字段，无 description）。 */
export interface McpParsedJsonEntry {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

/** mcp:parseMcpJson 回包：ok=true 带解析条目；ok=false 带中文错误消息（坏 JSON/根非对象/
 *  三形态都取不到合法 map），失败不 throw。 */
export type McpParseJsonResult =
  | { ok: true; servers: McpParsedJsonEntry[] }
  | { ok: false; error: string };

// ── 回合投影载荷类型（SA-2；内联镜像主进程 src/main/modules/turn-projection.ts 的
//    TurnProjectionSnapshot / TurnRunningEntry 及其嵌套形状——preload 不 import 主进程
//    模块，type 结构镜像，字段以其实现为准。stalled 复用 shared/stall-watchdog 的
//    StallInfo（主进程模块本身 import 同一 shared 类型，非镜像漂移点）──

/** api_retry 瞬态快照（turn-projection.TurnApiRetryTransient 镜像：system subtype==='api_retry' 的有效子集）。 */
export interface TurnApiRetryTransientView {
  /** 主进程记录时刻。 */
  observedAt: number;
  retryCount?: number;
  retryLimit?: number;
  nextRetryAt?: number;
  retryDelayMs?: number;
  error?: string;
  errorStatus?: number | null;
  sdkAttempt?: number;
  sdkMaxRetries?: number;
}

/** 后台任务（system task_*）记录（turn-projection.TurnBackgroundTask 镜像）。 */
export interface TurnBackgroundTaskView {
  startedAtServer: number;
  lastProgress?: unknown;
}

/** 回合投影快照（turn-projection.TurnProjectionSnapshot 镜像；serverNow 由查询时刻回填，
 *  供渲染端时钟偏移校正）。三路累加器全文 + 存储长度（截断后长度=上限）+ 瞬态与终态字段。 */
export interface TurnProjectionSnapshotView {
  sessionId: string;
  /** 回合代际（= SessionEntry.queryInstance）：防旧回合迟到快照污染新回合。 */
  generation: number;
  /** 回合起点（主进程 Date.now()，权威值）。 */
  startedAt: number;
  /** 查询时刻主进程时钟。 */
  serverNow: number;
  /** 回合阶段：由最近一条流事件推导（text→generating / thinking→thinking / tool 入参→tool）。 */
  phase: 'thinking' | 'tool' | 'generating';
  streamText: string;
  streamTextLength: number;
  truncatedText: boolean;
  streamThinking: string;
  streamThinkingLength: number;
  truncatedThinking: boolean;
  streamTool: Record<string, string>;
  truncatedTool: Record<string, boolean>;
  apiRetry: TurnApiRetryTransientView | null;
  stalled: StallInfo | null;
  backgroundTasks: Record<string, TurnBackgroundTaskView>;
  endedAt: number | null;
  outcome: 'success' | 'error' | 'interrupted' | null;
}

/** 进行中回合概览条目（turn-projection.TurnRunningEntry 镜像：仅未 ended 的投影）。 */
export interface TurnRunningOverviewEntry {
  sessionId: string;
  startedAt: number;
  generation: number;
  /** 概览捕获时刻主进程时钟（与快照 serverNow 同语义，供渲染端时钟偏移校正）。 */
  serverNow: number;
}

export interface ClaudeLinkAPI {
  detectCli: () => Promise<CliDetectionResult>;
  getCliStatus: () => Promise<CliDetectionResult>;
  getConfig: () => Promise<AppConfig>;
  saveConfig: (config: Partial<AppConfig>) => Promise<AppConfig>;
  clearConfig: () => Promise<AppConfig>;
  getStorageInfo: () => Promise<{ userData: string; config: string; workspaces: string; db: string }>;
  // 应用内检查更新（electron-updater / GitHub Releases）：getInfo 拉当前态，check 触发检查，
  // install 在 downloaded 态重启安装；stateChanged 事件推送全程状态。
  getUpdateInfo: () => Promise<AppUpdateInfo>;
  checkForAppUpdate: () => Promise<AppUpdateState>;
  installAppUpdate: () => Promise<boolean>;
  onUpdateStateChanged: (callback: (state: AppUpdateState) => void) => () => void;
  removeUpdateStateListener: () => void;
  listRecentWorkspaces: () => Promise<string[]>;
  addRecentWorkspace: (dir: string) => Promise<string[]>;
  removeRecentWorkspace: (dir: string) => Promise<string[]>;
  // P2 目录历史跨端同步：WORKSPACES_CHANGED 信号订阅（空载荷 {}，收到后重拉 listRecentWorkspaces）。
  onWorkspacesChanged: (callback: () => void) => () => void;
  removeWorkspacesListener: () => void;
  // 多供应商模型库（设置页=可选项库；密钥明文只在 save 时进主进程，list 只回掩码）。
  listProviders: () => Promise<ProviderLibrarySnapshot>;
  saveProvider: (input: ProviderSaveInput) => Promise<ProviderProfileView>;
  deleteProvider: (providerId: string) => Promise<void>;
  restoreProvider: () => Promise<ProviderProfileView>;
  queryProviderModels: (providerId: string, forceRefresh?: boolean) => Promise<ModelInfo[]>;
  testProviderModel: (providerId: string, modelId: string) => Promise<{ success: boolean; message: string; detail: string; durationMs: number }>;
  onProvidersChanged: (callback: () => void) => () => void;
  removeProvidersListener: () => void;
  listSessions: () => Promise<Session[]>;
  createSession: (name: string, spec?: SessionCreateSpec) => Promise<Session>;
  getSession: (id: string) => Promise<Session | null>;
  getSessionMessages: (sessionId: string) => Promise<Message[]>;
  deleteSession: (id: string) => Promise<void>;
  updateSession: (
    id: string,
    data: Partial<Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel' | 'providerOverride' | 'modelOverride'>>,
  ) => Promise<Session | null>;
  // P2 会话置顶（点 S4）：pinned=true 主进程写 Date.now()，false 写 NULL；返回更新后的会话
  //（withBridgePlatform 装饰；null = 会话不存在）。不 bump updated_at（repo 专用入口）。
  setSessionPinned: (sessionId: string, pinned: boolean) => Promise<Session | null>;
  // P4 会话自动命名：首输入兜底名写入。false = 会话不存在 / 名源不可升级（slot|first_input
  // 之外）/ 文本归一后为空（主进程截断/折叠，渲染层不预处理）；成功后主进程广播 SESSIONS_CHANGED。
  setFallbackSessionName: (sessionId: string, text: string) => Promise<boolean>;
  // B1：回合元数据持久化（回合 result 到达时 fire-and-forget）。主进程 handler 成功时固定返回 true，
  // sessionId 非法/会话不存在返回 null（hb10-OPT-1：布尔返回省一次全行读）。下方 Promise<Session | null>
  // 仅为历史形态，运行时实际返回 true | null；调用方均 fire-and-forget，不消费返回值。
  recordTurnMeta: (
    sessionId: string,
    payload: { messageId: string | null; costUsd: number | null; durationMs: number | null; endedAt: number | null },
  ) => Promise<Session | null>;
  searchSessions: (query: string) => Promise<Session[]>;
  analyzeTopic: (sessionId: string, firstMessage: string) => Promise<string | null>;
  sendMessage: (sessionId: string, payload: ChatSendPayload) => Promise<SendMessageResult>;
  abortChat: (sessionId: string) => Promise<void>;
  /** 批次二 #3：运行中回合中途切权限档（streaming 控制请求）；无运行回合返回 false。 */
  setRunningPermissionMode: (sessionId: string, mode: string | null) => Promise<boolean>;
  /** SA-2：回合投影快照（主进程内存投影只读旁路；运行中或终态 60s 保留期可查，
   *  暂态/无回合/保留期满返回 null）。 */
  getRuntimeSnapshot: (sessionId: string) => Promise<TurnProjectionSnapshotView | null>;
  /** SA-2：进行中回合概览（仅未 ended 投影；无在跑回合返回空数组）。 */
  getRunningOverview: () => Promise<TurnRunningOverviewEntry[]>;
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
  getChangeDiff: (workingDir: string | null, path: string, context: number) => Promise<ChangesDiffResult>;
  openChangeFile: (workingDir: string | null, path: string, mode?: 'default' | 'choose') => Promise<ChangesOpenResult>;
  // 轮末文件改动（turn-diff）：回合摘要列表 + 单文件 patch 懒加载（网页版经 web-bridge 同通道可达）。
  listTurnDiffSummaries: (sessionId: string) => Promise<import('../shared/types/turn-file-diff').TurnFileDiffTurnSummary[]>;
  getTurnFilePatch: (sessionId: string, turnStartMessageId: string, endMessageId: string | null, path: string) => Promise<{ mode: import('../shared/types/turn-file-diff').TurnFileDiffMode; patch: string; truncated: boolean }>;
  addTask: (sessionId: string, payload: ChatSendPayload) => Promise<{ task: Task; tasks: Task[] }>;
  removeTask: (taskId: string) => Promise<Task[]>;
  // D 点：后台任务（task_* 编排）终态输出文件只读（主进程强制绝对路径 + 512KB 上限 + 截断标记）。
  readTaskOutput: (outputFile: string) => Promise<{ content: string; truncated: boolean }>;
  getTasks: (sessionId: string) => Promise<Task[]>;
  reorderTasks: (sessionId: string, taskIds: string[]) => Promise<Task[]>;
  setTaskPaused: (taskId: string, paused: boolean) => Promise<Task[]>;
  // v3 队列语义：立即执行（守卫失败抛错）/ 全部恢复 / 面板全量数据。
  runTaskNow: (taskId: string) => Promise<QueueOverview>;
  resumeAllQueue: (sessionId: string) => Promise<QueueOverview>;
  getQueueOverview: (sessionId: string) => Promise<QueueOverview>;
  getClaudePlanState: (sessionId: string) => Promise<import('../shared/types/claude-plan').ClaudePlanState | null>;
  stageAttachmentPaths: (sessionId: string, paths: string[]) => Promise<PickAttachmentsResult>;
  stageAttachmentBytes: (input: StageAttachmentBytesInput) => Promise<AttachmentSummary>;
  getAttachmentPreview: (request: AttachmentPreviewRequest) => Promise<AttachmentPreviewResponse>;
  removeDraftAttachment: (sessionId: string, attachmentId: string) => Promise<void>;
  cloneMessageAttachments: (sessionId: string, messageId: string) => Promise<CloneMessageAttachmentsResult>;
  onQueueEvent: (callback: (payload: QueueEventPayload) => void) => () => void;
  removeQueueListener: () => void;
  // P5：第 3 参 webOrigin（可选）——仅网页端 store 传 true（!!window.__claudeLinkWebBridge），
  // 主进程据此走免协商保存 + 一次性票据 HTTP 下载；桌面不传（undefined → false，全旧行为）。
  // round-001 review-report FIX-2a：第 4 参 originNonce（可选）——网页端 start 生成的一次性
  // nonce 透传（主进程回填 webDownloads.originNonce 供发起端防抢答比对）；桌面不传。
  startImageExport: (sessionId: string, format: import('../shared/types/export-image').ExportImageFormat, webOrigin?: boolean, originNonce?: string) => Promise<{ ok: true; jobId: string } | { ok: false; code: string; message: string }>;
  onImageExportProgress: (callback: (payload: import('../shared/types/export-image').ExportImageProgressPayload) => void) => () => void;
  // B4（D13-F3）：取消当前导出（仅捕获/编码阶段；无活动 job 或已终态时主进程返回 ok:false）。
  cancelImageExport: () => Promise<{ ok: boolean }>;
  // 原生 Slash Commands：读取某会话当前命令快照 + 监听全量替换。
  getSessionCommands: (sessionId: string) => Promise<SessionCommandSnapshot>;
  onCommandChanged: (callback: (payload: CommandChangedPayload) => void) => () => void;
  removeCommandListener: () => void;
  // D4：全局兜底快照热刷新广播（暂态会话命令菜单的实时更新通道）。
  onGlobalCommandsChanged: (callback: (payload: CommandGlobalChangedPayload) => void) => () => void;
  // S5：Skill 页「立即刷新」——绕过节流重探全局兜底快照，返回探测后快照（degraded/error 为失败终态）。
  refreshGlobalCommands: () => Promise<SessionCommandSnapshot>;
  // Task 3 Step 5：原生 settings 诊断摘要（脱敏，只回来源/CLAUDE.md 候选/生效键名）。
  getNativeSettingsDiagnostic: (cwd: string) => Promise<import('../shared/types/ipc').NativeSettingsDiagnostic>;
  // Task 8：命令来源 provenance 诊断（origin/availability 计数 + unknown/hidden 命令名，脱敏派生视图）。
  getCommandDiagnostics: (sessionId: string) => Promise<import('../shared/types/ipc').CommandProvenance>;
  // 项目级 Skill 管理左栏数据（最近工作区 ∪ 默认工作区 + 每目录项目 Skill 全集 + 会话计数）。
  getSkillProjectDirs: () => Promise<SkillProjectDirsPayload>;
  // MCP 管理（设置页 MCP Tab）：快照现查（只读无副作用）/ 管理库全量保存（主进程 saveConfig
  // 互斥链）/ 启停 override 单键翻转（返回最新全量，渲染层以此为准）/ 探活（single 恒单元素数组）。
  getMcpSnapshot: () => Promise<McpSnapshot>;
  saveMcpManaged: (servers: McpManagedSaveEntry[]) => Promise<{ ok: true }>;
  setMcpOverride: (key: string, enabled: boolean) => Promise<{ overrides: Record<string, 'off'> }>;
  probeMcpServers: (target: McpProbeTarget) => Promise<McpProbeReport[]>;
  // P8 双向写入：用户级/项目级 mcpServers 条目 upsert/remove（哨兵还原在主进程 writer；
  // overwrote = upsert 命中现有同名，remove 恒 false）。
  writeMcpScoped: (payload: McpWriteScopedPayload) => Promise<{ overwrote: boolean }>;
  // 作用域导出 JSON：主进程构建 {"mcpServers":{…}} 文本并写系统剪贴板（渲染层零明文，
  // 回包只有 count；count=0 未动剪贴板）。
  exportMcpScoped: (payload: McpExportScopedPayload) => Promise<{ ok: true; count: number }>;
  // 单服务器 JSON 解析（点2，表单⇄JSON 双模式「JSON → 表单」方向）：文本送主进程
  // parseMcpServersJson（三形态导入口径同导入弹窗），失败回 { ok: false, error } 不 throw。
  parseMcpJson: (text: string) => Promise<McpParseJsonResult>;
  // IM 机器人（飞书/微信 bridge）：凭据掩码读写 / 状态 / 连通测试 / 扫码登录 / 绑定管理。
  bridgeGetConfig: () => Promise<BridgeConfigGetResult>;
  bridgeSaveConfig: (input: BridgeConfigSaveInput) => Promise<BridgeConfigGetResult>;
  bridgeGetStatus: () => Promise<BridgePlatformStatusEntry[]>;
  bridgeTestFeishu: (input: { appId?: string; appSecret?: string }) => Promise<BridgeFeishuTestResult>;
  bridgeWechatQrcode: () => Promise<{ qrcodeId: string; qrcodeDataUrl: string }>;
  bridgeWechatQrcodeStatus: (qrcodeId: string) => Promise<WechatQrcodeStatusResult>;
  bridgeListBindings: () => Promise<BridgeBindingView[]>;
  bridgePlatformRestart: (platform: 'feishu' | 'wechat') => Promise<BridgePlatformStatusEntry[]>;
  onBridgeStatusChanged: (callback: (payload: BridgePlatformStatusEntry[]) => void) => () => void;
  /** A3（D01-F2/D12-F4）：桥接运行期自动建会话落库推送（载荷含 sessionId）。 */
  onBridgeSessionsUpserted: (callback: (payload: { sessionId: string }) => void) => () => void;
  /** 「网页访问」P2 4a：跨端会话列表同步通用信号（create/update→upsert、delete→delete）。
   *  桌面端自身发起的建/改/删同样收到（去抖重拉幂等，无害）；消费链 P4 接入。 */
  onSessionsChanged: (callback: (payload: { kind: 'upsert' | 'delete'; sessionId: string }) => void) => () => void;
  // 「网页访问（局域网）」P3（docs/plans/2026-10-20-web-access-plan.md §3-P3-4）：设置页
  // 信息卡（URL/二维码/令牌，token 走 URL hash）/ 令牌重生成（主进程同步踢全部已认证连接）/
  // 复制链接（主进程白名单校验：url ∈ 本次构建的 urls 才写剪贴板）。
  webAccessGetInfo: () => Promise<WebAccessInfoView>;
  webAccessRegenerateToken: () => Promise<{ token: string }>;
  webAccessCopyLink: (url: string) => Promise<{ ok: boolean }>;
  // 自绘 FilePickerDialog 的只读文件系统元数据（选择动作在渲染层；文件内容读取仍在主进程）。
  fsListRoots: () => Promise<FsRootsResult>;
  fsListDir: (target: string) => Promise<FsListResult>;
  fsMkdir: (parent: string, name: string) => Promise<FsMkdirResult>;
  fsStat: (path: string) => Promise<FsStatResult>;
  // 文件操作补齐（P2，docs/plans/2026-10-14-picker-file-ops-idea-parity-plan.md §2 P2）：
  // 同目录重命名 / 多选移入回收站（部分成功语义）/ 资源管理器定位。
  fsRename: (oldPath: string, newName: string) => Promise<FsRenameResult>;
  fsTrash: (paths: string[]) => Promise<FsTrashResult>;
  fsShowInExplorer: (path: string) => Promise<FsShowResult>;
  // 导出目标协商（T5）：主→渲染请求选择保存目标；渲染层选定后经 resolveTarget 应答。
  resolveExportTarget: (jobId: string, resp: ExportTargetResponse) => Promise<boolean>;
  onExportTargetRequested: (callback: (req: ExportTargetRequest) => void) => () => void;
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
    // 「网页访问（局域网）」P3：信息卡 / 令牌重生成 / 复制链接（CONFIG_* 邻近区域）。
    webAccessGetInfo: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_GET_INFO) as Promise<WebAccessInfoView>,
    webAccessRegenerateToken: () =>
      ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_REGENERATE_TOKEN) as Promise<{ token: string }>,
    webAccessCopyLink: (url) =>
      ipcRenderer.invoke(IPC_CHANNELS.WEB_ACCESS_COPY_LINK, url) as Promise<{ ok: boolean }>,
    getUpdateInfo: () => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_GET_INFO),
    checkForAppUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_CHECK),
    installAppUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_UPDATE_INSTALL),
    onUpdateStateChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, state: AppUpdateState) => callback(state);
      ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_STATE_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.APP_UPDATE_STATE_CHANGED, listener);
    },
    removeUpdateStateListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.APP_UPDATE_STATE_CHANGED),
    listRecentWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST_RECENT) as Promise<string[]>,
    addRecentWorkspace: (dir) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_ADD_RECENT, dir) as Promise<string[]>,
    removeRecentWorkspace: (dir) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT, dir) as Promise<string[]>,
    // P2 目录历史跨端同步（on* 模式照抄 onProvidersChanged）。
    onWorkspacesChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.WORKSPACES_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.WORKSPACES_CHANGED, listener);
    },
    removeWorkspacesListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.WORKSPACES_CHANGED),
    listProviders: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_LIST) as Promise<ProviderLibrarySnapshot>,
    saveProvider: (input) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_SAVE, input) as Promise<ProviderProfileView>,
    deleteProvider: (providerId) => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_DELETE, providerId),
    restoreProvider: () => ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_RESTORE) as Promise<ProviderProfileView>,
    queryProviderModels: (providerId, forceRefresh) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_QUERY_MODELS, providerId, forceRefresh === true) as Promise<ModelInfo[]>,
    testProviderModel: (providerId, modelId) =>
      ipcRenderer.invoke(IPC_CHANNELS.PROVIDER_TEST_MODEL, providerId, modelId) as Promise<{
        success: boolean;
        message: string;
        detail: string;
        durationMs: number;
      }>,
    onProvidersChanged: (callback) => {
      const listener = () => callback();
      ipcRenderer.on(IPC_CHANNELS.PROVIDERS_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.PROVIDERS_CHANGED, listener);
    },
    removeProvidersListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.PROVIDERS_CHANGED),
    listSessions: () => ipcRenderer.invoke(IPC_CHANNELS.SESSION_LIST),
    createSession: (name, spec) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_CREATE, name, spec),
    getSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_GET, id),
    getSessionMessages: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.MESSAGE_GET_BY_SESSION, sessionId),
    deleteSession: (id) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_DELETE, id),
    updateSession: (id, data) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_UPDATE, id, data),
    // P2 会话置顶（点 S4）：两参透传，主进程负责校验与广播。
    setSessionPinned: (sessionId, pinned) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_PINNED, sessionId, pinned),
    // P4 会话自动命名：首输入兜底名（两参透传，主进程负责校验/归一/广播）。
    setFallbackSessionName: (sessionId, text) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SET_FALLBACK_NAME, sessionId, text),
    recordTurnMeta: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_RECORD_TURN_META, sessionId, payload),
    searchSessions: (query) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_SEARCH, query),
    analyzeTopic: (sessionId, firstMessage) => ipcRenderer.invoke(IPC_CHANNELS.SESSION_ANALYZE_TOPIC, sessionId, firstMessage),
    sendMessage: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SEND, sessionId, payload),
    abortChat: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_ABORT, sessionId),
    setRunningPermissionMode: (sessionId, mode) => ipcRenderer.invoke(IPC_CHANNELS.CHAT_SET_PERMISSION_MODE, sessionId, mode),
    // SA-2（回合投影只读查询）：两通道直连主进程内存投影，无 DB/事件流副作用。
    getRuntimeSnapshot: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_RUNTIME_SNAPSHOT, sessionId) as Promise<TurnProjectionSnapshotView | null>,
    getRunningOverview: () =>
      ipcRenderer.invoke(IPC_CHANNELS.CHAT_RUNNING_OVERVIEW) as Promise<TurnRunningOverviewEntry[]>,
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
    getChangeDiff: (workingDir, path, context) => ipcRenderer.invoke(IPC_CHANNELS.CHANGES_DIFF, workingDir, path, context),
    openChangeFile: (workingDir, path, mode) => ipcRenderer.invoke(IPC_CHANNELS.CHANGES_OPEN_FILE, workingDir, path, mode),
    listTurnDiffSummaries: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TURN_DIFF_LIST_SUMMARIES, sessionId),
    getTurnFilePatch: (sessionId, turnStartMessageId, endMessageId, path) =>
      ipcRenderer.invoke(IPC_CHANNELS.TURN_DIFF_FILE_PATCH, sessionId, turnStartMessageId, endMessageId, path),
    addTask: (sessionId, payload) => ipcRenderer.invoke(IPC_CHANNELS.TASK_ADD, sessionId, payload),
    removeTask: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_REMOVE, taskId) as Promise<Task[]>,
    // D 点：后台任务终态输出文件只读（对象载荷 { outputFile }，对齐主进程 handler 入参形状）。
    readTaskOutput: (outputFile) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASK_OUTPUT_READ, { outputFile }) as Promise<{ content: string; truncated: boolean }>,
    getTasks: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET_ALL, sessionId),
    reorderTasks: (sessionId, taskIds) =>
      ipcRenderer.invoke(IPC_CHANNELS.TASK_REORDER, sessionId, taskIds) as Promise<Task[]>,
    setTaskPaused: (taskId, paused) => ipcRenderer.invoke(IPC_CHANNELS.TASK_SET_PAUSED, taskId, paused) as Promise<Task[]>,
    runTaskNow: (taskId) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RUN_NOW, taskId) as Promise<QueueOverview>,
    resumeAllQueue: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_RESUME_ALL, sessionId) as Promise<QueueOverview>,
    getQueueOverview: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_OVERVIEW, sessionId) as Promise<QueueOverview>,
    getClaudePlanState: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.CLAUDE_PLAN_GET, sessionId) as Promise<import('../shared/types/claude-plan').ClaudePlanState | null>,
    stageAttachmentPaths: (sessionId, paths) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_STAGE_PATHS, sessionId, paths) as Promise<PickAttachmentsResult>,
    stageAttachmentBytes: (input) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_STAGE_BYTES, input) as Promise<AttachmentSummary>,
    getAttachmentPreview: (request) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_PREVIEW, request) as Promise<AttachmentPreviewResponse>,
    removeDraftAttachment: (sessionId, attachmentId) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_REMOVE_DRAFT, sessionId, attachmentId),
    cloneMessageAttachments: (sessionId, messageId) => ipcRenderer.invoke(IPC_CHANNELS.ATTACHMENT_CLONE_MESSAGE, sessionId, messageId) as Promise<CloneMessageAttachmentsResult>,
    onQueueEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: QueueEventPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.QUEUE_EVENT, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.QUEUE_EVENT, listener);
    },
    removeQueueListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.QUEUE_EVENT),
    // 会话导出长图（v3 JPEG / v4.1 PNG 双格式）：可见 renderer 请求开始 + 接收进度。图片数据不经过可见 renderer。
    // P5：webOrigin 透传（无新方法，头注释方法数不变）。
    // round-001 review-report FIX-2a：originNonce 第 4 参透传（无新方法，头注释方法数 111 不变）。
    startImageExport: (sessionId: string, format: import('../shared/types/export-image').ExportImageFormat, webOrigin?: boolean, originNonce?: string) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IMAGE_START, sessionId, format, webOrigin, originNonce),
    onImageExportProgress: (callback: (payload: import('../shared/types/export-image').ExportImageProgressPayload) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: import('../shared/types/export-image').ExportImageProgressPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.EXPORT_IMAGE_PROGRESS, listener);
    },
    // B4（D13-F3）：用户取消导出（仅捕获/编码阶段有效）。
    cancelImageExport: () => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_IMAGE_CANCEL) as Promise<{ ok: boolean }>,
    getSessionCommands: (sessionId) => ipcRenderer.invoke(IPC_CHANNELS.COMMANDS_GET, sessionId) as Promise<SessionCommandSnapshot>,
    onCommandChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CommandChangedPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.COMMANDS_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.COMMANDS_CHANGED, listener);
    },
    removeCommandListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.COMMANDS_CHANGED),
    onGlobalCommandsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: CommandGlobalChangedPayload) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.COMMANDS_GLOBAL_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.COMMANDS_GLOBAL_CHANGED, listener);
    },
    refreshGlobalCommands: () => ipcRenderer.invoke(IPC_CHANNELS.COMMANDS_REFRESH_GLOBAL) as Promise<SessionCommandSnapshot>,
    getNativeSettingsDiagnostic: (cwd) =>
      ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET_DIAGNOSTIC, cwd) as Promise<import('../shared/types/ipc').NativeSettingsDiagnostic>,
    getCommandDiagnostics: (sessionId) =>
      ipcRenderer.invoke(IPC_CHANNELS.COMMANDS_GET_DIAGNOSTIC, sessionId) as Promise<import('../shared/types/ipc').CommandProvenance>,
    getSkillProjectDirs: () =>
      ipcRenderer.invoke(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET) as Promise<SkillProjectDirsPayload>,
    // MCP 管理（设置页 MCP Tab）四通道（P4）；OVERRIDE_SET body 为单对象 { key, enabled }。
    getMcpSnapshot: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_SNAPSHOT_GET) as Promise<McpSnapshot>,
    saveMcpManaged: (servers) => ipcRenderer.invoke(IPC_CHANNELS.MCP_MANAGED_SAVE, servers) as Promise<{ ok: true }>,
    setMcpOverride: (key, enabled) =>
      ipcRenderer.invoke(IPC_CHANNELS.MCP_OVERRIDE_SET, { key, enabled }) as Promise<{ overrides: Record<string, 'off'> }>,
    probeMcpServers: (target) => ipcRenderer.invoke(IPC_CHANNELS.MCP_PROBE, target) as Promise<McpProbeReport[]>,
    // P8 双向写入（对象载荷，对齐主进程 handler 入参形状）。
    writeMcpScoped: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MCP_WRITE_SCOPED, payload) as Promise<{ overwrote: boolean }>,
    // 作用域导出 JSON（对象载荷；主进程写剪贴板，回包零明文）。
    exportMcpScoped: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MCP_EXPORT_SCOPED, payload) as Promise<{ ok: true; count: number }>,
    // 单服务器 JSON 解析（点2；text 原样转发主进程 parseMcpServersJson，失败回包不 throw）。
    parseMcpJson: (text) => ipcRenderer.invoke(IPC_CHANNELS.MCP_PARSE_JSON, text) as Promise<McpParseJsonResult>,
    // IM 机器人（飞书/微信 bridge）。
    bridgeGetConfig: () => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_CONFIG_GET) as Promise<BridgeConfigGetResult>,
    bridgeSaveConfig: (input) => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_CONFIG_SAVE, input),
    bridgeGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_STATUS_GET),
    bridgeTestFeishu: (input) => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_FEISHU_TEST, input),
    bridgeWechatQrcode: () => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_WECHAT_QRCODE),
    bridgeWechatQrcodeStatus: (qrcodeId) => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_WECHAT_QRCODE_STATUS, qrcodeId),
    bridgeListBindings: () => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_BINDING_LIST),
    bridgePlatformRestart: (platform) => ipcRenderer.invoke(IPC_CHANNELS.BRIDGE_PLATFORM_RESTART, platform),
    onBridgeStatusChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: BridgePlatformStatusEntry[]) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.BRIDGE_STATUS_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.BRIDGE_STATUS_CHANGED, listener);
    },
    onBridgeSessionsUpserted: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { sessionId: string }) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.BRIDGE_SESSIONS_UPSERTED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.BRIDGE_SESSIONS_UPSERTED, listener);
    },
    // 「网页访问」P2 4a：跨端会话列表同步（on* 模式照抄邻近成员）。
    onSessionsChanged: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, payload: { kind: 'upsert' | 'delete'; sessionId: string }) => callback(payload);
      ipcRenderer.on(IPC_CHANNELS.SESSIONS_CHANGED, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.SESSIONS_CHANGED, listener);
    },
    // 自绘 FilePickerDialog 的只读文件系统元数据（T2；选择动作在渲染层）。
    fsListRoots: () => ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_ROOTS) as Promise<FsRootsResult>,
    fsListDir: (target) => ipcRenderer.invoke(IPC_CHANNELS.FS_LIST_DIR, target) as Promise<FsListResult>,
    fsMkdir: (parent, name) => ipcRenderer.invoke(IPC_CHANNELS.FS_MKDIR, parent, name) as Promise<FsMkdirResult>,
    fsStat: (p) => ipcRenderer.invoke(IPC_CHANNELS.FS_STAT, p) as Promise<FsStatResult>,
    // 文件操作补齐（P2）：两参以上走对象载荷，对齐主进程 handler 入参形状。
    fsRename: (oldPath, newName) => ipcRenderer.invoke(IPC_CHANNELS.FS_RENAME, { oldPath, newName }) as Promise<FsRenameResult>,
    fsTrash: (paths) => ipcRenderer.invoke(IPC_CHANNELS.FS_TRASH, { paths }) as Promise<FsTrashResult>,
    fsShowInExplorer: (path) => ipcRenderer.invoke(IPC_CHANNELS.FS_SHOW_IN_EXPLORER, { path }) as Promise<FsShowResult>,
    // 导出目标协商（T5）：应答主进程的保存目标请求 / 订阅请求推送（App.vue 全局单订阅者）。
    resolveExportTarget: (jobId, resp) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RESOLVE_TARGET, jobId, resp) as Promise<boolean>,
    onExportTargetRequested: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, req: ExportTargetRequest) => callback(req);
      ipcRenderer.on(IPC_CHANNELS.EXPORT_REQUEST_TARGET, listener);
      return () => ipcRenderer.off(IPC_CHANNELS.EXPORT_REQUEST_TARGET, listener);
    },
  };
}

// —— 导出窗口 surface ——
// 隐藏导出窗口（additionalArguments 注入 --claude-link-surface=export）只暴露最小 window.exportLink，
// 不接触主窗口完整 API（会话 CRUD / 聊天发送 / 任务队列 / 配置写入）。
// surface 参数不是唯一授权条件；主进程仍按 sender（webContents 同一性）/frame（顶层 frame）/job（jobId 匹配）校验每次调用；URL 防护由导出窗口创建时的 link-guard（导航拦截）承担，不在每次 IPC 调用中校验。
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
      // 单向推送，fire-and-forget；主进程仅校验 sender 与迟到 jobId 后转发给 origin（进度同时兼作看门狗进展证据），不做限频。
      ipcRenderer.send(IPC_CHANNELS.EXPORT_RENDER_PROGRESS, payload);
    },
    finish: (payload) => ipcRenderer.invoke(IPC_CHANNELS.EXPORT_RENDER_FINISH, payload),
  };
}
