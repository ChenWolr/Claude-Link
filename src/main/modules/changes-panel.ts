// changes-panel.ts
// 会话改动面板的主进程 git 封装：列出 workingDir 的改动文件 + 按需取单文件 diff。
//
// 设计与旧「改前快照」通道的根本区别：这里**不抓改前内容**，而是在用户查看那一刻用 git 算
// 「当前文件 vs HEAD」的真实净 diff。因此没有快照时序竞态、不读文件到内存常驻、不在权限热路径阻塞。
//
// 所有 git 调用走 execFile（非 shell，路径作独立参数 + `--` 防注入），带 timeout/maxBuffer/windowsHide
// （不闪控制台窗），并设 GIT_TERMINAL_PROMPT=0 杜绝凭证交互挂起。解析逻辑为纯函数并导出，便于回归测试。

import { execFile, spawn } from 'child_process';
import * as path from 'path';
import * as fsp from 'node:fs/promises';
import * as fs from 'node:fs';
import { shell } from 'electron';
import { MAX_DIFF_LINES } from '../../shared/process-kind';
import type { ChangedFile, ChangeStatusCode, ChangesDiffResult, ChangesListResult, ChangesOpenResult } from '../../shared/types/changes';

// hb10-CHG-12：最近一次 listChanges 的文件快照（getChangeDiff 判定重命名条目用）。
let lastListFiles: ChangedFile[] | null = null;

// getChangeDiff 的入参 `path` 遮蔽了模块级 node:path 命名空间——目录条目兜底分支用此别名。
const nodePath = path;

const GIT_TIMEOUT_MS = 3000;
const GIT_MAX_BUFFER = 8 * 1024 * 1024;

interface RawGitResult {
  stdout: string;
  code: number;
}

// 跑一次 git；退出码 0/1（--no-index 文件不同时为 1）都当成功返回 stdout，
// 仅 spawn 失败 / 超时（err.code 非 number）才 reject。
function runGitRaw(cwd: string, args: string[]): Promise<RawGitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', cwd, ...args],
      {
        maxBuffer: GIT_MAX_BUFFER,
        timeout: GIT_TIMEOUT_MS,
        encoding: 'buffer',
        windowsHide: true, // hb12-CHG-02：Windows 上不闪 git 控制台窗
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdoutBuf) => {
        const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
        const decode = (buf: Buffer | undefined): string => {
          const utf8 = (buf ?? Buffer.alloc(0)).toString('utf8');
          // hb10-CHG-10：U+FFFD 占比 >5% 按 latin1 重解（hb13-v 批C 措辞纠偏：latin1 按字节
          // 单射，GBK 双字节中文重解后仍是乱码——效果仅是消除替换符海，不产生可读文本；
          // 真可读需 TextDecoder('gbk')，域内暂无下游再解码，有损降级优于替换符海）。
          let bad = 0;
          for (const ch of utf8) if (ch === REPLACEMENT_CHAR) bad += 1;
          if (bad > 0 && bad / Math.max(1, utf8.length) > 0.05) {
            return (buf ?? Buffer.alloc(0)).toString('latin1');
          }
          return utf8;
        };
        const stdout = decode(stdoutBuf as Buffer | undefined);
        if (!err) return resolve({ stdout, code: 0 });
        if (typeof err.code === 'number') return resolve({ stdout: stdout || (err.stdout != null ? String(err.stdout) : ''), code: err.code });
        reject(err); // 超时 / git 不存在 / spawn 错误
      },
    );
  });
}

// hb10 P2-7：runGit 不再丢弃退出码——返回 {stdout, code} 供调用方分流：
// status/diff 非 0（--no-index 路径另许 1=有差异的合法态）判定为 git 异常，面板显示失败态而非「无改动」。
async function runGit(cwd: string, args: string[]): Promise<RawGitResult> {
  return runGitRaw(cwd, args);
}

