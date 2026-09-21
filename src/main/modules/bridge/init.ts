// init.ts — bridge 模块的 electron 胶水层（唯一允许 import electron 的 bridge 文件）。
// 组装真实 deps：safeStorage cipher、主窗包装、sdk-backend/task-queue-engine/chat-send-locks 真函数、
// binding-repo（getConnection()）、resolveDefaultModel(getConfig())——dispatcher 与 CHAT_SEND 同构管线。
// IPC handler 本体在 ipc-handlers.ts 的 registerBridgeIpcHandlers，逻辑函数经本模块暴露。

import { safeStorage, type BrowserWindow } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { IPC_CHANNELS } from '../../../shared/constants';
import { resolveDefaultModel } from '../../../shared/settings-parser';
import type { BridgeConfigSaveInput, BridgePlatformStatusEntry, BridgeBindingView, WechatQrcodeStatusResult, BridgeConfigGetResult } from '../../../shared/types/bridge';
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
    resolveModel: () => resolveDefaultModel(getConfig().advancedJson),
    profiles: () => runtime?.profiles ?? rt.profiles,
    saveFeishuOwner: (openId) => {
      rt.profiles.feishu.ownerOpenId = openId;
      persistProfiles(rt);
      logger.info(`[bridge] 首个飞书私聊用户已自动捕获为 owner: ${openId.slice(0, 8)}…`);
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

  // B12：解密失败的凭据 → 平台不启动（enabled 也视为不可用），UI 红字提示重新录入。
  if (rt.feishuSecretBroken && rt.profiles.feishu.enabled) {
    logger.error('[bridge] 飞书 appSecret 解密失败，平台不启动；请在设置页重新录入');
  }
  if (rt.wechatTokenBroken && rt.profiles.wechat.enabled) {
    logger.error('[bridge] 微信 botToken 解密失败，平台不启动；请重新扫码登录');
  }
  // 已启用且凭据可用的平台随应用启动。
  if (rt.profiles.feishu.enabled && !rt.feishuSecretBroken) {
    void rt.manager.startPlatform('feishu');
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
    global: { workingDir: runtime.profiles.global.workingDir },
    secretBroken: { feishu: runtime.feishuSecretBroken, wechat: runtime.wechatTokenBroken },
  };
}

export async function bridgeConfigSave(input: BridgeConfigSaveInput): Promise<BridgeConfigGetResult> {
  const rt = runtime;
  if (!rt) throw new Error('bridge 未初始化');
  const p = rt.profiles;
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
    if (input.wechat.botToken !== undefined) {
      // 掩码=保留；空串=清除（退出登录）；新值=加密落库。
      p.wechat.botTokenEnc = resolveSecretPatch(p.wechat.botTokenEnc, input.wechat.botToken, cipher);
      rt.wechatTokenBroken = false;
    }
  }
  if (input.global && input.global.workingDir !== undefined) {
    p.global.workingDir = input.global.workingDir === '' ? null : input.global.workingDir;
  }
  persistProfiles(rt);

  // 存盘后重启受影响平台（enabled → start（stop→create→start）；禁用 → stop）。
  // 禁用分支带 clearBuffers:true（R1-P3d）：禁用即弃该平台在途缓冲；重启分支不传——
  // 缓冲与 debounce 定时器须原样跨重启，否则「保存一次凭据」会丢掉在途消息。
  if (input.feishu) {
    if (p.feishu.enabled && !rt.feishuSecretBroken) {
      await rt.manager.startPlatform('feishu');
    } else {
      await rt.manager.stopPlatform('feishu', { clearBuffers: true });
    }
  }
  if (input.wechat) {
    if (p.wechat.enabled && !rt.wechatTokenBroken) {
      await rt.manager.startPlatform('wechat');
    } else {
      await rt.manager.stopPlatform('wechat', { clearBuffers: true });
    }
  }
  return bridgeConfigGet();
}

export function bridgeStatusGet(): BridgePlatformStatusEntry[] {
  if (!runtime) return [];
  return runtime.manager.getStatus();
}

/** 飞书凭据连通测试：POST tenant_access_token/internal，code===0 即成功（openhanako :815-839）。 */
export async function bridgeFeishuTest(input: { appId?: string; appSecret?: string }): Promise<{ ok: boolean; detail?: string }> {
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
    const data = (await res.json()) as { code?: number; msg?: string };
    if (data.code === 0) return { ok: true, detail: '连接成功' };
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

/** phase 1 只解绑不删会话。 */
export function bridgeUnbind(sessionKey: string): void {
  bindingRepo.deleteBinding(getConnection(), sessionKey);
}
