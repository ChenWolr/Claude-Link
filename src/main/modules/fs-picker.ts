// fs-picker.ts
// 自绘 FilePickerDialog 的主进程后端：只读文件系统元数据（列根/列目录/新建文件夹/查存在）
// + renamePath：同目录重命名（拒绝移动语义），错误码对齐 FsMkdirResult 风格（IPC 通道 P2 接线）。
// 供 ipc-handlers.ts 的 FS_LIST_ROOTS / FS_LIST_DIR / FS_MKDIR / FS_STAT 四通道调用。
// 驱动器枚举为逐盘预算（enumerateDrivesWithProbe）：单盘慢/失败只剔除该盘，不再连坐全部归空。
//
// 约束：不得 import electron——契约脚本 scripts/tdd-fs-picker.ts 经 tsx 直接 import 本模块测试，
// 只允许 node:fs / node:fs/promises / node:path / node:os 与零依赖纯模块 shared/fs-name-rules。
// 文件内容读取不在本模块（仍在主进程专用链路）。

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidFsItemName } from '../../shared/fs-name-rules';
import type {
  FsDirEntry,
  FsDriveInfo,
  FsListError,
  FsListResult,
  FsMkdirResult,
  FsQuickLocation,
  FsRenameResult,
  FsRootsResult,
  FsStatResult,
} from '../../shared/types/fs-picker';

/** listDir 整体预算（readdir + 逐条目 stat + 排序）：不可达网络路径不再占死 IPC 调用方。 */
const LIST_DIR_BUDGET_MS = 3000;
/** 单盘探测预算：A–Z 逐盘并发各自计时——慢盘（休眠唤醒的机械盘/断连映射盘）单独剔除，其余盘照常返回。 */
const LIST_ROOTS_DRIVE_BUDGET_MS = 800;
/** 驱动器枚举外层兜底预算：仅防极端情形（如 event loop 被同步 IO 长时间挤占）；正常路径总耗时 ≈ 最慢单盘（逐盘并发不叠加）。 */
const LIST_ROOTS_BUDGET_MS = 2500;

/** 预算耗尽哨兵：与文件系统 errno 错误区分（后者走错误归一，前者固定归 'timeout'）。 */
class BudgetTimeoutError extends Error {
  constructor(scope: string) {
    super(`${scope} budget exhausted`);
    this.name = 'BudgetTimeoutError';
  }
}

/** race 工具：work 与 ms 预算竞速；预算耗尽或 work 抛错都不向上抛，统一走 onFail(err) 兜底。 */
async function withBudget<T>(
  scope: string,
  ms: number,
  work: () => T | Promise<T>,
  onFail: (err: unknown) => T,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new BudgetTimeoutError(scope)), ms);
      }),
    ]);
  } catch (err) {
    return onFail(err);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// ── listRoots：home + 快捷位置（存在性过滤）+ A–Z 驱动器枚举 ──

/** A–Z 驱动器逐盘预算探测（异步 probe，默认 fsp.access，给 event loop 让出点）：每盘各自
 *  withBudget 计时，慢盘（休眠唤醒的机械盘/断连映射盘）单独剔除、其余照常返回——不再
 *  「任一盘超时连坐全空」。probe reject（盘符不存在等）同样剔除。导出注入版供契约脚本
 *  scripts/tdd-fs-picker-drive-resilience.ts 直测（本模块不 import electron，tsx 可直跑）。 */
export async function enumerateDrivesWithProbe(
  probe: (root: string) => Promise<void>,
  perDriveMs: number,
): Promise<FsDriveInfo[]> {
  const probes = [] as Array<{ letter: string; path: string; budgeted: Promise<'timeout' | void> }>;
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code); // A–Z
    const root = `${letter}:\\`;
    // 逐盘独立预算：probe hang（预算耗尽）与 reject 都由 withBudget 归一为 'timeout' 哨兵，绝不向上抛。
    probes.push({
      letter,
      path: root,
      budgeted: withBudget<'timeout' | void>(`drive.${letter}`, perDriveMs, () => probe(root), () => 'timeout' as const),
    });
  }
  const settled = await Promise.allSettled(probes.map((p) => p.budgeted));
  const kept: FsDriveInfo[] = [];
  settled.forEach((s, i) => {
    // fulfilled 且非哨兵 → 保留；'timeout'（预算耗尽或 probe reject 归一）与 rejected 一律剔除。
    if (s.status === 'fulfilled' && s.value !== 'timeout') {
      const { letter, path } = probes[i];
      kept.push({ letter, path });
    }
  });
  return kept;
}

