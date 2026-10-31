// tdd-turn-file-diff-verify.ts
// 计划 docs/plans/2026-10-26-turn-file-changes-diff-and-web-changes-fix-plan.md 契约脚本。
// 由 plan-loop 各原子点分段追加（P1 先建；后续点在本文件末尾续写各段，勿删占位注释）：
//   段A（P1）：迁移 v15（turn_file_checkpoints 建表+索引+版本记录=15，幂等，v14 老库自动升级）
//             + turn-file-checkpoint-repo（insert / listBySession JOIN 丢孤儿行 / countBySession /
//               sessions 级联清空）。
//   段B（P2）已落地：shared/diff-core 提取（buildTwoFilePatch 机械搬移）+ diffFull。
//   段C（P3）已落地：checkpoint 记录器（noteCheckpointEvent 伪事件直喂 + 临时库 + 临时目录真实文件）。
//             round-002 追加 C⑥–C⑨：>2MiB 截断前缀 / 含 \0 binary / binary 判定先于截断（M-A3）/ 逐 part 容错（M-A5）。
//             round-001 R4 追加 C⑩–C⑫（负向）：非 diff 工具（Bash/Read）不落库 / 双 session Map 隔离互不串 /
//             disposeSession 清 Map 后同 session tool_result 不落库。
//   段D（P4）已落地：主进程聚合 turn-diff（aggregateFromCheckpoints/computeFileDiff 纯函数直测
//             + deriveTurnRanges/getPatch/listSummaries 临时库侧）。
//   段D round-001 R1 追加 D-ro①/D-ro②：同轮/跨轮乱序落库（数组序=id 序 ≠ mrow 序）时
//             after/before 一律按 mrow（消息序）最大者选取的回归钉。
//   段E（P1，2026-10-30 意图合成器重写计划 §2.2/§2.3）：synthesizeFirstChange 虚拟文档链
//             ——E1 mrow 排序治乱序（S2）/ E2 hunk 头锚定真实行号（S3）/ E3 context 透传生效（S1）/
//             E4 多 Write ± 净计（H3 有意修正）/ E5 截断与 ± 全量（S5/N3）/ E6 getPatch context
//             端到端（S6 DB 侧）/ E7 未命中追加兜底（S4）。
//             E8 合成 patch 喂渲染层 parseUnifiedDiff 解析链契约钉（review-round1 F-1 跟进）。
//
// 运行：npx tsx scripts/tdd-turn-file-diff-verify.ts
// （better-sqlite3 为 Electron ABI：当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重 spawn 本脚本——
//   n2 / skill-overrides 先例。DB 行为用 electron-stub（house pattern）：Module._load 把 'electron'
//   解析到 scripts/electron-stub.cjs，app.getPath 由 CLAUDE_LINK_TEST_USERDATA 指向 Cache 临时目录，
//   真实 connection/runMigrations/repo 在临时库上跑，绝不触碰真实用户库。）

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseUnifiedDiff } from '../src/renderer/utils/diff-parser';

const repoRoot = path.resolve(__dirname, '..');

// —— electron-stub 安装（tdd-skill-overrides / p1-01 / n4 先例）：必须在 require 任何主进程模块之前 ——
const stubUserDataDir = path.join(
  'D:\\software\\Cache',
  'claude-link',
  'turn-file-diff-verify',
  `tmp-userdata-${process.pid}-${Date.now()}`,
);
// 入口清扫：上轮运行若因 db 句柄未放（Windows 上 rmSync 报 EBUSY/EPERM）留下 tmp-userdata-*
// 残留，本轮建目录前先逐个清掉历史 tmp-userdata-*（尽力而为，清扫失败吞异常不阻断本轮）。
{
  const sweepRoot = path.dirname(stubUserDataDir);
  try {
    for (const entry of fs.readdirSync(sweepRoot)) {
      if (entry.startsWith('tmp-userdata-')) {
        try { fs.rmSync(path.join(sweepRoot, entry), { recursive: true, force: true }); } catch { /* 尽力清扫 */ }
      }
    }
  } catch { /* 根目录尚不存在：无残留可清 */ }
}
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

// —— better-sqlite3 ABI 预检 + ELECTRON_RUN_AS_NODE respawn（照抄 n2 / skill-overrides 手法）——
function openMemoryDb(): unknown {
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
  let probe: { close: () => void } | null = null;
  try {
    probe = openMemoryDb() as { close: () => void };
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

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** n2 先例的 versionOf 手法：项目版本存 schema_version 表（migrations.ts 不写 PRAGMA user_version）。 */
function versionOf(d: { prepare: (sql: string) => { get: () => unknown } }): number | null {
  return (d.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number } | undefined)?.version ?? null;
}

function tableCols(d: { prepare: (sql: string) => { all: () => unknown[] } }, table: string): string[] {
  return (d.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
}

// ═══════════════════════════════════════════════════════════════════════════
// 段A（P1）：迁移 v15 + turn-file-checkpoint-repo
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段A 迁移 v15 + turn-file-checkpoint-repo（P1） ===');

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runMigrations } = require(path.resolve(repoRoot, 'src', 'main', 'database', 'migrations.ts'));

// checkpoint repo：RED 阶段模块不存在 → require 失败降级为断言 FAIL，脚本不 crash。
let checkpointRepo: Record<string, unknown> | null = null;
let checkpointRepoErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  checkpointRepo = require(path.resolve(repoRoot, 'src', 'main', 'database', 'repositories', 'turn-file-checkpoint-repo.ts'));
} catch (e) {
  checkpointRepoErr = errMsg(e);
}

// 临时目录 SQLite 库（electron-stub userData 下 claude-link.db，真实 connection）。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const connectionMod = require(path.resolve(repoRoot, 'src', 'main', 'database', 'connection.ts'));
const db = connectionMod.getConnection() as {
  prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] };
  exec: (sql: string) => void;
};

// a) runMigrations 两次：第二次不抛错（幂等）、turn_file_checkpoints 表存在、版本记录=15。
{
  let migrateThrew = '';
  try { runMigrations(db); runMigrations(db); } catch (e) { migrateThrew = errMsg(e); }
  const tableExists = tableCols(db, 'turn_file_checkpoints').length > 0;
  const ver = versionOf(db);
  check('A①', '临时目录库 runMigrations×2：不抛错（幂等）', migrateThrew === '', migrateThrew.slice(0, 160));
  check('A②', 'turn_file_checkpoints 表存在', tableExists, '迁移后表缺失');
  check('A③', '版本记录 = 15', ver === 15, `实际=${String(ver)}`);
}

// 列集与索引、外键（建表 SQL 逐字契约的物理形态）。
{
  const cols = tableCols(db, 'turn_file_checkpoints');
  const expectedCols = [
    'id', 'session_id', 'message_id', 'path', 'tool_name', 'tool_use_id',
    'input_json', 'input_truncated', 'after_content', 'after_truncated',
    'binary', 'snapshot_state',
  ];
  check('A④', 'turn_file_checkpoints 列集齐全（§3.3 建表）',
    expectedCols.every((c) => cols.includes(c)) && cols.length === expectedCols.length,
    `实际列=[${cols.join(',')}]`);
  const indexes = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='turn_file_checkpoints'",
  ).all() as Array<{ name: string }>;
  const idxNames = indexes.map((i) => i.name);
  check('A⑤', '两个索引存在（idx_tfc_session / idx_tfc_session_path）',
    idxNames.includes('idx_tfc_session') && idxNames.includes('idx_tfc_session_path'),
    `实际索引=[${idxNames.join(',')}]`);
  const fk = db.prepare('PRAGMA foreign_key_list(turn_file_checkpoints)').all() as
    Array<{ table: string; to: string; on_delete: string }>;
  check('A⑥', 'session_id 外键引用 sessions(id) ON DELETE CASCADE（级联前提）',
    fk.length === 1 && fk[0]!.table === 'sessions' && fk[0]!.to === 'id' && fk[0]!.on_delete === 'CASCADE',
    `实际=${JSON.stringify(fk)}`);
}

// a续) 老库 v14 自动升级路径：手工造 v14 最小库（schema_version=14 + sessions/messages/tasks 最小表，
// 无 turn_file_checkpoints）跑 runMigrations → 不破坏、补建新表、版本升 15（影响面自查断言）。
function seedLegacyV14Db(): { prepare: (sql: string) => { run: (...args: unknown[]) => unknown; get: (...args: unknown[]) => unknown; all: (...args: unknown[]) => unknown[] }; exec: (sql: string) => void; close: () => void } {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  const d = new Database(':memory:');
  d.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, cli_session_id TEXT,
      model TEXT NOT NULL DEFAULT 'claude-sonnet-4-6', working_dir TEXT,
      permission_mode TEXT DEFAULT NULL, max_turns INTEGER DEFAULT 200,
      model_override TEXT DEFAULT NULL, provider_override TEXT DEFAULT NULL,
      thinking_level TEXT DEFAULT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    INSERT INTO schema_version (version) VALUES (14);
  `);
  return d;
}
{
  const legacy = seedLegacyV14Db();
  let upgradeThrew = '';
  try { runMigrations(legacy); } catch (e) { upgradeThrew = errMsg(e); }
  const newTableExists = tableCols(legacy, 'turn_file_checkpoints').includes('id')
    && tableCols(legacy, 'turn_file_checkpoints').includes('snapshot_state');
  const legacySessionsIntact = tableCols(legacy, 'sessions').includes('id')
    && (legacy.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n === 0;
  const legacyVer = versionOf(legacy);
  check('A⑦', '老库 v14 自动升级：不抛错；turn_file_checkpoints 补建；版本升 15；既有表不受损',
    upgradeThrew === '' && newTableExists && legacySessionsIntact && legacyVer === 15,
    [upgradeThrew ? `抛错：${upgradeThrew.slice(0, 120)}` : '',
      newTableExists ? '' : '新表未建',
      legacySessionsIntact ? '' : 'sessions 表受损',
      legacyVer !== 15 ? `版本=${legacyVer}` : ''].filter(Boolean).join('; '));
  legacy.close();
}

// b) repo 往返：session+messages → insert 3 条（2 合法 message_id + 1 孤儿）→
//    listBySession 返回 2 条、id 升序、字段回读一致、含 mrow；孤儿行 JOIN 自然丢弃、不抛错。
{
  const insert = checkpointRepo?.insert as ((row: Record<string, unknown>) => unknown) | undefined;
  const listBySession = checkpointRepo?.listBySession as ((sessionId: string) => unknown[]) | undefined;

  db.prepare("INSERT INTO sessions (id, name, model) VALUES ('sess-tfc-1', '回合文件改动-测试会话', 'claude-sonnet-4-6')").run();
  db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES ('msg-1', 'sess-tfc-1', 'user', '改一下 a.txt')").run();
  db.prepare("INSERT INTO messages (id, session_id, role, content) VALUES ('msg-2', 'sess-tfc-1', 'assistant', '好的')").run();

  const row1 = {
    session_id: 'sess-tfc-1',
    message_id: 'msg-1',
    path: 'D:/proj/a.txt',
    tool_name: 'Write',
    tool_use_id: 'tu-1',
    input_json: '{"file_path":"D:/proj/a.txt","content":"hello\\nworld"}',
    input_truncated: 0,
    after_content: 'hello\nworld',
    after_truncated: 0,
    binary: 0,
    snapshot_state: 'disk',
  };
  const row2 = {
    session_id: 'sess-tfc-1',
    message_id: 'msg-2',
    path: 'D:/proj/b.bin',
    tool_name: 'Write',
    tool_use_id: 'tu-2',
    input_json: '{"file_path":"D:/proj/b.bin","content":"BIN',
    input_truncated: 1,
    after_content: null,
    after_truncated: 0,
    binary: 1,
    snapshot_state: 'failed',
  };
  const row3Orphan = {
    session_id: 'sess-tfc-1',
    message_id: 'msg-missing-not-in-messages',
    path: 'D:/proj/c.txt',
    tool_name: 'Write',
    tool_use_id: 'tu-3',
    input_json: null,
    input_truncated: 0,
    after_content: 'orphan',
    after_truncated: 0,
    binary: 0,
    snapshot_state: 'disk',
  };

  let insertThrew = '';
  try {
    if (typeof insert !== 'function') throw new Error(`repo.insert 不可用${checkpointRepoErr ? `（模块加载失败：${checkpointRepoErr.slice(0, 120)}）` : ''}`);
    insert(row1); insert(row2); insert(row3Orphan);
  } catch (e) { insertThrew = errMsg(e); }
  check('A⑧', 'insert×3 不抛错（2 合法 + 1 孤儿 message_id，message_id 无外键约束）',
    insertThrew === '', insertThrew.slice(0, 160));

  let listed: Array<Record<string, unknown>> = [];
  let listThrew = '';
  try {
    if (typeof listBySession !== 'function') throw new Error(`repo.listBySession 不可用${checkpointRepoErr ? `（模块加载失败：${checkpointRepoErr.slice(0, 120)}）` : ''}`);
    listed = listBySession('sess-tfc-1') as Array<Record<string, unknown>>;
  } catch (e) { listThrew = errMsg(e); }
  check('A⑨', 'listBySession 不抛错且返回 2 条（孤儿行被 JOIN 自然丢弃）',
    listThrew === '' && listed.length === 2,
    [listThrew ? `抛错：${listThrew.slice(0, 120)}` : '', `实际条数=${listed.length}`].filter(Boolean).join('; '));

  const sortedAsc = listed.length === 2
    && (listed[0]!.id as number) < (listed[1]!.id as number)
    && listed[0]!.tool_use_id === 'tu-1' && listed[1]!.tool_use_id === 'tu-2';
  check('A⑩', 'listBySession 按 id 升序', sortedAsc, `实际顺序=[${listed.map((r) => r.tool_use_id).join(',')}]`);

  // 字段回读一致（含 mrow = messages.rowid）。
  const mrow1 = (db.prepare("SELECT rowid AS mrow FROM messages WHERE id = 'msg-1'").get() as { mrow: number }).mrow;
  const mrow2 = (db.prepare("SELECT rowid AS mrow FROM messages WHERE id = 'msg-2'").get() as { mrow: number }).mrow;
  const r1 = listed[0] ?? {};
  const r2 = listed[1] ?? {};
  const roundtripOk = listed.length === 2
    && typeof r1.id === 'number' && typeof r2.id === 'number'
    && r1.session_id === 'sess-tfc-1' && r2.session_id === 'sess-tfc-1'
    && r1.message_id === 'msg-1' && r2.message_id === 'msg-2'
    && r1.path === 'D:/proj/a.txt' && r2.path === 'D:/proj/b.bin'
    && r1.tool_name === 'Write' && r2.tool_name === 'Write'
    && r1.tool_use_id === 'tu-1' && r2.tool_use_id === 'tu-2'
    && r1.input_json === row1.input_json && r2.input_json === row2.input_json
    && r1.input_truncated === 0 && r2.input_truncated === 1
    && r1.after_content === 'hello\nworld' && r2.after_content === null
    && r1.after_truncated === 0 && r2.after_truncated === 0
    && r1.binary === 0 && r2.binary === 1
    && r1.snapshot_state === 'disk' && r2.snapshot_state === 'failed'
    && r1.mrow === mrow1 && r2.mrow === mrow2;
  check('A⑪', '字段回读一致且含 mrow（= messages.rowid）', roundtripOk,
    `r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)} mrow1=${mrow1} mrow2=${mrow2}`);

  // c) countBySession：原始 COUNT 语义（孤儿行也是该会话落库行；JOIN 丢弃只影响 listBySession 视图，
  //    不删物理行）。孤儿行物理仍在 = 3。
  const countBySession = checkpointRepo?.countBySession as ((sessionId: string) => number) | undefined;
  let countVal = -1;
  let countThrew = '';
  try {
    if (typeof countBySession !== 'function') throw new Error(`repo.countBySession 不可用${checkpointRepoErr ? `（模块加载失败：${checkpointRepoErr.slice(0, 120)}）` : ''}`);
    countVal = countBySession('sess-tfc-1');
  } catch (e) { countThrew = errMsg(e); }
  let physicalCount = -1;
  try {
    physicalCount = (db.prepare("SELECT COUNT(*) AS n FROM turn_file_checkpoints WHERE session_id = 'sess-tfc-1'").get() as { n: number }).n;
  } catch { /* RED 阶段表不存在：降级为 -1，由本断言判 FAIL，不让脚本 crash */ }
  check('A⑫', 'countBySession 计数正确（=3，孤儿行计入；物理行同为 3，JOIN 丢弃≠删除）',
    countThrew === '' && countVal === 3 && physicalCount === 3,
    [countThrew ? `抛错：${countThrew.slice(0, 120)}` : '', `count=${countVal} 物理=${physicalCount}`].filter(Boolean).join('; '));

  // 会话隔离：无 checkpoint 的会话 → 0 / 空数组。
  let countOther = -1;
  let listOther: unknown[] = ['sentinel'];
  let isolateThrew = '';
  try {
    if (typeof countBySession !== 'function' || typeof listBySession !== 'function') throw new Error('repo 方法不可用');
    countOther = countBySession('sess-tfc-none');
    listOther = listBySession('sess-tfc-none');
  } catch (e) { isolateThrew = errMsg(e); }
  check('A⑬', '会话隔离：无 checkpoint 会话 count=0 / list=[]',
    isolateThrew === '' && countOther === 0 && Array.isArray(listOther) && listOther.length === 0,
    [isolateThrew ? `抛错：${isolateThrew.slice(0, 120)}` : '', `count=${countOther} list=${JSON.stringify(listOther)}`].filter(Boolean).join('; '));

  // d) 删除该 session → 级联清空（COUNT=0，含孤儿行）。
  db.prepare("DELETE FROM sessions WHERE id = 'sess-tfc-1'").run();
  let afterCascade = -1;
  try {
    afterCascade = (db.prepare('SELECT COUNT(*) AS n FROM turn_file_checkpoints WHERE session_id = ?').get('sess-tfc-1') as { n: number }).n;
  } catch { /* RED 阶段表不存在：降级为 -1，由本断言判 FAIL */ }
  check('A⑭', '删除 sessions 行 → turn_file_checkpoints 级联清空（COUNT=0）', afterCascade === 0, `剩余=${afterCascade}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 段B（P2）：shared/diff-core 提取（buildTwoFilePatch 机械搬移 + diffFull）
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段B shared/diff-core（P2） ===');

