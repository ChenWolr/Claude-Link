// tdd-bugfix-p1-10-migrations-idempotent-verify.ts
// P1-10 契约钉：迁移非事务且版本块先于自愈块 →「ALTER 已执行、版本号未写」中间态
//（升级中崩溃/断电）每次启动复现 duplicate column 抛错，需手改 DB。
//
// 修复语义：① 版本块（V2/V8）的 ALTER TABLE ADD COLUMN 加 PRAGMA table_info 列存在守卫；
// ② V2 的 model_override 补进幂等自愈清单；③ runMigrations 整体包 db.transaction（SQLite DDL 可事务化）。
//
// 运行：npx tsx scripts/tdd-bugfix-p1-10-migrations-idempotent-verify.ts
// （better-sqlite3 为 Electron ABI：当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重spawn 本脚本）

import { spawnSync } from 'node:child_process';
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
    process.execPath.replace(/node\.exe$/i, 'electron.exe').includes('electron')
      ? path.join('node_modules', '.bin', 'electron.cmd')
      : path.join('node_modules', '.bin', 'electron.cmd'),
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

const V1_SQL = `
  CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cli_session_id TEXT,
    model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', working_dir TEXT,
    permission_mode TEXT DEFAULT NULL, max_turns INTEGER DEFAULT 200,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','system','tool')),
    content TEXT NOT NULL, raw_event TEXT, event_type TEXT, cost_usd REAL, duration_ms INTEGER,
    parent_task_id TEXT, process_kind TEXT, parent_agent_id TEXT, tool_use_id TEXT, title TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','queued','running','completed','failed','cancelled')),
    sort_order INTEGER NOT NULL DEFAULT 0, result TEXT, cost_usd REAL, duration_ms INTEGER,
    error_message TEXT, started_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;
const cols = (d: Db, table: string): string[] =>
  (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
const versionOf = (d: Db): number | null =>
  (d.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? null;

// ── 场景 1：全新库 ──
{
  const d = openMemoryDb();
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('① 全新库迁移不抛错且版本到 12', threw === '' && versionOf(d) === 12, threw || `version=${versionOf(d)}`);
  const sess = cols(d, 'sessions');
  check('② 全新库列齐全（model_override/provider_override/thinking_level/paused/is_error）',
    sess.includes('model_override') && sess.includes('provider_override') && sess.includes('thinking_level')
    && cols(d, 'tasks').includes('paused') && cols(d, 'messages').includes('is_error'));
  d.close();
}

// ── 场景 2：半应用态（ALTER 已执行、版本号 0）——修复主场景 ──
{
  const d = openMemoryDb();
  d.exec(V1_SQL);
  d.exec("ALTER TABLE sessions ADD COLUMN model_override TEXT DEFAULT NULL");
  d.exec('INSERT INTO schema_version (version) VALUES (0)');
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('③ 半应用态（model_override 已加、版本 0）迁移不抛 duplicate column',
    threw === '', threw.slice(0, 160));
  check('④ 半应用态迁移后版本写到 12 且列齐全', versionOf(d) === 12 && cols(d, 'sessions').includes('provider_override'));
  d.close();
}

// ── 场景 3：版本 9 但 model_override 缺失（自愈清单验证）──
{
  const d = openMemoryDb();
  d.exec(V1_SQL);
  d.exec('INSERT INTO schema_version (version) VALUES (9)');
  let threw = '';
  try { runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('⑤ 版本 9 缺 model_override → 自愈补列不抛错',
    threw === '' && cols(d, 'sessions').includes('model_override'), threw.slice(0, 160));
  d.close();
}

// ── 场景 4：迁移可安全重放（事务化 + 幂等）──
{
  const d = openMemoryDb();
  runMigrations(d);
  let threw = '';
  try { runMigrations(d); runMigrations(d); } catch (e) { threw = e instanceof Error ? e.message : String(e); }
  check('⑥ 重复重放迁移不抛错（幂等）', threw === '', threw.slice(0, 160));
  d.close();
}

// ── 结构：事务化 + 守卫 ──
{
  const src = require('node:fs').readFileSync(path.resolve(__dirname, '..', 'src/main/database/migrations.ts'), 'utf8');
  check('⑦ runMigrations 整体包 db.transaction（DDL 事务化，中断可安全重放）',
    /db\.transaction\(/.test(src));
  check('⑧ V2/V8 版本块 ALTER 前有列存在守卫', (() => {
    const v2 = src.slice(src.indexOf('if (currentVersion < 2)'), src.indexOf('if (currentVersion < 8)'));
    const v8 = src.slice(src.indexOf('if (currentVersion < 8)'), src.indexOf('const sessCols'));
    return /tableColumns|hasCol/.test(v2) && /tableColumns|hasCol/.test(v8);
  })());
  check('⑨ 自愈清单含 model_override', /hasCol\('model_override'\)/.test(src));
}

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
