// tdd-bugfix-p3-03-nonshell-tool-hardkill-relax-verify.ts
// P3-3 契约钉：静默长工具 900s 绝对硬杀误伤——tool_progress 只有 Bash/PowerShell/REPL 会发
//（验证轮坐实），MCP/WebSearch/Task 等工具全程无心跳，静默是正常时长而非死锁。
//
// 修复语义：tracker 记录最近工具名（lastToolName，tool_use 记录/result 清空）；watchdogTick
// 硬杀分支对「tool 区 + 已知非 shell 家族工具」只保留 stalled 横幅、不硬杀；shell 家族与
// 未知路径维持旧行为。classifyStall 纯函数不改（tdd-stall-watchdog-verify 基线不破）。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-03-nonshell-tool-hardkill-relax-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');
const backend = fs.readFileSync(path.join(repoRoot, 'src/main/modules/sdk-backend.ts'), 'utf8');
const watchdog = fs.readFileSync(path.join(repoRoot, 'src/shared/stall-watchdog.ts'), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

check('① StallTracker 增加 lastToolName 字段（reset 初始化 null）', () => {
  assert.match(backend, /lastToolName: string \| null;/);
  assert.match(backend, /lastToolName: null,/);
});
check('② tool_use 记录工具名', () => {
  const at = backend.indexOf('if (part.type === \'tool_use\' || part.type === \'server_tool_use\' || part.type === \'mcp_tool_use\') {', backend.indexOf('touchActivityFromEvent'));
  const seg = backend.slice(at, at + 600);
  assert.match(seg, /lastToolName = toolName/);
});
check('③ 全部工具结束清空 lastToolName', () => {
  const at = backend.indexOf('if (set.size === 0) t.lastToolName = null;');
  assert.ok(at > -1);
});
check('④ 硬杀分支对「tool 区 + 已知非 shell 家族」只横幅不硬杀', () => {
  const at = backend.indexOf('const knownNonShellTool =');
  assert.ok(at > -1);
  const seg = backend.slice(at, at + 500);
  assert.ok(seg.includes("verdict.zone === 'tool'"));
  assert.ok(seg.includes('/^(bash|powershell|repl)$/i.test(t.lastToolName)'));
  assert.ok(seg.includes('continue;'));
});
check('⑤ 既有 shell 家族/未知路径硬杀保留（hardAbortFired 主路径不动）', () => {
  const at = backend.indexOf('const knownNonShellTool =');
  const after = backend.slice(at);
  assert.ok(after.includes('t.hardAbortFired = true;'));
  assert.ok(after.indexOf('t.hardAbortFired = true;') > after.indexOf('if (knownNonShellTool)'));
});
check('⑥ classifyStall 纯函数不改（基线不破）', () => {
  assert.match(watchdog, /export function classifyStall/);
  assert.ok(!watchdog.includes('knownNonShellTool'));
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