// diff-core：RED 阶段模块不存在 → require 失败降级为断言 FAIL，脚本不 crash（段A checkpointRepo 同款）。
let diffCore: Record<string, unknown> | null = null;
let diffCoreErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  diffCore = require(path.resolve(repoRoot, 'src', 'shared', 'diff-core.ts')) as Record<string, unknown>;
} catch (e) {
  diffCoreErr = errMsg(e);
}

interface DiffFullRet {
  patch: string;
  additions: number;
  deletions: number;
  truncated: boolean;
}
type DiffFullFn = (before: string, after: string, path: string) => DiffFullRet;

// a) diffFull 基本用例：'a\nb\n' → 'a\nc\n'（1 行改 1 行）：patch 含 '-b'/'+c' 行、±=1/1、不截断。
{
  const diffFull = diffCore?.diffFull as DiffFullFn | undefined;
  let r: DiffFullRet | null = null;
  let threw = '';
  try {
    if (typeof diffFull !== 'function') {
      throw new Error(`diff-core.diffFull 不可用${diffCoreErr ? `（模块加载失败：${diffCoreErr.slice(0, 120)}）` : ''}`);
    }
    r = diffFull('a\nb\n', 'a\nc\n', 'x.txt');
  } catch (e) {
    threw = errMsg(e);
  }
  const lines = r ? r.patch.split('\n') : [];
  check('B①', "diffFull('a\\nb\\n' → 'a\\nc\\n', 'x.txt')：patch 含 '-b' 与 '+c'、additions=1、deletions=1、truncated=false",
    threw === '' && r !== null && lines.includes('-b') && lines.includes('+c')
      && r.additions === 1 && r.deletions === 1 && r.truncated === false,
    threw !== ''
      ? `抛错：${threw.slice(0, 160)}`
      : r
        ? `patch=[${r.patch.split('\n').join(' ⏎ ')}] ±=${r.additions}/${r.deletions} truncated=${String(r.truncated)}`
        : 'r=null');
}

// b) 截断用例：before 1 行、after 追加 3000 行 → truncated=true、patch 行数 ≤ 2000+头部若干
//    （2 文件头 + hunk 头，实测 2003，断言 ≤2005）；N3 口径：± 按截断前完整 patch 统计（additions=3000、deletions=0）。
{
  const diffFull = diffCore?.diffFull as DiffFullFn | undefined;
  const before = 'base\n';
  const after = `base\n${Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n')}\n`;
  let r: DiffFullRet | null = null;
  let threw = '';
  try {
    if (typeof diffFull !== 'function') {
      throw new Error(`diff-core.diffFull 不可用${diffCoreErr ? `（模块加载失败：${diffCoreErr.slice(0, 120)}）` : ''}`);
    }
    r = diffFull(before, after, 'big.txt');
  } catch (e) {
    threw = errMsg(e);
  }
  const lineCount = r ? r.patch.split('\n').length : -1;
  check('B②', '3000 行变更：truncated=true、patch 行数 ≤ 2005（2000 正文 + 头部若干）、additions=3000/deletions=0（截断前全量，N3）',
    threw === '' && r !== null && r.truncated === true && lineCount > 0 && lineCount <= 2005
      && r.additions === 3000 && r.deletions === 0,
    threw !== ''
      ? `抛错：${threw.slice(0, 160)}`
      : `行数=${lineCount} ±=${r?.additions}/${r?.deletions} truncated=${String(r?.truncated)}`);
}

// c) 影响面自查（运行时佐证）：tool-diff.ts re-export 保链——synthesizeToolDiff 现有行为不变
//    （Edit 冒烟 ±=1/1、diff 含 '-x'/'+y'）；buildTwoFilePatch 与 diff-core 导出为同一引用；
//    导出清单不缩水（ToolDiffKind/ToolDiffResult/synthesizeToolDiff 签名不变）由 typecheck 兜底。
{
  let toolDiff: Record<string, unknown> | null = null;
  let toolDiffErr = '';
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    toolDiff = require(path.resolve(repoRoot, 'src', 'renderer', 'utils', 'tool-diff.ts')) as Record<string, unknown>;
  } catch (e) {
    toolDiffErr = errMsg(e);
  }
  const synth = toolDiff?.synthesizeToolDiff as
    | ((toolName: string, input: unknown) => { kind: string; diff: string; additions: number; deletions: number } | null)
    | undefined;
  let smoke: { kind: string; diff: string; additions: number; deletions: number } | null = null;
  let smokeThrew = '';
  try {
    if (typeof synth !== 'function') {
      throw new Error(`tool-diff.synthesizeToolDiff 不可用${toolDiffErr ? `（加载失败：${toolDiffErr.slice(0, 120)}）` : ''}`);
    }
    smoke = synth('Edit', { file_path: 'a.txt', old_string: 'x', new_string: 'y' });
  } catch (e) {
    smokeThrew = errMsg(e);
  }
  const smokeOk = smoke !== null && smoke.kind === 'edit'
    && smoke.diff.split('\n').includes('-x') && smoke.diff.split('\n').includes('+y')
    && smoke.additions === 1 && smoke.deletions === 1;
  const sameRef =
    typeof toolDiff?.buildTwoFilePatch === 'function'
    && (toolDiff?.buildTwoFilePatch as unknown) === (diffCore?.buildTwoFilePatch as unknown);
  check('B③', 'tool-diff.ts re-export 保链：synthesizeToolDiff 行为不变（Edit 冒烟 ±=1/1）；buildTwoFilePatch 与 diff-core 同一引用',
    smokeOk && sameRef,
    [smokeThrew ? `抛错：${smokeThrew.slice(0, 120)}` : '',
      smokeOk ? '' : `smoke=${JSON.stringify(smoke)}`,
      sameRef ? '' : 'buildTwoFilePatch 引用不一致或缺失'].filter(Boolean).join('; '));
}

// ═══════════════════════════════════════════════════════════════════════════
// 段C（P3）：主进程 checkpoint 记录器（turn-diff-checkpoint，sdk-backend 旁路）
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段C checkpoint 记录器（P3） ===');

// 记录器：RED 阶段模块不存在 → require 失败降级为断言 FAIL，脚本不 crash（段A checkpointRepo 同款）。
let recorder: Record<string, unknown> | null = null;
let recorderErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  recorder = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'turn-diff-checkpoint.ts')) as Record<string, unknown>;
} catch (e) {
  recorderErr = errMsg(e);
}

const noteCheckpointEvent = recorder?.noteCheckpointEvent as
  | ((sessionId: string, ev: unknown) => void)
  | undefined;
// round-001 R4 负向③用：会话删除收口清 Map 的导出。
const disposeSessionC = recorder?.disposeSession as ((sessionId: string) => void) | undefined;

// 段C 临时真实文件目录（置于 stubUserDataDir 下，随尾部统一清理）。
const segCDir = path.join(stubUserDataDir, 'seg-c-files');

/** 造测试会话行（messages.session_id 外键前提）。 */
function seedSessionC(id: string): void {
  db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段C-记录器测试', 'claude-sonnet-4-6')").run(id);
}

/** 模拟 persistCliEvent 的 tool_result 消息落库行（真实顺序：forwardEvent 旁路钩子先喂记录器、
 *  persistCliEvent 同步后落库；测试按同序先喂事件再补消息行，再等异步快照续体落定）。 */
function seedToolResultMessage(sessionId: string, messageId: string, toolUseId: string): void {
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, event_type, tool_use_id) VALUES (?, ?, 'tool', 'ok', 'tool_result', ?)",
  ).run(messageId, sessionId, toolUseId);
}

/** 固定让出窗（「无记录」类断言用：给足 fire-and-forget 快照续体完成的时间）。 */
async function settleC(ms = 400): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

/** 轮询等待谓词成立（快照落库是异步续体；3s 上限防挂死）。 */
async function waitForC(pred: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!pred() && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  if (!pred()) throw new Error(`等待超时：${label}`);
}

function checkpointCountC(sessionId: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM turn_file_checkpoints WHERE session_id = ?').get(sessionId) as { n: number }).n;
}

function checkpointRowsC(sessionId: string): Array<Record<string, unknown>> {
  return db.prepare('SELECT * FROM turn_file_checkpoints WHERE session_id = ? ORDER BY id ASC').all(sessionId) as Array<Record<string, unknown>>;
}

