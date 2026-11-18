// tdd-mcp-workspace-scan-hook-verify.ts
// E3「项目打开自动扫描（主进程挂点）」TDD 契约（docs/plans/2026-11-15-eight-issues-batch/
// 03-test-cases-main.md §6 E3-01~06；行为契约 00-behavior-specs.md §E3；实现细节
// 01-impl-details-main.md §E3-1~E3-5；计划定名 04-实施计划.md §4.1：tdd-mcp-source-watcher-verify
// ≡ tdd-mcp-external-change-watch-verify（E2）+ 本名（E3））。
// 用例→断言映射：
//   ① E3-01 三效应合一（条款1）：dirP 先处坏目录负缓存态（badDirCacheMark 语义制造，先例
//        selftest-mcp-settings E3g/E3i——负缓存期内 collect 仍缺席）→ 写入合法 .mcp.json →
//        触发 WORKSPACE_ADD_RECENT 落点 → (a) 负缓存已清（badDirCacheHas=false 且再 collect
//        dirP 读得新 server）；(b) 恰广播 1 次快照失效信号（mcp:snapshotChanged）；(c) watcher
//        已增量挂载 dirP（其后再改 .mcp.json 可广播证明）。三效应缺一即失败。
//   ② E3-02 目录集第二目录同效 + 目录集外不受影响（条款2）：dirQ 经 E3-01 同款 ADD 流程在位；
//        dirR 经目录集增长路径（会话 distinct 工作目录加入=统一目录源扩集）进入集内 → 任一次
//        指纹刷新（此处以用户级文件事件触发，01 §E3-1「watcher 每次指纹刷新的 syncMountedRoots
//        对齐」）即挂载 dirR（改 R/.mcp.json 广播到达）——0 1 §E3-1 裁定：会话 distinct 路径无
//        专用事件锚（不新建额外事件锚，最小影响面），「同效」由统一目录集口径保证；负面断言
//        E3-02 附带：03 用例原文「清 R 负缓存」在会话 distinct 路径无主进程清除锚（E1 手动扫描
//        bypassCache/60s TTL 自愈兜底），本卷不在该路径钉负缓存清除（申报为用例裁剪，评审可
//        推翻）。对照：集外目录 dirS（从未进集）改动零广播。
//   ③ E3-04 REMOVE 收缩句柄（派发词明示）：WORKSPACE_REMOVE_RECENT(dirP) 后改 dirP/.mcp.json
//        → 零广播（句柄已摘除）；对照改 dirQ 仍广播（他目录不受累）；REMOVE 落点 mcp:snapshot
//        Changed 广播恰 0 次（01 §E3-1「广播不补发——移出清单无需重拉快照」）。
//   ④ E3-05 重复添加同目录幂等（派生边界·并发）：连续两次 WORKSPACE_ADD_RECENT(dirP) → 改
//        dirP/.mcp.json 一次 → 广播恰 1 次（挂载幂等，双 watch 会破坏去抖单信号）；两次 ADD 各
//        自的失效信号照发（渲染层重拉幂等，无害）；负缓存清除重复触发无害。
//   ⑤ E3-06 添加不存在目录不崩（派生边界·异常）：对不存在目录触发添加落点 → 无异常；失效信号
//        照发（负缓存清除对不存在目录为无害空操作）；watcher 走 E2-04 降级路径（pending 慢重试
//        注入短周期，目录从无到有后自愈挂上、变更可感知），全程零 unhandledRejection。
//   ⑥ E3-03 接线序钉（条款3·结构）：WORKSPACE_ADD_RECENT handler 内失效信号三连（badDirCache
//        Clear(dir) → broadcastMcpSnapshotInvalidated() → notifyMcpDirsChanged()）位于既有
//        WORKSPACES_CHANGED 发射之后、return 之前（与 wiring ⑭「发射位于 addRecentWorkspace(dir)
//        之后」衔接为同流程自主发射，不依赖渲染层二次触发）；WORKSPACE_REMOVE_RECENT 仅追加
//        notifyMcpDirsChanged()（无 broadcast/badDirCacheClear——广播不补发）；import 区三导出
//        锚；project-skills.ts badDirCacheClear 导出形态（带 dir 删单键 badDirUntil.delete(
//        normalizeDirKey(dir)) / 无 dir 清整表）+ Skill 既有 mark/Has 语义一字不动。渲染层
//        WORKSPACES_CHANGED 订阅联动由 tdd-web-access-wiring ⑭ 钉住（交叉引用不重写，spawn 门
//        回归）；渲染层 stale/重拉消费归渲染器域（E3 裁定：主进程在 ADD 锚点同步翻译为 MCP 信号，
//        乙域单订阅）。
//   ⑦ spawn 回归门：spawnSync 实跑 tdd-web-access-wiring-verify.ts exit 0（⑭ ADD/REMOVE 发射序
//        既有钉 + §11.2 键集对等回归）。
// seam：Module._load 拦截 electron→scripts/electron-stub.cjs（+app.getVersion 供 electron-store）+
//   ipcMain.handle 捕获注册调用（03 §6 驱动手法「先例：electron-stub 捕获注册调用」——捕获
//   workspace:addRecent / workspace:removeRecent 直调 handler）、session-repo→stub（真实
//   better-sqlite3 为 Electron ABI 纯 node 不可加载；listRecentWorkingDirs 可变数组供 E3-02 会话
//   distinct 路径注入）；广播捕获经 push-bus setWebPushSink（WORKSPACES_CHANGED 与 ADD 锚点直发
//   的 mcp:snapshotChanged 都走 push-bus；watcher 指纹广播走测试注入的 deps.onMcpSnapshotInvalidated
//   ——两路信号源天然可分，①(b) 的「恰 1 次」即 push-bus 路直发信号恰 1 次）；watcher deps.getProjectDirs
//   注入真实 E4 统一目录源 listRecentAndSessionProjectDirs(20)（挂载面=生产形态）；负缓存与 collect
//   链共用 project-skills 模块单实例（badDirCacheHas/badDirCacheMark/badDirCacheClear 同实例）；
//   真实 fs 夹具全部落系统临时目录，绝不触真实 ~/.claude.json / 真实工作区清单（workspace store
//   经 CLAUDE_LINK_TEST_USERDATA 隔离）。
// RED 预期（未实现树）：ADD 落点无三连 → ①(a)(b)(c)/②挂载/④⑤直发信号全 FAIL；REMOVE 无
//   notify → ③句柄收缩 FAIL；结构钉 ⑥ 全 FAIL；既有基线脚本（tdd-web-access-wiring /
//   selftest-mcp-settings / tdd-mcp-external-change-watch-verify）不受影响。
// 运行：npx tsx scripts/tdd-mcp-workspace-scan-hook-verify.ts（登记 scripts/selftest-static-list.txt 尾部）。

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
/** 源码行尾归一（仓库 CRLF/LF 混存；多行逐字锚统一按 LF 比对）。 */
function norm(src: string): string {
  return src.replace(/\r\n/g, '\n');
}
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── seam 安装（必须先于任何 src/main 模块 require）──
const tmpUserData = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-e3-scan-ud-'));
process.env.CLAUDE_LINK_TEST_USERDATA = tmpUserData;
const capturedHandlers = new Map<string, unknown>();
const origLoad = (Module as unknown as { _load: unknown })._load as
  (this: unknown, req: string, parent: unknown, isMain: boolean) => unknown;
