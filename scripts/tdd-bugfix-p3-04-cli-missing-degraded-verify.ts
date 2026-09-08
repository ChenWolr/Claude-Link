// tdd-bugfix-p3-04-cli-missing-degraded-verify.ts
// P3-4 契约钉：CLI 缺失时暂态会话斜杠菜单永久「正在读取」无失败出口。
//
// 修复语义：全局探测无 exe 时置 cliMissing 标志；COMMANDS_GET 只读分流据此返回 degraded
// 快照（status:'degraded' + error 文案，菜单显示「未检测到本地 Claude Code」），再次打开
// 菜单经 ensureGlobalCommandProbeFresh 重试；探测成功/新探测启动清位。
//
// 运行：npx tsx scripts/tdd-bugfix-p3-04-cli-missing-degraded-verify.ts

import { strict as assert } from 'node:assert';
import {
  resolveCommandsGetResult,
  type CommandsGetInput,
} from '../src/shared/commands-get';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const base: CommandsGetInput = {
  sessionExists: false,
  hasSnapshot: false,
  snapshot: { sessionId: 's1', commands: [], status: 'loading', source: 'default', updatedAt: null },
  fallback: null,
};

check('① 无兜底 + cliMissing → degraded 快照（显式失败出口）', () => {
  const d = resolveCommandsGetResult({ ...base, cliMissing: true });
  assert.equal(d.readOnly, true);
  assert.equal(d.snapshot.status, 'degraded');
  assert.match(d.snapshot.error ?? '', /未检测到本地 Claude Code/);
});
check('② 无兜底 + CLI 在 → 维持 loading（回归不变）', () => {
  const d = resolveCommandsGetResult({ ...base });
  assert.equal(d.snapshot.status, 'loading');
});
check('③ 有兜底时即使 cliMissing 也返回兜底副本（回归不变）', () => {
  const d = resolveCommandsGetResult({
    ...base,
    cliMissing: true,
    fallback: { sessionId: 'g', commands: [], status: 'empty', source: 'probe', updatedAt: null },
  });
  assert.equal(d.snapshot.status, 'empty');
  assert.equal(d.snapshot.source, 'cache');
});
check('④ 持久会话路径不受 cliMissing 影响（needsFullProbeSideEffects 照常）', () => {
  const d = resolveCommandsGetResult({ ...base, sessionExists: true, cliMissing: true });
  assert.equal(d.needsFullProbeSideEffects, true);
});

// 结构：主进程接线。
import * as fs from 'node:fs';
import * as path from 'node:path';
const backend = fs.readFileSync(path.resolve(__dirname, '../src/main/modules/sdk-backend.ts'), 'utf8');
const handlers = fs.readFileSync(path.resolve(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');

check('⑤ 全局探测无 exe 置位 + 新探测启动清位', () => {
  assert.match(backend, /let globalCliMissing = false;/);
  assert.match(backend, /export function isGlobalCliMissing/);
  const noExeAt = backend.indexOf('if (!exe) {', backend.indexOf('runGlobalCommandProbeInternal'));
  const seg = backend.slice(noExeAt, noExeAt + 700);
  assert.ok(seg.includes('globalCliMissing = true'), seg.slice(0, 120));
  const startAt = backend.indexOf('export function runGlobalCommandProbe(');
  assert.ok(backend.slice(startAt, startAt + 300).includes('globalCliMissing = false;'));
});
check('⑥ COMMANDS_GET 传入 cliMissing', () => {
  assert.match(handlers, /cliMissing: isGlobalCliMissing\(\)/);
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