async function runSegmentC(): Promise<void> {
  fs.mkdirSync(segCDir, { recursive: true });
  if (typeof noteCheckpointEvent !== 'function') {
    const why = `noteCheckpointEvent 不可用${recorderErr ? `（模块加载失败：${recorderErr.slice(0, 160)}）` : ''}`;
    check('C①', 'tool_use(Write)+成功 result → 1 条 disk 快照', false, why);
    check('C②', 'is_error result → 无记录', false, why);
    check('C③', '读不存在路径 → failed 快照', false, why);
    check('C④', '同 toolUseId 重放 → 仍 1 条', false, why);
    check('C⑤', '>512KiB input → 截断标志+前缀', false, why);
    check('C⑥', '>2MiB 文本 → after_truncated=1 + 2MiB 前缀', false, why);
    check('C⑦', '含 \\0 文件 → binary=1、after_content=NULL', false, why);
    check('C⑧', '>2MiB 且 \\0 在 2MiB 后 → binary=1（判定先于截断）', false, why);
    check('C⑨', '同事件前序 part 抛错 → 后续 part 仍处理', false, why);
    check('C⑩', '非 diff 工具（Bash/Read）tool_use+成功 result → 不落库', false, why);
    check('C⑪', '双 session 并发（同 toolUseId）→ listBySession 互不串', false, why);
    check('C⑫', 'disposeSession 后同 session tool_result → 不落库', false, why);
    return;
  }
  const note = noteCheckpointEvent;

  // a) tool_use(Write)+成功 tool_result：流式路径（content_block_start → input_json_delta×2 →
  //    content_block_stop）+ 完整 message 事件同喂（对齐真实 forwardEvent 流），1 条 disk 快照。
  {
    const sid = 'sess-c-a';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-a.txt');
    const fileBody = 'hello checkpoint\n';
    fs.writeFileSync(filePath, fileBody, 'utf-8');
    const toolUseId = 'tu-c-a';
    const inputJson = JSON.stringify({ file_path: filePath, content: fileBody });
    note(sid, { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolUseId, name: 'Write', input: {} }, delta: { type: 'text_delta' } } });
    note(sid, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson.slice(0, 10) } } });
    note(sid, { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: inputJson.slice(10) } } });
    note(sid, { type: 'stream_event', event: { type: 'content_block_stop', index: 0, delta: { type: 'text_delta' } } });
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: fileBody } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-a', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C① 快照落库');
    const rows = checkpointRowsC(sid);
    const r = rows[0] ?? {};
    const ok =
      rows.length === 1
      && r.snapshot_state === 'disk'
      && r.after_content === fileBody
      && r.tool_name === 'Write'
      && r.path === filePath
      && r.tool_use_id === toolUseId
      && r.message_id === 'msg-c-a'
      && r.session_id === sid
      && r.input_truncated === 0 && r.after_truncated === 0 && r.binary === 0;
    check('C①', 'tool_use(Write)+成功 result：1 条 disk 快照，after_content=文件全文，tool_name/path/tool_use_id 正确',
      ok, `rows=${JSON.stringify(rows)}`);
  }

  // b) is_error result → 丢弃 pending、不落库。
  {
    const sid = 'sess-c-b';
    seedSessionC(sid);
    const toolUseId = 'tu-c-b';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: path.join(segCDir, 'c-b.txt'), content: 'b' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'Error: nope', is_error: true }] });
    await settleC();
    check('C②', 'is_error result：不落库（count=0）', checkpointCountC(sid) === 0, `count=${checkpointCountC(sid)}`);
  }

  // c) 读不存在路径 → snapshot_state='failed'、after_content=NULL。
  {
    const sid = 'sess-c-c';
    seedSessionC(sid);
    const toolUseId = 'tu-c-c';
    const missingPath = path.join(segCDir, 'definitely-missing-c.txt');
    try { fs.rmSync(missingPath, { force: true }); } catch { /* 必不存在 */ }
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: toolUseId, input: { file_path: missingPath, old_string: 'a', new_string: 'b' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-c', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C③ failed 快照落库');
    const r = checkpointRowsC(sid)[0] ?? {};
    check('C③', '读不存在路径：snapshot_state=failed、after_content=NULL',
      r.snapshot_state === 'failed' && r.after_content === null, `row=${JSON.stringify(r)}`);
  }

  // d) 同 toolUseId 重放第二次成功 result（resume 语义：tool_use+result 再喂一遍）→ 仍 1 条。
  {
    const sid = 'sess-c-d';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-d.txt');
    fs.writeFileSync(filePath, 'd-body\n', 'utf-8');
    const toolUseId = 'tu-c-d';
    const useEvent = { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'd-body\n' } }] };
    const resultEvent = { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] };
    note(sid, useEvent);
    note(sid, resultEvent);
    seedToolResultMessage(sid, 'msg-c-d', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C④ 首次落库');
    note(sid, useEvent);
    note(sid, resultEvent);
    await settleC();
    check('C④', '同 toolUseId 重放第二次成功 result：仍 1 条（existsByToolUseId 幂等）',
      checkpointCountC(sid) === 1, `count=${checkpointCountC(sid)}`);
  }

  // e) >512KiB input：input_truncated=1、input_json=截断前缀（512KiB）。
  {
    const sid = 'sess-c-e';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-e.txt');
    fs.writeFileSync(filePath, 'e-body', 'utf-8');
    const toolUseId = 'tu-c-e';
    const fullJson = JSON.stringify({ file_path: filePath, content: 'x'.repeat(600 * 1024) });
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'x'.repeat(600 * 1024) } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-e', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C⑤ 截断快照落库');
    const r = checkpointRowsC(sid)[0] ?? {};
    const expectedPrefix = fullJson.slice(0, 512 * 1024);
    const inputJsonStr = typeof r.input_json === 'string' ? r.input_json : '';
    check('C⑤', '>512KiB input：input_truncated=1、input_json=截断前缀（512KiB）',
      r.input_truncated === 1 && inputJsonStr === expectedPrefix && inputJsonStr.length === 512 * 1024,
      `input_truncated=${String(r.input_truncated)} len=${inputJsonStr.length}`);
  }

  // f) >2MiB 纯文本文件（round-002 F4 覆盖钉）：after_truncated=1、after_content=2MiB 截断前缀。
  {
    const sid = 'sess-c-f';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-f.txt');
    const bigBody = 'x'.repeat(2 * 1024 * 1024 + 10); // 2MiB+10 字符，纯文本
    fs.writeFileSync(filePath, bigBody, 'utf-8');
    const toolUseId = 'tu-c-f';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'big' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-f', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C⑥ 截断快照落库');
    const r = checkpointRowsC(sid)[0] ?? {};
    const ac = typeof r.after_content === 'string' ? r.after_content : '';
    check('C⑥', '>2MiB 文本文件：after_truncated=1、after_content=2MiB 截断前缀（长度 2*1024*1024）',
      r.after_truncated === 1 && ac.length === 2 * 1024 * 1024 && ac === bigBody.slice(0, 2 * 1024 * 1024),
      `after_truncated=${String(r.after_truncated)} len=${ac.length}`);
  }

  // g) 含 \0 文件（round-002 F4 覆盖钉）：binary=1、after_content=NULL。
  {
    const sid = 'sess-c-g';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-g.bin');
    fs.writeFileSync(filePath, 'a\0b', 'utf-8');
    const toolUseId = 'tu-c-g';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'bin' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-g', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C⑦ binary 快照落库');
    const r = checkpointRowsC(sid)[0] ?? {};
    check('C⑦', '含 \\0 文件：binary=1、after_content=NULL',
      r.binary === 1 && r.after_content === null,
      `binary=${String(r.binary)} after_content=${JSON.stringify(r.after_content)}`);
  }

  // h) >2MiB 且 \0 位于 2MiB 之后（round-002 M-A3 次序钉）：binary 判定必须先于截断——
  //    旧实现先截到 2MiB 前缀再查 \0，\0 在前缀之外 → 以 mojibake 文本落库（binary=0）。
  {
    const sid = 'sess-c-h';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-h.bin');
    const body = `${'x'.repeat(2 * 1024 * 1024 + 9)}\0`; // 共 2MiB+10 字符，\0 在末尾（2MiB 之后）
    fs.writeFileSync(filePath, body, 'utf-8');
    const toolUseId = 'tu-c-h';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'bin-big' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-h', toolUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'C⑧ 快照落库');
    const r = checkpointRowsC(sid)[0] ?? {};
    check('C⑧', '>2MiB 且 \\0 位于 2MiB 之后：binary=1（binary 判定先于截断）、after_content=NULL',
      r.binary === 1 && r.after_content === null,
      `binary=${String(r.binary)} after_truncated=${String(r.after_truncated)} after_content=${r.after_content === null ? 'null' : `非null(len=${String(r.after_content).length})`}`);
  }

  // i) 同 message 事件内前序 part 抛错不中止后续 part（round-002 M-A5 钉）：坏 tool_use
  //    （name=123 非字符串 → upsertPending 内 .trim() 抛 TypeError）之后，同事件携带的
  //    合法 tool_result 仍被消费落库（此前无逐 part try，异常上抛外层吞掉 → result 丢失）。
  {
    const sid = 'sess-c-i';
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-i.txt');
    fs.writeFileSync(filePath, 'i-body\n', 'utf-8');
    const toolUseId = 'tu-c-i';
    // 先用独立正常事件登记 pending（tool_result 消费的前提）。
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'i-body\n' } }] });
    // 同一 message 事件：前序坏 part（抛错）+ 后序合法 tool_result。
    note(sid, { type: 'message', role: 'user', content: [
      { type: 'tool_use', name: 123, id: 'tu-c-i-bad', input: { file_path: filePath, content: 'x' } },
      { type: 'tool_result', tool_use_id: toolUseId, content: 'ok' },
    ] });
    seedToolResultMessage(sid, 'msg-c-i', toolUseId);
    try { await waitForC(() => checkpointCountC(sid) === 1, 'C⑨ 快照落库'); } catch { /* RED：未落库 */ }
    const rows = checkpointRowsC(sid);
    const r = rows[0] ?? {};
    check('C⑨', '同事件前序 part 抛错（name 非字符串）只跳过该 part：后续 tool_result 仍消费落库',
      rows.length === 1 && r.tool_use_id === toolUseId && r.snapshot_state === 'disk',
      `rows=${JSON.stringify(rows).slice(0, 240)}`);
  }

  // j) 非 diff 工具（round-001 R4 负向①）：TOOL_DIFF_TOOL_NAMES 之外的工具（Bash/Read）的
  //    tool_use+成功 result → upsertPending 工具名白名单不暂存 → 无快照续体、不落库。
  //    消息行照常落库 + Read 给真实存在的文件：若白名单失效本断言变红（排除「因消息行/文件
  //    缺失而不落」的假阴性）。
  {
    const sid = 'sess-c-j';
    seedSessionC(sid);
    const readFile = path.join(segCDir, 'c-j.txt');
    fs.writeFileSync(readFile, 'j-body\n', 'utf-8');
    const bashUseId = 'tu-c-j-bash';
    const readUseId = 'tu-c-j-read';
    note(sid, { type: 'message', role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', id: bashUseId, input: { command: 'echo j' } },
      { type: 'tool_use', name: 'Read', id: readUseId, input: { file_path: readFile } },
    ] });
    note(sid, { type: 'message', role: 'user', content: [
      { type: 'tool_result', tool_use_id: bashUseId, content: 'j' },
      { type: 'tool_result', tool_use_id: readUseId, content: 'ok' },
    ] });
    seedToolResultMessage(sid, 'msg-c-j-bash', bashUseId);
    seedToolResultMessage(sid, 'msg-c-j-read', readUseId);
    await settleC();
    const listJ = (checkpointRepo?.listBySession as ((id: string) => unknown[]) | undefined)?.(sid);
    check('C⑩', '非 diff 工具（Bash/Read）tool_use+成功 result：消息行在仍不落库（count=0 / listBySession=[]）',
      checkpointCountC(sid) === 0 && Array.isArray(listJ) && listJ.length === 0,
      `count=${checkpointCountC(sid)} list=${JSON.stringify(listJ)}`);
  }

  // k) 双 session 并发（round-001 R4 负向②）：两 session 故意用同一 toolUseId 各写各文件——
  //    session→记录器 Map（pendings/streamBlocks）按 sessionId 隔离；隔离失效时同 key 互踩
  //    （一方丢 pending、一方错挂对方 path）。listBySession 各自恰好 1 条且 session_id/path 各归各。
  {
    const sid1 = 'sess-c-k1';
    const sid2 = 'sess-c-k2';
    seedSessionC(sid1);
    seedSessionC(sid2);
    const sharedUseId = 'tu-c-k-shared';
    const file1 = path.join(segCDir, 'c-k-1.txt');
    const file2 = path.join(segCDir, 'c-k-2.txt');
    fs.writeFileSync(file1, 'k-body-1\n', 'utf-8');
    fs.writeFileSync(file2, 'k-body-2\n', 'utf-8');
    note(sid1, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: sharedUseId, input: { file_path: file1, content: 'k-body-1\n' } }] });
    note(sid2, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: sharedUseId, input: { file_path: file2, content: 'k-body-2\n' } }] });
    note(sid1, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: sharedUseId, content: 'ok' }] });
    note(sid2, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: sharedUseId, content: 'ok' }] });
    seedToolResultMessage(sid1, 'msg-c-k-1', sharedUseId);
    seedToolResultMessage(sid2, 'msg-c-k-2', sharedUseId);
    await waitForC(() => checkpointCountC(sid1) === 1 && checkpointCountC(sid2) === 1, 'C⑪ 双 session 落库');
    const listBySessionK = checkpointRepo?.listBySession as
      | ((id: string) => Array<Record<string, unknown>>)
      | undefined;
    const list1 = listBySessionK?.(sid1) ?? [];
    const list2 = listBySessionK?.(sid2) ?? [];
    const r1 = list1[0] ?? {};
    const r2 = list2[0] ?? {};
    check('C⑪', '双 session 并发（同 toolUseId）：各落 1 条、listBySession 互不串（session_id/path 各归各）',
      list1.length === 1 && list2.length === 1
        && r1.session_id === sid1 && r1.path === file1 && r1.tool_use_id === sharedUseId
        && r2.session_id === sid2 && r2.path === file2 && r2.tool_use_id === sharedUseId,
      `list1=${JSON.stringify(list1).slice(0, 200)} list2=${JSON.stringify(list2).slice(0, 200)}`);
  }

  // l) disposeSession 清 Map（round-001 R4 负向③）：tool_use 暂存后 disposeSession（会话删除
  //    markSessionDeleted 收口），同 session 再来成功 tool_result → 无 pending、不落库。
  //    消息行照常落库：排除「因消息行缺失而不落」的假阴性（DB 行清理由 sessions ON DELETE
  //    CASCADE 承担，不在本断言范围）。
  {
    const sid = 'sess-c-l';
    if (typeof disposeSessionC !== 'function') {
      throw new Error(`disposeSession 不可用${recorderErr ? `（模块加载失败：${recorderErr.slice(0, 120)}）` : ''}`);
    }
    seedSessionC(sid);
    const filePath = path.join(segCDir, 'c-l.txt');
    fs.writeFileSync(filePath, 'l-body\n', 'utf-8');
    const toolUseId = 'tu-c-l';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Write', id: toolUseId, input: { file_path: filePath, content: 'l-body\n' } }] });
    disposeSessionC(sid);
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-c-l', toolUseId);
    await settleC();
    check('C⑫', 'disposeSession 后同 session tool_result：Map 已清、消息行在仍不落库（count=0）',
      checkpointCountC(sid) === 0, `count=${checkpointCountC(sid)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 段D（P4）：主进程聚合 turn-diff——aggregateFromCheckpoints / computeFileDiff
// 纯函数直测（内存 rows，不依赖 DB）+ DB 侧 deriveTurnRanges / getPatch / listSummaries。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段D 聚合（P4） ===');

// turn-diff：RED 阶段模块不存在 → require 失败降级为断言 FAIL，脚本不 crash（段A 同款）。
let turnDiffMod: Record<string, unknown> | null = null;
let turnDiffErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  turnDiffMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'turn-diff.ts')) as Record<string, unknown>;
} catch (e) {
  turnDiffErr = errMsg(e);
}

interface AggItem { path: string; additions: number; deletions: number; writeCount: number; mode: string }
interface AggSummary { turnStartMessageId: string; items: AggItem[] }
interface FileDiffResult { mode: string; additions: number; deletions: number; writeCount: number; patch: string; truncated: boolean }
type AggregateFn = (rows: unknown[], ranges: unknown[]) => AggSummary[];
type ComputeFn = (rows: unknown[], startRow: number, endRow: number | null, path: string) => FileDiffResult;
type RangeShape = { turnStartMessageId: string; startRow: number; endRow: number | null };
type DeriveFn = (sessionId: string) => RangeShape[];
type GetPatchFn = (sessionId: string, turnStartMessageId: string, endMessageId: string | null, path: string) =>
  { mode: string; patch: string; truncated: boolean };
type ListSummariesFn = (sessionId: string) => AggSummary[];

const aggregateFromCheckpoints = turnDiffMod?.aggregateFromCheckpoints as AggregateFn | undefined;
const computeFileDiff = turnDiffMod?.computeFileDiff as ComputeFn | undefined;

/** 构造内存 CheckpointRow（形状对齐 repo.listBySession 返回行；传入数组序 = id 升序语义）。 */
function mkRow(seq: number, over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: seq, session_id: 'sess-d', message_id: `m${seq}`, path: 'p', tool_name: 'Write',
    tool_use_id: `tu-d-${seq}`, input_json: null, input_truncated: 0,
    after_content: null, after_truncated: 0, binary: 0, snapshot_state: 'disk',
    mrow: seq,
    ...over,
  };
}

function runSegmentD(): void {
  try {
    if (
      typeof aggregateFromCheckpoints !== 'function' || typeof computeFileDiff !== 'function'
      || typeof turnDiffMod?.deriveTurnRanges !== 'function'
      || typeof turnDiffMod?.getPatch !== 'function'
      || typeof turnDiffMod?.listSummaries !== 'function'
    ) {
      const why = `turn-diff 导出不可用${turnDiffErr ? `（模块加载失败：${turnDiffErr.slice(0, 160)}）` : ''}`;
      check('D①', '同轮同文件 3 次 disk 写：1 item / full / writeCount=3 / ±=首 before vs 末 after', false, why);
      check('D①p', 'computeFileDiff patch 单份（v1/v2 中间态特征行不出现）', false, why);
      check('D②', '跨轮：轮2 before 隐含轮1 末内容（± 与 patch 只含轮内变更）', false, why);
      check('D③', '首改合成：Write 整文件例', false, why);
      check('D③e', '首改合成：Edit old→new 例', false, why);
      check('D③m', '首改合成：MultiEdit edits[] 逐条例', false, why);
      check('D③x', '首改降级：input 缺失 / input_truncated=1 → unavailable', false, why);
      check('D③t', '首改合成截断（N3）：>MAX_DIFF_LINES → truncated=true、± 为截断前全量', false, why);
      check('D④', 'binary=1 / failed → intent（意图兜底）、±>0', false, why);
      check('D④b', 'binary 且意图缺失（input NULL/截断）→ unavailable、±=0', false, why);
      check('D④c', '区间全 binary + 区间前可用 before → intent（不产 full）', false, why);
      check('D-ui', 'TurnFileChangesCard intent 徽标 + 三态 title', false, why);
      check('D-ui2', 'TurnDiffDialog intent 徽标 + 新空态文案', false, why);
      check('D⑤', 'endRow=null → 覆盖到末尾', false, why);
      check('D⑥', '空区间轮不出现在结果', false, why);
      check('D⑦', 'deriveTurnRanges：主流程 user 分界 / 末回合 endRow=null / 子 agent user 不分界', false, why);
      check('D⑧', 'getPatch：full 重算 / turnStart 查不到 unavailable / endMessageId 查不到上界+∞ / first-change', false, why);
      check('D⑨', 'listSummaries：主进程推导轮区间的多轮摘要（N2）', false, why);
      check('D-ro①', '同轮乱序：after/before 按 mrow（消息序）最大者选取', false, why);
      check('D-ro②', '跨轮乱序：before 取 mrow 较大前轮行', false, why);
      return;
    }
    const aggregate = aggregateFromCheckpoints as AggregateFn;
    const fileDiff = computeFileDiff as ComputeFn;
    const diffFullFn = diffCore?.diffFull as DiffFullFn | undefined;

    // a) 同轮同文件 3 次 disk 写：区间前 before 行（mrow=10）+ 区间 [100,200) 内 3 行
    //    （after 链 v1→v2-mid→v3）。期望：1 summary / 1 item / full / writeCount=3 /
    //    ±=diffFull(v0, v3)（首 before vs 末 after 单份重算）。
    {
      const rows = [
        mkRow(1, { mrow: 10, path: 'A', after_content: 'alpha\n' }),
        mkRow(2, { mrow: 101, path: 'A', after_content: 'alpha\nv1\n' }),
        mkRow(3, { mrow: 102, path: 'A', after_content: 'alpha\nv2-mid\n' }),
        mkRow(4, { mrow: 103, path: 'A', after_content: 'alpha\nbeta\n' }),
      ];
      const out = aggregate(rows, [{ turnStartMessageId: 'turnA', startRow: 100, endRow: 200 }]);
      const item = out[0]?.items[0];
      const exp = diffFullFn ? diffFullFn('alpha\n', 'alpha\nbeta\n', 'A') : null;
      const okAgg = out.length === 1 && out[0]!.turnStartMessageId === 'turnA'
        && out[0]!.items.length === 1
        && item?.mode === 'full' && item?.writeCount === 3
        && item?.additions === (exp?.additions ?? -1) && item?.deletions === (exp?.deletions ?? -1);
      check('D①', '同轮同文件 3 次 disk 写：1 item / mode=full / writeCount=3 / ±=首 before vs 末 after（单份重算）',
        okAgg, `out=${JSON.stringify(out)} exp=${JSON.stringify(exp)}`);

      const fr = fileDiff(rows, 100, 200, 'A');
      check('D①p', 'computeFileDiff patch 为「首 before vs 末 after」单份 diff（v1/v2-mid 中间态特征行不出现）',
        fr.mode === 'full' && fr.writeCount === 3 && fr.truncated === false
          && fr.patch.split('\n').includes('+beta')
          && !fr.patch.includes('v2-mid') && !fr.patch.includes('v1'),
        `patch=[${fr.patch.split('\n').join(' ⏎ ')}]`);
    }

    // b) 跨轮：轮1 [A v0→v1]、轮2 [A v1→v2]。轮2 的 before 必须取轮1 末内容（± 与 patch 只含轮内变更）。
    {
      const rows = [
        mkRow(1, { mrow: 5, path: 'B', after_content: 'alpha\n' }),
        mkRow(2, { mrow: 11, path: 'B', after_content: 'alpha\nv1\n' }),
        mkRow(3, { mrow: 21, path: 'B', after_content: 'alpha\nbeta\n' }),
      ];
      const out = aggregate(rows, [
        { turnStartMessageId: 't1', startRow: 10, endRow: 20 },
        { turnStartMessageId: 't2', startRow: 20, endRow: null },
      ]);
      const i1 = out.find((s) => s.turnStartMessageId === 't1')?.items[0];
      const i2 = out.find((s) => s.turnStartMessageId === 't2')?.items[0];
      check('D②', '跨轮：轮1 A v0→v1（+1/0），轮2 before 隐含轮1 末内容（+1/-1）',
        out.length === 2
          && i1?.mode === 'full' && i1?.additions === 1 && i1?.deletions === 0 && i1?.writeCount === 1
          && i2?.mode === 'full' && i2?.additions === 1 && i2?.deletions === 1 && i2?.writeCount === 1,
        `out=${JSON.stringify(out)}`);
      const fr2 = fileDiff(rows, 20, null, 'B');
      check('D②p', '轮2 patch 只含轮1末→轮2末 变更行（-v1/+beta）',
        fr2.mode === 'full' && fr2.patch.split('\n').includes('-v1') && fr2.patch.split('\n').includes('+beta'),
        `patch=[${fr2.patch.split('\n').join(' ⏎ ')}]`);
    }

    // c) 首改（区间前无该 path 记录）→ first-change 且 patch 含 input 合成 hunk。
    {
      // Write 例：content 整文件 vs 空串。
      const writeRows = [
        mkRow(1, {
          mrow: 101, path: 'C', tool_name: 'Write', after_content: 'alpha\nbeta\n',
          input_json: JSON.stringify({ file_path: 'C', content: 'alpha\nbeta\n' }),
        }),
      ];
      const outW = aggregate(writeRows, [{ turnStartMessageId: 'tw', startRow: 100, endRow: 200 }]);
      const iW = outW[0]?.items[0];
      const frW = fileDiff(writeRows, 100, 200, 'C');
      check('D③', '首改 Write：mode=first-change、±=2/0、patch 含整文件合成 hunk（+alpha/+beta）',
        outW.length === 1 && iW?.mode === 'first-change' && iW?.additions === 2 && iW?.deletions === 0 && iW?.writeCount === 1
          && frW.mode === 'first-change' && frW.truncated === false
          && frW.patch.split('\n').includes('+alpha') && frW.patch.split('\n').includes('+beta'),
        `agg=${JSON.stringify(outW)} patch=[${frW.patch.split('\n').join(' ⏎ ')}]`);

      // Edit 例：old_string→new_string 片段 hunk。
      const editRows = [
        mkRow(1, {
          mrow: 101, path: 'D', tool_name: 'Edit', after_content: 'file-with-y\n',
          input_json: JSON.stringify({ file_path: 'D', old_string: 'x', new_string: 'y' }),
        }),
      ];
      const frE = fileDiff(editRows, 100, 200, 'D');
      check('D③e', '首改 Edit：patch 含 -x/+y 合成 hunk、±=1/1、mode=first-change',
        frE.mode === 'first-change' && frE.additions === 1 && frE.deletions === 1
          && frE.patch.split('\n').includes('-x') && frE.patch.split('\n').includes('+y'),
        `fr=${JSON.stringify(frE)}`);

      // MultiEdit 例：edits[] 逐条片段顺序拼接，± 累计。
      const multiRows = [
        mkRow(1, {
          mrow: 101, path: 'M', tool_name: 'MultiEdit', after_content: 'n1n2',
          input_json: JSON.stringify({
            file_path: 'M',
            edits: [{ old_string: 'm1', new_string: 'n1' }, { old_string: 'm2', new_string: 'n2' }],
          }),
        }),
      ];
      const frM = fileDiff(multiRows, 100, 200, 'M');
      check('D③m', '首改 MultiEdit：两片段 hunk 顺序拼接、±=2/2、patch 含 -m1/+n1/-m2/+n2',
        frM.mode === 'first-change' && frM.additions === 2 && frM.deletions === 2
          && frM.patch.split('\n').includes('-m1') && frM.patch.split('\n').includes('+n1')
          && frM.patch.split('\n').includes('-m2') && frM.patch.split('\n').includes('+n2'),
        `fr=${JSON.stringify(frM)}`);

      // 降级：input_json 缺失 / input_truncated=1 → unavailable（无可用 input）。
      const degRows = [
        mkRow(1, { mrow: 101, path: 'X', after_content: 'x', input_json: null }),
        mkRow(2, { mrow: 102, path: 'Y', after_content: 'y', input_json: '{"file_path":"Y","content":"y"}', input_truncated: 1 }),
      ];
      const frX = fileDiff(degRows, 100, 200, 'X');
      const frY = fileDiff(degRows, 100, 200, 'Y');
      check('D③x', '首改降级：input_json 缺失 / input_truncated=1 → mode=unavailable、±=0',
        frX.mode === 'unavailable' && frX.additions === 0 && frX.deletions === 0
          && frY.mode === 'unavailable' && frY.additions === 0 && frY.deletions === 0,
        `X=${JSON.stringify(frX)} Y=${JSON.stringify(frY)}`);

      // N3（合成侧）：单片段 >MAX_DIFF_LINES（2500 行 Write）→ truncated=true、± 仍为截断前全量 2500/0。
      const bigContent = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`).join('\n');
      const bigRows = [
        mkRow(1, {
          mrow: 101, path: 'Z', tool_name: 'Write', after_content: `${bigContent}\n`,
          input_json: JSON.stringify({ file_path: 'Z', content: `${bigContent}\n` }),
        }),
      ];
      const frZ = fileDiff(bigRows, 100, 200, 'Z');
      const zBodyLines = frZ.patch.split('\n').filter((l) => l !== '' && !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@')).length;
      check('D③t', '首改合成截断（N3）：2500 行 Write → truncated=true、additions=2500（截断前全量）、正文 ≤2000 行',
        frZ.mode === 'first-change' && frZ.truncated === true && frZ.additions === 2500 && frZ.deletions === 0
          && zBodyLines > 0 && zBodyLines <= 2000,
        `truncated=${String(frZ.truncated)} ±=${frZ.additions}/${frZ.deletions} 正文行=${zBodyLines}`);
    }

    // d) p5 重钉（2026-10-27 五问题 §6.4）：binary=1 / snapshot_state='failed' 行 → 快照缺失时按
    //    编辑意图合成兜底 mode=intent（±>0、patch 含 hunk、truncated=false）；区间前有可用 before
    //    也不再产 full（以意图为准；与过程工具行「查看改动对比」同源 input_json + 同一合成器）。
    {
      const rows = [
        mkRow(1, { mrow: 50, path: 'E', after_content: 'E-before\n' }),
        mkRow(2, { mrow: 101, path: 'E', binary: 1, after_content: null, input_json: '{"file_path":"E","content":"l1\\nl2\\nl3\\n"}' }),
        mkRow(3, { mrow: 102, path: 'F', snapshot_state: 'failed', after_content: null, tool_name: 'Edit', input_json: '{"file_path":"F","old_string":"o","new_string":"n"}' }),
      ];
      const out = aggregate(rows, [{ turnStartMessageId: 'tb', startRow: 100, endRow: 200 }]);
      const e = out[0]?.items.find((i) => i.path === 'E');
      const f = out[0]?.items.find((i) => i.path === 'F');
      const frE = fileDiff(rows, 100, 200, 'E');
      check('D④', 'binary=1 / failed 行：mode=intent（意图兜底）、±>0、patch 含 hunk、truncated=false；before 存在不产 full',
        out.length === 1
          && e?.mode === 'intent' && (e?.additions ?? 0) > 0 && e?.writeCount === 1
          && f?.mode === 'intent' && (f?.additions ?? 0) > 0
          && frE.mode === 'intent' && frE.truncated === false
          && frE.patch.split('\n').some((l) => l.startsWith('@@')) && frE.patch.split('\n').includes('+l1'),
        `out=${JSON.stringify(out)} fr=${JSON.stringify(frE)}`);
    }

    // d2) p5 新增：快照缺失且意图也不可用（input_json NULL / input_truncated=1）→ 仍 unavailable、±=0
    //    （既有 D③x 降级语义在快照缺失场景的延伸钉，防止兜底掩盖入参不可用）。
    {
      const rows = [
        mkRow(1, { mrow: 101, path: 'X', binary: 1, after_content: null, input_json: null }),
        mkRow(2, { mrow: 102, path: 'Y', binary: 1, after_content: null, input_json: '{"file_path":"Y","content":"y"}', input_truncated: 1 }),
      ];
      const out = aggregate(rows, [{ turnStartMessageId: 'tb2', startRow: 100, endRow: 200 }]);
      const x = out[0]?.items.find((i) => i.path === 'X');
      const y = out[0]?.items.find((i) => i.path === 'Y');
      check('D④b', 'binary 且意图缺失（input NULL / 截断）→ mode=unavailable、±=0（既有语义保留）',
        x?.mode === 'unavailable' && x?.additions === 0 && x?.deletions === 0
          && y?.mode === 'unavailable' && y?.additions === 0 && y?.deletions === 0,
        `out=${JSON.stringify(out)}`);
    }

    // d3) p5 新增：区间内全部行 binary（after 全缺）+ 区间前可用 before 存在 → 仍 mode=intent
    //    （不再产 full——中途才变加密的文件以编辑意图为准）。
    {
      const rows = [
        mkRow(1, { mrow: 90, path: 'B', after_content: 'B-before\n' }),
        mkRow(2, { mrow: 101, path: 'B', binary: 1, after_content: null, tool_name: 'Edit', input_json: '{"file_path":"B","old_string":"a\\n","new_string":"b\\n"}' }),
      ];
      const fr = fileDiff(rows, 100, 200, 'B');
      check('D④c', '区间内全 binary + 区间前可用 before → mode=intent（不再产 full）',
        fr.mode === 'intent' && fr.additions === 1 && fr.deletions === 1,
        `fr=${JSON.stringify(fr)}`);
    }

    // d4) p5 静态 UI 钉：卡片徽标/标题三态 + 弹窗徽标/空态文案（mode='intent' 的渲染层呈现）。
    {
      const cardSrc = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'components', 'chat', 'TurnFileChangesCard.vue'), 'utf8');
      const dlgSrc = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'components', 'chat', 'TurnDiffDialog.vue'), 'utf8');
      check('D-ui', 'TurnFileChangesCard：intent 徽标「意图 diff」+ title 三态（含「快照缺失（二进制）」）',
        cardSrc.includes('>意图 diff</span>')
          && cardSrc.includes("item.mode === 'intent'")
          && cardSrc.includes('快照缺失（二进制）'),
        'card 缺 intent 徽标或三态 title');
      check('D-ui2', 'TurnDiffDialog：「编辑意图（快照缺失）」徽标 + 空态文案更新（含「且编辑意图不可用」）',
        dlgSrc.includes('编辑意图（快照缺失）')
          && dlgSrc.includes("mode === 'intent'")
          && dlgSrc.includes('且编辑意图不可用'),
        'dialog 缺 intent 徽标或新空态文案');
    }

    // e) endRow=null → 覆盖到末尾（区间内两行都计入，after=末条）。
    {
      const rows = [
        mkRow(1, { mrow: 1, path: 'G', after_content: 'G0\n' }),
        mkRow(2, { mrow: 21, path: 'G', after_content: 'G1\n' }),
        mkRow(3, { mrow: 99, path: 'G', after_content: 'G2\n' }),
      ];
      const out = aggregate(rows, [{ turnStartMessageId: 'tg', startRow: 20, endRow: null }]);
      const fr = fileDiff(rows, 20, null, 'G');
      check('D⑤', 'endRow=null 覆盖到末尾：writeCount=2、after=末条（patch -G0/+G2，G1 不出现）',
        out.length === 1 && out[0]!.items.length === 1
          && out[0]!.items[0]!.writeCount === 2 && out[0]!.items[0]!.mode === 'full'
          && out[0]!.items[0]!.additions === 1 && out[0]!.items[0]!.deletions === 1
          && fr.patch.split('\n').includes('-G0') && fr.patch.split('\n').includes('+G2') && !fr.patch.includes('G1'),
        `out=${JSON.stringify(out)} patch=[${fr.patch.split('\n').join(' ⏎ ')}]`);
    }

    // f) 空区间（无行落入）→ 该轮不出现在结果。
    {
      const rows = [mkRow(1, { mrow: 10, path: 'H', after_content: 'h\n' })];
      const out = aggregate(rows, [
        { turnStartMessageId: 'tEmpty', startRow: 500, endRow: 600 },
        { turnStartMessageId: 'tHit', startRow: 1, endRow: 20 },
      ]);
      check('D⑥', '空区间（无行落入）不出现在结果；命中区间正常产出',
        out.length === 1 && out[0]!.turnStartMessageId === 'tHit'
          && !out.some((s) => s.turnStartMessageId === 'tEmpty'),
        `out=${JSON.stringify(out)}`);
    }

    // g) deriveTurnRanges（真实临时库）：主流程 user 消息分界、子 agent user 不分界、末回合 endRow=null。
    {
      const sid = 'sess-d-ranges';
      db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段D-轮区间测试', 'claude-sonnet-4-6')").run(sid);
      const insMsg = db.prepare(
        'INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, ?, ?, ?)',
      );
      insMsg.run('d-u1', sid, 'user', '第一轮', null);
      insMsg.run('d-a1', sid, 'assistant', '回复1', null);
      insMsg.run('d-usub', sid, 'user', '子agent轮', 'sa-1');
      insMsg.run('d-a2', sid, 'assistant', '子agent回复', 'sa-1');
      insMsg.run('d-u2', sid, 'user', '第二轮', null);
      insMsg.run('d-a3', sid, 'assistant', '回复2', null);
      const rowOf = (id: string): number =>
        (db.prepare('SELECT rowid AS r FROM messages WHERE id = ?').get(id) as { r: number }).r;
      const r1 = rowOf('d-u1');
      const r2 = rowOf('d-u2');
      const derive = turnDiffMod!.deriveTurnRanges as DeriveFn;
      const ranges = derive(sid);
      check('D⑦', 'deriveTurnRanges：主流程 user 分界（子 agent user 不分界）、末回合 endRow=null',
        ranges.length === 2
          && ranges[0]!.turnStartMessageId === 'd-u1' && ranges[0]!.startRow === r1 && ranges[0]!.endRow === r2
          && ranges[1]!.turnStartMessageId === 'd-u2' && ranges[1]!.startRow === r2 && ranges[1]!.endRow === null,
        `ranges=${JSON.stringify(ranges)} r1=${r1} r2=${r2}`);
    }

    // h) getPatch（真实临时库）：单文件重算 + 边界（turnStart 查不到 / endMessageId 查不到）+ 首改。
    {
      const sid = 'sess-d-patch';
      db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段D-getPatch测试', 'claude-sonnet-4-6')").run(sid);
      const insMsg = db.prepare(
        'INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, ?, ?, ?)',
      );
      insMsg.run('dp-m0', sid, 'assistant', '轮前基线写', null);
      insMsg.run('dp-u1', sid, 'user', '第一轮', null);
      insMsg.run('dp-m1', sid, 'assistant', '写1', null);
      insMsg.run('dp-m2', sid, 'assistant', '写2', null);
      insMsg.run('dp-u2', sid, 'user', '第二轮', null);
      insMsg.run('dp-m3', sid, 'assistant', '写3', null);
      const insertCk = checkpointRepo?.insert as ((row: Record<string, unknown>) => unknown) | undefined;
      const ck = (seq: number, messageId: string, p: string, after: string, toolInput: unknown, toolName = 'Write'): void => {
        insertCk!({
          session_id: sid, message_id: messageId, path: p, tool_name: toolName,
          tool_use_id: `tu-dp-${seq}`, input_json: JSON.stringify(toolInput), input_truncated: 0,
          after_content: after, after_truncated: 0, binary: 0, snapshot_state: 'disk',
        });
      };
      ck(0, 'dp-m0', 'P', 'P0\n', { file_path: 'P', content: 'P0\n' });
      ck(1, 'dp-m1', 'P', 'P1\n', { file_path: 'P', content: 'P1\n' });
      ck(2, 'dp-m2', 'P', 'P2\n', { file_path: 'P', content: 'P2\n' });
      ck(3, 'dp-m3', 'P', 'P3\n', { file_path: 'P', content: 'P3\n' });
      ck(4, 'dp-m1', 'Q', 'Q1\n', { file_path: 'Q', content: 'Q1\n' });

      const getPatch = turnDiffMod!.getPatch as GetPatchFn;
      const p12 = getPatch(sid, 'dp-u1', 'dp-u2', 'P');
      check('D⑧a', "getPatch 轮1：mode=full、patch=基线P0→末P2（'-P0'/'+P2'，P1/P3 不出现）",
        p12.mode === 'full' && p12.truncated === false
          && p12.patch.split('\n').includes('-P0') && p12.patch.split('\n').includes('+P2')
          && !p12.patch.includes('P1') && !p12.patch.includes('P3'),
        `p12=${JSON.stringify(p12)}`);
      const p23 = getPatch(sid, 'dp-u2', null, 'P');
      check('D⑧b', "getPatch 轮2（end=null）：before=轮1 末 P2 → patch '-P2'/'+P3'",
        p23.mode === 'full' && p23.patch.split('\n').includes('-P2') && p23.patch.split('\n').includes('+P3'),
        `p23=${JSON.stringify(p23)}`);
      const pInf = getPatch(sid, 'dp-u2', 'dp-missing-end', 'P');
      check('D⑧c', 'endMessageId 查不到 → 上界 +∞（与 end=null 同结果）',
        pInf.mode === 'full' && pInf.patch === p23.patch,
        `pInf=${JSON.stringify(pInf)}`);
      const pNoTurn = getPatch(sid, 'dp-missing-turn', null, 'P');
      check('D⑧d', "turnStartMessageId 查不到 → {mode:'unavailable', patch:'', truncated:false} 不抛错",
        pNoTurn.mode === 'unavailable' && pNoTurn.patch === '' && pNoTurn.truncated === false,
        `pNoTurn=${JSON.stringify(pNoTurn)}`);
      const q1 = getPatch(sid, 'dp-u1', 'dp-u2', 'Q');
      check('D⑧e', 'getPatch 首改（Q 区间前无记录）→ first-change、patch 含 +Q1',
        q1.mode === 'first-change' && q1.patch.split('\n').includes('+Q1'),
        `q1=${JSON.stringify(q1)}`);
    }

    // i) listSummaries（DB 组装全链）：主进程从 messages 表推导轮区间（N2 裁定）。
    {
      const listSummaries = turnDiffMod!.listSummaries as ListSummariesFn;
      const out = listSummaries('sess-d-patch');
      const t1 = out.find((s) => s.turnStartMessageId === 'dp-u1');
      const t2 = out.find((s) => s.turnStartMessageId === 'dp-u2');
      check('D⑨', 'listSummaries：主进程推导轮区间 → 两轮摘要（轮1 P+Q、轮2 P）',
        out.length === 2
          && t1?.items.length === 2
          && t1.items.some((i) => i.path === 'P' && i.mode === 'full' && i.writeCount === 2)
          && t1.items.some((i) => i.path === 'Q' && i.mode === 'first-change')
          && t2?.items.length === 1 && t2.items[0]!.path === 'P' && t2.items[0]!.mode === 'full',
        `out=${JSON.stringify(out)}`);
    }

    // j) D-ro①（round-001 R1）：同轮乱序——快照异步读盘完成序（数组序=id 序）与 mrow 序交叉时，
    //    after/before 不再按数组序「最后一条覆盖」，而是一律取 mrow（消息序）最大可用行。
    //    构造：前轮 2 行（mrow 11=pre-a、12=pre-b，数组序 pre-b,pre-a）+ 本轮 3 行
    //    （mrow 序 v1→v2→v3，数组序 v2,v3,v1）。期望 full：patch=轮始态 pre-b → 轮末 v3，
    //    中间态 v1/v2 与乱序前轮行 pre-a 均不出现。
    {
      const rows = [
        mkRow(1, { mrow: 12, path: 'RO', after_content: 'pre-b\n' }),
        mkRow(2, { mrow: 11, path: 'RO', after_content: 'pre-a\n' }),
        mkRow(3, { mrow: 102, path: 'RO', after_content: 'pre-b\nv2\n' }),
        mkRow(4, { mrow: 103, path: 'RO', after_content: 'pre-b\nv3\n' }),
        mkRow(5, { mrow: 101, path: 'RO', after_content: 'pre-b\nv1\n' }),
      ];
      const out = aggregate(rows, [{ turnStartMessageId: 'tro', startRow: 100, endRow: 200 }]);
      const item = out[0]?.items[0];
      const fr = fileDiff(rows, 100, 200, 'RO');
      const ok = out.length === 1 && item?.mode === 'full' && item?.writeCount === 3
        && item?.additions === 1 && item?.deletions === 0
        && fr.mode === 'full' && fr.writeCount === 3 && fr.truncated === false
        && fr.additions === 1 && fr.deletions === 0
        && fr.patch.split('\n').includes('+v3')
        && !fr.patch.includes('v1') && !fr.patch.includes('v2') && !fr.patch.includes('pre-a');
      check('D-ro①', '同轮乱序（数组序 pre-b,pre-a,v2,v3,v1 ≠ mrow 序）：before=前轮 mrow 最大(pre-b)、after=mrow 最大(v3)，patch 只含轮始态→v3（v1/v2/pre-a 不出现）',
        ok, `agg=${JSON.stringify(out)} patch=[${fr.patch.split('\n').join(' ⏎ ')}]`);
    }

    // k) D-ro②（round-001 R1）：跨轮乱序——前轮两行数组序与 mrow 序交叉，before 取 mrow 较大行。
    //    构造：前轮 mrow 21=b-earlier、22=b-later，数组序 [b-later, b-earlier]（交叉）；本轮 1 行
    //    after=b-later\nturn1。期望 before=b-later（mrow 较大）→ patch 仅 +turn1（±=1/0），
    //    乱序误取 b-earlier 时会多出 '-b-earlier'/'+b-later'。
    {
      const rows = [
        mkRow(1, { mrow: 22, path: 'RB', after_content: 'b-later\n' }),
        mkRow(2, { mrow: 21, path: 'RB', after_content: 'b-earlier\n' }),
        mkRow(3, { mrow: 101, path: 'RB', after_content: 'b-later\nturn1\n' }),
      ];
      const fr = fileDiff(rows, 100, null, 'RB');
      const ok = fr.mode === 'full' && fr.additions === 1 && fr.deletions === 0
        && fr.patch.split('\n').includes('+turn1')
        && !fr.patch.split('\n').includes('-b-earlier')
        && !fr.patch.split('\n').includes('+b-later');
      check('D-ro②', '跨轮乱序（前轮数组序 [b-later,b-earlier] ≠ mrow 序）：before 取 mrow 较大行 b-later（patch 无 -b-earlier/+b-later、±=1/0）',
        ok, `fr=${JSON.stringify(fr)}`);
    }
  } catch (e) {
    fail += 1;
    console.log(`  ❌ 段D 异常：${errMsg(e)}`);
  }
}

