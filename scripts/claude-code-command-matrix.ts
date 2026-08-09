// claude-code-command-matrix.ts
// 全量 Claude Code 命令验收矩阵（测试规格，非运行时命令来源）。
//
// 职责：为 SDK 在 demo 工作目录发现的每个命令维护一条「验收规格」——预期来源(origin)、
// 执行模式(executionMode)、副作用、成功/失败证据、（候选平替的）等价校验项。它只存测试规格，
// 不作为运行时命令真相源；运行时仍以 supportedCommands()/system:init.slash_commands 为权威
// （计划 line 20：不得把静态列表硬编码成永久真相）。
//
// 约定（与项目其它 tdd-*-verify.ts 一致）：纯 node:assert + check() 计数；不 import Electron
// 也不 import SDK；失败 process.exit(1)。运行：npx tsx scripts/claude-code-command-matrix.ts
//
// 关于命令数量：demo 真实快照（probe-usage.json 的 system.init.slash_commands）与计划逐条列出的
// 完整清单均为 72 项——技能 56 + 非 Skill 命令 16（其中 agents/__remote-workflow 各占 1）。计划正文
// 早期版本误写「74」，已在计划文档中更正为 72；本矩阵按 72 名称维护。注意：这个静态列表只是当前
// demo 快照的测试规格（计划 line 20：不得把静态列表硬编码成永久真相）——它不证明运行时覆盖，
// 运行时覆盖由 selftest:native 的 baseline + --require-runtime-match 以真实 supportedCommands 验证。
import { strict as assert } from 'node:assert';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
// review-v2 P1-2：baseline 过期/缺失时在门禁内重新采集，版本绑定当前 executable/SDK，不依赖旧缓存时间戳。
import { collectBaselineToFile } from './claude-code-command-baseline';

/** 单命令预期来源（与 src/shared/types/command.ts 的 CommandOrigin 对齐，Task 2 落地）。 */
export type CommandOrigin =
  | 'builtin'
  | 'user-skill'
  | 'project'
  | 'plugin'
  | 'internal'
  | 'removed'
  | 'unknown';

/** 执行模式：原生 SDK 执行 / 已证明等价的平替 / 不展示（removed·internal）。 */
export type ExecutionMode = 'native-sdk' | 'proven-equivalent' | 'hidden';

/**
 * 单命令验收规格。字段固定，Task 6/7/8 复用同一形状。
 * - expectedOrigin：预期来源分类；不能证明时用 unknown，但 unknown 不得作为「完成」状态。
 * - executionMode：native-sdk=走真实 SDK query；proven-equivalent=经 Task 6 逐项证明的平替；
 *   hidden=removed/internal，菜单不展示或标不可用。
 * - replacement：仅 proven-equivalent 时填写，记录平替操作与等价校验项。
 */
export type CommandMatrixEntry = {
  name: string;
  expectedOrigin: CommandOrigin;
  executionMode: ExecutionMode;
  sideEffects: string[];
  successEvidence: string[];
  failureEvidence: string[];
  replacement?: { operation: string; equivalenceChecks: string[] };
};

// ── 当前 demo 基线命令名（probe-usage.json 真实 system.init.slash_commands，72 项）──────
// 运行时若 supportedCommands() 返回不同集合，应以运行时为准并在本矩阵增删；此处钉住当前基线。
const SKILL_NAMES: readonly string[] = [
  'ai-news-digest', 'auto-updater', 'banner-design', 'brainstorming', 'brand', 'cantian-bazi',
  'design', 'design-system', 'dispatching-parallel-agents', 'error-driven-evolution',
  'executing-plans', 'finishing-a-development-branch', 'gog', 'karpathy-guidelines',
  'multi-search-engine', 'notion', 'proactive-agent', 'pua', 'receiving-code-review',
  'requesting-code-review', 'self-evolving', 'self-improving-agent', 'skill-vetter', 'slides',
  'smtp', 'subagent-driven-development', 'summarize', 'systematic-debugging',
  'test-driven-development', 'ui-styling', 'ui-ux-pro-max', 'using-git-worktrees',
  'using-superpowers', 'verification-before-completion', 'waza-check', 'waza-health',
  'waza-hunt', 'waza-learn', 'waza-read', 'waza-think', 'waza-write', 'writing-plans',
  'writing-skills', 'deep-research', 'dataviz', 'update-config', 'verify', 'debug',
  'code-review', 'simplify', 'batch', 'fewer-permission-prompts', 'loop', 'claude-api',
  'run', 'run-skill-generator',
];

