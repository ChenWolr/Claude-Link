// project-skills.ts（shared 纯函数，零 Node API 依赖）
// 项目级 Skill 管理的目录清单归一/合并/排序与 SKILL.md frontmatter 解析。
// 目录口径（2026-09-17 计划 §3.1）：listRecentWorkspaces() ∪ config.workingDirectory，
// normalizeDirKey 归一去重（Windows 大小写/斜杠不敏感）→ isDefault 置顶 + basename 字典序；
// 磁盘存在性过滤与会话计数在主进程 modules/project-skills.ts（fs 依赖不进 shared）。

/** 归一键：trim + 正斜杠归反斜杠 + 去尾部分隔符 + toLowerCase（大小写/斜杠不敏感去重）。 */
export function normalizeDirKey(dir: string): string {
  return dir.trim().replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
}

/** 目录名：按 [\\/] 切尾段（win32/posix 兼容；不用 path 模块以保持纯函数）。 */
export function basenameOfDir(dir: string): string {
  const parts = dir.trim().split(/[\\/]+/).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : dir.trim();
}

/**
 * 合并：recentDirs 保序在前，defaultDir 并入；normalizeDirKey 相同视为同一目录，
 * 命中默认目录时该条 isDefault=true（显示串保留 recentDirs 中的原串；
 * 若仅存在于 defaultDir 则用其原串）。空串/空白条目跳过；defaultDir=null 仅 recent。
 */
export function mergeProjectDirs(recentDirs: string[], defaultDir: string | null): Array<{ path: string; isDefault: boolean }> {
  const out: Array<{ path: string; isDefault: boolean }> = [];
  const byKey = new Map<string, { path: string; isDefault: boolean }>();
  const defaultKey = defaultDir && defaultDir.trim() ? normalizeDirKey(defaultDir) : null;
  for (const dir of recentDirs) {
    if (!dir || !dir.trim()) continue;
    const key = normalizeDirKey(dir);
    if (byKey.has(key)) continue;
    const entry = { path: dir, isDefault: key === defaultKey };
    byKey.set(key, entry);
    out.push(entry);
  }
  if (defaultKey !== null && !byKey.has(defaultKey)) {
    const entry = { path: defaultDir as string, isDefault: true };
    byKey.set(defaultKey, entry);
    out.push(entry);
  }
  return out;
}

/** 排序：isDefault 置顶，其余按 basenameOfDir localeCompare('zh') 字典序；返回新数组不改入参。 */
export function sortProjectDirs<T extends { path: string; isDefault: boolean }>(dirs: T[]): T[] {
  return dirs.slice().sort((a, b) => {
    if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
    return basenameOfDir(a.path).localeCompare(basenameOfDir(b.path), 'zh');
  });
}

/**
 * frontmatter 解析：/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/ 提首块；无分隔符返回 null
 * （调用方跳过该文件——引擎亦不加载）；块内逐行 ^(name|description):\s*(.*)$，
 * 值 trim 后剥成对包裹引号（" 或 ' 各一层，不成对保留原值）；其余键忽略。
 */
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---/;

export function parseSkillFrontmatter(content: string): { name: string | null; description: string | null } | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  let name: string | null = null;
  let description: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = stripWrappingQuotes(kv[2].trim());
    if (kv[1] === 'name' && name === null) name = value;
    else if (kv[1] === 'description' && description === null) description = value;
  }
  return { name, description };
}

function stripWrappingQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}
