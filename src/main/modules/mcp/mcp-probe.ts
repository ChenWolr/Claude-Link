// mcp/mcp-probe.ts
// MCP 探活器（docs/plans/2026-10-12-mcp-management-plan.md §2 P6、§3.7/§3.11）。
// 职责：对单条 MCP 服务器定义（McpProbeInput，入参形状兼容 ParsedMcpEntry / McpManagedServer
// 的 transport/command/args/env/url/headers 侧）做一次「测试连接」：
//   - stdio：spawn 子进程，行缓冲 JSON-RPC 握手 initialize(id:1) → notifications/initialized
//     + tools/list(id:2)，以 result.tools.length 为工具数；
//   - http/sse：POST JSON-RPC 同款两步握手；initialize 响应头 mcp-session-id 存在时回传给
//     tools/list（B-5）；HTTP 4xx/5xx → fail，4xx 且 sse 时附「端点可能为 SSE 传输，
//     Claude Code 会自行协商」提示。
// 任何异常路径（进程秒退/spawn ENOENT/超时/stdout 非 JSON/HTTP 4xx 5xx/网络错误/fetch 不可用/
// 探活器自身 bug）一律收敛为 fail report（error 截断 200 字符），绝不抛出、绝不炸调用方（§3.7）。
// 结果内存缓存：key = mcpProbeKey（override 键空间同款：managed:<name> / user:<name> /
// project:<dirKey>:<name>）；「60s 内不重探」由调用方（IPC 层 P4 / UI）用 hasFreshCache 判定，
// 本模块不做时间驱动的自动重探。
//
// 纯 node 模块红线（P9 selftest 可直接 import 本文件跑在纯 node 下）：
//   不 import electron；仅用 node:child_process 内置与全局 fetch
//  （旧 node 无 fetch → fail report，不抛）。
//
// 本文件导出清单：
//   - McpProbeInput / McpProbeReport（类型）
//   - mcpProbeKey(scope, dirKey, name)              统一探活缓存键（与 override 键空间同款）
//   - resolveProbeTimeoutMs(entry?)                 探活生效超时解析（2026-10-19 点1：条目
//                                                   timeoutMs 合法整数 → min(v, 120000) 封顶；
//                                                   undefined/非法 → 默认 10000）
//   - probeMcpServer(input, timeoutMs?, cacheKey?)  单服务器探活；第 3 参可选——传入非空字符串时
//                                                   写入探活缓存并回填 report.key（供调用方持有
//                                                   正确键空间时使用；不传则只探不缓存，
//                                                   key 回填 managed 键空间的推导默认值）
//   - probeAllManaged(inputs, timeoutMs?)           管理库并发探活（Promise.allSettled，逐条
//                                                   以 managed:<name> 键写缓存；条目自带合法
//                                                   timeoutMs 时逐条生效——2026-10-19 点1）
//   - getCachedProbeReports() / hasFreshCache(key, maxAgeMs?) / pruneProbeCache(maxAgeMs?)
//                                                   缓存读取 / 新鲜判定 / 过期清理
//   - dropProbeCacheByPrefix(prefix)                按前缀删键（managedSave 落盘后调用，防旧定义结论残留）

import { spawn, type ChildProcess } from 'node:child_process';

// ── 契约类型（§2 P6）────────────────────────────────────────────────────────

/** 单条探活入参：字段与 ParsedMcpEntry / McpManagedServer 的连接侧字段同形（只读其子集）。 */
export interface McpProbeInput {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 探活超时覆盖（毫秒，2026-10-19 点1）：条目级可选；probeAllManaged 逐条经
   *  resolveProbeTimeoutMs 生效（非法/缺省回落批量参数或默认 10s）。不参与缓存键。 */
  timeoutMs?: number;
}

