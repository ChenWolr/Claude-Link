// project-skills.ts（主进程 fs 枚举 + 聚合；R-1 起全链 async）
// 项目级 Skill 管理的数据源：每目录直读 <dir>\.claude\skills\<子目录>\SKILL.md，
// parseSkillFrontmatter 解析 name/description（无 frontmatter 分隔符 → 跳过该文件，
// 引擎亦不加载）；不走引擎逐目录探测（globalSnapshot 探测 cwd 固定 = 默认工作区，
// 逐目录 spawn CLI 每目录一次引擎冷启；文件系统直读与引擎加载 project skill 的
// 目录约定一致，零成本、可测——管理页显示「磁盘全集 + 开关控制」）。
// R-1（2026-09-19）：全局作用域同法直读 ~/.claude/skills（collectUserSkillDirNames，
// 产 fm 名→目录名映射供开关键=目录名口径与 '/' 菜单过滤同源消费）。
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
 * P2-4 坏目录负缓存：stat **超时**（非抛错）的目录记 60s TTL，期内直接跳过——不再消耗 3s
 * 预算、不再重复占用 libuv 线程池（不可达 UNC 首次触达实测单次 stat 占线程 ~31s，默认池 4 线）。
 * 仅超时进缓存：stat 抛错（ENOENT/权限）不缓存——存在性过滤需要每次确认，新目录 60s 内可见。
 * now 参数可注入（契约脚本行为级验证）；TTL 过期读时惰性清除（自愈）。
 */
export const BAD_DIR_TTL_MS = 60_000;
const badDirUntil = new Map<string, number>();

export function badDirCacheMark(dir: string, now: number = Date.now()): void {
  badDirUntil.set(normalizeDirKey(dir), now + BAD_DIR_TTL_MS);
}

export function badDirCacheHas(dir: string, now: number = Date.now()): boolean {
  const key = normalizeDirKey(dir);
  const until = badDirUntil.get(key);
  if (until === undefined) return false;
  if (now >= until) {
    badDirUntil.delete(key);
    return false;
  }
  return true;
}

/**
 * 项目作用域单目录枚举（§3.2 口径）：直读 <dir>\.claude\skills，主体在 enumerateSkillsRoot
 * （R-1 起抽出——全局作用域 collectUserSkillDirNames 以同一主体直读 ~/.claude/skills，
 * junction/symlink/大小写去重等口径天然同源）。
 */
export async function enumerateProjectSkills(dir: string): Promise<Array<{ name: string; dirName: string; description: string }>> {
  return enumerateSkillsRoot(path.join(dir, '.claude', 'skills'));
}

/**
 * 单 skills 根目录枚举（§3.2 口径）：skillsRoot 不存在/读失败 → []；单 skill 读失败 → 跳过该 skill；
 * SKILL.md 无 frontmatter 分隔符 → 跳过；name 缺省子目录名、description 缺省空串；按 name 字典序。
 * R-2：排序后按 name 去重（first-wins，取排序后首见）——skillOverrides 按名开关键空间，
 * 同名 skill 无法独立控制，管理页同目录同名只保留一条，渲染层 v-for :key 亦不重复。
 * A-1（P2-4）：SKILL.md 按字节读前 8192B（Buffer.alloc(8192)+filehandle.read），不再全文读入
 * ——巨文件内存有界、单文件不再吃光整目录预算；frontmatter 闭合在 8192B 后的维持跳过
 * （既有语义，多字节截断尾部由 UTF-8 解码容错替换，不影响首块匹配）。
 */
