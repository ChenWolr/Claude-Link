// init.ts — bridge 模块的 electron 胶水层（唯一允许 import electron 的 bridge 文件）。
// 组装真实 deps：safeStorage cipher、主窗包装、sdk-backend/task-queue-engine/chat-send-locks 真函数、
// binding-repo（getConnection()）、resolveDefaultModel(getConfig())——dispatcher 与 CHAT_SEND 同构管线。
// IPC handler 本体在 ipc-handlers.ts 的 registerBridgeIpcHandlers，逻辑函数经本模块暴露。

import { safeStorage, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IPC_CHANNELS } from '../../../shared/constants';
import { resolveDefaultModel } from '../../../shared/settings-parser';
import type { BridgeConfigSaveInput, BridgePlatformStatusEntry, BridgeBindingView, WechatQrcodeStatusResult, BridgeConfigGetResult, BridgeFeishuTestResult } from '../../../shared/types/bridge';
import { getConfig } from '../config-manager';
import { getConnection } from '../../database/connection';
import * as sessionRepo from '../../database/repositories/session-repo';
import * as messageRepo from '../../database/repositories/message-repo';
import { spawnForChat, sendMessage, getActiveProcess, getKnownTurnOutcome, killProcess } from '../chat-backend';
import { beginUserTurn, noteTurnOutcome } from '../task-queue-engine';
import { isChatSendLocked, acquireChatSendLock, releaseChatSendLock } from '../chat-send-locks';
import { logger } from '../../utils/logger';
import {
  loadProfilesWithStatus,
  saveProfiles,
  resolveSecretPatch,
  toFeishuView,
  toWechatView,
  MASKED_SECRET,
  type BridgeCipher,
  type BridgeProfilesStored,
} from './profiles';
import * as bindingRepo from './binding-repo';
import { dispatchBridgeTurn, type TurnEngineDeps, type TurnPersistenceDeps, type BridgeTurnResult } from './dispatcher';
import { BridgeManager, type BridgeManagerDeps } from './manager';
import { createFeishuAdapter } from './feishu-adapter';
import { createWechatAdapter } from './wechat-adapter';
import { writeWechatSkipBacklogFlag } from './wechat-ilink';
import { getWechatQrcode, pollWechatQrcodeStatus } from './wechat-login';

interface BridgeRuntime {
  opts: { getWindow: () => BrowserWindow | null; userDataDir: string };
  profilesFile: string;
  wechatStateDir: string;
  profiles: BridgeProfilesStored;
  feishuSecretBroken: boolean;
  wechatTokenBroken: boolean;
  manager: BridgeManager;
}

let runtime: BridgeRuntime | null = null;

// 飞书 App ID 格式（生命周期修复批次1.3）：非此形态时 lark SDK start() 会静默 return，
// 30s 健康巡检无限重试、状态永远「异常」——保存与启动双路径前置正则拦截（症状④最强根因）。
const FEISHU_APPID_RE = /^cli_[0-9a-fA-F]{16}$/;

// ── safeStorage cipher（provider apiKey 同款先例：加密不可用时降级 base64，带前缀可逆）──

const cipher: BridgeCipher = {
  encrypt(plain: string): string {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(plain).toString('base64');
    }
    logger.warn('[bridge] safeStorage 不可用，凭据降级为 base64 存储');
    return `plain:${Buffer.from(plain, 'utf8').toString('base64')}`;
  },
  decrypt(enc: string): string | null {
    try {
      if (enc.startsWith('plain:')) return Buffer.from(enc.slice(6), 'base64').toString('utf8');
      return safeStorage.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null; // B12：解密失败（换机/重装）→ broken 标记
    }
  },
};

function persistProfiles(rt: BridgeRuntime): void {
  saveProfiles(rt.profilesFile, rt.profiles);
}

function pushStatusChanged(rt: BridgeRuntime): void {
  try {
    rt.opts.getWindow()?.webContents.send(IPC_CHANNELS.BRIDGE_STATUS_CHANGED, rt.manager.getStatus());
  } catch {
    // webContents 可能已销毁
  }
}

// ── dispatcher 真实 deps（同构 CHAT_SEND :627-711）──

