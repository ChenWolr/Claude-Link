// tdd-bridge-binding-repo-verify.ts
// 计划 docs/plans/2026-09-21-im-bridge-feishu-wechat-plan.md Task 2 契约钉：
//   A. V13 迁移：真实 runMigrations 建出 bridge_bindings（列集齐全），重复迁移幂等。
//   B. binding-repo：upsert 新建 / 同 sessionKey 幂等覆盖、get 命中/未命中 null、
//      rebind 换 sessionId、touch 更新 lastActiveAt、delete 清除、listBindings 全量。
//   C. 级联：PRAGMA foreign_keys=ON 下删 sessions 行 → bridge_bindings 行跟随消失。
// 生命周期修复计划追加（docs/plans/2026-09-22-im-bridge-lifecycle-ux-fix-plan.md 批次1）：
//   A⑤⑥. V14 迁移：bridge_bindings 加 unbound_at 列；V13→V14 升级路径（老库跑 runMigrations 补列）。
//   B⑩-⑭. 解绑墓碑：deleteBinding=UPDATE 置 unbound_at（行保留、get/list 不可见、isUnbound=true、
//          幂等不刷新时间戳）；upsert ON CONFLICT 清墓碑（/new 复活）；touch 不触碰墓碑行。
// 2026-09-23 微信扫码重连修复计划追加：D. purgeTombstonesByPlatform 只删指定平台墓碑行
//   （活跃行/异平台墓碑不动）、删后 isUnbound=false 且 getBinding=null（走无绑定自动重建路径）、
//   幂等、返回删除行数。
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

  // V14：解绑墓碑列。fresh 库经 runMigrations 后 bridge_bindings 须有 unbound_at（可空 INTEGER）。
  const cols14 = (db.prepare('PRAGMA table_info(bridge_bindings)').all() as { name: string }[]).map((c) => c.name);
  check('A', '⑤', 'V14：bridge_bindings 有 unbound_at 列（fresh 库迁移后）', cols14.includes('unbound_at'),
    `实际列=[${cols14.join(',')}]`);

  // V13→V14 升级路径：老库（版本已 13、表无 unbound_at）跑 runMigrations 补列且不抛。
  // 手法：迁移到 V14 后 DROP COLUMN 回退列、版本号手拨回 13，再跑 runMigrations。
  const sqliteVer = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
  const [major] = sqliteVer.split('.').map((n) => parseInt(n, 10));
  if (major! >= 3 && parseInt(sqliteVer.split('.')[1]!, 10) >= 35) {
    let upgradeThrew = '';
    try {
      db.exec('ALTER TABLE bridge_bindings DROP COLUMN unbound_at');
      db.prepare('UPDATE schema_version SET version = 13').run();
      runMigrations(db);
    } catch (e) { upgradeThrew = e instanceof Error ? e.message : String(e); }
    const colsAfter = (db.prepare('PRAGMA table_info(bridge_bindings)').all() as { name: string }[]).map((c) => c.name);
    check('A', '⑥', 'V13→V14 升级路径：老库（无 unbound_at、版本 13）迁移补列不抛',
      upgradeThrew === '' && colsAfter.includes('unbound_at'),
      `threw=${upgradeThrew.slice(0, 160)} 列=[${colsAfter.join(',')}]`);
  } else {
    check('A', '⑥', 'V13→V14 升级路径（跳过：SQLite < 3.35 无 DROP COLUMN）', true);
  }
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
  check('B', '⑨', 'deleteBinding（V14=置解绑墓碑）后 get 未命中且 list 不再返回',
    bindingRepo.getBindingBySessionKey(db, 'wx_dm_wxid_1') === null
    && (bindingRepo.listBindings(db) as unknown[]).length === 1,
    `剩余=${JSON.stringify(bindingRepo.listBindings(db))}`);

  // ── 解绑墓碑（生命周期修复计划批次1：deleteBinding 语义 DELETE→UPDATE 置 unbound_at）──
  const rawTomb = db.prepare("SELECT unbound_at FROM bridge_bindings WHERE session_key = 'wx_dm_wxid_1'").get() as
    | { unbound_at: number | null }
    | undefined;
  check('B', '⑩', '解绑墓碑：行仍物理保留且 unbound_at 非空 + isUnbound=true',
    !!rawTomb && typeof rawTomb.unbound_at === 'number' && rawTomb.unbound_at > 0
    && bindingRepo.isUnbound(db, 'wx_dm_wxid_1') === true,
    `行=${JSON.stringify(rawTomb)} isUnbound=${bindingRepo.isUnbound(db, 'wx_dm_wxid_1')}`);
  check('B', '⑪', 'isUnbound：未绑定/未解绑 key → false',
    bindingRepo.isUnbound(db, 'wx_dm_nobody') === false && bindingRepo.isUnbound(db, 'fs_dm_ou_abc') === false);

  // 幂等：已墓碑行重复 delete 不刷新时间戳。
  db.prepare("UPDATE bridge_bindings SET unbound_at = 12345 WHERE session_key = 'wx_dm_wxid_1'").run();
  bindingRepo.deleteBinding(db, 'wx_dm_wxid_1');
  const tombAfter = db.prepare("SELECT unbound_at FROM bridge_bindings WHERE session_key = 'wx_dm_wxid_1'").get() as
    | { unbound_at: number };
  check('B', '⑫', 'deleteBinding 幂等：已墓碑行重复解绑不刷新 unbound_at（仍 12345）',
    tombAfter.unbound_at === 12345, `实际=${String(tombAfter.unbound_at)}`);

  // touch 不触碰墓碑行。
  db.prepare("UPDATE bridge_bindings SET unbound_at = 12345, last_active_at = 999 WHERE session_key = 'wx_dm_wxid_1'").run();
  bindingRepo.touchBinding(db, 'wx_dm_wxid_1');
  const touchedTomb = db.prepare("SELECT last_active_at FROM bridge_bindings WHERE session_key = 'wx_dm_wxid_1'").get() as
    | { last_active_at: number };
  check('B', '⑬', 'touchBinding 不推进墓碑行 last_active_at（WHERE 过滤）',
    touchedTomb.last_active_at === 999, `实际=${String(touchedTomb.last_active_at)}`);

  // upsert 清墓碑（/new 复活语义）：同 key 重新绑定 → unbound_at 归 NULL。
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_wxid_1', userId: 'wxid_1',
    chatId: 'wxid_1', displayName: null, sessionId: 'sess-b',
  });
  const revived = bindingRepo.getBindingBySessionKey(db, 'wx_dm_wxid_1');
  check('B', '⑭', 'upsert ON CONFLICT 清墓碑复活（/new 语义）：get 命中且 isUnbound=false',
    !!revived && bindingRepo.isUnbound(db, 'wx_dm_wxid_1') === false,
    `实际=${JSON.stringify(revived)} isUnbound=${bindingRepo.isUnbound(db, 'wx_dm_wxid_1')}`);
  // 复活后还原为墓碑态，免影响 C 组级联断言基线（C 只动 sess-a，此处仅还原可见性基线）。
  bindingRepo.deleteBinding(db, 'wx_dm_wxid_1');

  // ── wechat owner 存量迁移查询（生命周期修复批次5.2-4）──
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_old', userId: 'wxid_older',
    chatId: 'wxid_older', displayName: null, sessionId: 'sess-b',
  });
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_new', userId: 'wxid_newest',
    chatId: 'wxid_newest', displayName: null, sessionId: 'sess-b',
  });
  db.prepare("UPDATE bridge_bindings SET last_active_at = 100 WHERE session_key = 'wx_dm_old'").run();
  db.prepare("UPDATE bridge_bindings SET last_active_at = 200 WHERE session_key = 'wx_dm_new'").run();
  check('B', '⑮', 'getLatestBindingUserIdByPlatform：返回 wechat last_active_at 最新行 user_id',
    bindingRepo.getLatestBindingUserIdByPlatform(db, 'wechat') === 'wxid_newest'
    && bindingRepo.getLatestBindingUserIdByPlatform(db, 'feishu') === 'ou_abc',
    `wechat=${bindingRepo.getLatestBindingUserIdByPlatform(db, 'wechat')} feishu=${bindingRepo.getLatestBindingUserIdByPlatform(db, 'feishu')}`);
  // 墓碑行不参与：把最新行置为解绑 → 回退次新行。
  bindingRepo.deleteBinding(db, 'wx_dm_new');
  check('B', '⑯', 'getLatestBindingUserIdByPlatform：墓碑行不参与（回退次新活跃行）',
    bindingRepo.getLatestBindingUserIdByPlatform(db, 'wechat') === 'wxid_older',
    String(bindingRepo.getLatestBindingUserIdByPlatform(db, 'wechat')));
  // 清理迁移测试行，免影响 C 组。
  db.prepare("DELETE FROM bridge_bindings WHERE session_key IN ('wx_dm_old', 'wx_dm_new')").run();
}

