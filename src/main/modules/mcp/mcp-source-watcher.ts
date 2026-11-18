// mcp-source-watcher.ts
// E2（2026-11-15 eight-issues）MCP 配置外部变更 watcher：监听用户级 ~/.claude.json（文件粒度）
// 与项目目录集内每目录（目录粒度，非递归——.mcp.json 在目录根，create/modify/delete/rename 全
// 可捕；根内其他文件事件由指纹过滤不广播），磁盘变更经 1.5s 去抖合并 + 指纹比对，内容实变才
// 触发 deps.onMcpSnapshotInvalidated()（E2 失效信号广播源；渲染层拉取式重拉）。挂载失败降级与
// 慢重试对齐 command-source-watcher 既有模式语义：挂载时目标不存在 → pending 慢重试（30s）直至
// 挂上（不崩不放弃）；已挂载句柄连续 error → 5s 全量重挂 ×3 → 转 30s 慢重试循环。
//
// 指纹口径（内容哈希——偏离 01 §E2-3 伪代码 mtimeMs:size 的申报点）：行为契约 #4 是「磁盘内容
// 未实际变化不广播」，而 mtime 指纹在同内容回写/编辑器 touch（mtime 抖动、内容不变）时必然
// 实变 → 假广播，与用例 E2-07 硬期望（同内容覆写 + 重复 touch → 广播零次）直接冲突；按
// 03-test-cases-main.md §5 E2-10 预留的「指纹按内容/按解析态的口径实现后回填」口子取内容
// sha1——「内容未实变不广播」由内容哈希逐字成立。missing/unreadable 为确定性态：stat 失败
// （含 ENOENT）→ ':missing'（删除也变指纹，E2-10 硬期望）；stat 成功但读失败 → ':unreadable'。
// 同毫秒写回边界（01 §E2-5）：内容哈希口径下同毫秒写回按内容正确判定，原「允许陈旧一拍」不再
// 适用（更严格，无回归面）。
//
// 测试边界（command-source-watcher 同款）：本模块只 import node 内置模块，不 import electron /
// sdk-backend / config-manager / push-bus / workspace-history——app 依赖经 startMcpSourceWatcher(deps)
// 由 index.ts 注入；mcpWatchTargets / computeMcpConfigFingerprint / 注入 debounceMs、pendingRetryMs
// 供契约脚本（tdd-mcp-external-change-watch-verify.ts）tsx 行为测试。
//
// 全局单例，无 per-session Map（规避 markSessionDeleted 收口登记义务；E2-S2 生命周期钉）。

import { watch, statSync, readFileSync, type FSWatcher, type Stats } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** 事件去抖：合并窗口内的高频变更（编辑器保存/原子写常连发多次事件）。 */
export const MCP_WATCHER_DEBOUNCE_MS = 1500;
/** watcher error 自愈：延迟重挂间隔与连续限次（超限转入 MCP_WATCHER_PENDING_RETRY_MS 慢重试循环直至挂上）。 */
export const MCP_WATCHER_REMOUNT_DELAY_MS = 5000;
export const MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE = 3;
/** 挂载失败待重挂目标的兜底重试周期（目标从无到有盲区；对齐 WATCHER_PENDING_ROOT_RETRY_MS）。 */
export const MCP_WATCHER_PENDING_RETRY_MS = 30_000;

/** 单个监听目标：kind='file'（用户级 ~/.claude.json，文件粒度）| kind='dir'（项目目录，目录粒度）。 */
export interface McpWatchTarget {
  path: string;
  kind: 'file' | 'dir';
}

/** watcher 的 app 依赖（index.ts 注入；注入边界即测试边界——本文件其余部分保持纯 node）。 */
export interface McpSourceWatcherDeps {
  /**
   * 用户级根锚点：effectiveUserHome（advancedJson.env 可能覆盖 USERPROFILE/HOME；禁裸 homedir()）。
   * 取现值而非一次性解析，配置变更后经 refreshFingerprints→mcpWatchTargets 重解析即生效。
   */
  getUserHome(): string | undefined;
  /** 项目级目标锚点：E4 统一目录集 ∪ 默认目录（index.ts 注入，getProjectSkillDirs 同款 concat 尾巴形态）。 */
  getProjectDirs(): string[];
  /**
   * 指纹实变回调（每次实变至多一条信号——去抖合并后；首拍建基准不触发）。
   * index.ts 注入 broadcastMcpSnapshotInvalidated（mcp:snapshotChanged 空载荷广播；E3 WORKSPACE_
   * ADD_RECENT 锚点复用同款信号）。
   */
  onMcpSnapshotInvalidated(): void;
  logger: { info(message: string): void; warn(message: string): void };
  /** 待重挂目标的兜底重试周期（ms）；缺省 MCP_WATCHER_PENDING_RETRY_MS。测试可注入更短周期。 */
  pendingRetryMs?: number;
  /** 事件去抖窗口（ms）；缺省 MCP_WATCHER_DEBOUNCE_MS。测试可注入更短窗口。 */
  debounceMs?: number;
}

