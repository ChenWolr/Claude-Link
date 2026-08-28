// command-source-watcher.ts
// 全局命令来源目录监视（计划 D3）：用户级 ~/.claude/{commands,skills} 与项目级
// <workingDirectory>/.claude/{commands,skills} 的新增/修改/删除 → 指纹变化 → 触发全局兜底命令
// 探测热刷新（globalFallback），让新会话（含暂态）在 app 运行中免重启拿到最新命令。
//
// 测试边界（与 sdk-command-registry 同模式）：本模块只 import node 内置模块，不 import
// electron / sdk-backend / config-manager / logger——app 依赖经 startCommandSourceWatcher(deps)
// 由 index.ts 注入；computeCommandRootsFingerprint / commandSourceRoots 供 selftest tsx 行为测试。
//
// 全局单例，无 per-session Map（规避 markSessionDeleted 收口登记义务）。

import { watch, readdirSync, type FSWatcher, type Dirent } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import * as path from 'node:path';

/** 指纹递归深度：与 sdk-command-origin 的 skill 树扫描一致（≤6），跳 symlink。 */
export const FINGERPRINT_MAX_DEPTH = 6;
/** 事件去抖：合并窗口内的高频变更（编辑器保存常连发多次事件）。 */
export const WATCHER_DEBOUNCE_MS = 1500;
/** 两次真实全局探测的最小间隔（节流；绝不轮询式 spawn）。 */
export const WATCHER_PROBE_MIN_INTERVAL_MS = 10_000;
/** watcher error 自愈：延迟重挂间隔与连续限次（超过放弃，等下一次 onConfigSaved/重启）。 */
export const WATCHER_REMOUNT_DELAY_MS = 5000;
export const WATCHER_REMOUNT_MAX_CONSECUTIVE = 3;

/**
 * 对每个根目录递归收集「文件」条目（path:mtimeMs:size），排序后 sha1。
 * 只含文件不含目录条目：文件内容修改反映在 mtime、新建/删除反映在条目集合，
 * 而单纯 touch 目录 mtime 不改变指纹（「无实质变化不 spawn」的判定依据）。
 * 目录不存在/不可读 → 该子树贡献空集（指纹仍确定）。roots 为空 → 空集指纹（常量）。
 */
export async function computeCommandRootsFingerprint(roots: string[]): Promise<string> {
  const entries: string[] = [];
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > FINGERPRINT_MAX_DEPTH) return;
    let dirents: Dirent[];
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const full = path.join(dir, d.name);
      let st;
      try {
        st = await fsp.lstat(full);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) continue; // 与证据扫描同口径：symlink 不进指纹不递归
      if (st.isFile()) entries.push(`${full}:${st.mtimeMs}:${st.size}`);
      else if (st.isDirectory()) await visit(full, depth + 1);
    }
  };
  for (const root of roots) await visit(root, 0);
  entries.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return createHash('sha1').update(entries.join('\n')).digest('hex');
}

/** watcher 的 app 依赖（index.ts 注入；注入边界即测试边界——本文件其余部分保持纯 node）。 */
export interface CommandSourceWatcherDeps {
  /**
   * 用户级根锚点：effectiveUserHome（经 buildSpawnEnv，advancedJson.env 可能覆盖
   * USERPROFILE/HOME；禁裸 homedir()）。取现值而非一次性解析，配置保存后重挂即生效。
   */
  getUserHome(): string | undefined;
  /** 项目级根锚点：getConfig().workingDirectory（全局默认工作目录）。 */
  getWorkingDirectory(): string | null;
  /** 触发全局兜底探测（包装 runGlobalCommandProbe(mainWindow)；幂等锁在 sdk-backend 内）。 */
  triggerGlobalProbe(): void;
  /** 配置保存订阅（onConfigSaved）：workingDirectory / advancedJson.env 变化 → 全量重挂。 */
  onConfigSaved(listener: () => void): () => void;
  logger: { info(message: string): void; warn(message: string): void };
}

export interface CommandSourceRoots {
  /** 用户级两根（D5 指纹只算这两根：用户级变更影响所有会话）。 */
  userRoots: string[];
  /** watch 与全根指纹目标 = 用户级 + 项目级。 */
  allRoots: string[];
}