// ── C. 级联删除 ──
{
  db.prepare('DELETE FROM sessions WHERE id = ?').run('sess-a');
  check('C', '①', '删除 sessions 行 → bridge_bindings 级联消失',
    bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc') === null,
    `实际=${JSON.stringify(bindingRepo.getBindingBySessionKey(db, 'fs_dm_ou_abc'))}`);
}

// ── D. purgeTombstonesByPlatform（2026-09-23 微信扫码重连修复）：只删指定平台墓碑行、
// 活跃行与异平台墓碑不动、删后走「无绑定+无墓碑」自动重建路径、幂等、返回删除行数。──
{
  // 预置前清残留：B 组按契约故意遗留 wx_dm_wxid_1 微信墓碑行（墓碑断言基线），
  // 会混入 D④ 删除计数——此处物理清全部墓碑行，使 D④ 计数封闭（不改 A/B/C 断言）。
  db.prepare('DELETE FROM bridge_bindings WHERE unbound_at IS NOT NULL').run();
  // 预置：1 个 wechat 活跃绑定 A + 1 个 wechat 墓碑行 B + 1 个 feishu 墓碑行 C（均需 sessions 外键）。
  db.prepare("INSERT INTO sessions (id, name, model) VALUES ('sess-d', '会话D', 'sonnet')").run();
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_u1', userId: 'wxid_u1',
    chatId: 'wxid_u1', displayName: null, sessionId: 'sess-d',
  });
  bindingRepo.upsertBinding(db, {
    platform: 'wechat', sessionKey: 'wx_dm_u2', userId: 'wxid_u2',
    chatId: 'wxid_u2', displayName: null, sessionId: 'sess-d',
  });
  bindingRepo.deleteBinding(db, 'wx_dm_u2'); // B → 墓碑
  bindingRepo.upsertBinding(db, {
    platform: 'feishu', sessionKey: 'fs_dm_u3', userId: 'ou_u3',
    chatId: 'oc_u3', displayName: null, sessionId: 'sess-d',
  });
  bindingRepo.deleteBinding(db, 'fs_dm_u3'); // C → 墓碑

  const purged = bindingRepo.purgeTombstonesByPlatform(db, 'wechat');

  // D④：返回值 = 恰好删掉的 wechat 墓碑行数（feishu 墓碑不计入）。
  check('D', '④', 'purgeTombstonesByPlatform 返回删除行数（恰 1，异平台墓碑不计入）', purged === 1, String(purged));
  // D①：跨平台隔离——wechat 墓碑 B 消失、活跃行 A 仍在、feishu 墓碑 C 仍是墓碑态。
  const rowB = db.prepare("SELECT * FROM bridge_bindings WHERE session_key = 'wx_dm_u2'").get();
  check('D', '①', 'purge 只删 wechat 墓碑：B 行消失、活跃行 A 仍在、feishu 墓碑 C 不动',
    rowB === undefined
    && bindingRepo.getBindingBySessionKey(db, 'wx_dm_u1') !== null
    && bindingRepo.isUnbound(db, 'fs_dm_u3') === true,
    `B行=${JSON.stringify(rowB)} A可见=${bindingRepo.getBindingBySessionKey(db, 'wx_dm_u1') !== null} C墓碑=${bindingRepo.isUnbound(db, 'fs_dm_u3')}`);
  // D②：物理删除 ≠ 复活——删后 isUnbound=false 且 getBinding=null（flush 走无绑定自动重建路径）。
  check('D', '②', 'purge 后 B 键 isUnbound=false 且 getBinding=null（无绑定+无墓碑 → 自动重建路径）',
    bindingRepo.isUnbound(db, 'wx_dm_u2') === false
    && bindingRepo.getBindingBySessionKey(db, 'wx_dm_u2') === null,
    `isUnbound=${bindingRepo.isUnbound(db, 'wx_dm_u2')} get=${JSON.stringify(bindingRepo.getBindingBySessionKey(db, 'wx_dm_u2'))}`);
  // D③：幂等——无墓碑时再跑不抛错且返回 0。
  let idemThrew = '';
  let purgedAgain = -1;
  try { purgedAgain = bindingRepo.purgeTombstonesByPlatform(db, 'wechat') as number; } catch (e) { idemThrew = e instanceof Error ? e.message : String(e); }
  check('D', '③', '无墓碑时再跑 purge 不抛错且返回 0（幂等）', idemThrew === '' && purgedAgain === 0,
    `threw=${idemThrew} 返回=${String(purgedAgain)}`);
}

console.log(`\n结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
