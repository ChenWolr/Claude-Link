// tdd-skill-overrides-verify.ts
// Skill 管理功能 TDD 验证（docs/plans/2026-09-15-skill-management-plan.md §4.1）。
// 共 24 条断言：§4.1 原 16 条（①-⑯）+ 前轮 P2 补充 2 条（⑰⑱）+ 2026-09-15 S2 独立 review
// P2 修复补充 3 条（⑲⑳㉑，docs/review/2026-09-15-skill-management-independent-review.md）
// + 冷启动自愈正式化补充 3 条（㉒㉓㉔，docs/review/2026-09-15-skill-management-coldstart-fix.md）。
// 组1 纯函数行为（①-④）：sdk-skill-overrides.ts / command-filter.ts 两个新模块；
// 组2 DB 行为（⑤-⑦）：免升版自愈列 skill_overrides + session-repo 往返；
// 组3 源形契约（⑧-⑮、⑰-㉔）：钉住接线（其中 ⑩⑪ 为「零改动钉住」，未实施前就应 PASS）；
// 组4 契约同步（⑯）：spawn regression-tests.ts 运行验证（实测 ~2s，不豁免）。
//
// RED 阶段预期（对未实施主干）：①-⑨、⑫-⑮ FAIL；⑩⑪⑯ PASS；⑰⑱ 对未修复前轮 P2 树 FAIL；
// ⑲⑳㉑ 对未修复 S2-P2 的工作树 FAIL（修复轮 RED 留证：skill-verify/p2fix-red.log）；
// ㉒㉓㉔ 对未修复冷启动缺陷的工作树 FAIL（修复轮 RED 留证：skill-verify/coldstart-red.log）。
// GREEN 阶段目标：24/24 全 PASS。
//
// 运行：npx tsx scripts/tdd-skill-overrides-verify.ts（不启动 Electron；better-sqlite3 为
// Electron ABI、当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重spawn 本脚本——n2 先例）。
// ⑦ session-repo 往返用 electron-stub（house pattern：Module._load 把 'electron' 解析到
// scripts/electron-stub.cjs，app.getPath 由 CLAUDE_LINK_TEST_USERDATA 指向 Cache 临时目录），
// 真实 connection/session-repo 在临时库上跑，绝不触碰真实用户库。
// 版本检查用 schema_version 表（项目真实版本机制；migrations.ts 不使用 PRAGMA user_version，
// n2 的 versionOf 手法即读该表）。

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

// —— electron-stub 安装（tdd-bugfix-p1-01/n4 先例）：必须在 require 任何主进程模块之前 ——
const stubUserDataDir = path.join('D:\\software\\Cache', 'claude-link', 'skill-verify', `tmp-userdata-${process.pid}-${Date.now()}`);
fs.mkdirSync(stubUserDataDir, { recursive: true });
process.env.CLAUDE_LINK_TEST_USERDATA = stubUserDataDir;
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origLoad = (Module as any)._load;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(Module as any)._load = function (req: string, parent: unknown, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

function readRel(p: string): string {
  const abs = path.resolve(repoRoot, p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}

// —— better-sqlite3 ABI 预检 + ELECTRON_RUN_AS_NODE respawn（照抄 tdd-bugfix-n2 手法）——
function openMemoryDb(): { prepare: (sql: string) => { all: () => unknown[]; get: () => unknown }; exec: (sql: string) => void; close: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  return new Database(':memory:');
}

/** ABI 不匹配（node vs electron NODE_MODULE_VERSION）时以 electron-as-node 重跑自身并透传退出码。 */
function respawnUnderElectronIfNeeded(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (!/NODE_MODULE_VERSION/.test(msg)) throw err;
  const r = spawnSync(
    path.join('node_modules', '.bin', 'electron.cmd'),
    [path.join('node_modules', 'tsx', 'dist', 'cli.mjs'), ...process.argv.slice(1)],
    { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', shell: true },
  );
  process.stdout.write(r.stdout ?? '');
  process.stderr.write(r.stderr ?? '');
  process.exit(r.status ?? 1);
}

{
  let probe: ReturnType<typeof openMemoryDb> | null = null;
  try {
    probe = openMemoryDb();
  } catch (err) {
    respawnUnderElectronIfNeeded(err);
  }
  probe?.close();
}

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

function deepEq(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// 组1：两个新模块（RED 阶段不存在 → require 失败降级为断言 FAIL，脚本不 crash）。
let skillMod: any = null;
let skillModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  skillMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'sdk-skill-overrides.ts'));
} catch (e) {
  skillModErr = errMsg(e);
}
let filterMod: any = null;
let filterModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  filterMod = require(path.resolve(repoRoot, 'src', 'shared', 'command-filter.ts'));
} catch (e) {
  filterModErr = errMsg(e);
}

// ── 组1 纯函数行为 ──────────────────────────────────────────────────────────

