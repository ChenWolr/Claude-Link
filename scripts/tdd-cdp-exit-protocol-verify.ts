// tdd-cdp-exit-protocol-verify.ts
// review-v4 High-2：CDP 不可用时 cdp-context-e2e 必须走前置条件协议（exit 2），不得 FATAL exit 1。
// 无 app 环境即可运行：用不可达端口（127.0.0.1:1，连接即刻拒绝）驱动真实脚本，验证进程退出码
// 与证据落盘（行为验证，非源码字符串检查）。
// 运行：npx tsx scripts/tdd-cdp-exit-protocol-verify.ts（已接入 selftest:static）
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = process.cwd();
const EVID_ROOT = 'D:/software/Cache/claude-link/context-research';

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

const startedAt = Date.now();
// 127.0.0.1:1 —— Windows 保留端口，连接立刻拒绝；CDP_PORT 环境变量覆盖（脚本侧已支持）。
const r = spawnSync('node', ['scripts/cdp-context-e2e.mjs'], {
  cwd: REPO,
  encoding: 'utf8',
  env: { ...process.env, CDP_PORT: '1' },
  timeout: 60_000,
});

console.log('=== review-v4 High-2：CDP 不可用 → exit 2 前置协议（真实进程行为）===');
check('进程退出码为 2（环境前置，非实现回归 exit 1）', () => {
  assert.ok(r.status != null, `进程未正常退出（signal=${r.signal}）`);
  assert.equal(r.status, 2, `期望 exit 2，实际 ${r.status}\nstdout 尾部：${(r.stdout ?? '').slice(-300)}`);
});
check('输出含「前置条件不满足」且不含 FATAL', () => {
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
  assert.ok(out.includes('前置条件不满足'), '缺前置条件不满足提示');
  assert.ok(!out.includes('FATAL'), '不得把连接失败归为 FATAL（exit 1 语义）');
});
check('证据目录落盘（summary/assertions/scrub-scan），exitReason 为 precondition', () => {
  const dirs = readdirSync(EVID_ROOT)
    .filter((d) => d.startsWith('e2e-cdp-ctx-'))
    .map((d) => ({ d, t: statSync(resolve(EVID_ROOT, d)).mtimeMs }))
    .filter((x) => x.t >= startedAt - 1000)
    .sort((a, b) => b.t - a.t);
  assert.ok(dirs.length > 0, '未发现本次运行产生的证据目录');
  const dir = resolve(EVID_ROOT, dirs[0].d);
  assert.ok(existsSync(resolve(dir, 'assertions.json')), '缺 assertions.json（允许为空数组，不得伪造通过）');
  const assertions = JSON.parse(readFileSync(resolve(dir, 'assertions.json'), 'utf8')) as Array<{ status?: string }>;
  assert.ok(assertions.every((a) => a.status === 'pass' || a.status === 'fail' || a.status === 'skipped'), '断言状态只能是 pass/fail/skipped');
  assert.ok(existsSync(resolve(dir, 'scrub-scan.txt')), '缺 scrub-scan.txt');
  const summary = readFileSync(resolve(dir, 'summary.md'), 'utf8');
  assert.ok(summary.includes('precondition'), `summary 退出原因应为 precondition，实际：${summary.split('\n').find((l) => l.includes('退出原因')) ?? '(无)'}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
