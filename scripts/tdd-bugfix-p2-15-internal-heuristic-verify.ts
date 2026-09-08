// tdd-bugfix-p2-15-internal-heuristic-verify.ts
// P2-15 契约钉：internal 描述启发式子串误伤——用户命令描述含英文单词 "internal" 即被隐藏。
//
// 修复语义：收窄为 \bserver-launched\b | \bserver\s+session\b | \bserver-only\b | (internal)
// ——真实内置命令的标记形态保留，普通描述里的 internal 单词不再误判。
//
// 运行：npx tsx scripts/tdd-bugfix-p2-15-internal-heuristic-verify.ts

import { strict as assert } from 'node:assert';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { classifyOrigin } = require('../src/main/modules/sdk-command-registry');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 200)}`); }
}

const NO_CTX = { skills: [], plugins: [] } as never;

check('① 用户命令描述含 "internal" 单词不再误判 internal', () => {
  const o = classifyOrigin('my-audit', 'Audit internal APIs', undefined, NO_CTX);
  assert.notEqual(o, 'internal', String(o));
});
check('② 真实标记 server-launched 仍判 internal', () => {
  assert.equal(classifyOrigin('x', 'server-launched maintenance command', undefined, NO_CTX), 'internal');
});
check('③ 真实标记 (internal) 仍判 internal', () => {
  assert.equal(classifyOrigin('x', 'Run diagnostics (internal)', undefined, NO_CTX), 'internal');
});
check('④ 真实标记 server-only / server session 仍判 internal', () => {
  assert.equal(classifyOrigin('x', 'server-only helper', undefined, NO_CTX), 'internal');
  assert.equal(classifyOrigin('x', 'Runs in a server session', undefined, NO_CTX), 'internal');
});
check('⑤ 名称 __ 前缀仍判 internal（回归）', () => {
  assert.equal(classifyOrigin('__tick', 'anything', undefined, NO_CTX), 'internal');
});
check('⑥ 普通用户命令描述不受影响', () => {
  const o = classifyOrigin('deploy', 'Deploy the project', undefined, NO_CTX);
  assert.notEqual(o, 'internal', String(o));
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
