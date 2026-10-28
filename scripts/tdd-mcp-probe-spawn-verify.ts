// tdd-mcp-probe-spawn-verify.ts
// P2（MCP 探活超时对齐 10s→30s + 失败日志，2026-10-27 五问题计划 round-001 p2）真实 spawn 契约：
//   A 自证框架：node 直跑 fixture → ok 且 toolCount=2（证明探活握手链与 fixture 行为对齐）；
//   B 用户故障同形回归钉（win32 only）：cmd /c node fixture → ok（cmd 直通形态真实可探活，
//     即用户报障「cmd /c npx 配置」的最小同形；非 win32 平台跳过）；
//   C 超时路径：FAKE_MCP_DELAY_MS=8000 + 入参 timeoutMs=1500 → fail 且 error 含「探活超时」与「1500」；
//   D 默认超时解析：DEFAULT_PROBE_TIMEOUT_MS === 30_000；resolveProbeTimeoutMs 缺省 → 30000、
//     超配 999999 → 封顶 120000、合法 5000 → 5000。
// 运行：npx tsx scripts/tdd-mcp-probe-spawn-verify.ts（已登记 scripts/selftest-static-list.txt）

import { strict as assert } from 'node:assert';
import { fileURLToPath } from 'node:url';
import { DEFAULT_PROBE_TIMEOUT_MS, probeMcpServer, resolveProbeTimeoutMs } from '../src/main/modules/mcp/mcp-probe';

const fixtureAbs = fileURLToPath(new URL('./fixtures/fake-mcp-stdio-server.mjs', import.meta.url));

let pass = 0;
let fail = 0;
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try { await fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

// tsx 以 CJS 形态编译本目录脚本（package.json 无 "type":"module"），顶层 await 不可用 → main() 包裹。
async function main(): Promise<void> {
  console.log('\n=== A. node 直跑 fixture：探活框架自证（ok + toolCount=2） ===');
  await check('A1 probeMcpServer({command:node, args:[fixture]}) → ok 且 toolCount=2', async () => {
    const r = await probeMcpServer({ name: 'fake', transport: 'stdio', command: 'node', args: [fixtureAbs] });
    assert.equal(r.status, 'ok', `status=${r.status} error=${r.error ?? ''}`);
    assert.equal(r.toolCount, 2, `toolCount=${r.toolCount}`);
  });

  console.log('\n=== B. cmd /c node fixture（win32 用户故障同形回归钉） ===');
  if (process.platform !== 'win32') {
    console.log('  ⏭ 非 win32 平台，B 组跳过');
  } else {
    await check('B1 probeMcpServer({command:cmd, args:[/c,node,fixture]}) → ok 且 toolCount=2', async () => {
      const r = await probeMcpServer({ name: 'fake-cmd', transport: 'stdio', command: 'cmd', args: ['/c', 'node', fixtureAbs] });
      assert.equal(r.status, 'ok', `status=${r.status} error=${r.error ?? ''}`);
      assert.equal(r.toolCount, 2, `toolCount=${r.toolCount}`);
    });
  }

  console.log('\n=== C. 超时路径（fixture 慢响应 + 短探活预算） ===');
  await check('C1 FAKE_MCP_DELAY_MS=8000 + timeoutMs=1500 → fail 且 error 匹配 /探活超时/ 且含 1500', async () => {
    const r = await probeMcpServer(
      { name: 'fake-slow', transport: 'stdio', command: 'node', args: [fixtureAbs], env: { FAKE_MCP_DELAY_MS: '8000' } },
      1500,
    );
    assert.equal(r.status, 'fail', `status=${r.status}（慢响应应超时 fail）`);
    assert.match(r.error ?? '', /探活超时/, `error=${r.error ?? ''}`);
    assert.ok((r.error ?? '').includes('1500'), `error 未含生效超时值 1500：${r.error ?? ''}`);
  });

  console.log('\n=== D. 默认超时解析（DEFAULT_PROBE_TIMEOUT_MS / resolveProbeTimeoutMs） ===');
  await check('D1 DEFAULT_PROBE_TIMEOUT_MS === 30_000', () => {
    assert.equal(DEFAULT_PROBE_TIMEOUT_MS, 30_000);
  });
  await check('D2 resolveProbeTimeoutMs(undefined) === 30_000（缺省默认对齐 30s）', () => {
    assert.equal(resolveProbeTimeoutMs(undefined), 30_000);
  });
  await check('D3 resolveProbeTimeoutMs({timeoutMs:999999}) === 120_000（封顶不变）', () => {
    assert.equal(resolveProbeTimeoutMs({ timeoutMs: 999999 }), 120_000);
  });
  await check('D4 resolveProbeTimeoutMs({timeoutMs:5000}) === 5000（条目覆盖透传）', () => {
    assert.equal(resolveProbeTimeoutMs({ timeoutMs: 5000 }), 5000);
  });

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  if (fail > 0) process.exit(1);
}

void main();