/** 单条探活结果：status ok 仅在完成两步 JSON-RPC 握手并取得 tools 时出现；probedAt 写入时间。 */
export interface McpProbeReport {
  key: string;
  status: 'ok' | 'fail';
  toolCount: number;
  error?: string;
  probedAt: number;
}

/** 探活器内部产物（补 key 前的形态）。 */
type ProbeOutcome = Omit<McpProbeReport, 'key'>;

/** 探活缓存键：与 override 键空间同款（managed:<name> / user:<name> / project:<dirKey>:<name>）。
 *  scope==='project' 且 dirKey 为 null → dirKey 以空串占位（project::<name>；调用方 P4 场景下
 *  project 条目恒有 dirKey，null 仅作防御性兜底，保持模板形态不抛错）。 */
export function mcpProbeKey(scope: 'managed' | 'user' | 'project', dirKey: string | null, name: string): string {
  if (scope === 'user') return `user:${name}`;
  if (scope === 'project') return `project:${dirKey ?? ''}:${name}`;
  return `managed:${name}`;
}

// ── 常量与小工具 ────────────────────────────────────────────────────────────

/** error 截断上限（§3.7：fail + error 截断 200 字符）。 */
const ERROR_TEXT_MAX = 200;
/** stderr 只留尾部（供「进程提前退出」错误附言），避免超长输出撑爆 report。 */
const STDERR_TAIL_MAX = 2000;
/** stdout 未完行剩余缓冲上限（B-4）：1MB——无换行持续输出在探活超时窗口内的内存上界，
 *  超限即 fail 不再无界累加；完整行已在判定前逐条切出处理，不计入本守卫（D3）。 */
const STDOUT_BUF_MAX = 1_000_000;
/** stdout 单行上限（B-4）：256KB——防超大单行 JSON.parse 的内存峰值。 */
const STDOUT_LINE_MAX = 262_144;
/** MCP initialize 握手参数（§2 P6 钉死值）。 */
const MCP_PROTOCOL_VERSION = '2025-06-18';
const PROBE_CLIENT_INFO = { name: 'claude-link-probe', version: '0.0.0' } as const;

/** Windows 下必须经 cmd.exe 包裹的裸命令名（无扩展名；§3.11——npx 等在 Windows 是 .cmd 垫片，
 *  CreateProcess 不解析 PATHEXT，直接 spawn 必 ENOENT）。 */
const STDIO_SHELL_WRAP_BASENAMES = new Set(['npx', 'npm', 'uvx', 'pnpm', 'yarn']);
/** 「Node 运行时族」裸命令名：spawn ENOENT 时 error 文案改为「未检测到 Node.js…」（§3.11）。 */
const NODE_RUNTIME_BASENAMES = new Set(['node', 'npm', 'npx', 'uvx', 'pnpm', 'yarn']);

function truncateError(text: string): string {
  return text.length > ERROR_TEXT_MAX ? text.slice(0, ERROR_TEXT_MAX) : text;
}

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** 取 command 的 basename（容忍 / 与 \ 分隔；Windows 两式都常见）。 */
function basenameOfCommand(command: string): string {
  return command.split(/[\\/]/).pop() ?? command;
}

/**
 * stdio spawn 规格解析（§3.11 Windows 包裹，openhanako resolveMcpStdioSpawnSpec 模式）：
 * win32 且（basename 以 .cmd/.bat 结尾（大小写不敏感）或 basename 为 npx/npm/uvx/pnpm/yarn
 * 且无扩展名）→ cmd.exe /d /s /c 包裹；其余原样直 spawn。
 */
function resolveStdioSpawnSpec(command: string, args: string[] | undefined): { file: string; args: string[] } {
  if (process.platform !== 'win32') return { file: command, args: args ?? [] };
  const base = basenameOfCommand(command);
  const lower = base.toLowerCase();
  const endsWithWinScript = lower.endsWith('.cmd') || lower.endsWith('.bat');
  const extlessWrapCandidate = !base.includes('.') && STDIO_SHELL_WRAP_BASENAMES.has(lower);
  if (endsWithWinScript || extlessWrapCandidate) {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', command, ...(args ?? [])] };
  }
  return { file: command, args: args ?? [] };
}

