// tdd-interrupt-subagent-treekill-verify.ts
// UI13-P7 契约钉：用户中断打断 subagent——killProcess('user') 两段式（interrupt 优先 ≤1500ms
// → abort 兜底 finishKill）+ Windows 进程树击杀兜底（win-tree-kill.ts：resume UUID 匹配
// 命令行 → taskkill /T /F，detached+unref）+ 应用退出/删会话链路附带树杀 + 「abort = Windows
// 瞬时 TerminateProcess」错误注释认知清零（T7-I，负向钉范围 src/ + scripts/，不含 docs/）。
// F2（P1-B 修复）增补 T7-L：user 树杀接管守卫——优雅窗内重发经 spawnForChat forceKill 接管后
// 新回合 entry 已同步在位（entries.has(sessionId)），同会话每回合 resume 同一 UUID，此刻按 UUID
// 扫命令行整杀会命中新回合进程树（taskkill /T /F 误杀）；守卫跳过；自然收尾路径 entry 已删且无
// 新回合在途 → 照发扫孤儿残留（评审 docs/reports/2026-11-14-ui13-batch-review-r1.md P1-B）。
// 用例映射 docs/plans/2026-11-14-ui13-batch/03-test-cases.md §P7 T7-A~K。
// 运行：npx tsx scripts/tdd-interrupt-subagent-treekill-verify.ts（退出码非 0 = 失败）。
// 【随 B2 同步（2026-11-15 eight-issues-batch），最小同步留痕——语义均不变】：
//   ① T7-B3：win-tree-kill WMIQL 过滤串追加探针排除子句「AND NOT CommandLine LIKE
//     '%--no-session-persistence%'」（WQL 合法形态；指令原文「AND CommandLine NOT LIKE」在本机
//     win32 19045 实测无效查询 0x80041017，四形态隔离探针证据见点报告 B2-W1），过滤串收尾双引号
//     移至排除子句行——正则随形更新，LIKE 主句语义不变；
//   ② T7-A6/T7-L1：killProcess 两段式 finally 树杀条件由「reason === 'user' && !entries.has(...)」
//     对称化为「TREE_KILL_REASONS.includes(reason) && !entries.has(...)」（user/watchdog/
//     upstream_fatal/queue 四理由，F2 接管守卫原样保留），派发体移入守卫块内独立行——正则随形
//     更新（A6 窗 400→700，B2 注释增厚所致），「守卫先于派发」语义不变；旧单理由单行形态加负向钉。

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass += 1; console.log(`  ✅ ${name}`); }
  catch (e) { fail += 1; console.log(`  ❌ ${name} — ${(e as Error).message.slice(0, 300)}`); }
}

function readIf(p: string): string {
  const full = path.join(repoRoot, p);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '';
}

const backend = readIf('src/main/modules/sdk-backend.ts');
const treeKill = readIf('src/main/modules/win-tree-kill.ts');
const ipcHandlers = readIf('src/main/ipc-handlers.ts');
const mainIndex = readIf('src/main/index.ts');
const cdpE2e = readIf('scripts/cdp-interrupt-resume-e2e.mjs');
const diagnose = readIf('scripts/diagnose-interrupt-transcript.mjs');
const queueEngine = readIf('src/main/modules/task-queue-engine.ts');

const TREEKILL_CALL = /scheduleWindowsTreeKill\(sessionCliIds\.get\(sessionId\) \?\? resolveCliSessionId\(sessionId\) \?\? null\)/;

// T7-I 负向钉：递归收集 src/ 与 scripts/ 下源码文本（不含 docs/——计划文档合法保留旧表述
// 记录裁决；不含本脚本——旧字面以模式形式留在本文件）。
function collectSourceTexts(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  const exts = new Set(['.ts', '.tsx', '.vue', '.mjs', '.js']);
  const self = 'tdd-interrupt-subagent-treekill-verify';
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      const rel = path.relative(repoRoot, full);
      if (rel.includes(self)) continue;
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (exts.has(path.extname(name))) out.push({ file: rel, text: fs.readFileSync(full, 'utf8') });
    }
  };
  walk(path.join(repoRoot, 'src'));
  walk(path.join(repoRoot, 'scripts'));
  return out;
}