// 非 Skill 的 Claude Code 命令（slash_commands 命中但不在 init.skills 内）。
// 其中 agents=removed、__remote-workflow=internal，其余为 builtin。
const NON_SKILL_NAMES: readonly string[] = [
  'agents', 'clear', 'compact', 'config', 'context', 'heapdump', 'init', '__remote-workflow',
  'reload-skills', 'review', 'security-review', 'usage', 'insights', 'recap', 'goal',
  'team-onboarding',
];

/** 当前基线全量命令名（技能 + 非 Skill，去重排序前先按「技能在前、非 Skill 在后」保留可读顺序）。 */
export const BASELINE_COMMAND_NAMES: readonly string[] = [...SKILL_NAMES, ...NON_SKILL_NAMES];

// ── 证据模板（按类别，避免逐条手写 72 份重复文案）────────────────────────────────────
const SKILL_SUCCESS = [
  'supportedCommands() / system.init.slash_commands 命中该名称',
  'system.init.skills 命中（确认 SKILL.md 已被发现）',
  '对应 SKILL.md 可加载，描述/参数提示不丢失',
  '执行事件（assistant/tool/stream）能回传到 UI',
];
const SKILL_SIDE_EFFECTS = [
  'SKILL.md 加载进 system prompt（无磁盘写入）',
  '若 skill 内部写文件，落在指定 cwd 或用户明确路径',
];
const COMMON_FAILURE = [
  'skill/命令加载失败时返回明确错误，不伪造成功',
  '用户取消 → aborted/取消终态，不新增成功消息',
];

const BUILTIN_SUCCESS = [
  'supportedCommands() / system.init.slash_commands 命中该名称',
  '原生 system 事件（local_command_output 等）或 result 终态回传',
];
const BUILTIN_SIDE_EFFECTS: string[] = [];

function skillEntry(name: string): CommandMatrixEntry {
  return {
    name,
    expectedOrigin: 'user-skill',
    executionMode: 'native-sdk',
    sideEffects: [...SKILL_SIDE_EFFECTS],
    successEvidence: [...SKILL_SUCCESS],
    failureEvidence: [...COMMON_FAILURE],
  };
}

function builtinEntry(name: string, extra: Partial<CommandMatrixEntry> = {}): CommandMatrixEntry {
  return {
    name,
    expectedOrigin: 'builtin',
    executionMode: 'native-sdk',
    sideEffects: [...BUILTIN_SIDE_EFFECTS],
    successEvidence: [...BUILTIN_SUCCESS],
    failureEvidence: [...COMMON_FAILURE],
    ...extra,
  };
}

/**
 * 构建全量矩阵。hidden（removed/internal）单独构造；/init 与 /clear 带专属证据/门禁，
 * 其余 builtin 与全部 user-skill 用模板。顺序：技能 → 非 Skill（与 BASELINE_COMMAND_NAMES 一致）。
 */
