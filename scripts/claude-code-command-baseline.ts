// claude-code-command-baseline.ts
// 真实 Claude Code 命令基线采集（Task 1 原生 E2E 门禁，review-v1 修复后）。
//
// 职责：用明确目标环境的本地 claude.exe + 独立临时 cwd 跑一次 Claude Agent SDK query，采集：
//   - query / resolveSettings 是否为可用函数；
//   - supportedCommands() 的命令列表（运行时真相源，含 SDK 原始字段保留，防未来字段丢失）；
//   - system.init 的 slash_commands / skills / plugins；
//   - 每条命令的「可验证来源分类」（基于 init.skills / init.plugins / 描述 / 已知 builtin 名称；
//     SDK 若将来提供结构化 provenance 则优先透传），无法判断者标 unknown（显式差异，非完成）；
//   - resolveSettings({cwd}) 的来源级联摘要（脱敏：只取 source 名 + path + effective 键名），
//     并在 native 模式下作为硬门禁（必须可用且能看到 project/local 来源）。
// 机器可比对 JSON 输出到 D:\software\Cache\claude-link\command-baseline.json（不入仓库）。
//
// review-v1 修复点：
//   F1   Query 清理收口到 finally：supportedCommands 超时/失败/断言异常都只 close 一次（防进程/资源泄漏）。
//   F3   不再写读取不存在字段的假断言；保留 SDK 原始字段（rawCommands + provenance/aliases 透传），
//        用可验证分类器 classifyOrigin 做真断言，unknown 显式列出并失败。
//   F4   不在 try/catch 内 process.exit；清理在 main 的 finally 完成，退出码由外层统一设置。
//   F5   明确目标环境：优先 demo 的 executable，PATH 兜底时告警并记录 exe 来源，避免把任意 PATH
//        环境误当 demo 基线；结果写入 environment 摘要（exe/sdk/cc 版本/demo 匹配）。
//   F6   native 模式下 resolveSettings 必须成功且 sources 含 project/local（cwd 内置 settings 夹具）；
//        失败即退出，不把 settings 诊断降级伪装成通过。
//   F7   本脚本不再放入默认 npm run selftest（纯 Node 门禁）；由显式 selftest:native 门禁执行。
//
// 门禁约定：
//   - 触发：--native 参数 或 CLAUDE_LINK_RUN_NATIVE_E2E=1。
//   - 未触发：打印 SKIP 行并 exit 0（仅显式手动运行；不作为任何绿色门禁的一部分）。
//   - 触发但 claude.exe 缺失 → 中文前置条件错误 + exit 2（不把环境缺失伪装成通过）。
//   - 触发且断言失败 → exit 1。
//   - system.init / supportedCommands 用本地命令 /usage 触发，num_turns 0、API 花费 0，无需 API key。
//
// 运行：npx tsx scripts/claude-code-command-baseline.ts --native
//       或 CLAUDE_LINK_RUN_NATIVE_E2E=1 npx tsx scripts/claude-code-command-baseline.ts
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
import { homedir } from 'node:os';
import path from 'node:path';
import { buildCommandOriginEvidence } from '../src/main/modules/sdk-command-origin';

const RUN_NATIVE =
  process.argv.includes('--native') || process.env.CLAUDE_LINK_RUN_NATIVE_E2E === '1';
const CACHE_ROOT = 'D:/software/Cache';
const TEMP_ROOT = path.join(CACHE_ROOT, 'temp');
const OUT_DIR = path.join(CACHE_ROOT, 'claude-link');
const OUT_FILE = path.join(OUT_DIR, 'command-baseline.json');

// demo 目标环境（Task 1 基线以此为准；plan 要求使用 demo 的真实 claude.exe）。
const DEMO_DIR = 'D:/software/Cache/claude-link-goal-demo';
const DEMO_SDK_PACKAGE = path.join(DEMO_DIR, 'sdk-package.json');
// demo 脚本（goal-demo.mjs / probe-*.mjs）硬编码的 executable 路径。
const DEMO_EXE_PATH =
  'D:/software/Cache/npm-global/node_modules/@anthropic-ai/claude-code/bin/claude.exe';

// ── 来源分类（可验证；review-v1 F3）────────────────────────────────────────────────
type CommandOrigin =
  | 'builtin'
  | 'user-skill'
  | 'project'
  | 'plugin'
  | 'internal'
  | 'removed'
  | 'unknown';

