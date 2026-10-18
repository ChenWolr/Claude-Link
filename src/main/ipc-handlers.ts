// ipc-handlers.ts
// IPC handler 注册中心：渲染进程 ↔ 主进程的桥梁。
//
// 注册 cli / config / workspace / provider / changes / settings / skill / session / message / claude-plan / commands / chat / interaction / task / queue / attachment / bridge 全部 invoke 通道，并委托 registerExportImageHandlers 注册导出窗口专用通道。
// 渲染进程经 preload 的 window.claudeLink.xxx() → ipcRenderer.invoke → 此处 ipcMain.handle 路由到对应模块。

import { BrowserWindow, clipboard, ipcMain, app, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs'; // hb10-CFG-09：workingDirectory 同步存在性/目录校验
import path from 'node:path';
import os from 'node:os';
import type { AppConfig } from '../shared/types/config';
import type { Session } from '../shared/types/session';
import { isValidThinkingLevel } from '../shared/types/thinking';
import { isValidPermissionMode } from '../shared/permission-resolver';
import { normalizeDirKey, mergeProjectDirs } from '../shared/project-skills';
import { IPC_CHANNELS } from '../shared/constants';
import { getAppUpdateInfo, checkForAppUpdates, installAppUpdate } from './modules/app-updater';
import { clearConfig, getConfig, saveConfig, getLibrarySnapshot, saveProviderProfile, deleteProviderProfile, restoreDeletedProvider, getStoredProviderProfile, decryptProviderApiKey, recordLastUsedProviderModel, getConfigForRenderer, DECRYPT_FAILED } from './modules/config-manager';
import { runProviderModelTest } from './modules/connection-tester';
import { listRecentWorkspaces, addRecentWorkspace, removeRecentWorkspace } from './modules/workspace-history';
import { listRoots, listDir, mkdir, statPath, isValidFolderName, renamePath } from './modules/fs-picker';
import type { FsTrashFailure } from '../shared/types/fs-picker';
import { badDirCacheHas, badDirCacheMark, collectSkillProjectDirs, collectUserSkillDirNames } from './modules/project-skills';
import { effectiveUserHome } from './modules/sdk-backend';
import { resolveDefaultModel } from '../shared/settings-parser';
import { detectCli, getCachedCliStatus } from './modules/cli-detector';
import { fetchAvailableModels } from './modules/model-resolver';
import { spawnForChat, sendMessage, killProcess, getActiveProcess, markSessionDeleted, markSessionActive, startCommandProbe, getNativeSettingsDiagnostic, schedulePostTurnProbe, resolveCliSessionId, setRunningQueryPermissionMode, ensureGlobalCommandProbeFresh, isGlobalCliMissing, clearSessionPermissionBook, getKnownTurnOutcome, isGlobalProbeFailed, isCommandProbeInFlight } from './modules/chat-backend';
import { buildSessionSkillOverridesForPin } from './modules/sdk-skill-overrides';
import { buildSessionMcpOverridesForPin } from './modules/mcp/sdk-mcp';
import {
  buildMcpServersExportJson,
  restoreMaskedMcpServers,
  sanitizeMcpServersConfig,
  type McpManagedSaveEntry,
} from './modules/mcp/mcp-config';
import { collectMcpSnapshot, readProjectMcpServersRawSync, readUserMcpServersRawSync } from './modules/mcp/mcp-scanner';
import { writeScopedMcpServer, type ScopedMcpEntry } from './modules/mcp/mcp-writer';
import {
  dropProbeCacheByPrefix,
  getCachedProbeReports,
  hasFreshCache,
  mcpProbeKey,
  probeAllManaged,
  probeMcpServer,
  pruneProbeCache,
  type McpProbeInput,
  type McpProbeReport,
} from './modules/mcp/mcp-probe';
import { resolveCommandsGetResult } from '../shared/commands-get';
import { isChatSendLocked, acquireChatSendLock, releaseChatSendLock } from './modules/chat-send-locks';
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
import { getConnection } from './database/connection'; // hb12-TM-03：recordTurnMeta 两 UPDATE 包事务
import * as taskRepo from './database/repositories/task-repo';
import * as attachmentRepo from './database/repositories/attachment-repo';
import { cleanupSessionAttachments } from './modules/attachment-service';
import { createInteractionHistory, getInteractionHistory } from './database/repositories/interaction-history-repo';
import { getPlanState as getClaudePlanState } from './database/repositories/claude-plan-repo';
import { listChanges, getChangeDiff, openChangeFile } from './modules/changes-panel';
import { registerExportImageHandlers, resolveExportTarget } from './modules/export-image-manager';
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
  listDraftQuotaItems,
} from './modules/attachment-service';
import { DRAFT_QUOTA_MAX_COUNT } from '../shared/draft-attachment-quota';
import { prepareAttachmentPrompt } from './modules/attachment-prompt-builder';
import type { ChatSendPayload, SendMessageResult, AttachmentSummary, CloneMessageAttachmentsResult } from '../shared/types/attachment';
import type { BridgeConfigSaveInput } from '../shared/types/bridge';
import {
  bridgeConfigGet, bridgeConfigSave, bridgeStatusGet, bridgeFeishuTest,
  bridgeWechatQrcode, bridgeWechatQrcodeStatus, bridgeBindingList,
  bridgePlatformRestart,
} from './modules/bridge/init';
import type { StageAttachmentBytesInput, AttachmentPreviewRequest, PickAttachmentsResult, SessionCreateSpec } from '../shared/types/ipc';

let mainWindow: BrowserWindow;

// F6（macOS dock 重开推演）：全量 IPC 注册只允许一次。重复调用（activate → createWindow
// 二次进入）在此守卫收口——先更新模块级 mainWindow 指向新窗（事件推送仍可达），再直接
// return，避免在第一个重复通道上同步抛 "Attempted to register a second handler"，导致
// createWindow 里 registerIpcHandlers 之后的 trackWindowSize 等初始化被跳过。全仓无
// removeHandler 调用，不采用逐通道重挂方案。
let ipcHandlersRegistered = false;

/** 供应商库内容变更 → 推送全部渲染方（设置页 + 会话选择器缓存）刷新。 */
function broadcastProvidersChanged(): void {
  try {
    mainWindow.webContents.send(IPC_CHANNELS.PROVIDERS_CHANGED);
  } catch {
    // webContents 可能已销毁（窗口关闭），忽略
  }
}

// bridge 会话锁定装饰（review 2026-09-25 P1 收类）：SESSION_GET/SESSION_UPDATE 单行出口附带 bridgePlatform，
// 防渲染层整体替换 activeSession/列表行的路径（改名等）丢锁定标记；SESSION_CREATE 新会话不可能已绑定，无需附带。
function withBridgePlatform<T extends { id: string }>(session: T) {
  const platform = bridgeBindingList().find((b) => b.sessionId === session.id)?.platform ?? null;
  return { ...session, bridgePlatform: platform };
}

/**
 * 附件路径暂存链（原附件选择 handler 内 dialog 之后的整段，逻辑逐行保留）：
 * 草稿余量预检（10 上限）→ stat 早退（ATTACHMENT_READ_GUARD_BYTES）→ 读盘 → 魔数探测 →
 * 暂态/持久暂存 → 逐项错误收集。选择动作已移渲染层（FilePickerDialog），本函数只负责
 * 校验/读盘/暂存——路径由渲染层用户选择后传入，与原生框用户选择等价。
 */
