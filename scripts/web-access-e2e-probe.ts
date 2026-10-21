// web-access-e2e-probe.ts
// 「网页访问（局域网）」协议级全链 E2E 探针（SA-5 / P0-6a；手动/编排器用，**不进 selftest 链**——
// 需真实 app 运行中、网页访问开关开启、CLI/上游网关可用；应用未运行时干跑应快速失败并给出连接诊断）：
//
//   npx tsx scripts/web-access-e2e-probe.ts [--url ws://127.0.0.1:8790/ws] [--token <t>] [--lan-ip <本机局域网 IPv4>]
//
// 默认参数从 %APPDATA%/claude-link/claude-link-config.json 读取：顶层键 webAccessToken（token）+
// webAccess.port（端口）；--url/--token 覆盖优先（与 scripts/web-access-probe.ts 一致）。
//
// 用例（P0-P9，任一失败打印 [P?] FAIL: 期望/实际 并 exit 1；每用例打印 [P?] PASS 行）：
//   P0  GET /（Host 头 127.0.0.1:<port> 与 <lan-ip>:<port>）→ 均 200 且 body 含 <div id="app">；
//   P1  错 token WS 升级 → bye(bad-token) + close 4001（仅跑 1 次，避免限速 5 次/10 分钟）；
//   P2  对 token → welcome 帧（appVersion/buildRev）；
//   P3  invoke session:list → ok 且返回数组；
//   P4  invoke session:create（spec.workingDir=本仓库）→ ok 返回含 id 的 Session；并发断言收到
//       sessions:changed {kind:'upsert',sessionId} 广播（P9 的 upsert 项在此一并断言）；
//   P5  invoke chat:send（固定文本「请只回复数字 42,不要使用任何工具」，不触发工具/权限弹窗）→
//       ≥1 条 stream_event 增量 + ≥1 条 type:'message' 全量 + 1 条 type:'result'（超时 120s）；
//       CLI/上游网关不可用 → 打印错误文本原样后 fail；
//   P6  第二轮 send 后立刻 invoke chat:abort → type:'aborted' 或新 type:'result'（超时 60s）；
//   P7  invoke message:getBySession（P4 会话 id）→ user+assistant 合计 ≥3；
//   P8  invoke session:delete → ok 且收到 sessions:changed {kind:'delete'} 广播（测试会话自清理）；
//   P9  （upsert 广播断言已并入 P4）末尾汇总打印。
//
// 纪律：token 全程掩码（前 4 后 4，任何输出/日志/异常栈不出现完整 token）；异常路径尽量 close 连接、
// 测试会话尽力清理（不悬挂）；总超时 300s 兜底自杀 exit 1；关键输出追加落盘
// docs/reports/web-access-e2e-probe-run.log（目录不存在则创建；token 掩码同样生效）。
//
// 协议事实（真相源，勿凭记忆改）：channel 精确字符串取自 src/shared/types/ipc.ts IPC_CHANNELS
// （session:list / session:create / session:delete / message:getBySession / chat:send / chat:abort /
// chat:event / sessions:changed），键名对照 src/renderer/web/web-bridge.ts WEB_CHANNEL_TABLE；客户端→
// 服务端仅 invoke 帧 {v:1,kind:'invoke',id,channel,args}，事件**无 subscribe 帧**——服务端向全部已认证
// 连接广播 {v:1,kind:'event',channel,args}（src/main/modules/web-access/web-access-server.ts）；chat:event
// 载荷 args[0]={sessionId,event:CliEvent}，sessions:changed 载荷 args[0]={kind,sessionId}。

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import WebSocket from 'ws';

// ── 常量 ─────────────────────────────────────────────────────────────────────────

const DEFAULT_PORT = 8790;

/** 本机局域网 IPv4（F10 脱敏：由 node:os networkInterfaces() 取首个非 internal 且非
 * 100.64.0.0/10 CGNAT 段的 IPv4 程序派生（CGNAT=Tailscale 网卡，与常规 LAN 区分），
 * 源码不硬编码本机 IP；--lan-ip 覆盖优先不变）。 */
function deriveLanIp(): string {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const iface of list ?? []) {
      if (iface.internal || iface.family !== 'IPv4') continue;
      const p = iface.address.split('.').map(Number);
      if (p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127) continue;
      return iface.address;
    }
  }
  return '';
}
const DEFAULT_LAN_IP = deriveLanIp();
/** P4 创建会话携带的工作目录（F10 脱敏：process.cwd()——探针在仓库根以 npm run/tsx 运行
 * 时即仓库根，便于复用 CLI 会话；语义等同旧的仓库绝对路径）。 */