// Windows/macOS 文件系统大小写不敏感：LLM 给的 file_path 大小写未必与 git 存的一致，
// 比对 touchedThisSession 时按平台归一比对键（Linux 保持大小写敏感）。
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
function pathKey(rel: string): string {
  return CASE_INSENSITIVE_PATHS ? rel.toLowerCase() : rel;
}

/** 仓库根目录；非 git 仓库或 git 缺失返回 null。 */
async function ensureRepo(cwd: string | null): Promise<string | null> {
  if (!cwd) return null;
  try {
    const out = (await runGitRaw(cwd, ['rev-parse', '--show-toplevel'])).stdout.trim();
    return out || null;
  } catch {
    return null; // git 缺失或不可用
  }
}

/** 区分 git 不可用 vs 非 git 仓库（二者 ensureRepo 都返回 null，需二次判定）。 */
async function detectReason(cwd: string): Promise<ChangesListResult> {
  try {
    await runGitRaw(cwd, ['--version']);
  } catch {
    return { ok: false, reason: 'git-unavailable', message: '未检测到 git，无法查看改动' };
  }
  return { ok: false, reason: 'not-a-repo', message: '当前工作目录不是 git 仓库' };
}

// ── 纯解析函数（导出供回归测试）──────────────────────────────────

/** 解析 `git status --porcelain=v1 -z` 输出（NUL 分隔；重命名含第二段 oldPath）。 */
export function parseStatusPorcelainV1Z(output: string): Array<{ xy: string; path: string; oldPath?: string }> {
  const fields = output.split('\0');
  const result: Array<{ xy: string; path: string; oldPath?: string }> = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    if (!field) continue;
    const xy = field.slice(0, 2);
    const path = field.slice(3); // 跳过 "XY " 三字符
    const x = xy[0];
    if (x === 'R' || x === 'C') {
      result.push({ xy, path, oldPath: fields[i + 1] });
      i++; // 消耗第二段 oldPath
    } else {
      result.push({ xy, path });
    }
  }
  return result;
}

/** 把 porcelain 的 XY 状态码归一为面板用的 ChangeStatusCode。
 *  hb10-CHG-06：冲突态（第二列 U 或 DD/AU/UA/DU/UD/AA）先于归一标「冲」（U），
 *  未合并条目不再被静默归一为 M/A/D。 */
export function normalizeStatus(xy: string): ChangeStatusCode {
  const x = xy[0];
  // hb10-CHG-06：冲突判定——第二列 U 或双方改写组合全部标 U（冲突可见）。
  const y = xy[1];
  if (y === 'U' || xy === 'DD' || xy === 'AA') return 'U';
  if (x === '?') return '??';
  if (x === 'A') return 'A';
  if (x === 'D') return 'D';
  if (x === 'R' || x === 'C') return 'R';
  if (x === 'U') return 'U';
  return 'M'; // M / T / 其它一律视作 modified
}

/** 解析 `git diff HEAD --numstat -z` 输出；二进制（-\t-）标 binary。
 *  G3：重命名形态（本仓库 git 实证）为 `add\tdel\t<NUL>oldPath<NUL>newPath<NUL>`——计数段
 *  路径为空串，随后两段依次为 old/new。现把计数并入 new 路径键、跳过 old 段（旧行为把
 *  计数落在空串幽灵键、new 路径无条目）。 */
export function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const out = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  const segments = output.split('\0');
  for (let i = 0; i < segments.length; i += 1) {
    const raw = segments[i];
    if (!raw) continue;
    // hb12-CHG-04：原 (.*)$ 正则不匹配含换行/回车文件名（-z 允许）→ ± 计数静默丢失。
    // 改 indexOf('\t') 手工切前两段、剩余整段作路径（含任何控制字符的文件名都不丢）。
    const tab1 = raw.indexOf('\t');
    const tab2 = tab1 >= 0 ? raw.indexOf('\t', tab1 + 1) : -1;
    if (tab1 <= 0 || tab2 <= tab1) continue; // 重命名 oldPath 段等非 numstat 行 → 跳过
    const addTok = raw.slice(0, tab1);
    const delTok = raw.slice(tab1 + 1, tab2);
    const pathPart = raw.slice(tab2 + 1);
    if (!/^(-|\d+)$/.test(addTok) || !/^(-|\d+)$/.test(delTok)) continue;
    const m = [null, addTok, delTok, pathPart] as unknown as RegExpMatchArray;
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    const counts = { additions: add, deletions: del, binary: add === null && del === null };
    if (m[3] === '') {
      // G3：重命名形态——跳过 oldPath（i+1），计数并入 newPath（i+2）。
      const newPath = segments[i + 2];
      if (newPath) {
        out.set(newPath, counts);
        i += 2;
      }
      continue;
    }
    out.set(m[3], counts);
  }
  return out;
}