function buildMatrix(): CommandMatrixEntry[] {
  const entries: CommandMatrixEntry[] = [];

  for (const name of SKILL_NAMES) entries.push(skillEntry(name));

  for (const name of NON_SKILL_NAMES) {
    if (name === 'agents') {
      entries.push({
        name: 'agents',
        expectedOrigin: 'removed',
        executionMode: 'hidden',
        sideEffects: ['无（命令已移除，不可执行）'],
        successEvidence: ['菜单不展示，或展示并标注「已移除/不可用」原因'],
        failureEvidence: ['不得当作正常可执行命令转发给 SDK；描述含 (removed)'],
      });
      continue;
    }
    if (name === '__remote-workflow') {
      entries.push({
        name: '__remote-workflow',
        expectedOrigin: 'internal',
        executionMode: 'hidden',
        sideEffects: ['无（服务端会话内部命令，非用户命令）'],
        successEvidence: ['菜单不展示，或展示并标注「内部命令/仅服务端会话」原因'],
        failureEvidence: ['不得当作普通用户命令转发；名称以双下划线前缀标记 internal'],
      });
      continue;
    }
    if (name === 'init') {
      entries.push(builtinEntry('init', {
        sideEffects: ['在 cwd 创建/更新 CLAUDE.md（真实文件副作用）'],
        successEvidence: [
          ...BUILTIN_SUCCESS,
          'existsSync(cwd/CLAUDE.md) && isFile && readFileSync 非空（Task 5 真实落盘门禁）',
          '用户级/项目级 CLAUDE.md 进入 query 上下文（Task 3 settings source）',
        ],
        failureEvidence: [
          ...COMMON_FAILURE,
          '只读目录/工作目录为空/executable 缺失 → 明确失败，不报告成功也不写假文件',
        ],
      }));
      continue;
    }
    if (name === 'clear') {
      // Task 6 前强制 native-sdk：新建对话只是候选平替，未逐项证明等价前不得改 proven-equivalent。
      entries.push(builtinEntry('clear', {
        successEvidence: [
          ...BUILTIN_SUCCESS,
          '原生 /clear 清空当前会话上下文（旧 transcript 不可恢复、生成新 CLI session id）',
        ],
        failureEvidence: [
          ...COMMON_FAILURE,
          '在 Task 6 逐项等价证明前，不得用「新建对话」平替冒充 /clear',
        ],
      }));
      continue;
    }
    entries.push(builtinEntry(name));
  }

  return entries;
}

export const COMMAND_MATRIX: readonly CommandMatrixEntry[] = buildMatrix();

// ── 断言入口 ───────────────────────────────────────────────────────────────────────
let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