console.log('\n=== 组1 纯函数行为（sdk-skill-overrides.ts / command-filter.ts） ===');

// ① parseSessionSkillOverrides
{
  const sub: string[] = [];
  const parse: unknown = skillMod?.parseSessionSkillOverrides;
  if (typeof parse !== 'function') {
    sub.push(`导出 parseSessionSkillOverrides 不可用${skillModErr ? `（模块加载失败：${skillModErr.slice(0, 120)}）` : ''}`);
  } else {
    const p = parse as (raw: string | null) => Record<string, 'off'> | null;
    if (p(null) !== null) sub.push('null → 应为 null');
    if (p('') !== null) sub.push("'' → 应为 null");
    if (p('not-json{') !== null) sub.push('非 JSON → 应为 null');
    if (p('[1,2]') !== null) sub.push('数组 → 应为 null');
    if (p('{"a":1}') !== null) sub.push('{"a":1}（值非 off）→ 应为 null');
    if (!deepEq(p('{"a":"off","b":"on"}'), { a: 'off' })) sub.push('{"a":"off","b":"on"} → 仅保留合法键 {a:"off"}');
    if (!deepEq(p('{"a":"off"}'), { a: 'off' })) sub.push('{"a":"off"} → 原样等值');
  }
  check('①', 'parseSessionSkillOverrides：null/空串/非JSON/数组/非法值 → null；仅保留 "off" 条目', sub.length === 0, sub.join('; '));
}

// ② mergeSkillOverridesIntoSettings
{
  const sub: string[] = [];
  const merge: unknown = skillMod?.mergeSkillOverridesIntoSettings;
  if (typeof merge !== 'function') {
    sub.push(`导出 mergeSkillOverridesIntoSettings 不可用${skillModErr ? `（模块加载失败：${skillModErr.slice(0, 120)}）` : ''}`);
  } else {
    const m = merge as (s: Record<string, unknown>, o: Record<string, 'off'> | null) => Record<string, unknown>;
    const s0: Record<string, unknown> = { permissions: { allow: [] } };
    const rNull = m(s0, null);
    const rEmpty = m(s0, {});
    const okShape = (r: Record<string, unknown> | undefined, base: Record<string, unknown>): boolean =>
      !!r && (r === base || (deepEq(r, base) && !('skillOverrides' in r)));
    if (!okShape(rNull, s0)) sub.push('overrides=null → 应原样返回（引用相等或深相等且无 skillOverrides 键）');
    if (!okShape(rEmpty, s0)) sub.push('overrides={} → 应原样返回（引用相等或深相等且无 skillOverrides 键）');
    const r2 = m({ a: 1 }, { pua: 'off' });
    if (!deepEq(r2?.skillOverrides, { pua: 'off' })) sub.push('{"pua":"off"} → 返回对象应含 skillOverrides 键');
  }
  check('②', 'mergeSkillOverridesIntoSettings：null/{} 入参原样返回不加键；非空并入顶层 skillOverrides', sub.length === 0, sub.join('; '));
}

// ③ buildSessionSkillOverridesForPin / sanitizeSkillOverridesConfig
{
  const sub: string[] = [];
  const pin: unknown = skillMod?.buildSessionSkillOverridesForPin;
  const san: unknown = skillMod?.sanitizeSkillOverridesConfig;
  if (typeof pin !== 'function') {
    sub.push(`导出 buildSessionSkillOverridesForPin 不可用${skillModErr ? `（模块加载失败：${skillModErr.slice(0, 120)}）` : ''}`);
  } else {
    const p = pin as (v: unknown) => Record<string, 'off'> | null;
    for (const dirty of [null, 'x', 42, [1], {}]) {
      if (p(dirty) !== null) sub.push(`pin(${JSON.stringify(dirty)}) → 应为 null（脏值/空 → null 形态）`);
    }
    if (!deepEq(p({ a: 'off' }), { a: 'off' })) sub.push('pin({a:"off"}) → 原样等值');
    if (!deepEq(p({ a: 'off', b: 'on' }), { a: 'off' })) sub.push('pin({a:"off",b:"on"}) → 丢弃非 "off" 键');
  }
  if (typeof san !== 'function') {
    sub.push(`导出 sanitizeSkillOverridesConfig 不可用${skillModErr ? `（模块加载失败：${skillModErr.slice(0, 120)}）` : ''}`);
  } else {
    const s = san as (v: unknown) => Record<string, 'off'>;
    for (const dirty of [null, 'x', 42, [1]]) {
      if (!deepEq(s(dirty), {})) sub.push(`sanitize(${JSON.stringify(dirty)}) → 应为 {}（脏值 → 空对象形态）`);
    }
    if (!deepEq(s({}), {})) sub.push('sanitize({}) → 应为 {}（空值形态与 pin 的 null 相区别）');
    if (!deepEq(s({ a: 'off', b: 'on' }), { a: 'off' })) sub.push('sanitize({a:"off",b:"on"}) → 丢弃非 "off" 键');
  }
  check('③', 'buildSessionSkillOverridesForPin / sanitizeSkillOverridesConfig：脏值清洗一致，空值形态 null vs {}', sub.length === 0, sub.join('; '));
}

