// tdd-web-reopen-runtime-verify.ts
// 计划 docs/plans/2026-10-24-web-sync-directory-naming-export-plan.md §1（P1 网页运行态同步）
// 渲染端静态契约钉（G1-G4，源码文本/结构断言，不 import Electron）：
//   G1：关页重开丢 active——无独立代码，由 G2+G3+既有挂载无条件 applyRunningOverview 共同覆盖
//      （挂载/realign 两步已钉在 tdd-turn-projection-verify §7，本脚本不重复）。
//   G2：switchSession 对 running 会话拉投影细快照——running 条件 + getRuntimeSnapshot +
//      IPC 往返竞态守卫（activeSession.id 比对）+ try 包裹，且位于 turnStartIndex 计算之后、
//      maybeAnalyzeTopicForFirstUserMessage 回补之前。
//   G3：applyRunningOverview 透传 entry.serverNow 给 markRunning 第三参（刷新 serverClockOffset）。
//   G4：lastTurnEndedServerAt 终态对账——state 字段 + noteTurnEndedServer 单调记账 +
//      概览 skip 条件 + use-chat 两处 turn_ended 记账 + deleteSession 清理。
// 运行：npx tsx scripts/tdd-web-reopen-runtime-verify.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as assert from 'node:assert';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}
function countOccurrences(haystack: string, needle: string): number {
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i > -1) { n += 1; i = haystack.indexOf(needle, i + needle.length); }
  return n;
}
/** 提取 pinia action 段（session-store）：从签名出现处到其后第一个「列 4 的 },」收口。 */
function actionSeg(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  const end = src.indexOf('\n    },', start);
  return end === -1 ? src.slice(start) : src.slice(start, end);
}

/** 提取 composable 内层函数段（use-chat）：到下一个「列 2 的 function」声明处或文件尾。 */
function fnSeg(src: string, signature: string): string {
  const start = src.indexOf(signature);
  if (start === -1) return '';
  const next = src.indexOf('\n  function ', start + signature.length);
  return next === -1 ? src.slice(start) : src.slice(start, next);
}

const storeSrc = read('src/renderer/stores/session-store.ts');
const useChatSrc = read('src/renderer/composables/use-chat.ts');

// ── 1. G4 账本：state 字段 + noteTurnEndedServer 单调记账 ──────────────
console.log('=== 1) G4：lastTurnEndedServerAt state + noteTurnEndedServer action ===');
check('state 含 lastTurnEndedServerAt: {} as Record<string, number>',
  storeSrc.includes('lastTurnEndedServerAt: {} as Record<string, number>'));
const noteSeg = actionSeg(storeSrc, 'noteTurnEndedServer(sessionId: string, endedAt: number)');
check('noteTurnEndedServer action 存在且非空', noteSeg !== '');
check('noteTurnEndedServer 数值有限才写（Number.isFinite 守卫）',
  noteSeg.includes('Number.isFinite(endedAt)'));
check('noteTurnEndedServer 单调取 max（Math.max(prev ?? 0, endedAt)）',
  noteSeg.includes('Math.max(prev ?? 0, endedAt)'));
check('noteTurnEndedServer 全文件恰 1 处 action 定义（另 2 处为 use-chat 调用点，见 §4）',
  countOccurrences(storeSrc, 'noteTurnEndedServer(') === 1,
  `实际 ${countOccurrences(storeSrc, 'noteTurnEndedServer(')}`);

// ── 2. G4 概览对账：applyRunningOverview skip 条件 + G3 serverNow 透传 ──
console.log('=== 2) G3+G4：applyRunningOverview serverNow 透传 + endedAt 对账 skip ===');
const overviewSeg = actionSeg(storeSrc, 'applyRunningOverview(list: TurnRunningOverviewEntry[])');
check('applyRunningOverview 函数段提取非空', overviewSeg !== '');
check('G3：透传 entry.serverNow 给 markRunning 第三参',
  overviewSeg.includes('this.markRunning(entry.sessionId, entry.startedAt, entry.serverNow);'));
check('G4：对账 skip——读 lastTurnEndedServerAt[entry.sessionId]',
  overviewSeg.includes('this.lastTurnEndedServerAt[entry.sessionId]'));
check('G4：对账 skip——endedAt >= entry.startedAt 即 continue（同钟域比较，不得重新点亮黄灯）',
  overviewSeg.includes('endedAt != null && endedAt >= entry.startedAt'));
check('G4：skip 条件先于 markRunning（已结束回合不置运行态）',
  overviewSeg.indexOf('this.lastTurnEndedServerAt[entry.sessionId]') !== -1 &&
  overviewSeg.indexOf('this.lastTurnEndedServerAt[entry.sessionId]') <
  overviewSeg.indexOf('this.markRunning(entry.sessionId, entry.startedAt, entry.serverNow);'));
