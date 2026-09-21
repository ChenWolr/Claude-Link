// tdd-bridge-binding-repo-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 2 契约钉：
//   A. V13 迁移：真实 runMigrations 建出 bridge_bindings（列集齐全），重复迁移幂等。
//   B. binding-repo：upsert 新建 / 同 sessionKey 幂等覆盖、get 命中/未命中 null、
//      rebind 换 sessionId、touch 更新 lastActiveAt、delete 清除、listBindings 全量。
//   C. 级联：PRAGMA foreign_keys=ON 下删 sessions 行 → bridge_bindings 行跟随消失。
// RED 预期（未改树）：bridge_bindings 表不存在 / binding-repo 模块不存在 → FAIL。
// 运行：npx tsx scripts/tdd-bridge-binding-repo-verify.ts
// （better-sqlite3 为 Electron ABI：当前 node 不匹配时自动以 ELECTRON_RUN_AS_NODE 重 spawn 本脚本）

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';

type Db = import('better-sqlite3').Database;

function openMemoryDb(): Db {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const Database = require('better-sqlite3');
  return new Database(':memory:');
}

/** ABI 不匹配（node vs electron）时以 electron-as-node 重跑自身并透传退出码（p1-10 先例）。 */
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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const bindingRepo = require('../src/main/modules/bridge/binding-repo');

