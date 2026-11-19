// tdd-rr-autoretry-interrupt-mutex-verify.ts
// B1（2026-11-15 eight-issues-batch §B1）契约脚本：reasoning_replay 自动重试 × 中断互斥。
//
// 根因（00-behavior-specs §B1 现状事实）：本回合曾命中 reasoning_replay 400 时置标志
//（cli-shared persistMessageParts→noteReasoningReplayError），中断不清标志（清点全在下一回合
// 起步）；中断优雅收尾 result 无条件调度自动重试（sdk-backend result 出口），2s 二次守卫仅查
// hasRunningQuery/isSessionAlive、无中断边沿判定 → 用户中断后 2s 整回合原样真重发。
//
// 修复语义（00 §B1 行为契约五条）：
//   1. user(CHAT_ABORT)/watchdog/upstream_fatal/queue/session_cleanup 任一边沿：已排程重试取消、
//      未排程不再排程；  2. 边沿同步清除命中标志；  3. 二次守卫新增「本回合曾中断」双保险；
//   4. 正常失败回合自动重试一次逐字不变（B1-00 spawn 回归门）；  5. 重试已发出后中断新回合 =
//      正常中断，无第三次。
//
// 驱动手法（03-test-cases-main §2）：真实 reasoning-replay-auto-retry 模块 + 既有测试钩子
//（_testonlyInjectTurnError / recordOutgoingUserText / maybeScheduleReasoningReplayRetry spy ctx /
// willAutoRetryReasoningReplay 观测面 / clearReasoningReplayTurnFlag），中断边沿经真实
// sdk-backend.killProcess 触发（reason ∈ user/watchdog/upstream_fatal/queue/session_cleanup）。
// 夹具：_load 拦截同 tdd-reasoning-replay-resilience-verify（electron/connection/session-repo）、
// CLAUDE_LINK_TEST_USERDATA 临时目录、resent spy、2s 定时器用真实时钟（等待窗 ≤3s）。
//
// 观测面边界申报：spy ctx 世界无真实 runQuery 流，「新回合起步」以 clearReasoningReplayTurnFlag
//（runQuery 起步清点的同一真实导出，sdk-backend runQuery 内调用）模拟；「resendUserText 若被调
// 不得产生新回合起步」以 isSessionAlive 兜底接线（stub 会话仓）表达；回合全链路收尾归 B1-00
// spawn 回归门（复用 resilience + X10 两卷）覆盖。
//
// P3-1（2026-11-19 验收 r1）：B1-00 spawn 门稳态化——两个子进程卷的 spawnSync 加 ≤2 次瞬态
// 重试（仅非零退出才重跑，exit 0 唯一通过判定不变），吸收 npx/tsx 冷启动抖动（验收首跑 5 失败、
// 复跑 47/0 全过的瞬态）；断言语义零变化，真回归在重试耗尽后照常红。
//
// 运行：npx tsx scripts/tdd-rr-autoretry-interrupt-mutex-verify.ts

// ── 0. 在 require 任何主进程模块之前装 _load hook（同 tdd-reasoning-replay-resilience-verify）──
const Module = require('module');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('node:child_process');
const { v4: uuidv4 } = require('uuid');

const repoRoot = path.resolve(__dirname, '..');
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-rr-mutex-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;

let fakeRowid = 0;
const fakeStmt = {
  run: () => ({ lastInsertRowid: ++fakeRowid, changes: 1 }),
  all: () => [],
  get: () => undefined,
  finalize() { /* no-op */ },
};
const fakeDb = {
  prepare: () => fakeStmt,
  transaction: (fn: () => unknown) => fn,
  pragma: () => undefined,
  exec: () => undefined,
  close() { /* no-op */ },
};
const fakeConnection = { getConnection: () => fakeDb, closeConnection: () => {} };

const sessions = new Map<string, Record<string, unknown>>();
const sessionRepoStub = {
  createSession: (name: string, model: string, workingDir: string | null) => {
    const id = uuidv4();
    const s = { id, name, model, workingDir: workingDir ?? null, cliSessionId: null as string | null };
    sessions.set(id, s);
    return s;
  },
  getSession: (id: string) => sessions.get(id) ?? null,
  updateCliSessionId: () => null,
  updateLastContext: () => null,
  updateLastContextWindow: () => null,
  updateLastContextUsed: () => null,
};

const origLoad = Module._load;
Module._load = function (req: string, parent: NodeJS.Module | undefined, isMain: boolean) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]connection$/.test(req)) return fakeConnection;
  if (/[\\/]session-repo$/.test(req)) return sessionRepoStub;
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
};