/** spawn ENOENT 的 error 文案：Node 运行时族缺失 → §3.11 文案；其余 → 通用「命令不存在」。 */
function enoentErrorText(command: string): string {
  const base = basenameOfCommand(command).toLowerCase().replace(/\.(exe|cmd|bat)$/, '');
  if (NODE_RUNTIME_BASENAMES.has(base)) return `未检测到 Node.js 或命令不在 PATH：${command}`;
  return `命令不存在或无法执行（ENOENT）：${command}；请检查命令名与 PATH`;
}

/** 结束必杀：Windows 用 taskkill /pid <pid> /T /F（连带 cmd.exe 包裹层与孙进程），其余 kill()；
 *  已退出（exitCode/signalCode 非 null）则跳过。清理尽力而为，不抛。 */
function killProbeChild(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return; // 已退出 → 跳过
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      /* 清理失败不影响探活结论 */
    }
  } else {
    try {
      child.kill();
    } catch {
      /* 已死/已退出：忽略 */
    }
  }
}

/** JSON-RPC 请求/通知构造（stdio 与 http 两路共用同一报文形状）。 */
function initializeRequest(): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: PROBE_CLIENT_INFO },
  };
}
function initializedNotification(): Record<string, unknown> {
  return { jsonrpc: '2.0', method: 'notifications/initialized' };
}
function toolsListRequest(): Record<string, unknown> {
  return { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
}

/** 提取 result.tools.length（缺 tools/非数组 → 0，不抛）。 */
function extractToolCount(msg: unknown): number {
  const tools = (msg as { result?: { tools?: unknown } } | null)?.result?.tools;
  return Array.isArray(tools) ? tools.length : 0;
}

/** JSON-RPC error 对象 → 文案（无 error 字段返回 null）。 */
function rpcErrorMessage(msg: unknown): string | null {
  const err = (msg as { error?: { message?: unknown } } | null)?.error;
  if (err !== undefined && err !== null) {
    const text = typeof err.message === 'string' && err.message !== '' ? err.message : JSON.stringify(err);
    return `JSON-RPC 错误：${text}`;
  }
  return null;
}

/** 判定 msg 是不是指定 id 的响应（通知无 id → 不匹配）。 */
function isResponseForId(msg: unknown, id: 1 | 2): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { id?: unknown }).id === id;
}

// ── stdio 探活（行缓冲 JSON-RPC）───────────────────────────────────────────

/**
 * stdio 探活主体：spawn → 发 initialize(id:1) → 收 id:1 响应 → 发 notifications/initialized +
 * tools/list(id:2) → 收 id:2 响应 → ok + toolCount。
 * fail 路径：spawn ENOENT / 总超时 / 进程提前退出（附 stderr 尾部）/ stdout 行非 JSON /
 * stdout 输出超限（B-4：未完行剩余缓冲 >1MB 或单行 >256KB）/ 响应带 error 字段。
 * stderr 仅记录不判死（很多真实服务器往 stderr 打日志）。
 */
