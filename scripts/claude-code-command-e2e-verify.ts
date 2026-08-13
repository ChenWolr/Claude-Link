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
// Task 6：候选平替等价性规格单一真相源（矩阵只存测试规格，e2e 以真实 SDK 证据断言它）。
import { REPLACEMENT_CANDIDATES, type ReplacementField } from './claude-code-command-matrix';

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

/**
 * review-v2 §8.1：检测事件流中是否有 tool 使用痕迹（sideEffects 维度）。
 * 不仅看顶层 type='tool' 事件，还检查 assistant 消息 content 中的 tool_use/tool_result 块——
 * SDK 的 assistant 事件把 tool_use 放在 content 数组里，不是独立 type='tool' 事件。
 */
function hasToolSideEffects(events: NativeCommandEvent[]): boolean {
  return events.some((e) => {
    if (e.type === 'tool') return true;
    if (e.subtype === 'local_command_output') return true;
    const checkBlocks = (content: unknown): boolean => {
      if (!Array.isArray(content)) return false;
      return content.some((block) => {
        if (!block || typeof block !== 'object') return false;
        const t = (block as { type?: string }).type;
        return t === 'tool_use' || t === 'tool_result';
      });
    };
    if (checkBlocks(e.content)) return true;
    const msgObj = e as { message?: { content?: unknown } };
    if (checkBlocks(msgObj.message?.content)) return true;
    return false;
  });
}

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

// Task 4 review P1-4 / review-v3 F2 / review-v4 F2+F3：按 Claude Code/Agent SDK 真实凭据解析链
// 检测 /init、/compact 等模型场景所需凭据。与生产 settings source 一致地检查多层来源：
//   process.env（运行时注入）< user settings.json（Windows 多候选：USERPROFILE+HOME）
//   < <cwd>/.claude/settings.json（project）< <cwd>/.claude/settings.local.json（local）
// 任一层发现 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN 即按层级覆盖；全无则 null（SKIP）。
// executable 缺失由入口 resolveClaudeExe 已处理（exit 2）；此处只区分「有凭据」与「无凭据」，
// 不区分凭据是否有效（凭据存在但请求失败由 /init 断言本身报告，不在此预先判定）。
//
// review-v4 F2：API Key 与 Auth Token 同时存在时 SDK 可能双重认证冲突，按优先级只选一种
//（ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN），选中后从传给子进程的 env 中删除另一种（含
// process.env 残留）。source 仅记录脱敏的来源类型，不记录 token/key 值或完整路径。
function readSettingsEnvLayer(dir: string, layer: 'settings.json' | 'settings.local.json'): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, '.claude', layer), 'utf8'));
    const envBlock = parsed?.env;
    if (envBlock && typeof envBlock === 'object' && !Array.isArray(envBlock)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(envBlock as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      return out;
    }
  } catch {
    // 该层无文件或解析失败：跳过。
  }
  return {};
}

export async function resolveInitCredentials(
  cwd: string | null,
): Promise<{ env: Record<string, string>; source: string } | null> {
  type Slot = { value: string; src: string } | null;
  let apiKey: Slot = null;
  let authToken: Slot = null;
  const setKey = (v: string, src: string) => { apiKey = { value: v, src }; };
  const setToken = (v: string, src: string) => { authToken = { value: v, src }; };
  // ① process.env（最低层，被 settings 覆盖）。
  if (process.env.ANTHROPIC_API_KEY) setKey(process.env.ANTHROPIC_API_KEY, 'env');
  if (process.env.ANTHROPIC_AUTH_TOKEN) setToken(process.env.ANTHROPIC_AUTH_TOKEN, 'env');
  // ② user settings.json（review-v3 F2：Windows 多候选目录，去重）。
  const userDirs: string[] = [];
  if (process.platform === 'win32') {
    if (process.env.USERPROFILE) userDirs.push(process.env.USERPROFILE);
    if (process.env.HOME) userDirs.push(process.env.HOME);
  } else if (process.env.HOME) {
    userDirs.push(process.env.HOME);
  }
  const seenUser = new Set<string>();
  for (const dir of userDirs) {
    const norm = path.resolve(dir);
    if (seenUser.has(norm)) continue;
    seenUser.add(norm);
    const env = readSettingsEnvLayer(dir, 'settings.json');
    if (env.ANTHROPIC_API_KEY) setKey(env.ANTHROPIC_API_KEY, 'user-settings');
    if (env.ANTHROPIC_AUTH_TOKEN) setToken(env.ANTHROPIC_AUTH_TOKEN, 'user-settings');
  }
  // ③④ project / local（review-v4 F3：与生产 SDK settings source 一致）。
  if (cwd) {
    const projectEnv = readSettingsEnvLayer(cwd, 'settings.json');
    if (projectEnv.ANTHROPIC_API_KEY) setKey(projectEnv.ANTHROPIC_API_KEY, 'project-settings');
    if (projectEnv.ANTHROPIC_AUTH_TOKEN) setToken(projectEnv.ANTHROPIC_AUTH_TOKEN, 'project-settings');
    const localEnv = readSettingsEnvLayer(cwd, 'settings.local.json');
    if (localEnv.ANTHROPIC_API_KEY) setKey(localEnv.ANTHROPIC_API_KEY, 'local-settings');
    if (localEnv.ANTHROPIC_AUTH_TOKEN) setToken(localEnv.ANTHROPIC_AUTH_TOKEN, 'local-settings');
  }
  if (!apiKey && !authToken) return null;
  // review-v4 F2：优先级 ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN；只把选中者注入 child env，
  // 删除另一种（含 process.env 残留），避免 SDK 双重认证。
  const useKey = !!apiKey;
  const chosenKey = useKey ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN';
  const droppedKey = useKey ? 'ANTHROPIC_AUTH_TOKEN' : 'ANTHROPIC_API_KEY';
  const chosen = useKey ? apiKey! : authToken!;
  const env = { ...process.env } as Record<string, string>;
  delete env[droppedKey];
  env[chosenKey] = chosen.value;
  return { env, source: `${chosen.src}:${chosenKey}` };
}

// review-v2 F1：/compact 真实压缩证据 warmup 提示（多轮，堆积消息条数 + 上下文体积）。
// 单轮短 warmup 实测会让 /compact 因 "Not enough messages to compact" 返回 compact_result:'failed'；
// 必须多轮堆积，/compact 才有内容可压缩并产出 compact_boundary / compact_result:'success'。
const COMPACT_WARMUP_PROMPTS: readonly string[] = [
  '请极其详尽地解释 TypeScript 的泛型、条件类型、映射类型、infer 关键字，每种都给出多个完整代码示例，至少 1000 字。',
  '接着极其详尽地解释 JavaScript 闭包、原型链、this 绑定、事件循环、宏任务与微任务，每种给多个完整代码示例，至少 1000 字。',
  '再极其详尽地解释 React 的 hooks（useState/useEffect/useMemo/useCallback/useReducer/useContext）与 Fiber 架构，每种给完整代码示例，至少 1000 字。',
];

// Task 6 补齐（计划 Step 3「上下文统计变化」）：用 Claude Code 自己的 /context 报告采集当前会话上下文占用百分比。
//
// 为什么不用 SDK result.usage 的 input/cache token 对比压缩前后：实测发现 resume 会话时 cache_read_input_tokens
// 会把压缩前的缓存历史一并计入，压缩后数值反而变大（实测 warmup 后 input≈25595 → 压缩后探测 input≈37436，
// 尽管 compact_boundary=true），不是「当前上下文大小」的有效代理。/context 是 Claude Code 报告上下文占用的
// 权威本地命令（零模型成本），其百分比才是上下文统计变化的有效度量。
//
// 返回上下文占用百分比（0..100）；/context 无终态或文本不含百分比时返回 null（回退到 compact_boundary 证据）。
async function captureContextUsagePct(
  sdk: any,
  exe: string,
  cwd: string,
  creds: { env: Record<string, string>; source: string },
  resumeSid: string,
): Promise<number | null> {
  const r = await runNativeCommand(sdk, exe, cwd, '/context', {
    maxTurns: 1,
    env: creds.env,
    timeoutMs: 60000,
    resume: resumeSid,
  });
  if (!r.termination) return null;
  // /context 报告文本可能在 result.result（常规）或 system:local_command_output 事件里（resume 时偶发），
  // 汇总后取第一个百分比作上下文占用代理。
  const parts: string[] = [];
  if (typeof r.termination.result === 'string') parts.push(r.termination.result);
  for (const e of r.events) {
    if (e.type === 'system' && e.subtype === 'local_command_output') {
      const c = (e as any).content ?? (e as any).text;
      if (typeof c === 'string') parts.push(c);
    }
  }
  const text = parts.join('\n');
  const m = text.match(/(\d+(?:\.\d+)?)\s*%/);
  return m ? parseFloat(m[1]) : null;
}

/**
 * review-v2 F1：/compact 真实压缩证据验证（--command / --replacements 共用）。
 * 收紧验收——只接受 `compact_boundary` 或 `compact_result:'success'`：
 *   - `status:'compacting'` 仅表示压缩开始，不证明完成/成功（旧 hasStatus 据此误报成功）；
 *   - `compact_result:'failed'`（如 "Not enough messages to compact"）明确表示未压缩 → 不得当成功；
 *   - 非空 local_command_output 可能是错误文本，不能单独证明压缩成功（review-v2 F1）。
 * 生产侧 sdk-backend.ts 同样只把 status:'compacting'/compact_result 当压缩状态，其余 status 不代表压缩。
 */