(Module as unknown as { _load: unknown })._load = function (
  this: unknown, req: string, parent: unknown, isMain: boolean,
) {
  if (req === 'electron') {
    const stub = require('./electron-stub.cjs') as Record<string, unknown>;
    return {
      ...stub,
      app: { ...(stub.app as Record<string, unknown>), getVersion: () => '0.0.0-e3-test' },
      // ipcMain.handle 捕获注册调用（03 §6 驱动手法先例）+ on 兜底（部分注册路径用）。
      ipcMain: {
        handle: (ch: string, fn: unknown) => { capturedHandlers.set(ch, fn); },
        on: () => {},
      },
    };
  }
  if (/[\\/]session-repo$/.test(req)) {
    // 会话 distinct 工作目录注入面（E3-02 目录集增长路径）：可变数组=「会话切换使目录集新增」。
    return {
      listWorkingDirCounts: () => new Map<string, number>(),
      listRecentWorkingDirs: (cap: number) => sessionDirsFixture.slice(0, cap),
    };
  }
  return origLoad.apply(this, [req, parent, isMain] as unknown as Parameters<typeof origLoad>);
} as typeof origLoad;

// ── 行为夹具：真实 fs，全部落临时目录（绝不触真实 ~/.claude.json / 真实工作区清单）──
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-e3-scan-fix-'));
const tmpHome = path.join(tmpRoot, 'home');
const dirP = path.join(tmpRoot, 'proj-p');       // E3-01 主角（负缓存前置态 → ADD → E3-04 REMOVE → E3-05 重加）
const dirQ = path.join(tmpRoot, 'proj-q');       // E3-02 已在集内对照（E3-04 他目录不受累对照）
const dirR = path.join(tmpRoot, 'proj-r');       // E3-02 会话 distinct 路径新增目录
const dirS = path.join(tmpRoot, 'proj-s');       // E3-02 集外对照（全程不进集）
const dirMissing = path.join(tmpRoot, 'proj-missing'); // E3-06 全程不存在（自愈阶段才创建）
const sessionDirsFixture: string[] = [];         // session-repo stub 的会话 distinct 工作目录
function writeMcpJson(dir: string, server: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { [server]: { command: 'node', args: [`${server}.js`] } } }), 'utf8');
}
try {
  fs.mkdirSync(tmpHome, { recursive: true });
  fs.writeFileSync(path.join(tmpHome, '.claude.json'), JSON.stringify({ mcpServers: { 'user-0': { command: 'node', args: ['u0.js'] } } }), 'utf8');
  writeMcpJson(dirQ, 'svc-q');
  writeMcpJson(dirR, 'svc-r');
  writeMcpJson(dirS, 'svc-s');
  // dirP 与 dirMissing 此刻均无 .mcp.json（E3-01 负缓存前置 / E3-06 不存在目录）。
} catch (e) {
  console.error('fixture setup failed', e);
  process.exit(1);
}

