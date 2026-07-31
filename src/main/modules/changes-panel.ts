// changes-panel.ts
// 会话改动面板的主进程 git 封装：列出 workingDir 的改动文件 + 按需取单文件 diff。
//
// 设计与旧「改前快照」通道的根本区别：这里**不抓改前内容**，而是在用户查看那一刻用 git 算
// 「当前文件 vs HEAD」的真实净 diff。因此没有快照时序竞态、不读文件到内存常驻、不在权限热路径阻塞。
//
// 所有 git 调用走 execFile（非 shell，路径作独立参数 + `--` 防注入），带 timeout/maxBuffer，
// 并设 GIT_TERMINAL_PROMPT=0 杜绝凭证交互挂起。解析逻辑为纯函数并导出，便于回归测试。

import { execFile } from 'child_process';
import * as path from 'path';
import { shell } from 'electron';
import { MAX_DIFF_LINES } from '../../shared/process-kind';
import type { ChangedFile, ChangeStatusCode, ChangesDiffResult, ChangesListResult, ChangesOpenResult } from '../../shared/types/changes';

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
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      },
      (err, stdout) => {
        if (!err) return resolve({ stdout: stdout ?? '', code: 0 });
        if (typeof err.code === 'number') return resolve({ stdout: stdout ?? err.stdout ?? '', code: err.code });
        reject(err); // 超时 / git 不存在 / spawn 错误
      },
    );
  });
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return (await runGitRaw(cwd, args)).stdout;
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

/** 把 porcelain 的 XY 状态码归一为面板用的 ChangeStatusCode。 */
export function normalizeStatus(xy: string): ChangeStatusCode {
  const x = xy[0];
  if (x === '?') return '??';
  if (x === 'A') return 'A';
  if (x === 'D') return 'D';
  if (x === 'R' || x === 'C') return 'R';
  if (x === 'U') return 'U';
  return 'M'; // M / T / 其它一律视作 modified
}

/** 解析 `git diff HEAD --numstat -z` 输出；二进制（-\t-）标 binary。重命名的 oldPath 段被跳过。 */
export function parseNumstatZ(output: string): Map<string, { additions: number | null; deletions: number | null; binary: boolean }> {
  const out = new Map<string, { additions: number | null; deletions: number | null; binary: boolean }>();
  for (const raw of output.split('\0')) {
    if (!raw) continue;
    const m = raw.match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
    if (!m) continue; // 重命名的 oldPath 段等非 numstat 行 → 跳过
    const add = m[1] === '-' ? null : Number(m[1]);
    const del = m[2] === '-' ? null : Number(m[2]);
    out.set(m[3], { additions: add, deletions: del, binary: add === null && del === null });
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
    statusOut = await runGit(root, ['--no-pager', 'status', '--porcelain=v1', '-z', '--ignore-submodules', ...pathspec]);
    numstatOut = await runGit(root, ['--no-pager', 'diff', 'HEAD', '--numstat', '-z', '--ignore-submodules', ...pathspec]);
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

  return { ok: true, files, baselineRef };
}

export async function getChangeDiff(workingDir: string | null, path: string, context = 3): Promise<ChangesDiffResult> {
  if (!path) return { ok: false, reason: 'no-such-file', message: '未指定文件' };
  const cwd = await ensureRepo(workingDir);
  if (!cwd) {
    const r = await detectReason(workingDir ?? '.');
    if (r.ok) return { ok: false, reason: 'not-a-repo', message: '当前工作目录不是 git 仓库' };
    return { ok: false, reason: r.reason === 'git-unavailable' ? 'error' : 'not-a-repo', message: r.message };
  }

  let diffText = '';
  try {
    // 已跟踪文件：相对 HEAD 的净改动（含已暂存+未暂存）。
    // -U{context}：上下文行数由弹窗「上下文 3/5/10/20」选择器决定 —— git 直接给 N 行 ctx，
    // inline 不再二次折叠（避免 -U 固定大值时边界 ctx 被拆成碎 gap）；hunk 间距 >2N 时 git 自然跳过 → skip 分隔。
    const tracked = await runGitRaw(cwd, ['--no-pager', 'diff', 'HEAD', `-U${context}`, '--', path]);
    if (tracked.stdout.trim()) {
      diffText = tracked.stdout;
    } else {
      // 未跟踪文件（在改动列表里但 diff HEAD 为空）：整文件作新增。--no-index 文件不同时退出码 1。
      diffText = (await runGitRaw(cwd, ['--no-pager', 'diff', '--no-index', '--', '/dev/null', path])).stdout;
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

// 「打开」文件：走 shell.openPath 用系统默认程序打开（无默认程序则系统弹「打开方式」）。
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
  const abs = path.resolve(root, relPath);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    return { ok: false, reason: 'no-such-file', message: '文件不在仓库目录内' };
  }
  try {
    const err = await shell.openPath(abs);
    if (err) return { ok: false, reason: 'error', message: `无法打开：${err}` };
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error', message: '打开文件失败' };
  }
}
