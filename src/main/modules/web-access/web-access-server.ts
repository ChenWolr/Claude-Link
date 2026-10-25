// web-access-server.ts
// 「网页访问（局域网）」P3：HTTP 静态服务 + WS RPC + 令牌鉴权 + 生命周期
//（docs/plans/2026-10-20-web-access-plan.md §3-P3-2/§2 安全模型/§4 边界值表）。
//
// 依赖方向（计划 §2 铁律，无环）：本模块 → ipc-registry / push-bus / config-manager（token 存取）/
// shared 协议纯函数；config-manager **不得**反向 import 本模块；sync 驱动点仅两处——
// ipc-handlers.ts（CONFIG_SAVE 保存成功返回前）与 index.ts（createWindow 之后 + will-quit 收口）。
//
// 生命周期语义（幂等 sync）：
//   enabled=false → stop；true 且未运行 → start；运行中且 port/allowedHosts 变化 → restart；
//   token 为空 → getWebAccessToken() ?? setWebAccessToken(randomWebAccessToken())（§4 #1）。
// server.on('error')（EADDRINUSE 等）→ 状态 error + logger.error，不抛不崩（§4 #2）。

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import type { Duplex } from 'node:stream';
import { app } from 'electron';
import { WebSocketServer, WebSocket } from 'ws';
import type { RawData } from 'ws';
import type { AppConfig } from '../../../shared/types/config';
import type { WebAccessRuntimeStatusView } from '../../../shared/types/ipc';
import { BUILD_REV } from '../../../shared/build-info';
import {
  encodeWireValue,
  decodeWireValue,
  isAllowedHost,
  resolveStaticPath,
  STATIC_MIME,
} from '../../../shared/web-access-protocol';
import { getWebAccessToken, setWebAccessToken } from '../config-manager';
// P5（网页版导出）：一次性下载票据消费（ticket 即凭证，单次、10min 过期、不含路径信息）。
import { consumeTicket } from '../export-web-tickets';
import { invokeFromWeb } from '../../ipc-registry';
import { setWebPushSink } from '../push-bus';
import { logger } from '../../utils/logger';

/** 运行时状态（视图类型单一真相源在 shared/types/ipc.ts，preload 类型面同源）。 */
export type WebAccessRuntimeStatus = WebAccessRuntimeStatusView;

/** sync 钩子：主窗口 getter（P3 服务端生命周期暂不消费，接口形参按计划保留）。 */
export interface WebAccessSyncHooks {
  getMainWindow: () => Electron.BrowserWindow | null;
}

// ── 常量 ─────────────────────────────────────────────────────────────────────────

const WS_PATH = '/ws';
/** 单帧应用层上限 48MiB（超限回 resolve 错误；单帧硬上限 64MiB 由 ws maxPayload 兜底 close 1009）。
 *  §4 #11：30MiB 附件 base64≈41MB，两者皆可过。 */
const INVOKE_MAX_BYTES = 48 * 1024 * 1024;
/** 心跳：30s ping，连续 2 周期无 pong terminate（计划 §2）。 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;
const HEARTBEAT_MAX_MISSES = 2;
/** 每 IP 10 分钟窗口 5 次鉴权失败 → 429 拒绝升级（计划 §2/§4 #6）。 */
const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_WINDOW_MS = 10 * 60 * 1000;
/** close 4001 = 令牌无效（网页端据此清本地令牌回登录浮层，区别于网络断开 1006）。 */
const CLOSE_BAD_TOKEN = 4001;
/** close 1001 = going away（服务停/restart，网页端走重连浮层）。 */
const CLOSE_GOING_AWAY = 1001;

// ── 运行时状态 ───────────────────────────────────────────────────────────────────

interface WebClient {
  ws: WebSocket;
  ip: string;
  missedPongs: number;
}

let status: WebAccessRuntimeStatus = { state: 'off' };
let server: http.Server | null = null;
let wss: WebSocketServer | null = null;
const clients = new Set<WebClient>();
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let runningConfig: { port: number; allowedHosts: string[] } | null = null;
let hooks: WebAccessSyncHooks | null = null;
const rateBuckets = new Map<string, { count: number; resetAt: number }>();

// ── 导出面 ───────────────────────────────────────────────────────────────────────

/** 令牌生成：crypto.randomBytes(24).toString('base64url')（32 字符，计划 §2）。 */
export function randomWebAccessToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

/**
 * 幂等同步：按 config.webAccess 启停/重启 HTTP+WS 服务。只从 ipc-handlers.ts（CONFIG_SAVE）与
 * index.ts（createWindow 之后）两处驱动；可被 CONFIG_SAVE/内部 saveConfig 高频调用（运行中且
 * port/allowedHosts 未变时为纯读 no-op）。
 */