/**
 * 解析当前应 watch 的目标（01 §E2-3 watchTargets 伪代码逐字对照）：
 * [ { path: join(home, '.claude.json'), kind: 'file' } ] ∪ deps.getProjectDirs().map(d => ({ path: d, kind: 'dir' }))。
 * 用户级目标与目录集彼此按小写键去重（同根双 watch 事件翻倍；大小写归一与 command watcher
 * 同口径，win32 不敏感）；空串目录跳过。
 */
export function mcpWatchTargets(deps: McpSourceWatcherDeps): McpWatchTarget[] {
  const home = deps.getUserHome();
  const targets: McpWatchTarget[] = home ? [{ path: path.join(home, '.claude.json'), kind: 'file' }] : [];
  const seen = new Set(targets.map((t) => t.path.toLowerCase()));
  for (const dir of deps.getProjectDirs()) {
    if (typeof dir !== 'string' || dir === '') continue;
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ path: dir, kind: 'dir' });
  }
  return targets;
}

/** 指纹对象：file → 本文件；dir → <dir>/.mcp.json（01 §E2-3「dir → join(dir,'.mcp.json')」）。 */
function fingerprintObjectOf(t: McpWatchTarget): string {
  return t.kind === 'file' ? t.path : path.join(t.path, '.mcp.json');
}

/**
 * stat 短路缓存（M-A，2026-11-17 eight-issues round-002）：指纹对象 → 上次全文读时的
 * (size, mtimeMs) 二元组 + 内容 sha1。指纹刷新高频（每次去抖后/目录集变更/慢重试挂上/重挂），
 * 用户级 ~/.claude.json 每轮全文读开销大——stat 二元组与上次相同则跳过全文读、复用上次哈希
 * （内容哈希口径判定结果不变：二元组变 → 照旧全文读重哈希；同 size+mtime 变内容属该口径的
 * 固有盲区，接受）。任何非正常路径（missing/非文件/unreadable）清该对象缓存条目——删除与
 * 恢复必走全文读，不留陈旧短路（:missing 语义保持）。
 */
interface McpFingerprintStatCache {
  size: number;
  mtimeMs: number;
  sha1: string;
}
const fingerprintStatCache = new Map<string, McpFingerprintStatCache>();

/**
 * 单目标指纹条目：`${指纹对象}:${内容 sha1}`；stat 失败 → `${指纹对象}:missing`（删除也变指纹）；
 * stat 成功但读失败 → `${指纹对象}:unreadable`（确定性态，恢复后随内容回正常条目）。
 */
function fingerprintEntry(t: McpWatchTarget): string {
  const obj = fingerprintObjectOf(t);
  let st: Stats;
  try {
    st = statSync(obj);
  } catch {
    fingerprintStatCache.delete(obj);
    return `${obj}:missing`;
  }
  if (!st.isFile()) {
    fingerprintStatCache.delete(obj); // 指纹对象被目录等占据（异常形态）：按 missing 稳定态
    return `${obj}:missing`;
  }
  // stat 短路：二元组未变 → 内容未变（该口径固有假设），跳过全文读复用上次哈希。
  const cached = fingerprintStatCache.get(obj);
  if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return `${obj}:${cached.sha1}`;
  let text: string;
  try {
    text = readFileSync(obj, 'utf8');
  } catch {
    fingerprintStatCache.delete(obj);
    return `${obj}:unreadable`;
  }
  const sha1 = createHash('sha1').update(text).digest('hex');
  fingerprintStatCache.set(obj, { size: st.size, mtimeMs: st.mtimeMs, sha1 });
  return `${obj}:${sha1}`;
}

