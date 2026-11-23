// 【连接面声明】本模块是主进程 HTTP 直连白名单成员（契约：scripts/regression-tests.ts 连接面
// 白名单断言 B，2026-11-20 第三轮 R6 免费网页 MT 引擎组登记）。AI 回复翻译引擎层：
// 五种引擎适配器（bing-web / alibaba-web / qq-transmart / sogou-web / youdao-web）+
// WebMtEngineGroup 组逻辑（order 升序 + enabled 过滤实例化、失败逐引擎降级
// 全耗尽 → 段级失败、429 冷却表、单引擎尝试 10s 超时）+ 出站代理接线（env HTTPS_PROXY 优先 →
// CONNECT 隧道 agent；env 缺失回落 session.defaultSession.resolveProxy；仅 useProxy 引擎应用）。
// 2026-11-22 扩容批次 p6/W5：注册/付费层（官方 API 付费引擎）与模板引擎（DSL）整链移除
// ——适配器/kind/凭据链/节流全删（00 计划 W5 用户裁决：付费的不必要存在），unavailable 机械面
// 保留休眠（评审 P2-7，见 createWebMtEngineGroup）。
// 2026-11-22 扩容批次 p7/W4：baidu-web 死引擎清理 + google-gtx 用户裁决剔除（「谷歌先剔除掉」）
// ——两死引擎适配器与其出厂端点常量整链删除，dispatch 收窄到五 kind 终态（seed 遗留条目经
// sanitize 读路径剔除+补齐归一，见 shared/translation-core.ts；符号面零残留由 E1 卷 EX-P7-1
// 结构钉承载，本注释不引用死符号名）。
// https/http.request 直连形态同 topic-analyzer。零第三方依赖（node:crypto 签名/哈希、node:net
// CONNECT 握手）。不读任何 settings.json——引擎配置经 translation-service 从 config-manager
// 传入（TranslationConfig 形状，shared/types/config.ts）；聊天凭据/端点/模型零接触。
//
// 测试 seam（03 裁决 R3 / 01 §5.2.7 引擎尝试契约）：__setTranslationEnginesTransportForTest 注入
// transport 覆盖真实 HTTP（translation-service 的 __setTranslationTransportForTest 转发到此）；
// stub 语义 = 逐段确定性应答（{engineKind, segment, signal} → {ok,text}|{ok,error}），生产代码
// 永不调用。探测（probeEngines）与翻译共用同一 seam（probe 调用 segment=TRANSLATION_PROBE_TEXT）。
//
// 已知技术边界（对用户言明，01 §5.2.3；2026-11-22 09 报告勘误）：带签名算法的引擎（bing/有道）
// 协议逻辑固定于代码适配器（有道 V2 重写后为固定多主机协议不消费 endpoint——2026-11-22
// 扩容批次评审 P1-5；bing 仅域名可配；alibaba/qq/sogou 同为固定多主机协议）；厂商改版 →
// 该引擎确定性失败降级，组内其余引擎
// 接管（探测结果表可见）。勘误（09-bing复活发现与修复方案 §4/§5）：bing 不再是确定性失败边界
// ——params_AbusePreventionHelper 的 key/token 语义修正（key=数组[0] 时间戳位、token=数组[1]；
// 旧实现把 arr[2] 有效期 ms 当 key 发送）后 ttranslatev3 客户端直连实测 200 可用（usedLLM:true），
// 「ttranslatev3 TLS 指纹级不可廉价修复」旧结论作废。
import * as https from 'node:https';
import * as http from 'node:http';
import * as tls from 'node:tls';
import * as crypto from 'node:crypto';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { logger } from '../utils/logger';
import {
  TRANSLATION_ENGINE_TRY_TIMEOUT_MS,
  TRANSLATION_ENGINE_429_COOLDOWN_MS,
  TRANSLATION_RESPONSE_MAX_BYTES,
  DEFAULT_BING_WEB_DOMAIN,
} from '../../shared/translation-core';
import type { TranslationConfig, TranslationEngineConfig } from '../../shared/types/config';

// ── 引擎层接口（01 §5.2.1） ──

export type TranslationEngineAttempt =
  | { ok: true; text: string }
  | { ok: false; error: string; kind: 'network' | 'http-4xx' | 'rate-limit' | 'parse' | 'auth' };

export interface TranslationEngine {
  readonly kind: TranslationEngineConfig['kind'];
  /** 对应 TranslationEngineConfig.id（粘性引擎与探测结果表的锚点）。 */
  readonly id: string;
  translate(segment: string, signal: AbortSignal): Promise<TranslationEngineAttempt>;
}

// ── R3 seam：引擎尝试契约（01 §5.2.7） ──

export interface TranslationTransportRequest {
  /** TranslationEngineKind 字面（stub 侧按引擎分流应答/失败）。 */
  engineKind: string;
  /** 段文本；probe 调用时 = TRANSLATION_PROBE_TEXT（stub 可区分探测与翻译）。 */
  segment: string;
  signal: AbortSignal;
}

export type TranslationTransport = (
  req: TranslationTransportRequest,
) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;

let transportOverride: TranslationTransport | null = null;

/** @internal test-only — 注入 fake transport 覆盖真实引擎 HTTP；传 null 恢复默认。生产永不调用。 */
export function __setTranslationEnginesTransportForTest(transport: TranslationTransport | null): void {
  transportOverride = transport;
}

// ── 出站代理接线（01 §5.2.3：env 优先 → CONNECT 隧道 agent；env 缺失回落 resolveProxy） ──

/** env 代理变量读取（typeof process 守卫兼容 vm 装载；优先序 HTTPS_PROXY > https_proxy > HTTP_PROXY > all_proxy）。 */
function readProxyEnv(): string | null {
  const env = typeof process !== 'undefined' ? process.env : undefined;
  if (!env) return null;
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.all_proxy;
  return typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null;
}

function parseProxyUrl(raw: string): URL | null {
  try {
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * 解析某引擎的出站代理（仅 useProxy:true 引擎调用；返回 null = 直连）。
 * 降级链：env（HTTPS_PROXY/https_proxy/HTTP_PROXY/all_proxy）→ 缺失回落 Electron
 * session.defaultSession.resolveProxy（Chromium 系统代理口径），PROXY host:port 解析后走同隧道；
 * 皆无 → 直连。parse 失败 = 无效（等同未配置，继续降级链，不抛异常不阻断）。
 * vm/无 electron 环境（契约卷）守卫为 null。
 * 第二参（显式出站代理地址）为休眠机械面（评审 P3-7 口径：无出厂/UI 入口消费者，机械保留原样）
 * ——P1-B 代理面回撤后生产零传参（原 config 显式代理闭包传参随 google 剔除删除，p8/W4）；
 * 签名与优先级语义保留：将来引擎加回即恢复消费（显式地址 > env > 系统代理）。
 */
export async function resolveOutboundProxy(
  useProxy: boolean,
  explicitProxyUrl?: string | null,
): Promise<URL | null> {
  if (!useProxy) return null;
  const explicitRaw = typeof explicitProxyUrl === 'string' ? explicitProxyUrl.trim() : '';
  if (explicitRaw) {
    const parsed = parseProxyUrl(explicitRaw);
    if (parsed) return parsed;
  }
  const envRaw = readProxyEnv();
  if (envRaw) return parseProxyUrl(envRaw);
  try {
    const electron = require('electron') as
      | { session?: { defaultSession?: { resolveProxy?: (url: string) => Promise<string> } } }
      | string;
    if (typeof electron !== 'object' || !electron?.session?.defaultSession?.resolveProxy) return null;
    // 探测目标 URL：原为 google 端点（google-gtx 是唯一 useProxy 出厂消费者时代的选择）——
    // p7/W4 google 剔除后随存活引擎域更新为 bing（机械休眠面：现无 useProxy 出厂消费者，
    // env 链语义不变，将来引擎加回即恢复消费；契约卷 fake electron 不按 URL 分流，零测试影响）。
    const answer = await electron.session.defaultSession.resolveProxy('https://cn.bing.com/');
    const m = /PROXY\s+([^\s;]+)/.exec(String(answer ?? ''));
    return m ? parseProxyUrl(m[1]) : null;
  } catch {
    return null;
  }
}

/** CONNECT 隧道握手（先例口径：http.request({method:'CONNECT'}) → 200 后 socket 交 TLS 复用，
 *  零第三方依赖）。握手失败 = 普通引擎失败（降级接管）。 */
export async function establishConnectTunnel(
  proxyHref: string,
  targetHost: string,
  targetPort: number,
  timeoutMs = TRANSLATION_ENGINE_TRY_TIMEOUT_MS,
): Promise<Socket> {
  const proxy = parseProxyUrl(proxyHref);
  if (!proxy) throw new Error(`代理地址无效：${proxyHref}`);
  return await new Promise<Socket>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };
    timer = setTimeout(() => {
      req.destroy(new Error(`代理 CONNECT 握手超时（${timeoutMs}ms）`));
      finish(() => reject(new Error(`代理 CONNECT 握手超时（${timeoutMs}ms）`)));
    }, timeoutMs);
    const req = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: `${targetHost}:${targetPort}`,
      headers: { Host: `${targetHost}:${targetPort}` },
    });
    req.on('connect', (res, socket) => {
      if (res.statusCode === 200) {
        finish(() => resolve(socket));
      } else {
        socket.destroy();
        finish(() => reject(new Error(`代理 CONNECT 握手失败：HTTP ${res.statusCode}`)));
      }
    });
    req.on('error', (e: Error) => finish(() => reject(e)));
    req.end();
  });
}

/** CONNECT 隧道 agent：createConnection 即握手，https 形态在隧道裸 socket 上完成对目标主机的
 *  TLS 握手（SNI=目标主机名）再交付；http 形态保持裸 socket 直通（https.Agent 的 createConnection
 *  契约是交付 TLS 层流——P1-A 修复：裸 socket 直进 443 必然 "socket hang up"）。 */