function buildEngineDeps(rt: BridgeRuntime): TurnEngineDeps {
  const getWindow = rt.opts.getWindow;
  return {
    spawnForChat(sessionId, opts) {
      const win = getWindow();
      if (!win) throw new Error('主窗口不可用，无法发起回合');
      return spawnForChat(sessionId, win, opts as Parameters<typeof spawnForChat>[2]);
    },
    sendMessage: (sessionId, prompt) => sendMessage(sessionId, prompt),
    getActiveProcess: (sessionId) => getActiveProcess(sessionId),
    getKnownTurnOutcome: (sessionId) => getKnownTurnOutcome(sessionId),
    beginUserTurn: (sessionId) => {
      const win = getWindow();
      if (win) beginUserTurn(sessionId, win);
    },
    noteTurnOutcome: (sessionId, outcome) => {
      const win = getWindow();
      if (win) noteTurnOutcome(sessionId, outcome, win);
    },
    isChatSendLocked: (sessionId) => isChatSendLocked(sessionId),
    acquireChatSendLock: (sessionId) => acquireChatSendLock(sessionId),
    releaseChatSendLock: (sessionId) => releaseChatSendLock(sessionId),
    getConfigMaxTurns: () => getConfig().maxTurns,
    getSessionRow(sessionId) {
      const s = sessionRepo.getSession(sessionId);
      if (!s) return null;
      return {
        model: s.model,
        modelOverride: s.modelOverride,
        providerOverride: s.providerOverride,
        workingDir: s.workingDir,
        permissionMode: s.permissionMode,
        thinkingLevel: s.thinkingLevel,
        cliSessionId: s.cliSessionId,
      };
    },
  };
}

const persistenceDeps: TurnPersistenceDeps = {
  persistUserMessage: (sessionId, text) => {
    messageRepo.createMessage({ sessionId, role: 'user', content: text, eventType: 'message' });
  },
  findReplyText: (sessionId) => {
    const assistantId = messageRepo.findLastTurnMainFlowAssistantId(sessionId);
    if (!assistantId) return null;
    const rows = messageRepo.getRecentMessagesForTurnCheck(sessionId, 50);
    return rows.find((r) => r.id === assistantId)?.content ?? null;
  },
};

function buildManagerDeps(rt: BridgeRuntime): BridgeManagerDeps {
  const db = getConnection();
  const engine = buildEngineDeps(rt);
  return {
    dispatcher: (sessionId: string, text: string): Promise<BridgeTurnResult> =>
      dispatchBridgeTurn(engine, persistenceDeps, sessionId, text),
    createSession: (name, model, workingDir) => sessionRepo.createSession(name, model, workingDir),
    getBinding: (sessionKey) => bindingRepo.getBindingBySessionKey(db, sessionKey),
    upsertBinding: (b) => bindingRepo.upsertBinding(db, b),
    rebind: (sessionKey, newSessionId) => void bindingRepo.rebindSession(db, sessionKey, newSessionId),
    touch: (sessionKey) => bindingRepo.touchBinding(db, sessionKey),
    getSessionRow: (id) => sessionRepo.getSession(id),
    isUnbound: (sessionKey) => bindingRepo.isUnbound(db, sessionKey),
    resolveModel: () => resolveDefaultModel(getConfig().advancedJson),
    profiles: () => runtime?.profiles ?? rt.profiles,
    saveFeishuOwner: (openId) => {
      rt.profiles.feishu.ownerOpenId = openId;
      persistProfiles(rt);
      logger.info(`[bridge] 首个飞书私聊用户已自动捕获为 owner: ${openId.slice(0, 8)}…`);
    },
    saveWechatOwner: (userId) => {
      rt.profiles.wechat.ownerUserId = userId;
      persistProfiles(rt);
      logger.info(`[bridge] 首个微信私聊用户已自动捕获为 owner: ${userId.slice(0, 8)}…`);
    },
    interruptTurn: (sessionId) => killProcess(sessionId, 'user', rt.opts.getWindow() ?? undefined),
    adapters: {
      feishu: (hooks) => {
        const p = rt.profiles.feishu;
        const appSecret = p.appSecretEnc ? cipher.decrypt(p.appSecretEnc) : null;
        // B15/B12：appId/appSecret 缺失或解密失败 → 不造 adapter。
        if (!p.enabled || !p.appId || !appSecret) return null;
        return createFeishuAdapter({ appId: p.appId, appSecret, region: p.region, ...hooks });
      },
      wechat: (hooks) => {
        const p = rt.profiles.wechat;
        const botToken = p.botTokenEnc ? cipher.decrypt(p.botTokenEnc) : null;
        if (!p.enabled || !botToken) return null;
        return createWechatAdapter({ botToken, stateDir: rt.wechatStateDir, ...hooks });
      },
    },
    onStatusChanged: () => pushStatusChanged(rt),
  };
}

