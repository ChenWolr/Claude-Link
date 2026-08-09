// claude-code-command-e2e-verify.ts
// Claude Code 命令真实端到端验证（Task 3 起逐 Task 扩展）。
//
// 职责：用本地真实 claude.exe + D:\software\Cache\temp 隔离目录做真实 SDK 行为验证，断言磁盘
// 结果与事件终态，而不是只检查字符串包含。目前实现 --settings（Task 3）；后续 Task 追加：
//   --command /init|/compact（Task 4）、--init-matrix（Task 5）、--replacements（Task 6）、
//   --all（Task 7）。
//
// 门禁约定（与 claude-code-command-baseline.ts 一致）：
//   - 触发：--native 或 CLAUDE_LINK_RUN_NATIVE_E2E=1。
//   - 未触发：SKIP + exit 0。
//   - 触发但 claude.exe 缺失 → 中文前置条件错误 + exit 2。
//   - 触发且断言失败 → exit 1。
//   - 真实目录/配置一律位于 D:\software\Cache\temp，测试结束清理。
//
// 运行：CLAUDE_LINK_RUN_NATIVE_E2E=1 npx tsx scripts/claude-code-command-e2e-verify.ts --settings
import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

const RUN_NATIVE =
  process.argv.includes('--native') || process.env.CLAUDE_LINK_RUN_NATIVE_E2E === '1';
const TEMP_ROOT = 'D:/software/Cache/temp';
// demo 目标环境 executable（与 claude-code-command-baseline.ts 同源）。
const DEMO_EXE_PATH =
  'D:/software/Cache/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

// ── exe 解析（复刻 baseline 的最小版：显式 > demo > PATH(.cmd shim) > npm 全局）─────────
function isExe(p: string): boolean {
  if (!p) return false;
  return process.platform === 'win32' ? p.toLowerCase().endsWith('.exe') : true;
}

function resolveFromCmdShim(cmdPath: string): string | undefined {
  try {
    const text = readFileSync(cmdPath, 'utf8');
    const dir = path.dirname(cmdPath);
    const m = text.match(/"[^"]*?\.exe"|[\w./\\:-]+\.exe/i);
    if (!m) return undefined;
    let p = m[0]
      .replace(/"/g, '')
      .replace(/%dp0%/gi, dir + path.sep)
      .replace(/%~dp0/gi, dir + path.sep);
    if (!path.isAbsolute(p)) p = path.join(dir, p);
    p = path.normalize(p);
    return existsSync(p) && isExe(p) ? p : undefined;
  } catch {
    return undefined;
  }
}

function resolveClaudeExe(): string | null {
  const override = process.env.CLAUDE_LINK_CLAUDE_EXE;
  if (override && existsSync(override) && isExe(override)) return override;
  if (existsSync(DEMO_EXE_PATH) && isExe(DEMO_EXE_PATH)) return DEMO_EXE_PATH;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    if (process.platform === 'win32') {
      const direct = candidates.find((c) => isExe(c));
      if (direct) return direct;
      for (const c of candidates) {
        if (c.toLowerCase().endsWith('.cmd') || c.toLowerCase().endsWith('.bat')) {
          const exe = resolveFromCmdShim(c);
          if (exe) return exe;
        }
      }
    } else if (candidates[0]) {
      return candidates[0];
    }
  } catch {
    // not in PATH
  }
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(candidate) && isExe(candidate)) return candidate;
  } catch {
    // npm unavailable
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

// 在 cwd 跑一次本地命令 /usage，采集 init + 终态（零 API 花费、无需 key）。q 清理在 finally。
// env 可选：传入 USERPROFILE/HOME 覆盖时，真实 CLI 子进程以隔离用户主目录解析 user 级来源。
async function collectInitAndTermination(
  sdk: any,
  exe: string,
  cwd: string,
  env?: Record<string, string>,
): Promise<{ init: any; termination: { type: string; subtype?: string; isError?: boolean } }> {
  const q = sdk.query({
    prompt: '/usage',
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      permissionMode: 'plan',
      maxTurns: 1,
      ...(env ? { env } : {}),
    },
  });
  let init: any = null;
  let termination: { type: string; subtype?: string; isError?: boolean } = { type: 'none' };
  try {
    const consume = (async () => {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') init = msg;
        else if (msg.type === 'result') {
          termination = { type: 'result', subtype: msg.subtype, isError: msg.is_error };
          break;
        }
      }
    })();
    await withTimeout(consume, 25000, '等待 init/result');
  } catch {
    // 超时：保留已收到的 init；终态按不变量合成 aborted。
  } finally {
    try {
      q.close();
    } catch {
      // 已关闭。
    }
  }
  if (!init) throw new Error('未收到 system.init');
  if (termination.type === 'none') termination = { type: 'aborted' };
  return { init, termination };
}