export function syncWebAccessServer(config: AppConfig, hooksIn: WebAccessSyncHooks): void {
  hooks = hooksIn;
  const cfg = config.webAccess;
  if (!cfg || !cfg.enabled) {
    stopWebAccessServer();
    return;
  }
  // §4 #1：enabled=true 且 token 为空 → 自动生成并持久化
  if (!getWebAccessToken()) {
    setWebAccessToken(randomWebAccessToken());
    logger.info('[web-access] 已自动生成网页访问令牌');
  }
  if (server && wss && runningConfig && sameListenConfig(runningConfig, cfg.port, cfg.allowedHosts)) {
    return; // 运行中且监听配置未变：幂等 no-op（token 轮换经 kickAllWebClients 单独处理）
  }
  restartServer(cfg.port, cfg.allowedHosts);
}

/** 当前运行状态（设置页状态卡用）。 */
export function getWebAccessStatus(): WebAccessRuntimeStatus {
  return { ...status };
}

/** 踢掉全部已认证连接：token-rotated → close 4001（网页端回登录浮层）；其余 → 1001（走重连）。 */
export function kickAllWebClients(reason: string): void {
  for (const client of [...clients]) {
    safeSend(client.ws, { v: 1, kind: 'bye', reason });
    try {
      client.ws.close(reason === 'token-rotated' ? CLOSE_BAD_TOKEN : CLOSE_GOING_AWAY, reason.slice(0, 100));
    } catch {
      /* 已断开竞态：忽略 */
    }
  }
  clients.clear();
  setWebPushSink(null);
}

/** 退出收口（index.ts will-quit）：先向全部 WS 发 bye(server-stopping) 再关 HTTP/WS 服务。 */
export function stopWebAccessServer(): void {
  stopHeartbeat();
  if (clients.size > 0) {
    kickAllWebClients('server-stopping');
  } else {
    setWebPushSink(null);
  }
  // 不调 wss.close()：其实现会对全部客户端 terminate，掐断 bye/close 帧的投递——
  // 优雅 close 帧已由 kickAll 发出，交给 close 握手自然收尾；进程退出时套接字随进程销毁。
  wss = null;
  runningConfig = null;
  if (server) {
    const srv = server;
    server = null;
    try {
      srv.close(() => {});
    } catch {
      /* 已关闭：忽略 */
    }
  }
  status = { state: 'off' };
}

// ── 启动/重启 ────────────────────────────────────────────────────────────────────

function sameListenConfig(running: { port: number; allowedHosts: string[] }, port: number, allowedHosts: string[]): boolean {
  if (running.port !== port) return false;
  if (running.allowedHosts.length !== allowedHosts.length) return false;
  return running.allowedHosts.every((h, i) => h === allowedHosts[i]);
}

function restartServer(port: number, allowedHosts: string[]): void {
  // restart：旧连接收 bye(server-stopping) 后优雅关闭（网页端走重连浮层，不清令牌）
  stopWebAccessServer();
  startServer(port, allowedHosts);
}

function startServer(port: number, allowedHosts: string[]): void {
  // 单帧硬上限 64MiB（ws maxPayload，超限自动 close 1009；计划 §3-P3-2）
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
  const srv = http.createServer((req, res) => {
    handleRequest(req, res, allowedHosts);
  });
  srv.on('error', (err: NodeJS.ErrnoException) => {
    // EADDRINUSE 等（§4 #2）：状态 error + 日志，不抛不崩；清理运行引用使下次 sync 可重试。
    const message = err.code ? `${err.code}: ${err.message}` : err.message;
    logger.error(`[web-access] server error: ${message}`);
    if (server === srv) {
      server = null;
      wss = null;
      runningConfig = null;
      stopHeartbeat();
      status = { state: 'error', port, message };
    }
  });
  srv.on('upgrade', (req, socket, head) => {
    handleUpgrade(req, socket, head, wsServer, allowedHosts, port);
  });
  // IPv4 全卡绑定（v6 场景由 allowedHosts+隧道覆盖，计划 §4 #16）
  srv.listen(port, '0.0.0.0', () => {
    status = { state: 'running', port };
    logger.info(`[web-access] listening on 0.0.0.0:${port}`);
  });
  server = srv;
  wss = wsServer;
  runningConfig = { port, allowedHosts: [...allowedHosts] };
  startHeartbeat();
}

