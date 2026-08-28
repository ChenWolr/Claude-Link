// tdd-native-command-verify.ts
// 原生 Claude Code Slash Commands 动态接入：行为测试 + 源码接线契约。
// 运行：npx tsx scripts/tdd-native-command-verify.ts
//
// 约定（与项目其它 tdd-*-verify.ts 一致）：纯 node:assert + check() 计数，
// 不 import Electron；失败 process.exit(1)。优先测纯函数行为；记录跨文件接线契约用源码文本断言。
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  parseSlashInvocation,
  filterRenderableCommands,
  findCommandByAlias,
} from '../src/shared/command-routing';
import { resolveCommandsGetResult, isSnapshotOriginStale } from '../src/shared/commands-get';
import {
  computeCommandRootsFingerprint,
  commandSourceRoots,
  FINGERPRINT_MAX_DEPTH,
  startCommandSourceWatcher,
  stopCommandSourceWatcher,
  isCommandSourceWatcherRunning,
  getUserOriginFingerprint,
  type CommandSourceWatcherDeps,
} from '../src/main/modules/command-source-watcher';
import {
  createDefaultCommandSnapshot,
  EMPTY_COMMAND_ORIGIN_CONTEXT,
  type SdkCommand,
  type SessionCommandSnapshot,
} from '../src/shared/types/command';
import { IPC_CHANNELS } from '../src/shared/types/ipc';
import { SdkCommandRegistry, toSdkCommand, sdkCommandRegistry, GLOBAL_FALLBACK_SESSION_ID } from '../src/main/modules/sdk-command-registry';
import { setActivePinia, createPinia } from 'pinia';
import { useCommandStore } from '../src/renderer/stores/command-store';
import { prepareAttachmentPrompt } from '../src/main/modules/attachment-prompt-builder';
import { hasLocalCommandOutputMessage } from '../src/renderer/composables/use-chat';
import { mergeSpawnOptions } from '../src/main/modules/sdk-command-options';
import { buildCommandOriginEvidence } from '../src/main/modules/sdk-command-origin';
import type { Message, Session } from '../src/shared/types/session';
// Task 6：候选平替等价性规格（矩阵 single source）。
import { REPLACEMENT_CANDIDATES, failingFieldsOf, type ReplacementField } from './claude-code-command-matrix';
// review-v3 F2：e2e 凭据解析（行为测试导入；e2e 入口已 isMainModule 守卫，导入不触发执行）。
import { resolveInitCredentials } from './claude-code-command-e2e-verify';

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
// 异步断言（prepareAttachmentPrompt 等纯 async 函数用）。需在调用处 await。
async function asyncCheck(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const sdkCommands: SdkCommand[] = [
  { name: 'usage', description: 'show usage', argumentHint: '', aliases: ['cost', 'stats'], source: 'sdk', origin: 'builtin', availability: 'available' },
  { name: 'goal', description: 'set a goal', argumentHint: '', aliases: [], source: 'sdk', origin: 'builtin', availability: 'available' },
];

console.log('=== 1) parseSlashInvocation 路由（不充当发送白名单）===');

check('/cost tokens → slash，保留 rawText/参数', () => {
  const r = parseSlashInvocation('/cost tokens');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'cost');
  assert.equal(r.rawText, '/cost tokens');
  assert.equal(r.argumentsText, 'tokens');
});

check('普通文本中间的 /tmp → prompt（不触发命令逻辑）', () => {
  assert.equal(parseSlashInvocation('请解释 /tmp 目录').kind, 'prompt');
});

check('  /goal 中文 参数 → 不 trim rawText', () => {
  const r = parseSlashInvocation('  /goal 中文 参数');
  assert.equal(r.kind, 'slash');
  assert.equal(r.rawText, '  /goal 中文 参数');
  if (r.kind === 'slash') {
    assert.equal(r.commandName, 'goal');
    assert.equal(r.argumentsText, '中文 参数');
  }
});

check('/unknown 任意参数 → slash candidate，路由不阻止发送', () => {
  const r = parseSlashInvocation('/unknown 任意参数');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'unknown');
  assert.equal(r.argumentsText, '任意参数');
  // 关键不变量：路由结果不携带"拒绝发送"信号；未知命令仍归类为 slash，由现有 CHAT_SEND 原样发送。
});

check('空串 / 全空白 → prompt', () => {
  assert.equal(parseSlashInvocation('').kind, 'prompt');
  assert.equal(parseSlashInvocation('   ').kind, 'prompt');
});

check('纯 / → slash（commandName 空，用于菜单触发）', () => {
  const r = parseSlashInvocation('/');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, '');
});

check('leading slash 后含引号/中文不丢失', () => {
  const r = parseSlashInvocation('/compact 保留中文和  引号"');
  assert.equal(r.kind, 'slash');
  if (r.kind !== 'slash') throw new Error('expected slash');
  assert.equal(r.commandName, 'compact');
  assert.equal(r.argumentsText, '保留中文和  引号"');
});

console.log('=== 2) alias / canonical 匹配（大小写不敏感）===');

check('findCommandByAlias：alias 命中', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'cost')?.name, 'usage');
  assert.equal(findCommandByAlias(sdkCommands, 'stats')?.name, 'usage');
});

check('findCommandByAlias：canonical 大小写不敏感', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'USAGE')?.name, 'usage');
  assert.equal(findCommandByAlias(sdkCommands, 'Goal')?.name, 'goal');
});

check('findCommandByAlias：未命中返回 undefined（不抛错）', () => {
  assert.equal(findCommandByAlias(sdkCommands, 'nope'), undefined);
  assert.equal(findCommandByAlias([], 'usage'), undefined);
  assert.equal(findCommandByAlias(sdkCommands, ''), undefined);
});

console.log('=== 3) filterRenderableCommands（菜单数据源清洗）===');

check('filterRenderableCommands：返回合法 sdk 命令', () => {
  assert.deepEqual(
    filterRenderableCommands(sdkCommands).map((c) => c.name),
    ['usage', 'goal'],
  );
});

check('filterRenderableCommands：丢弃 name 空 / 非 sdk 来源', () => {
  const mixed: SdkCommand[] = [
    ...sdkCommands,
    { name: '', description: 'x', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' },
  ];
  assert.deepEqual(
    filterRenderableCommands(mixed).map((c) => c.name),
    ['usage', 'goal'],
  );
});

check('filterRenderableCommands：过滤 hidden（removed/internal）命令（Task 2）', () => {
  const withHidden: SdkCommand[] = [
    { name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'builtin', availability: 'available' },
    { name: 'some-skill', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'user-skill', availability: 'available' },
    { name: 'agents', description: '(removed)', argumentHint: '', aliases: [], source: 'sdk', origin: 'removed', availability: 'hidden' },
    { name: '__remote-workflow', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'internal', availability: 'hidden' },
  ];
  assert.deepEqual(
    filterRenderableCommands(withHidden).map((c) => c.name),
    ['usage', 'some-skill'],
  );
});

console.log('=== 4) 共享命令模型 / 默认快照 ===');

check('SdkCommand 字段齐备', () => {
  const c: SdkCommand = { name: 'usage', description: 'd', argumentHint: '<file>', aliases: ['cost'], source: 'sdk', origin: 'unknown', availability: 'unknown' };
  assert.equal(c.name, 'usage');
  assert.equal(c.argumentHint, '<file>');
  assert.deepEqual(c.aliases, ['cost']);
  assert.equal(c.source, 'sdk');
});

check('createDefaultCommandSnapshot：默认 loading / 空命令', () => {
  const snap = createDefaultCommandSnapshot('s1');
  assert.equal(snap.sessionId, 's1');
  assert.equal(snap.status, 'loading');
  assert.equal(snap.commands.length, 0);
  assert.equal(snap.updatedAt, null);
});

check('SessionCommandSnapshot：source/status 取值符合联合类型', () => {
  const snap: SessionCommandSnapshot = {
    sessionId: 's2',
    commands: [],
    status: 'ready',
    source: 'probe',
    updatedAt: '2026-08-06T00:00:00.000Z',
  };
  assert.equal(snap.status, 'ready');
  assert.equal(snap.source, 'probe');
});

console.log('=== 5) IPC 常量与 payload 接线契约 ===');

check('IPC_CHANNELS.COMMANDS_GET / COMMANDS_CHANGED 存在且唯一', () => {
  assert.equal(typeof IPC_CHANNELS.COMMANDS_GET, 'string');
  assert.equal(IPC_CHANNELS.COMMANDS_GET, 'commands:get');
  assert.equal(IPC_CHANNELS.COMMANDS_CHANGED, 'commands:changed');
  assert.notEqual(IPC_CHANNELS.COMMANDS_GET, IPC_CHANNELS.COMMANDS_CHANGED);
});

check('源码契约：ChatEventPayload 之外存在专用 CommandChangedPayload', () => {
  const ipcSrc = readFileSync(path.join('src', 'shared', 'types', 'ipc.ts'), 'utf8');
  assert.ok(ipcSrc.includes('CommandChangedPayload'), 'ipc.ts 应引用/定义 CommandChangedPayload');
  const cmdSrc = readFileSync(path.join('src', 'shared', 'types', 'command.ts'), 'utf8');
  assert.ok(cmdSrc.includes('CommandChangedPayload'), 'command.ts 应定义 CommandChangedPayload');
});

console.log('=== 6) 主进程 registry：全量替换 / 隔离 / 清理 ===');

check('registry.get 默认 loading / 空命令', () => {
  const reg = new SdkCommandRegistry();
  assert.equal(reg.get('a').status, 'loading');
  assert.equal(reg.get('a').commands.length, 0);
});

check('registry.replace 全量替换（旧命令消失，不 concat）', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: 'd', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
  reg.replace('a', [{ name: 'usage', description: 'd', argumentHint: '', aliases: ['cost'], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'changed');
  assert.deepEqual(
    reg.get('a').commands.map((c) => c.name),
    ['usage'],
  );
  assert.equal(reg.get('a').source, 'changed');
  assert.equal(reg.get('a').status, 'ready');
});

check('registry 隔离 + clear 只影响指定 session', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
  reg.replace('b', [{ name: 'help', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
  reg.clear('a');
  assert.equal(reg.get('a').status, 'loading'); // clear 后回默认 loading
  assert.equal(reg.get('b').commands[0].name, 'help'); // B 不受影响
});

check('registry.setStatus 保留 commands（probe 失败降级不清空缓存）', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
  reg.setStatus('a', 'degraded', 'probe failed');
  assert.equal(reg.get('a').status, 'degraded');
  assert.equal(reg.get('a').commands.length, 1); // 命令保留
  assert.equal(reg.get('a').error, 'probe failed');
});

check('registry.replace 空列表 → status empty', () => {
  const reg = new SdkCommandRegistry();
  const snap = reg.replace('a', [], 'changed');
  assert.equal(snap.status, 'empty');
  assert.equal(snap.commands.length, 0);
});

console.log('=== 6b) Task 2：registry 替换/兜底/状态切换保持 provenance ===');
check('replace 带 ctx 分类 user-skill 并保留', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'verify', description: '', argumentHint: '', aliases: [] }], 'probe', {
    skills: ['verify'], plugins: [], slashCommands: ['verify'],
  });
  assert.equal(reg.get('a').commands[0].origin, 'user-skill');
  assert.equal(reg.get('a').commands[0].availability, 'available');
});
check('replace 全量替换：新 ctx 分类覆盖旧命令，旧命令消失', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'verify', description: '', argumentHint: '', aliases: [] }], 'probe', {
    skills: ['verify'], plugins: [], slashCommands: ['verify'],
  });
  reg.replace('a', [{ name: 'agents', description: '(removed) x', argumentHint: '', aliases: [] }], 'changed', {
    skills: [], plugins: [], slashCommands: ['agents'],
  });
  assert.deepEqual(reg.get('a').commands.map((c) => c.name), ['agents']);
  assert.equal(reg.get('a').commands[0].origin, 'removed');
  assert.equal(reg.get('a').commands[0].availability, 'hidden');
});
check('setGlobalFallback 按描述分类 removed/internal，清空不残留', () => {
  const reg = new SdkCommandRegistry();
  reg.setGlobalFallback([{ name: 'agents', description: '(removed) x', argumentHint: '', aliases: [] }], 'probe');
  assert.equal(reg.getGlobalFallback()?.commands[0]?.origin, 'removed');
  assert.equal(reg.getGlobalFallback()?.commands[0]?.availability, 'hidden');
  reg.clearGlobalFallback();
  assert.equal(reg.getGlobalFallback(), null);
});
check('setStatusPreservingCommands 保留已有命令的 origin/availability', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'waza-check', description: '', argumentHint: '', aliases: [] }], 'probe', {
    skills: ['waza-check'], plugins: [], slashCommands: ['waza-check'],
  });
  reg.setStatusPreservingCommands('a', 'degraded', '探测失败');
  assert.equal(reg.get('a').commands[0].origin, 'user-skill');
  assert.equal(reg.get('a').status, 'degraded');
});
check('清理：clear 后 registry 无残留命令与分类', () => {
  const reg = new SdkCommandRegistry();
  reg.replace('a', [{ name: 'verify', description: '', argumentHint: '', aliases: [] }], 'probe', {
    skills: ['verify'], plugins: [], slashCommands: ['verify'],
  });
  reg.clear('a');
  assert.equal(reg.get('a').commands.length, 0);
  assert.equal(reg.get('a').status, 'loading');
});

console.log('=== 7) toSdkCommand：SDK 原始对象清洗 ===');

check('toSdkCommand 去前导 / + 非 string 字段归空 + alias 去重', () => {
  const c = toSdkCommand({ name: '/Usage', description: 123, argumentHint: null, aliases: ['cost', 'cost', 'stats', '/usage'] });
  assert.equal(c?.name, 'Usage'); // 去前导 / 不改大小写
  assert.equal(c?.description, '');
  assert.equal(c?.argumentHint, '');
  assert.deepEqual(c?.aliases, ['cost', 'stats']); // 去重 + 去 / + 去掉与 name 同名
  assert.equal(c?.source, 'sdk');
});

check('toSdkCommand name 空 / 非对象 → 丢弃', () => {
  assert.equal(toSdkCommand({ name: '', description: 'x' }), undefined);
  assert.equal(toSdkCommand({ name: '   ' }), undefined);
  assert.equal(toSdkCommand(null), undefined);
  assert.equal(toSdkCommand('string'), undefined);
});

check('toSdkCommand 不泄漏 SDK 原始字段', () => {
  const raw = { name: 'goal', description: 'd', argumentHint: '', aliases: [], extra: 'leak' } as Record<string, unknown>;
  const c = toSdkCommand(raw);
  assert.equal(c?.name, 'goal');
  assert.ok(!c || !('extra' in c), '不应泄漏 SDK 原始字段');
});

check('sdkCommandRegistry 单例存在（供 sdk-backend / ipc-handlers 共用）', () => {
  assert.ok(sdkCommandRegistry instanceof SdkCommandRegistry);
});

console.log('=== 7b) Task 2：provenance 来源分类（toSdkCommand + CommandOriginContext）===');
check('verify 命中 skills → user-skill / available', () => {
  const skill = toSdkCommand(
    { name: 'verify', description: 'x (user)', argumentHint: '' },
    { skills: ['verify'], plugins: [], slashCommands: ['verify'] },
  );
  assert.equal(skill?.origin, 'user-skill');
  assert.equal(skill?.availability, 'available');
});
check('init 命中已知 builtin → builtin', () => {
  const init = toSdkCommand(
    { name: 'init', description: 'Initialize a new CLAUDE.md file with codebase documentation' },
    { skills: [], plugins: [], slashCommands: ['init'] },
  );
  assert.equal(init?.origin, 'builtin');
});
check('agents(removed) → removed + hidden（不误判 builtin）', () => {
  const removed = toSdkCommand(
    { name: 'agents', description: '(removed) Ask Claude to manage subagents' },
    { skills: [], plugins: [], slashCommands: ['agents'] },
  );
  assert.equal(removed?.origin, 'removed');
  assert.equal(removed?.availability, 'hidden');
  assert.notEqual(removed?.origin, 'builtin');
});
check('__remote-workflow → internal + hidden', () => {
  const internal = toSdkCommand(
    { name: '__remote-workflow', description: 'Run the workflow script (server-launched only)' },
    { skills: [], plugins: [], slashCommands: ['__remote-workflow'] },
  );
  assert.equal(internal?.origin, 'internal');
  assert.equal(internal?.availability, 'hidden');
});
check('插件名命中 plugins → plugin', () => {
  const plugin = toSdkCommand(
    { name: 'pdf', description: 'x' },
    { skills: [], plugins: ['pdf'], slashCommands: ['pdf'] },
  );
  assert.equal(plugin?.origin, 'plugin');
});
check('无法判断 → unknown + availability unknown（显式差异，非完成态）', () => {
  const unk = toSdkCommand({ name: 'mystery', description: 'x' }, { skills: [], plugins: [], slashCommands: [] });
  assert.equal(unk?.origin, 'unknown');
  assert.equal(unk?.availability, 'unknown');
});
check('SDK 结构化 provenance 优先（未来字段透传即采信）', () => {
  const withProv = toSdkCommand({ name: 'x', description: '', provenance: 'plugin' }, { skills: [], plugins: [], slashCommands: [] });
  assert.equal(withProv?.origin, 'plugin');
});
check('分类上下文缺省时单参数调用仍可用（默认空 ctx）', () => {
  const c = toSdkCommand({ name: 'init', description: 'x' });
  assert.equal(c?.origin, 'builtin'); // 空 ctx 下靠已知 builtin 名称
});

