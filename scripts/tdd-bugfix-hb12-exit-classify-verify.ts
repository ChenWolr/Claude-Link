// scripts/tdd-bugfix-hb12-exit-classify-verify.ts
// hb12 P2-2【终态重构批】契约（hb12-ENG-01 + hb10-ENG-V01 改写版 + hb12-QUE-02）。
//
// 语义不变量：result 权威 > 显式终态标记 > 退出码兜底，任何路径不得把「已中断」记成 success。
//   ① 出口②（流丢 result 合成 aborted）：emitExit(null) + 同序列显式 noteTurnOutcome('interrupted')，
//     entry.knownOutcome='interrupted'（原 emitExit(0) 被兜底结算 success = 队列假成功+arm）；
//   ② exit 兜底两处（ipc-handlers / task-queue-engine）同一分类语义：读 entry 已知终态，
//     有终态即让位（no-op）；无终态时 0=success、null/非 0=error（系统杀维持失败语义）；
//   ③ hb10-ENG-V01 原修法（null→success 直映）作废——watchdog/系统杀路径 emitExit(null)
//     是该路径唯一队列结算信号，null→success 会把杀路径记成功。
//
// 运行：npx tsx scripts/tdd-bugfix-hb12-exit-classify-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');
const engine = read('src/main/modules/task-queue-engine.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

// ① 出口②。
check('① 出口②：emitExit(null) + 显式 noteTurnOutcome(interrupted)（emitExit 之前）+ knownOutcome 置位', () => {
  const idx = backend.indexOf('hb12-P2-2（出口② 终态重构）');
  assert.ok(idx > -1, '未定位出口② 改造段');
  const seg = backend.slice(idx, idx + 1400);
  assert.match(seg, /entry\.knownOutcome = 'interrupted';/, '缺 knownOutcome 置位');
  assert.match(seg, /noteTurnOutcome\(sessionId, 'interrupted', mainWindow\);/, '缺显式 interrupted 结算');
  assert.match(seg, /emitExit\(null\);/, '缺 emitExit(null)');
  const noteIdx = seg.indexOf("noteTurnOutcome(sessionId, 'interrupted', mainWindow);");
  const exitIdx = seg.indexOf('emitExit(null);');
  assert.ok(noteIdx < exitIdx, '显式结算必须先于 emitExit');
  // 出口② 段内不得再有 emitExit(0)
  assert.ok(!seg.slice(0, exitIdx).includes('emitExit(0)'), '出口② 段内残留 emitExit(0)');
});

// ② knownOutcome 机制。
check('② knownOutcome：SessionEntry 字段 + result 权威置位 + 导出查询', () => {
  assert.match(backend, /knownOutcome\?: 'success' \| 'error' \| 'interrupted';/, 'SessionEntry 缺字段');
  assert.match(backend, /if \(hookEntry && !hookEntry\.knownOutcome\) hookEntry\.knownOutcome = outcome;/, 'forwardEvent result 钩子缺置位');
  assert.match(backend, /entry\.knownOutcome = sdkMsg\.is_error === true \? 'error' : 'success';/, 'runQuery result 到达处缺粗标');
  assert.match(backend, /export function getKnownTurnOutcome\(sessionId: string\)/, '缺导出查询');
});

// ③ 两处兜底一致。
check('③ 兜底分类（ipc + tqe）：knownOutcome 让位 + 0/非0 分类；禁止 null→success 直映', () => {
  const ipcIdx = handlers.indexOf("child.on('exit', (code) => {");
  const ipcBody = handlers.slice(ipcIdx, ipcIdx + 900);
  assert.match(ipcBody, /getKnownTurnOutcome\(sessionId\)/, 'ipc 兜底缺终态读取');
  assert.match(ipcBody, /if \(known\) return;/, 'ipc 兜底缺让位');
  assert.match(ipcBody, /code === 0 \? 'success' : 'error'/, 'ipc 兜底分类形态（0=success，其余含 null=error）');

  const tqeIdx = engine.indexOf("noteTurnOutcome(sessionId, code === 0 ? 'success' : 'error', mainWindow);", engine.indexOf('child.on'));
  assert.ok(tqeIdx > -1, 'tqe 兜底缺退出码分类');
  const tqeSeg = engine.slice(tqeIdx - 600, tqeIdx);
  assert.match(tqeSeg, /getKnownTurnOutcome\(sessionId\)/, 'tqe 兜底缺终态读取');
  // 禁止 null→success 直映（hb10-ENG-V01 原修法作废）
  for (const src of [handlers, engine]) {
    assert.doesNotMatch(src, /code === 0 \|\| code === null \? 'success'/, '出现 null→success 直映（watchdog 杀路径会被记成功）');
  }
});

// ④ hb12-QUE-02：合成 aborted 触发结算（出口② 的 noteTurnOutcome 即载体，判定幂等由 running 闸）。
check('④ 合成 aborted 触发 noteTurnOutcome(interrupted)（幂等：同回合 aborted+exit 只结算一次）', () => {
  const idx = backend.indexOf('hb12-P2-2（出口② 终态重构）');
  const seg = backend.slice(idx, idx + 1400);
  assert.match(seg, /try \{[\s\S]{0,120}noteTurnOutcome\(sessionId, 'interrupted', mainWindow\);[\s\S]{0,120}\} catch \(err\) \{/, '结算须 try 包裹（对齐周围风格）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
