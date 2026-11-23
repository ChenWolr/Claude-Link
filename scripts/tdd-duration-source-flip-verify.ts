// scripts/tdd-duration-source-flip-verify.ts
// P5「durationMs 口径翻转」契约脚本（2026-11-21 批次 round-001 p5）。
// ② 气泡脚注耗时口径翻转：客户端回合计时（发送起点→result 时刻，serverClockOffset 换算）优先，
// 端点回报 duration_ms（模型侧耗时）降为客户端起点缺失时的兜底。前台 attachResultMetadata 与
// 后台 case 'result' 两分支同翻转；② 气泡脚注（message.durationMs）、lastTurn 会话级 meta
// （setLastTurnMeta）、messages.duration_ms 持久化（recordTurnMeta）三处与 ④ turn_ended 权威口径
// 同源（同回合 ②≈④，差值 ≤ 渲染时延）。costUsd 逻辑/成功门控/TM-01 守卫/中断不落库/turn_ended
// 权威消费全部不变。
// TDD 验证脚本：
//   P5-T1 前台 attachResultMetadata 优先级翻转（新形态在位 + 旧形态字面零残留，指令点名 grep 形态）
//   P5-T2 后台 case 'result' 同翻转（新形态在位 + 旧形态零残留 + meta 先于 markCompleted 顺序硬要求）
//   P5-T3 两分支三级判定形态覆盖（clientMs 在→用之 / 缺→端点>0→端点值 / 皆无→null→P2-2 半写收口衔接）
//   P5-T4 两分支客户端计时仍含 serverClockOffset[sid] 换算（R6 语义字面在位，clientMs 计算式不动）
//   P5-T5 recordTurnMeta 载荷两分支均取翻转后同值（messages.duration_ms 列与 sessions.last_turn_duration_ms 同为全程口径）
//   P5-T6 costUsd 逻辑 / isSuccessfulCliResult 门控 / turnStartedAt!=null 守卫字面不变（hb10 ⑧ 同源）
//   P5-T7 持久化仍限成功 result（中断/错误不落库 P2-1；error/aborted 分支零持久化调用）
//   P5-T8 turn_ended 分支照旧消费主进程权威 event.durationMs/endedAt（F1-1d 同源）
//   P5-T9 pinia store 直测（无头）：setLastTurnMeta 正数写读回；null/非正/非有限早退不写（P2-2）；
//         markRunning 新回合边界清 turnFootnote、不清 lastTurnMeta；deleteSession 清理字面 + 行为。
//   spawn 门：b1 / hb10 / b3 三卷退出码 0（MOD-P5-1 预核对：三卷均无旧优先级字面钉，无需修订）。
// 运行：npx tsx scripts/tdd-duration-source-flip-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`); }
}

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const read = (rel: string): string => readFileSync(`${repoRoot}/${rel}`, 'utf8');

const useChat = read('src/renderer/composables/use-chat.ts');
const sessionStore = read('src/renderer/stores/session-store.ts');
const selftestList = read('scripts/selftest-static-list.txt');

// 区段提取（与 b1 ⑧ 同一切法）：前台 attachResultMetadata 函数体 / 后台 case 'result' 分支体。
const frontIdx = useChat.indexOf('function attachResultMetadata');
const frontEnd = useChat.indexOf('async function sendMessage');
const front = useChat.slice(frontIdx, frontEnd > -1 ? frontEnd : undefined);
const bgIdx = useChat.indexOf('function handleBackgroundEvent');
const cliIdx = useChat.indexOf('function handleCliEvent');
const bg = useChat.slice(bgIdx, cliIdx > -1 ? cliIdx : undefined);
const resultCase = bg.indexOf("case 'result':");
const errorCase = bg.indexOf("case 'error':", resultCase);
const bgResult = bg.slice(resultCase, errorCase > -1 ? errorCase : undefined);

console.log('\n=== P5-T0 · 新卷登记 ===');
check('P5-T0 新卷已登记 scripts/selftest-static-list.txt', () => {
  assert.ok(selftestList.includes('scripts/tdd-duration-source-flip-verify.ts'), '新卷未登记 selftest 静态清单');
});

console.log('\n=== P5-T1~T4 · 优先级翻转静态钉（use-chat.ts 两分支） ===');

