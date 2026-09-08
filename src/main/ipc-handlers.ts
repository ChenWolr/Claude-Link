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
import { isValidThinkingLevel } from '../shared/types/thinking';
import { isValidPermissionMode } from '../shared/permission-resolver';
import { IPC_CHANNELS } from '../shared/constants';
import { clearConfig, getConfig, importSettingsFile, saveConfig, getLibrarySnapshot, saveProviderProfile, deleteProviderProfile, restoreDeletedProvider, getStoredProviderProfile, decryptProviderApiKey, recordLastUsedProviderModel, getConfigForRenderer } from './modules/config-manager';
import { detectClaudeConfig } from './modules/claude-config-detector';
import { runProviderModelTest } from './modules/connection-tester';
import { listRecentWorkspaces, addRecentWorkspace, removeRecentWorkspace } from './modules/workspace-history';
import { resolveDefaultModel } from '../shared/settings-parser';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';
import { spawnForChat, sendMessage, killProcess, getActiveProcess, markSessionDeleted, markSessionActive, startCommandProbe, getNativeSettingsDiagnostic, schedulePostTurnProbe, resolveCliSessionId, setRunningQueryPermissionMode, ensureGlobalCommandProbeFresh, isGlobalCliMissing } from './modules/chat-backend';
import { resolveCommandsGetResult } from '../shared/commands-get';
import { getUserOriginFingerprint, getProjectOriginFingerprint } from './modules/command-source-watcher';
import { resolveEffectivePermissionMode, type PermissionMode } from '../shared/permission-resolver';
import { sdkCommandRegistry, getCommandProvenance } from './modules/sdk-command-registry';
import { getPendingInteractionPrompts, respondToInteractionPrompt } from './modules/interaction-prompts';
import {
  beginUserTurn,
  noteTurnOutcome,
  abortHalt,
  armFromUserAction,
  runTaskNow,
  resumeAllTasks,
  getQueueOverview,
  onQueueEnabledChanged,
  drainCountdownIfNoRunnable,
  cleanupQueue,
} from './modules/task-queue-engine';
import { analyzeTopic } from './modules/topic-analyzer';
import { logger } from './utils/logger';
import * as sessionRepo from './database/repositories/session-repo';
import * as messageRepo from './database/repositories/message-repo';
import * as taskRepo from './database/repositories/task-repo';
import * as attachmentRepo from './database/repositories/attachment-repo';
import { cleanupSessionAttachments } from './modules/attachment-service';
import { createInteractionHistory, getInteractionHistory } from './database/repositories/interaction-history-repo';
import { getPlanState as getClaudePlanState } from './database/repositories/claude-plan-repo';
import { listChanges, getChangeDiff, openChangeFile } from './modules/changes-panel';
import { registerExportImageHandlers } from './modules/export-image-manager';
import { detectDirectImageFormat, validateChatSendPayloadShape, ATTACHMENT_READ_GUARD_BYTES, MAX_FILE_BYTES, formatBytes } from './modules/attachment-policy';
import {
  stageAttachment,
  stageTransientAttachment,
  bindTransientAttachmentsToSession,
  getAttachmentPreview,
  removeDraftAttachment,
  assertAttachmentsReadyForSend,
  cloneMessageAttachmentsToDraft,
  cleanupDetachedAttachments,
} from './modules/attachment-service';
import { prepareAttachmentPrompt } from './modules/attachment-prompt-builder';
import type { ChatSendPayload, SendMessageResult, AttachmentSummary } from '../shared/types/attachment';
import type { StageAttachmentBytesInput, AttachmentPreviewRequest, PickAttachmentsResult, SessionCreateSpec } from '../shared/types/ipc';

let mainWindow: BrowserWindow;

// F6（macOS dock 重开推演）：全量 IPC 注册只允许一次。重复调用（activate → createWindow
// 二次进入）在此守卫收口——先更新模块级 mainWindow 指向新窗（事件推送仍可达），再直接
// return，避免在第一个重复通道上同步抛 "Attempted to register a second handler"，导致
// createWindow 里 registerIpcHandlers 之后的 trackWindowSize 等初始化被跳过。全仓无
// removeHandler 调用，不采用逐通道重挂方案。
let ipcHandlersRegistered = false;

/** 会话级发送互斥：防止并发 CHAT_SEND 双落库/覆盖 pending。 */
const chatSendLocks = new Set<string>();

