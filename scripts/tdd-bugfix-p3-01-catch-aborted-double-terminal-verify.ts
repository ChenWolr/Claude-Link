// tdd-bugfix-p3-01-catch-aborted-double-terminal-verify.ts
// P3-1 契约钉：watchdog 硬杀优雅窗内流抛错 → 双终态（error+aborted 都发）且 aborted「已中断」落库；
// 顺带修正过期注释（persistCliEvent 对 aborted 有 case）与硬杀文案不一致（「已硬中断」→「已中断」）。
//
// 修复语义：catch 的 aborted 补发分支加条件 entry.forceKill == null——两段式优雅窗已接管
// （finishKill 路径已发终态并收口）时不补发；user 直杀照常补发。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-01-catch-aborted-double-terminal-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');
const cliShared = fs.readFileSync(path.join(repoRoot, 'src/main/modules/cli-shared.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① catch 的 aborted 补发带 entry.forceKill == null 条件（优雅窗接管不双发）', () => {
  const at = backend.indexOf('if (interruptedQueries.has(query)) {');
  const seg = backend.slice(at, at + 600);
  assert.match(seg, /if \(entry\.forceKill == null\) \{[\s\S]*?type: 'aborted'/);
});
check('② emitExit(null) 仍无条件执行（收口不丢）', () => {
  const at = backend.indexOf('if (interruptedQueries.has(query)) {');
  const seg = backend.slice(at, at + 700);
  const guardAt = seg.indexOf('entry.forceKill == null');
  const emitAt = seg.indexOf('emitExit(null)');
  assert.ok(emitAt > guardAt, 'emitExit 在补发块之后');
  assert.ok(!/forceKill == null[\s\S]*?emitExit\(null\);[\s\S]*?\}[\s\S]*?emitExit\(null\)/.test(seg.slice(guardAt)), '无第二个 emitExit');
});
check('③ finishKill 终态文案统一为「已中断」', () => {
  assert.ok(!backend.includes('已硬中断'), '旧硬杀专属文案应删除');
  const at = backend.indexOf("forwardEvent(sessionId, mainWindow, { type: 'aborted', message: '已中断' });", backend.indexOf("if (reason === 'watchdog' && mainWindow)"));
  assert.ok(at > -1, 'watchdog 补发文案=已中断');
});
check('④ 过期注释已纠偏（persistCliEvent 对 aborted 有 case）', () => {
  assert.ok(!backend.includes('无 case，不落库'), '「aborted 无 case 不落库」旧注释应删除');
  assert.ok(!backend.includes('persistCliEvent 无 case'), 'killProcess 段同类过期注释应删除');
});
check('⑤ cli-shared 的 aborted 落库 case 仍在（回归不变）', () => {
  assert.match(cliShared, /case 'aborted': \{[\s\S]*?system:aborted/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