/** 默认探测实现（listRoots 消费）：真实 fsp.access 盘根存在性检查，逐盘预算 LIST_ROOTS_DRIVE_BUDGET_MS。 */
async function enumerateDrives(): Promise<FsDriveInfo[]> {
  return enumerateDrivesWithProbe((root) => fsp.access(root), LIST_ROOTS_DRIVE_BUDGET_MS);
}

export async function listRoots(): Promise<FsRootsResult> {
  const cwdHome = os.homedir();
  // quick 候选固定四个，fsp.access 异步过滤磁盘上不存在的（如未本地化的 Documents / 被移走的 Desktop）——
  // 与 enumerateDrives 同为异步探测，模块内不再有任何同步 fs 调用（P2-2）。
  const quickCandidates = [
    { id: 'home', label: '主目录', path: cwdHome },
    { id: 'desktop', label: '桌面', path: path.join(cwdHome, 'Desktop') },
    { id: 'documents', label: '文档', path: path.join(cwdHome, 'Documents') },
    { id: 'downloads', label: '下载', path: path.join(cwdHome, 'Downloads') },
  ] as const;
  const quickChecks = await Promise.allSettled(quickCandidates.map((q) => fsp.access(q.path)));
  const quick: FsQuickLocation[] = quickCandidates
    .filter((_, i) => quickChecks[i].status === 'fulfilled')
    .map(({ id, label, path }) => ({ id, label, path }));
  // 驱动器枚举：慢盘已由逐盘预算（enumerateDrivesWithProbe 内 800ms/盘）单独剔除；此处外层 2500ms
  // 仅极端兜底（预算耗尽/异常归空数组，ok 仍 true——弹窗仍可用 home/quick 导航）。
  const drives = await withBudget('listRoots.drives', LIST_ROOTS_BUDGET_MS, enumerateDrives, () => [] as FsDriveInfo[]);
  return { ok: true, cwdHome, quick, drives };
}

// ── listDir：readdir(withFileTypes) + 逐条目 stat + 目录优先/中文 locale 排序 ──

/** listDir 错误归一：预算耗尽 → timeout；EPERM/EACCES → access-denied；其余（ENOENT/ENOTDIR/未知）保守归 not-found。 */
function normalizeListError(err: unknown): FsListError {
  if (err instanceof BudgetTimeoutError) return 'timeout';
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === 'EPERM' || code === 'EACCES') return 'access-denied';
  return 'not-found';
}

async function readEntries(dir: string): Promise<FsDirEntry[]> {
  const dirents = await fsp.readdir(dir, { withFileTypes: true });
  const entries = await Promise.all(
    dirents.map(async (dirent): Promise<FsDirEntry> => {
      // isDir 以 dirent 自身为准（symlink 不跟随判目录）；size/mtimeMs 跟随 stat（symlink 指向目标的大小）。
      // stat 失败的条目按 size=0/mtimeMs=0 保留，不整体失败（列目录尽最大努力展示）。
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = await fsp.stat(path.join(dir, dirent.name));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // 保留 0/0
      }
      return { name: dirent.name, isDir: dirent.isDirectory(), size, mtimeMs, hidden: dirent.name.startsWith('.') };
    }),
  );
  // 排序：目录在前 → 名称中文 locale 自然排序（数字按数值比较、大小写不敏感）。
  entries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name, 'zh', { numeric: true, sensitivity: 'base' });
  });
  return entries;
}