check('G4：既有 running-includes continue 仍在（先订阅后拉协议不重复 markRunning）',
  overviewSeg.includes('if (this.runningSessions.includes(entry.sessionId)) continue;'));
check('G3 依赖：markRunning 第三参 serverNow 签名存在',
  storeSrc.includes('markRunning(sessionId: string, startedAt?: number, serverNow?: number)'));

// ── 3. G2：switchSession 对 running 会话拉投影细快照 ──────────────────
console.log('=== 3) G2：switchSession running 条件快照拉取 + 竞态守卫 ===');
const switchSeg = actionSeg(storeSrc, 'async switchSession(session: Session)');
check('switchSession 函数段提取非空', switchSeg !== '');
check('G2：running 条件门（this.runningSessions.includes(session.id)）',
  switchSeg.includes('if (this.runningSessions.includes(session.id))'));
check('G2：getRuntimeSnapshot(session.id) 调用',
  switchSeg.includes('window.claudeLink.getRuntimeSnapshot(session.id)'));
check('G2：IPC 往返竞态守卫（this.activeSession?.id === session.id 才采用快照）',
  switchSeg.includes('this.activeSession?.id === session.id) this.applyRuntimeSnapshot(snap);'));
check('G2：try 包裹（投影恢复失败不致命，overview 路径兜底）',
  /if \(this\.runningSessions\.includes\(session\.id\)\) \{\s*try \{[\s\S]*?getRuntimeSnapshot\(session\.id\)[\s\S]*?\} catch \{/.test(switchSeg));
check('G2：位于 turnStartIndex 计算（computeTurnStartIndex）之后',
  switchSeg.indexOf('computeTurnStartIndex(this.messages)') !== -1 &&
  switchSeg.indexOf('computeTurnStartIndex(this.messages)') <
  switchSeg.indexOf('getRuntimeSnapshot(session.id)'));
check('G2：位于 maybeAnalyzeTopicForFirstUserMessage 回补之前',
  switchSeg.indexOf('getRuntimeSnapshot(session.id)') <
  switchSeg.indexOf('this.maybeAnalyzeTopicForFirstUserMessage('));
check('G4：deleteSession 清理 lastTurnEndedServerAt（防内存泄漏）',
  actionSeg(storeSrc, 'async deleteSession(id: string)').includes('delete this.lastTurnEndedServerAt[id];'));

// ── 4. G4：use-chat 两处 turn_ended 记账 ─────────────────────────────
console.log('=== 4) G4：use-chat 后台/前台两处 turn_ended 先记 endedAt ===');
check('use-chat noteTurnEndedServer 调用恰 2 处（后台 + 前台）',
  countOccurrences(useChatSrc, 'store.noteTurnEndedServer(') === 2,
  `实际 ${countOccurrences(useChatSrc, 'store.noteTurnEndedServer(')}`);
const bgSeg = fnSeg(useChatSrc, 'function handleBackgroundEvent(payload: ChatEventPayload)');
const fgSeg = fnSeg(useChatSrc, 'function handleCliEvent(');
check('后台路径 handleBackgroundEvent 段内 turn_ended 记账',
  bgSeg !== '' && bgSeg.includes("case 'turn_ended':") && bgSeg.includes('store.noteTurnEndedServer(sid, event.endedAt)'));
check('后台路径：记账先于迟到终态幂等守卫（被忽略的 turn_ended 也入对账账本）',
  (() => {
    const c = bgSeg.indexOf("case 'turn_ended':");
    const note = bgSeg.indexOf('store.noteTurnEndedServer(sid, event.endedAt)');
    const guard = bgSeg.indexOf('if (!store.runningSessions.includes(sid)) break;', c);
    return c > -1 && note > c && guard > note;
  })());
check('前台路径 handleCliEvent 段内 turn_ended 记账',
  fgSeg !== '' && fgSeg.includes("case 'turn_ended':") && fgSeg.includes('store.noteTurnEndedServer(sid, event.endedAt)'));
check('前台路径：记账先于 running 幂等守卫（sid 绑定后第一时间）',
  (() => {
    const c = fgSeg.indexOf("case 'turn_ended':");
    const note = fgSeg.indexOf('store.noteTurnEndedServer(sid, event.endedAt)');
    const guard = fgSeg.indexOf('if (!store.runningSessions.includes(sid)) break;', c);
    return c > -1 && note > c && guard > note;
  })());

console.log(`\n[web-reopen-runtime P1] pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.error(`[web-reopen-runtime P1] ❌ ${fail} 项断言失败`);
  process.exit(1);
}
assert.strictEqual(fail, 0);
console.log('[web-reopen-runtime P1] ✅ 全部通过');
