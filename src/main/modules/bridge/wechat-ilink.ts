// wechat-ilink.ts — 腾讯 iLink Bot 协议 HTTP 客户端（自研，非 wechaty/wcf/gewe，无外部网关）。
// 移植自 openhanako (Apache-2.0) lib/bridge/wechat-adapter.ts（其另参考 MIT 的
// @tencent-weixin/openclaw-weixin v1.0.2），按 claude-link phase 1 裁剪：
// 不移植媒体上传/typing/block 流式。fetch/now/间隔全部可注入（契约脚本用）。
// 关键协议事实：基址 ilinkai.weixin.qq.com；业务错误是 HTTP 200 且 ret != 0；
// getupdates 40s 长轮询 + get_updates_buf 增量 cursor（原子持久化，重启不丢不重）；
// 回复必须带对方 24h 内消息产生的 context_token。
// 对计划 IlinkDeps 的增补（偏差申报）：intervals/onStatus/onMessage 三个可选注入位。

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { splitWechatText } from '../../../shared/bridge/wechat-outbound';
import type { BridgeInboundMessage } from '../../../shared/types/bridge';

const LONG_POLL_TIMEOUT_MS = 40_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_DELAYS = [2000, 5000, 30_000];
const CONTEXT_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

// ── iLink 消息类型常量 ──
const MessageItemType = { TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5 } as const;
const MessageType = { USER: 1, BOT: 2 } as const;
const MessageState = { FINISH: 2 } as const;

export interface IlinkDeps {
  fetchFn: typeof fetch;
  stateDir: string;
  now?: () => number;
  intervals?: { pollTimeoutMs?: number; backoffMs?: number[]; pollSuccessPauseMs?: number };
  onStatus?: (s: { status: 'connected' | 'error' | 'disconnected'; error?: string }) => void;
  onMessage?: (m: BridgeInboundMessage) => void;
}

export interface IlinkClient {
  pollOnce(): Promise<void>;
  startLoop(): void;
  stop(): void;
  canReply(userId: string): boolean;
  getContextToken(userId: string): string | null;
  rememberContextToken(userId: string, token: string, expiresAt: number): void;
  sendText(userId: string, text: string): Promise<void>;
  isExpired(): boolean;
}

interface IlinkItem {
  type?: number;
  text_item?: { text?: string };
  voice_item?: { text?: string };
  ref_msg?: { title?: string; message_item?: IlinkItem };
}

interface IlinkMsg {
  from_user_id?: string;
  context_token?: string;
  item_list?: IlinkItem[];
}

// ── HTTP ──

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf-8').toString('base64');
}

function buildHeaders(token: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'AuthorizationType': 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

function isSessionExpiredError(err: unknown): boolean {
  const message = String((err as Error)?.message || '');
  return /(?:ret|errcode)=-14\b/.test(message);
}

function isAbortError(err: unknown): boolean {
  return (err as Error)?.name === 'AbortError';
}

// ── 持久化（cursor + context_token）──

function hash8(str: string): string {
  return crypto.createHash('sha256').update(str).digest('hex').slice(0, 8);
}

function atomicWriteSync(filePath: string, content: string): void {
  const tmp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf-8');
  fs.renameSync(tmp, filePath);
}

/**
 * 微信积压跳过标记（生命周期修复批次2.3，症状③）：平台禁用时写——重开后的首轮非空拉取整批
 * 丢弃、只前进 cursor，不补处理关闭期间服务端积压的消息。文件名带 token hash8（换号互不误伤），
 * 客户端创建时一次性消费（读后即删）。
 */
export function writeWechatSkipBacklogFlag(stateDir: string, botToken: string): void {
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    atomicWriteSync(path.join(stateDir, `skip-backlog-${hash8(botToken)}.json`), JSON.stringify({ createdAt: Date.now() }));
  } catch { /* 写失败按无标记处理（最多退回补处理积压的原状） */ }
}

interface ContextEntry {
  token: string;
  ts: number;
  expiresAt: number;
}