/** 解析当前应 watch 的根目录（不存在的根由 mountRoot/指纹扫描各自容错跳过）。 */
export function commandSourceRoots(deps: CommandSourceWatcherDeps): CommandSourceRoots {
  const home = deps.getUserHome();
  const userRoots = home
    ? [path.join(home, '.claude', 'commands'), path.join(home, '.claude', 'skills')]
    : [];
  const cwd = deps.getWorkingDirectory();
  const projectRoots = cwd
    ? [path.join(cwd, '.claude', 'commands'), path.join(cwd, '.claude', 'skills')]
    : [];
  return { userRoots, allRoots: [...userRoots, ...projectRoots] };
}

interface CommandSourceWatcherState {
  watchers: FSWatcher[];
  /** 全根上次指纹；null = 尚未算过（首个刷新只建立基准，不触发探测）。 */
  fingerprint: string | null;
  /** 用户级两根指纹（D5 写 per-session 快照附带）；undefined = 尚未算出（字段缺省不比对）。 */
  userFingerprint: string | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  remountTimer: ReturnType<typeof setTimeout> | null;
  lastProbeStartedAt: number;
  probeQueued: boolean;
  /** 连续 error 重挂计数；一次「安静刷新周期」（挂载后至刷新完成无新 error）证明健康即清零。 */
  consecutiveErrors: number;
  hadErrorSinceMount: boolean;
  stopped: boolean;
  unsubscribeConfigSaved: (() => void) | null;
}

let state: CommandSourceWatcherState | null = null;

/** watcher 是否在跑（观测用；stop 后为 false，重复 start 幂等跳过）。 */
export function isCommandSourceWatcherRunning(): boolean {
  return state !== null;
}

/**
 * D5 消费口：当前用户级出生指纹。watcher 未启动/未算出时返回 undefined——
 * registry.replace 调用方据此缺省字段，COMMANDS_GET 不做指纹比对（不误标 stale）。
 */
export function getUserOriginFingerprint(): string | undefined {
  return state?.userFingerprint;
}

/** 启动全局命令来源监视（全局单例；重复调用幂等跳过）。 */
export function startCommandSourceWatcher(deps: CommandSourceWatcherDeps): void {
  if (state) return;
  state = {
    watchers: [],
    fingerprint: null,
    userFingerprint: undefined,
    debounceTimer: null,
    remountTimer: null,
    lastProbeStartedAt: 0,
    probeQueued: false,
    consecutiveErrors: 0,
    hadErrorSinceMount: false,
    stopped: false,
    unsubscribeConfigSaved: null,
  };
  // 配置保存（含 workingDirectory 与 advancedJson.env 变化）→ 全量重挂 + 重算指纹。
  // 全量而非只重挂项目侧：advancedJson.env 覆盖 USERPROFILE/HOME 时用户级根也随之漂移。
  state.unsubscribeConfigSaved = deps.onConfigSaved(() => handleConfigSaved(deps));
  mountAll(deps);
  // 启动基准指纹（异步）：完成前 userFingerprint 为 undefined → D5 不比对；首个刷新只建基准不探测
  // （启动探测由 index.ts 的 runGlobalCommandProbe 负责，watcher 不重复 spawn）。
  void refreshFingerprints(deps);
  deps.logger.info('[command-source-watcher] 已启动命令来源目录监视');
}

/** 停止并清理（before-quit / window-all-closed 调用；幂等）。 */
export function stopCommandSourceWatcher(): void {
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
  s.unsubscribeConfigSaved?.();
  closeWatchers(s);
  state = null;
}

function closeWatchers(s: CommandSourceWatcherState): void {
  for (const w of s.watchers) {
    try {
      w.close();
    } catch {
      // ignore：句柄可能已失效
    }
  }
  s.watchers = [];
}

function handleConfigSaved(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  // 配置保存给了新的重挂机会：清零连续错误计数（对应「超过限次等 onConfigSaved/重启」的恢复路径）。
  s.consecutiveErrors = 0;
  s.hadErrorSinceMount = false;
  mountAll(deps);
  void refreshFingerprints(deps);
}

function mountAll(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  closeWatchers(s);
  s.hadErrorSinceMount = false;
  const { allRoots } = commandSourceRoots(deps);
  for (const root of allRoots) mountRoot(root, deps);
}