/** 全目标指纹：条目排序后 sha1（与 command watcher 指纹同构；内容哈希口径见文件头申报）。 */
export function computeMcpConfigFingerprint(targets: McpWatchTarget[]): string {
  const entries = targets.map(fingerprintEntry).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  // stat 短路缓存对齐当前目标集：目录集收缩后已摘除目标的缓存条目不再保留（防无界增长）。
  if (fingerprintStatCache.size > targets.length) {
    const live = new Set(targets.map(fingerprintObjectOf));
    for (const key of [...fingerprintStatCache.keys()]) {
      if (!live.has(key)) fingerprintStatCache.delete(key);
    }
  }
  return createHash('sha1').update(entries.join('\n')).digest('hex');
}

interface McpSourceWatcherState {
  deps: McpSourceWatcherDeps;
  /** 按目标登记的已挂载句柄（key=目标小写路径；差集增量挂载/摘除的比对前提）。 */
  mountedRoots: Map<string, FSWatcher[]>;
  /** 全目标上次指纹；null = 尚未算过（首拍只建基准，不触发信号）。 */
  fingerprint: string | null;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  remountTimer: ReturnType<typeof setTimeout> | null;
  /** 挂载失败待重挂目标（key=目标小写路径 → 原目标；从无到有盲区的低频兜底重试直至挂上）。 */
  pendingRoots: Map<string, McpWatchTarget>;
  /** 待重挂低频重试循环（pendingRoots 非空时运行）。 */
  pendingRetryTimer: ReturnType<typeof setInterval> | null;
  /** 连续 error 重挂计数；一次「安静刷新周期」（挂载后至刷新完成无新 error）证明健康即清零。 */
  consecutiveErrors: number;
  hadErrorSinceMount: boolean;
  stopped: boolean;
}

let state: McpSourceWatcherState | null = null;
// hb10-CMD-V03 同构：单调序号——并发 refresh 仅最新完成者写基线（乱序旧结果不覆盖新基线）。
let refreshSeq = 0;

/** watcher 是否在跑（观测用；stop 后为 false，重复 start 幂等跳过）。 */
export function isMcpSourceWatcherRunning(): boolean {
  return state !== null;
}

/** 启动 MCP 配置变更监视（全局单例幂等；重复调用跳过——E2-S2 主进程级单例，不随会话挂卸）。 */
export function startMcpSourceWatcher(deps: McpSourceWatcherDeps): void {
  if (state) return;
  state = {
    deps,
    mountedRoots: new Map<string, FSWatcher[]>(),
    fingerprint: null,
    debounceTimer: null,
    remountTimer: null,
    pendingRoots: new Map<string, McpWatchTarget>(),
    pendingRetryTimer: null,
    consecutiveErrors: 0,
    hadErrorSinceMount: false,
    stopped: false,
  };
  mountAll(deps);
  // 首拍建基准（同步指纹）：完成前 fingerprint 为 null → 首轮只建基准不广播（启动预热由
  // index.ts void warmMcpSnapshot() 负责，watcher 不重复收集）。
  refreshFingerprints(deps);
  deps.logger.info('[mcp-source-watcher] 已启动 MCP 配置变更监视');
}

/** 停止并清理（window-all-closed 调用；幂等）。 */
export function stopMcpSourceWatcher(): void {
  const s = state;
  if (!s) return;
  s.stopped = true;
  if (s.debounceTimer) {
    clearTimeout(s.debounceTimer);
    s.debounceTimer = null;
  }
  if (s.remountTimer) {
    clearTimeout(s.remountTimer);
    s.remountTimer = null;
  }
  if (s.pendingRetryTimer) {
    clearInterval(s.pendingRetryTimer);
    s.pendingRetryTimer = null;
  }
  closeWatchers(s);
  state = null;
}

/**
 * E3 锚点（01 §E2-3 notifyMcpDirsChanged 伪代码逐字对照）：目录集变化（WORKSPACE_ADD_RECENT
 * 落点等）通知重算——未启动 no-op；已启动 → refreshFingerprints（内部 syncMountedRoots 增量
 * 挂载/摘除 + 重算指纹）。R5-3（round-005 注释如实化，行为级探针实证）：目录集条目实际增删
 * （无论新目录是否带 .mcp.json——指纹条目含 :missing 确定态，新增目录即使无 .mcp.json 也以
 * `…:missing` 新条目进指纹，删除目录则摘条目）→ 指纹实变 → 广播恰 1 次失效信号；带 .mcp.json
 * 的新目录其内容后续变更再广播。同目录集重复通知指纹不变、不广播（幂等无害，00 契约未违反）。
 */
export function notifyMcpDirsChanged(): void {
  const s = state;
  if (!s || s.stopped) return;
  refreshFingerprints(s.deps);
}

