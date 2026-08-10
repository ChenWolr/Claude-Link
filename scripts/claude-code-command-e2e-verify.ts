// claude-code-command-e2e-verify.ts
// Claude Code 命令真实端到端验证（Task 3 起逐 Task 扩展）。
//
// 职责：用本地真实 claude.exe + D:\software\Cache\temp 隔离目录做真实 SDK 行为验证，断言磁盘
// 结果与事件终态，而不是只检查字符串包含。目前实现 --settings（Task 3）、--command（Task 4）、
// --init-matrix（Task 5）；后续 Task 追加：--replacements（Task 6）、--all（Task 7）。
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
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
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
  /** review-v4：grace 后仍无真实终态才硬 abort 兜底；result 断言不依赖它。 */
  forcedAbort: boolean;
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
  // review-v4：grace 后仍无真实终态才置 true（硬 abort 兜底）。
  let forcedAbort = false;
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
    // review-v4 P1-1：不立即 abort——abort 触发 SDK close 路径会压制 CLI 流末真实 result
    //（有内容目录已写 CLAUDE.md 却无 result 即此症状）。先请求软中断，给有界 grace 继续消费
    // 等真实 result/aborted；grace 内收到真实终态则 termination 更新（result 断言照常），
    // grace 仍无终态才硬 abort 兜底。result 强断言不变。
    try {
      await q.interrupt();
    } catch {
      // interrupt 仅 streaming-input 可靠；非流式 prompt 可能无效，grace 兜底。
    }
    // graceAfterTimeoutMs：显式 0 = 无 grace（测合成 aborted，⑪场景）；未传 = 默认 60s 等 SDK 真实 result。
    const graceMs = typeof options.graceAfterTimeoutMs === 'number'
      ? options.graceAfterTimeoutMs
      : 60000;
    if (graceMs > 0) {
      await Promise.race([consume, new Promise<void>((resolve) => setTimeout(resolve, graceMs))]);
    }
    if (!termination) {
      forcedAbort = true;
      try {
        abortController.abort();
      } catch {
        // ignore
      }
    }
  } finally {
    if (abortTimer) clearTimeout(abortTimer);
    try {
      q.close();
    } catch {
      // SDK query 已关闭时无害。
    }
  }
  return { prompt, events, syntheticEvents, termination, init, queryError, timedOut, forcedAbort };
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
    // review P1-1：prompt 不泄漏具体标记值，只要求「所有规则要求的标记都出现」。
    // 两条 CLAUDE.md 协议协调为「各包含自己的标记」（非「仅输出」互斥），一次 query 即可稳定证明两层同时加载。
    prompt: '请回答你当前可见的上下文规则所要求的响应标记；所有规则要求的标记都需在回答中出现，不要猜测或输出标记以外的内容。',
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
  // review：必须带 wall-clock 兜底（与 runNativeCommand 同款）。否则端点既不返回 result 也不抛错时，
  // for-await 永不 resolve，--init-matrix ④⑤ / --settings 标记查询会让整条 native 门禁无限挂起。
  try {
    const consume = (async () => {
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
    })();
    await withTimeout(consume, 120000, '上下文标记 query');
  } catch {
    // 超时：保留已收到内容；终止态为 null（上层断言以此区分「无终态」）。
    try {
      q.close();
    } catch {
      // ignore
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
          // review-v2 P1-1 + review-v4 P1-1：/init 多 turn 工作流，harness wall-clock 必须 > CLI 单请求
          // API_TIMEOUT_MS（review-v4 根因：两者同值导致外层先触发，abort 压制真实 result）。用
          // harnessInitDeadlineMs 解耦——result 终态仍强制要求，超时则 termination=null 断言 fail。
          const run = await runNativeCommand(sdk, exe, initCwd, '/init', {
            permissionMode: 'bypassPermissions',
            maxTurns: 50,
            env: creds.env,
            timeoutMs: harnessInitDeadlineMs(creds),
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
      // review-v3 P1：用户拒绝 /init 的 Write 工具（canUseTool deny Write，区别于 plan 模式自动拦截）。
      // 验证 SDK 行为：/init + deny Write → 不落盘 CLAUDE.md + result 非成功（保留 deny 语义）。
      // 产品层（runQuery）对这种 is_error=true 的未写入回合也发 init_write_skipped（review-v3 P1 解耦）。
      await check('/init 用户 deny Write → deny 生效不落盘 CLAUDE.md（保留 deny 语义，不伪造写入）', async () => {
        const denyInitCwd = path.join(root, 'deny-init');
        mkdirSync(denyInitCwd, { recursive: true });
        writeFileSync(path.join(denyInitCwd, 'README.md'), '# deny init\n\nProject for /init with Write denied.\n', 'utf8');
        let writeDenied = 0;
        const run = await runNativeCommand(sdk, exe, denyInitCwd, '/init', {
          permissionMode: 'default',
          maxTurns: 20,
          env: creds.env,
          timeoutMs: 180000,
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            // 仅拒绝 Write（/init 写 CLAUDE.md 的工具），其他工具放行让其分析代码库。
            if (toolName === 'Write') {
              writeDenied++;
              return { behavior: 'deny', message: '用户拒绝了 CLAUDE.md 写入' };
            }
            return { behavior: 'allow', updatedInput: input };
          },
        });
        assert.ok(
          writeDenied > 0,
          `canUseTool 须对 Write 触发 deny（/init 调用了 Write），实际 writeDenied=${writeDenied}`,
        );
        // 核心：deny Write 后不落盘 CLAUDE.md（保留 deny 语义，不伪造文件写入成功）。
        assert.ok(!existsSync(path.join(denyInitCwd, 'CLAUDE.md')), 'deny Write 后不得落盘 CLAUDE.md');
        assert.ok(
          run.termination,
          `deny Write /init 须有终态（回合结束）；诊断：${resultDiagnostic(run, path.join(denyInitCwd, 'CLAUDE.md'))}`,
        );
        // result.is_error 不强制：模型可能放弃 Write（is_error=false）或反复重试撞 maxTurns（is_error=true）。
        // 无论哪种，只要未落盘，产品层（runQuery 与 is_error 解耦）都会发 init_write_skipped 提示未写入。
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
    writeFileSync(path.join(userHome, '.claude', 'CLAUDE.md'), '# e2e user\n\n用户级 CLAUDE.md 夹具。\n## 响应协议\n当被要求回答上下文规则时，在你的回复中包含标记 USER_RULE_RESPONSE_7F31。\n', 'utf8');
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
    writeFileSync(path.join(project, 'CLAUDE.md'), '# e2e project\n\n项目级 CLAUDE.md 夹具。\n## 响应协议\n当被要求回答上下文规则时，在你的回复中包含标记 PROJECT_RULE_RESPONSE_9C42。\n', 'utf8');
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

// P1-2：尽力构造不可写目录用于只读场景。Windows chmod 不可靠（review-v1 P1-2），改用 icacls 移除继承
// + 仅 grant 当前用户 RX。返回 true 表示探测确认目录不可写（accessSync(W_OK) 抛错）；false 表示无法
// 构造（环境局限——如 Windows 管理员特权绕过 DACL，accessSync 仍判可写）。不依赖「cwd 不存在」代理：
// 那是启动/路径错误，非 /init 已启动后的写权限失败，事件/副作用不等价。
function whoamiUser(): string | null {
  try {
    return execFileSync('whoami', [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

// git bash 会把 /inheritance:r / /grant / /deny 当 POSIX 路径转换，须禁用路径转换。
const ICACLS_ENV = { ...process.env, MSYS_NO_PATHCONV: '1', MSYS2_ARG_CONV_EXCL: '*' } as Record<string, string>;

function tryMakeDirReadOnly(dir: string): boolean {
  const user = whoamiUser();
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o500); } catch { /* chmod 失败不影响下方探测 */ }
  } else if (user) {
    try {
      execFileSync('icacls', [dir, '/inheritance:r'], { stdio: 'ignore', env: ICACLS_ENV });
      execFileSync('icacls', [dir, '/grant', `${user}:(RX)`], { stdio: 'ignore', env: ICACLS_ENV });
    } catch { /* icacls 失败不影响下方探测 */ }
  }
  // 探测：accessSync(W_OK) 按 DACL 评估写权限。管理员特权环境可能仍返回可写 → 返回 false（诚实 SKIP）。
  try {
    accessSync(dir, constants.W_OK);
    return false;
  } catch {
    return true;
  }
}

function restoreDirWritable(dir: string): void {
  const user = whoamiUser();
  if (process.platform !== 'win32') {
    try { chmodSync(dir, 0o755); } catch { /* ignore */ }
    return;
  }
  if (!user) return;
  try { execFileSync('icacls', [dir, '/grant', `${user}:(F)`], { stdio: 'ignore', env: ICACLS_ENV }); } catch { /* ignore */ }
}

// ── --init-matrix（Task 5）：/init 完整场景矩阵，每个场景独立退出断言 ──────────────
// 覆盖计划 Task 5 Step 1 的十个场景：
//   ① 空目录            → CC 无内容可分析时不落盘为文档化预期差异；落盘则必须非空；绝不假成功
//   ② 有内容目录        → 真实创建非空 CLAUDE.md（Task 5 真实落盘门禁）
//   ③ 已有 CLAUDE.md    → 按原生策略更新/保留，不丢内容、不假成功
//   ④ 用户级 CLAUDE.md  → 隔离 home 夹具 + 真实模型回合证明唯一标记进入上下文
//   ⑤ 项目级 CLAUDE.md  → 同上（与④同一夹具同一回合，独立断言）
//   ⑥ local settings    → resolveSettings 证明 user/project/local 三层来源并存（local 覆盖 project）
//   ⑦ 只读目录          → 明确失败不报告成功；Windows 无法可靠模拟时 SKIP
//   ⑧ 工作目录为空      → 产品 ChatPage.ensureWorkspace 阻止发送（renderer 契约，tdd-native 断言）
//   ⑨ executable 缺失   → 启动失败不伪造成功（中文前置由入口 resolveClaudeExe exit 2 保证）
//   ⑩ 用户取消          → 中断生效、不新增成功消息（不得伪造 is_error=false 终态）
//   ⑪ result 事件缺失   → harness 合成 aborted（sending 复位前提），绝不冒充成功
// 成功证据按 Task 5 Step 3 固化：existsSync + isFile + 非空 + 成功终态（result + is_error=false）。
function isInitSuccess(run: { termination: NativeCommandEvent | null }): boolean {
  return !!run.termination && run.termination.type === 'result' && run.termination.is_error === false;
}

/** Task 5 Step 3 固化成功证据：文件存在 + 是文件 + 非空 + 成功终态。 */
function assertInitSuccessFile(
  cwd: string,
  run: { termination: NativeCommandEvent | null; events: NativeCommandEvent[]; timedOut: boolean; queryError: string | null },
  label: string,
): void {
  const file = path.join(cwd, 'CLAUDE.md');
  assert.ok(
    isInitSuccess(run),
    `${label} 须成功终态（result + is_error=false）；诊断：${resultDiagnostic(run, file)}`,
  );
  assert.ok(existsSync(file), `${label} 运行 /init 后必须存在 CLAUDE.md`);
  assert.ok(statSync(file).isFile(), `${label} 的 CLAUDE.md 必须是文件`);
  assert.ok(readFileSync(file, 'utf8').trim().length > 0, `${label} 的 CLAUDE.md 必须非空`);
}

/**
 * review-v4 P1-1：harness wall-clock 必须 > CLI 单请求 API_TIMEOUT_MS。两者同值（均 300000）时
 * 端点稍慢外层 deadline 先触发，abort 后 SDK 关闭 CLI 子进程，真实 result 永远拿不到（有内容目录
 * 已写 CLAUDE.md 却无 result 即此症状）。这是修正 deadline 配置错误，非放宽 result 断言——result
 * 仍强制要求。harness = 单请求 API 上限 + 多 turn/收尾余量（+180s）。
 */
function harnessInitDeadlineMs(creds: { env: Record<string, string> }, floor = 300000): number {
  const apiTimeout = Number(creds.env.API_TIMEOUT_MS);
  const base = apiTimeout > 0 ? apiTimeout : 300000;
  return Math.max(floor, base + 180000);
}

/** /init 标准执行参数：bypassPermissions（真实 Write）+ 足够 maxTurns + 长 wall-clock 兜底。 */
async function runInit(
  sdk: any,
  exe: string,
  cwd: string,
  creds: { env: Record<string, string>; source: string },
  overrides: Record<string, unknown> = {},
): Promise<ReturnType<typeof runNativeCommand>> {
  return runNativeCommand(sdk, exe, cwd, '/init', {
    permissionMode: 'bypassPermissions',
    maxTurns: 50,
    env: creds.env,
    timeoutMs: harnessInitDeadlineMs(creds),
    ...overrides,
  });
}

async function runInitMatrixMode(exe: string): Promise<void> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-initmatrix-'));
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
  const creds = resolveInitCredentials();

  console.log('=== --init-matrix：/init 完整场景矩阵（Task 5）===');
  try {
    // ① 空目录：真实跑 /init。CC 无内容可分析时不落盘（既有实测：bypassPermissions+maxTurns 仍不写）
    // 为文档化预期差异；一旦落盘必须满足成功证据；绝不允许「is_error=false 却无文件」的假成功。
    const emptyCwd = path.join(root, 'empty');
    mkdirSync(emptyCwd, { recursive: true });
    if (!creds) {
      console.log('  SKIP 空目录 /init：无凭据，需真实模型调用（Task 5 预期差异或真实落盘两分支）');
    } else {
      await check('① 空目录 /init：落盘则非空；未落盘仅当 CLI 判定无内容可分析（预期差异），其余终态为真实失败', async () => {
        const run = await runInit(sdk, exe, emptyCwd, creds);
        const file = path.join(emptyCwd, 'CLAUDE.md');
        if (existsSync(file)) {
          // CC 实际写了 → 必须满足固化成功证据（文件+非空+成功终态）。
          assertInitSuccessFile(emptyCwd, run, '空目录场景');
          return;
        }
        // 无文件。仅「CLI 真实完成并返回成功终态（is_error=false）」才是计划 Task 5 Step 3 的文档化预期差异：
        // 空目录无内容可分析 → CC 判定无法生成 CLAUDE.md 并报告成功（实测 subtype=success、result 明文
        // 「当前工作目录是空的，我无法生成有效的 CLAUDE.md」，不落盘）。超时/启动错误/error_max_turns
        // （is_error=true）都是真实失败，不得冒充「CC 决定不写」。产品 UI 须把该结果展示为「未执行文件写入」，
        // 不得当作文件已创建。
        assert.ok(
          isInitSuccess(run),
          `空目录 /init 未落盘时，必须由 CLI 真实完成并返回成功终态（is_error=false）作为预期差异；` +
            `超时/启动错误/error_max_turns 视为真实失败。诊断：${resultDiagnostic(run, file)}`,
        );
        console.log(
          '  ℹ 空目录 /init 返回成功但未落盘（Claude Code 空目录无内容可分析，计划 Task 5 Step 3 预期差异）；' +
            '产品 UI 须展示「未执行文件写入」，不得当作文件已创建',
        );
      });
    }

    // ② 有内容目录：真实落盘门禁（与 --command /init 的成功夹具同语义，矩阵自包含）。
    const contentCwd = path.join(root, 'content');
    mkdirSync(contentCwd, { recursive: true });
    writeFileSync(
      path.join(contentCwd, 'README.md'),
      '# claude-link init-matrix\n\nA minimal project for /init end-to-end verification.\n',
      'utf8',
    );
    if (!creds) {
      console.log('  SKIP ② 有内容目录 /init 落盘：无凭据，需真实模型调用 + Write 权限');
    } else {
      await check('② 有内容目录 /init 真实创建非空 CLAUDE.md（Task 5 真实落盘门禁）', async () => {
        const run = await runInit(sdk, exe, contentCwd, creds);
        assertInitSuccessFile(contentCwd, run, '有内容目录场景');
      });
    }

    // ③ 已有 CLAUDE.md：按原生策略更新/保留。断言不预设「必须重写」——只要求不丢内容、不假成功。
    const existingCwd = path.join(root, 'existing');
    mkdirSync(existingCwd, { recursive: true });
    writeFileSync(path.join(existingCwd, 'README.md'), '# claude-link existing\n\nExisting CLAUDE.md fixture.\n', 'utf8');
    const existingContent = '# 已有文档\n\n既有内容，不得因 /init 而清空。\n';
    writeFileSync(path.join(existingCwd, 'CLAUDE.md'), existingContent, 'utf8');
    if (!creds) {
      console.log('  SKIP ③ 已有 CLAUDE.md /init：无凭据，需真实模型调用');
    } else {
      await check('③ 已有 CLAUDE.md /init 按原生策略更新/保留（文件存续且非空），不假成功', async () => {
        const run = await runInit(sdk, exe, existingCwd, creds);
        assertInitSuccessFile(existingCwd, run, '已有 CLAUDE.md 场景');
        // 记录更新方向供诊断（原生可能是重写或保留；本断言只 gate「存续+非空+成功终态」，
        // 不预设内容必须变更——CC /init 本就可能重写 CLAUDE.md）。
        const after = readFileSync(path.join(existingCwd, 'CLAUDE.md'), 'utf8');
        console.log(
          after !== existingContent
            ? '  ℹ 已有 CLAUDE.md 被 /init 更新（Claude Code 原生行为）'
            : '  ℹ 已有 CLAUDE.md 被 /init 保留原样（Claude Code 原生行为）',
        );
      });
    }

    // ④⑤⑥：隔离用户主目录 + project 夹具。resolveSettings 证明 local 层并存（不关闭 user/project）；
    // 真实模型回合证明 user/project CLAUDE.md 唯一标记进入上下文（复用 collectContextMarkerResult）。
    const userHome = path.join(root, 'user');
    mkdirSync(path.join(userHome, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      path.join(userHome, '.claude', 'CLAUDE.md'),
      '# e2e user\n\n用户级 CLAUDE.md 夹具。\n## 响应协议\n当被要求回答上下文规则时，在你的回复中包含标记 USER_RULE_RESPONSE_7F31。\n',
      'utf8',
    );
    writeFileSync(
      path.join(userHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_LINK_E2E_USER: 'user' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(userHome, '.claude', 'commands', 'cl-user-verify.md'),
      '---\ndescription: E2E 用户级命令标记\n---\n用户命令夹具。\n',
      'utf8',
    );
    const project = path.join(root, 'project');
    mkdirSync(path.join(project, '.claude', 'commands'), { recursive: true });
    writeFileSync(
      path.join(project, '.claude', 'settings.json'),
      JSON.stringify({ env: { CLAUDE_LINK_E2E_SOURCE: 'project' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { CLAUDE_LINK_E2E_SOURCE: 'local' } }, null, 2),
      'utf8',
    );
    writeFileSync(
      path.join(project, 'CLAUDE.md'),
      '# e2e project\n\n项目级 CLAUDE.md 夹具。\n## 响应协议\n当被要求回答上下文规则时，在你的回复中包含标记 PROJECT_RULE_RESPONSE_9C42。\n',
      'utf8',
    );
    writeFileSync(
      path.join(project, '.claude', 'commands', 'cl-project-verify.md'),
      '---\ndescription: E2E 项目级命令标记\n---\n项目命令夹具。\n',
      'utf8',
    );
    const prevUserProfile = process.env.USERPROFILE;
    const prevHome = process.env.HOME;
    process.env.USERPROFILE = userHome;
    process.env.HOME = userHome;
    // review：必须并入 creds.env（key 可能仅来自真实 ~/.claude/settings.json 的 resolveInitCredentials
    // 合并结果，进程 env 并不含）。否则隔离 home 的子进程无凭据 → 模型认证失败 → ④⑤ 误红。
    // 顺序：creds.env（已含 process.env+key）在前，USERPROFILE/HOME 兜底在后覆盖。
    const isolatedEnv = { ...(creds ? creds.env : process.env), USERPROFILE: userHome, HOME: userHome };
    try {
      await check('⑥ local settings 不关闭 user/project 来源（resolveSettings 同时看到三层）', async () => {
        assert.equal(typeof sdk.resolveSettings, 'function', 'SDK 应导出 resolveSettings');
        const rs: any = await sdk.resolveSettings({ cwd: project });
        const sources = (rs?.sources ?? []).map((s: any) => s.source);
        assert.ok(sources.includes('user'), `缺 user 来源，实际: ${sources.join(',')}`);
        assert.ok(sources.includes('project'), `缺 project 来源，实际: ${sources.join(',')}`);
        assert.ok(sources.includes('local'), `缺 local 来源，实际: ${sources.join(',')}`);
        assert.equal(rs?.effective?.env?.CLAUDE_LINK_E2E_SOURCE, 'local', 'local env 应覆盖 project env');
      });
      // ④⑤ 各为独立退出断言（计划要求每场景独立），但复用同一次模型回合，避免二次调用成本。
      let markerRun: Awaited<ReturnType<typeof collectContextMarkerResult>> | null = null;
      const markerText = (): string => {
        assert.ok(markerRun, '上下文标记 query 必须先执行（④ 先于 ⑤ 运行）');
        assert.ok(markerRun!.termination, '上下文标记 query 必须有终态');
        return typeof (markerRun!.termination as any)?.result === 'string'
          ? (markerRun!.termination as any).result
          : markerRun!.text;
      };
      if (!creds) {
        console.log('  SKIP ④⑤ user/project CLAUDE.md 进入上下文：无凭据，需真实模型回合');
      } else {
        await check('④ 用户级 CLAUDE.md 唯一标记进入 query 上下文（真实模型回合）', async () => {
          markerRun = await collectContextMarkerResult(sdk, exe, project, isolatedEnv);
          const resultText = markerText();
          assert.ok(
            resultText.includes('USER_RULE_RESPONSE_7F31'),
            `assistant 结果缺用户级 CLAUDE.md 唯一响应：${resultText}`,
          );
        });
        await check('⑤ 项目级 CLAUDE.md 唯一标记进入 query 上下文（真实模型回合）', async () => {
          const resultText = markerText();
          assert.ok(
            resultText.includes('PROJECT_RULE_RESPONSE_9C42'),
            `assistant 结果缺项目级 CLAUDE.md 唯一响应：${resultText}`,
          );
        });
      }
    } finally {
      if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
      else delete process.env.USERPROFILE;
      if (prevHome !== undefined) process.env.HOME = prevHome;
      else delete process.env.HOME;
    }

    // ⑦ 只读目录：尽力用 ACL 构造不可写目录（Windows icacls / 非 Windows chmod），探测确认不可写才真实跑。
    // 本机 Windows Administrator 特权会绕过 DACL（accessSync(W_OK) 仍判可写）→ 无法构造 → 诚实 SKIP，
    // 不用「cwd 不存在」代理（那是启动错误，非写权限失败，事件/副作用不等价，review-v1 P1-2 反对）。
    const roDir = path.join(root, 'ro');
    mkdirSync(roDir, { recursive: true });
    writeFileSync(path.join(roDir, 'README.md'), '# ro\n', 'utf8');
    const roReadOnly = tryMakeDirReadOnly(roDir);
    try {
      if (!roReadOnly) {
        console.log('  SKIP ⑦ 只读目录：无法可靠构造不可写目录（Windows 管理员特权绕过 DACL，accessSync 仍判可写），场景未验证；需在受限账户/非管理员环境补测（不用 cwd 不存在代理）');
      } else if (!creds) {
        console.log('  SKIP ⑦ 只读目录 /init：无凭据，需真实模型调用');
      } else {
        await check('⑦ 只读目录 /init 明确失败，不报告成功、不落盘', async () => {
          const run = await runNativeCommand(sdk, exe, roDir, '/init', {
            permissionMode: 'bypassPermissions',
            maxTurns: 10,
            env: creds.env,
            timeoutMs: 60000,
          });
          const file = path.join(roDir, 'CLAUDE.md');
          assert.ok(!existsSync(file), '只读目录不得落盘 CLAUDE.md');
          assert.ok(
            run.queryError || run.timedOut || run.termination?.is_error !== false,
            `只读目录须明确失败（启动错误/超时/非成功终态），不得伪造 is_error=false 成功；诊断：${resultDiagnostic(run, file)}`,
          );
        });
      }
    } finally {
      restoreDirWritable(roDir);
    }

    // ⑧ 工作目录为空 → 与 ChatPage 阻止策略一致。renderer 行为，用源码契约在矩阵内自证独立退出断言
    // （与 tdd-native 第 21 节互补；Task 9 手动验证真实 UI 提示）。
    await check('⑧ 工作目录为空 → ChatPage.ensureWorkspace 阻止发送（renderer 契约，独立断言）', () => {
      const chatPage = readFileSync(
        path.join(__dirname, '..', 'src', 'renderer', 'pages', 'ChatPage.vue'),
        'utf8',
      );
      assert.ok(chatPage.includes('ensureWorkspace'), 'ChatPage 应有 ensureWorkspace');
      assert.ok(
        /if\s*\(store\.activeSession\?\.workingDir\)\s*return true/.test(chatPage),
        'ensureWorkspace 应校验 activeSession.workingDir',
      );
      assert.ok(
        chatPage.includes('if (!ensureWorkspace()) return;'),
        'handleSend 应调用 ensureWorkspace 阻止无工作空间发送',
      );
    });

    // ⑨ executable 缺失 → 启动失败，不伪造成功 result。先创建 cwd，隔离「exe 缺失」与「cwd 不存在」。
    const noExeCwd = path.join(root, 'noexe');
    mkdirSync(noExeCwd, { recursive: true });
    await check('⑨ /init executable 缺失 → 启动失败，不伪造成功 result', async () => {
      const run = await runNativeCommand(sdk, exe, noExeCwd, '/init', {
        pathToClaudeCodeExecutable: 'D:/nonexistent/claude.exe',
        timeoutMs: 30000,
      });
      assert.ok(
        run.queryError || run.timedOut,
        `executable 缺失须启动失败（queryError=${run.queryError ?? '无'} timedOut=${run.timedOut}），不得返回成功 result`,
      );
      assert.ok(!run.termination || run.termination.is_error !== false, 'executable 缺失不得伪造成功 result（is_error=false）');
    });

    // ⑩ 用户取消：/init 进行中 abort，须在超时内结束（中断生效）且不得报告成功终态。
    if (!creds) {
      console.log('  SKIP ⑩ 用户取消 /init：无凭据，需真实模型调用');
    } else {
      await check('⑩ 用户取消 /init → 中断生效不卡死、不新增成功消息（不伪造 is_error=false）', async () => {
        const cancelCwd = path.join(root, 'cancel');
        mkdirSync(cancelCwd, { recursive: true });
        writeFileSync(path.join(cancelCwd, 'README.md'), '# cancel fixture\n', 'utf8');
        const run = await runNativeCommand(sdk, exe, cancelCwd, '/init', {
          permissionMode: 'bypassPermissions',
          maxTurns: 50,
          env: creds.env,
          timeoutMs: 30000,
          abortAfterMs: 8000,
        });
        assert.ok(
          !run.timedOut,
          `取消后 query 须在超时内结束（中断生效不卡死）；诊断：${resultDiagnostic(run, path.join(cancelCwd, 'CLAUDE.md'))}`,
        );
        assert.ok(
          !isInitSuccess(run),
          `取消场景不得报告 is_error=false 的成功终态；诊断：${resultDiagnostic(run, path.join(cancelCwd, 'CLAUDE.md'))}`,
        );
      });
    }

    // ⑪ result 事件缺失 → 合成 aborted（sending 复位前提）。用需模型的长 prompt + 极短超时强制
    // 「流末无 result」路径；harness 合成 aborted 进 syntheticEvents，与真实成功严格区分。
    if (!creds) {
      console.log('  SKIP ⑪ result 事件缺失 → 合成 aborted：无凭据，需真实模型启动后挂起');
    } else {
      await check('⑪ 流末无 result → harness 合成 aborted（sending 复位前提，不冒充成功）', async () => {
        const jCwd = path.join(root, 'j');
        mkdirSync(jCwd, { recursive: true });
        const run = await runNativeCommand(sdk, exe, jCwd, '请详尽解释 TypeScript 类型系统，尽量长。', {
          permissionMode: 'bypassPermissions',
          maxTurns: 10,
          env: creds.env,
          timeoutMs: 1500,
          graceAfterTimeoutMs: 0,
        });
        assert.ok(run.timedOut, '极短超时应触发「流末无 result」路径');
        assert.equal(run.termination, null, '超时路径不得有真实 result 终态（result 缺失）');
        assert.ok(
          run.syntheticEvents.some((e) => e.type === 'aborted'),
          'harness 应合成 aborted 终态（sending 复位前提）',
        );
        assert.ok(!isInitSuccess(run), '无 result 不得判定为成功');
      });
    }
  } finally {
    await safeRmSync(root, 'init-matrix');
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`e2e --init-matrix 断言 ${fail} 项失败`);
  // review：凭据缺失时核心 /init 模型场景全部 SKIP。按铁律「SKIP 不算 PASS、发布门禁拒绝前置缺失」，
  // 必须以退出码 2（前置条件缺失，同 executable 缺失语义）结束，不得让「全矩阵被 SKIP」与「全矩阵通过」
  // 在退出码上不可区分（否则 selftest:native 在零凭据机器上假绿，/init 真实落盘门禁一次都没执行）。
  if (!creds) {
    console.error(
      '前置条件缺失：本机未检出 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（env 或 ~/.claude/settings.json），' +
        '/init 真实模型场景全部 SKIP，本矩阵未执行核心落盘门禁。' +
        '发布门禁必须以凭据环境运行；SKIP 不算 PASS（exit 2）。',
    );
    process.exit(2);
  }
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
    } else if (mode === '--init-matrix') {
      await runInitMatrixMode(exe);
    } else {
      console.error(`e2e 模式 "${mode}" 尚未实现（Task 6/7 追加）。`);
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