// ── 生命周期 ──

export function initBridge(opts: { getWindow: () => BrowserWindow | null; userDataDir: string }): void {
  if (runtime) {
    logger.warn('[bridge] initBridge 重复调用，忽略（createWindow 二次进入由 F6 守卫收口）');
    return;
  }
  const bridgeDir = path.join(opts.userDataDir, 'bridge');
  fs.mkdirSync(bridgeDir, { recursive: true });
  const profilesFile = path.join(bridgeDir, 'profiles.json');
  const wechatStateDir = path.join(bridgeDir, 'wechat');
  fs.mkdirSync(wechatStateDir, { recursive: true });

  const loaded = loadProfilesWithStatus(profilesFile, cipher);
  const rt: BridgeRuntime = {
    opts,
    profilesFile,
    wechatStateDir,
    profiles: loaded.profiles,
    feishuSecretBroken: loaded.feishuSecretBroken,
    wechatTokenBroken: loaded.wechatTokenBroken,
    manager: null as unknown as BridgeManager,
  };
  rt.manager = new BridgeManager(buildManagerDeps(rt));
  runtime = rt;

  // 批次5.2 存量迁移（一次性）：旧版「微信任何私聊用户即 owner」升级为显式 owner——取绑定表
  // wechat 平台 last_active_at 最新活跃行的 user_id（墓碑行不参与）；无绑定保持 null 等待首捕获。
  if (!rt.profiles.wechat.ownerUserId) {
    const legacyOwner = bindingRepo.getLatestBindingUserIdByPlatform(getConnection(), 'wechat');
    if (legacyOwner) {
      rt.profiles.wechat.ownerUserId = legacyOwner;
      persistProfiles(rt);
      logger.info(`[bridge] wechat owner 存量迁移：已取绑定表最新活跃用户 ${legacyOwner.slice(0, 8)}…`);
    }
  }

  // B12：解密失败的凭据 → 平台不启动（enabled 也视为不可用），UI 红字提示重新录入。
  if (rt.feishuSecretBroken && rt.profiles.feishu.enabled) {
    logger.error('[bridge] 飞书 appSecret 解密失败，平台不启动；请在设置页重新录入');
  }
  if (rt.wechatTokenBroken && rt.profiles.wechat.enabled) {
    logger.error('[bridge] 微信 botToken 解密失败，平台不启动；请重新扫码登录');
  }
  // 已启用且凭据可用的平台随应用启动。飞书 appId 非法 → 不启动直接 error
  //（SDK start() 对坏 appId 静默 return，30s 巡检无限重试——批次1.3 前置拦截）。
  if (rt.profiles.feishu.enabled && !rt.feishuSecretBroken) {
    if (rt.profiles.feishu.appId && !FEISHU_APPID_RE.test(rt.profiles.feishu.appId)) {
      rt.manager.markPlatformError('feishu', 'App ID 格式非法：应为 cli_ 开头的 20 位字符，请在设置页修正');
    } else {
      void rt.manager.startPlatform('feishu');
    }
  }
  if (rt.profiles.wechat.enabled && !rt.wechatTokenBroken) {
    void rt.manager.startPlatform('wechat');
  }
  logger.info('[bridge] bridge 初始化完成');
}

/** B14：before-quit 收口——停轮询/断 WS/清定时器。在途回合由既有 killAllProcesses 兜底。 */
export async function stopBridge(): Promise<void> {
  if (!runtime) return;
  await runtime.manager.stopAll();
  runtime = null;
}

// ── IPC 逻辑函数（ipc-handlers.ts registerBridgeIpcHandlers 消费）──