// unhandled rejection 收集（E3-06 异常面；注册后 Node 不再因未处理拒绝崩进程，测试自行断言为零）
const unhandled: unknown[] = [];
process.on('unhandledRejection', (r) => { unhandled.push(r); });

// ── 被测模块（RED 阶段导出缺席 → 断言 FAIL，脚本不 crash）──
interface PushBusMod {
  initPushBus?: (getter: () => null) => void;
  setWebPushSink?: (sink: ((channel: string, args: unknown[]) => void) | null) => void;
}
interface WorkspaceHistoryMod {
  listRecentWorkspaces?: () => string[];
  addRecentWorkspace?: (dir: string) => string[];
  removeRecentWorkspace?: (dir: string) => string[];
}
interface DirSetMod { listRecentAndSessionProjectDirs?: (dirCap?: number) => string[] }
interface ProjectSkillsMod {
  badDirCacheMark?: (dir: string, now?: number) => void;
  badDirCacheHas?: (dir: string, now?: number) => boolean;
  badDirCacheClear?: (dir?: string) => void;
}
interface ServiceMod {
  collectMcpSnapshotWithAppDeps?: (overrides?: Record<string, unknown>) => Promise<{
    projectDirs: Array<{ path: string; servers: Array<{ name: string }> }>;
  }>;
}
interface WatcherMod {
  startMcpSourceWatcher?: (deps: unknown) => void;
  stopMcpSourceWatcher?: () => void;
  isMcpSourceWatcherRunning?: () => boolean;
}
function reqMod<T>(rel: string[], errBox: { v: string }): T | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.resolve(repoRoot, ...rel)) as T;
  } catch (e) {
    errBox.v = e instanceof Error ? e.message : String(e);
    return null;
  }
}
const pushBusErr = { v: '' };
const pushBus = reqMod<PushBusMod>(['src', 'main', 'modules', 'push-bus.ts'], pushBusErr);
const wsHistErr = { v: '' };
const wsHist = reqMod<WorkspaceHistoryMod>(['src', 'main', 'modules', 'workspace-history.ts'], wsHistErr);
const dirSetErr = { v: '' };
const dirSet = reqMod<DirSetMod>(['src', 'main', 'modules', 'project-dir-set.ts'], dirSetErr);
const psErr = { v: '' };
const projectSkills = reqMod<ProjectSkillsMod>(['src', 'main', 'modules', 'project-skills.ts'], psErr);
const svcErr = { v: '' };
const service = reqMod<ServiceMod>(['src', 'main', 'modules', 'mcp', 'mcp-snapshot-service.ts'], svcErr);
const watcherErr = { v: '' };
const watcher = reqMod<WatcherMod>(['src', 'main', 'modules', 'mcp', 'mcp-source-watcher.ts'], watcherErr);
let ipcModErr = '';
let registerIpcHandlers: ((win: unknown) => void) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const m = require(path.resolve(repoRoot, 'src', 'main', 'ipc-handlers.ts')) as { registerIpcHandlers?: (win: unknown) => void };
  registerIpcHandlers = m.registerIpcHandlers ?? null;
} catch (e) {
  ipcModErr = e instanceof Error ? e.message : String(e);
}

// ── 广播捕获：push-bus webSink（主窗 getter 恒 null——桌面单播判空跳过，webSink 全量记录）──
const broadcasts: Array<{ channel: string }> = [];
pushBus?.initPushBus?.(() => null);
pushBus?.setWebPushSink?.((channel: string) => { broadcasts.push({ channel }); });
const countSink = (channel: string, from?: number): number =>
  broadcasts.slice(from ?? 0).filter((b) => b.channel === channel).length;

// ── watcher 驱动：注入去抖/慢重试定时器（快进）+ 指纹广播计数 + 真实 E4 统一目录源 ──
const DEBOUNCE_MS = 60;
const RETRY_MS = 50;
const SETTLE_MS = 350;   // start 后等首拍基准建好（指纹为同步计算，数毫秒级；余量充分）
const FLUSH_MS = 500;    // 一次文件事件/notify 后等去抖窗 + 指纹 + 广播落定
let watcherSignals = 0;  // watcher 指纹实变信号（deps.onMcpSnapshotInvalidated 注入计数）
watcher?.startMcpSourceWatcher?.({
  getUserHome: () => tmpHome,
  getProjectDirs: () => dirSet?.listRecentAndSessionProjectDirs?.(20) ?? [],
  onMcpSnapshotInvalidated: () => { watcherSignals += 1; },
  logger: { info: () => {}, warn: () => {} },
  debounceMs: DEBOUNCE_MS,
  pendingRetryMs: RETRY_MS,
});

// ── handler 直调（electron-stub 捕获注册调用先例；await 到三连/返回值全落定）──
let ipcHookErr = '';
if (typeof registerIpcHandlers === 'function') {
  try { registerIpcHandlers(null); } catch (e) { ipcHookErr = e instanceof Error ? e.message : String(e); }
} else {
  ipcHookErr = `registerIpcHandlers 不可用${ipcModErr ? `（模块加载失败：${ipcModErr.slice(0, 160)}）` : ''}`;
}
const addHandler = capturedHandlers.get('workspace:addRecent') as ((e: null, dir: string) => Promise<string[]>) | undefined;
const removeHandler = capturedHandlers.get('workspace:removeRecent') as ((e: null, dir: string) => Promise<string[]>) | undefined;