function probeStdioServer(input: McpProbeInput, timeoutMs: number): Promise<ProbeOutcome> {
  return new Promise((resolve) => {
    const command = input.command ?? '';
    if (command === '') {
      resolve({ status: 'fail', toolCount: 0, error: 'stdio 服务器缺少必填 command', probedAt: Date.now() });
      return;
    }

    const spec = resolveStdioSpawnSpec(command, input.args);
    let child: ChildProcess;
    try {
      child = spawn(spec.file, spec.args, {
        env: { ...process.env, ...input.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      resolve({ status: 'fail', toolCount: 0, error: truncateError(`进程启动失败：${errMessage(e)}`), probedAt: Date.now() });
      return;
    }

    let settled = false;
    let stdoutBuf = '';
    let stderrTail = '';
    let pendingId: 1 | 2 = 1;
    let timer: ReturnType<typeof setTimeout>;

    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderrData);
      killProbeChild(child);
      resolve(outcome);
    };

    timer = setTimeout(() => {
      finish({
        status: 'fail',
        toolCount: 0,
        error: `探活超时（${timeoutMs}ms）：未在时限内完成 initialize + tools/list 握手`,
        probedAt: Date.now(),
      });
    }, timeoutMs);

    /** 单行 JSON-RPC 处理：id:1 响应 → 发 initialized 通知 + tools/list；id:2 响应 → 收官。 */
    const handleRpcMessage = (msg: unknown): void => {
      if (!isResponseForId(msg, pendingId)) return; // 通知/非当前等待响应 → 忽略，继续等
      const rpcErr = rpcErrorMessage(msg);
      if (rpcErr !== null) {
        finish({
          status: 'fail',
          toolCount: 0,
          error: truncateError(pendingId === 1 ? `initialize 失败：${rpcErr}` : `tools/list 失败：${rpcErr}`),
          probedAt: Date.now(),
        });
        return;
      }
      if (pendingId === 1) {
        pendingId = 2;
        try {
          child.stdin?.write(JSON.stringify(initializedNotification()) + '\n');
          child.stdin?.write(JSON.stringify(toolsListRequest()) + '\n');
        } catch (e) {
          finish({ status: 'fail', toolCount: 0, error: truncateError(`写入 stdin 失败：${errMessage(e)}`), probedAt: Date.now() });
        }
        return;
      }
      finish({ status: 'ok', toolCount: extractToolCount(msg), probedAt: Date.now() });
    };

    const onStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf8');
      let idx = stdoutBuf.indexOf('\n');
      while (idx >= 0) {
        const line = stdoutBuf.slice(0, idx).replace(/\r$/, '').trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (line.length > STDOUT_LINE_MAX) {
          // B-4 防御：单行超限不进 JSON.parse，避免内存峰值。
          finish({
            status: 'fail',
            toolCount: 0,
            error: truncateError('单行响应超限（>256KB）'),
            probedAt: Date.now(),
          });
          return;
        }
        if (line !== '') {
          let msg: unknown;
          try {
            msg = JSON.parse(line);
          } catch {
            finish({
              status: 'fail',
              toolCount: 0,
              error: truncateError(`stdout 输出非 JSON：${line}`),
              probedAt: Date.now(),
            });
            return;
          }
          handleRpcMessage(msg);
          if (settled) return;
        }
        idx = stdoutBuf.indexOf('\n');
      }
      if (stdoutBuf.length > STDOUT_BUF_MAX) {
        // B-4 防御（D3 移位）：总量守卫只对「无换行收尾的剩余缓冲」负责——无换行的持续输出
        // 在超时窗口内最多堆积 1MB，超限即 fail（finish 内已 off('data') 停累积 + settled
        // 防重复收官）。完整行洪水不经此路径：非 JSON 行在首次出现即 fail（既有行为），
        // 合法响应按完整行逐条切出、单行 ≤256KB 各自处理，不再被总量误杀。
        finish({
          status: 'fail',
          toolCount: 0,
          error: truncateError('stdout 输出超限（>1MB），疑似非 MCP 服务器命令'),
          probedAt: Date.now(),
        });
        return;
      }
    };

    const onStderrData = (chunk: Buffer): void => {
      // 仅记录不判死；留尾部供「进程提前退出」附言。
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-STDERR_TAIL_MAX);
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderrData);
    child.on('error', (e: NodeJS.ErrnoException) => {
      // spawn 失败（ENOENT=命令不存在 / PATH 缺 node），PID 多半未起 → finish 内杀进程自然跳过。
      finish({
        status: 'fail',
        toolCount: 0,
        error: e.code === 'ENOENT' ? enoentErrorText(command) : truncateError(`进程启动失败：${errMessage(e)}`),
        probedAt: Date.now(),
      });
    });
    child.on('close', (code, signal) => {
      if (settled) return; // 已按响应/超时/错误收官 → close 只是善后
      const tail = stderrTail.trim();
      const detail = tail !== '' ? `；stderr 尾部：${tail}` : '';
      finish({
        status: 'fail',
        toolCount: 0,
        error: truncateError(`进程提前退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）${detail}`),
        probedAt: Date.now(),
      });
    });

    // 握手第一步：发 initialize(id:1)。
    try {
      child.stdin?.write(JSON.stringify(initializeRequest()) + '\n');
    } catch (e) {
      finish({ status: 'fail', toolCount: 0, error: truncateError(`写入 stdin 失败：${errMessage(e)}`), probedAt: Date.now() });
    }
  });
}