// ④ filterCommandsBySkillOverrides
{
  const sub: string[] = [];
  const f: unknown = filterMod?.filterCommandsBySkillOverrides;
  if (typeof f !== 'function') {
    sub.push(`导出 filterCommandsBySkillOverrides 不可用${filterModErr ? `（模块加载失败：${filterModErr.slice(0, 120)}）` : ''}`);
  } else {
    const flt = f as <T extends { name: string }>(cmds: T[], o: Record<string, 'off'> | null | undefined) => T[];
    const cmds = [{ name: 'pua' }, { name: 'other' }, { name: 'skill-x' }];
    if (flt(cmds, null) !== cmds) sub.push('overrides=null → 应原数组引用返回');
    if (flt(cmds, undefined) !== cmds) sub.push('overrides=undefined → 应原数组引用返回');
    const out = flt(cmds, { pua: 'off' });
    if (!deepEq(out.map((c) => c.name), ['other', 'skill-x'])) sub.push('命中 overrides[name]==="off" 应剔除 pua');
    if (flt(cmds, { PUA: 'off' }).length !== 3) sub.push('大小写不匹配（PUA vs pua）应不动（canonical 名区分大小写）');
    if (flt([{ name: 'help', alias: '?' }] as never[], { '?': 'off' }).length !== 1) sub.push('别名不匹配（override 键非 canonical name）应不动');
  }
  check('④', 'filterCommandsBySkillOverrides：空 overrides 原引用返回；命中剔除；别名/大小写不匹配不动', sub.length === 0, sub.join('; '));
}

// ── 组2 DB 行为（ELECTRON_RUN_AS_NODE + better-sqlite3，参照 tdd-bugfix-n2）─────────

console.log('\n=== 组2 DB 行为（免升版自愈列 skill_overrides + session-repo 往返） ===');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runMigrations } = require(path.resolve(repoRoot, 'src', 'main', 'database', 'migrations.ts'));

