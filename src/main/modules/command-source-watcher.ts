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
/** watcher error 自愈：延迟重挂间隔与连续限次（超限不再放弃，转入 WATCHER_PENDING_ROOT_RETRY_MS 慢重试循环直至挂上；onConfigSaved 仍会清零计数给新机会）。 */
export const WATCHER_REMOUNT_DELAY_MS = 5000;
export const WATCHER_REMOUNT_MAX_CONSECUTIVE = 3;
/** 待重挂根（挂载时目录尚不存在等）的兜底重试周期（review-v1 发现2：目录从无到有盲区）。 */
export const WATCHER_PENDING_ROOT_RETRY_MS = 30_000;

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
  /**
   * UI13-P8：项目 skill 目录清单（最近工作区 ∪ 会话 distinct 工作目录 ∪ 默认目录；
   * index.ts 注入，与 SKILL_PROJECT_DIRS_GET 同源口径）。清单内每目录的 .claude/skills
   * 追加监听——只加 skills 不加 commands（契约 #4 只要求 skills；命令侧项目监听维持现状
   * 仅默认目录）。缺省（旧 deps 形态 / 行为测试）→ 不追加，行为与现状一致。
   */
  getProjectSkillDirs?(): string[];
  /**
   * UI13-P8：项目 skill 目录变化广播联动（queueProbe 处调用——指纹已确认变化）。
   * index.ts 注入为 skills:projectDirsChanged 推送（渲染层 Skill tab 活跃时重拉项目清单）。
   * 广播不受 skillAutoSync 门控（R7 裁决：项目清单 fs 重拉 ≠ 引擎重探；重探门控在
   * triggerGlobalProbe 注入侧既有早退）。
   */
  onProjectSkillsChanged?(): void;
  /**
   * 触发全局兜底探测（包装 runGlobalCommandProbe(mainWindow)）。
   * 返回 true = 本次真正启动；false = 已有探测在跑被幂等锁吞掉——watcher 据此延迟重试，
   * 否则该次磁盘变更永久丢失（review-v1 发现1：指纹已更新为最新，后续无新事件不再比对）。
   */
  triggerGlobalProbe(): boolean;
  /** 配置保存订阅（onConfigSaved）：workingDirectory / advancedJson.env 变化 → 全量重挂。 */
  onConfigSaved(listener: () => void): () => void;
  logger: { info(message: string): void; warn(message: string): void };
  /** 待重挂根的兜底重试周期（ms）；缺省 WATCHER_PENDING_ROOT_RETRY_MS。测试可注入更短周期。 */
  pendingRetryMs?: number;
}

export interface CommandSourceRoots {
  /** 用户级两根（D5 指纹只算这两根：用户级变更影响所有会话）。 */
  userRoots: string[];
  /** UI13-P8：清单内每目录的 .claude/skills（不含 commands；与既有根同键去重后追加）。 */
  projectSkillRoots: string[];
  /** watch 与全根指纹目标 = 用户级 + 项目级 + 项目 skills（清单内 skills 变化一并改变全根指纹）。 */
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
  // UI13-P8（契约 #4）：项目目录清单内每目录的 .claude/skills 追加监听（只加 skills 不加
  // commands）。与既有根（及清单内彼此）按小写同键去重——默认目录既经 getWorkingDirectory
  // 产出 skills 根、又常在清单内，不去重会同根双 watch（事件翻倍）。目录不存在的根由
  // mountRoot pendingRoots 慢重试兜底；清单新增根由 refreshFingerprints→syncMountedRoots
  // 增量挂载（P2-D：mountAll 仅启动/onConfigSaved/错误重挂三处触发，覆盖不到清单增长）。
  const seenKeys = new Set([...userRoots, ...projectRoots].map((r) => r.toLowerCase()));
  const projectSkillRoots: string[] = [];
  for (const dir of deps.getProjectSkillDirs?.() ?? []) {
    const root = path.join(dir, '.claude', 'skills');
    const key = root.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    projectSkillRoots.push(root);
  }
  return { userRoots, projectSkillRoots, allRoots: [...userRoots, ...projectRoots, ...projectSkillRoots] };
}