/** 供应商库内容变更 → 推送全部渲染方（设置页 + 会话选择器缓存）刷新。 */
function broadcastProvidersChanged(): void {
  try {
    mainWindow.webContents.send(IPC_CHANNELS.PROVIDERS_CHANGED);
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

export function registerIpcHandlers(mainWindowRef: BrowserWindow): void {
  mainWindow = mainWindowRef;
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  // CLI
  ipcMain.handle(IPC_CHANNELS.CLI_DETECT, async () => detectCli(true));
  ipcMain.handle(IPC_CHANNELS.CLI_GET_STATUS, async () => getCachedCliStatus() ?? detectCli());

  // 会话改动面板：列出 workingDir 的 git 改动 + 按需取单文件 diff（不抓快照，按需 git diff）。
  ipcMain.handle(IPC_CHANNELS.CHANGES_LIST, async (_event, workingDir: string | null, touchedPaths: string[]) =>
    listChanges(workingDir, touchedPaths));
  ipcMain.handle(IPC_CHANNELS.CHANGES_DIFF, async (_event, workingDir: string | null, path: string, context: number) =>
    getChangeDiff(workingDir, path, context));
  // 点文件「打开」：shell.openPath 走系统默认程序（仓库根解析 + 越界守卫在 openChangeFile 内）。
  ipcMain.handle(IPC_CHANNELS.CHANGES_OPEN_FILE, async (_event, workingDir: string | null, p: string) =>
    openChangeFile(workingDir, p));

  // Config
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => getConfigForRenderer());
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, partial: Partial<AppConfig>) => {
    // v3：queueEnabled 值变化 → 通知引擎（关：取消倒计时转 switch_off；开：仅清 reason 不 arm）。
    const prevQueueEnabled = getConfig().queueEnabled === true;
    const saved = saveConfig(partial);
    if ((saved.queueEnabled === true) !== prevQueueEnabled) {
      onQueueEnabledChanged(saved.queueEnabled === true, mainWindow);
    }
    // P3-6：回传给 renderer 的配置同样只带掩码（渲染层 UI 不显示明文 Key）。
    return getConfigForRenderer();
  });
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
  // 流式测试连接（弹框）已删除：测试收敛到 PROVIDER_TEST_MODEL（模型行内按钮，直返结果）。
  // Task 3 Step 5：原生 settings 诊断摘要（resolveSettings 脱敏视图：来源/CLAUDE.md 候选/生效键名，
  // 绝不含 effective 值/API key/env）。cwd 只做非空字符串校验——真实路径解析交给 SDK 与 findClaudeMdCandidates。
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_DIAGNOSTIC, async (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Invalid working directory');
    return getNativeSettingsDiagnostic(cwd);
  });

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
  // 永久删除某条最近目录历史（只移除历史记录，不触碰磁盘上的目录本体）。
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT, async (_event, dir: string) => removeRecentWorkspace(dir));

  // 多供应商模型库：设置页（可选项库）与 会话选择器（只读）共用。
  // 密钥边界：listProviders 只回掩码视图；save 的明文 key 落盘前加密；查询/行内测试都在主进程内解密。
  ipcMain.handle(IPC_CHANNELS.PROVIDER_LIST, async () => getLibrarySnapshot());
  ipcMain.handle(IPC_CHANNELS.PROVIDER_SAVE, async (_event, input) => {
    const view = saveProviderProfile(input);
    broadcastProvidersChanged();
    return view;
  });
  ipcMain.handle(IPC_CHANNELS.PROVIDER_DELETE, async (_event, providerId: string) => {
    deleteProviderProfile(providerId);
    broadcastProvidersChanged();
  });
  ipcMain.handle(IPC_CHANNELS.PROVIDER_RESTORE, async () => {
    const view = restoreDeletedProvider();
    broadcastProvidersChanged();
    return view;
  });
  ipcMain.handle(IPC_CHANNELS.PROVIDER_QUERY_MODELS, async (_event, providerId: string, forceRefresh?: boolean) => {
    if (typeof providerId !== 'string' || !providerId.trim()) throw new Error('Invalid provider id');
    const profile = getStoredProviderProfile(providerId);
    if (!profile) throw new Error('供应商不存在');
    const apiKey = decryptProviderApiKey(profile);
    if (!apiKey) throw new Error('该供应商未配置 API Key，无法查询；可在下拉框手动输入模型 ID 添加。');
    return fetchAvailableModels(profile, apiKey, forceRefresh === true);
  });
  // 模型行内测试（r5）：指定供应商 + 指定模型真实 spawn CLI，直返汇总结果。
  ipcMain.handle(IPC_CHANNELS.PROVIDER_TEST_MODEL, async (_event, providerId: string, modelId: string) => {
    if (typeof providerId !== 'string' || typeof modelId !== 'string') throw new Error('Invalid provider/model id');
    return runProviderModelTest(providerId, modelId);
  });

  // Sessions
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => sessionRepo.listSessions());
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, name: string, spec?: SessionCreateSpec) => {
    const config = getConfig();
    // 暂态物化：renderer 预生成的 id 直接沿用（草稿/附件/乐观消息 key 不迁移）。
    // spec 为空时行为与旧版完全一致（cdp-smoke-test 等直接调用方不受影响）。
    const specId = typeof spec?.id === 'string' && spec.id.trim() ? spec.id : undefined;
    if (specId && sessionRepo.getSession(specId)) throw new Error('会话 id 已存在');
    let session = sessionRepo.createSession(
      name,
      resolveDefaultModel(config.advancedJson),
      spec?.workingDir ?? null,
      specId,
    );
    // 暂态期间选定的供应商×模型 override 在建行时一并落库（白名单：仅接受 string，
    // 与 SESSION_UPDATE 同语义）；两者齐备时补记全局「最近使用」（与 SESSION_UPDATE 对齐）。
    const providerOverride = typeof spec?.providerOverride === 'string' ? spec.providerOverride : undefined;
    const modelOverride = typeof spec?.modelOverride === 'string' ? spec.modelOverride : undefined;
    // 权限档/思考强度同随物化落库（F-1）：null = 跟随全局默认（合法，与建行默认一致），
    // 非 null 非法值按 SESSION_UPDATE 同款白名单丢弃并记日志，不信任 renderer 传值。
    let specPermissionMode = spec?.permissionMode;
    if (specPermissionMode !== undefined && specPermissionMode !== null && !isValidPermissionMode(specPermissionMode)) {
      logger.warn(`[permission] invalid spec.permissionMode, discarding: ${String(specPermissionMode)}`);
      specPermissionMode = undefined;
    }
    let specThinkingLevel = spec?.thinkingLevel;
    if (specThinkingLevel !== undefined && specThinkingLevel !== null && !isValidThinkingLevel(specThinkingLevel)) {
      logger.warn(`[thinking] invalid spec.thinkingLevel, discarding: ${String(specThinkingLevel)}`);
      specThinkingLevel = undefined;
    }
    if (
      providerOverride !== undefined ||
      modelOverride !== undefined ||
      specPermissionMode !== undefined ||
      specThinkingLevel !== undefined
    ) {
      const patch: Partial<Pick<Session, 'providerOverride' | 'modelOverride' | 'permissionMode' | 'thinkingLevel'>> = {};
      if (providerOverride !== undefined) patch.providerOverride = providerOverride;
      if (modelOverride !== undefined) patch.modelOverride = modelOverride;
      if (specPermissionMode !== undefined) patch.permissionMode = specPermissionMode;
      if (specThinkingLevel !== undefined) patch.thinkingLevel = specThinkingLevel;
      session = sessionRepo.updateSession(session.id, patch) ?? session;
      if (providerOverride !== undefined && modelOverride !== undefined) {
        recordLastUsedProviderModel(providerOverride, modelOverride);
      }
    }
    // 暂态附件转正：物化建行后外键已满足，绑定为 draft 记录供 CHAT_SEND 校验/升格。
    if (spec?.bindTransientAttachmentIds?.length) {
      bindTransientAttachmentsToSession(session.id, spec.bindTransientAttachmentIds);
    }
    // Task 4/5：新会话创建后立即后台命令发现（control-only probe）。fire-and-forget——失败/无 exe 走
    // degraded，不阻塞会话创建返回；结果经 COMMANDS_CHANGED 推前端。
    // F1 修复：probe 用 activeSessions 做存活守卫，创建后必须先登记（markSessionActive），否则
    // startCommandProbe 首行 isSessionActive 守卫直接 return，探测根本不启动；删除时 markSessionDeleted 已撤销。
    markSessionActive(session.id);
    void startCommandProbe(session.id, mainWindow, {
      model: session.model,
      modelOverride: session.modelOverride,
      providerOverride: session.providerOverride,
      workingDir: session.workingDir,
      maxTurns: session.maxTurns,
      permissionMode: session.permissionMode,
      thinkingLevel: session.thinkingLevel,
    });
    return session;
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
    cleanupQueue(id);
    markSessionDeleted(id);
    killProcess(id, 'session_cleanup');
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
    async (
      _event,
      id: string,
      data: Partial<
        Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel' | 'providerOverride' | 'modelOverride'>
      >,
    ) => {
      // 白名单校验（review-v2 F11）：不信任 renderer 传值，非法 thinkingLevel 丢弃，
      // 合法 null（跟随默认）/ 有效档位放行。
      if (data.thinkingLevel !== undefined && data.thinkingLevel !== null && !isValidThinkingLevel(data.thinkingLevel)) {
        logger.warn(`[thinking] invalid thinkingLevel, discarding: ${String(data.thinkingLevel)}`);
        delete data.thinkingLevel;
      }
      // 权限模式同样白名单：只接受 null（跟随全局默认）/ 合法四档；非法值丢弃。
      if (data.permissionMode !== undefined && data.permissionMode !== null && !isValidPermissionMode(data.permissionMode)) {
        logger.warn(`[permission] invalid permissionMode, discarding: ${String(data.permissionMode)}`);
        delete data.permissionMode;
      }
      // 供应商/模型 override 同样白名单：只接受 string | null（实际模型 ID，非别名）。
      if (data.providerOverride !== undefined && data.providerOverride !== null && typeof data.providerOverride !== 'string') {
        logger.warn(`[session] invalid providerOverride, discarding: ${String(data.providerOverride)}`);
        delete data.providerOverride;
      }
      if (data.modelOverride !== undefined && data.modelOverride !== null && typeof data.modelOverride !== 'string') {
        logger.warn(`[session] invalid modelOverride, discarding: ${String(data.modelOverride)}`);
        delete data.modelOverride;
      }
      const touchedSelection =
        data.providerOverride !== undefined || data.modelOverride !== undefined;
      const updated = sessionRepo.updateSession(id, data);
      // 会话选用供应商×模型成功 → 更新全局「最近使用」记忆 + 老字段投影
      //（recordLastUsed 内部校验存在性，供应商/模型已删则静默跳过，解析层走回退链）。
      if (
        touchedSelection &&
        typeof data.providerOverride === 'string' &&
        typeof data.modelOverride === 'string' &&
        updated
      ) {
        recordLastUsedProviderModel(data.providerOverride, data.modelOverride);
      }
      // F3：工作目录变化影响 Skill/Plugin 可见性 → 重新探测命令（旧快照标 stale，新结果替换）。
      // N2：清除工作目录（workingDir: null）同样必须重新探测——旧目录的 Skill/Plugin 命令不再适用。
      if (data.workingDir !== undefined) {
        void startCommandProbe(id, mainWindow, { ...data });
      }
      return updated;
    },
  );
  // B1：回合元数据持久化（渲染层在 result 到达时 fire-and-forget 调用）。
  // 校验：会话必须存在；durationMs/endedAt 仅正数可写（非正/NaN/非 number → null）；
  // costUsd 仅正数可写（非正 → null，端点 0 值不展示 $0.0000 的既有语义）。
  // messageId 允许 null（后台分支无 attach 目标）；仅字符串 messageId 直传（AND session_id 守卫），
  // 命中失败/非字符串/null 一律回落主流程行查找（见 handler 内 B1 审查修复注释）。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_RECORD_TURN_META,
    async (
      _event,
      sessionId: string,
      payload: { messageId: string | null; costUsd: number | null; durationMs: number | null; endedAt: number | null },
    ) => {
      if (typeof sessionId !== 'string' || !sessionId) return null;
      if (!sessionRepo.getSession(sessionId)) return null;
      const pos = (v: unknown): number | null =>
        typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
      const durationMs = pos(payload?.durationMs);
      const endedAt = pos(payload?.endedAt);
      const costUsd = pos(payload?.costUsd);
      // B1 审查修复：渲染层乐观消息 id（crypto.randomUUID）与 DB 行 id（主进程 uuidv4）两套
      // uuid 永不相等，直传 messageId 恒 0 行。messageId 类型收窄（typeof string 且非空才直传，
      // 非字符串不做 String() 强转）：命中失败/为 null/非字符串（含后台分支的 null）一律回落
      // 「本回合主流程最后一条 assistant 行」查找（新→旧、遇 user 边界即停、跳过子 agent）；
      // 仍找不到则只写 sessions 半边，不报错（无 assistant 行的回合不产生脚注，诚实不造数）。
      const meta = { costUsd, durationMs };
      const directHit = typeof payload?.messageId === 'string' && payload.messageId
        ? messageRepo.updateResultMeta(payload.messageId, sessionId, meta)
        : false;
      if (!directHit) {
        const fallbackId = messageRepo.findLastTurnMainFlowAssistantId(sessionId);
        if (fallbackId) messageRepo.updateResultMeta(fallbackId, sessionId, meta);
      }
      sessionRepo.updateTurnMeta(sessionId, { durationMs, endedAt });
      return sessionRepo.getSession(sessionId);
    },
  );
  ipcMain.handle(IPC_CHANNELS.SESSION_SEARCH, async (_event, query: string) =>
    sessionRepo.searchSessions(query),
  );
  // OPT-10：会话级「单独改 model_override」的 IPC 死链已删除（模型选用唯一现场=供应商模型选择器
  // SESSION_SET_PROVIDER_MODEL；该通道在 renderer/store/repo 三层均无调用方）。
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

  // Claude 计划快照：按会话读取 TodoWrite / Task 工具的计划状态。
  // 独立于手动排队 tasks 表——不复用 task-repo。
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLAN_GET, async (_event, sessionId: string) =>
    getClaudePlanState(sessionId),
  );

  // 原生 Slash Commands：读取某会话当前命令快照（registry 已清洗 + 去重）。返回纯可克隆 snapshot，
  // 不返回 Query / SDK stream / 未经清洗的消息。
  ipcMain.handle(IPC_CHANNELS.COMMANDS_GET, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid session id');
    // D1 分流：先验证 DB 会话存在，再允许登记 active/启动 probe——不能把任意 renderer 输入当作会话
    // 生命周期事实。无 DB 行（暂态）不再 throw：只读返回全局兜底副本（source:'cache'），不 markSessionActive、
    // 不 startCommandProbe、不 schedulePostTurnProbe；分流决策统一在 shared 纯函数 resolveCommandsGetResult。
    const sessionRow = sessionRepo.getSession(sessionId);
    // P2-14：快照带项目级出生指纹时现算比对（无指纹的旧快照/无 cwd 会话跳过 IO）。
    const existingSnapshot = sdkCommandRegistry.get(sessionId);
    const currentProjectFingerprint = existingSnapshot?.projectOriginFingerprint !== undefined
      ? await getProjectOriginFingerprint(sessionRow?.workingDir ?? null)
      : undefined;
    const decision = resolveCommandsGetResult({
      sessionExists: Boolean(sessionRow),
      hasSnapshot: sdkCommandRegistry.has(sessionId),
      snapshot: sdkCommandRegistry.get(sessionId),
      fallback: sdkCommandRegistry.getGlobalFallback(),
      currentUserFingerprint: getUserOriginFingerprint(),
      currentProjectFingerprint,
      cliMissing: isGlobalCliMissing(),
    });
    if (decision.readOnly) {
      // D6：兜底未就绪（启动探测失败/未完成）时打开菜单即自然重试一次（60s 节流，fire-and-forget）。
      void ensureGlobalCommandProbeFresh(mainWindow);
      return decision.snapshot;
    }
    if (decision.needsFullProbeSideEffects) {
      // N6 修复：无 per-session 快照时 markSessionActive，让 startCommandProbe 下游 4 处 isSessionActive 守卫
      // 全部放行（与 SESSION_CREATE 一致；删除时 markSessionDeleted 已撤销）。否则重启后打开闲置旧会话，probe
      // 在 runCommandProbe 被 !isSessionActive 拦截、emitCommandChanged 不推送，命令永远 loading。
      markSessionActive(sessionId);
      void startCommandProbe(sessionId, mainWindow);
      // Task 3 Step 5（本计划）：重启后首次加载会话，若 DB 有 post-turn 探针持久化的占用值，
      // 预填 stale 后追加一次免费探针（~2s）——成功升级为 fresh 精确值，失败保持 stale 预填，
      // 无「待刷新」空态回归。probeInstance 用 0：重启后 renderer 无已知代际，0 会被接受并建立
      // 已知代际，随后真实回合代际单调递增覆盖。守卫在 schedulePostTurnProbe 内（仅无 running entry 时调度）。
      const reopenSession = sessionRepo.getSession(sessionId);
      if (reopenSession && typeof reopenSession.lastContextUsed === 'number' && reopenSession.lastContextUsed >= 0) {
        schedulePostTurnProbe(sessionId, mainWindow, 0, resolveCliSessionId(sessionId));
      }
    } else if (decision.needsRefreshProbeOnly) {
      // D5：用户级命令文件变更 → 旧会话快照过期。decision.snapshot 已是克隆 stale（UI「可能不是最新」），
      // 免费重探一次（幂等/N3 互斥/活跃 query 只标 stale 等全守卫在 startCommandProbe 内），
      // 完成后经 COMMANDS_CHANGED 推精确覆盖。不 markSessionActive（N5 的 DB 存活判据已放行）。
      void startCommandProbe(sessionId, mainWindow);
    }
    // 返回值统一由分流给出：per-session 快照 / 兜底 cache 副本 / stale 克隆 / loading 默认。
    return decision.snapshot;
  });
  // Task 8：命令来源 provenance 诊断（从已清洗快照派生的脱敏视图：origin/availability 计数 +
  // unknown/hidden 命令名）。只读、无副作用——不 markSessionActive、不触发 probe（区别于 COMMANDS_GET）。
  // sessionId 做非空校验；DB 会话存在性不强制（诊断对无快照会话也返回 total=0 空诊断，不抛错）。
  ipcMain.handle(IPC_CHANNELS.COMMANDS_GET_DIAGNOSTIC, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid session id');
    return getCommandProvenance(sessionId);
  });

  // Chat
  ipcMain.handle(IPC_CHANNELS.CHAT_SEND, async (_event, sessionId: string, payload: ChatSendPayload) => {
    // Task 4：校验 → prepare → 落库（附件保持 draft）→ spawn/send → 成功后升格 message。
    // spawn/send 同步失败则回滚消息关联，附件仍 draft，可原样重试（禁止再插第二条用户消息）。
    let locked = false;
    let spawned = false;
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

      // P1-6：prepareAttachmentPrompt 的读盘 await（大附件数百 ms）窗口内会话可能已被删除——
      // 落库前重查，避免 createMessage FK 报错刷屏 + 下方 spawn 把已删会话占坑（孤儿回合）。
      // 走既有失败路径：抛错由外层 catch 回滚（锁释放/附件 draft 保持/占坑清理）。
      if (!sessionRepo.getSession(sessionId)) {
        throw new Error(`Session ${sessionId} not found`);
      }

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
      const child = spawnForChat(sessionId, mainWindow, {
        model: session.model,
        modelOverride: session.modelOverride,
        providerOverride: session.providerOverride,
        workingDir: session.workingDir,
        // F2：三路执行链（直发/重发/队列）统一从全局设置取 maxTurns——session.maxTurns 的
        // DB 列默认 200 且渲染层从不写入，会话级值永远到不了设置，直发路径曾完全无视该设置。
        maxTurns: getConfig().maxTurns,
        permissionMode: session.permissionMode,
        thinkingLevel: session.thinkingLevel,
        resumeSessionId: session.cliSessionId,
        additionalDirectories: prepared.additionalDirectories,
        userCommandText: payload.text,
        // N4：带附件回合不参与 reasoning_replay 自动重试（重发载体是纯文本，照发丢图）。
        hasAttachments: prepared.attachmentIds.length > 0,
      });
      spawned = true;
      // v3 调度挂点：占坑成功即回合开始——插话顶掉倒计时 + 引擎置 running（规则 #4/#5）。
      beginUserTurn(sessionId, mainWindow);
      // exit 兜底：防普通回合 result 永久丢失时引擎 status 僵尸卡 running。
      // 幂等安全：正常路径 result 先到（emitExit 与 result 处理同一同步序列、中间无 await，
      // 新回合不可能插在两者之间），引擎 status 已非 running，arm/halt 双双 no-op。
      // 回合代际守卫（2026-09-06）：被中断/替换的旧回合 CLI 会滞留数秒才 emitExit，此刻若
      // 新回合已在途（entries 持别的活动 entry，含 pendingFirstPrompt 形态），旧 exit 不得对
      // 队列记账——否则在新回合 running 期间错误熔断转 standby，制造「UI 显示空闲但占坑未放」
      // 的假空闲窗口（2026-09-06 定案：中断→百毫秒级重发链路 5/5 复现）。自身出口触发时
      // getActiveProcess 恒为 undefined——entries 已空（result 分支/流末合成 aborted 的
      // deleteEntry 先于 emitExit 同 tick），或本 entry 已被 emitExit 置 finished/killed
      //（isEntryActive 恒假；catch 路径虽 entries 仍持本 entry 亦然）→ 照常兜底，result
      // 丢失防线不变。谓词实际语义=「有任何活动 entry 在途（必属别的回合）才拦」；
      // active !== child 为防御性子句（防 emitExit 未来改为先回调后置位），当前恒真。
      // 谓词警告：不得写成 getActiveProcess(sessionId) === child——自身出口触发时 active
      // 恒为 undefined，该写法恒假，会误杀兜底主场景（流丢 result）。
      child.on('exit', (code) => {
        const active = getActiveProcess(sessionId);
        if (active && active !== child) {
          logger.debug(`[chat-exit-fallback] session=${sessionId} 旧回合迟到 exit 被代际守卫拦截（新回合在途）`);
          return;
        }
        noteTurnOutcome(sessionId, code === 0 ? 'success' : 'error', mainWindow);
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
      if (spawned) {
        // spawn 已登记 entry/pending 后，后续同步步骤失败也必须收口，
        // 否则下一次发送会被误判为仍有活动回合。
        killProcess(sessionId, 'session_cleanup');
      }
      logger.error('Failed to send message', error);
      throw error;
    } finally {
      if (locked) chatSendLocks.delete(sessionId);
    }
  });

  ipcMain.handle(IPC_CHANNELS.CHAT_ABORT, async (_event, sessionId: string) => {
    killProcess(sessionId, 'user', mainWindowRef);
    // v3 熔断挂点：手动中断可能没有 result 事件（两段式 abort 兜底只 emitExit 不发事件），
    // 熔断必须同时挂在 CHAT_ABORT（守卫在 abortHalt 内：非 running 且无活动进程时 no-op）。
    abortHalt(sessionId, mainWindowRef);
  });

  // 批次二 #3：运行中回合中途切权限档。null（跟随全局）在主进程解析成有效档；
  // 无运行回合返回 false（渲染层回落「下一条消息生效」语义，不另提示）。
  // F3：白名单纵深防御——本入口曾是唯一不过 isValidPermissionMode 的会话 IPC（对齐
  // SESSION_CREATE/SESSION_UPDATE 先例），非法值丢弃按 null（跟随全局默认）处理并 warn，
  // 不把渲染层传来的未校验值直送 SDK setPermissionMode 控制帧。
  ipcMain.handle(IPC_CHANNELS.CHAT_SET_PERMISSION_MODE, async (_event, sessionId: string, mode: string | null) => {
    if (mode !== null && !isValidPermissionMode(mode as PermissionMode)) {
      logger.warn(`[permission] invalid running permissionMode, discarding: ${String(mode)}`);
      mode = null;
    }
    const effective = resolveEffectivePermissionMode(mode as PermissionMode | null, getConfig().permissionMode);
    return setRunningQueryPermissionMode(sessionId, effective);
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
  // v3 面板只展示 pending 任务：所有返回给渲染层的任务列表统一过滤 pending
  //（DB 里 running/failed 是执行残留行——status 仅崩溃恢复用，不进视图）。
  const pendingTasksOf = (sessionId: string) =>
    taskRepo.getTasksBySession(sessionId).filter((t) => t.status === 'pending');

  ipcMain.handle(IPC_CHANNELS.TASK_ADD, async (_event, sessionId: string, payload: ChatSendPayload) => {
    // Task 7B：任务附件接入。落库 task + 稳定 clientMessageId + 附件 links（status→task）。
    // 执行时由 popExecute 按 clientMessageId 创建/复用 user message、prepare 带附件的 prompt。
    // v3：返回 { task, tasks }——渲染层以返回的 tasks 为顺序权威（addTask 后立即反映真实排序）。
    const shape = validateChatSendPayloadShape(payload);
    if (!shape.ok) throw new Error(shape.message);
    assertAttachmentsReadyForSend(sessionId, payload.attachmentIds);
    // P2-16：sortOrder 用现存量 MAX+1（nextSortOrder），不再用 tasks.length——建-删-建后
    // 与现存行撞值导致排序不稳定。
    const sortOrder = taskRepo.nextSortOrder(sessionId);
    const task = taskRepo.createTaskWithAttachments(
      sessionId,
      payload.text.trim(),
      sortOrder,
      payload.attachmentIds,
      payload.clientMessageId,
    );
    return { task, tasks: pendingTasksOf(sessionId) };
  });

  ipcMain.handle(IPC_CHANNELS.TASK_REMOVE, async (_event, taskId: string) => {
    // Task 7B：解除 task_attachments 后，零引用附件（未执行的 pending task）删 row+文件；
    // 已升格为 message 的附件仍有引用，保留。
    // v3（语义表 #10）：删除后若该会话已无未暂停 pending → 取消倒计时转 standby；仍有 → 倒计时继续。
    const task = taskRepo.getTask(taskId);
    const attachmentIds = taskRepo.deleteTask(taskId);
    await cleanupDetachedAttachments(attachmentIds);
    if (task) drainCountdownIfNoRunnable(task.sessionId, mainWindow);
    return task ? pendingTasksOf(task.sessionId) : [];
  });

  ipcMain.handle(IPC_CHANNELS.TASK_GET_ALL, async (_event, sessionId: string) => {
    return pendingTasksOf(sessionId);
  });

  // 拖拽排序：只改执行顺序（到期取谁），不触碰倒计时。
  ipcMain.handle(IPC_CHANNELS.TASK_REORDER, async (_event, sessionId: string, taskIds: string[]) => {
    taskRepo.reorderTasks(sessionId, taskIds);
    return pendingTasksOf(sessionId);
  });

  // 任务级暂停/恢复（v3 语义表 #7/#9）：
  // 暂停 = 顺延；若已无未暂停 pending → 取消倒计时转 standby，仍有 → 倒计时继续（到期取新队首）。
  // 恢复 = 回待执行序列；standby 且无活动回合且开关开 → 立即全量倒计时；倒计时在走 → 不打断不重置。
  ipcMain.handle(IPC_CHANNELS.TASK_SET_PAUSED, async (_event, taskId: string, paused: unknown) => {
    const task = taskRepo.getTask(taskId);
    if (!task) throw new Error('任务不存在');
    const updated = taskRepo.setTaskPaused(taskId, paused === true);
    if (!updated) throw new Error('仅待执行（pending）任务可暂停/恢复');
    if (paused === true) {
      drainCountdownIfNoRunnable(task.sessionId, mainWindow);
    } else {
      armFromUserAction(task.sessionId, mainWindow);
    }
    return pendingTasksOf(task.sessionId);
  });

  // Queue（v3）
  // 立即执行：跳过倒计时立即出队（非队首=插队）；守卫失败抛错 → 渲染层 notice。
  ipcMain.handle(IPC_CHANNELS.TASK_RUN_NOW, async (_event, taskId: string) => {
    return runTaskNow(taskId, mainWindow);
  });

  // 熔断提示行「全部恢复」：全部 paused→pending + 立即开始全量倒计时。
  ipcMain.handle(IPC_CHANNELS.QUEUE_RESUME_ALL, async (_event, sessionId: string) => {
    return resumeAllTasks(sessionId, mainWindow);
  });

  // 面板全量数据：状态 + pending 任务 + 本次已执行历史。
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_OVERVIEW, async (_event, sessionId: string) => {
    return getQueueOverview(sessionId);
  });

  // 附件 IPC：选择 / 暂存字节（粘贴·拖放）/ 受控预览 / 移除草稿。
  // 文件读取与校验全部在主进程；renderer 只拿不透明附件 ID 与受控预览 bytes。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_PICK, async (_event, sessionId: string): Promise<PickAttachmentsResult> => {
    // 暂态会话（无 DB 行）：附件走无行暂存（内存 Map + 物理文件），物化时经
    // bindTransientAttachmentIds 转正；持久会话走原 stageAttachment 建 draft 行。
    const persisted = sessionRepo.getSession(sessionId);
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
        // P1-7：读入内存前先 stat 早退——数 GB 文件不再进 Buffer（防主进程 OOM）。
        // 错误形态与既有业务校验一致（逐项收集，不含内部路径）；精确的 10/30MiB
        // 区分仍由 stageAttachment 内的 validateAttachmentBytes 裁定（本守卫不动预算语义）。
        const st = await fsp.stat(filePath);
        if (st.size > ATTACHMENT_READ_GUARD_BYTES) {
          throw new Error(`文件「${filename}」超过 ${formatBytes(MAX_FILE_BYTES)} 上限。`);
        }
        const buf = await fsp.readFile(filePath);
        const bytes = new Uint8Array(buf);
        // 据魔数识别真实图片格式，避免靠扩展名把伪装图片当 image 直传。
        const detected = detectDirectImageFormat(bytes);
        const staged = persisted
          ? await stageAttachment({ id: randomUUID(), sessionId, filename, mimeType: detected ?? '', bytes })
          : await stageTransientAttachment({ id: randomUUID(), sessionId, filename, mimeType: detected ?? '', bytes });
        attachments.push(staged);
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
      // 暂态会话（无 DB 行）走无行暂存；持久会话走原 stageAttachment 建 draft 行。
      const persisted = sessionRepo.getSession(input.sessionId);
      // 主进程重新校验：不信任 renderer 传来的大小/MIME，由 policy 二次裁定。
      const detected = detectDirectImageFormat(input.bytes);
      const stage = persisted ? stageAttachment : stageTransientAttachment;
      return stage({
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

  // 克隆历史消息附件为草稿：异步发送失败后「重新编辑发送」用；跨会话防护在 service 内。
  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_CLONE_MESSAGE,
    async (_event, sessionId: string, messageId: string): Promise<AttachmentSummary[]> =>
      cloneMessageAttachmentsToDraft(sessionId, messageId),
  );

  // 会话导出 JPEG 长图（v3）：注册主窗口开始 + 隐藏 renderer 专用 IPC。
  registerExportImageHandlers();
}
