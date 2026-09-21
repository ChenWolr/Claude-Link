// owner-policy.ts — bridge owner 判定（纯函数）。
// 语义移植自 openhanako (Apache-2.0) lib/bridge/owner-policy.ts:8-11：
// 微信无 owner 配置概念——任何私聊用户即 owner；飞书按 ownerOpenId 精确匹配（未配置 = 无 owner，
// 但 claude-link 侧首个私聊用户会被 manager 自动捕获为 owner，见 manager.handleInbound）。

export function isBridgeOwner(
  platform: 'feishu' | 'wechat',
  userId: string,
  feishuOwnerOpenId: string | null,
): boolean {
  if (!userId) return false;
  if (platform === 'wechat') return true;
  return feishuOwnerOpenId !== null && feishuOwnerOpenId !== '' && feishuOwnerOpenId === userId;
}