runSegmentD();

// ═══════════════════════════════════════════════════════════════════════════
// 段E（P1，2026-10-30 意图合成器重写计划 §2.2/§2.3）：虚拟文档链 + mrow 排序 + context 透传。
// 纯函数直测（内存 rows）+ E6 走真实临时库 getPatch。hunk 头用 @@ -a,b +c,d @@ 正则抽取断言。
// E8 另把合成 patch 直接喂渲染层 parseUnifiedDiff，钉渲染解析契约（组序/skip 分隔/行号单调/乱序治愈）。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段E 意图合成器重写（锚定/排序/context） ===');

type ComputeCtxFn = (rows: unknown[], startRow: number, endRow: number | null, path: string, context?: number) => FileDiffResult;
type GetPatchCtxFn = (sessionId: string, turnStartMessageId: string, endMessageId: string | null, path: string, context?: number) =>
  { mode: string; patch: string; truncated: boolean };

interface HunkHeader { oldStart: number; oldCount: number; newStart: number; newCount: number }

const E_HUNK_RE = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/;

/** 从 patch 抽全部 hunk 头（@@ -oldStart,oldCount +newStart,newCount @@）。 */
function hunkHeadersOf(patch: string): HunkHeader[] {
  const out: HunkHeader[] = [];
  for (const line of patch.split('\n')) {
    const m = E_HUNK_RE.exec(line);
    if (m) out.push({ oldStart: Number(m[1]), oldCount: Number(m[2]), newStart: Number(m[3]), newCount: Number(m[4]) });
  }
  return out;
}