interface CommandSourceWatcherState {
  /** 按根登记的已挂载句柄（key=根小写；P2-D 增量挂载的「本次 roots vs 已挂载」差集比对前提）。 */
  mountedRoots: Map<string, FSWatcher[]>;
  /** 全根上次指纹；null = 尚未算过（首个刷新只建立基准，不触发探测）。 */
  fingerprint: string | null;
  /** 用户级两根指纹（D5 写 per-session 快照附带）；undefined = 尚未算出（字段缺省不比对）。 */
  userFingerprint: string | undefined;
  debounceTimer: ReturnType<typeof setTimeout> | null;
  remountTimer: ReturnType<typeof setTimeout> | null;
  /** 挂载失败待重挂的根（review-v1 发现2：目录从无到有盲区；低频兜底重试直至挂上）。 */
  pendingRoots: Set<string>;
  /** 待重挂低频重试循环（pendingRoots 非空时运行）。 */
  pendingRetryTimer: ReturnType<typeof setInterval> | null;
  /** 被幂等锁吞后的延迟重试 timer（发现1；stop 时需一并清理）。 */
  swallowedRetryTimer: ReturnType<typeof setTimeout> | null;
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

/**
 * P2-14：项目级出生指纹（per-session cwd 的 commands/skills 两根，与用户级同一指纹函数）。
 * probe 成功时随快照写入；COMMANDS_GET 现算比对（目录小、递归廉价，不做缓存）。
 * cwd 缺省 → undefined（不比对不误标）；目录不存在 → 空集指纹（确定性，仍可比对）。
 * 注：COMMANDS_GET 侧按 hb10-CMD-V01 在会话 cwd 缺省时回退全局配置工作目录，函数级「无 cwd」
 * 仅在会话与全局两级皆空时触发（出生侧 probe 同该回退）。
 */
export async function getProjectOriginFingerprint(cwd: string | null | undefined): Promise<string | undefined> {
  if (!cwd) return undefined;
  return computeCommandRootsFingerprint([
    path.join(cwd, '.claude', 'commands'),
    path.join(cwd, '.claude', 'skills'),
  ]);
}

/** 启动全局命令来源监视（全局单例；重复调用幂等跳过）。 */
export function startCommandSourceWatcher(deps: CommandSourceWatcherDeps): void {
  if (state) return;
  state = {
    mountedRoots: new Map<string, FSWatcher[]>(),
    fingerprint: null,
    userFingerprint: undefined,
    debounceTimer: null,
    remountTimer: null,
    pendingRoots: new Set<string>(),
    pendingRetryTimer: null,
    swallowedRetryTimer: null,
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
  if (s.pendingRetryTimer) {
    clearInterval(s.pendingRetryTimer);
    s.pendingRetryTimer = null;
  }
  if (s.swallowedRetryTimer) {
    clearTimeout(s.swallowedRetryTimer);
    s.swallowedRetryTimer = null;
  }
  s.unsubscribeConfigSaved?.();
  closeWatchers(s);
  state = null;
}

function closeWatchers(s: CommandSourceWatcherState): void {
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

/** 按根登记已挂载句柄（非递归降级路径的子目录句柄同样归属其根，便于整根增量摘除）。 */
function registerMounted(s: CommandSourceWatcherState, root: string, w: FSWatcher): void {
  const key = root.toLowerCase();
  const list = s.mountedRoots.get(key);
  if (list) list.push(w);
  else s.mountedRoots.set(key, [w]);
}

function handleConfigSaved(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  // 配置保存给了新的重挂机会：清零连续错误计数（对应「超过限次等 onConfigSaved/重启」的恢复路径）。
  s.consecutiveErrors = 0;
  s.hadErrorSinceMount = false;
  // hb10-CMD-06：先清在途重挂 timer 再重挂（防与 mountAll 双重重挂/句柄泄漏）。
  if (s.remountTimer) {
    clearTimeout(s.remountTimer);
    s.remountTimer = null;
  }
  mountAll(deps);
  void refreshFingerprints(deps);
}

function mountAll(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  closeWatchers(s);
  s.pendingRoots.clear(); // hb10-CMD-05：全量重挂即全新登记，陈旧 pending 根不再空转
  s.hadErrorSinceMount = false;
  const { allRoots } = commandSourceRoots(deps);
  for (const root of allRoots) mountRoot(root, deps);
}

function mountRoot(root: string, deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const onEvent = (): void => scheduleRefresh(deps);
  // 挂载成功即从待重挂集合移除（mountAll/兜底重试共用同一登记口径）。
  const mounted = (w: FSWatcher): void => {
    w.on('error', (err) => handleWatcherError(root, deps, err));
    registerMounted(s, root, w);
    if (s.pendingRoots.delete(root) && s.pendingRoots.size === 0 && s.pendingRetryTimer) {
      clearInterval(s.pendingRetryTimer);
      s.pendingRetryTimer = null;
    }
  };
  try {
    // 首选递归 watch（Windows/Linux 支持良好）。
    mounted(watch(root, { recursive: true }, onEvent));
    return;
  } catch {
    // 降级：平台不支持 recursive 时退化为「本目录非递归 + 每根一层子目录」
    // （§4.4 防御性写法；本产品当前主战场 win32，正常走不到）。
  }
  try {
    mounted(watch(root, onEvent));
  } catch {
    // 目录不存在等（review-v1 发现2）：登记待重挂，由低频兜底重试（目录从无到有后挂上），
    // 不阻塞其它根。stop/onConfigSaved 亦覆盖（onConfigSaved 走全量重挂）。
    s.pendingRoots.add(root);
    ensurePendingRetryLoop(deps);
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
      registerMounted(s, root, cw);
    } catch {
      // 单个子目录挂载失败不阻塞其它根。
    }
  }
}

/** 待重挂根的低频兜底重试：挂上后从 pending 移除并重算指纹（新目录已有命令文件 → 指纹变化 → 正常探测）。 */
function ensurePendingRetryLoop(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped || s.pendingRetryTimer || s.pendingRoots.size === 0) return;
  const intervalMs = Math.max(250, deps.pendingRetryMs ?? WATCHER_PENDING_ROOT_RETRY_MS);
  s.pendingRetryTimer = setInterval(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    const before = cur.pendingRoots.size;
    for (const root of [...cur.pendingRoots]) {
      mountRoot(root, deps);
    }
    // 有根在重试中挂上 → 目录状态已变（从无到有），重算指纹；无实质变化时该调用只更新基准不探测。
    const after = state;
    if (after && after.pendingRoots.size < before) {
      // hb13-v B11（F8）：有根在慢循环中重新挂上 = 恢复挂载成功——复位 hadErrorSinceMount，
      // 让本次安静刷新可以把 consecutiveErrors 归零，恢复快/慢模式流转
      //（旧实现该旗标在超限后永无复位点，一旦进入慢循环即永久慢模式）。
      after.hadErrorSinceMount = false;
      // 有根在重试中挂上 → 目录状态已变（从无到有），重算指纹；无实质变化时该调用只更新基准不探测。
      void refreshFingerprints(deps);
    }
  }, intervalMs);
  if (s.pendingRetryTimer && typeof s.pendingRetryTimer.unref === 'function') s.pendingRetryTimer.unref();
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
    // hb10-CMD-02：超限不再永久放弃——登记全部根进 pending 慢重试循环（30s，见
    // WATCHER_PENDING_ROOT_RETRY_MS），错误风暴后仍可自愈（pendingRetryLoop 挂上即重算
    // 指纹并恢复常规探测）。hb13-v B11：注释向实现对齐——hb10 计划原文误写 60s。
    deps.logger.warn('[command-source-watcher] 连续重挂失败超限，转入 30s 慢重试循环。');
    const { allRoots } = commandSourceRoots(deps);
    for (const r of allRoots) s.pendingRoots.add(r);
    ensurePendingRetryLoop(deps);
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

/**
 * P2-D（UI13 批评审）：挂载对齐本次 commandSourceRoots——差集增量挂载/摘除。
 * 旧实现挂载是启动快照：mountAll 仅 start/onConfigSaved/watcher 出错重挂三处触发，
 * 清单动态增长（新项目首次使用进 listRecentWorkingDirs）后新根无 watch 句柄，其
 * .claude/skills 变化不产生 fs 事件，契约 P8#4 对启动后新增目录静默失效。refreshFingerprints
 * 每轮先经本函数对齐：
 * - 新增根复用既有单根挂载 mountRoot（目录不存在 → pendingRoots 慢重试兜底，同一机制）；
 * - 已消失根整根摘除：句柄按既有 close 清理路径关闭，pending 登记一并撤销（清单已不含该根，
 *   慢重试循环对其重试无意义）。
 * 前置约束：调用点与本函数全程同步执行（JS 单线程，无两次差集互踩）；pendingRoots 已登记的根
 * 归慢重试循环管，此处按小写同键跳过，避免同根双 watch。大小写归一与 commandSourceRoots
 * 去重口径一致（win32 不敏感）。
 */
function syncMountedRoots(deps: CommandSourceWatcherDeps, allRoots: string[]): void {
  const s = state;
  if (!s || s.stopped) return;
  const currentKeys = new Set(allRoots.map((r) => r.toLowerCase()));
  // 已消失根：关闭句柄并摘除登记。
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
  // 已消失根若尚在 pending 慢重试，一并撤销；清空后停掉低频循环（登记口径与 mountAll 对齐）。
  for (const root of [...s.pendingRoots]) {
    if (!currentKeys.has(root.toLowerCase())) s.pendingRoots.delete(root);
  }
  if (s.pendingRoots.size === 0 && s.pendingRetryTimer) {
    clearInterval(s.pendingRetryTimer);
    s.pendingRetryTimer = null;
  }
  // 新增根：增量挂载（已挂/已在 pending 的根跳过——pending 归慢重试循环，避免同根双 watch）。
  const pendingKeys = new Set([...s.pendingRoots].map((r) => r.toLowerCase()));
  for (const root of allRoots) {
    const key = root.toLowerCase();
    if (s.mountedRoots.has(key) || pendingKeys.has(key)) continue;
    mountRoot(root, deps);
  }
}

// hb10-CMD-V03：单调序号——并发 refresh 仅最新完成者写基线（乱序旧结果不覆盖新基线）。
let refreshSeq = 0;

async function refreshFingerprints(deps: CommandSourceWatcherDeps): Promise<void> {
  const s = state;
  if (!s || s.stopped) return;
  const mySeq = ++refreshSeq;
  const { userRoots, allRoots } = commandSourceRoots(deps);
  // P2-D：挂载对齐本次清单（差集增量挂载/摘除）在指纹计算前完成——与上方 roots 解析同段
  // 同步执行，不引入新 await 窗口；新根既有文件随本轮指纹进入基线（首拍只建基准不探测），
  // 后续变化经 fs 事件正常触发刷新。旧实现只刷指纹不补挂载（启动快照）。
  syncMountedRoots(deps, allRoots);
  const [allFp, userFp] = await Promise.all([
    computeCommandRootsFingerprint(allRoots),
    computeCommandRootsFingerprint(userRoots),
  ]);
  const cur = state;
  if (!cur || cur.stopped) return;
  if (mySeq !== refreshSeq) return; // hb10-CMD-V03：已有更新一轮完成，本轮结果作废
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
  // UI13-P8（契约 #4/#7，R7 裁决）：指纹确认变化即广播 skills:projectDirsChanged——渲染层
  // Skill tab 活跃时收到即重拉项目清单（廉价 fs 读）。01 已申报轻微过量：用户级 commands-only
  // 变化也会触发一次项目清单重拉（幂等无害）。广播不受 skillAutoSync 门控（项目清单 fs 重拉
  // ≠ 引擎重探）；全局引擎重探仍由下方 fireProbe→triggerGlobalProbe（index.ts 注入侧
  // skillAutoSync 早退）门控，语义不回退。
  deps.onProjectSkillsChanged?.();
  const now = Date.now();
  const wait = s.lastProbeStartedAt + WATCHER_PROBE_MIN_INTERVAL_MS - now;
  if (wait > 0) {
    if (s.probeQueued) return; // 已有排队：到期按最新指纹探测一次
    s.probeQueued = true;
    const t = setTimeout(() => {
      const cur = state;
      if (!cur || cur.stopped) return;
      cur.probeQueued = false;
      fireProbe(deps);
    }, wait);
    if (t && typeof t.unref === 'function') t.unref();
    return;
  }
  fireProbe(deps);
}

/**
 * 立即触发全局探测（节流窗口外）。
 * review-v1 发现1：trigger 返回 false = 被幂等锁吞掉（已有探测在跑）——不推进 lastProbeStartedAt
 * （否则指纹已是最新、后续无新事件不再比对，该次磁盘变更永久丢失），经 swallowedRetryTimer 延迟
 * 一个最小间隔重试，直到真正启动（true）为止；stop 时清理。
 */
function fireProbe(deps: CommandSourceWatcherDeps): void {
  const s = state;
  if (!s || s.stopped) return;
  const started = deps.triggerGlobalProbe();
  if (started !== false) {
    s.lastProbeStartedAt = Date.now();
    return;
  }
  if (s.swallowedRetryTimer || s.probeQueued) return; // 已有重试/排队在途
  s.probeQueued = true;
  s.swallowedRetryTimer = setTimeout(() => {
    const cur = state;
    if (!cur || cur.stopped) return;
    cur.swallowedRetryTimer = null;
    cur.probeQueued = false;
    fireProbe(deps);
  }, WATCHER_PROBE_MIN_INTERVAL_MS);
  if (s.swallowedRetryTimer && typeof s.swallowedRetryTimer.unref === 'function') s.swallowedRetryTimer.unref();
}
