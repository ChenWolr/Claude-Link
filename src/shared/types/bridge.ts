// bridge.ts — IM 机器人（飞书/微信 bridge）共享类型：入站消息、平台状态、IPC 载荷。
// 渲染层与主进程共用；凭据类字段一律掩码形态（见 bridge/profiles.ts 的 View 类型）。

export type BridgePlatform = 'feishu' | 'wechat';

export type BridgePlatformStatus = 'off' | 'connecting' | 'connected' | 'error' | 'disconnected';

/** 适配器 → manager 的入站消息（adapter onMessage 回调载荷）。 */
export interface BridgeInboundMessage {
  platform: BridgePlatform;
  chatId: string;
  userId: string;
  sessionKey: string;
  text: string;
  senderName: string;
  isGroup: boolean;
}

/** 适配器状态回调载荷。 */
export interface BridgeAdapterStatus {
  status: BridgePlatformStatus;
  error?: string;
}

/** manager 对渲染层广播的单平台状态行（BRIDGE_STATUS_CHANGED / BRIDGE_STATUS_GET 载荷元素）。 */
export interface BridgePlatformStatusEntry {
  platform: BridgePlatform;
  status: BridgePlatformStatus;
  error?: string;
}

/** BRIDGE_CONFIG_SAVE 入参（渲染层 → 主进程；appSecret 为明文新值/掩码/空串，语义见 profiles.resolveSecretPatch）。 */
export interface BridgeConfigSaveInput {
  feishu?: {
    enabled?: boolean;
    appId?: string;
    appSecret?: string;
    region?: 'feishu_cn' | 'lark_global';
    ownerOpenId?: string | null;
  };
  wechat?: {
    enabled?: boolean;
    /** 掩码/空串语义同 appSecret：掩码=保留，空串=清除（退出登录）。 */
    botToken?: string;
    /** 授权用户（批次5.2）：'' = 清除授权（主进程归一为 null），非空 = 设为该 userId。 */
    ownerUserId?: string | null;
  };
  global?: {
    workingDir?: string | null;
    /** A2 处理中回执开关（缺省不覆盖）。 */
    receiptEnabled?: boolean;
  };
}

/** 微信扫码状态轮询返回（BRIDGE_WECHAT_QRCODE_STATUS）。error=扫码链路故障（网络/服务端），错误文案透传展示（review P3b），不再映射成 expired 误导用户重扫。 */
export type WechatQrcodeStatusResult =
  | { status: 'wait' | 'scaned' | 'expired' }
  | { status: 'confirmed'; botUserId?: string }
  | { status: 'error'; error: string };

/** BRIDGE_CONFIG_GET 返回（凭据只有掩码形态；secretBroken=解密失败需重录）。 */
export interface BridgeConfigGetResult {
  feishu: {
    enabled: boolean;
    appId: string;
    hasAppSecret: boolean;
    appSecretMasked: string | null;
    region: 'feishu_cn' | 'lark_global';
    ownerOpenId: string | null;
  };
  wechat: {
    enabled: boolean;
    loggedIn: boolean;
    botUserId: string | null;
    /** 授权用户（批次5.2 owner 收窄）：null = 未定（下一个私聊用户首捕获）。 */
    ownerUserId: string | null;
  };
  global: { workingDir: string | null; receiptEnabled: boolean };
  secretBroken: { feishu: boolean; wechat: boolean };
}

/** 绑定列表行（BRIDGE_BINDING_LIST）。 */
export interface BridgeBindingView {
  platform: BridgePlatform;
  sessionKey: string;
  userId: string;
  displayName: string | null;
  sessionId: string;
  lastActiveAt: number;
}
