// session-key.ts — bridge 会话键构造/解析（纯函数，零依赖）。
// 会话键形态对齐 openhanako（移植自 openhanako Apache-2.0 lib/bridge/session-key.ts:9-19，
// 只保留 claude-link phase 1 的两个平台）。claude-link 不带 @agentId 后缀（单 agent 形态）。
// phase 1 仅私聊：fs_dm_/wx_dm_；群键（fs_group_）不构造也不解析。

export type BridgePlatform = 'feishu' | 'wechat';

/** 平台 → 私聊会话键前缀。新增平台在此注册前缀即可。 */
const SESSION_DM_PREFIX: Readonly<Record<BridgePlatform, string>> = {
  feishu: 'fs_dm_',
  wechat: 'wx_dm_',
};

/** phase 1 识别的私聊前缀表（群键一律不认，parse 返回 null）。 */
const DM_PREFIXES: ReadonlyArray<readonly [prefix: string, platform: BridgePlatform]> = [
  ['fs_dm_', 'feishu'],
  ['wx_dm_', 'wechat'],
];

export function buildBridgeSessionKey(platform: BridgePlatform, platformUserId: string): string {
  return `${SESSION_DM_PREFIX[platform]}${platformUserId}`;
}

export function parseBridgeSessionKey(key: string): { platform: BridgePlatform; userId: string } | null {
  for (const [prefix, platform] of DM_PREFIXES) {
    if (key.startsWith(prefix)) {
      const userId = key.slice(prefix.length);
      if (!userId) return null;
      return { platform, userId };
    }
  }
  return null;
}
