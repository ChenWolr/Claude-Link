// tdd-mcp-external-change-watch-verify.ts
// E2「MCP 启动预热 + 外部变更 watcher + 失效信号」TDD 契约（docs/plans/2026-11-15-eight-issues-batch/
// 03-test-cases-main.md §5 E2-01~10 + E2-S1/S2；行为契约 00-behavior-specs.md §E2；实现细节
// 01-impl-details-main.md §E2-1~E2-6；计划定名 04-实施计划.md §4.1：tdd-mcp-source-watcher-verify ≡ 本名）。
// 用例→断言映射：
//   ① E2-01a ready 预热覆盖：默认目录+2 最近工作区（其一不存在目录）全部进预热读取面
//        （快照 projectDirs 三目录可见，svc-a/svc-default 读得证明 IO 发生）；
//   ② E2-01b 预热不阻塞调用方（同步返回时慢依赖未执行）+ 坏目录静默（无 throw / 零 unhandled rejection）；
//   ③ E2-02 用户级 ~/.claude.json 外部实变 → 每次恰广播 1 次失效信号；
//   ④ E2-03 项目目录集内 .mcp.json 变更广播 / 集外目录对照不广播；
//   ⑤ E2-03b notifyMcpDirsChanged 增量挂载冒烟（E3 锚点可用性：新目录带 .mcp.json → 广播 + 后续变更可感知；
//        ⑤c R5-3 行为钉 round-005：目录集新增不带 .mcp.json 的目录 → 指纹含 :missing 新条目实变 → 广播恰 1 次）；
//   ⑥ E2-04 挂载失败降级 + 慢重试自愈（全程无异常；重试轮内目录从无到有 → 挂上；后续变更可广播）；
//   ⑦ E2-07 同内容覆写 + 重复 touch（mtime 抖动）→ 广播零次【内容哈希指纹口径的硬期望，
//        01 §E2-3 伪代码 mtimeMs:size 与此冲突，按 03 §5 E2-10「指纹按内容/按解析态的口径实现后
//        回填」取内容 sha1——申报项，见 mcp-source-watcher.ts 文件头】；
//   ⑧ E2-08 去抖合流：窗口内 5 次不同内容覆写恰 1 次广播 + 末次内容即基准（同内容重写零广播）；
//   ⑨ E2-09 监听零噪音（console.log/info/warn/error 全程零调用；logger 除 start 一条 info 外零输出，
//        含挂载失败静默——mountRoot 失败走 pending 不打 warn，对齐 command-source-watcher 既有水位）；
//   ⑩ E2-10 删除 .mcp.json / 写入损坏 JSON 均广播（删与坏=实变硬期望）+ 同损坏内容二次写零广播；
//   ⑪ E2-05 接线钉：MCP_SNAPSHOT_CHANGED 常量（带 E2 注释原文）/ preload 双成员 + getMcpSnapshot
//        签名扩展 + 头注 117→119 / web-bridge 双键 / 发射点 pushToMainWindow 空载荷 {} + 发射前
//        指纹门（isFirstBaseline 基准更新序）/ regInvokeHandler 计数保持 91 / handler bypassCache+dir
//        参数与负缓存清除+clearMcpRawCache 调用锚（E2 卷原钉临时等价面 badDirCacheMark(dir, now-TTL)；
//        round-002 P21 随 E3 收口最小同步为 badDirCacheClear(opts.dir)，留痕见 ⑪-6 钉注）；
//        〔round-006 R6-2① 扩钉留痕〕⑪-6 追加白名单门三字面切片钉（if (opts.dir !== undefined) /
//        knownKeys /「目录不在可扫描白名单内」，R5-2 主进程白名单防御面锚定防删）；red-on-old 以
//        git show 3be0d7d:src/main/ipc-handlers.ts 临时形态反证一次（基线 handler 无 bypass 分支，
//        ⑪ 切片三字面全缺必红），留痕见本报告轮 round-006/R6-fix-report.md。
//   ⑫ E2-05/S2 模块纯净性（watcher 零 electron/sdk-backend/config-manager/push-bus import）+
//        去抖/重试常量值（行为级 require）+ notifyMcpDirsChanged/collect/warm/broadcast 导出面；
//   ⑬ E2-S1 预热接线钉：index.ts void warmMcpSnapshot()（无 await）位于 whenReady 后 +
//        startMcpSourceWatcherPipeline 定义 1 处调用恰 2 处（whenReady+activate）+ window-all-closed stop；
//   ⑭ E2-S2 watcher 生命周期单例（state 幂等守卫 / 无会话参数）+ 降级同形钉（pendingRoots 慢重试
//        Map / setInterval 兜底循环 / error 5s 重挂×3 转 30s 常量三件套）；
//   ⑮ E2-05 spawn 回归门：spawnSync 实跑 tdd-web-access-wiring-verify.ts exit 0（§11.2 双向对等
//        断言自动覆盖新表键/新接口成员）。
// seam：Module._load 拦截 electron→scripts/electron-stub.cjs（CLAUDE_LINK_TEST_USERDATA 临时目录）、
//   session-repo→stub（真实 better-sqlite3 为 Electron ABI 纯 node 不可加载——E4 脚本同款手法）；
//   mcp-source-watcher 为纯 node 模块、mcp-snapshot-service 经 overrides 全量注入（默认装配面
//   不执行），真实 fs 监听全部落系统临时目录 userHome/项目目录，绝不触真实 ~/.claude.json。
// RED 预期（未实现树）：src/main/modules/mcp/mcp-source-watcher.ts 与 mcp-snapshot-service.ts
//   不存在 → 组1 行为 ①~⑩ 全 FAIL（模块加载失败降级）+ 组2 结构钉 ⑪~⑭ 全 FAIL；既有基线脚本
//   （tdd-web-access-wiring / selftest-mcp-settings）不受影响。
// 运行：npx tsx scripts/tdd-mcp-external-change-watch-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { Module } from 'node:module';
import { normalizeDirKey } from '../src/shared/project-skills';