const WORKING_DIR = process.cwd();
/** P5 固定消息文本：不触发任何工具，避免权限弹窗卡死无人值守回合。 */
const E2E_MESSAGE_TEXT = '请只回复数字 42,不要使用任何工具';
const BAD_TOKEN = 'definitely-wrong-e2e-probe-token';
/** 错 token 仅 1 次（限速阈值：同 IP 10 分钟 5 次鉴权失败 → 429）。 */

const TOTAL_TIMEOUT_MS = 300_000;
const HTTP_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 10_000;
const INVOKE_TIMEOUT_MS = 30_000;
const CHAT_TURN_TIMEOUT_MS = 120_000;
const ABORT_TURN_TIMEOUT_MS = 60_000;
const EVENT_WAIT_TIMEOUT_MS = 10_000;

const APP_HINT = '请先启动应用（Claude Link 桌面端）并确认设置页「网页访问」开关已开启（配置 webAccess.enabled=true，端口见配置）';

// channel 精确字符串（真相源：src/shared/types/ipc.ts IPC_CHANNELS；勿凭空改）。
const CH = {
  SESSION_LIST: 'session:list',
  SESSION_CREATE: 'session:create',
  SESSION_DELETE: 'session:delete',
  MESSAGE_GET_BY_SESSION: 'message:getBySession',
  CHAT_SEND: 'chat:send',
  CHAT_ABORT: 'chat:abort',
  CHAT_EVENT: 'chat:event',
  SESSIONS_CHANGED: 'sessions:changed',
} as const;

type Frame = Record<string, unknown>;

interface RecordedEvent {
  channel: string;
  args: unknown[];
}

// ── 配置默认值（%APPDATA%/claude-link/claude-link-config.json）──────────────────

function readConfigDefaults(): { port: number; token: string; configPath: string } {
  const appData = process.env.APPDATA;
  if (!appData) return { port: DEFAULT_PORT, token: '', configPath: '(无 APPDATA 环境)' };
  const configPath = path.join(appData, 'claude-link', 'claude-link-config.json');
  try {
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    const token = typeof raw.webAccessToken === 'string' ? raw.webAccessToken : '';
    const webAccess = raw.webAccess as Record<string, unknown> | undefined;
    const rawPort = webAccess?.port;
    const port =
      typeof rawPort === 'number' && Number.isInteger(rawPort) && rawPort >= 1024 && rawPort <= 65535
        ? rawPort
        : DEFAULT_PORT;
    return { port, token, configPath };
  } catch (e) {
    return { port: DEFAULT_PORT, token: '', configPath: `${configPath}（读取失败：${e instanceof Error ? e.message : String(e)}）` };
  }
}

// ── 参数解析 ─────────────────────────────────────────────────────────────────────

interface ProbeArgs {
  wsUrl: string;
  httpBase: string;
  port: number;
  lanIp: string;
  token: string;
}

function parseArgs(argv: string[]): ProbeArgs {
  let url = '';
  let token = '';
  let lanIp = '';
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--url') url = argv[i + 1] ?? '';
    if (argv[i] === '--token') token = argv[i + 1] ?? '';
    if (argv[i] === '--lan-ip') lanIp = argv[i + 1] ?? '';
  }
  const defaults = readConfigDefaults();
  const resolvedUrl = url || `ws://127.0.0.1:${defaults.port}/ws`;
  const resolvedToken = token || defaults.token;
  const resolvedLanIp = lanIp || DEFAULT_LAN_IP;
  // HTTP 基址与 Host 头端口从最终 ws url 派生（--url 覆盖时同步生效）；解析失败回落默认。
  let port = defaults.port;
  let httpBase = `http://127.0.0.1:${defaults.port}`;
  try {
    const u = new URL(resolvedUrl);
    httpBase = `http://${u.host}`;
    if (u.port && /^\d+$/.test(u.port)) port = Number(u.port);
  } catch {
    /* 无效 --url：保留默认基址（后续步骤会以连接失败报出） */
  }
  if (!resolvedLanIp) {
    console.error(
      '未获得本机局域网 IPv4：networkInterfaces() 中无非 internal 的 IPv4 地址，且未提供 --lan-ip。\n' +
        '用法：npx tsx scripts/web-access-e2e-probe.ts [--url ws://127.0.0.1:8790/ws] [--token <t>] [--lan-ip <本机局域网 IPv4>]',
    );
    process.exit(2);
  }
  if (!resolvedToken) {
    console.error(
      `未获得网页访问令牌：--token 未提供，且配置文件（${defaults.configPath}）顶层键 webAccessToken 缺失或为空。\n` +
        '用法：npx tsx scripts/web-access-e2e-probe.ts [--url ws://127.0.0.1:8790/ws] [--token <t>] [--lan-ip <本机局域网 IPv4>]',
    );
    process.exit(2);
  }
  return { wsUrl: resolvedUrl, httpBase, port, lanIp: resolvedLanIp, token: resolvedToken };
}

// ── token 掩码 + 落盘日志（任何输出先过 sanitize，杜绝完整 token 泄漏）──────────

