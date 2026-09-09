// scripts/tdd-bugfix-b3-turn-endtime-bubble-verify.ts
// B3 契约：气泡脚注「去费用 + 结束时间永久落盘」。
//
// 需求（2026-09-09 用户截图）：消息气泡脚注（⏱ 2:02 · $0.0998）不再展示费用；
// 改为展示回合结束时间（结束于 HH:mm:ss），且该结束时间永久落盘（重启/切会话不丢）；
// 输入浮岛的「本次回复」行（TurnTimer 运行中/完成态）保持不变。
//
// 修复语义：messages 表新增 ended_at 列（epoch ms）——
// ① 迁移走 messages 历来惯例：初始建表 + 幂等自愈补列，**不升 schema 版本**
//   （升版必撞 regression-tests/pin 脚本一组版本号断言，messages 加列自 is_error 起
//   均为免升版自愈先例）；② 写路径：SESSION_RECORD_TURN_META handler 的 messages 半边
//   UPDATE 一并写 ended_at（渲染层本就上送 endedAt，B1 已有）；③ 读路径：Message/
//   RenderableMessage 增加 endedAt，历史回读/导出投影携带；④ 渲染层：attachResultMetadata
//   在内存消息上同步赋 endedAt（脚注即时可见，与 durationMs 同层、在持久化门控之外）；
//   MessageBubble 脚注去掉费用 span、门控收窄为 durationMs、追加「结束于」文案
//   （老消息无记录不显示，诚实不造数）。
//
// 运行：npx tsx scripts/tdd-bugfix-b3-turn-endtime-bubble-verify.ts
// （better-sqlite3 为 Electron ABI：需要时以 ELECTRON_RUN_AS_NODE 重spawn）

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const migrations = read('src/main/database/migrations.ts');
const messageRepo = read('src/main/database/repositories/message-repo.ts');
const exportImageShared = read('src/shared/export-image.ts');
const exportImageTypes = read('src/shared/types/export-image.ts');
const ipcHandlers = read('src/main/ipc-handlers.ts');
const useChat = read('src/renderer/composables/use-chat.ts');
const messageBubble = read('src/renderer/components/chat/MessageBubble.vue');
const turnTimer = read('src/renderer/components/chat/TurnTimer.vue');
const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };

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
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { runMigrations } = require('../src/main/database/migrations');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① migrations：messages 初始建表含 ended_at + 幂等自愈补列 + 不升版本（保持 12）。
check('① migrations：初始建表含 ended_at + 自愈块 hasMsgCol 守卫 ALTER + CURRENT_SCHEMA_VERSION 保持 12（不升版）', () => {
  const createIdx = migrations.indexOf('CREATE TABLE IF NOT EXISTS messages');
  assert.ok(createIdx > -1, '未找到 messages 初始建表');
  const createEnd = migrations.indexOf(')', migrations.indexOf('created_at', createIdx));
  const createBlock = migrations.slice(createIdx, createEnd);
  assert.match(createBlock, /ended_at INTEGER/, 'messages 初始建表缺 ended_at 列（新库首建即有）');
  assert.match(migrations, /if \(!hasMsgCol\('ended_at'\)\) \{\s*db\.exec\('ALTER TABLE messages ADD COLUMN ended_at INTEGER'\);/, '自愈块缺 ended_at 守卫 + ALTER（老库补列）');
  assert.match(migrations, /CURRENT_SCHEMA_VERSION = 12/, 'CURRENT_SCHEMA_VERSION 必须保持 12——messages 加列走自愈惯例，升版撞一组 pin 脚本');
});

// ② message-repo 写路径：updateResultMeta SQL 三列同写 + AND session_id 守卫 + meta 类型含 endedAt。
check('② message-repo：updateResultMeta 写 ended_at（AND session_id 守卫）+ meta 类型含 endedAt', () => {
  const fnIdx = messageRepo.indexOf('export function updateResultMeta');
  assert.ok(fnIdx > -1, '未找到 export function updateResultMeta');
  const nextExport = messageRepo.indexOf('export ', fnIdx + 10);
  const body = messageRepo.slice(fnIdx, nextExport > -1 ? nextExport : undefined);
  assert.match(body, /UPDATE messages SET cost_usd = \?, duration_ms = \?, ended_at = \? WHERE id = \? AND session_id = \?/, 'updateResultMeta SQL 必须三列同写（cost_usd/duration_ms/ended_at）且带 AND session_id 归属守卫');
  assert.match(body, /meta: \{ costUsd: number \| null; durationMs: number \| null; endedAt: number \| null \}/, 'updateResultMeta meta 参数类型缺 endedAt');
  assert.match(body, /r\.changes > 0/, 'updateResultMeta 应返回 changes > 0 布尔');
});

// ③ message-repo 读路径：MessageRow/toMessage/建消息返回值/导出窄投影（ExportMessageRow/toRenderable/SELECT）全链带 ended_at。
check('③ message-repo 读路径：MessageRow/toMessage/createMessage 返回/ExportMessageRow/toRenderable/SELECT 全链带 ended_at', () => {
  assert.match(messageRepo, /ended_at: number \| null;/, 'MessageRow/ExportMessageRow 缺 ended_at 字段');
  assert.match(messageRepo, /endedAt: row\.ended_at/, 'toMessage/toRenderable 缺 endedAt 映射');
  assert.match(messageRepo, /endedAt: null,/, 'createMessageWithAttachments 返回值缺 endedAt: null（新建消息尚未结束）');
  const selIdx = messageRepo.indexOf('getRenderableMessagesBySession');
  const selBlock = messageRepo.slice(selIdx, messageRepo.indexOf('}', messageRepo.indexOf('.all(', selIdx)));
  assert.match(selBlock, /SELECT id, session_id, role, content, event_type, cost_usd, duration_ms, ended_at,/, '导出窄投影 SELECT 未补 ended_at');
});

// ④ shared 类型与投影：RenderableMessage.endedAt + toRenderable 映射（聊天历史与导出快照共用契约）。
check('④ shared：RenderableMessage.endedAt 类型 + shared/export-image.ts toRenderable 映射', () => {
  assert.match(exportImageTypes, /endedAt: number \| null;/, 'RenderableMessage 缺 endedAt 必填字段');
  assert.match(exportImageShared, /endedAt: msg\.endedAt/, 'toRenderable 投影缺 endedAt');
});

// ⑤ ipc-handlers：messages 半边的 meta 携带 endedAt（渲染层 B1 起已上送，此处落到消息行）。
check('⑤ ipc-handlers：SESSION_RECORD_TURN_META 的 meta 三字段（costUsd/durationMs/endedAt）', () => {
  const hIdx = ipcHandlers.indexOf('IPC_CHANNELS.SESSION_RECORD_TURN_META');
  assert.ok(hIdx > -1, '未找到 SESSION_RECORD_TURN_META handler');
  const body = ipcHandlers.slice(hIdx, hIdx + 2600);
  assert.match(body, /const meta = \{ costUsd, durationMs, endedAt \};/, 'handler meta 必须携带 endedAt 落到 messages 行');
});

// ⑥ use-chat：attachResultMetadata 在内存消息上赋 endedAt（门控外、与 durationMs 同层——脚注即时可见）；
// endedAt 计算须先于 assistant 赋值；recordTurnMeta payload 仍带 endedAt（B1 持久化链不回退）。
check('⑥ use-chat：attachResultMetadata 内存赋 message.endedAt（门控外）+ recordTurnMeta payload 带 endedAt', () => {
  const frontIdx = useChat.indexOf('function attachResultMetadata');
  const frontEnd = useChat.indexOf('async function sendMessage');
  const front = useChat.slice(frontIdx, frontEnd > -1 ? frontEnd : undefined);
  assert.match(front, /message\.endedAt = endedAt;/, 'attachResultMetadata 缺内存 message.endedAt 赋值');
  const endedIdx = front.indexOf('const endedAt = Date.now()');
  const assignIdx = front.indexOf('message.endedAt = endedAt;');
  assert.ok(endedIdx > -1 && assignIdx > endedIdx, 'endedAt 计算必须先于 message.endedAt 赋值');
  // 门控外赋值：中断/错误回合的内存脚注行为保持不变（持久化仍走 isSuccessfulCliResult 门控）。
  const gateIdx = front.indexOf('if (sid && isSuccessfulCliResult(event)) {');
  assert.ok(gateIdx > assignIdx, 'message.endedAt 赋值必须在持久化门控之外（内存脚注行为不变）');
  assert.match(front, /endedAt,\s*\n\s*\}\)\.catch/, 'recordTurnMeta payload 缺 endedAt（B1 持久化链不得回退）');
});