class ConnectTunnelAgent extends https.Agent {
  proxyHref: string;
  constructor(proxyHref: string) {
    super({ keepAlive: true });
    this.proxyHref = proxyHref;
  }
  // 属性箭头赋值形态（签名对齐 http.Agent 基类；异步握手经 callback 交付，同步返回 null）。
  createConnection = (
    options: http.RequestOptions & { protocol?: string; servername?: string },
    callback?: ((err: Error | null, stream: Duplex) => void) | undefined,
  ): Duplex | null | undefined => {
    const host = options.host ?? 'localhost';
    const port = Number(options.port) || 443;
    // 错误路径仅交付 err（Node 语义允许；基类类型把 stream 形参标为必选，此处收窄为可选调用）。
    const cb = callback as ((err: Error | null, stream?: Duplex) => void) | undefined;
    establishConnectTunnel(this.proxyHref, host, port)
      .then((socket) => {
        // P1-A：https 形态在隧道裸 socket 上完成对目标主机的 TLS 握手（SNI=目标主机名）再交付；
        // http 形态（自定义 http:// 端点 + useProxy 的理论组合）保持裸 socket 直通。
        // protocol 来源：httpRequest 请求选项注入 parsed.protocol（https.Agent 基类不透传该键，
        // 实测 options.protocol 缺省——端口 443 兜底仅覆盖缺注入的直用形态）。
        const secure = options.protocol === 'https:' || port === 443;
        if (!secure) {
          cb?.(null, socket);
          return;
        }
        let delivered = false; // secureConnect 与 error 互斥守卫（cb 只许交付一次）
        const tlsSocket = tls.connect({ socket, servername: options.servername ?? host, rejectUnauthorized: true });
        tlsSocket.once('secureConnect', () => {
          if (delivered) return;
          delivered = true;
          cb?.(null, tlsSocket);
        });
        tlsSocket.once('error', (e: Error) => {
          if (delivered) return;
          delivered = true;
          socket.destroy();
          cb?.(e); // TLS 失败（代理 MITM/证书错/握手前被掐断）= 普通引擎 network 失败 → 组内降级接管
        });
      })
      .catch((e: Error) => cb?.(e));
    return null;
  };
}

/** @internal 导出供契约卷（T34 代理尊重）单测形态断言：agent 携带代理坐标。 */
export function createTunnelAgent(proxyHref: string): ConnectTunnelAgent {
  return new ConnectTunnelAgent(proxyHref);
}

const tunnelAgentCache = new Map<string, https.Agent>();

/** 代理 → 隧道 agent（按代理地址缓存；socket 复用由 Agent keepAlive 层承担）。 */
function agentForProxy(proxy: URL): https.Agent {
  let agent = tunnelAgentCache.get(proxy.href);
  if (!agent) {
    agent = createTunnelAgent(proxy.href);
    tunnelAgentCache.set(proxy.href, agent);
  }
  return agent;
}

// ── 通用 HTTP 助手（防护全镜像 topic-analyzer：总 deadline + req.setTimeout 双保险 +
//  响应累积 4MiB 上限 + signal 即时中断 + 'aborted' 事件兜底） ──

interface RawHttpResponse {
  status: number;
  body: string;
  /** 响应头（bing 会话 cookie 提取用；其余适配器不消费，附加字段零影响）。 */
  headers: http.IncomingHttpHeaders;
}

function httpRequest(
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers?: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    timeoutMs?: number;
    agent?: https.Agent;
  },
): Promise<RawHttpResponse> {
  const parsed = new URL(url);
  const lib = parsed.protocol === 'https:' ? https : http;
  const timeoutMs = init.timeoutMs ?? TRANSLATION_ENGINE_TRY_TIMEOUT_MS;
  return new Promise<RawHttpResponse>((resolve, reject) => {
    let settled = false;
    let deadlineTimer: NodeJS.Timeout | undefined;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      fn();
    };
    const request = lib.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        // P1-A：protocol 注入请求选项——ConnectTunnelAgent.createConnection 需按目标协议判定
        // TLS 包裹（https.Agent 基类不透传 protocol，实测缺省；此处为唯一 agent 消费入口）。
        protocol: parsed.protocol,
        path: `${parsed.pathname}${parsed.search}`,
        method: init.method,
        // P1-C：统一浏览器 UA 默认头（显式传入者经展开序覆盖默认——适配器自带 headers 优先；
        // baidu 首页 GET 无 UA 被 302 的根因即在此补齐）。
        headers: init.body !== undefined
          ? { 'User-Agent': BROWSER_UA, ...init.headers, 'Content-Length': Buffer.byteLength(init.body) }
          : { 'User-Agent': BROWSER_UA, ...init.headers },
        signal: init.signal,
        ...(init.agent ? { agent: init.agent } : {}),
      },
      (res) => {
        let bytes = 0;
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => {
          bytes += Buffer.byteLength(chunk);
          if (bytes > TRANSLATION_RESPONSE_MAX_BYTES) {
            request.destroy(new Error(`引擎响应 exceeds ${TRANSLATION_RESPONSE_MAX_BYTES} bytes`));
            return;
          }
          body += chunk;
        });
        // Node22/Electron35 实测断连只 emit 'aborted' 不 emit 'error'——必须监听防悬挂。
        res.on('error', (e: Error) => finish(() => reject(e)));
        res.on('aborted', () => finish(() => reject(new Error('response aborted'))));
        res.on('end', () => finish(() => resolve({ status: res.statusCode ?? 0, body, headers: res.headers })));
      },
    );
    deadlineTimer = setTimeout(() => {
      request.destroy(new Error(`引擎尝试 deadline（${timeoutMs}ms）`));
    }, timeoutMs);
    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error(`引擎请求超时（${timeoutMs}ms）`));
    });
    request.on('error', (e: Error) => finish(() => reject(e)));
    if (init.body !== undefined) request.write(init.body);
    request.end();
  });
}

/** 状态码 → 类型化失败（429 单列 rate-limit；其余 4xx = http-4xx；5xx/网络/超时 = network）。 */
function statusFailure(brand: string, status: number): TranslationEngineAttempt {
  if (status === 429) {
    return { ok: false, error: `${brand} 限频（HTTP 429），已入冷却`, kind: 'rate-limit' };
  }
  if (status >= 400 && status < 500) {
    return { ok: false, error: `${brand} 接口错误（HTTP ${status}）`, kind: 'http-4xx' };
  }
  return { ok: false, error: `${brand} 服务异常（HTTP ${status}）`, kind: 'network' };
}

function networkFailure(brand: string, err: unknown): TranslationEngineAttempt {
  const msg = err instanceof Error ? err.message : String(err);
  return { ok: false, error: `${brand} 网络不可达/超时（${msg}）`, kind: 'network' };
}

function parseFailure(brand: string, detail: string): TranslationEngineAttempt {
  return { ok: false, error: `${brand} 响应解析失败（${detail}）`, kind: 'parse' };
}

// ── 内置适配器：真实 HTTP 实现（transportOverride 未安装时的生产路径；规格 = 01 §5.2.3） ──

type RealAdapter = (
  segment: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
) => Promise<TranslationEngineAttempt>;

interface AdapterCtx {
  entry: TranslationEngineConfig;
}

/** 句末标点子切（bing >1000 字符适配器内子切用；复用切段纯函数的标点口径，阈值参数化）。 */
function splitBySentence(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const pieces: string[] = [];
  let buf = '';
  for (const piece of text.split(/(?<=[.!?。！？；;])/)) {
    if (piece.length === 0) continue;
    if (piece.length > maxChars) {
      if (buf) {
        pieces.push(buf);
        buf = '';
      }
      for (let i = 0; i < piece.length; i += maxChars) pieces.push(piece.slice(i, i + maxChars));
      continue;
    }
    if ((buf + piece).length > maxChars) {
      if (buf) pieces.push(buf);
      buf = piece;
    } else {
      buf += piece;
    }
  }
  if (buf) pieces.push(buf);
  return pieces;
}

function md5Hex(input: string): string {
  return crypto.createHash('md5').update(input, 'utf8').digest('hex');
}

// ── bing-web（cn.bing.com 抓 IG+data-iid+params_AbusePrevention 三件套（parseBingSessionHtml
//  提纯）→ ttranslatev3；key=数组[0]/token=数组[1] 语义（09 §2 差异1，2026-11-22 复活根因）；
//  会话模块级缓存 + 失效重抓一次 + 重抓并发单飞（EX-P1-10，round-002 C-1 补钉——与 qq/sogou/
//  youdao 会话单飞同形态）；>1000 字符句末子切拼接；translations[0].text；简中字面
//  to=zh-Hans） ──

/** 统一浏览器 UA（全部引擎 HTTP 默认头——node http 默认无 UA 会被反爬 302/风控；bing 的
 *  fetchBingToken 与 ttranslatev3 两请求上下文一致防滥用漂移。Chrome 桌面形态字面，
 *  P1-C 起由 bing 专用常量更名扩面为全局默认；2026-11-22 随 bing 复活配方升 Chrome/141
 *  （09 §2 差异4：UA 版本段过旧属真网风控形态，整配方口径一致）。 */
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

interface BingTokenCache {
  host: string;
  ig: string;
  key: string;
  token: string;
  /** 页面 GET 响应 Set-Cookie 会话 cookie（name=value 对拼接；ttranslatev3 随 Cookie 头携带——
   *  p5a 裸配方 401 `{"ShowCaptcha":false}` 的缺省上下文）。 */
  cookie: string;
  /** 页面 DOM data-iid 剥 translator. 前缀后的数字（URL 模板 IID=translator.${iid} 拼前缀恰一次）。 */
  iid: number;
  fetchedAt: number;
}
let bingTokenCache: BingTokenCache | null = null;
/** token 重抓并发单飞（in-flight promise）：并发失效共享同一重抓，防双倍重取漂移出两份会话
 *  （EX-P1-10 契约面；与 qq/sogou/youdao 会话单飞同形态）。 */
let bingTokenFetch: Promise<BingTokenCache> | null = null;

/** Set-Cookie 头数组 → Cookie 请求头字面（每条取 name=value 首对；忽略 Expires/Path 等属性）。 */
function cookieHeaderFromResponse(headers: http.IncomingHttpHeaders): string {
  const raw = headers?.['set-cookie'];
  if (!Array.isArray(raw)) return '';
  const pairs: string[] = [];
  for (const line of raw) {
    const pair = (line.split(';')[0] ?? '').trim();
    if (pair.includes('=')) pairs.push(pair);
  }
  return pairs.join('; ');
}

// ── 页面 → 会话三件套提纯（09 §5.4：可测纯函数，零网络零缓存副作用；E1 卷 EX-P1 组消费） ──

export interface BingSessionParts {
  /** 页面 IG（ttranslatev3 URL 查询参数）。 */
  ig: string;
  /** 页面 DOM data-iid 剥 translator. 前缀后的数字（URL 模板 IID=translator.${iid} 侧拼前缀
   *  恰一次，防前缀双拼——出站 IID 不得出现两段 translator.）。 */
  iid: number;
  /** params_AbusePreventionHelper 数组[0]（时间戳位，String 化；09 §2 差异1 语义）或对象形态 key。 */
  key: string;
  /** params_AbusePreventionHelper 数组[1] 或对象形态 token。 */
  token: string;
}

/**
 * bing 翻译页 HTML → 会话三件套（IG / IID / key+token）。任一要素缺失或形态不可解析 → null
 * （调用方按引擎失败降级，不静默空值发畸形请求）。
 * key/token 语义（09 §2 差异1 实测裁决，2026-11-22 复活根因）：现行页面形态 =
 * params_AbusePreventionHelper JS 数组 [时间戳ms, token, 有效期ms, …] → key=数组[0]（String 化）、
 * token=数组[1]；旧实现取 arr[2]（把有效期 3600000 当 key 发送）→ ttranslatev3 恒 205 反滥用拒绝。
 * 旧对象形态 {key,token} 回落保留（防御旧页面回滚）。
 * IID（09 §2 差异2）：页面 DOM #tta_outGDCont 的 data-iid（如 translator.5026 / 纯数字形态），
 * translator. 前缀恰剥一次存数字。
 */
