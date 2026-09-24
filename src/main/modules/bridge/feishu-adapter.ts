// feishu-adapter.ts — 飞书 Bot WebSocket 长连接适配器。
// 移植自 openhanako (Apache-2.0) lib/bridge/feishu-adapter.ts，按 claude-link phase 1 裁剪：
// 仅文本收发（post 富文本解析保留文本部分，媒体 → 诊断占位）、无流式/无媒体上传/无 CardKit。
// SDK 为纯 ESM → 动态 import（externalizeDepsPlugin 保持外部依赖，运行时 import() 加载）；
// 测试经 opts.__loadSdkForTest 注入 fake（openhanako tests/feishu-adapter.test.ts 手法）。
// 本模块禁止运行时 import electron。

import {
  renderFeishuOutbound,
} from '../../../shared/bridge/feishu-outbound';
import type { BridgeInboundMessage, BridgeAdapterStatus } from '../../../shared/types/bridge';

/** @larksuiteoapi/node-sdk 最小使用面（动态 import 后 as 断言；fake 注入同形即可）。 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type LarkSdkModule = any;

const FEISHU_WS_OPEN = 1;
const FEISHU_WS_INITIAL_POLL_MS = 500;
const FEISHU_WS_INITIAL_MAX_CHECKS = 20;
const FEISHU_WS_HEALTH_INTERVAL_MS = 30_000;
// 批次3.1：错误文案中文化（渲染层内联展示，英文仅存 hover title 的形态废弃）。
const FEISHU_WS_DISCONNECTED_ERROR = '连接已断开，正在重连';
const MAX_MSG_SIZE = 100_000; // B2：超长入站截断（对齐 openhanako MAX_MSG_SIZE）
const USER_CACHE_MAX = 200;
const GROUP_IGNORE_LOG_INTERVAL_MS = 60_000; // R1-P3g：群消息忽略日志节流间隔

// R1-P3g：群消息忽略的节流时间戳（模块级——同一进程内所有 adapter 实例共享节流窗）。
// 用 console 而非 logger：本模块禁止 import electron（logger 拽 electron，会炸 tsx 契约脚本）。
let lastGroupIgnoreLogAt = 0;

const FEISHU_DOMAIN_BY_REGION: Record<string, { domain: string; sdkDomain: unknown }> = {
  feishu_cn: { domain: 'https://open.feishu.cn', sdkDomain: 'feishu_cn' },
  lark_global: { domain: 'https://open.larksuite.com', sdkDomain: 'lark_global' },
};

export function resolveFeishuDomain(region: 'feishu_cn' | 'lark_global'): { domain: string; sdkDomain: unknown } {
  const resolved = FEISHU_DOMAIN_BY_REGION[region];
  if (!resolved) throw new Error(`不支持的飞书区域: ${String(region)}`);
  return resolved;
}

interface FeishuMessagePayload {
  message_type?: string;
  chat_id?: string;
  chat_type?: string;
  content?: string;
  message_id?: string;
}

interface FeishuSenderPayload {
  sender_type?: string;
  sender_id?: { open_id?: string; user_id?: string; app_id?: string };
}

interface LarkRestClient {
  im: {
    message: {
      create(payload: { params: { receive_id_type: string }; data: { receive_id: string; msg_type: string; content: string } }): Promise<unknown>;
    };
  };
  contact: {
    user: {
      get(args: { path: { user_id: string }; params: { user_id_type: string } }): Promise<unknown>;
    };
  };
}

/** 适配器状态回调（去重后上报）。 */
export type FeishuStatusListener = (s: BridgeAdapterStatus) => void;

export interface FeishuAdapterOptions {
  appId: string;
  appSecret: string;
  region: 'feishu_cn' | 'lark_global';
  onMessage: (m: BridgeInboundMessage) => void;
  onStatus: FeishuStatusListener;
  /** 契约测试注入 fake lark 模块；生产走动态 import。 */
  __loadSdkForTest?: () => Promise<LarkSdkModule>;
  /** 契约测试注入轮询/巡检间隔（生产用默认值）。 */
  __intervalsForTest?: { initialPollMs?: number; healthIntervalMs?: number };
}

export interface FeishuAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendReply(chatId: string, text: string): Promise<void>;
}

// ── 错误包装（移植 openhanako :158-183：code/log_id 必须出现在错误信息）──