// ── 1. 安全 require 真实模块（sdk-backend 内部 import 的 resilience 模块为同一实例）──
const rr = require('../src/main/modules/reasoning-replay-auto-retry');
const { killProcess } = require('../src/main/modules/sdk-backend');
const { saveConfig } = require('../src/main/modules/config-manager');

saveConfig({ cliPath: process.execPath });

const retrySrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/reasoning-replay-auto-retry.ts'), 'utf8');
const backendSrc = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');
const ipcSrc = fs.readFileSync(path.join(repoRoot, 'src/main/ipc-handlers.ts'), 'utf8');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(label: string, fn: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fn()) return;
    await sleep(100);
  }
  throw new Error(`等待超时：${label}`);
}

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function freshId(): string {
  return `rr-mutex-${uuidv4()}`;
}

function makeSpyWindow(sink: Record<string, unknown>[]) {
  const { setWebPushSink } = require('../src/main/modules/push-bus');
  setWebPushSink((_channel: string, args: unknown[]) => {
    const payload = args[0] as { event?: Record<string, unknown> } | undefined;
    if (payload && payload.event) sink.push(payload.event);
  });
  return {
    webContents: {
      send: (_channel: string, payload: { sessionId: string; event: Record<string, unknown> }) => {
        if (payload && payload.event) sink.push(payload.event);
      },
    },
    isDestroyed: () => true,
    isFocused: () => true,
  };
}
const ipcSink: Record<string, unknown>[] = [];
const win = makeSpyWindow(ipcSink);

/** B1 spy ctx：hasRunningQuery=false / isSessionAlive 可选接线 / wasTurnInterrupted 可选闩。
 *  旧实现（无 wasTurnInterrupted 成员）下多余成员被忽略——本脚本对旧实现跑出失败面（红）。 */
function scheduleSpy(sessionId: string, opts: { isSessionAlive?: () => boolean; wasTurnInterrupted?: () => boolean } = {}) {
  const resent: string[] = [];
  const notices: string[] = [];
  const ctx: Record<string, unknown> = {
    sessionId,
    mainWindow: win,
    hasRunningQuery: () => false,
    isSessionAlive: opts.isSessionAlive ?? (() => true),
    forwardSystemNotice: (_subtype: string, text: string) => { notices.push(text); },
    resendUserText: (text: string) => { resent.push(text); },
  };
  if (opts.wasTurnInterrupted) ctx.wasTurnInterrupted = opts.wasTurnInterrupted;
  rr.maybeScheduleReasoningReplayRetry(ctx as unknown as Parameters<typeof rr.maybeScheduleReasoningReplayRetry>[0]);
  return { resent, notices };
}

type KillReasonT = 'user' | 'watchdog' | 'upstream_fatal' | 'queue' | 'session_cleanup';
const FOUR: KillReasonT[] = ['user', 'watchdog', 'upstream_fatal', 'queue'];
const FIVE: KillReasonT[] = [...FOUR, 'session_cleanup'];

/** 截取 src 中 from 起到 endMarker（不含）的片段。 */
function bodyBetween(src: string, from: string, endMarker: string): string {
  const at = src.indexOf(from);
  if (at < 0) return '';
  const end = src.indexOf(endMarker, at + from.length);
  return src.slice(at, end > at ? end : src.length);
}