async function enumerateSkillsRoot(skillsRoot: string): Promise<Array<{ name: string; dirName: string; description: string }>> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(skillsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: Array<{ name: string; dirName: string; description: string }> = [];
  for (const entry of entries) {
    // D-4（review 2026-09-18 §3-4）：junction/dir-symlink 对齐引擎口径——引擎双通道均加载
    // junction 形态的 skill 目录（V1 实测裁决），旧「仅 isDirectory()」口径漏列。对 symlink 条目
    // fs.stat 跟随判定目标为目录；断链（stat 抛错）与非目录目标维持跳过。
    // 口径反转申报：这是对旧「跳 symlink」判定的有意反转——枚举只读 SKILL.md（无执行面），
    // stat 跟随单层无环风险（readdir 不递归）。
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) {
      try {
        isDir = (await fs.stat(path.join(skillsRoot, entry.name))).isDirectory();
      } catch {
        isDir = false; // 断链/不可达 → 跳过（与读失败静默剔除同语义）
      }
    }
    if (!isDir) continue;
    let content: string;
    try {
      const fh = await fs.open(path.join(skillsRoot, entry.name, 'SKILL.md'), 'r');
      try {
        const buf = Buffer.alloc(8192);
        const { bytesRead } = await fh.read(buf, 0, 8192, 0);
        content = buf.toString('utf8', 0, bytesRead);
      } finally {
        await fh.close();
      }
    } catch {
      continue;
    }
    const fm = parseSkillFrontmatter(content);
    if (!fm) continue;
    // 空/纯空白 name 视同缺省回退子目录名（「name 缺省用子目录名」口径的空值推广；
    // `?.trim()` 兼顾引号包裹纯空白形态——parse 层剥引号后不二次 trim，`"  "` 直通为空白）。
    // P2-3 键名口径（2026-09-18 Phase 0-2 实验裁决）：引擎 skillOverrides 只认目录名——dirName
    // 恒等于真实子目录名，渲染层开关键走 dirName；排序/去重键维持 name（frontmatter 名）不变。
    out.push({ name: fm.name?.trim() ? fm.name : entry.name, dirName: entry.name, description: fm.description ?? '' });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  // D-6（review 2026-09-18 §3-5）：去重键改 toLowerCase——与引擎 SDK 注册表的小写去重口径一致
  //（旧严格相等口径对仅大小写不同的同名对产出双条目）。first-wins 保留排序胜者原串展示；
  // 胜者拼写由 localeCompare 的 case tie-break 决定（ICU 小写在先），契约不钉拼写只钉归一条数。
  const seen = new Set<string>();
  const deduped: Array<{ name: string; dirName: string; description: string }> = [];
  for (const s of out) {
    const dedupKey = s.name.toLowerCase();
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);
    deduped.push(s);
  }
  return deduped;
}

/**
 * R-1（review 2026-09-18 验收 §3 R-1）：全局作用域（~/.claude/skills）skill 的 frontmatter 名→
 * 目录名映射（引擎 skillOverrides 键空间=目录名的数据源）。复用 enumerateSkillsRoot 枚举口径
 * （junction/symlink 跟随、大小写同名去重、空 name 回退子目录名同款）——枚举已按 name 小写
 * 去重（first-wins），同名 fm 冲突在此天然 first-wins 无二义。skillsRoot 作参数由 handler 侧
 * 组装（path.join(os.homedir(), '.claude', 'skills')），本函数不硬编码用户目录——契约以临时
 * 夹具直测；skillsRoot 不存在/读失败 → 空对象。载体用 null 原型对象（B-2 同款理由：fm 名恰为
 * __proto__ 时普通对象赋值走原型 setter 静默 no-op；经 IPC structured clone 归一为普通对象，
 * 渲染层安全）。
 * X-3（2026-09-19 Skill 修复独立评审 §2 X-3）：调用侧治理封装在本模块导出内（与项目路径
 * collectSkillProjectDirs/collectInFlight 同构，SKILL_PROJECT_DIRS_GET handler 调用形态不变）——
 * ①整根枚举套 withTimeout(…, 3000)：D-4 起枚举跟随 symlink/junction，坏链接指向不可达网络位置时
 * 单条 stat/open 可占线程数十秒（P2-4 实测 31s 量级），无预算会拖挂整个 handler。②并发调用共享
 * 独立单槽 userDirNamesInFlight（rootDir 恒定无需键控），finally 条件清空；快速反复进 tab 的并发
 * 查询不再各自全量枚举。
 * Y-1（2026-09-19 X-123 批独立评审 §2）：超时与「合法空」在载荷层区分——超时（withTimeout 归
 * null）resolve **null 哨兵**。X-3 初版 `?? []` 让超时以空映射正常 resolve，「ready+空映射」使
 * 渲染层 X-1 假失效与 X-2 无效键写入复活——X-1 门控挡的是「未装载」，挡不住「装载成功但内容为
 * 空」（初版注释误断该门控可挡超时空映射，论断不成立，随本批修正）；「skillsRoot 不存在/读
 * 失败 → 空对象」既有语义原样保留（合法空 ≠ 超时，下游可区分）。枚举器/超时预算可注入（inject，
 * badDirCache now 注入先例同款 seam——超时行为不可稳定复现，契约以永不落定枚举器+极小预算受控
 * 触发验证哨兵）；包装返回 Promise<Record<string, string> | null>，handler 据此落载荷
 * userSkillDirNamesTimedOut 标记（渲染层超时不覆盖映射槽/不置就绪旗标）。
 */
