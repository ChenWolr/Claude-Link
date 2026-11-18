// scripts/tdd-treekill-symmetry-probe-order-verify.ts
// B2 树杀对称化 + 探针防同链误杀 契约钉（2026-11-15-eight-issues-batch，03-test-cases-main.md §3 B2-01~06；
// 行为契约 00-behavior-specs.md 域 B B2；实现细节 01-impl-details-main.md §B2-1~B2-5）。
//
// 用例映射与断言形态：
//   B2-01（结构序钉·条款1）：
//     a) finishKill 内 post-turn 探针调度（schedulePostTurnProbe，wasCurrent && (user||watchdog) 门内）
//        原位不迁出（01 §B2-1「finishKill 探针调度原位保留」；迁出会丢失接管路径 spawnForChat forceKill
//        复用 finishKill 的既有探针行为）。
//     b) 两段式 finally 内序：finishKill() 先于树杀条件求值，二者同步相邻无 await 插入——既有顺序不可
//        对调（对调会让 finishKill/removeEntryIfCurrent 之前的 entries.has 恒真、树杀恒被跳过，01 §B2-2①）。
//     c) 契约 #1 兑现机制=「树杀目标集最终判定」：win-tree-kill WMIQL 过滤串含探针排除子句
//        AND NOT CommandLine LIKE '%--no-session-persistence%'（探针进程唯一持有该参数，
//        src/shared/post-turn-probe.ts:18 唯一代码字面）且 LIKE 主句保留。机制裁定：契约原文「树杀动作
//        完成判定后再调度探针」按字面需 await 树杀完成，但 scheduleWindowsTreeKill 是 spawn+unref 的
//        fire-and-forget（PS 枚举 1-3s 无完成回调可接），探针调度点在 finishKill 内部且被接管路径
//        spawnForChat forceKill 复用——迁出超最小影响面，故以目标集构造时排除探针兑现「任何路径探针
//        不被同链树杀击杀」，确定性成立不依赖时序（裁定留痕 01 §B2-2②与点报告，评审可推翻；推翻须
//        连带重估 tdd-effort-truth-verify:86-90 与 tdd-code-inline-fileref-verify:151-153 两份探针
//        args 契约）。【指令字面修正，申报留痕】排除子句为 WQL 合法形态「AND NOT CommandLine LIKE」
//        （派发指令第 2 条原文「AND CommandLine NOT LIKE」在本机 win32 19045 实测无效查询
//        0x80041017——WQL 不支持二元 field NOT LIKE，树杀会整体 no-op；四形态隔离探针证据见点报告
//        B2-W1），语义（同一排除目标集）与指令一致，仅词序合 WQL 文法。
//   B2-02（win32 真实行为·条款1）：
//     ① spawn 命令行含 --resume <uuid> 的 node 子进程 A → scheduleWindowsTreeKill(uuid) → A 被击杀
//       （树杀按 --resume 扫命令行的机制本身不失效）；
//     ② A 死后 spawn 探针形态 B（同 uuid 命令行 + --no-session-persistence）与对照 C（同 uuid、无探针
//       参数）→ 再次 scheduleWindowsTreeKill → C 被击杀（树杀机制未坏）且 B 存活（排除子句生效——
//       「后起同 uuid 探针存活」在树杀活跃下非空洞成立，抓住用例声明的回归「探针后起仍被击杀」；
//       无二次树杀的存活断言是空洞的，此为对用例步骤②的最小强化，期望语义与 03 §3.2 B2-02 一致）。
//       非-win32 整组 SKIP（平台守卫，理由入汇总行）。
//   B2-03（结构·条款2）：TREE_KILL_REASONS = user/watchdog/upstream_fatal/queue 恰四元（api_retry_exhausted
//     枚举死值不入——D 报告 §1-S8 无生产调用点，禁发挥；session_cleanup 走 else 直杀路径既有树杀）；
//     两段式 finally 唯一对称化调用点带 F2 守卫形（!entries.has(sessionId)）；killProcess 内树杀调用
//     恰 2 处（不为三理由另立第二处树杀实现，防两处守卫漂移）；session_cleanup 直杀路径原样（无守卫）。
//   B2-04（行为·条款2，vm 注入驱动——守卫为内联块非可注入纯函数，按 tdd-session-name-source ③ vm 先例
//     抽取真实守卫块+真实 TREE_KILL_REASONS 字面实跑）：①entries 含该会话（接管在途）→不派发；
//     ②entries 不含→user/watchdog/upstream_fatal/queue 四理由全派发、api_retry_exhausted/session_cleanup
//     不派发，实参=resumeId 解析链取值；回退形态（sessionCliIds 空、resolveCliSessionId 命中）实参=解析值；
//     ③id 链全空→派发实参 null（scheduleWindowsTreeKill 首行 !resumeSessionId 静默放弃，不误杀无辜——
//     该空参守卫行随本用例钉）。
//   B2-05（spawn 回归门·条款3）：spawnSync 实跑 scripts/tdd-interrupt-subagent-treekill-verify.ts
//     （T7-A~L 全量：user 两段式/F2 守卫形/session_cleanup 树杀/T7-I 负向钉），exit 0 才算过。
//   B2-06（并发·结构）：finally 内 finishKill(); 起点至树杀收尾无 await 间隙——间隙会把「守卫时无接管、
//     派发时已有接管」竞态变成误杀窗口（03 §3.2 B2-06）。
// RED 预期（未改树）：B2-01b/c、B2-02②、B2-03a/b、B2-04 FAIL（TREE_KILL_REASONS 与排除子句均缺，
// 探针形态 B 被同链树杀击杀）；B2-02① 可能因旧形 PS 自匹配自杀竞态而 FAIL；B2-01a、B2-03c/d、
// B2-05、B2-06 对现状本就成立（回归面）。
// 运行：npx tsx scripts/tdd-treekill-symmetry-probe-order-verify.ts（已登记 scripts/selftest-static-list.txt 尾部）