function runStructuralAssertions(): void {
  const entries = [...COMMAND_MATRIX];
  const names = entries.map((e) => e.name);
  const baselineSet = new Set(BASELINE_COMMAND_NAMES);

  console.log('=== 1) 矩阵命令名称完整、无重复、含 /init、覆盖全部基线名称 ===');
  check('矩阵条数 === 基线命令数（条数派生自 BASELINE_COMMAND_NAMES，不硬编码 magic 值）', () => {
    // 不钉死 magic 数字：条数一律派生自基线数组。计划文档已把正文「74」更正为 72——
    // 完整清单即下方 SKILL_NAMES(56) + NON_SKILL_NAMES(16)。此处只锚定「计划清单的拆分」，
    // 防止技能/非技能两组被意外合并或遗漏；真正的运行时覆盖由 selftest:native 验证。
    assert.equal(entries.length, BASELINE_COMMAND_NAMES.length, '条数应等于基线命令数');
    assert.equal(SKILL_NAMES.length, 56, '技能基线应为 56（计划清单第 17 行）');
    assert.equal(NON_SKILL_NAMES.length, 16, '非 Skill 命令基线应为 16（计划清单第 18 行）');
  });
  check('命令名无重复', () => {
    assert.equal(new Set(names).size, names.length, '存在重复命令名');
  });
  check('矩阵命令集合 === 基线命令集合', () => {
    assert.deepEqual(new Set(names), baselineSet, '矩阵与基线名称集合不一致');
  });
  check('包含 /init（强制端到端验收项）', () => {
    assert.ok(names.includes('init'), '矩阵必须包含 init');
  });

  console.log('=== 2) removed / internal 预期状态正确 ===');
  check('agents → hidden + removed（不可执行）', () => {
    const e = entries.find((x) => x.name === 'agents');
    assert.ok(e, 'agents 条目应存在');
    assert.equal(e!.expectedOrigin, 'removed');
    assert.equal(e!.executionMode, 'hidden');
  });
  check('__remote-workflow → hidden + internal（服务端内部命令）', () => {
    const e = entries.find((x) => x.name === '__remote-workflow');
    assert.ok(e, '__remote-workflow 条目应存在');
    assert.equal(e!.expectedOrigin, 'internal');
    assert.equal(e!.executionMode, 'hidden');
  });
  check('所有 hidden 命令均非 native-sdk（不在执行路径）', () => {
    for (const e of entries) {
      if (e.executionMode === 'hidden') {
        assert.ok(
          e.expectedOrigin === 'removed' || e.expectedOrigin === 'internal',
          `${e.name} 为 hidden 但来源既非 removed 也非 internal`,
        );
      }
    }
  });

  console.log('=== 3) 平替门禁：/clear 在 Task 6 证明前不得 proven-equivalent ===');
  check('/clear 当前为 native-sdk（候选平替未证明等价）', () => {
    const e = entries.find((x) => x.name === 'clear');
    assert.ok(e, 'clear 条目应存在');
    assert.equal(e!.executionMode, 'native-sdk', 'Task 6 逐项等价证明前必须保持 native-sdk');
  });
  check('当前无任何命令提前标 proven-equivalent（未经证明）', () => {
    const premature = entries.filter((e) => e.executionMode === 'proven-equivalent');
    assert.deepEqual(premature.map((e) => e.name), [], '不应存在未经验证的 proven-equivalent');
  });

  console.log('=== 4) 完成状态约束：不得用 unknown 作为已完成状态 ===');
  check('无命令 expectedOrigin 为 unknown（Task 1 全部归类明确）', () => {
    const unknowns = entries.filter((e) => e.expectedOrigin === 'unknown');
    assert.deepEqual(unknowns.map((e) => e.name), [], 'unknown 只能作显式差异状态，不能当完成');
  });

  console.log('=== 5) 结构完整性：每条命令都有可执行的证据项 ===');
  check('每条命令 successEvidence / failureEvidence 非空', () => {
    for (const e of entries) {
      assert.ok(e.successEvidence.length > 0, `${e.name} 缺 successEvidence`);
      assert.ok(e.failureEvidence.length > 0, `${e.name} 缺 failureEvidence`);
    }
  });
}

/**
 * --require-no-unexplained-gap：每条命令必须处于「可解释」状态——
 * 有明确的 executionMode，且非 hidden 命令具备可验证的成功证据（无空档）。
 * Task 7 的 --require-no-unverified-command（要求运行时已验证）更强，届时再加。
 */
function requireNoUnexplainedGap(): void {
  console.log('=== 6) --require-no-unexplained-gap：无未解释空档 ===');
  const entries = [...COMMAND_MATRIX];
  check('每条命令 executionMode 已定义', () => {
    for (const e of entries) {
      assert.ok(
        e.executionMode === 'native-sdk' || e.executionMode === 'proven-equivalent' || e.executionMode === 'hidden',
        `${e.name} 的 executionMode 未定义`,
      );
    }
  });
  check('每条非 hidden 命令具备成功证据（可验证目标）', () => {
    for (const e of entries) {
      if (e.executionMode === 'hidden') continue;
      assert.ok(e.successEvidence.length > 0, `${e.name} 缺可验证的成功证据`);
    }
  });
  check('每条 hidden 命令都写明不可用原因（failureEvidence）', () => {
    for (const e of entries) {
      if (e.executionMode !== 'hidden') continue;
      assert.ok(e.failureEvidence.length > 0, `${e.name} 为 hidden 但缺原因说明`);
    }
  });
}