export function bridgeConfigGet(): BridgeConfigGetResult {
  if (!runtime) throw new Error('bridge 未初始化');
  return {
    feishu: toFeishuView(runtime.profiles),
    wechat: toWechatView(runtime.profiles),
    global: { workingDir: runtime.profiles.global.workingDir, receiptEnabled: runtime.profiles.global.receiptEnabled },
    secretBroken: { feishu: runtime.feishuSecretBroken, wechat: runtime.wechatTokenBroken },
  };
}

export function bridgeConfigSave(input: BridgeConfigSaveInput): Promise<BridgeConfigGetResult> {
  return enqueueBridgeSave(() => doSave(input));
}

// ── 保存串行链（生命周期修复批次2.2）：并发 save / save×restart 竞态收口——全部入链严格串行，
// 前驱失败不断链（catch 吞掉后继照跑）。doSave 主体保持纯函数形态（单次保存语义不变）。
let bridgeSaveChain: Promise<unknown> = Promise.resolve();

function enqueueBridgeSave<T>(task: () => Promise<T>): Promise<T> {
  const run = bridgeSaveChain.then(task, task);
  bridgeSaveChain = run.catch(() => undefined);
  return run;
}

async function doSave(input: BridgeConfigSaveInput): Promise<BridgeConfigGetResult> {
  const rt = runtime;
  if (!rt) throw new Error('bridge 未初始化');
  const p = rt.profiles;
  // 批次1.3：appId 前置校验（persist 之前抛错，坏值不落盘；渲染层 save() catch 显示 saveError）。
  if (input.feishu?.appId !== undefined) {
    const appId = input.feishu.appId.trim();
    if (appId && !FEISHU_APPID_RE.test(appId)) {
      throw new Error('App ID 格式非法：应为 cli_ 开头的 20 位字符（可在飞书开放平台凭证页查看）');
    }
  }
  // 批次2.1：重启触发字段集快照（before）——只有这些字段实际变化才重启平台；ownerOpenId /
  // workingDir / 掩码同值 blur 等纯数据操作只落盘不动平台（消灭重启窗口丢在途回复）。
  const before = {
    feishu: {
      enabled: p.feishu.enabled, appId: p.feishu.appId, region: p.feishu.region,
      appSecretEnc: p.feishu.appSecretEnc,
    },
    wechat: { enabled: p.wechat.enabled, botTokenEnc: p.wechat.botTokenEnc },
  };
  if (input.feishu) {
    if (input.feishu.enabled !== undefined) p.feishu.enabled = input.feishu.enabled;
    if (input.feishu.appId !== undefined) p.feishu.appId = input.feishu.appId.trim();
    if (input.feishu.region !== undefined) {
      p.feishu.region = input.feishu.region === 'lark_global' ? 'lark_global' : 'feishu_cn';
    }
    if (input.feishu.ownerOpenId !== undefined) {
      p.feishu.ownerOpenId = input.feishu.ownerOpenId === '' ? null : input.feishu.ownerOpenId;
    }
    if (input.feishu.appSecret !== undefined) {
      p.feishu.appSecretEnc = resolveSecretPatch(p.feishu.appSecretEnc, input.feishu.appSecret, cipher);
      rt.feishuSecretBroken = false; // 重录密钥后清除 broken 标记
    }
  }
  if (input.wechat) {
    if (input.wechat.enabled !== undefined) p.wechat.enabled = input.wechat.enabled;
    if (input.wechat.ownerUserId !== undefined) {
      // 批次5.2：'' = 清除授权（null），非空 = 设为该 userId。纯数据操作（不在重启字段集）。
      p.wechat.ownerUserId = input.wechat.ownerUserId === '' ? null : input.wechat.ownerUserId;
    }
    if (input.wechat.botToken !== undefined) {
      // 掩码=保留；空串=清除（退出登录）；新值=加密落库。
      p.wechat.botTokenEnc = resolveSecretPatch(p.wechat.botTokenEnc, input.wechat.botToken, cipher);
      rt.wechatTokenBroken = false;
    }
  }
  if (input.global) {
    if (input.global.workingDir !== undefined) {
      p.global.workingDir = input.global.workingDir === '' ? null : input.global.workingDir;
    }
    // A2：纯数据操作——不在重启字段集（开关保存绝不重启平台）。
    if (input.global.receiptEnabled !== undefined) {
      p.global.receiptEnabled = input.global.receiptEnabled !== false;
    }
  }
  persistProfiles(rt);

  // 批次2.1：脏检查——重启触发字段集逐项比较；未变化则完全不碰平台生命周期。
  const feishuRestart = (['enabled', 'appId', 'region', 'appSecretEnc'] as const).some((k) => before.feishu[k] !== p.feishu[k]);
  const wechatRestart = (['enabled', 'botTokenEnc'] as const).some((k) => before.wechat[k] !== p.wechat[k]);
  // 启用分支条件补凭据非空（批次2.1）：退出登录（token 空）+ enabled 仍 true → 走 off
  // （面板「未登录」区），不再落入「凭据未配置完整」error 红字误导。
  if (input.feishu && feishuRestart) {
    if (p.feishu.enabled && !rt.feishuSecretBroken && p.feishu.appId && p.feishu.appSecretEnc) {
      await rt.manager.startPlatform('feishu');
    } else {
      // 批次1.4：禁用分支 silent + markPlatformOff——终态「未启用」而非「已断开」，
      // 且不再残留「凭据未配置完整」error 红字。
      await rt.manager.stopPlatform('feishu', { clearBuffers: true, silent: true });
      rt.manager.markPlatformOff('feishu');
    }
  }
  if (input.wechat && wechatRestart) {
    if (p.wechat.enabled && !rt.wechatTokenBroken && p.wechat.botTokenEnc) {
      await rt.manager.startPlatform('wechat');
    } else {
      await rt.manager.stopPlatform('wechat', { clearBuffers: true, silent: true });
      rt.manager.markPlatformOff('wechat');
      // 批次2.3：禁用即写积压跳过标记——重开后的首轮非空拉取整批丢弃只进 cursor。
      writeWechatSkipBacklog(rt);
    }
  }
  return bridgeConfigGet();
}

