// owner-policy.ts — bridge owner 判定（纯函数）。
// 语义移植自 openhanako (Apache-2.0) lib/bridge/owner-policy.ts，按 claude-link 批次5.2 收窄：
// 两平台统一 userId 精确匹配（owner 未配置 = 无 owner，claude-link 侧首个私聊用户会被
// manager.handleInbound 自动捕获为 owner）。原「微信任何私聊用户即 owner」已废除（无鉴权高危）。

export function isBridgeOwner(
  _platform: 'feishu' | 'wechat',
  userId: string,
  ownerUserId: string | null,
): boolean {
  if (!userId) return false;
  if (!ownerUserId) return false;
  return ownerUserId === userId;
}