function mountRoot(root: string, deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const onEvent = (): void => scheduleRefresh(deps);
  try {
    // 首选递归 watch（Windows/Linux 支持良好）。
    const w = watch(root, { recursive: true }, onEvent);
    w.on('error', (err) => handleWatcherError(root, deps, err));
    s.watchers.push(w);
    return;
  } catch {
    // 降级：平台不支持 recursive 时退化为「本目录非递归 + 每根一层子目录」
    // （§4.4 防御性写法；本产品当前主战场 win32，正常走不到）。
  }
  try {
    const w = watch(root, onEvent);
    w.on('error', (err) => handleWatcherError(root, deps, err));
    s.watchers.push(w);
  } catch {
    // 目录不存在等：记录待重挂（onConfigSaved / 下次 mountAll 重试），不阻塞其它根。
    return;
  }
  let children: Dirent[];
  try {
    children = readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of children) {
    if (!d.isDirectory() || d.isSymbolicLink()) continue;
    try {
      const cw = watch(path.join(root, d.name), onEvent);
      cw.on('error', (err) => handleWatcherError(path.join(root, d.name), deps, err));
      s.watchers.push(cw);
    } catch {
      // 单个子目录挂载失败不阻塞其它根。
    }
  }
}

function handleWatcherError(root: string, deps: CommandSourceWatcherDeps, err: unknown): void {
  const s = state;
  if (!s || s.stopped) return;
  deps.logger.warn(`[command-source-watcher] watch 错误（${root}）：${err instanceof Error ? err.message : String(err)}`);
  s.hadErrorSinceMount = true;
  s.consecutiveErrors += 1;
  // 单根 error 后句柄状态不可信：全量关闭整体重挂（延迟 5s，限连续 3 次）。
  closeWatchers(s);
  if (s.consecutiveErrors > WATCHER_REMOUNT_MAX_CONSECUTIVE) {
    deps.logger.warn('[command-source-watcher] 连续重挂失败超限，放弃自动重挂（等下一次配置保存或重启）。');
    return;
  }
  if (s.remountTimer) return; // 已有重挂排队
  s.remountTimer = setTimeout(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    cur.remountTimer = null;
    mountAll(deps);
    void refreshFingerprints(deps);
  }, WATCHER_REMOUNT_DELAY_MS);
  if (s.remountTimer && typeof s.remountTimer.unref === 'function') s.remountTimer.unref();
}

function scheduleRefresh(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  if (s.debounceTimer) return; // 单 timer 合并：窗口内的后续事件全部并入本次刷新
  s.debounceTimer = setTimeout(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    cur.debounceTimer = null;
    void refreshFingerprints(deps);
  }, WATCHER_DEBOUNCE_MS);
  if (s.debounceTimer && typeof s.debounceTimer.unref === 'function') s.debounceTimer.unref();
}

async function refreshFingerprints(deps: CommandSourceWatcherDeps): Promise<void> {
  const s = state;
  if (!s || s.stopped) return;
  const { userRoots, allRoots } = commandSourceRoots(deps);
  const [allFp, userFp] = await Promise.all([
    computeCommandRootsFingerprint(allRoots),
    computeCommandRootsFingerprint(userRoots),
  ]);
  const cur = state;
  if (!cur || cur.stopped) return;
  cur.userFingerprint = userFp;
  // 「安静刷新周期」证明挂载健康：清零连续错误计数（无限重挂循环的破除条件）。
  if (!cur.hadErrorSinceMount) cur.consecutiveErrors = 0;
  const isFirstBaseline = cur.fingerprint === null;
  if (!isFirstBaseline && cur.fingerprint === allFp) return; // 无实质变化：不 spawn
  cur.fingerprint = allFp;
  if (isFirstBaseline) return; // 基准指纹不触发探测（启动探测由 index.ts 负责）
  queueProbe(deps);
}

/** 指纹已变化 → 节流触发全局探测（10s 最小间隔；窗口内重复变化合并为到期后一次）。 */
function queueProbe(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const now = Date.now();
  const wait = s.lastProbeStartedAt + WATCHER_PROBE_MIN_INTERVAL_MS - now;
  if (wait > 0) {
    if (s.probeQueued) return; // 已有排队：到期按最新指纹探测一次
    s.probeQueued = true;
    const t = setTimeout(() => {
      const cur = state;
      if (!cur || cur.stopped) return;
      cur.probeQueued = false;
      cur.lastProbeStartedAt = Date.now();
      deps.triggerGlobalProbe();
    }, wait);
    if (t && typeof t.unref === 'function') t.unref();
    return;
  }
  s.lastProbeStartedAt = now;
  deps.triggerGlobalProbe();
}