function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（连带契约被波及）\n${tail}`);
}

console.log('=== UI13-P7 T7 用户中断打断 subagent 契约钉 ===');

console.log('\n--- T7-A user 中断两段式（interrupt 优先 ≤1500ms → abort 兜底） ---');
check('T7-A1 twoPhaseReasons 三族定义在位', () => {
  assert.match(backend, /const twoPhaseReasons = reason === 'watchdog' \|\| reason === 'upstream_fatal' \|\| reason === 'queue';/);
});
check('T7-A2 user 并入两段式分支（query && (twoPhaseReasons || user)）', () => {
  assert.match(backend, /if \(query && \(twoPhaseReasons \|\| reason === 'user'\)\) \{/);
});
check('T7-A3 user 短窗 1500 常量（graceMs 三元）+ deadline 用 graceMs', () => {
  assert.match(backend, /const graceMs = reason === 'user' \? 1500 : 5000;/);
  assert.match(backend, /const deadline = Date\.now\(\) \+ graceMs;/);
});
check('T7-A4 interrupt 先行：优雅窗 race 以 query.interrupt() 起手、waitUntil(graceMs) 有界', () => {
  assert.match(backend, /query\.interrupt\(\)\.then\(/);
  assert.match(backend, /waitUntil\(graceMs\)\.then\(\(\) => 'no-ack'/);
});
check('T7-A5 剩余窗 exited / abort 兜底 race 在位', () => {
  assert.match(backend, /exited\.then\(\(c\) => `exit:\$\{c\}`/);
  assert.match(backend, /abort-fallback/);
});
check('T7-A6 finally finishKill 幂等兜底 + 树杀（F2 接管守卫形；B2 随源同步：理由集对称化）+ outcome 日志', () => {
  const at = backend.indexOf('const twoPhaseReasons');
  assert.ok(at > -1, 'twoPhaseReasons 缺失');
  const seg = backend.slice(at, at + 3000);
  assert.ok(seg.includes('} finally {'), 'finally 兜底缺失');
  // B2 随源同步（语义不变）：树杀条件 reason==='user' → TREE_KILL_REASONS.includes(reason)
  //（四理由对称化），派发体移入守卫块内独立行；finishKill() 先于树杀条件求值的既有顺序不变。
  assert.match(seg, /finishKill\(\);[\s\S]{0,700}if \(TREE_KILL_REASONS\.includes\(reason\) && !entries\.has\(sessionId\)\) \{\s*\n\s*scheduleWindowsTreeKill\(sessionCliIds/);
  assert.match(seg, /\[two-phase-interrupt\] session=\$\{sessionId\} reason=\$\{reason\} outcome=\$\{how\}/);
});
check('T7-A7 区分锚：session_cleanup 不入两段式族（else 立即硬杀分支）', () => {
  assert.ok(!/twoPhaseReasons.*session_cleanup|session_cleanup.*twoPhaseReasons/.test(backend), 'session_cleanup 混入两段式族');
  assert.ok(backend.indexOf("if (reason === 'session_cleanup') scheduleWindowsTreeKill(") > -1, 'else 分支 session_cleanup 树杀缺失');
});
check('T7-A8 区分锚：watchdog 族 5000 窗统一走 graceMs（不再字面 waitUntil(5000)）', () => {
  assert.ok(!/waitUntil\(5000\)/.test(backend), '仍存在字面 waitUntil(5000)——user 未并入统一 graceMs');
  assert.match(backend, /entry\.forceKill = finishKill;/);
});
check('T7-A9 interruptedQueries.add 仍在同步段先行（catch 走 aborted 既有语义）', () => {
  const addAt = backend.indexOf('if (entry.query) interruptedQueries.add(entry.query);');
  const phaseAt = backend.indexOf('const twoPhaseReasons');
  assert.ok(addAt > -1, 'interruptedQueries.add 缺失');
  assert.ok(phaseAt > addAt, 'add 应先于两段式分支（同步段）');
});

console.log('\n--- T7-B Windows 树杀兜底（win-tree-kill.ts） ---');
check('T7-B1 win-tree-kill.ts 存在且导出 scheduleWindowsTreeKill', () => {
  assert.ok(treeKill.length > 0, 'src/main/modules/win-tree-kill.ts 不存在');
  assert.match(treeKill, /export function scheduleWindowsTreeKill\(resumeSessionId: string \| null\): void/);
});
check('T7-B2 taskkill /T /F 整树 + Get-CimInstance Win32_Process 定位', () => {
  assert.match(treeKill, /taskkill \/PID \$_\.ProcessId \/T \/F/);
  assert.match(treeKill, /Get-CimInstance Win32_Process/);
});
check('T7-B3 resume UUID 按命令行匹配（CommandLine LIKE %--resume <id>%；B2 随源同步：追加探针排除子句）', () => {
  // B2 随源同步（语义不变）：WMIQL 过滤串由单 LIKE 行改为「LIKE 主句 + AND NOT CommandLine
  // LIKE '%--no-session-persistence%'」两行模板拼接形态（探针进程唯一持有该参数，防同链树杀
  // 误杀 post-turn 探针——契约 #1 目标集排除机制）。形态为 WQL 合法词序「AND NOT <field> LIKE」
  //（指令原文「AND CommandLine NOT LIKE」在本机 win32 19045 实测无效查询 0x80041017，证据见
  // 点报告 B2-W1），过滤串收尾双引号移至排除子句行——正则随形更新，LIKE 主句语义不变。
  assert.match(treeKill, /CommandLine LIKE '%--resume \$\{resumeSessionId\}%'[\s\S]{0,20}AND NOT CommandLine LIKE '%--no-session-persistence%'\s*"\s*\|/);
});
check('T7-B4 PowerShell 无窗后台执行（-NoProfile -NonInteractive + ignore/windowsHide/unref；禁 detached）', () => {
  assert.match(treeKill, /'-NoProfile', '-NonInteractive', '-Command'/);
  // 编排裁定（2026-11-14）：detached:true 在 win32 19045 + PowerShell 5.1 实测使 PowerShell
  // 无控制台启动即静默退出（树杀 no-op，证据 P7-treekill-live.log FAIL/PASS 证据对）——
  // 契约意图「fire-and-forget + Electron 退出后仍收尾」由 stdio:'ignore' + windowsHide + unref
  // 达成（Windows 无 kill-on-close），故钉负向：不得出现 detached。
  assert.doesNotMatch(treeKill, /detached\s*:/);
  assert.match(treeKill, /stdio: 'ignore'/);
  assert.match(treeKill, /windowsHide: true/);
  assert.match(treeKill, /child\.unref\(\)/);
});
check('T7-B5 sdk-backend 接线：import + user/session_cleanup 两调用点 + resumeId 解析链', () => {
  assert.match(backend, /import \{ scheduleWindowsTreeKill \} from '\.\/win-tree-kill';/);
  const calls = backend.match(new RegExp(TREEKILL_CALL.source, 'g')) ?? [];
  assert.ok(calls.length >= 2, `接线点应 ≥2（user + session_cleanup），实际 ${calls.length}`);
});

console.log('\n--- T7-C 树杀静默三条件（匹配失败/非 win32/无 resumeId 均静默） ---');
check('T7-C1 非 win32 / 无 resumeId 首行守卫直接 return', () => {
  assert.match(treeKill, /if \(process\.platform !== 'win32' \|\| !resumeSessionId\) return;/);
});
check('T7-C2 spawn 静默失败（try/catch 吞掉；无 throw、无用户可见报错通道）', () => {
  assert.match(treeKill, /try \{[\s\S]*const child = spawn\('powershell\.exe'[\s\S]*\} catch \{/);
  assert.ok(!treeKill.includes('throw'), '树杀链路不得 throw');
  assert.ok(!/logger\.|dialog|Notification/.test(treeKill), '树杀 util 不得引报错/通知通道');
});

console.log('\n--- T7-D detached 也能命中：匹配键=命令行而非 pid 链 ---');
check('T7-D1 匹配走 CommandLine LIKE（独立于父子 pid 链）', () => {
  assert.ok(treeKill.includes('CommandLine LIKE'), '缺命令行匹配');
});
check('T7-D2 无 parent-pid 遍历残留', () => {
  assert.ok(!/ParentProcessId|ppid/i.test(treeKill), '树杀不得沿 pid 链遍历（detached 漏杀面）');
});

console.log('\n--- T7-E 应用退出附带树杀 ---');
check('T7-E1 killAllProcesses 循环 session_cleanup（退出路径统一入口）', () => {
  assert.match(backend, /for \(const \[sessionId\] of entries\) \{\s*\n\s*killProcess\(sessionId, 'session_cleanup'\);\s*\n\s*\}/);
});
check('T7-E2 else 分支对 session_cleanup 附带树杀（退出链兜底落点）', () => {
  const at = backend.indexOf("if (reason === 'session_cleanup') scheduleWindowsTreeKill(");
  assert.ok(at > -1, 'else 立即硬杀分支未附带 session_cleanup 树杀');
});
check('T7-E3 main/index.ts 退出路径仍经 killAllProcesses（结构不变）', () => {
  assert.match(mainIndex, /killAllProcesses\(\);/);
});

console.log('\n--- T7-F 会话删除附带树杀 ---');
check('T7-F1 SESSION_DELETE 先 killProcess(session_cleanup)（删除链统一入口）', () => {
  const at = ipcHandlers.indexOf('regInvokeHandler(IPC_CHANNELS.SESSION_DELETE');
  assert.ok(at > -1, 'SESSION_DELETE handler 缺失');
  const seg = ipcHandlers.slice(at, at + 1200);
  assert.match(seg, /killProcess\(id, 'session_cleanup'\);/);
});
check('T7-F2 session_cleanup 路径附带树杀（删除链兜底生效）', () => {
  const at = backend.indexOf("if (reason === 'session_cleanup') scheduleWindowsTreeKill(");
  assert.ok(at > -1, 'session_cleanup 树杀缺失（删会话后 CLI 子树残留）');
});

console.log('\n--- T7-G 终态语义回归门 ---');
check('T7-G1 user 中断 aborted 终态补发链保留（forwardEvent aborted + emitTurnEnded interrupted）', () => {
  assert.match(backend, /if \(wasCurrent && \(reason === 'user' \|\| reason === 'watchdog'\) && mainWindow\) \{/);
  assert.match(backend, /forwardEvent\(sessionId, mainWindow, \{ type: 'aborted', message: '已中断' \}\);/);
  assert.match(backend, /emitTurnEnded\(sessionId, 'interrupted', entry\.queryInstance\);/);
});
check('T7-G2 tdd-subagent-verify 全绿（连带回归钉）', () => spawnAssert('scripts/tdd-subagent-verify.ts'));

console.log('\n--- T7-H 三路径不回归（watchdog/upstream_fatal/queue 仍 5000 优雅窗） ---');
check('T7-H1 watchdog 族优雅窗仍 5000（graceMs 非 user 分支）+ forceKill 幂等句柄', () => {
  assert.match(backend, /reason === 'user' \? 1500 : 5000/);
  assert.match(backend, /entry\.forceKill = finishKill;/);
});
check('T7-H2 tdd-stall-watchdog-verify 全绿（现状 F1/R6 形态钉不破）', () => spawnAssert('scripts/tdd-stall-watchdog-verify.ts'));

console.log('\n--- T7-I 错误注释认知清零（负向钉 src/ + scripts/，不含 docs/ 与本脚本） ---');
const OLD_PATTERNS: Array<[string, RegExp]> = [
  ['TerminateProcess（瞬时…）', /TerminateProcess[\s\S]{0,20}（瞬时/],
  ['→ TerminateProcess 真硬杀', /→ TerminateProcess 真硬杀/],
  ['硬杀（abort → TerminateProcess）', /硬杀（abort → TerminateProcess）/],
  ['user 中断即时硬杀（TerminateProcess）', /即时硬杀（TerminateProcess）/],
  ['user 中断立即硬杀（TerminateProcess）', /立即硬杀（TerminateProcess）/],
];
check('T7-I1 旧字面组合全仓（src/+scripts/）零命中', () => {
  for (const { file, text } of collectSourceTexts()) {
    for (const [label, re] of OLD_PATTERNS) {
      assert.ok(!re.test(text), `${file} 仍含旧表述「${label}」`);
    }
  }
});
check('T7-I2 正向钉：新认知表述在位（sdk-backend 注释 + 两脚本头注改述两段式）', () => {
  const canonical = 'SDK 0.3.191 win32 abort = 关 stdin → 2s → 再 5s → TerminateProcess（仅直接子进程；孙进程成孤儿——由 scheduleWindowsTreeKill 兜底）';
  const n = backend.split(canonical).length - 1;
  assert.ok(n >= 2, `sdk-backend 新认知句应 ≥2 处，实际 ${n}`);
  assert.match(cdpE2e, /user 中断现为两段式/, 'cdp-interrupt-resume-e2e.mjs 头注未改述两段式现状');
  assert.match(diagnose, /两段式/, 'diagnose-interrupt-transcript.mjs 头注未改述两段式现状');
});

console.log('\n--- T7-J 重复中断幂等 ---');
check('T7-J1 killProcess 无 entry 早退（二次 CHAT_ABORT 无 entry 不进分支不抛错）', () => {
  assert.match(backend, /const entry = entries\.get\(sessionId\);\s*\n\s*if \(entry\) \{/);
});
check('T7-J2 finishKill 幂等门（killClosed）', () => {
  assert.match(backend, /if \(killClosed\) return;/);
});
check('T7-J3 emitTurnEnded 幂等保留（endedAt 已结算拒双发）', () => {
  assert.match(backend, /if \(snap\.endedAt != null\) return;/);
});

console.log('\n--- T7-K 无运行回合中断无副作用 ---');
check('T7-K1 abortHalt 空转守卫保留（非 running 且无活动进程 no-op）', () => {
  assert.match(queueEngine, /if \(!running && !getActiveProcess\(sessionId\)\) return;/);
});
check('T7-K2 CHAT_ABORT 链路保留 killProcess(user) + abortHalt（ipc-handlers）', () => {
  const at = ipcHandlers.indexOf('IPC_CHANNELS.CHAT_ABORT');
  assert.ok(at > -1, 'CHAT_ABORT handler 缺失');
  const seg = ipcHandlers.slice(at, at + 600);
  assert.match(seg, /killProcess\(sessionId, 'user', mainWindowRef\);/);
  assert.match(seg, /abortHalt\(sessionId, mainWindowRef\);/);
});
check('T7-K3 aborted 补发保持 wasCurrent 门（空回合/迟到不误发终态）', () => {
  assert.match(backend, /if \(wasCurrent && \(reason === 'user' \|\| reason === 'watchdog'\) && mainWindow\) \{/);
});

console.log('\n--- T7-L F2（P1-B）树杀接管守卫：优雅窗内重发的新回合不被旧回合树杀误杀 ---');
check('T7-L1 树杀调用带接管守卫字面，且守卫判断位于 scheduleWindowsTreeKill 之前（B2 随源同步：理由集对称化，守卫形不变）', () => {
  // B2 随源同步（语义不变）：树杀理由 reason==='user' 扩为 TREE_KILL_REASONS（user/watchdog/
  // upstream_fatal/queue 四理由同权，F2 接管守卫 !entries.has(sessionId) 原样保留），派发体由
  // 单行条件表达式移入守卫块内独立行——「守卫判断先于派发求值」语义不变，行内断言改为块内断言。
  const guard = '!entries.has(sessionId)';
  const call = 'if (TREE_KILL_REASONS.includes(reason) && !entries.has(sessionId)) {';
  const callIdx = backend.indexOf(call);
  assert.ok(callIdx > -1, '树杀调用缺接管守卫字面（TREE_KILL_REASONS.includes(reason) && !entries.has(sessionId)）');
  // 守卫判断位于派发之前：同一 if 块内，条件（含守卫）先于块内 scheduleWindowsTreeKill 调用。
  const blockEnd = backend.indexOf('}', callIdx);
  const schedIdx = blockEnd > -1 ? backend.indexOf('scheduleWindowsTreeKill(', callIdx) : -1;
  assert.ok(schedIdx > callIdx && schedIdx < blockEnd, '派发调用须位于守卫块内、守卫判断之后');
  // 负向钉：无守卫的旧形态（P1-B 缺陷形——优雅窗内重发的新回合必被旧回合树杀命中）不得回归。
  assert.ok(!backend.includes("if (reason === 'user') scheduleWindowsTreeKill("), '存在无接管守卫的树杀调用（P1-B 缺陷形回归）');
  // 负向钉：B2 对称化前的单理由单行旧形不得回归（防对称化回退）。
  assert.ok(!backend.includes("if (reason === 'user' && !entries.has(sessionId)) scheduleWindowsTreeKill("), '单理由单行旧形树杀回归（B2 对称化前形态）');
});
check('T7-L2 session_cleanup 分支不动（无后继可能，树杀保持无条件）', () => {
  const at = backend.indexOf("if (reason === 'session_cleanup') scheduleWindowsTreeKill(");
  assert.ok(at > -1, 'session_cleanup 树杀缺失');
  const line = backend.slice(at, backend.indexOf('\n', at));
  assert.ok(!line.includes('entries.has'), 'session_cleanup 树杀不得加接管守卫（无后继可能，守卫恒真无意义）');
});

console.log(`\nverify 结果：${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