export async function stageAttachmentPaths(sessionId: string, filePaths: string[]): Promise<PickAttachmentsResult> {
  // 暂态会话（无 DB 行）：附件走无行暂存（内存 Map + 物理文件），物化时经
  // bindTransientAttachmentIds 转正；持久会话走原 stageAttachment 建 draft 行。
  const persisted = sessionRepo.getSession(sessionId);
  // A11（D08-F1）+ hb10-ATT-06：一次最多 10 个附件——暂存即限量；旧「本次多选 ≤10」
  // slice 截断不感知草稿余量且被截断文件无提示，已废——改为按「当前草稿余量」预检：
  // 余量外的文件不读盘直接进 errors（D08-F10 提示缺口顺带），余量内的才走读盘暂存链。
  const room = DRAFT_QUOTA_MAX_COUNT - listDraftQuotaItems(sessionId).length;
  const stagedPaths = room <= 0 ? [] : filePaths.slice(0, room);
  const attachments: AttachmentSummary[] = [];
  const errors: Array<{ filename: string; message: string }> = [];
  for (const skipped of filePaths.slice(stagedPaths.length)) {
    errors.push({ filename: path.basename(skipped), message: '草稿附件已达 10 个上限，已忽略' });
  }
  for (const filePath of stagedPaths) {
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
      // hb10-ATT-07：错误文案脱敏——FK/ENOENT 类内部错误串（可能含绝对路径）不出主进程，原文仅 logger。
      const rawMessage = e instanceof Error ? e.message : String(e);
      const safeMessage = /ENOENT|no such file|SQLITE_CONSTRAINT|FOREIGN KEY/i.test(rawMessage)
        ? '部分附件保存失败（可能已被删除）'
        : rawMessage;
      if (safeMessage !== rawMessage) logger.warn(`[attachment-pick] sanitized error: ${rawMessage}`);
      errors.push({ filename, message: safeMessage });
    }
  }
  return { attachments, errors };
}