const KNOWN_ORIGIN_SET = new Set<CommandOrigin>([
  'builtin', 'user-skill', 'project', 'plugin', 'internal', 'removed', 'unknown',
]);

// 已知 CC builtin 名称（不在 init.skills/plugins 内，也不匹配 removed/internal 特征）。
// 分类顺序固定：SDK 结构化 provenance → removed 描述 → internal 名称/描述 → skills → plugins
// → 已知 builtin 名称 → unknown。
const KNOWN_BUILTIN_NAMES = new Set<string>([
  'init', 'clear', 'compact', 'config', 'context', 'heapdump', 'reload-skills', 'review',
  'security-review', 'usage', 'insights', 'recap', 'goal', 'team-onboarding',
]);

function commandNameKeyForBaseline(value: unknown): string {
  return typeof value === 'string' ? value.trim().replace(/^\/+/, '').toLowerCase() : '';
}

function classifyOrigin(
  cmd: { name: string; description: string; provenance: unknown },
  ctx: { skills: Set<string>; plugins: Set<string>; evidence?: ReturnType<typeof buildCommandOriginEvidence> },
): CommandOrigin {
  const name = typeof cmd.name === 'string' ? cmd.name : '';
  const desc = typeof cmd.description === 'string' ? cmd.description : '';
  // ① SDK 若将来提供结构化 provenance 字段，优先采信（当前 SDK 未提供 → undefined 跳过）。
  if (typeof cmd.provenance === 'string' && KNOWN_ORIGIN_SET.has(cmd.provenance as CommandOrigin)) {
    return cmd.provenance as CommandOrigin;
  }
  // ② removed：agents 等描述带 (removed)。
  if (desc.includes('(removed)')) return 'removed';
  const evidenceOrigin = ctx.evidence?.origins[commandNameKeyForBaseline(name)];
  if (evidenceOrigin && evidenceOrigin !== 'unknown') return evidenceOrigin;
  // ③ user Skill：Claude Code supportedCommands 对用户 Skill 给出可验证的 (user) 标记。
  if (/\(user\)\s*$/.test(desc)) return 'user-skill';
  // ④ internal：双下划线前缀或 server 内部描述。
  if (
    name.startsWith('__') ||
    /server-launched|server session|server-only|internal/i.test(desc)
  ) {
    return 'internal';
  }
  // ④ user-skill：命中 init.skills。
  if (ctx.skills.has(name)) return 'user-skill';
  // ⑤ plugin：命中 init.plugins。
  if (ctx.plugins.has(name)) return 'plugin';
  // ⑥ 已知 builtin 名称集合。
  if (KNOWN_BUILTIN_NAMES.has(name)) return 'builtin';
  // ⑦ 无法判断 → unknown（显式差异，不得当作 builtin 完成）。
  return 'unknown';
}

// ── exe 解析（review-v1 F5：优先 demo 目标环境，PATH 仅兜底并告警）────────────────────
type ExeResolution =
  | { exe: string; source: 'explicit' | 'demo' | 'path' | 'npm-global' }
  | null;

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

function resolveClaudeExe(): ExeResolution {
  const override = process.env.CLAUDE_LINK_CLAUDE_EXE;
  if (override && existsSync(override) && isExe(override)) {
    return { exe: override, source: 'explicit' };
  }
  // ① 目标环境：demo 脚本指定的 executable（若存在）。
  if (existsSync(DEMO_EXE_PATH) && isExe(DEMO_EXE_PATH)) {
    return { exe: DEMO_EXE_PATH, source: 'demo' };
  }
  // ② PATH 兜底（非 demo 环境，调用方需告警，不能默认为 demo 基线）。
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = execFileSync(lookup, ['claude'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const candidates = out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && existsSync(l));
    if (process.platform === 'win32') {
      const direct = candidates.find((c) => isExe(c));
      if (direct) return { exe: direct, source: 'path' };
      for (const c of candidates) {
        const lower = c.toLowerCase();
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
          const exe = resolveFromCmdShim(c);
          if (exe) return { exe, source: 'path' };
        }
      }
    } else if (candidates[0]) {
      return { exe: candidates[0], source: 'path' };
    }
  } catch {
    // claude 不在 PATH。
  }
  // ③ npm 全局兜底。
  try {
    const npmRoot = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const candidate = path.join(npmRoot, '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(candidate) && isExe(candidate)) return { exe: candidate, source: 'npm-global' };
  } catch {
    // npm 不可用。
  }
  return null;
}