/** 超 maxLines 行截断：按完整 hunk（@@ 起止）累加，避免切在 hunk 中段产出 span 与 body 不符的残缺 hunk。
 *  首个 hunk 本身就超限时，部分保留它（行切），总比只显文件头强。未超限原样返回。 */
export function truncateDiff(diff: string, maxLines: number): { diff: string; truncated: boolean } {
  const lines = diff.split('\n');
  if (lines.length <= maxLines) return { diff, truncated: false };
  const firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk < 0) return { diff: lines.slice(0, maxLines).join('\n'), truncated: true }; // 无 hunk，按行切
  // 从切点往前退到第一个 @@（该 @@ 起的 hunk 被部分保留 → 不完整，丢弃它，保留之前完整 hunk）
  let keep = maxLines;
  while (keep > 0 && !lines[keep].startsWith('@@')) keep--;
  if (keep > firstHunk) return { diff: lines.slice(0, keep).join('\n'), truncated: true };
  // keep 落在首个 hunk 头上 → 连第一个 hunk 都装不下：部分保留首个 hunk
  return { diff: lines.slice(0, maxLines).join('\n'), truncated: true };
}

// ── IPC 入口 ──────────────────────────────────────────────────

export async function listChanges(workingDir: string | null, touchedPaths: string[] = []): Promise<ChangesListResult> {
  const root = await ensureRepo(workingDir);
  if (!root) return detectReason(workingDir ?? '.');

  let baselineRef = '';
  try {
    baselineRef = (await runGitRaw(root, ['rev-parse', 'HEAD'])).stdout.trim();
  } catch {
    baselineRef = ''; // 无提交的空仓库
  }

  // workingDir 可能是仓库子目录：只列该子树下的改动（pathspec 相对仓库根，正斜杠）。
  const relPrefix = workingDir ? path.relative(root, workingDir).replace(/\\/g, '/') : '';
  const pathspec = relPrefix ? ['--', relPrefix] : [];
  // status/numstat 超时（>GIT_TIMEOUT_MS）或输出超 maxBuffer → runGit reject；
  // 降级为 ok:false 让面板显可读错误，不让 rejection 冒泡成静默失败（与 getChangeDiff 失败处理同形）。
  let statusOut: string;
  let numstatOut: string;
  try {
    // hb10 P2-7：status/numstat 非零退出（如损坏 .git/index）不再当成功空输出，返回 git-error 失败态。
    const st = await runGit(root, ['--no-pager', 'status', '--porcelain=v1', '-z', '--ignore-submodules', '--untracked-files=all', ...pathspec]);
    if (st.code !== 0) {
      return { ok: false, reason: 'git-error', message: '扫描改动失败：git 异常退出' };
    }
    const ns = await runGit(root, ['--no-pager', 'diff', 'HEAD', '--numstat', '-z', '--ignore-submodules', ...pathspec]);
    if (ns.code !== 0) {
      return { ok: false, reason: 'git-error', message: '扫描改动失败：git 异常退出' };
    }
    statusOut = st.stdout;
    numstatOut = ns.stdout;
  } catch {
    return { ok: false, reason: 'error', message: '扫描改动失败（超时或输出过大），请重试' };
  }
  const numstat = parseNumstatZ(numstatOut);

  // 本会话触碰集 → 归一到仓库根相对路径（正斜杠），与 git 给的 f.path 同基准比对。
  // 处理绝对路径与相对 workingDir 两种 tool_use file_path 形式。
  const touchedRels = new Set<string>();
  if (workingDir) {
    for (const p of touchedPaths) {
      if (typeof p !== 'string' || !p) continue;
      const abs = path.isAbsolute(p) ? p : path.resolve(workingDir, p);
      touchedRels.add(pathKey(path.relative(root, abs).replace(/\\/g, '/')));
    }
  }

  const files: ChangedFile[] = parseStatusPorcelainV1Z(statusOut).map((s) => {
    const ns = numstat.get(s.path);
    return {
      path: s.path,
      status: normalizeStatus(s.xy),
      oldPath: s.oldPath,
      additions: ns?.additions ?? null,
      deletions: ns?.deletions ?? null,
      binary: ns?.binary ?? false,
      touchedThisSession: touchedRels.has(pathKey(s.path)),
    };
  });

  lastListFiles = files;
  return { ok: true, files, baselineRef };
}