function describeFeishuError(err: unknown): string {
  const e = err as { response?: { data?: Record<string, unknown> }; data?: Record<string, unknown>; message?: string };
  const data = e?.response?.data || e?.data || null;
  if (data && typeof data === 'object') {
    const parts: string[] = [];
    if (data.code !== undefined) parts.push(`code=${String(data.code)}`);
    if (data.msg) parts.push(`msg=${String(data.msg)}`);
    const logId = (data.error as Record<string, unknown> | undefined)?.log_id || data.log_id;
    if (logId) parts.push(`log_id=${String(logId)}`);
    if (parts.length) return parts.join(', ');
  }
  return e?.message || String(err);
}

function wrapFeishuError(label: string, err: unknown): Error {
  return new Error(`飞书${label}失败：${describeFeishuError(err)}`);
}

// ── 入站规范化（移植 openhanako :228-379，裁剪媒体为诊断占位）──

function parseFeishuMessageContent(message: FeishuMessagePayload): Record<string, unknown> {
  if (message.content && typeof message.content === 'object') return message.content as Record<string, unknown>;
  try {
    return JSON.parse(message.content || '{}') as Record<string, unknown>;
  } catch (err) {
    throw new Error(`Invalid Feishu ${message.message_type || 'unknown'} content JSON: ${String(err instanceof Error ? err.message : err)}`);
  }
}

function diagnosticText(detail: string): string {
  return `[${detail}]`;
}

function normalizePostAtText(item: Record<string, unknown>): string {
  const id = item.user_name || item.name || item.user_id || item.open_id || item.id || '';
  return id ? `@${String(id)}` : '@unknown';
}

/** post 富文本：text/a/at/md 拼文本；img/media → 诊断占位（phase 1 无媒体）。 */
function normalizeFeishuPost(content: Record<string, unknown>): { text: string } {
  const diagnostics: string[] = [];
  const localePayload = (content.zh_cn
    || content.en_us
    || Object.values(content).find((v) => v && typeof v === 'object' && Array.isArray((v as Record<string, unknown>).content))
    || (Array.isArray(content.content) ? content : null)) as { content?: unknown[] } | null;
  if (!localePayload) {
    const detail = 'Unsupported Feishu post content: missing locale content';
    return { text: diagnosticText(detail) };
  }
  const paragraphs = Array.isArray(localePayload.content) ? localePayload.content : [];
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!Array.isArray(paragraph)) continue;
    let line = '';
    for (const rawItem of paragraph) {
      const item = rawItem as Record<string, unknown>;
      const tag = item?.tag || item?.type;
      if (tag === 'text' || tag === 'md') {
        line += String(item.text ?? '');
      } else if (tag === 'a') {
        line += String(item.text ?? item.href ?? '');
      } else if (tag === 'at') {
        line += normalizePostAtText(item);
      } else if (tag === 'img' || tag === 'image') {
        diagnostics.push('飞书 post 图片，当前版本暂不支持');
      } else if (tag === 'media') {
        diagnostics.push('飞书 post 视频，当前版本暂不支持');
      } else {
        diagnostics.push(`Unsupported Feishu post tag: ${String(tag || 'unknown')}`);
      }
    }
    if (line) lines.push(line);
  }
  const textParts = [...lines, ...diagnostics.map(diagnosticText)];
  return { text: textParts.join('\n') };
}

/** phase 1 文本 only：非 text/post 类型产出诊断文本（不静默丢弃）。 */
function normalizeFeishuInboundMessage(message: FeishuMessagePayload): { text: string } {
  let content: Record<string, unknown>;
  try {
    content = parseFeishuMessageContent(message);
  } catch (err) {
    return { text: diagnosticText(err instanceof Error ? err.message : String(err)) };
  }
  if (message.message_type === 'text') {
    return { text: String(content.text ?? '') };
  }
  if (message.message_type === 'post') {
    return normalizeFeishuPost(content);
  }
  const detail = `飞书消息类型: ${message.message_type || 'unknown'}，当前版本暂不支持`;
  return { text: diagnosticText(detail) };
}

function isSelfFeishuBotSender(sender: FeishuSenderPayload, appId: string): boolean {
  const senderType = sender?.sender_type;
  if (senderType !== 'bot' && senderType !== 'app') return false;
  return Boolean(appId && sender?.sender_id?.app_id === appId);
}