import { strict as assert } from 'node:assert';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import { scheduleWindowsTreeKill } from '../src/main/modules/win-tree-kill';

const repoRoot = path.resolve(__dirname, '..');
const WIN32 = process.platform === 'win32';

let pass = 0;
let fail = 0;
const skips: string[] = [];

async function runCheck(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    pass += 1;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    fail += 1;
    console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`);
  }
}

function skip(name: string, reason: string): void {
  skips.push(`${name}（${reason}）`);
  console.log(`  ⏭️ SKIP ${name} — ${reason}`);
}

function readIf(rel: string): string {
  const full = path.join(repoRoot, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

const backend = readIf('src/main/modules/sdk-backend.ts');
const treeKillSrc = readIf('src/main/modules/win-tree-kill.ts');
const probeSrc = readIf('src/shared/post-turn-probe.ts');

const kpStart = backend.indexOf('export function killProcess(');
const kpEnd = backend.indexOf('export function killAllProcesses(');
const kpRegion = kpStart > -1 && kpEnd > kpStart ? backend.slice(kpStart, kpEnd) : '';

function parseTreeKillReasons(): string[] {
  const decl = backend.match(/const TREE_KILL_REASONS(?::\s*readonly KillReason\[\])? = \[([^\]]*)\];/);
  assert.ok(decl, 'TREE_KILL_REASONS 声明缺失（B2 对称化未实施）');
  return decl[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

function spawnResumeProc(uuid: string, probeShaped: boolean): ChildProcess {
  // 命令行含 --resume <uuid>（树杀 LIKE 主句命中形态）；探针形态追加 --no-session-persistence
  // （post-turn 探针唯一持有参数，排除子句豁免形态）。'--' 后均为程序参数（node 实证 argv 透传）。
  const args = ['-e', 'setInterval(() => {}, 1000);', '--', '--resume', uuid];
  if (probeShaped) args.push('--no-session-persistence');
  return spawn(process.execPath, args, { stdio: 'ignore', windowsHide: true });
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve(true);
    const timer = setTimeout(() => resolve(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    timer.unref?.();
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
    child.once('error', () => { clearTimeout(timer); resolve(false); });
  });
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

async function main(): Promise<void> {
  console.log('=== B2 树杀对称化 + 探针防同链误杀 契约钉 ===');

  console.log('\n--- B2-01 finishKill 探针调度原位 + finally 内序 + 目标集排除（条款1·结构序钉） ---');
  await runCheck('B2-01a finishKill 内探针调度原位（wasCurrent && (user||watchdog) 门内，不迁出）', () => {
    const fkStart = kpRegion.indexOf('const finishKill = () => {');
    const fkEnd = kpRegion.indexOf('const query = entry.query;');
    assert.ok(fkStart > -1 && fkEnd > fkStart, 'finishKill 函数体定位失败');
    const fkBody = kpRegion.slice(fkStart, fkEnd);
    const gate = "if (wasCurrent && (reason === 'user' || reason === 'watchdog') && mainWindow) {";
    const gateAt = fkBody.indexOf(gate);
    assert.ok(gateAt > -1, 'finishKill wasCurrent 中断门缺失');
    const probeAt = fkBody.indexOf('schedulePostTurnProbe(sessionId, mainWindow, entry.queryInstance, resolveCliSessionId(sessionId)');
    assert.ok(probeAt > gateAt, '探针调度不在 wasCurrent 门内（迁出 finishKill 会丢失接管路径既有探针行为）');
  });
  await runCheck('B2-01b 两段式 finally 内序：finishKill() 先于树杀条件求值（同步相邻，既有顺序不可对调）', () => {
    const finallyIdx = kpRegion.indexOf('} finally {');
    assert.ok(finallyIdx > -1, '两段式 finally 缺失');
    const fkIdx = kpRegion.indexOf('finishKill();', finallyIdx);
    assert.ok(fkIdx > finallyIdx, 'finally 首语句 finishKill() 缺失');
    const treeIdx = kpRegion.indexOf('if (TREE_KILL_REASONS.includes(reason) && !entries.has(sessionId)) {', fkIdx);
    assert.ok(treeIdx > fkIdx, '树杀条件求值必须位于 finishKill() 之后（对调会让 entries.has 恒真、树杀恒被跳过）');
    const treeEnd = kpRegion.indexOf('}', treeIdx);
    const between = kpRegion.slice(fkIdx, treeEnd);
    assert.ok(!/\bawait\b/.test(between), 'finishKill 与树杀判读之间出现 await——同步相邻被破坏');
  });
  await runCheck('B2-01c 树杀目标集排除探针（WMIQL 排除子句 AND NOT CommandLine LIKE %--no-session-persistence%；LIKE 主句保留）', () => {
    assert.match(
      treeKillSrc,
      /CommandLine LIKE '%--resume \$\{resumeSessionId\}%'[\s\S]{0,20}AND NOT CommandLine LIKE '%--no-session-persistence%'\s*"\s*\|/,
      'WMIQL 探针排除子句缺失或形态漂移（契约 #1 兑现机制）',
    );
    assert.ok(treeKillSrc.includes("CommandLine LIKE '%--resume ${resumeSessionId}%'"), 'LIKE 主句缺失（树杀机制失锚）');
    // 排除参数确为探针唯一持有：探针 spawn 参数字面在位（post-turn-probe.ts:18），防排除子句与探针参数脱钩漂移。
    assert.ok(probeSrc.includes("'--no-session-persistence'"), '探针参数字面缺失（排除子句失去锚定对象）');
  });

  console.log('\n--- B2-02 win32 真实进程：树杀击杀匹配进程 + 后起同 uuid 探针存活（条款1·真实行为） ---');
  if (WIN32) {
    await runCheck('B2-02① 真实树杀击杀含 --resume <uuid> 的匹配进程 A', async () => {
      const uuid = randomUUID();
      const a = spawnResumeProc(uuid, false);
      try {
        await sleep(500);
        assert.ok(isAlive(a), 'A 未能存活启动（夹具失效）');
        scheduleWindowsTreeKill(uuid);
        const died = await waitForExit(a, 15000);
        assert.ok(died, 'A 未在 15s 内被树杀击杀（按 --resume 扫命令行击杀机制失效）');
      } finally {
        try { if (isAlive(a)) a.kill('SIGKILL'); } catch { /* 清理尽力而为 */ }
      }
    });
    await runCheck('B2-02② 树杀活跃下后起同 uuid 探针形态 B 存活、对照 C 被杀（排除子句生效）', async () => {
      const uuid = randomUUID();
      const b = spawnResumeProc(uuid, true); // 探针形态：+--no-session-persistence（post-turn 探针唯一持有）
      const c = spawnResumeProc(uuid, false); // 对照：同 uuid、无探针参数
      try {
        await sleep(500);
        assert.ok(isAlive(b) && isAlive(c), 'B/C 未能存活启动（夹具失效）');
        scheduleWindowsTreeKill(uuid);
        await sleep(6000); // PS 枚举 1-3s + 余量
        assert.ok(!isAlive(c), '对照 C 未被树杀击杀（排除子句误伤主机制）');
        assert.ok(isAlive(b), '探针形态 B 被同链树杀击杀——「探针后起仍被击杀」回归，契约 #1 破坏');
      } finally {
        for (const p of [b, c]) {
          try { if (isAlive(p)) p.kill('SIGKILL'); } catch { /* 清理尽力而为 */ }
        }
      }
    });
  } else {
    skip('B2-02①/②（win32 真实进程组）', `非 win32 平台（process.platform=${process.platform}）：scheduleWindowsTreeKill 首行平台守卫静默放弃，真实 taskkill 行为无法执行——结构面由 B2-01c/T7 系列钉覆盖`);
  }

  console.log('\n--- B2-03 三理由同调用点 + 守卫形 + session_cleanup 原样（条款2·结构） ---');
  await runCheck('B2-03a TREE_KILL_REASONS 恰四元（user/watchdog/upstream_fatal/queue；api_retry_exhausted/session_cleanup 不入）', () => {
    assert.deepEqual(parseTreeKillReasons(), ['user', 'watchdog', 'upstream_fatal', 'queue']);
  });
  await runCheck('B2-03b 对称化调用点唯一且带 F2 守卫形（不为三理由另立第二处树杀实现）', () => {
    assert.match(
      kpRegion,
      /if \(TREE_KILL_REASONS\.includes\(reason\) && !entries\.has\(sessionId\)\) \{\s*\n\s*scheduleWindowsTreeKill\(sessionCliIds\.get\(sessionId\) \?\? resolveCliSessionId\(sessionId\) \?\? null\);\s*\n\s*\}/,
      '对称化调用点（TREE_KILL_REASONS + F2 守卫形 + resumeId 解析链实参）缺失',
    );
    const calls = kpRegion.match(/scheduleWindowsTreeKill\(/g) ?? [];
    assert.equal(calls.length, 2, `killProcess 内树杀调用应恰 2 处（对称化 + session_cleanup），实际 ${calls.length}——三理由不得另立第二处实现`);
  });
  await runCheck('B2-03c session_cleanup 直杀路径树杀原样（契约 #3 第二路；无接管守卫）', () => {
    const at = kpRegion.indexOf("if (reason === 'session_cleanup') scheduleWindowsTreeKill(");
    assert.ok(at > -1, 'session_cleanup 直杀路径树杀缺失');
    const line = kpRegion.slice(at, kpRegion.indexOf('\n', at));
    assert.ok(
      line.includes('scheduleWindowsTreeKill(sessionCliIds.get(sessionId) ?? resolveCliSessionId(sessionId) ?? null)'),
      'session_cleanup 树杀实参链被改动',
    );
    assert.ok(!line.includes('entries.has'), 'session_cleanup 树杀不得加接管守卫（无后继可能，守卫恒真无意义）');
  });
  await runCheck('B2-03d user 两段式成员与既有门不回归（对称化只是条件扩集）', () => {
    assert.ok(
      kpRegion.includes("const twoPhaseReasons = reason === 'watchdog' || reason === 'upstream_fatal' || reason === 'queue';"),
      'twoPhaseReasons 形被改',
    );
    assert.ok(kpRegion.includes("if (query && (twoPhaseReasons || reason === 'user')) {"), 'user 两段式成员形被改');
    assert.ok(kpRegion.includes('const graceMs = reason === \'user\' ? 1500 : 5000;'), 'user 短窗/系统族 5000 窗被改');
  });

  console.log('\n--- B2-04 F2 接管守卫行为对照：有接管跳过 / 无接管照杀 / 取空链不误杀（条款2·vm 注入驱动） ---');
  await runCheck('B2-04 守卫块 vm 实跑三变体（真实守卫块+真实 TREE_KILL_REASONS 字面注入）', () => {
    const reasons = parseTreeKillReasons();
    const blockMatch = kpRegion.match(
      /if \(TREE_KILL_REASONS\.includes\(reason\) && !entries\.has\(sessionId\)\) \{\s*scheduleWindowsTreeKill\(sessionCliIds\.get\(sessionId\) \?\? resolveCliSessionId\(sessionId\) \?\? null\);\s*\}/,
    );
    assert.ok(blockMatch, '真实守卫块抽取失败（结构形漂移）');
    const wrapper = `(function (TREE_KILL_REASONS, entries, reason, sessionId, sessionCliIds, resolveCliSessionId, scheduleWindowsTreeKill) {\n${blockMatch[0]}\n})`;
    const guardBlock = vm.runInNewContext(wrapper, vm.createContext({})) as (
      reasons: string[],
      entries: Map<string, unknown>,
      reason: string,
      sessionId: string,
      sessionCliIds: Map<string, string>,
      resolveCliSessionId: (sid: string) => string | null,
      scheduleWindowsTreeKill: (resumeId: string | null) => void,
    ) => void;

    // 变体①：接管在途（entries 含该会话，同 uuid 新回合 entry 已同步在位）→ 四理由全跳过（F2 防误杀）。
    const dispatched1: string[] = [];
    for (const reason of reasons) {
      guardBlock(reasons, new Map([['s1', {}]]), reason, 's1', new Map(), () => null, (arg) => dispatched1.push(`${reason}:${arg}`));
    }
    assert.deepEqual(dispatched1, [], '接管在途（entries 含该会话）时仍派发树杀——F2 守卫失效（taskkill /T 误杀新回合进程树）');

    // 变体②：无接管（entries 空）→ 四理由全派发；api_retry_exhausted（枚举死值）/session_cleanup（else 直杀路径）不派发。
    const dispatched2: string[] = [];
    for (const reason of [...reasons, 'api_retry_exhausted', 'session_cleanup']) {
      guardBlock(reasons, new Map(), reason, 's1', new Map([['s1', 'cli-uuid-xyz']]), () => null, (arg) => dispatched2.push(`${reason}:${arg}`));
    }
    assert.deepEqual(
      dispatched2,
      reasons.map((r) => `${r}:cli-uuid-xyz`),
      '无接管时派发集/实参不符（漏理由=对称化不全；多理由=越界；实参链被改）',
    );

    // 变体②回退：sessionCliIds 空、resolveCliSessionId 命中 → 实参=解析值（解析链回退形态）。
    const dispatched3: string[] = [];
    guardBlock(reasons, new Map(), 'watchdog', 's1', new Map(), () => 'resolved-uuid', (arg) => dispatched3.push(String(arg)));
    assert.deepEqual(dispatched3, ['resolved-uuid'], 'resumeId 解析链回退形态被改');

    // 变体③：id 链全空 → 派发实参 null（scheduleWindowsTreeKill 首行 !resumeSessionId 静默放弃，不误杀无辜进程）。
    const dispatched4: Array<string | null> = [];
    guardBlock(reasons, new Map(), 'queue', 's1', new Map(), () => null, (arg) => dispatched4.push(arg));
    assert.deepEqual(dispatched4, [null], 'id 链取空应派发 null（树杀静默放弃路径），不得派发非 null 或跳过派发');
    assert.match(
      treeKillSrc,
      /if \(process\.platform !== 'win32' \|\| !resumeSessionId\) return;/,
      'scheduleWindowsTreeKill 首行空参守卫缺失（null 实参会误杀）',
    );
  });

  console.log('\n--- B2-05 user/session_cleanup 两路既有树杀回归门（条款3·spawn 复用） ---');
  await runCheck('B2-05 spawnSync 实跑 tdd-interrupt-subagent-treekill-verify.ts（T7-A~L 全量）exit 0', () => {
    const r = spawnSync('npx', ['tsx', 'scripts/tdd-interrupt-subagent-treekill-verify.ts'], { cwd: repoRoot, encoding: 'utf8', shell: WIN32 });
    const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
    assert.equal(r.status, 0, `tdd-interrupt-subagent-treekill-verify.ts 退出码 ${r.status}（user/session_cleanup 既有树杀回归面被破坏）\n${tail}`);
  });

  console.log('\n--- B2-06 守卫判读与派发同同步临界区（并发·结构） ---');
  await runCheck('B2-06 finally 窗内 finishKill→守卫判读→派发无 await 间隙', () => {
    const finallyIdx = kpRegion.indexOf('} finally {');
    assert.ok(finallyIdx > -1, '两段式 finally 缺失');
    const logIdx = kpRegion.indexOf('[two-phase-interrupt]', finallyIdx);
    assert.ok(logIdx > -1, 'finally 收尾日志锚缺失');
    const window = kpRegion.slice(finallyIdx, logIdx);
    assert.ok(window.includes('entries.has(sessionId)'), '窗内缺守卫判读（entries.has）');
    assert.ok(window.includes('scheduleWindowsTreeKill('), '窗内缺树杀派发');
    assert.ok(!/\bawait\b/.test(window), '守卫判读与派发间存在 await 间隙——「守卫时无接管、派发时已有接管」竞态变成误杀窗口');
  });

  console.log(`\nverify 结果：${pass} passed, ${fail} failed${skips.length ? `, ${skips.length} skipped（${skips.join('；')}）` : ''}`);
  process.exit(fail > 0 ? 1 : 0);
}

void main();