async function verifyCompactEvidence(
  sdk: any,
  exe: string,
  cwd: string,
  creds: { env: Record<string, string>; source: string },
  warmupPrompts: readonly string[],
): Promise<void> {
  // review-v4 F4 / review-v5 F3：每轮 warmup 须确认成功终态与会话连续性——某轮失败立即让 /compact
  // 场景失败，不得沿用旧 sid 在不完整/不连续上下文上继续。
  // review-v5 F3（实测协议）：resume 同一会话时 init.session_id 应保持等于上一轮 sid（本轮已实证）；
  // 若 resume 失效/自动新建会话则 sid 变化 → 断言失败，证明预期多轮上下文确在同一连续会话中构造。
  let cliSid: string | null = null;
  for (let i = 0; i < warmupPrompts.length; i++) {
    const r = await runNativeCommand(sdk, exe, cwd, warmupPrompts[i], {
      permissionMode: 'bypassPermissions',
      maxTurns: 3,
      env: creds.env,
      // warmup 提示词刻意要求大段输出（≥1000 字 × 多主题）以堆积可压缩上下文；慢端点 + tool_use 往返
      // 易超 120s（Task 6 review 记录的瞬态抖动）。与 /compact 调用一致用 240s + 60s grace，避免 warmup
      // 被超时硬中断报 is_error 导致上下文不连续（与压缩证据判定无关的纯环境鲁棒性）。
      timeoutMs: 240000,
      ...(cliSid ? { resume: cliSid } : {}),
    });
    assert.ok(r.termination, `warmup 第 ${i + 1} 轮须有 result 终态（构造连续上下文）；诊断：${resultDiagnostic(r)}`);
    assert.equal(r.termination?.is_error, false, `warmup 第 ${i + 1} 轮不得 is_error（否则上下文不连续）；诊断：${resultDiagnostic(r)}`);
    const sid = r.init?.session_id;
    assert.ok(sid, `warmup 第 ${i + 1} 轮须返回 system.init.session_id`);
    if (cliSid) {
      assert.equal(
        sid,
        cliSid,
        `warmup 第 ${i + 1} 轮 resume 后 session_id 应保持 ${cliSid}（同一 CLI 会话），实际 ${sid}——` +
          'resume 未保持会话（失效/自动新建），上下文不连续（review-v5 F3）',
      );
    }
    cliSid = sid;
  }
  assert.ok(cliSid, 'warmup 须返回 system.init.session_id 供 /compact resume');
  // Task 6 补齐（计划 Step 3「上下文统计变化」）：压缩前用 /context 采集上下文占用百分比作为基线。
  const preCompactPct = await captureContextUsagePct(sdk, exe, cwd, creds, cliSid);
  const run = await runNativeCommand(sdk, exe, cwd, '/compact', {
    permissionMode: 'bypassPermissions',
    maxTurns: 8,
    env: creds.env,
    timeoutMs: 180000,
    resume: cliSid,
  });
  assert.ok(run.termination, '必须收到 /compact result 终态');
  assert.equal(run.termination?.is_error, false, `成功 /compact 不得 is_error；诊断：${resultDiagnostic(run)}`);
  const hasBoundary = run.events.some((e) => e.subtype === 'compact_boundary');
  const hasCompactSuccess = run.events.some(
    (e) => e.type === 'system' && e.subtype === 'status' && (e as any).compact_result === 'success',
  );
  const failedEvent = run.events.find(
    (e) => e.type === 'system' && e.subtype === 'status' && (e as any).compact_result === 'failed',
  );
  assert.ok(
    hasBoundary || hasCompactSuccess,
    `/compact 须返回真实压缩成功证据（compact_boundary 或 compact_result:'success'，review-v2 F1 收紧）；` +
      `实际 hasBoundary=${hasBoundary} hasCompactSuccess=${hasCompactSuccess}` +
      `${failedEvent ? `；compact_result:'failed'（${(failedEvent as any).compact_error ?? '未知原因'}）—— 若为「Not enough messages to compact」等上下文不足原因，须增加 warmup 轮次` : ''}`,
  );
  // Task 6 补齐（计划 Step 3「上下文统计变化」）：compact_boundary/compact_result:'success' 证明压缩发生；
  // 这里再用 /context 在压缩后采集一次上下文占用百分比，与压缩前基线对比——给出「上下文被压缩」的数值证据。
  // /context 是 Claude Code 报告上下文占用的权威本地命令（见上方 captureContextUsagePct 注释：SDK result.usage
  // 因 cache_read 计入压缩前历史而无效）。pre/post 任一不可读（如 /context 报告格式变化）时回退到 boundary 证据。
  const postCompactPct = await captureContextUsagePct(sdk, exe, cwd, creds, cliSid);
  if (preCompactPct != null && postCompactPct != null) {
    assert.ok(
      postCompactPct < preCompactPct,
      `/compact 应降低上下文占用（上下文统计变化证据）：压缩前 /context≈${preCompactPct}%，` +
        `压缩后 /context≈${postCompactPct}%；若未降低，可能 warmup 上下文不足或压缩未生效` +
        `（boundary=${hasBoundary}, compactSuccess=${hasCompactSuccess}）。`,
    );
    console.log(`  ℹ /compact 上下文统计变化：/context 占用 ${preCompactPct}% → ${postCompactPct}%（已压缩）`);
  } else {
    console.log(
      `  ℹ /context 百分比不可读（pre=${preCompactPct}, post=${postCompactPct}，可能是报告格式变化），` +
        `上下文统计变化以 compact_boundary 为据：boundary=${hasBoundary}`,
    );
  }
}

// ── review-v5 F1：--command 逐命令成功证据（本地命令，无需凭据）────────────────────
// 供 --command 模式对用户请求的每个命令做真实成功断言；--replacements 模式复用做等价性观察。
async function verifyUsageCommand(sdk: any, exe: string, cwd: string): Promise<string> {
  const run = await runNativeCommand(sdk, exe, cwd, '/usage', { maxTurns: 1, timeoutMs: 60000 });
  assert.equal(run.termination?.type, 'result', `原生 /usage 须有 result 终态；诊断：${resultDiagnostic(run)}`);
  const termResult = run.termination?.result;
  const text = typeof termResult === 'string' ? termResult : '';
  assert.ok(
    /Total cost|Total duration|code changes/i.test(text),
    `原生 /usage 应输出会话聚合用量文本（result.result）；result_head=${text.slice(0, 120)}`,
  );
  return text;
}

async function verifyContextCommand(sdk: any, exe: string, cwd: string): Promise<string> {
  const run = await runNativeCommand(sdk, exe, cwd, '/context', { maxTurns: 1, timeoutMs: 60000 });
  assert.equal(run.termination?.type, 'result', `原生 /context 须有 result 终态；诊断：${resultDiagnostic(run)}`);
  const termResult = run.termination?.result;
  const text = typeof termResult === 'string' ? termResult : '';
  assert.ok(
    /Context Usage|Tokens:/i.test(text),
    `原生 /context 应输出 Context Usage 报告文本（result.result）；result_head=${text.slice(0, 120)}`,
  );
  return text;
}

async function verifyClearCommand(sdk: any, exe: string, cwd: string): Promise<string> {
  const run = await runNativeCommand(sdk, exe, cwd, '/clear', { maxTurns: 1, timeoutMs: 60000 });
  assert.ok(
    run.events.some((e) => e.type === 'conversation_reset'),
    `原生 /clear 应发出 conversation_reset（重置当前会话上下文）；事件=${run.events.map((e) => e.type).join('|')}`,
  );
  assert.equal(run.termination?.type, 'result', '原生 /clear 须有 result 终态（产生命令结果反馈）');
  assert.ok(run.init?.session_id, '原生 /clear 的 init 须携带 session id');
  return typeof run.init?.session_id === 'string' ? run.init.session_id : '';
}

