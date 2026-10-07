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
// X9（R11-F1，b272628 回归修复）补钉：wasCurrent 单门把「interrupt 生效导致的回合终止」与
// 「自然完成」混同——interrupt 优雅收尾三出口（result 分支 / 流末兜底 / catch）全部先
// deleteEntry 后 finishKill（两段式 race 续体是微任务，跑在 runQuery 同步段之后），
// wasCurrent 恒 false，挂账在主路径永不兑现。修复两步（计划修法，优先②保完备）：
// ② runQuery 三中断收尾出口（result 为 error_during_execution/interrupted 的分支、流末兜底、
//   catch 中断分支）于 deleteEntry 之前消费挂账——先 forwardEvent(error)（同步落库
//   system:error + renderer 横幅/重试入口）再清账；迟到的 finishKill 因挂账已清不产生二次转发。
//   catch 出口消费门为 forceKill != null（两段式优雅窗在途）——user 直杀的 finishKill 已自清
//   forceKill，不消费挂账，「user 中断语义不动」保持；upstream_fatal/queue 无挂账天然 no-op。
// ① finishKill 兑现门收窄：wasCurrent 之外补两种「回合确被中止」确认——流末兜底已知中断
//   （knownOutcome==='interrupted'）与本回合曾被 watchdog 硬杀且无权威终态标记
//   （watchdogInterrupted && !knownOutcome，catch 抛错收尾形态）。watchdogInterrupted 判据必须
//   以 !knownOutcome 为前提：优雅窗内自然完成（success result）时 knownOutcome='success'、
//   三态皆假不兑现——b272628「优雅完成不残留误报」目标保持（直译三析取会在该场景误兑现）。
//   兑现仍限定 reason==='watchdog'；error 先于 wasCurrent 门的 aborted 补发（次序同旧时序）；
//   aborted/探针等会话级副作用保持 wasCurrent 单门（防迟到污染收尾后新回合，regression 钉）。
//   自然完成（success result）不消费（isAbortedCliResult 门）；5s deadline abort-fallback 等
//   既有兑现点（finishKill wasCurrent=true）语义不动。
//
// Rv3（2026-10-07 review followup）补钉：
// - Rv3-2：watchdog 5s 优雅窗内用户手动停止（killProcess('user')）须清挂账——迟到的 watchdog
//   finishKill 不得经 (watchdogInterrupted && !knownOutcome) 析取在用户已见「已中断」后补发
//   watchdog error（挂账随用户决断作废，与「user 直杀不消费挂账」语义对齐）。
// - Rv3-1：result 分支消费门放宽——watchdog 硬杀在途（watchdogInterrupted 置位）的非标准
//   error result（is_error=true 且非 error_during_execution）同属「回合被中止后收尾」，挂账
//   一并消费防随 deleteEntry 消亡丢弃；success result 仍不消费。
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
check('④ finishKill 终态兑现：watchdog 挂账 error 先于 aborted；aborted 门保持 wasCurrent 单门（X9 修法①）', () => {
  const gateIdx = fnRegion.indexOf("wasCurrent && (reason === 'user' || reason === 'watchdog')");
  assert.ok(gateIdx > -1, '缺 wasCurrent 门（迟到守卫回归——aborted/探针等会话级副作用不得放宽）');
  const redeemIfIdx = fnRegion.indexOf("reason === 'watchdog' &&");
  assert.ok(redeemIfIdx > -1 && redeemIfIdx < gateIdx, '兑现块须在 wasCurrent 门之前（error 先于 aborted，次序同旧时序）');
  const errorIdx = fnRegion.indexOf("{ type: 'error', message: entry.watchdogErrorPending }");
  const abortedIdx = fnRegion.indexOf("{ type: 'aborted', message: '已中断' }");
  assert.ok(errorIdx > redeemIfIdx && errorIdx < abortedIdx, '挂账 error 须先于 aborted 补发');
  assert.ok(fnRegion.slice(redeemIfIdx, errorIdx).includes('entry.watchdogErrorPending &&'), '兑现门须含挂账存在性（无挂账不转发）');
  assert.ok(fnRegion.slice(redeemIfIdx, errorIdx).includes('mainWindow'), '兑现门须含 mainWindow 守卫');
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

console.log('\n=== 组3 X9（R11-F1）：interrupt 优雅收尾主路径兑现挂账（b272628 回归修复） ===');
// result 分支切片：if (type === 'result') → 本分支自己的 emitExit(0)（占坑释放收尾）。
const resultBranchAt = backend.indexOf("if (type === 'result')");
const resultBranchEnd = backend.indexOf('emitExit(0);', resultBranchAt);
const resultBranch = backend.slice(resultBranchAt, resultBranchEnd);
check('⑨ result 分支：interrupted result（error_during_execution）在 deleteEntry 前消费挂账', () => {
  assert.ok(resultBranchAt > -1 && resultBranchEnd > resultBranchAt, '缺 result 分支定位锚');
  // 转换结果先落局部变量（isAbortedCliResult 权威判定中断 result，复用共享谓词不重造 subtype 判断）
  assert.ok(resultBranch.indexOf('const resultEvent = convertResultMessage(sdkMsg);') > -1, '缺 resultEvent 提取（isAbortedCliResult 判定前提）');
  // Rv3-1 放宽形态：interrupted result 之外，watchdog 硬杀在途的 is_error result 也命中（⑮ 钉字面量）。
  const gateIdx = resultBranch.indexOf('if (entry.watchdogErrorPending && (isAbortedCliResult(resultEvent) || (resultEvent.is_error && entry.watchdogInterrupted)))');
  assert.ok(gateIdx > -1, '缺挂账消费门（watchdogErrorPending && (isAbortedCliResult || is_error&&watchdogInterrupted)）');
  const errIdx = resultBranch.indexOf("forwardEvent(sessionId, mainWindow, { type: 'error', message: entry.watchdogErrorPending })");
  assert.ok(errIdx > gateIdx, '消费门内须转发挂账 error');
  assert.match(resultBranch.slice(gateIdx, resultBranch.indexOf('deleteEntry(sessionId, entry);')), /entry\.watchdogErrorPending = undefined;/, '消费后清账（防迟到 finishKill 二次转发）');
  const delIdx = resultBranch.indexOf('deleteEntry(sessionId, entry);');
  assert.ok(delIdx > errIdx, '消费须先于 deleteEntry（主路径兑现根因：微任务 finishKill 届时 wasCurrent 恒 false）');
});
check('⑩ 流末兜底（出口②）：挂账在 deleteEntry 前消费、error 先于 aborted 合成', () => {
  const streamAt = backend.indexOf('isCurrentEntry(sessionId, entry) && !gotResult');
  const streamEnd = backend.indexOf('emitExit(null);', streamAt);
  assert.ok(streamAt > -1 && streamEnd > streamAt, '缺流末兜底定位锚');
  const seg = backend.slice(streamAt, streamEnd);
  const errIdx = seg.indexOf("forwardEvent(sessionId, mainWindow, { type: 'error', message: entry.watchdogErrorPending })");
  assert.ok(errIdx > -1, '缺挂账 error 转发');
  const abortIdx = seg.indexOf("forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '回合已结束' })");
  const delIdx = seg.indexOf('deleteEntry(sessionId, entry);');
  assert.ok(abortIdx > -1 && abortIdx > errIdx, 'error 须先于 aborted（与 finishKill 兑现次序一致）');
  assert.ok(delIdx > -1 && delIdx > errIdx, '消费须先于 deleteEntry');
  assert.match(seg.slice(0, errIdx), /if \(entry\.watchdogErrorPending\) \{/, '缺消费门（本分支仅无 result 的中断收尾可达，pending 有值必属本回合被中断）');
  assert.match(seg.slice(errIdx, delIdx), /entry\.watchdogErrorPending = undefined;/, '消费后清账（幂等）');
});
check('⑪ 自然完成不残留误报（b272628 目标不回归）：result 分支消费门不含 success 命中路径', () => {
  // Rv3-1 放宽形态（⑨ 同步）：两析取均不命中 success result——isAbortedCliResult 要求
  // subtype==='error_during_execution'，第二析取要求 is_error===true；success result
  // （is_error=false、subtype='success'）双假，消费门不消费（语义与放宽前一致）。
  assert.ok(/if \(entry\.watchdogErrorPending && \(isAbortedCliResult\(resultEvent\) \|\| \(resultEvent\.is_error && entry\.watchdogInterrupted\)\)\)/.test(resultBranch), '消费门须限定 interrupted / watchdog 硬杀 is_error result——success result（优雅窗自然完成）不得消费挂账');
  // finishKill 兑现门（wasCurrent）原样保留：abort-fallback / forceKill 接管 / 无 query 直杀
  // 三既有兑现点行为不变（⑤ 的 wasCurrent 捕获顺序钉 + ④ 的门形态钉共同覆盖，此处复验字面量）。
  assert.ok(/wasCurrent && \(reason === 'user' \|\| reason === 'watchdog'\)/.test(backend), 'finishKill wasCurrent 门被改动（三既有兑现点回归）');
});

console.log('\n=== 组4 X9 第二轮（验收反馈）：catch 出口消费 + 修法① 兑现门收窄 ===');
check('⑫ watchdogInterrupted 标志：SessionEntry 字段声明 + watchdogTick 与挂账一并置位', () => {
  assert.match(backend, /watchdogInterrupted\?: boolean;/, 'SessionEntry 缺 watchdogInterrupted 字段');
  assert.match(hardRegion, /entry\.watchdogErrorPending = reason;\s*\n\s*entry\.watchdogInterrupted = true;/, 'watchdogTick 须在挂账同时置位硬杀标记（修法① 迟到兑现的确认判据）');
});
check('⑬ catch 中断出口（出口③）：优雅窗在途（forceKill 非空）流抛错时在 finally deleteEntry 前消费挂账', () => {
  const at = backend.indexOf('interruptedQueries.has(query)');
  const end = backend.indexOf('} else {', at);
  assert.ok(at > -1 && end > at, '缺 catch 中断分支定位锚');
  const seg = backend.slice(at, end);
  const errIdx = seg.indexOf("forwardEvent(sessionId, mainWindow, { type: 'error', message: entry.watchdogErrorPending })");
  assert.ok(errIdx > -1, '缺挂账 error 转发（catch 出口三出口之一，验收缺口）');
  const gateIdx = seg.indexOf('if (entry.forceKill != null && entry.watchdogErrorPending) {');
  assert.ok(gateIdx > -1 && gateIdx < errIdx, '消费门须为 forceKill != null（user 直杀 forceKill 已自清不消费；upstream_fatal/queue 无挂账 no-op）');
  assert.match(seg.slice(errIdx), /entry\.watchdogErrorPending = undefined;/, '消费后清账（幂等，防迟到 finishKill 二次转发）');
  // 消费块须在 emitExit(null) 之后、分支收尾之前：同处一个同步段（微任务 finishKill 无法
  // 插队，清账先于 deleteEntry/finishKill 语义等价），且不挤占 p3-01 契约钉的中断分支
  // 前 600/700 字符窗口（forceKill==null aborted 守卫与 emitExit 位置不可推后）。
  const emitIdx = seg.indexOf('emitExit(null);');
  assert.ok(emitIdx > -1 && emitIdx < gateIdx, '消费块须位于 emitExit(null) 之后（p3-01 窗口钉不破）');
});
check('⑭ finishKill 兑现门收窄（修法①）：三态确认；watchdogInterrupted 须以无权威终态标记为前提', () => {
  assert.match(fnRegion, /\(wasCurrent \|\| entry\.knownOutcome === 'interrupted' \|\| \(entry\.watchdogInterrupted === true && !entry\.knownOutcome\)\)/, '缺收窄兑现门（wasCurrent / 流末已知中断 / watchdog 硬杀且无权威终态标记）');
  // b272628 防误报不回归的结构证据：watchdogInterrupted 与 !entry.knownOutcome 联用——
  // 优雅窗内自然完成（success result，knownOutcome='success'）三态皆假，挂账随 entry 消亡；
  // 若直译「watchdogInterrupted 孤立判据」，该场景将被迟到 finishKill 误兑现（D11-F6 复发）。
  assert.ok(/entry\.watchdogInterrupted === true && !entry\.knownOutcome/.test(fnRegion), 'watchdogInterrupted 判据须联用 !knownOutcome（防 success 误兑现）');
});

console.log('\n=== 组5 Rv3（2026-10-07 review followup）：Rv3-1 消费门放宽 + Rv3-2 用户停止清挂账 ===');
check('⑮ Rv3-1：result 分支消费门为放宽形态——is_error && watchdogInterrupted 字面量在位', () => {
  assert.ok(resultBranchAt > -1, '缺 result 分支定位锚');
  // 专属钉（⑨/⑪ 匹配整门形态，此处单独钉第二析取字面量）：删掉放宽析取（回退窄门）即失配——
  // watchdog 中断后回合以非 error_during_execution 的 error result 收尾时挂账不得丢弃。
  const disjunctIdx = resultBranch.indexOf('resultEvent.is_error && entry.watchdogInterrupted');
  assert.ok(disjunctIdx > -1, '缺放宽析取（resultEvent.is_error && entry.watchdogInterrupted）——非标准 error result 也须消费挂账');
  const gateIdx = resultBranch.indexOf('if (entry.watchdogErrorPending &&');
  assert.ok(gateIdx > -1 && gateIdx < disjunctIdx, '放宽析取须位于消费门条件内');
});
check('⑯ Rv3-2：killProcess 顶部 reason===user 分支清挂账（迟到的 watchdog finishKill 无账可补发）', () => {
  // killProcess 函数顶区切片：函数起点 → finishKill 定义。清挂账须落在该顶区内（先于
  // finishKill 定义/兑现门区域），且邻近 reason === 'user' 分支；整段删掉即失配。
  const killFnAt = backend.indexOf('export function killProcess(');
  const killFnEnd = backend.indexOf('const finishKill = () => {', killFnAt);
  assert.ok(killFnAt > -1 && killFnEnd > killFnAt, '缺 killProcess / finishKill 定位锚');
  const killHead = backend.slice(killFnAt, killFnEnd);
  const userIfIdx = killHead.indexOf("if (reason === 'user') {");
  assert.ok(userIfIdx > -1, "缺 reason === 'user' 独立分支");
  const clearIdx = killHead.indexOf('watchdogErrorPending = undefined;', userIfIdx);
  assert.ok(clearIdx > -1 && clearIdx - userIfIdx < 300, "user 分支须邻近清挂账（watchdogErrorPending = undefined），且位于函数顶部（finishKill 定义之前）");
  // 清理须先于后续 const entry = entries.get(sessionId); 取用点（变量名不同源码编译前提，非契约重点，
  // 但钉顺序：顶部清理 → 主体 entry 逻辑），并不得误伤 finishKill 兑现主路径（⑭ 复验收窄门不动）。
  const entryIdx = killHead.indexOf('const entry = entries.get(sessionId);');
  assert.ok(entryIdx === -1 || userIfIdx < entryIdx, '清挂账须位于 killProcess 顶部（先于主体 entry 取用）');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