/** 批次2.3：微信禁用时写积压跳过标记（token 已空/解密失败则不写——无积压意义）。 */
function writeWechatSkipBacklog(rt: BridgeRuntime): void {
  const tok = rt.profiles.wechat.botTokenEnc ? cipher.decrypt(rt.profiles.wechat.botTokenEnc) : null;
  if (tok) writeWechatSkipBacklogFlag(rt.wechatStateDir, tok);
}

/**
 * 平台重启 IPC（生命周期修复批次2.4，重连按钮后端）：入保存串行链防与 save 交错；
 * 未启用或凭据缺失/非法 → 明确抛错（渲染层 saveError 展示），不静默半启动。
 */
export async function bridgePlatformRestart(platform: 'feishu' | 'wechat'): Promise<BridgePlatformStatusEntry[]> {
  return enqueueBridgeSave(async () => {
    const rt = runtime;
    if (!rt) throw new Error('bridge 未初始化');
    const broken = platform === 'feishu' ? rt.feishuSecretBroken : rt.wechatTokenBroken;
    let credentialOk: boolean;
    if (platform === 'feishu') {
      const f = rt.profiles.feishu;
      credentialOk = Boolean(f.appId && FEISHU_APPID_RE.test(f.appId) && f.appSecretEnc);
    } else {
      credentialOk = Boolean(rt.profiles.wechat.botTokenEnc);
    }
    if (!rt.profiles[platform].enabled || broken || !credentialOk) {
      throw new Error('平台未启用或凭据缺失，无法重连');
    }
    await rt.manager.startPlatform(platform);
    return rt.manager.getStatus();
  });
}

export function bridgeStatusGet(): BridgePlatformStatusEntry[] {
  if (!runtime) return [];
  return runtime.manager.getStatus();
}

/** 飞书凭据连通测试：POST tenant_access_token/internal，code===0 即成功（openhanako :815-839）。
 *  成功后附带 bot/v3/info 查询 botName（C1）——任何失败静默省略，不影响 ok 判定。 */