// ── http/sse 探活（POST JSON-RPC）──────────────────────────────────────────

/** 响应体 → JSON（非 JSON/读体失败 → ok:false + 中文错误）。 */
async function parseJsonBody(res: globalThis.Response): Promise<{ ok: true; msg: unknown } | { ok: false; error: string }> {
  let text: string;
  try {
    text = await res.text();
  } catch (e) {
    return { ok: false, error: `读取响应体失败：${errMessage(e)}` };
  }
  try {
    return { ok: true, msg: JSON.parse(text) };
  } catch {
    return { ok: false, error: truncateError(`响应非 JSON：${text}`) };
  }
}

/** HTTP 非 2xx 的 fail 文案；4xx 且 sse → 附「端点可能为 SSE 传输」提示（§2 P6）。 */
function httpStatusFail(status: number, statusText: string, transport: 'http' | 'sse', step: string): ProbeOutcome {
  let error = `${step}请求失败：HTTP ${status}${statusText !== '' ? ` ${statusText}` : ''}`;
  if (status >= 400 && status < 500 && transport === 'sse') {
    error += '（端点可能为 SSE 传输，Claude Code 会自行协商）';
  }
  return { status: 'fail', toolCount: 0, error: truncateError(error), probedAt: Date.now() };
}

/**
 * http/sse 探活主体：POST initialize(id:1) → 2xx 解析 JSON → POST tools/list(id:2) → 解析 →
 * ok + toolCount。总超时 = timeoutMs（双请求共享一个 AbortController）；网络异常/abort → fail。
 */