/** 按 @@ 头切 section，返回各 hunk 的正文行（跳过空行；文件头 ---/+++ 在首个 @@ 之前，不落入任何 section）。 */
function hunkBodiesOf(patch: string): string[][] {
  const bodies: string[][] = [];
  let cur: string[] | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@')) { cur = []; bodies.push(cur); continue; }
    if (cur !== null && line !== '') cur.push(line);
  }
  return bodies;
}

{
  const fileDiffCtx = computeFileDiff as ComputeCtxFn | undefined;
  const getPatchCtx = turnDiffMod?.getPatch as GetPatchCtxFn | undefined;

  if (typeof fileDiffCtx !== 'function') {
    const why = `computeFileDiff 不可用${turnDiffErr ? `（模块加载失败：${turnDiffErr.slice(0, 160)}）` : ''}`;
    check('E1', '乱序治愈（S2）：mrow 序重排后 hunk 按文件位置升序', false, why);
    check('E2', '行号真实（S3）：Edit 第 7 行 → hunk newStart=7', false, why);
    check('E3', 'context 生效（S1）：ctx=3 → 8 行 / ctx=10 → 11 行、编辑 hunk ±=1/1', false, why);
    check('E4', '多 Write ± 净计（H3）：4/0 而非重复整计 7/0', false, why);
    check('E5', '截断与 ±（S5/N3）：3000 行 Write → truncated、±=3000/0、正文 ≤2000', false, why);
    check('E6', 'getPatch context 端到端（S6 DB 侧）：ctx=10 正文 > ctx=3、mode 均 full', false, why);
    check('E7', '未命中追加（S4 兜底）：newStart=6 + 命中片段 newStart=3 升序', false, why);
    check('E8', '合成 patch 喂渲染层解析链（F-1 钉）：parseUnifiedDiff 非 null 非 binary、含 skip 组、mod 组行号单调不重置、-L2 组先于 -L9 组', false, why);
  } else {
    // a) E1 乱序治愈（S2）：rows 按 t.id 序给出（数组序=id 序）、mrow 与数组序相反——
    //    t.id1=Edit L9（mrow 103）、t.id2=Edit L2（mrow 102）、t.id3=Write 10 行文档（mrow 101）。
    //    Write 行带可用 disk 快照（after_content=文档全文）→ mode=first-change。
    //    期望：重排后 Write→L2→L9 虚拟文档链锚定，hunk newStart 全体严格升序；
    //    修改型 hunk（oldStart>0，排除 Write 的 @@ -0,0 新建 hunk）恰 2 个且 newStart=[2,9]。
    {
      const doc10 = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const rows = [
        mkRow(1, { mrow: 103, path: 'PE1', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE1', old_string: 'L9', new_string: 'L9X' }) }),
        mkRow(2, { mrow: 102, path: 'PE1', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE1', old_string: 'L2', new_string: 'L2X' }) }),
        mkRow(3, { mrow: 101, path: 'PE1', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE1', content: doc10 }), after_content: doc10 }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE1');
      const headers = hunkHeadersOf(fr.patch);
      const newStarts = headers.map((h) => h.newStart);
      const modHunks = headers.filter((h) => h.oldStart > 0);
      const strictlyAsc = newStarts.every((v, i) => i === 0 || v > newStarts[i - 1]!);
      check('E1', '乱序治愈（S2）：mrow 与数组序相反 → hunk newStart 严格升序、修改型 hunk 恰 2 个且 newStart=[2,9]（旧实现反序且恒 1）、mode=first-change、truncated=false',
        fr.mode === 'first-change' && fr.truncated === false
          && strictlyAsc && modHunks.length === 2
          && modHunks[0]?.newStart === 2 && modHunks[1]?.newStart === 9
          && fr.patch.includes('-L2') && fr.patch.includes('+L2X') && fr.patch.includes('-L9') && fr.patch.includes('+L9X'),
        `mode=${fr.mode} headers=${JSON.stringify(headers)} modNewStarts=[${modHunks.map((h) => h.newStart).join(',')}]`);
    }

    // b) E2 行号真实连续（S3）：10 行 Write 后 Edit 第 7 行（L7→L7X）→ 该 hunk newStart===7（不是 1）。
    {
      const doc10 = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const rows = [
        mkRow(1, { mrow: 101, path: 'PE2', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE2', content: doc10 }) }),
        mkRow(2, { mrow: 102, path: 'PE2', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE2', old_string: 'L7', new_string: 'L7X' }) }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE2');
      const headers = hunkHeadersOf(fr.patch);
      const editHunk = headers.find((h) => h.newStart === 7);
      check('E2', '行号真实（S3）：10 行 Write 后 Edit 第 7 行 → 该 hunk newStart=7（不是 1）、patch 含 -L7/+L7X',
        editHunk !== undefined && editHunk.oldStart === 7
          && fr.patch.split('\n').includes('-L7') && fr.patch.split('\n').includes('+L7X'),
        `headers=${JSON.stringify(headers)}`);
    }

    // c) E3 context 生效（S1）：20 行 Write + Edit 前 10 行块（仅 L5→L5X，锚定第 1 行）。
    //    编辑 hunk 正文行数随 context 增（3→8 行、10→11 行），编辑改动本身 ± 恒 1/1——
    //    证明 context 从 computeFileDiff 一路透传进 buildTwoFilePatch。
    {
      const doc20 = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const oldBlock = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n');
      const newBlock = oldBlock.replace('L5', 'L5X');
      const rows = [
        mkRow(1, { mrow: 101, path: 'PE3', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE3', content: doc20 }) }),
        mkRow(2, { mrow: 102, path: 'PE3', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE3', old_string: oldBlock, new_string: newBlock }) }),
      ];
      const fr3 = fileDiffCtx(rows, 100, 200, 'PE3', 3);
      const fr10 = fileDiffCtx(rows, 100, 200, 'PE3', 10);
      // 编辑 hunk = 含 -L5 的那个 section（Write 在前、Edit 锚定同 1 行但时序在后）。
      const editBody = (fr: FileDiffResult): string[] =>
        hunkBodiesOf(fr.patch).find((body) => body.includes('-L5')) ?? [];
      const b3 = editBody(fr3);
      const b10 = editBody(fr10);
      const plusMinusOf = (body: string[]): string => `${body.filter((l) => l.startsWith('-')).length}/${body.filter((l) => l.startsWith('+')).length}`;
      check('E3', 'context 生效（S1）：编辑 hunk 正文 ctx=3 → 8 行 / ctx=10 → 11 行、两档编辑 hunk ± 同为 1/1（-L5/+L5X）',
        b3.length === 8 && b10.length === 11
          && plusMinusOf(b3) === '1/1' && plusMinusOf(b10) === '1/1'
          && b3.includes('-L5') && b3.includes('+L5X') && b10.includes('+L5X'),
        `ctx3 正文=${b3.length}（±${plusMinusOf(b3)}） ctx10 正文=${b10.length}（±${plusMinusOf(b10)}）`);
    }

    // d) E4 多 Write ± 净计（H3 有意修正）：同 path 两次 Write，第一片 +3（vs 空）、
    //    第二片对虚拟文档 diff 净 +1 → 合计 additions=4/deletions=0（旧口径重复整计 7/0）。
    {
      const rows = [
        mkRow(1, { mrow: 101, path: 'PE4', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE4', content: 'a\nb\nc\n' }) }),
        mkRow(2, { mrow: 102, path: 'PE4', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE4', content: 'a\nb\nc\nd\n' }) }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE4');
      check('E4', '多 Write ± 净计（H3）：Write a,b,c → Write a,b,c,d → additions=4/deletions=0（旧口径 7）、patch 含 +d',
        fr.additions === 4 && fr.deletions === 0 && fr.patch.split('\n').includes('+d'),
        `±=${fr.additions}/${fr.deletions} patch=[${fr.patch.split('\n').join(' ⏎ ')}]`);
    }

    // e) E5 截断与 ±（S5/N3）：单 Write 3000 行（context=10 一并验证透传不破坏截断）：
    //    truncated=true、additions=3000（截断前全量）、deletions=0、正文行数 ≤2000 且 >0。
    {
      const big = Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const rows = [
        mkRow(1, { mrow: 101, path: 'PE5', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE5', content: big }) }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE5', 10);
      const bodyCount = hunkBodiesOf(fr.patch).reduce((acc, body) => acc + body.length, 0);
      check('E5', '截断与 ±（S5/N3）：3000 行 Write（ctx=10）→ truncated=true、±=3000/0（截断前全量）、正文 0<行数≤2000',
        fr.truncated === true && fr.additions === 3000 && fr.deletions === 0 && bodyCount > 0 && bodyCount <= 2000,
        `truncated=${String(fr.truncated)} ±=${fr.additions}/${fr.deletions} 正文=${bodyCount}`);
    }

    // f) E6 getPatch context 端到端（S6 DB 侧）：真实临时库上造「full 模式」样本——
    //    区间前 before 快照（mrow<startRow）+ 区间内 after 快照，前后留 ≥6 行公共上下文
    //    （before=K1..K10，after 仅 K6→K6X）。ctx=10 的 hunk 正文行数必须 > ctx=3（3→8、10→11），
    //    两次 mode 均 full、±（正文 +/- 计数）相同。
    {
      const sid = 'sess-e-ctx';
      db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段E-getPatch-context测试', 'claude-sonnet-4-6')").run(sid);
      const insMsg = db.prepare(
        'INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, ?, ?, ?)',
      );
      insMsg.run('e-pre', sid, 'assistant', '轮前基线写', null);
      insMsg.run('e-u1', sid, 'user', '第一轮', null);
      insMsg.run('e-m1', sid, 'assistant', '轮内改写', null);
      const insertCkE = checkpointRepo?.insert as ((row: Record<string, unknown>) => unknown) | undefined;
      const before10 = Array.from({ length: 10 }, (_, i) => `K${i + 1}`).join('\n') + '\n';
      const after10 = before10.replace('K6', 'K6X');
      if (typeof insertCkE !== 'function') throw new Error('repo.insert 不可用');
      insertCkE({
        session_id: sid, message_id: 'e-pre', path: 'K', tool_name: 'Write', tool_use_id: 'tu-e-pre',
        input_json: JSON.stringify({ file_path: 'K', content: before10 }), input_truncated: 0,
        after_content: before10, after_truncated: 0, binary: 0, snapshot_state: 'disk',
      });
      insertCkE({
        session_id: sid, message_id: 'e-m1', path: 'K', tool_name: 'Write', tool_use_id: 'tu-e-m1',
        input_json: JSON.stringify({ file_path: 'K', content: after10 }), input_truncated: 0,
        after_content: after10, after_truncated: 0, binary: 0, snapshot_state: 'disk',
      });
      const p3 = getPatchCtx!(sid, 'e-u1', null, 'K', 3);
      const p10 = getPatchCtx!(sid, 'e-u1', null, 'K', 10);
      const b3 = hunkBodiesOf(p3.patch).reduce((acc, body) => acc + body.length, 0);
      const b10 = hunkBodiesOf(p10.patch).reduce((acc, body) => acc + body.length, 0);
      const pmOf = (p: { patch: string }): string =>
        `${p.patch.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---')).length}/${p.patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).length}`;
      check('E6', 'getPatch context 端到端（S6 DB 侧）：full 模式下 ctx=10 hunk 正文（11）> ctx=3（8）、两次 mode=full、± 相同（1/1）',
        p3.mode === 'full' && p10.mode === 'full'
          && b3 === 8 && b10 === 11 && b10 > b3
          && pmOf(p3) === pmOf(p10) && pmOf(p3) === '1/1',
        `mode=${p3.mode}/${p10.mode} ctx3 正文=${b3} ctx10 正文=${b10} ±=${pmOf(p3)}/${pmOf(p10)}`);
    }

    // g) E7 未命中追加（S4 兜底）：5 行 Write 后 Edit old_string 未命中 → 追加到尾部下一行
    //    （anchor = countLF(doc)+2 = 4+2 = 6）；再补一条命中 L3 的 Edit → newStart=3。
    //    两 hunk newStart 升序（[3,6]）；patch 含 -NOT-PRESENT/+Z。
    {
      const doc5 = 'L1\nL2\nL3\nL4\nL5';
      const rows = [
        mkRow(1, { mrow: 101, path: 'PE7', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE7', content: doc5 }) }),
        mkRow(2, { mrow: 102, path: 'PE7', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE7', old_string: 'NOT-PRESENT', new_string: 'Z' }) }),
        mkRow(3, { mrow: 103, path: 'PE7', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE7', old_string: 'L3', new_string: 'L3Y' }) }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE7');
      const headers = hunkHeadersOf(fr.patch);
      const zHunk = headers.find((h) => h.newStart === 6);
      const hitHunk = headers.find((h) => h.newStart === 3);
      const newStarts = headers.map((h) => h.newStart);
      const asc = newStarts.every((v, i) => i === 0 || v > newStarts[i - 1]!);
      check('E7', '未命中追加（S4 兜底）：未命中 Edit 追加尾部 hunk newStart=6、命中 L3 hunk newStart=3、两 hunk newStart 升序、patch 含 -NOT-PRESENT/+Z/-L3/+L3Y',
        zHunk !== undefined && hitHunk !== undefined && asc
          && fr.patch.split('\n').includes('-NOT-PRESENT') && fr.patch.split('\n').includes('+Z')
          && fr.patch.split('\n').includes('-L3') && fr.patch.split('\n').includes('+L3Y'),
        `headers=${JSON.stringify(headers)} newStarts=[${newStarts.join(',')}]`);
    }

    // h) E8 合成 patch → 渲染层解析链契约钉（review-round1 F-1 跟进）：与 E1 同款乱序输入但
    //    全行 binary=1+snapshot_state='failed' → intent 模式；把合成 patch 喂渲染层真正的
    //    parseUnifiedDiff（diff-parser 自述无 DOM/Vue 依赖可被 tsx 直 import），断言解析层
    //    非 binary / skip 分隔恢复 / mod 行号单调不重置 / 乱序治愈组序 四点。
    {
      const doc10 = Array.from({ length: 10 }, (_, i) => `L${i + 1}`).join('\n') + '\n';
      const rows = [
        mkRow(1, { mrow: 103, path: 'PE8', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE8', old_string: 'L9', new_string: 'L9X' }), binary: 1, snapshot_state: 'failed' }),
        mkRow(2, { mrow: 102, path: 'PE8', tool_name: 'Edit', input_json: JSON.stringify({ file_path: 'PE8', old_string: 'L2', new_string: 'L2X' }), binary: 1, snapshot_state: 'failed' }),
        mkRow(3, { mrow: 101, path: 'PE8', tool_name: 'Write', input_json: JSON.stringify({ file_path: 'PE8', content: doc10 }), binary: 1, snapshot_state: 'failed' }),
      ];
      const fr = fileDiffCtx(rows, 100, 200, 'PE8', 3);
      const parsed = parseUnifiedDiff(fr.patch);
      const groups = parsed?.groups ?? [];
      // 组概要（诊断用）：k 序列 + 各组首行号/skipCount
      const gs = (g: (typeof groups)[number]): string =>
        g.k === 'skip' ? `skip(${g.skipCount})` : `${g.k}[L${g.L[0]?.n ?? '-'}|R${g.R[0]?.n ?? '-'}]`;
      const groupsSummary = `mode=${fr.mode} groups=[${groups.map(gs).join(',')}]`;
      const modGroups = groups.filter((g) => g.k === 'mod');
      const lOld = modGroups.flatMap((g) => g.L.map((l) => l.n).filter((n): n is number => n !== null));
      const rNew = modGroups.flatMap((g) => g.R.map((r) => r.n).filter((n): n is number => n !== null));
      const nonDec = (arr: number[]): boolean => arr.every((v, i) => i === 0 || v >= arr[i - 1]!);
      const l1Count = modGroups.filter((g) => (g.L[0]?.n ?? null) === 1).length;
      const l2Idx = groups.findIndex((g) => g.L.some((l) => l.t === 'L2'));
      const l9Idx = groups.findIndex((g) => g.L.some((l) => l.t === 'L9'));
      check('E8', '合成 patch 喂渲染层解析链（F-1 钉）：parseUnifiedDiff 非 null 非 binary、组序含 skip 组、mod 组旧/新行号各按组序单调不降且无「每块从 1 重置」（不存在两个 L 首行号=1 的 mod 组）、含 -L2 的组先于含 -L9 的组',
        parsed !== null && parsed.binary === false
          && groups.some((g) => g.k === 'skip' && (g.skipCount ?? 0) > 0)
          && nonDec(lOld) && nonDec(rNew) && l1Count <= 1
          && l2Idx >= 0 && l9Idx > l2Idx,
        groupsSummary);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 段F（P2，2026-10-30 mcp-web-parity-and-turn-diff-intent-fix 计划 §2.3.5/§2.3.6）：
// 渲染层源形状钉——turn-diff-store 缓存键带 context 维度 + TurnDiffDialog 全文/切档重拉。
// 与段 D-ui/D-ui2 同款静态断言（读源码文本子串），钉住渲染层接线不被回退。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段F 渲染层源形状（P2） ===');

{
  const dlgSrcF = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'components', 'chat', 'TurnDiffDialog.vue'), 'utf8');
  const storeSrcF = fs.readFileSync(path.join(repoRoot, 'src', 'renderer', 'stores', 'turn-diff-store.ts'), 'utf8');
  const preloadSrcF = fs.readFileSync(path.join(repoRoot, 'src', 'preload', 'api.ts'), 'utf8');

  // F1 全文/重拉全链：FULL_CONTEXT 常量、effectiveContext 派生、切档 watch 重拉、setFullText、
  // 「全文」按钮、DiffBody 双绑定、打开复位路径懒加载带 effectiveContext。
  check('F1', 'TurnDiffDialog 全文/重拉全链：FULL_CONTEXT=100000 / effectiveContext / watch(effectiveContext) 重拉 / setFullText / 全文按钮 / :context="effectiveContext" / :full-text="fullText" / 打开路径 getPatch 带 effectiveContext',
    dlgSrcF.includes('const FULL_CONTEXT = 100000')
    && dlgSrcF.includes('const effectiveContext = computed(')
    && dlgSrcF.includes('watch(effectiveContext,')
    && dlgSrcF.includes('setFullText')
    && dlgSrcF.includes('全文</button>')
    && dlgSrcF.includes(':context="effectiveContext"')
    && dlgSrcF.includes(':full-text="fullText"')
    && dlgSrcF.includes('store.getPatch(t.sessionId, t.turnStartMessageId, t.endMessageId, t.path, effectiveContext.value)'),
    'TurnDiffDialog 缺全文/重拉接线之一');

  // F2 上下文不匹配守卫：bodyState（!== 视为 loading）与 parsed（=== 才渲染）两处都在。
  check('F2', 'TurnDiffDialog 上下文不匹配守卫：bodyState 含 entry.value.context !== effectiveContext.value、parsed 含 entry.value.context === effectiveContext.value',
    dlgSrcF.includes('entry.value.context !== effectiveContext.value')
    && dlgSrcF.includes('entry.value.context === effectiveContext.value'),
    'TurnDiffDialog 缺上下文不匹配守卫（bodyState / parsed）');

  // F3 store 三段键 + context 字段：键 `${turnStartMessageId}|${path}|${context}`、接口字段、
  // getPatch 三参键调用、缓存写入补 context。
  check('F3', 'turn-diff-store 三段键 + context 字段：键模板 turnStartMessageId|path|context / TurnFilePatch.context: number / getPatch 用 turnDiffPatchKey(turnStartMessageId, path, context) / 缓存写入 { ...res, context }',
    storeSrcF.includes('`${turnStartMessageId}|${path}|${context}`')
    && storeSrcF.includes('context: number;')
    && storeSrcF.includes('turnDiffPatchKey(turnStartMessageId, path, context)')
    && storeSrcF.includes('{ ...res, context }'),
    'turn-diff-store 缺三段键或 context 字段');

  // F4 preload 五参 + 缺省 3（P1 已落地，此处防回退）：声明带 context?: number、实现透传 context ?? 3。
  check('F4', 'preload getTurnFilePatch 五参 + 缺省 3：声明含 context?: number、invoke 含 path, context ?? 3',
    preloadSrcF.includes('context?: number')
    && preloadSrcF.includes('IPC_CHANNELS.TURN_DIFF_FILE_PATCH, sessionId, turnStartMessageId, endMessageId, path, context ?? 3'),
    'preload 缺五参声明或缺省 3 透传');
}

// ═══════════════════════════════════════════════════════════════════════════
// 段F（点A，2026-10-31 turn-diff-notebookedit-and-pathkey 计划 §3.6 段F）：NotebookEdit 追踪。
// 注：上文已有「段F 渲染层源形状」（P2，check 编号 F1-F4）占用段名，本段沿用计划原文命名
// 「段F（NotebookEdit）」、check 编号用圈号 F①-F⑥，与 F1-F4 无冲突。
// F①/F②/F⑤ 直喂记录器（伪事件 + stubUserDataDir 下临时真实文件）；F③/F④ 走真实临时库全链
//（记录器 → listBySession → deriveTurnRanges → aggregateFromCheckpoints/computeFileDiff 直测）。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段F NotebookEdit 追踪（点A） ===');

const segFDir = path.join(stubUserDataDir, 'seg-f-files');

/** 段F 用：主流程 user 轮起点消息行（deriveTurnRanges 分界前提，parent_agent_id=NULL）。 */
function seedUserMessageF(sessionId: string, messageId: string, content: string): void {
  db.prepare(
    "INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, 'user', ?, NULL)",
  ).run(messageId, sessionId, content);
}

function seedSessionF(id: string): void {
  db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段F-NotebookEdit测试', 'claude-sonnet-4-6')").run(id);
}

async function runSegmentF(): Promise<void> {
  fs.mkdirSync(segFDir, { recursive: true });
  const note = noteCheckpointEvent;
  const listBySessionF = checkpointRepo?.listBySession as
    | ((id: string) => Array<Record<string, unknown>>)
    | undefined;
  const deriveF = turnDiffMod?.deriveTurnRanges as DeriveFn | undefined;
  const aggregateF = aggregateFromCheckpoints;

  if (
    typeof note !== 'function' || typeof listBySessionF !== 'function'
    || typeof deriveF !== 'function' || typeof aggregateF !== 'function'
    || typeof computeFileDiff !== 'function'
  ) {
    const why = `记录器/turn-diff 导出不可用${recorderErr ? `（recorder 加载失败：${recorderErr.slice(0, 120)}）` : ''}${turnDiffErr ? `（turn-diff 加载失败：${turnDiffErr.slice(0, 120)}）` : ''}`;
    check('F①', 'tool_use(NotebookEdit)+成功 result → 1 条 disk 快照', false, why);
    check('F②', 'NotebookEdit 无 notebook_path → 不落库', false, why);
    check('F③', '聚合 unavailable：仅一轮 NotebookEdit 行', false, why);
    check('F④', '聚合 full：前轮 Edit 行 + 本轮 NotebookEdit 行', false, why);
    check('F⑤', '白名单回归：Bash/Read 仍不落库', false, why);
    check('F⑥', 'NotebookEdit input >512KiB：input_truncated=1 且正则兜底 → 行落库、path=notebook_path 值', false, why);
    return;
  }

  // a) F① 记录器正例：tool_use(NotebookEdit, input.notebook_path=临时目录真实文件) + 成功 result
  //    → 1 条 disk 快照：path=notebook_path 值、after_content=磁盘内容、tool_name=NotebookEdit。
  {
    const sid = 'sess-f-a';
    seedSessionF(sid);
    const nbPath = path.join(segFDir, 'f-a.ipynb');
    const nbBody = '{"cells":[]}\n';
    fs.writeFileSync(nbPath, nbBody, 'utf-8');
    const toolUseId = 'tu-f-a';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'NotebookEdit', id: toolUseId, input: { notebook_path: nbPath, cell_id: 'c1', new_source: 'x' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-a', toolUseId);
    try { await waitForC(() => checkpointCountC(sid) === 1, 'F① 快照落库'); } catch { /* RED：未落库 */ }
    const rows = checkpointRowsC(sid);
    const r = rows[0] ?? {};
    check('F①', 'tool_use(NotebookEdit)+成功 result：1 条 disk 快照，path=notebook_path 值、after_content=磁盘内容、tool_name=NotebookEdit',
      rows.length === 1 && r.snapshot_state === 'disk' && r.path === nbPath
        && r.after_content === nbBody && r.tool_name === 'NotebookEdit',
      `rows=${JSON.stringify(rows).slice(0, 300)}`);
  }

  // b) F② 记录器负例：NotebookEdit 但 input 无 notebook_path 字段 → extractFilePath 提不出
  //    （JSON 分支与正则兜底均无命中）→ 不暂存，成功 result 也不落库。
  {
    const sid = 'sess-f-b';
    seedSessionF(sid);
    const toolUseId = 'tu-f-b';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'NotebookEdit', id: toolUseId, input: { cell_id: 'c1', new_source: 'x' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-b', toolUseId);
    await settleC();
    check('F②', 'NotebookEdit input 无 notebook_path 字段：不落库（count=0）',
      checkpointCountC(sid) === 0, `count=${checkpointCountC(sid)}`);
  }

  // c) F③ 聚合 unavailable（真实临时库全链）：仅一轮 NotebookEdit 行（区间前无该 path 可用
  //    disk 行）→ NotebookEdit 入参只有 new_source/cell_id、无改前内容，synth 不产片段 →
  //    items 含该 path、mode=unavailable、writeCount=1、±=0（诚实降级，不合成假 diff）。
  {
    const sid = 'sess-f-c';
    seedSessionF(sid);
    seedUserMessageF(sid, 'fu3-u1', '第一轮');
    const nbPath = path.join(segFDir, 'f-c.ipynb');
    fs.writeFileSync(nbPath, '{"cells":["c1"]}\n', 'utf-8');
    const toolUseId = 'tu-f-c';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'NotebookEdit', id: toolUseId, input: { notebook_path: nbPath, cell_id: 'c1', new_source: 'print(42)' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-c', toolUseId);
    try { await waitForC(() => checkpointCountC(sid) === 1, 'F③ 快照落库'); } catch { /* RED：未落库 */ }
    const rows = listBySessionF(sid);
    const out = aggregateF(rows, deriveF(sid));
    const item = out[0]?.items[0];
    check('F③', '聚合 unavailable：仅一轮 NotebookEdit 行（区间前无可用 disk 行）→ items 含该 path、mode=unavailable、writeCount=1、±=0',
      out.length === 1 && item?.path === nbPath && item?.mode === 'unavailable'
        && item?.writeCount === 1 && item?.additions === 0 && item?.deletions === 0,
      `out=${JSON.stringify(out)}`);
  }

  // d) F④ 聚合 full（真实临时库全链）：前一轮 Edit 造同 path 可用 disk 行（after=A），本轮
  //    NotebookEdit 行（after=B）→ mode=full、patch 含 A→B 真实差异行、writeCount=1（本区间 1 行）。
  //    时序纪律：先等 Edit 行落库（读盘续体已终结）再覆盖文件为 B，防快照竞态读到新内容。
  {
    const sid = 'sess-f-d';
    seedSessionF(sid);
    seedUserMessageF(sid, 'fu4-u1', '第一轮');
    const nbPath = path.join(segFDir, 'f-d.ipynb');
    fs.writeFileSync(nbPath, 'old-line\n', 'utf-8'); // Edit 后磁盘内容 = A
    const editUseId = 'tu-f-d-edit';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', id: editUseId, input: { file_path: nbPath, old_string: 'a', new_string: 'b' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: editUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-d-edit', editUseId);
    await waitForC(() => checkpointCountC(sid) === 1, 'F④ Edit 行落库'); // Edit 行在白名单内，RED 阶段也应落库
    seedUserMessageF(sid, 'fu4-u2', '第二轮');
    fs.writeFileSync(nbPath, 'new-line\n', 'utf-8'); // NotebookEdit 后磁盘内容 = B
    const nbUseId = 'tu-f-d-nb';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'NotebookEdit', id: nbUseId, input: { notebook_path: nbPath, cell_id: 'c1', new_source: 'x' } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: nbUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-d-nb', nbUseId);
    try { await waitForC(() => checkpointCountC(sid) === 2, 'F④ NotebookEdit 行落库'); } catch { /* RED：未落库 */ }
    const rows = listBySessionF(sid);
    const turn2 = deriveF(sid).find((rg) => rg.turnStartMessageId === 'fu4-u2');
    const out = aggregateF(rows, turn2 ? [turn2] : []);
    const item = out[0]?.items[0];
    const fr = turn2 ? computeFileDiff(rows, turn2.startRow, turn2.endRow, nbPath) : null;
    check('F④', '聚合 full：前轮 Edit 行（after=A=old-line）+ 本轮 NotebookEdit 行（after=B=new-line）→ mode=full、patch 含 -old-line/+new-line 真实差异行、±=1/1、writeCount=1',
      out.length === 1 && item?.path === nbPath && item?.mode === 'full' && item?.writeCount === 1
        && item?.additions === 1 && item?.deletions === 1
        && fr !== null && fr.mode === 'full'
        && fr.patch.split('\n').includes('-old-line') && fr.patch.split('\n').includes('+new-line'),
      `out=${JSON.stringify(out)} fr=${JSON.stringify(fr)}`);
  }

  // e) F⑤ 白名单回归（防白名单数组改动误伤）：Bash/Read 伪事件仍不落行（既有 C⑩ 语义不回退）。
  {
    const sid = 'sess-f-e';
    seedSessionF(sid);
    const readFile = path.join(segFDir, 'f-e.txt');
    fs.writeFileSync(readFile, 'f-e-body\n', 'utf-8');
    const bashUseId = 'tu-f-e-bash';
    const readUseId = 'tu-f-e-read';
    note(sid, { type: 'message', role: 'assistant', content: [
      { type: 'tool_use', name: 'Bash', id: bashUseId, input: { command: 'echo f' } },
      { type: 'tool_use', name: 'Read', id: readUseId, input: { file_path: readFile } },
    ] });
    note(sid, { type: 'message', role: 'user', content: [
      { type: 'tool_result', tool_use_id: bashUseId, content: 'f' },
      { type: 'tool_result', tool_use_id: readUseId, content: 'ok' },
    ] });
    seedToolResultMessage(sid, 'msg-f-e-bash', bashUseId);
    seedToolResultMessage(sid, 'msg-f-e-read', readUseId);
    await settleC();
    check('F⑤', '白名单回归：Bash/Read 伪事件仍不落行（count=0，C⑩ 语义不回退）',
      checkpointCountC(sid) === 0, `count=${checkpointCountC(sid)}`);
  }

  // f) F⑥ 截断钉板（备忘-3）：NotebookEdit input >512KiB（new_source 大字段致 JSON.stringify
  //    超 INPUT_JSON_LIMIT=512KiB）→ 落库 input_json 为截断前缀（非法 JSON）→ extractFilePath
  //    JSON.parse 分支 null，正则兜底从前缀文本提取 notebook_path（notebook_path 放 input 最前，
  //    保证落在 512KiB 前缀内；Windows 路径反斜杠经 JSON 转义为 \\，由 (?:[^"\\]|\\.)* 消化）
  //    → 行落库：path=notebook_path 值、input_truncated=1、tool_name=NotebookEdit。
  {
    const sid = 'sess-f-f';
    seedSessionF(sid);
    const nbPath = path.join(segFDir, 'f-f.ipynb');
    fs.writeFileSync(nbPath, '{"cells":[]}\n', 'utf-8');
    const toolUseId = 'tu-f-f';
    note(sid, { type: 'message', role: 'assistant', content: [{ type: 'tool_use', name: 'NotebookEdit', id: toolUseId, input: { notebook_path: nbPath, cell_id: 'c1', new_source: 'x'.repeat(600 * 1024) } }] });
    note(sid, { type: 'message', role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] });
    seedToolResultMessage(sid, 'msg-f-f', toolUseId);
    try { await waitForC(() => checkpointCountC(sid) === 1, 'F⑥ 截断快照落库'); } catch { /* RED：未落库 */ }
    const rows = checkpointRowsC(sid);
    const r = rows[0] ?? {};
    check('F⑥', 'NotebookEdit input >512KiB：input_truncated=1 且截断前缀下 notebook_path 正则兜底生效——行落库、path=notebook_path 值',
      rows.length === 1 && r.path === nbPath && r.input_truncated === 1 && r.tool_name === 'NotebookEdit',
      `count=${rows.length}、path=${String(r.path)}、input_truncated=${String(r.input_truncated)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 段G（点B，2026-10-31 turn-diff-notebookedit-and-pathkey 计划 §3.6 段G）：pathKey 归一化。
// G①②③ 纯函数直测 pathKey（内存字符串）；G④ 聚合合并纯函数直测（内存 rows + cwd 入参）；
// G⑤ getPatch 双拼写（真实临时库，直接 repo.insert 落行）；G⑥ cwd=null 回归钉（纯函数不传
// cwd 逐字节一致 + working_dir NULL 会话 listSummaries 不回归）；G⑦ 语义收紧（备忘-1+2）：
// win32 UNC 两拼写同键且不被前置 cwd；POSIX 反斜杠是合法文件名字符不折叠。全部同步执行，
// 不依赖段C/段F 的异步快照续体。
// ═══════════════════════════════════════════════════════════════════════════

console.log('\n=== 段G pathKey 归一化（点B） ===');

type PathKeyFnG = (p: string, cwd: string | null, platform?: string) => string;
type AggregateCwdFnG = (rows: unknown[], ranges: unknown[], cwd?: string | null) => AggSummary[];
type ComputeCwdFnG = (
  rows: unknown[], startRow: number, endRow: number | null, path: string, context?: number, cwd?: string | null,
) => FileDiffResult;

const pathKeyG = turnDiffMod?.pathKey as PathKeyFnG | undefined;
const aggregateCwdG = aggregateFromCheckpoints as AggregateCwdFnG | undefined;
const fileDiffCwdG = computeFileDiff as ComputeCwdFnG | undefined;

/** 段G 用：剥掉 ---/+++ 文件头行（头路径按 display 原文呈现、大小写不折叠是既有设计行为）。 */
function patchBodyG(patch: string): string[] {
  return patch.split('\n').filter((l) => !l.startsWith('--- ') && !l.startsWith('+++ '));
}

function runSegmentG(): void {
  try {
    if (typeof pathKeyG !== 'function' || typeof aggregateCwdG !== 'function' || typeof fileDiffCwdG !== 'function') {
      const why = `pathKey/aggregateFromCheckpoints/computeFileDiff 导出不可用${turnDiffErr ? `（turn-diff 加载失败：${turnDiffErr.slice(0, 160)}）` : ''}`;
      check('G①', "pathKey win32：'D:\\A\\B.ts' 与 'd:/a/b.ts' 同键；platform='linux' 注入时不同键", false, why);
      check('G②', "pathKey 相对：cwd='/w' 时 'src/x.ts' 与 '/w/src/x.ts' 同键；cwd=null 相对不解析（残余限制钉板）", false, why);
      check('G③', 'pathKey NFC/斜杠：NFD 组合形与 NFC 规范形同键；正反斜杠混用同键', false, why);
      check('G④', '聚合合并：大小写变体两行 → items 仅 1 条 / writeCount=2 / ± 为合并行集净差 / item.path=首行原文', false, why);
      check('G⑤', 'getPatch 双拼写：命中同组、同一 patch、mode 一致', false, why);
      check('G⑥', 'cwd=null 回归：不传 cwd 同拼写行为逐字节一致；working_dir NULL 会话 listSummaries 不回归', false, why);
      check('G⑦', 'pathKey win32：UNC 两拼写同键且不被前置 cwd；linux：含反斜杠文件名与斜杠子路径不同键', false, why);
      return;
    }

    // a) G① win32 大小写折叠 + platform 注入（计划 §3.6 G①）。
    {
      const k1 = pathKeyG('D:\\A\\B.ts', null);
      const k2 = pathKeyG('d:/a/b.ts', null);
      const l1 = pathKeyG('D:\\A\\B.ts', null, 'linux');
      const l2 = pathKeyG('d:/a/b.ts', null, 'linux');
      check('G①', "pathKey win32：'D:\\A\\B.ts' 与 'd:/a/b.ts' 同键（统一斜杠+折叠大小写）；platform='linux' 注入时不同键（POSIX 大小写敏感不折叠）",
        k1 === k2 && l1 !== l2,
        `win32: [${k1}] vs [${k2}]；linux: [${l1}] vs [${l2}]`);
    }

    // b) G② 相对路径解析：cwd 存在时解析为绝对后同键；cwd=null 不解析（两键不同——§11 残余限制钉板）。
    {
      const kRel = pathKeyG('src/x.ts', '/w');
      const kAbs = pathKeyG('/w/src/x.ts', null);
      const kRelNoCwd = pathKeyG('src/x.ts', null);
      const kAbsNoCwd = pathKeyG('/w/src/x.ts', null);
      check('G②', "pathKey 相对：cwd='/w' 时 'src/x.ts' 与 '/w/src/x.ts' 同键；cwd=null 时相对路径不解析（两键不同——§11 残余限制钉板）",
        kRel === kAbs && kRelNoCwd !== kAbsNoCwd,
        `cwd=/w: [${kRel}] vs [${kAbs}]；cwd=null: [${kRelNoCwd}] vs [${kAbsNoCwd}]`);
    }

    // c) G③ NFC 归一（NFD 组合字符形 vs NFC 规范形）+ 正反斜杠混用。
    {
      const nfc = pathKeyG('D:\\Dir\\caf\u00e9.ts', null); // NFC 规范形（U+00E9）
      const nfd = pathKeyG('D:/Dir/cafe\u0301.ts', null);  // NFD 分解形（e + U+0301 组合符）
      const s1 = pathKeyG('D:\\A\\B.ts', null);
      const s2 = pathKeyG('D:/A/B.ts', null);
      check('G③', 'pathKey NFC/斜杠：NFD 组合字符形与 NFC 规范形同键（normalize NFC）；正反斜杠混用同键',
        nfc === nfd && s1 === s2,
        `nfc: [${nfc}] vs [${nfd}]；slash: [${s1}] vs [${s2}]`);
    }

    // d) G④ 聚合合并（计划 §3.6 G④）：前轮 before 行（pUpper）+ 同回合两行同文件（pUpper/pLower
    //    大小写不同、cwd 传临时目录）→ items 仅 1 条、writeCount=2、± 为合并行集净差
    //   （before=BASE vs after=mrow 最大行的 BASE v1 v2）、item.path=首行原文 pUpper。
    {
      const segGDir = path.join(stubUserDataDir, 'seg-g-files');
      const pUpper = path.join(segGDir, 'GCase.txt');
      const pLower = path.join(segGDir, 'gcase.txt');
      const rows = [
        mkRow(1, { mrow: 10, path: pUpper, after_content: 'BASE\n' }),
        mkRow(2, { mrow: 101, path: pUpper, after_content: 'BASE\nv1\n' }),
        mkRow(3, { mrow: 102, path: pLower, after_content: 'BASE\nv1\nv2\n' }),
      ];
      const out = aggregateCwdG(rows, [{ turnStartMessageId: 'tg4', startRow: 100, endRow: 200 }], segGDir);
      const item = out[0]?.items[0];
      const exp = (diffCore?.diffFull as DiffFullFn | undefined)?.('BASE\n', 'BASE\nv1\nv2\n', pUpper);
      const ok = out.length === 1 && out[0]!.items.length === 1
        && item?.path === pUpper && item?.mode === 'full' && item?.writeCount === 2
        && item?.additions === (exp?.additions ?? -1) && item?.deletions === (exp?.deletions ?? -1);
      check('G④', '聚合合并：同回合两行同文件（大小写变体，cwd=临时目录）→ items 仅 1 条、writeCount=2、mode=full、± 为合并行集净差（diffFull(BASE, BASE v1 v2)）、item.path=首行原文',
        ok, `out=${JSON.stringify(out)} exp=${JSON.stringify(exp)}`);
    }

    // e) G⑤ getPatch 双拼写（真实临时库，G④ 同款数据落库；session.working_dir=临时目录）：
    //    pUpper 与其正斜杠变体调 getPatch → 命中同组、同一 patch（diff-core 文件头把反斜杠归一为
    //    正斜杠，两拼写头一致 → 逐字节相等）、mode 一致（均 full）；再用 pLower 调一次 → mode 一致、
    //    patch 正文（剥 ---/+++ 头）逐行相同（头路径按 display 原文呈现，大小写不折叠是既有设计）。
    {
      const sid = 'sess-g-patch';
      const segGDir5 = path.join(stubUserDataDir, 'seg-g-files');
      const pUpper5 = path.join(segGDir5, 'GCase.txt');
      const pLower5 = path.join(segGDir5, 'gcase.txt');
      db.prepare("INSERT INTO sessions (id, name, model, working_dir) VALUES (?, '段G-getPatch双拼写', 'claude-sonnet-4-6', ?)").run(sid, segGDir5);
      const insMsgG = db.prepare('INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, ?, ?, ?)');
      insMsgG.run('gu5-pre', sid, 'assistant', '轮前基线写', null);
      insMsgG.run('gu5-u1', sid, 'user', '第一轮', null);
      insMsgG.run('gu5-m1', sid, 'assistant', '写1', null);
      insMsgG.run('gu5-m2', sid, 'assistant', '写2', null);
      const insertCkG = checkpointRepo?.insert as ((row: Record<string, unknown>) => unknown) | undefined;
      if (typeof insertCkG !== 'function') throw new Error('repo.insert 不可用');
      const ckG = (messageId: string, p: string, after: string): void => {
        insertCkG({
          session_id: sid, message_id: messageId, path: p, tool_name: 'Write',
          tool_use_id: `tu-g5-${messageId}`, input_json: JSON.stringify({ file_path: p, content: after }),
          input_truncated: 0, after_content: after, after_truncated: 0, binary: 0, snapshot_state: 'disk',
        });
      };
      ckG('gu5-pre', pUpper5, 'BASE\n');
      ckG('gu5-m1', pUpper5, 'BASE\nv1\n');
      ckG('gu5-m2', pLower5, 'BASE\nv1\nv2\n');
      const getPatchG = turnDiffMod!.getPatch as GetPatchFn;
      const rUp = getPatchG(sid, 'gu5-u1', null, pUpper5);
      const rFwd = getPatchG(sid, 'gu5-u1', null, pUpper5.replace(/\\/g, '/'));
      const rLow = getPatchG(sid, 'gu5-u1', null, pLower5);
      check('G⑤', 'getPatch 双拼写：pUpper 与正斜杠变体 → 同一 patch（逐字节）、mode 一致（均 full）；pLower → mode 一致、patch 正文（剥文件头）逐行相同',
        rUp.mode === 'full' && rFwd.mode === rUp.mode && rLow.mode === rUp.mode
          && rUp.patch === rFwd.patch
          && JSON.stringify(patchBodyG(rUp.patch)) === JSON.stringify(patchBodyG(rLow.patch))
          && rUp.patch.split('\n').includes('+v2'),
        `rUp=${JSON.stringify(rUp).slice(0, 240)} rFwd=${JSON.stringify(rFwd).slice(0, 240)} rLow=${JSON.stringify(rLow).slice(0, 240)}`);
    }

    // f) G⑥ cwd=null 回归钉（计划 §3.6 G⑥，既有段D 用例天然覆盖、此条显式钉）：
    //    ①纯函数不传 cwd——D① 同款同拼写数据，结果与现状逐字节一致（patch 与 diffFull 全等）；
    //    ②working_dir 为 NULL 的会话（sessions 默认不填 working_dir）listSummaries 照常聚合不回归。
    {
      const rows = [
        mkRow(1, { mrow: 10, path: 'A', after_content: 'alpha\n' }),
        mkRow(2, { mrow: 101, path: 'A', after_content: 'alpha\nv1\n' }),
        mkRow(3, { mrow: 102, path: 'A', after_content: 'alpha\nv2-mid\n' }),
        mkRow(4, { mrow: 103, path: 'A', after_content: 'alpha\nbeta\n' }),
      ];
      const fr = fileDiffCwdG(rows, 100, 200, 'A'); // 不传 cwd（缺省 null）
      const exp = (diffCore?.diffFull as DiffFullFn | undefined)?.('alpha\n', 'alpha\nbeta\n', 'A');
      const out = aggregateCwdG(rows, [{ turnStartMessageId: 'tg6', startRow: 100, endRow: 200 }]); // 不传 cwd
      const pureOk = fr.mode === 'full' && fr.writeCount === 3 && fr.truncated === false
        && exp !== undefined && fr.patch === exp.patch && fr.additions === exp.additions && fr.deletions === exp.deletions
        && out.length === 1 && out[0]!.items.length === 1
        && out[0]!.items[0]!.writeCount === 3 && out[0]!.items[0]!.mode === 'full';

      const sid = 'sess-g-nullcwd';
      db.prepare("INSERT INTO sessions (id, name, model) VALUES (?, '段G-working_dir-NULL', 'claude-sonnet-4-6')").run(sid); // working_dir 默认 NULL
      const insMsgG6 = db.prepare('INSERT INTO messages (id, session_id, role, content, parent_agent_id) VALUES (?, ?, ?, ?, ?)');
      insMsgG6.run('gu6-pre', sid, 'assistant', '轮前基线写', null);
      insMsgG6.run('gu6-u1', sid, 'user', '第一轮', null);
      insMsgG6.run('gu6-m1', sid, 'assistant', '写1', null);
      const insertCkG6 = checkpointRepo?.insert as ((row: Record<string, unknown>) => unknown) | undefined;
      if (typeof insertCkG6 !== 'function') throw new Error('repo.insert 不可用');
      const ckG6 = (messageId: string, p: string, after: string): void => {
        insertCkG6({
          session_id: sid, message_id: messageId, path: p, tool_name: 'Write',
          tool_use_id: `tu-g6-${messageId}`, input_json: JSON.stringify({ file_path: p, content: after }),
          input_truncated: 0, after_content: after, after_truncated: 0, binary: 0, snapshot_state: 'disk',
        });
      };
      ckG6('gu6-pre', 'SG6.txt', 'S0\n');
      ckG6('gu6-m1', 'SG6.txt', 'S1\n');
      const listSummariesG6 = turnDiffMod!.listSummaries as ListSummariesFn;
      const out6 = listSummariesG6(sid);
      const item6 = out6[0]?.items[0];
      const dbOk = out6.length === 1 && item6?.path === 'SG6.txt' && item6?.mode === 'full'
        && item6?.writeCount === 1 && item6?.additions === 1 && item6?.deletions === 1;
      check('G⑥', 'cwd=null 回归：不传 cwd 直调 computeFileDiff/aggregate → 同拼写行为与现状逐字节一致（patch 与 diffFull 全等、writeCount=3）；working_dir NULL 会话 listSummaries 照常聚合不回归',
        pureOk && dbOk, `pure: fr=${JSON.stringify(fr)} out=${JSON.stringify(out)}；db: out=${JSON.stringify(out6)}`);
    }

    // g) G⑦ pathKey 语义收紧（备忘-1+2）：win32 下 UNC 两拼写（\\srv\share\f.txt 折叠后 //srv/share/f.txt）
    //    同键且视为绝对不前置 cwd；POSIX 上反斜杠是合法文件名字符，不与斜杠子路径折叠同键。
    {
      const uBack = pathKeyG('\\\\srv\\share\\f.txt', null, 'win32'); // TS 字面量，实际值 \\srv\share\f.txt
      const uFwd = pathKeyG('//srv/share/f.txt', null, 'win32');
      const uCwd = pathKeyG('\\\\srv\\share\\f.txt', '/w', 'win32');
      const pBack = pathKeyG('weird\\name.ts', null, 'linux');
      const pFwd = pathKeyG('weird/name.ts', null, 'linux');
      check('G⑦', 'pathKey win32：UNC 两拼写同键且不被前置 cwd；linux：含反斜杠文件名与斜杠子路径不同键',
        uBack === uFwd && uCwd === uBack && pBack !== pFwd,
        `unc: [${uBack}] vs [${uFwd}]；unc+cwd=/w: [${uCwd}]；linux: [${pBack}] vs [${pFwd}]`);
    }
  } catch (e) {
    fail += 1;
    console.log(`  ❌ 段G 异常：${errMsg(e)}`);
  }
}

runSegmentG();

// ── 后续点追加区 ──
// 段C 与段F（点A）均为异步收尾段（快照是 fire-and-forget 续体），故 finish 统一在 .then 里
// 收口清理与汇总；段F 续在段C 之后、清理之前执行（依赖临时库与临时目录仍存活）。

void runSegmentC()
  .catch((e: unknown) => {
    fail += 1;
    console.log(`  ❌ 段C 异步驱动异常：${errMsg(e)}`);
  })
  .then(() => runSegmentF())
  .catch((e: unknown) => {
    fail += 1;
    console.log(`  ❌ 段F 异步驱动异常：${errMsg(e)}`);
  })
  .then(() => {
    // 先放掉 db 句柄再删目录：段A/段C/段D（含 checkpointRepo/turn-diff-checkpoint/turn-diff）
    // 共用 connection.ts 的 getConnection() 单例连接；Windows 上未关闭的 better-sqlite3 句柄
    // （claude-link.db 及 WAL/SHM）会让尾部 rmSync 报 EBUSY/EPERM、留下 tmp-userdata-* 残留。
    // 其余临时句柄均已用毕即关（probe: ABI 预检后 close；legacy: v14 升级用例后 close）。
    try { connectionMod.closeConnection(); } catch { /* 尽力关闭 */ }
    try { fs.rmSync(stubUserDataDir, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    try { fs.rmSync(path.dirname(stubUserDataDir), { recursive: true, force: true }); } catch { /* 尽力清理 */ }

    console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
    if (fail > 0) {
      process.exit(1);
    }
    console.log('OK');
  });