// ── Task 4 真实 query harness：命令/普通文本共用 SDK query，保留原文与全部终态事件 ──
type NativeCommandEvent = {
  type: string;
  subtype?: string;
  content?: unknown;
  result?: unknown;
  is_error?: boolean;
  message?: string;
  // system:init 携带的 CLI 会话 id（/compact resume 复用，P2-1 warmup）。
  session_id?: string;
};

async function runNativeCommand(
  sdk: any,
  exe: string,
  cwd: string,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<{
  prompt: string;
  /** SDK for-await 产生的原始事件（不含 harness 合成）。取消/终态断言只查这里。 */
  events: NativeCommandEvent[];
  /** harness 合成事件（仅超时收尾的 aborted），与 SDK 原始事件分离，不计入通过条件（review-v2 P1-3）。 */
  syntheticEvents: NativeCommandEvent[];
  termination: NativeCommandEvent | null;
  init: NativeCommandEvent | null;
  /** SDK query 迭代抛错的原始消息（executable 缺失/cwd 不存在等启动失败），区分于超时。 */
  queryError: string | null;
  timedOut: boolean;
}> {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 90000;
  // Task 4 review P1-6：abortAfterMs 由调用方排除出 sdk options（SDK 不识别），用于测用户取消终态。
  const { timeoutMs: _ignoredTimeout, abortAfterMs: _ignoredAbort, ...sdkOptionOverrides } = options;
  const abortController = new AbortController();
  const q = sdk.query({
    prompt,
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      permissionMode: 'plan',
      maxTurns: 1,
      abortController,
      ...sdkOptionOverrides,
    },
  });
  const events: NativeCommandEvent[] = [];
  const syntheticEvents: NativeCommandEvent[] = [];
  let termination: NativeCommandEvent | null = null;
  let init: NativeCommandEvent | null = null;
  let queryError: string | null = null;
  let timedOut = false;
  // Task 4 review P1-6：可选 abortAfterMs——启动后定时 abort，测用户取消终态（aborted 复位 sending）。
  let abortTimer: ReturnType<typeof setTimeout> | undefined;
  if (typeof options.abortAfterMs === 'number' && options.abortAfterMs > 0) {
    abortTimer = setTimeout(() => {
      try { abortController.abort(); } catch { /* ignore */ }
    }, options.abortAfterMs);
  }
  // review-v2 P1-3：consume 内 catch SDK 迭代错误 → queryError，不混入 events/synthetic。
  // 这样 executable 缺失/cwd 不存在（SDK 抛 "native binary not found"/"failed to launch"）
  // 与超时（harness withTimeout 触发）严格分离，断言可区分启动失败 vs 超时 vs 真实终态。
  const consume = (async () => {
    try {
      for await (const msg of q) {
        const event = msg as NativeCommandEvent;
        events.push(event);
        if (event.type === 'system' && event.subtype === 'init') init = event;
        if (event.type === 'result') {
          termination = event;
          break;
        }
      }
    } catch (e) {
      queryError = e instanceof Error ? e.message : String(e);
    }
  })();
  try {
    await withTimeout(consume, timeoutMs, `${prompt} query`);
  } catch (error) {
    // 仅超时走此分支（SDK 错误已被 consume 内 catch，consume 正常 resolve）。
    timedOut = true;
    // review-v2 P1-3：合成 aborted 进 syntheticEvents，不进 events——取消断言只查 events/termination，
    // harness 合成不计入通过条件，防 SDK 未返回真实终态时被测试自身注入的 aborted 放宽。
    syntheticEvents.push({ type: 'aborted', message: error instanceof Error ? error.message : String(error) });
    try {
      abortController.abort();
    } catch {
      // ignore
    }
    try {
      await q.interrupt();
    } catch {
      // SDK may already be aborting.
    }
    // abort/interrupt 后 SDK 可能仍吐出真实终态事件（Windows 硬杀常丢，但若返回则是真实的，进 events）。
    await Promise.race([consume, new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    try {
      q.close();
    } catch {
      // SDK query 已关闭时无害。
    }
  }
  return { prompt, events, syntheticEvents, termination, init, queryError, timedOut };
}

// review-v3 P1-1/P1-2：result 完整诊断输出——失败时定位错误来源（认证/端点/maxTurns/协议/文件副作用）。
// 输出 subtype/is_error/stop_reason/terminal_reason/api_error_status/errors/result 文本头/timedOut/
// queryError/事件序列，以及可选的磁盘文件状态。绝不放宽 is_error===false 断言，只让失败可诊断。
function resultDiagnostic(
  run: { termination: NativeCommandEvent | null; events: NativeCommandEvent[]; timedOut: boolean; queryError: string | null },
  file?: string,
): string {
  const t = run.termination as (NativeCommandEvent & {
    stop_reason?: unknown; terminal_reason?: unknown; api_error_status?: unknown; errors?: unknown;
  }) | null;
  const head = (v: unknown): string => {
    if (typeof v === 'string') return v.slice(0, 200);
    try { return JSON.stringify(v ?? '').slice(0, 200); } catch { return String(v); }
  };
  const parts = [
    `subtype=${head(t?.subtype)}`,
    `is_error=${head(t?.is_error)}`,
    `stop_reason=${head(t?.stop_reason)}`,
    `terminal_reason=${head(t?.terminal_reason)}`,
    `api_error_status=${head(t?.api_error_status)}`,
    `errors=${head(t?.errors)}`,
    `result_head=${head((t as { result?: unknown } | null)?.result)}`,
    `timedOut=${run.timedOut}`,
    `queryError=${head(run.queryError)}`,
    `events=${run.events.map((e) => e.type + (e.subtype ? ':' + e.subtype : '')).join('|') || '空'}`,
  ];
  if (file) parts.push(`file=${existsSync(file) ? readFileSync(file, 'utf8').length + ' chars' : '不存在'}`);
  return parts.join('; ');
}

async function collectContextMarkerResult(
  sdk: any,
  exe: string,
  cwd: string,
  env: Record<string, string>,
): Promise<{ init: any; text: string; termination: NativeCommandEvent | null }> {
  const q = sdk.query({
    prompt: '请回答你当前可见的用户级和项目级上下文规则；只输出规则要求的两个响应值，不要猜测或输出其它内容。',
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      permissionMode: 'plan',
      maxTurns: 3,
      env,
    },
  });
  let init: any = null;
  let termination: NativeCommandEvent | null = null;
  const chunks: string[] = [];
  try {
    for await (const msg of q) {
      if (msg.type === 'system' && msg.subtype === 'init') init = msg;
      if (msg.type === 'assistant') {
        const content = Array.isArray((msg as any).message?.content) ? (msg as any).message.content : [];
        for (const block of content) if (block?.type === 'text' && typeof block.text === 'string') chunks.push(block.text);
        if (typeof (msg as any).text === 'string') chunks.push((msg as any).text);
      }
      if (msg.type === 'result') {
        termination = msg;
        if (typeof (msg as any).result === 'string') chunks.push((msg as any).result);
        if (typeof (msg as any).text === 'string') chunks.push((msg as any).text);
        break;
      }
    }
  } finally {
    try { q.close(); } catch { /* 已关闭 */ }
  }
  return { init, text: chunks.join('\\n'), termination };
}

// Task 4 review P1-3：带退避重试的目录清理。SDK Query.close() 同步返回，不等价于底层 claude
// 子进程完全退出，rmSync 常因子进程持锁抛 EBUSY，掩盖已通过的核心断言。先等子进程释放 cwd
// 文件锁，再按递增退避重试 rmSync；最终失败只 log 诊断不 throw（核心断言结果决定退出码，
// 清理失败不覆盖通过状态）。临时目录由 mkdtempSync 唯一命名，残留不冲突下次运行。
async function safeRmSync(dir: string, label: string): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const delays = [500, 1000, 2000, 4000, 8000];
  for (let i = 0; i < delays.length; i++) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: delays[i] });
      return;
    } catch (e) {
      if (i === delays.length - 1) {
        console.log(`  ⚠ 清理临时目录失败（不影响核心断言）：${label} ${dir} — ${(e as Error).message}`);
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delays[i]));
    }
  }
}