async function probeHttpServer(input: McpProbeInput, timeoutMs: number): Promise<ProbeOutcome> {
  const url = input.url ?? '';
  if (url === '') {
    return { status: 'fail', toolCount: 0, error: 'http/sse 服务器缺少必填 url', probedAt: Date.now() };
  }
  if (typeof globalThis.fetch !== 'function') {
    // 旧 node 无全局 fetch（§3.7：fetch 不可用 → fail report 不抛）。
    return { status: 'fail', toolCount: 0, error: '当前运行时不支持 fetch，无法探活远程 MCP 服务器', probedAt: Date.now() };
  }

  const probedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const postJson = (body: unknown, extraHeaders?: Record<string, string>): Promise<Response> =>
    fetch(input.url as string, {
      method: 'POST',
      // D4：extraHeaders（服务器签发的 mcp-session-id）有意后置——同名时覆盖用户自定义值，
      // 会话延续须遵从服务器对本会话的新签发；如需用户优先须产品决策另立。
      headers: { 'content-type': 'application/json', ...(input.headers ?? {}), ...(extraHeaders ?? {}) },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

  try {
    const initRes = await postJson(initializeRequest());
    if (!initRes.ok) return httpStatusFail(initRes.status, initRes.statusText, input.transport === 'sse' ? 'sse' : 'http', 'initialize ');
    const initParsed = await parseJsonBody(initRes);
    if (!initParsed.ok) return { status: 'fail', toolCount: 0, error: `initialize ${initParsed.error}`, probedAt };
    const initErr = rpcErrorMessage(initParsed.msg);
    if (initErr !== null) return { status: 'fail', toolCount: 0, error: truncateError(`initialize 失败：${initErr}`), probedAt };

    // B-5：Streamable HTTP 会话延续——initialize 响应头若带 mcp-session-id，第二步 tools/list
    // 原样回传（严格服务器缺此头会 404）；sid 为 null/空串则不传头（宽松服务器忽略多余头，无副作用）。
    // D4：sid 与用户自定义头同名时，服务器签发值有意优先（postJson 展开序 input.headers →
    // extraHeaders）——会话延续须遵从服务器对本会话的新签发；如需用户优先须产品决策另立。
    const sid = initRes.headers.get('mcp-session-id'); // Headers.get 大小写不敏感
    const toolsRes = await postJson(toolsListRequest(), sid ? { 'mcp-session-id': sid } : undefined);
    if (!toolsRes.ok) return httpStatusFail(toolsRes.status, toolsRes.statusText, input.transport === 'sse' ? 'sse' : 'http', 'tools/list ');
    const toolsParsed = await parseJsonBody(toolsRes);
    if (!toolsParsed.ok) return { status: 'fail', toolCount: 0, error: `tools/list ${toolsParsed.error}`, probedAt };
    const toolsErr = rpcErrorMessage(toolsParsed.msg);
    if (toolsErr !== null) return { status: 'fail', toolCount: 0, error: truncateError(`tools/list 失败：${toolsErr}`), probedAt };

    return { status: 'ok', toolCount: extractToolCount(toolsParsed.msg), probedAt };
  } catch (e) {
    const err = e as Error & { code?: string };
    const aborted = err?.name === 'AbortError' || err?.code === 'ABORT_ERR';
    return {
      status: 'fail',
      toolCount: 0,
      error: truncateError(aborted ? `探活超时（${timeoutMs}ms）` : `网络请求失败：${errMessage(e)}`),
      probedAt,
    };
  } finally {
    clearTimeout(timer);
  }
}

// ── 对外入口（整体 try/catch 兜底 + 缓存）──────────────────────────────────

/**
 * 探活生效超时解析（2026-10-19 mcp-settings-plan-a 点1）：条目 timeoutMs 为合法整数
 *（Number.isInteger 且 >=1）→ Math.min(v, 120000)（超配封顶 120s 防呆）；undefined / 缺字段 /
 * 非法（0/负/小数/字符串/null）→ 默认 10000。与配置侧 mcp-config.isValidMcpTimeoutMs（1..120000
 * 之外静默丢字段）分工：配置侧管落库合法性，本函数管运行时生效值（宁可封顶执行，不丢探活）。
 */
export function resolveProbeTimeoutMs(entry?: { timeoutMs?: unknown }): number {
  const v = entry?.timeoutMs;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 1) return Math.min(v, 120_000);
  return 10_000;
}

/**
 * 单服务器探活（§2 P6）：整体 try/catch，任何未预期异常 → fail report（绝不炸调用方，§3.7）。
 * cacheKey 传入非空字符串 → report.key = cacheKey 并写入探活缓存（供「测试连接」等需要缓存
 * 最近值的调用方）；不传 → 只探不缓存，key 回填 managed 键空间推导值（仅作关联用途）。
 * 生效超时（2026-10-19 点1）：Math.min(timeoutMs ?? 10000, 120000)——入参为「生效值」，此处仅对
 * 超配/缺省统一兜底封顶（resolveProbeTimeoutMs 同语义）；不传沿用既有默认 10s，行为不变。
 */
export async function probeMcpServer(input: McpProbeInput, timeoutMs = 10_000, cacheKey?: string): Promise<McpProbeReport> {
  const effectiveTimeoutMs = Math.min(timeoutMs ?? 10_000, 120_000);
  let outcome: ProbeOutcome;
  try {
    outcome =
      input.transport === 'stdio'
        ? await probeStdioServer(input, effectiveTimeoutMs)
        : await probeHttpServer(input, effectiveTimeoutMs);
  } catch (e) {
    outcome = { status: 'fail', toolCount: 0, error: truncateError(`探活器内部异常：${errMessage(e)}`), probedAt: Date.now() };
  }
  const hasCacheKey = typeof cacheKey === 'string' && cacheKey !== '';
  const key = hasCacheKey ? (cacheKey as string) : mcpProbeKey('managed', null, input.name);
  const report: McpProbeReport = { key, status: outcome.status, toolCount: outcome.toolCount, probedAt: outcome.probedAt };
  if (outcome.error !== undefined) report.error = outcome.error;
  if (hasCacheKey) probeCache.set(key, report);
  return report;
}

/**
 * 管理库并发探活（§2 P6）：Promise.allSettled 并发，逐条以 managed:<name> 键写缓存；
 * 某条若意外 rejected（probeMcpServer 自身已兜底，此处为防御性第二道）→ 该条 fail report。
 * per-entry 超时（2026-10-19 点1）：条目自带合法 timeoutMs（>=1 整数）→ 以 resolveProbeTimeoutMs
 * 逐条生效（封顶在 probeMcpServer 内统一执行）；未带/非法 → 沿用批量参数 timeoutMs（缺省
 * undefined → probeMcpServer 默认 10s，既有行为不变）。缓存键不变：mcpProbeKey 同台同键，
 * 超时差异不参与新鲜判定（60s 缓存语义维持）。
 */
export async function probeAllManaged(inputs: McpProbeInput[], timeoutMs?: number): Promise<McpProbeReport[]> {
  const settled = await Promise.allSettled(
    inputs.map((input) => {
      const hasOwnTimeout = typeof input.timeoutMs === 'number' && Number.isInteger(input.timeoutMs) && input.timeoutMs >= 1;
      const effective = hasOwnTimeout ? resolveProbeTimeoutMs(input) : timeoutMs;
      return probeMcpServer(input, effective, mcpProbeKey('managed', null, input.name));
    }),
  );
  return settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    return {
      key: mcpProbeKey('managed', null, inputs[i]?.name ?? ''),
      status: 'fail' as const,
      toolCount: 0,
      error: truncateError(`探活器内部异常：${errMessage(r.reason)}`),
      probedAt: Date.now(),
    };
  });
}