type UserDirNamesInject = {
  enumerator?: (root: string) => Promise<Array<{ name: string; dirName: string; description: string }>>;
  timeoutMs?: number;
};

let userDirNamesInFlight: Promise<Record<string, string> | null> | null = null;

export async function collectUserSkillDirNames(
  skillsRoot: string,
  inject?: UserDirNamesInject,
): Promise<Record<string, string> | null> {
  if (userDirNamesInFlight) return userDirNamesInFlight;
  const promise = collectUserSkillDirNamesUncached(skillsRoot, inject).finally(() => {
    if (userDirNamesInFlight === promise) userDirNamesInFlight = null;
  });
  userDirNamesInFlight = promise;
  return promise;
}

async function collectUserSkillDirNamesUncached(
  skillsRoot: string,
  inject?: UserDirNamesInject,
): Promise<Record<string, string> | null> {
  const enumerate = inject?.enumerator ?? enumerateSkillsRoot;
  const skills = await withTimeout(enumerate(skillsRoot), inject?.timeoutMs ?? 3000);
  if (skills === null) return null;
  const out = Object.create(null) as Record<string, string>;
  for (const s of skills) out[s.name] = s.dirName;
  return out;
}

// P2-4 in-flight 共享：SKILL_PROJECT_DIRS_GET 无去重时，快速反复进 tab 的并发查询各自全量
// stat×N + 枚举，叠加不可达目录可占满线程池。并发调用共享同一在飞 Promise（兼修渲染层并发
// 乱序回写），finally 清空；共享槽为单槽（保最近一次调用），后到调用共享前者的结果。
let collectInFlight: Promise<ProjectDirEntry[]> | null = null;

/**
 * 聚合入口（SKILL_PROJECT_DIRS_GET handler 唯一调用点，R-1 起 async；P2-4 起并发共享）：
 * mergeProjectDirs → sortProjectDirs → 逐目录存在性过滤（withTimeout 包 fs.stat，3s 预算：
 * 超时归 null / stat 抛错 / 非目录一律剔除——「磁盘上已删除的目录不再显示」的网络路径推广，
 * 工作区历史记录本身不动）→ enumerateProjectSkills（整目录 readdir+逐 SKILL.md 读取同享
 * 3s 预算，超时 skills=[]，与空态引导同语义）→ 并入 sessionCounts
 * （键 = normalizeDirKey 匹配并聚合，sessions 表原文与 recentDirs 写法可能不同）。
 * P2-4：负缓存期内目录直接跳过；仅 stat 超时进负缓存（抛错=ENOENT/权限不缓存）。
 */
export async function collectSkillProjectDirs(input: {
  recentDirs: string[];
  defaultDir: string | null;
  sessionCounts: Map<string, number>;
}): Promise<ProjectDirEntry[]> {
  if (collectInFlight) return collectInFlight;
  const promise = collectSkillProjectDirsUncached(input).finally(() => {
    if (collectInFlight === promise) collectInFlight = null;
  });
  collectInFlight = promise;
  return promise;
}

async function collectSkillProjectDirsUncached(input: {
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
    if (badDirCacheHas(d.path)) continue;
    let st: Stats | null = null;
    let statTimedOut = false;
    try {
      st = await withTimeout(fs.stat(d.path));
      if (st === null) statTimedOut = true; // withTimeout 超时归 null；抛错（ENOENT/权限）走 catch
    } catch {
      st = null;
    }
    if (st === null) {
      if (statTimedOut) badDirCacheMark(d.path);
      continue;
    }
    if (!st.isDirectory()) continue;
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
