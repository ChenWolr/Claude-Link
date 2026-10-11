// fs-picker.ts
// 自绘 FilePickerDialog 的主进程后端：只读文件系统元数据（列根/列目录/新建文件夹/查存在）。
// 供 ipc-handlers.ts 的 FS_LIST_ROOTS / FS_LIST_DIR / FS_MKDIR / FS_STAT 四通道调用。
//
// 约束：不得 import electron——契约脚本 scripts/tdd-fs-picker.ts 经 tsx 直接 import 本模块测试，
// 只允许 node:fs / node:fs/promises / node:path / node:os。文件内容读取不在本模块（仍在主进程专用链路）。

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  FsDirEntry,
  FsDriveInfo,
  FsListError,
  FsListResult,
  FsMkdirResult,
  FsQuickLocation,
  FsRootsResult,
  FsStatResult,
} from '../../shared/types/fs-picker';

/** listDir 整体预算（readdir + 逐条目 stat + 排序）：不可达网络路径不再占死 IPC 调用方。 */
const LIST_DIR_BUDGET_MS = 3000;
/** 驱动器枚举整体预算：A–Z 并发 fsp.access 探测（断连映射盘可能各阻塞数百 ms~数十秒），超时归空数组。 */
const LIST_ROOTS_BUDGET_MS = 1000;

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

/** A–Z 驱动器探测（异步 fsp.access，给 event loop 让出点）：断连映射盘的单盘阻塞不再
 *  冻结主进程——withBudget 的 1s 预算 race 由此第一次真实生效（同步 existsSync 时代
 *  timer 回调无法在阻塞期触发，预算形同虚设，P2-2）。失败/超时项统一过滤。 */
async function enumerateDrives(): Promise<FsDriveInfo[]> {
  const probes = [] as Array<{ letter: string; path: string; probe: Promise<void> }>;
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code); // A–Z
    const root = `${letter}:\\`;
    probes.push({ letter, path: root, probe: fsp.access(root) });
  }
  const settled = await Promise.allSettled(probes.map((p) => p.probe));
  return probes.filter((_, i) => settled[i].status === 'fulfilled').map(({ letter, path }) => ({ letter, path }));
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
  // 驱动器枚举 1s 预算：预算耗尽/异常归空数组（ok 仍 true——弹窗仍可用 home/quick 导航）。
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