let activeToken = '';

function maskToken(): string {
  if (!activeToken) return '(空)';
  return activeToken.length >= 8 ? `${activeToken.slice(0, 4)}****${activeToken.slice(-4)}` : '****';
}

function sanitize(text: string): string {
  if (!activeToken) return text;
  return text.split(activeToken).join(maskToken());
}

const logFilePath = path.resolve(__dirname, '..', 'docs', 'reports', 'web-access-e2e-probe-run.log');

function writeLog(line: string, isError: boolean): void {
  const safe = sanitize(line);
  if (isError) console.error(safe);
  else console.log(safe);
  try {
    fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
    fs.appendFileSync(logFilePath, `${safe}\n`);
  } catch {
    /* 日志落盘失败不阻断探针主流程 */
  }
}

function log(line: string): void {
  writeLog(line, false);
}

// ── 用例结果汇总 ─────────────────────────────────────────────────────────────────

/**
 * 用例登记表（同时是 grep 级锚点：源码内 [P0]-[P9] 字面标记取自此处；末尾汇总逐条打印）。
 * P9 说明：upsert 广播并发断言已并入 P4（同一动作窗口），P9 仅末尾汇总。
 */
const CASES: Array<{ id: string; label: string }> = [
  { id: 'P0', label: '[P0] HTTP GET /（Host=127.0.0.1 与局域网 IP）→ 200 且含 <div id="app">' },
  { id: 'P1', label: '[P1] 错 token WS 升级 → bye(bad-token) + close 4001（仅 1 次，不触限速）' },
  { id: 'P2', label: '[P2] 对 token → welcome（appVersion/buildRev）' },
  { id: 'P3', label: '[P3] invoke session:list → ok 且返回数组' },
  { id: 'P4', label: '[P4] invoke session:create（workingDir=本仓库）→ Session 含 id + sessions:changed(upsert) 广播' },
  { id: 'P5', label: '[P5] invoke chat:send → ≥1 stream_event 增量 + ≥1 message 全量 + 1 result（120s）' },
  { id: 'P6', label: '[P6] 第二轮 send 后立刻 chat:abort → aborted 或新 result（60s）' },
  { id: 'P7', label: '[P7] invoke message:getBySession → user+assistant 合计 ≥3' },
  { id: 'P8', label: '[P8] invoke session:delete → ok + sessions:changed(delete) 广播' },
  { id: 'P9', label: '[P9] 并发广播断言汇总：upsert（并入 P4）+ delete（P8）' },
];

const passedCases = new Set<string>();

function pass(id: string, note: string): void {
  passedCases.add(id);
  log(`[${id}] PASS ${note}`);
}

/** 汇总（逐用例一行；全过时为「全部 10 用例通过（P0-P9）」收尾行）。 */
function printSummary(): void {
  for (const c of CASES) {
    log(`  ${passedCases.has(c.id) ? 'PASS' : 'FAIL'} ${c.label}`);
  }
  const missing = CASES.filter((c) => !passedCases.has(c.id));
  if (missing.length === 0) log('全部 10 用例通过（P0-P9）');
  else log(`已通过 ${passedCases.size}/10（未通过：${missing.map((c) => c.id).join(', ')}）`);
}

// ── 测试会话善后（异常路径也尽力清理，不悬挂）────────────────────────────────────

let testSessionId: string | null = null;
let mainSocket: E2eSocket | null = null;
/** cleanup 复连目标（main 里赋值；模块级即可，无需 globalThis）。 */
let targetWsUrl = '';
let targetToken = '';