export async function listDir(target: string): Promise<FsListResult> {
  // 入参防御：非 string / 空白串直接 not-found（IPC 层已校验，这里兜底供契约脚本与未来调用方）。
  if (typeof target !== 'string' || !target.trim()) {
    return { ok: false, path: typeof target === 'string' ? target : String(target), error: 'not-found' };
  }
  const dir = path.resolve(target);
  if (!path.isAbsolute(dir)) {
    return { ok: false, path: dir, error: 'not-found' };
  }
  return withBudget<FsListResult>(
    'listDir',
    LIST_DIR_BUDGET_MS,
    async (): Promise<FsListResult> => ({ ok: true, path: dir, entries: await readEntries(dir) }),
    (err): FsListResult => ({ ok: false, path: dir, error: normalizeListError(err) }),
  );
}

// ── mkdir：Windows 目录名校验 + 单层新建 ──

/** Windows 目录名合法性（纯函数，契约脚本直测）：非空、不含 \ / : * ? " < > |、不以点或空格结尾、长度 ≤ 255。 */
export function isValidFolderName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > 255) return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  return true;
}

export async function mkdir(parent: string, name: string): Promise<FsMkdirResult> {
  if (!isValidFolderName(name)) return { ok: false, error: 'invalid-name' };
  try {
    const dir = path.resolve(parent, name);
    await fsp.mkdir(dir);
    return { ok: true, path: dir };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'EEXIST') return { ok: false, error: 'exists' };
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, error: 'denied' };
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, error: 'not-found' };
    // 未知错误保守归 denied（写操作失败最常见原因是权限）。
    return { ok: false, error: 'denied' };
  }
}

// ── renamePath：同目录重命名（拒绝移动语义） ──

/** 大小写不敏感同位判定（Windows）：resolve 归一后 toLowerCase 相等——大小写-only 重命名放行的关键。 */
function samePathCI(a: string, b: string): boolean {
  return path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
}

export async function renamePath(oldPath: string, newName: string): Promise<FsRenameResult> {
  // 1. 同名（新名与当前名字面相等）→ no-op 成功，不触盘。
  if (path.basename(oldPath) === newName) return { ok: true, path: oldPath };
  // 2. 新名非法（含路径分隔符即被拒——重命名限定同目录，不接受移动语义）→ invalid-name。
  if (!isValidFsItemName(newName)) return { ok: false, error: 'invalid-name' };
  // 3. 同目录拼接：parent = oldPath 父目录；newPath = parent + 新名。
  const parent = path.dirname(oldPath);
  const newPath = path.join(parent, newName);
  // 4. 前置检查（竞态可接受）：源不存在 → not-found；目标已存在且非大小写-only 同位 → exists
  //    （大小写-only 重命名 a→A 必须放行：Windows 大小写不敏感，samePathCI 相等时跳过冲突判定）。
  if (!(await statPath(oldPath)).exists) return { ok: false, error: 'not-found' };
  const newStat = await statPath(newPath);
  if (newStat.exists && !samePathCI(oldPath, newPath)) return { ok: false, error: 'exists' };
  // 5. fsp.rename：ENOENT → not-found；EPERM/EACCES/EEXIST/ENOTEMPTY 及其余未知 errno → denied（保守）。
  try {
    await fsp.rename(oldPath, newPath);
    return { ok: true, path: newPath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === 'ENOENT') return { ok: false, error: 'not-found' };
    return { ok: false, error: 'denied' };
  }
}

// ── statPath：存在性/目录性/大小（跟随符号链接，与保存语义一致） ──

export async function statPath(p: string): Promise<FsStatResult> {
  if (typeof p !== 'string' || !p.trim()) return { exists: false, isDir: false, size: 0 };
  try {
    const st = await fsp.stat(p);
    return { exists: true, isDir: st.isDirectory(), size: st.size };
  } catch {
    return { exists: false, isDir: false, size: 0 };
  }
}
