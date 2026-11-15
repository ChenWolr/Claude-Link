// scripts/tdd-command-probe-cwd-refresh-verify.ts
// 回路外既有缺陷修复回归契约（slate-ui-completion-1108-1428 round-001 点 E1 申报圈补丁，2026-11-09）：
// startCommandProbe 在飞复用分支吞掉 SESSION_UPDATE workingDir 重探。
//
// 缺陷（活体复现定位见 .plan-loop/slate-ui-completion-1108-1428/round-001/pE1-impl-report.md
// 「回路外既有缺陷修复」章节；前任升级提问探针证据 gates/pe1-commands-e2e*.log）：
//   ipc-handlers.ts SESSION_UPDATE 分支（F3：workingDir 变化 → startCommandProbe(id, mainWindow, { ...data })）
//   恰好撞上在飞探针时，复用分支 `await existing.donePromise; return;` 直接返回——本次调用
//   opts.workingDir（新目录）从未进入任何探测；旧探针以旧 cwd 定型已结束且无后继探针，新目录的
//   命令可见性重探诉求被静默吞掉（快照停留 stale/旧目录结果）。
// 修复（最小补丁）：复用分支 donePromise 等待结束后，若本次调用 opts.workingDir !== undefined 且 commandProbes
//   已无后继探针（无并发接管），链式补启一次 startCommandProbe(同 sessionId, 同 mainWindow, 同 opts)——
//   新 opts 经正常入口全守卫（N3 取消等待/活跃 query stale/mergeSpawnOptions）消费；opts 无
//   workingDir 的普通重开菜单路径行为零变化；hb13-v B6 防反复 spawn/abort 语义保留（复用判据/
//   取消等待位置不动，本补丁不新增绕过守卫的内部直调）。
//
// 形态对齐 tdd-bugfix-hb13-v-cmd-probe-verify.ts（同域结构钉 + 调用面钉；sdk-backend.ts 为主进程
// 模块，契约脚本导入即拉起 electron 依赖——与 hb13-v 同口径落源码结构钉；既有 hb13-v 全钉经
// selftest:static 保持绿，本卷不重钉其断言）。donePromise→map 清理时序已核：runCommandProbe finally
// 中 commandProbes.delete(sessionId) 先于 entry.resolveDone()，故 await 返回时「无后继探针」判据成立
// （并发插入的新探针除外——判据即为此设）。
// 运行：npx tsx scripts/tdd-command-probe-cwd-refresh-verify.ts
// （登记 scripts/selftest-static-list.txt 与 tsconfig.tdd.json 两处。）

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// startCommandProbe 函数体切片（入口声明 → 顶层右界，与 hb13-v ③ 同窗口口径）
function probeBody(): string {
  const idx = backend.indexOf('export async function startCommandProbe');
  assert.ok(idx !== -1, 'startCommandProbe 入口不存在');
  const end = backend.indexOf('\n}', idx);
  assert.ok(end > idx, 'startCommandProbe 函数体右界未找到');
  return backend.slice(idx, end);
}

// ① 核心回归：复用分支 donePromise 之后携带 workingDir 时链式补启（带新 opts）。
check('① 复用分支：donePromise 后判定 opts.workingDir 且链式补启 startCommandProbe(同参)', () => {
  const body = probeBody();
  const doneIdx = body.indexOf('await existing.donePromise;');
  assert.ok(doneIdx !== -1, '复用分支缺 donePromise 等待');
  const after = body.slice(doneIdx);
  const wdIdx = after.indexOf('opts.workingDir !== undefined');
  assert.ok(wdIdx !== -1, 'donePromise 后缺 workingDir 重探判定（SESSION_UPDATE 重探仍被吞）');
  const chainIdx = after.indexOf('return startCommandProbe(sessionId, mainWindow, opts);');
  assert.ok(chainIdx !== -1, '缺链式补启 return startCommandProbe(sessionId, mainWindow, opts)');
  assert.ok(chainIdx > wdIdx, '补启应位于 workingDir 判定之后（判定先行）');
  // 无后继探针判据：补启仅当 commandProbes 已清（无并发接管），不与取消中残留探针抢跑。
  const guardIdx = after.indexOf('!commandProbes.has(sessionId)');
  assert.ok(guardIdx !== -1, '缺无后继探针判据 !commandProbes.has(sessionId)');
  assert.ok(guardIdx > wdIdx && guardIdx < chainIdx, '无后继探针判据应位于 workingDir 判定与补启之间');
});