async function cleanupBestEffort(): Promise<void> {
  if (testSessionId) {
    const sid = testSessionId;
    testSessionId = null;
    try {
      let socket = mainSocket;
      let owned = false;
      if (!socket || !socket.isOpen()) {
        socket = null;
        owned = true;
        try {
          socket = (await connectAuthed(targetWsUrl, targetToken, CONNECT_TIMEOUT_MS)).socket;
        } catch {
          socket = null;
        }
      }
      if (socket) {
        await socket.invoke(CH.SESSION_DELETE, [sid], INVOKE_TIMEOUT_MS);
        log(`[cleanup] 已删除测试会话 ${sid}`);
        if (owned) socket.close();
      }
    } catch (e) {
      log(`[cleanup] 删除测试会话失败（会残留，需人工清理）：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (mainSocket) {
    mainSocket.close();
    mainSocket = null;
  }
}

let exited = false;

async function fail(id: string, diff: string): Promise<never> {
  if (exited) process.exit(1);
  exited = true;
  writeLog(`[${id}] FAIL: ${diff}`, true);
  await cleanupBestEffort();
  printSummary();
  process.exit(1);
}

// ── P0：HTTP GET /（两个 Host 头）───────────────────────────────────────────────

function httpGet(url: string, hostHeader: string, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(url);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    const req = http.get(
      {
        hostname: u.hostname,
        port: u.port || 80,
        path: '/',
        headers: { Host: hostHeader },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`HTTP 请求超时（${timeoutMs}ms）`)));
    req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))));
  });
}

async function runP0(args: ProbeArgs): Promise<void> {
  const hosts = [`127.0.0.1:${args.port}`, `${args.lanIp}:${args.port}`];
  for (const host of hosts) {
    let res: { status: number; body: string };
    try {
      res = await httpGet(args.httpBase, host, HTTP_TIMEOUT_MS);
    } catch (e) {
      await fail('P0', `Host=${host} 请求失败：${e instanceof Error ? e.message : String(e)}（${APP_HINT}）`);
      return; // fail() 恒 process.exit；此 return 仅为消除 strict TS2454（res used before assigned）
    }
    if (res.status !== 200) {
      await fail('P0', `Host=${host} 期望 HTTP 200，实际 ${res.status}；body 前 200 字符：${res.body.slice(0, 200)}`);
    }
    if (!res.body.includes('<div id="app">')) {
      await fail('P0', `Host=${host} body 缺少 <div id="app">（期望渲染层入口页）；body 前 200 字符：${res.body.slice(0, 200)}`);
    }
  }
  pass('P0', `GET / 两个 Host（127.0.0.1 与 ${args.lanIp}）均 200 且含 <div id="app">`);
}

// ── WS 客户端（invoke + 事件广播记录；帧格式与既有 probe 一致，不引入新依赖）────

interface EventWaiter {
  channel: string;
  fromIndex: number;
  predicate: (args: unknown[]) => boolean;
  resolve: (args: unknown[]) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class E2eSocket {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private readonly pending = new Map<string, { resolve: (frame: Frame) => void; reject: (e: Error) => void }>();
  private readonly waiters = new Set<EventWaiter>();
  private readonly events: RecordedEvent[] = [];
  private welcomeResolve: ((frame: Frame) => void) | null = null;
  private welcomeReject: ((e: Error) => void) | null = null;
  closedCode: number | null = null;

  connect(rawUrl: string, token: string, timeoutMs: number): Promise<Frame> {
    return new Promise<Frame>((resolve, reject) => {
      const url = rawUrl.includes('?') ? `${rawUrl}&token=${encodeURIComponent(token)}` : `${rawUrl}?token=${encodeURIComponent(token)}`;
      const ws = new WebSocket(url);
      this.ws = ws;
      const timer = setTimeout(() => {
        reject(new Error(`WS 连接/等待 welcome 超时（${timeoutMs}ms）。${APP_HINT}`));
        try { ws.terminate(); } catch { /* ignore */ }
      }, timeoutMs);
      this.welcomeResolve = (frame) => {
        clearTimeout(timer);
        resolve(frame);
      };
      this.welcomeReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
      ws.on('message', (data) => {
        let frame: Frame;
        try {
          frame = JSON.parse(String(data)) as Frame;
        } catch {
          return; // 非法帧忽略
        }
        if (frame.kind === 'welcome') {
          if (this.welcomeResolve) this.welcomeResolve(frame);
          this.welcomeResolve = null;
          this.welcomeReject = null;
          return;
        }
        if (frame.kind === 'resolve') {
          const id = typeof frame.id === 'string' ? frame.id : '';
          const p = this.pending.get(id);
          if (p) {
            this.pending.delete(id);
            p.resolve(frame);
          }
          return;
        }
        if (frame.kind === 'event') {
          const channel = typeof frame.channel === 'string' ? frame.channel : '';
          const args = Array.isArray(frame.args) ? frame.args : [];
          this.events.push({ channel, args });
          for (const w of [...this.waiters]) {
            if (w.channel === channel && this.events.length - 1 >= w.fromIndex && w.predicate(args)) {
              this.waiters.delete(w);
              clearTimeout(w.timer);
              w.resolve(args);
            }
          }
          return;
        }
        // bye 等其余帧：本探针不消费（主流程 bye 会随后触发 close）
      });
      ws.on('close', (code) => {
        this.closedCode = code;
        const err = new Error(`WS 连接已关闭（code=${code}）`);
        if (this.welcomeReject) {
          this.welcomeReject(err);
          this.welcomeResolve = null;
          this.welcomeReject = null;
        }
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        for (const w of this.waiters) {
          clearTimeout(w.timer);
          w.reject(err);
        }
        this.waiters.clear();
      });
      ws.on('error', (err) => {
        if (this.welcomeReject) {
          this.welcomeReject(new Error(`WS 连接错误：${err.message}。${APP_HINT}`));
          this.welcomeResolve = null;
          this.welcomeReject = null;
        }
        // open 后的 error 由 close 收口，不在此重复 reject pending（避免双 settle）
      });
    });
  }

  isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  /** 发送 invoke 并等待对应 resolve 帧（ok 与否都 resolve，调用方断言 frame.ok）。 */
  invoke(channel: string, args: unknown[], timeoutMs: number): Promise<Frame> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WS 未连接，无法 invoke'));
    }
    const id = `e2e-${this.nextId}`;
    this.nextId += 1;
    return new Promise<Frame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`invoke(${channel}) 超时（${timeoutMs}ms）`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ v: 1, kind: 'invoke', id, channel, args }));
    });
  }

  /** 当前已记录事件数（调用方在动作前取快照，作 waitForEvent 的 fromIndex）。 */
  eventIndex(): number {
    return this.events.length;
  }

  recordedEvents(fromIndex: number, channel: string): RecordedEvent[] {
    return this.events.filter((e, i) => i >= fromIndex && e.channel === channel);
  }

  /**
   * 等待事件广播：先扫已记录帧（≥ fromIndex），未命中则挂 waiter 等后续帧；超时 reject。
   * （协议无 subscribe 帧——服务端向全部已认证连接广播，本地按 channel 过滤即可。）
   */
  waitForEvent(channel: string, predicate: (args: unknown[]) => boolean, timeoutMs: number, fromIndex: number): Promise<unknown[]> {
    const recorded = this.recordedEvents(fromIndex, channel);
    const hit = recorded.find((e) => predicate(e.args));
    if (hit) return Promise.resolve(hit.args);
    return new Promise<unknown[]>((resolve, reject) => {
      const waiter: EventWaiter = {
        channel,
        fromIndex,
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`等待事件 ${channel} 超时（${timeoutMs}ms）`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }

  close(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    try {
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
        ws.close(1000, 'probe-done');
        setTimeout(() => {
          try { ws.terminate(); } catch { /* ignore */ }
        }, 1000).unref();
      }
    } catch {
      try { ws.terminate(); } catch { /* ignore */ }
    }
  }
}

async function connectAuthed(rawUrl: string, token: string, timeoutMs: number): Promise<{ socket: E2eSocket; welcome: Frame }> {
  const socket = new E2eSocket();
  const welcome = await socket.connect(rawUrl, token, timeoutMs);
  return { socket, welcome };
}

// ── P1：错 token → bye(bad-token) + close 4001（仅 1 次）────────────────────────

async function runP1(rawUrl: string): Promise<void> {
  const url = rawUrl.includes('?') ? `${rawUrl}&token=${encodeURIComponent(BAD_TOKEN)}` : `${rawUrl}?token=${encodeURIComponent(BAD_TOKEN)}`;
  const result = await new Promise<{ bye: Frame | null; closeCode: number }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`错 token 探测超时（${CONNECT_TIMEOUT_MS}ms）。${APP_HINT}`)), CONNECT_TIMEOUT_MS);
    const ws = new WebSocket(url);
    let bye: Frame | null = null;
    ws.on('message', (data) => {
      try {
        const frame = JSON.parse(String(data)) as Frame;
        if (frame.kind === 'bye') bye = frame;
      } catch {
        /* 非法帧忽略 */
      }
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      resolve({ bye, closeCode: code });
    });
    ws.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`错 token 连接错误：${err.message}。${APP_HINT}`));
    });
  });
  if (!result.bye || result.bye.kind !== 'bye' || result.bye.reason !== 'bad-token') {
    await fail('P1', `期望 bye 帧 {kind:'bye',reason:'bad-token'}，实际 ${JSON.stringify(result.bye).slice(0, 200)}`);
  }
  if (result.closeCode !== 4001) {
    await fail('P1', `期望 close code 4001，实际 ${result.closeCode}`);
  }
  pass('P1', '错 token → bye(bad-token) + close 4001（仅 1 次，未触限速）');
}

// ── chat:event 载荷辅助 ──────────────────────────────────────────────────────────

interface ChatEventEnvelope {
  sessionId?: string;
  event?: Record<string, unknown>;
}

function asChatEnvelope(args: unknown[]): ChatEventEnvelope | null {
  const first = args[0];
  if (first !== null && typeof first === 'object') return first as ChatEventEnvelope;
  return null;
}

/** 收集某会话从 fromIndex 起的全部 CliEvent（event 字段），按到达序。 */
function collectChatEvents(socket: E2eSocket, fromIndex: number, sessionId: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const rec of socket.recordedEvents(fromIndex, CH.CHAT_EVENT)) {
    const env = asChatEnvelope(rec.args);
    if (env && env.sessionId === sessionId && env.event && typeof env.event === 'object') {
      out.push(env.event);
    }
  }
  return out;
}

function describeCliEvent(event: Record<string, unknown>): string {
  const type = String(event.type);
  if (type === 'error') return `type=error message=${String(event.message ?? '')}`;
  if (type === 'system' && event.subtype === 'api_retry') {
    return `type=system/api_retry error=${String(event.error ?? '?')} retryCount=${String(event.retryCount ?? '?')}/${String(event.retryLimit ?? '?')}`;
  }
  if (type === 'aborted') return `type=aborted message=${String(event.message ?? '')}`;
  if (type === 'result') {
    return `type=result subtype=${String(event.subtype ?? '?')} is_error=${String(event.is_error)} errors=${JSON.stringify(event.errors ?? [])} result=${String(event.result ?? '').slice(0, 300)}`;
  }
  return `type=${type}`;
}

/** 回合失败诊断：收集 error / api_retry / aborted / result(is_error) 事件文本原样输出。 */
function collectTurnDiagnostics(events: Array<Record<string, unknown>>): string {
  const lines: string[] = [];
  for (const event of events) {
    const type = String(event.type);
    if (type === 'error' || type === 'aborted') lines.push(describeCliEvent(event));
    else if (type === 'system' && event.subtype === 'api_retry') lines.push(describeCliEvent(event));
    else if (type === 'result' && event.is_error === true) lines.push(describeCliEvent(event));
  }
  if (lines.length === 0) {
    const types = events.map((e) => String(e.type)).join(',') || '（无任何事件）';
    lines.push(`无显式错误事件；收到的事件类型序列：${types.slice(0, 500)}`);
  }
  return `回合诊断（错误文本原样）：\n  ${lines.join('\n  ')}`;
}

// ── 主流程 ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  activeToken = args.token;
  targetWsUrl = args.wsUrl;
  targetToken = args.token;

  log(`[e2e] ==== run ${new Date().toISOString()} ====`);
  log(`[e2e] 端口=${args.port} token=${maskToken()} url=${args.wsUrl}（token 已掩码；日志落盘 ${path.relative(path.resolve(__dirname, '..'), logFilePath)}）`);

  // P0：HTTP 双 Host
  await runP0(args);

  // P1：错 token（仅 1 次）
  await runP1(args.wsUrl);

  // P2-P8：单条已认证连接全链
  let welcomeFrame: Frame;
  try {
    const connected = await connectAuthed(args.wsUrl, args.token, CONNECT_TIMEOUT_MS);
    mainSocket = connected.socket;
    welcomeFrame = connected.welcome;
  } catch (e) {
    await fail('P2', `对 token 连接/欢迎帧失败：${e instanceof Error ? e.message : String(e)}`);
    return; // fail() 恒 process.exit；此 return 仅为消除 strict TS2454（welcomeFrame used before assigned）
  }
  // P2：welcome（appVersion/buildRev 字符串，与既有 probe 同口径）
  if (
    !welcomeFrame ||
    typeof welcomeFrame.appVersion !== 'string' ||
    typeof welcomeFrame.buildRev !== 'string'
  ) {
    await fail('P2', `期望 welcome 含 appVersion/buildRev 字符串，实际 ${JSON.stringify(welcomeFrame).slice(0, 200)}`);
  }
  pass('P2', `对 token → welcome（appVersion=${String(welcomeFrame!.appVersion)}, buildRev=${String(welcomeFrame!.buildRev)}）`);

  const socket = mainSocket!;

  // P3：session:list
  const listFrame = await socket.invoke(CH.SESSION_LIST, [], INVOKE_TIMEOUT_MS).catch(async (e) => {
    await fail('P3', `invoke(session:list) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (listFrame.ok !== true || !Array.isArray(listFrame.result)) {
    await fail('P3', `期望 ok:true 且 result 为数组，实际 ok=${String(listFrame.ok)}、result 类型=${Array.isArray(listFrame.result) ? 'array' : typeof listFrame.result}、error=${String(listFrame.error ?? '')}`);
  }
  pass('P3', `invoke(session:list) → ok 且返回数组（${Array.isArray(listFrame.result) ? (listFrame.result as unknown[]).length : 0} 条）`);

  // P4：session:create（含 P9 的 sessions:changed upsert 并发断言）
  const createStartIdx = socket.eventIndex();
  const sessionName = `web-e2e-probe ${new Date().toISOString()}`;
  const createFrame = await socket.invoke(CH.SESSION_CREATE, [sessionName, { workingDir: WORKING_DIR }], INVOKE_TIMEOUT_MS).catch(async (e) => {
    await fail('P4', `invoke(session:create) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (createFrame.ok !== true) {
    await fail('P4', `期望 ok:true，实际 ok=${String(createFrame.ok)}、error=${String(createFrame.error ?? '')}`);
  }
  const created = createFrame.result as Record<string, unknown> | null;
  if (!created || typeof created !== 'object' || typeof created.id !== 'string' || !created.id) {
    await fail('P4', `期望返回含 string id 的 Session 对象，实际 ${JSON.stringify(created).slice(0, 300)}`);
  }
  testSessionId = created!.id as string;
  // P9（upsert 项并入 P4）：捕获 sessions:changed {kind:'upsert', sessionId} 广播
  try {
    await socket.waitForEvent(
      CH.SESSIONS_CHANGED,
      (evArgs) => {
        const p = evArgs[0] as Record<string, unknown> | undefined;
        return !!p && p.kind === 'upsert' && p.sessionId === testSessionId;
      },
      EVENT_WAIT_TIMEOUT_MS,
      createStartIdx,
    );
  } catch (e) {
    await fail('P4', `未捕获 sessions:changed {kind:'upsert'} 广播（P9 并发断言）：${e instanceof Error ? e.message : String(e)}`);
  }
  pass('P4', `invoke(session:create) → Session(id=${testSessionId}) 且收到 sessions:changed(upsert) 广播（P9 upsert 项）`);

  // P5：chat:send 全链流式回合
  const turn1StartIdx = socket.eventIndex();
  const clientMessageId1 = crypto.randomUUID();
  const send1Frame = await socket.invoke(
    CH.CHAT_SEND,
    [testSessionId, { text: E2E_MESSAGE_TEXT, attachmentIds: [], clientMessageId: clientMessageId1 }],
    INVOKE_TIMEOUT_MS,
  ).catch(async (e) => {
    await fail('P5', `invoke(chat:send) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (send1Frame.ok !== true) {
    await fail('P5', `chat:send 被拒绝（CLI/环境不可用时如此）：${String(send1Frame.error ?? '')}`);
  }
  let terminal1: unknown[] | null = null;
  try {
    terminal1 = await socket.waitForEvent(
      CH.CHAT_EVENT,
      (evArgs) => {
        const env = asChatEnvelope(evArgs);
        return !!env && env.sessionId === testSessionId && (env.event?.type === 'result' || env.event?.type === 'aborted');
      },
      CHAT_TURN_TIMEOUT_MS,
      turn1StartIdx,
    );
  } catch (e) {
    const events = collectChatEvents(socket, turn1StartIdx, testSessionId!);
    await fail('P5', `回合终态事件等待失败：${e instanceof Error ? e.message : String(e)}。${collectTurnDiagnostics(events)}`);
  }
  const turn1Events = collectChatEvents(socket, turn1StartIdx, testSessionId!);
  const terminalType1 = String((asChatEnvelope(terminal1!)?.event as Record<string, unknown> | undefined)?.type);
  if (terminalType1 !== 'result') {
    await fail('P5', `期望终态 type:'result'，实际 type:'${terminalType1}'。${collectTurnDiagnostics(turn1Events)}`);
  }
  const resultEvent1 = turn1Events.find((e) => e.type === 'result') as Record<string, unknown> | undefined;
  if (resultEvent1 && resultEvent1.is_error === true) {
    await fail('P5', `回合 result.is_error=true（上游/CLI 失败）。${collectTurnDiagnostics(turn1Events)}`);
  }
  const streamDeltaCount = turn1Events.filter(
    (e) => e.type === 'stream_event' && (e.event as Record<string, unknown> | undefined)?.delta != null,
  ).length;
  const assistantMessageCount = turn1Events.filter((e) => e.type === 'message' && e.role === 'assistant').length;
  const resultCount = turn1Events.filter((e) => e.type === 'result').length;
  if (streamDeltaCount < 1) {
    await fail('P5', `期望 ≥1 条 stream_event 流式增量，实际 ${streamDeltaCount}。${collectTurnDiagnostics(turn1Events)}`);
  }
  if (assistantMessageCount < 1) {
    await fail('P5', `期望 ≥1 条 type:'message' 全量消息（assistant），实际 ${assistantMessageCount}。${collectTurnDiagnostics(turn1Events)}`);
  }
  if (resultCount < 1) {
    await fail('P5', `期望 1 条 type:'result'，实际 ${resultCount}。${collectTurnDiagnostics(turn1Events)}`);
  }
  const resultText = String(resultEvent1?.result ?? '');
  pass('P5', `chat:send 全链回合完成：stream_event 增量 ${streamDeltaCount} 条、message 全量 ${assistantMessageCount} 条、result 1 条（回复片段：${resultText.slice(0, 60)}）`);

  // P6：第二轮 send 后立刻 abort → aborted 或新 result
  const turn2StartIdx = socket.eventIndex();
  const clientMessageId2 = crypto.randomUUID();
  const send2Frame = await socket.invoke(
    CH.CHAT_SEND,
    [testSessionId, { text: E2E_MESSAGE_TEXT, attachmentIds: [], clientMessageId: clientMessageId2 }],
    INVOKE_TIMEOUT_MS,
  ).catch(async (e) => {
    await fail('P6', `第二轮 invoke(chat:send) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (send2Frame.ok !== true) {
    await fail('P6', `第二轮 chat:send 被拒绝：${String(send2Frame.error ?? '')}`);
  }
  const abortFrame = await socket.invoke(CH.CHAT_ABORT, [testSessionId], INVOKE_TIMEOUT_MS).catch(async (e) => {
    await fail('P6', `invoke(chat:abort) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (abortFrame.ok !== true) {
    await fail('P6', `chat:abort 期望 ok:true，实际 ok=${String(abortFrame.ok)}、error=${String(abortFrame.error ?? '')}`);
  }
  let terminal2: unknown[] | null = null;
  try {
    terminal2 = await socket.waitForEvent(
      CH.CHAT_EVENT,
      (evArgs) => {
        const env = asChatEnvelope(evArgs);
        return !!env && env.sessionId === testSessionId && (env.event?.type === 'result' || env.event?.type === 'aborted');
      },
      ABORT_TURN_TIMEOUT_MS,
      turn2StartIdx,
    );
  } catch (e) {
    const events = collectChatEvents(socket, turn2StartIdx, testSessionId!);
    await fail('P6', `中断回合终态等待失败：${e instanceof Error ? e.message : String(e)}。${collectTurnDiagnostics(events)}`);
  }
  const terminalType2 = String((asChatEnvelope(terminal2!)?.event as Record<string, unknown> | undefined)?.type);
  if (terminalType2 !== 'aborted' && terminalType2 !== 'result') {
    await fail('P6', `期望 type:'aborted' 或新 type:'result'，实际 type:'${terminalType2}'`);
  }
  pass('P6', `send 后立刻 chat:abort → 回合结束（终态 type:'${terminalType2}'）`);

  // P7：message:getBySession → user+assistant ≥3
  const msgFrame = await socket.invoke(CH.MESSAGE_GET_BY_SESSION, [testSessionId], INVOKE_TIMEOUT_MS).catch(async (e) => {
    await fail('P7', `invoke(message:getBySession) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (msgFrame.ok !== true || !Array.isArray(msgFrame.result)) {
    await fail('P7', `期望 ok:true 且 result 为数组，实际 ok=${String(msgFrame.ok)}、error=${String(msgFrame.error ?? '')}`);
  }
  const messages = msgFrame.result as Array<Record<string, unknown>>;
  const roleCount = (role: string) => messages.filter((m) => m.role === role).length;
  const userCount = roleCount('user');
  const assistantCount = roleCount('assistant');
  if (userCount + assistantCount < 3) {
    await fail('P7', `期望 user+assistant 消息合计 ≥3，实际 user=${userCount} assistant=${assistantCount}（总 ${messages.length} 条）`);
  }
  pass('P7', `invoke(message:getBySession) → user=${userCount} assistant=${assistantCount}（合计 ≥3，总 ${messages.length} 条）`);

  // P8：session:delete + sessions:changed(delete) 广播
  const deleteStartIdx = socket.eventIndex();
  const deleteFrame = await socket.invoke(CH.SESSION_DELETE, [testSessionId], INVOKE_TIMEOUT_MS).catch(async (e) => {
    await fail('P8', `invoke(session:delete) 失败：${e instanceof Error ? e.message : String(e)}`);
  }) as Frame;
  if (deleteFrame.ok !== true) {
    await fail('P8', `session:delete 期望 ok:true，实际 ok=${String(deleteFrame.ok)}、error=${String(deleteFrame.error ?? '')}`);
  }
  try {
    await socket.waitForEvent(
      CH.SESSIONS_CHANGED,
      (evArgs) => {
        const p = evArgs[0] as Record<string, unknown> | undefined;
        return !!p && p.kind === 'delete' && p.sessionId === testSessionId;
      },
      EVENT_WAIT_TIMEOUT_MS,
      deleteStartIdx,
    );
  } catch (e) {
    await fail('P8', `未捕获 sessions:changed {kind:'delete'} 广播：${e instanceof Error ? e.message : String(e)}`);
  }
  pass('P8', 'invoke(session:delete) → ok 且收到 sessions:changed(delete) 广播（测试会话已清理）');
  testSessionId = null; // 已删，cleanup 不再处理

  // P9：汇总（upsert 广播断言已并入 P4）
  pass('P9', '并发广播断言汇总：sessions:changed upsert（P4 已断言）+ delete（P8 已断言）均捕获');

  socket.close();
  mainSocket = null;
  printSummary();
  process.exit(0);
}

// 总超时兜底（防挂死）：300s 自杀 exit 1
const totalTimer = setTimeout(() => {
  void fail('P-', `总超时 ${TOTAL_TIMEOUT_MS}ms，脚本自杀退出（防挂死）`);
}, TOTAL_TIMEOUT_MS);
totalTimer.unref();

main().then(
  () => {
    /* main 内部自行 process.exit；此处兜底 */
    process.exit(0);
  },
  async (e) => {
    await fail('P-', `未预期异常：${e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e)}`);
  },
);