// ① 前台 attachResultMetadata：客户端回合计时优先。
check('P5-T1 前台 attachResultMetadata：clientMs != null 在头的新形态在位 + 旧优先级字面零残留', () => {
  assert.match(
    front,
    /message\.durationMs = clientMs != null\s*\?\s*clientMs\s*:\s*\(typeof duration === 'number' && duration > 0 \? duration : null\);/,
    '缺 P5 新优先级形态（clientMs != null 三元在头、端点 duration_ms>0 兜底落 null）',
  );
  // 负向（指令点名 grep 形态）：旧「端点值在前、clientMs 兜底」三元族零残留。
  assert.ok(!front.includes('duration : clientMs'), '旧形态残留：duration : clientMs');
  assert.ok(!/duration > 0\s*\?\s*duration\s*:\s*clientMs/.test(front), '旧形态残留：duration > 0 ? duration : clientMs');
});

// ② 后台 case 'result'：同翻转。
check('P5-T2 后台 case result：startedAt != null 在头的新形态在位 + 旧形态零残留 + meta 先于 markCompleted', () => {
  assert.match(
    bgResult,
    /const dur = startedAt != null\s*\?\s*\(Date\.now\(\) \+ \(store\.serverClockOffset\[sid\] \?\? 0\)\) - startedAt\s*:\s*\(typeof event\.duration_ms === 'number' && event\.duration_ms > 0 \? event\.duration_ms : null\);/,
    '缺 P5 后台翻转形态（startedAt 客户端计时在头、端点 duration_ms>0 兜底落 null）',
  );
  // 负向：旧「event.duration_ms 三元在头、startedAt 兜底」零残留。
  assert.ok(
    !/event\.duration_ms === 'number' && event\.duration_ms > 0\s*\?\s*event\.duration_ms\s*:\s*\(startedAt/.test(bgResult),
    '旧形态残留：duration_ms 在头、startedAt 兜底',
  );
  // 顺序硬要求（b1 ⑧ 同源）：meta 计算（turnStartedAt 捕获 + setLastTurnMeta）必须先于 markCompleted
  // ——markCompleted 会 delete turnStartedAt[sid]，晚读恒为 null。
  const capture = bgResult.indexOf('store.turnStartedAt[sid]');
  const setIdx = bgResult.indexOf('store.setLastTurnMeta(');
  const completed = bgResult.indexOf('store.markCompleted(sid)');
  assert.ok(capture > -1 && setIdx > -1 && completed > -1, '后台分支缺关键调用（捕获/setLastTurnMeta/markCompleted）');
  assert.ok(capture < completed, 'turnStartedAt 捕获必须先于 markCompleted');
  assert.ok(setIdx < completed, 'setLastTurnMeta 必须先于 markCompleted');
});

// ③ 三级判定形态覆盖 + P2-2 半写收口衔接。
check('P5-T3 两分支三级判定形态：clientMs 在→用之 / 缺→端点>0→端点值 / 皆无→null→P2-2 收口', () => {
  // 一级：clientMs 非空判定在头（前台 clientMs != null / 后台 startedAt != null）。
  assert.match(front, /message\.durationMs = clientMs != null/, '前台缺一级判定（clientMs != null）');
  assert.match(bgResult, /const dur = startedAt != null/, '后台缺一级判定（startedAt != null）');
  // 二级：端点值 >0 真值兜底，尾值落端点（sdk-backend 补 0 形态被 >0 门拦住）。
  assert.match(front, /typeof duration === 'number' && duration > 0 \? duration : null/, '前台缺二级端点兜底');
  assert.match(bgResult, /typeof event\.duration_ms === 'number' && event\.duration_ms > 0 \? event\.duration_ms : null/, '后台缺二级端点兜底');
  // 三级：皆无 → null → session-store setLastTurnMeta P2-2 早退（半写收口：保持上一条有效记录）。
  assert.match(
    sessionStore,
    /if \(meta\.durationMs == null \|\| meta\.durationMs <= 0 \|\| !Number\.isFinite\(meta\.durationMs\)\) return;/,
    'session-store P2-2 早退字面缺失（null 收口衔接断裂）',
  );
});

// ④ R6 客户端计时换算字面（不动清单：clientMs 计算式 1175）。
check('P5-T4 两分支客户端计时仍含 serverClockOffset[sid] 换算（R6 语义字面在位）', () => {
  assert.match(
    front,
    /const clientMs = startedAt && sid \? \(Date\.now\(\) \+ \(store\.serverClockOffset\[sid\] \?\? 0\)\) - startedAt : null;/,
    '前台 clientMs 计算式被改动（R6 换算丢失）',
  );
  assert.match(bgResult, /\(Date\.now\(\) \+ \(store\.serverClockOffset\[sid\] \?\? 0\)\) - startedAt/, '后台 dur 缺 serverClockOffset 换算');
});

console.log('\n=== P5-T5~T8 · 载荷同源与不动清单静态钉 ===');

// ⑤ 持久化载荷同源。
check('P5-T5 recordTurnMeta 载荷两分支均取翻转后同值（持久化列=全程口径）', () => {
  // 前台主流程载荷：durationMs 取 finalDuration（读翻转后的 message.durationMs 真值判断）。
  assert.match(
    front,
    /const finalDuration = typeof message\.durationMs === 'number' && message\.durationMs > 0 \? message\.durationMs : null;/,
    '前台 finalDuration 真值判断被改动',
  );
  const payloadIdx = front.indexOf('window.claudeLink.recordTurnMeta(sid, {');
  assert.ok(payloadIdx > -1, '前台缺 recordTurnMeta 主载荷');
  const payload = front.slice(payloadIdx, payloadIdx + 320);
  assert.match(payload, /messageId: message\.id,/, '前台载荷 messageId 异常');
  assert.match(payload, /durationMs: finalDuration,/, '前台载荷 durationMs 未取翻转后 finalDuration');
  // 空回合 fallback 载荷（hb10-TM-03 路径）：同步翻转 clientMs ?? 端点兜底。
  assert.match(
    front,
    /durationMs: clientMs \?\? \(typeof duration === 'number' && duration > 0 \? duration : null\),/,
    '前台空回合 fallback 载荷未同步翻转',
  );
  // 后台载荷：durationMs: dur。
  const bgPayloadIdx = bgResult.indexOf('window.claudeLink.recordTurnMeta(sid, {');
  assert.ok(bgPayloadIdx > -1, '后台缺 recordTurnMeta 载荷');
  const bgPayload = bgResult.slice(bgPayloadIdx, bgPayloadIdx + 320);
  assert.match(bgPayload, /durationMs: dur,/, '后台载荷 durationMs 未取翻转后 dur');
  // 会话级 meta 与持久化载荷同源：setLastTurnMeta 各取 finalDuration / dur。
  assert.match(front, /store\.setLastTurnMeta\(sid, \{ durationMs: finalDuration, endedAt \}\);/, '前台 setLastTurnMeta 未取 finalDuration');
  assert.match(bgResult, /store\.setLastTurnMeta\(sid, \{ durationMs: dur, endedAt \}\);/, '后台 setLastTurnMeta 未取 dur');
});

// ⑥ 不动清单：costUsd / 成功门控 / TM-01 守卫字面。
check('P5-T6 costUsd 逻辑 / isSuccessfulCliResult 门控 / turnStartedAt!=null 守卫字面不变（hb10 ⑧ 同源）', () => {
  assert.match(front, /message\.costUsd = typeof cost === 'number' && cost > 0 \? cost : null;/, '前台 costUsd 逻辑被改动');
  assert.match(bgResult, /costUsd: typeof event\.total_cost_usd === 'number' && event\.total_cost_usd > 0 \? event\.total_cost_usd : null,/, '后台 costUsd 逻辑被改动');
  assert.match(front, /costUsd: typeof cost === 'number' && cost > 0 \? cost : null,/, '前台空回合载荷 costUsd 逻辑被改动');
  assert.match(front, /if \(sid && isSuccessfulCliResult\(event\) && store\.turnStartedAt\[sid\] != null\) \{/, '前台持久化门控字面被改动（P2-1+TM-01）');
  assert.match(front, /if \(sid && !hitAssistant && isSuccessfulCliResult\(event\) && store\.turnStartedAt\[sid\] != null\) \{/, '前台空回合门控字面被改动（TM-03+TM-01）');
  assert.match(bgResult, /if \(startedAt != null\) \{/, '后台 TM-01 守卫字面被改动（hb10 ⑧）');
  assert.match(bgResult, /if \(isSuccessfulCliResult\(event\)\) \{/, '后台成功门控字面被改动');
});

// ⑦ P2-1：持久化仍限成功 result；error/aborted 分支零持久化。
check('P5-T7 持久化仍限成功 result（中断/错误不落库；内存脚注行为不变）', () => {
  assert.match(front, /中断\/错误回合不产生记录/, '前台 P2-1 语义注释缺失');
  // 前台内存脚注赋值（costUsd/durationMs/endedAt）在持久化门控之外（中断/错误回合内存行为不变）。
  const assignIdx = front.indexOf('message.durationMs =');
  const gateIdx = front.indexOf('if (sid && isSuccessfulCliResult(event) && store.turnStartedAt[sid] != null) {');
  assert.ok(assignIdx > -1 && gateIdx > assignIdx, '内存脚注赋值必须先于持久化门控（中断/错误也写内存）');
  // 后台失败路径：else 分支仅 markStopped（P2-3 footnoteOutcome），无持久化调用。
  const elseIdx = bgResult.indexOf('} else {');
  const brkIdx = bgResult.indexOf('break;', elseIdx);
  const elseBody = bgResult.slice(elseIdx, brkIdx > -1 ? brkIdx : undefined);
  assert.ok(elseBody.includes("markStopped(sid, { footnoteOutcome: 'error' })"), '后台失败路径形态变化');
  assert.ok(!elseBody.includes('recordTurnMeta') && !elseBody.includes('setLastTurnMeta'), '失败回合落库（P2-1 被破坏）');
  // 后台 error/aborted case：同样零持久化（仅 markStopped 分流脚注）。
  const bgErrorCase = bg.slice(errorCase);
  const bgErrorBrk = bgErrorCase.indexOf('break;');
  const bgErrorBody = bgErrorCase.slice(0, bgErrorBrk > -1 ? bgErrorBrk : undefined);
  assert.ok(bgErrorBody.includes('markStopped(sid,'), '后台 error/aborted 形态变化');
  assert.ok(!bgErrorBody.includes('recordTurnMeta') && !bgErrorBody.includes('setLastTurnMeta'), 'error/aborted 回合落库（P2-1 被破坏）');
  // 前台 handleCliEvent 的 error case：零持久化调用。
  const cliSection = useChat.slice(cliIdx);
  const cliErrorIdx = cliSection.indexOf("case 'error': {");
  const cliAbortedIdx = cliSection.indexOf("case 'aborted': {");
  assert.ok(cliErrorIdx > -1 && cliAbortedIdx > cliErrorIdx, '前台缺 error case 锚点');
  const cliErrorBody = cliSection.slice(cliErrorIdx, cliAbortedIdx);
  assert.ok(!cliErrorBody.includes('recordTurnMeta') && !cliErrorBody.includes('setLastTurnMeta'), '前台 error 回合落库（P2-1 被破坏）');
});

// ⑧ turn_ended 权威消费不动（F1-1d 同源）。
check('P5-T8 turn_ended 分支照旧消费主进程权威 event.durationMs/endedAt', () => {
  const teIdx = useChat.indexOf("case 'turn_ended': {");
  const teResultIdx = useChat.indexOf("case 'result': {", teIdx);
  const teBody = useChat.slice(teIdx, teResultIdx > -1 ? teResultIdx : undefined);
  assert.match(teBody, /store\.setLastTurnMeta\(sid, \{ durationMs: event\.durationMs, endedAt: event\.endedAt \}\);/, 'turn_ended 成功分支缺权威 durationMs/endedAt 消费');
  assert.match(teBody, /durationMs: event\.durationMs,/, 'turn_ended recordTurnMeta 缺权威 durationMs');
  assert.match(teBody, /store\.setTurnFootnote\(sid, \{ outcome: event\.outcome, durationMs: event\.durationMs, endedAt: event\.endedAt \}\);/, 'turn_ended 脚注记账缺权威数据面');
  assert.match(teBody, /if \(!store\.runningSessions\.includes\(sid\)\) break;/, 'turn_ended running 守卫缺失');
});

console.log('\n=== P5-T9 · pinia store 直测（setLastTurnMeta P2-2 语义不变） ===');

// 无头环境 stub（p1-04 同式）。
(globalThis as unknown as { window: unknown }).window = {
  claudeLink: {
    analyzeTopic: async () => null,
    getSessionMessages: async () => [],
    deleteSession: async () => {},
  },
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { createPinia, setActivePinia } = require('pinia');
setActivePinia(createPinia());
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { useSessionStore } = require('../src/renderer/stores/session-store');

const store = useSessionStore();
store.sessions = [{ id: 'p5-s1', name: 'P5 直测会话' }] as never;
store.activeSession = store.sessions[0] as never;

check('P5-T9a setLastTurnMeta 正数写入：lastTurnMeta map + Session 字段就地同值', () => {
  store.setLastTurnMeta('p5-s1', { durationMs: 4200, endedAt: 11111 });
  assert.equal(store.lastTurnMeta['p5-s1']?.durationMs, 4200, 'map 未写入');
  assert.equal(store.lastTurnMeta['p5-s1']?.endedAt, 11111, 'map endedAt 不符');
  assert.equal((store.sessions[0] as unknown as { lastTurnDurationMs: number }).lastTurnDurationMs, 4200, 'Session 字段未就地补写');
  assert.equal((store.sessions[0] as unknown as { lastTurnEndedAt: number }).lastTurnEndedAt, 11111, 'Session endedAt 未就地补写');
});

check('P5-T9b null/0/负数/NaN/Infinity 早退不写（P2-2 半写收口语义不变）', () => {
  const before = { ...store.lastTurnMeta['p5-s1'] };
  for (const bad of [null, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
    store.setLastTurnMeta('p5-s1', { durationMs: bad as unknown as number, endedAt: 22222 });
  }
  assert.deepEqual(store.lastTurnMeta['p5-s1'], before, '无效耗时破坏了上一条有效记录（P2-2 早退失效）');
});

check('P5-T9c markRunning 新回合边界：清 turnFootnote、不清 lastTurnMeta（最近一回合语义不变）', () => {
  store.setTurnFootnote('p5-s1', { outcome: 'success', durationMs: 100, endedAt: 200 });
  assert.ok(store.turnFootnote['p5-s1'], '前置脚注未落位（会话尚未 running）');
  store.markRunning('p5-s1', 5000, 5000); // 新回合边界（首次加入 runningSessions）
  assert.equal(store.turnFootnote['p5-s1'], undefined, '新回合未清脚注槽');
  assert.equal(store.lastTurnMeta['p5-s1']?.durationMs, 4200, '新回合误清了最近回合 meta');
});

check('P5-T9d deleteSession 清理：lastTurnMeta 随会话删除一并清理（字面 + 行为双钉）', () => {
  const dsIdx = sessionStore.indexOf('async deleteSession(id: string) {');
  assert.ok(dsIdx > -1, '未定位 deleteSession');
  const dsBody = sessionStore.slice(dsIdx, dsIdx + 4000);
  assert.ok(dsBody.includes('delete this.lastTurnMeta[id];'), 'deleteSession 缺 lastTurnMeta 清理字面');
  // 行为：乐观清理段同步摘除内存 map（IPC stub 掉；首个 await 之前全同步）。
  store.sessions = [{ id: 'p5-s2', name: 'P5 删除会话' }] as never;
  store.setLastTurnMeta('p5-s2', { durationMs: 300, endedAt: 1 });
  assert.ok(store.lastTurnMeta['p5-s2'], '前置写入失败');
  void store.deleteSession('p5-s2').catch(() => {});
  assert.equal(store.lastTurnMeta['p5-s2'], undefined, 'deleteSession 未清理 lastTurnMeta');
});

console.log('\n=== spawn 门（b1/hb10/b3 三卷退出码 0） ===');
const spawnGate = (script: string, name: string) => check(name, () => {
  const r = spawnSync('npx', ['tsx', script], {
    cwd: repoRoot,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（翻转波及既有接入/顺序/守卫钉）\n${tail}`);
});
void spawnGate('scripts/tdd-bugfix-b1-turn-meta-persistence-verify.ts', 'spawn tdd-bugfix-b1-turn-meta-persistence-verify.ts 退出码 0（B1 接入+P2-1 门控钉）');
void spawnGate('scripts/tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts', 'spawn tdd-bugfix-hb10-engine-turnmeta-p3-verify.ts 退出码 0（TM 守卫+引擎批钉）');
void spawnGate('scripts/tdd-bugfix-b3-turn-endtime-bubble-verify.ts', 'spawn tdd-bugfix-b3-turn-endtime-bubble-verify.ts 退出码 0（endedAt 链+SQL 形态钉）');

const summary = `\n结果：${pass} 通过 / ${fail} 失败`;
console.log(summary);
process.exit(fail === 0 ? 0 : 1);