export function parseBingSessionHtml(html: string): BingSessionParts | null {
  const ig = /IG["']?\s*[:=]\s*"([^"]+)"/.exec(html)?.[1] ?? '';
  const iidRaw = /id="tta_outGDCont"[^>]*data-iid="([^"]+)"/.exec(html)?.[1] ?? '';
  const iid = Number.parseInt(iidRaw.replace(/^translator\./, ''), 10);
  let key = '';
  let token = '';
  const helperRaw = /params_AbusePrevention(?:Helper)?\s*=\s*(\[[\s\S]{0,500}?\])/.exec(html)?.[1] ?? '';
  if (helperRaw) {
    try {
      const arr = JSON.parse(helperRaw) as unknown[];
      key = arr[0] !== undefined && arr[0] !== null ? String(arr[0]) : '';
      token = typeof arr[1] === 'string' ? arr[1] : '';
    } catch {
      /* 数组形态解析失败 → 对象形态回落 */
    }
  }
  if (!token) {
    const abuseRaw = /params_AbusePrevention\s*=\s*(\{[\s\S]{0,500}?\})/.exec(html)?.[1] ?? '';
    if (abuseRaw) {
      try {
        const o = JSON.parse(abuseRaw) as { key?: unknown; token?: unknown };
        key = typeof o.key === 'string' ? o.key : '';
        token = typeof o.token === 'string' ? o.token : '';
      } catch {
        /* 提取形态失配 → 走下方要素校验 */
      }
    }
  }
  if (!ig || !token || !key || !Number.isFinite(iid)) return null;
  return { ig, iid, key, token };
}

async function fetchBingToken(host: string, signal: AbortSignal, agent: https.Agent | undefined): Promise<BingTokenCache> {
  const res = await httpRequest(`https://${host}/translator`, { method: 'GET', headers: { 'User-Agent': BROWSER_UA }, signal, agent });
  if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
  const parts = parseBingSessionHtml(res.body);
  if (!parts) throw new Error('页面改版：IG/data-iid/params_AbusePrevention 提取失败');
  const cached: BingTokenCache = { host, ig: parts.ig, key: parts.key, token: parts.token, cookie: cookieHeaderFromResponse(res.headers), iid: parts.iid, fetchedAt: Date.now() };
  bingTokenCache = cached;
  return cached;
}

async function bingOneChunk(
  host: string,
  chunk: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<TranslationEngineAttempt> {
  let cache = bingTokenCache;
  if (!cache || cache.host !== host || Date.now() - cache.fetchedAt > 3_600_000) {
    // 重抓并发单飞：并发失效共享同一 in-flight 重抓（不双取、不互踩两份会话）。
    if (!bingTokenFetch) {
      bingTokenFetch = fetchBingToken(host, signal, agent).finally(() => {
        bingTokenFetch = null;
      });
    }
    try {
      cache = await bingTokenFetch;
      // 单飞槽不按 host 键控（r3-2-1，2026-11-23）：并发异 host 时后到者 await 共享槽拿到先发起
      // host 的会话（IG/token/key/cookie 属于对方）→ 以对方会话向本 host 发畸形请求。await 后补
      // host 校验：异 host 者直取自身重抓（不触碰共享槽本身，避免扰动另一 host 的 await 方；
      // 自身重抓失败仍走 networkFailure 原路径）。
      if (cache.host !== host) {
        cache = await fetchBingToken(host, signal, agent);
      }
    } catch (err) {
      return networkFailure('Bing', err);
    }
  }
  // IID 用页面值（fetchBingToken 存 data-iid 剥前缀数字；URL 模板拼 translator. 前缀恰一次，
  // 09 §2 差异2——旧 5023 硬编码 + 自增删除）。
  const url = `https://${host}/ttranslatev3?isVertical=1&IG=${encodeURIComponent(cache.ig)}&IID=translator.${cache.iid}`;
  const form = new URLSearchParams({
    fromLang: 'en',
    to: 'zh-Hans',
    text: chunk,
    // 09 §2 差异3：现行 payload 字段（缺省 = 真网形态异常面）。
    tryFetchingGenderDebiasedTranslations: 'true',
    token: cache.token,
    key: cache.key,
  });
  try {
    const res = await httpRequest(url, {
      method: 'POST',
      // UA 与 fetchBingToken 两处一致（防滥用上下文不漂移）；页面 GET 的会话 cookie 随行
      //（p5a 裸配方 401 结论：ttranslatev3 需会话 cookie 才免 `{"ShowCaptcha":false}`）。
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': BROWSER_UA,
        ...(cache.cookie ? { Cookie: cache.cookie } : {}),
      },
      body: form.toString(),
      signal,
      agent,
    });
    if (res.status !== 200) return statusFailure('Bing', res.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return parseFailure('Bing', '响应非 JSON');
    }
    const first = Array.isArray(parsed) ? parsed[0] : undefined;
    const translated = (first as { translations?: Array<{ text?: unknown }> } | undefined)?.translations?.[0]?.text;
    if (typeof translated !== 'string' || translated.length === 0) {
      // 空 translations = 防滥用拦截/token 失效 → 上层重抓一次。
      return parseFailure('Bing', 'translations 空（防滥用拦截或 token 失效）');
    }
    return { ok: true, text: translated };
  } catch (err) {
    return networkFailure('Bing', err);
  }
}

function makeBingWeb(ctx: AdapterCtx): RealAdapter {
  return async (segment, signal, agent) => {
    const host = ctx.entry.endpoint?.trim() || DEFAULT_BING_WEB_DOMAIN;
    const chunks = segment.length > 1000 ? splitBySentence(segment, 1000) : [segment];
    let text = '';
    for (const chunk of chunks) {
      let attempt = await bingOneChunk(host, chunk, signal, agent);
      // token/IG 失效：重抓页面一次，仍败 → 引擎失败降级。
      if (!attempt.ok) {
        bingTokenCache = null;
        attempt = await bingOneChunk(host, chunk, signal, agent);
      }
      if (!attempt.ok) return attempt;
      text += attempt.text;
    }
    return { ok: true, text };
  };
}

// ── alibaba-web（translate.alibaba.com 三步：①页面预热取会话 cookie → ②GET
//  /api/translate/csrftoken 得顶层 {headerName,token}（解析实际响应形态，翻译请求以响应给的
//  headerName 携带 token——不硬编码头名）→ ③multipart POST /api/translate/text，表单字段
//  query/srcLang=en/tgtLang=zh/_csrf=<token>/domain=general；仓库 HTTP 助手只有 urlencoded
//  形态，multipart body 零依赖手搓 boundary（buildMultipartBody 纯函数）；响应取
//  data.translateText）。csrf 会话级缓存（模块级变量，与 bing token 缓存同形态；TTL 30 分钟级）
//  + 翻译失败重取一次（30 分钟边界竞态以「失败一次即重取」兜底，对齐 bing token 重抓先例）
//  + 重取并发单飞（EX-P2A-7，round-002 C-1 补钉——与 qq/sogou/youdao 会话单飞同形态）。
//  固定多主机协议不消费 entry.endpoint（评审 P1-5；sanitize 剥离在后点统一做）。>5000 字符
//  防御性子切保留（评审 P3-2：正常路径不可达——上游切段硬顶 1200）。协议事实 = 2026-11-22
//  实测配方（csrf→multipart POST→200 data.translateText；mt-probe Stage A 只读采纳，
//  TS 独立实现，零 GPL 代码入仓）。 ──

const ALIBABA_WEB_HOST = 'https://translate.alibaba.com';
/** csrf 会话缓存 TTL（30 分钟级；过期竞态不追表——「失败一次即重取」兜底）。 */
const ALIBABA_CSRF_TTL_MS = 1_800_000;
/** 上游单请求字面硬顶（translators AlibabaV2 input_limit=5e3 同口径；本仓库正常路径不可达
 *  ——segmentSourceText 段硬顶 1200，此子切仅为适配器直调/上游回归面防御兜底）。 */
const ALIBABA_WEB_MAX_CHARS = 5_000;

/** csrf 响应产物（可测纯函数契约视图；headerName 动态透传——硬编码头名 = 改版即漂移）。 */
export interface AlibabaCsrfParts {
  /** csrf 响应给的请求头名（翻译 POST 头面携带 token 用）。 */
  headerName: string;
  /** csrf token（multipart _csrf 字段 + headerName 头双面携带）。 */
  token: string;
}

/**
 * csrf 响应解析（可测纯函数，零网络零缓存副作用）：顶层 {headerName,token} 双非空字符串才出
 * 产物；非 JSON / 任一要素缺失、空串、非字符串 → null（调用方按引擎失败降级，不发畸形请求）。
 */
export function parseAlibabaCsrfResponse(body: string): AlibabaCsrfParts | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as { headerName?: unknown; token?: unknown };
  if (typeof o.headerName !== 'string' || o.headerName.length === 0) return null;
  if (typeof o.token !== 'string' || o.token.length === 0) return null;
  return { headerName: o.headerName, token: o.token };
}

/** csrf 请求装配（可测纯函数）：翻译 POST 五字段固定序（tgtLang 字面 zh = 目标语言契约钉）。 */
export function alibabaTranslateFields(segment: string, csrfToken: string): Array<[string, string]> {
  return [
    ['query', segment],
    ['srcLang', 'en'],
    ['tgtLang', 'zh'],
    ['_csrf', csrfToken],
    ['domain', 'general'],
  ];
}

/**
 * multipart/form-data body 零依赖手搓装配（可测纯函数；boundary 参数注入 = 隔离可测）。
 * 帧结构（requests files= 文本字段同形实测 200）：每字段一个 part
 * `--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n{value}\r\n`，
 * 终止符 `--{boundary}--\r\n`。值原样不编码（段内换行不破坏帧——仅边界串终止 part）。
 */