const cols = (d: { prepare: (sql: string) => { all: () => unknown[] } }, table: string): string[] =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
/** n2 先例的 versionOf 手法：项目版本存 schema_version 表（migrations.ts 不写 PRAGMA user_version）。 */
const versionOf = (d: { prepare: (sql: string) => { get: () => unknown } }): number | null =>
  (d.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? null;

// ⑤ 全新临时库 runMigrations 两遍
{
  const d = openMemoryDb();
  let threw = '';
  try { runMigrations(d); runMigrations(d); } catch (e) { threw = errMsg(e); }
  const hasCol = cols(d, 'sessions').includes('skill_overrides');
  const ver = versionOf(d);
  check('⑤', '全新临时库 runMigrations×2：不抛错；sessions 含 skill_overrides；版本=当前 14（V14 落地后同步）',
    threw === '' && hasCol && ver === 14,
    [threw ? `抛错：${threw.slice(0, 120)}` : '', hasCol ? '' : '缺 skill_overrides 列', ver !== 14 ? `版本=${ver}` : ''].filter(Boolean).join('; '));
  d.close();
}

// ⑥ 老 schema-12 库（手工建含全列但缺 skill_overrides 的 sessions 表 + messages/tasks 最小表——
// migrations 对这两表有无条件自愈块，缺表会在迁移时抛 no such table）
function seedLegacySchema12Db(): ReturnType<typeof openMemoryDb> {
  const d = openMemoryDb();
  d.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, cli_session_id TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', working_dir TEXT,
      permission_mode TEXT DEFAULT NULL, max_turns INTEGER DEFAULT 200,
      provider_override TEXT DEFAULT NULL, model_override TEXT DEFAULT NULL,
      thinking_level TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_context_tokens INTEGER DEFAULT NULL, last_context_updated_at TEXT DEFAULT NULL,
      last_context_window INTEGER DEFAULT NULL, last_context_used INTEGER DEFAULT NULL,
      last_context_used_capacity INTEGER DEFAULT NULL, last_context_used_at INTEGER DEFAULT NULL,
      last_effective_effort TEXT DEFAULT NULL,
      last_turn_duration_ms INTEGER DEFAULT NULL, last_turn_ended_at INTEGER DEFAULT NULL
    );
    CREATE TABLE messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL,
      -- parent_task_id 必带：OPT-8 对其有无条件 CREATE INDEX（自愈块不补该列）。
      parent_task_id TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version) VALUES (12);
    INSERT INTO sessions (id, name) VALUES ('legacy-1', 'old-session');
  `);
  return d;
}
{
  const d = seedLegacySchema12Db();
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = errMsg(e); }
  const hasCol = cols(d, 'sessions').includes('skill_overrides');
  const ver = versionOf(d);
  check('⑥', '老 schema-12 库跑迁移：skill_overrides 列补上；版本升到 14（V14 生效）',
    threw === '' && hasCol && ver === 14,
    [threw ? `抛错：${threw.slice(0, 120)}` : '', hasCol ? '' : '缺 skill_overrides 列（自愈块未覆盖）', ver !== 14 ? `版本=${ver}` : ''].filter(Boolean).join('; '));
  d.close();
}

// ⑦ session-repo 往返（electron-stub 临时 userData 库，真实 connection/session-repo/migrations）
{
  const sub: string[] = [];
  try {
    // 1) 在临时 userData 上迁移出真实 schema（RED 阶段无 skill_overrides 列，GREEN 后自愈补上）。
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { getConnection, closeConnection } = require(path.resolve(repoRoot, 'src', 'main', 'database', 'connection.ts'));
    runMigrations(getConnection());
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const repo = require(path.resolve(repoRoot, 'src', 'main', 'database', 'repositories', 'session-repo.ts'));
    const created = repo.createSession('skill-rt', 'test-model') as { id: string };
    // a) 写 {"pua":"off"} → 读回等值
    try {
      repo.updateSession(created.id, { skillOverrides: { pua: 'off' } });
      const back = repo.getSession(created.id) as { skillOverrides?: Record<string, 'off'> | null };
      if (!deepEq(back?.skillOverrides, { pua: 'off' })) sub.push(`updateSession({pua:off}) 读回 ${JSON.stringify(back?.skillOverrides)} ≠ {"pua":"off"}`);
    } catch (e) { sub.push(`updateSession({pua:off}) 抛错：${errMsg(e).slice(0, 120)}`); }
    // b) 写 null → 读回 null
    try {
      repo.updateSession(created.id, { skillOverrides: null });
      const back = repo.getSession(created.id) as { skillOverrides?: Record<string, 'off'> | null };
      if (back?.skillOverrides !== null) sub.push(`updateSession(null) 读回 ${JSON.stringify(back?.skillOverrides)} ≠ null`);
    } catch (e) { sub.push(`updateSession(null) 抛错：${errMsg(e).slice(0, 120)}`); }
    // c) 脏 JSON 直写 DB → 读回 null（parseSessionSkillOverrides 兜底）
    try {
      const dbFile = path.join(stubUserDataDir, 'claude-link.db');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const raw = new Database(dbFile);
      raw.prepare("UPDATE sessions SET skill_overrides = '{bad json' WHERE id = ?").run(created.id);
      raw.close();
      const back = repo.getSession(created.id) as { skillOverrides?: Record<string, 'off'> | null };
      if (back?.skillOverrides !== null) sub.push(`脏 JSON 读回 ${JSON.stringify(back?.skillOverrides)} ≠ null`);
    } catch (e) { sub.push(`脏 JSON 直写/读回抛错：${errMsg(e).slice(0, 120)}`); }
  } catch (e) {
    sub.push(`往返前置失败：${errMsg(e).slice(0, 160)}`);
  } finally {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(path.resolve(repoRoot, 'src', 'main', 'database', 'connection.ts')).closeConnection();
    } catch { /* 关闭失败不影响判定 */ }
    try { fs.rmSync(stubUserDataDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  }
  check('⑦', 'session-repo 往返：{pua:off} 读回等值；null 读回 null；脏 JSON 读回 null', sub.length === 0, sub.join('; '));
}

// ── 组3 源形契约（regex 源码检查，钉住接线）─────────────────────────────────

console.log('\n=== 组3 源形契约（regex 源码检查） ===');

// ⑧ ipc-handlers.ts：SESSION_CREATE 钉住接线
{
  const src = readRel('src/main/ipc-handlers.ts');
  const pinAt = src.indexOf('buildSessionSkillOverridesForPin(getConfig().skillOverrides)');
  const near = pinAt >= 0 ? src.slice(pinAt, pinAt + 600) : '';
  check('⑧', 'ipc-handlers.ts 含 buildSessionSkillOverridesForPin(getConfig().skillOverrides) 且邻近 updateSession(session.id,{skillOverrides',
    pinAt >= 0 && near.includes('updateSession(session.id, { skillOverrides'),
    pinAt < 0 ? '缺钉住调用（RED 预期）' : '钉住调用存在但邻近缺 updateSession(skillOverrides) 落库');
}

// ⑨ sdk-backend.ts：buildClaudeLinkSettingsBlock 区域含 mergeSkillOverridesIntoSettings
{
  const src = readRel('src/main/modules/sdk-backend.ts');
  const fnAt = src.indexOf('function buildClaudeLinkSettingsBlock');
  let region = '';
  if (fnAt >= 0) {
    const nextFn = src.slice(fnAt + 10).search(/\n(?:export )?(?:async )?function /);
    region = src.slice(fnAt, nextFn < 0 ? fnAt + 12000 : fnAt + 10 + nextFn);
  }
  check('⑨', 'sdk-backend.ts 的 buildClaudeLinkSettingsBlock 区域含 mergeSkillOverridesIntoSettings',
    fnAt >= 0 && region.includes('mergeSkillOverridesIntoSettings'),
    fnAt < 0 ? 'buildClaudeLinkSettingsBlock 未找到' : 'settings 块构造点未并入 mergeSkillOverridesIntoSettings（RED 预期）');
}

// ⑩ claude-settings-projection.ts 不含 skillOverrides（零改动钉住：不进投影/不落用户文件）
{
  const src = readRel('src/main/modules/claude-settings-projection.ts');
  check('⑩', 'claude-settings-projection.ts 不含 skillOverrides（不进投影）', src.length > 0 && !src.includes('skillOverrides'),
    src.length === 0 ? '文件不存在' : '投影文件出现 skillOverrides——违反「仅运行时注入」边界');
}

// ⑪ connection-tester.ts / post-turn-probe.ts 各自仍含 '--setting-sources', ''（零改动钉住：隔离路径）
{
  const ct = readRel('src/main/modules/connection-tester.ts');
  const pt = readRel('src/shared/post-turn-probe.ts');
  check('⑪', "connection-tester.ts 与 src/shared/post-turn-probe.ts 各自仍含 '--setting-sources', ''",
    ct.includes("'--setting-sources', ''") && pt.includes("'--setting-sources', ''"),
    `connection-tester=${ct.includes("'--setting-sources', ''")}, post-turn-probe=${pt.includes("'--setting-sources', ''")}`);
}

// ⑫ migrations.ts：CURRENT_SCHEMA_VERSION ≥ 12 且含 ADD COLUMN skill_overrides TEXT
{
  const src = readRel('src/main/database/migrations.ts');
  const verOk = /CURRENT_SCHEMA_VERSION\s*=\s*1[2-9];/.test(src);
  const colOk = src.includes('ADD COLUMN skill_overrides TEXT');
  check('⑫', 'migrations.ts CURRENT_SCHEMA_VERSION ≥ 12 且含 ADD COLUMN skill_overrides TEXT',
    verOk && colOk,
    [verOk ? '' : 'CURRENT_SCHEMA_VERSION < 12（版本回退）', colOk ? '' : '缺 skill_overrides 补列语句（RED 预期）'].filter(Boolean).join('; '));
}

// ⑬ App.vue：globalSnapshot = payload.snapshot（或等价赋值）
{
  const src = readRel('src/renderer/App.vue');
  check('⑬', 'App.vue 含 globalSnapshot = payload.snapshot（或等价赋值）',
    /globalSnapshot\s*=\s*payload\.snapshot/.test(src),
    '未找到 globalSnapshot 赋值（RED 预期）');
}

// ⑭ command-store.ts：暂态分支含 filterCommandsBySkillOverrides；回填分支不含
{
  const src = readRel('src/renderer/stores/command-store.ts');
  const tAt = src.indexOf('if (active?.transient) {');
  const tEnd = tAt >= 0 ? src.indexOf('return;', tAt) : -1;
  const transient = tAt >= 0 && tEnd > tAt ? src.slice(tAt, tEnd) : '';
  const bAt = src.indexOf('const current = this.snapshotsBySession[active.id]');
  const bEndRaw = src.indexOf('\n    async load(', bAt);
  const backfill = bAt >= 0 ? src.slice(bAt, bEndRaw > bAt ? bEndRaw : bAt + 1500) : '';
  const transientOk = transient.includes('filterCommandsBySkillOverrides');
  const backfillOk = backfill.length > 0 && !backfill.includes('filterCommandsBySkillOverrides');
  check('⑭', 'command-store.ts 暂态分支含 filterCommandsBySkillOverrides 调用；回填分支不含',
    transientOk && backfillOk,
    [transientOk ? '' : '暂态分支缺过滤调用（RED 预期）', backfillOk ? '' : '回填分支不应含过滤调用'].filter(Boolean).join('; '));
}

// ⑮【B2* 改写】ConfigPage.vue：TabId 含 'skill' / data-testid / PERSISTED_FIELDS / !== 'off' 绑定
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const sub: string[] = [];
  if (!/type TabId\s*=\s*[^;\n]*'skill'/.test(src)) sub.push("TabId 联合类型缺 'skill'");
  if (!src.includes('data-testid="skill-manage-section"')) sub.push('缺 data-testid="skill-manage-section"');
  if (!/PERSISTED_FIELDS\s*=\s*\[[\s\S]{0,800}?'skillOverrides'/.test(src)) sub.push("PERSISTED_FIELDS 数组缺 'skillOverrides'");
  if (!src.includes("!== 'off'")) sub.push("缺开关绑定形态 !== 'off'（启用语义 checked = 未禁用）");
  check('⑮', "ConfigPage.vue：TabId 含 'skill'；skill-manage-section testid；PERSISTED_FIELDS 含 skillOverrides；开关绑定 !== 'off'",
    sub.length === 0, sub.join('; ') + (sub.length ? '（RED 预期）' : ''));
}

// ── 组4 契约同步检查 ────────────────────────────────────────────────────────

console.log('\n=== 组4 契约同步检查（运行验证而非源形） ===');

// ⑯ regression-tests.ts 全量契约回归 exit 0。
// 选择：实测 spawn 耗时 ~2s（远低于 60s 豁免线），无跨工作流硬依赖 → 按计划原文真实运行，
// 不使用 SKIP 豁免。
{
  const r = spawnSync('npx', ['tsx', 'scripts/regression-tests.ts'], {
    cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
  check('⑯', 'regression-tests.ts 全量契约回归 exit 0（既有 settings/probe/commands 断言不因本改动变红）',
    r.status === 0,
    r.status === 0 ? '' : `exit=${r.status}${r.error ? ` err=${String(r.error)}` : ''}\n${tail}`);
}

// ── P2 修复补充源形契约（组3 风格，⑰⑱）────────────────────────────────────
// RED 预期：⑰⑱ FAIL（P2 未修）；既有 ①-⑯ 不受影响。GREEN 目标：18/18 全 PASS。

console.log('\n=== P2 补充源形契约（SESSION_UPDATE 运行时剔除 / 暂态早退登记刷新） ===');

// ⑰【P2-1】ipc-handlers.ts：SESSION_UPDATE handler 区域——既有 delete 白名单（thinkingLevel/
// permissionMode/providerOverride/modelOverride，「不信任 renderer 传值」先例）在位，且新增
// data.skillOverrides 运行时剔除（钉住值仅由 SESSION_CREATE 依据全局配置落库，本通道一律剔除）。
{
  const src = readRel('src/main/ipc-handlers.ts');
  const updAt = src.indexOf('IPC_CHANNELS.SESSION_UPDATE');
  const nextAt = updAt >= 0 ? src.indexOf('IPC_CHANNELS.', updAt + 10) : -1;
  const region = updAt >= 0 && nextAt > updAt ? src.slice(updAt, nextAt) : '';
  const whitelistOk = /delete data\.(thinkingLevel|permissionMode|providerOverride|modelOverride)/.test(region);
  const stripOk = /delete data\.skillOverrides/.test(region);
  check('⑰', 'SESSION_UPDATE handler：既有 delete 白名单在位，且含 data.skillOverrides 运行时剔除',
    whitelistOk && stripOk,
    [whitelistOk ? '' : '既有 delete 白名单形态未找到（区域锚定失败）', stripOk ? '' : '缺 data.skillOverrides 运行时剔除（P2-1 RED 预期）'].filter(Boolean).join('; '));
}

// ⑱【P2-2】session-store.ts：startTransientSession 早退分支（单例复用：activeSession?.transient
// 与邻近 return 区域）含 markTransientSession 登记刷新——config.skillOverrides 在暂态存活期间
// 可能已被改过，早退不刷新会让 ChatInput 去抖重拉按旧 overrides 过滤，与文末登记路径不一致。
{
  const src = readRel('src/renderer/stores/session-store.ts');
  const fnAt = src.indexOf('startTransientSession()');
  const earlyAt = fnAt >= 0 ? src.indexOf('if (this.activeSession?.transient)', fnAt) : -1;
  const retAt = earlyAt >= 0 ? src.indexOf('return;', earlyAt) : -1;
  const region = earlyAt >= 0 && retAt > earlyAt ? src.slice(earlyAt, retAt) : '';
  check('⑱', 'startTransientSession 早退分支（activeSession?.transient 与 return 邻近区域）含 markTransientSession 调用',
    fnAt >= 0 && earlyAt >= 0 && retAt > earlyAt && region.includes('markTransientSession'),
    fnAt < 0 || earlyAt < 0 || retAt <= earlyAt ? '早退分支未找到' : '早退分支缺 markTransientSession 登记刷新（P2-2 RED 预期）');
}

// ── S2 独立 review P2 修复源形契约（组3 风格，⑲⑳㉑）─────────────────────────
// 2026-09-15 独立 review（docs/review/2026-09-15-skill-management-independent-review.md §2）
// 抓出两处 P2（S2-P2-1 暂态过滤时效性 / S2-P2-2 启动自愈不全 + 误导空态）；本组钉住修复形态。
// RED 预期：对未修复工作树 ⑲⑳㉑ FAIL、①-⑱ 不受影响。全限定名带「S2-」前缀避免与前轮 P2 撞号。

console.log('\n=== S2 review P2 修复源形契约（load() 现值过滤 / 回填移出暂态分支 / ConfigPage loading 分支） ===');

// ⑲【S2-P2-1】command-store.ts load()：暂态过滤取「当前」全局配置（与 App.vue 广播路径同源），
// 登记表仅作暂态身份判定、不再向过滤提供冻结值（暂态存活期间拨开关后的去抖重拉倒退覆盖修复）。
{
  const src = readRel('src/renderer/stores/command-store.ts');
  const loadAt = src.indexOf('async load(sessionId: string)');
  const nextAt = loadAt >= 0 ? src.indexOf('async loadDiagnostics', loadAt) : -1;
  const region = loadAt >= 0 && nextAt > loadAt ? src.slice(loadAt, nextAt) : '';
  const currentCfgOk = region.includes('useConfigStore().config.skillOverrides');
  const frozenFilterGone = !region.includes('filterCommandsBySkillOverrides(snapshot.commands, overrides)');
  const identityOk = region.includes('transientOverridesBySession[sessionId]');
  check('⑲', 'load() 暂态过滤取 useConfigStore().config.skillOverrides 当前值；登记表冻结值过滤形态移除；登记表保留身份判定',
    currentCfgOk && frozenFilterGone && identityOk,
    [currentCfgOk ? '' : 'load() 区域缺 useConfigStore().config.skillOverrides 当前值取用（S2-P2-1 RED 预期）',
     frozenFilterGone ? '' : '登记表冻结值过滤形态仍在（倒退覆盖未修）',
     identityOk ? '' : '登记表暂态身份判定缺失'].filter(Boolean).join('; '));
}

// ⑳【S2-P2-2】command-store.ts load()：globalSnapshot 哨兵回填移出暂态分支——凡响应为全局
// 兜底派生数据（source==='cache'：兜底副本 / loading 默认 / degraded 克隆）即回填，非暂态路径
// 同样回填（闭合「启动广播落在订阅前 + 不建暂态」自愈缺口）；per-session 权威快照
//（probe/init/changed，可能被引擎按钉住 overrides 过滤）不回填，保住「未过滤全局快照」语义。
{
  const src = readRel('src/renderer/stores/command-store.ts');
  const loadAt = src.indexOf('async load(sessionId: string)');
  const nextAt = loadAt >= 0 ? src.indexOf('async loadDiagnostics', loadAt) : -1;
  const region = loadAt >= 0 && nextAt > loadAt ? src.slice(loadAt, nextAt) : '';
  const guardBackfillOk = /if \(snapshot\.source === 'cache'\)\s*\{\s*this\.globalSnapshot = \{ \.\.\.snapshot, sessionId: GLOBAL_FALLBACK_SESSION_ID \};\s*\}/.test(region);
  const backfillAt = region.indexOf('this.globalSnapshot = { ...snapshot, sessionId: GLOBAL_FALLBACK_SESSION_ID }');
  const elseAt = region.indexOf('} else {');
  const afterTransientElse = backfillAt >= 0 && elseAt >= 0 && backfillAt > elseAt;
  check('⑳', "load() 回填以 source==='cache' 守卫且位于暂态 if/else 收口之后（非暂态路径同样回填）",
    guardBackfillOk && afterTransientElse,
    [guardBackfillOk ? '' : "缺 source==='cache' 守卫 + 哨兵回填邻接形态（S2-P2-2 RED 预期）",
     afterTransientElse ? '' : '回填语句不在暂态 if/else 收口之后（仍在暂态分支内）'].filter(Boolean).join('; '));
}

// ㉑【S2-P2-2】ConfigPage.vue：状态链补 loading 分支（null 与 loading 同占位「正在探测」），
// 统计三卡与空态网格在「探测中」不渲染（0/0/0 + 「当前筛选下无匹配的 Skill」误导空态修复）。
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const pendingComputedOk = src.includes('const skillProbePending = computed')
    && /const skillProbePending = computed[\s\S]{0,200}?status === 'loading'/.test(src);
  const armOk = src.includes('v-if="skillProbePending"');
  const statOk = src.includes('<div v-if="!skillProbePending" class="stat-grid">');
  const emptyOk = src.includes('v-if="!skillProbePending && visibleSkills.length === 0"');
  check('㉑', "ConfigPage 状态链含 loading（skillProbePending：null||loading 同占位）；统计三卡与空态网格排除「探测中」",
    pendingComputedOk && armOk && statOk && emptyOk,
    [pendingComputedOk ? '' : "缺 skillProbePending computed（含 status === 'loading' 判定）",
     armOk ? '' : '状态条占位臂未改用 skillProbePending',
     statOk ? '' : '统计三卡未排除「探测中」',
     emptyOk ? '' : '空态网格未排除「探测中」'].filter(Boolean).join('; '));
}

// ── 冷启动自愈正式化源形契约（组3 风格，㉒㉓㉔）─────────────────────────────
// 2026-09-15 生产缺陷「冷启动零交互直进 Skill 管理页永不加载」（根因报告：
// D:\software\Cache\claude-link\skill-verify\rootcause-coldstart\rootcause-report.md）：
// COMMANDS_GLOBAL_CHANGED 一次性推送早于 App.vue 订阅注册即永久丢失，而 load() 全部调用点
// 交互驱动、Skill 页纯被动——修复 = ensureGlobalSnapshot 幂等按需拉取（复用 COMMANDS_GET
// 哨兵只读分流，零新增 IPC）+ Skill tab 激活接线 + App.vue 订阅就绪后补拉。
// RED 预期：对未修复工作树 ㉒㉓㉔ FAIL、①-㉑ 不受影响。

console.log('\n=== 冷启动自愈正式化源形契约（ensureGlobalSnapshot 三处接线） ===');

// ㉒【coldstart-1】command-store.ts：ensureGlobalSnapshot 定义在位 + 幂等守卫形态
//（null/loading 判定——非 loading 快照直接返回防 tab 拉取风暴）+ in-flight 锁（并发去重）。
{
  const src = readRel('src/renderer/stores/command-store.ts');
  const ensureAt = src.indexOf('async ensureGlobalSnapshot(): Promise<void>');
  let body = '';
  if (ensureAt >= 0) {
    const nextAt = src.indexOf('\n    async ', ensureAt + 10);
    body = src.slice(ensureAt, nextAt > ensureAt ? nextAt : ensureAt + 1600);
  }
  const defOk = ensureAt >= 0;
  const guardOk = body.includes('this.globalSnapshot') && /status\s*!==\s*'loading'/.test(body);
  const lockOk = body.includes('globalEnsureInFlight') && /globalEnsureInFlight[^=]*=\s*null/.test(src);
  check('㉒', 'command-store.ts：ensureGlobalSnapshot 定义；守卫（globalSnapshot 非 loading 直接返回）；in-flight 锁（globalEnsureInFlight）',
    defOk && guardOk && lockOk,
    [defOk ? '' : '缺 ensureGlobalSnapshot 定义（coldstart RED 预期）',
     guardOk ? '' : '守卫缺 globalSnapshot null/loading 判定形态',
     lockOk ? '' : '缺 in-flight 锁（globalEnsureInFlight）形态'].filter(Boolean).join('; '));
}

// ㉓【coldstart-2】ConfigPage.vue：Skill tab 激活 → ensureGlobalSnapshot 接线
//（watch(activeTab) 回调内含 'skill' 判定与 ensureGlobalSnapshot 调用）。
{
  const src = readRel('src/renderer/pages/ConfigPage.vue');
  const watchAt = src.indexOf('watch(activeTab');
  const body = watchAt >= 0 ? src.slice(watchAt, watchAt + 400) : '';
  const skillOk = body.includes("'skill'");
  const ensureOk = body.includes('ensureGlobalSnapshot');
  check('㉓', "ConfigPage.vue：watch(activeTab) 含 'skill' 判定 → commandStore.ensureGlobalSnapshot 调用",
    watchAt >= 0 && skillOk && ensureOk,
    [watchAt < 0 ? '缺 watch(activeTab 接线（coldstart RED 预期）' : '',
     watchAt >= 0 && !skillOk ? "watch 回调缺 'skill' 判定" : '',
     watchAt >= 0 && !ensureOk ? 'watch 回调缺 ensureGlobalSnapshot 调用' : ''].filter(Boolean).join('; '));
}

// ㉔【coldstart-3】App.vue：COMMANDS_GLOBAL_CHANGED 订阅注册之后含 ensureGlobalSnapshot 补拉
//（覆盖「用户从不进 Skill 页」的全路由场景；出现位置须在订阅之后，保证订阅先就绪）。
{
  const src = readRel('src/renderer/App.vue');
  const subAt = src.indexOf('onGlobalCommandsChanged');
  const callAt = src.indexOf('ensureGlobalSnapshot');
  check('㉔', 'App.vue：onGlobalCommandsChanged 订阅之后含 ensureGlobalSnapshot 补拉调用',
    subAt >= 0 && callAt > subAt,
    subAt < 0 ? '订阅注册未找到' : callAt < 0 ? '缺补拉调用（coldstart RED 预期）' : '补拉调用不在订阅之后（须晚于订阅注册）');
}

console.log(`\n===== tdd-skill-overrides-verify: ${pass} pass / ${fail} fail =====`);
if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
process.exit(fail > 0 ? 1 : 0);