function closeWatchers(s: McpSourceWatcherState): void {
  for (const ws of s.mountedRoots.values()) {
    for (const w of ws) {
      try {
        w.close();
      } catch {
        // ignore：句柄可能已失效
      }
    }
  }
  s.mountedRoots.clear();
}

function mountAll(deps: McpSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  closeWatchers(s);
  s.pendingRoots.clear(); // 全量重挂即全新登记，陈旧 pending 目标不再空转（hb10-CMD-05 同构）
  s.hadErrorSinceMount = false;
  for (const t of mcpWatchTargets(deps)) mountRoot(t, deps);
}

function mountRoot(t: McpWatchTarget, deps: McpSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const key = t.path.toLowerCase();
  const onEvent = (): void => scheduleRefresh(deps);
  // 挂载成功即从待重挂集合移除（mountAll/兜底重试共用同一登记口径）。
  const mounted = (w: FSWatcher): void => {
    w.on('error', (err) => handleWatcherError(t, deps, err));
    const list = s.mountedRoots.get(key);
    if (list) list.push(w);
    else s.mountedRoots.set(key, [w]);
    if (s.pendingRoots.delete(key) && s.pendingRoots.size === 0 && s.pendingRetryTimer) {
      clearInterval(s.pendingRetryTimer);
      s.pendingRetryTimer = null;
    }
  };
  // file 与 dir 同 API（01 §E2-3）；dir 非递归：.mcp.json 在目录根，create/modify/delete/rename
  // 全可捕，根内其他文件事件由指纹过滤（不广播）。
  try {
    mounted(watch(t.path, onEvent));
    return;
  } catch {
    // 目标不存在等（ENOENT）：登记待重挂，由低频兜底重试（从无到有后挂上），不阻塞其它目标、
    // 不打日志（噪音水位对齐 command watcher：挂载失败静默 pending，仅 error 事件 warn）。
    s.pendingRoots.set(key, t);
    ensurePendingRetryLoop(deps);
  }
}

/** 待重挂目标的低频兜底重试：挂上后从 pending 移除并重算指纹（新目录已有 .mcp.json → 指纹变化 → 正常广播）。 */
function ensurePendingRetryLoop(deps: McpSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped || s.pendingRetryTimer || s.pendingRoots.size === 0) return;
  const intervalMs = Math.max(20, deps.pendingRetryMs ?? MCP_WATCHER_PENDING_RETRY_MS);
  s.pendingRetryTimer = setInterval(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    const before = cur.pendingRoots.size;
    for (const target of [...cur.pendingRoots.values()]) {
      mountRoot(target, cur.deps);
    }
    // 有目标在重试中挂上 → 状态已变（从无到有），重算指纹；无实质变化时该调用只更新基准不广播。
    const after = state;
    if (after && after.pendingRoots.size < before) {
      // hb13-v B11 同构：有目标在慢循环中重新挂上 = 恢复挂载成功——复位 hadErrorSinceMount，
      // 让本次安静刷新可以把 consecutiveErrors 归零，恢复快/慢模式流转。
      after.hadErrorSinceMount = false;
      refreshFingerprints(after.deps);
    }
  }, intervalMs);
  if (s.pendingRetryTimer && typeof s.pendingRetryTimer.unref === 'function') s.pendingRetryTimer.unref();
}

function handleWatcherError(t: McpWatchTarget, deps: McpSourceWatcherDeps, err: unknown): void {
  const s = state;
  if (!s || s.stopped) return;
  deps.logger.warn(`[mcp-source-watcher] watch 错误（${t.path}）：${err instanceof Error ? err.message : String(err)}`);
  s.hadErrorSinceMount = true;
  s.consecutiveErrors += 1;
  // 单目标 error 后句柄状态不可信：全量关闭整体重挂（延迟 5s，限连续 3 次；command watcher 同构）。
  closeWatchers(s);
  if (s.consecutiveErrors > MCP_WATCHER_REMOUNT_MAX_CONSECUTIVE) {
    // 超限不再永久放弃——登记全部目标进 pending 慢重试循环（30s），错误风暴后仍可自愈。
    for (const target of mcpWatchTargets(deps)) s.pendingRoots.set(target.path.toLowerCase(), target);
    ensurePendingRetryLoop(deps);
    return;
  }
  if (s.remountTimer) return; // 已有重挂排队
  s.remountTimer = setTimeout(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    cur.remountTimer = null;
    mountAll(cur.deps);
    refreshFingerprints(cur.deps);
  }, MCP_WATCHER_REMOUNT_DELAY_MS);
  if (s.remountTimer && typeof s.remountTimer.unref === 'function') s.remountTimer.unref();
}

