// profiles.ts — bridge 凭据/开关存取（fs + 注入 cipher + 掩码视图）。
// appSecret/botToken 永不进 AppConfig（AppConfig 经 CONFIG_GET 整体出主进程，审计 G1/G2 教训）；
// 独立存 userData/bridge/profiles.json，safeStorage 加密（cipher 由 bridge/init.ts 注入，
// 本模块零 electron 依赖）。一切 IPC 出口只回掩码 ******** + has*/loggedIn；写侧掩码值保留旧值。
// 掩码语义对照 openhanako (Apache-2.0) shared/secret-custody.ts。

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface BridgeCipher {
  encrypt(plain: string): string;
  decrypt(enc: string): string | null;
}

export interface BridgeGlobalConfig {
  workingDir: string | null;
}

export interface FeishuProfileStored {
  enabled: boolean;
  appId: string;
  appSecretEnc: string | null;
  region: 'feishu_cn' | 'lark_global';
  ownerOpenId: string | null;
}

export interface WechatProfileStored {
  enabled: boolean;
  botTokenEnc: string | null;
  botUserId: string | null;
  // 批次5.2：授权用户收窄——仅此 userId 可触发对话；null = 未定（下一个私聊用户首捕获）。
  ownerUserId: string | null;
}

export interface BridgeProfilesStored {
  global: BridgeGlobalConfig;
  feishu: FeishuProfileStored;
  wechat: WechatProfileStored;
}

/** 渲染层视图（掩码；绝不含明文/密文）。 */
export interface FeishuProfileView {
  enabled: boolean;
  appId: string;
  hasAppSecret: boolean;
  appSecretMasked: string | null;
  region: 'feishu_cn' | 'lark_global';
  ownerOpenId: string | null;
}

export interface WechatProfileView {
  enabled: boolean;
  loggedIn: boolean;
  botUserId: string | null;
  ownerUserId: string | null;
}

export const MASKED_SECRET = '********';

export function defaultProfiles(): BridgeProfilesStored {
  return {
    global: { workingDir: null },
    feishu: { enabled: false, appId: '', appSecretEnc: null, region: 'feishu_cn', ownerOpenId: null },
    wechat: { enabled: false, botTokenEnc: null, botUserId: null, ownerUserId: null },
  };
}

export interface BridgeProfilesLoadStatus {
  profiles: BridgeProfilesStored;
  feishuSecretBroken: boolean;
  wechatTokenBroken: boolean;
}

/**
 * 读 profiles.json：文件缺失/损坏 → 默认值不抛（B13）；解密失败 → Enc 置 null + broken 标记
 * （B12：调用方据 broken 拒启平台并提示重新录入）。
 */
export function loadProfilesWithStatus(file: string, cipher: BridgeCipher): BridgeProfilesLoadStatus {
  const result: BridgeProfilesLoadStatus = {
    profiles: defaultProfiles(),
    feishuSecretBroken: false,
    wechatTokenBroken: false,
  };
  try {
    if (!fs.existsSync(file)) return result;
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<BridgeProfilesStored>;
    const d = result.profiles;
    if (raw.global && typeof raw.global === 'object') {
      d.global.workingDir = typeof raw.global.workingDir === 'string' ? raw.global.workingDir : null;
    }
    if (raw.feishu && typeof raw.feishu === 'object') {
      d.feishu.enabled = raw.feishu.enabled === true;
      d.feishu.appId = typeof raw.feishu.appId === 'string' ? raw.feishu.appId : '';
      d.feishu.region = raw.feishu.region === 'lark_global' ? 'lark_global' : 'feishu_cn';
      d.feishu.ownerOpenId = typeof raw.feishu.ownerOpenId === 'string' ? raw.feishu.ownerOpenId : null;
      if (typeof raw.feishu.appSecretEnc === 'string' && raw.feishu.appSecretEnc) {
        if (cipher.decrypt(raw.feishu.appSecretEnc) === null) {
          result.feishuSecretBroken = true;
        } else {
          d.feishu.appSecretEnc = raw.feishu.appSecretEnc;
        }
      }
    }
    if (raw.wechat && typeof raw.wechat === 'object') {
      d.wechat.enabled = raw.wechat.enabled === true;
      d.wechat.botUserId = typeof raw.wechat.botUserId === 'string' ? raw.wechat.botUserId : null;
      // 批次5.2：老文件缺 ownerUserId 字段 → 兜底 null（等待首捕获/存量迁移）。
      d.wechat.ownerUserId = typeof raw.wechat.ownerUserId === 'string' && raw.wechat.ownerUserId ? raw.wechat.ownerUserId : null;
      if (typeof raw.wechat.botTokenEnc === 'string' && raw.wechat.botTokenEnc) {
        if (cipher.decrypt(raw.wechat.botTokenEnc) === null) {
          result.wechatTokenBroken = true;
        } else {
          d.wechat.botTokenEnc = raw.wechat.botTokenEnc;
        }
      }
    }
  } catch {
    // 损坏 JSON：整体回落默认值（B13），不抛。
    result.profiles = defaultProfiles();
  }
  return result;
}

export function loadProfiles(file: string, cipher: BridgeCipher): BridgeProfilesStored {
  return loadProfilesWithStatus(file, cipher).profiles;
}

/** 原子写（tmp + rename），避免半写文件被下次启动读成损坏。 */
export function saveProfiles(file: string, p: BridgeProfilesStored): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(p, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function toFeishuView(p: BridgeProfilesStored): FeishuProfileView {
  const has = typeof p.feishu.appSecretEnc === 'string' && p.feishu.appSecretEnc.length > 0;
  return {
    enabled: p.feishu.enabled,
    appId: p.feishu.appId,
    hasAppSecret: has,
    appSecretMasked: has ? MASKED_SECRET : null,
    region: p.feishu.region,
    ownerOpenId: p.feishu.ownerOpenId,
  };
}

export function toWechatView(p: BridgeProfilesStored): WechatProfileView {
  return {
    enabled: p.wechat.enabled,
    loggedIn: typeof p.wechat.botTokenEnc === 'string' && p.wechat.botTokenEnc.length > 0,
    ownerUserId: p.wechat.ownerUserId,
    botUserId: p.wechat.botUserId,
  };
}

/**
 * 写侧掩码语义：incoming === MASKED_SECRET 或 undefined → 保留 currentEnc（用户没改密钥，
 * 掩码值原样回传不得覆盖真值）；空串 → null（显式清除）；其他非空字符串 → 加密落库。
 */
export function resolveSecretPatch(
  currentEnc: string | null,
  incoming: string | undefined,
  cipher: BridgeCipher,
): string | null {
  if (incoming === undefined || incoming === MASKED_SECRET) return currentEnc;
  if (incoming === '') return null;
  return cipher.encrypt(incoming);
}