// ⑦ MessageBubble：门控收窄为 durationMs + 无费用展示 + 结束于文案（老消息无记录不显示）。
check('⑦ MessageBubble：脚注门控仅 durationMs + 模板无 costUsd/$ + 「结束于」文案 + endedAtText 与 TurnTimer 同口径', () => {
  const tplIdx = messageBubble.indexOf('<template>');
  const tpl = messageBubble.slice(tplIdx);
  assert.match(tpl, /v-if="message\.durationMs" class="bubble__meta"/, '脚注门控必须收窄为 message.durationMs（cost 不再参与门控）');
  assert.ok(!tpl.includes('costUsd'), '模板不得再出现 costUsd（费用不展示）');
  // $ 检查只扫脚注块本身（模板其它处的 ${} 类绑定如 bubble--${role} 与费用无关）。
  const metaIdx = tpl.indexOf('class="bubble__meta"');
  const metaEnd = tpl.indexOf('</div>', metaIdx);
  const metaBlock = tpl.slice(metaIdx, metaEnd);
  assert.ok(!metaBlock.includes('$'), '脚注块不得出现 $ 字样（费用已移除）');
  assert.match(tpl, /结束于 \{\{ endedAtText \}\}/, '脚注缺「结束于」文案');
  assert.match(messageBubble, /toLocaleTimeString\('zh-CN', \{ hour12: false \}\)/, 'endedAtText 必须与 TurnTimer 完成态同口径（zh-CN 24 小时制）');
  assert.match(messageBubble, /bubble__meta-end/, '缺 bubble__meta-end 样式类');
  assert.ok(!messageBubble.includes('bubble__meta-cost'), '残留 bubble__meta-cost 样式（应已删除）');
});

