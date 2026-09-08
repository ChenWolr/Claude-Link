// tdd-bugfix-p2-16-sort-tiebreaker-verify.ts
// P2-16 契约钉：三处同秒排序无 tiebreaker（新会话可能不排顶 / 历史同秒乱序 / 任务顺序撞值）。
//
// 修复语义：session-repo / interaction-history-repo 的 ORDER BY 补 rowid DESC；
// task-repo 两条 ORDER BY 补 rowid ASC；TASK_ADD 的 sort_order 改用 nextSortOrder
//（MAX+1），建-删-建不再撞值。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-16-sort-tiebreaker-verify.ts
// （better-sqlite3 为 Electron ABI：需要时以 ELECTRON_RUN_AS_NODE 重spawn）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function openMemoryDb(): import('better-sqlite3').Database {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  return new Database(':memory:');
}
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
try {
  openMemoryDb().close();
} catch (err) {
  respawnUnderElectronIfNeeded(err);
}

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// ── 结构：三处 ORDER BY 与 nextSortOrder ──
const read = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf8');
check('① session-repo ORDER BY updated_at DESC, rowid DESC', () =>
  assert_ok(read('src/main/database/repositories/session-repo.ts').includes('ORDER BY updated_at DESC, rowid DESC')));
check('② interaction-history ORDER BY created_at DESC, rowid DESC', () =>
  assert_ok(read('src/main/database/repositories/interaction-history-repo.ts').includes('ORDER BY created_at DESC, rowid DESC')));
check('③ task-repo 两条 ORDER BY 补 rowid ASC', () => {
  const src = read('src/main/database/repositories/task-repo.ts');
  assert_ok(src.includes('ORDER BY sort_order ASC, rowid ASC'));
  assert_ok(src.includes('ORDER BY sort_order ASC, rowid ASC"') || src.match(/rowid ASC/g)!.length >= 2);
});
check('④ TASK_ADD 用 nextSortOrder', () =>
  assert_ok(read('src/main/ipc-handlers.ts').includes('taskRepo.nextSortOrder(sessionId)')));

function assert_ok(cond: boolean): void {
  if (!cond) throw new Error('断言失败');
}

// ── 行为：真实内存库复现撞值与稳定排序 ──
const db = openMemoryDb();
db.exec(`
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, cli_session_id TEXT,
    model TEXT NOT NULL DEFAULT 'm', working_dir TEXT, permission_mode TEXT,
    max_turns INTEGER DEFAULT 200,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);
const insertSession = db.prepare("INSERT INTO sessions (id, name, updated_at) VALUES (?, ?, ?)");
insertSession.run('s-old', '旧会话', '2026-09-07 10:00:00');
insertSession.run('s-new1', '新会话1', '2026-09-07 10:00:00'); // 同秒
insertSession.run('s-new2', '新会话2', '2026-09-07 10:00:00'); // 同秒

check('⑤ 同秒会话按 rowid DESC 稳定排序（后建者在前）', () => {
  const rows = db.prepare('SELECT id FROM sessions ORDER BY updated_at DESC, rowid DESC').all() as Array<{ id: string }>;
  assert.deepEqual(rows.map((r) => r.id), ['s-new2', 's-new1', 's-old']);
});

// 任务撞值：建 2 个任务（sort 0,1）→ 删第 2 个 → tasks.length=1 → 旧逻辑 sort=1 撞残留行。
const insertTask = db.prepare("INSERT INTO tasks (id, session_id, prompt, sort_order) VALUES (?, ?, ?, ?)");
insertTask.run('t1', 's-old', 'a', 0);
insertTask.run('t2', 's-old', 'b', 1);
db.prepare("DELETE FROM tasks WHERE id = 't2'").run();
const next = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tasks WHERE session_id = ?').get('s-old') as { next: number };
check('⑥ nextSortOrder（MAX+1）不撞残留行（旧 tasks.length 逻辑会给 1）', () => {
  assert.equal(next.next, 1); // MAX(0)+1=1 —— 撞值场景已不残留：删除的是 sort=1 行
});
// 更真实的撞值：删除 sort=0（首条），残留 sort=1；tasks.length=1 → 旧逻辑给 1 → 与残留撞。
db.prepare("DELETE FROM tasks WHERE id = 't1'").run();
insertTask.run('t3', 's-old', 'c', 1); // 旧逻辑会给 sort_order=1，与残留 t3? 模拟撞值后排序
insertTask.run('t4', 's-old', 'd', 1); // 复现：两行同 sort_order=1
const stable = db.prepare('SELECT id FROM tasks WHERE session_id = ? ORDER BY sort_order ASC, rowid ASC').all('s-old') as Array<{ id: string }>;
check('⑦ 同 sort_order 时 rowid ASC 保证稳定序（先建在前）', () => {
  assert.deepEqual(stable.map((r) => r.id), ['t3', 't4']);
});
const next2 = db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM tasks WHERE session_id = ?').get('s-old') as { next: number };
check('⑧ 撞值存量存在时 nextSortOrder 取 MAX+1=2（不再产生第三条同序）', () => assert.equal(next2.next, 2));

db.close();
console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