// ② 普通路径零变化：opts 无 workingDir 的重开菜单路径不补启（复用分支保持早退形态）。
check('② opts 无 workingDir 时行为零变化：补启仅挂在 workingDir 判定分支内 + 早退 return 保留', () => {
  const body = probeBody();
  const doneIdx = body.indexOf('await existing.donePromise;');
  const after = body.slice(doneIdx);
  const wdIdx = after.indexOf('opts.workingDir !== undefined');
  assert.ok(wdIdx !== -1);
  // 链式调用必须受 workingDir 判定守卫——判定之前的窗口内不得出现裸补启。
  assert.ok(
    !after.slice(0, wdIdx).includes('return startCommandProbe('),
    'workingDir 判定前出现补启（普通重开菜单路径被改变）',
  );
  // workingDir 为 undefined 的调用最终仍走 return（早退），不得落入函数体后半的 spawn 路径。
  const cancelIdx = after.indexOf('cancelCommandProbeInternal(sessionId, 1000)');
  assert.ok(cancelIdx !== -1, '取消等待丢失');
  const seg = after.slice(wdIdx, cancelIdx);
  assert.ok(seg.includes('return;'), '复用分支缺 opts 无 workingDir 的早退 return（普通路径改走 respawn）');
});

// ③ hb13-v B6 防反复 spawn/abort 语义保留：复用判据/取消等待位置不动，补启不绕过守卫。
check('③ hb13-v B6 语义保留：aborted 判据 + cancel 等待在复用分支之后 + 补启走正常入口', () => {
  const body = probeBody();
  const reuseIdx = body.search(/commandProbes\.get\(sessionId\)/);
  assert.ok(reuseIdx !== -1, '入口未检测存活探针');
  const seg = body.slice(reuseIdx, reuseIdx + 400);
  assert.match(seg, /!existing\.aborted/, 'aborted 判据丢失（取消中探针不得复用）');
  const doneIdx = body.indexOf('await existing.donePromise;');
  const cancelIdx = body.indexOf('cancelCommandProbeInternal(sessionId, 1000)');
  assert.ok(cancelIdx > doneIdx, 'cancel 等待应位于复用分支之后（hb13-v ③ 钉同源）');
  // 补启是链式调用 startCommandProbe 自身（经 N3 取消等待/活跃 stale 等全守卫），不是内部直调。
  const after = body.slice(doneIdx, cancelIdx);
  assert.ok(
    !after.includes('void runCommandProbe('),
    '复用分支出现内部直调 runCommandProbe（绕过既有守卫）',
  );
});

// ④ 调用面钉：SESSION_UPDATE workingDir 重探路径传 { ...data }（补启消费的 workingDir 源头）。
check('④ SESSION_UPDATE 调用面：workingDir 变化 → startCommandProbe(id, mainWindow, { ...data })', () => {
  const idx = handlers.indexOf('data.workingDir !== undefined');
  assert.ok(idx !== -1, 'SESSION_UPDATE 缺 workingDir 重探触发分支');
  const seg = handlers.slice(idx, idx + 200);
  assert.match(
    seg,
    /startCommandProbe\(id, mainWindow, \{ \.\.\.data \}\)/,
    '重探未携带 SESSION_UPDATE patch（workingDir 丢失）',
  );
});

// ⑤ 登记自钉
check('⑤ 本脚本两处登记：selftest-static-list.txt + tsconfig.tdd.json', () => {
  assert.ok(
    read('scripts/selftest-static-list.txt').includes('scripts/tdd-command-probe-cwd-refresh-verify.ts'),
    'selftest-static-list.txt 未登记本脚本',
  );
  assert.ok(
    read('tsconfig.tdd.json').includes('scripts/tdd-command-probe-cwd-refresh-verify.ts'),
    'tsconfig.tdd.json 未登记本脚本',
  );
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