let pass = 0;
let fail = 0;
function check(group: string, no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ [${group}] ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ [${group}] ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

db.pragma('foreign_keys = ON');

// ── A. V13 迁移 ──
{
  let migrationThrew = '';
  try { runMigrations(db); } catch (e) { migrationThrew = e instanceof Error ? e.message : String(e); }
  check('A', '①', 'runMigrations 在 V13 下不抛错', migrationThrew === '', migrationThrew.slice(0, 160));

  const cols = (db.prepare('PRAGMA table_info(bridge_bindings)').all() as { name: string }[]).map((c) => c.name);
  const expectedCols = ['id', 'platform', 'session_key', 'user_id', 'chat_id', 'display_name', 'session_id', 'created_at', 'last_active_at'];
  check('A', '②', 'bridge_bindings 列集齐全（V13 建表）',
    expectedCols.every((c) => cols.includes(c)),
    `实际列=[${cols.join(',')}]`);
  const fk = (db.prepare('PRAGMA foreign_key_list(bridge_bindings)').all() as Array<{ table: string; to: string }>)[0];
  check('A', '③', 'session_id 外键引用 sessions(id)（级联删除前提）',
    !!fk && fk.table === 'sessions' && fk.to === 'id',
    `实际=${JSON.stringify(fk)}`);

  // 幂等重放：再跑一遍迁移不抛错、表仍在。
  let replayThrew = '';
  try { runMigrations(db); } catch (e) { replayThrew = e instanceof Error ? e.message : String(e); }
  check('A', '④', '迁移幂等重放不抛错', replayThrew === '', replayThrew.slice(0, 160));
}

// ── B. binding-repo 全函数 ──
{
  db.prepare("INSERT INTO sessions (id, name, model) VALUES ('sess-a', '会话A', 'sonnet')").run();
  db.prepare("INSERT INTO sessions (id, name, model) VALUES ('sess-b', '会话B', 'sonnet')").run();

  const created = bindingRepo.upsertBinding(db, {
    platform: 'feishu',
    sessionKey: 'fs_dm_ou_abc',
    userId: 'ou_abc',
    chatId: 'oc_chat_1',
    displayName: '张三',
    sessionId: 'sess-a',
  }) as { id: string; createdAt: number; lastActiveAt: number };
  check('B', '①', 'upsert 新建：返回完整 binding（id/createdAt/lastActiveAt 生成）',
    typeof created.id === 'string' && created.id.length > 0
    && typeof created.createdAt === 'number' && created.createdAt > 0
    && typeof created.lastActiveAt === 'number' && created.lastActiveAt > 0,
    `实际=${JSON.stringify(created)}`);

  const fetched = bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') as Record<string, unknown> | null;
  check('B', '②', 'getBindingBySessionKey 命中：字段往返一致',
    !!fetched && fetched.platform === 'feishu' && fetched.sessionKey === 'fs_dm_ou_abc'
    && fetched.userId === 'ou_abc' && fetched.chatId === 'oc_chat_1'
    && fetched.displayName === '张三' && fetched.sessionId === 'sess-a',
    `实际=${JSON.stringify(fetched)}`);
  check('B', '③', 'getBindingBySessionKey 未命中 → null',
    bindingRepo.getBindingBySessionKey(db, 'wx_dm_nobody') === null,
    `实际=${JSON.stringify(bindingRepo.getBindingBySessionKey(db, 'wx_dm_nobody'))}`);

  // 同 sessionKey 幂等覆盖：不新增行，更新 sessionId/chatId/displayName。
  bindingRepo.upsertBinding(db, {
    platform: 'feishu',
    sessionKey: 'fs_dm_ou_abc',
    userId: 'ou_abc',
    chatId: 'oc_chat_1',
    displayName: '张三三',
    sessionId: 'sess-b',
  });
  const count = (db.prepare('SELECT COUNT(*) AS n FROM bridge_bindings').get() as { n: number }).n;
  const after = bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') as Record<string, unknown> | null;
  check('B', '④', 'upsert 同 sessionKey 幂等覆盖（行数不变 + 字段更新）',
    count === 1 && after && after.sessionId === 'sess-b' && after.displayName === '张三三',
    `行数=${count} 实际=${JSON.stringify(after)}`);

  // /new：rebindSession 换绑新会话。
  const rebound = bindingRepo.rebindSession(db, 'fs_dm_ou_abc', 'sess-a');
  check('B', '⑤', 'rebindSession 换 sessionId 并返回更新后行',
    !!rebound && rebound.sessionId === 'sess-a',
    `实际=${JSON.stringify(rebound)}`);
  check('B', '⑥', 'rebindSession 未命中 → null',
    bindingRepo.rebindSession(db, 'wx_dm_nobody', 'sess-a') === null,
    `实际=${JSON.stringify(bindingRepo.rebindSession(db, 'wx_dm_nobody', 'sess-a'))}`);

  // touch：lastActiveAt 前移。
  const beforeTouch = (bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') as { lastActiveAt: number }).lastActiveAt;
  const bumped = beforeTouch - 60_000;
  db.prepare('UPDATE bridge_bindings SET last_active_at = ? WHERE session_key = ?').run(bumped, 'fs_dm_ou_abc');
  bindingRepo.touchBinding(db, 'fs_dm_ou_abc');
  const afterTouch = (bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') as { lastActiveAt: number }).lastActiveAt;
  check('B', '⑦', 'touchBinding 把 lastActiveAt 推进到当前时间', afterTouch >= bumped + 60_000,
    `before=${bumped} after=${afterTouch}`);

  // listBindings。
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_wxid_1', userId: 'wxid_1',
    chatId: 'wxid_1', displayName: null, sessionId: 'sess-b',
  });
  const all = bindingRepo.listBindings(db) as Array<{ sessionKey: string }>;
  check('B', '⑧', 'listBindings 返回全部绑定（含 displayName null 行）',
    all.length === 2 && all.some((b) => b.sessionKey === 'wx_dm_wxid_1'),
    `实际=${JSON.stringify(all)}`);

  bindingRepo.deleteBinding(db, 'wx_dm_wxid_1');
  check('B', '⑨', 'deleteBinding 清除后 get 未命中',
    bindingRepo.getBindingBySessionKey(db, 'wx_dm_wxid_1') === null
    && (bindingRepo.listBindings(db) as unknown[]).length === 1,
    `剩余=${JSON.stringify(bindingRepo.listBindings(db))}`);
}

// ── C. 级联删除 ──
{
  db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-a');
  check('C', '①', '删除 sessions 行 → bridge_bindings 级联消失',
    bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') === null,
    `实际=${JSON.stringify(bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc'))}`);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