export function createIlinkClient(botToken: string, deps: IlinkDeps): IlinkClient {
  const baseUrl = 'https://ilinkai.weixin.qq.com';
  const now = deps.now ?? Date.now;
  const pollTimeoutMs = deps.intervals?.pollTimeoutMs ?? LONG_POLL_TIMEOUT_MS;
  const backoffDelays = deps.intervals?.backoffMs ?? BACKOFF_DELAYS;
  // 成功轮询后的间歇：生产中 getupdates 本身 hold 40s，此间歇只防「服务器秒回时紧密自旋」
  // （mock fetch / 异常网关下会打爆 CPU 与内存）。
  const pollSuccessPauseMs = deps.intervals?.pollSuccessPauseMs ?? 300;

  let generation = 0;
  let expired = false;
  let abortController = new AbortController();
  const timers = new Set<ReturnType<typeof setTimeout>>();

  fs.mkdirSync(deps.stateDir, { recursive: true });
  const syncBufPath = path.join(deps.stateDir, `sync-${hash8(botToken)}.json`);
  const contextCachePath = path.join(deps.stateDir, `context-${hash8(botToken)}.json`);
  const skipBacklogPath = path.join(deps.stateDir, `skip-backlog-${hash8(botToken)}.json`);

  // 积压跳过标志（批次2.3）：创建时探测一次性消费（读后即删）——首次非空拉取整批丢弃只进
  // cursor；空批保留标志到下一轮。无标志文件（正常启停/新 token）行为完全不变。
  let skipBacklogPending = false;
  try {
    if (fs.existsSync(skipBacklogPath)) {
      skipBacklogPending = true;
      fs.rmSync(skipBacklogPath, { force: true });
    }
  } catch { /* 探测失败按无标志 */ }

  // cursor：重启不丢不重（增量协议要求跨进程持久化）。
  let getUpdatesBuf = '';
  try {
    if (fs.existsSync(syncBufPath)) {
      const data = JSON.parse(fs.readFileSync(syncBufPath, 'utf-8')) as { get_updates_buf?: string };
      getUpdatesBuf = data.get_updates_buf || '';
    }
  } catch { /* 损坏按空 cursor 重放 */ }

  // context_token 存储：TTL 24h 惰性剪枝。
  const contextCache = new Map<string, ContextEntry>();
  try {
    if (fs.existsSync(contextCachePath)) {
      const data = JSON.parse(fs.readFileSync(contextCachePath, 'utf-8')) as {
        entries?: Record<string, { token?: string; ts?: number; expiresAt?: number }>;
      };
      const entries = data.entries ?? {};
      for (const [userId, raw] of Object.entries(entries)) {
        const ts = Number(raw?.ts);
        const expiresAt = Number(raw?.expiresAt || (Number.isFinite(ts) ? ts + CONTEXT_TOKEN_TTL_MS : 0));
        if (!raw?.token || !Number.isFinite(ts) || !Number.isFinite(expiresAt)) continue;
        if (expiresAt <= now()) continue;
        contextCache.set(userId, { token: raw.token, ts, expiresAt });
      }
    }
  } catch { /* 损坏按空缓存起步 */ }

  function saveContextCache(): void {
    try {
      const entries: Record<string, ContextEntry> = {};
      for (const [userId, entry] of contextCache.entries()) {
        if (entry.expiresAt <= now()) continue;
        entries[userId] = entry;
      }
      atomicWriteSync(contextCachePath, JSON.stringify({ version: 1, entries }));
    } catch { /* 忽略写盘失败（内存态仍可用） */ }
  }

  // 批次3.2：reportStatus 去重（对齐 feishu-adapter 写法）——40s 长轮询每轮成功都到 connected，
  // 不去重则每个轮询周期全量广播一次状态噪音；状态/error 变化时仍正常上报。
  let lastStatus: string | null = null;
  let lastError: string | null | undefined = undefined;
  function reportStatus(status: 'connected' | 'error' | 'disconnected', error?: string): void {
    const normalizedError = error ?? null;
    if (lastStatus === status && lastError === normalizedError) return;
    lastStatus = status;
    lastError = normalizedError;
    deps.onStatus?.(error ? { status, error } : { status });
  }

  function guardedSleep(ms: number, myGen: number): Promise<boolean> {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        timers.delete(id);
        resolve(myGen === generation);
      }, ms);
      timers.add(id);
    });
  }

  async function api(endpoint: string, body: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>> {
    const url = `${baseUrl}/${endpoint.replace(/^\/+/, '')}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? DEFAULT_API_TIMEOUT_MS);
    const onParentAbort = () => controller.abort();
    abortController.signal.addEventListener('abort', onParentAbort, { once: true });
    try {
      const res = await deps.fetchFn(url, {
        method: 'POST',
        headers: buildHeaders(botToken),
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      if (!res.ok) throw new Error(`${endpoint} HTTP ${res.status}: ${text}`);
      const json = JSON.parse(text) as Record<string, unknown>;
      // iLink 业务错误：HTTP 200 且 ret != 0。
      if (json.ret !== undefined && json.ret !== 0) {
        throw new Error(`${endpoint} ret=${String(json.ret)} errcode=${String(json.errcode ?? '')} errmsg=${String(json.errmsg ?? '')}`);
      }
      return json;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    } finally {
      abortController.signal.removeEventListener('abort', onParentAbort);
    }
  }

  // ── 入站 ──

  function extractText(itemList?: IlinkItem[]): string {
    if (!itemList?.length) return '';
    for (const item of itemList) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text != null) {
        const text = String(item.text_item.text);
        // 引用消息：拼 [引用: title | body]\n正文（媒体引用不拼）。
        const ref = item.ref_msg;
        if (!ref) return text;
        const parts: string[] = [];
        if (ref.title) parts.push(ref.title);
        if (ref.message_item) {
          const refBody = extractText([ref.message_item]); // 协议：message_item 是单个 item，包数组复用提取
          if (refBody) parts.push(refBody);
        }
        if (!parts.length) return text;
        return `[引用: ${parts.join(' | ')}]\n${text}`;
      }
      // 语音已 ASR 转文字，透传。
      if (item.type === MessageItemType.VOICE && item.voice_item?.text) {
        return item.voice_item.text;
      }
    }
    return '';
  }

  function handleInbound(msg: IlinkMsg): void {
    const fromUserId = msg.from_user_id || '';
    // 回声过滤：bot 自身消息忽略。
    if (!fromUserId || fromUserId.endsWith('@im.bot')) return;
    if (msg.context_token) {
      rememberContextToken(fromUserId, msg.context_token, now() + CONTEXT_TOKEN_TTL_MS);
    }
    const text = extractText(msg.item_list);
    if (!text.trim()) return;
    deps.onMessage?.({
      platform: 'wechat',
      chatId: fromUserId,
      userId: fromUserId,
      sessionKey: `wx_dm_${fromUserId}`,
      text,
      senderName: fromUserId.split('@')[0] || '微信用户',
      isGroup: false,
    });
  }

  // ── context_token 管理 ──

  function rememberContextToken(userId: string, token: string, expiresAt: number): void {
    contextCache.set(userId, { token, ts: now(), expiresAt });
    saveContextCache();
  }

  function getContextToken(userId: string): string | null {
    const entry = contextCache.get(userId);
    if (!entry) return null;
    if (entry.expiresAt <= now()) {
      contextCache.delete(userId);
      saveContextCache();
      return null;
    }
    return entry.token;
  }

  // ── 发送 ──

  // R1-P3h：段级断点（per userId）——多分段中途失败时记录 { 完整文本, 下一段索引 }，
  // manager 2s 整条重试（同 text）自然命中断点续发，不重复已送达段；全部送达即清除。
  // 换文本不命中（text 全等校验），全量重发。内存态即可：client 生命周期=平台连接生命周期。
  const lastSendState = new Map<string, { text: string; nextIndex: number }>();

  async function sendText(userId: string, text: string): Promise<void> {
    const contextToken = getContextToken(userId);
    if (!contextToken) throw new Error('微信：需要对方最近发过消息才能回复');
    // 长文本 4000 分段循环发送（不做 block 流式——iLink 对连续发消息有速率限制）。
    const chunks = splitWechatText(text);
    const breakpoint = lastSendState.get(userId);
    const startIndex = breakpoint && breakpoint.text === text ? breakpoint.nextIndex : 0;
    for (let i = startIndex; i < chunks.length; i++) {
      try {
        await api('ilink/bot/sendmessage', {
          msg: {
            from_user_id: '',
            to_user_id: userId,
            client_id: crypto.randomUUID(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text: chunks[i]! } }],
            context_token: contextToken,
          },
          base_info: { channel_version: '1.0.0' },
        });
      } catch (err) {
        // 段级断点：manager 的 2s 整条重试同 text 会从这里续发，不重复前 i 段（R1-P3h）。
        lastSendState.set(userId, { text, nextIndex: i });
        const detail = err instanceof Error ? err.message : String(err);
        throw new Error(`微信第 ${i + 1}/${chunks.length} 段发送失败，前 ${i} 段已送达，重试将续发：${detail}`);
      }
    }
    lastSendState.delete(userId); // 全部成功 → 清除断点（delete 幂等）
  }

  // ── 长轮询 ──

  async function pollOnce(): Promise<void> {
    const resp = await api('ilink/bot/getupdates', {
      get_updates_buf: getUpdatesBuf,
      base_info: { channel_version: '1.0.0' },
    }, pollTimeoutMs);
    reportStatus('connected');
    if (typeof resp.get_updates_buf === 'string' && resp.get_updates_buf) {
      getUpdatesBuf = resp.get_updates_buf;
      try {
        atomicWriteSync(syncBufPath, JSON.stringify({ get_updates_buf: getUpdatesBuf }));
      } catch { /* 忽略写盘失败 */ }
    }
    const msgs = (resp.msgs as IlinkMsg[] | undefined) ?? [];
    // 积压跳过（批次2.3）：标志在途且首批非空 → 整批丢弃、只前进 cursor（上方已写盘）；
    // 空批保留标志到下一轮（服务端可能尚未吐出积压）。
    if (skipBacklogPending) {
      if (msgs.length === 0) return;
      skipBacklogPending = false;
      console.info(`[wechat-bridge] 跳过积压消息 ${msgs.length} 条（平台关闭期间）`);
      return;
    }
    for (const msg of msgs) {
      try {
        handleInbound(msg);
      } catch { /* 单条解析失败不中断整批 */ }
    }
  }

  function startLoop(): void {
    const myGen = generation;
    let consecutiveFailures = 0;
    void (async () => {
      while (myGen === generation && !expired) {
        try {
          await pollOnce();
          consecutiveFailures = 0;
          const alive = await guardedSleep(pollSuccessPauseMs, myGen);
          if (!alive) return;
        } catch (err) {
          if (myGen !== generation) return;
          if (isAbortError(err)) continue; // 长轮询超时/stop 中断，正常
          if (isSessionExpiredError(err)) {
            // ret=-14 不可恢复：停轮询，等重新扫码（B10）。
            expired = true;
            reportStatus('error', 'session expired');
            return;
          }
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            reportStatus('error', String((err as Error)?.message ?? err));
          }
          const delay = backoffDelays[Math.min(consecutiveFailures - 1, backoffDelays.length - 1)] ?? 0;
          const alive = await guardedSleep(delay, myGen);
          if (!alive) return;
        }
      }
    })().catch(() => { /* 循环已由条件收口 */ });
  }

  function stop(): void {
    generation += 1;
    abortController.abort();
    abortController = new AbortController();
    for (const t of timers) clearTimeout(t);
    timers.clear();
    reportStatus('disconnected');
  }

  return {
    pollOnce,
    startLoop,
    stop,
    canReply: (userId: string) => getContextToken(userId) !== null,
    getContextToken,
    rememberContextToken,
    sendText,
    isExpired: () => expired,
  };
}