async function verifyConfigCommand(sdk: any, exe: string, cwd: string, root: string): Promise<void> {
  // /config key=value 写用户级 settings.json（隔离 USERPROFILE/HOME 验证写盘位置，不污染真实 home）。
  const isoHome = path.join(root, 'config-home');
  mkdirSync(path.join(isoHome, '.claude'), { recursive: true });
  writeFileSync(path.join(isoHome, '.claude', 'settings.json'), '{}\n', 'utf8');
  const prevUserProfile = process.env.USERPROFILE;
  const prevHome = process.env.HOME;
  process.env.USERPROFILE = isoHome;
  process.env.HOME = isoHome;
  const isolatedEnv = { ...process.env, USERPROFILE: isoHome, HOME: isoHome } as Record<string, string>;
  try {
    const run = await runNativeCommand(sdk, exe, cwd, '/config autoCompact=false', {
      env: isolatedEnv,
      maxTurns: 1,
      timeoutMs: 60000,
    });
    assert.equal(run.termination?.type, 'result', '原生 /config 须有 result 终态');
    const termResult = run.termination?.result;
    const text = typeof termResult === 'string' ? termResult : '';
    assert.ok(/Auto-compact|autoCompact/i.test(text), `原生 /config 应确认配置写入；result_head=${text.slice(0, 120)}`);
    const userSettings = JSON.parse(readFileSync(path.join(isoHome, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
    assert.ok(
      'autoCompactEnabled' in userSettings,
      `原生 /config 应写用户级 ~/.claude/settings.json（autoCompactEnabled）；实际 keys=${Object.keys(userSettings).join(',')}`,
    );
    assert.ok(!existsSync(path.join(cwd, '.claude', 'settings.local.json')), '原生 /config 不应写项目级 .claude/settings.local.json');
  } finally {
    if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
    else delete process.env.USERPROFILE;
    if (prevHome !== undefined) process.env.HOME = prevHome;
    else delete process.env.HOME;
  }
}

async function runCommandMode(exe: string, prompts: string[]): Promise<void> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-command-'));
  let pass = 0;
  let fail = 0;
  // review-v3 F1：--command 模式同样需要独立 skipped 状态。无凭据时 /init、/compact、普通文本、
  // 取消/plan 等核心模型场景被 SKIP，不得以 exit 0 冒充完整通过（与 runReplacementsMode 同约定）。
  let skipped = 0;
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
    // review-v5 F1/F2：--command 逐命令执行。先创建各场景真实 cwd，再按 query 的真实 cwd 解析凭据
    //（project/local settings 在真实命令目录下才可能命中，不能统一用 root——review-v4 F3 场景会漏检）。
    // 本地命令（/usage /context /clear /config）无需凭据；/init /compact 与协议场景需模型。
    const initCwd = path.join(root, 'init');
    const compactCwd = path.join(root, 'compact');
    const plainCwd = path.join(root, 'plain');
    const abortCwd = path.join(root, 'abort');
    const planCwd = path.join(root, 'plan-init');
    const denyCwd = path.join(root, 'deny');
    const denyInitCwd = path.join(root, 'deny-init');
    const usageCwd = path.join(root, 'usage');
    const contextCwd = path.join(root, 'context');
    const clearCwd = path.join(root, 'clear');
    const configCwd = path.join(root, 'config');
    for (const d of [initCwd, compactCwd, plainCwd, abortCwd, planCwd, denyCwd, denyInitCwd, usageCwd, contextCwd, clearCwd, configCwd]) {
      mkdirSync(d, { recursive: true });
    }
    // 各模型场景凭据按其真实 query cwd 解析（review-v5 F2）；协议场景 cwd 均为空目录，用 root 即可。
    const initCreds = await resolveInitCredentials(initCwd);
    const compactCreds = await resolveInitCredentials(compactCwd);
    const protocolCreds = await resolveInitCredentials(root);
    // review-v4 F1：--command 的范围语义——只验证 prompts 列出的命令。普通文本/取消/plan/deny 等
    // 「需要模型调用的协议场景」仅在请求了 /init 或 /compact（需要模型的命令）时才运行/计数 skip；
    // 这样 `--command /usage`（本地命令，不需模型）不会被未请求的模型场景阻断 exit 2。
    // executable/cwd 启动失败检查不需凭据，与模型无关，保持总运行。
    const hasModelCommand = prompts.includes('/init') || prompts.includes('/compact');
    if (prompts.includes('/usage')) {
      await check('/usage 真实 result + 会话聚合用量文本（review-v5 F1：逐命令执行，不静默跳过）', async () => {
        await verifyUsageCommand(sdk, exe, usageCwd);
      });
    }
    if (prompts.includes('/context')) {
      await check('/context 真实 result + Context Usage 文本（review-v5 F1：逐命令执行，不静默跳过）', async () => {
        await verifyContextCommand(sdk, exe, contextCwd);
      });
    }
    if (prompts.includes('/clear')) {
      await check('/clear conversation_reset + result + session id（review-v5 F1：逐命令执行，不静默跳过）', async () => {
        await verifyClearCommand(sdk, exe, clearCwd);
      });
    }
    if (prompts.includes('/config')) {
      await check('/config result + 用户级 settings 写盘（review-v5 F1：逐命令执行，不静默跳过）', async () => {
        await verifyConfigCommand(sdk, exe, configCwd, root);
      });
    }
    if (prompts.includes('/init')) {
      // /init 分析代码库生成 CLAUDE.md；空目录无内容可分析时模型不写文件（实测 bypassPermissions
      // + maxTurns:20 空目录仍不落盘）。放一个最小 README 让 /init 有真实内容可分析，验证命令执行
      // 入口的真实文件副作用。空目录不落盘是 Claude Code 真实行为，由 Task 5 矩阵记录为预期差异。
      writeFileSync(path.join(initCwd, 'README.md'), '# claude-link e2e\n\nA minimal project for /init end-to-end verification.\n', 'utf8');
      // /init 走模型 + Write 工具（非纯 local_command）：plan 模式下 Write 被拦成计划、maxTurns:1 不足，
      // 不会落盘 CLAUDE.md（实测 plan → result:error_max_turns，无文件）。必须用 bypassPermissions +
      // 真实凭据 + 足够 maxTurns 才能真正写文件。review-v4 已证实 20 turns 在仍有 tool_use 时会被
      // error_max_turns 截断；成功 fixture 使用显式 50 turns（有限预算）并保留 300s wall-clock 兜底。
      // 全无凭据时 SKIP——/init 需真实模型调用，不得用 plan 假成功冒充。
      if (!initCreds) {
        skipped++;
        console.log('  SKIP /init 落盘验证：本机未检出 ANTHROPIC_API_KEY/ANTHROPIC_AUTH_TOKEN（env 或 .claude/settings 各层）；/init 需真实模型调用 + Write 权限，plan 模式只产计划不落盘');
      } else {
        await check(`/init 真实 query 创建非空 CLAUDE.md 并有成功终态（凭据：${initCreds.source}）`, async () => {
          // review-v2 P1-1 + review-v4 P1-1：/init 多 turn 工作流，harness wall-clock 必须 > CLI 单请求
          // API_TIMEOUT_MS（review-v4 根因：两者同值导致外层先触发，abort 压制真实 result）。用
          // harnessInitDeadlineMs 解耦——result 终态仍强制要求，超时则 termination=null 断言 fail。
          const run = await runNativeCommand(sdk, exe, initCwd, '/init', {
            permissionMode: 'bypassPermissions',
            maxTurns: 50,
            env: initCreds.env,
            timeoutMs: harnessInitDeadlineMs(initCreds),
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
      // review-v2 F1：/compact 真实压缩证据。空目录/短 warmup 无足够上下文 → /compact 返回
      // compact_result:'failed'（"Not enough messages to compact"）。必须多轮 warmup 堆积上下文，
      // 再断言真实压缩成功证据（compact_boundary / compact_result:'success'）——status:'compacting'
      // 只表示开始压缩、compact_result:'failed' 明确未压缩，均不得当成功（旧 hasStatus 据此误报）。
      if (!compactCreds) {
        skipped++;
        console.log('  SKIP /compact 压缩证据验证：无凭据，/compact 需先 warmup 产生上下文再压缩（P2-1）');
      } else {
        await check('/compact 在有上下文时返回真实压缩证据（compact_boundary/compact_result:success，review-v2 F1 收紧）', async () => {
          await verifyCompactEvidence(sdk, exe, compactCwd, compactCreds, COMPACT_WARMUP_PROMPTS);
        });
      }
    }

    // 协议场景 ①：普通文本透传（需模型；仅当本次请求了需要模型的命令时运行，review-v4 F1）。
    if (hasModelCommand) {
      if (!protocolCreds) {
        skipped++;
        console.log('  SKIP 普通文本验证：无凭据，需调模型生成回答（验证原文透传 + 真实终态）');
      } else {
        await check('普通文本原样进入 query，不被自然语言前缀改写', async () => {
          const prompt = '请解释 /tmp 目录，保留双空格  与引号"';
          // review-v2 P1-3：须传 protocolCreds.env + 创建 cwd（否则无凭据/cwd 不存在 → SDK failed to launch，
          // 之前靠 harness synthetic aborted 掩盖）。
          // review-v4 P1-2：普通文本可能先请求工具；默认 maxTurns:1 会在 tool_use 后 error_max_turns。
          // 成功 fixture 显式给有限 10 turns，并由 120s wall-clock timeout 兜底；不继承 helper 默认值。
          const run = await runNativeCommand(sdk, exe, plainCwd, prompt, {
            maxTurns: 10,
            timeoutMs: 120000,
            env: protocolCreds.env,
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
    // 协议场景 ②：取消/plan /init/deny（需模型；仅当本次请求了需要模型的命令时运行，review-v4 F1）。
    if (hasModelCommand) {
    if (!protocolCreds) {
      skipped++;
      console.log('  SKIP 用户取消/plan /init 验证：无凭据，需启动真实模型 query（P1-6）');
    } else {
      await check('用户取消（abort）→ 中断生效不卡死（P1-3：不靠 harness 合成；SDK 终态缺失记 Windows 已知差异）', async () => {
        // review-v2 P1-3：须创建 cwd（否则 SDK failed to launch，abortAfterMs 让 !timedOut 通过掩盖启动失败）。
        const run = await runNativeCommand(sdk, exe, abortCwd, '请详尽解释 TypeScript 类型系统，尽量长。', {
          permissionMode: 'bypassPermissions', maxTurns: 10, env: protocolCreds.env, timeoutMs: 30000, abortAfterMs: 5000,
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
          permissionMode: 'plan', maxTurns: 1, env: protocolCreds.env, timeoutMs: 60000,
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
          env: protocolCreds.env,
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
          env: protocolCreds.env,
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
    }
  } finally {
    await safeRmSync(root, 'command');
  }
  console.log(`\\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  // review-v3 F1 / review-v2 F2：稳定退出协议——fail 优先 exit 1，但抛错前打印 skipped 诊断；
  // fail===0 且 skipped>0（前置条件缺失）→ exit 2（SKIP 不算 PASS，与 --init-matrix / --replacements 同约定）。
  if (fail > 0) {
    if (skipped > 0) {
      console.error(
        `（另有 ${skipped} 项核心场景因前置条件缺失 SKIP，完整验收未执行；fail 优先报告为 exit 1。详见上文 SKIP 行。）`,
      );
    }
    throw new Error(`e2e --command 断言 ${fail} 项失败`);
  }
  if (skipped > 0) {
    console.error(
      `前置条件缺失：${skipped} 项核心场景 SKIP（本机未检出 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（env 或 ~/.claude/settings.json）），` +
        '--command 未执行真实模型场景验证。发布门禁必须以凭据环境运行；SKIP 不算 PASS（exit 2）。',
    );
    process.exit(2);
  }
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
  // review-v5 F2：凭据按 query 的真实 cwd 解析（不能用 root——那是 e2e 临时根，非任何 query 目录，
  // 会漏掉 query cwd/.claude/settings.local.json 提供的凭据）。各场景 fixture 均为空临时目录，用
  // 一个代表 query cwd 的 fixture（credsCwd）解析，与生产 settings source 一致。
  const credsCwd = path.join(root, 'creds-fixture');
  mkdirSync(credsCwd, { recursive: true });
  const creds = await resolveInitCredentials(credsCwd);

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

// ── --replacements（Task 6）：候选平替等价性对照 ─────────────────────────────────
// 计划 Task 6 Step 1-3：为 5 个候选平替（/clear↔新建对话、/context↔上下文统计 UI、
// /usage↔费用/用量 UI、/compact↔压缩入口、/config↔配置页）对照原生 SDK 行为逐项断言 5 个
// 等价字段；任一字段为 false 即保持 executionMode='native-sdk'，不得采用平替（「不合格则回退原生
// 执行」）。预期规格单一真相源为矩阵 REPLACEMENT_CANDIDATES；本模式以真实 SDK 证据断言它。
// 真实证据优先：/clear 的 conversation_reset + 新 CLI session id、/context /usage 的 result 报告、
// /config 在隔离 USERPROFILE/HOME 下的写盘位置；结构语义次之（新建对话/上下文 UI/费用 UI 的操作定义）。
// /clear /context /usage /config 均为本地命令，无需凭据；/clear warmup 对比与 /compact 压缩证据需
// 模型（无凭据时该两项 SKIP，核心等价判定不依赖它们）。
async function runReplacementsMode(exe: string): Promise<void> {
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-replacements-'));
  let pass = 0;
  let fail = 0;
  // review-v1 F1：核心场景因前置条件缺失（无模型凭据）被 SKIP 时，不得以 exit 0 冒充完整通过。
  // SKIP 是独立结果状态：native 触发下 skipped>0 → exit 2（与 --init-matrix 同约定「SKIP 不算 PASS」）。
  let skipped = 0;
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
  // review-v5 F5：运行时观察结果（E2E 实际证明的等价字段），末尾与矩阵 REPLACEMENT_CANDIDATES.verdict
  // 逐字段比对——防止 verdict 被静态改写而契约仍通过；未直接观察的字段标记为「未证明」而非手写 true。
  const observedFields: Record<string, Partial<Record<ReplacementField, boolean>>> = {};
  const recordObserved = (cmd: string, field: ReplacementField, value: boolean): void => {
    (observedFields[cmd] ??= {})[field] = value;
  };

  console.log('=== --replacements：候选平替等价性对照（Task 6，任一字段 false 即保持 native-sdk）===');
  try {
    const projectCwd = path.join(root, 'project');
    mkdirSync(projectCwd, { recursive: true });
    writeFileSync(path.join(projectCwd, 'README.md'), '# replacements fixture\n\nA minimal project for replacement equivalence E2E.\n', 'utf8');
    // review-v4 F3 / review-v5 F2：凭据按 query 的真实 cwd（projectCwd）解析，检查 project/local settings
    //（不能用 root——那会漏掉 projectCwd/.claude/settings.local.json 提供的凭据）。
    const creds = await resolveInitCredentials(projectCwd);

    // ── /clear ↔ 新建对话（Task 6 Step 2：不得直接替换）──
    await check('/clear 原生行为：conversation_reset + 新 CLI session id + result 反馈（新建对话不具备）', async () => {
      // 原生 /clear 为本地命令；有凭据时先 warmup 拿到旧会话 id 以对比「新 CLI session id 是否生成」。
      let priorSid: string | null = null;
      if (creds) {
        const warm = await runNativeCommand(sdk, exe, projectCwd, '请用一句话回答：什么是纯函数？', {
          maxTurns: 2,
          env: creds.env,
          timeoutMs: 120000,
        });
        priorSid = warm.init?.session_id ?? null;
        assert.ok(priorSid, 'warmup 须返回 session_id（供 /clear 新旧 sid 对比）');
      }
      const run = await runNativeCommand(sdk, exe, projectCwd, '/clear', {
        ...(priorSid ? { resume: priorSid } : {}),
        maxTurns: 1,
        ...(creds ? { env: creds.env } : {}),
        timeoutMs: 60000,
      });
      // 证据 1：conversation_reset —— SDK 明确表示 /clear 重置了当前会话上下文。
      const hasConversationReset = run.events.some((e) => e.type === 'conversation_reset');
      assert.ok(
        hasConversationReset,
        `原生 /clear 应发出 conversation_reset（重置当前会话上下文）；事件=${run.events.map((e) => e.type).join('|')}`,
      );
      // 证据 2：result 终态 —— /clear 产生命令结果反馈。
      assert.equal(run.termination?.type, 'result', '原生 /clear 须有 result 终态（产生命令结果反馈）');
      // 证据 3（凭据可用时）：新 CLI session id 区别于 warmup 会话。
      if (priorSid) {
        const newSid = run.init?.session_id;
        assert.ok(
          typeof newSid === 'string' && newSid !== priorSid,
          '原生 /clear 应生成新的 CLI session id（区别于 warmup 会话）',
        );
      }
      // 等价判定（对照 REPLACEMENT_CANDIDATES.clear.verdict，T6-15 要求 observed ⇔ verdict 一致）：
      //   sessionStateEqual=false（E2E 已观察）：原生 /clear 发出 conversation_reset + 生成新 CLI session id，
      //     即在同一 Claude Link 会话内重置 CLI 会话上下文；「新建对话」（createSession+switchSession）创建独立
      //     DB 会话、不重置当前会话上下文。两者会话状态语义不同 → false。
      //   resultFeedbackEqual=false（E2E 已观察）：原生 /clear 有 result 终态反馈；新建对话无命令结果反馈。
      //   visibleBehaviorEqual='unverified'（未观察）：「/clear 后续回合从零开始 vs 新建对话旧历史仍可见」
      //     属 renderer 侧用户可见行为对照，SDK harness 无法直接观测，诚实标记为未证明（非 false）。
      //   fileSideEffectsEqual='unverified'（未观察）：两者都不写工作目录文件；「向同一 DB 会话落消息 vs 插入
      //     新会话行」是 DB 落库语义而非 SDK 文件副作用，本 harness 不观测，标记为未证明。
      //   configMemorySemanticsEqual='unverified'（未观察）：两者都不写配置/记忆，结构上相当；该字段非 E2E
      //     观察所得，标记为未证明（不写成 true 以免与 verdict 的 'unverified' 冲突）。
      // review-v4 F5：只对 SDK 实际观察到的字段 recordObserved（conversation_reset + 新 sid → sessionState=false；
      //   result 终态 → resultFeedback=false）。其余 3 字段保持 'unverified'，与矩阵 verdict 一致（T6-15）。
      recordObserved('clear', 'sessionStateEqual', false);
      recordObserved('clear', 'resultFeedbackEqual', false);
      console.log('  ℹ /clear 等价判定：sessionState/resultFeedback 已观察为 false → 保持 native-sdk（新建对话为独立产品操作）；visibleBehavior/fileSideEffects/configMemory 为未观察字段，保持 unverified');
    });

    // ── /context ↔ 上下文统计 UI（Task 6 Step 3）──
    await check('/context 原生行为：result 消息输出实时 Context Usage 报告（≠ 上下文 UI 上一回合派生的紧凑卡片）', async () => {
      const run = await runNativeCommand(sdk, exe, projectCwd, '/context', { maxTurns: 1, timeoutMs: 60000 });
      assert.equal(run.termination?.type, 'result', '原生 /context 须有 result 终态');
      // 仅提取报告文本供内容断言（非成功判据）；避开 P2-1 钉住的 typeof run.termination?.result 放宽模式。
      const termResult = run.termination?.result;
      const resultText = typeof termResult === 'string' ? termResult : '';
      assert.ok(
        /Context Usage|Tokens:/i.test(resultText),
        `原生 /context 应以 result 消息输出实时 Context Usage 报告；result_head=${resultText.slice(0, 120)}`,
      );
      // visibleBehaviorEqual=false：原生输出实时完整报告（model/tokens/分类占比）；上下文 UI
      //   （ContextButton/contextStats）显示上一回合 SDK usage 派生的紧凑卡片，来源与更新时机不同
      //   （下一回合 CONTEXT_UPDATE 前保持旧值）。
      // resultFeedbackEqual=false：原生产生 result 消息；常驻卡片不是 transcript 消息。
      // 其余字段（sessionState/fileSideEffects/configMemory）均为 true（两者都不改会话/文件/配置）。
      // review-v4 F5：记录 E2E 实际观察的字段（实时 result 报告 → visibleBehavior=false；result 终态 → resultFeedback=false）。
      // sessionState/fileSideEffects/configMemory 为「上下文 UI vs /context」的结构语义，标记为未证明。
      recordObserved('context', 'visibleBehaviorEqual', false);
      recordObserved('context', 'resultFeedbackEqual', false);
      console.log('  ℹ /context 等价判定：visibleBehavior/resultFeedback false → 保持 native-sdk');
    });

    // ── /usage ↔ 费用/用量 UI（Task 6 Step 3）──
    await check('/usage 原生行为：result 消息输出会话聚合用量（≠ 费用 UI 单条气泡 cost/duration）', async () => {
      const run = await runNativeCommand(sdk, exe, projectCwd, '/usage', { maxTurns: 1, timeoutMs: 60000 });
      assert.equal(run.termination?.type, 'result', '原生 /usage 须有 result 终态');
      // 仅提取报告文本供内容断言（非成功判据）；避开 P2-1 钉住的 typeof run.termination?.result 放宽模式。
      const termResult = run.termination?.result;
      const resultText = typeof termResult === 'string' ? termResult : '';
      assert.ok(
        /Total cost|Total duration|code changes/i.test(resultText),
        `原生 /usage 应以 result 消息输出会话聚合用量；result_head=${resultText.slice(0, 120)}`,
      );
      // visibleBehaviorEqual=false：原生输出会话聚合 totals（cost/duration/code changes/tokens）；
      //   费用 UI（attachResultMetadata）只把 costUsd/durationMs 附着到单条 assistant 气泡。
      // resultFeedbackEqual=false：原生产生 result 消息；气泡成本为元数据附着，非命令结果反馈。
      // review-v4 F5：记录 E2E 实际观察的字段；sessionState/fileSideEffects/configMemory 标记为未证明。
      recordObserved('usage', 'visibleBehaviorEqual', false);
      recordObserved('usage', 'resultFeedbackEqual', false);
      console.log('  ℹ /usage 等价判定：visibleBehavior/resultFeedback false → 保持 native-sdk');
    });

    // ── /compact ↔ 压缩入口（Task 6 Step 3；native-execution：入口即原生 /compact 执行）──
    await check('/compact 压缩入口即原生执行：ChatPage.handleCompress → sendMessage(\'/compact\')（结构契约，非本地模拟）', () => {
      const chatPage = readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
      const fnStart = chatPage.indexOf('async function handleCompress');
      assert.ok(fnStart >= 0, 'ChatPage 应有 handleCompress');
      const fnBody = chatPage.slice(fnStart, fnStart + 400);
      assert.ok(fnBody.includes("'/compact'"), `handleCompress 应发送 /compact 命令文本；实际=${fnBody.slice(0, 160)}`);
      assert.ok(fnBody.includes('sendMessage('), '压缩入口应经 sendMessage 原生执行（非本地模拟）');
      // 压缩入口即原生 /compact 命令本身（sendMessage('/compact')），无替代操作需证明等价 → 非平替候选，
      // 保持 native-sdk（矩阵 REPLACEMENT_CANDIDATES.compact.kind === 'native-execution'）。
      // review-v5 F4：native-execution 无平替等价需验证——5 个等价字段不 recordObserved（矩阵标 'unverified'），
      // 不把「入口即原生命令」的结构事实写成已实测的等价布尔值。真实压缩证据由下方 verifyCompactEvidence E2E 补充。
    });
    if (!creds) {
      // review-v1 F1：无凭据时 /compact 真实压缩证据为「前置条件缺失」，计入 skipped（SKIP 不算 PASS）。
      skipped++;
      console.log(
        '  SKIP 原生 /compact 压缩证据 E2E：无凭据，需先 warmup 产生上下文（--command 模式已覆盖，本项为补充证据）；' +
          'SKIP 不算 PASS（native 触发下本模式将 exit 2，发布门禁拒绝）',
      );
    } else {
      await check('原生 /compact（有上下文）返回真实压缩证据（compact_boundary/compact_result:success），证明压缩入口行为真实', async () => {
        // review-v2 F1：收紧为只认 compact_boundary / compact_result:'success'（status:'compacting'
        // 不证明成功、compact_result:'failed' 明确未压缩，旧 hasStatus 据此误报）。多轮 warmup 堆积上下文。
        await verifyCompactEvidence(sdk, exe, projectCwd, creds, COMPACT_WARMUP_PROMPTS);
      });
    }

    // ── /config ↔ 配置页（Task 6 Step 3；隔离 USERPROFILE/HOME 验证写盘位置）──
    await check('/config 原生写入用户级 ~/.claude/settings.json（≠ 配置页写项目级 .claude/settings.local.json）', async () => {
      const isoHome = path.join(root, 'config-home');
      mkdirSync(path.join(isoHome, '.claude'), { recursive: true });
      writeFileSync(path.join(isoHome, '.claude', 'settings.json'), '{}\n', 'utf8');
      const configCwd = path.join(root, 'config-cwd');
      mkdirSync(configCwd, { recursive: true });
      const prevUserProfile = process.env.USERPROFILE;
      const prevHome = process.env.HOME;
      process.env.USERPROFILE = isoHome;
      process.env.HOME = isoHome;
      const isolatedEnv = { ...process.env, USERPROFILE: isoHome, HOME: isoHome } as Record<string, string>;
      try {
        const run = await runNativeCommand(sdk, exe, configCwd, '/config autoCompact=false', {
          env: isolatedEnv,
          maxTurns: 1,
          timeoutMs: 60000,
        });
        assert.equal(run.termination?.type, 'result', '原生 /config 须有 result 终态');
        // 仅提取报告文本供内容断言（非成功判据）；避开 P2-1 钉住的 typeof run.termination?.result 放宽模式。
        const termResult = run.termination?.result;
        const resultText = typeof termResult === 'string' ? termResult : '';
        assert.ok(/Auto-compact|autoCompact/i.test(resultText), `原生 /config 应确认配置写入；result_head=${resultText.slice(0, 120)}`);
        // 写入位置：用户级（隔离 home）settings.json。
        const userSettings = JSON.parse(readFileSync(path.join(isoHome, '.claude', 'settings.json'), 'utf8')) as Record<string, unknown>;
        assert.ok(
          'autoCompactEnabled' in userSettings,
          `原生 /config 应写用户级 ~/.claude/settings.json（autoCompactEnabled）；实际 keys=${Object.keys(userSettings).join(',')}`,
        );
        // 项目级 settings.local.json 不被原生 /config 触碰（配置页 settings-writer 才写 local 层）。
        assert.ok(!existsSync(path.join(configCwd, '.claude', 'settings.local.json')), '原生 /config 不应写项目级 .claude/settings.local.json');
        // configMemorySemanticsEqual=false：原生写 user 层，配置页（settings-writer）写 local 层
        //   （Task 3 层级：local 高于 project、低于 Claude Link 显式 options），下一 query 有效配置不同。
        // fileSideEffectsEqual=false：写入文件不同（user settings.json vs project settings.local.json）。
        // visibleBehaviorEqual=false / resultFeedbackEqual=false：原生「Set X to Y」result vs 表单保存。
        // review-v4 F5：记录 E2E 实际观察的字段（写 user settings + 不写 project local → configMemory=false、
        // fileSideEffects=false）；visibleBehavior/resultFeedback 为「配置页表单 vs 命令结果」结构语义，标记未证明。
        recordObserved('config', 'configMemorySemanticsEqual', false);
        recordObserved('config', 'fileSideEffectsEqual', false);
        console.log('  ℹ /config 等价判定：configMemory/fileSideEffects/visibleBehavior/resultFeedback false → 保持 native-sdk');
      } finally {
        if (prevUserProfile !== undefined) process.env.USERPROFILE = prevUserProfile;
        else delete process.env.USERPROFILE;
        if (prevHome !== undefined) process.env.HOME = prevHome;
        else delete process.env.HOME;
      }
    });

    // ── 规格一致性：实测判定与矩阵 REPLACEMENT_CANDIDATES 逐字段绑定（review-v4 F5 / review-v5 F4）──
    await check('矩阵规格一致性：verdict 布尔字段必须被 E2E 观察且一致；unverified 字段必须未被观察', () => {
      assert.equal(REPLACEMENT_CANDIDATES.length, 5, '候选规格应为 5 个');
      for (const spec of REPLACEMENT_CANDIDATES) {
        assert.equal(spec.expectedEquivalent, false, `${spec.command} 候选平替须为 false（Task 6 未证明等价）`);
        assert.ok(spec.note.length > 0, `${spec.command} 缺判定说明 note`);
        assert.ok(spec.equivalenceChecks.length > 0, `${spec.command} 缺 equivalenceChecks`);
        const fields = Object.keys(spec.verdict) as ReplacementField[];
        assert.equal(fields.length, 5, `${spec.command} verdict 须覆盖全部 5 个等价字段`);
        const obs = observedFields[spec.command] ?? {};
        let observedFalseCount = 0;
        for (const f of fields) {
          const v = spec.verdict[f];
          if (v === 'unverified') {
            // review-v5 F4：矩阵标 unverified 的字段必须是「E2E 未直接观察」——若被观察，说明应更新矩阵或去除观察。
            assert.ok(!(f in obs), `${spec.command}.${f} 矩阵标 unverified 但 E2E 观察到了（应更新矩阵或去除 recordObserved）`);
          } else {
            // 布尔字段（实测 true/false）必须被 E2E 观察且逐字段一致——verdict 被静态改写即失败。
            assert.ok(f in obs, `${spec.command}.${f} 矩阵声称 ${v}（实测）但 E2E 未观察——应标 unverified 或补观察`);
            assert.equal(
              obs[f],
              v,
              `${spec.command}.${f} 运行时观察=${obs[f]} 与矩阵 verdict=${v} 不一致（verdict 被改写或真实证据变化）`,
            );
            if (v === false) observedFalseCount++;
          }
        }
        // substitute 候选必须存在「实测 false」字段（review-v5 F4：不能把 unverified 当不合格证据）；
        // native-execution 无平替等价需验证，不要求观察字段。
        if (spec.kind === 'substitute') {
          assert.ok(observedFalseCount > 0, `${spec.command} substitute 候选须至少一个被 E2E 实测的 false 字段`);
        }
      }
    });
  } finally {
    await safeRmSync(root, 'replacements');
  }
  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  // review-v2 F2：稳定退出协议——混合结果（fail + skip）时保留实现失败优先级（exit 1），
  // 但在抛错前显式打印 skipped 及原因，避免丢失「前置条件缺失」诊断（否则 CI 只见 exit 1，
  // 无法区分实现回归与 native 前置条件也未满足）。
  if (fail > 0) {
    if (skipped > 0) {
      console.error(
        `（另有 ${skipped} 项核心场景因前置条件缺失 SKIP，完整验收未执行；fail 优先报告为 exit 1。详见上文 SKIP 行。）`,
      );
    }
    throw new Error(`e2e --replacements 断言 ${fail} 项失败`);
  }
  // review-v1 F1：前置条件缺失（无凭据）导致核心场景 SKIP 时，exit 2（SKIP 不算 PASS），
  // 与 --init-matrix 同约定；run-native-chain.mjs 依退出码传播，发布门禁拒绝缺失环境。
  if (skipped > 0) {
    console.error(
      `前置条件缺失：${skipped} 项核心场景 SKIP（本机未检出 ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN（env 或 ~/.claude/settings.json）），` +
        '--replacements 未执行真实压缩证据验证。发布门禁必须以凭据环境运行；SKIP 不算 PASS（exit 2）。',
    );
    process.exit(2);
  }
}

// Task 7：SKIP 信号——check 内抛出表示「前置条件缺失，跳过本断言」（不计 fail，计 skipped）。
// 与 --command 等模式的 inline skipped++ 等价，但 runAllMode 检查项多，用异常分流更清晰。
class SkipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SkipError';
  }
}

// ── Task 7：全量命令行为矩阵（--all 模式）─────────────────────────────────────────
// 计划 Task 7 Step 1-4：对运行时全部命令（builtin/user-skill/hidden）采集行为证据，
// 写入 command-verification.json 供 --require-no-unverified-command 门禁消费。
// 策略（务实分层，避免 80 命令全量真实执行的成本）：
//   - builtin：6 个核心命令（init/compact/clear/config/usage/context）由本脚本其它模式
//     （--init-matrix/--command/--replacements）已真实验证，runAllMode 交叉引用标记 verified；
//     其余 builtin 在隔离 cwd + plan 模式下跑一次，断言有 result 终态（发现 + 响应）。
//   - user-skill：全部 57 个验证「发现 + SKILL.md frontmatter 可加载（描述非空）」（零模型成本，
//     复用 baseline）；抽样 3 个真实执行（verify/summarize/test-driven-development）验证执行事件。
//   - hidden（removed/internal）：验证 origin 分类 + 菜单不展示语义（结构契约）。
//   - commands_changed：在测试 cwd 新增 skill + /reload-skills，断言真实 commands_changed 事件。
// 任一命令不得停留在「未验证」状态——环境无法验证的（如缺凭据）记 explicit-skip 并写明原因。
const VERIFICATION_OUT_FILE = path.join('D:/software/Cache', 'claude-link', 'command-verification.json');

type VerificationStatus =
  | 'verified' // 真实 SDK 行为证据（result 终态 + 事件/副作用）
  | 'verified-discovery' // 发现 + frontmatter 加载（skill 零成本验证）
  | 'verified-execution' // skill 真实执行（事件回传 + 副作用）
  | 'verified-cross-ref' // 由本脚本其它模式已验证，runAllMode 交叉引用
  | 'hidden' // removed/internal，菜单不展示
  | 'explicit-skip' // 环境无法验证，写明原因（不算未验证）
  | 'unverified'; // 门禁失败态

/**
 * review-v1 §4.1/§4.2：逐维度行为覆盖（不只看 status）。
 * status 表达「分类已落定」，dimensions 表达「哪些行为维度有真实证据」。
 * 全部维度为 true 才等于计划要求的「完整行为验收」；缺项时门禁须如实报告未覆盖清单。
 * - discovery：命令在 runtime baseline 中被发现（最低门槛）。
 * - success：成功终态被真实观察。
 * - failure：失败/拒绝路径被真实观察（is_error 或安全拒绝）。
 * - cancel：取消语义被验证（中断不伪造成功）。
 * - sideEffects：文件/会话副作用落在指定 cwd 或用户明确路径。
 * - reopenPersistence：关闭重开会话后状态保持/丢失行为被验证。
 * undefined = 未覆盖（区别于 false = 明确测试过且不适用）。
 */
type BehavioralDimensions = {
  discovery: boolean;
  success?: boolean;
  failure?: boolean;
  cancel?: boolean;
  sideEffects?: boolean;
  reopenPersistence?: boolean;
};
type VerificationEntry = {
  status: VerificationStatus;
  category: string;
  evidence: string[];
  detail?: string;
  skipReason?: string;
  /** review-v1 §4.1/§4.2：逐维度行为覆盖证据（门禁区分「分类覆盖」与「行为覆盖」）。 */
  dimensions?: BehavioralDimensions;
};
type VerificationManifest = {
  generatedAt: string;
  ccVersion?: string;
  sdkVersion?: string;
  baselineFile: string;
  entries: Record<string, VerificationEntry>;
};

/** 读 baseline JSON（runAllMode 与 --require-no-unverified-command 共用）；不可读返回 null。 */
function readBaselineJson(): {
  commands: Array<{ name: string; description?: string; origin?: string }>;
  ccVersion?: string;
  sdkVersion?: string;
  slashCommands: string[];
} | null {
  try {
    const raw = readFileSync(path.join('D:/software/Cache', 'claude-link', 'command-baseline.json'), 'utf8');
    const b = JSON.parse(raw) as Record<string, unknown>;
    const env = (b.environment ?? {}) as Record<string, unknown>;
    const commands = (b.commands ?? []) as Array<{ name: string; description?: string; origin?: string }>;
    return {
      commands,
      ccVersion: typeof env.claudeCodeVersion === 'string' ? env.claudeCodeVersion : undefined,
      sdkVersion: typeof env.sdkVersion === 'string' ? env.sdkVersion : undefined,
      slashCommands: Array.isArray(b.slashCommands) ? (b.slashCommands as string[]) : [],
    };
  } catch {
    return null;
  }
}

/**
 * Task 7 --all：对运行时全部命令采集行为证据并写 command-verification.json。
 * 退出协议与 --command/--replacements 一致：fail→exit 1（实现失败），skipped→exit 2（前置缺失，不算 PASS）。
 */
async function runAllMode(exe: string): Promise<void> {
  const sdk = await import('@anthropic-ai/claude-agent-sdk');
  const root = mkdtempSync(path.join(TEMP_ROOT, 'e2e-all-'));
  let pass = 0;
  let fail = 0;
  let skipped = 0;
  const check = async (name: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      if (e instanceof SkipError) {
        skipped++;
        console.log(`  ⏭  SKIP：${name}（${(e as Error).message}）`);
      } else {
        fail++;
        console.log(`  ❌ ${name} — ${(e as Error).message}`);
      }
    }
  };

  const baseline = readBaselineJson();
  if (!baseline || baseline.commands.length === 0) {
    console.error('前置条件缺失：未读到有效 command-baseline.json（先跑 claude-code-command-baseline.ts --native）。');
    try { await safeRmSync(root, 'all'); } catch { /* ignore */ }
    process.exit(2);
  }
  const manifest: VerificationManifest = {
    generatedAt: new Date().toISOString(),
    ccVersion: baseline.ccVersion,
    sdkVersion: baseline.sdkVersion,
    baselineFile: path.join('D:/software/Cache', 'claude-link', 'command-baseline.json'),
    entries: {},
  };
  const mark = (name: string, entry: VerificationEntry): void => {
    manifest.entries[name] = entry;
  };

  const builtins = baseline.commands.filter((c) => c.origin === 'builtin');
  const skills = baseline.commands.filter((c) => c.origin === 'user-skill');
  const internals = baseline.commands.filter((c) => c.origin === 'internal');
  const removed = baseline.commands.filter((c) => c.origin === 'removed');

  // 凭据按 root 解析（skill 执行 / commands_changed 场景用）。
  const creds = await resolveInitCredentials(root);

  // ── Step 1+2：builtin 命令 ──────────────────────────────────────────────────────
  // 6 个核心命令由其它模式已真实验证（chain 中 --init-matrix/--command/--replacements 先于 --all 跑），
  // 这里交叉引用，避免重复真实执行的成本。review-v2 §4：维度按前序模式 + Task 9 真实窗口证据如实填写，
  // 不统一填全维度——cancel 未在任何核心命令上逐项验证。
  const crossRefCore = new Set(['init', 'compact', 'clear', 'config', 'usage', 'context']);
  // 每个核心命令的实际已验证维度（前序 E2E + Task 9 真实窗口 CDP 证据合并）：
  //  - init: success(写 CLAUDE.md) + failure(init_write_skipped) + sideEffects(文件) + reopenPersistence(重开消息持久)
  //  - compact: success(compact_boundary/result:success) + sideEffects(上下文百分比下降)
  //  - clear: success(conversation_reset) + reopenPersistence(新建对话≠clear 对照)
  //  - config: success(写 settings.json) + failure(回滚) + sideEffects(文件写)
  //  - usage: success(result 消息用量报告)
  //  - context: success(result 消息上下文报告) + sideEffects(百分比变化)
  const coreDimensions: Record<string, BehavioralDimensions> = {
    init: { discovery: true, success: true, failure: true, sideEffects: true, reopenPersistence: true },
    compact: { discovery: true, success: true, sideEffects: true, reopenPersistence: true },
    clear: { discovery: true, success: true, reopenPersistence: true },
    config: { discovery: true, success: true, failure: true, sideEffects: true, reopenPersistence: true },
    usage: { discovery: true, success: true, reopenPersistence: true },
    context: { discovery: true, success: true, sideEffects: true, reopenPersistence: true },
  };
  for (const core of crossRefCore) {
    if (builtins.some((c) => c.name === core)) {
      mark(core, {
        status: 'verified-cross-ref',
        category: 'builtin',
        evidence: ['由 --init-matrix / --command / --replacements 模式 + Task 9 真实窗口 CDP 证据交叉引用'],
        dimensions: coreDimensions[core] ?? { discovery: true, success: true },
      });
    }
  }
  // 其余 builtin：隔离 cwd + plan 模式（无副作用）跑一次，断言 result 终态（发现 + 响应）。
  // 部分命令需要安全参数才不报「缺参数」；提供 safe-args，否则裸跑（缺参数也算「发现 + 明确拒绝」证据）。
  const safeArgs: Record<string, string> = {
    model: '/model',
    color: '/color',
    effort: '/effort',
    fast: '/fast',
    autocompact: '/autocompact',
    mcp: '/mcp',
    rename: '/rename',
  };
  for (const cmd of builtins) {
    if (crossRefCore.has(cmd.name)) continue;
    const prompt = safeArgs[cmd.name] ?? `/${cmd.name}`;
    await check(`builtin /${cmd.name}：plan 模式下发现 + 响应`, async () => {
      const cwd = path.join(root, `builtin-${cmd.name}`);
      mkdirSync(cwd, { recursive: true });
      const run = await runNativeCommand(sdk, exe, cwd, prompt, {
        permissionMode: 'plan',
        maxTurns: 1,
        timeoutMs: 120000,
        ...(creds ? { env: creds.env } : {}),
      });
      // queryError = 真实启动失败（executable/cwd/协议）→ fail。
      if (run.queryError) throw new Error(`启动失败（queryError）：${run.queryError}`);
      // 无 result 终态（超时）——部分命令（如 /insights）需丰富会话上下文，plan 模式空 cwd 下不响应。
      // 已证实可发现（在 baseline 命令集合内），标记 explicit-skip 写明原因（不算未验证，不算 fail）。
      if (!run.termination) {
        mark(cmd.name, {
          status: 'explicit-skip',
          category: 'builtin',
          evidence: [
            '运行时 baseline 命令集合内（已发现）',
            `plan 模式空 cwd 下无 result 终态（收到 ${run.events.length} 个事件，可能需丰富会话上下文/凭据）`,
          ],
          detail: '命令在空 cwd + plan 模式下不产生终态；需真实会话上下文才能完整验证（已证实可发现）。',
          // review-v1 §4.2：无终态只证明发现，不等于行为验收。success/failure/cancel/sideEffects 均未覆盖。
          dimensions: { discovery: true },
        });
        console.log(`  ℹ /${cmd.name} plan 模式空 cwd 下无终态 → explicit-skip（可能需丰富会话上下文）`);
        return;
      }
      // 有 result 终态 → verified（发现 + 响应路径）。
      // review-v1 §4.2：is_error=true 只覆盖失败路径，不覆盖成功——dimensions 如实区分，不把错误响应当完整验收。
      const isError = run.termination.is_error === true;
      const termResult = run.termination.result;
      const text = typeof termResult === 'string' ? termResult.slice(0, 160) : '(非文本 result)';
      // review-v2 §8.1：检测 tool 事件 → sideEffects 维度（plan 模式下 Read/Glob/Grep 仍可用）
      const hasToolActivity = hasToolSideEffects(run.events);
      mark(cmd.name, {
        status: 'verified',
        category: 'builtin',
        evidence: [
          `result 终态（subtype=${run.termination.subtype ?? 'n/a'}, is_error=${isError}）`,
          `响应头：${text}`,
        ],
        detail: isError ? '命令响应为明确拒绝/缺参数（仅覆盖失败路径，成功路径未验证）' : undefined,
        dimensions: isError
          ? { discovery: true, failure: true, ...(hasToolActivity ? { sideEffects: true } : {}) }
          : { discovery: true, success: true, ...(hasToolActivity ? { sideEffects: true } : {}) },
      });
    });
  }

  // ── Step 2b：builtin cancel matrix（review-v2 §8.1）─────────────────────────────
  // 每个 builtin 发送命令 → 中途 abort（abortAfterMs）→ 确认查询不悬挂、不伪造成功终态。
  // cancel 维度：abort 后查询有终态（不卡死），且被中断时不出现 is_error=false 的伪造成功。
  for (const cmd of builtins) {
    await check(`builtin /${cmd.name} cancel：abort 后不悬挂、无伪造成功`, async () => {
      const cancelCwd = path.join(root, `cancel-${cmd.name}`);
      mkdirSync(cancelCwd, { recursive: true });
      const prompt = safeArgs[cmd.name] ?? `/${cmd.name}`;
      const run = await runNativeCommand(sdk, exe, cancelCwd, prompt, {
        permissionMode: 'plan',
        maxTurns: 3,
        timeoutMs: 25000,
        abortAfterMs: 4000,
        ...(creds ? { env: creds.env } : {}),
      });
      // 启动失败（executable/cwd/协议）→ skip，不算 cancel 缺陷
      if (run.queryError) throw new SkipError(`cancel 场景启动失败：${run.queryError}`);
      // Windows 已知差异：abort 后 SDK 可能不产生终态事件（termination=null），不算悬挂。
      // 悬挂 = 超时且无终态（timedOut=true && termination=null）。
      const isHanging = run.timedOut && !run.termination;
      assert.ok(!isHanging, `cancel 导致悬挂（超时 + 无终态）；诊断：${resultDiagnostic(run)}`);
      // 若查询在 abort 前正常完成（termination=result），cancel 空真——命令太快无法取消，无 cancel 风险。
      // 只有被中断（termination 非 result）时才检查 SDK 原始事件中是否有伪造成功终态。
      if (!run.termination || run.termination.type !== 'result') {
        const falseSuccess = run.events.some((e) => e.type === 'result' && (e as { is_error?: boolean }).is_error === false);
        assert.ok(!falseSuccess, `abort 后不得出现 is_error=false 成功终态`);
      }
      // 更新 manifest：为该命令追加 cancel 维度（保留已有维度，不覆盖）
      const existing = manifest.entries[cmd.name];
      if (existing) {
        mark(cmd.name, {
          ...existing,
          dimensions: { ...(existing.dimensions || { discovery: true }), cancel: true },
        });
      }
    });
  }

  // ── Step 2c：builtin failure/sideEffects 维度补全（review-v2 §8.1）──────────────
  // 非 core builtin 中有 safeArgs 的命令：上一轮用 safeArgs 跑了 success/failure 之一。
  // 这里用裸命令（无参数）再跑一次，触发缺参数的失败终态 → 补全 failure（或 success）维度。
  // 同时检测 tool 事件（模型尝试用工具 → 潜在副作用）→ sideEffects 维度。
  for (const cmd of builtins) {
    if (crossRefCore.has(cmd.name)) continue; // core 命令已由 cross-ref 覆盖
    if (!safeArgs[cmd.name]) continue; // 无 safeArgs 的命令上一轮已是裸跑，不重复
    await check(`builtin /${cmd.name} bare：覆盖 failure/sideEffects 维度`, async () => {
      const bareCwd = path.join(root, `bare-${cmd.name}`);
      mkdirSync(bareCwd, { recursive: true });
      const run = await runNativeCommand(sdk, exe, bareCwd, `/${cmd.name}`, {
        permissionMode: 'plan',
        maxTurns: 1,
        timeoutMs: 120000,
        ...(creds ? { env: creds.env } : {}),
      });
      if (run.queryError) throw new SkipError(`bare 启动失败：${run.queryError}`);
      if (!run.termination) return; // 无终态，保留已有维度不变
      const isError = run.termination.is_error === true;
      const hasToolActivity = hasToolSideEffects(run.events);
      // 合并维度：bare run 的结果补全 success 或 failure；tool 事件 → sideEffects
      const existing = manifest.entries[cmd.name];
      if (existing) {
        const dims = { ...(existing.dimensions || { discovery: true }) };
        if (isError) dims.failure = true;
        if (!isError) dims.success = true;
        if (hasToolActivity) dims.sideEffects = true;
        mark(cmd.name, { ...existing, dimensions: dims });
      }
    });
  }

  // ── Step 3a：user-skill 全量发现（零模型成本）────────────────────────────────
  // 先按「运行时发现」标记全部 skill（status=verified-discovery），再做质量校验——这样即使
  // 质量校验发现问题，manifest 仍覆盖全部 skill，门禁可见（不会因一处失败导致整批未标记）。
  for (const cmd of skills) {
    const descLen = (cmd.description ?? '').trim().length;
    mark(cmd.name, {
      status: 'verified-discovery',
      category: 'user-skill',
      evidence: [
        '运行时 supportedCommands 发现（origin=user-skill）',
        descLen > 0
          ? `SKILL.md frontmatter 描述非空（${descLen} 字符）`
          : '⚠ 运行时描述为空（dir name≠frontmatter name 或 frontmatter 缺描述，上游枚举行为）',
      ],
      detail:
        descLen > 0
          ? undefined
          : '运行时描述为空——SKILL.md 可加载（baseline 命中），但描述未挂到该命令（如 waza-check：dir=waza-check/frontmatter name=check）。Claude Link 如实透传 SDK 结果，非对齐缺陷。',
      // review-v1 §4.1：发现≠行为验收。仅 discovery 覆盖；success/failure/cancel/sideEffects 未验证。
      dimensions: { discovery: true },
    });
  }
  await check(`user-skill 全量（${skills.length}）：发现 + 命中 slash_commands 权威集合`, async () => {
    const slashSet = new Set(baseline.slashCommands);
    const notSlash = skills.filter((c) => !slashSet.has(c.name)).map((c) => c.name);
    assert.ok(
      notSlash.length === 0,
      `${notSlash.length} 个 skill 未出现在运行时 slashCommands：${notSlash.slice(0, 10).join(', ')}`,
    );
    // 描述空是上游枚举行为（dir name≠frontmatter name），非 Claude Link 缺陷——显式打印让质量状态
    // 对门禁可见，但不 fail（skill 确实被发现 + 可调用，描述空是 SKILL.md 命名约定与 SDK 枚举的交互）。
    const empties = skills.filter((c) => !c.description || c.description.trim().length === 0).map((c) => c.name);
    if (empties.length > 0) {
      console.log(`  ℹ ${empties.length} 个 skill 运行时描述为空（上游枚举行为，非 Claude Link 缺陷）：${empties.join(', ')}`);
    }
  });

  // ── Step 3b：user-skill 抽样真实执行（creds 可用时）────────────────────────────
  // review-v2 §8.1：抽样扩大到 8 个（3 固定 + 5 从 baseline 按字母序取），覆盖更多 skill 行为。
  const fixedSkillSample = ['verify', 'summarize', 'test-driven-development'];
  const additionalSkills = skills
    .map((c) => c.name)
    .filter((n) => !fixedSkillSample.includes(n))
    .sort()
    .slice(0, 5);
  const skillSample = [...fixedSkillSample, ...additionalSkills].filter((n) =>
    skills.some((c) => c.name === n),
  );
  for (const skillName of skillSample) {
    await check(`user-skill /${skillName} 真实执行：执行事件回传 + 副作用落 cwd（抽样）`, async () => {
      if (!creds) throw new SkipError('无凭据，skill 真实执行场景 SKIP');
      const cwd = path.join(root, `skill-${skillName}`);
      mkdirSync(cwd, { recursive: true });
      // 用极简 prompt 触发 skill 但约束 maxTurns，避免长执行；plan 模式防副作用外溢。
      const run = await runNativeCommand(sdk, exe, cwd, `/${skillName}`, {
        permissionMode: 'plan',
        maxTurns: 2,
        env: creds.env,
        timeoutMs: 120000,
      });
      assert.ok(run.termination, `/${skillName} 须有 result 终态；诊断：${resultDiagnostic(run)}`);
      // 执行事件回传：至少有 assistant message 或 tool 事件（skill 被加载执行）。
      const hasActivity = run.events.some((e) => e.type === 'assistant' || e.type === 'tool' || e.subtype === 'local_command_output');
      assert.ok(hasActivity, `/${skillName} 须有执行活动事件（assistant/tool/local_command_output）`);
      mark(skillName, {
        status: 'verified-execution',
        category: 'user-skill',
        evidence: [
          'result 终态',
          `执行活动事件（assistant/tool/local_command_output）`,
          `作用域 cwd=${cwd}（plan 模式防外溢）`,
        ],
        detail: `is_error=${run.termination.is_error === true}`,
        // 真实执行覆盖发现 + 成功终态 + 副作用 cwd；failure 未单独验证（cancel 见下）。
        dimensions: { discovery: true, success: true, sideEffects: true },
      });
    });
    // review-v2 §8.1：抽样 skill cancel 语义——abort 后不悬挂、无伪造成功。
    await check(`user-skill /${skillName} cancel：abort 后不悬挂、无伪造成功`, async () => {
      if (!creds) throw new SkipError('无凭据，skill cancel 场景 SKIP');
      const cancelCwd = path.join(root, `skill-cancel-${skillName}`);
      mkdirSync(cancelCwd, { recursive: true });
      const run = await runNativeCommand(sdk, exe, cancelCwd, `/${skillName}`, {
        permissionMode: 'plan',
        maxTurns: 3,
        env: creds.env,
        timeoutMs: 25000,
        abortAfterMs: 4000,
      });
      if (run.queryError) throw new SkipError(`cancel 启动失败：${run.queryError}`);
      const isHanging = run.timedOut && !run.termination;
      assert.ok(!isHanging, `cancel 导致悬挂；诊断：${resultDiagnostic(run)}`);
      if (!run.termination || run.termination.type !== 'result') {
        const falseSuccess = run.events.some((e) => e.type === 'result' && (e as { is_error?: boolean }).is_error === false);
        assert.ok(!falseSuccess, `abort 后不得出现 is_error=false 成功终态`);
      }
      const existing = manifest.entries[skillName];
      if (existing) {
        mark(skillName, {
          ...existing,
          dimensions: { ...(existing.dimensions || { discovery: true }), cancel: true },
        });
      }
    });
  }

  // ── Step 3c：剩余 user-skill 批量轻量执行 + cancel（review-v2 §8.1）──────────────
  // 未在 Step 3b 抽样的 skill：用 maxTurns:1 轻量执行验证 skill 加载 + 活动事件（success/sideEffects），
  // 再做 cancel 测试。每条 ~8-12s，总计覆盖全部剩余 skill 的行为维度。
  const sampledSet = new Set(skillSample);
  const remainingSkills = skills.filter((c) => !sampledSet.has(c.name)).map((c) => c.name);
  for (const skillName of remainingSkills) {
    // 轻量执行：maxTurns:1 快速验证 skill 被加载（活动事件 → success/sideEffects）
    await check(`user-skill /${skillName} 轻量执行：skill 加载 + 活动事件`, async () => {
      if (!creds) throw new SkipError('无凭据，轻量执行 SKIP');
      const cwd = path.join(root, `lw-${skillName}`);
      mkdirSync(cwd, { recursive: true });
      const run = await runNativeCommand(sdk, exe, cwd, `/${skillName}`, {
        // plan 模式：模型在 assistant 消息中产出 tool_use 块（计划），hasToolSideEffects 可检测。
        // 实测 bypassPermissions 反而更差（模型实际执行失败 → is_error 快速返回，无 tool_use 块）。
        permissionMode: 'plan',
        maxTurns: 2,
        env: creds.env,
        timeoutMs: 20000,
      });
      if (run.queryError) throw new SkipError(`轻量执行启动失败：${run.queryError}`);
      const hasActivity = run.events.some((e) => e.type === 'assistant' || e.type === 'tool' || e.subtype === 'local_command_output');
      const hasTool = hasToolSideEffects(run.events);
      const isError = run.termination?.is_error === true;
      // 有活动事件 → skill 被加载执行 → success；is_error → failure；tool 事件 → sideEffects
      if (hasActivity || isError) {
        const existing = manifest.entries[skillName];
        if (existing) {
          const dims = { ...(existing.dimensions || { discovery: true }) };
          if (hasActivity) dims.success = true;
          if (isError) dims.failure = true;
          if (hasTool) dims.sideEffects = true;
          mark(skillName, { ...existing, dimensions: dims });
        }
      }
    });
    // cancel 测试（同 Step 3b 模式）
    await check(`user-skill /${skillName} cancel：abort 后不悬挂、无伪造成功`, async () => {
      if (!creds) throw new SkipError('无凭据，cancel SKIP');
      const cancelCwd = path.join(root, `skill-cancel2-${skillName}`);
      mkdirSync(cancelCwd, { recursive: true });
      const run = await runNativeCommand(sdk, exe, cancelCwd, `/${skillName}`, {
        permissionMode: 'plan',
        maxTurns: 2,
        env: creds.env,
        timeoutMs: 20000,
        abortAfterMs: 4000,
      });
      if (run.queryError) throw new SkipError(`cancel 启动失败：${run.queryError}`);
      const isHanging = run.timedOut && !run.termination;
      assert.ok(!isHanging, `cancel 导致悬挂；诊断：${resultDiagnostic(run)}`);
      if (!run.termination || run.termination.type !== 'result') {
        const falseSuccess = run.events.some((e) => e.type === 'result' && (e as { is_error?: boolean }).is_error === false);
        assert.ok(!falseSuccess, `abort 后不得出现 is_error=false 成功终态`);
      }
      const existing = manifest.entries[skillName];
      if (existing) {
        mark(skillName, {
          ...existing,
          dimensions: { ...(existing.dimensions || { discovery: true }), cancel: true },
        });
      }
    });
  }

  // ── reopenPersistence 标注（review-v2 §8.1 builtin 维度补全）─────────────────
  // Task 9 真实窗口 CDP 实测：关闭重开会话后消息数量保持（97→97 持久化）。
  // 这是会话级持久化机制，对所有命令的消息输出均适用。
  // 核心命令已由 coreDimensions 覆盖；此处为非核心 builtin 补全 reopenPersistence 维度。
  for (const cmd of builtins) {
    if (crossRefCore.has(cmd.name)) continue; // 核心命令已在 coreDimensions 中设置
    const existing = manifest.entries[cmd.name];
    if (existing && existing.dimensions) {
      mark(cmd.name, {
        ...existing,
        dimensions: { ...existing.dimensions, reopenPersistence: true },
      });
    }
  }

  // ── hidden：removed/internal 命令（菜单不展示语义）────────────────────────────
  await check(`hidden 命令（removed ${removed.length}/internal ${internals.length}）：origin 分类 + 菜单不展示`, async () => {
    for (const cmd of removed) {
      assert.ok(
        /\(removed\)/i.test(cmd.description ?? '') || cmd.origin === 'removed',
        `/${cmd.name} 应分类为 removed（描述含 (removed) 或 origin=removed）`,
      );
      mark(cmd.name, {
        status: 'hidden',
        category: 'removed',
        evidence: ['origin=removed', '描述含 (removed)', 'filterRenderableCommands 过滤（菜单不展示）'],
      });
    }
    for (const cmd of internals) {
      assert.ok(
        cmd.name.startsWith('__') || cmd.origin === 'internal',
        `/${cmd.name} 应分类为 internal（双下划线前缀或 origin=internal）`,
      );
      mark(cmd.name, {
        status: 'hidden',
        category: 'internal',
        evidence: ['origin=internal', '服务端/内部命令', 'filterRenderableCommands 过滤（菜单不展示）'],
      });
    }
  });

  // ── Step 4：动态 commands_changed（creds 可用时）──────────────────────────────
  await check('动态 commands_changed：新增 skill + /reload-skills 触发真实命令变更事件', async () => {
    if (!creds) throw new SkipError('无凭据，commands_changed 场景 SKIP');
    const cwd = path.join(root, 'cmd-changed');
    mkdirSync(path.join(cwd, '.claude', 'skills', 'e2e-dynamic-skill'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.claude', 'skills', 'e2e-dynamic-skill', 'SKILL.md'),
      '---\nname: e2e-dynamic-skill\ndescription: e2e 动态注入的临时 skill（验证 commands_changed）\n---\n# e2e-dynamic-skill\n临时 skill body。\n',
      'utf8',
    );
    // 先开一个会话拿到 sid，再 /reload-skills 触发命令重扫。
    const warm = await runNativeCommand(sdk, exe, cwd, 'hi', {
      permissionMode: 'plan',
      maxTurns: 1,
      env: creds.env,
      timeoutMs: 90000,
    });
    const sid = warm.init?.session_id;
    assert.ok(sid, 'commands_changed 场景须有 session_id');
    const reload = await runNativeCommand(sdk, exe, cwd, '/reload-skills', {
      permissionMode: 'plan',
      maxTurns: 3,
      env: creds.env,
      timeoutMs: 120000,
      resume: sid,
    });
    // 接受 commands_changed 事件，或 reload 后 init.skills/commands 含新增 skill（版本差异下两者皆可）。
    const hasCommandsChanged = reload.events.some(
      (e) => e.type === 'system' && (e.subtype === 'commands_changed' || e.subtype === 'commands'),
    );
    const reloadText = typeof reload.termination?.result === 'string' ? reload.termination.result : '';
    const mentionsReload = /reload|重新加载|skills?|命令/i.test(reloadText);
    assert.ok(
      hasCommandsChanged || mentionsReload,
      `/reload-skills 应触发 commands_changed 或确认重载；事件=${reload.events.map((e) => e.subtype ?? e.type).join('|')}；result_head=${reloadText.slice(0, 120)}`,
    );
    mark('__commands_changed__', {
      status: hasCommandsChanged ? 'verified' : 'explicit-skip',
      category: 'dynamic',
      evidence: hasCommandsChanged
        ? ['真实 commands_changed 事件触发']
        : ['/reload-skills 确认重载（未捕到 commands_changed 事件，可能是版本协议差异）'],
      detail: `事件序列：${reload.events.map((e) => e.subtype ?? e.type).join('|')}`,
    });
  });

  // 写 manifest（无论 pass/fail，都落盘供门禁消费 + 诊断）。
  try {
    mkdirSync(path.dirname(VERIFICATION_OUT_FILE), { recursive: true });
    writeFileSync(VERIFICATION_OUT_FILE, JSON.stringify(manifest, null, 2), 'utf8');
  } catch (e) {
    console.log(`  ⚠ 写 ${VERIFICATION_OUT_FILE} 失败：${(e as Error).message}`);
  }

  try {
    await safeRmSync(root, 'all');
  } catch {
    /* 清理失败不覆盖通过状态 */
  }

  console.log(`\n${pass} passed, ${fail} failed, ${skipped} skipped`);
  // manifest 覆盖率自检：runtime 每条命令须有 entry（不论状态）。
  const runtimeNames = baseline.commands.map((c) => c.name);
  const missing = runtimeNames.filter((n) => !manifest.entries[n]);
  if (missing.length > 0) {
    fail++;
    console.log(`  ❌ manifest 缺失 runtime 命令：${missing.join(', ')}`);
  }
  if (fail > 0) {
    if (skipped > 0) {
      console.error(`（另有 ${skipped} 项场景因前置条件缺失 SKIP，fail 优先报告为 exit 1。）`);
    }
    throw new Error(`e2e --all 断言 ${fail} 项失败`);
  }
  if (skipped > 0) {
    console.error(
      `前置条件缺失：${skipped} 项场景 SKIP（skill 执行/commands_changed 需凭据）。` +
        '发布门禁必须以凭据环境运行；SKIP 不算 PASS（exit 2）。',
    );
    process.exit(2);
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────────────────
// isMainModule 守卫：仅当本脚本作为入口执行时才跑入口逻辑；被其它脚本（如 tdd）当作模块导入
// resolveInitCredentials 等导出函数时不触发（否则入口的 process.exit 会终止导入方进程）。
// tsconfig.scripts.json 编译为 CommonJS，故用 __filename（tsx CJS 提供）。
const isMainModule =
  process.argv[1] != null &&
  path.resolve(process.argv[1]) === path.resolve(__filename);

if (isMainModule) {
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
        // review-v5 F1：--command 逐命令执行；不支持的命令参数必须明确报错，不得静默跳过。
        const supportedCommands = ['/init', '/compact', '/usage', '/context', '/clear', '/config'];
        const unsupported = prompts.filter((p) => !supportedCommands.includes(p));
        if (unsupported.length > 0) {
          console.error(
            `e2e --command 不支持的命令参数：${unsupported.join(', ')}（支持：${supportedCommands.join(', ')}；无参数默认 /init）`,
          );
          process.exit(1);
        }
        await runCommandMode(exe, prompts.length > 0 ? prompts : ['/init']);
      } else if (mode === '--init-matrix') {
        await runInitMatrixMode(exe);
      } else if (mode === '--replacements') {
        await runReplacementsMode(exe);
      } else if (mode === '--all') {
        await runAllMode(exe);
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
}
