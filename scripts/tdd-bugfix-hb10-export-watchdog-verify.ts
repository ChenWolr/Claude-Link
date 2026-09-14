// scripts/tdd-bugfix-hb10-export-watchdog-verify.ts
// hb10 P1-1（EXP-01）+ P2-9（EXP-02）契约：导出看门狗「绝对硬顶」改「无进展硬顶」+ startImageExport TOCTOU 互斥。
//
// P1-1 病根：resetWatchdog() 首行 `Date.now() >= active.absoluteDeadlineMs → failJob`——每次健康进展
// 重置都先过绝对门；absoluteDeadlineMs 仅 start 时一次性设 start+300s，全仓无顺延路径。
// PNG 页高按内存预算反推后单页 10–38 段捕获 + 128MB RGBA 同步编码，数千消息会话 >300s 现实可达
// → 健康长导出必然失败，无绕过。
// 修法：resetWatchdog 恢复纯「重置 90s 无进展窗」语义并维护 lastProgressAt；绝对防死循环语义改为
// 独立 5min 无进展定时器（连续 5 分钟无任何 resetWatchdog 调用才 failJob，文案含「无进展」）。
// hb12 §1.1.2 硬约束：无进展定时器必须在 handleFinishImpl（与 finishTimer 同点）clearTimeout，
// 且 waitingForDestination/saving 阶段不重排——否则用户在保存对话框停留 >5min 会被误杀（WARN-3）。
//
// P2-9 病根：startImageExport 的 isActive() 检查与 `active = {...}` 赋值之间隔两次 await
// （buildExportAttachmentSnapshots / mkdtemp），并发第二次调用可覆盖 active。
// 修法：模块级 starting 标志，进入同步段置位，全部 await 完成赋值 active 或失败路径的 finally 复位。
//
// 本契约锁：
// ① absoluteDeadlineMs/WATCHDOG_ABSOLUTE_MS 全文件收口（删除或改名后无残留）；
// ② resetWatchdog 纯语义：不含绝对门、维护 lastProgressAt、phase 守卫（saving/waitingForDestination 不重排）；
// ③ 无进展定时器：WATCHDOG_NO_PROGRESS_MS 常量 + 「无进展」failJob 文案 + 自续延检查形态；
// ④ 生命周期收口：handleFinishImpl / failJob / cleanup 三处均 clearTimeout(noProgressTimer)；
// ⑤ P2-9 starting 标志 + try/finally 复位形态。
//
// 运行：npx tsx scripts/tdd-bugfix-hb10-export-watchdog-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const manager = read('src/main/modules/export-image-manager.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

function fnBody(src: string, head: string, headOccurrence = 1): string {
  let idx = -1;
  for (let i = 0; i < headOccurrence; i++) idx = src.indexOf(head, idx + 1);
  assert.ok(idx > -1, `未找到 ${head}`);
  const end = src.indexOf('\n}', idx);
  return src.slice(idx, end > -1 ? end : undefined);
}

// ① 绝对硬顶字段/常量收口：全文件不再含 absoluteDeadlineMs 与 WATCHDOG_ABSOLUTE_MS。
check('① absoluteDeadlineMs 字段与 WATCHDOG_ABSOLUTE_MS 常量全文件无残留（原 300s 绝对门已废）', () => {
  assert.doesNotMatch(manager, /absoluteDeadlineMs/, 'absoluteDeadlineMs 仍有残留引用（绝对门未收口）');
  assert.doesNotMatch(manager, /WATCHDOG_ABSOLUTE_MS/, 'WATCHDOG_ABSOLUTE_MS 常量仍有残留');
});

// ② resetWatchdog 纯语义。
check('② resetWatchdog：不含绝对门比较 + 维护 lastProgressAt + saving/waitingForDestination 阶段不重排（hb12 WARN-3）', () => {
  const body = fnBody(manager, 'function resetWatchdog');
  assert.doesNotMatch(body, /Date\.now\(\)\s*>=\s*active\.\w+/, 'resetWatchdog 函数体仍含绝对门比较（健康进展先过绝对门=原病根）');
  assert.match(body, /active\.lastProgressAt = Date\.now\(\)/, 'resetWatchdog 缺 lastProgressAt 维护（无进展判据的推进点）');
  assert.match(body, /clearTimeout\(active\.finishTimer\)/, 'resetWatchdog 缺 90s 窗重置');
  assert.match(body, /'waitingForDestination'/, 'resetWatchdog 缺 waitingForDestination 阶段守卫');
  assert.match(body, /'saving'/, 'resetWatchdog 缺 saving 阶段守卫（保存对话框停留 >5min 不得被无进展定时器误杀）');
});