export function buildMultipartBody(fields: Array<[string, string]>, boundary: string): string {
  let body = '';
  for (const [key, value] of fields) {
    body += `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  }
  body += `--${boundary}--\r\n`;
  return body;
}

/**
 * translateText 提取（可测纯函数）：data.translateText 非空字符串才出译文；success:false /
 * data 缺失 / translateText 缺失、空串、非字符串 → null（空译文 ≠ 成功态；无 success 键的
 * 响应形态不作失败判定——只钉失败面）。
 */
export function extractAlibabaTranslateText(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  if ((parsed as { success?: unknown }).success === false) return null;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const text = (data as { translateText?: unknown }).translateText;
  if (typeof text !== 'string' || text.length === 0) return null;
  return text;
}

interface AlibabaCsrfCache {
  /** 页面预热 Set-Cookie 会话 cookie（csrf 与翻译 POST 随 Cookie 头携带）。 */
  cookie: string;
  headerName: string;
  token: string;
  fetchedAt: number;
}
let alibabaCsrfCache: AlibabaCsrfCache | null = null;
/** csrf 重取并发单飞（in-flight promise）：并发失效共享同一重取，防双倍重取/互踩出两份 csrf
 *  （EX-P2A-7 契约面；与 qq/sogou/youdao 会话单飞同形态）。 */
let alibabaCsrfFetch: Promise<AlibabaCsrfCache> | null = null;

async function fetchAlibabaCsrf(signal: AbortSignal, agent: https.Agent | undefined): Promise<AlibabaCsrfCache> {
  // ① 页面预热（会话 cookie；非 200 = 服务异常 → 确定性失败）。
  const page = await httpRequest(ALIBABA_WEB_HOST, {
    method: 'GET',
    headers: { Referer: ALIBABA_WEB_HOST },
    signal,
    agent,
  });
  if (page.status !== 200) throw new Error(`预热 HTTP ${page.status}`);
  const cookie = cookieHeaderFromResponse(page.headers);
  // ② csrf token（响应顶层 {headerName,token}；非 200 = 确定性失败，评审失败形态契约）。
  const res = await httpRequest(`${ALIBABA_WEB_HOST}/api/translate/csrftoken`, {
    method: 'GET',
    headers: { Referer: ALIBABA_WEB_HOST, ...(cookie ? { Cookie: cookie } : {}) },
    signal,
    agent,
  });
  if (res.status !== 200) throw new Error(`csrf HTTP ${res.status}`);
  const parts = parseAlibabaCsrfResponse(res.body);
  if (!parts) throw new Error('csrf 响应改版：headerName/token 提取失败');
  const cached: AlibabaCsrfCache = { cookie, headerName: parts.headerName, token: parts.token, fetchedAt: Date.now() };
  alibabaCsrfCache = cached;
  return cached;
}

async function alibabaOnce(
  chunk: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<TranslationEngineAttempt> {
  let cache = alibabaCsrfCache;
  if (!cache || Date.now() - cache.fetchedAt > ALIBABA_CSRF_TTL_MS) {
    // 重取并发单飞：并发失效共享同一 in-flight 重取（不双取、不互踩两份 csrf）。
    if (!alibabaCsrfFetch) {
      alibabaCsrfFetch = fetchAlibabaCsrf(signal, agent).finally(() => {
        alibabaCsrfFetch = null;
      });
    }
    try {
      cache = await alibabaCsrfFetch;
    } catch (err) {
      return networkFailure('阿里', err);
    }
  }
  // ③ multipart POST（boundary 每请求随机——同会话各请求独立边界，防段内容含边界串撞帧）。
  const boundary = `----cl-alibaba-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const body = buildMultipartBody(alibabaTranslateFields(chunk, cache.token), boundary);
  try {
    const res = await httpRequest(`${ALIBABA_WEB_HOST}/api/translate/text`, {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        Origin: ALIBABA_WEB_HOST,
        Referer: ALIBABA_WEB_HOST,
        ...(cache.cookie ? { Cookie: cache.cookie } : {}),
        // csrf 双面携带：multipart _csrf 字段（字段面）+ 响应给的 headerName 头（头面，动态）。
        [cache.headerName]: cache.token,
      },
      body,
      signal,
      agent,
    });
    if (res.status !== 200) return statusFailure('阿里', res.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return parseFailure('阿里', '响应非 JSON');
    }
    const text = extractAlibabaTranslateText(parsed);
    if (text === null) {
      return parseFailure('阿里', 'success:false 或 translateText 缺失（csrf 失效或接口改版）');
    }
    return { ok: true, text };
  } catch (err) {
    return networkFailure('阿里', err);
  }
}

function makeAlibabaWeb(ctx: AdapterCtx): RealAdapter {
  // ctx.entry.endpoint 不消费（评审 P1-5：固定多主机协议无单端点语义，URL 恒出厂域；
  // sanitize 对该 kind 的 endpoint 剥离在后点统一做）。
  void ctx;
  return async (segment, signal, agent) => {
    // >5000 字符防御性子切（评审 P3-2：正常路径不可达——上游 segmentSourceText 段硬顶 1200；
    // 本切仅为适配器直调/上游回归面兜底，子段译文按序拼接）。
    const chunks = segment.length > ALIBABA_WEB_MAX_CHARS
      ? splitBySentence(segment, ALIBABA_WEB_MAX_CHARS)
      : [segment];
    let text = '';
    for (const chunk of chunks) {
      let attempt = await alibabaOnce(chunk, signal, agent);
      // csrf 失效（30 分钟边界竞态等）：重取一次，仍败 → 引擎失败降级（对齐 bing token 重抓先例）。
      if (!attempt.ok) {
        alibabaCsrfCache = null;
        attempt = await alibabaOnce(chunk, signal, agent);
      }
      if (!attempt.ok) return attempt;
      text += attempt.text;
    }
    return { ok: true, text };
  };
}

// ── qq-transmart（腾讯交互翻译；transmart.qq.com 三步：①GET 首页预热取会话 cookie →
//  ②自造 client_key（`browser-firefox-110.0.0-Windows 10-{uuid}-{ts}`：uuid 每会话一个——
//  模块级会话缓存一次 build 终局复用、ts=毫秒时间戳），后续 /api/imt 请求以
//  Cookie: client_key=…（值 encodeURIComponent——client_key 含空格）携带、预热 cookie 同头随行
//  → ③POST /api/imt body fn=text_analysis 分句（响应 sentence_list 的 start/len 切原 text 得
//  分句；sentence_list 缺失/空时整段作单句兜底——契约钉）→ ④POST /api/imt body fn=auto_translation
//  （source.text_list=['']+分句+[''] 首尾空串、source.lang=en、target.lang=zh）→ ⑤响应
//  auto_translation 数组去首尾空串后拼接为译文。失败形态：ret_code≠succ / auto_translation
//  缺失/空 → 引擎失败降级。固定多主机协议不消费 entry.endpoint（评审 P1-5，sanitize 剥离在后点
//  统一做）；>5000 字符防御性子切（评审 P3-2：正常路径不可达——上游切段硬顶 1200）。会话缓存
//  与 csrf/密钥缓存同形态（模块级变量）；预热并发单飞（in-flight promise 共享，防并发双预热
//  漂移出两份 client_key）。一律走既有 httpRequest 传输层（连接面白名单语义不变）。协议事实 =
//  2026-11-22 实测配方（mt-probe transmart-test.ts 预热→client_key→text_analysis→auto_translation
//  200 出译文；translators-server.py QQTranSmart 节只读采纳，TS 独立实现，零 GPL 代码入仓）。 ──

const QQ_TRANSMART_HOST = 'https://transmart.qq.com';
/** 上游单请求字面硬顶（translators QQTranSmart input_limit=5e3 同口径；本仓库正常路径不可达
 *  ——segmentSourceText 段硬顶 1200，此子切仅为适配器直调/上游回归面防御兜底）。 */
const QQ_TRANSMART_MAX_CHARS = 5_000;

/**
 * client_key 装配（可测纯函数）：`browser-firefox-110.0.0-Windows 10-{uuid}-{ts}` 字面模板
 * （实测配方；uuid 每会话一个由调用方注入、ts=毫秒时间戳）。模板字面漂移 = 真网风控拒绝面。
 */
export function buildQqClientKey(uuid: string, tsMs: number): string {
  return `browser-firefox-110.0.0-Windows 10-${uuid}-${tsMs}`;
}

/**
 * text_analysis 分句请求装配（可测纯函数）：header.fn=text_analysis + client_key 双面透传、
 * type=plain、normalize.merge_broken_line='false'（实测配方字面——漂移即风控/格式异常面）。
 */
export interface QqSplitPayload {
  header: { fn: string; client_key: string };
  type: string;
  text: string;
  normalize: { merge_broken_line: string };
}

export function qqSplitPayload(segment: string, clientKey: string): QqSplitPayload {
  return {
    header: { fn: 'text_analysis', client_key: clientKey },
    type: 'plain',
    text: segment,
    normalize: { merge_broken_line: 'false' },
  };
}

/**
 * 分句响应解析（可测纯函数，零网络零缓存副作用）：响应 {text, sentence_list:[{start,len}]}
 * 按 [start, start+len) 逐条目切原 text 得分句（实测配方：逐条目切片、句间缺口不并入）。
 * sentence_list 缺失/空数组/text 缺失/要素残缺（start/len 非有限数字或 len<0）→ null
 * （调用方整段作单句兜底——契约钉，不发畸形请求不静默空值）。
 */
export function parseQqSentenceList(parsed: unknown): string[] | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as { text?: unknown; sentence_list?: unknown };
  if (typeof o.text !== 'string') return null;
  if (!Array.isArray(o.sentence_list) || o.sentence_list.length === 0) return null;
  const sentences: string[] = [];
  for (const item of o.sentence_list) {
    if (typeof item !== 'object' || item === null) return null;
    const start = (item as { start?: unknown }).start;
    const len = (item as { len?: unknown }).len;
    if (typeof start !== 'number' || !Number.isFinite(start)) return null;
    if (typeof len !== 'number' || !Number.isFinite(len) || len < 0) return null;
    sentences.push(o.text.slice(start, start + len));
  }
  return sentences;
}

/**
 * auto_translation 请求装配（可测纯函数）：source.text_list=['']+分句+['']（首尾各一个空串
 * ——实测配方契约钉）、source.lang=en、target.lang=zh（目标语言字面钉）、model_category=normal。
 */
export interface QqAutoTranslationPayload {
  header: { fn: string; client_key: string };
  type: string;
  model_category: string;
  source: { lang: string; text_list: string[] };
  target: { lang: string };
}

export function qqAutoTranslationPayload(sentences: string[], clientKey: string): QqAutoTranslationPayload {
  return {
    header: { fn: 'auto_translation', client_key: clientKey },
    type: 'plain',
    model_category: 'normal',
    source: { lang: 'en', text_list: ['', ...sentences, ''] },
    target: { lang: 'zh' },
  };
}

/**
 * 译文提取（可测纯函数）：ret_code≠succ（含空串；键缺省不钉失败面——只钉失败形态判定面，
 * 对齐 alibaba success 键先例）/ auto_translation 缺失、非数组、含非字符串元素 → null；
 * 去首尾空串后拼接为译文（评审 P2-6：非全量 filter——正文逐字保全）；拼接结果空串 → null
 * （全空串拼接 ≠ 成功态）。
 */
export function extractQqTranslation(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as { ret_code?: unknown; auto_translation?: unknown };
  if (typeof o.ret_code === 'string' && o.ret_code !== 'succ') return null;
  if (!Array.isArray(o.auto_translation)) return null;
  const pieces = o.auto_translation as unknown[];
  let start = 0;
  let end = pieces.length;
  while (start < end && pieces[start] === '') start += 1;
  while (end > start && pieces[end - 1] === '') end -= 1;
  let text = '';
  for (let i = start; i < end; i += 1) {
    const piece = pieces[i];
    if (typeof piece !== 'string') return null;
    text += piece;
  }
  return text.length > 0 ? text : null;
}

