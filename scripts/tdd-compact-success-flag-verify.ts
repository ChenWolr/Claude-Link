// scripts/tdd-compact-success-flag-verify.ts
// X18（R04-F1）契约钉：压缩成功标记 compactedJustNow 的 entry 级提升与四类非 result 出口透传。
//
// 修复语义（round2 计划 X18）：P2-9 的 turnHadCompactSuccess/postCompactionFreshSent 原是
// runQuery 局部变量，仅 result 出口透传给 post-turn 探针；流丢 result（出口②）/ resume 重试
// 失败（出口⑤）/ SDK 错误（出口④）/ killProcess 中断兜底四处裸调探针——CU 控制通道失效
// 环境下压缩成功后无任何横幅反馈。修复：两标志镜像提升为 SessionEntry 字段（killProcess
// 独立函数可见），四处出口统一经 entryCompactedJustNow(entry) 透传；result 出口行为不变
//（P2-9 ①-⑥ 契约继续成立——局部变量仍为回合数据源，entry 为镜像）。
//
// 运行：npx tsx scripts/tdd-compact-success-flag-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① SessionEntry 新增两个可选字段（entry 级镜像；随 entry 生命周期，无跨回合残留）。
check('① SessionEntry 声明 turnHadCompactSuccess?/postCompactionFreshSent? 字段', () => {
  const at = backend.indexOf('interface SessionEntry {');
  assert.ok(at > -1, '缺 SessionEntry 接口');
  const body = backend.slice(at, backend.indexOf('const nextQueryInstance', at));
  assert.match(body, /turnHadCompactSuccess\?: boolean;/, '缺 turnHadCompactSuccess 字段');
  assert.match(body, /postCompactionFreshSent\?: boolean;/, '缺 postCompactionFreshSent 字段');
});

// ② 单源读取 helper：成功标志 + 双横幅防重（与 result 出口局部变量语义一致）。
check('② entryCompactedJustNow 单源 helper（=== true 成功 + !== true 双横幅防重）', () => {
  const at = backend.indexOf('function entryCompactedJustNow(entry: SessionEntry): boolean {');
  assert.ok(at > -1, '缺 helper 函数');
  const body = backend.slice(at, backend.indexOf('}', at));
  assert.match(body, /entry\.turnHadCompactSuccess === true/, '缺成功标志判定');
  assert.match(body, /entry\.postCompactionFreshSent !== true/, '缺双横幅防重判定');
});

// ③ compact_result 成功处置位镜像 entry。
check('③ compact_result success 置 turnHadCompactSuccess 时镜像 entry', () => {
  const at = backend.indexOf("if (sdkMsg.compact_result === 'success')");
  assert.ok(at > -1, '缺 compact_result success 处置点');
  const win = backend.slice(at, at + 700);
  assert.ok(win.includes('turnHadCompactSuccess = true'), '局部置位缺失（P2-9 ② 契约）');
  assert.ok(win.includes('entry.turnHadCompactSuccess = true'), '缺 entry 镜像置位');
});

// ④ 即时 fresh 实际送达镜像 entry（refreshContextSnapshot 的 onFreshSent 触发点）。
check('④ 即时 fresh 送达（opts.onFreshSent 触发点）镜像 entry.postCompactionFreshSent', () => {
  const at = backend.indexOf('opts.onFreshSent?.();');
  assert.ok(at > -1, '缺 onFreshSent 触发点');
  const win = backend.slice(Math.max(0, at - 400), at + 60);
  assert.ok(win.includes('opts.compactedJustNow && used != null'), '触发门缺失（P2-9 ⑥ 契约）');
  assert.ok(win.includes('entry.postCompactionFreshSent = true'), '缺 entry 镜像置位');
});

// ⑤ resume 重试二次起步重置局部 + entry 镜像（hb10-CTX-10 语义在镜像形态下保持）。
check('⑤ resume 重试二次起步重置双标志（局部 + entry 镜像同步）', () => {
  const at = backend.indexOf('hb10-CTX-10：重试不误弹横幅');
  assert.ok(at > -1, '缺 CTX-10 重置注释锚点');
  const win = backend.slice(at, at + 700);
  assert.ok(win.includes('turnHadCompactSuccess = false'), '缺局部重置');
  assert.ok(win.includes('postCompactionFreshSent = false'), '缺局部重置');
  assert.ok(win.includes('entry.turnHadCompactSuccess = false'), '缺 entry 镜像重置');
  assert.ok(win.includes('entry.postCompactionFreshSent = false'), '缺 entry 镜像重置');
});