console.log('=== 7c) Task 2 / review-v1 F7：provenance 证据扫描支持隔离 userHome ===');
// 证据扫描不得依赖宿主真实 homedir（不同机器用户目录存在不同 Skill 时，同一会话命令会得到不同
// provenance）。注入 userHome 后必须只扫该隔离目录；未注入时不把隔离目录当用户来源。
const ORIGIN_TMP_ROOT = 'D:/software/Cache/temp';
const UNIQUE_SKILL = 'zzz-isolated-skill-test';
check('注入 userHome 后，隔离目录 skill 被分类为 user-skill（不读真实 homedir）', () => {
  mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
  const isolated = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-origin-'));
  try {
    const skillDir = path.join(isolated, '.claude', 'skills', UNIQUE_SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: zzz-isolated-skill-test\n---\n# 隔离技能夹具\n', 'utf8');
    const ev = buildCommandOriginEvidence({ userHome: isolated, cwd: path.join(isolated, 'proj') });
    assert.equal(ev.origins[UNIQUE_SKILL], 'user-skill', '注入 userHome 后隔离目录 skill 应分类为 user-skill');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});
check('未注入 userHome 时不把隔离目录 skill 当用户来源（隔离生效，读的是真实 homedir）', () => {
  mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
  const isolated = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-origin-'));
  try {
    const skillDir = path.join(isolated, '.claude', 'skills', UNIQUE_SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: zzz-isolated-skill-test\n---\n# 隔离技能夹具\n', 'utf8');
    // cwd 指向隔离目录下无 .claude 的子目录：该 skill 只可能被「真实 homedir 扫描」命中，
    // 而真实 homedir 不会有这个唯一名 → 断言 undefined，证明未注入时不会误读隔离目录。
    const ev = buildCommandOriginEvidence({ cwd: path.join(isolated, 'proj') });
    assert.equal(ev.origins[UNIQUE_SKILL], undefined, '未注入 userHome 时不得读到隔离目录 skill');
  } finally {
    rmSync(isolated, { recursive: true, force: true });
  }
});

// review-v1 §5.1：commands_changed provenance 刷新的核心机制——重扫同一 cwd 后，
// 新增的项目命令文件会被正确分类（init 时冻结的 evidence 不反映此变化）。
check('review-v1 §5.1: 重扫 cwd 后新增项目命令文件被正确分类（provenance 刷新机制）', () => {
  mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
  const proj = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-refresh-'));
  try {
    const DYN_CMD = 'zzz-dynamic-refresh-cmd';
    const userHome = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-refresh-home-'));
    // ① init 时（无项目命令）：DYN_CMD 不在 evidence 中。
    const evBefore = buildCommandOriginEvidence({ cwd: proj, userHome });
    assert.equal(evBefore.origins[DYN_CMD], undefined, 'init 时项目命令文件不存在 → origins 中无 DYN_CMD');

    // ② 会话过程中新增项目命令文件（模拟 /reload-skills 前用户创建 .claude/commands/zzz-dynamic-refresh-cmd.md）。
    mkdirSync(path.join(proj, '.claude', 'commands'), { recursive: true });
    writeFileSync(path.join(proj, '.claude', 'commands', `${DYN_CMD}.md`), '# 动态项目命令\n', 'utf8');

    // ③ commands_changed 刷新：重扫同一 cwd → DYN_CMD 被分类为 project。
    const evAfter = buildCommandOriginEvidence({ cwd: proj, userHome });
    assert.equal(evAfter.origins[DYN_CMD], 'project', '重扫后新增项目命令文件须分类为 project');

    rmSync(userHome, { recursive: true, force: true });
  } finally {
    rmSync(proj, { recursive: true, force: true });
  }
});

// review-v3 §6.7：advancedJson.env.USERPROFILE 覆盖时，evidence 扫描须用覆盖值（非宿主默认）。
// 模拟：宿主 process.env.USERPROFILE 指向 real-home（无 Skill），advancedJson.env.USERPROFILE 指向 isolated-home（有 Skill）。
// buildSpawnEnv 会用 advancedJson.env 覆盖 → effectiveUserHome() = isolated-home → evidence 扫描 isolated-home。
check('review-v3 §6.7: advancedJson.env.USERPROFILE 覆盖 → evidence 扫描用覆盖值（非 process.env）', () => {
  mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
  const realHome = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-real-home-'));
  const isolatedHome = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-iso-home-'));
  try {
    // 只在 isolatedHome 放 Skill（模拟 advancedJson.env.USERPROFILE 指向的隔离目录）
    const skillDir = path.join(isolatedHome, '.claude', 'skills', UNIQUE_SKILL);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: zzz-isolated-skill-test\n---\n# 隔离技能\n', 'utf8');

    // 用 realHome（process.env 默认）→ 找不到 Skill
    const evReal = buildCommandOriginEvidence({ userHome: realHome });
    assert.equal(evReal.origins[UNIQUE_SKILL], undefined, '用宿主默认 userHome 不应发现隔离 Skill');

    // 用 isolatedHome（advancedJson.env 覆盖值）→ 发现 Skill 并分类为 user-skill
    const evOverridden = buildCommandOriginEvidence({ userHome: isolatedHome });
    assert.equal(evOverridden.origins[UNIQUE_SKILL], 'user-skill', '用覆盖后的 userHome 须发现隔离 Skill');

    rmSync(realHome, { recursive: true, force: true });
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }
});

console.log('=== 8) Task 4 SDK 动态发现接线契约（sdk-backend 源码）===');
// sdk-backend.ts 经 config-manager → electron 运行时依赖链，无法被 tsx 直接 import，故用源码文本契约
// 钉住跨文件接线不变量（CLAUDE.md：记录接线契约可用源码文本断言）。
const sdkBackendSrc = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');

check('导出 startCommandProbe / cancelCommandProbe', () => {
  assert.ok(/export (async )?function startCommandProbe/.test(sdkBackendSrc), '应导出 startCommandProbe');
  assert.ok(/export async function cancelCommandProbe/.test(sdkBackendSrc), '应导出 cancelCommandProbe');
});

check('control-only probe 使用 shouldQuery:false（Task 1 验证的 B 路径）', () => {
  assert.ok(sdkBackendSrc.includes('shouldQuery: false'), 'probe 应使用 shouldQuery:false 单条消息，不伪造空 prompt');
});

check('Query 使用 Claude Agent SDK 官方 supportedCommands 契约', () => {
  assert.ok(sdkBackendSrc.includes("Query as SdkQuery") || sdkBackendSrc.includes('type Query = SdkQuery'), 'Query 应复用 SDK 官方 Query 类型');
  assert.ok(!/supportedCommands\?\s*:/.test(sdkBackendSrc), '不应把 SDK 官方必需 supportedCommands 降级为可选字段');
});

check('commands_changed 全量替换 source:changed，不 concat', () => {
  assert.ok(sdkBackendSrc.includes("'commands_changed'"), "system 分支应识别 commands_changed");
  assert.ok(
    /replace\(sessionId,\s*rawCommands,\s*'changed'[,)]/.test(sdkBackendSrc),
    'commands_changed 应 registry.replace 全量替换 source:changed（可带分类 ctx）',
  );
});

check('runQuery 开头取消 probe（probe/真实 query 互斥，§7）', () => {
  assert.ok(
    /await cancelCommandProbe\(sessionId\)/.test(sdkBackendSrc),
    'runQuery 应在真实 query 创建前 await cancelCommandProbe',
  );
});

check('markSessionDeleted 清理 probe + registry（生命周期）', () => {
  assert.ok(/cancelCommandProbeInternal\(sessionId,\s*0\)/.test(sdkBackendSrc), 'markSessionDeleted 应取消 probe');
  assert.ok(sdkBackendSrc.includes('sdkCommandRegistry.clear(sessionId)'), 'markSessionDeleted 应 registry.clear');
});
check('Task2: system.init 捕获命令分类 ctx（buildCommandOriginContext）', () => {
  assert.ok(/function buildCommandOriginContext/.test(sdkBackendSrc), '应存在 buildCommandOriginContext');
  assert.ok(sdkBackendSrc.includes('sessionCommandCtx.set(sessionId, buildCommandOriginContext('), 'init 分支应写入 sessionCommandCtx');
});
check('Task2: probe 全量替换带本会话分类 ctx', () => {
  assert.ok(sdkBackendSrc.includes("'probe', sessionCommandCtx.get(sessionId)"), 'probe replace 应带 sessionCommandCtx');
});
// review-v1 §5.1：commands_changed 不再用 init 时冻结的 ctx，而是按当前 cwd 重建来源证据。
// review-v9 §4 更新：refreshCommandOriginContext 增加可选 queryCwd——当前 query 的 cwd 优先于
// init seed（实测：会话创建时 probe 用全局默认 cwd，seed 冻结旧目录会把新 cwd 的 project skill
// 分类成 unknown，且代际号 guard 使后到的正确 probe 无法纠正 → 菜单永不显示）。
check('review-v1 §5.1: commands_changed 按 cwd 刷新 provenance（refreshCommandOriginContext）', () => {
  assert.ok(/function refreshCommandOriginContext\(sessionId: string, queryCwd\?: string\)/.test(sdkBackendSrc), '应定义 refreshCommandOriginContext(sessionId, queryCwd?)');
  assert.ok(
    /'changed',\s*refreshCommandOriginContext\(sessionId,\s*opts\.workingDir/.test(sdkBackendSrc),
    'commands_changed replace 应传入当前 query 的 workingDir（优先于 init seed）',
  );
  // commands_changed 分支不得回退为冻结的 sessionCommandCtx.get。
  const changedBranch = sdkBackendSrc.match(/subtype === 'commands_changed'[\s\S]*?continue;/);
  assert.ok(changedBranch, 'commands_changed 分支未找到');
  assert.ok(!/sessionCommandCtx\.get\(sessionId\)/.test(changedBranch![0]), 'commands_changed 不应用 init 时冻结的 ctx');
  // review-v9 §4：当前 query cwd 优先，且回写 seed（后续刷新不再沿用旧 cwd）。
  const fnMatch = sdkBackendSrc.match(/function refreshCommandOriginContext[\s\S]*?\n}/);
  assert.ok(fnMatch, 'refreshCommandOriginContext 函数体未找到');
  const fnBody = fnMatch![0];
  assert.ok(/const cwd = queryCwd \?\? seed\?\.cwd/.test(fnBody), 'cwd 应为 queryCwd ?? seed.cwd（当前 query 优先）');
  assert.ok(/sessionProvenanceSeeds\.set\(sessionId, \{ cwd: queryCwd/.test(fnBody), 'queryCwd 与 seed 不一致时应回写 seed');
});
// review-v4 §5.3（review-v9 §4 修订）：commands_changed 在 init 前到达（sessionCommandCtx 缺失）时，
// 不再早返回 EMPTY——那会把 project skill 固化成 unknown 且被代际号 guard 锁死（实测缺陷）。
// 新契约：缺失 ctx 时仍按磁盘 evidence 构建分类上下文（名称集合为空，由 evidence +
// '(user)' 描述标记 + KNOWN_BUILTIN_NAMES 兜底分类）。
check('review-v4 §5.3（v9 修订）: refreshCommandOriginContext 缺失 ctx 时按 evidence 兜底（不返回 EMPTY）', () => {
  const fnMatch = sdkBackendSrc.match(/function refreshCommandOriginContext[\s\S]*?\n}/);
  assert.ok(fnMatch, 'refreshCommandOriginContext 函数体未找到');
  const fnBody = fnMatch![0];
  assert.ok(
    !/if\s*\(\s*!ctx\s*\)\s*return\s+EMPTY_COMMAND_ORIGIN_CONTEXT/.test(fnBody),
    '不得在缺失 sessionCommandCtx 时早返回 EMPTY（unknown 会固化为终态）',
  );
  assert.ok(
    /return \{ skills: \[\], plugins: \[\], slashCommands: \[\], evidence \};/.test(fnBody),
    '缺失 ctx 时应返回 evidence-only 上下文（名称集合空，磁盘来源映射兜底）',
  );
});
check('review-v4 §5.3: 缺失分类上下文 → 命令 unknown，后续带 ctx 的 replace 纠正（行为）', () => {
  const reg = new SdkCommandRegistry();
  const sid = 'test-missing-ctx';
  const rawCmds = [
    { name: 'init', description: 'Initialize project' },
    { name: 'my-skill', description: 'A test skill' },
  ];
  // ① commands_changed 在 init 前到达 → ctx=EMPTY → 未知命令分类为 unknown（启发式）
  const snap1 = reg.replace(sid, rawCmds, 'changed', EMPTY_COMMAND_ORIGIN_CONTEXT);
  const skillCmd1 = snap1.commands.find((c) => c.name === 'my-skill');
  assert.equal(skillCmd1?.origin, 'unknown', '空 ctx 下未知 skill 应分类为 unknown（非 user-skill）');
  // ② init 到达后建立 ctx → 下次 commands_changed 带正确 ctx → 同一命令重新分类为 user-skill
  const snap2 = reg.replace(sid, rawCmds, 'changed', {
    skills: ['my-skill'], plugins: [], slashCommands: ['init', 'my-skill'],
  });
  const skillCmd2 = snap2.commands.find((c) => c.name === 'my-skill');
  assert.equal(skillCmd2?.origin, 'user-skill', '带 ctx 后 my-skill 须纠正为 user-skill（全量替换不残留旧分类）');
});
check('review-v1 §5.1: provenance 种子存储 + 清理（sessionProvenanceSeeds）', () => {
  assert.ok(/sessionProvenanceSeeds\s*=\s*new Map/.test(sdkBackendSrc), '应定义 sessionProvenanceSeeds Map');
  assert.ok(sdkBackendSrc.includes('sessionProvenanceSeeds.set(sessionId,'), 'buildCommandOriginContext 应存 provenance 种子');
  assert.ok(sdkBackendSrc.includes('sessionProvenanceSeeds.delete(sessionId)'), 'markSessionDeleted 应清理 provenance 种子');
});
// review-v2 §5：证据扫描必须用与 SDK 子进程一致的 userHome（buildSpawnEnv 的 effective env），
// 而非宿主 process.env 默认值——否则 advancedJson.env 覆盖 USERPROFILE/HOME 时分类错。
check('review-v2 §5: provenance 证据扫描用 effective env userHome（非 process.env）', () => {
  assert.ok(/function effectiveUserHome\(\)/.test(sdkBackendSrc), '应定义 effectiveUserHome()');
  const effFn = sdkBackendSrc.match(/function effectiveUserHome\(\)[\s\S]*?\n}/);
  assert.ok(effFn, 'effectiveUserHome 函数体未找到');
  assert.ok(/buildSpawnEnv\(\)/.test(effFn![0]), 'effectiveUserHome 应调用 buildSpawnEnv()');
  // buildCommandOriginContext + refreshCommandOriginContext 均用 effectiveUserHome()
  const ctxSection = sdkBackendSrc.slice(
    sdkBackendSrc.indexOf('function buildCommandOriginContext'),
    sdkBackendSrc.indexOf('function findClaudeMdCandidates'),
  );
  assert.ok(ctxSection.includes('effectiveUserHome()'), '证据扫描入口应调用 effectiveUserHome()');
  assert.ok(
    !/process\.env\.USERPROFILE\s*\|\|\s*process\.env\.HOME/.test(ctxSection),
    '证据扫描不得直接读 process.env.USERPROFILE||process.env.HOME（须走 effective env）',
  );
});
check('Task2: markSessionDeleted 清理 sessionCommandCtx（单一收口登记）', () => {
  assert.ok(sdkBackendSrc.includes('sessionCommandCtx.delete(sessionId)'), 'markSessionDeleted 应清理命令分类 ctx');
});

check('emitCommandChanged 走独立 COMMANDS_CHANGED + isSessionActive 守卫', () => {
  assert.ok(sdkBackendSrc.includes('IPC_CHANNELS.COMMANDS_CHANGED'), '应经 COMMANDS_CHANGED 推送（不进 CHAT_EVENT）');
  const m = sdkBackendSrc.match(/function emitCommandChanged[\s\S]*?\n}/);
  assert.ok(m, 'emitCommandChanged 函数应存在');
  assert.ok(m && m[0].includes('isSessionActive'), 'emitCommandChanged 应有 isSessionActive 守卫（迟到事件拒绝）');
});
// review-v3 §6.3：commands_changed 全链路接线契约——从 SDK 事件到 renderer 菜单。
// 每一环都须存在且串联：sdk-backend → registry.replace → emitCommandChanged → IPC → preload → command-store → ChatInput
check('review-v3 §6.3: commands_changed 全链路接线（registry→IPC→preload→store→ChatInput）', () => {
  // ① sdk-backend: commands_changed 分支 → refreshCommandOriginContext → registry.replace('changed') → emitCommandChanged
  const changedBranch = sdkBackendSrc.match(/subtype === 'commands_changed'[\s\S]*?continue;/);
  assert.ok(changedBranch, 'commands_changed 分支须存在');
  assert.ok(/refreshCommandOriginContext/.test(changedBranch![0]), '须调 refreshCommandOriginContext');
  assert.ok(/emitCommandChanged/.test(changedBranch![0]), '须调 emitCommandChanged');
  // ② emitCommandChanged → COMMANDS_CHANGED IPC
  assert.ok(sdkBackendSrc.includes('IPC_CHANNELS.COMMANDS_CHANGED'), 'emitCommandChanged 须用 COMMANDS_CHANGED IPC');
  // ③ preload: on(COMMANDS_CHANGED) → callback
  const preloadSrc = readFileSync(path.join('src', 'preload', 'api.ts'), 'utf8');
  assert.ok(preloadSrc.includes('IPC_CHANNELS.COMMANDS_CHANGED'), 'preload 须监听 COMMANDS_CHANGED');
  assert.ok(/onCommandChanged/.test(preloadSrc), 'preload 须暴露 onCommandChanged');
  // ④ command-store: replaceFromEvent 全量替换
  const storeSrc = readFileSync(path.join('src', 'renderer', 'stores', 'command-store.ts'), 'utf8');
  assert.ok(/replaceFromEvent/.test(storeSrc), 'command-store 须有 replaceFromEvent');
  // ⑤ ChatInput 从 command-store 读 commands（菜单数据源）
  const chatInputSrc = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(/commandStore|command-store|useCommandStore|matchingCommands/.test(chatInputSrc), 'ChatInput 须从 command-store 读命令');
  // ⑥ provenance 徽章渲染
  assert.ok(/originLabel|data-origin/.test(chatInputSrc), 'ChatInput 须渲染 origin 徽章');
});

check('命令发现失败 → degraded（保留缓存命令，不阻塞聊天）', () => {
  assert.ok(sdkBackendSrc.includes("'degraded'"), '失败路径应设 degraded');
});

check('不新增 invokeCommand 通道 / 不额外 spawn claude CLI / 不伪造空 prompt', () => {
  assert.ok(!/invokeCommand|executeCommand/.test(sdkBackendSrc), '不应新增 invokeCommand/executeCommand 通道');
  assert.ok(!/child_process\.spawn/.test(sdkBackendSrc), '不应 child_process.spawn（仅 resolveExecutable 用 execFileSync）');
  assert.ok(!/prompt:\s*''|prompt:\s*""/.test(sdkBackendSrc), '不应伪造空字符串 prompt');
});

console.log('=== 9) command-store（renderer 缓存 + 全量替换 + 按 sessionId 隔离）===');
setActivePinia(createPinia());

check('activeSnapshot 未加载 → 默认 loading（不抛错、不阻塞 UI）', () => {
  const store = useCommandStore();
  const snap = store.activeSnapshot('s-store-1');
  assert.equal(snap.sessionId, 's-store-1');
  assert.equal(snap.status, 'loading');
  assert.equal(snap.commands.length, 0);
});

check('replaceFromEvent 全量替换指定 session', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 's-store-2',
    snapshot: {
      sessionId: 's-store-2',
      commands: [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      status: 'ready',
      source: 'probe',
      updatedAt: 't',
    },
  });
  assert.equal(store.activeSnapshot('s-store-2').commands.length, 1);
  assert.equal(store.activeSnapshot('s-store-2').status, 'ready');
});