// ③ 无进展硬顶：常量 + 文案 + 自续延检查。
check('③ WATCHDOG_NO_PROGRESS_MS 常量 + 「无进展」failJob 文案 + 到点检查/续延形态', () => {
  assert.match(manager, /WATCHDOG_NO_PROGRESS_MS\s*=\s*5\s*\*\s*60_000/, '缺 WATCHDOG_NO_PROGRESS_MS = 5min 常量');
  assert.match(manager, /导出连续 5 分钟无进展/, '缺「导出连续 5 分钟无进展」failJob 文案');
  const checkFn = fnBody(manager, 'function checkNoProgress');
  assert.match(checkFn, /Date\.now\(\) - active\.lastProgressAt/, '无进展判据必须以 lastProgressAt 为基准');
  assert.match(checkFn, /idle >= WATCHDOG_NO_PROGRESS_MS/, '无进展判据必须比较空闲时长与 5min 窗');
  assert.match(checkFn, /setTimeout\(checkNoProgress/, '判据未命中时缺自续延 setTimeout（否则中途恢复进展后再无进展不会被杀）');
  const iface = manager.slice(manager.indexOf('interface ActiveJob'), manager.indexOf('let active: ActiveJob'));
  assert.match(iface, /noProgressTimer:\s*NodeJS\.Timeout/, 'ActiveJob 缺 noProgressTimer 字段');
  assert.match(iface, /lastProgressAt:\s*number/, 'ActiveJob 缺 lastProgressAt 字段');
});

// ④ 生命周期收口：三处 clearTimeout + job 启动初始化（Impl 拆分后按位置钉：初始化位于 startImageExport 声明之后）。
check('④ handleFinishImpl / failJob / cleanup 三处均清理 noProgressTimer（与 finishTimer 同点）', () => {
  const finish = fnBody(manager, 'async function handleFinishImpl');
  assert.match(finish, /clearTimeout\(active\.noProgressTimer\)/, 'handleFinishImpl 缺 noProgressTimer 清理（保存对话框停留 >5min 会被误杀——hb12 WARN-3）');
  const fail = fnBody(manager, 'async function failJob');
  assert.match(fail, /clearTimeout\(active\.noProgressTimer\)/, 'failJob 缺 noProgressTimer 清理');
  const clean = fnBody(manager, 'async function cleanup(_reason');
  assert.match(clean, /clearTimeout\(job\.noProgressTimer\)/, 'cleanup 缺 noProgressTimer 清理（定时器泄漏）');
  const startIdx = manager.indexOf('export async function startImageExport');
  const timerIdx = manager.indexOf('noProgressTimer: setTimeout(checkNoProgress');
  const lastIdx = manager.indexOf('lastProgressAt: Date.now()');
  assert.ok(timerIdx > startIdx, 'startImageExport 链路缺 noProgressTimer 启动（与 watchdog 同生命周期）');
  assert.ok(lastIdx > startIdx, 'startImageExport 链路缺 lastProgressAt 初始化');
});

// ⑤ P2-9：TOCTOU 互斥。
check('⑤ startImageExport：starting 互斥标志 + try/finally 复位（并发第二次同步返回 busy）', () => {
  assert.match(manager, /let starting = false/, '缺模块级 starting 标志');
  const start = fnBody(manager, 'export async function startImageExport');
  assert.match(start, /if \(starting \|\| isActive\(\)\)/, 'startImageExport 入口守卫未纳入 starting（TOCTOU 窗未闭合）');
  assert.match(start, /starting = true/, '入口缺 starting = true 置位');
  assert.match(start, /\}\s*finally\s*\{/, '缺 try/finally 包裹');
  assert.match(start, /starting = false/, 'finally 缺 starting = false 复位（首调失败后不可重试=回归）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
