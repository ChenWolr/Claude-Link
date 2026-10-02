// tdd-connection-tester-async-cleanup-verify.ts
// B6（D02-F2，P3）契约钉：临时目录清理重试去同步睡眠（Atomics.wait 清退主进程阻塞）。
//
// 根因（D02-F2 CONFIRMED）：cleanupTestCwd 用 Atomics.wait 同步睡眠实现 250/1000/4000ms
// 延迟重试，全部失败累计阻塞主进程事件循环 5250ms——期间全部 IPC/定时器/UI 停摆
// （会话发送/中断/流式转发/队列调度全冻结）。触发路径恰是「测试超时/失败」用户正盯着屏幕的场景。
//
// 修复语义：重试改 setTimeout 异步链（fire-and-forget，调用点不 await——中止/落定路径
// 即时返回，测试行为与档位语义不变）；立即首删（0ms 档）保留；全部失败 console.warn
// 留证保留；函数名与两处调用点不动（tdd-bugfix-opt2-10-smallfixes-verify 钉 cleanupTestCwd
// 存在与 finishWith/abortActiveTest 调用点）。
//
// 运行：npx tsx scripts/tdd-connection-tester-async-cleanup-verify.ts

import { readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try {
    fn();
    pass++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ❌ ${name} — ${(e as Error).message}`);
  }
}

const src = readFileSync(new URL('../src/main/modules/connection-tester.ts', import.meta.url), 'utf8');

console.log('\n=== B6（D02-F2）：连接测试临时目录清理去 Atomics.wait 同步睡眠 ===');
check('connection-tester 全文件无 Atomics.wait（主进程零同步睡眠）', () => {
  assert.ok(!src.includes('Atomics.wait'), '仍存在 Atomics.wait 同步阻塞');
  assert.ok(!src.includes('Atomics.'), '不应残留任何 Atomics 用法');
});
check('重试档位语义不变（250/1000/4000 三档延迟）', () => {
  assert.match(src, /\[0, 250, 1000, 4000\]/, '延迟档位清单缺失');
});
check('重试为 setTimeout 异步链（不再同步循环睡眠）', () => {
  const idx = src.indexOf('function cleanupTestCwd');
  assert.ok(idx > -1, '缺 cleanupTestCwd');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /setTimeout\(run, ms\)/, '延迟档应走 setTimeout');
});
check('立即首删（0ms 档同步执行）保留', () => {
  const idx = src.indexOf('function cleanupTestCwd');
  const body = src.slice(idx, src.indexOf('\n}', idx));
  assert.match(body, /if \(ms > 0\) setTimeout\(run, ms\);\s*else run\(\);/, '0ms 档应同步直跑');
});
check('全部失败 console.warn 留证保留', () => {
  assert.match(src, /console\.warn\('\[connection-tester\] 临时目录清理失败（已重试）：'/, '缺失败留证日志');
});
check('函数名与两处调用点不动（opt2-10 契约：finishWith + abortActiveTest）', () => {
  assert.match(src, /function cleanupTestCwd\(dir: string\): void/, '函数签名应保持（fire-and-forget 同步返回）');
  const calls = src.match(/cleanupTestCwd\((?:active\.cwd|testCwd)\);/g) ?? [];
  assert.equal(calls.length, 2, `调用点应仍为 2 处，实得 ${calls.length}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