function scheduleRefresh(deps: McpSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  if (s.debounceTimer) return; // 单 timer 合并：窗口内的后续事件全部并入本次刷新
  s.debounceTimer = setTimeout(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    cur.debounceTimer = null;
    refreshFingerprints(cur.deps);
  }, Math.max(0, deps.debounceMs ?? MCP_WATCHER_DEBOUNCE_MS));
  if (s.debounceTimer && typeof s.debounceTimer.unref === 'function') s.debounceTimer.unref();
}

/**
 * P2-D 同构（command watcher UI13 批评审产物）：挂载对齐本次 targets——差集增量挂载/摘除。
 * refreshFingerprints 每轮先经本函数对齐：目录集动态增长（新项目首次使用进清单）即挂上；
 * 已消失目标整根摘除，pending 登记一并撤销（清单已不含该目标，慢重试对其无意义）。
 * 前置约束：调用点与本函数全程同步执行（JS 单线程，无两次差集互踩）；pendingRoots 已登记的
 * 目标归慢重试循环管，此处按小写同键跳过，避免同目标双 watch。
 */
function syncMountedRoots(deps: McpSourceWatcherDeps, targets: McpWatchTarget[]): void {
  const s = state;
  if (!s || s.stopped) return;
  const currentKeys = new Set(targets.map((t) => t.path.toLowerCase()));
  // 已消失目标：关闭句柄并摘除登记。
  for (const [key, ws] of [...s.mountedRoots]) {
    if (currentKeys.has(key)) continue;
    for (const w of ws) {
      try {
        w.close();
      } catch {
        // ignore：句柄可能已失效
      }
    }
    s.mountedRoots.delete(key);
  }
  // 已消失目标若尚在 pending 慢重试，一并撤销；清空后停掉低频循环（登记口径与 mountAll 对齐）。
  for (const key of [...s.pendingRoots.keys()]) {
    if (!currentKeys.has(key)) s.pendingRoots.delete(key);
  }
  if (s.pendingRoots.size === 0 && s.pendingRetryTimer) {
    clearInterval(s.pendingRetryTimer);
    s.pendingRetryTimer = null;
  }
  // 新增目标：增量挂载（已挂/已在 pending 的目标跳过——pending 归慢重试循环，避免双 watch）。
  const pendingKeys = new Set(s.pendingRoots.keys());
  for (const t of targets) {
    const key = t.path.toLowerCase();
    if (s.mountedRoots.has(key) || pendingKeys.has(key)) continue;
    mountRoot(t, deps);
  }
}

/**
 * 指纹刷新（01 §E2-3 refreshFingerprints 伪代码逐字对照；hb10-CMD-V03 seq 守卫同构）：
 * ① targets 重解析（含用户级根取现值）→ ② syncMountedRoots 差集挂载对齐（指纹计算前同步完成，
 * 不引入 await 窗口）→ ③ 全目标指纹 → ④ 首拍只建基准；fp 与基准相同 → return（磁盘内容未实际
 * 变化不广播，契约 #4）；基准更新 → deps.onMcpSnapshotInvalidated()（每次实变至多一条信号）。
 * 全程同步（小配置文件 stat+read，量级 = 目录数），无并发窗口；seq 守卫保留同形结构防漂移。
 */
function refreshFingerprints(deps: McpSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const mySeq = ++refreshSeq;
  const targets = mcpWatchTargets(deps);
  syncMountedRoots(deps, targets);
  const fp = computeMcpConfigFingerprint(targets);
  const cur = state;
  if (!cur || cur.stopped) return;
  if (mySeq !== refreshSeq) return; // hb10-CMD-V03：已有更新一轮完成，本轮结果作废
  // 「安静刷新周期」证明挂载健康：清零连续错误计数（无限重挂循环的破除条件）。
  if (!cur.hadErrorSinceMount) cur.consecutiveErrors = 0;
  const isFirstBaseline = cur.fingerprint === null;
  if (!isFirstBaseline && cur.fingerprint === fp) return; // 内容未实际变化：不广播（契约 #4）
  cur.fingerprint = fp;
  if (isFirstBaseline) return; // 首拍只建基准（预热由 index.ts 负责，watcher 不重复收集）
  deps.onMcpSnapshotInvalidated();
}
