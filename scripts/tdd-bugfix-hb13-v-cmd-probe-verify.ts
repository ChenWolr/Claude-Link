// scripts/tdd-bugfix-hb13-v-cmd-probe-verify.ts
// hb13-v B6【命令后端】契约：探测终态三处守卫收口 + 失败快照兑现 + 探测中幂等。
//
// 病根（docs/audit/2026-09-13-uncommitted-verify-slash-commands.md F2/F3/F4/F5）：
//   F2/P1 hb10-CMD-07 只做置位半边——isGlobalProbeFailed 全仓零消费者，暂态菜单仍永久 loading；
//   F3/P2 init 早期快照写入（指纹 await 后）无代际/现役重查；
//   F4/P2 commands_changed 路径新增指纹 await 后无任何代际重查；
//   F5/P2 hb12-CMD-10 两加重未做——startCommandProbe 对在跑探针 cancel+respawn 而非复用，
//         needsRefreshProbeOnly 不感知探测中（10s 节流窗后仍反复 spawn/abort）。
//
// 运行：npx tsx scripts/tdd-bugfix-hb13-v-cmd-probe-verify.ts

import { strict as assert } from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveCommandsGetResult } from '../src/shared/commands-get';

const repoRoot = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

const backend = read('src/main/modules/sdk-backend.ts');
const handlers = read('src/main/ipc-handlers.ts');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 240)}`); }
}

const LOADING = { sessionId: 's1', status: 'loading' as const, commands: [], source: 'probe' as const };

// ① CMD-07 行为级：暂态 + 无兜底 + probeFailed → degraded 失败快照（菜单显式失败行退出 loading）。
check('① CMD-07 行为级：probeFailed → degraded 失败快照（error 文案可重试）', () => {
  const out = resolveCommandsGetResult({
    sessionExists: false,
    hasSnapshot: false,
    snapshot: LOADING,
    fallback: null,
    probeFailed: true,
  });
  assert.equal(out.readOnly, true, '失败分流不得触发会话副作用');
  assert.equal(out.snapshot.status, 'degraded', `仍返回 ${out.snapshot.status}（永久 loading 缺陷形态）`);
  assert.match(out.snapshot.error ?? '', /命令探测失败/, '缺「命令探测失败」文案');
  // cliMissing 优先（更具体）；probeFailed 单独成立时也生效。
  const out2 = resolveCommandsGetResult({ sessionExists: false, hasSnapshot: false, snapshot: LOADING, fallback: null, cliMissing: true, probeFailed: true });
  assert.match(out2.snapshot.error ?? '', /Claude Code/, 'cliMissing 文案应优先');
  // 有兜底时不受影响（cache 副本仍可用）。
  const out3 = resolveCommandsGetResult({ sessionExists: false, hasSnapshot: false, snapshot: LOADING, fallback: { ...LOADING, status: 'ready', commands: [{ name: 'a', description: '', argumentHint: '', aliases: [], source: 'sdk' as const }] }, probeFailed: true });
  assert.equal(out3.snapshot.status, 'ready', '有兜底时失败旗标不得覆盖 cache 副本');
});

// ② CMD-10 行为级：探测中（probeInProgress）不返回 needsRefreshProbeOnly（不重复 spawn/abort）。
check('② CMD-10 行为级：stale × probeInProgress → needsRefreshProbeOnly=false；探测结束恢复', () => {
  const base = { sessionExists: true, hasSnapshot: true, snapshot: { ...LOADING, status: 'ready' as const, originFingerprint: 'fp-old' }, currentUserFingerprint: 'fp-new' };
  const probing = resolveCommandsGetResult({ ...base, probeInProgress: true });
  assert.equal(probing.needsRefreshProbeOnly, false, '探测中仍触发 needsRefreshProbeOnly（cancel+respawn 循环）');
  const idle = resolveCommandsGetResult({ ...base, probeInProgress: false });
  assert.equal(idle.needsRefreshProbeOnly, true, '探测结束后应恢复免费重探');
});

// ③ startCommandProbe 探测中幂等：存活探针复用 donePromise（不再 cancel+respawn）。
check('③ CMD-10 结构：startCommandProbe 入口复用存活探针 donePromise', () => {
  const idx = backend.indexOf('export async function startCommandProbe');
  const body = backend.slice(idx, backend.indexOf('\n}', idx));
  const reuseIdx = body.search(/commandProbes\.get\(sessionId\)/);
  assert.ok(reuseIdx > -1, '入口未检测存活探针');
  const seg = body.slice(reuseIdx, reuseIdx + 400);
  assert.match(seg, /!existing\.aborted/, '缺 aborted 判定（取消中探针不得复用）');
  assert.match(seg, /await existing\.donePromise;/, '存活探针未复用 donePromise');
  const cancelIdx = body.indexOf('cancelCommandProbeInternal(sessionId, 1000)');
  assert.ok(cancelIdx > reuseIdx, 'cancel+respawn 应位于复用分支之后（仅对已取消/残留探针）');
});

// ④ F3/F4：replace 守卫统一 helper，三处共用（probe 既有 / init 早期 / changed）。
check('④ F3/F4：replaceCommandSnapshotIfCurrent 守卫 helper 存在且三处调用', () => {
  assert.match(backend, /async function replaceCommandSnapshotIfCurrent\(/, '缺守卫 helper');
  assert.match(backend, /replaceCommandSnapshotIfCurrent\(sessionId, mainWindow, \{[^}]*source: 'probe'/, 'probe 主路径未换用 helper');
  assert.match(backend, /replaceCommandSnapshotIfCurrent\(sessionId, mainWindow, \{[^}]*source: 'init'/, 'init 早期快照写入未换用 helper（F3）');
  assert.match(backend, /replaceCommandSnapshotIfCurrent\(sessionId, mainWindow, \{[^}]*source: 'changed'/, 'changed 路径未换用 helper（F4）');
  const hIdx = backend.indexOf('async function replaceCommandSnapshotIfCurrent(');
  const hBody = backend.slice(hIdx, hIdx + 1600);
  assert.match(hBody, /getRevision\(sessionId\) !== [\s\S]{0,40}startRev/, 'helper 缺代际重查');
  assert.match(hBody, /await args\.computeProjectFp\(\)/, 'helper 缺指纹 IO 委托');
  const after = hBody.slice(hBody.indexOf('await args.computeProjectFp()'));
  assert.match(after, /getRevision\(sessionId\) !== [\s\S]{0,40}startRev[\s\S]{0,300}replace\(/, '指纹 IO 后缺二次代际重查即 replace（hb12-CMD-02 口径）');
  // 三处调用都以 getProjectOriginFingerprint 为指纹来源（经 computeProjectFp 委托）。
  const calls = (backend.match(/computeProjectFp: \(\) => getProjectOriginFingerprint\(/g) ?? []).length;
  assert.ok(calls >= 3, `指纹委托不足三处（${calls}/3）`);
});

// ⑤ handler 接线：COMMANDS_GET 传 probeFailed/probeInProgress。
check('⑤ handler 接线：resolveCommandsGetResult 收到 probeFailed + probeInProgress', () => {
  const idx = handlers.indexOf('IPC_CHANNELS.COMMANDS_GET');
  const body = handlers.slice(idx, handlers.indexOf('\n  });', idx));
  assert.match(body, /probeFailed: isGlobalProbeFailed\(\)/, 'handler 未传 probeFailed（CMD-07 零消费者形态）');
  assert.match(body, /probeInProgress: isCommandProbeInFlight\(sessionId\)/, 'handler 未传 probeInProgress（CMD-10）');
  assert.match(handlers, /isGlobalProbeFailed, isCommandProbeInFlight/, 'ipc-handlers 未导入两个探针查询');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