export async function bridgeFeishuTest(input: { appId?: string; appSecret?: string }): Promise<BridgeFeishuTestResult> {
  const rt = runtime;
  const stored = rt?.profiles.feishu;
  const region = stored?.region ?? 'feishu_cn';
  const domain = region === 'lark_global' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
  const appId = input.appId?.trim() || stored?.appId || '';
  let appSecret = input.appSecret ?? '';
  // 掩码凭据必须搭配已存密文；掩码语义 → 用已存密文解密。
  if (appSecret === MASKED_SECRET || (!appSecret && stored?.appSecretEnc)) {
    appSecret = stored?.appSecretEnc ? cipher.decrypt(stored.appSecretEnc) ?? '' : '';
  }
  if (!appId || !appSecret) return { ok: false, detail: 'App ID 或 App Secret 未填写' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${domain}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
      signal: controller.signal,
    });
    const data = (await res.json()) as { code?: number; msg?: string; tenant_access_token?: string };
    if (data.code === 0) {
      // C1：凭据通过后附带查 botName（bot/v3/info）。独立 10s 超时；失败静默省略不影响 ok。
      const token = data.tenant_access_token ?? '';
      let botName: string | undefined;
      if (token) {
        try {
          const ctrl2 = new AbortController();
          const timer2 = setTimeout(() => ctrl2.abort(), 10_000);
          try {
            const info = await fetch(`${domain}/open-apis/bot/v3/info`, {
              headers: { Authorization: `Bearer ${token}` },
              signal: ctrl2.signal,
            });
            const j = (await info.json()) as { code?: number; data?: { bot?: { bot_name?: string } } };
            if (j.code === 0 && j.data?.bot?.bot_name) botName = j.data.bot.bot_name;
          } finally {
            clearTimeout(timer2);
          }
        } catch { /* botName 可选：任何失败静默省略，不影响 ok */ }
      }
      return { ok: true, detail: '连接成功', botName };
    }
    return { ok: false, detail: `code=${String(data.code)} msg=${String(data.msg ?? '')}` };
  } catch (err) {
    return { ok: false, detail: String(err instanceof Error ? err.message : err) };
  } finally {
    clearTimeout(timer);
  }
}

export async function bridgeWechatQrcode(): Promise<{ qrcodeId: string; qrcodeDataUrl: string }> {
  return getWechatQrcode();
}

/** confirmed 时主进程直接写密文入 profiles（token 不出主进程），已启用则重启平台（B19 覆盖旧密文）。 */
export async function bridgeWechatQrcodeStatus(qrcodeId: string): Promise<WechatQrcodeStatusResult> {
  const rt = runtime;
  if (!rt) throw new Error('bridge 未初始化');
  const result = await pollWechatQrcodeStatus(qrcodeId);
  if (result.status !== 'confirmed') {
    // review P3b：error 不再映射成 expired——扫码期间网络故障显示「二维码已过期」会误导用户重扫
    //（重扫无效），错误文案透传渲染层展示。
    return result.status === 'error' ? { status: 'error', error: result.error } : { status: result.status };
  }
  rt.profiles.wechat.botTokenEnc = cipher.encrypt(result.botToken);
  rt.profiles.wechat.botUserId = result.botUserId;
  rt.wechatTokenBroken = false;
  persistProfiles(rt);
  // 2026-09-23 墓碑治本：重新扫码 = 微信桥全新开始，清掉旧解绑墓碑——否则 owner 的
  // 普通消息会被 flush 的墓碑分支静默吞（用户被迫发 /new 才能对话）。
  const purged = bindingRepo.purgeTombstonesByPlatform(getConnection(), 'wechat');
  if (purged > 0) logger.info(`[bridge] 微信重新登录：已清除 ${purged} 条旧解绑墓碑`);
  if (rt.profiles.wechat.enabled) {
    await rt.manager.startPlatform('wechat'); // stop→create→start：旧客户端收口后重建
  }
  return { status: 'confirmed', botUserId: result.botUserId };
}

export function bridgeBindingList(): BridgeBindingView[] {
  if (!runtime) return [];
  return bindingRepo.listBindings(getConnection()).map((b) => ({
    platform: b.platform,
    sessionKey: b.sessionKey,
    userId: b.userId,
    displayName: b.displayName,
    sessionId: b.sessionId,
    lastActiveAt: b.lastActiveAt,
  }));
}

/** phase 1 只解绑不删会话。V14 墓碑：先 DB 置位，再清 manager 缓冲定时器（免消息复活路径）。 */
export function bridgeUnbind(sessionKey: string): void {
  bindingRepo.deleteBinding(getConnection(), sessionKey);
  const rt = runtime;
  if (rt) rt.manager.unbind(sessionKey);
}
