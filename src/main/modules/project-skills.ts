// project-skills.ts（主进程 fs 枚举 + 聚合；R-1 起全链 async）
// 项目级 Skill 管理的数据源：每目录直读 <dir>\.claude\skills\<子目录>\SKILL.md，
// parseSkillFrontmatter 解析 name/description（无 frontmatter 分隔符 → 跳过该文件，
// 引擎亦不加载）；不走引擎逐目录探测（globalSnapshot 探测 cwd 固定 = 默认工作区，
// 逐目录 spawn CLI 每目录一次引擎冷启；文件系统直读与引擎加载 project skill 的
// 目录约定一致，零成本、可测——管理页显示「磁盘全集 + 开关控制」）。
// 所有失败路径（目录被删/无权限/坏文件/超时）一律静默剔除，管理页不报错。

import * as fs from 'node:fs/promises';
import type { Dirent, Stats } from 'node:fs';
import * as path from 'node:path';
import { basenameOfDir, mergeProjectDirs, normalizeDirKey, parseSkillFrontmatter, sortProjectDirs } from '../../shared/project-skills';
import type { ProjectDirEntry } from '../../shared/types/command';

/**
 * R-1 超时预算 helper：Promise.race 竞速，超时归 null（finally 中 clearTimeout 清理定时器）。
 * 3s 预算针对不可达 UNC/断连映射盘——Windows 对不可达网络主机的同步 stat 阻塞数秒~数十秒，
 * 曾会让整个 IPC handler 同步占死主进程；本地路径 stat/枚举亚毫秒，预算不受影响。
 * 同一坏目录每次进 tab 仍会消耗一次 3s 预算（目录至多 13：recent ≤12 + 独立 defaultDir，可接受）。
 */
async function withTimeout<T>(p: Promise<T>, ms = 3000): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 单目录枚举（§3.2 口径）：skillsRoot 不存在/读失败 → []；单 skill 读失败 → 跳过该 skill；
 * SKILL.md 无 frontmatter 分隔符 → 跳过；name 缺省子目录名、description 缺省空串；按 name 字典序。
 * R-2：排序后按 name 去重（first-wins，取排序后首见）——skillOverrides 按名开关键空间，
 * 同名 skill 无法独立控制，管理页同目录同名只保留一条，渲染层 v-for :key 亦不重复。
 */
export async function enumerateProjectSkills(dir: string): Promise<Array<{ name: string; description: string }>> {
  const skillsRoot = path.join(dir, '.claude', 'skills');
  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; description: string }> = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(skillsRoot, entry.name, 'SKILL.md'), 'utf8');
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(content.slice(0, 8192));
    if (!fm) continue;
    // 空/纯空白 name 视同缺省回退子目录名（「name 缺省用子目录名」口径的空值推广；
    // `?.trim()` 兼顾引号包裹纯空白形态——parse 层剥引号后不二次 trim，`"  "` 直通为空白）。
    out.push({ name: fm.name?.trim() ? fm.name : entry.name, description: fm.description ?? '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  const seen = new Set<string>();
  const deduped: Array<{ name: string; description: string }> = [];
  for (const s of out) {
    if (seen.has(s.name)) continue;
    seen.add(s.name);
    deduped.push(s);
  }
  return deduped;
}

/**
 * 聚合入口（SKILL_PROJECT_DIRS_GET handler 唯一调用点，R-1 起 async）：
 * mergeProjectDirs → sortProjectDirs → 逐目录存在性过滤（withTimeout 包 fs.stat，3s 预算：
 * 超时归 null / stat 抛错 / 非目录一律剔除——「磁盘上已删除的目录不再显示」的网络路径推广，
 * 工作区历史记录本身不动）→ enumerateProjectSkills（整目录 readdir+逐 SKILL.md 读取同享
 * 3s 预算，超时 skills=[]，与空态引导同语义）→ 并入 sessionCounts
 * （键 = normalizeDirKey 匹配并聚合，sessions 表原文与 recentDirs 写法可能不同）。
 */
export async function collectSkillProjectDirs(input: {
  recentDirs: string[];
  defaultDir: string | null;
  sessionCounts: Map<string, number>;
}): Promise<ProjectDirEntry[]> {
  const countsByKey = new Map<string, number>();
  for (const [rawDir, count] of input.sessionCounts) {
    const key = normalizeDirKey(rawDir);
    countsByKey.set(key, (countsByKey.get(key) ?? 0) + count);
  }
  const out: ProjectDirEntry[] = [];
  for (const d of sortProjectDirs(mergeProjectDirs(input.recentDirs, input.defaultDir))) {
    let st: Stats | null = null;
    try {
      st = await withTimeout(fs.stat(d.path));
    } catch {
      st = null;
    }
    if (!st || !st.isDirectory()) continue;
    const skills = (await withTimeout(enumerateProjectSkills(d.path), 3000)) ?? [];
    out.push({
      path: d.path,
      name: basenameOfDir(d.path),
      isDefault: d.isDefault,
      sessionCount: countsByKey.get(normalizeDirKey(d.path)) ?? 0,
      skills,
    });
  }
  return out;
}