// ── 探活结果内存缓存（60s 内不重探由调用方判定）────────────────────────────

const probeCache = new Map<string, McpProbeReport>();

/** 全部最近一次探活值（P4 snapshot/all 场景附带回显用）。 */
export function getCachedProbeReports(): McpProbeReport[] {
  return Array.from(probeCache.values());
}

/** 新鲜判定：key 有缓存且距 probedAt 不足 maxAgeMs（默认 60s）→ true（调用方免重探）。 */
export function hasFreshCache(key: string, maxAgeMs = 60_000): boolean {
  const hit = probeCache.get(key);
  if (!hit) return false;
  return Date.now() - hit.probedAt < maxAgeMs;
}

/** 过期清理：删除距 probedAt 已满 maxAgeMs（默认 60s）的条目。 */
export function pruneProbeCache(maxAgeMs = 60_000): void {
  const now = Date.now();
  for (const [key, report] of probeCache) {
    if (now - report.probedAt >= maxAgeMs) probeCache.delete(key);
  }
}

/** 按前缀删除探活缓存键（managedSave 落盘后调用，防旧定义结论残留）。
 *  只删命中前缀的键：'managed:' 不影响 user:/project: 键（B-21 留空间）。 */
export function dropProbeCacheByPrefix(prefix: string): void {
  for (const k of probeCache.keys()) if (k.startsWith(prefix)) probeCache.delete(k);
}
