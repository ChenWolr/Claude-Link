// scripts/tdd-bugfix-hb10-task-result-persist-verify.ts
// hb10 P2-13（QUE-01+QUE-V02）契约：updateTaskResult 死代码——任务 DB 永久 running。
//
// 病根：task-repo.updateTaskResult（唯一 completed 写入者）零调用；noteTurnOutcome 只动内存。
// 队列任务收尾后 DB 行永久 running → 重启 resetRunningTasks 把「上次会话的成功任务」批量误翻 failed。
// 修法：settleCurrent 内按 outcome 映射落库（复用现有 repo 函数，不扩列）：
//   success → updateTaskResult（status=completed + completed_at）；failed → updateTaskError；
//   interrupted → updateTaskStatus('cancelled')。幂等：以 DB 行 status==='running' 为判据 +
//   settleCurrent 现有 currentTaskId 闸防重入，终态只写一次。resetRunningTasks 语义不变。
// 断言级别（hb13-v 批C 注记）：本契约为静态钉（源码文本断言）；行为级由回归测试覆盖
//（hb10 计划 :171 承诺的「内存库跑 settleCurrent 三态断言 DB 行」降级理由见 queue-tasks 域 F8）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-task-result-persist-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const engine = fs.readFileSync(path.join(repoRoot, 'src/main/modules/task-queue-engine.ts'), 'utf8');
const repo = fs.readFileSync(path.join(repoRoot, 'src/main/database/repositories/task-repo.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① settleCurrent：终态落库接线（outcome 三分支映射）。
check('① settleCurrent：按 outcome 落库（success→updateTaskResult / failed→updateTaskError / interrupted→cancelled）', () => {
  const idx = engine.indexOf('function settleCurrent');
  assert.ok(idx > -1, '未找到 settleCurrent');
  const body = engine.slice(idx, engine.indexOf('\n}', idx));
  assert.match(body, /taskRepo\.getTask\(taskId\)/, '落库前未读任务行（幂等判据来源）');
  assert.match(body, /taskRow\.status === 'running'/, '缺 DB running 判据（终态只写一次）');
  const resultIdx = body.indexOf("updateTaskResult(taskId");
  const errorIdx = body.indexOf("updateTaskError(taskId");
  const cancelIdx = body.indexOf("updateTaskStatus(taskId, 'cancelled')");
  assert.ok(resultIdx > -1, 'success 分支缺 updateTaskResult 落库（死代码启用）');
  assert.ok(errorIdx > -1, 'failed 分支缺 updateTaskError 落库');
  assert.ok(cancelIdx > -1, 'interrupted 分支缺 cancelled 落库');
  // 落库须在 currentTaskId 清空之前（同序结算）。
  const clearIdx = body.indexOf('state.currentTaskId = null');
  assert.ok(clearIdx > resultIdx && clearIdx > errorIdx && clearIdx > cancelIdx, 'DB 落库必须先于清 currentTaskId（同序收口）');
});

// ② repo 侧形态不变性（settleCurrent 依赖的三个函数语义钉）。
check('② task-repo：updateTaskResult 置 completed+completed_at；updateTaskError 置 failed；cancelled 含 completed_at', () => {
  const r1 = repo.slice(repo.indexOf('export function updateTaskResult'), repo.indexOf('export function updateTaskError'));
  assert.match(r1, /status = 'completed'/, 'updateTaskResult 未置 completed');
  assert.match(r1, /completed_at = COALESCE/, 'updateTaskResult 缺 completed_at');
  const r2 = repo.slice(repo.indexOf('export function updateTaskError'), repo.indexOf('export function reorderTasks'));
  assert.match(r2, /status = 'failed'/, 'updateTaskError 未置 failed');
  const r3 = repo.slice(repo.indexOf('export function updateTaskStatus'), repo.indexOf('export function updateTaskResult'));
  assert.match(r3, /'completed', 'failed', 'cancelled'\]/, 'updateTaskStatus 的 completed_at 分支须含 cancelled');
  // resetRunningTasks 语义不变（启动兜底仍翻 failed）。
  const r4 = repo.slice(repo.indexOf('export function resetRunningTasks'), repo.indexOf('export function resetRunningTasks') + 700);
  assert.match(r4, /status = 'failed'/, 'resetRunningTasks 语义被改（启动兜底失效）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