// ── HTTP 静态（不鉴权：与应用安装包同等的公开代码，计划 §2）───────────────────────

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, allowedHosts: string[]): void {
  try {
    // Host 白名单（防 DNS rebinding，§4 #5）：裸 IP / localhost / allowedHosts 之外一律 403
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      plain(res, 403, 'Forbidden');
      return;
    }
    const method = (req.method ?? 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, {
        'Content-Type': 'text/plain; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        Allow: 'GET, HEAD',
      });
      res.end('Method Not Allowed');
      return;
    }
    const urlPath = (req.url ?? '/').split('?')[0]!.split('#')[0]!;
    // P5（网页版导出）：一次性票据下载端点——ticket 即凭证（192bit 随机、单次、10min 过期），
    // 不复用 WS token（a[download]/fetch 的 GET 无法携带 WS 鉴权）；仅暴露本 job 产物文件。
    // 置于 Host 白名单/方法门之后、静态解析之前（/api 命中不依赖渲染层构建产物）。
    if (urlPath === '/api/export-download') {
      serveExportDownload(req, res, method);
      return;
    }
    const rootDir = path.join(app.getAppPath(), 'out', 'renderer');
    if (!fs.existsSync(rootDir)) {
      // dev 未 build（§4 #4）：200 纯文本提示页
      plain(res, 200, '网页访问需要渲染层构建产物：请先执行 npm run build');
      return;
    }
    const filePath = resolveStaticPath(rootDir, urlPath);
    if (!filePath) {
      plain(res, 404, 'Not Found');
      return;
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      plain(res, 404, 'Not Found');
      return;
    }
    if (!stat.isFile()) {
      plain(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = STATIC_MIME[ext] ?? 'application/octet-stream';
    const isIndex = path.basename(filePath).toLowerCase() === 'index.html';
    res.writeHead(200, {
      'Content-Type': mime,
      'Content-Length': stat.size,
      // 入口文档不缓存（重发版/令牌轮换即时生效）；静态资源带内容指纹缓存一周
      'Cache-Control': isIndex ? 'no-cache' : 'max-age=604800, immutable',
      'X-Content-Type-Options': 'nosniff',
    });
    if (method === 'HEAD') {
      res.end();
      return;
    }
    // fs.createReadStream：asar 内路径由 Electron fs 补丁透明支持（打包产物可直接服务）
    const stream = fs.createReadStream(filePath);
    stream.on('error', (err) => {
      logger.error(`[web-access] static stream failed: ${filePath}`, err);
      res.destroy();
    });
    stream.pipe(res);
  } catch (e) {
    logger.error('[web-access] request handling failed', e);
    try {
      plain(res, 500, 'Internal Server Error');
    } catch {
      /* socket 已毁：忽略 */
    }
  }
}