function unrefTimer(timer: NodeJS.Timeout): NodeJS.Timeout {
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export function createFeishuAdapter(opts: FeishuAdapterOptions): FeishuAdapter {
  // B16：region 非法 → 构造即 throw，且不创建任何客户端。
  const feishuDomain = resolveFeishuDomain(opts.region);

  let started = false;
  let stopped = false;
  let lark: LarkSdkModule | null = null;
  let restClient: LarkRestClient | null = null;
  let wsClient: {
    start(args: { eventDispatcher: unknown }): Promise<void>;
    close(): void;
    wsConfig?: { wsInstance?: { readyState?: number } | null };
  } | null = null;
  let connectionPollTimer: NodeJS.Timeout | null = null;
  let healthTimer: NodeJS.Timeout | null = null;
  let lastStatus: string | null = null;
  let lastError: string | null | undefined = undefined;

  /** 发送者昵称缓存（LRU 200，只缓存成功结果；失败下次重试，openhanako :414-449）。 */
  const userCache = new Map<string, string>();

  const initialPollMs = opts.__intervalsForTest?.initialPollMs ?? FEISHU_WS_INITIAL_POLL_MS;
  const healthIntervalMs = opts.__intervalsForTest?.healthIntervalMs ?? FEISHU_WS_HEALTH_INTERVAL_MS;

  async function loadSdk(): Promise<LarkSdkModule> {
    if (opts.__loadSdkForTest) return opts.__loadSdkForTest();
    // 模块级缓存手法同 sdk-backend 动态加载 claude-agent-sdk：进程内只加载一次。
    return import('@larksuiteoapi/node-sdk') as Promise<LarkSdkModule>;
  }

  function reportStatus(status: BridgeAdapterStatus['status'], error?: string): void {
    const normalizedError = error ?? null;
    if (lastStatus === status && lastError === normalizedError) return;
    lastStatus = status;
    lastError = normalizedError;
    opts.onStatus(normalizedError ? { status, error: normalizedError } : { status });
  }

  async function getUserDisplayName(openId: string): Promise<string> {
    const cached = userCache.get(openId);
    if (cached) {
      // LRU touch
      userCache.delete(openId);
      userCache.set(openId, cached);
      return cached;
    }
    try {
      const res = (await restClient!.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })) as { data?: { user?: { nickname?: string; en_name?: string; name?: string } } };
      // 优先 nickname（用户昵称）→ en_name → name（真名）。
      const user = res?.data?.user;
      const displayName = user?.nickname || user?.en_name || user?.name || null;
      if (displayName) {
        userCache.set(openId, displayName);
        if (userCache.size > USER_CACHE_MAX) {
          const oldest = userCache.keys().next().value;
          if (oldest !== undefined) userCache.delete(oldest);
        }
      }
      return displayName || openId;
    } catch {
      return openId; // 失败不缓存，回落 open_id
    }
  }

  async function handleInboundEvent(data: unknown): Promise<void> {
    const { message, sender } = (data ?? {}) as { message?: FeishuMessagePayload; sender?: FeishuSenderPayload };
    if (!message || !sender) return;
    // 只忽略本应用自己的回声；其他 bot/app 的消息保留（openhanako :124-128）。
    if (isSelfFeishuBotSender(sender, opts.appId)) return;

    // phase 1 仅私聊：群聊消息忽略并记节流日志（§1 全局约束；R1-P3g：不再无痕静默）。
    const isGroup = message.chat_type === 'group';
    if (isGroup) {
      const nowTs = Date.now();
      if (nowTs - lastGroupIgnoreLogAt >= GROUP_IGNORE_LOG_INTERVAL_MS) {
        lastGroupIgnoreLogAt = nowTs;
        console.log('[bridge] 飞书群聊消息已忽略（phase 1 仅私聊）chat_id=' + String(message.chat_id ?? ''));
      }
      return;
    }

    let text: string;
    try {
      text = normalizeFeishuInboundMessage(message).text;
    } catch (err) {
      text = diagnosticText(err instanceof Error ? err.message : String(err));
    }
    if (!text.trim()) return;

    // B2：超长消息截断后照常处理。
    if (text.length > MAX_MSG_SIZE) {
      text = text.slice(0, MAX_MSG_SIZE);
    }

    const chatId = message.chat_id || '';
    const openId = sender.sender_id?.open_id || sender.sender_id?.app_id || 'unknown';
    const userId = sender.sender_id?.user_id || openId;
    const isBotSender = sender.sender_type === 'bot' || sender.sender_type === 'app';
    const senderName = isBotSender
      ? sender.sender_id?.app_id || 'Feishu Bot'
      : await getUserDisplayName(openId);

    opts.onMessage({
      platform: 'feishu',
      chatId,
      userId,
      sessionKey: `fs_dm_${openId}`,
      text,
      senderName,
      isGroup: false,
    });
  }

  function clearConnectionPoll(): void {
    if (connectionPollTimer) {
      clearInterval(connectionPollTimer);
      connectionPollTimer = null;
    }
  }

  function clearHealthTimer(): void {
    if (healthTimer) {
      clearTimeout(healthTimer);
      healthTimer = null;
    }
  }

  function isWsOpen(): boolean {
    return wsClient?.wsConfig?.wsInstance?.readyState === FEISHU_WS_OPEN;
  }

  // B9：10s 初始轮询（500ms×20）+ 30s 健康巡检自动重连。
  function scheduleHealthCheck(): void {
    if (stopped || healthTimer) return;
    healthTimer = unrefTimer(setTimeout(() => {
      healthTimer = null;
      if (stopped) return;
      if (isWsOpen()) {
        reportStatus('connected');
        scheduleHealthCheck();
        return;
      }
      reportStatus('error', FEISHU_WS_DISCONNECTED_ERROR);
      void startWsClient(eventDispatcher);
      scheduleHealthCheck();
    }, healthIntervalMs));
  }

  function pollConnectionAfterStart(): void {
    clearConnectionPoll();
    let checks = 0;
    connectionPollTimer = unrefTimer(setInterval(() => {
      if (stopped) {
        clearConnectionPoll();
        return;
      }
      checks += 1;
      if (isWsOpen()) {
        clearConnectionPoll();
        reportStatus('connected');
        scheduleHealthCheck();
      } else if (checks >= FEISHU_WS_INITIAL_MAX_CHECKS) {
        clearConnectionPoll();
        reportStatus('error', '连接建立失败，将自动重试');
        scheduleHealthCheck();
      }
    }, initialPollMs));
  }

  function startWsClient(dispatcher: { register(handlers: Record<string, (data: unknown) => Promise<void> | void>): void } | null): Promise<void> {
    if (stopped || !wsClient || !dispatcher) return Promise.resolve();
    return wsClient
      .start({ eventDispatcher: dispatcher })
      .then(() => {
        if (!stopped) pollConnectionAfterStart();
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        reportStatus('error', `连接异常：${message}`);
        scheduleHealthCheck();
      });
  }

  let eventDispatcher: { register(handlers: Record<string, (data: unknown) => Promise<void> | void>): void } | null = null;

  async function start(): Promise<void> {
    if (started) return;
    started = true;
    stopped = false;
    reportStatus('connecting');
    lark = await loadSdk();
    const dispatcher = new lark.EventDispatcher({});
    dispatcher.register({
      'im.message.receive_v1': (data: unknown) => handleInboundEvent(data),
    });
    eventDispatcher = dispatcher;
    restClient = new lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: feishuDomain.sdkDomain,
    });
    wsClient = new lark.WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      domain: feishuDomain.sdkDomain,
      loggerLevel: lark.LoggerLevel?.warn,
    });
    await startWsClient(dispatcher);
  }

  async function stop(): Promise<void> {
    stopped = true;
    started = false;
    clearConnectionPoll();
    clearHealthTimer();
    try {
      wsClient?.close();
    } catch {
      // 已断开时 close 可能抛，忽略
    }
    reportStatus('disconnected');
  }

  async function sendReply(chatId: string, text: string): Promise<void> {
    if (!restClient) throw new Error('飞书适配器未启动');
    const rendered = renderFeishuOutbound(text);
    try {
      await restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: {
          receive_id: chatId,
          msg_type: rendered.msgType,
          content: rendered.content,
        },
      });
    } catch (err) {
      throw wrapFeishuError('消息发送', err);
    }
  }

  return { start, stop, sendReply };
}