export function registerIpcHandlers(mainWindowRef: BrowserWindow): void {
  // hb10-CMD-10：needsRefreshProbeOnly 重探节流时间戳（registerIpcHandlers 单次注册闭包内，ipcHandlersRegistered 守卫保证语义等效模块级进程内单例）。
  let lastProbeOnlyAt = 0;

  mainWindow = mainWindowRef;
  if (ipcHandlersRegistered) return;
  ipcHandlersRegistered = true;

  // CLI
  ipcMain.handle(IPC_CHANNELS.CLI_DETECT, async () => detectCli(true));
  ipcMain.handle(IPC_CHANNELS.CLI_GET_STATUS, async () => getCachedCliStatus() ?? detectCli());

  // 会话改动面板：列出 workingDir 的 git 改动 + 按需取单文件 diff（不抓快照，按需 git diff）。
  // hb10 P2-8：三通道 workingDir 绑定——主进程无「当前活动会话」追踪，允许集=全局配置工作目录
  // ∪ 会话库全部工作目录（分隔符/大小写归一比对；win 大小写不敏感）。受损 renderer 不得对
  // 任意目录跑 git。null 沿既有降级链路放行（listChanges 内部按无目录处理）。
  const normDir = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const isBoundWorkingDir = (dir: string | null): boolean => {
    if (dir === null) return true;
    if (typeof dir !== 'string' || !dir.trim()) return false;
    const configDir = getConfig().workingDirectory;
    if (configDir && normDir(configDir) === normDir(dir)) return true;
    return sessionRepo.listSessions().some((s) => (s.workingDir ? normDir(s.workingDir) === normDir(dir) : false));
  };
  ipcMain.handle(IPC_CHANNELS.CHANGES_LIST, async (_event, workingDir: string | null, touchedPaths: string[]) => {
    if (!isBoundWorkingDir(workingDir)) return { ok: false, reason: 'error', message: '工作目录不在允许列表' };
    return listChanges(workingDir, touchedPaths);
  });
  ipcMain.handle(IPC_CHANNELS.CHANGES_DIFF, async (_event, workingDir: string | null, path: string, context: number) => {
    if (!isBoundWorkingDir(workingDir)) return { ok: false, reason: 'error', message: '工作目录不在允许列表' };
    // hb10 P2-7：-U context 钳制——非整数/负数/超界回落默认 3（防 -UNaN「整文件当新增」假象）。
    const safeContext = Number.isInteger(context) && context >= 0 && context <= 100000 ? context : 3;
    return getChangeDiff(workingDir, path, safeContext);
  });
  // 点文件「打开」：shell.openPath 走系统默认程序（仓库根解析 + 越界守卫在 openChangeFile 内）。
  ipcMain.handle(IPC_CHANNELS.CHANGES_OPEN_FILE, async (_event, workingDir: string | null, p: string) => {
    if (!isBoundWorkingDir(workingDir)) return { ok: false, reason: 'error', message: '工作目录不在允许列表' };
    return openChangeFile(workingDir, p);
  });

  // Config
  ipcMain.handle(IPC_CHANNELS.CONFIG_GET, async () => getConfigForRenderer());
  ipcMain.handle(IPC_CHANNELS.CONFIG_SAVE, async (_event, partial: Partial<AppConfig>) => {
    // MCP 管理库/启停只经 mcp:managedSave / mcp:overrideSet 专用通道写入——渲染层整包回显携带的
    // mcpServers/mcpOverrides 可能陈旧（专用通道保存后 store.config 未即时回写），照收会静默回滚
    // 专用通道的落盘结果（同 hb12-P2-6 lastUsed 剥离理由）。剥离后回包仍下发主进程最新 MCP 值，
    // 渲染层镜像反而经回包同步为权威态。（置于守卫块之前：与目录校验独立、均先于 saveConfig；
    // 且 warn 行 [CONFIG_SAVE] 字面量是 tdd-queue-v3 400 字符邻近断言的锚点，其后不可再插入内容。）
    if (partial) { delete partial.mcpServers; delete partial.mcpOverrides; }
    // hb10-CFG-09：workingDirectory 必须真实存在且为目录——否则丢弃该字段（保留旧值）。
    // 坏目录入库后 spawn/投影/诊断处处失败。丢弃非硬失败：回传值保持旧目录，
    // 渲染层比对所送值与回传值不一致后给 notice（见 config-store.saveConfig）。
    if (partial && typeof partial.workingDirectory === 'string' && partial.workingDirectory) {
      let dirOk = false;
      try {
        dirOk = fs.existsSync(partial.workingDirectory) && fs.statSync(partial.workingDirectory).isDirectory();
      } catch {
        dirOk = false;
      }
      if (!dirOk) {
        const { workingDirectory: rejectedWorkingDirectory, ...rest } = partial;
        partial = rest;
        logger.warn(`[CONFIG_SAVE] workingDirectory 非有效目录，已丢弃并保留旧值：${rejectedWorkingDirectory}`);
      }
    }
    // v3：queueEnabled 值变化 → 通知引擎（关：取消倒计时转 switch_off；开：仅清 reason 不 arm）。
    const prevQueueEnabled = getConfig().queueEnabled === true;
    const saved = saveConfig(partial);
    if ((saved.queueEnabled === true) !== prevQueueEnabled) {
      onQueueEnabledChanged(saved.queueEnabled === true, mainWindow);
    }
    // P3-6：回传给 renderer 的配置同样只带掩码（渲染层 UI 不显示明文 Key）。
    // hb13-v B3（F-04）：回传补带 projectionOk——getConfigForRenderer 不含该字段，旧回传使
    // 「已保存（投影失败）」徽标条件恒 false（hb10-CFG-04 端到端死代码）。
    return { ...getConfigForRenderer(), projectionOk: saved.projectionOk };
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
  // 应用内检查更新（electron-updater / GitHub Releases；实现见 modules/app-updater.ts）。
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_GET_INFO, async () => getAppUpdateInfo());
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_CHECK, async () => checkForAppUpdates());
  ipcMain.handle(IPC_CHANNELS.APP_UPDATE_INSTALL, async () => installAppUpdate());
  // settings.json 导入/选档/自动检测三条死通道（原 config:importSettings 等三个 channel）
  // 已于 2026-09-20 整链删除：无 UI 入口却保留明文 apiKey 回传渲染进程的通道。
  // 流式测试连接（弹框）已删除：测试收敛到 PROVIDER_TEST_MODEL（模型行内按钮，直返结果）。
  // Task 3 Step 5：原生 settings 诊断摘要（resolveSettings 脱敏视图：来源/CLAUDE.md 候选/生效键名，
  // 绝不含 effective 值/API key/env）。cwd 只做非空字符串校验——真实路径解析交给 SDK 与 findClaudeMdCandidates。
  ipcMain.handle(IPC_CHANNELS.SETTINGS_GET_DIAGNOSTIC, async (_event, cwd: unknown) => {
    if (typeof cwd !== 'string' || !cwd.trim()) throw new Error('Invalid working directory');
    return getNativeSettingsDiagnostic(cwd);
  });

  // Workspace（工作空间）：最近历史。Claude Code 基于某目录运行，会话可绑定并复用历史目录。
  // 选目录原生弹窗通道（workspace:pickDir）已于 T3 整链删除——两入口改渲染层自绘
  // FilePickerDialog（fs-picker-store），最近历史经 WORKSPACE_ADD_RECENT 显式回写。
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST_RECENT, async () => listRecentWorkspaces());
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_ADD_RECENT, async (_event, dir: string) => addRecentWorkspace(dir));
  // 永久删除某条最近目录历史（只移除历史记录，不触碰磁盘上的目录本体）。
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT, async (_event, dir: string) => removeRecentWorkspace(dir));

  // 自绘 FilePickerDialog 的只读文件系统元数据（详见 modules/fs-picker.ts）。
  ipcMain.handle(IPC_CHANNELS.FS_LIST_ROOTS, async () => listRoots());
  ipcMain.handle(IPC_CHANNELS.FS_LIST_DIR, async (_event, target: string) => {
    if (typeof target !== 'string' || !target.trim()) throw new Error('Invalid directory path');
    return listDir(target);
  });
  ipcMain.handle(IPC_CHANNELS.FS_MKDIR, async (_event, parent: string, name: string) => {
    if (typeof parent !== 'string' || !parent.trim() || typeof name !== 'string') throw new Error('Invalid mkdir arguments');
    return mkdir(parent, name);
  });
  ipcMain.handle(IPC_CHANNELS.FS_STAT, async (_event, p: string) => {
    if (typeof p !== 'string' || !p.trim()) throw new Error('Invalid path');
    return statPath(p);
  });
  // 文件操作补齐三通道（docs/plans/2026-10-14-picker-file-ops-idea-parity-plan.md §2 P2）。
  // FS_RENAME：同目录重命名，两参走对象载荷；入参 typeof 校验（既有形态），名称/冲突/存在性判定交给 renamePath。
  ipcMain.handle(IPC_CHANNELS.FS_RENAME, async (_event, req: unknown) => {
    const r = (req ?? {}) as Record<string, unknown>;
    if (typeof r.oldPath !== 'string' || !r.oldPath.trim() || typeof r.newName !== 'string') throw new Error('Invalid rename arguments');
    return renamePath(r.oldPath, r.newName);
  });
  // FS_TRASH：多选移入回收站。入参温和校验（非数组/空数组/超 200/含非 string）→ 不抛异常，返回逐项
  // error 的温和拒绝结果；随后逐项【串行】await shell.trashItem（回收站 shell 调用不宜并发轰炸），
  // 失败按 errno 映射（ENOENT→not-found，其余含网络位置不支持→error）入 failed，尽力而为不停（部分成功语义）。
  ipcMain.handle(IPC_CHANNELS.FS_TRASH, async (_event, req: unknown) => {
    const r = (req ?? {}) as Record<string, unknown>; // preload 发对象载荷 { paths }（对齐 FS_RENAME 解构形态）
    const paths = r.paths;
    const strItems = Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [];
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > 200 || strItems.length !== paths.length) {
      return { ok: false, trashed: [] as string[], failed: strItems.map((p) => ({ path: p, error: 'error' as const })) };
    }
    const trashed: string[] = [];
    const failed: FsTrashFailure[] = [];
    for (const p of strItems) {
      try {
        await shell.trashItem(p);
        trashed.push(p);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException | null)?.code;
        failed.push({ path: p, error: code === 'ENOENT' ? 'not-found' : 'error' });
      }
    }
    return { ok: failed.length === 0, trashed, failed };
  });
  // FS_SHOW_IN_EXPLORER：资源管理器定位。路径不存在时 Electron 静默不弹；异常兜底归 ok:false（渲染层静默降级不报错）。
  ipcMain.handle(IPC_CHANNELS.FS_SHOW_IN_EXPLORER, async (_event, req: unknown) => {
    const r = (req ?? {}) as Record<string, unknown>; // preload 发对象载荷 { path }（对齐 FS_RENAME 解构形态）
    if (typeof r.path !== 'string' || !r.path.trim()) throw new Error('Invalid path');
    try {
      await shell.showItemInFolder(r.path);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  // 导出目标协商应答（T5）：渲染层 FilePickerDialog 选定后回传；jobId 在 Map 中才有效（防重放/伪造他人 job）。
  ipcMain.handle(IPC_CHANNELS.EXPORT_RESOLVE_TARGET, async (_event, jobId: unknown, resp: unknown) => {
    if (typeof jobId !== 'string' || !jobId) throw new Error('Invalid export target jobId');
    // resp 形状 + 内容校验（P2-1 纵深防御）：directory/save 的 dir 必须绝对路径；save 的 filename
    // 复用 isValidFolderName（非法字符/结尾点空格/长度 ≤255）——渲染层 FilePickerDialog 本就传
    // trim 后的合法值，此处仅防被攻破/出 bug 的渲染层传 '..\\..\\x.png'（穿越）或相对 dir。
    let ok = false;
    if (resp && typeof resp === 'object') {
      const r = resp as Record<string, unknown>;
      if (r.kind === 'directory' && typeof r.dir === 'string' && r.dir.trim() && path.isAbsolute(r.dir)) ok = true;
      else if (r.kind === 'save' && typeof r.dir === 'string' && r.dir.trim() && path.isAbsolute(r.dir)
        && typeof r.filename === 'string' && r.filename.trim() && isValidFolderName(r.filename.trim())) ok = true;
      else if (r.kind === 'cancel' && (r.reason === 'user' || r.reason === 'timeout' || r.reason === 'window-closed')) ok = true;
    }
    if (!ok) throw new Error('Invalid export target response');
    // save 应答的 filename 统一以 trim 后形态下发（下游 performSave join(dir, filename) 用）。
    const normalized = resp && typeof resp === 'object' && (resp as Record<string, unknown>).kind === 'save'
      ? { ...(resp as Record<string, unknown>), filename: ((resp as Record<string, unknown>).filename as string).trim() }
      : resp;
    return resolveExportTarget(jobId, normalized as import('../shared/types/fs-picker').ExportTargetResponse);
  });

  // 项目级 Skill 管理左栏数据（方案 B 双栏）：最近工作区 ∪ 默认工作区（存在性过滤，
  // 磁盘上已删除的目录不再显示）+ 每目录直读 .claude\skills 的项目 Skill 全集 + 会话计数。
  // 只读、无副作用；全链 async + 每目录 3s 超时预算（R-1：不可达 UNC/断连映射盘不再同步
  // 占死主进程），每次进 Skill tab 现查。
  ipcMain.handle(IPC_CHANNELS.SKILL_PROJECT_DIRS_GET, async () => {
    // Y-1（2026-09-19 X-123 批评审 §2）：用户根映射先取（独立单槽共享）；null 哨兵=枚举超时——
    // 载荷恒回对象 + 超时标记（渲染层据此不覆盖映射槽/不置就绪旗标），dirs 三源 await 内联不动。
    // A10（D07-F2）：用户根与全链同口径（effectiveUserHome = 子进程实际生效 USERPROFILE/HOME，
    // 与证据扫描/command-source-watcher 同源）——advancedJson.env 覆盖 home 时映射不再扫错根；
    // 无覆盖时二者同值，行为不变。undefined 回退宿主 home（按函数语义核对）。
    const userDirNames = await collectUserSkillDirNames(path.join(effectiveUserHome() ?? os.homedir(), '.claude', 'skills'));
    return {
      dirs: await collectSkillProjectDirs({
        recentDirs: listRecentWorkspaces(),
        defaultDir: getConfig().workingDirectory ?? null,
        sessionCounts: sessionRepo.listWorkingDirCounts(),
      }),
      // R-1（2026-09-19）：全局作用域（~/.claude/skills）fm 名→目录名映射，与项目清单同拍现查
      // （开关键=目录名口径的数据源）；rootDir 由本侧组装，collectUserSkillDirNames 参数化
      // 不硬编码用户目录（契约以夹具直测）。
      userSkillDirNames: userDirNames ?? {},
      userSkillDirNamesTimedOut: userDirNames === null,
    };
  });

  // MCP 管理（设置页 MCP Tab）四 handler（docs/plans/2026-10-12-mcp-management-plan.md §2 P4）。
  // 快照：现查无副作用（同 skills:projectDirsGet 先例，依赖取法完全同源）——用户根
  // effectiveUserHome() ?? os.homedir()（子进程实际生效 USERPROFILE/HOME）、最近工作区
  // listRecentWorkspaces()、默认目录 getConfig().workingDirectory、会话计数
  // sessionRepo.listWorkingDirCounts()、坏目录负缓存与 Skill 共用同一实例
  //（project-skills badDirCacheHas/badDirCacheMark，语义「目录不可达 60s」）。
  ipcMain.handle(IPC_CHANNELS.MCP_SNAPSHOT_GET, async () => {
    const defaultWorkingDir = getConfig().workingDirectory ?? null;
    return collectMcpSnapshot({
      userHome: effectiveUserHome() ?? os.homedir(),
      isDefaultDir: (dir) =>
        defaultWorkingDir !== null && normalizeDirKey(dir) === normalizeDirKey(defaultWorkingDir),
      recentWorkspaces: listRecentWorkspaces(),
      defaultWorkingDir,
      listWorkingDirCounts: () => sessionRepo.listWorkingDirCounts(),
      badDirHas: badDirCacheHas,
      badDirMark: badDirCacheMark,
    });
  });
  // 管理库全量替换：body = McpManagedSaveEntry[]（McpManagedServer + 瞬态改名 hint）→
  // 先 restoreMaskedMcpServers（§1.3：渲染层提交的未改动字段值是掩码哨兵，按已存条目还原
  // 原值——哨兵还原必须在 sanitize 前，防哨兵字面量落库；瞬态 hint 随还原剥离）再 sanitize，
  // 最后走主进程 saveConfig（与渲染层 700ms 防抖 config:save 撞车由 config-store 既有互斥
  // savingConfig + 漂移补偿保护，§3.12；本 handler 不自带任何绕过互斥的直写 store 操作）。
  ipcMain.handle(IPC_CHANNELS.MCP_MANAGED_SAVE, async (_event, body: unknown) => {
    if (!Array.isArray(body)) throw new Error('Invalid MCP managed servers payload');
    saveConfig({
      mcpServers: sanitizeMcpServersConfig(restoreMaskedMcpServers(body as McpManagedSaveEntry[], getConfig().mcpServers)),
    });
    // B-7：管理库是全量替换保存，落盘成功后统一清空 managed: 探活缓存（比逐键 diff 简单且
    // 可预测）——增/删/改后旧定义结论即时失效，批量重探一律取新结论（60s 内同名重添无旧值回显）。
    dropProbeCacheByPrefix('managed:');
    return { ok: true as const };
  });
  // 启停 override 单键翻转：主进程内直接改 config 再 saveConfig——不经渲染层整包 config，
  // 规避并发覆盖；键须 string 且带作用域前缀（managed:/user:/project:），否则拒绝。
  // 返回 saveConfig 落盘后的最新全量（渲染层以此为准，不自行拼装）。
  ipcMain.handle(IPC_CHANNELS.MCP_OVERRIDE_SET, async (_event, body: unknown) => {
    if (typeof body !== 'object' || body === null) throw new Error('Invalid MCP override payload');
    const { key, enabled } = body as { key?: unknown; enabled?: unknown };
    if (typeof key !== 'string' || !/^(managed|user|project):/.test(key)) {
      throw new Error('Invalid MCP override key');
    }
    if (typeof enabled !== 'boolean') throw new Error('Invalid MCP override enabled flag');
    const overrides = getConfig().mcpOverrides;
    if (enabled) delete overrides[key];
    else overrides[key] = 'off';
    saveConfig({ mcpOverrides: overrides });
    return { overrides: getConfig().mcpOverrides };
  });
  // 探活：all = 管理库逐条构造 inputs（name/transport/command/args/env/url/headers）并发探活，
  // 60s 缓存逐 key 判定（hasFreshCache 命中直接回缓存报告，未命中才探；入口先 pruneProbeCache
  // 时间驱动清理）；single = 渲染层只传 name（§1.3 渲染层零明文约束），主进程按 name 在
  // getConfig().mcpServers 定位已存条目、自取明文 env/headers 构造探活输入现探（用户显式
  // 「测试连接」只写不读缓存——传 cacheKey 把新结论写进缓存供批量命中，但回包恒为现探值，
  // 不回旧缓存）；查无 → 单元素 fail report，不抛。
  // 返回 McpProbeReport[]（single 恒单元素数组；all 与启用条目逐条对齐同序；禁用条目缺槽，
  // UI 按 key 消费并显示已禁用态。single 为用户显式动作不滤禁用——禁用卡也允许手动测试）。
  ipcMain.handle(IPC_CHANNELS.MCP_PROBE, async (_event, body: unknown): Promise<McpProbeReport[]> => {
    if (typeof body !== 'object' || body === null) throw new Error('Invalid MCP probe payload');
    const req = body as { target?: unknown; name?: unknown };
    if (req.target === 'single') {
      const name = req.name;
      if (typeof name !== 'string' || name === '') throw new Error('Invalid MCP probe name');
      const stored = getConfig().mcpServers.find((server) => server.name === name);
      if (!stored) {
        return [
          { key: mcpProbeKey('managed', null, name), status: 'fail', toolCount: 0, error: `未找到该服务器：${name}`, probedAt: Date.now() },
        ];
      }
      const input: McpProbeInput = {
        name: stored.name,
        transport: stored.transport,
        command: stored.command,
        args: stored.args,
        env: stored.env,
        url: stored.url,
        headers: stored.headers,
      };
      // 只写不读：新结论写进 managed:<name> 缓存（供 all 批量 60s 命中），回包恒为现探值。
      return [await probeMcpServer(input, 10_000, mcpProbeKey('managed', null, input.name))];
    }
    if (req.target !== 'all') throw new Error('Invalid MCP probe target');
    // B-10：批量探测入口顺带时间驱动清理过期缓存（pruneProbeCache 原全仓零调用方，此处接线）。
    pruneProbeCache(60_000);
    const cachedByKey = new Map(getCachedProbeReports().map((r) => [r.key, r]));
    const pending: McpProbeInput[] = [];
    // B-8：批量探测只探启用条目（override `managed:<name>` 缺失/非 'off' 即启用）；禁用条目
    // 不进 pending（零 spawn 零请求）也不进返回数组（UI 按 key 消费、缺槽不炸，显示已禁用态）。
    const overridesNow = getConfig().mcpOverrides;
    const enabledServers = getConfig().mcpServers.filter((s) => overridesNow[`managed:${s.name}`] !== 'off');
    const slots = enabledServers.map((server) => {
      const input: McpProbeInput = {
        name: server.name,
        transport: server.transport,
        command: server.command,
        args: server.args,
        env: server.env,
        url: server.url,
        headers: server.headers,
      };
      const key = mcpProbeKey('managed', null, input.name);
      const cached = cachedByKey.get(key);
      if (cached !== undefined && hasFreshCache(key)) return { key, cached };
      pending.push(input);
      return { key, cached: undefined };
    });
    // probeAllManaged 逐条以 managed:<name> 键写探活缓存；pending 与 slots 非命中槽一一对应
    //（保序），probe 后按 key 回填（防御性：万一缺槽回 fail report，不炸整拍）。
    const probed = await probeAllManaged(pending);
    const probedByKey = new Map(probed.map((r) => [r.key, r]));
    return slots.map(({ key, cached }) => {
      const fresh = probedByKey.get(key);
      if (fresh !== undefined) return fresh;
      if (cached !== undefined) return cached;
      return { key, status: 'fail' as const, toolCount: 0, error: '探活结果缺失', probedAt: Date.now() };
    });
  });
  // P8 双向写入（用户级/项目级）：body = { scope, dir?, entry, mode } → writeScopedMcpServer
  //（mcp-writer.ts：user → ~/.claude.json / project → <dir>/.mcp.json 顶层 mcpServers 条目
  // upsert/remove；哨兵值按原文件还原，瞬态改名 hint 还原后剥离；tmp+rename 原子写 + mtime
  // 冲突重试）→ { overwrote }。安全边界（必须）：scope=project 时 dir 必须属于已知项目目录集
  // ——与 MCP_SNAPSHOT_GET 同源（mergeProjectDirs(listRecentWorkspaces(), 默认工作目录) 按
  // normalizeDirKey 归一比对），防渲染层任意路径写；user 作用域 userHome 由主进程自取
  // effectiveUserHome() ?? os.homedir()（与注入链同口径），渲染层不可传。
  ipcMain.handle(IPC_CHANNELS.MCP_WRITE_SCOPED, async (_event, body: unknown): Promise<{ overwrote: boolean }> => {
    if (typeof body !== 'object' || body === null) throw new Error('Invalid MCP write payload');
    const req = body as { scope?: unknown; dir?: unknown; entry?: unknown; mode?: unknown };
    if (req.scope !== 'user' && req.scope !== 'project') throw new Error('Invalid MCP write scope');
    if (req.mode !== 'upsert' && req.mode !== 'remove') throw new Error('Invalid MCP write mode');
    if (typeof req.entry !== 'object' || req.entry === null) throw new Error('Invalid MCP write entry');
    const entry = req.entry as ScopedMcpEntry;
    if (typeof entry.name !== 'string' || entry.name === '') throw new Error('Invalid MCP write entry name');
    let dir: string | undefined;
    if (req.scope === 'project') {
      if (typeof req.dir !== 'string' || req.dir === '') throw new Error('Invalid MCP write dir');
      const knownDirs = mergeProjectDirs(listRecentWorkspaces(), getConfig().workingDirectory ?? null);
      const knownKeys = new Set(knownDirs.map((d) => normalizeDirKey(d.path)));
      if (!knownKeys.has(normalizeDirKey(req.dir))) throw new Error('目标目录不在已知项目目录集中，已拒绝写入');
      dir = req.dir;
    }
    return writeScopedMcpServer({ scope: req.scope, dir, entry, mode: req.mode, userHome: effectiveUserHome() ?? os.homedir() });
  });
  // 作用域导出 JSON（2026-10-18）：body = { scope, dir? } → { ok, count }。主进程内取明文
  //（managed = config store 数组按 name 成表 / user、project = scanner raw 直读，未脱敏真值）
  // → buildMcpServersExportJson（{"mcpServers":{…}} 形态）→ electron clipboard 写剪贴板。
  // §1.3 渲染层零明文：JSON 文本全程不出主进程，渲染层只拿 count；导出含全部定义（启停
  // 是 Claude Link 专属 override，非标准字段，不参与导出）。project 的 dir 白名单校验与
  // WRITE_SCOPED 同源（已知项目目录集，防任意路径读探测）；count = 0 时不动剪贴板
  //（渲染层按钮已按空表禁用，防御性兜底）。
  ipcMain.handle(IPC_CHANNELS.MCP_EXPORT_SCOPED, async (_event, body: unknown): Promise<{ ok: true; count: number }> => {
    if (typeof body !== 'object' || body === null) throw new Error('Invalid MCP export payload');
    const req = body as { scope?: unknown; dir?: unknown };
    if (req.scope !== 'managed' && req.scope !== 'user' && req.scope !== 'project') throw new Error('Invalid MCP export scope');
    let dir: string | undefined;
    if (req.scope === 'project') {
      if (typeof req.dir !== 'string' || req.dir === '') throw new Error('Invalid MCP export dir');
      const knownDirs = mergeProjectDirs(listRecentWorkspaces(), getConfig().workingDirectory ?? null);
      const knownKeys = new Set(knownDirs.map((d) => normalizeDirKey(d.path)));
      if (!knownKeys.has(normalizeDirKey(req.dir))) throw new Error('目标目录不在已知项目目录集中，已拒绝导出');
      dir = req.dir;
    }
    // 明文数据源按作用域现取（不缓存导出内容）；入参形态均为 toSdkMcpServerConfig 兼容形状。
    let servers: Parameters<typeof buildMcpServersExportJson>[0];
    if (req.scope === 'managed') {
      servers = {};
      for (const server of getConfig().mcpServers) servers[server.name] = server;
    } else if (req.scope === 'user') {
      servers = readUserMcpServersRawSync(effectiveUserHome() ?? os.homedir());
    } else {
      // req.scope === 'project'（上方已校验 dir 属已知目录集）
      servers = readProjectMcpServersRawSync(dir as string);
    }
    const count = Object.keys(servers).length;
    if (count === 0) return { ok: true, count: 0 };
    clipboard.writeText(buildMcpServersExportJson(servers));
    return { ok: true, count };
  });

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
    // hb13-v B2（F-03）：解密哨兵按未配置短路——损坏态不得把哨兵串放进 x-api-key/Bearer 头。
    if (apiKey === DECRYPT_FAILED) throw new Error('该供应商的 API Key 解密失败（密钥损坏，请重新输入），无法查询模型。');
    // B7（D02-F5）key-less 放行：空 key 不拦截，凭据头由 model-resolver 按 key 门控（空 key 省略）。
    return fetchAvailableModels(profile, apiKey, forceRefresh === true);
  });
  // 模型行内测试（r5）：指定供应商 + 指定模型真实 spawn CLI，直返汇总结果。
  ipcMain.handle(IPC_CHANNELS.PROVIDER_TEST_MODEL, async (_event, providerId: string, modelId: string) => {
    if (typeof providerId !== 'string' || typeof modelId !== 'string') throw new Error('Invalid provider/model id');
    return runProviderModelTest(providerId, modelId);
  });

  // Sessions
  // bridge 会话本地锁定：以 bridge_bindings 活跃绑定为唯一事实源，给列表行附带
  // bridgePlatform（null=普通会话）；渲染层凭它把绑定会话置为桌面端只读。
  // runtime 未初始化时 bridgeBindingList 返回 []（全不锁，仅退出路径可达）。
  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const sessions = sessionRepo.listSessions();
    const boundPlatformBySessionId = new Map(bridgeBindingList().map((b) => [b.sessionId, b.platform]));
    return sessions.map((s) => ({ ...s, bridgePlatform: boundPlatformBySessionId.get(s.id) ?? null }));
  });
  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_event, name: string, spec?: SessionCreateSpec) => {
    // hb10-SMG-07：入参健壮性校验（对齐 COMMANDS_GET 形态）——空白名直调 IPC 不再建脏行。
    if (typeof name !== 'string' || !name.trim()) throw new Error('会话名称不能为空');
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
        // hb10 P2-3：lastUsed 变更兜底广播（幂等；渲染层 ensureReload 同步触发器显示态）。
        broadcastProvidersChanged();
      }
    }
    // Skill 管理钉住：新会话创建时复制当前全局禁用集合（主进程侧取值，不信任 renderer）。
    // 之后配置变更不影响本会话（旧会话不受影响语义）；null = 全启用，不写列（与建行默认一致）。
    const pinnedSkillOverrides = buildSessionSkillOverridesForPin(getConfig().skillOverrides);
    if (pinnedSkillOverrides) {
      session = sessionRepo.updateSession(session.id, { skillOverrides: pinnedSkillOverrides }) ?? session;
    }
    // MCP 管理钉住：同款——新会话创建时复制当前全局 MCP 启停 override（主进程侧取值，
    // 不信任 renderer）；null = 无需钉住，不写列（与建行默认 NULL 一致）。之后全局配置变更
    // 不影响本会话；存量会话（功能前建行）该列为 NULL，注入时回退当前全局（§3.14）。
    const pinnedMcpOverrides = buildSessionMcpOverridesForPin(getConfig().mcpOverrides);
    if (pinnedMcpOverrides) {
      session = sessionRepo.updateSession(session.id, { mcpOverrides: pinnedMcpOverrides }) ?? session;
    }
    // 暂态附件转正：物化建行后外键已满足，绑定为 draft 记录供 CHAT_SEND 校验/升格。
    // hb12-SMG-09：绑定失败必须回滚会话行——只回滚附件不清会话行会留下「附件已指向不存在的
    // 会话行」的死锁半态（hb10-ATT-V01 计划明文：实施时必须叠加本条）。
    if (spec?.bindTransientAttachmentIds?.length) {
      try {
        bindTransientAttachmentsToSession(session.id, spec.bindTransientAttachmentIds);
      } catch (err) {
        sessionRepo.deleteSession(session.id);
        throw err;
      }
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
  ipcMain.handle(IPC_CHANNELS.SESSION_GET, async (_event, id: string) => {
    const s = sessionRepo.getSession(id);
    return s ? withBridgePlatform(s) : s;
  });
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
        Pick<Session, 'name' | 'model' | 'workingDir' | 'permissionMode' | 'maxTurns' | 'thinkingLevel' | 'skillOverrides' | 'mcpOverrides' | 'providerOverride' | 'modelOverride'>
      >,
    ) => {
      // hb10-SMG-07：入参健壮性校验（对齐 COMMANDS_GET 形态）——非字符串 sessionId 直拒。
      if (typeof id !== 'string' || !id.trim()) throw new Error('非法会话 id');
      // D-8（review 2026-09-18 §3-14）：data 形状守卫（对齐防御惯例）——null/非对象入参时下方
      // 白名单访问会 TypeError → invoke reject；渲染层 6 处恒传对象（当前不可达），此处仅兜底
      // 拒绝（return false 与 updateSession 无行 falsy 返回同形态），不抛错。
      if (!data || typeof data !== 'object') return false;
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
      // skillOverrides（钉住值）不经本通道可写（P2-1）：仅 SESSION_CREATE 依据全局配置落库，
      // 不信任 renderer 传值——renderer 经 IPC 附带的该键一律剔除（上方白名单同款形态）。
      delete data.skillOverrides;
      // mcpOverrides（钉住值）同款：仅 SESSION_CREATE 依据全局配置落库，SESSION_UPDATE 一律剔除。
      delete data.mcpOverrides;
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
        // hb10 P2-3：lastUsed 变更兜底广播（幂等；渲染层 ensureReload 同步触发器显示态）。
        broadcastProvidersChanged();
      }
      // F3：工作目录变化影响 Skill/Plugin 可见性 → 重新探测命令（旧快照标 stale，新结果替换）。
      // N2：清除工作目录（workingDir: null）同样必须重新探测——旧目录的 Skill/Plugin 命令不再适用。
      if (data.workingDir !== undefined) {
        void startCommandProbe(id, mainWindow, { ...data });
      }
      return updated ? withBridgePlatform(updated) : updated;
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
      // B1 审查修复：渲染层内存消息 id（crypto.randomUUID）与 DB 行 id（主进程 uuidv4）两套
      // uuid 永不相等，常态（活跃会话内）直传 messageId 命中不了；回合中切走再切回时 store
      // 经 getSessionMessages 重载出 DB-id 行，直传可命中（良性）。messageId 类型收窄
      //（typeof string 且非空才直传，非字符串不做 String() 强转）：命中失败/为 null/非字符串
      //（含后台分支的 null）一律回落「本回合主流程最后一条 assistant 行」查找（新→旧、
      // 遇 user 边界即停、跳过子 agent）；仍找不到则只写 sessions 半边，不报错（无 assistant
      // 行的回合不产生脚注，诚实不造数）。
      const meta = { costUsd, durationMs, endedAt };
      // P2-2 半写收口：全 null payload（端点 0 值兜底后）不再抹掉既有记录——
      // messages 半边仅在 costUsd/durationMs 至少一个非 null 时执行；
      // sessions 半边仅在 durationMs/endedAt 齐备（完整有效记录）时执行。
      // hb12-TM-03：两半边 UPDATE 包同一 transaction——任一半边失败不再留半态
      //（P2-2 双门控判定原样保留，事务只包两次写、不包门控判定）。
      const applyTurnMeta = getConnection().transaction(() => {
        if (costUsd != null || durationMs != null) {
          const directHit = typeof payload?.messageId === 'string' && payload.messageId
            ? messageRepo.updateResultMeta(payload.messageId, sessionId, meta)
            : false;
          if (!directHit) {
            const fallbackId = messageRepo.findLastTurnMainFlowAssistantId(sessionId, { endedAt });
            if (fallbackId) messageRepo.updateResultMeta(fallbackId, sessionId, meta);
          }
        }
        if (durationMs != null && endedAt != null) {
          sessionRepo.updateTurnMeta(sessionId, { durationMs, endedAt });
        }
      });
      applyTurnMeta();
      // hb10-OPT-1：调用方均 fire-and-forget，返回布尔即可（省一次全行读）。
      return true;
    },
  );
  ipcMain.handle(IPC_CHANNELS.SESSION_SEARCH, async (_event, query: string) =>
    sessionRepo.searchSessions(query),
  );
  // OPT-10：会话级「单独改 model_override」的 IPC 死链已删除（模型选用唯一现场=供应商模型选择器，
  // 渲染层经 SESSION_UPDATE 透传 providerOverride/modelOverride；被删通道在 renderer/store/repo 三层均无调用方）。
  ipcMain.handle(
    IPC_CHANNELS.SESSION_ANALYZE_TOPIC,
    async (_event, sessionId: string, firstMessage: string) => {
      // hb10-SMG-07：入参健壮性校验（对齐 COMMANDS_GET 形态）——空白消息不再触发命名链写库。
      if (typeof sessionId !== 'string' || !sessionId.trim() || typeof firstMessage !== 'string' || !firstMessage.trim()) {
        return null;
      }
      const result = await analyzeTopic(sessionId, firstMessage);
      return result;
    },
  );

  // Messages
  ipcMain.handle(IPC_CHANNELS.MESSAGE_GET_BY_SESSION, async (_event, sessionId: string) => {
    // hb10-SHL-08/V01：入参校验（对齐 COMMANDS_GET 形态）。
    if (typeof sessionId !== 'string' || !sessionId.trim()) return [];
    return messageRepo.getMessagesBySession(sessionId);
  });

  // Claude 计划快照：按会话读取 TodoWrite / Task 工具的计划状态。
  // 独立于手动排队 tasks 表——不复用 task-repo。
  ipcMain.handle(IPC_CHANNELS.CLAUDE_PLAN_GET, async (_event, sessionId: string) => {
    // hb10-SHL-08：入参校验（对齐 COMMANDS_GET 形态）。
    if (typeof sessionId !== 'string' || !sessionId.trim()) return null;
    return getClaudePlanState(sessionId);
  });

  // 原生 Slash Commands：读取某会话当前命令快照（registry 已清洗 + 去重）。返回纯可克隆 snapshot，
  // 不返回 Query / SDK stream / 未经清洗的消息。
  ipcMain.handle(IPC_CHANNELS.COMMANDS_GET, async (_event, sessionId: unknown) => {
    if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('Invalid session id');
    // D1 分流：先验证 DB 会话存在，再允许登记 active/启动 probe——不能把任意 renderer 输入当作会话
    // 生命周期事实。无 DB 行（暂态）不再 throw：只读返回全局兜底副本（source:'cache'），不 markSessionActive、
    // 不 startCommandProbe、不 schedulePostTurnProbe；分流决策统一在 shared 纯函数 resolveCommandsGetResult。
    const sessionRow = sessionRepo.getSession(sessionId);
    // P2-14：快照带项目级出生指纹时现算比对（无指纹的旧快照跳过 IO；cwd 取值见下条 hb10-CMD-V01
    // 回退——会话 cwd 缺省时用全局配置工作目录现算，两级皆空才经 getProjectOriginFingerprint 的
    // !cwd 短路无 IO）。
    const existingSnapshot = sdkCommandRegistry.get(sessionId);
    const currentProjectFingerprint = existingSnapshot?.projectOriginFingerprint !== undefined
      // hb10-CMD-V01：指纹比对侧镜像出生侧回退——session cwd 缺省时用全局配置工作目录
      //（出生侧 probe 即该回退；否则全局 cwd 会话 stale 检测永远不触发）。
      ? await getProjectOriginFingerprint(sessionRow?.workingDir ?? getConfig().workingDirectory ?? null)
      : undefined;
    const decision = resolveCommandsGetResult({
      sessionExists: Boolean(sessionRow),
      hasSnapshot: sdkCommandRegistry.has(sessionId),
      snapshot: sdkCommandRegistry.get(sessionId),
      fallback: sdkCommandRegistry.getGlobalFallback(),
      currentUserFingerprint: getUserOriginFingerprint(),
      currentProjectFingerprint,
      cliMissing: isGlobalCliMissing(),
      // hb13-v B6（CMD-07/CMD-10）：失败旗标接上真实消费者；探测中抑制 needsRefreshProbeOnly。
      probeFailed: isGlobalProbeFailed(),
      probeInProgress: isCommandProbeInFlight(sessionId),
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
      // hb10-CMD-10（加重）：10s 节流——指纹比对每次重新为真 + 探测中反复返回 stale 时，
      // 无节流会反复 spawn/abort 探测可能永不完成；探测中幂等由 startCommandProbe 的 N3 互斥兜底。
      const now = Date.now();
      if (now - lastProbeOnlyAt >= 10_000) {
        lastProbeOnlyAt = now;
        void startCommandProbe(sessionId, mainWindow);
      }
    }
    // 返回值统一由分流给出：per-session 快照 / 兜底 cache 副本 / stale 克隆 / loading 默认。
    return decision.snapshot;
  });
  // Task 8：命令来源 provenance 诊断（从已清洗快照派生的脱敏视图：origin/availability 计数 +
  // unknown/hidden 命令名）。只读、无副作用——不 markSessionActive、不触发 probe（区别于 COMMANDS_GET）。
  // sessionId 做非空校验；DB 会话存在性不强制（无快照会话回退全局兜底派生诊断，兜底也未就绪时
  // 才返回 total=0 空诊断；均不抛错）。
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
      if (isChatSendLocked(sessionId) || getActiveProcess(sessionId)) {
        throw new Error('当前回合仍在执行，请等待结束或中断后重试');
      }
      acquireChatSendLock(sessionId);
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
        // F2：四路执行链（直发/重发/队列/bridge 分发器）统一从全局设置取 maxTurns——
        // session.maxTurns 的 DB 列默认 200 且渲染层从不写入，会话级值永远到不了设置，
        // 直发路径曾完全无视该设置。
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
        // hb12-P2-2（终态重构）：显式终态优先——result/合成 aborted 已结算（knownOutcome 置位）
        // 时兜底 no-op；无终态信息才按退出码分类（0=真成功退出，null=系统杀/无 code 维持 error
        // 现状语义，其余非 0=error）。不变量：任何路径不得把「已中断」记成 success。
        const known = getKnownTurnOutcome(sessionId);
        if (known) return;
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
      if (locked) releaseChatSendLock(sessionId);
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
    const changed = await setRunningQueryPermissionMode(sessionId, effective);
    // hb10 P2-2：档位变更成功即失效本会话记忆的全部 allow-session 放行（小本本清账）——
    // 切档后同工具重新弹窗，防新档位（尤其 plan）继承旧档记忆的裸 allow 越权。
    if (changed) clearSessionPermissionBook(sessionId);
    return changed;
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
    // hb10-ATT-05：状态守卫——仅待执行任务可删除（与面板只展示 pending 语义对齐；
    // running 任务删除走先中断后删的两步，本期不做），防删除熔断队列。
    if (!task || task.status !== 'pending') {
      throw new Error('仅待执行任务可删除');
    }
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

  // D 点：后台任务（task_* 编排）终态输出文件只读。入参对象载荷 { outputFile }：
  // 校验绝对路径 + fs.stat 为常规文件 → 只读打开、最多读前 512KB（超出 truncated:true）。
  // 安全面：纯 fs.stat/fs.open+read，不执行、不写、无路径拼接（绝对路径直读），512KB 上限封顶。
  ipcMain.handle(IPC_CHANNELS.TASK_OUTPUT_READ, async (_event, req: unknown): Promise<{ content: string; truncated: boolean }> => {
    const r = (req ?? {}) as Record<string, unknown>;
    if (typeof r.outputFile !== 'string' || !r.outputFile.trim() || !path.isAbsolute(r.outputFile)) {
      throw new Error('输出文件不可读：路径无效');
    }
    const outputFile = r.outputFile;
    const MAX_BYTES = 512 * 1024;
    let stat: fs.Stats;
    try {
      stat = await fsp.stat(outputFile);
    } catch {
      throw new Error('输出文件不存在');
    }
    if (!stat.isFile()) throw new Error('输出文件不可读：不是常规文件');
    let handle: fs.promises.FileHandle;
    try {
      handle = await fsp.open(outputFile, 'r');
    } catch {
      throw new Error('输出文件不可读');
    }
    try {
      const buf = Buffer.alloc(Math.min(stat.size, MAX_BYTES));
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      return {
        content: buf.subarray(0, bytesRead).toString('utf8'),
        truncated: stat.size > bytesRead,
      };
    } catch {
      throw new Error('输出文件不可读');
    } finally {
      try {
        await handle.close();
      } catch {
        // 关闭失败不掩盖读取错误（原错误从 try/catch 正常抛出）。
      }
    }
  });

  // 熔断提示行「全部恢复」：全部 paused→pending + 立即开始全量倒计时。
  ipcMain.handle(IPC_CHANNELS.QUEUE_RESUME_ALL, async (_event, sessionId: string) => {
    return resumeAllTasks(sessionId, mainWindow);
  });

  // 面板全量数据：状态 + pending 任务 + 本次已执行历史。
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_OVERVIEW, async (_event, sessionId: string) => {
    return getQueueOverview(sessionId);
  });

  // 附件 IPC：路径暂存（自绘选择器选中后）/ 暂存字节（粘贴·拖放）/ 受控预览 / 移除草稿。
  // 文件读取与校验全部在主进程；renderer 只拿不透明附件 ID 与受控预览 bytes。
  ipcMain.handle(IPC_CHANNELS.ATTACHMENT_STAGE_PATHS, async (_event, sessionId: string, paths: unknown): Promise<PickAttachmentsResult> => {
    // 入参校验：string[]、每项非空字符串、长度 ≤50（一次选择的合理上界，防滥用）。
    if (typeof sessionId !== 'string' || !sessionId.trim() || !Array.isArray(paths) || paths.length > 50 || !paths.every((p) => typeof p === 'string' && p.trim())) {
      throw new Error('附件路径参数无效');
    }
    return stageAttachmentPaths(sessionId, paths as string[]);
  });

  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_STAGE_BYTES,
    async (_event, input: StageAttachmentBytesInput): Promise<AttachmentSummary> => {
      // hb10-ATT-09：主进程字节上界——超过 32MiB 早退拒绝（不进校验/落盘链路）。
      if (input && input.bytes instanceof Uint8Array && input.bytes.byteLength > 32 * 1024 * 1024) {
        throw new Error('附件超过 32MiB 上限');
      }
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
  // A11（D08-F1）：返回 { created, rejected }——余量预检拒掉的附件以名单返回（不落盘）。
  ipcMain.handle(
    IPC_CHANNELS.ATTACHMENT_CLONE_MESSAGE,
    async (_event, sessionId: string, messageId: string): Promise<CloneMessageAttachmentsResult> =>
      cloneMessageAttachmentsToDraft(sessionId, messageId),
  );

  // 会话导出长图（v3 JPEG / v4.1 PNG 双格式）：注册主窗口开始 + 隐藏 renderer 专用 IPC。
  registerExportImageHandlers();

  // IM 机器人（飞书/微信 bridge）通道：逻辑在 modules/bridge/init.ts（凭据只回掩码，不回明文/密文）。
  registerBridgeIpcHandlers();
}