const repoRoot = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}
function readRel(p: string): string {
  const abs = path.resolve(repoRoot, p);
  if (!fs.existsSync(abs)) return '';
  return fs.readFileSync(abs, 'utf8');
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── seam 安装（必须先于任何 src/main 模块 require：mcp-snapshot-service 顶层 import 链含
//    config-manager(electron-store/safeStorage)/sdk-backend/session-repo(better-sqlite3)）──
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-e2-mcp-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
const origLoad = (Module as unknown as { _load: unknown })._load as
  (this: unknown, req: string, parent: unknown, isMain: boolean) => unknown;
(Module as unknown as { _load: unknown })._load = function (
  this: unknown, req: string, parent: unknown, isMain: boolean,
) {
  if (req === 'electron') return require('./electron-stub.cjs');
  if (/[\\/]session-repo$/.test(req)) {
    return { listWorkingDirCounts: () => new Map(), listRecentWorkingDirs: () => [] };
  }
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
} as typeof origLoad;

// ── 被测模块（RED 阶段不存在 → require 失败降级为断言 FAIL，脚本不 crash）──
interface WatcherMod {
  MCP_WATCHER_DEBOUNCE_MS?: number;
  MCP_WATCHER_REMOUNT_DELAY_MS?: number;
  MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE?: number;
  MCP_WATCHER_PENDING_RETRY_MS?: number;
  mcpWatchTargets?: (deps: unknown) => Array<{ path: string; kind: 'file' | 'dir' }>;
  computeMcpConfigFingerprint?: (targets: Array<{ path: string; kind: 'file' | 'dir' }>) => string;
  startMcpSourceWatcher?: (deps: unknown) => void;
  stopMcpSourceWatcher?: () => void;
  notifyMcpDirsChanged?: () => void;
  isMcpSourceWatcherRunning?: () => boolean;
}
interface ServiceMod {
  collectMcpSnapshotWithAppDeps?: (overrides?: Record<string, unknown>) => Promise<unknown>;
  warmMcpSnapshot?: (overrides?: Record<string, unknown>) => Promise<unknown>;
  broadcastMcpSnapshotInvalidated?: () => void;
}
let watcherMod: WatcherMod | null = null;
let watcherModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  watcherMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'mcp', 'mcp-source-watcher.ts'));
} catch (e) {
  watcherModErr = e instanceof Error ? e.message : String(e);
}
let serviceMod: ServiceMod | null = null;
let serviceModErr = '';
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  serviceMod = require(path.resolve(repoRoot, 'src', 'main', 'modules', 'mcp', 'mcp-snapshot-service.ts'));
} catch (e) {
  serviceModErr = e instanceof Error ? e.message : String(e);
}

// ── 行为夹具：真实 fs，全部落临时目录（绝不触真实 ~/.claude.json）──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-e2-mcp-fix-'));
const tmpHome = path.join(tmpRoot, 'home');
const dirA = path.join(tmpRoot, 'proj-a');       // 目录集内（E2-03 正例）
const dirB = path.join(tmpRoot, 'proj-b');       // 目录集外（E2-03 对照）
const dirDefault = path.join(tmpRoot, 'proj-default');
const dirMissing = path.join(tmpRoot, 'proj-missing'); // 全程不创建（E2-01 坏目录 / E2-04 挂载失败）
const dirC = path.join(tmpRoot, 'proj-c');       // E2-03b 增量挂载新目录
const dirPlain = path.join(tmpRoot, 'proj-plain'); // ⑤c（R5-3 行为钉）目录集新增不带 .mcp.json 的目录
function writeMcpJson(dir: string, server: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [server]: { command: 'node', args: [`${server}.js`] } } }), 'utf8');
}
try {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { 'user-0': { command: 'node', args: ['u0.js'] } } }), 'utf8');
  writeMcpJson(dirA, 'svc-a');
  writeMcpJson(dirB, 'svc-b');
  writeMcpJson(dirDefault, 'svc-default');
  writeMcpJson(dirC, 'svc-c');
  fs.mkdirSync(dirPlain, { recursive: true }); // 只建空目录：不写 .mcp.json（⑤c :missing 条目形态）
} catch (e) {
  console.error('fixture setup failed', e);
  process.exit(1);
}

const mcpJsonOf = (dir: string): string => path.join(dir, '.mcp.json');
function readUserCfg(): string {
  return fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf8');
}
function writeUserCfg(text: string): void {
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), text, 'utf8');
}

// unhandled rejection 收集（E2-01 静默面；注册后 Node 不再因未处理拒绝崩进程，测试自行断言为零）
const unhandled: unknown[] = [];
process.on('unhandledRejection', (r) => { unhandled.push(r); });

// ── watcher 驱动助手：注入去抖/重试定时器（快进）+ 信号收集 + logger spy ──
// 注入去抖窗 200ms（round-001 闸门①修复：原 60ms 对 ⑧ burst 5 写 wait(12) 零裕度——Windows
// setTimeout 下限钳制使相邻写起点实测 12~25ms/拍，5 写实测跨度 60/62/68ms ≥ 60ms 窗，窗口中途
// 触发读得 burst-4 广播 #1、burst-5 落新窗广播 #2，违背「窗口内 5 写恰 1 次广播」断言；实现行为
// 符合契约、字节级与 15/0 通过时点一致，属测试零裕度时序。200ms 使 burst 跨度稳居单窗（对实测
// 最坏 68ms 裕度 ≥130ms，约 3×）；scheduleRefresh 为单 timer 合并（首事件起表，窗内事件并入），
// 放大窗口不改变「恰 1 次广播+末次内容即基准」被测语义；FLUSH_MS=500 仍覆盖全窗+指纹+广播落定，
// 其余用例写入后均等 FLUSH_MS，不受窗口放大影响。文档口径：03 §5 E2-08 未规定写间距/注入值，
// 01:441 仅规定 DI 缝（debounceMs? 缺省 1_500，测试可注入）。
const DEBOUNCE_MS = 200;
const RETRY_MS = 60;
const SETTLE_MS = 350;   // start 后等首拍基准建好（指纹为同步计算，数毫秒级；余量充分）
const FLUSH_MS = 500;    // 一次写入后等去抖窗 + 指纹 + 广播落定