// 读取 demo 记录的目标 SDK 版本（sdk-package.json 的 claudeCodeVersion；仅信息性）。
function readDemoRecordedVersion(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(DEMO_SDK_PACKAGE, 'utf8'));
    return typeof pkg.claudeCodeVersion === 'string' ? pkg.claudeCodeVersion : null;
  } catch {
    return null;
  }
}

// ── 夹具：临时 cwd 内置 user/project/local 来源（review-v1 F6 的 settings 断言基础）──
function setupNativeFixture(cwd: string): void {
  mkdirSync(path.join(cwd, '.claude'), { recursive: true });
  writeFileSync(
    path.join(cwd, '.claude', 'settings.json'),
    JSON.stringify({ env: {} }, null, 2),
    'utf8',
  );
  writeFileSync(
    path.join(cwd, '.claude', 'settings.local.json'),
    JSON.stringify({ env: {} }, null, 2),
    'utf8',
  );
  writeFileSync(path.join(cwd, 'CLAUDE.md'), '# baseline fixture\n\nnon-empty\n', 'utf8');
}

// ── 结果类型 ───────────────────────────────────────────────────────────────────────
type BaselineEnvironment = {
  target: 'demo';
  exe: string;
  exeSource: 'explicit' | 'demo' | 'path' | 'npm-global';
  demoExeExpected: string;
  demoExeMatched: boolean;
  sdkVersion: string | null;
  claudeCodeVersion: string | null;
  demoRecordedClaudeCodeVersion: string | null;
  /** user-skill 证据扫描所用的用户主目录（CLAUDE_LINK_USER_HOME 覆盖或 homedir 默认）。 */
  userHome: string;
  /** 是否为显式覆盖（非宿主真实 homedir）——可复现性提示。 */
  userHomeOverridden: boolean;
};

type BaselineSettings = {
  cwd: string;
  sources: Array<{ source: string; path?: string }>;
  effectiveKeys: string[];
};

type BaselineInit = {
  claudeCodeVersion: string | null;
  slashCommands: string[];
  skills: string[];
  plugins: Array<{ name: string; path?: string }>;
};

type BaselineCommand = {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  provenance: unknown; // SDK 若提供则透传保留（防未来字段丢失）
  origin: CommandOrigin; // 运行时可验证分类
};

type BaselineResult = {
  environment: BaselineEnvironment;
  cwd: string;
  collectedAt: string;
  /** 权威命令名集合：system.init.slash_commands（矩阵以此键为差集基准）。 */
  slashCommands: string[];
  /** 以权威 slashCommands 为键、附运行时来源分类的命令清单。 */
  commands: BaselineCommand[];
  /** supportedCommands() 探测视图（与 slash_commands 可能命名不同，见 onlyInProbe）。 */
  probeView: {
    count: number;
    names: string[];
    /** 探测视图独有、不在 slash_commands 的名字（同名技能的另一命名视图，显式记录而非静默忽略）。 */
    onlyInProbe: string[];
    /** 由真实 SKILL.md frontmatter/目录证据建立的 probe name → slash canonical name 映射。 */
    canonicalMappings: Record<string, string>;
  };
  rawCommands: Array<Record<string, unknown>>; // SDK 原始命令全量保留，防未来字段静默丢弃
  init: BaselineInit;
  settings: BaselineSettings;
  termination: { type: 'result' | 'aborted' | 'none'; subtype?: string; isError?: boolean };
};

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms)),
  ]);
}