/** bridge IPC 注册（由 registerIpcHandlers 尾部调用一次，F6 幂等守卫天然覆盖）。 */
function registerBridgeIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS.BRIDGE_CONFIG_GET, async () => bridgeConfigGet());
  ipcMain.handle(IPC_CHANNELS.BRIDGE_CONFIG_SAVE, async (_event, input: BridgeConfigSaveInput) => bridgeConfigSave(input));
  ipcMain.handle(IPC_CHANNELS.BRIDGE_STATUS_GET, async () => bridgeStatusGet());
  ipcMain.handle(IPC_CHANNELS.BRIDGE_FEISHU_TEST, async (_event, input: { appId?: string; appSecret?: string }) => bridgeFeishuTest(input));
  ipcMain.handle(IPC_CHANNELS.BRIDGE_WECHAT_QRCODE, async () => bridgeWechatQrcode());
  ipcMain.handle(IPC_CHANNELS.BRIDGE_WECHAT_QRCODE_STATUS, async (_event, qrcodeId: string) => bridgeWechatQrcodeStatus(qrcodeId));
  ipcMain.handle(IPC_CHANNELS.BRIDGE_BINDING_LIST, async () => bridgeBindingList());
  ipcMain.handle(IPC_CHANNELS.BRIDGE_PLATFORM_RESTART, async (_event, platform: string) =>
    bridgePlatformRestart(platform === 'wechat' ? 'wechat' : 'feishu'));
}
