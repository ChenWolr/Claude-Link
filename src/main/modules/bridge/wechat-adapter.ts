// wechat-adapter.ts — 微信 bridge 适配器（包 iLink 协议客户端）。
// 移植自 openhanako (Apache-2.0) lib/bridge/wechat-adapter.ts 的 adapter 壳（其另参考 MIT 的
// @tencent-weixin/openclaw-weixin v1.0.2）；协议本体在 wechat-ilink.ts。
// owner 判定不在 adapter 层——消息统一交 manager.handleInbound 按 owner-policy.ts 判定
//（批次5.2 收窄：仅 profiles.wechat.ownerUserId 精确匹配可触发对话，首个私聊用户自动捕获为 owner）。

import { createIlinkClient, type IlinkClient } from './wechat-ilink';
import type { BridgeInboundMessage, BridgeAdapterStatus } from '../../../shared/types/bridge';

export interface WechatAdapterOptions {
  botToken: string;
  stateDir: string;
  onMessage: (m: BridgeInboundMessage) => void;
  onStatus: (s: BridgeAdapterStatus) => void;
  fetchFn?: typeof fetch;
  intervalsForTest?: { pollTimeoutMs?: number; backoffMs?: number[] };
}

export interface WechatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(chatId: string, text: string): Promise<void>;
}

export function createWechatAdapter(opts: WechatAdapterOptions): WechatAdapter {
  let client: IlinkClient | null = null;
  let started = false;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    client = createIlinkClient(opts.botToken, {
      fetchFn: opts.fetchFn ?? fetch,
      stateDir: opts.stateDir,
      intervals: opts.intervalsForTest ? { ...opts.intervalsForTest } : undefined,
      onStatus: (s) => opts.onStatus(s),
      onMessage: (m) => opts.onMessage(m),
    });
    client.startLoop();
  }

  async function stop(): Promise<void> {
    if (!started) return;
    started = false;
    client?.stop();
    client = null;
    opts.onStatus({ status: 'disconnected' });
  }

  async function sendReply(chatId: string, text: string): Promise<void> {
    if (!client) throw new Error('微信适配器未启动');
    await client.sendText(chatId, text);
  }

  return { start, stop, sendReply };
}
