// tdd-watchdog-error-deferred-verify.ts
// A13（D11-F6，P2）契约钉：watchdog「已自动中断」系统消息延迟到硬杀终态确定时落库。
//
// 根因：watchdogTick 硬杀分支先 forwardEvent(error)（同步 persistCliEvent 落库 system:error
// 行），再 killProcess('watchdog') 进两段式优雅窗（保持 entry current、流可自然收尾）。优雅
// 生效时 runQuery result 分支正常落库成功回复并 deleteEntry，finishKill 迟到 wasCurrent=false
// 跳过 aborted——DB 同时留下「判定卡死已自动中断」system:error 行与成功回复，经 group-messages
// 独立成条在重载时永久可见（误报不可自愈）；renderer 6s 宽限（hb10-ENG-04）只回收横幅。
//
// 修复语义：watchdogTick 只把 reason 挂账到 entry.watchdogErrorPending（随回合生命周期，不跨
// 回合残留；entry 缺失兜底保持旧直发语义）；finishKill 终态路径在 wasCurrent && reason==='watchdog'
// 时先兑现挂账 error（转发+落库）再补发 aborted——回合确被中止才落库，优雅窗内自然完成则
// 永不发出（stalled 横幅仍即时可见，不受影响）。user/upstream_fatal/queue 语义不动。
//
// 运行：npx tsx scripts/tdd-watchdog-error-deferred-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const backend = readFileSync(new URL('../src/main/modules/sdk-backend.ts', import.meta.url), 'utf8');

// watchdogTick 硬杀分支窗口：从 hardAbortFired 置位到 killProcess 调用。
const hardAt = backend.indexOf('t.hardAbortFired = true');
const hardRegion = backend.slice(hardAt, backend.indexOf('killProcess(sessionId, \'watchdog\'', hardAt) + 40);
// finishKill 的 watchdog 补发窗口：从 wasCurrent 判定到 schedulePostTurnProbe。
const fnAt = backend.indexOf('const finishKill = () => {');
const fnRegion = backend.slice(fnAt, backend.indexOf('Interrupted SDK query for session', fnAt));

console.log('\n=== A13（D11-F6）：watchdog 误报延迟落库 ===');
console.log('\n=== 组1 结构契约（挂账 + 终态兑现） ===');
check('① watchdogTick 硬杀分支主路径不再直发 error：挂账 entry.watchdogErrorPending', () => {
  assert.ok(hardAt > -1, '缺 hardAbortFired 定位锚');
  const directIdx = hardRegion.indexOf("forwardEvent(sessionId, mw, { type: 'error', message: reason })");
  assert.match(hardRegion, /if \(entry\) \{\s*\n\s*entry\.watchdogErrorPending = reason;/, '缺挂账形态（if (entry) 主路径）');
  assert.ok(directIdx > -1 && hardRegion.slice(Math.max(0, directIdx - 40), directIdx).includes('} else'), '直发只允许出现在 entry 缺失的 else 兜底（主路径直发=误报根因残留）');
});
check('② 挂账有 entry 缺失兜底（保持旧直发，行为不回退）', () => {
  assert.match(hardRegion, /const entry = entries\.get\(sessionId\);/, '缺 entry 取用');
  assert.match(hardRegion, /forwardEvent\(sessionId, mw, \{ type: 'error', message: reason \}\);/, '缺 entry 缺失兜底直发');
  const ifIdx = hardRegion.indexOf('if (entry)');
  const fallbackIdx = hardRegion.indexOf("forwardEvent(sessionId, mw, { type: 'error', message: reason })");
  assert.ok(ifIdx > -1 && fallbackIdx > ifIdx, '直发须位于 if (entry) 之后的 else 兜底');
});
check('③ SessionEntry 含 watchdogErrorPending 字段（生命周期随回合）', () => {
  assert.match(backend, /watchdogErrorPending\?: string;/, '缺字段声明');
});
check('④ finishKill 终态兑现：wasCurrent && watchdog 分支先挂账 error 后 aborted（次序与旧时序一致）', () => {
  const gateIdx = fnRegion.indexOf("wasCurrent && (reason === 'user' || reason === 'watchdog')");
  assert.ok(gateIdx > -1, '缺 wasCurrent 门（迟到守卫回归）');
  const redeemIfIdx = fnRegion.indexOf("if (reason === 'watchdog' && entry.watchdogErrorPending)");
  assert.ok(redeemIfIdx > gateIdx, '兑现须在 wasCurrent 门内');
  const errorIdx = fnRegion.indexOf("{ type: 'error', message: entry.watchdogErrorPending }");
  const abortedIdx = fnRegion.indexOf("{ type: 'aborted', message: '已中断' }");
  assert.ok(errorIdx > redeemIfIdx && errorIdx < abortedIdx, '挂账 error 须先于 aborted 补发');
  assert.match(fnRegion.slice(redeemIfIdx, abortedIdx), /reason === 'watchdog'/, '兑现须限定 watchdog reason（user 中断语义不动）');
  assert.match(fnRegion.slice(redeemIfIdx, abortedIdx), /entry\.watchdogErrorPending = undefined;/, '兑现后清账（幂等）');
});
check('⑤ 优雅窗完成路径不落库的结构证据：兑现以 wasCurrent 为门（迟到 finishKill 不走到）', () => {
  const wasCurrentIdx = fnRegion.indexOf('const wasCurrent = entries.get(sessionId) === entry;');
  const removeIdx = fnRegion.indexOf('removeEntryIfCurrent(sessionId, entry)');
  assert.ok(wasCurrentIdx > -1 && removeIdx > wasCurrentIdx, 'wasCurrent 捕获须先于 removeEntryIfCurrent（既有迟到守卫钉）');
});

console.log('\n=== 组2 既有契约兼容复验（对当前源码重跑 regression 关键正则） ===');
check('⑥ regression:1755-1756 killProcess user/watchdog aborted 形态不破', () => {
  assert.ok(/reason === 'user' \|\| reason === 'watchdog'/.test(backend));
  assert.ok(/reason === 'user' \|\| reason === 'watchdog'[\s\S]*?forwardEvent[\s\S]*?type: 'aborted'/.test(backend));
});
check('⑦ regression:3585-3603 finishKill 迟到守卫形态不破', () => {
  assert.ok(/if \(wasCurrent\) cleanupSessionStall\(sessionId\);/.test(backend));
  assert.ok(/wasCurrent && \(reason === 'user' \|\| reason === 'watchdog'\)/.test(backend));
  assert.ok(/wasCurrent && \(reason === 'user' \|\| reason === 'watchdog'\)[\s\S]{0,1300}schedulePostTurnProbe\(sessionId, mainWindow, entry\.queryInstance/.test(backend), '探针调度须在同步后窗口内（regression 契约已随 A13 扩 700→1300）');
});
check('⑧ 两段式优雅窗机制不动（forceKill 挂账 + race 形态在位）', () => {
  assert.match(backend, /entry\.forceKill = finishKill;/, '缺 forceKill 挂账');
  assert.match(backend, /abort-fallback:/, '缺 abort-fallback 分档');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
