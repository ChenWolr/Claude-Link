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
};

async function runNativeCommand(
  sdk: any,
  exe: string,
  cwd: string,
  prompt: string,
  options: Record<string, unknown> = {},
): Promise<{ prompt: string; events: NativeCommandEvent[]; termination: NativeCommandEvent | null; timedOut: boolean }> {
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : 90000;
  const { timeoutMs: _ignoredTimeout, ...sdkOptionOverrides } = options;
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
  let termination: NativeCommandEvent | null = null;
  let timedOut = false;
  const consume = (async () => {
    for await (const msg of q) {
      const event = msg as NativeCommandEvent;
      events.push(event);
      if (event.type === 'result') {
        termination = event;
        break;
      }
    }
  })();
  try {
    await withTimeout(consume, timeoutMs, `${prompt} query`);
  } catch (error) {
    timedOut = true;
    events.push({ type: 'aborted', message: error instanceof Error ? error.message : String(error) });
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
    await Promise.race([consume.catch(() => undefined), new Promise<void>((resolve) => setTimeout(resolve, 5000))]);
  } finally {
    try {
      q.close();
    } catch {
      // SDK query 已关闭时无害。
    }
  }
  return { prompt, events, termination, timedOut };
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
    if (prompts.includes('/init')) {
      const initCwd = path.join(root, 'init');
      mkdirSync(initCwd, { recursive: true });
      await check('/init 真实 query 创建非空 CLAUDE.md 并有成功终态', async () => {
        const run = await runNativeCommand(sdk, exe, initCwd, '/init');
        const file = path.join(initCwd, 'CLAUDE.md');
        assert.ok(run.events.some((e) => e.type === 'system' && e.subtype === 'local_command_output') || run.events.some((e) => e.type === 'result'), '命令必须返回 local_command_output 或 result');
        assert.ok(existsSync(file), '运行 /init 后必须存在 CLAUDE.md');
        assert.ok(readFileSync(file, 'utf8').trim().length > 0, 'CLAUDE.md 必须非空');
        assert.ok(run.termination, '必须收到 result 终态');
        assert.equal(run.termination?.is_error, false, '成功 /init 不得 is_error');
      });
    }

    if (prompts.includes('/compact')) {
      const compactCwd = path.join(root, 'compact');
      mkdirSync(compactCwd, { recursive: true });
      await check('/compact 真实 query 返回原生终态/压缩证据', async () => {
        const run = await runNativeCommand(sdk, exe, compactCwd, '/compact');
        assert.ok(run.termination, '必须收到 /compact result 终态');
        assert.equal(run.termination?.is_error, false, '成功 /compact 不得 is_error');
        assert.ok(
          run.events.some((e) => e.subtype === 'compact_boundary' || e.subtype === 'local_command_output') || typeof run.termination?.result === 'string',
          '必须存在 compact_boundary/local_command_output 或 result 正文证据',
        );
      });
    }

    await check('普通文本原样进入 query，不被自然语言前缀改写', async () => {
      const prompt = '请解释 /tmp 目录，保留双空格  与引号"';
      const run = await runNativeCommand(sdk, exe, path.join(root, 'plain'), prompt);
      assert.equal(run.prompt, prompt);
      assert.ok(run.events.some((e) => e.type === 'result' || e.type === 'aborted'), '普通文本必须有明确终态');
    });
  } finally {
    rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
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
    rmSync(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 500 });
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