// ── 运行时差集门禁（review-v1 F2/F3）─────────────────────────────────────────────
// 矩阵必须消费真实 baseline，不能只做静态自比：selftest:native 先跑
// claude-code-command-baseline.ts --native 写出 command-baseline.json，本函数读取它。
//
// review-v1 F3：以「运行时命令集合」为真相源 reconcile，而不是拿固定 BASELINE_COMMAND_NAMES
// 做严格相等比对——真实 baseline 与静态数组的合法差异（Claude Code 版本新增/删除命令、环境里
// 新增/移除 Skill）不再直接判红：
//   ① 矩阵缺失（矩阵有、runtime 无）：仅当该命令在矩阵中非 hidden（removed/internal）才算回归；
//      hidden 命令在新版 runtime 合法消失 → 显式 drift，报告但不红。
//   ② 矩阵外新增（runtime 有、矩阵无）：以运行时 origin 生成「待补矩阵规格」，不硬失败；唯一失败
//      条件是 runtime-only 命令无法分类（unknown/缺失），此时无法生成规格。
//   ③ origin 交叉校验（交集）：矩阵 expectedOrigin 必须与运行时分类一致（真正的契约），仍硬校验。
//   ④ 差集报告显式打印，让版本/环境漂移对门禁可见。
const BASELINE_OUT_FILE = path.join('D:/software/Cache', 'claude-link', 'command-baseline.json');
const PENDING_MATRIX_OUT_FILE = path.join('D:/software/Cache', 'claude-link', 'command-matrix-pending.json');
const EFFECTIVE_MATRIX_OUT_FILE = path.join('D:/software/Cache', 'claude-link', 'command-matrix-effective.json');

type BaselineJsonCommand = { name?: string; description?: string; argumentHint?: string; aliases?: string[]; origin?: string };