// Task 4 review P1-4：按 Claude Code/Agent SDK 真实凭据解析链检测 /init 所需凭据。
// 不只读 settings.json 的 ANTHROPIC_API_KEY——SDK 凭据优先级涵盖进程 env 的
// ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN + ~/.claude/settings.json env 块。任一可用即返回
// 合并 env 与来源说明；全无则 null（SKIP）。executable 缺失由入口 resolveClaudeExe 已处理
// （exit 2）；此处只区分「有凭据」与「无凭据」，不区分凭据是否有效（凭据存在但请求失败由
// /init 断言本身报告，不在此预先判定）。
function resolveInitCredentials(): { env: Record<string, string>; source: string } | null {
  const merged: Record<string, string> = {};
  const sources: string[] = [];
  const envKey = process.env.ANTHROPIC_API_KEY;
  const envToken = process.env.ANTHROPIC_AUTH_TOKEN;
  if (envKey) { merged.ANTHROPIC_API_KEY = envKey; sources.push('env:ANTHROPIC_API_KEY'); }
  if (envToken) { merged.ANTHROPIC_AUTH_TOKEN = envToken; sources.push('env:ANTHROPIC_AUTH_TOKEN'); }
  const home = process.env.HOME || process.env.USERPROFILE;
  if (home) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'));
      const envBlock = parsed?.env;
      if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
        for (const [k, v] of Object.entries(envBlock as Record<string, unknown>)) {
          if (typeof v !== 'string') continue;
          if ((k === 'ANTHROPIC_API_KEY' || k === 'ANTHROPIC_AUTH_TOKEN') && !merged[k]) {
            merged[k] = v;
            sources.push(`settings.json:${k}`);
          }
        }
      }
    } catch {
      // 本机无 settings.json 或解析失败：跳过该来源。
    }
  }
  if (Object.keys(merged).length === 0) return null;
  return { env: { ...process.env, ...merged } as Record<string, string>, source: sources.join(', ') };
}