export async function getChangeDiff(workingDir: string | null, path: string, context = 3): Promise<ChangesDiffResult> {
  if (!path) return { ok: false, reason: 'no-such-file', message: '未指定文件' };
  // hb10 P2-8：路径信任边界（先校验后执行）——绝对路径/越界形态（..）/.git 段一律拒绝。
  if (!isSafeRepoRelPath(path)) {
    return { ok: false, reason: 'no-such-file', message: '非法文件路径' };
  }
  const cwd = await ensureRepo(workingDir);
  if (!cwd) {
    const r = await detectReason(workingDir ?? '.');
    if (r.ok) return { ok: false, reason: 'not-a-repo', message: '当前工作目录不是 git 仓库' };
    return { ok: false, reason: r.reason === 'git-unavailable' ? 'error' : 'not-a-repo', message: r.message };
  }
  // hb10 P2-8：越界双保险——resolve 后仍须落在仓库根内（大小写/分隔符归一比对）。
  if (!isPathInsideRoot(nodePath.resolve(cwd, path), cwd)) {
    return { ok: false, reason: 'no-such-file', message: '文件不在仓库目录内' };
  }

  let diffText = '';
  try {
    // P1-11：目录折叠条目兜底（`dir/` 结尾，status.showUntrackedFiles=no 时仍会出现）——
    // 对目录跑 --no-index 会报错（实测 exit 1 "Could not access"）。枚举目录内文件逐个
    // --no-index 拼接整目录新增 diff，交给既有二进制检测/截断流程。
    if (path.endsWith('/')) {
      const absDir = nodePath.join(cwd, path);
      const dirents = await fsp.readdir(absDir, { withFileTypes: true, recursive: true });
      // hb10-CHG-08（收窄）：目录兜底预算——嵌入仓库（node_modules 级海量文件）不逐文件拼；
      // 文件数 ≤50 且总字节 ≤8MB 才拼，超限返回失败文案。
      const dirFiles = dirents.filter((d) => d.isFile());
      if (dirFiles.length > 50) {
        return { ok: false, reason: 'error', message: '目录条目过大，无法显示（>50 个文件）' };
      }
      let totalBytes = 0;
      for (const dirent of dirFiles) {
        try { totalBytes += fs.statSync(nodePath.join(dirent.path, dirent.name)).size; } catch { /* 不可读跳过 */ }
      }
      if (totalBytes > 8 * 1024 * 1024) {
        return { ok: false, reason: 'error', message: '目录条目过大，无法显示（>8MB）' };
      }
      const parts: string[] = [];
      for (const dirent of dirFiles) {
        if (!dirent.isFile()) continue;
        const rel = nodePath.relative(cwd, nodePath.join(dirent.path, dirent.name)).replace(/\\/g, '/');
        const r = await runGitRaw(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', rel]);
        if (r.code !== 0 && r.code !== 1) {
          return { ok: false, reason: 'git-error', message: '读取 diff 失败：git 异常退出' };
        }
        if (r.stdout.trim()) parts.push(r.stdout);
      }
      diffText = parts.join('\n');
    } else
    // 已跟踪文件：相对 HEAD 的净改动（含已暂存+未暂存）。
    // -U{context}：上下文行数由弹窗「上下文 3/5/10/20」选择器决定 —— git 直接给 N 行 ctx，
    // inline 不再二次折叠（避免 -U 固定大值时边界 ctx 被拆成碎 gap）；hunk 间距 >2N 时 git 自然跳过 → skip 分隔。
    {
      // hb10-CHG-12：重命名条目（R）用 -- oldPath newPath 取改名 diff（hb13-v 批C 措辞纠偏：
      // git 实证「对 new 路径 diff HEAD 恒空」不成立——rename 后 new 路径相对 HEAD 可产出 diff；
      // 双路径 pathspec 的实际价值是呈现完整改名差异（含旧路径侧内容）。）
      const renameEntry = lastListFiles?.find((f) => f.path === path && f.status === 'R' && f.oldPath);
      const pathspecArgs: string[] = renameEntry?.oldPath ? ['--', renameEntry.oldPath, path] : ['--', path];
      const tracked = await runGit(cwd, ['--no-pager', 'diff', 'HEAD', `-U${context}`, ...pathspecArgs]);
      // hb10 P2-7：diff 非零退出不再当成功空输出（--no-index 差异态 exit 1 在下方分支合法）。
      if (tracked.code !== 0) {
        return { ok: false, reason: 'git-error', message: '读取 diff 失败：git 异常退出' };
      }
      if (tracked.stdout.trim()) {
        diffText = tracked.stdout;
      } else {
        // 未跟踪文件（在改动列表里但 diff HEAD 为空）：整文件作新增。--no-index 文件不同时退出码 1。
        const untracked = await runGit(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', path]);
        if (untracked.code !== 0 && untracked.code !== 1) {
          return { ok: false, reason: 'git-error', message: '读取 diff 失败：git 异常退出' };
        }
        diffText = untracked.stdout;
      }
    }
  } catch {
    return { ok: false, reason: 'error', message: '读取 diff 失败' };
  }

  // 锚行首：git 二进制标记是整行 meta（`Binary files a/x and b/x differ` / `GIT binary patch`），无 +/- 前缀；
  // 文本 diff 内容行带前缀（如 `+Binary files ...`），不匹配 ^，避免文本文件被子串误判为二进制。
  const binary = /^(?:Binary files .+ differ|GIT binary patch)$/m.test(diffText);
  if (binary) {
    return { ok: true, diff: '二进制文件，无法显示行级 diff', truncated: false, binary: true, context };
  }

  const t = truncateDiff(diffText, MAX_DIFF_LINES);
  if (!t.diff.trim()) return { ok: false, reason: 'no-such-file', message: '无可显示差异' };
  return { ok: true, diff: t.diff, truncated: t.truncated, binary: false, context };
}

/** 给定绝对路径与平台，返回弹原生「打开方式」对话框的命令；平台不支持返回 null。
 *  Windows 用 rundll32 shell32.dll,OpenAs_RunDLL；macOS/Linux 暂不支持（返回 null，由调用方决定回退）。 */
export function openWithCommand(absPath: string, platform: string = process.platform): { command: string; args: string[] } | null {
  if (platform === 'win32') {
    return { command: 'rundll32.exe', args: ['shell32.dll,OpenAs_RunDLL', absPath] };
  }
  return null;
}

/** 仓库根相对路径信任判定（hb10 P2-8）：拒绝空串/绝对路径/形态层越界（.. 段）/.git 段。
 *  语义层越界（符号链接、大小写）由调用方 resolve + isPathInsideRoot 双保险兜底。
 *  导出纯函数供契约行为测试。目录条目（尾随 /）放行——由目录兜底分支处理。 */
export function isSafeRepoRelPath(rel: string): boolean {
  if (!rel) return false;
  if (nodePath.isAbsolute(rel)) return false;
  if (/(^|\/)\.git(\/|$)/.test(rel)) return false;
  if (rel.split('/').some((seg) => seg === '..')) return false;
  return true;
}

/** 判断 absPath 是否在 root 目录内（含 root 自身）。
 *  关键：git rev-parse --show-toplevel 在 Windows 输出正斜杠（D:/...），而 path.resolve 把 abs 规范化成反斜杠，
 *  字符串 startsWith 会因分隔符不匹配误判越界 → 两边都 normalize 统一为平台分隔符后再比。 */
export function isPathInsideRoot(absPath: string, root: string): boolean {
  const nr = path.normalize(root);
  const na = path.normalize(absPath);
  return na === nr || na.startsWith(nr + path.sep);
}

// 启动外部程序弹原生「打开方式」对话框：detached 不等退出（对话框是模态 UI，由用户操作关闭）；
// 仅在 spawn 立即失败（如 rundll32 缺失）时 reject，给调用方回退原错误的机会。
function spawnOpenWithDialog(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }); // hb12-CHG-02：同上
    child.once('error', reject);
    child.unref();
    // spawn 同步失败（ENOENT 等）会近立即抛 error；留 120ms 窗口捕获，无 error 视为对话框已弹出。
    // hb10-CHG-15：removeListener 后改挂 noop——detached 子进程晚发 error（如对话框进程崩溃）
    // 无监听会冒成 uncaughtException；noop 吸收且不阻塞 resolve。
    setTimeout(() => {
      child.removeListener('error', reject);
      child.on('error', () => {});
      resolve();
    }, 120);
  });
}