async function requireRuntimeMatch(): Promise<void> {
  console.log('=== 6) --require-runtime-match：矩阵消费真实基线（以运行时为真相源 reconcile + origin 交叉校验）===');
  type BaselineJson = {
    slashCommands?: string[];
    commands?: BaselineJsonCommand[];
    probeView?: { names?: string[]; canonicalMappings?: Record<string, string> };
    collectedAt?: string;
    environment?: { sdkVersion?: string; claudeCodeVersion?: string };
  };
  const readBaseline = (): BaselineJson | null => {
    try {
      return JSON.parse(readFileSync(BASELINE_OUT_FILE, 'utf8')) as BaselineJson;
    } catch {
      return null;
    }
  };
  let baseline = readBaseline();
  // review-v2 P1-2：baseline 缺失或过期时在门禁内重新采集当前 executable/SDK 版本基线，
  // 不依赖仓库外旧缓存时间戳（selftest:native 串行跑时 e2e 耗时 >5min 会导致 baseline 过期）。
  const ageMs0 = baseline?.collectedAt && !Number.isNaN(Date.parse(baseline.collectedAt))
    ? Date.now() - Date.parse(baseline.collectedAt)
    : Number.POSITIVE_INFINITY;
  const needsRegen = !baseline || ageMs0 > 5 * 60 * 1000;
  if (needsRegen) {
    console.log('  ℹ baseline 缺失或过期，重新采集当前版本基线（review-v2 P1-2，版本绑定当前 executable/SDK）...');
    try {
      await collectBaselineToFile();
    } catch (e) {
      check('baseline 重新采集成功（executable 可用）', () => {
        throw new Error(`重新采集 baseline 失败（executable 缺失或 SDK 异常）: ${(e as Error).message}`);
      });
      return;
    }
    baseline = readBaseline();
  }
  if (!baseline) {
    check('command-baseline.json 可读取（需先运行 baseline --native）', () => {
      throw new Error(`读取 ${BASELINE_OUT_FILE} 失败`);
    });
    return;
  }
  check('baseline 是近期生成且记录目标版本（禁止消费陈旧缓存）', () => {
    assert.ok(baseline.collectedAt && !Number.isNaN(Date.parse(baseline.collectedAt)), 'baseline 缺有效 collectedAt');
    const ageMs = Date.now() - Date.parse(baseline.collectedAt!);
    assert.ok(ageMs >= 0 && ageMs <= 5 * 60 * 1000, `baseline 过期或来自未来：ageMs=${ageMs}`);
    assert.ok(baseline.environment?.sdkVersion, 'baseline 缺 SDK 版本');
    assert.ok(baseline.environment?.claudeCodeVersion, 'baseline 缺 Claude Code 版本');
  });
  // 同时校验生产消费的 supportedCommands 探测视图与 init.slash_commands 权威视图。
  // 两者若名称不同，必须由 baseline 的显式 canonicalMappings 证明；不能只打印 onlyInProbe 后放行。
  const runtimeNames = Array.isArray(baseline.slashCommands) ? baseline.slashCommands : [];
  const runtimeSet = new Set(runtimeNames);
  const probeNames = Array.isArray(baseline.probeView?.names) ? baseline.probeView.names : [];
  const probeOnly = probeNames.filter((n) => !runtimeSet.has(n));
  const unmappedProbeOnly = probeOnly.filter((n) => !baseline.probeView?.canonicalMappings?.[n]);
  const expectedNames = [...BASELINE_COMMAND_NAMES];
  const expectedSet = new Set(expectedNames);
  const originByCommand = new Map(
    (baseline.commands ?? []).map((c) => [c.name, c.origin] as const),
  );
  const commandByName = new Map((baseline.commands ?? []).map((c) => [c.name, c] as const));

  const missing = expectedNames.filter((n) => !runtimeSet.has(n));
  const extra = runtimeNames.filter((n) => !expectedSet.has(n));

  // ① 矩阵缺失：仅非 hidden 命令缺失判红（可执行命令在 runtime 消失 = 回归）。
  check('非 hidden 矩阵命令在运行时全部出现（removed/internal 允许版本漂移）', () => {
    const unexpectedMissing = missing.filter((n) => {
      const entry = COMMAND_MATRIX.find((e) => e.name === n);
      return entry && entry.executionMode !== 'hidden';
    });
    assert.deepEqual(unexpectedMissing, [], `矩阵可执行命令在运行时缺失（回归或未说明的版本漂移）: ${unexpectedMissing.join(', ')}`);
  });
  check('生产 supportedCommands 探测视图无未解释 probe-only 命令', () => {
    assert.deepEqual(unmappedProbeOnly, [], `probe 视图存在未建立 canonical 映射的命令: ${unmappedProbeOnly.join(', ')}`);
    for (const name of probeOnly) {
      const canonical = baseline.probeView?.canonicalMappings?.[name];
      assert.ok(canonical && runtimeSet.has(canonical), `${name} 的 canonical ${canonical ?? '(缺失)'} 不在 slash_commands`);
    }
  });
  // ② 运行时新增：以运行时 origin 生成并持久化待补矩阵规格；仅 unknown/缺失分类才红。
  const pendingEntries: CommandMatrixEntry[] = extra.map((name) => {
    const raw = commandByName.get(name);
    const origin = originByCommand.get(name);
    return {
      name,
      expectedOrigin: (origin && origin !== 'unknown' ? origin : 'unknown') as CommandOrigin,
      executionMode: origin === 'removed' || origin === 'internal' ? 'hidden' : 'native-sdk',
      sideEffects: ['待补：根据该版本 Claude Code 的真实行为记录文件/会话副作用'],
      successEvidence: [
        '运行时 supportedCommands()/system.init.slash_commands 命中该名称',
        `待补：验证 ${raw?.description || '命令'} 的真实成功终态与结果事件`,
      ],
      failureEvidence: [
        '待补：验证启动失败、用户取消、权限拒绝时的明确终态',
      ],
    };
  });
  check('runtime-only 命令均可分类并持久化待补矩阵规格', () => {
    const unclassifiable = pendingEntries.filter((e) => e.expectedOrigin === 'unknown');
    assert.deepEqual(unclassifiable, [], `runtime-only 命令无法分类，无法生成待补规格: ${unclassifiable.map((e) => e.name).join(', ')}`);
    mkdirSync(path.dirname(PENDING_MATRIX_OUT_FILE), { recursive: true });
    writeFileSync(PENDING_MATRIX_OUT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'runtime-baseline',
      baseline: BASELINE_OUT_FILE,
      entries: pendingEntries,
    }, null, 2), 'utf8');
    assert.ok(readFileSync(PENDING_MATRIX_OUT_FILE, 'utf8').includes('"entries"'), '待补矩阵文件必须可读取');
  });
  check('运行时有效矩阵已合并静态规格与待补规格并持久化', () => {
    const effectiveEntries = [
      ...COMMAND_MATRIX.filter((entry) => runtimeSet.has(entry.name)),
      ...pendingEntries,
    ];
    mkdirSync(path.dirname(EFFECTIVE_MATRIX_OUT_FILE), { recursive: true });
    writeFileSync(EFFECTIVE_MATRIX_OUT_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'runtime-reconciled-matrix',
      baseline: BASELINE_OUT_FILE,
      entries: effectiveEntries,
    }, null, 2), 'utf8');
    const saved = JSON.parse(readFileSync(EFFECTIVE_MATRIX_OUT_FILE, 'utf8')) as { entries?: unknown[] };
    assert.equal(saved.entries?.length, runtimeNames.length, '有效矩阵必须覆盖全部 runtime 命令');
  });
  // ③ 交集 origin 交叉校验：矩阵 expectedOrigin 必须与运行时分类一致。
  check('矩阵 expectedOrigin 与运行时 origin 全量一致（交集，真正的契约）', () => {
    const unknowns: string[] = [];
    const mismatches: string[] = [];
    for (const name of runtimeNames) {
      if (!expectedSet.has(name)) continue; // extra 已由②按运行时 origin 生成待补规格
      const entry = COMMAND_MATRIX.find((e) => e.name === name);
      if (!entry) continue;
      const origin = originByCommand.get(name);
      if (!origin || origin === 'unknown') {
        unknowns.push(`${name}(${origin ?? '缺失'})`);
        continue;
      }
      if (entry.expectedOrigin !== origin) {
        mismatches.push(`${name}(矩阵=${entry.expectedOrigin} 运行时=${origin})`);
      }
    }
    assert.deepEqual(unknowns, [], `runtime 分类 unknown/缺失: ${unknowns.join(', ')}`);
    assert.deepEqual(mismatches, [], `origin 不一致: ${mismatches.join(', ')}`);
  });
  // ④ 差集报告显式打印（不静默）：版本/环境漂移对门禁可见，后续需补矩阵规格或确认预期。
  if (missing.length > 0 || extra.length > 0) {
    console.log('  ℹ runtime 与矩阵差集（版本/环境漂移，需补矩阵规格或确认预期）：');
    for (const n of extra) {
      const origin = originByCommand.get(n);
      console.log(`    + 仅运行时: ${n} (origin=${origin ?? '?'}) → 已按运行时分类生成待补矩阵规格`);
    }
    for (const n of missing) {
      const entry = COMMAND_MATRIX.find((e) => e.name === n);
      console.log(`    - 仅矩阵: ${n} (executionMode=${entry?.executionMode ?? '?'})`);
    }
  }
}

// ── 入口 ───────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log('Claude Code 命令矩阵：当前基线 %d 条（技能 %d + 非 Skill %d）', COMMAND_MATRIX.length, SKILL_NAMES.length, NON_SKILL_NAMES.length);
  runStructuralAssertions();
  if (process.argv.includes('--require-no-unexplained-gap')) {
    requireNoUnexplainedGap();
  }
  if (process.argv.includes('--require-runtime-match')) {
    await requireRuntimeMatch();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void main().catch((e) => {
  console.error('matrix fatal:', e);
  process.exit(1);
});