function readSdkVersion(): string | null {
  try {
    const pkgPath = path.resolve(__dirname, '..', 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

async function collectBaseline(exe: string, cwd: string, userHome?: string): Promise<BaselineResult> {
  // 动态 import SDK（ESM）。基线脚本不得 import 任何项目主进程代码（避免 electron 运行时依赖）。
  const sdk: any = await import('@anthropic-ai/claude-agent-sdk');
  const { query, resolveSettings } = sdk;

  // 断言 query / resolveSettings 可用（review-v1 F6：resolveSettings 是 native settings 基线前置）。
  assert.equal(typeof query, 'function', 'SDK 应导出 query 函数');
  assert.equal(typeof resolveSettings, 'function', 'SDK 应导出 resolveSettings 函数');

  // 用本地命令 /usage 作 prompt：触发 system.init + result 终态，不走模型（零花费、无需 key）。
  // settingSources 不传 → 用 SDK 默认（user/project/local 全开），如实采集原生级联（Task 3 对照基线）。
  // review-v1 F7：显式 userHome 覆盖时把 USERPROFILE/HOME 传进 query 子进程，保证 user-skill 来源
  // 与证据扫描来自同一隔离目录（基线可复现，不依赖宿主真实 homedir）。
  const q = query({
    prompt: '/usage',
    options: {
      cwd,
      pathToClaudeCodeExecutable: exe,
      permissionMode: 'plan',
      maxTurns: 1,
      ...(userHome ? { env: { ...process.env, USERPROFILE: userHome, HOME: userHome } } : {}),
    },
  });
  assert.equal(typeof q.supportedCommands, 'function', 'query 句柄应提供 supportedCommands 方法');

  let initMsg: any = null;
  let termination: BaselineResult['termination'] = { type: 'none' };
  let supportedRaw: any[] | null = null;

  // review-v1 F1：Query 清理收口到 finally——supportedCommands 超时/失败、流超时、断言异常
  // 都只会走到一次 q.close()，杜绝 native 基线重复运行时残留子进程/资源。
  try {
    const consumeStream = (async () => {
      for await (const msg of q) {
        if (msg.type === 'system' && msg.subtype === 'init') {
          initMsg = msg;
        } else if (msg.type === 'result') {
          termination = { type: 'result', subtype: msg.subtype, isError: msg.is_error };
          break;
        }
      }
    })();
    supportedRaw = await withTimeout(q.supportedCommands(), 20000, 'supportedCommands');
    try {
      await withTimeout(consumeStream, 25000, '等待 system.init/result');
    } catch {
      // result 未在超时内到达：尽力保留已收到的 init；终止态按不变量合成 aborted。
    }
  } finally {
    try {
      q.close();
    } catch {
      // 已关闭。
    }
  }

  if (!supportedRaw) throw new Error('supportedCommands 无结果（超时或失败）');
  if (!initMsg) throw new Error('未收到 system.init（无法采集命令真相源）');
  if (termination.type === 'none') {
    // 流末未收到 result → 合成 aborted（与 sdk-backend 主循环不变量一致）。
    termination = { type: 'aborted' };
  }

  // review-v1 F3：保留 SDK 原始命令（rawCommands 全字段），normalized 命令带 aliases/provenance，
  // 并用可验证分类器分类（供矩阵 --require-runtime-match 交叉校验）。
  const rawCommands: Array<Record<string, unknown>> = supportedRaw.map((c) => ({ ...(c as object) }));
  const skills = new Set<string>(Array.isArray(initMsg.skills) ? initMsg.skills : []);
  const plugins = new Set<string>(
    Array.isArray(initMsg.plugins) ? initMsg.plugins.map((p: any) => p?.name) : [],
  );
  // review-v1 F7：证据扫描显式传入 userHome（CLAUDE_LINK_USER_HOME 覆盖或 homedir 默认），
  // 不依赖宿主真实 homedir，保证 user-skill 来源可复现。
  const evidence = buildCommandOriginEvidence({
    cwd,
    plugins: Array.isArray(initMsg.plugins) ? initMsg.plugins : [],
    ...(userHome ? { userHome } : {}),
  });

  // 权威命令名集合 = system.init.slash_commands（矩阵的差集基准；app registry 用 supportedCommands
  // 作为探测视图，二者对同一批技能可能命名不同——如 waza-check vs check、self-evolving vs Self-Evolving）。
  // 分类必须基于权威名集合，才能命中 init.skills/init.plugins 的名称；supportedCommands 独有名字
  // 记入 probeView.onlyInProbe 显式展示，不当作独立命令误分类。
  const slashCommands: string[] = Array.isArray(initMsg.slash_commands)
    ? initMsg.slash_commands
    : [];
  const probeNames: string[] = rawCommands.map((c) => (typeof c.name === 'string' ? c.name : ''));
  const onlyInProbe = probeNames.filter((n) => !slashCommands.includes(n));

  const commands: BaselineCommand[] = slashCommands.map((name) => {
    // 描述/别名/字段尽量从 supportedCommands 同名对象取；无同名（大小写差异等）取大小写不敏感兜底。
    const probe =
      rawCommands.find((c) => c.name === name) ??
      rawCommands.find((c) => typeof c.name === 'string' && c.name.toLowerCase() === name.toLowerCase());
    return {
      name,
      description: typeof probe?.description === 'string' ? probe.description : '',
      argumentHint: typeof probe?.argumentHint === 'string' ? probe.argumentHint : '',
      aliases: Array.isArray(probe?.aliases)
        ? probe.aliases.filter((a): a is string => typeof a === 'string')
        : [],
      provenance: probe?.provenance, // 原样透传；SDK 当前未提供 → undefined
      origin: classifyOrigin(
        { name, description: typeof probe?.description === 'string' ? probe.description : '', provenance: probe?.provenance },
        { skills, plugins, evidence },
      ),
    };
  });

  const init: BaselineInit = {
    claudeCodeVersion: typeof initMsg.claude_code_version === 'string' ? initMsg.claude_code_version : null,
    slashCommands,
    skills: [...skills],
    plugins: Array.isArray(initMsg.plugins) ? initMsg.plugins : [],
  };

  // review-v1 F6：resolveSettings 在 native 模式下是硬门禁——失败直接抛出（exit 1），不降级放行。
  let settings: BaselineSettings;
  try {
    const resolved: any = await resolveSettings({ cwd });
    settings = {
      cwd,
      sources: Array.isArray(resolved?.sources)
        ? resolved.sources.map((s: any) => ({
            source: typeof s?.source === 'string' ? s.source : 'unknown',
            ...(typeof s?.path === 'string' && s.path ? { path: s.path } : {}),
          }))
        : [],
      effectiveKeys:
        resolved?.effective && typeof resolved.effective === 'object'
          ? Object.keys(resolved.effective)
          : [],
    };
  } catch (e) {
    throw new Error(`resolveSettings 失败（native 门禁要求 settings 诊断可用）: ${(e as Error).message}`);
  }

  const environment: BaselineEnvironment = {
    target: 'demo',
    exe,
    exeSource: exe === DEMO_EXE_PATH ? 'demo' : (process.env.CLAUDE_LINK_CLAUDE_EXE ? 'explicit' : 'path'),
    demoExeExpected: DEMO_EXE_PATH,
    demoExeMatched: path.normalize(exe).toLowerCase() === path.normalize(DEMO_EXE_PATH).toLowerCase(),
    sdkVersion: readSdkVersion(),
    claudeCodeVersion: init.claudeCodeVersion,
    demoRecordedClaudeCodeVersion: readDemoRecordedVersion(),
    userHome: userHome ?? homedir(),
    userHomeOverridden: !!userHome,
  };

  return {
    environment,
    cwd,
    collectedAt: new Date().toISOString(),
  slashCommands,
    commands,
    probeView: {
      count: probeNames.length,
      names: probeNames,
      onlyInProbe,
      canonicalMappings: Object.fromEntries(
        probeNames
          .filter((name) => evidence.canonicalNames[commandNameKeyForBaseline(name)])
          .map((name) => [name, evidence.canonicalNames[commandNameKeyForBaseline(name)]]),
      ),
    },
    rawCommands,
    init,
    settings,
    termination,
  };
}

/**
 * review-v2 P1-2：采集 baseline 并写 OUT_FILE，返回结果。供 baseline.ts 入口与 matrix
 * --require-runtime-match 共用——matrix 在 baseline 过期/不存在时调用本函数重新采集，
 * 保证版本绑定当前 executable/SDK（不依赖仓库外旧缓存时间戳）。不跑 runAssertions
 *（matrix 有自己的 runtime match 断言；入口单独跑基线行为断言）。executable 缺失抛带
 * 中文 Error，由调用方决定 exit 码。
 */
export async function collectBaselineToFile(): Promise<BaselineResult> {
  const resolved = resolveClaudeExe();
  if (!resolved) {
    throw new Error(
      '前置条件缺失：未找到本地 Claude Code 可执行文件（claude.exe）。\n' +
        '请先 npm install -g @anthropic-ai/claude-code，或设置 CLAUDE_LINK_CLAUDE_EXE。',
    );
  }
  const { exe, source } = resolved;
  if (source !== 'demo' && source !== 'explicit') {
    console.warn(`⚠ 使用的 claude.exe 来自 ${source}（非 demo 目标环境 ${DEMO_EXE_PATH}）。` +
      '采集结果可能与 Task1 的 demo 72 命令基线漂移；请确认这是预期的目标环境。');
  }
  mkdirSync(TEMP_ROOT, { recursive: true });
  const cwd = mkdtempSync(path.join(TEMP_ROOT, 'baseline-cwd-'));
  try {
    setupNativeFixture(cwd);
    const defaultUserHome = homedir();
    const overrideUserHome = process.env.CLAUDE_LINK_USER_HOME?.trim();
    const userHome = overrideUserHome && existsSync(overrideUserHome) ? path.resolve(overrideUserHome) : defaultUserHome;
    if (userHome !== defaultUserHome) {
      process.env.USERPROFILE = userHome;
      process.env.HOME = userHome;
    }
    const userHomeUsed = userHome !== defaultUserHome ? userHome : undefined;
    const baseline = await collectBaseline(exe, cwd, userHomeUsed);
    mkdirSync(OUT_DIR, { recursive: true });
    writeFileSync(OUT_FILE, JSON.stringify(baseline, null, 2), 'utf8');
    return baseline;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function runAssertions(b: BaselineResult): void {
  let pass = 0;
  let fail = 0;
  const check = (name: string, fn: () => void): void => {
    try {
      fn();
      pass++;
      console.log(`  ✅ ${name}`);
    } catch (e) {
      fail++;
      console.log(`  ❌ ${name} — ${(e as Error).message}`);
    }
  };

  console.log('=== 基线行为断言（真实 SDK query）===');
  check('supportedCommands 返回非空命令列表', () => {
    assert.ok(b.commands.length > 0, '命令列表为空');
  });
  check('命令列表包含 init', () => {
    assert.ok(b.commands.some((c) => c.name === 'init'), '未发现 init 命令');
  });
  check('system.init.slash_commands 包含 init', () => {
    assert.ok(b.init.slashCommands.includes('init'), 'init.slash_commands 缺 init');
  });
  check('system.init.skills 为数组', () => {
    assert.ok(Array.isArray(b.init.skills), 'init.skills 非数组');
  });
  check('system.init.plugins 为数组', () => {
    assert.ok(Array.isArray(b.init.plugins), 'init.plugins 非数组');
  });

  console.log('=== 来源分类（review-v1 F3：可验证分类，非读取不存在字段的假断言）===');
  const byName = new Map(b.commands.map((c) => [c.name, c]));
  check('agents(removed) 分类为 removed，绝非 builtin', () => {
    const a = byName.get('agents');
    assert.ok(a, 'agents 命令应存在');
    assert.equal(a!.origin, 'removed', 'agents 应按 (removed) 描述分类为 removed');
    assert.notEqual(a!.origin, 'builtin', 'agents 不得被误判为 builtin');
    assert.ok(a!.description.includes('(removed)'), 'agents 描述应含 (removed)');
  });
  check('__remote-workflow 分类为 internal（服务端内部命令），绝非 builtin', () => {
    const r = byName.get('__remote-workflow');
    assert.ok(r, '__remote-workflow 命令应存在');
    assert.equal(r!.origin, 'internal', '__remote-workflow 应分类为 internal');
    assert.notEqual(r!.origin, 'builtin', '__remote-workflow 不得被误判为 builtin');
  });
  check('init / clear 分类为 builtin（已知 builtin 集合）', () => {
    assert.equal(byName.get('init')?.origin, 'builtin');
    assert.equal(byName.get('clear')?.origin, 'builtin');
  });
  check('无命令分类为 unknown（全部可解释；有则显式列出）', () => {
    const unknowns = b.commands.filter((c) => c.origin === 'unknown').map((c) => c.name);
    assert.deepEqual(unknowns, [], `存在无法解释来源的命令: ${unknowns.join(', ')}`);
  });
  check('SDK 原始字段被保留（rawCommands 非空，provenance/aliases 未丢）', () => {
    assert.ok(b.rawCommands.length > 0, 'rawCommands 为空');
    assert.ok(Array.isArray(b.commands[0]?.aliases), 'normalized 命令应带 aliases 字段');
    assert.ok('provenance' in b.commands[0], 'normalized 命令应保留 provenance 字段（哪怕 undefined）');
  });
  // supportedCommands 探测视图与 init.slash_commands 的命名差异（如 waza-check vs check）——
  // 显式记录，不静默忽略；矩阵以 slash_commands 为权威键做差集。
  if (b.probeView.onlyInProbe.length > 0) {
    console.log(
      '  ℹ supportedCommands 探测视图有 %d 个名字不在 init.slash_commands（同一批技能的另命名视图）: %s',
      b.probeView.onlyInProbe.length,
      b.probeView.onlyInProbe.join(', '),
    );
  }

  console.log('=== 原生 settings 级联（review-v1 F6：native 硬门禁）===');
  check('resolveSettings 返回非空 sources 列表', () => {
    assert.ok(b.settings.sources.length > 0, 'settings.sources 为空');
  });
  check('cwd 夹具的 project/local 来源被采集（原生级联未被禁用）', () => {
    const names = b.settings.sources.map((s) => s.source);
    assert.ok(names.includes('project'), `缺 project 来源，实际: ${names.join(',')}`);
    assert.ok(names.includes('local'), `缺 local 来源，实际: ${names.join(',')}`);
  });

  console.log('=== 终态（review-v1 F1 场景确认）===');
  check('query 收到终态 result（流末有终态，非悬空）', () => {
    assert.ok(b.termination.type === 'result', `终态应为 result，实际 ${b.termination.type}`);
  });
  check('baseline 有效时间戳与目标环境版本', () => {
    assert.ok(!Number.isNaN(Date.parse(b.collectedAt)), 'collectedAt 必须是有效 ISO 时间');
    assert.ok(b.environment.sdkVersion, '必须记录 SDK 版本');
    assert.ok(b.environment.claudeCodeVersion, '必须记录 Claude Code 版本');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) throw new Error(`基线断言 ${fail} 项失败`);
}

// ── 入口（CJS 不支持 top-level await，包一层 async；review-v1 F4：exit 不在 try/catch 内）──
void (async () => {
  if (!RUN_NATIVE) {
    console.log('SKIP: Claude Code native E2E 未触发（--native 或 CLAUDE_LINK_RUN_NATIVE_E2E=1）。' +
      '默认 npm run selftest 不包含本脚本；请用 npm run selftest:native 执行真实基线。');
    process.exit(0);
  }

  // 前置检查：executable 缺失 exit 2（前置条件，非断言失败）。采集逻辑（fixture/cleanup/写文件）
  // 已下沉到 collectBaselineToFile，供 matrix --require-runtime-match 过期时复用（review-v2 P1-2）。
  const resolved = resolveClaudeExe();
  if (!resolved) {
    console.error(
      '前置条件缺失：未找到本地 Claude Code 可执行文件（claude.exe）。\n' +
        '请先 npm install -g @anthropic-ai/claude-code，或设置环境变量 CLAUDE_LINK_CLAUDE_EXE 指向 ' +
        'node_modules/@anthropic-ai/claude-code/bin/claude.exe。',
    );
    process.exit(2);
  }
  console.log('真实基线采集：exe=%s (source=%s)', resolved.exe, resolved.source);

  let code = 0;
  try {
    const baseline = await collectBaselineToFile();
    runAssertions(baseline);
    console.log('基线 JSON 已写入 %s', OUT_FILE);
    console.log(
      '概要：commands=%d skills=%d plugins=%d slash_commands=%d settings.sources=%s 终态=%s ccVersion=%s userHome=%s%s',
      baseline.commands.length,
      baseline.init.skills.length,
      baseline.init.plugins.length,
      baseline.init.slashCommands.length,
      baseline.settings.sources.map((s) => s.source).join('|'),
      baseline.termination.type,
      baseline.init.claudeCodeVersion,
      baseline.environment.userHome,
      baseline.environment.userHomeOverridden ? '（CLAUDE_LINK_USER_HOME 覆盖）' : '',
    );
  } catch (e) {
    console.error('基线采集失败：', (e as Error).message);
    code = 1;
  }
  process.exit(code);
})().catch((e) => {
  console.error('baseline fatal:', e);
  process.exit(1);
});