interface QqSessionCache {
  /** 首页预热 Set-Cookie 会话 cookie（/api/imt 请求随 Cookie 头与 client_key 同行）。 */
  cookie: string;
  /** 自造 client_key（uuid 每会话一个 + ts=构造时毫秒时间戳；一次 build 终局复用）。 */
  clientKey: string;
  fetchedAt: number;
}
let qqSessionCache: QqSessionCache | null = null;
/** 预热并发单飞（in-flight promise）：并发首译共享同一预热，防漂移出两份 client_key。 */
let qqSessionFetch: Promise<QqSessionCache> | null = null;

async function fetchQqSession(signal: AbortSignal, agent: https.Agent | undefined): Promise<QqSessionCache> {
  // ① 首页预热（取会话 cookie；非 200 = 服务异常 → 确定性失败）。
  const page = await httpRequest(QQ_TRANSMART_HOST, {
    method: 'GET',
    headers: { Referer: QQ_TRANSMART_HOST },
    signal,
    agent,
  });
  if (page.status !== 200) throw new Error(`预热 HTTP ${page.status}`);
  // ② 自造 client_key（uuid 每会话一个 + ts=毫秒时间戳；会话级一次 build 终局复用）。
  const cached: QqSessionCache = {
    cookie: cookieHeaderFromResponse(page.headers),
    clientKey: buildQqClientKey(crypto.randomUUID(), Date.now()),
    fetchedAt: Date.now(),
  };
  qqSessionCache = cached;
  return cached;
}

/** 会话缓存获取（缓存命中直返；未命中走并发单飞预热——EX-P2B-8/9 契约面：client_key 会话级
 *  复用、预热恰 1 次）。预热失败（网络/非 200）→ throw，调用方 networkFailure 降级。 */
async function getQqSession(signal: AbortSignal, agent: https.Agent | undefined): Promise<QqSessionCache> {
  if (qqSessionCache) return qqSessionCache;
  if (!qqSessionFetch) {
    qqSessionFetch = fetchQqSession(signal, agent).finally(() => {
      qqSessionFetch = null;
    });
  }
  return qqSessionFetch;
}

/** /api/imt 请求头面（Origin/Referer/JSON + Cookie：client_key 主体（值 encodeURIComponent
 *  ——模板含空格）+ 预热 cookie 同头随行）。 */
function qqApiHeaders(session: QqSessionCache): Record<string, string> {
  const cookie = `client_key=${encodeURIComponent(session.clientKey)}`;
  return {
    'Content-Type': 'application/json',
    Origin: QQ_TRANSMART_HOST,
    Referer: QQ_TRANSMART_HOST,
    Cookie: session.cookie ? `${cookie}; ${session.cookie}` : cookie,
  };
}