check('clear 只影响指定 session（A/B 隔离）', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 'a',
    snapshot: { sessionId: 'a', commands: [], status: 'ready', source: 'probe', updatedAt: 't' },
  });
  store.replaceFromEvent({
    sessionId: 'b',
    snapshot: { sessionId: 'b', commands: [], status: 'ready', source: 'probe', updatedAt: 't' },
  });
  store.clear('a');
  assert.equal(store.activeSnapshot('a').status, 'loading'); // clear 后回默认
  assert.equal(store.activeSnapshot('b').status, 'ready'); // B 不受影响
});

check('commands_changed 全量替换不 concat（旧命令消失）', () => {
  const store = useCommandStore();
  store.replaceFromEvent({
    sessionId: 'c',
    snapshot: {
      sessionId: 'c',
      commands: [
        { name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' },
        { name: 'help', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' },
      ],
      status: 'ready',
      source: 'probe',
      updatedAt: 't',
    },
  });
  store.replaceFromEvent({
    sessionId: 'c',
    snapshot: {
      sessionId: 'c',
      commands: [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      status: 'ready',
      source: 'changed',
      updatedAt: 't2',
    },
  });
  assert.deepEqual(
    store.activeSnapshot('c').commands.map((cmd) => cmd.name),
    ['usage'],
  );
});

console.log('=== 10) Task 5 IPC / preload / renderer 接线契约（源码）===');

check('preload 暴露 getSessionCommands / onCommandChanged / removeCommandListener', () => {
  const src = readFileSync(path.join('src', 'preload', 'api.ts'), 'utf8');
  assert.ok(src.includes('getSessionCommands'), 'preload 应暴露 getSessionCommands');
  assert.ok(src.includes('onCommandChanged'), 'preload 应暴露 onCommandChanged');
  assert.ok(src.includes('removeCommandListener'), 'preload 应暴露 removeCommandListener');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_GET'), 'preload 应 invoke COMMANDS_GET');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_CHANGED'), 'preload 应 on(COMMANDS_CHANGED)');
});

check('ipc-handlers 注册 COMMANDS_GET + SESSION_CREATE 触发 probe', () => {
  const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
  assert.ok(src.includes('IPC_CHANNELS.COMMANDS_GET'), '应注册 COMMANDS_GET handler');
  assert.ok(src.includes('sdkCommandRegistry.get'), 'COMMANDS_GET 应返回 registry snapshot（不返回 Query/stream）');
  assert.ok(
    /startCommandProbe\(session\.id,\s*mainWindow/.test(src),
    'SESSION_CREATE 应触发 startCommandProbe（fire-and-forget）',
  );
});

check('App.vue 全局订阅 onCommandChanged（ChatPage 卸载/后台会话不丢事件）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'App.vue'), 'utf8');
  assert.ok(src.includes('onCommandChanged'), 'App.vue 应订阅 onCommandChanged');
  assert.ok(src.includes('commandStore.replaceFromEvent'), '事件应交给 commandStore.replaceFromEvent');
  assert.ok(src.includes('stopCommandChanges'), 'onBeforeUnmount 应退订');
});

check('session-store create/delete 同步 command-store', () => {
  const src = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
  assert.ok(/useCommandStore\(\)\.load\(session\.id\)/.test(src), 'createSession 应 commandStore.load');
  assert.ok(/useCommandStore\(\)\.clear\(id\)/.test(src), 'deleteSession 应 commandStore.clear');
});

check('新会话延迟持久化：暂态会话链路', () => {
  const sessionStore = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
  const useChat = readFileSync(path.join('src', 'renderer', 'composables', 'use-chat.ts'), 'utf8');
  const chatPage = readFileSync(path.join('src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
  const appSidebar = readFileSync(path.join('src', 'renderer', 'components', 'layout', 'AppSidebar.vue'), 'utf8');
  const sessionsPage = readFileSync(path.join('src', 'renderer', 'pages', 'SessionsPage.vue'), 'utf8');
  const ipcHandlers = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
  const attService = readFileSync(path.join('src', 'main', 'modules', 'attachment-service.ts'), 'utf8');
  const sessionType = readFileSync(path.join('src', 'shared', 'types', 'session.ts'), 'utf8');

  assert.ok(/transient\?: boolean/.test(sessionType), 'Session 应有 renderer-only transient 标记');
  assert.ok(/startTransientSession\(\)/.test(sessionStore), 'session-store 应有 startTransientSession');
  assert.ok(/if \(this\.activeSession\?\.transient\) return;/.test(sessionStore), '暂态应单例复用（再点新会话不新建）');
  assert.ok(/async materializeActiveTransient/.test(sessionStore), '应有 materializeActiveTransient');
  assert.ok(sessionStore.includes('bindTransientAttachmentIds'), '物化应带暂态附件绑定');
  assert.ok(!/async createSession\(name/.test(sessionStore), '旧的点击即落库 createSession action 应删除');
  const guardCount = (sessionStore.match(/if \(this\.activeSession\.transient\)/g) || []).length;
  assert.ok(guardCount >= 6, `会话级 setter 应有暂态内存分支（实际 ${guardCount} 处，含 rename）`);
  assert.ok(useChat.includes('store.activeSession?.transient'), 'sendMessage 应有暂态物化守卫');
  assert.ok(useChat.includes('materializeActiveTransient()'), '守卫应调用 materializeActiveTransient');
  assert.ok(chatPage.includes('store.startTransientSession()'), 'ChatPage 新会话入口应走暂态');
  assert.ok(appSidebar.includes('store.startTransientSession()'), '侧栏新会话入口应走暂态');
  assert.ok(sessionsPage.includes('store.startTransientSession()'), '会话管理页新建入口应走暂态');
  assert.ok(ipcHandlers.includes('bindTransientAttachmentsToSession'), 'SESSION_CREATE 应绑定暂态附件');
  assert.ok(ipcHandlers.includes('stageTransientAttachment'), '附件暂存 handler 应有无行分支');
  assert.ok(attService.includes('transientAttachments = new Map'), 'attachment-service 应有暂态附件内存映射');
  assert.ok(attService.includes('export function bindTransientAttachmentsToSession'), 'attachment-service 应提供绑定转正');
  // 验收 review F-1/F-2/F-3 补丁契约。
  const ipcTypes = readFileSync(path.join('src', 'shared', 'types', 'ipc.ts'), 'utf8');
  const specStart = ipcTypes.indexOf('export interface SessionCreateSpec');
  const specBlock = ipcTypes.slice(specStart, specStart + 700);
  assert.ok(
    /permissionMode\?:/.test(specBlock) && /thinkingLevel\?:/.test(specBlock),
    'SessionCreateSpec 应含 permissionMode/thinkingLevel（F-1：暂态选择随物化落库）',
  );
  assert.ok(
    /startTransientSession\(\) \{[\s\S]{0,450}?this\.sessionStreams\[oldId\]/.test(sessionStore),
    'startTransientSession 应保存离开会话的流式快照（F-2：与 switchSession 同构）',
  );
  assert.ok(
    /stillOnSender = store\.activeSession\?\.id === sessionId/.test(useChat),
    'sendMessage 应有物化后切走守卫（F-3：防乐观消息错插其他会话）',
  );
});

console.log('=== 11) Task 6 ChatInput 动态菜单契约（源码）===');

check('ChatInput 不再依赖静态 SLASH_COMMANDS，改用 props.commands', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(!/import\s*\{\s*SLASH_COMMANDS/.test(src), 'ChatInput 不应再 import SLASH_COMMANDS');
  assert.ok(!src.includes("from '../../../shared/constants'"), 'ChatInput 不应再从 constants import 静态列表');
  assert.ok(src.includes('props.commands'), 'ChatInput 应基于 props.commands');
  assert.ok(src.includes('parseSlashInvocation'), '应使用 parseSlashInvocation 路由');
});

check('菜单选择插入 canonical /name（SDK name 不带斜杠，需补 /）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('`/${cmd.name} `'), 'selectSlashCommand 应插入 /${cmd.name} ');
});

check('ChatInput 展示 loading/empty/error 状态（不退回静态列表）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('正在读取 Claude Code 命令'), '应显示 loading 提示');
  assert.ok(src.includes('没有可用 Slash Command'), '应显示 empty 提示');
});

check('ChatPage 从 command-store 传 active snapshot 给 ChatInput', () => {
  const src = readFileSync(path.join('src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
  assert.ok(src.includes('activeCommandSnapshot'), 'ChatPage 应有 activeCommandSnapshot computed');
  assert.ok(src.includes(':commands="activeCommandSnapshot'), '应传 :commands');
  assert.ok(src.includes(':command-status="activeCommandSnapshot'), '应传 :command-status');
});

check('constants 删除静态 SLASH_COMMANDS（SDK 命令为真相源）', () => {
  const src = readFileSync(path.join('src', 'shared', 'constants.ts'), 'utf8');
  assert.ok(!src.includes('SLASH_COMMANDS'), 'constants 不应再有 SLASH_COMMANDS');
});

// Slash Command 菜单分页需求（2026-08-06）：移除独立 / 按钮 + 仅前缀匹配 + 每页 5 项分页 + 滚动/键盘跨页。
check('ChatInput 移除独立 slash trigger，/ 由输入触发', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(!src.includes('class="slash-trigger"'), '不应保留独立 slash trigger 按钮');
  assert.ok(!src.includes('insertSlash'), '不应保留 insertSlash 触发函数');
});

check('ChatInput 仅按命令名和 alias 前缀匹配', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('startsWith(q)'), '命令名/alias 应使用 startsWith 前缀匹配');
  assert.ok(!src.includes('.includes(q)'), '不应保留 includes 中间匹配兜底');
});

check('ChatInput 使用每页 5 项的分页渲染', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('COMMANDS_PAGE_SIZE = 5'), '页面大小应为 5');
  assert.ok(src.includes('visibleCommands'), '模板应使用分页后的 visibleCommands');
  assert.ok(src.includes('slice(0, loadedCommandCount'), '可见命令应按 loadedCommandCount 截取');
});

check('ChatInput 支持滚动触底和键盘跨页', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(src.includes('@scroll="handleSlashMenuScroll"'), '菜单应监听滚动触底');
  assert.ok(src.includes('loadNextCommandPage'), '应存在下一页加载函数');
  assert.ok(src.includes("e.key === 'ArrowDown'"), '应保留 ArrowDown 分页导航');
  assert.ok(src.includes("e.key === 'ArrowUp'"), '应保留 ArrowUp 跨页返回');
});

