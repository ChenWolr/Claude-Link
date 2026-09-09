// tdd-bugfix-n2-permission-mode-cleanup-once-verify.ts
// N2（P1）契约钉：`permission_mode='default'` 存量清洗是**无版本守卫的启动块**——
// 'default' 是 UI/校验层的一等显式档（SessionToolbar 可选、SESSION_UPDATE 白名单放行），
// 用户显式钉在安全档的会话**每次重启被抹为 NULL（跟随全局）**；全局为自动模式时=静默升权。
//
// 修复语义：清洗迁入带版本号的 V11 块（仅在该版本未应用时执行一次），
// CURRENT_SCHEMA_VERSION 升 11——用户显式 'default' 重启后保留。
//
// 运行：npx tsx scripts/tdd-bugfix-n2-permission-mode-cleanup-once-verify.ts
// （better-sqlite3 为 Electron ABI：当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重spawn 本脚本）

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

type Db = import('better-sqlite3').Database;

function openMemoryDb(): Db {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  return new Database(':memory:');
}

/** ABI 不匹配（node 127 vs electron 133）时以 electron-as-node 重跑自身并透传退出码。 */
function respawnUnderElectronIfNeeded(err: unknown): never | void {
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

let db: Db;
try {
  db = openMemoryDb();
} catch (err) {
  respawnUnderElectronIfNeeded(err);
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runMigrations } = require('../src/main/database/migrations');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const cols = (d: Db, table: string): string[] =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const versionOf = (d: Db): number | null =>
  (d.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? null;
const permModes = (d: Db): (string | null)[] =>
  (d.prepare('SELECT permission_mode FROM sessions ORDER BY rowid').all() as { permission_mode: string | null }[])
    .map((r) => r.permission_mode);

function seedLegacyDb(explicitVersion: number): Db {
  const d = openMemoryDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, cli_session_id TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', working_dir TEXT,
      permission_mode TEXT DEFAULT NULL, max_turns INTEGER DEFAULT 200,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
      content TEXT NOT NULL, raw_event TEXT, event_type TEXT, cost_usd REAL, duration_ms INTEGER,
      parent_task_id TEXT, process_kind TEXT, parent_agent_id TEXT, tool_use_id TEXT, title TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','running','completed','failed','cancelled')),
      sort_order INTEGER NOT NULL DEFAULT 0, result TEXT, cost_usd REAL, duration_ms INTEGER,
      error_message TEXT, started_at TEXT, completed_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    INSERT INTO schema_version (version) VALUES (${explicitVersion});
    INSERT INTO sessions (id, name, permission_mode) VALUES
      ('s1', 'legacy-phantom', 'default'),
      ('s2', 'explicit-bypass', 'bypassPermissions'),
      ('s3', 'follow-global', NULL);
  `);
  return d;
}

// ── 场景 1：升级路径（版本 10 老库，含 legacy 幻影 'default'）——清洗执行一次 ──
{
  const d = seedLegacyDb(10);
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('① 版本 10 老库升级不抛错且版本到 12', threw === '' && versionOf(d) === 12, threw || `version=${versionOf(d)}`);
  check('② 升级时 legacy 幻影 default 清洗为 NULL（一次性 V11 语义保留）',
    JSON.stringify(permModes(d)) === JSON.stringify([null, 'bypassPermissions', null]),
    JSON.stringify(permModes(d)));
  d.close();
}

// ── 场景 2：版本 11 库，用户显式重选 'default'——重启后必须保留（N2 主场景）──
{
  const d = seedLegacyDb(11);
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('③ 版本 11 库重启迁移不抛错', threw === '', threw.slice(0, 160));
  check('④ 用户显式 default 重启后保留（不再被启动清洗抹为 NULL）',
    JSON.stringify(permModes(d)) === JSON.stringify(['default', 'bypassPermissions', null]),
    JSON.stringify(permModes(d)));
  check('⑤ 版本 11 老库迁移后版本到 12（V12 落地后 v11 库迁移即升 12）', versionOf(d) === 12, `version=${versionOf(d)}`);
  d.close();
}

// ── 场景 3：全新库——迁移到 12，V11 块对空表无害 ──
{
  const d = openMemoryDb();
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('⑥ 全新库迁移不抛错且版本到 12', threw === '' && versionOf(d) === 12, threw || `version=${versionOf(d)}`);
  d.close();
}

// ── 结构契约：清洗在版本块内 + 版本常量 ──
{
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/main/database/migrations.ts'), 'utf8');
  check('⑦ permission_mode 清洗迁入 currentVersion < 11 版本块（非无条件启动块）', (() => {
    const v11 = src.slice(src.indexOf('currentVersion < 11'));
    return /UPDATE sessions SET permission_mode = NULL[\s\S]*?WHERE permission_mode = 'default'/.test(v11);
  })());
  check('⑧ CURRENT_SCHEMA_VERSION = 12', /CURRENT_SCHEMA_VERSION = 12;/.test(src));
  check('⑨ 无版本守卫的裸 permission_mode 清洗已移除（清洗只出现在 V11 块内）', (() => {
    const v11At = src.indexOf('currentVersion < 11');
    const before = src.slice(0, v11At);
    return !/UPDATE sessions SET permission_mode = NULL/.test(before);
  })());
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
