// scripts/tdd-bugfix-hb10-single-instance-verify.ts
// hb10 P2-5（CFG-02+SHL-02）契约：无单实例锁（同根一处修复收两域）。
//
// 病根：src/main/index.ts whenReady 前无 requestSingleInstanceLock——双实例并行会双写同一 SQLite
// （bus error/锁冲突），且 disposeExportTempDirsSync/cleanupStaleTempDirs 跨实例互删对方在用的
// 导出临时目录。
// 修法：模块顶层（app ready 之前）requestSingleInstanceLock；失败（已有实例）→ app.quit() 且
// 不执行任何初始化（runMigrations 不得触达）；成功 → second-instance 事件聚焦既有窗口；
// whenReady 主体包进 gotLock 守卫。dev 与打包同锁（userData 级）；隔离实例（--user-data-dir）
// 天然不受影响。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-single-instance-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const mainIndex = fs.readFileSync(path.join(repoRoot, 'src/main/index.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 锁调用位于模块顶层（whenReady 之前）。
check('① 模块顶层 requestSingleInstanceLock（app ready 之前）+ 失败即 quit', () => {
  const lockIdx = mainIndex.indexOf('app.requestSingleInstanceLock()');
  const readyIdx = mainIndex.indexOf('app.whenReady()');
  assert.ok(lockIdx > -1, '缺 requestSingleInstanceLock 调用');
  assert.ok(readyIdx > lockIdx, '锁调用必须位于 whenReady 之前（初始化前裁决）');
  assert.match(mainIndex, /if \(!gotLock\) \{\s*app\.quit\(\);/, '锁失败路径缺 app.quit()');
});

// ② 锁失败路径不执行任何初始化（whenReady 主体被守卫包裹）。
check('② whenReady 主体包进 gotLock 守卫（锁失败不触达 runMigrations/DB）', () => {
  const readyIdx = mainIndex.indexOf('app.whenReady()');
  const body = mainIndex.slice(readyIdx, mainIndex.indexOf('app.on(\'window-all-closed\''));
  const guardIdx = body.indexOf('if (!gotLock) return;');
  assert.ok(guardIdx > -1, 'whenReady 回调缺 gotLock 早退守卫');
  const migrateIdx = body.indexOf('runMigrations(');
  assert.ok(migrateIdx > guardIdx, 'runMigrations 必须位于锁守卫之后（防双写 DB）');
});

// ③ second-instance 聚焦既有窗口。
check('③ second-instance：聚焦既有窗口（restore/show/focus），不产生第二进程', () => {
  assert.match(mainIndex, /app\.on\('second-instance'/, '缺 second-instance 处理');
  const idx = mainIndex.indexOf("app.on('second-instance'");
  const body = mainIndex.slice(idx, mainIndex.indexOf('\n});', idx));
  assert.match(body, /isMinimized\(\)/, '缺最小化 restore');
  assert.match(body, /\.focus\(\)/, '缺 focus');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