// ⑧ TurnTimer 保持不变（用户明确要求：当前回合的结束时间与耗时展示不动）。
check('⑧ TurnTimer 不回退：本次回复 label + lastMeta 完成态 + 结束于 仍在（需求要求保持不变）', () => {
  assert.match(turnTimer, /本次回复/, 'TurnTimer 缺「本次回复」label（不得被本次改动波及）');
  assert.match(turnTimer, /v-else-if="lastMeta"/, 'TurnTimer 完成态分支丢失');
  assert.match(turnTimer, /结束于 \{\{ endClockText \}\}/, 'TurnTimer 完成态「结束于」丢失');
  assert.match(turnTimer, /formatDurationMs\(lastMeta\.durationMs\)/, 'TurnTimer 完成态耗时展示丢失');
});

// ⑨ 真库行为：新库首建即有列；「今日 schema 去列模拟老库」迁移自愈补列且版本不升；
// repo 源提取的 UPDATE SQL 在迁移后 schema 上可执行，ended_at 真实落盘 + AND session_id 守卫生效。
check('⑨ 真库：fresh 迁移含 ended_at；老库（去列）自愈补列且版本仍 12；UPDATE SQL 真实落盘 + 守卫', () => {
  const Database = require('better-sqlite3');
  // a) fresh：空库迁移后 messages 自带 ended_at。
  const fresh = new Database(':memory:');
  runMigrations(fresh);
  const cols = (db: import('better-sqlite3').Database): string[] =>
    (db.prepare('PRAGMA table_info(messages)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(cols(fresh).includes('ended_at'), 'fresh 库迁移后 messages 缺 ended_at');
  const versionOf = (db: import('better-sqlite3').Database): number =>
    (db.prepare('SELECT version FROM schema_version LIMIT 1').get() as { version: number }).version;
  assert.equal(versionOf(fresh), 12, 'fresh 库版本应为 12');

  // b) 老库模拟：先迁移出今日 schema，DROP COLUMN 模拟 B3 之前的库，再迁移 → 自愈补列、版本不升。
  fresh.exec('ALTER TABLE messages DROP COLUMN ended_at');
  runMigrations(fresh);
  assert.ok(cols(fresh).includes('ended_at'), '去列老库二次迁移未自愈补列');
  assert.equal(versionOf(fresh), 12, '自愈迁移不得升版本（保持 12）');

  // c) 行为：提取 repo 源中的 UPDATE 字面 SQL，在迁移后 schema 上执行——列存在、SQL 合法、守卫生效。
  const sqlMatch = messageRepo.match(/UPDATE messages SET cost_usd = \?, duration_ms = \?, ended_at = \? WHERE id = \? AND session_id = \?/);
  assert.ok(sqlMatch, 'repo 源未找到期望的 UPDATE SQL 形态');
  fresh.exec("INSERT INTO sessions (id, name) VALUES ('s1', '测试会话')");
  fresh.exec("INSERT INTO messages (id, session_id, role, content) VALUES ('m1', 's1', 'assistant', '正文')");
  const r1 = fresh.prepare(sqlMatch[0]).run(0.0998, 122000, 1757411299000, 'm1', 's1');
  assert.equal(r1.changes, 1, 'UPDATE 应命中 1 行');
  const row = fresh.prepare('SELECT cost_usd, duration_ms, ended_at FROM messages WHERE id = ?').get('m1') as {
    cost_usd: number; duration_ms: number; ended_at: number;
  };
  assert.equal(row.ended_at, 1757411299000, 'ended_at 未落盘');
  assert.equal(row.duration_ms, 122000, 'duration_ms 被误伤');
  // AND session_id 守卫：错 session 0 行。
  const r2 = fresh.prepare(sqlMatch[0]).run(null, null, null, 'm1', 'other-session');
  assert.equal(r2.changes, 0, 'session_id 不匹配必须 0 行（归属守卫）');
  fresh.close();
});

// ⑩ package.json：selftest:static 链入链（链尾）。
check('⑩ package.json：selftest:static 链包含 tdd-bugfix-b3-turn-endtime-bubble-verify.ts', () => {
  const chain = pkg.scripts['selftest:static'];
  assert.ok(chain, '未找到 selftest:static 脚本');
  assert.ok(chain.includes('tdd-bugfix-b3-turn-endtime-bubble-verify.ts'), 'selftest:static 未包含 B3 契约脚本');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