// ⑥ sdk-backend 内 schedulePostTurnProbe 调用点枚举：全部携带 compactedJustNow（无裸调）。
check('⑥ schedulePostTurnProbe 调用点全枚举：每处都携带 compactedJustNow（无裸调）', () => {
  const calls: string[] = [];
  let idx = 0;
  while ((idx = backend.indexOf('schedulePostTurnProbe(', idx)) !== -1) {
    if (backend.slice(Math.max(0, idx - 9), idx) !== 'function ') {
      const end = backend.indexOf(');', idx);
      calls.push(backend.slice(idx, end + 2));
    }
    idx += 1;
  }
  assert.equal(calls.length, 5, `调用点应为 5 处（result/出口②/出口⑤/出口④/killProcess），实际 ${calls.length}`);
  for (const c of calls) {
    assert.ok(c.includes('compactedJustNow'), `存在裸调（无 compactedJustNow）：${c.slice(0, 160)}`);
  }
});

// ⑦ 四类非 result 出口均透传 entry 级标记 entryCompactedJustNow(entry)。
check('⑦ 四类非 result 出口均透传 entryCompactedJustNow(entry)', () => {
  // 出口②（流丢 result）：probeInstance2 调度点
  const at2 = backend.indexOf('schedulePostTurnProbe(sessionId, mainWindow, probeInstance2');
  assert.ok(at2 > -1, '缺出口② 调度点');
  const line2 = backend.slice(at2, backend.indexOf(');', at2) + 2);
  assert.ok(line2.includes('entryCompactedJustNow(entry)'), `出口② 未透传：${line2.slice(0, 200)}`);
  // 出口⑤（resume 重试失败）
  const c5 = backend.indexOf('出口⑤（resume 重试失败）');
  assert.ok(c5 > -1, '缺出口⑤ 注释锚点');
  const at5 = backend.indexOf('schedulePostTurnProbe(', c5);
  const line5 = backend.slice(at5, backend.indexOf(');', at5) + 2);
  assert.ok(line5.includes('entryCompactedJustNow(entry)'), `出口⑤ 未透传：${line5.slice(0, 200)}`);
  // 出口④（真实 SDK 错误）
  const c4 = backend.indexOf('出口④（真实 SDK 执行出错');
  assert.ok(c4 > -1, '缺出口④ 注释锚点');
  const at4 = backend.indexOf('schedulePostTurnProbe(', c4);
  const line4 = backend.slice(at4, backend.indexOf(');', at4) + 2);
  assert.ok(line4.includes('entryCompactedJustNow(entry)'), `出口④ 未透传：${line4.slice(0, 200)}`);
  // killProcess 中断兜底
  const ck = backend.indexOf('中断兜底探针必须在此处调度');
  assert.ok(ck > -1, '缺 killProcess 中断兜底注释锚点');
  const atk = backend.indexOf('schedulePostTurnProbe(', ck);
  const linek = backend.slice(atk, backend.indexOf(');', atk) + 2);
  assert.ok(linek.includes('entryCompactedJustNow(entry)'), `killProcess 出口未透传：${linek.slice(0, 200)}`);
});

// ⑧ result 正常出口行为不变：局部变量链照旧（P2-9 ③④ 契约），探针 opts 用局部 compactedJustNow。
check('⑧ result 出口行为不变：局部 const compactedJustNow + { compactedJustNow } 透传照旧', () => {
  assert.match(backend, /const compactedJustNow = turnHadCompactSuccess && !postCompactionFreshSent;/);
  const at = backend.indexOf('schedulePostTurnProbe(sessionId, mainWindow, probeInstance, probeCliSid');
  assert.ok(at > -1, '缺 result 出口调度点');
  const line = backend.slice(at, backend.indexOf(');', at) + 2);
  assert.ok(line.includes('{ compactedJustNow }'), `result 出口透传形态被改动：${line.slice(0, 200)}`);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