function plain(res: http.ServerResponse, code: number, text: string): void {
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

// ── P5：导出产物一次性票据下载 ────────────────────────────────────────────────────
// 消费即摘票（伪造/过期/已用/重放统一 404 固定文案，无路径/状态泄漏）；命中后 statSync
// 预检（缺失 → 410，如 tempDir 已被清理），再按静态流同形态附件下发（Content-Length +
// nosniff + createReadStream pipe，流错误 destroy）。下载走 HTTP 流，不受 WS 48MiB 帧上限。
function serveExportDownload(req: http.IncomingMessage, res: http.ServerResponse, method: string): void {
  let ticket = '';
  try {
    ticket = new URL(req.url ?? '/', 'http://localhost').searchParams.get('ticket') ?? '';
  } catch {
    ticket = '';
  }
  const hit = consumeTicket(ticket);
  if (!hit) {
    // 固定文案：查无/过期/已用/伪造不区分——零信息泄漏（计划 §4.3）。
    plain(res, 404, 'Not Found（链接无效或已使用）');
    return;
  }
  let stat: fs.Stats;
  try {
    stat = fs.statSync(hit.filePath);
  } catch {
    plain(res, 410, 'Gone（文件已清理）');
    return;
  }
  if (!stat.isFile()) {
    plain(res, 410, 'Gone（文件已清理）');
    return;
  }
  const ext = path.extname(hit.filename).slice(1).toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  // Content-Disposition：filename*（RFC 5987）承载原名（会话名可含非 ASCII）；filename 兜底
  // ASCII 回退（老客户端）。
  const asciiFallback = hit.filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.writeHead(200, {
    'Content-Type': mime,
    'Content-Length': stat.size,
    'Content-Disposition': `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(hit.filename)}`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (method === 'HEAD') {
    res.end();
    return;
  }
  const stream = fs.createReadStream(hit.filePath);
  stream.on('error', (err) => {
    logger.error('[web-access] export download stream failed', err);
    res.destroy();
  });
  stream.pipe(res);
}

// ── WS 升级（鉴权四路径：对 token / 错 token / 超限 / 坏 Host，计划 §6-6）─────────

function handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, wsServer: WebSocketServer, allowedHosts: string[], port: number): void {
  try {
    let pathname = '/';
    let token = '';
    try {
      const u = new URL(req.url ?? '/', 'http://localhost');
      pathname = u.pathname;
      token = u.searchParams.get('token') ?? '';
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== WS_PATH) {
      socket.destroy();
      return;
    }
    if (!isAllowedHost(req.headers.host, allowedHosts)) {
      socket.destroy(); // §4 #5：坏 Host 拒绝升级
      return;
    }
    // Origin 校验（§4 #21）：浏览器必带；缺失放行（非浏览器客户端，token 仍是充分鉴权）
    const origin = req.headers.origin;
    if (typeof origin === 'string' && origin !== '' && !isOriginAllowed(origin, req.headers.host, allowedHosts, port)) {
      socket.destroy();
      return;
    }
    const ip = remoteIp(req);
    if (isRateLimited(ip)) {
      // §4 #6：同 IP 10 分钟窗口 5 次鉴权失败 → 429 拒绝升级
      try {
        socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      } catch {
        /* ignore */
      }
      socket.destroy();
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (ws) => {
      handleConnection(ws, ip, token);
    });
  } catch (e) {
    logger.error('[web-access] upgrade handling failed', e);
    try {
      socket.destroy();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Origin 同源判定：① 与请求 Host 头同源（页面即从本服务加载的 LAN 直连形态，http/https 两种
 * scheme）；② allowedHosts 条目（隧道/反代域名）的 http://<h>:<port> 与 https://<h> 形态——
 * 判定用 URL.origin（序列化为 scheme://host[:port]，默认端口 :80/:443 归一化省略、非默认端口
 * 保留），与候选集带 scheme 全形同形态比对。
 */
function isOriginAllowed(origin: string, hostHeader: string | undefined, allowedHosts: string[], port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const candidates = new Set<string>();
  const hh = typeof hostHeader === 'string' ? hostHeader.trim().toLowerCase() : '';
  if (hh) {
    candidates.add(`http://${hh}`);
    candidates.add(`https://${hh}`);
  }
  for (const entry of allowedHosts) {
    const host = String(entry ?? '').trim().toLowerCase();
    if (!host) continue;
    candidates.add(`http://${host}:${port}`);
    candidates.add(`https://${host}`);
    candidates.add(`http://${host}`);
    candidates.add(`https://${host}:${port}`);
  }
  return candidates.has(parsed.origin.toLowerCase());
}

function remoteIp(req: http.IncomingMessage): string {
  return req.socket.remoteAddress ?? 'unknown';
}

function isRateLimited(ip: string): boolean {
  const bucket = rateBuckets.get(ip);
  if (!bucket) return false;
  if (Date.now() > bucket.resetAt) {
    rateBuckets.delete(ip);
    return false;
  }
  return bucket.count >= RATE_LIMIT_MAX_FAILURES;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  // 顺手清理过期桶（LAN 规模极小，摊销成本可忽略）
  for (const [key, bucket] of rateBuckets) {
    if (now > bucket.resetAt) rateBuckets.delete(key);
  }
  const bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return;
  }
  bucket.count += 1;
}

// ── 连接生命周期 ─────────────────────────────────────────────────────────────────

function handleConnection(ws: WebSocket, ip: string, providedToken: string): void {
  const expected = getWebAccessToken();
  // token 复核：对 sha256 摘要做 timingSafeEqual（避免长度泄漏，计划 §2）；
  // expected 为 null（恢复出厂清键等）时一律拒绝——无有效令牌即无人可认证。
  if (!expected || !tokenMatches(providedToken, expected)) {
    recordAuthFailure(ip);
    safeSend(ws, { v: 1, kind: 'bye', reason: 'bad-token' });
    try {
      ws.close(CLOSE_BAD_TOKEN, 'bad-token');
    } catch {
      /* ignore */
    }
    return;
  }
  const client: WebClient = { ws, ip, missedPongs: 0 };
  clients.add(client);
  if (clients.size === 1) {
    // 首个已认证连接注入事件广播 sink；最后一个断开时清除（勿在还有客户端时清，计划 §3-P3-2）
    setWebPushSink(broadcastEvent);
  }
  ws.on('pong', () => {
    client.missedPongs = 0;
  });
  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) return; // v1 协议仅 JSON 文本帧
    handleClientMessage(client, data);
  });
  ws.on('close', () => {
    clients.delete(client);
    if (clients.size === 0) setWebPushSink(null);
  });
  ws.on('error', (err: Error) => {
    logger.error(`[web-access] client error (${ip})`, err);
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  });
  safeSend(ws, { v: 1, kind: 'welcome', appVersion: app.getVersion(), buildRev: BUILD_REV });
}

/** sha256 摘要常量时间比较（输入先归一为定长摘要，避免 timingSafeEqual 长度不等抛错 + 长度泄漏）。 */
function tokenMatches(provided: string, expected: string): boolean {
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest();
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function safeSend(ws: WebSocket, payload: unknown): void {
  try {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  } catch {
    /* 发送竞态（连接刚断开）：忽略 */
  }
}

/** 事件广播（push-bus web sink 注入）：事件编码一次、同一字符串发全部客户端（计划 §3-P3-2）。 */
function broadcastEvent(channel: string, args: unknown[]): void {
  if (clients.size === 0) return;
  const frame = JSON.stringify({ v: 1, kind: 'event', channel, args: encodeWireValue(args) });
  for (const client of clients) {
    try {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(frame);
      }
    } catch {
      /* 单客户端发送失败不影响其余 */
    }
  }
}

// ── invoke 分发（客户端→服务端仅 invoke 一种帧）─────────────────────────────────

function rawDataToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(new Uint8Array(data)).toString('utf8');
  return (data as Buffer).toString('utf8');
}