/** collect 一拍（真实生产 collect 链 + 仅 io 级 override 钉临时目录；负缓存走共享单实例默认面）。 */
async function collectOne(recent: string[]): Promise<Array<{ path: string; servers: Array<{ name: string }> }>> {
  const snap = (await service?.collectMcpSnapshotWithAppDeps?.({
    userHome: tmpHome,
    recentWorkspaces: recent,
    defaultWorkingDir: null,
    listWorkingDirCounts: () => new Map<string, number>(),
  })) as { projectDirs: Array<{ path: string; servers: Array<{ name: string }> }> } | undefined;
  return snap?.projectDirs ?? [];
}
const dirViewOf = (dirs: Array<{ path: string; servers: Array<{ name: string }> }>, dir: string) =>
  dirs.find((d) => normalizeDirKey(d.path) === normalizeDirKey(dir));

async function main(): Promise<void> {
try {
  console.log('\n=== 组1 行为（E3-01/02/04/05/06；真实 fs + 注入去抖/重试定时器快进 + handler 直调） ===');

  // 前置健康：seam 全部就位（RED 阶段不因 seam 缺席而误报——seam 缺席时报明确的 seam 错）。
  {
    const sub: string[] = [];
    if (!pushBus?.setWebPushSink) sub.push(`push-bus seam 缺席${pushBusErr.v ? `：${pushBusErr.v.slice(0, 160)}` : ''}`);
    if (!wsHist?.addRecentWorkspace) sub.push(`workspace-history seam 缺席${wsHistErr.v ? `：${wsHistErr.v.slice(0, 160)}` : ''}`);
    if (!dirSet?.listRecentAndSessionProjectDirs) sub.push(`project-dir-set seam 缺席${dirSetErr.v ? `：${dirSetErr.v.slice(0, 160)}` : ''}`);
    if (!projectSkills?.badDirCacheMark) sub.push(`project-skills seam 缺席${psErr.v ? `：${psErr.v.slice(0, 160)}` : ''}`);
    if (!service?.collectMcpSnapshotWithAppDeps) sub.push(`mcp-snapshot-service seam 缺席${svcErr.v ? `：${svcErr.v.slice(0, 160)}` : ''}`);
    if (!watcher?.startMcpSourceWatcher) sub.push(`mcp-source-watcher seam 缺席${watcherErr.v ? `：${watcherErr.v.slice(0, 160)}` : ''}`);
    if (!addHandler || !removeHandler) {
      sub.push(`handler 捕获缺席（add=${String(addHandler !== undefined)} remove=${String(removeHandler !== undefined)}）${ipcHookErr ? `：${ipcHookErr.slice(0, 160)}` : ''}`);
    }
    await wait(SETTLE_MS);
    if (unhandled.length !== 0) sub.push(`前置期 unhandledRejection 应为 0，实际 ${unhandled.length}`);
    check('⓪', 'seam 前置健康：模块/handler 捕获/统一目录源全就位 + watcher 首拍基准零广播', sub.length === 0, sub.join('; '));
  }

  // ① E3-01：三效应合一（条款1；负缓存前置态用 badDirCacheMark 语义制造）。
  {
    const sub: string[] = [];
    if (!addHandler || !projectSkills?.badDirCacheMark || !service?.collectMcpSnapshotWithAppDeps) {
      sub.push('前置 seam 缺席（见 ⓪）');
    } else {
      // 前置：P 无 .mcp.json → badDirCacheMark(P)（E3g/E3i 语义先例）→ 负缓存态确认。
      projectSkills.badDirCacheMark(dirP);
      if (!projectSkills.badDirCacheHas?.(dirP)) sub.push('前置自检：badDirCacheMark 后 badDirCacheHas 应为 true');
      // ① 确认负缓存态下 collect P 返回「无项目级 server」。
      const dirsBefore = await collectOne([dirP]);
      const vBefore = dirViewOf(dirsBefore, dirP);
      if (!vBefore || vBefore.servers.length !== 0) sub.push(`负缓存态 collect P 应 servers=[]，实际 ${JSON.stringify(vBefore)}`);
      // 之后在 P 写入合法 .mcp.json（磁盘已实变，但负缓存期内 collect 仍缺席）。
      writeMcpJson(dirP, 'svc-p');
      const dirsCached = await collectOne([dirP]);
      const vCached = dirViewOf(dirsCached, dirP);
      if (!vCached || vCached.servers.length !== 0) sub.push(`负缓存期内磁盘已实变仍应缺席（负缓存未生效），实际 ${JSON.stringify(vCached)}`);
      // ② 触发 WORKSPACE_ADD_RECENT 落点（目录=P）——捕获面直调 handler。
      const sinkMark = broadcasts.length;
      const sigMark = watcherSignals;
      let addErr = '';
      try { await addHandler(null, dirP); } catch (e) { addErr = e instanceof Error ? e.message : String(e); }
      if (addErr) sub.push(`ADD handler 抛错：${addErr}`);
      // ③ 断言三效应。
      // (a) 负缓存已清：badDirCacheHas=false 且再 collect P 读得新 server。
      if (projectSkills.badDirCacheHas?.(dirP)) sub.push('(a) ADD 后负缓存未清（badDirCacheHas(P) 仍 true）');
      const dirsAfter = await collectOne([dirP]);
      const vAfter = dirViewOf(dirsAfter, dirP);
      if (!vAfter || !vAfter.servers.some((s) => s.name === 'svc-p')) sub.push(`(a) ADD 后再 collect P 应读得 svc-p（负缓存已清），实际 ${JSON.stringify(vAfter)}`);
      // (b) 恰广播 1 次快照失效信号（push-bus 路直发 mcp:snapshotChanged；watcher 路另行计数）。
      const directSignals = countSink('mcp:snapshotChanged', sinkMark);
      if (directSignals !== 1) sub.push(`(b) ADD 后应恰广播 1 次 mcp:snapshotChanged（直发），实际 ${directSignals}`);
      if (countSink('workspaces:changed', sinkMark) !== 1) sub.push(`ADD 既有 WORKSPACES_CHANGED 应仍恰 1 次，实际 ${countSink('workspaces:changed', sinkMark)}`);
      // notify 增量挂载（新目录带 .mcp.json → 指纹 missing→实内容）→ watcher 路恰 1 条实变信号。
      await wait(FLUSH_MS);
      if (watcherSignals - sigMark !== 1) sub.push(`(c 前置) ADD notify 后 watcher 指纹实变信号应恰 1 次（挂载+内容），实际 ${watcherSignals - sigMark}`);
      // (c) watcher 已增量挂载 P：④的变更可广播证明。
      const sig2 = watcherSignals;
      writeMcpJson(dirP, 'svc-p2');
      await wait(FLUSH_MS);
      if (watcherSignals - sig2 !== 1) sub.push(`(c) ADD 后外部改 P/.mcp.json 应广播 1 次（watcher 已挂载），实际 ${watcherSignals - sig2}`);
      if (unhandled.length !== 0) sub.push(`E3-01 期 unhandledRejection 应为 0，实际 ${unhandled.length}`);
    }
    check('①', 'E3-01 三效应合一：负缓存清（collect 读得新 server）+ 恰 1 次失效信号直发 + watcher 增量挂载（变更可感知）', sub.length === 0, sub.join('; '));
  }

  // ② E3-02：目录集第二目录同效 + 目录集外不受影响（条款2）。
  {
    const sub: string[] = [];
    if (!addHandler || !dirSet?.listRecentAndSessionProjectDirs) {
      sub.push('前置 seam 缺席（见 ⓪）');
    } else {
      // 前置夹具：目录 Q 经 E3-01 流程（ADD 落点）已监听在位。
      const qMark = watcherSignals;
      await addHandler(null, dirQ);
      await wait(FLUSH_MS);
      if (watcherSignals - qMark !== 1) sub.push(`前置：ADD(Q) 后 Q 挂载实变信号应恰 1 次，实际 ${watcherSignals - qMark}`);
      // ① dirR 经目录集增长路径（会话 distinct 工作目录加入=统一目录源扩集）进入集内。
      sessionDirsFixture.push(dirR);
      const unified = dirSet.listRecentAndSessionProjectDirs(20);
      if (!unified.some((d) => normalizeDirKey(d) === normalizeDirKey(dirR))) {
        sub.push(`前置：会话 distinct 注入后统一目录源应含 R，实际 ${JSON.stringify(unified)}`);
      }
      // 任一次指纹刷新即对齐挂载（01 §E3-1：syncMountedRoots 每轮差集增量挂载）——以用户级
      // 文件事件触发一次刷新（会话路径无专用事件锚=实现裁定，挂载靠下一次刷新对齐）。
      const sigMark = watcherSignals;
      fs.utimesSync(path.join(tmpHome, '.claude.json'), new Date(), new Date());
      await wait(FLUSH_MS);
      if (watcherSignals - sigMark !== 1) sub.push(`R 入集后刷新应恰 1 次实变信号（挂载+内容），实际 ${watcherSignals - sigMark}`);
      // ② R 加入后改 R/.mcp.json → 广播到达（挂载证明）。
      const sig2 = watcherSignals;
      writeMcpJson(dirR, 'svc-r2');
      await wait(FLUSH_MS);
      if (watcherSignals - sig2 !== 1) sub.push(`R 入集后改 R/.mcp.json 应广播 1 次（挂载对齐生效），实际 ${watcherSignals - sig2}`);
      // 对照：集外目录 S（从未进集）改动零广播。
      const sig3 = watcherSignals;
      writeMcpJson(dirS, 'svc-s2');
      await wait(FLUSH_MS);
      if (watcherSignals - sig3 !== 0) sub.push(`集外目录 S 改动不应广播，实际 ${watcherSignals - sig3}`);
    }
    check('②', 'E3-02 目录集增长路径同效（R 经会话 distinct 入集→刷新即挂载→变更可感知）+ 集外 S 零广播', sub.length === 0, sub.join('; '));
  }

  // ③ E3-04：REMOVE 收缩句柄（派发词明示）+ 广播不补发。
  {
    const sub: string[] = [];
    if (!removeHandler) {
      sub.push('前置 seam 缺席（见 ⓪）');
    } else {
      // 前置：E3-01 后目录 P 在集内且被监听（① 已证）；REMOVE 落点（P）。
      const sinkMark = broadcasts.length;
      const sigMark = watcherSignals;
      let rmErr = '';
      try { await removeHandler(null, dirP); } catch (e) { rmErr = e instanceof Error ? e.message : String(e); }
      if (rmErr) sub.push(`REMOVE handler 抛错：${rmErr}`);
      if (countSink('workspaces:changed', sinkMark) !== 1) sub.push(`REMOVE 既有 WORKSPACES_CHANGED 应仍恰 1 次，实际 ${countSink('workspaces:changed', sinkMark)}`);
      if (countSink('mcp:snapshotChanged', sinkMark) !== 0) sub.push(`REMOVE 落点不得补发失效信号（广播不补发），实际 ${countSink('mcp:snapshotChanged', sinkMark)}`);
      await wait(FLUSH_MS);
      // 收缩后 P 变更零广播（句柄已摘；notify 摘除时 P 条目退出指纹 → 1 条实变信号属摘除本身）。
      if (watcherSignals - sigMark !== 1) sub.push(`REMOVE notify 应恰 1 次实变信号（P 条目退出指纹=摘除证明），实际 ${watcherSignals - sigMark}`);
      const sig2 = watcherSignals;
      writeMcpJson(dirP, 'svc-p3');
      await wait(FLUSH_MS);
      if (watcherSignals - sig2 !== 0) sub.push(`REMOVE 后改 P/.mcp.json 不应广播（句柄已收缩），实际 ${watcherSignals - sig2}`);
      // 对照：改 Q 仍广播（他目录监听不受累）。
      const sig3 = watcherSignals;
      writeMcpJson(dirQ, 'svc-q2');
      await wait(FLUSH_MS);
      if (watcherSignals - sig3 !== 1) sub.push(`REMOVE 后他目录 Q 变更应仍广播（不受累），实际 ${watcherSignals - sig3}`);
    }
    check('③', 'E3-04 REMOVE 收缩句柄：P 变更零广播 + 广播不补发（mcp:snapshotChanged 恰 0）+ 他目录 Q 不受累', sub.length === 0, sub.join('; '));
  }

  // ④ E3-05：重复添加同目录幂等（派生边界·并发）。
  {
    const sub: string[] = [];
    if (!addHandler || !projectSkills?.badDirCacheHas) {
      sub.push('前置 seam 缺席（见 ⓪）');
    } else {
      const sinkMark = broadcasts.length;
      // 连续两次 WORKSPACE_ADD_RECENT(P)（E3-04 已移出，重加回）。
      try { await addHandler(null, dirP); await addHandler(null, dirP); } catch (e) { sub.push(`ADD 抛错：${e instanceof Error ? e.message : String(e)}`); }
      // 每次各直发 1 次失效信号（重复触发无害；渲染层重拉幂等）。
      const direct = countSink('mcp:snapshotChanged', sinkMark);
      if (direct !== 2) sub.push(`两次 ADD 应各直发 1 次失效信号（共 2），实际 ${direct}`);
      // 挂载幂等：改 P/.mcp.json 一次 → 广播恰 1 次（双 watch 会双计破坏去抖）。
      await wait(FLUSH_MS);
      const sig2 = watcherSignals;
      writeMcpJson(dirP, 'svc-p4');
      await wait(FLUSH_MS);
      if (watcherSignals - sig2 !== 1) sub.push(`重复 ADD 后改 P 一次应恰广播 1 次（挂载幂等），实际 ${watcherSignals - sig2}`);
      // 负缓存清除重复触发无害：清后不命中。
      if (projectSkills.badDirCacheHas?.(dirP)) sub.push('重复 ADD 后负缓存应未命中（清除幂等）');
      if (unhandled.length !== 0) sub.push(`E3-05 期 unhandledRejection 应为 0，实际 ${unhandled.length}`);
    }
    check('④', 'E3-05 重复添加同目录幂等：两次 ADD 信号各 1（无害）+ 单次变更恰 1 广播（挂载幂等）', sub.length === 0, sub.join('; '));
  }

  // ⑤ E3-06：添加不存在目录不崩（派生边界·异常；watcher 降级慢重试自愈）。
  {
    const sub: string[] = [];
    if (!addHandler) {
      sub.push('前置 seam 缺席（见 ⓪）');
    } else {
      const sinkMark = broadcasts.length;
      const sigMark = watcherSignals;
      let addErr = '';
      try { await addHandler(null, dirMissing); } catch (e) { addErr = e instanceof Error ? e.message : String(e); }
      if (addErr) sub.push(`对不存在目录 ADD 应不抛错，实际：${addErr}`);
      if (!wsHist?.listRecentWorkspaces?.().some((d) => normalizeDirKey(d) === normalizeDirKey(dirMissing))) {
        sub.push('不存在目录应照常入最近清单（主流程不被挂点打断）');
      }
      // 失效信号照发；负缓存清除对不存在目录为无害空操作（无断言面，无抛错即证）。
      if (countSink('mcp:snapshotChanged', sinkMark) !== 1) sub.push(`不存在目录 ADD 仍应直发 1 次失效信号，实际 ${countSink('mcp:snapshotChanged', sinkMark)}`);
      await wait(FLUSH_MS);
      if (watcherSignals - sigMark !== 1) sub.push(`不存在目录入集应为 missing 指纹实变信号 1 次，实际 ${watcherSignals - sigMark}`);
      if (unhandled.length !== 0) sub.push(`ADD 路径 unhandledRejection 应为 0，实际 ${unhandled.length}`);
      // watcher 走 E2-04 降级路径：pending 慢重试——目录从无到有后挂上（变更可感知）。
      writeMcpJson(dirMissing, 'svc-m');
      await wait(RETRY_MS * 6 + FLUSH_MS);
      const sig2 = watcherSignals;
      writeMcpJson(dirMissing, 'svc-m2');
      await wait(FLUSH_MS);
      if (watcherSignals - sig2 !== 1) sub.push('不存在目录慢重试自愈挂上后变更应可感知（降级不崩、不放弃）');
      if (unhandled.length !== 0) sub.push(`E3-06 期 unhandledRejection 应为 0，实际 ${unhandled.length}`);
    }
    check('⑤', 'E3-06 不存在目录不崩：主流程不断 + 失效信号照发 + 慢重试自愈挂上（E2-04 降级路径）', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组2 结构钉（E3-03 接线序 + project-skills 导出形态） ===');

  // ⑥ E3-03 接线序钉（条款3·结构）。
  {
    const handlers = readRel('src/main/ipc-handlers.ts');
    const skillsSrc = readRel('src/main/modules/project-skills.ts');
    const sub: string[] = [];
    if (!handlers) sub.push('src/main/ipc-handlers.ts 不存在');
    else {
      const addStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.WORKSPACE_ADD_RECENT');
      const addEnd = handlers.indexOf('regInvokeHandler(', addStart + 10);
      const addSeg = addStart > -1 && addEnd > addStart ? handlers.slice(addStart, addEnd) : '';
      if (!addSeg) sub.push('WORKSPACE_ADD_RECENT handler 切片定位失败');
      else {
        // 三连逐字锚（01 §E3-2 代码形态与注释逐字对照）。
        if (!addSeg.includes('badDirCacheClear(dir);')) sub.push('ADD handler 缺 badDirCacheClear(dir); 直发锚');
        if (!addSeg.includes('broadcastMcpSnapshotInvalidated();')) sub.push('ADD handler 缺 broadcastMcpSnapshotInvalidated(); 直发锚');
        if (!addSeg.includes('notifyMcpDirsChanged();')) sub.push('ADD handler 缺 notifyMcpDirsChanged(); 直发锚');
        if (!addSeg.includes('E3（2026-11-15 eight-issues）项目打开自动扫描挂点三连')) sub.push('ADD handler 缺 E3 三连注释原文（§E3-2 逐字对照）');
        // 发射序：addRecentWorkspace(dir) < WORKSPACES_CHANGED 发射 < 三连 < return list（同流程
        // 自主发射，不依赖渲染层二次触发；与 wiring ⑭ 既有钉衔接）。
        const iAdd = addSeg.indexOf('addRecentWorkspace(dir)');
        const iWs = addSeg.indexOf('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED');
        const iClear = addSeg.indexOf('badDirCacheClear(dir);');
        const iBcast = addSeg.indexOf('broadcastMcpSnapshotInvalidated();');
        const iNotify = addSeg.indexOf('notifyMcpDirsChanged();');
        const iReturn = addSeg.indexOf('return list;');
        if (!(iAdd > -1 && iWs > iAdd)) sub.push(`ADD handler 缺既有序 addRecentWorkspace(dir) < WORKSPACES_CHANGED 发射（${iAdd}/${iWs}）`);
        if (!(iClear > iWs && iBcast > iClear && iNotify > iBcast && iReturn > iNotify)) {
          sub.push(`三连序应为 WORKSPACES_CHANGED 发射 < badDirCacheClear(dir) < broadcastMcpSnapshotInvalidated() < notifyMcpDirsChanged() < return list（实际 ws@${iWs} clear@${iClear} bcast@${iBcast} notify@${iNotify} ret@${iReturn}）`);
        }
      }
      const rmStart = handlers.indexOf('regInvokeHandler(IPC_CHANNELS.WORKSPACE_REMOVE_RECENT');
      const rmEnd = handlers.indexOf('regInvokeHandler(', rmStart + 10);
      const rmSeg = rmStart > -1 && rmEnd > rmStart ? handlers.slice(rmStart, rmEnd) : '';
      if (!rmSeg) sub.push('WORKSPACE_REMOVE_RECENT handler 切片定位失败');
      else {
        const iRm = rmSeg.indexOf('removeRecentWorkspace(dir)');
        const iWs = rmSeg.indexOf('pushToMainWindow(IPC_CHANNELS.WORKSPACES_CHANGED');
        const iNotify = rmSeg.indexOf('notifyMcpDirsChanged();');
        if (!(iRm > -1 && iWs > iRm && iNotify > iWs)) {
          sub.push(`REMOVE 应仅追加 notifyMcpDirsChanged() 且位于 WORKSPACES_CHANGED 发射之后（实际 rm@${iRm} ws@${iWs} notify@${iNotify}）`);
        }
        if (rmSeg.includes('badDirCacheClear') || rmSeg.includes('broadcastMcpSnapshotInvalidated')) {
          sub.push('REMOVE 不得清负缓存/补发失效信号（广播不补发——移出清单无需重拉快照）');
        }
      }
      // import 区三导出锚。
      const impSkills = handlers.split(/\r?\n/).find((l) => l.includes("from './modules/project-skills'")) ?? '';
      if (!/badDirCacheClear/.test(impSkills)) sub.push(`ipc-handlers project-skills import 行缺 badDirCacheClear：${impSkills.trim()}`);
      const impSvc = handlers.split(/\r?\n/).find((l) => l.includes("from './modules/mcp/mcp-snapshot-service'")) ?? '';
      if (!/broadcastMcpSnapshotInvalidated/.test(impSvc)) sub.push(`ipc-handlers mcp-snapshot-service import 行缺 broadcastMcpSnapshotInvalidated：${impSvc.trim()}`);
      const impWatcher = handlers.split(/\r?\n/).find((l) => l.includes("from './modules/mcp/mcp-source-watcher'")) ?? '';
      if (!/notifyMcpDirsChanged/.test(impWatcher)) sub.push(`ipc-handlers mcp-source-watcher import 行缺 notifyMcpDirsChanged：${impWatcher.trim()}`);
    }
    // project-skills.ts badDirCacheClear 导出形态 + Skill 既有 mark/Has 语义一字不动。
    if (!skillsSrc) sub.push('src/main/modules/project-skills.ts 不存在');
    else {
      const s = norm(skillsSrc);
      if (!s.includes('export function badDirCacheClear(dir?: string): void')) {
        sub.push("project-skills 缺 export function badDirCacheClear(dir?: string): void");
      }
      const iClear = s.indexOf('export function badDirCacheClear');
      const clearBody = iClear > -1 ? s.slice(iClear, iClear + 400) : '';
      if (!clearBody.includes('badDirUntil.delete(normalizeDirKey(dir))')) sub.push('badDirCacheClear 带 dir 应删单键 badDirUntil.delete(normalizeDirKey(dir))');
      if (!clearBody.includes('badDirUntil.clear()')) sub.push('badDirCacheClear 无 dir 应清整表 badDirUntil.clear()');
      // Skill 既有 mark/Has 语义一字不动（badDirCacheMark/badDirCacheHas 函数体逐字锚）。
      if (!s.includes('export function badDirCacheMark(dir: string, now: number = Date.now()): void {\n  badDirUntil.set(normalizeDirKey(dir), now + BAD_DIR_TTL_MS);\n}')) {
        sub.push('badDirCacheMark 语义被改动（须一字不动：set(normalizeDirKey(dir), now + BAD_DIR_TTL_MS)）');
      }
      if (!s.includes('export function badDirCacheHas(dir: string, now: number = Date.now()): boolean {\n  const key = normalizeDirKey(dir);\n  const until = badDirUntil.get(key);\n  if (until === undefined) return false;\n  if (now >= until) {\n    badDirUntil.delete(key);\n    return false;\n  }\n  return true;\n}')) {
        sub.push('badDirCacheHas 语义被改动（须一字不动：惰性过期删除三段体）');
      }
    }
    check('⑥', 'E3-03 接线序钉：ADD 三连逐字锚+发射序（…WORKSPACES_CHANGED < clear < broadcast < notify < return）+ REMOVE 仅 notify + import 三锚 + badDirCacheClear 导出形态 + mark/Has 一字不动', sub.length === 0, sub.join('; '));
  }

  console.log('\n=== 组3 spawn 回归门 ===');

  // ⑦ spawn 回归门：wiring verify（⑭ ADD/REMOVE 发射序既有钉 + §11.2 键集对等）实跑 exit 0。
  {
    const r = spawnSync('npx', ['tsx', 'scripts/tdd-web-access-wiring-verify.ts'], {
      cwd: repoRoot, encoding: 'utf8', timeout: 180_000, shell: process.platform === 'win32',
    });
    const ok = r.status === 0;
    check('⑦', 'spawn 回归门：tdd-web-access-wiring-verify.ts exit 0（WORKSPACES_CHANGED 发射序既有钉 + 三处同步回归）',
      ok, ok ? '' : `exit=${String(r.status)} 输出尾部：${String(r.stdout || '').slice(-300)}${String(r.stderr || '').slice(-300)}`);
  }
} finally {
  watcher?.stopMcpSourceWatcher?.();
  pushBus?.setWebPushSink?.(null);
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
  try { fs.rmSync(tmpUserData, { recursive: true, force: true }); } catch { /* 尽力清理 */ }
}
}

function finish(): void {
  if (unhandled.length !== 0) {
    console.log(`\n⚠ unhandledRejection 共 ${unhandled.length} 条：${unhandled.map(String).join(' | ').slice(0, 500)}`);
    fail += 1;
  }
  console.log(`\n===== tdd-mcp-workspace-scan-hook-verify: ${pass} pass / ${fail} fail =====`);
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
