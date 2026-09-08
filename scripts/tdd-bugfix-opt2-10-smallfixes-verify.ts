// tdd-bugfix-opt2-10-smallfixes-verify.ts
// OPT-2..OPT-10 契约钉（合并脚本）：
//   OPT-2 result 落库去重改窄查询 getRecentMessagesForTurnCheck（尾部 50、窄列，语义不变）；
//   OPT-3 resolveExecutable 结果缓存（CONFIG_SAVE 失效、失败不缓存）；
//   OPT-4 连接测试临时目录清理（finishWith / abortActiveTest 收口）；
//   OPT-5 post-turn runtime 快照成功也持久化 last_context_used；
//   OPT-6 聊天列表跟底滚动 + 回底按钮（ResizeObserver + nearBottom 不抢滚动）；
//   OPT-7 队列面板倒计时人类可读（formatCountdownHuman）；
//   OPT-8 messages.parent_task_id 索引（V10 + CURRENT_SCHEMA_VERSION=10）；
//   OPT-9 导出资源回收（before-quit 同步清临时目录 + 固定 partition 复用）；
//   OPT-10 死代码与双份常量清理（MODEL_OVERRIDE 链删除、api_retry 死分支删除、六开关单常量）。
//
// 运行：npx tsx scripts/tdd-bugfix-opt2-10-smallfixes-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

// OPT-2
const cliShared = read('src/main/modules/cli-shared.ts');
const messageRepo = read('src/main/database/repositories/message-repo.ts');
check('OPT-2① repo 新增窄查询（尾部 50、窄列、rowid DESC）', () => {
  assert.match(messageRepo, /export function getRecentMessagesForTurnCheck\(sessionId: string, limit = 50\)/);
  assert.match(messageRepo, /ORDER BY created_at DESC, rowid DESC LIMIT \?/);
});
check('OPT-2② 两个去重谓词改用窄查询', () => {
  // OPT-2 补口同步（窗口打满回落全量兜底）：两谓词共用 turnCheckRows（内走窄查询）。
  const hits = cliShared.match(/turnCheckRows\(sessionId\)/g) ?? [];
  assert.ok(hits.length >= 2);
  assert.match(cliShared, /getRecentMessagesForTurnCheck\(sessionId, TURN_CHECK_WINDOW\)/);
});

// OPT-3
const backend = read('src/main/modules/sdk-backend.ts');
check('OPT-3 resolveExecutable 缓存 + CONFIG_SAVE 失效', () => {
  assert.match(backend, /const resolveExecutableCache = new Map<string, string \| undefined>\(\);/);
  assert.match(backend, /if \(resolved\) resolveExecutableCache\.set\(cmd, resolved\);/);
  assert.match(backend, /onConfigSaved\(\(\) => \{\s*resolveExecutableCache\.clear\(\);\s*\}\);/s);
});

// OPT-4
const tester = read('src/main/modules/connection-tester.ts');
check('OPT-4 测试临时目录落定/被取代双路径清理', () => {
  assert.match(tester, /function cleanupTestCwd/);
  assert.match(tester, /cleanupTestCwd\(testCwd\);/);
  assert.match(tester, /cleanupTestCwd\(active\.cwd\);/);
});

// OPT-5
check('OPT-5 post-turn runtime 成功持久化 last_context_used', () => {
  assert.match(backend, /opts\.samplePhase === 'post-turn' && used != null && capacity != null/);
  assert.match(backend, /sessionRepo\.updateLastContextUsed\(sessionId, used, capacity, Date\.now\(\)\);/);
});

// OPT-6
const messageList = read('src/renderer/components/chat/MessageList.vue');
check('OPT-6 跟底滚动 + 回底按钮（ResizeObserver/nearBottom/按钮）', () => {
  assert.match(messageList, /new ResizeObserver/);
  assert.match(messageList, /const nearBottom = ref\(true\);/);
  assert.match(messageList, /distance < 80/);
  assert.match(messageList, /showBackToBottom/);
  assert.match(messageList, /@scroll\.passive="onScroll"/);
});

// OPT-7
const queueEta = read('src/shared/queue-eta.ts');
const panel = read('src/renderer/components/task/TaskQueuePanel.vue');
check('OPT-7 formatCountdownHuman 导出 + 面板复用（两处裸秒消除）', () => {
  assert.match(queueEta, /export function formatCountdownHuman/);
  assert.match(panel, /formatCountdownHuman\(state\.countdownRemaining\)/);
  assert.match(panel, /formatCountdownHuman\(cd\)/);
  assert.ok(!panel.includes('${cd}s'), '裸秒分支应删除');
});

// OPT-8
const migrations = read('src/main/database/migrations.ts');
check('OPT-8 V10 索引迁移 + 版本 12', () => {
  assert.match(migrations, /CURRENT_SCHEMA_VERSION = 12;/);
  assert.match(migrations, /CREATE INDEX IF NOT EXISTS idx_messages_parent_task ON messages\(parent_task_id\);/);
});

// OPT-9
const exportMgr = read('src/main/modules/export-image-manager.ts');
const mainIndex = read('src/main/index.ts');
check('OPT-9① before-quit 同步清导出临时目录', () => {
  assert.match(exportMgr, /export function disposeExportTempDirsSync\(\): void/);
  assert.match(mainIndex, /disposeExportTempDirsSync\(\);/);
  assert.ok(!mainIndex.includes('void disposeExportImageOnQuit()'), 'void 异步调用应替换');
});
check('OPT-9② 固定 partition 复用', () => {
  assert.match(exportMgr, /fromPartition\(`claude-link-export`/);
  assert.ok(!exportMgr.includes('claude-link-export-${jobId}'));
});

// OPT-10
check('OPT-10① SESSION_UPDATE_MODEL_OVERRIDE 死链删除', () => {
  for (const f of ['src/main/ipc-handlers.ts', 'src/preload/api.ts', 'src/shared/types/ipc.ts', 'src/renderer/stores/session-store.ts']) {
    assert.ok(!read(f).includes('SESSION_UPDATE_MODEL_OVERRIDE'), f + ' 仍有残留');
  }
  assert.ok(!read('src/main/database/repositories/session-repo.ts').includes('export function updateModelOverride'));
});
check('OPT-10② use-chat api_retry 死分支删除', () => {
  assert.ok(!read('src/renderer/composables/use-chat.ts').includes('API 重试中（第'));
});
check('OPT-10③ 六开关单一常量（两通道共用）', () => {
  const constants = read('src/shared/constants.ts');
  assert.match(constants, /export const ENGINE_BACKGROUND_TOGGLE_ENV/);
  assert.match(cliShared, /for \(const \[envKey, configKey\] of ENGINE_BACKGROUND_TOGGLE_ENV\)/);
  assert.match(backend, /for \(const \[envKey, configKey\] of ENGINE_BACKGROUND_TOGGLE_ENV\)/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
