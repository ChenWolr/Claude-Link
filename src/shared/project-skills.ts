// project-skills.ts（shared 纯函数，零 Node API 依赖）
// 项目级 Skill 管理的目录清单归一/合并/排序与 SKILL.md frontmatter 解析。
// 目录口径（2026-09-17 计划 §3.1）：listRecentWorkspaces() ∪ config.workingDirectory，
// normalizeDirKey 归一去重（Windows 大小写/斜杠不敏感）→ isDefault 置顶 + basename 字典序；
// 磁盘存在性过滤与会话计数在主进程 modules/project-skills.ts（fs 依赖不进 shared）。

import type { ProjectDirEntry, SkillProjectDirsPayload } from './types/command';

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
 * D-1（review 2026-09-18 §3-3）：skillOverrides 死键识别——键 ∈ overrides 但 ∉ 已知全集者列为
 * 「疑似失效」。已知全集 = 全局 userSkills 开关键集（R-1 起目录名口径，调用方传 skillKey 键集）
 * ∪ 已枚举项目目录 skills 的开关键集（目录名）；未挂载项目目录的键不在全集内、同样会被列出
 * （防误删由清理入口的确认步骤兜底），不做自动清理。
 * 纯函数；键比较区分大小写（与 skillOverrides 键空间口径一致）。
 */
export function findStaleSkillKeys(
  overrides: Record<string, 'off'> | null | undefined,
  globalSkillNames: string[],
  projectDirKeys: string[],
): string[] {
  if (!overrides) return [];
  const known = new Set<string>(globalSkillNames);
  for (const key of projectDirKeys) known.add(key);
  return Object.keys(overrides).filter((key) => !known.has(key));
}

/**
 * X-1（2026-09-19 Skill 修复独立评审 §2 X-1）：D-1「清理失效键」入口的数据就绪门控。
 * 三个「假失效」窗口——①全局快照非 ready（degraded/error 失败出口 commands=[]，全局禁用键被
 * 全数误判失效）②项目目录 pending/error（项目侧键集缺席/滞留旧值）
 * ③fm 名→目录名映射未就绪（fm≠dir 条目回退 slash 名键，目录名历史键被误判失效，与 X-2 同根）
 * ——任一成立时已知全集不完整，调用方（ConfigPage staleSkillKeys）应恒返回 []：清理入口不渲染、
 * cleanupStaleSkillKeys 空转，防确认弹窗诱导误删有效禁用键。
 * Y-2（2026-09-19 X-123 批独立评审 §2）：empty 快照放行——empty 是探测**成功**的合法终态
 * （setGlobalFallback/replace：commands.length>0 ? 'ready' : 'empty'），该态全局命令集真空、
 * overrides 中的键确为真失效键（全集只剩项目键，语义仍安全），不再随「非 ready 一刀」拒绝；
 * degraded/error（失败出口同为 commands=[]，不可作全集依据）与 loading 维持拒绝。
 * 纯函数：快照 ready|empty + 目录装载空闲无错 + 映射至少成功装载一次 才放行（ConfigPage 消费
 * 形态为源形钉，见 tdd-skill-x123-verify ①）。
 */
export function isStaleKeyScanReady(input: {
  snapshotStatus: string | null | undefined;
  projectDirsPending: boolean;
  projectDirsError: string | null | undefined;
  userSkillDirNamesReady: boolean;
}): boolean {
  return (
    (input.snapshotStatus === 'ready' || input.snapshotStatus === 'empty') &&
    !input.projectDirsPending &&
    !input.projectDirsError &&
    input.userSkillDirNamesReady
  );
}

/**
 * R-1（review 2026-09-18 验收 §3 R-1）：按 fm 名→目录名映射为 user-skill 快照条目补 dirName
 * （引擎 skillOverrides 键空间=目录名；快照条目名=slash 名=frontmatter 名，快照无目录名）。
 * fm 名精确匹配（区分大小写，与 skillOverrides 键空间口径一致，hasOwnProperty 防原型链误取）；
 * 无命中条目 dirName=undefined——下游 skillKey（dirName ?? name）自动回退 slash 名
 * （fm==dir 公共形态与「映射不可得」均如此，渲染层口径不散改）。
 * 纯函数：返回新数组新对象，不改入参。
 */