async function runCommandMode(exe: string, prompts: string[]): Promise<void> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-command-'));
  let pass = 0;
  let fail = 0;
  const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${name} — ${(e as Error).message}`);
    }
  };
  try {
    // review P1-4：凭据检测覆盖 env + settings.json，/init、/compact、用户取消等调模型场景共用。
    const creds = resolveInitCredentials();
    if (prompts.includes('/init')) {
      const initCwd = path.join(root, 'init');
      mkdirSync(initCwd, { recursive: true });
      // /init 分析代码库生成 CLAUDE.md；空目录无内容可分析时模型不写文件（实测 bypassPermissions
      // + maxTurns:20 空目录仍不落盘）。放一个最小 README 让 /init 有真实内容可分析，验证命令执行
      // 入口的真实文件副作用。空目录不落盘是 Claude Code 真实行为，由 Task 5 矩阵记录为预期差异。
      writeFileSync(path.join(initCwd, 'README.md'), '# claude-link e2e\n\nA minimal project for /init end-to-end verification.\n', 'utf8');
      // /init 走模型 + Write 工具（非纯 local_command）：plan 模式下 Write 被拦成计划、maxTurns:1 不足，
      // 不会落盘 CLAUDE.md（实测 plan → result:error_max_turns，无文件）。必须用 bypassPermissions +
      // 真实凭据 + 足够 maxTurns 才能真正写文件。review-v4 已证实 20 turns 在仍有 tool_use 时会被
      // error_max_turns 截断；成功 fixture 使用显式 50 turns（有限预算）并保留 300s wall-clock 兜底。
      // 全无凭据时 SKIP——/init 需真实模型调用，不得用 plan 假成功冒充。
      if (!creds) {
        console.log('  SKIP /init 落盘验证：本机未检出 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN（env 或 ~/.claude/settings.json）；/init 需真实模型调用 + Write 权限，plan 模式只产计划不落盘');
      } else {
        await check(`/init 真实 query 创建非空 CLAUDE.md 并有成功终态（凭据：${creds.source}）`, async () => {
          // review-v2 P1-1：/init 实测耗时 ~106s（分析代码库 + Write），旧 180s 超时余量小，端点波动即
          // 超时注入合成 aborted 导致"必须返回 result"失败。调至 300s 给真实耗时足够余量；这不是放宽
          // 断言——result 终态仍强制要求，超时则 termination=null 断言 fail，并记录完整事件序列供诊断。
          const run = await runNativeCommand(sdk, exe, initCwd, '/init', {
            permissionMode: 'bypassPermissions',
            maxTurns: 50,
            env: creds.env,
            timeoutMs: 300000,
          });
          const file = path.join(initCwd, 'CLAUDE.md');
          // review-v2 P1-3：termination 是 SDK 真实 result（不含 harness 合成），强制要求成功终态。
          // 超时/启动失败 → termination=null，断言 fail（不放宽"必须有 result"）。
          assert.ok(run.termination, `/init 必须返回 result 终态（超时=${run.timedOut} 启动错误=${run.queryError ?? '无'}；事件序列=${run.events.map((e) => e.type + (e.subtype ? ':' + e.subtype : '')).join('|') || '空'}）`);
          assert.equal(run.termination?.is_error, false, `成功 /init 不得 is_error；诊断：${resultDiagnostic(run, file)}`);
          assert.ok(existsSync(file), '运行 /init 后必须存在 CLAUDE.md（bypassPermissions 下 Write 已执行）');
          assert.ok(readFileSync(file, 'utf8').trim().length > 0, 'CLAUDE.md 必须非空');
        });
      }
    }

    if (prompts.includes('/compact')) {
      // P2-1：/compact 压缩的是当前 CLI 会话上下文，空目录无上下文 → 仅返回 assistant+空 result，
      // 旧断言 typeof result==='string' 连空字符串都命中（过宽）。必须先 warmup 产生上下文
      //（拿 init.session_id），再 /compact resume 同一会话，断言可观测压缩证据。实测 glm-5.2
      // 端点 /compact 不返回 compact_boundary，但有上下文时返回 system:status（空目录无此事件），
      // 作为端点可观测的压缩状态证据；若端点均不返回则该断言失败，记录为需说明的差异。
      if (!creds) {
        console.log('  SKIP /compact 压缩证据验证：无凭据，/compact 需先 warmup 产生上下文再压缩（P2-1）');
      } else {
        const compactCwd = path.join(root, 'compact');
        mkdirSync(compactCwd, { recursive: true });
        await check('/compact 在有上下文时返回压缩证据（移除空 result 放宽，P2-1）', async () => {
          const warmup = await runNativeCommand(sdk, exe, compactCwd, '请详细解释 TypeScript 泛型与闭包，尽量详尽。', {
            permissionMode: 'bypassPermissions', maxTurns: 3, env: creds.env, timeoutMs: 120000,
          });
          const cliSid = warmup.init?.session_id;
          assert.ok(cliSid, 'warmup 须返回 system.init.session_id 供 /compact resume');
          const run = await runNativeCommand(sdk, exe, compactCwd, '/compact', {
            permissionMode: 'bypassPermissions', maxTurns: 5, env: creds.env, timeoutMs: 120000, resume: cliSid,
          });
          assert.ok(run.termination, '必须收到 /compact result 终态');
          assert.equal(run.termination?.is_error, false, `成功 /compact 不得 is_error；诊断：${resultDiagnostic(run)}`);
          // P2-1：必须有可观测压缩证据，不得只靠 result.result 字符串（空字符串也命中 typeof==='string'）。
          // 接受 compact_boundary（官方边界）/ 非空 local_command_output / system:status（端点压缩状态）。
          const hasBoundary = run.events.some((e) => e.subtype === 'compact_boundary');
          const hasLocalOutput = run.events.some(
            (e) => e.subtype === 'local_command_output' && typeof (e as any).content === 'string' && ((e as any).content as string).trim().length > 0,
          );
          const hasStatus = run.events.some((e) => e.type === 'system' && e.subtype === 'status');
          assert.ok(
            hasBoundary || hasLocalOutput || hasStatus,
            '/compact 须返回 compact_boundary/非空 local_command_output/system:status 作为压缩证据（P2-1：不得用空 result 放宽）；若端点均不返回，需记录为已知差异',
          );
        });
      }
    }

    if (!creds) {
      console.log('  SKIP 普通文本验证：无凭据，需调模型生成回答（验证原文透传 + 真实终态）');
    } else {
      await check('普通文本原样进入 query，不被自然语言前缀改写', async () => {
        const prompt = '请解释 /tmp 目录，保留双空格  与引号"';
        // review-v2 P1-3：须传 creds.env + 创建 cwd（否则无凭据/cwd 不存在 → SDK failed to launch，
        // 之前靠 harness synthetic aborted 掩盖）。
        const plainCwd = path.join(root, 'plain');
        mkdirSync(plainCwd, { recursive: true });
        // review-v4 P1-2：普通文本可能先请求工具；默认 maxTurns:1 会在 tool_use 后 error_max_turns。
        // 成功 fixture 显式给有限 10 turns，并由 120s wall-clock timeout 兜底；不继承 helper 默认值。
        const run = await runNativeCommand(sdk, exe, plainCwd, prompt, {
          maxTurns: 10,
          timeoutMs: 120000,
          env: creds.env,
        });
        // §1 核心：原文透传（无命令 prompt 翻译器改写）。
        assert.equal(run.prompt, prompt);
        // review-v4 P1-2：未安排 cancel 的成功场景必须获得真实 result + is_error=false。
        // SDK 原始 aborted 仅可用于取消场景，绝不能当作普通文本成功。
        assert.ok(run.termination, `普通文本必须返回真实 result 终态；诊断：${resultDiagnostic(run)}`);
        assert.equal(run.termination?.type, 'result', `普通文本终态必须为 result，不得以 aborted 当成功；诊断：${resultDiagnostic(run)}`);
        assert.equal(run.termination?.is_error, false, `普通文本 result 不得 is_error；诊断：${resultDiagnostic(run)}`);
      });
    }

    // Task 4 review P1-6：取消/启动失败/不可写目录/executable 缺失/权限拒绝真实 E2E 场景。
    // 错误/取消路径验证命令执行入口不伪造成功文件/结果；启动失败类（executable 缺失、cwd 不存在）
    // 不需凭据，取消与 plan /init 需调模型故在 creds 内。工作目录不可写在 Windows 上 chmod 不可靠，
    // 由「cwd 不存在」覆盖「工作目录无效」语义。
    // review-v2 P1-3：启动失败用 queryError（SDK 抛 "native binary not found"/"failed to launch"）
    // 或 timedOut 判定，不靠 harness 合成的 aborted（synthetic 已分离，events 可能空）。
    await check('executable 缺失 → 启动失败，不伪造成功 result', async () => {
      const run = await runNativeCommand(sdk, exe, path.join(root, 'noexe'), '/usage', {
        pathToClaudeCodeExecutable: 'D:/nonexistent/claude.exe', timeoutMs: 30000,
      });
      assert.ok(
        run.queryError || run.timedOut,
        `executable 缺失须启动失败（queryError=${run.queryError ?? '无'} timedOut=${run.timedOut}），不得返回成功 result`,
      );
      assert.ok(!run.termination || run.termination.is_error !== false, 'executable 缺失不得伪造成功 result（is_error=false）');
    });
    await check('cwd 不存在 → 启动失败，不伪造成功 result', async () => {
      const run = await runNativeCommand(sdk, exe, 'D:/nonexistent/cwd-xxx', '/usage', { timeoutMs: 30000 });
      assert.ok(
        run.queryError || run.timedOut,
        `cwd 不存在须启动失败（queryError=${run.queryError ?? '无'} timedOut=${run.timedOut}），不得返回成功 result`,
      );
      assert.ok(!run.termination || run.termination.is_error !== false, 'cwd 不存在不得伪造成功 result');
    });
    if (!creds) {
      console.log('  SKIP 用户取消/plan /init 验证：无凭据，需启动真实模型 query（P1-6）');
    } else {
      await check('用户取消（abort）→ 中断生效不卡死（P1-3：不靠 harness 合成；SDK 终态缺失记 Windows 已知差异）', async () => {
        // review-v2 P1-3：须创建 cwd（否则 SDK failed to launch，abortAfterMs 让 !timedOut 通过掩盖启动失败）。
        const abortCwd = path.join(root, 'abort');
        mkdirSync(abortCwd, { recursive: true });
        const run = await runNativeCommand(sdk, exe, abortCwd, '请详尽解释 TypeScript 类型系统，尽量长。', {
          permissionMode: 'bypassPermissions', maxTurns: 10, env: creds.env, timeoutMs: 30000, abortAfterMs: 5000,
        });
        // review-v2 P1-3：abort 后 query 须在超时内结束（中断生效，不卡死）——这是「明确的 query 终止状态」
        // （迭代器 resolve），不靠 harness syntheticEvents 放宽（合成 ${run.syntheticEvents.length} 条不计入）。
        // SDK 真实终态事件（aborted/result）在 Windows 硬杀下可能丢失（termination=null, events 无 aborted），
        // 记为已知差异：生产层由 killProcess 补发幂等 aborted（review-v1 P1-2 契约保证），e2e harness 只验证
        // SDK 层中断生效，不强求 SDK 返回终态事件（避免用 harness 合成冒充）。
        assert.ok(
          !run.timedOut,
          `abort 后 query 须在超时内结束（中断生效不卡死），实际 timedOut=${run.timedOut}；SDK 终态=${run.termination?.type ?? '无（Windows 硬杀已知差异，生产层 killProcess 补发 aborted）'}；harness 合成 ${run.syntheticEvents.length} 条不计入`,
        );
      });
      await check('plan 模式 /init → Write 被拦成计划，不落盘 CLAUDE.md（plan 模式行为，非用户 deny；真实 deny 见 canUseTool 测试 P1-4）', async () => {
        const planCwd = path.join(root, 'plan-init');
        mkdirSync(planCwd, { recursive: true });
        writeFileSync(path.join(planCwd, 'README.md'), '# plan init\n', 'utf8');
        const run = await runNativeCommand(sdk, exe, planCwd, '/init', {
          permissionMode: 'plan', maxTurns: 1, env: creds.env, timeoutMs: 60000,
        });
        assert.ok(!existsSync(path.join(planCwd, 'CLAUDE.md')), 'plan 模式 /init 不得落盘 CLAUDE.md（Write 被拦成计划）');
        assert.ok(run.termination, 'plan /init 须有终态');
        assert.ok(
          run.termination?.is_error === true || run.termination?.subtype === 'error_max_turns',
          'plan /init maxTurns:1 不足须 error_max_turns（is_error=true），不伪造成功',
        );
      });
      // Task 4 review-v2 P1-4：真实用户 deny 交互（非 plan 模式拦截）。注入 canUseTool hook 返回 deny，
      // 验证权限请求产生、query 终态是 result（模型收到拒绝后结束），与 abort 路径（aborted/无 result）分离。
      // plan 模式是「只规划不执行」，不是用户点击 deny；真实 deny 须走 canUseTool 返回 deny 语义。
      await check('用户 deny（canUseTool 返回 deny）→ 权限拒绝产生 result 终态，与 abort 路径分离（P1-4）', async () => {
        const denyCwd = path.join(root, 'deny');
        mkdirSync(denyCwd, { recursive: true });
        let denyCount = 0;
        const run = await runNativeCommand(sdk, exe, denyCwd, '请使用 Bash 工具运行命令 echo hello', {
          permissionMode: 'default',
          maxTurns: 5,
          env: creds.env,
          timeoutMs: 120000,
          canUseTool: async () => {
            denyCount++;
            return { behavior: 'deny', message: '用户拒绝了该工具调用' };
          },
        });
        assert.ok(
          denyCount > 0,
          `canUseTool 须被调用（权限请求产生），实际 denyCount=${denyCount}（模型可能未触发工具调用）`,
        );
        assert.ok(run.termination, 'deny 后 query 须有终态（模型收到拒绝后结束）');
        // deny 路径终态是 result（模型收到拒绝正常结束），与 abort 路径（aborted/无 result）区分。
        assert.equal(
          run.termination?.type,
          'result',
          `deny 终态应为 result（非 aborted），实际 ${run.termination?.type}；与 abort 路径区分`,
        );
      });
    }
  } finally {
    await safeRmSync(root, 'command');
  }
  console.log(`\\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`e2e --command 断言 ${fail} 项失败`);
}