interface WatchSession {
  signals: number[];
  logs: Array<{ level: string; message: string }>;
  stop(): void;
}
function driveWatcher(getDirs: () => string[], home = tmpHome): WatchSession {
  const signals: number[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  watcherMod?.startMcpSourceWatcher?.({
    getUserHome: () => home,
    getProjectDirs: getDirs,
    onMcpSnapshotInvalidated: () => { signals.push(Date.now()); },
    logger: {
      info: (m: string) => logs.push({ level: 'info', message: m }),
      warn: (m: string) => logs.push({ level: 'warn', message: m }),
    },
    debounceMs: DEBOUNCE_MS,
    pendingRetryMs: RETRY_MS,
  });
  return {
    signals,
    logs,
    stop: () => watcherMod?.stopMcpSourceWatcher?.(),
  };
}
/** 除「start 一条 info」外的 logger 输出（E2-09 零噪音口径：挂载失败/事件路径均不得产出）。 */
function nonStartLogs(s: WatchSession): Array<{ level: string; message: string }> {
  return s.logs.filter((e) => !(e.level === 'info' && e.message.includes('已启动')));
}
/** console spy（E2-09：监听器驱动时段 console 零调用——watcher 只经 deps.logger 说话）。 */
function spyConsole(): { calls: string[]; restore(): void } {
  const calls: string[] = [];
  const orig: Record<string, (...args: unknown[]) => void> = {};
  for (const k of ['log', 'info', 'warn', 'error'] as const) {
    orig[k] = (console as unknown as Record<string, (...args: unknown[]) => void>)[k];
    (console as unknown as Record<string, (...args: unknown[]) => void>)[k] = (...args: unknown[]) => {
      calls.push(`${k}:${args.map(String).join(' ')}`);
    };
  }
  return {
    calls,
    restore: () => {
      for (const k of Object.keys(orig)) {
        (console as unknown as Record<string, (...args: unknown[]) => void>)[k] = orig[k];
      }
    },
  };
}

async function main(): Promise<void> {
try {
  console.log('\n=== 组1 行为（E2-01~10；真实 fs + 注入去抖/重试定时器快进） ===');

  // ①② E2-01：ready 预热覆盖 + 不阻塞 + 坏目录静默（条款1）。
  {
    const sub: string[] = [];
    const warm = serviceMod?.warmMcpSnapshot;
    if (typeof warm !== 'function') {
      sub.push(`warmMcpSnapshot 不可用${serviceModErr ? `（模块加载失败：${serviceModErr.slice(0, 160)}）` : ''}`);
    } else {
      let countsRuns = 0;
      const t0 = Date.now();
      const p = warm({
        userHome: tmpHome,
        recentWorkspaces: [dirA, dirMissing],
        defaultWorkingDir: dirDefault,
        listWorkingDirCounts: () => { countsRuns += 1; return new Map(); },
      }) as Promise<{ projectDirs: Array<{ path: string; servers: Array<{ name: string }> }> } | null>;
      // ②a 不阻塞：同步返回时刻预热慢路径（listWorkingDirCounts 在首个 await 之后）尚未执行。
      if (countsRuns !== 0) sub.push(`预热调用应同步返回（countsRuns=0），实际 ${countsRuns}`);
      const snap = (await p) as { projectDirs: Array<{ path: string; servers: Array<{ name: string }> }> } | null;
      if (Date.now() - t0 > 5000) sub.push('预热耗时异常（>5s，坏目录未静默降级？）');
      // ②b 坏目录静默：无 throw（走到这里即未抛）、无 unhandled rejection（脚本级汇总再断言一次）。
      if (unhandled.length !== 0) sub.push(`unhandledRejection 应为 0，实际 ${unhandled.length}`);
      // ① 覆盖面：默认目录 + 2 最近工作区（其一不存在）全部进读取面——svc-a/svc-default 读得即证 IO；
      //    缺失目录条目在位且 servers=[]（ENOENT=正常空态）。
      if (!snap) sub.push('预热应返回快照（无静默失败）');
      else {
        const keys = new Set(snap.projectDirs.map((d) => normalizeDirKey(d.path)));
        for (const d of [dirA, dirDefault, dirMissing]) {
          if (!keys.has(normalizeDirKey(d))) sub.push(`预热覆盖缺目录：${d}，实际 ${JSON.stringify(snap.projectDirs.map((x) => x.path))}`);
        }
        const entryA = snap.projectDirs.find((d) => normalizeDirKey(d.path) === normalizeDirKey(dirA));
        if (!entryA || !entryA.servers.some((s) => s.name === 'svc-a')) sub.push(`dirA 的 .mcp.json 读取面缺席：${JSON.stringify(entryA)}`);
        const entryDef = snap.projectDirs.find((d) => normalizeDirKey(d.path) === normalizeDirKey(dirDefault));
        if (!entryDef || !entryDef.servers.some((s) => s.name === 'svc-default')) sub.push(`默认目录读取面缺席：${JSON.stringify(entryDef)}`);
        const entryMiss = snap.projectDirs.find((d) => normalizeDirKey(d.path) === normalizeDirKey(dirMissing));
        if (!entryMiss || entryMiss.servers.length !== 0) sub.push(`缺失目录应为空态条目：${JSON.stringify(entryMiss)}`);
      }
      if (countsRuns !== 1) sub.push(`预热完成后 listWorkingDirCounts 应恰 1 次，实际 ${countsRuns}`);
    }
    check('①', 'E2-01a 预热覆盖：默认目录+2 最近工作区全部进读取面（svc-a/svc-default 读得、缺失目录空态在位）', sub.length === 0, sub.join('; '));
    check('②', 'E2-01b 预热不阻塞调用方（同步返回时慢依赖未跑）+ 坏目录静默（无 throw / 零 unhandledRejection）', sub.length === 0, sub.join('; '));
  }

  // ③ E2-02：用户级 ~/.claude.json 外部实变 → 每次恰广播 1 次（条款2·用户级）。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push(`startMcpSourceWatcher 不可用${watcherModErr ? `（模块加载失败：${watcherModErr.slice(0, 160)}）` : ''}`);
    } else {
      const s = driveWatcher(() => [dirA]);
      try {
        await wait(SETTLE_MS);
        const before = s.signals.length;
        const cfg0 = readUserCfg();
        const obj = JSON.parse(cfg0) as { mcpServers: Record<string, unknown> };
        obj.mcpServers['user-1'] = { command: 'node', args: ['u1.js'] };
        writeUserCfg(JSON.stringify(obj));
        await wait(FLUSH_MS);
        if (s.signals.length - before !== 1) sub.push(`第一次实变后应恰 1 次广播，实际 ${s.signals.length - before}`);
        const obj2 = JSON.parse(readUserCfg()) as { mcpServers: Record<string, unknown> };
        obj2.mcpServers['user-2'] = { command: 'node', args: ['u2.js'] };
        writeUserCfg(JSON.stringify(obj2));
        await wait(FLUSH_MS);
        if (s.signals.length - before !== 2) sub.push(`第二次实变后应再恰 1 次（累计 2），实际 ${s.signals.length - before}`);
      } finally {
        s.stop();
      }
    }
    check('③', 'E2-02 用户级 ~/.claude.json 外部实变 → 每次恰广播 1 次失效信号', sub.length === 0, sub.join('; '));
  }

  // ④⑤ E2-03：项目目录集内 .mcp.json 变更广播 / 集外不广播；⑤ notifyMcpDirsChanged 增量挂载冒烟。
  {
    const sub: string[] = [];
    let dirsNow: string[] = [dirA];
    const s = driveWatcher(() => dirsNow);
    try {
      await wait(SETTLE_MS);
      // ⑤a 未启动时 notifyMcpDirsChanged 必须 no-op（先停后调）——但当前已启动，改为：
      //    停止 → notify（no-op 不抛）→ 重启后再测增量。此处先测已启动路径（⑤ 在下方）。
      const before = s.signals.length;
      fs.writeFileSync(mcpJsonOf(dirA), JSON.stringify({ mcpServers: { 'svc-a': { command: 'node', args: ['a2.js'] }, 'svc-a2': { command: 'node', args: ['a3.js'] } } }), 'utf8');
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 1) sub.push(`集内目录 A 变更应恰 1 次广播，实际 ${s.signals.length - before}`);
      const before2 = s.signals.length;
      fs.writeFileSync(mcpJsonOf(dirB), JSON.stringify({ mcpServers: { 'svc-b2': { command: 'node', args: ['b2.js'] } } }), 'utf8');
      await wait(FLUSH_MS);
      if (s.signals.length - before2 !== 0) sub.push(`集外目录 B 变更不应广播，实际 ${s.signals.length - before2}`);
      // ⑤ notifyMcpDirsChanged：新目录 C（带 .mcp.json）加入目录集 → 增量挂载 + 指纹实变 → 广播；
      //    后续改 C/.mcp.json 可再广播（证明 C 的 watch 句柄已增量挂上）。
      dirsNow = [dirA, dirC];
      const before3 = s.signals.length;
      watcherMod?.notifyMcpDirsChanged?.();
      await wait(FLUSH_MS);
      if (s.signals.length - before3 !== 1) sub.push(`notifyMcpDirsChanged 新目录带 .mcp.json 应广播 1 次（指纹 missing→实内容），实际 ${s.signals.length - before3}`);
      const before4 = s.signals.length;
      fs.writeFileSync(mcpJsonOf(dirC), JSON.stringify({ mcpServers: { 'svc-c2': { command: 'node', args: ['c2.js'] } } }), 'utf8');
      await wait(FLUSH_MS);
      if (s.signals.length - before4 !== 1) sub.push(`增量挂载后 C 目录变更应广播（句柄已挂），实际 ${s.signals.length - before4}`);
      // ⑤c（R5-3 行为钉，round-005）：目录集新增不带 .mcp.json 的目录 → 指纹条目含 `…:missing`
      // 新条目 → 指纹实变 → 广播恰 1 次（修正 01 §E2-3 旧口径「不带 → 基准更新不广播」的注释
      // 失实——round-004 行为级探针实证 add/remove 均广播 1 次，行为幂等无害、00 契约未违反）。
      dirsNow = [dirA, dirC, dirPlain];
      const before5 = s.signals.length;
      watcherMod?.notifyMcpDirsChanged?.();
      await wait(FLUSH_MS);
      if (s.signals.length - before5 !== 1) sub.push(`目录集新增不带 .mcp.json 的目录应广播恰 1 次（:missing 条目实变），实际 ${s.signals.length - before5}`);
      if (nonStartLogs(s).length !== 0) sub.push(`notify/增量挂载路径不得有噪音日志，实际 ${JSON.stringify(nonStartLogs(s))}`);
    } finally {
      s.stop();
    }
    // ⑤b 未启动路径：stop 后调用必须 no-op 不抛（E3 锚点在 watcher 未启时安全）。
    let noopOk = true;
    try { watcherMod?.notifyMcpDirsChanged?.(); } catch { noopOk = false; }
    if (!noopOk) sub.push('watcher 未启动时 notifyMcpDirsChanged 应 no-op 不抛');
    check('④', 'E2-03 项目目录集内 .mcp.json 变更恰 1 次广播 / 集外目录变更零广播', sub.length === 0, sub.join('; '));
    check('⑤', 'E2-03b notifyMcpDirsChanged 增量挂载冒烟（新目录带 .mcp.json 广播 + 后续变更可感知）+ 未启动 no-op', sub.length === 0, sub.join('; '));
  }

  // ⑥ E2-04：挂载失败降级 + 慢重试自愈（条款2·降级语义；注入 pendingRetryMs 快进）。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push('startMcpSourceWatcher 不可用');
    } else {
      const s = driveWatcher(() => [dirMissing]);
      try {
        await wait(SETTLE_MS);
        if (s.signals.length !== 0) sub.push(`目录不存在挂载失败不应广播，实际 ${s.signals.length}`);
        // 多轮重试（目标仍不存在）：仍无异常、无广播。
        await wait(RETRY_MS * 6);
        if (s.signals.length !== 0) sub.push('目标仍不存在期间不得广播');
        // 自愈：目录从无到有 → 兜底重试挂上 → 指纹 missing→实内容 → 广播（真实磁盘变化）。
        writeMcpJson(dirMissing, 'svc-m');
        await wait(RETRY_MS * 6 + FLUSH_MS);
        if (s.signals.length < 1) sub.push('目录创建后慢重试应挂上并广播（missing→实内容）');
        const before = s.signals.length;
        fs.writeFileSync(mcpJsonOf(dirMissing), JSON.stringify({ mcpServers: { 'svc-m2': { command: 'node', args: ['m2.js'] } } }), 'utf8');
        await wait(FLUSH_MS);
        if (s.signals.length - before < 1) sub.push('自愈挂载后 .mcp.json 变更应可感知（广播到达）');
        if (nonStartLogs(s).length !== 0) sub.push(`挂载失败降级路径不得有噪音日志（静默 pending），实际 ${JSON.stringify(nonStartLogs(s))}`);
      } finally {
        s.stop();
      }
    }
    check('⑥', 'E2-04 挂载失败降级 + 慢重试自愈：全程无异常 / 目录从无到有挂上 / 恢复后变更可感知 / 降级路径零噪音', sub.length === 0, sub.join('; '));
  }

  // ⑦ E2-07：同内容覆写 + 重复 touch（mtime 抖动）→ 广播零次（条款4·指纹；内容哈希口径硬期望）。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push(`startMcpSourceWatcher 不可用${watcherModErr ? `（模块加载失败：${watcherModErr.slice(0, 120)}）` : ''}`);
    }
    const s = driveWatcher(() => [dirA]);
    try {
      await wait(SETTLE_MS);
      const before = s.signals.length;
      const content = fs.readFileSync(mcpJsonOf(dirA), 'utf8');
      fs.writeFileSync(mcpJsonOf(dirA), content, 'utf8'); // 原样回写（mtime 必变、内容不变）
      await wait(FLUSH_MS);
      fs.utimesSync(mcpJsonOf(dirA), new Date(), new Date()); // 重复 touch（mtime 抖动）
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 0) sub.push(`同内容覆写+touch 不应广播（mtime 抖动假信号），实际 ${s.signals.length - before}`);
    } finally {
      s.stop();
    }
    check('⑦', 'E2-07 同内容覆写 + 重复 touch → 广播零次（内容哈希指纹；mtime:size 口径此用例必红）', sub.length === 0, sub.join('; '));
  }

  // ⑧ E2-08：去抖合流——窗口内 5 次不同内容覆写恰 1 次广播 + 末次内容即基准（条款4·去抖）。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push('startMcpSourceWatcher 不可用');
    }
    const s = driveWatcher(() => [dirA]);
    try {
      await wait(SETTLE_MS);
      const before = s.signals.length;
      for (let i = 1; i <= 5; i++) {
        fs.writeFileSync(mcpJsonOf(dirA), JSON.stringify({ mcpServers: { [`burst-${i}`]: { command: 'node', args: ['x.js'] } } }), 'utf8');
        await wait(12); // 窗口内高频连写（编辑器原子写形态）
      }
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 1) sub.push(`窗口内 5 次写应恰 1 次广播（去抖合流），实际 ${s.signals.length - before}`);
      // 末次内容即基准：原样重写第 5 次内容（mtime 变、内容不变）→ 零广播（证明基准已推到末次）。
      const last = fs.readFileSync(mcpJsonOf(dirA), 'utf8');
      fs.writeFileSync(mcpJsonOf(dirA), last, 'utf8');
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 1) sub.push('末次内容重写不应再广播（基准=末次内容）');
    } finally {
      s.stop();
    }
    check('⑧', 'E2-08 去抖合流：窗口内 5 次写恰 1 次广播 + 末次内容即基准（重写零广播）', sub.length === 0, sub.join('; '));
  }

  // ⑨ E2-09：监听零噪音——console 四方法全程零调用；logger 除 start 一条 info 外零输出
  //    （覆盖 E2-02/03/04 全部挂载与事件序列：含挂载失败静默路径）。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push('startMcpSourceWatcher 不可用');
    } else {
      const spy = spyConsole();
      const s = driveWatcher(() => [dirA, dirMissing]); // 含挂载失败目标（E2-04 序列）
      try {
        await wait(SETTLE_MS + RETRY_MS * 4);
        writeUserCfg(readUserCfg().replace('"user-0"', '"user-0"').replace('u0.js', 'u0b.js')); // 用户级实变
        await wait(FLUSH_MS);
        fs.writeFileSync(mcpJsonOf(dirA), JSON.stringify({ mcpServers: { 'svc-a9': { command: 'node', args: ['a9.js'] } } }), 'utf8'); // 项目级实变
        await wait(FLUSH_MS);
        if (spy.calls.length !== 0) sub.push(`console.log/info/warn/error 监听时段应零调用，实际 ${JSON.stringify(spy.calls.slice(0, 5))}`);
        if (nonStartLogs(s).length !== 0) sub.push(`logger 除 start info 外应零输出（挂载失败静默），实际 ${JSON.stringify(nonStartLogs(s))}`);
        const startInfos = s.logs.filter((e) => e.level === 'info' && e.message.includes('已启动'));
        if (startInfos.length !== 1) sub.push(`start 应恰一条 info（噪音水位对齐 command watcher），实际 ${startInfos.length}`);
      } finally {
        s.stop();
        spy.restore();
      }
    }
    check('⑨', 'E2-09 监听零噪音：console 四方法零调用 / logger 仅 start 一条 info（含挂载失败静默）', sub.length === 0, sub.join('; '));
  }

  // ⑩ E2-10：删除 .mcp.json / 写入损坏 JSON 均广播（删与坏=实变硬期望）+ 同损坏内容二次写零广播。
  {
    const sub: string[] = [];
    if (typeof watcherMod?.startMcpSourceWatcher !== 'function') {
      sub.push('startMcpSourceWatcher 不可用');
    }
    const s = driveWatcher(() => [dirA]);
    try {
      await wait(SETTLE_MS);
      const before = s.signals.length;
      fs.unlinkSync(mcpJsonOf(dirA)); // ① 删除 → :missing 指纹 → 实变广播
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 1) sub.push(`删除 .mcp.json 应恰 1 次广播，实际 ${s.signals.length - before}`);
      fs.writeFileSync(mcpJsonOf(dirA), '{oops', 'utf8'); // ② 重建为损坏 JSON → 内容态实变 → 广播
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 2) sub.push(`损坏 JSON 写入应广播（累计 2），实际 ${s.signals.length - before}`);
      const corrupt = fs.readFileSync(mcpJsonOf(dirA), 'utf8');
      fs.writeFileSync(mcpJsonOf(dirA), corrupt, 'utf8'); // ③ 同损坏内容二次写 → 内容未变 → 零广播
      await wait(FLUSH_MS);
      if (s.signals.length - before !== 2) sub.push(`同损坏内容二次写不应广播，实际 ${s.signals.length - before}`);
    } finally {
      s.stop();
    }
    check('⑩', 'E2-10 删除/损坏 JSON 实变均广播 + 同损坏内容二次写零广播（内容口径）', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组2 结构钉（E2-05 接线 + S1/S2 + 模块纯净性） ===');

  // ⑪ E2-05 接线钉（四条接线不变量 + 计数 + handler bypass 锚）。
  {
    const ipcConst = readRel('src/shared/types/ipc.ts');
    const preloadApi = readRel('src/preload/api.ts');
    const webBridge = readRel('src/renderer/web/web-bridge.ts');
    const handlers = readRel('src/main/ipc-handlers.ts');
    const service = readRel('src/main/modules/mcp/mcp-snapshot-service.ts');
    const watcherSrc = readRel('src/main/modules/mcp/mcp-source-watcher.ts');
    const sub: string[] = [];
    // 1) ipc 常量（带注释原文）。
    if (!ipcConst.includes("MCP_SNAPSHOT_CHANGED: 'mcp:snapshotChanged'")) sub.push("ipc.ts 缺 MCP_SNAPSHOT_CHANGED: 'mcp:snapshotChanged'");
    if (!ipcConst.includes('E2（2026-11-15 eight-issues）主→渲染推送：MCP 配置外部变更/目录集变更快照失效信号'))
      sub.push('ipc.ts 缺 E2 通道注释原文（带注释原文要求）');
    // 2) preload 双成员（接口 + 实现）+ getMcpSnapshot 签名扩展 + 头注 117→119。
    if (!preloadApi.includes('onMcpSnapshotChanged: (callback: (payload: Record<string, never>) => void) => () => void;'))
      sub.push('preload 接口缺 onMcpSnapshotChanged 成员');
    if (!preloadApi.includes('removeMcpSnapshotListener: () => void;')) sub.push('preload 接口缺 removeMcpSnapshotListener 成员');
    if (!preloadApi.includes('onMcpSnapshotChanged: (callback) =>')) sub.push('preload 实现缺 onMcpSnapshotChanged');
    if (!preloadApi.includes('removeMcpSnapshotListener: () => ipcRenderer.removeAllListeners(IPC_CHANNELS.MCP_SNAPSHOT_CHANGED)'))
      sub.push('preload 实现缺 removeMcpSnapshotListener removeAllListeners 形态');
    if (!preloadApi.includes('getMcpSnapshot: (opts?: { bypassCache?: boolean; dir?: string }) => Promise<McpSnapshot>;'))
      sub.push('preload 接口 getMcpSnapshot 签名未扩 opts?: { bypassCache?: boolean; dir?: string }');
    if (!preloadApi.includes('getMcpSnapshot: (opts) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SNAPSHOT_GET, opts) as Promise<McpSnapshot>'))
      sub.push('preload 实现 getMcpSnapshot 未透传 opts');
    if (!preloadApi.includes('119 个方法')) sub.push('preload 头注释方法数应 117→119');
    if (preloadApi.includes('117 个方法')) sub.push('preload 头注释 117 旧计数残留');
    // 3) web-bridge 双键。
    if (!webBridge.includes('onMcpSnapshotChanged: IPC_CHANNELS.MCP_SNAPSHOT_CHANGED')) sub.push('web-bridge 缺 onMcpSnapshotChanged 键');
    if (!webBridge.includes('removeMcpSnapshotListener: IPC_CHANNELS.MCP_SNAPSHOT_CHANGED')) sub.push('web-bridge 缺 removeMcpSnapshotListener 键');
    // 4) 发射点：空载荷 {} + 发射前指纹门（基准更新序）。
    if (!service.includes('pushToMainWindow(IPC_CHANNELS.MCP_SNAPSHOT_CHANGED, {})')) sub.push('service 广播缺空载荷 {} 形态 pushToMainWindow');
    if (!service.includes('export function broadcastMcpSnapshotInvalidated')) sub.push('service 缺 broadcastMcpSnapshotInvalidated 导出');
    if (!watcherSrc.includes('deps.onMcpSnapshotInvalidated()')) sub.push('watcher 缺 onMcpSnapshotInvalidated 发射点');
    {
      // 文件头注释含同名字面（申报说明），故 emit 用 lastIndexOf 落到 refreshFingerprints 函数体内
      // 的真实调用点；set/base 在注释中无同名形态，indexOf 即代码位。
      const iBase = watcherSrc.indexOf('if (isFirstBaseline) return');
      const iSet = watcherSrc.indexOf('cur.fingerprint = fp;');
      const iEmit = watcherSrc.lastIndexOf('deps.onMcpSnapshotInvalidated()');
      if (!(iSet > -1 && iBase > iSet && iEmit > iBase))
        sub.push(`发射序应为 基准更新 → 首拍早退 → 发射（实际 set@${iSet} base@${iBase} emit@${iEmit}）`);
    }
    // 5) 无新 invoke handler：regInvokeHandler 计数保持 91（信号推送不注册）。
    const regCount = (handlers.match(/regInvokeHandler\(/g) ?? []).length;
    if (regCount !== 91) sub.push(`regInvokeHandler( 计数应保持 91（无新 invoke handler），实际 ${regCount}`);
    // 6) handler bypass 锚：opts 参数 + collectMcpSnapshotWithAppDeps + 负缓存清除/clearMcpRawCache。
    //    【round-002 P21 留痕】E2 卷原钉临时等价面 badDirCacheMark(dir, Date.now()-BAD_DIR_TTL_MS)
    //    （badDirCacheClear 导出归 E3 点 project-skills.ts，E2 文件圈不含）；E3 已落地，本钉随实现
    //    最小同步为 badDirCacheClear(opts.dir)（带 dir 删单键、无 dir 清整表）。
    {
      const start = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.MCP_SNAPSHOT_GET');
      const next = handlers.indexOf('regInvokeHandler(', start + 10);
      const slice = start > -1 && next > start ? handlers.slice(start, next) : '';
      if (!slice) sub.push('MCP_SNAPSHOT_GET handler 切片定位失败');
      else {
        if (!slice.includes('opts?: { bypassCache?: boolean; dir?: string }')) sub.push('handler 缺 opts?: { bypassCache?: boolean; dir?: string } 参数');
        if (!slice.includes('collectMcpSnapshotWithAppDeps()')) sub.push('handler 应改调 collectMcpSnapshotWithAppDeps()（deps 装配收口）');
        if (!slice.includes('bypassCache === true')) sub.push('handler 缺 bypassCache === true 分支');
        // 带 `;` 语句形锚（防注释字面误命中：E2 临时面申报注释含无分号的 badDirCacheClear(opts.dir) 字样）。
        if (!slice.includes('badDirCacheClear(opts.dir);'))
          sub.push('handler bypass 分支缺负缓存清除语句锚（badDirCacheClear(opts.dir);：带 dir 删单键、无 dir 清整表）');
        if (!slice.includes('clearMcpRawCache()')) sub.push('handler bypass 分支缺 clearMcpRawCache()');
        // 【round-006 R6-2① 白名单切片钉】bypass 分支白名单门三字面（R5-2 主进程防御面锚定防删）：
        // `if (opts.dir !== undefined)` 门行 / `knownKeys` 白名单集 / 「目录不在可扫描白名单内」
        // 友好文案——对基线 3be0d7d 必红（基线 handler 无 bypass 分支，三字面全缺），反证留痕头注。
        if (!slice.includes('if (opts.dir !== undefined)')) sub.push('handler bypass 分支缺白名单门行 if (opts.dir !== undefined)');
        if (!slice.includes('knownKeys')) sub.push('handler bypass 分支缺白名单集 knownKeys');
        if (!slice.includes('目录不在可扫描白名单内')) sub.push('handler bypass 分支缺白名单文案「目录不在可扫描白名单内」');
      }
    }
    // 7) service 导出面：collect/warm（try/catch 静默）+ E4 统一目录源装配。
    if (!service.includes('export function collectMcpSnapshotWithAppDeps')) sub.push('service 缺 collectMcpSnapshotWithAppDeps 导出');
    if (!service.includes('export async function warmMcpSnapshot')) sub.push('service 缺 warmMcpSnapshot 导出');
    {
      const wi = service.indexOf('export async function warmMcpSnapshot');
      const wbody = wi > -1 ? service.slice(wi, wi + 700) : '';
      if (!wbody.includes('try') || !wbody.includes('catch')) sub.push('warmMcpSnapshot 应 try/catch 静默失败（契约 #1）');
    }
    if (!service.includes('listRecentAndSessionProjectDirs(20)')) sub.push('service 装配缺 E4 统一目录源 listRecentAndSessionProjectDirs(20)');
    check('⑪', 'E2-05 接线钉：常量+注释 / preload 双成员+签名+119 / web-bridge 双键 / 空载荷+发射序 / regInvokeHandler=91 / handler bypass 锚+白名单切片钉（R6-2①） / service 导出面', sub.length === 0, sub.join('; '));
  }

  // ⑫ 模块纯净性 + 常量值 + watcher 导出面（E2-05/S2；§8 ①②锚）。
  {
    const watcherSrc = readRel('src/main/modules/mcp/mcp-source-watcher.ts');
    const sub: string[] = [];
    if (!watcherSrc) sub.push('src/main/modules/mcp/mcp-source-watcher.ts 不存在');
    else {
      // 纯净性按 import 行检查（文件头注释的申报说明含同名字面，须剥离后检查）。
      const importLines = watcherSrc.split(/\r?\n/).filter((l) => /^\s*import\s/.test(l) || /require\(/.test(l)).join('\n');
      if (/from 'electron'/.test(importLines) || /require\('electron'\)/.test(importLines)) sub.push("watcher 模块出现 electron import（依赖注入边界被破坏）");
      if (importLines.includes('sdk-backend')) sub.push('watcher 模块出现 sdk-backend import');
      if (importLines.includes('config-manager')) sub.push('watcher 模块出现 config-manager import');
      if (importLines.includes('push-bus')) sub.push('watcher 模块出现 push-bus import（广播经 deps.onMcpSnapshotInvalidated 注入）');
      if (importLines.includes('workspace-history')) sub.push('watcher 模块出现 workspace-history import（目录源经 deps.getProjectDirs 注入）');
    }
    if (watcherMod) {
      if (watcherMod.MCP_WATCHER_DEBOUNCE_MS !== 1500) sub.push(`MCP_WATCHER_DEBOUNCE_MS 应 1500，实际 ${String(watcherMod.MCP_WATCHER_DEBOUNCE_MS)}`);
      if (watcherMod.MCP_WATCHER_REMOUNT_DELAY_MS !== 5000) sub.push(`MCP_WATCHER_REMOUNT_DELAY_MS 应 5000，实际 ${String(watcherMod.MCP_WATCHER_REMOUNT_DELAY_MS)}`);
      if (watcherMod.MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE !== 3) sub.push(`MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE 应 3，实际 ${String(watcherMod.MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE)}`);
      if (watcherMod.MCP_WATCHER_PENDING_RETRY_MS !== 30_000) sub.push(`MCP_WATCHER_PENDING_RETRY_MS 应 30000，实际 ${String(watcherMod.MCP_WATCHER_PENDING_RETRY_MS)}`);
      if (typeof watcherMod.stopMcpSourceWatcher !== 'function') sub.push('缺 stopMcpSourceWatcher 导出');
      if (typeof watcherMod.notifyMcpDirsChanged !== 'function') sub.push('缺 notifyMcpDirsChanged 导出（E3 锚点）');
      if (typeof watcherMod.isMcpSourceWatcherRunning !== 'function') sub.push('缺 isMcpSourceWatcherRunning 导出');
      // watchTargets 形态（§E2-3 伪代码）：用户级文件粒度 + 目录集目录粒度；missing 指纹确定性。
      if (typeof watcherMod.mcpWatchTargets === 'function') {
        const targets = watcherMod.mcpWatchTargets({
          getUserHome: () => '/e2home',
          getProjectDirs: () => ['/e2a', '/E2A', ''],
          onMcpSnapshotInvalidated: () => {},
          logger: { info: () => {}, warn: () => {} },
        }) as Array<{ path: string; kind: string }>;
        const fileT = targets.find((t) => t.path.replace(/\\/g, '/').endsWith('/.claude.json'));
        if (!fileT || fileT.kind !== 'file') sub.push(`watchTargets 缺用户级 file 粒度目标，实际 ${JSON.stringify(targets)}`);
        const dirTargets = targets.filter((t) => t.kind === 'dir');
        if (dirTargets.length !== 1) sub.push(`watchTargets 目录集大小写变体应去重（/e2a 与 /E2A 单条），实际 ${JSON.stringify(dirTargets)}`);
        if (targets.some((t) => t.path === '')) sub.push('watchTargets 不得纳入空串目录');
        if (typeof watcherMod.computeMcpConfigFingerprint === 'function') {
          const fp1 = watcherMod.computeMcpConfigFingerprint([{ path: path.join(tmpRoot, 'nonexistent-target'), kind: 'dir' }]);
          const fp2 = watcherMod.computeMcpConfigFingerprint([{ path: path.join(tmpRoot, 'nonexistent-target'), kind: 'dir' }]);
          if (fp1 !== fp2) sub.push('缺失目标指纹应确定（:missing 态可重复计算）');
          const fpA = watcherMod.computeMcpConfigFingerprint([{ path: dirA, kind: 'dir' }]);
          const fpB = watcherMod.computeMcpConfigFingerprint([{ path: dirB, kind: 'dir' }]);
          if (fpA === fpB) sub.push('不同内容文件指纹应不同');
        } else {
          sub.push('缺 computeMcpConfigFingerprint 导出');
        }
      } else {
        sub.push('缺 mcpWatchTargets 导出');
      }
    } else {
      sub.push(`watcher 模块加载失败：${watcherModErr.slice(0, 160)}`);
    }
    check('⑫', 'E2-05/S2 模块纯净性（零 electron/sdk-backend/config-manager/push-bus/workspace-history import）+ 常量值 + 导出面 + targets 去重/missing 指纹', sub.length === 0, sub.join('; '));
  }

  // ⑬ E2-S1：预热接线钉（index.ts）。
  //   【备忘(b)（round-005）钉面同步留痕】index.ts 预热调用改为 void warmMcpSnapshot().then(...)
  //   （失败 logger.debug 旁路，01 §E2-5 括注「try/catch 静默 logger.debug」）——fire-and-forget
  //   语义不变（void 前缀、无 await、不阻塞启动窗口），钉字面去尾分号适配 .then 形态
  //   （原 void warmMcpSnapshot(); 字面由本注留痕）。
  {
    const index = readRel('src/main/index.ts');
    const sub: string[] = [];
    if (!index.includes('void warmMcpSnapshot()')) sub.push('index.ts 缺 void warmMcpSnapshot()（fire-and-forget）');
    if (!index.includes('if (snap === null) logger.debug')) sub.push('index.ts 预热缺失败 logger.debug 旁路（备忘(b)，01 §E2-5 括注）');
    if (/await\s+warmMcpSnapshot/.test(index)) sub.push('index.ts 不得 await warmMcpSnapshot（阻塞启动窗口）');
    const iReady = index.indexOf('app.whenReady()');
    const iWarm = index.indexOf('void warmMcpSnapshot()');
    if (!(iReady > -1 && iWarm > iReady)) sub.push('预热调用应位于 whenReady 之后（ready 链内）');
    if (!index.includes('function startMcpSourceWatcherPipeline(')) sub.push('index.ts 缺 startMcpSourceWatcherPipeline 定义');
    const callCount = (index.match(/startMcpSourceWatcherPipeline\(\);/g) ?? []).length;
    if (callCount !== 2) sub.push(`startMcpSourceWatcherPipeline() 应恰 2 处调用（whenReady+activate），实际 ${callCount}`);
    if (!index.includes("import { startMcpSourceWatcher, stopMcpSourceWatcher } from './modules/mcp/mcp-source-watcher'"))
      sub.push("index.ts 缺 import { startMcpSourceWatcher, stopMcpSourceWatcher } from './modules/mcp/mcp-source-watcher'");
    if (!index.includes('warmMcpSnapshot')) sub.push('index.ts 缺 warmMcpSnapshot import');
    {
      const iClosed = index.indexOf("app.on('window-all-closed'");
      const iNext = index.indexOf("app.on(", iClosed + 10);
      const slice = iClosed > -1 && iNext > iClosed ? index.slice(iClosed, iNext) : '';
      if (!slice.includes('stopMcpSourceWatcher();')) sub.push('window-all-closed 缺 stopMcpSourceWatcher()');
    }
    check('⑬', 'E2-S1 预热接线钉：void warmMcpSnapshot 位于 whenReady 后 / pipeline 定义 1 调用 2 / window-all-closed stop / import 面', sub.length === 0, sub.join('; '));
  }

  // ⑭ E2-S2：watcher 生命周期单例 + 降级同形钉（pending 慢重试 + error 5s×3 转 30s）。
  {
    const watcherSrc = readRel('src/main/modules/mcp/mcp-source-watcher.ts');
    const sub: string[] = [];
    if (!watcherSrc) sub.push('watcher 文件不存在');
    else {
      if (!/if \(state\) return;/.test(watcherSrc)) sub.push('startMcpSourceWatcher 缺全局单例幂等守卫（if (state) return;）');
      if (!watcherSrc.includes('pendingRoots')) sub.push('缺 pendingRoots（挂载失败降级同形）');
      if (!watcherSrc.includes('setInterval')) sub.push('缺 setInterval 兜底慢重试循环');
      if (!watcherSrc.includes('MCP_WATCHER_PENDING_RETRY_MS = 30_000')) sub.push('缺 MCP_WATCHER_PENDING_RETRY_MS = 30_000');
      if (!watcherSrc.includes('MCP_WATCHER_REMOUNT_DELAY_MS = 5000')) sub.push('缺 MCP_WATCHER_REMOUNT_DELAY_MS = 5000');
      if (!watcherSrc.includes('MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE = 3')) sub.push('缺 MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE = 3');
      if (!watcherSrc.includes('syncMountedRoots')) sub.push('缺 syncMountedRoots（差集增量挂载/摘除，P2-D 同构）');
      if (!watcherSrc.includes('refreshSeq')) sub.push('缺 refreshSeq 单调序号守卫（hb10-CMD-V03 同构）');
      if (/sessionId|per-session|sessions\.get/i.test(watcherSrc.replace(/\/\/[^\n]*/g, ''))) sub.push('watcher 出现会话级耦合（应主进程级单例，无 per-session Map）');
    }
    check('⑭', 'E2-S2 生命周期/降级同形钉：单例守卫 / pendingRoots 慢重试 / 5s×3 转 30s 常量 / syncMountedRoots / seq 守卫 / 零会话耦合', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组3 spawn 回归门 ===');

  // ⑮ E2-05 spawn 回归门：wiring verify（§11.2 双向对等自动覆盖新键）实跑 exit 0。
  {
    const r = spawnSync('npx', ['tsx', 'scripts/tdd-web-access-wiring-verify.ts'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32',
    });
    const ok = r.status === 0;
    check('⑮', 'E2-05 spawn 回归门：tdd-web-access-wiring-verify.ts exit 0（键集对等自动覆盖 +2 表键/+2 接口成员）',
      ok, ok ? '' : `exit=${String(r.status)} 输出尾部：${String(r.stdout || '').slice(-300)}${String(r.stderr || '').slice(-300)}`);
  }
} finally {
  watcherMod?.stopMcpSourceWatcher?.();
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}
}

function finish(): void {
  if (unhandled.length !== 0) {
    console.log(`\n⚠ unhandledRejection 共 ${unhandled.length} 条：${unhandled.map(String).join(' | ').slice(0, 500)}`);
    fail += 1;
  }
  console.log(`\n===== tdd-mcp-external-change-watch-verify: ${pass} pass / ${fail} fail =====`);
  if (fail > 0) console.log('（RED 阶段：FAIL 项为尚未实施的生产改动，实施后应全 PASS）');
  process.exit(fail > 0 ? 1 : 0);
}

void main()
  .then(finish)
  .catch((e: unknown) => {
    console.error('main 执行异常（夹具已尽力清理）', e);
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
    process.exit(1);
  });