(async () => {
  // ── 2. 结构钉 B1-S1 / B1-S2（03 §2.3；锚点回填：见各断言名） ──
  console.log('\n=== 结构钉 B1-S1/S2 ===');
  {
    // B1-S1（回填锚点）：reasoning-replay-auto-retry.ts cancelReasoningReplayRetryForInterrupt ——
    // 单函数同时完成「取消已排程重试（clearTimeout+pendingTimers.delete）+ 清命中标志
    //（turnHasReasoningReplayError.delete）」，且不触碰重试载体/防重入闩/发起标记三态。
    const cancelFn = bodyBetween(retrySrc, 'export function cancelReasoningReplayRetryForInterrupt', 'export function recordOutgoingUserText');
    check('S1 取消函数导出且同时含取消 timer + 清标志两动作',
      cancelFn.includes('clearTimeout(timer)') && cancelFn.includes('pendingTimers.delete(sessionId)') &&
      cancelFn.includes('turnHasReasoningReplayError.delete(sessionId)'),
      '函数体缺失或动作不全');
    check('S1 取消函数只动两态（不触碰载体/闩/发起标记）',
      !cancelFn.includes('lastUserTextBySession') && !cancelFn.includes('retriedTextBySession') &&
      !cancelFn.includes('autoRetryDispatched'),
      '取消函数触碰了非契约状态');
    // B1-S1（回填锚点）：sdk-backend.ts killProcess 内调用点位于 pendingFirstPrompt.delete 之后、
    // entry 取用分支之前 → user/watchdog/upstream_fatal/queue/session_cleanup 五族 reason 全部
    // 无条件流经该咽喉（边沿入口 = killProcess 收尾点，单一挂接覆盖全部 KillReason）。
    const kBody = bodyBetween(backendSrc, 'export function killProcess(', 'export function killAllProcesses');
    const pdIdx = kBody.indexOf('pendingFirstPrompt.delete(sessionId);');
    const callIdx = kBody.indexOf('cancelReasoningReplayRetryForInterrupt(sessionId);');
    const entryIdx = kBody.indexOf('const entry = entries.get(sessionId);');
    const between = pdIdx >= 0 && callIdx > pdIdx ? kBody.slice(pdIdx, callIdx) : '';
    check('S1 killProcess 内五族边沿共用挂接点存在', callIdx >= 0, '未找到 cancelReasoningReplayRetryForInterrupt 调用');
    check('S1 挂接点在 entry 分支之前（任意 KillReason 必经）', callIdx >= 0 && entryIdx > callIdx,
      `callIdx=${callIdx} entryIdx=${entryIdx}`);
    check('S1 挂接点无条件执行（与 pendingFirstPrompt.delete 之间无 reason 条件包裹）',
      between.length > 0 && !between.includes('if ('), between.replace(/\n/g, ' ').slice(0, 120));
    // B1-S1 五族边沿入口走 killProcess：CHAT_ABORT(user)/watchdog/upstream_fatal/session_cleanup
    // 实调存在；queue 为保留枚举（申报不修的死枚举清理），KillReason 联合含 'queue' 即被咽喉覆盖。
    check('S1 CHAT_ABORT → killProcess(user) 接线存在', ipcSrc.includes("killProcess(sessionId, 'user', mainWindowRef)"));
    check('S1 watchdog / upstream_fatal / session_cleanup 调用点存在',
      backendSrc.includes("killProcess(sessionId, 'watchdog'") &&
      backendSrc.includes("killProcess(sessionId, 'upstream_fatal'") &&
      backendSrc.includes("killProcess(sessionId, 'session_cleanup')"));
    check('S1 KillReason 联合含 queue（保留枚举经同一咽喉覆盖）', /export type KillReason =[\s\S]*?\| 'queue'/.test(backendSrc));

    // B1-S2（回填锚点）：ReasoningReplayRetryCtx.wasTurnInterrupted 可选成员 + maybeSchedule 同步段
    // 判定 + 定时回调二次守卫三连判定（读边沿写入的中断闩，非复用既有两项）。
    check('S2 ctx 增可选成员 wasTurnInterrupted?: () => boolean', retrySrc.includes('wasTurnInterrupted?: () => boolean;'));
    const syncBody = bodyBetween(retrySrc, 'export function maybeScheduleReasoningReplayRetry', 'const timer = setTimeout');
    check('S2 同步段含「曾中断」判定（调度点拦截）', syncBody.includes('if (ctx.wasTurnInterrupted?.()) return;'), '同步段判定缺失');
    const timerBody = bodyBetween(retrySrc, 'const timer = setTimeout', 'pendingTimers.set(sessionId, timer);');
    check('S2 二次守卫三连判定含「曾中断」（回调内兜底）',
      /ctx\.hasRunningQuery\(\) \|\| !ctx\.isSessionAlive\(\) \|\| ctx\.wasTurnInterrupted\?\.\(\)/.test(timerBody),
      '回调守卫未读中断闩');
    // S2 配套：sdk-backend 调度链透传（签名第三参 + 两调用点各传 () => interruptedQueries.has(query)）。
    const schedBody = bodyBetween(backendSrc, 'function scheduleReasoningReplayRetryForTurn(', 'export function spawnForTask');
    check('S2 调度函数签名第三参并透传进 ctx',
      schedBody.includes('wasTurnInterrupted?: () => boolean,') && schedBody.includes('wasTurnInterrupted,'));
    const callSiteCount = backendSrc.split('scheduleReasoningReplayRetryForTurn(sessionId, mainWindow, () => interruptedQueries.has(query));').length - 1;
    check('S2 两调用点（result 出口 + 流丢 result 出口）各传中断闩', callSiteCount === 2, `调用点计数=${callSiteCount}`);
  }

  // ── 3. 行为用例 B1-01~07（真实时钟 2s 定时器，等待窗 ≤3s） ──

  // B1-01 user/watchdog/upstream_fatal/queue 四边沿取消已排程重试（条款1 前半）。
  console.log('\n=== B1-01 四边沿取消已排程重试（条款1 前半） ===');
  for (const reason of FOUR) {
    const id = freshId();
    rr.recordOutgoingUserText(id, '帮我查天气'); // ① 重试载体
    rr._testonlyInjectTurnError(id);             // ① 置命中标志
    const { resent, notices } = scheduleSpy(id); // ② 排程（spy ctx，2s 定时器在途）
    killProcess(id, reason, win);                // ③ 立即触发边沿（2s 定时器未到）
    await sleep(2600);                           // ④ 等待 >2.5s
    check(`B1-01 ${reason}: 已排程重试被取消（resent 零调用）`, resent.length === 0, `resent=${JSON.stringify(resent)}`);
    check(`B1-01 ${reason}: 等待窗内无二次排程且取消静默（notices 零）`,
      notices.length === 0 && resent.length === 0, `notices=${JSON.stringify(notices)}`);
  }

  // B1-02 session_cleanup 边沿同款互斥（条款1 补全）。
  console.log('\n=== B1-02 session_cleanup 边沿互斥 ===');
  {
    // a) 主断言（同 B1-01 形态，会话保持存活——生产 session_cleanup 边沿（如发送失败收口
    //    ipc-handlers killProcess(sessionId,'session_cleanup')）时会话记录尚在，isSessionAlive
    //    兜底不挡，幽灵重发在旧实现下可见（红面所在）。
    const idA = freshId();
    sessions.set(idA, { id: idA });                // stub 会话在册（isSessionAlive 全程为真）
    rr.recordOutgoingUserText(idA, '帮我查天气');
    rr._testonlyInjectTurnError(idA);
    const a = scheduleSpy(idA, { isSessionAlive: () => sessions.has(idA) });
    killProcess(idA, 'session_cleanup', win);      // 删除链路 killProcess 边沿
    await sleep(2600);
    check('B1-02a session_cleanup: 已排程重试被取消（resent 零调用）',
      a.resent.length === 0, `resent=${JSON.stringify(a.resent)}`);
    sessions.delete(idA);

    // b) 追加断言：删除后 resendUserText 若被调也不得产生新回合起步（与 isSessionAlive 兜底叠加）。
    const idB = freshId();
    sessions.set(idB, { id: idB });
    rr.recordOutgoingUserText(idB, '帮我查天气');
    rr._testonlyInjectTurnError(idB);
    const b = scheduleSpy(idB, { isSessionAlive: () => sessions.has(idB) });
    killProcess(idB, 'session_cleanup', win);
    sessions.delete(idB);                          // 删除会话（markSessionDeleted 的 isSessionAlive 兜底形态）
    await sleep(2600);
    check('B1-02b 删除后即便重发也无新回合起步（isSessionAlive 兜底叠加，resent 零调用）',
      b.resent.length === 0, `resent=${JSON.stringify(b.resent)}`);
  }

  // B1-03 五族边沿同步清除命中标志（条款2；谓词 willAutoRetryReasoningReplay 作观测面）。
  console.log('\n=== B1-03 边沿同步清除命中标志（条款2） ===');
  for (const reason of FIVE) {
    const id = freshId();
    rr.recordOutgoingUserText(id, '任务文本');
    rr._testonlyInjectTurnError(id);
    check(`B1-03 ${reason}: 前置（置标志后谓词 true，观测面活性）`, rr.willAutoRetryReasoningReplay(id) === true);
    killProcess(id, reason, win);
    check(`B1-03 ${reason}: 边沿后谓词 false（命中标志已清除）`, rr.willAutoRetryReasoningReplay(id) === false);
  }

  // B1-04 二次守卫「本回合曾中断」双保险（条款3）。
  console.log('\n=== B1-04 二次守卫双保险（条款3） ===');
  {
    // a) 真实边沿在窗内（~0.5s 处）：排程后边沿 → 定时器被取消，resent 零调用。
    const idA = freshId();
    rr.recordOutgoingUserText(idA, '帮我查天气');
    rr._testonlyInjectTurnError(idA);
    const a = scheduleSpy(idA);          // 2s 定时器在途
    await sleep(500);
    killProcess(idA, 'user', win);       // 定时器到期前触发 user 边沿
    await sleep(2600);
    check('B1-04a 窗内真实边沿：定时器取消，resent 零调用', a.resent.length === 0, `resent=${JSON.stringify(a.resent)}`);

    // b) 最坏情形：排程清理被竞态绕过，仅剩回调内「曾中断」判定兜底（经 ctx 注入面驱动中断闩，
    //    03 §2.2 B1-04「_testonly 注入面」授权形态）。
    const idB = freshId();
    let interruptedB = false;
    rr.recordOutgoingUserText(idB, '帮我查天气');
    rr._testonlyInjectTurnError(idB);
    const b = scheduleSpy(idB, { wasTurnInterrupted: () => interruptedB });
    await sleep(500);
    interruptedB = true;                 // 边沿写入中断闩（排程清理失效的最坏形态）
    await sleep(2600);
    check('B1-04b 回调内「曾中断」判定兜底拦截（resent 零调用）', b.resent.length === 0, `resent=${JSON.stringify(b.resent)}`);

    // b-对照：闩不翻转时同一机制必须真实重发（归因对照——证明 b 的零调用确由该判定拦截）。
    const idC = freshId();
    rr.recordOutgoingUserText(idC, '帮我查天气');
    rr._testonlyInjectTurnError(idC);
    const c = scheduleSpy(idC, { wasTurnInterrupted: () => false });
    await waitFor('B1-04 对照：中断闩不翻转时 2s 重发真实发生', () => c.resent.length >= 1);
    check('B1-04对照 中断闩不翻转时重发照常发出（恰好一次）', c.resent.length === 1, `resent=${JSON.stringify(c.resent)}`);
  }

// B1-05 重试已实际发出后中断新回合：正常中断、无第三次（条款5）。
console.log('\n=== B1-05 重试发出后中断新回合（条款5） ===');
{
  const id = freshId();
  rr.recordOutgoingUserText(id, '帮我查天气');
  rr._testonlyInjectTurnError(id);
  const first = scheduleSpy(id);                            // 排程
  await waitFor('B1-05 首次重发实际发出（resent=1）', () => first.resent.length >= 1);
  check('B1-05 重试已实际发出（resent=1，X10 行为④ 先例）', first.resent.length === 1);
  rr.clearReasoningReplayTurnFlag(id);                      // 新回合起步清点（runQuery 起步同一真实导出）
  rr.recordOutgoingUserText(id, '新问题文本');               // 新回合起步刷新载体（spawnForChat 同源；换文本为观测
  // 隔声——防重入闩持有旧文本且谓词为 AND 链，同文本会让「标志位」与「闩/pending」互相遮蔽，
  // 换文本使谓词对标志位单敏感；机制与 01 边界值表「中断后手动重发刷新载体」行同源）。
  rr._testonlyInjectTurnError(id);                          // 新回合命中（回合再遇 rr 错误形态）
  killProcess(id, 'user', win);                             // 用户中断该新回合（此刻无 pending timer、闩≠载体）
  check('B1-05 新回合中断边沿清除命中标志（B1-03 联动；谓词对标志单敏感）',
    rr.willAutoRetryReasoningReplay(id) === false);
  const second = scheduleSpy(id, { wasTurnInterrupted: () => true }); // 中断后迟到 result 出口调度尝试（真实形态：闩=真）
  await sleep(2600);
  check('B1-05 resent 停在 1（无第三次重发；边沿后迟到 result 不再排程）',
    first.resent.length === 1 && second.resent.length === 0,
    `first=${JSON.stringify(first.resent)} second=${JSON.stringify(second.resent)}`);
}

  // B1-06 边沿与排程同 tick 竞态（派生边界·并发）。
  console.log('\n=== B1-06 边沿与排程同 tick 竞态 ===');
  {
    // 序 A：同一同步块内 排程 → 边沿（两者间无 await）。
    const idA = freshId();
    let interruptedA = false;
    rr.recordOutgoingUserText(idA, '帮我查天气');
    rr._testonlyInjectTurnError(idA);
    const a = scheduleSpy(idA, { wasTurnInterrupted: () => interruptedA });
    killProcess(idA, 'user', win);        // 同步栈内紧随边沿
    interruptedA = true;                  // 边沿已将本回合记入中断闩（interruptedQueries 形态）
    await sleep(2600);
    check('B1-06 序A 先排程后边沿（同 tick）：resent 零调用', a.resent.length === 0, `resent=${JSON.stringify(a.resent)}`);

    // 序 B：反序 边沿 → 排程（同 tick；迟到 result 带中断闩 + abort 尾巴重置标志的最坏形态）。
    const idB = freshId();
    rr.recordOutgoingUserText(idB, '帮我查天气');
    rr._testonlyInjectTurnError(idB);
    killProcess(idB, 'user', win);        // 先边沿
    rr._testonlyInjectTurnError(idB);     // abort 尾巴内迟到正文重新置标志
    const b = scheduleSpy(idB, { wasTurnInterrupted: () => true }); // 后排程（迟到 result 形态，闩=真）
    await sleep(2600);
    check('B1-06 序B 先边沿后排程（同 tick）：resent 零调用', b.resent.length === 0, `resent=${JSON.stringify(b.resent)}`);
  }

  // B1-07 连续两边沿幂等（派生边界·异常）。
  console.log('\n=== B1-07 连续两边沿幂等 ===');
  {
    const id = freshId();
    rr.recordOutgoingUserText(id, '帮我查天气');
    rr._testonlyInjectTurnError(id);
    const { resent } = scheduleSpy(id);
    let threw = '';
    try {
      killProcess(id, 'user', win);
      killProcess(id, 'user', win);       // 连续第二次边沿
    } catch (e) {
      threw = e instanceof Error ? e.message : String(e);
    }
    check('B1-07 连续两边沿无异常', threw === '', threw);
    await sleep(2600);
    check('B1-07 resent 零调用', resent.length === 0, `resent=${JSON.stringify(resent)}`);
    check('B1-07 标志保持 false', rr.willAutoRetryReasoningReplay(id) === false);
    rr._testonlyInjectTurnError(id);
    const predAfter = rr.willAutoRetryReasoningReplay(id);
    rr.clearReasoningReplayTurnFlag(id);  // 清理（收尾不留态）
    check('B1-07 取消不误清载体/闩（重置标志后谓词恢复 true）', predAfter === true);
  }

  // ── 4. B1-00 正常失败自动重试既有行为回归门（条款4 红线，spawn 复用不重写） ──
  console.log('\n=== B1-00 spawn 回归门（正常失败回合自动重试一次逐字不变） ===');
  // P3-1（2026-11-19 验收 r1）稳态化：仅对非零退出重跑（≤2 次重试），exit 0 唯一通过判定不变；
  // 重试命中时留痕输出，真回归在重试耗尽后照常红。
  function spawnGateWithRetry(args: string[]): { status: number | null; error?: Error; tail: string } {
    let lastStatus: number | null = null;
    let lastError: Error | undefined;
    let lastTail = '';
    for (let run = 1; run <= 3; run++) {
      const r = spawnSync('npx', args, { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
      lastStatus = r.status;
      lastError = r.error;
      lastTail = `${r.stdout ?? ''}${r.stderr ?? ''}`.slice(-300).trim();
      if (r.status === 0) {
        if (run > 1) console.log(`  ⚠️ B1-00 ${args[1]} 第 ${run} 次运行通过（前 ${run - 1} 次瞬态失败已吸收）`);
        return { status: lastStatus, error: lastError, tail: lastTail };
      }
    }
    return { status: lastStatus, error: lastError, tail: lastTail };
  }
  {
    const g1 = spawnGateWithRetry(['tsx', 'scripts/tdd-reasoning-replay-resilience-verify.ts']);
    check('B1-00 tdd-reasoning-replay-resilience-verify.ts exit 0（全链路/防重入/开关/命令文本；冷启动瞬态重试 ≤2 次）',
      g1.status === 0, g1.status === 0 ? '' : `exit=${g1.status}${g1.error ? ` err=${String(g1.error)}` : ''}\n${g1.tail}`);
    const g2 = spawnGateWithRetry(['tsx', 'scripts/tdd-queue-autoretry-halt-resume-verify.ts']);
    check('B1-00 tdd-queue-autoretry-halt-resume-verify.ts exit 0（X10 熔断自愈链；冷启动瞬态重试 ≤2 次）',
      g2.status === 0, g2.status === 0 ? '' : `exit=${g2.status}${g2.error ? ` err=${String(g2.error)}` : ''}\n${g2.tail}`);
  }

  console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((err) => {
  console.error('verify 抛错:', err);
  process.exit(1);
});