function resolveError(ws: WebSocket, id: string, error: string): void {
  safeSend(ws, { v: 1, kind: 'resolve', id, ok: false, error });
}

function handleClientMessage(client: WebClient, data: RawData): void {
  const text = rawDataToString(data);
  // 48MiB 检查先于 JSON.parse（review P3-1）：单帧应用层上限（§4 #11）；>64MiB 由 ws maxPayload close 1009 兜底。
  // 取舍：超限回包需 id，而 id 须解析 rec.id 才可得、此处尚不可得，故直接 close 1009（与 ws maxPayload 超限同语义）——
  // 帧已超 48MiB，客户端属异常路径，回包可达性不作强保证。
  if (Buffer.byteLength(text) > INVOKE_MAX_BYTES) {
    client.ws.close(1009, '单帧载荷超限（上限 48MiB）');
    return;
  }
  let msg: unknown;
  try {
    msg = JSON.parse(text);
  } catch {
    return; // 畸形 JSON 帧：静默丢弃（协议外流量不喂错误回包）
  }
  const rec = msg !== null && typeof msg === 'object' ? (msg as Record<string, unknown>) : null;
  if (!rec || rec.kind !== 'invoke') return;
  const id = typeof rec.id === 'string' ? rec.id : '';
  if (!id) return;
  if (typeof rec.channel !== 'string' || !Array.isArray(rec.args)) {
    resolveError(client.ws, id, 'invoke 参数非法（channel 须为字符串、args 须为数组）');
    return;
  }
  let args: unknown[];
  try {
    args = decodeWireValue(rec.args) as unknown[];
  } catch (e) {
    // 非法 base64 等 fail-fast：归一为 error 响应，不崩进程（web-access-protocol P1 注记）
    resolveError(client.ws, id, `载荷解码失败: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  void invokeFromWeb(rec.channel, args)
    .then((r) => {
      if (client.ws.readyState !== WebSocket.OPEN) return; // 回包前已断开
      if (r.ok) {
        safeSend(client.ws, { v: 1, kind: 'resolve', id, ok: true, result: encodeWireValue(r.result) });
      } else {
        resolveError(client.ws, id, r.error);
      }
    })
    .catch((e) => {
      logger.error('[web-access] invoke dispatch failed', e);
      resolveError(client.ws, id, e instanceof Error ? e.message : String(e));
    });
}

// ── 心跳 ─────────────────────────────────────────────────────────────────────────

function startHeartbeat(): void {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    for (const client of [...clients]) {
      if (client.missedPongs >= HEARTBEAT_MAX_MISSES) {
        // 连续 2 周期无 pong → terminate（计划 §2）
        try {
          client.ws.terminate();
        } catch {
          /* ignore */
        }
        clients.delete(client);
        continue;
      }
      client.missedPongs += 1;
      try {
        client.ws.ping();
      } catch {
        /* ignore */
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat(): void {
  if (heartbeatTimer !== null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

// hooks 形参在 P3 保留（计划 §3-P3-2 接口签名），消费点在后续点接入前由引用防 unused 报错。
export function getWebAccessHooks(): WebAccessSyncHooks | null {
  return hooks;
}