async function qqOnce(
  chunk: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<TranslationEngineAttempt> {
  let session: QqSessionCache;
  try {
    session = await getQqSession(signal, agent);
  } catch (err) {
    return networkFailure('腾讯交互翻译', err);
  }
  const url = `${QQ_TRANSMART_HOST}/api/imt`;
  try {
    // ③ text_analysis 分句（sentence_list start/len 切原 text；缺失 → 整段单句兜底契约钉）。
    const splitRes = await httpRequest(url, {
      method: 'POST',
      headers: qqApiHeaders(session),
      body: JSON.stringify(qqSplitPayload(chunk, session.clientKey)),
      signal,
      agent,
    });
    if (splitRes.status !== 200) return statusFailure('腾讯交互翻译', splitRes.status);
    let splitParsed: unknown;
    try {
      splitParsed = JSON.parse(splitRes.body);
    } catch {
      return parseFailure('腾讯交互翻译', '分句响应非 JSON');
    }
    const sentences = parseQqSentenceList(splitParsed) ?? [chunk];
    // ④ auto_translation（text_list=['']+分句+[''] 首尾空串、source.lang=en、target.lang=zh）。
    const res = await httpRequest(url, {
      method: 'POST',
      headers: qqApiHeaders(session),
      body: JSON.stringify(qqAutoTranslationPayload(sentences, session.clientKey)),
      signal,
      agent,
    });
    if (res.status !== 200) return statusFailure('腾讯交互翻译', res.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return parseFailure('腾讯交互翻译', '响应非 JSON');
    }
    // ⑤ auto_translation 去首尾空串拼接；ret_code≠succ / auto_translation 缺失 → 失败降级。
    const text = extractQqTranslation(parsed);
    if (text === null) {
      return parseFailure('腾讯交互翻译', 'ret_code≠succ 或 auto_translation 缺失/空（接口改版）');
    }
    return { ok: true, text };
  } catch (err) {
    return networkFailure('腾讯交互翻译', err);
  }
}

function makeQqTransmart(ctx: AdapterCtx): RealAdapter {
  // ctx.entry.endpoint 不消费（评审 P1-5：固定多主机协议无单端点语义，URL 恒出厂域；
  // sanitize 对该 kind 的 endpoint 剥离在后点统一做）。
  void ctx;
  return async (segment, signal, agent) => {
    // >5000 字符防御性子切（评审 P3-2：正常路径不可达——上游 segmentSourceText 段硬顶 1200；
    // 本切仅为适配器直调/上游回归面兜底，子段译文按序拼接）。
    const chunks = segment.length > QQ_TRANSMART_MAX_CHARS
      ? splitBySentence(segment, QQ_TRANSMART_MAX_CHARS)
      : [segment];
    let text = '';
    for (const chunk of chunks) {
      let attempt = await qqOnce(chunk, signal, agent);
      // 会话面失败自愈（复审 P3-7，对齐 bing/alibaba/youdao chunk 级重取先例）：清会话缓存 +
      // 置空 in-flight 单飞槽 → 恰重试一次，仍败才返回失败（恰 2 次不放大）。重试语义对并发第二
      // 调用者有效的原因：传染源是首调用者绑进共享槽的私有 AbortSignal（如 10s 超时 abort），
      // 第二调用者自身 signal 未 abort，重试以其自身 signal 重建新会话槽。
      if (!attempt.ok) {
        qqSessionCache = null;
        qqSessionFetch = null;
        attempt = await qqOnce(chunk, signal, agent);
      }
      if (!attempt.ok) return attempt;
      text += attempt.text;
    }
    return { ok: true, text };
  };
}

// ── sogou-web（fanyi.sogou.com 两步：①GET /text 预热取会话 cookie；②sign=md5(from+to+text+
//  secretCode)（页面 CONFIG.secretCode 常量内建——同 translators 硬编码先例，改版失效即确定性
//  降级）→ POST /api/transpc/text/result（form 8 字段：from=en/to=zh-CHS/text/uuid/s/client=pc/
//  fr=browser_pc/needQc=1）→ data.translate.dit；status/errorCode≠0 或 dit 缺失 → 失败降级；
//  uuid 会话级随机一次生成终局复用；2026-11-22 扩容批次 W2c 移植，协议事实 = mt-probe
//  sogou-youdao-iciba-test.ts 实测 + translators-server.py Sogou 节只读采纳，TS 独立实现） ──

const SOGOU_WEB_HOST = 'https://fanyi.sogou.com';
/** sign secretCode（页面 CONFIG.secretCode 常量内建；改版失效 → 确定性失败降级，组内其余引擎接管）。 */
const SOGOU_SECRET_CODE = '109984457';
/** 上游单请求字面硬顶（translators Sogou input_limit=5e3 同口径；本仓库正常路径不可达——
 *  segmentSourceText 段硬顶 1200，此子切仅为适配器直调/上游回归面防御兜底）。 */
const SOGOU_WEB_MAX_CHARS = 5_000;

/**
 * sign 装配（可测纯函数）：md5(from + to + text + secretCode) 拼接序字面钉（实测配方——
 * 拼接序漂移 = 真网 sign 校验拒绝面）；secretCode 参数注入（会话侧传 SOGOU_SECRET_CODE 常量，
 * 固定向量不触网可复算——E1 卷 EX-P2C-2）。
 */
export function sogouSign(from: string, to: string, text: string, secretCode: string): string {
  return md5Hex(`${from}${to}${text}${secretCode}`);
}

/**
 * result POST form 装配（可测纯函数）：8 字段固定序（from=en/to=zh-CHS/text/uuid/s/client=pc/
 * fr=browser_pc/needQc=1——实测配方字面钉，漂移即风控/参数异常面）；uuid/sign 由调用方注入
 * （uuid 会话级、sign 逐段装配——E1 卷 EX-P2C-3）。
 */
export function sogouTranslateForm(text: string, sign: string, uuid: string): Array<[string, string]> {
  return [
    ['from', 'en'],
    ['to', 'zh-CHS'],
    ['text', text],
    ['uuid', uuid],
    ['s', sign],
    ['client', 'pc'],
    ['fr', 'browser_pc'],
    ['needQc', '1'],
  ];
}

/**
 * 译文提取（可测纯函数）：status / errorCode 失败形态判定——键缺省 → 容忍继续解析（对齐
 * alibaba success 键先例，只钉失败形态判定面）；键在场时数值 0 为唯一成功形态（r3-2-2 收紧，
 * 2026-11-23）：false/''/null/' '/[]/字符串 '0'/非零数字/非数字类型一律失败。r2-F 曾以
 * `Number(x) !== 0` 收紧空串/null，但 Number(false)=Number(' ')=Number([])=0 的归一缝隙仍
 * 容忍冒充成功——改为显式数字白名单封堵（与真网数值协议形态一致）。
 * data.translate.dit 缺失、非字符串、空串 → null；dit 即译文（E1 卷 EX-P2C-4/5/6）。
 */
export function extractSogouTranslation(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const o = parsed as { status?: unknown; errorCode?: unknown; data?: unknown };
  if (o.status !== undefined && !(typeof o.status === 'number' && o.status === 0)) return null;
  if (o.errorCode !== undefined && !(typeof o.errorCode === 'number' && o.errorCode === 0)) return null;
  const data = (o as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const translate = (data as { translate?: unknown }).translate;
  if (typeof translate !== 'object' || translate === null) return null;
  const dit = (translate as { dit?: unknown }).dit;
  return typeof dit === 'string' && dit.length > 0 ? dit : null;
}

interface SogouSessionCache {
  /** 预热 Set-Cookie 会话 cookie（result POST 随 Cookie 头携带）。 */
  cookie: string;
  /** 会话级 uuid（一次生成终局复用——EX-P2C-8 契约面：并发两段 uuid 一致）。 */
  uuid: string;
  fetchedAt: number;
}
let sogouSessionCache: SogouSessionCache | null = null;
/** 预热并发单飞（in-flight promise）：并发首译共享同一预热，防漂移出两份 uuid。 */
let sogouSessionFetch: Promise<SogouSessionCache> | null = null;

async function fetchSogouSession(signal: AbortSignal, agent: https.Agent | undefined): Promise<SogouSessionCache> {
  // ① /text 预热（取会话 cookie；非 200 = 服务异常 → 确定性失败）。
  const page = await httpRequest(`${SOGOU_WEB_HOST}/text`, {
    method: 'GET',
    headers: { Referer: `${SOGOU_WEB_HOST}/text` },
    signal,
    agent,
  });
  if (page.status !== 200) throw new Error(`预热 HTTP ${page.status}`);
  // ② 会话级 uuid（一次生成终局复用）。
  const cached: SogouSessionCache = {
    cookie: cookieHeaderFromResponse(page.headers),
    uuid: crypto.randomUUID(),
    fetchedAt: Date.now(),
  };
  sogouSessionCache = cached;
  return cached;
}

/** 会话缓存获取（缓存命中直返；未命中走并发单飞预热——EX-P2C-7/8 契约面：预热恰 1 次、
 *  uuid 会话级复用）。预热失败（网络/非 200）→ throw，调用方 networkFailure 降级。 */
async function getSogouSession(signal: AbortSignal, agent: https.Agent | undefined): Promise<SogouSessionCache> {
  if (sogouSessionCache) return sogouSessionCache;
  if (!sogouSessionFetch) {
    sogouSessionFetch = fetchSogouSession(signal, agent).finally(() => {
      sogouSessionFetch = null;
    });
  }
  return sogouSessionFetch;
}

async function sogouOnce(
  chunk: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<TranslationEngineAttempt> {
  let session: SogouSessionCache;
  try {
    session = await getSogouSession(signal, agent);
  } catch (err) {
    return networkFailure('搜狗翻译', err);
  }
  try {
    // ② sign=md5(from+to+text+secretCode) → form POST /api/transpc/text/result。
    const sign = sogouSign('en', 'zh-CHS', chunk, SOGOU_SECRET_CODE);
    const res = await httpRequest(`${SOGOU_WEB_HOST}/api/transpc/text/result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: SOGOU_WEB_HOST,
        Referer: `${SOGOU_WEB_HOST}/text`,
        'X-Requested-With': 'XMLHttpRequest',
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      body: new URLSearchParams(sogouTranslateForm(chunk, sign, session.uuid)).toString(),
      signal,
      agent,
    });
    if (res.status !== 200) return statusFailure('搜狗翻译', res.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      return parseFailure('搜狗翻译', '响应非 JSON');
    }
    // ③ data.translate.dit 即译文；status/errorCode≠0 或 dit 缺失 → 失败降级。
    const text = extractSogouTranslation(parsed);
    if (text === null) {
      return parseFailure('搜狗翻译', 'status/errorCode≠0 或 dit 缺失（接口改版）');
    }
    return { ok: true, text };
  } catch (err) {
    return networkFailure('搜狗翻译', err);
  }
}

function makeSogouWeb(ctx: AdapterCtx): RealAdapter {
  // ctx.entry.endpoint 不消费（评审 P1-5：固定域协议无单端点语义，URL 恒出厂域；
  // sanitize 对该 kind 的 endpoint 剥离在后点统一做）。
  void ctx;
  return async (segment, signal, agent) => {
    // >5000 字符防御性子切（评审 P3-2：正常路径不可达——上游 segmentSourceText 段硬顶 1200；
    // 本切仅为适配器直调/上游回归面兜底，子段译文按序拼接）。
    const chunks = segment.length > SOGOU_WEB_MAX_CHARS
      ? splitBySentence(segment, SOGOU_WEB_MAX_CHARS)
      : [segment];
    let text = '';
    for (const chunk of chunks) {
      let attempt = await sogouOnce(chunk, signal, agent);
      // 会话面失败自愈（复审 P3-7，对齐 bing/alibaba/youdao chunk 级重取先例）：清会话缓存 +
      // 置空 in-flight 单飞槽 → 恰重试一次，仍败才返回失败（恰 2 次不放大）。重试语义对并发第二
      // 调用者有效的原因：传染源是首调用者绑进共享槽的私有 AbortSignal（如 10s 超时 abort），
      // 第二调用者自身 signal 未 abort，重试以其自身 signal 重建新会话槽。
      if (!attempt.ok) {
        sogouSessionCache = null;
        sogouSessionFetch = null;
        attempt = await sogouOnce(chunk, signal, agent);
      }
      if (!attempt.ok) return attempt;
      text += attempt.text;
    }
    return { ok: true, text };
  };
}

// ── youdao-web（V2 webtranslate 协议，2026-11-22 扩容批次 W2d 整函数重写；V1 旧版 web 端点协议
//  +老 sign 判死删除，E1 卷 EX-P2D-13 源码字面零命中钉）：①GET fanyi.youdao.com 取会话 cookie
//  → ②default_key/decodeKey/decodeIv 常量内建
//  （happy path 零 js 下载——评审 P2-3）→ ③GET dict.youdao.com/webtranslate/key（keyid=
//  webfanyi-key-getter-2025 + sign=md5(client=fanyideskweb&mysticTime=T&product=webfanyi&key=
//  defaultKey)）→ data.{secretKey,aesKey,aesIv} → ④POST dict.youdao.com/webtranslate（form i/
//  from=en/to=zh-CHS/dictResult/useTerm + keyid=webfanyi + 同式 sign 换 secretKey）→ ⑤响应
//  base64url 密文 → AES-128-CBC 解密（key/iv = md5(aesKey/aesIv) 摘要 16 字节；node:crypto
//  createDecipheriv 零新依赖）→ translateResult[].tgt 拼接。密钥三件套会话级缓存（模块级变量，
//  与 alibaba csrf/qq/sogou 会话缓存同形态、无 TTL 失效重取）+ 预热并发单飞；key 无 secretKey/
//  解密失败/translateResult 缺失 → 整链重取恰一次（页面→app js→key 全链——app js 抓取仅在重取
//  链路走，js 内无 default_key 形态 → 内建常量兜底），仍失败 → 引擎失败降级。固定多主机协议不
//  消费 entry.endpoint（评审 P1-5；V1 端点常量已删）；>5000 字符防御性子切（评审 P3-2：正常路径
//  不可达——上游切段硬顶 1200）。协议事实 = 2026-11-22 真网复现实测（page/js/key/translate 全链
//  200 出译文；keyid 字面作 sign key 实测 500，js 形态 group(2) 才是 default key 实值）+
//  mt-probe sogou-youdao-iciba-test.ts 实测配方 + translators-server.py YoudaoV2 节只读采纳，
//  TS 独立实现，零 GPL 代码入仓。 ──
//  来源注记：页面 js 形状锚点正则与 translators 库同形，来源=页面公开格式（协议事实），非代码拷贝。

const YOUDAO_WEB_HOST = 'https://fanyi.youdao.com';
const YOUDAO_DICT_HOST = 'https://dict.youdao.com';
/** keyid（key 接口 keyid 参数 + 页面 js 形态锚点；≠ default key 实值——实值见 YOUDAO_DEFAULT_KEY）。 */
const YOUDAO_KEY_ID = 'webfanyi-key-getter-2025';
/** default key 实值（页面 js 形态 `="webfanyi-key-getter-2025",a="yU5nT5dK3eZ1pI4j";` 的取值，
 *  2026-11-22 真网实测内建——keyid 字面作 sign key 实测 key 接口 500；改版失效 → 重取链路
 *  app js 提取兜底，再失效 → 确定性失败降级）。 */
const YOUDAO_DEFAULT_KEY = 'yU5nT5dK3eZ1pI4j';
/** decodeKey/decodeIv 内建兜底（页面 js `decodeKey:"…",` 形态实值，2026-11-22 真网实测——与 key
 *  接口响应 aesKey/aesIv 同值；key 响应缺省时兜底——评审 P2-3）。 */
const YOUDAO_BUILTIN_DECODE_KEY = 'ydsecret://query/key/B*RGygVywfNBwpmBaZg*WT7SIOUP2T0C9WHMZN39j^DAdaZhAnxvGcCY6VYFwnHl';
const YOUDAO_BUILTIN_DECODE_IV = 'ydsecret://query/iv/C@lZe2YzHtZ2CYgaXKSVfsb7Y4QWHjITPPZ0nQp87fBeJ!Iv6v^6fvi2WN@bYpJ4';
/** app js 地址正则（页面内嵌 script 形态 shared.ydstatic.com/dict/translation-website/…/js/app.*.js；
 *  仅重取链路 js 下载消费——happy path 零 js 下载，评审 P2-3）。 */
const YOUDAO_APP_JS_RE = /https:\/\/shared\.ydstatic\.com\/dict\/translation-website\/[^/]+\/js\/app\.[^.]+\.js/;
/** 上游单请求字面硬顶（translators YoudaoV2 input_limit=5e3 同口径；本仓库正常路径不可达——
 *  segmentSourceText 段硬顶 1200，此子切仅为适配器直调/上游回归面防御兜底）。 */
const YOUDAO_WEB_MAX_CHARS = 5_000;

/**
 * sign 装配（可测纯函数）：md5(client=fanyideskweb&mysticTime={T}&product=webfanyi&key={key})
 * 拼接模板字面钉（实测配方——模板漂移 = 真网 sign 校验拒绝面）；key 参数注入（key 接口侧传
 * default key、translate 侧传 secretKey——双 sign 式同模板，E1 卷 EX-P2D-2）。
 */
export function youdaoSign(mysticTime: string, key: string): string {
  return md5Hex(`client=fanyideskweb&mysticTime=${mysticTime}&product=webfanyi&key=${key}`);
}

/**
 * key 接口查询装配（可测纯函数）：15 字段固定序（keyid/mysticTime/sign/client/product/appVersion/
 * vendor/keyfrom/pointParam/yduuid/mid/screen/model/network/abtest——实测配方字面钉）。
 */
export function youdaoKeyQuery(mysticTime: string, key: string): Array<[string, string]> {
  return [
    ['keyid', YOUDAO_KEY_ID],
    ['mysticTime', mysticTime],
    ['sign', youdaoSign(mysticTime, key)],
    ['client', 'fanyideskweb'],
    ['product', 'webfanyi'],
    ['appVersion', '12.0.0'],
    ['vendor', 'web'],
    ['keyfrom', 'fanyi.web'],
    ['pointParam', 'client,mysticTime,product'],
    ['yduuid', 'abcdefg'],
    ['mid', '1'],
    ['screen', '1'],
    ['model', '1'],
    ['network', 'wifi'],
    ['abtest', '0'],
  ];
}

/**
 * 翻译 POST form 装配（可测纯函数）：20 字段固定序——i/from=en/to=zh-CHS/dictResult=true/
 * useTerm=false 五翻译字段 + keyid=webfanyi 载荷 15 字段（载荷 keyid ≠ key 接口 keyid——
 * 第二步换 keyid 面；to=zh-CHS 字面钉 = RB-MT-T11 youdao 面）。
 */
export function youdaoTranslateForm(segment: string, mysticTime: string, secretKey: string): Array<[string, string]> {
  return [
    ['i', segment],
    ['from', 'en'],
    ['to', 'zh-CHS'],
    ['dictResult', 'true'],
    ['useTerm', 'false'],
    ['keyid', 'webfanyi'],
    ['mysticTime', mysticTime],
    ['sign', youdaoSign(mysticTime, secretKey)],
    ['client', 'fanyideskweb'],
    ['product', 'webfanyi'],
    ['appVersion', '12.0.0'],
    ['vendor', 'web'],
    ['keyfrom', 'fanyi.web'],
    ['pointParam', 'client,mysticTime,product'],
    ['yduuid', 'abcdefg'],
    ['mid', '1'],
    ['screen', '1'],
    ['model', '1'],
    ['network', 'wifi'],
    ['abtest', '0'],
  ];
}

/**
 * key 响应解析（可测纯函数，零网络零缓存副作用）：data.secretKey 非空字符串必需（缺失/空/
 * 非字符串 → null，调用方按整链重取→失败降级，不发畸形请求）；aesKey/aesIv 缺省/非字符串 → ''
 * （调用方走 js 提取→内建常量兜底链）。
 */
export function parseYoudaoKeyResponse(body: string): { secretKey: string; aesKey: string; aesIv: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const data = (parsed as { data?: unknown }).data;
  if (typeof data !== 'object' || data === null) return null;
  const secretKey = (data as { secretKey?: unknown }).secretKey;
  if (typeof secretKey !== 'string' || secretKey.length === 0) return null;
  const aesKey = (data as { aesKey?: unknown }).aesKey;
  const aesIv = (data as { aesIv?: unknown }).aesIv;
  return {
    secretKey,
    aesKey: typeof aesKey === 'string' ? aesKey : '',
    aesIv: typeof aesIv === 'string' ? aesIv : '',
  };
}

/**
 * app js default_key 提取（可测纯函数）：`="{keyid}",<var>="<value>";` 形态取值（group(2)——
 * keyid 字面是形态锚点不是取值，2026-11-22 实测申报）；无形态 → null（调用方内建常量兜底）。
 */
export function extractYoudaoDefaultKey(js: string): string | null {
  const m = new RegExp(`="${YOUDAO_KEY_ID}",(\\w+)="(\\w+)";`).exec(js);
  const key = m?.[2] ?? '';
  return key.length > 0 ? key : null;
}

/**
 * app js decodeKey/decodeIv 提取（可测纯函数，重取链路兜底值源）：`decodeKey:"…",` /
 * `decodeIv:"…",` 形态；无形态 → null（调用方内建常量兜底）。
 */
export function extractYoudaoDecodeParts(js: string): { decodeKey: string | null; decodeIv: string | null } {
  return {
    decodeKey: /decodeKey:"(.*?)",/.exec(js)?.[1] ?? null,
    decodeIv: /decodeIv:"(.*?)",/.exec(js)?.[1] ?? null,
  };
}

/**
 * AES 密钥派生（可测纯函数）：md5(input) 摘要前 16 字节（md5 摘要即 16 字节——「摘要整体」
 * 解释，实测配方 `md5buf(x).subarray(0, 16)` 同形；hex 串前 16 字符解释与实证不符不采用）。
 * 以字节数组出（跨 realm 可测——E1 卷 EX-P2D-3a）。
 */
export function youdaoAesSecretBytes(input: string): number[] {
  return Array.from(crypto.createHash('md5').update(input, 'utf8').digest().subarray(0, 16));
}

/**
 * base64url 密文解密（可测纯函数）：AES-128-CBC（key/iv = md5 派生、PKCS7 卸垫由
 * createDecipheriv 内建）→ utf8 明文；空密文/非法 base64url/坏密文（卸垫失败）→ null
 * （解密失败不挂起不冒充成功——调用方走整链重取→失败降级）。
 */
export function youdaoDecrypt(cipher: string, aesKey: string, aesIv: string): string | null {
  try {
    const decipher = crypto.createDecipheriv(
      'aes-128-cbc',
      Buffer.from(youdaoAesSecretBytes(aesKey)),
      Buffer.from(youdaoAesSecretBytes(aesIv)),
    );
    const dec = Buffer.concat([decipher.update(Buffer.from(cipher, 'base64url')), decipher.final()]).toString('utf8');
    return dec.length > 0 ? dec : null;
  } catch {
    return null;
  }
}

/**
 * 译文提取（可测纯函数）：translateResult[[{tgt}]] 展平拼接（评审 P2-6 逐字保全）；translateResult
 * 缺失/非数组/空数组、行非数组/元素非对象/tgt 非字符串 → null（接口改版面）；拼接结果空串 → null
 * （空译文 ≠ 成功态；E1 卷 EX-P2D-7）。
 */
export function extractYoudaoTranslation(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const rows = (parsed as { translateResult?: unknown }).translateResult;
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let text = '';
  for (const row of rows) {
    if (!Array.isArray(row)) return null;
    for (const cell of row) {
      if (typeof cell !== 'object' || cell === null) return null;
      const tgt = (cell as { tgt?: unknown }).tgt;
      if (typeof tgt !== 'string') return null;
      text += tgt;
    }
  }
  return text.length > 0 ? text : null;
}

interface YoudaoSessionCache {
  /** 页面预热 Set-Cookie 会话 cookie（key/translate 请求随 Cookie 头携带）。 */
  cookie: string;
  secretKey: string;
  aesKey: string;
  aesIv: string;
  fetchedAt: number;
}
let youdaoSessionCache: YoudaoSessionCache | null = null;
/** 密钥流并发单飞（in-flight promise）：并发首译/并发整链重取共享同一密钥流（EX-P2D-10 面）。 */
let youdaoSessionFetch: Promise<YoudaoSessionCache> | null = null;

/** key 接口取密钥（cookie + default key + 兜底值源注入；非 200/无 secretKey → throw，调用方降级）。 */
async function fetchYoudaoSecrets(
  cookie: string,
  defaultKey: string,
  jsDecodeKey: string | null,
  jsDecodeIv: string | null,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<YoudaoSessionCache> {
  const mysticTime = String(Date.now());
  const res = await httpRequest(
    `${YOUDAO_DICT_HOST}/webtranslate/key?${new URLSearchParams(youdaoKeyQuery(mysticTime, defaultKey)).toString()}`,
    {
      method: 'GET',
      headers: { Referer: YOUDAO_WEB_HOST, ...(cookie ? { Cookie: cookie } : {}) },
      signal,
      agent,
    },
  );
  if (res.status !== 200) throw new Error(`key HTTP ${res.status}`);
  const parts = parseYoudaoKeyResponse(res.body);
  if (!parts) throw new Error('key 响应改版：secretKey 提取失败');
  const cached: YoudaoSessionCache = {
    cookie,
    secretKey: parts.secretKey,
    // 兜底链：key 响应 aesKey/aesIv → 重取链路 js 提取 decodeKey/decodeIv → 内建常量（P2-3）。
    aesKey: parts.aesKey || jsDecodeKey || YOUDAO_BUILTIN_DECODE_KEY,
    aesIv: parts.aesIv || jsDecodeIv || YOUDAO_BUILTIN_DECODE_IV,
    fetchedAt: Date.now(),
  };
  youdaoSessionCache = cached;
  return cached;
}

/** 冷启动密钥流（happy path：页面预热取 cookie → 内建 default key 取密钥；零 js 下载——P2-3）。 */
async function fetchYoudaoSessionCold(signal: AbortSignal, agent: https.Agent | undefined): Promise<YoudaoSessionCache> {
  const page = await httpRequest(`${YOUDAO_WEB_HOST}/`, {
    method: 'GET',
    headers: { Referer: YOUDAO_WEB_HOST },
    signal,
    agent,
  });
  if (page.status !== 200) throw new Error(`预热 HTTP ${page.status}`);
  return fetchYoudaoSecrets(cookieHeaderFromResponse(page.headers), YOUDAO_DEFAULT_KEY, null, null, signal, agent);
}

/**
 * 整链重取（页面→app js→key 全链；app js 抓取仅在重取链路走——评审 P2-3）：js 提取 default key
 * 与 decodeKey/decodeIv 兜底值源（js URL 未命中/下载失败/无形态 → 内建常量兜底继续，EX-P2D-4
 * 面），仍失败 → throw 降级。
 */
async function refreshYoudaoSession(signal: AbortSignal, agent: https.Agent | undefined): Promise<YoudaoSessionCache> {
  const page = await httpRequest(`${YOUDAO_WEB_HOST}/`, {
    method: 'GET',
    headers: { Referer: YOUDAO_WEB_HOST },
    signal,
    agent,
  });
  if (page.status !== 200) throw new Error(`预热 HTTP ${page.status}`);
  const cookie = cookieHeaderFromResponse(page.headers);
  const appJsUrl = YOUDAO_APP_JS_RE.exec(page.body)?.[0] ?? null;
  let defaultKey = YOUDAO_DEFAULT_KEY;
  let jsDecodeKey: string | null = null;
  let jsDecodeIv: string | null = null;
  if (appJsUrl) {
    try {
      const js = await httpRequest(appJsUrl, {
        method: 'GET',
        headers: { Referer: YOUDAO_WEB_HOST, ...(cookie ? { Cookie: cookie } : {}) },
        signal,
        agent,
      });
      if (js.status === 200) {
        defaultKey = extractYoudaoDefaultKey(js.body) ?? YOUDAO_DEFAULT_KEY;
        const parts = extractYoudaoDecodeParts(js.body);
        jsDecodeKey = parts.decodeKey;
        jsDecodeIv = parts.decodeIv;
      }
    } catch {
      /* app js 下载失败 → 内建常量兜底继续（EX-P2D-4 面） */
    }
  }
  return fetchYoudaoSecrets(cookie, defaultKey, jsDecodeKey, jsDecodeIv, signal, agent);
}

/** 会话缓存获取（缓存命中直返；未命中走并发单飞——冷启动/整链重取由 refresh 参数分流，
 *  共享同一 in-flight 槽防并发双取）。密钥流失败（网络/非 200/无 secretKey）→ throw，调用方降级。 */
async function getYoudaoSession(signal: AbortSignal, agent: https.Agent | undefined, refresh: boolean): Promise<YoudaoSessionCache> {
  if (youdaoSessionCache) return youdaoSessionCache;
  if (!youdaoSessionFetch) {
    youdaoSessionFetch = (refresh ? refreshYoudaoSession(signal, agent) : fetchYoudaoSessionCold(signal, agent))
      .finally(() => {
        youdaoSessionFetch = null;
      });
  }
  return youdaoSessionFetch;
}

async function youdaoOnce(
  chunk: string,
  signal: AbortSignal,
  agent: https.Agent | undefined,
  refresh: boolean,
): Promise<TranslationEngineAttempt> {
  let session: YoudaoSessionCache;
  try {
    session = await getYoudaoSession(signal, agent, refresh);
  } catch (err) {
    return networkFailure('有道', err);
  }
  try {
    // ④⑤ form POST → base64url 密文 → AES-128-CBC 解密 → translateResult[].tgt 拼接。
    const res = await httpRequest(`${YOUDAO_DICT_HOST}/webtranslate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: YOUDAO_WEB_HOST,
        Referer: YOUDAO_WEB_HOST,
        'X-Requested-With': 'XMLHttpRequest',
        ...(session.cookie ? { Cookie: session.cookie } : {}),
      },
      body: new URLSearchParams(youdaoTranslateForm(chunk, String(Date.now()), session.secretKey)).toString(),
      signal,
      agent,
    });
    if (res.status !== 200) return statusFailure('有道', res.status);
    const plain = youdaoDecrypt(res.body, session.aesKey, session.aesIv);
    if (plain === null) {
      // 解密失败 = secretKey/密钥三件套失效或接口改版 → 上层整链重取一次。
      return parseFailure('有道', '密文解密失败（密钥失效或接口改版）');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(plain);
    } catch {
      return parseFailure('有道', '解密明文非 JSON');
    }
    const text = extractYoudaoTranslation(parsed);
    if (text === null) {
      return parseFailure('有道', 'translateResult 缺失或空（接口改版）');
    }
    return { ok: true, text };
  } catch (err) {
    return networkFailure('有道', err);
  }
}

function makeYoudaoWeb(ctx: AdapterCtx): RealAdapter {
  // ctx.entry.endpoint 不消费（评审 P1-5：V2 固定多主机协议无单端点语义，URL 恒出厂域；
  // sanitize 对该 kind 的 endpoint 剥离在后点统一做）。
  void ctx;
  return async (segment, signal, agent) => {
    // >5000 字符防御性子切（评审 P3-2：正常路径不可达——上游 segmentSourceText 段硬顶 1200；
    // 本切仅为适配器直调/上游回归面兜底，子段译文按序拼接）。
    const chunks = segment.length > YOUDAO_WEB_MAX_CHARS
      ? splitBySentence(segment, YOUDAO_WEB_MAX_CHARS)
      : [segment];
    let text = '';
    for (const chunk of chunks) {
      // key 无 secretKey/解密失败/translateResult 缺失 → 整链重取恰一次（页面→app js→key 全链），
      // 仍失败 → 引擎失败降级（EX-P2D-9 面；对齐 bing/alibaba 重取一次先例）。
      let attempt = await youdaoOnce(chunk, signal, agent, false);
      if (!attempt.ok) {
        youdaoSessionCache = null;
        attempt = await youdaoOnce(chunk, signal, agent, true);
      }
      if (!attempt.ok) return attempt;
      text += attempt.text;
    }
    return { ok: true, text };
  };
}

// ── baidu-web 已随 2026-11-22 扩容批次 p7/W4 死引擎清理整链删除（00 计划 W4：07/08 报告实证
//  死引擎——适配器/端点常量/kind/种子全删；存量 seed-baidu-web 条目经 sanitize 读路径剔除）。
//  同批 google-gtx 亦按用户裁决（「谷歌先剔除掉」）整链剔除（配方留档 00 计划「已实证状态」表，
//  将来加回时按既有适配器先例重建）。 ──

// ── 引擎实例化 ──

type BuiltEngine =
  | { engine: TranslationEngine }
  | { unavailableError: string };

function buildEngine(entry: TranslationEngineConfig): BuiltEngine {
  const ctx: AdapterCtx = { entry };
  const adapterFactory: ((ctx: AdapterCtx) => RealAdapter) | null =
    entry.kind === 'bing-web' ? makeBingWeb
    : entry.kind === 'alibaba-web' ? makeAlibabaWeb
    : entry.kind === 'qq-transmart' ? makeQqTransmart
    : entry.kind === 'sogou-web' ? makeSogouWeb
    : entry.kind === 'youdao-web' ? makeYoudaoWeb
    // 评审 P2-7 休眠面：p7/W4 死引擎清理后 dispatch 覆盖现存全部五 kind，此兜底
    // 分支零 reachable 来源（sanitize 白名单已剔除越集 kind），将来引擎回归（付费通道或
    // google-gtx 加回）时恢复消费。
    : null;
  if (adapterFactory === null) {
    // enabled 但无适配器（类型系统不可达；越集 kind 经 sanitize 剔除后组内不应出现）——
    // 走 unavailable 机械面呈现，不阻塞组、零请求。
    return { unavailableError: '未知引擎类型' };
  }
  const real: RealAdapter = adapterFactory(ctx);
  const kind = entry.kind;
  const id = entry.id;
  const useProxy = entry.useProxy === true;
  return {
    engine: {
      kind,
      id,
      async translate(segment: string, signal: AbortSignal): Promise<TranslationEngineAttempt> {
        // seam 优先（测试注入；生产恒 null）。stub 契约失败形态无 kind 字段——按错误文案
        // 推断限频（含 429/限频字样 → rate-limit，供冷却表联动探测与翻译的降级测试）。
        if (transportOverride) {
          try {
            const r = await transportOverride({ engineKind: kind, segment, signal });
            if (r.ok) return r;
            const inferred = /\b429\b|限频/.test(r.error) ? 'rate-limit' : 'network';
            return { ok: false, error: r.error, kind: inferred };
          } catch (err) {
            return networkFailure(kind, err);
          }
        }
        let agent: https.Agent | undefined;
        if (useProxy) {
          // P1-B 代理面回撤（p8/W4）：config 显式代理闭包传参已整链删除（它存在的唯一理由是
          // google——「先剔除」语义下通用基建零消费者休眠；将来引擎加回即在此恢复消费，显式
          // 地址作为 resolveOutboundProxy 第二参直传）。出站代理 = env > Electron 系统代理链。
          const proxy = await resolveOutboundProxy(true);
          if (proxy) agent = agentForProxy(proxy);
        }
        return real(segment, signal, agent);
      },
    },
  };
}

// ── WebMtEngineGroup（order 升序 + enabled 过滤实例化；失败逐引擎降级全耗尽 → 段级失败；
//  429 冷却表共享注入；粘性起点由 service 层以 startEngineId 传入） ──

export interface WebMtEngineGroupAttempt {
  ok: boolean;
  text?: string;
  /** 成功引擎 id（粘性记账）。 */
  engineId?: string;
  /** 全耗尽时的中文摘要（含首引擎错误）。 */
  error?: string;
  /** 本段实际尝试过的引擎 id 序列（观测面）。 */
  tried: string[];
  /** 粘性引擎因 429 冷却被跳过（service 侧立即换粘引擎的依据）。 */
  stickySkipped: boolean;
}

export interface WebMtEngineGroup {
  /** 可用引擎（order 升序、enabled 过滤）。 */
  readonly engines: TranslationEngine[];
  /** enabled 但不可用——探测结果表需呈现，零请求。评审 P2-7 休眠面：付费通道/模板引擎
   *  与 google/baidu 死引擎删除后零 reachable 来源（现存五 kind 全有适配器），机械面保留，
   *  将来引擎回归时恢复消费。 */
  readonly unavailable: Array<{ id: string; kind: string; error: string }>;
  translateSegment(
    segment: string,
    signal: AbortSignal,
    startEngineId?: string,
  ): Promise<WebMtEngineGroupAttempt>;
}

export function createWebMtEngineGroup(
  config: TranslationConfig,
  opts: { cooldown?: Map<string, number> } = {},
): WebMtEngineGroup {
  const cooldown = opts.cooldown ?? new Map<string, number>();
  const sorted = [...(config.engines ?? [])].sort((a, b) => a.order - b.order);
  const engines: TranslationEngine[] = [];
  const unavailable: WebMtEngineGroup['unavailable'] = [];
  for (const entry of sorted) {
    if (!entry.enabled) continue;
    const built = buildEngine(entry);
    if ('engine' in built) engines.push(built.engine);
    else unavailable.push({ id: entry.id, kind: entry.kind, error: built.unavailableError });
  }
  const isCoolingDown = (kind: string): boolean => {
    const deadline = cooldown.get(kind);
    return deadline !== undefined && deadline > Date.now();
  };

  /** 单引擎尝试（10s 超时 + 外层 abort 链接；超时/异常归类 network）。 */
  const tryEngine = async (engine: TranslationEngine, segment: string, outer: AbortSignal): Promise<TranslationEngineAttempt> => {
    const ac = new AbortController();
    const onOuterAbort = (): void => ac.abort();
    if (outer.aborted) ac.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        engine.translate(segment, ac.signal),
        new Promise<TranslationEngineAttempt>((_, reject) => {
          timer = setTimeout(() => {
            ac.abort();
            reject(new Error(`引擎尝试超时（${TRANSLATION_ENGINE_TRY_TIMEOUT_MS}ms）`));
          }, TRANSLATION_ENGINE_TRY_TIMEOUT_MS);
        }),
      ]);
    } catch (err) {
      return networkFailure(engine.kind, err);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      outer.removeEventListener('abort', onOuterAbort);
    }
  };

  return {
    engines,
    unavailable,
    async translateSegment(segment, signal, startEngineId) {
      // 粘性起点旋转（保持 order 相对序）；无粘性/未命中 → 配置序。
      let list = engines;
      const stickyIdx = startEngineId ? engines.findIndex((e) => e.id === startEngineId) : -1;
      if (stickyIdx > 0) list = [...engines.slice(stickyIdx), ...engines.slice(0, stickyIdx)];
      const tried: string[] = [];
      let stickySkipped = false;
      let firstError = '';
      for (const engine of list) {
        if (isCoolingDown(engine.kind)) {
          if (engine.id === startEngineId) stickySkipped = true;
          continue;
        }
        tried.push(engine.id);
        const attempt = await tryEngine(engine, segment, signal);
        if (attempt.ok) {
          return { ok: true, text: attempt.text, engineId: engine.id, tried, stickySkipped };
        }
        if (attempt.kind === 'rate-limit') {
          cooldown.set(engine.kind, Date.now() + TRANSLATION_ENGINE_429_COOLDOWN_MS);
          logger.warn(`translation engine ${engine.kind} rate-limited; cooldown ${TRANSLATION_ENGINE_429_COOLDOWN_MS}ms`);
        }
        if (!firstError) firstError = attempt.error;
        if (signal.aborted) {
          return { ok: false, error: `已中止（${firstError}）`, tried, stickySkipped };
        }
      }
      // 全组耗尽终态（P2-1 计数式文案，2026-11-22 扩容批次 p8 并入）：N/M = 实际尝试数/组内引擎数，
      // firstError = 首个失败摘要（保留既有收集语义；零尝试形态如实报「无可尝试引擎」）。
      return {
        ok: false,
        error: `全部引擎不可用（${tried.length}/${list.length} 引擎失败，首错：${firstError || '无可尝试引擎'}）`,
        tried,
        stickySkipped,
      };
    },
  };
}