export function attachUserSkillDirNames<T extends { name: string }>(
  items: T[],
  nameToDir: Record<string, string> | null | undefined,
): Array<T & { dirName?: string }> {
  return items.map((it) => ({
    ...it,
    dirName:
      nameToDir && Object.prototype.hasOwnProperty.call(nameToDir, it.name) ? nameToDir[it.name] : undefined,
  }));
}

/**
 * C-5/E-7（review 2026-09-18 §3-7 + §7 裸奔点收口）：SKILL_PROJECT_DIRS_GET 装载状态机
 * （shared 纯逻辑，渲染层 ensureProjectDirs 消费；E-7 契约在此做桩 reject 行为测——此前
 * handler 无 try/catch、渲染 catch 吞到无形）。
 * resolve → { ok:true, dirs, userSkillDirNames, userSkillDirNamesTimedOut }（R-1 起透传全局
 * fm 名→目录名映射，缺省 {}；Y-1 起透传用户根枚举超时标记，缺省归一 false）；
 * reject（IPC 抛错）→ { ok:false, error }（Error 取 message，非 Error/空 message 归一为固定文案）
 * ——调用方据 ok 分支写 projectDirs/commandStore.userSkillDirNames；超时态（Y-1）不覆盖映射槽、
 * 不置就绪旗标，与「合法空」在载荷层区分。
 */
export async function loadSkillProjectDirs(
  fetcher: () => Promise<SkillProjectDirsPayload>,
): Promise<
  | {
      ok: true;
      dirs: ProjectDirEntry[];
      userSkillDirNames: Record<string, string>;
      userSkillDirNamesTimedOut: boolean;
    }
  | { ok: false; error: string }
> {
  try {
    const payload = await fetcher();
    return {
      ok: true,
      dirs: payload.dirs,
      userSkillDirNames: payload.userSkillDirNames ?? {},
      // Y-1：用户根枚举超时标记透传（缺省归一 false——旧载荷/非超时走常规装载）。
      userSkillDirNamesTimedOut: payload.userSkillDirNamesTimedOut === true,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error && e.message ? e.message : '项目目录读取失败，请重试' };
  }
}

/**
 * frontmatter 解析（P2-3 对齐引擎真实 YAML 解析下限，2026-09-18）：
 * /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/ 提首块——开分隔符容尾空白/制表
 * （`---␣` 是合法 YAML，引擎可加载，管理页不得跳过）；闭分隔符锚定到行尾（`---more` 不误闭合，
 * 正文 `---` 不会被误切）；无分隔符返回 null（调用方跳过该文件——引擎亦不加载）。
 * 块内逐行 ^(name|description):\s*(.*)$；值先剥行内注释（引号感知扫描器 stripInlineComment：
 * 引号外遇「空白 + #」截断其后内容，引号内 # 保留，无空白前 # 保留如 `a#b`），再 trim、
 * 剥成对包裹引号（" 或 ' 各一层，不成对保留原值）；其余键忽略。
 * 已知限制（review §2 P2-3 方案 1d，维持不改）：多行块标量（`name: |`）只取首行字面，
 * 与引擎按 YAML 展开多行的解析值不一致——该形态罕见，登记为已知分歧。
 */
const FRONTMATTER_RE = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?=\r?\n|$)/;

export function parseSkillFrontmatter(content: string): { name: string | null; description: string | null } | null {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) return null;
  let name: string | null = null;
  let description: string | null = null;
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(name|description):\s*(.*)$/.exec(line);
    if (!kv) continue;
    const value = stripWrappingQuotes(stripInlineComment(kv[2]).trim());
    if (kv[1] === 'name' && name === null) name = value;
    else if (kv[1] === 'description' && description === null) description = value;
  }
  return { name, description };
}

/** 行内注释剥离（引号感知）：遍历字符跟踪引号状态（"/'），引号外遇「空白 + #」截断其后内容。 */
function stripInlineComment(v: string): string {
  let quote: string | null = null;
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && i > 0 && /\s/.test(v[i - 1])) {
      return v.slice(0, i);
    }
  }
  return v;
}

function stripWrappingQuotes(v: string): string {
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) {
    return v.slice(1, -1);
  }
  return v;
}