// ── --settings（Task 3 Step 6）：原生 settings 来源 + user/project CLAUDE.md 进入上下文 ──
// review-v1 F4：建立隔离用户主目录（user/CLAUDE.md + ~/.claude/settings.json + ~/.claude/commands
// 用户命令），把 query 子进程与 resolveSettings 的 USERPROFILE/HOME 指向它；通过真实 query 的
// system.init.slash_commands 同时出现用户命令与项目命令（+ memory_paths 落在隔离 home）证明
// user/project 级联确实被 CLI 加载——CLAUDE.md 与该级联同源同级（同一 home / 同一 project 目录）。
async function runSettingsMode(exe: string): Promise<void> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const { resolveSettings } = sdk;
  assert.equal(typeof resolveSettings, 'function', 'SDK 应导出 resolveSettings');

  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-settings-'));
  const userHome = path.join(root, 'user');
  const project = path.join(root, 'project');
  const bare = path.join(root, 'bare');
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  let pass = 0;
  let fail = 0;
  // async 感知的 check：resolveSettings / collectInitAndTermination 均为 async，须 await 才能捕获断言错误。
  const check = async (name: string, fn: () => void | Promise<void>): Promise<void> => {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${name} — ${(e as Error).message}`);
    }
  };

  try {
    // ── 夹具：隔离用户主目录（review-v1 F4：user 层 + user/CLAUDE.md + 用户命令）──
    mkdirSync(path.join(userHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(userHome, '.claude', 'CLAUDE.md'), '# e2e user\n\n用户级 CLAUDE.md 夹具。\n当被要求回答上下文规则时，仅输出 USER_RULE_RESPONSE_7F31。\n', 'utf8');
    writeFileSync(
      path.join(userHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_LINK_E2E_USER: 'user' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(userHome, '.claude', 'commands', 'cl-user-verify.md'),
      '---\ndescription: E2E 用户级命令标记\n---\n这是用户命令发现夹具，不包含上下文规则响应值。\n',
      'utf8',
    );

    // ── 夹具：project 目录带 settings.json（project 层）+ settings.local.json（local 层）
    //    + CLAUDE.md + 项目命令（证明 project 级联被真实 query 加载）──
    mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ env: { CLAUDE_LINK_E2E_SOURCE: 'project' } }, null, 2), 'utf8');
    writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ env: { CLAUDE_LINK_E2E_SOURCE: 'local' } }, null, 2), 'utf8');
    writeFileSync(path.join(project, 'CLAUDE.md'), '# e2e project\n\n项目级 CLAUDE.md 夹具。\n当被要求回答项目上下文规则时，仅输出 PROJECT_RULE_RESPONSE_9C42。\n', 'utf8');
    writeFileSync(
      path.join(project, '.claude', 'commands', 'cl-project-verify.md'),
      '---\ndescription: E2E 项目级命令标记\n---\n这是项目命令发现夹具，不包含上下文规则响应值。\n',
      'utf8',
    );

    // 夹具 B：裸目录（无任何 project/local 文件），验证缺失层时仍能正常运行。
    mkdirSync(bare, { recursive: true });

    // 把进程级 USERPROFILE/HOME 指向隔离用户主目录：resolveSettings 与 query 子进程都以此解析
    // user 级来源（本机 os.homedir() 会重读环境变量；finally 恢复）。query 还额外显式传 env 兜底。
    process.env.USERPROFILE = userHome;
    process.env.HOME = userHome;
    const isolatedEnv = { ...process.env, USERPROFILE: userHome, HOME: userHome };

    console.log('=== --settings：原生 settings 来源 + user/project CLAUDE.md 进入上下文（Task 3 Step 6）===');
    await check('resolveSettings 看到 user(隔离 home) + project + local 来源', async () => {
      const rs: any = await resolveSettings({ cwd: project });
      const sources = (rs?.sources ?? []).map((s: any) => s.source);
      assert.ok(sources.includes('user'), `缺 user 来源，实际: ${sources.join(',')}`);
      assert.ok(sources.includes('project'), `缺 project 来源，实际: ${sources.join(',')}`);
      assert.ok(sources.includes('local'), `缺 local 来源，实际: ${sources.join(',')}`);
      const userSrc = (rs?.sources ?? []).find((s: any) => s.source === 'user');
      assert.ok(
        userSrc?.path &&
          path.normalize(userSrc.path).toLowerCase().startsWith(path.normalize(userHome).toLowerCase()),
        `user 来源路径应落在隔离 user home，实际: ${userSrc?.path ?? '?'}`,
      );
      assert.equal(rs?.effective?.env?.CLAUDE_LINK_E2E_SOURCE, 'local', 'local env 应覆盖 project env');
      assert.equal(rs?.provenance?.env?.source, 'local', 'effective env provenance 应指向 local');
    });
    await check('真实 query 同时加载隔离 user home 与 project（用户/项目命令进入 slash_commands）', async () => {
      const { init, termination } = await collectInitAndTermination(sdk, exe, project, isolatedEnv);
      const sc = Array.isArray(init.slash_commands) ? init.slash_commands : [];
      assert.ok(sc.includes('cl-user-verify'), `用户级命令 cl-user-verify 应进入 slash_commands，实际共 ${sc.length} 条`);
      assert.ok(sc.includes('cl-project-verify'), '项目级命令 cl-project-verify 应进入 slash_commands');
      // memory_paths.auto 落在隔离 user home → CLI 确实读取了该 home（含 user/CLAUDE.md 与用户命令的同源级联）
      const mpAuto =
        init.memory_paths && typeof init.memory_paths === 'object'
          ? String((init.memory_paths as Record<string, unknown>).auto ?? '')
          : '';
      assert.ok(
        mpAuto && path.normalize(mpAuto).toLowerCase().startsWith(path.normalize(userHome).toLowerCase()),
        `init.memory_paths.auto 应指向隔离 user home，实际: ${mpAuto || JSON.stringify(init.memory_paths ?? '')}`,
      );
      assert.equal(termination.type, 'result', `终态应为 result，实际 ${termination.type}`);
    });
    await check('CLAUDE.md 唯一标记实际进入 query 上下文并出现在 assistant 结果', async () => {
      const run = await collectContextMarkerResult(sdk, exe, project, isolatedEnv);
      assert.ok(run.termination, '上下文规则 query 必须有终态');
      const resultText = typeof (run.termination as any)?.result === 'string' ? (run.termination as any).result : run.text;
      assert.ok(resultText.includes('USER_RULE_RESPONSE_7F31'), `assistant 结果缺用户 CLAUDE.md 唯一响应：${resultText}`);
      assert.ok(resultText.includes('PROJECT_RULE_RESPONSE_9C42'), `assistant 结果缺项目 CLAUDE.md 唯一响应：${resultText}`);
    });
    await check('缺失 project/local 层时仍能正常运行（裸目录，user 层仍生效）', async () => {
      const rs: any = await resolveSettings({ cwd: bare });
      const sources = (rs?.sources ?? []).map((s: any) => s.source);
      assert.ok(sources.includes('user'), `user 来源应仍存在（隔离 home），实际: ${sources.join(',')}`);
      assert.ok(!sources.includes('project'), '裸目录不应有 project 来源');
      assert.ok(!sources.includes('local'), '裸目录不应有 local 来源');
      const { init, termination } = await collectInitAndTermination(sdk, exe, bare, isolatedEnv);
      assert.ok(Array.isArray(init.skills), '裸目录 query 仍应带 skills');
      assert.equal(termination.type, 'result', `裸目录终态应为 result，实际 ${termination.type}`);
    });
    await check('user/CLAUDE.md 与 project/CLAUDE.md 作为上下文内存候选存在且非空', () => {
      for (const [label, file] of [
        ['用户级', path.join(userHome, '.claude', 'CLAUDE.md')],
        ['项目级', path.join(project, 'CLAUDE.md')],
      ] as const) {
        assert.ok(existsSync(file), `${label} CLAUDE.md 应存在`);
        assert.ok(readFileSync(file, 'utf8').trim().length > 0, `${label} CLAUDE.md 应非空`);
      }
    });
  } finally {
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
    await safeRmSync(root, 'settings');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`e2e --settings 断言 ${fail} 项失败`);
}

// ── 入口 ───────────────────────────────────────────────────────────────────────────
void (async () => {
  if (!RUN_NATIVE) {
    console.log('SKIP: Claude Code native E2E 未触发（--native 或 CLAUDE_LINK_RUN_NATIVE_E2E=1）。');
    process.exit(0);
  }
  const exe = resolveClaudeExe();
  if (!exe) {
    console.error(
      '前置条件缺失：未找到本地 Claude Code 可执行文件（claude.exe）。\n' +
        '请先 npm install -g @anthropic-ai/claude-code，或设置 CLAUDE_LINK_CLAUDE_EXE。',
    );
    process.exit(2);
  }

  const args = process.argv.slice(2);
  // --native 是触发开关（与 CLAUDE_LINK_RUN_NATIVE_E2E=1 等价，供 npm 脚本跨平台使用），不是 mode；
  // mode 从其余 -- 参数取，避免 `--native --settings` 时把 --native 误判为 mode。
  const mode = args.find((a) => a.startsWith('--') && a !== '--native') ?? '--settings';
  try {
    if (mode === '--settings') {
      await runSettingsMode(exe);
    } else if (mode === '--command') {
      const prompts = args.filter((a) => a.startsWith('/'));
      await runCommandMode(exe, prompts.length > 0 ? prompts : ['/init']);
    } else {
      console.error(`e2e 模式 "${mode}" 尚未实现（Task 5/6/7 追加）。`);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    console.error(`e2e ${mode} 失败：`, (e as Error).message);
    process.exit(1);
  }
})().catch((e) => {
  console.error('e2e fatal:', e);
  process.exit(1);
});