check('ChatInput 命令数据源变化时重置分页（防 selectedSlashIndex 越界崩溃）', () => {
  const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
  assert.ok(/watch\(\(\) => props\.commands/.test(src), '应 watch props.commands 变化重置分页');
});

console.log('=== 12) Task 7 原样发送契约（prepareAttachmentPrompt 纯函数）===');
// 无附件时 prepareAttachmentPrompt 原样返回 trim 后的用户文字（line 173-180），不加自然语言前缀；
// 参数内部空白/引号/中文不被改写；alias 手写不被 canonicalize。
// 包进 async IIFE——CJS 输出不支持 top-level await；汇总/exit 置于 IIFE 内，确保 async 计数完成后再判定。
void (async () => {
  const slashSendCases: Array<{ text: string; expect: string }> = [
    { text: '/goal 完成后停止', expect: '/goal 完成后停止' },
    { text: '/compact 保留中文和  引号"', expect: '/compact 保留中文和  引号"' },
    { text: '/cost', expect: '/cost' },
    { text: '/unknown 任意参数', expect: '/unknown 任意参数' },
    { text: '请解释 /tmp', expect: '请解释 /tmp' },
  ];
  for (const c of slashSendCases) {
    await asyncCheck(`无附件时原样进 SDK：${c.text}`, async () => {
      const result = await prepareAttachmentPrompt({
        sessionId: 's7',
        payload: { text: c.text, attachmentIds: [], clientMessageId: 's7-message' },
        attachments: [],
        attachmentPaths: {},
      });
      assert.equal(result.prompt, c.expect, `prompt 应原样（仅 trim 前后空白），实际：${result.prompt}`);
      assert.equal(result.additionalDirectories.length, 0, '无附件不应有 additionalDirectories');
      assert.equal(result.attachmentIds.length, 0, '无附件不应有 attachmentIds');
    });
  }
  await asyncCheck('alias 手写不被 canonicalize（/cost 不变 /usage）', async () => {
    const result = await prepareAttachmentPrompt({
      sessionId: 's7',
      payload: { text: '/cost tokens', attachmentIds: [], clientMessageId: 's7-alias-message' },
      attachments: [],
      attachmentPaths: {},
    });
    assert.equal(result.prompt, '/cost tokens', 'alias 应原样，不被改写成 /usage');
  });

  console.log('=== 13) Task 8 local_command_output 落库 + result 兜底契约（源码）===');
  const sdkBackendSrcLco = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
  check('system 分支识别 local_command_output', () => {
    assert.ok(sdkBackendSrcLco.includes("'local_command_output'"), "system 分支应识别 local_command_output");
  });
  check('local_command_output 主进程单一落库（processKind + persisted_message）', () => {
    assert.ok(sdkBackendSrcLco.includes('system:local_command_output'), '应用专用 processKind');
    const m = sdkBackendSrcLco.match(/function persistLocalCommandOutput[\s\S]*?\n}/);
    if (!m) throw new Error('persistLocalCommandOutput 未找到');
    assert.ok(m[0].includes('createMessage'), '应 createMessage 单一落库');
    assert.ok(m[0].includes('persisted_message'), '应推 persisted_message（renderer upsert 不二次落库）');
  });
  check('content string 原样 / 非 string 安全 stringify', () => {
    assert.ok(
      sdkBackendSrcLco.includes("typeof rawContent === 'string' ? rawContent : JSON.stringify"),
      '应 string 原样 / 非 string 安全 stringify',
    );
  });
  check('local_command_output 不靠正文正则猜命令名', () => {
    const m = sdkBackendSrcLco.match(/subtype === 'local_command_output'[\s\S]*?continue;/);
    if (!m) throw new Error('local_command_output 分支未找到');
    assert.ok(!/\.match\(/.test(m[0]), '不应从正文正则提取信息');
  });
  check('result 终态兜底保留（/usage 结果只出现在 result.result）', () => {
    assert.ok(/type === 'result'/.test(sdkBackendSrcLco), 'result 终态分支应保留');
  });
  // review-v2 §3.7：aborted 终态（「已中断」/「已硬中断」）须落库——此前 persistCliEvent 缺 case 导致
  // 中断文本消失。验证 persistCliEvent（cli-shared.ts）处理 aborted 并 createMessage。
  check('review-v2 §3.7: aborted 终态落库（persistCliEvent case aborted + createMessage）', () => {
    const cliSharedSrc = readFileSync(path.join('src', 'main', 'modules', 'cli-shared.ts'), 'utf8');
    const persistFn = cliSharedSrc.match(/export function persistCliEvent[\s\S]*?\n}/);
    assert.ok(persistFn, 'persistCliEvent 函数体未找到');
    assert.ok(/case 'aborted'/.test(persistFn![0]), 'persistCliEvent 须有 case aborted');
    assert.ok(/system:aborted/.test(persistFn![0]), 'aborted 须用 processKind system:aborted 落库');
    assert.ok(/createMessage/.test(persistFn![0]), 'aborted 须 createMessage（不能只 break）');
  });

  console.log('=== 14) Task 9 降级 / 隔离 / 迟到事件补全契约（源码）===');
  check('api_retry 不清空已有命令列表（retry 分支不碰 registry）', () => {
    const m = sdkBackendSrcLco.match(/infoSubtype === 'api_retry'[\s\S]*?continue;/);
    if (!m) throw new Error('api_retry 分支未找到');
    assert.ok(!/sdkCommandRegistry/.test(m[0]), 'api_retry 分支不应触碰命令 registry（不清空命令）');
  });
  check('commands_changed 不重新调 supportedCommands（SDK 官定 REPLACE，不 refetch）', () => {
    const m = sdkBackendSrcLco.match(/subtype === 'commands_changed'[\s\S]*?continue;/);
    if (!m) throw new Error('commands_changed 分支未找到');
    assert.ok(!/supportedCommands/.test(m[0]), 'commands_changed 不应重调 supportedCommands');
  });
  check('命令推送/落库出口均有 isSessionActive 守卫（迟到事件对已删会话无效）', () => {
    const emitM = sdkBackendSrcLco.match(/function emitCommandChanged[\s\S]*?\n}/);
    const persistM = sdkBackendSrcLco.match(/function persistLocalCommandOutput[\s\S]*?\n}/);
    assert.ok(emitM && emitM[0].includes('isSessionActive'), 'emitCommandChanged 应有 isSessionActive 守卫');
    assert.ok(persistM && persistM[0].includes('isSessionActive'), 'persistLocalCommandOutput 应有 isSessionActive 守卫');
  });

  console.log('=== 15) Review F1-F4 修复契约 ===');
  // F4：registry revision 代际（纯函数，可测）
  check('F4 registry.getRevision 单调递增，clear 归零', () => {
    const reg = new SdkCommandRegistry();
    assert.equal(reg.getRevision('a'), 0);
    reg.replace('a', [{ name: 'goal', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
    assert.equal(reg.getRevision('a'), 1);
    reg.replace('a', [{ name: 'usage', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'changed');
    assert.equal(reg.getRevision('a'), 2);
    reg.clear('a');
    assert.equal(reg.getRevision('a'), 0);
  });
  // review-v4 §5.2：revision 防旧回写——异步 probe 完成时若代际已变（期间发生 commands_changed），
  // 须跳过写入，防旧 probe 覆盖新命令列表。行为模拟生产代码中的 startRev === getRevision 守卫。
  check('review-v4 §5.2: revision 防旧回写——旧 probe 代际不匹配时跳过写入（行为模拟）', () => {
    const reg = new SdkCommandRegistry();
    const sid = 'test-stale-probe';
    // ① probe 启动时捕获代际
    const startRev = reg.getRevision(sid); // 0
    // ② probe 进行中，commands_changed 先到达 → replace 翻代际（写入新命令）
    reg.replace(sid, [{ name: 'fresh-cmd', description: 'from commands_changed' }], 'changed');
    const currentRev = reg.getRevision(sid); // 1
    // ③ probe 完成——代际不匹配 → 跳过写入（防旧覆盖新）
    assert.notEqual(startRev, currentRev, 'probe 期间发生 commands_changed → 代际不匹配 → 须跳过旧 probe 写入');
    // ④ commands_changed 的新命令须保留（未被旧 probe 覆盖）
    const snap = reg.get(sid);
    assert.ok(
      snap.commands.some((c) => c.name === 'fresh-cmd'),
      'commands_changed 写入的命令须保留（旧 probe 未覆盖）',
    );
    // ⑤ 对比：若期间无 commands_changed（代际匹配），probe 写入正常
    const sid2 = 'test-fresh-probe';
    const startRev2 = reg.getRevision(sid2); // 0
    reg.replace(sid2, [{ name: 'probe-cmd', description: 'from probe' }], 'probe');
    assert.equal(startRev2, reg.getRevision(sid2) - 1, '无 commands_changed 时 probe 正常写入（代际匹配）');
  });
  // F1：SESSION_CREATE 登记会话，probe 真正启动
  check('F1 SESSION_CREATE 调 markSessionActive 登记会话（probe 守卫可通过）', () => {
    const ipc = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/markSessionActive\(session\.id\)/.test(ipc), 'SESSION_CREATE 应 markSessionActive(session.id)');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export function markSessionActive/.test(backend), 'markSessionActive 应导出');
  });
  // F2 + review-v1 F6：probe 复用会话 SDK 上下文（settings 投影 / 模型映射 / 会话权限）。
  // F6 后 settings 投影与权限更新统一收口到 buildClaudeLinkSettingsBlock，query 与 probe 共用同一
  // 构造（杜绝配置漂移），因此断言 buildProbeSdkOptions 调用统一构造、且该构造内含投影与权限逻辑。
  check('F2/F6 probe 与 query 共用统一 settings 构造（buildClaudeLinkSettingsBlock 含投影/权限）', () => {
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/function buildProbeSdkOptions/.test(backend), '应存在 buildProbeSdkOptions');
    const m = backend.match(/function buildProbeSdkOptions[\s\S]*?return \{ options, exe \};/);
    if (!m) throw new Error('buildProbeSdkOptions 未找到');
    assert.ok(m[0].includes('buildClaudeLinkSettingsBlock'), 'probe 应调用统一 settings 构造（F6）');
    assert.ok(m[0].includes('resolveAliasToActualModel'), 'probe 应用模型别名映射');
    const block = backend.match(/function buildClaudeLinkSettingsBlock[\s\S]*?\n}/);
    if (!block) throw new Error('buildClaudeLinkSettingsBlock 未找到');
    assert.ok(block[0].includes('buildClaudeSettingsProjection'), '统一 settings 构造应应用 settings 投影');
    assert.ok(block[0].includes('applySessionPermissionUpdates'), '统一 settings 构造应应用会话权限更新');
  });
  // F3：SESSION_UPDATE workingDir 变化触发重新 probe；startCommandProbe 标 stale
  check('F3 workingDir 变化触发重新 probe（SESSION_UPDATE + stale 标记）', () => {
    const ipc = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/data\.workingDir/.test(ipc) && /startCommandProbe\(/.test(ipc), 'SESSION_UPDATE 应在 workingDir 更新后 startCommandProbe');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/'stale'/.test(backend), 'startCommandProbe 重新探测应标 stale（保留旧命令）');
  });
  // F4：异步 supportedCommands 结果用 getRevision 校验（防旧 probe 覆盖较新 commands_changed）
  check('F4 supportedCommands 异步结果用 getRevision 代际校验（防旧覆盖新）', () => {
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(backend.includes('getRevision(sessionId)'), 'probe/init fallback 应校验 revision');
    assert.ok(/getRevision\(sessionId\) === startRev/.test(backend), '应校验 startRev === 当前 revision');
  });

  console.log('=== 16) Review F5 命令输出去重契约 ===');
  const mkMsg = (role: Message['role'], content: string | null, processKind: string | null): Message =>
    ({
      id: 'x',
      sessionId: 's',
      role,
      content,
      rawEvent: null,
      eventType: 'message',
      costUsd: null,
      durationMs: null,
      parentTaskId: null,
      processKind,
      parentAgentId: null,
      toolUseId: null,
    }) as Message;
  check('F5 result-only：无相同 local 输出 → false（需补 assistant 正文）', () => {
    assert.equal(hasLocalCommandOutputMessage([], 'X'), false);
    assert.equal(hasLocalCommandOutputMessage([mkMsg('assistant', 'A', null)], 'X'), false);
  });
  check('F5 local+相同 result → true（去重，不重复展示）', () => {
    const messages = [mkMsg('user', '/usage', null), mkMsg('system', 'X', 'system:local_command_output')];
    assert.equal(hasLocalCommandOutputMessage(messages, 'X'), true);
  });
  check('F5 local+不同 result → false（都保留）', () => {
    const messages = [mkMsg('user', '/usage', null), mkMsg('system', 'X', 'system:local_command_output')];
    assert.equal(hasLocalCommandOutputMessage(messages, 'Y'), false);
  });
  check('F5 只查本回合（用户消息之后）', () => {
    const messages = [
      mkMsg('system', 'X', 'system:local_command_output'), // 上一回合
      mkMsg('user', '新消息', null),
      mkMsg('system', 'Z', 'system:local_command_output'), // 本回合
    ];
    assert.equal(hasLocalCommandOutputMessage(messages, 'X'), false);
    assert.equal(hasLocalCommandOutputMessage(messages, 'Z'), true);
  });
  check('F5 ensureResultMessage 调用去重（源码契约）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'composables', 'use-chat.ts'), 'utf8');
    assert.ok(src.includes('hasLocalCommandOutputMessage'), 'ensureResultMessage 应调用 hasLocalCommandOutputMessage');
  });

  console.log('=== 17) Review-v2 N1-N4 修复契约 ===');
  const sessionFields = {
    id: 's1',
    name: '会话',
    model: 'sonnet',
    modelOverride: 'opus',
    workingDir: null,
    permissionMode: 'plan',
    maxTurns: 50,
    thinkingLevel: 'high',
  } as Session;
  // N1：增量 opts 由会话配置补全（纯函数）
  check('N1 mergeSpawnOptions 用会话配置补全增量 opts（modelOverride/permissionMode/thinkingLevel）', () => {
    const merged = mergeSpawnOptions(sessionFields, { workingDir: 'D:/proj' });
    assert.equal(merged.modelOverride, 'opus');
    assert.equal(merged.permissionMode, 'plan');
    assert.equal(merged.thinkingLevel, 'high');
    assert.equal(merged.maxTurns, 50);
    assert.equal(merged.workingDir, 'D:/proj'); // 增量优先
  });
  check('N1 mergeSpawnOptions 无会话时原样返回 opts', () => {
    assert.deepEqual(mergeSpawnOptions(null, { workingDir: 'D:/proj' }), { workingDir: 'D:/proj' });
  });
  check('N1 mergeSpawnOptions workingDir:null 保持 null（N2 清除场景）', () => {
    const merged = mergeSpawnOptions(sessionFields, { workingDir: null });
    assert.equal(merged.workingDir, null);
  });
  // N2：SESSION_UPDATE 条件含 null
  check('N2 SESSION_UPDATE 清除工作目录（null）也触发重新 probe', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(/data\.workingDir !== undefined/.test(src), '条件应为 workingDir !== undefined（string 和 null 都触发）');
  });
  // N3：startCommandProbe async + 等待旧 probe + 活跃 query 检查
  check('N3 startCommandProbe 等待旧 probe 取消 + 活跃聊天 query 检查', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export async function startCommandProbe/.test(src), 'startCommandProbe 应为 async');
    assert.ok(/await cancelCommandProbeInternal/.test(src), '应等待旧 probe 取消完成');
    assert.ok(/isEntryActive/.test(src), '应检查活跃聊天 query（活跃时只标 stale）');
  });
  // N4：COMMANDS_GET 无快照触发 probe + switchSession load
  // （report-v1 N6：COMMANDS_GET 改写为「正向 has 判断 + 无快照 markSessionActive + startCommandProbe」，
  //   语义不变——无 per-session 快照仍触发 probe；此处只钉住该接线仍存在。）
  check('N4 COMMANDS_GET 无快照时异步启动 probe（重启后打开已有会话）', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    const m = src.match(/IPC_CHANNELS\.COMMANDS_GET[\s\S]*?(?=ipcMain\.handle)/);
    if (!m) throw new Error('COMMANDS_GET handler 未找到');
    assert.ok(m[0].includes('sdkCommandRegistry.has(sessionId)'), 'COMMANDS_GET 应按 per-session 快照判断');
    assert.ok(m[0].includes('startCommandProbe'), '无快照时应触发 probe');
  });
  check('N4 switchSession 触发 commandStore.load（重启后已有会话加载命令）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
    assert.ok(
      /switchSession[\s\S]*?useCommandStore\(\)\.load\(session\.id\)/.test(src),
      'switchSession 应 commandStore.load',
    );
  });

  console.log('=== 18) Review-v3 N5 + O1 + O3 修复契约 ===');
  // N5：startCommandProbe 守卫放宽——DB 中真实存在的会话（重启后 activeSessions 为空）也能探测
  check('N5 startCommandProbe 对 DB 存在会话放宽 isSessionActive 守卫', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(
      /!isSessionActive\(sessionId\) && !sessionFromDb/.test(src),
      '守卫应为「内存活跃 或 DB 会话存在」',
    );
    assert.ok(src.includes('sessionRepo.getSession(sessionId)'), 'probe 应从 DB 读取会话判断存活');
  });
  // O1：buildProbeSdkOptions 调用在 try/catch 内（fire-and-forget 无 unhandled rejection）
  check('O1 buildProbeSdkOptions 调用包 try/catch（失败标 degraded）', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    const m = src.match(/export async function startCommandProbe[\s\S]*?await donePromise;/);
    if (!m) throw new Error('startCommandProbe 未找到');
    assert.ok(
      /try \{[\s\S]*?buildProbeSdkOptions[\s\S]*?\} catch/.test(m[0]),
      'buildProbeSdkOptions 应在 try/catch 内',
    );
    assert.ok(m[0].includes("'degraded'"), '失败应标 degraded');
  });
  // O3：supportedCommands 超时定时器清理
  check('O3 supportedCommands 超时定时器 clearTimeout 清理', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(src.includes('clearTimeout(timeoutTimer)'), 'supportedCommands 超时应清理定时器');
  });

  console.log('=== 19) Report-v1：启动兜底 + N6 运行期 + 菜单精简 ===');
  // registry globalFallback 纯函数行为
  check('globalFallback 写入/读取/清空 + 哨兵 sessionId', () => {
    const reg = new SdkCommandRegistry();
    assert.strictEqual(reg.getGlobalFallback(), null, '初始无兜底');
    const snap = reg.setGlobalFallback(
      [{ name: 'foo', description: 'd', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      'probe',
    );
    assert.strictEqual(snap.status, 'ready');
    assert.strictEqual(snap.sessionId, GLOBAL_FALLBACK_SESSION_ID, '兜底快照用哨兵 sessionId');
    assert.strictEqual(reg.getGlobalFallback(), snap, 'getGlobalFallback 返回刚写入的快照');
    reg.clearGlobalFallback();
    assert.strictEqual(reg.getGlobalFallback(), null, '清空后无兜底');
  });
  check('globalFallback 清洗去重与 replace 同款', () => {
    const reg = new SdkCommandRegistry();
    const snap = reg.setGlobalFallback(
      [
        { name: 'foo', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' },
        { name: 'Foo', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }, // 同名大小写去重
        { name: '', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }, // 空 name 丢弃
        null,
      ],
      'probe',
    );
    assert.strictEqual(snap.commands.length, 1, '去重 + 丢弃空名后应只剩 1 条');
    assert.strictEqual(snap.commands[0].name, 'foo');
  });
  check('clear(sessionId) 不影响 globalFallback（per-session 优先且隔离）', () => {
    const reg = new SdkCommandRegistry();
    reg.replace('s1', [{ name: 'a', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
    reg.setGlobalFallback([{ name: 'g', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
    reg.clear('s1');
    assert.strictEqual(reg.has('s1'), false);
    assert.ok(reg.getGlobalFallback() !== null, '清 per-session 不应影响 globalFallback');
  });
  check('get/has 语义不受 globalFallback 影响（无 per-session 仍 loading）', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback([{ name: 'g', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'probe');
    const got = reg.get('s1');
    assert.strictEqual(got.status, 'loading', '无 per-session 快照时 get 仍返回 loading 默认');
    assert.strictEqual(got.commands.length, 0);
    assert.strictEqual(reg.has('s1'), false, 'has 不因 globalFallback 变 true');
  });
  // N6 运行期：COMMANDS_GET 无快照 markSessionActive + 兜底回填
  check('N6 运行期：COMMANDS_GET 无快照 markSessionActive + getGlobalFallback 回填', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    const m = src.match(/IPC_CHANNELS\.COMMANDS_GET[\s\S]*?(?=ipcMain\.handle)/);
    if (!m) throw new Error('COMMANDS_GET handler 未找到');
    assert.ok(m[0].includes('sessionRepo.getSession(sessionId)'), '无快照应先验证 DB 会话存在');
    assert.ok(m[0].includes('markSessionActive(sessionId)'), '已知会话无快照才登记 active 让 probe 下游守卫放行');
    assert.ok(m[0].includes('getGlobalFallback()'), '无快照应回填全局兜底');
    assert.ok(m[0].includes("'cache'"), '回填快照 source 应为 cache');
  });
  // 全局兜底探测接线
  check('全局兜底探测：runGlobalCommandProbe / cancelGlobalCommandProbe 接线', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export function runGlobalCommandProbe/.test(src), '应 export runGlobalCommandProbe');
    assert.ok(/export async function cancelGlobalCommandProbe/.test(src), '应 export cancelGlobalCommandProbe');
    assert.ok(src.includes('GLOBAL_PROBE_SESSION_ID'), '全局探测应用哨兵 sessionId（不污染 per-session map）');
    assert.ok(src.includes('sdkCommandRegistry.setGlobalFallback'), '全局探测应写入 globalFallback');
  });
  check('全局探测启动触发 + 退出清理（index.ts）', () => {
    const src = readFileSync(path.join('src', 'main', 'index.ts'), 'utf8');
    assert.ok(src.includes('runGlobalCommandProbe'), 'app.whenReady 应触发全局探测');
    assert.ok(src.includes('cancelGlobalCommandProbe'), '退出时应 cancelGlobalCommandProbe 防孤儿进程');
  });
  // 菜单精简：仅 /命令名
  check('菜单精简：ChatInput 仅 /命令名，无 desc/hint-arg', () => {
    const src = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
    assert.ok(!src.includes('slash-menu__desc'), '不应再有 slash-menu__desc');
    assert.ok(!src.includes('slash-menu__hint-arg'), '不应再有 slash-menu__hint-arg');
    assert.ok(src.includes('/{{ cmd.name }}'), '菜单应显示 /命令名');
  });

  console.log('=== 20) Review-v5 N7：globalFallback 不被 loading/degraded 清空 ===');
  // setStatusPreservingCommands 纯函数行为
  check('N7 setStatusPreservingCommands：无 per-session 快照时 loading 携带 globalFallback 命令', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.status, 'loading');
    assert.strictEqual(snap.commands.length, 1, 'loading 应携带 globalFallback 命令，不清空');
    assert.strictEqual(snap.commands[0].name, 'global-cmd');
    assert.strictEqual(snap.source, 'cache', '命令取自 globalFallback 时 source 标 cache');
  });
  check('N7 setStatusPreservingCommands：degraded 同样保留 globalFallback 命令（异常容错）', () => {
    const reg = new SdkCommandRegistry();
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'degraded', '探测失败');
    assert.strictEqual(snap.status, 'degraded');
    assert.strictEqual(snap.commands.length, 1, 'degraded 不应清空兜底命令');
    assert.ok(snap.error, 'degraded 应携带 error');
  });
  check('N7 setStatusPreservingCommands：有 per-session 命令时优先保留（per-session 优先于兜底）', () => {
    const reg = new SdkCommandRegistry();
    reg.replace('s1', [{ name: 'session-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }], 'init');
    reg.setGlobalFallback(
      [{ name: 'global-cmd', description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' }],
      'probe',
    );
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.commands.length, 1);
    assert.strictEqual(snap.commands[0].name, 'session-cmd', 'per-session 命令优先于 globalFallback');
  });
  check('N7 setStatusPreservingCommands：无 globalFallback 时 0 命令（兼容现状）', () => {
    const reg = new SdkCommandRegistry();
    const snap = reg.setStatusPreservingCommands('s1', 'loading');
    assert.strictEqual(snap.commands.length, 0);
  });
  // 源码契约：probe 的 non-ready 推送均改用 setStatusPreservingCommands（无残留裸 setStatus 调用）
  check('N7 源码：sdk-backend 的 loading/degraded/stale 推送均用 setStatusPreservingCommands', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/setStatusPreservingCommands\(sessionId, 'loading'/.test(src), '初始 loading 应保留兜底命令');
    assert.ok(/setStatusPreservingCommands\(sessionId, 'degraded'/.test(src), '失败 degraded 应保留兜底命令');
    assert.ok(
      !/sdkCommandRegistry\.setStatus\(/.test(src),
      '不应残留裸 sdkCommandRegistry.setStatus( 调用（9 处应全改为 setStatusPreservingCommands）',
    );
  });
  // 源码契约：回填按 commands 空判断（不再被 has(sid) 跳过）
  check('N7 源码：applyGlobalProbeCommands 回填按 commands 空判断 + 保留会话 status', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    const m = src.match(/async function applyGlobalProbeCommands[\s\S]*?clearTimeout\(timeoutTimer\)/);
    if (!m) throw new Error('applyGlobalProbeCommands 未找到');
    assert.ok(m[0].includes('current.commands.length > 0'), '回填应按 commands 空判断，而非 has(sid)');
    assert.ok(m[0].includes('setStatusPreservingCommands(sid, current.status)'), '回填应保留会话当前 status 并补 cache 命令');
  });
  // renderer 行为：cache → loading(携带命令) → ready 序列，命令不被清空
  check('N7 renderer：cache → loading(携带命令) → ready，中途不清空、最终为真实命令', () => {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const sid = 'n7-renderer';
    const cmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' });
    const snap = (
      commands: SdkCommand[],
      status: SessionCommandSnapshot['status'],
      source: SessionCommandSnapshot['source'],
    ): SessionCommandSnapshot => ({ sessionId: sid, commands, status, source, updatedAt: null });
    // ① COMMANDS_GET 返回 cache（全局兜底立即显示）
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'ready', 'cache') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'cache 应有命令');
    // ② COMMANDS_CHANGED 推 loading（携带 cache 命令，N7 修复）——不应清空
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'loading', 'cache') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'loading 携带命令，不被清空');
    assert.strictEqual(store.activeSnapshot(sid).status, 'loading');
    // ③ per-session probe 成功 → 真实命令替换 cache（per-session 仍优先）
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('real-cmd')], 'ready', 'probe') });
    assert.strictEqual(store.activeSnapshot(sid).commands[0].name, 'real-cmd');
    assert.strictEqual(store.activeSnapshot(sid).status, 'ready');
  });
  // 失败路径：degraded(携带命令) 不清空 cache（异常容错）
  check('N7 renderer：degraded(携带命令) 覆盖 cache，命令仍可用（异常容错）', () => {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const sid = 'n7-degraded';
    const cmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' });
    const snap = (
      commands: SdkCommand[],
      status: SessionCommandSnapshot['status'],
      source: SessionCommandSnapshot['source'],
      error?: string,
    ): SessionCommandSnapshot => ({ sessionId: sid, commands, status, source, updatedAt: null, ...(error ? { error } : {}) });
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'ready', 'cache') });
    // per-session probe 失败 → degraded 携带 cache 命令（N7 修复），不清空
    store.replaceFromEvent({ sessionId: sid, snapshot: snap([cmd('cache-cmd')], 'degraded', 'cache', '探测失败') });
    assert.strictEqual(store.activeSnapshot(sid).commands.length, 1, 'degraded 应保留兜底命令');
    assert.strictEqual(store.activeSnapshot(sid).status, 'degraded');
  });

  console.log('=== 21) Task 5 /init 闭环契约（源码）===');

  check('ChatPage 无工作空间时阻止发送（ensureWorkspace 校验 activeSession.workingDir）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
    assert.ok(src.includes('ensureWorkspace'), 'ChatPage 应有 ensureWorkspace 函数');
    assert.ok(
      /if\s*\(store\.activeSession\?\.workingDir\)\s*return true/.test(src),
      'ensureWorkspace 应校验 activeSession.workingDir（无工作目录阻止发送）',
    );
    assert.ok(src.includes('if (!ensureWorkspace()) return;'), 'handleSend 应调用 ensureWorkspace 阻止无工作空间发送');
  });

  check('e2e 已实现 --init-matrix 模式并复用 runNativeCommand 真实 harness', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('--init-matrix'), 'e2e 应识别 --init-matrix mode');
    assert.ok(src.includes('runInitMatrixMode'), '应存在 runInitMatrixMode');
    assert.ok(src.includes('await runInit(sdk, exe,'), '矩阵应经 runInit 执行 /init（调用链：runInitMatrixMode → runInit → runNativeCommand）');
    assert.ok(src.includes('runNativeCommand'), 'runInit 应复用 runNativeCommand harness');
  });

  check('/init 成功证据固化：文件存在 + 是文件 + 非空 + 成功终态', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    // assertInitSuccessFile 把 CLAUDE.md 提到 const file = path.join(cwd, 'CLAUDE.md') 后统一断言。
    assert.ok(src.includes("path.join(cwd, 'CLAUDE.md')"), '应解析 cwd 下的 CLAUDE.md 路径');
    assert.ok(src.includes('existsSync(file)'), '应断言 CLAUDE.md 存在');
    assert.ok(src.includes('.isFile()'), '应断言是文件');
    assert.ok(src.includes(".trim().length > 0"), '应断言非空');
    assert.ok(
      src.includes('is_error === false') || src.includes('is_error, false'),
      '应断言成功终态 is_error=false',
    );
  });

  check('selftest:native 已接入 --init-matrix（发布门禁执行 /init 全矩阵）', () => {
    const pkg = readFileSync(path.join('package.json'), 'utf8');
    assert.ok(
      /"selftest:native": "npm run selftest:static && node scripts\/run-native-chain\.mjs"/.test(pkg),
      'selftest:native 应经 run-native-chain.mjs 执行 native 链',
    );
    const chain = readFileSync(path.join('scripts', 'run-native-chain.mjs'), 'utf8');
    assert.ok(chain.includes('--native --init-matrix'), 'run-native-chain.mjs 应含 --native --init-matrix');
  });

  check('init-matrix 凭据缺失时须以退出码 2 结束（SKIP 不算 PASS，发布门禁拒绝前置缺失）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('process.exit(2)'), '凭据缺失应非零退出（exit 2 前置条件缺失）');
    assert.ok(
      /if \(!creds\)[\s\S]{0,400}process\.exit\(2\)/.test(src),
      'exit 2 应挂在 !creds 分支（全矩阵被 SKIP 不得绿色通过）',
    );
  });

  console.log('=== 22) review-v1/v2/v3/v4 修复契约（P1-1/P1-2/v2-P1/v2-P2×2/v3-P1/v4-P1/v4-P2 seam）===');

  // P1-1：用户级/项目级 CLAUDE.md 不得用「仅输出 X」互斥措辞（复用同一次 query 时模型只能满足一条，
  // 导致⑤项 flaky）。改为「包含自己的标记」协调协议；prompt 不泄漏具体标记值。
  check('P1-1：fixture 无「仅输出」互斥，改为「包含标记」协调协议', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(!/仅输出 USER_RULE_RESPONSE_7F31/.test(src), '用户级 CLAUDE.md 不得用「仅输出」互斥措辞');
    assert.ok(!/仅输出 PROJECT_RULE_RESPONSE_9C42/.test(src), '项目级 CLAUDE.md 不得用「仅输出」互斥措辞');
    assert.ok(src.includes('包含标记 USER_RULE_RESPONSE_7F31'), '用户级应改为「包含标记」协调协议');
    assert.ok(src.includes('包含标记 PROJECT_RULE_RESPONSE_9C42'), '项目级应改为「包含标记」协调协议');
    // prompt 不得泄漏具体标记值（7F31/9C42），否则不能证明 CLAUDE.md 进入上下文。
    const promptLine = src.match(/prompt: '[^']*所有规则要求的标记[^']*'/);
    assert.ok(promptLine, 'prompt 应要求「所有规则要求的标记都出现」且不泄漏具体值');
    assert.ok(!/prompt: '[^']*7F31/.test(src) && !/prompt: '[^']*9C42/.test(src), 'prompt 不得含具体标记值');
  });

  // P1-2：只读目录不得用「cwd 不存在」代理（那是启动错误，非写权限失败）。用 ACL 构造 + accessSync 探测，
  // 探测失败时诚实 SKIP（不用 cwd 不存在代理）。
  check('P1-2：只读目录用 ACL 构造 + accessSync 探测，不用 cwd 不存在代理', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('tryMakeDirReadOnly'), '应有 tryMakeDirReadOnly 辅助');
    assert.ok(src.includes('accessSync(dir, constants.W_OK)'), '应用 accessSync(W_OK) 探测不可写');
    assert.ok(src.includes('/inheritance:r'), 'Windows 应用 icacls /inheritance:r 移除继承');
    assert.ok(src.includes('restoreDirWritable'), '应有 restoreDirWritable 恢复权限便于清理');
    assert.ok(
      !/以 cwd 不存在覆盖不可写语义/.test(src),
      '不得保留「以 cwd 不存在覆盖不可写语义」代理措辞',
    );
  });

  // v2-P1（review-v2 P1）：未执行文件写入须用独立 init_write_skipped 事件——informational 会被
  // isRedundantSystemProcessKind 冗余过滤吞掉（review-v2 P1）。独立 subtype 不被过滤、独立展示。
  check('v2-P1：未执行文件写入用独立 init_write_skipped 事件，不被冗余过滤、独立展示', () => {
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(
      backend.includes("subtype: 'init_write_skipped'"),
      '主进程应用独立 init_write_skipped subtype（非 informational，避免被冗余过滤）',
    );
    assert.ok(backend.includes('initTargetFile') && backend.includes('initFileExistedBefore'), '应记录 /init 文件副作用状态');
    // review-v3 P1：与 result.is_error 解耦——plan/deny（is_error=true）未写入也发 init_write_skipped。
    assert.ok(
      !backend.includes('sdkMsg.is_error !== true && !existsSync(initTargetFile)'),
      '不得保留 is_error !== true 条件（review-v3 P1：plan/权限拒绝未写入也须发提示）',
    );
    assert.ok(
      /if \(initTargetFile && !initFileExistedBefore && !existsSync\(initTargetFile\)\)/.test(backend),
      '触发条件应为 initTargetFile && !initFileExistedBefore && !existsSync(initTargetFile)（与 is_error 解耦）',
    );
    const cli = readFileSync(path.join('src', 'shared', 'types', 'cli.ts'), 'utf8');
    assert.ok(cli.includes("'init_write_skipped'"), 'CliSystemInfoEvent.subtype 联合应含 init_write_skipped');
    // isRedundantSystemProcessKind 不得把 init_write_skipped 判冗余（否则又被过滤）。
    const sysinfo = readFileSync(path.join('src', 'shared', 'system-info.ts'), 'utf8');
    assert.ok(!sysinfo.includes('system:init_write_skipped'), 'isRedundantSystemProcessKind 不得含 init_write_skipped');
    // group-messages 须让 init_write_skipped 独立展示（不进 fold，否则被折叠隐藏）。
    const group = readFileSync(path.join('src', 'renderer', 'utils', 'group-messages.ts'), 'utf8');
    assert.ok(group.includes("'system:init_write_skipped'"), 'group-messages 应让 init_write_skipped 独立展示（不进 fold）');
    // MessageBubble 对 system role 隐藏 bubble__role（避免「Claude」误导居中横幅）。
    const bubble = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'MessageBubble.vue'), 'utf8');
    assert.ok(/v-if="message\.role !== 'system'"/.test(bubble), 'MessageBubble 对 system role 应隐藏 bubble__role');
  });

  // v3-P1（review-v3 P1）：plan/权限拒绝导致 /init 未写入（is_error=true）时也须发 init_write_skipped。
  // 产品层已与 is_error 解耦；e2e 补 /init + canUseTool deny Write 真实交互场景，验证 SDK 行为
  // （不落盘 + result 非成功），保留 deny 语义的同时让产品层能显示「未写入」原因。
  check('v3-P1：/init deny Write 真实交互 E2E（plan/deny 未写入有 SDK 证据）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('/init 用户 deny Write'), 'e2e 应有 /init + canUseTool deny Write 场景（区别于 plan 自动拦截）');
    assert.ok(src.includes("toolName === 'Write'"), 'canUseTool 应区分 Write 工具拒绝（其他放行）');
    assert.ok(src.includes('writeDenied'), '应追踪 canUseTool 对 Write 的 deny 次数（证明 deny 生效）');
    assert.ok(src.includes('deny Write 后不得落盘'), '应断言 deny Write 后不落盘 CLAUDE.md（核心 deny 语义，不伪造写入）');
  });

  // v4-P1（review-v4）：native /init harness 与 CLI API_TIMEOUT_MS 同值（300s）导致竞争——端点稍慢
  // 外层先触发，abort 压制真实 result。修正：harness wall-clock 解耦（> API_TIMEOUT_MS + 余量）+
  // 终止协议先 interrupt+有界 grace 再 abort（旧 abort→interrupt 顺序压制 result）。result 强断言不变。
  check('v4-P1：harness deadline 与 API_TIMEOUT_MS 解耦 + 终止协议 interrupt+grace→abort', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('harnessInitDeadlineMs'), '应有 harnessInitDeadlineMs（wall-clock > API_TIMEOUT_MS）');
    assert.ok(/base \+ 180000/.test(src), 'harness deadline 应 = API_TIMEOUT_MS + 余量（修正同值竞争）');
    assert.ok(!/timeoutMs: 300000(?!\d)/.test(src), '不得保留硬编码 timeoutMs: 300000（应经 harnessInitDeadlineMs 解耦）');
    assert.ok(src.includes('graceAfterTimeoutMs'), '应有 graceAfterTimeoutMs（有界 grace 等 SDK 真实 result）');
    assert.ok(src.includes('let forcedAbort = false'), '应有 forcedAbort 标记（grace 后仍无终态才硬 abort 兜底）');
  });

  // v4-P2（review-v4）：生产链路 E2E 前置——test-only query factory seam，让 Electron smoke 能注入
  // fake query 驱动真实 runQuery/forwardEvent/DB，不调真实 CLI/模型。默认仍用真实 SDK。
  check('v4-P2：test-only query factory seam（startSdkQuery 可注入，默认用真实 SDK）', () => {
    const src = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(src.includes('__setSdkQueryFactoryForTest'), '应导出 test-only __setSdkQueryFactoryForTest');
    assert.ok(src.includes('activeSdkQueryFactory'), 'startSdkQuery 应经 activeSdkQueryFactory（可注入）');
    assert.ok(src.includes('defaultSdkQueryFactory'), '应有默认 factory（调真实 importSdk + sdk.query）');
    assert.ok(/defaultSdkQueryFactory[\s\S]{0,120}importSdk[\s\S]{0,60}sdk\.query/.test(src), '默认 factory 应调真实 importSdk + sdk.query');
  });

  // v2-P2（review-v2 P2）：带附件时 prompt 是 AsyncIterable，typeof string 判定失效。用 SpawnOptions
  // .userCommandText 保留原始命令文本，runQuery 优先用它，不从 AsyncIterable 反推命令名。
  check('v2-P2：带附件 /init 用 userCommandText 保留原始命令判定', () => {
    const opts = readFileSync(path.join('src', 'main', 'modules', 'cli-shared.ts'), 'utf8');
    assert.ok(opts.includes('userCommandText?: string'), 'SpawnOptions 应含 userCommandText 字段');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(backend.includes('opts.userCommandText'), 'runQuery 应优先用 opts.userCommandText 判定 /init');
    const ipc = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    assert.ok(ipc.includes('userCommandText: payload.text'), 'CHAT_SEND spawnForChat 应传 payload.text');
    const taskq = readFileSync(path.join('src', 'main', 'modules', 'task-queue-engine.ts'), 'utf8');
    assert.ok(taskq.includes('userCommandText: task.prompt'), 'task spawnForTask 应传 task.prompt');
    assert.ok(taskq.includes('userCommandText: payload.text'), 'queue spawnForChat 应传 payload.text');
  });

  // v2-P2（review-v2 P2）：selftest 与 selftest:native 各调一次 native 链，env=1 时不重复。
  check('v2-P2：selftest 与 selftest:native 各调一次 native 链（env=1 不重复）', () => {
    const pkg = readFileSync(path.join('package.json'), 'utf8');
    assert.ok(/"selftest:static":/.test(pkg), '应拆出 selftest:static（纯静态链）');
    assert.ok(
      /"selftest": "npm run selftest:static && node scripts\/run-native-if-env\.mjs"/.test(pkg),
      'selftest = selftest:static + run-native-if-env.mjs',
    );
    assert.ok(
      /"selftest:native": "npm run selftest:static && node scripts\/run-native-chain\.mjs"/.test(pkg),
      'selftest:native = selftest:static + run-native-chain.mjs',
    );
    // selftest:native 不得调 selftest 或 run-native-if-env（否则 env=1 时 native 链重复）。
    const nativeMatch = pkg.match(/"selftest:native": "([^"]*)"/);
    assert.ok(nativeMatch, '应有 selftest:native');
    assert.ok(!nativeMatch![1].includes('npm run selftest"'), 'selftest:native 不得调 npm run selftest（避免重复）');
    assert.ok(!nativeMatch![1].includes('run-native-if-env'), 'selftest:native 不得经 run-native-if-env（避免重复）');
    const chain = readFileSync(path.join('scripts', 'run-native-chain.mjs'), 'utf8');
    assert.ok(chain.includes('--native --init-matrix') && chain.includes('--require-runtime-match'), 'run-native-chain.mjs 应含完整 native 段');
    const ifEnv = readFileSync(path.join('scripts', 'run-native-if-env.mjs'), 'utf8');
    assert.ok(ifEnv.includes('run-native-chain.mjs'), 'run-native-if-env.mjs 应委托 run-native-chain.mjs（单一命令源）');
    assert.ok(/CLAUDE_LINK_RUN_NATIVE_E2E !== '1'/.test(ifEnv), 'run-native-if-env.mjs 应在 env 未设时 exit 0');
  });

  // ── Task 6：候选平替等价性结构契约（Step 4 UI 不提前标注；Step 5 门禁接线）──
  console.log('=== 23) Task 6：候选平替等价性结构契约（不合格则回退原生执行）===');
  check('T6-1 矩阵 REPLACEMENT_CANDIDATES 文档化 5 候选、verdict 为 boolean|unverified、substitute 有实测 false', () => {
    assert.equal(REPLACEMENT_CANDIDATES.length, 5, '应有 5 个候选平替（计划 Task 6 Step 1）');
    for (const spec of REPLACEMENT_CANDIDATES) {
      assert.equal(spec.expectedEquivalent, false, `${spec.command} 候选未证明等价，expectedEquivalent 必须 false`);
      assert.ok(spec.equivalenceChecks.length > 0, `${spec.command} 缺 equivalenceChecks`);
      assert.ok(spec.note.length > 0, `${spec.command} 缺判定说明 note`);
      const fields = Object.keys(spec.verdict) as ReplacementField[];
      assert.equal(fields.length, 5, `${spec.command} verdict 须覆盖全部 5 个等价字段`);
      // review-v5 F4：布尔字段 = E2E 实测；'unverified' = 未证明，不得充当已验证的布尔值。
      for (const f of fields) {
        const v = spec.verdict[f];
        assert.ok(v === true || v === false || v === 'unverified', `${spec.command}.${f} verdict 只能是 boolean 或 'unverified'，实际 ${v}`);
      }
      if (spec.kind === 'substitute') {
        assert.ok(failingFieldsOf(spec).length > 0, `${spec.command} substitute 候选须至少一个实测 false 字段`);
        assert.ok(fields.some((f) => typeof spec.verdict[f] === 'boolean'), `${spec.command} substitute 候选须有实测布尔字段（不能全 unverified）`);
      }
      if (spec.kind === 'native-execution') {
        assert.ok(fields.every((f) => spec.verdict[f] === 'unverified'), `${spec.command} 为 native-execution，无平替等价验证，5 字段应全 unverified`);
      }
    }
  });
  check('T6-2 e2e-verify 已实现并接线 --replacements 模式（真实 SDK 证据断言规格）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    assert.ok(src.includes('async function runReplacementsMode'), '应定义 runReplacementsMode');
    assert.ok(src.includes("mode === '--replacements'"), '入口应接线 --replacements 分支');
    assert.ok(src.includes('REPLACEMENT_CANDIDATES'), '应导入矩阵 REPLACEMENT_CANDIDATES 规格（single source）');
  });
  check('T6-3 native 门禁链已纳入 --replacements（Task 6 Step 5 门禁）', () => {
    const chain = readFileSync(path.join('scripts', 'run-native-chain.mjs'), 'utf8');
    assert.ok(chain.includes('--native --replacements'), 'run-native-chain.mjs 应含 --replacements 门禁');
  });
  check('T6-4 候选命令以原生文本流向 SDK，不经本地拦截（无隐式命令翻译器）', () => {
    const routing = readFileSync(path.join('src', 'shared', 'command-routing.ts'), 'utf8');
    assert.ok(routing.includes('不充当发送白名单'), 'command-routing 声明不充当发送白名单');
    const useChat = readFileSync(path.join('src', 'renderer', 'composables', 'use-chat.ts'), 'utf8');
    // 4 个 substitute 候选不得在发送路径被拦截为本地操作（作为命令文本原样透传）。
    for (const c of ['clear', 'context', 'usage', 'config']) {
      assert.ok(!useChat.includes(`'/` + c + `'`), `use-chat 不得拦截 /${c} 为本地操作（保持原生发送）`);
    }
    // /compact 由 ChatPage.handleCompress 显式以原生命令文本发送（非本地模拟）。
    const chatPage = readFileSync(path.join('src', 'renderer', 'pages', 'ChatPage.vue'), 'utf8');
    assert.ok(chatPage.includes("'/compact'") && chatPage.includes('sendMessage('), '压缩入口以原生 /compact 文本发送');
  });
  check('T6-5 renderer 命令模型无提前等价标注（Step 4：不能把候选平替提前标为官方兼容）', () => {
    // Task 6 无一候选证明等价 → 运行时模型不得承载 proven-equivalent/executionMode 标记（Task 8 才做完整 UI provenance 展示）。
    const cmdType = readFileSync(path.join('src', 'shared', 'types', 'command.ts'), 'utf8');
    assert.ok(!cmdType.includes('proven-equivalent'), 'command.ts 不得含 proven-equivalent 运行时标记');
    assert.ok(!cmdType.includes('executionMode'), 'command.ts 不得含 executionMode 字段（矩阵规格不进入运行时模型）');
    const chatInput = readFileSync(path.join('src', 'renderer', 'components', 'chat', 'ChatInput.vue'), 'utf8');
    assert.ok(!chatInput.includes('Claude Link 等价操作'), 'ChatInput 不得提前把候选平替标为等价操作');
  });
  check('T6-6 review-v1 F1：--replacements 无凭据时 SKIP 计入退出码（SKIP 不算 PASS，exit 2）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    // ① SKIP 是独立结果状态（不是只打印日志）：无凭据时 /compact 真实压缩证据计为 skipped。
    assert.ok(/\bskipped\+\+/.test(src), 'runReplacementsMode 无凭据时须累计 skipped（SKIP 为独立状态）');
    assert.ok(/let skipped = 0/.test(src), '须声明 skip 计数初始值');
    // ② 汇总输出 skipped 计数，避免「0 failed」被误读为完整通过。
    assert.ok(/\$\{skipped\} skipped/.test(src), '汇总须输出 skipped 计数');
    // ③ native 触发下 skipped>0 → exit 2，且明示「SKIP 不算 PASS」（与 --init-matrix 同约定）。
    assert.ok(/skipped > 0/.test(src), '须以 skipped>0 判定前置条件缺失');
    assert.ok(/process\.exit\(2\)/.test(src), '前置条件缺失须 exit 2（发布门禁拒绝）');
    assert.ok(/SKIP 不算 PASS/.test(src), '须明示 SKIP 不算 PASS');
  });
  check('T6-7 review-v2 F1：/compact 收紧为只认 compact_boundary/compact_result:success（不再用泛化 hasStatus）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    // 收紧：只接受 compact_boundary 或 compact_result:'success' 作为真实压缩成功证据。
    assert.ok(/verifyCompactEvidence/.test(src), '应有 verifyCompactEvidence 共享 helper（--command/--replacements 复用）');
    assert.ok(/compact_result === 'success'/.test(src), '须以 compact_result:\'success\' 作为成功证据');
    assert.ok(/subtype === 'compact_boundary'/.test(src), '须保留 compact_boundary 作为成功证据');
    // 禁止旧泛化断言：任意 system:status（含 status:'compacting'/requesting）不证明压缩成功。
    assert.ok(!/hasBoundary \|\| hasLocalOutput \|\| hasStatus/.test(src), '不得保留 hasBoundary||hasLocalOutput||hasStatus 泛化断言（status 不证明压缩成功）');
    // 多轮 warmup：单轮短 warmup 实测让 /compact 因 "Not enough messages" 返回 compact_result:'failed'。
    assert.ok(/COMPACT_WARMUP_PROMPTS/.test(src), '须用 COMPACT_WARMUP_PROMPTS 多轮 warmup 堆积消息条数');
    assert.ok(/compact_result === 'failed'/.test(src), "须检测 compact_result:'failed' 并明示上下文不足须加 warmup");
  });
  check('T6-8 review-v2 F2：混合 fail+skip 时 fail 优先 exit 1，但抛错前打印 skipped 及原因', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    // 稳定退出协议：fail>0 时 exit 1（实现回归优先），但须先打印 skipped 诊断，避免丢失前置条件缺失信号。
    const summaryMatch = src.match(/\$\{pass\} passed, \$\{fail\} failed, \$\{skipped\} skipped[\s\S]*?process\.exit\(2\)/);
    assert.ok(summaryMatch, '汇总应先打印 pass/fail/skipped，再处理退出码');
    // fail 分支在 throw 前，须有 skipped>0 的诊断打印（混合结果不丢 SKIP 语义）。
    assert.ok(/if \(fail > 0\) \{[\s\S]*?skipped > 0[\s\S]*?另有[\s\S]*?throw/.test(src), 'fail>0 时抛错前须打印 skipped 及原因（review-v2 F2）');
    // skipped>0 && fail===0 → exit 2（前置条件缺失优先于「全过」假象）。
    assert.ok(/if \(skipped > 0\) \{[\s\S]*?process\.exit\(2\)/.test(src), 'fail===0 且 skipped>0 须 exit 2');
  });
  check('T6-9 review-v3 F1：--command 无凭据时 SKIP 计入退出码（runCommandMode 与 --replacements 同约定）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const cmdStart = src.indexOf('async function runCommandMode');
    const cmdEnd = src.indexOf('async function runSettingsMode');
    assert.ok(cmdStart >= 0 && cmdEnd > cmdStart, '应能定位 runCommandMode 源码段');
    const cmdSection = src.slice(cmdStart, cmdEnd);
    // 独立 skipped 计数。
    assert.ok(/let skipped = 0/.test(cmdSection), 'runCommandMode 须声明 skipped 计数');
    // 4 个凭据缺失 SKIP 点（/init、/compact、普通文本、取消/plan）均累计 skipped。
    const skipIncrements = (cmdSection.match(/\bskipped\+\+/g) || []).length;
    assert.ok(skipIncrements >= 4, `runCommandMode 须在 >=4 个无凭据 SKIP 点累计 skipped（实际 ${skipIncrements}）`);
    // 汇总输出 skipped + exit 2。
    assert.ok(/\$\{skipped\} skipped/.test(cmdSection), 'runCommandMode 汇总须输出 skipped 计数');
    assert.ok(/skipped > 0[\s\S]*?process\.exit\(2\)/.test(cmdSection), 'runCommandMode 须 skipped>0 时 exit 2（SKIP 不算 PASS）');
  });
  await asyncCheck('T6-10 review-v3 F2：HOME 与 USERPROFILE 分离时凭据解析检查多候选目录', async () => {
    // F2 为 Windows/Git Bash 专属问题（Claude Code Windows 用户配置在 USERPROFILE）。
    if (process.platform !== 'win32') {
      console.log('  ℹ 非.Windows 平台不检查 USERPROFILE，T6-10 自动通过（F2 为 Windows 专属）');
      return;
    }
    // fixture：HOME 指向空目录、USERPROFILE 指向含 settings.json 的目录。
    // 旧逻辑 `HOME || USERPROFILE` 只看 HOME（空）→ 返回 null；新逻辑按平台检查多候选 → 解析出凭据。
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'tdd-creds-'));
    const emptyHome = path.join(tmpRoot, 'empty-home');
    mkdirSync(emptyHome, { recursive: true });
    const profileHome = path.join(tmpRoot, 'profile-home');
    mkdirSync(path.join(profileHome, '.claude'), { recursive: true });
    writeFileSync(
      path.join(profileHome, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'test-key-via-userprofile' } }),
      'utf8',
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.HOME = emptyHome;
    process.env.USERPROFILE = profileHome;
    try {
      // review-v4 F3：resolveInitCredentials 已改为 async + 接收 cwd（null = 只看 user/env 层）。
      const creds = await resolveInitCredentials(null);
      assert.ok(creds, 'HOME 空但 USERPROFILE 有 settings.json 时应解析出凭据（不得只看 HOME 返回 null）');
      assert.equal(creds!.env.ANTHROPIC_API_KEY, 'test-key-via-userprofile', '应来自 USERPROFILE 下的 settings.json');
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
  check('T6-11 review-v4 F1：--command 协议场景按 hasModelCommand 门控（本地命令请求不被模型场景阻断）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const cmdStart = src.indexOf('async function runCommandMode');
    const cmdEnd = src.indexOf('async function runSettingsMode');
    assert.ok(cmdStart >= 0 && cmdEnd > cmdStart, '应能定位 runCommandMode 源码段');
    const cmdSection = src.slice(cmdStart, cmdEnd);
    assert.ok(
      /hasModelCommand = prompts\.includes\('\/init'\) \|\| prompts\.includes\('\/compact'\)/.test(cmdSection),
      '应有 hasModelCommand（本次是否请求了需要模型的命令）',
    );
    assert.ok(/if \(hasModelCommand\) \{[\s\S]*?SKIP 普通文本验证/.test(cmdSection), '普通文本协议场景应受 hasModelCommand 门控');
    assert.ok(/if \(hasModelCommand\) \{[\s\S]*?SKIP 用户取消/.test(cmdSection), '取消/plan/deny 协议场景应受 hasModelCommand 门控');
    // 本地命令请求（如 --command /usage，hasModelCommand=false）不进入协议场景 → 不计 skip、不 exit 2。
    // executable/cwd 启动失败检查与模型无关，保持总运行（unconditional await check；不受 creds/hasModelCommand 门控，
    // 由 T6-9 的 skipped 计数与 `--command /usage` 无凭据 exit 0 行为共同保证，见 review-v4 F1 行为验证）。
    assert.ok(cmdSection.includes("await check('executable 缺失"), 'executable 启动检查应存在（总运行）');
    assert.ok(cmdSection.includes("await check('cwd 不存在"), 'cwd 启动检查应存在（总运行）');
  });
  await asyncCheck('T6-12 review-v4 F2：API Key 与 Auth Token 同时存在时只选一种（key 优先），child env 不含另一种', async () => {
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'tdd-creds-f2-'));
    const home = path.join(tmpRoot, 'home');
    mkdirSync(path.join(home, '.claude'), { recursive: true });
    // user settings 提供 Auth Token，process.env 提供 API Key → 优先级 key 胜，token 被删。
    writeFileSync(
      path.join(home, '.claude', 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'token-from-settings' } }),
      'utf8',
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
      // Case 1：env 有 API Key + user settings 有 Auth Token → 选 key，child env 删 token。
      process.env.ANTHROPIC_API_KEY = 'key-from-env';
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const creds1 = await resolveInitCredentials(null);
      assert.ok(creds1, '应解析出凭据');
      assert.equal(creds1!.env.ANTHROPIC_API_KEY, 'key-from-env', 'API Key 应优先（> Auth Token）');
      assert.ok(!('ANTHROPIC_AUTH_TOKEN' in creds1!.env), 'child env 不得同时含 Auth Token（避免 SDK 双重认证）');
      // Case 2：仅 Auth Token 可用（env 无 key、user settings 有 token）→ 用 token，child env 删 key。
      delete process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_AUTH_TOKEN;
      const creds2 = await resolveInitCredentials(null);
      assert.ok(creds2, '应解析出凭据（token 来源）');
      assert.equal(creds2!.env.ANTHROPIC_AUTH_TOKEN, 'token-from-settings', 'user settings 层提供 token（> env 无 token）');
      assert.ok(!('ANTHROPIC_API_KEY' in creds2!.env), '选 token 时 child env 不得含 API Key');
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
  await asyncCheck('T6-13 review-v4 F3：凭据解析读取 project/local settings 的 env（与生产一致）', async () => {
    // fixture：local settings 提供凭据（user 空、env 无）→ 旧逻辑只看 user 目录返回 null；新逻辑应解析出。
    const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'tdd-creds-f3-'));
    const userHome = path.join(tmpRoot, 'user');
    mkdirSync(path.join(userHome, '.claude'), { recursive: true });
    const cwd = path.join(tmpRoot, 'project');
    mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    writeFileSync(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'key-via-local' } }),
      'utf8',
    );
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    const prevKey = process.env.ANTHROPIC_API_KEY;
    const prevToken = process.env.ANTHROPIC_AUTH_TOKEN;
    process.env.HOME = userHome;
    process.env.USERPROFILE = userHome;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    try {
      const creds = await resolveInitCredentials(cwd);
      assert.ok(creds, 'local settings 提供凭据时应解析出（不得只看 user 目录返回 null，review-v4 F3）');
      assert.equal(creds!.env.ANTHROPIC_API_KEY, 'key-via-local', '应来自 cwd/.claude/settings.local.json');
      assert.ok(creds!.source.includes('local-settings'), `source 应标注 local-settings，实际 ${creds!.source}`);
    } finally {
      if (prevKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = prevKey;
      if (prevToken === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN; else process.env.ANTHROPIC_AUTH_TOKEN = prevToken;
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = prevProfile;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
  check('T6-14 review-v4 F4：compact warmup 每轮断言成功终态与会话连续性', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const helperStart = src.indexOf('async function verifyCompactEvidence');
    const helperEnd = src.indexOf('async function runCommandMode');
    assert.ok(helperStart >= 0 && helperEnd > helperStart, '应能定位 verifyCompactEvidence 源码段');
    const helper = src.slice(helperStart, helperEnd);
    assert.ok(/warmup 第 \$\{i \+ 1\} 轮须有 result 终态/.test(helper), '每轮 warmup 须断言 result 终态（review-v4 F4）');
    assert.ok(/warmup 第 \$\{i \+ 1\} 轮不得 is_error/.test(helper), '每轮 warmup 须断言 is_error=false（上下文连续）');
    assert.ok(/warmup 第 \$\{i \+ 1\} 轮须返回 system\.init\.session_id/.test(helper), '每轮 warmup 须断言 init.session_id 存在');
  });
  check('T6-15 review-v4 F5 / review-v5 F4：observedFields 与 verdict 逐字段绑定（布尔字段须观察一致，unverified 须未观察）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const modeStart = src.indexOf('async function runReplacementsMode');
    const modeEnd = src.indexOf('// ── 入口 ──');
    assert.ok(modeStart >= 0 && modeEnd > modeStart, '应能定位 runReplacementsMode 源码段');
    const modeSection = src.slice(modeStart, modeEnd);
    assert.ok(/const observedFields/.test(modeSection), 'runReplacementsMode 应有 observedFields 记录器');
    assert.ok(/recordObserved\(/.test(modeSection), '各候选 check 应 recordObserved 运行时观察');
    // 布尔字段（实测）必须被观察且逐字段一致；unverified 字段必须未被观察。
    assert.ok(/运行时观察=\$\{obs\[f\]\}[\s\S]*?与矩阵 verdict/.test(modeSection), '应逐字段比对 observed 与 verdict（review-v4 F5）');
    assert.ok(/矩阵标 unverified 但 E2E 观察到了/.test(modeSection), 'unverified 字段若被 E2E 观察须失败（review-v5 F4）');
    assert.ok(/矩阵声称 \$\{v\}（实测）但 E2E 未观察/.test(modeSection), '布尔字段若 E2E 未观察须失败（不得把未观察写成实测）');
    assert.ok(/substitute 候选须至少一个被 E2E 实测的 false 字段/.test(modeSection), 'substitute 须有实测 false 字段（unverified 不能当不合格证据）');
  });
  check('T6-16 review-v5 F1：--command 逐命令执行（/usage /context /clear /config 有真实成功断言，入口拒绝不支持命令）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const cmdStart = src.indexOf('async function runCommandMode');
    const cmdEnd = src.indexOf('async function runSettingsMode');
    assert.ok(cmdStart >= 0 && cmdEnd > cmdStart, '应能定位 runCommandMode 源码段');
    const cmdSection = src.slice(cmdStart, cmdEnd);
    for (const cmd of ['/usage', '/context', '/clear', '/config']) {
      assert.ok(cmdSection.includes(`prompts.includes('${cmd}')`), `--command 应支持 ${cmd} 并逐命令执行`);
    }
    assert.ok(/verifyUsageCommand|verifyContextCommand|verifyClearCommand|verifyConfigCommand/.test(src), '应有本地命令验证 helper（review-v5 F1 成功证据）');
    // 入口拒绝不支持的命令参数（不得静默跳过）。
    const entrySection = src.slice(src.indexOf('// ── 入口 ──'));
    assert.ok(/不支持的命令参数/.test(entrySection), '入口应对不支持的 --command 参数明确报错');
  });
  check('T6-17 review-v5 F2：凭据按真实 query cwd 解析（runCommandMode 按场景、replacements 用 projectCwd、init-matrix 用 fixture cwd）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const cmdSection = src.slice(src.indexOf('async function runCommandMode'), src.indexOf('async function runSettingsMode'));
    assert.ok(/const initCreds = await resolveInitCredentials\(initCwd\)/.test(cmdSection), '/init 凭据应按 initCwd 解析');
    assert.ok(/const compactCreds = await resolveInitCredentials\(compactCwd\)/.test(cmdSection), '/compact 凭据应按 compactCwd 解析');
    assert.ok(/const protocolCreds = await resolveInitCredentials\(root\)/.test(cmdSection), '协议场景凭据用 root（其 cwd 均为空目录）');
    const replSection = src.slice(src.indexOf('async function runReplacementsMode'), src.indexOf('// ── 入口 ──'));
    assert.ok(/resolveInitCredentials\(projectCwd\)/.test(replSection), 'replacements 凭据应按 projectCwd 解析');
    const initMatrixSection = src.slice(src.indexOf('async function runInitMatrixMode'), src.indexOf('async function runReplacementsMode'));
    assert.ok(/resolveInitCredentials\(credsCwd\)/.test(initMatrixSection), 'init-matrix 凭据应按代表 query cwd 的 fixture 解析');
  });
  check('T6-18 review-v5 F3：compact warmup resume 后 session_id 必须保持（同一 CLI 会话）', () => {
    const src = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const helper = src.slice(src.indexOf('async function verifyCompactEvidence'), src.indexOf('async function runCommandMode'));
    assert.ok(/resume 后 session_id 应保持 \$\{cliSid\}/.test(helper), '每轮 warmup resume 后须断言 session_id 保持等于上一轮 sid（review-v5 F3）');
    assert.ok(/resume 未保持会话/.test(helper), 'resume 失效/自动新建会话须明确失败');
  });

  console.log('=== 24) Task 7：全量命令行为矩阵 + 无未验证命令门禁（源码契约）===');
  {
    const e2eSrc = readFileSync(path.join('scripts', 'claude-code-command-e2e-verify.ts'), 'utf8');
    const matrixSrc = readFileSync(path.join('scripts', 'claude-code-command-matrix.ts'), 'utf8');
    const chainSrc = readFileSync(path.join('scripts', 'run-native-chain.mjs'), 'utf8');

    check('T7-1：runAllMode 已实现 + 入口分派 --all', () => {
      assert.ok(/async function runAllMode\(exe: string\)/.test(e2eSrc), '须定义 async function runAllMode(exe)');
      assert.ok(/mode === '--all'/.test(e2eSrc), '入口须分派 --all 模式');
    });
    check('T7-2：runAllMode 写 command-verification.json manifest', () => {
      assert.ok(/VERIFICATION_OUT_FILE/.test(e2eSrc), '须定义 VERIFICATION_OUT_FILE');
      assert.ok(/writeFileSync\(VERIFICATION_OUT_FILE/.test(e2eSrc), '须写 manifest 到 VERIFICATION_OUT_FILE');
      assert.ok(/VerificationManifest/.test(e2eSrc), '须有 VerificationManifest 类型');
    });
    check('T7-3：6 个核心命令交叉引用（避免重复真实执行）', () => {
      const section = e2eSrc.slice(e2eSrc.indexOf('crossRefCore'), e2eSrc.indexOf('safeArgs'));
      assert.ok(/init.*compact.*clear.*config.*usage.*context/s.test(section), '须交叉引用 init/compact/clear/config/usage/context');
      assert.ok(/verified-cross-ref/.test(section), '核心命令标记 verified-cross-ref');
    });
    check('T7-4：SkipError 用于 runAllMode 的前置条件缺失分流', () => {
      assert.ok(/class SkipError extends Error/.test(e2eSrc), '须定义 SkipError 类');
      const allSection = e2eSrc.slice(e2eSrc.indexOf('async function runAllMode'), e2eSrc.indexOf('// ── 入口'));
      assert.ok(/instanceof SkipError/.test(allSection), 'runAllMode 须用 SkipError 分流 skip');
    });
    check('T7-5：user-skill 发现标记全部（不因描述空 fail）', () => {
      const allSection = e2eSrc.slice(e2eSrc.indexOf('Step 3a'), e2eSrc.indexOf('Step 3b'));
      assert.ok(/verified-discovery/.test(allSection), 'skill 须标 verified-discovery');
      assert.ok(/上游枚举行为/.test(allSection), '描述空须记为上游枚举行为（非 fail）');
    });
    check('T7-6：generic builtin 无终态时标 explicit-skip（不 fail）', () => {
      const allSection = e2eSrc.slice(e2eSrc.indexOf('Step 1+2'), e2eSrc.indexOf('Step 3a'));
      assert.ok(/explicit-skip/.test(allSection), 'builtin 无终态须标 explicit-skip');
      assert.ok(/可能需丰富会话上下文/.test(allSection), '须写明 explicit-skip 原因');
    });
    check('T7-7：matrix --require-no-unverified-command 门禁已实现 + 分派', () => {
      assert.ok(/function requireNoUnverifiedCommand\(\)/.test(matrixSrc), '须定义 requireNoUnverifiedCommand');
      assert.ok(/requireNoUnverifiedCommand\(\)/.test(matrixSrc), 'main 须分派 --require-no-unverified-command');
      assert.ok(/VERIFICATION_OUT_FILE/.test(matrixSrc), '门禁须读 VERIFICATION_OUT_FILE');
      assert.ok(/unverified/.test(matrixSrc), '门禁须拒绝 unverified 状态');
    });
    check('T7-8：native 门禁链接入 --all + --require-no-unverified-command', () => {
      assert.ok(/--native --all/.test(chainSrc), 'chain 须含 --native --all');
      assert.ok(/--require-no-unverified-command/.test(chainSrc), 'chain 须含 --require-no-unverified-command');
      // 顺序：--all 必须在 --replacements 之后（交叉引用前置模式），门禁必须在 --all 之后（消费 manifest）。
      const allIdx = chainSrc.indexOf('--native --all');
      const replIdx = chainSrc.indexOf('--native --replacements');
      const gateIdx = chainSrc.indexOf('--require-no-unverified-command');
      assert.ok(replIdx > 0 && allIdx > replIdx, '--all 须在 --replacements 之后（交叉引用前置模式验证结果）');
      assert.ok(gateIdx > allIdx, '--require-no-unverified-command 须在 --all 之后（消费 manifest）');
    });
    // review-v3 §6.2：行为覆盖两级门禁 + 接入发布链
    check('review-v3 §6.2: 行为覆盖实践级门禁接入 chain + 严格级门禁独立', () => {
      assert.ok(/function requireBehavioralCoverage\(\)/.test(matrixSrc), '须定义 requireBehavioralCoverage（实践级）');
      assert.ok(/function requireBehavioralCoverageFull\(\)/.test(matrixSrc), '须定义 requireBehavioralCoverageFull（严格级）');
      assert.ok(matrixSrc.includes('--require-behavioral-coverage-full'), 'main 须分派 --require-behavioral-coverage-full');
      assert.ok(/0\.95/.test(matrixSrc), '实践级须有 ≥95% 容忍阈值');
      // chain 须含实践级门禁
      assert.ok(/--require-behavioral-coverage['"]/.test(chainSrc), 'chain 须含 --require-behavioral-coverage');
      // chain 不含严格级（gap 未闭合前不阻塞发布链）
      assert.ok(!/--require-behavioral-coverage-full/.test(chainSrc), 'chain 不应含严格级（sideEffects gap 未闭合）');
    });
    // ── review-v1 §4.1/§4.2：行为维度拆分（发现 ≠ 行为验收）──
    check('review-v1 §4.1: manifest 携带 BehavioralDimensions 逐维度字段', () => {
      assert.ok(/type BehavioralDimensions/.test(e2eSrc), '须定义 BehavioralDimensions 类型');
      assert.ok(/dimensions\?:\s*BehavioralDimensions/.test(e2eSrc), 'VerificationEntry 须有 dimensions 可选字段');
      // verified-discovery mark 只带 discovery 维度（不伪装行为覆盖）。
      const step3a = e2eSrc.slice(e2eSrc.indexOf('Step 3a'), e2eSrc.indexOf('Step 3b'));
      assert.ok(/discovery:\s*true/.test(step3a), 'verified-discovery 须带 dimensions.discovery = true');
      assert.ok(!/success:\s*true/.test(step3a), 'verified-discovery 不得伪装 success 维度');
    });
    check('review-v1 §4.2: builtin is_error 标 failure 维度（不标 success）', () => {
      // is_error 分支须设 failure: true 且不设 success: true；非 is_error 分支设 success: true。
      const builtinSection = e2eSrc.slice(e2eSrc.indexOf('Step 1+2'), e2eSrc.indexOf('Step 3a'));
      assert.ok(/failure:\s*true/.test(builtinSection), 'is_error builtin 须标 dimensions.failure = true');
      assert.ok(/success:\s*true/.test(builtinSection), '非 is_error builtin 须标 dimensions.success = true');
      // 显式条件分支（isError ? failure : success），不是无条件标全维度。
      assert.ok(/isError\s*\?/.test(builtinSection), 'dimensions 须按 is_error 条件区分');
    });
    check('review-v1 §4.1: explicit-skip 只带 discovery 维度（不伪装行为覆盖）', () => {
      const builtinSection = e2eSrc.slice(e2eSrc.indexOf('Step 1+2'), e2eSrc.indexOf('Step 3a'));
      // explicit-skip 的 dimensions 须为 { discovery: true }（只发现，无终态）。
      assert.ok(/discovery:\s*true/.test(builtinSection), 'explicit-skip 须带 dimensions.discovery = true');
    });
    check('review-v1 §4.1/§4.2: --require-behavioral-coverage 行为覆盖门禁已实现 + 分派', () => {
      assert.ok(/function requireBehavioralCoverage\(\)/.test(matrixSrc), '须定义 requireBehavioralCoverage');
      assert.ok(/requireBehavioralCoverage\(\)/.test(matrixSrc), 'main 须分派 --require-behavioral-coverage');
      assert.ok(/behavioralLevel/.test(matrixSrc), '须有 behavioralLevel 逐命令等级判定');
      assert.ok(/REQUIRED_DIMENSIONS/.test(matrixSrc), '须定义按 category 的要求维度表');
    });
    check('review-v1 §4.1: --require-no-unverified-command 打印行为覆盖汇总（区分分类覆盖与行为覆盖）', () => {
      assert.ok(/行为覆盖等级/.test(matrixSrc), '门禁须打印行为覆盖等级汇总');
      assert.ok(/behavioralLevel/.test(matrixSrc), '汇总须用 behavioralLevel 判定');
    });
  }

  console.log('=== 25) 暂态命令可用 + 全局快照热刷新（计划 D1-D6 契约）===');
  // 本节契约背景：暂态会话（无 DB 行）经 COMMANDS_GET 只读分流拿全局兜底（D1/D2）；watcher 监视
  // 命令来源目录热刷新 globalFallback（D3）；COMMANDS_GLOBAL_CHANGED 广播链（D4）；旧会话用户级
  // 指纹惰性刷新（D5）；兜底为空时节流重试（D6）。守卫（N3/N5/isEntryActive/收口）一律不动。
  const dcmd = (name: string): SdkCommand => ({ name, description: '', argumentHint: '', aliases: [], source: 'sdk', origin: 'unknown', availability: 'unknown' });
  const dsnap = (sessionId: string, names: string[], status: SessionCommandSnapshot['status'], source: SessionCommandSnapshot['source'], originFingerprint?: string): SessionCommandSnapshot => ({
    sessionId,
    commands: names.map(dcmd),
    status,
    source,
    updatedAt: null,
    ...(originFingerprint !== undefined ? { originFingerprint } : {}),
  });

  check('D1 resolveCommandsGetResult：无 DB 行只读分流（兜底副本覆写 sessionId+cache；兜底 null → loading 默认）', () => {
    const loading = createDefaultCommandSnapshot('t1');
    const fb = dsnap(GLOBAL_FALLBACK_SESSION_ID, ['g'], 'ready', 'probe');
    const d = resolveCommandsGetResult({ sessionExists: false, hasSnapshot: false, snapshot: loading, fallback: fb });
    assert.equal(d.readOnly, true, '无 DB 行必须标只读（禁一切生命周期副作用）');
    assert.equal(d.needsFullProbeSideEffects, false);
    assert.equal(d.needsRefreshProbeOnly, false);
    assert.equal(d.snapshot.sessionId, 't1', '兜底副本应覆写为请求 sessionId');
    assert.equal(d.snapshot.source, 'cache', '兜底副本 source 应为 cache');
    assert.deepEqual(d.snapshot.commands.map((c) => c.name), ['g']);
    const dNull = resolveCommandsGetResult({ sessionExists: false, hasSnapshot: false, snapshot: loading, fallback: null });
    assert.equal(dNull.readOnly, true);
    assert.equal(dNull.snapshot.status, 'loading', '无兜底时返回 loading 默认（不崩、优雅空态）');
    assert.deepEqual(dNull.snapshot.commands, []);
  });

  check('D1 resolveCommandsGetResult：有 DB 行三态与改动前同语义（has 原样 / 无快照全链 / 无兜底 loading）', () => {
    const snap = dsnap('s1', ['a'], 'ready', 'probe');
    const dHas = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: true, snapshot: snap, fallback: null });
    assert.equal(dHas.readOnly, false);
    assert.equal(dHas.needsFullProbeSideEffects, false, 'has 路径不触发 markSessionActive/probe 链（与改动前一致）');
    assert.equal(dHas.snapshot, snap, 'has 路径应原样返回同一引用');
    const fb = dsnap(GLOBAL_FALLBACK_SESSION_ID, ['g'], 'ready', 'probe');
    const dNoSnap = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: false, snapshot: createDefaultCommandSnapshot('s2'), fallback: fb });
    assert.equal(dNoSnap.needsFullProbeSideEffects, true, '无快照需 N6 全副作用链');
    assert.equal(dNoSnap.snapshot.sessionId, 's2');
    assert.equal(dNoSnap.snapshot.source, 'cache');
    const loading = createDefaultCommandSnapshot('s3');
    const dNoFb = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: false, snapshot: loading, fallback: null });
    assert.equal(dNoFb.needsFullProbeSideEffects, true);
    assert.equal(dNoFb.snapshot, loading, '无兜底回落 registry.get 的 loading 默认（旧行为）');
  });

  check('D5 指纹比对：不一致 → stale 克隆 + 仅重探；一致 → 原样；双端缺省 → 原样不误标', () => {
    const staleSnap = dsnap('old', ['a'], 'ready', 'probe', 'fp-old');
    const d = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: true, snapshot: staleSnap, fallback: null, currentUserFingerprint: 'fp-new' });
    assert.equal(d.needsRefreshProbeOnly, true, '指纹不一致应触发免费重探');
    assert.equal(d.needsFullProbeSideEffects, false, '重探路径不 markSessionActive（N5 DB 判据放行）');
    assert.equal(d.snapshot.status, 'stale', '返回克隆标 stale（UI「可能不是最新」）');
    assert.notEqual(d.snapshot, staleSnap, '必须是克隆，不回写 registry');
    assert.equal(staleSnap.status, 'ready', '原快照不被污染');
    const dSame = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: true, snapshot: dsnap('old', ['a'], 'ready', 'probe', 'fp-same'), fallback: null, currentUserFingerprint: 'fp-same' });
    assert.equal(dSame.needsRefreshProbeOnly, false);
    assert.equal(dSame.snapshot.status, 'ready', '指纹一致原样返回');
    const dNoSnapFp = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: true, snapshot: dsnap('old', ['a'], 'ready', 'probe'), fallback: null, currentUserFingerprint: 'fp-new' });
    assert.equal(dNoSnapFp.needsRefreshProbeOnly, false, '快照无指纹（旧快照）不比对');
    const dNoCur = resolveCommandsGetResult({ sessionExists: true, hasSnapshot: true, snapshot: dsnap('old', ['a'], 'ready', 'probe', 'fp-old'), fallback: null, currentUserFingerprint: undefined });
    assert.equal(dNoCur.needsRefreshProbeOnly, false, 'watcher 未启动（当前指纹缺省）不比对');
    assert.equal(isSnapshotOriginStale(dsnap('x', ['a'], 'ready', 'probe'), undefined), false, 'isSnapshotOriginStale 缺省恒 false');
  });

  check('D5 registry.replace 写入 originFingerprint；缺省不带字段；状态切换经 spread 保留指纹', () => {
    const reg = new SdkCommandRegistry();
    const withFp = reg.replace('fp1', [dcmd('a')], 'probe', EMPTY_COMMAND_ORIGIN_CONTEXT, 'fp-A');
    assert.equal(withFp.originFingerprint, 'fp-A');
    const noFp = reg.replace('fp2', [dcmd('b')], 'probe', EMPTY_COMMAND_ORIGIN_CONTEXT);
    assert.equal(noFp.originFingerprint, undefined, '缺省时字段缺省');
    const kept = reg.setStatusPreservingCommands('fp1', 'stale');
    assert.equal(kept.originFingerprint, 'fp-A', '非 ready 状态切换保留出生指纹');
  });

  check('D3 commandSourceRoots：用户级两根 + 项目级两根；home/cwd 缺省各自为空；userRoots 只含用户级', () => {
    const mkDeps = (home?: string, cwd?: string | null): CommandSourceWatcherDeps => ({
      getUserHome: () => home,
      getWorkingDirectory: () => cwd ?? null,
      triggerGlobalProbe: () => {},
      onConfigSaved: () => () => {},
      logger: { info: () => {}, warn: () => {} },
    });    const r = commandSourceRoots(mkDeps('C:/u', 'C:/p'));
    assert.equal(r.allRoots.length, 4, '四个 watch 根');
    assert.deepEqual(r.userRoots, [path.join('C:/u', '.claude', 'commands'), path.join('C:/u', '.claude', 'skills')], 'userRoots 只含用户级两根（D5 指纹口径）');
    assert.ok(r.allRoots.includes(path.join('C:/p', '.claude', 'commands')), '项目级 commands 根在场');
    assert.ok(r.allRoots.includes(path.join('C:/p', '.claude', 'skills')), '项目级 skills 根在场');
    assert.deepEqual(commandSourceRoots(mkDeps(undefined, 'C:/p')).userRoots, [], 'home 缺省 → 用户级为空（不裸 homedir）');
    assert.equal(commandSourceRoots(mkDeps('C:/u', null)).allRoots.length, 2, 'cwd null → 只剩用户级两根');
    assert.deepEqual(commandSourceRoots(mkDeps(undefined, null)).allRoots, [], '全缺省 → 空根（指纹为常量）');
  });

  await asyncCheck('D3 指纹纯函数：建/改/删文件变化；仅 touch 目录不变；深度 ≤6 计入、>6 不计', async () => {
    mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
    const root = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-fp-'));
    try {
      const cmds = path.join(root, 'commands');
      mkdirSync(cmds, { recursive: true });
      const fpEmpty = await computeCommandRootsFingerprint([cmds]);
      writeFileSync(path.join(cmds, 'a.md'), 'hello');
      const fpA = await computeCommandRootsFingerprint([cmds]);
      assert.notEqual(fpA, fpEmpty, '新建文件指纹应变化');
      writeFileSync(path.join(cmds, 'a.md'), 'hello-world-longer');
      const fpB = await computeCommandRootsFingerprint([cmds]);
      assert.notEqual(fpB, fpA, '修改文件（内容+大小）指纹应变化');
      const future = new Date(Date.now() + 60_000);
      utimesSync(cmds, future, future);
      assert.equal(await computeCommandRootsFingerprint([cmds]), fpB, '仅 touch 目录 mtime 不应改变指纹（指纹只含文件条目）');
      rmSync(path.join(cmds, 'a.md'));
      const fpDel = await computeCommandRootsFingerprint([cmds]);
      assert.equal(fpDel, fpEmpty, '删回空目录回到空集指纹');
      let deep6 = cmds;
      for (let i = 0; i < FINGERPRINT_MAX_DEPTH; i++) deep6 = path.join(deep6, `d${i}`);
      mkdirSync(deep6, { recursive: true });
      writeFileSync(path.join(deep6, 'skill.md'), 'x');
      const fpDeep6 = await computeCommandRootsFingerprint([cmds]);
      assert.notEqual(fpDeep6, fpDel, '深度 ≤6 的嵌套文件应计入');
      let deep7 = cmds;
      for (let i = 0; i <= FINGERPRINT_MAX_DEPTH; i++) deep7 = path.join(deep7, `x${i}`);
      mkdirSync(deep7, { recursive: true });
      writeFileSync(path.join(deep7, 'beyond.md'), 'z');
      assert.equal(await computeCommandRootsFingerprint([cmds]), fpDeep6, '深度 >6 的文件不应计入（与证据扫描同口径）');
      const emptyFp = await computeCommandRootsFingerprint([]);
      assert.equal(emptyFp, await computeCommandRootsFingerprint([]), '空根指纹为确定常量');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await asyncCheck('D3 watcher 端到端（真实 fs.watch）：基准不探测 → 新文件触发 → 终态不变不触发 → stop 幂等', async () => {
    mkdirSync(ORIGIN_TMP_ROOT, { recursive: true });
    const home = mkdtempSync(path.join(ORIGIN_TMP_ROOT, 'cl-w-home-'));
    try {
      const cmdsDir = path.join(home, '.claude', 'commands');
      mkdirSync(cmdsDir, { recursive: true });
      let probes = 0;
      startCommandSourceWatcher({
        getUserHome: () => home,
        getWorkingDirectory: () => null,
        triggerGlobalProbe: () => {
          probes += 1;
        },
        onConfigSaved: () => () => {},
        logger: { info: () => {}, warn: () => {} },
      });
      const sleep = (ms: number): Promise<void> => new Promise<void>((r) => setTimeout(r, ms));
      await sleep(600); // 基准指纹建立（异步）
      assert.equal(probes, 0, '启动基准指纹不得触发探测（启动探测由 index.ts 负责）');
      assert.ok(typeof getUserOriginFingerprint() === 'string', '基准刷新后应导出用户级指纹（D5 附带）');
      writeFileSync(path.join(cmdsDir, 'hot.md'), 'v1');
      await sleep(2600); // 去抖 1500ms + 指纹扫描
      assert.ok(probes >= 1, '文件新增应在去抖后触发一次全局探测');
      const afterFirst = probes;
      const scratch = path.join(cmdsDir, 'tmp-scratch.md');
      writeFileSync(scratch, 'temp');
      rmSync(scratch, { force: true });
      await sleep(2600);
      assert.equal(probes, afterFirst, '建/删同文件（终态不变，指纹相同）不应再 spawn 探测');
      assert.ok(isCommandSourceWatcherRunning(), 'stop 前应处于运行态');
      stopCommandSourceWatcher();
      assert.equal(isCommandSourceWatcherRunning(), false, 'stop 后应清理单例');
      assert.equal(getUserOriginFingerprint(), undefined, 'stop 后指纹导出回 undefined（D5 缺省不比对）');
    } finally {
      stopCommandSourceWatcher(); // 幂等兜底清理
      rmSync(home, { recursive: true, force: true });
    }
  });

  check('D1/D5 结构：COMMANDS_GET 只读分流接线（不 throw + D6 重试 + N6 链保留 + 指纹入参）', () => {
    const src = readFileSync(path.join('src', 'main', 'ipc-handlers.ts'), 'utf8');
    const m = src.match(/IPC_CHANNELS\.COMMANDS_GET[\s\S]*?(?=ipcMain\.handle)/);
    if (!m) throw new Error('COMMANDS_GET handler 未找到');
    assert.ok(m[0].includes('resolveCommandsGetResult'), '分流决策应走 shared 纯函数');
    assert.ok(!m[0].includes('not found'), '暂态/未知会话不得再 throw（D1 根因）');
    assert.ok(m[0].includes('ensureGlobalCommandProbeFresh'), '只读分流应触发 D6 节流重试');
    assert.ok(m[0].includes('sessionRepo.getSession(sessionId)'), 'N6：DB 会话存在性校验保留');
    assert.ok(m[0].includes('markSessionActive(sessionId)'), 'N6：有 DB 行无快照的 active 登记保留');
    assert.ok(m[0].includes('startCommandProbe'), 'N4/N6/D5：probe 触发保留');
    assert.ok(m[0].includes('schedulePostTurnProbe'), 'post-turn 探针调度保留');
    assert.ok(m[0].includes('getUserOriginFingerprint()'), 'D5：指纹入参在场');
    assert.ok(m[0].includes("'cache'"), '兜底 cache 语义保留');
  });

  check('D2 结构：startTransientSession 末尾 commandStore.load（B10 反转）', () => {
    const src = readFileSync(path.join('src', 'renderer', 'stores', 'session-store.ts'), 'utf8');
    assert.ok(
      /startTransientSession\(\) \{[\s\S]*?useCommandStore\(\)\.load\(/.test(src),
      '暂态创建应立即加载命令兜底快照（与 switchSession N4 同构）',
    );
    assert.ok(
      /B10 反转/.test(src),
      '旧「暂态不 load」注释应已反转',
    );
  });

  check('D4 结构：COMMANDS_GLOBAL_CHANGED 三处同步 + 广播不经 isSessionActive', () => {
    const ipcTypes = readFileSync(path.join('src', 'shared', 'types', 'ipc.ts'), 'utf8');
    assert.ok(ipcTypes.includes("COMMANDS_GLOBAL_CHANGED: 'commands:globalChanged'"), 'ipc.ts 应定义通道常量');
    assert.ok(ipcTypes.includes('CommandGlobalChangedPayload'), 'ipc.ts 应 re-export payload 类型');
    const preload = readFileSync(path.join('src', 'preload', 'api.ts'), 'utf8');
    assert.ok(preload.includes('onGlobalCommandsChanged'), 'preload 应暴露 onGlobalCommandsChanged');
    assert.ok(preload.includes('IPC_CHANNELS.COMMANDS_GLOBAL_CHANGED'), 'preload 应订阅该通道');
    const appVue = readFileSync(path.join('src', 'renderer', 'App.vue'), 'utf8');
    assert.ok(appVue.includes('onGlobalCommandsChanged'), 'App.vue 应注册全局广播消费');
    assert.ok(appVue.includes('applyGlobalFallback'), 'App.vue 应调 commandStore.applyGlobalFallback');
    const store = readFileSync(path.join('src', 'renderer', 'stores', 'command-store.ts'), 'utf8');
    assert.ok(store.includes('applyGlobalFallback'), 'command-store 应有 applyGlobalFallback action');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    const emit = backend.match(/function emitGlobalCommandsChanged[\s\S]*?\n\}/);
    if (!emit) throw new Error('emitGlobalCommandsChanged 未找到');
    assert.ok(!emit[0].includes('isSessionActive'), '全局广播不得经 isSessionActive 守卫（暂态不在 activeSessions）');
    const apply = backend.match(/async function applyGlobalProbeCommands[\s\S]*?clearTimeout\(timeoutTimer\)/);
    if (!apply) throw new Error('applyGlobalProbeCommands 未找到');
    assert.ok(apply[0].includes('emitGlobalCommandsChanged'), 'applyGlobalProbeCommands 成功写入兜底后应广播');
  });

  check('D4 行为：applyGlobalFallback 暂态覆盖 / 空命令回填保留 status / 非空不动 / null 不写', () => {
    setActivePinia(createPinia());
    const store = useCommandStore();
    const fb = (names: string[]): SessionCommandSnapshot => dsnap(GLOBAL_FALLBACK_SESSION_ID, names, 'ready', 'probe');
    const asSession = (id: string, transient: boolean): Session => ({ id, transient } as unknown as Session);
    store.applyGlobalFallback(fb(['g1']), asSession('t1', true));
    assert.equal(store.snapshotsBySession['t1'].sessionId, 't1', '暂态应覆写 sessionId');
    assert.equal(store.snapshotsBySession['t1'].source, 'cache');
    assert.equal(store.activeSnapshot('t1').commands[0].name, 'g1');
    store.setSnapshot({ sessionId: 'full', commands: [dcmd('mine')], status: 'ready', source: 'probe', updatedAt: null });
    store.applyGlobalFallback(fb(['g2']), asSession('full', false));
    assert.equal(store.activeSnapshot('full').commands[0].name, 'mine', '非空已物化会话不动（per-session 优先）');
    store.setSnapshot({ sessionId: 'deg', commands: [], status: 'degraded', source: 'probe', updatedAt: null, error: 'x' });
    store.applyGlobalFallback(fb(['g3']), asSession('deg', false));
    const deg = store.snapshotsBySession['deg'];
    assert.equal(deg.commands[0].name, 'g3', '空命令已物化会话应回填');
    assert.equal(deg.status, 'degraded', '回填保留原 status（N7 语义）');
    assert.equal(deg.source, 'cache');
    store.applyGlobalFallback(fb(['g4']), asSession('fresh', false));
    assert.equal(store.activeSnapshot('fresh').commands[0].name, 'g4', '无条目的活跃已物化会话整体回填');
    const before = Object.keys(store.snapshotsBySession).length;
    store.applyGlobalFallback(fb(['g5']), null);
    assert.equal(Object.keys(store.snapshotsBySession).length, before, 'active 为 null 不写任何键');
  });

  check('D3/D6/D5 结构：watcher 纯净性 + index.ts 挂接清理 + 节流重试导出 + replace 附带指纹', () => {
    const w = readFileSync(path.join('src', 'main', 'modules', 'command-source-watcher.ts'), 'utf8');
    assert.ok(w.includes('WATCHER_DEBOUNCE_MS'), '应定义去抖常量');
    assert.ok(w.includes('WATCHER_PROBE_MIN_INTERVAL_MS'), '应定义 10s 探测节流常量');
    assert.ok(w.includes('WATCHER_REMOUNT_MAX_CONSECUTIVE'), '应定义重挂限次常量');
    assert.ok(w.includes('onConfigSaved'), '应订阅 onConfigSaved');
    assert.ok(w.includes('recursive: true'), '应优先递归 watch');
    assert.ok(!/from 'electron'/.test(w), 'watcher 不得 import electron（保持 tsx 可测，依赖注入）');
    const idx = readFileSync(path.join('src', 'main', 'index.ts'), 'utf8');
    assert.ok(idx.includes('startCommandSourceWatcher'), 'whenReady 应挂接 watcher');
    const stops = (idx.match(/stopCommandSourceWatcher\(\);/g) || []).length;
    assert.ok(stops >= 2, `window-all-closed 与 before-quit 都应停止 watcher（实际 ${stops}）`);
    assert.ok(/getUserHome:\s*effectiveUserHome/.test(idx), '用户级根锚点应注入 effectiveUserHome（禁裸 homedir 口径）');
    const backend = readFileSync(path.join('src', 'main', 'modules', 'sdk-backend.ts'), 'utf8');
    assert.ok(/export function ensureGlobalCommandProbeFresh/.test(backend), 'D6 应导出节流重试');
    assert.ok(/lastGlobalProbeAttemptAt = Date\.now\(\)/.test(backend), 'runGlobalCommandProbe 应推进尝试时刻（成败都计节流窗口）');
    const ensure = backend.match(/export function ensureGlobalCommandProbeFresh[\s\S]*?\n\}/);
    if (!ensure) throw new Error('ensureGlobalCommandProbeFresh 未找到');
    assert.ok(ensure[0].includes('getGlobalFallback()'), '兜底非 null 直接返回');
    assert.ok(ensure[0].includes('lastGlobalProbeAttemptAt'), '应按上次尝试时刻节流');
    const fpCalls = (backend.match(/getUserOriginFingerprint\(\)/g) || []).length;
    assert.ok(fpCalls >= 4, `replace 各来源调用点应附带用户级指纹（实际 ${fpCalls}，需 ≥4）`);
    const registry = readFileSync(path.join('src', 'main', 'modules', 'sdk-command-registry.ts'), 'utf8');
    assert.ok(/originFingerprint\?: string/.test(registry), 'replace 应接受可选 originFingerprint 参数');
  });

  // ── 汇总 ──
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
})().catch((e) => {
  console.error('Task 7 fatal:', e);
  process.exit(1);
});