// 「打开」文件：优先走 shell.openPath 用系统默认程序打开；失败时（无默认程序 / 文件不存在等）
// 在 Windows 降级用 rundll32 弹原生「打开方式」对话框让用户选程序，其他平台无等价 API 直接返回错误。
// 安全要点：ChangedFile.path 是仓库根相对（正斜杠），workingDir 可能是仓库子目录 →
// 绝不能 path.resolve(workingDir, rel)，必须经仓库根 resolve，并 startsWith(root+sep)
// 防 .. 越界逃逸。openPath 成功返回空串，失败返回 ErrorDescription 字符串。
export async function openChangeFile(workingDir: string | null, relPath: string): Promise<ChangesOpenResult> {
  if (!relPath) return { ok: false, reason: 'no-such-file', message: '未指定文件' };
  const root = await ensureRepo(workingDir);
  if (!root) {
    const r = await detectReason(workingDir ?? '.');
    if (r.ok) return { ok: false, reason: 'not-a-repo', message: '当前工作目录不是 git 仓库' };
    return { ok: false, reason: r.reason === 'git-unavailable' ? 'git-unavailable' : 'not-a-repo', message: r.message };
  }
  let abs = path.resolve(root, relPath);
  // hb10-CHG-07：symlink 穿透封堵——最终路径 realpathSync 后再验界（解析符号链接；
  // 解析失败=路径不存在/悬空链接，直接拒绝）。
  try {
    abs = fs.realpathSync(abs);
  } catch {
    return { ok: false, reason: 'no-such-file', message: '文件不存在或链接失效' };
  }
  if (!isPathInsideRoot(abs, root)) {
    return { ok: false, reason: 'no-such-file', message: '文件不在仓库目录内' };
  }
  try {
    const err = await shell.openPath(abs);
    if (!err) return { ok: true };
    // shell.openPath 失败：Windows 降级弹「打开方式」对话框；其他平台无等价 API，回退原错误。
    const fallback = openWithCommand(abs);
    if (fallback) {
      try {
        await spawnOpenWithDialog(fallback.command, fallback.args);
        return { ok: true };
      } catch {
        return { ok: false, reason: 'error', message: `无法打开：${err}` };
      }
    }
    return { ok: false, reason: 'error', message: `无法打开：${err}` };
  } catch {
    return { ok: false, reason: 'error', message: '打开文件失败' };
  }
}
