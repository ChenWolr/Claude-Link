// mcp/mcp-scanner.ts
// MCP 扫描器（docs/plans/2026-10-12-mcp-management-plan.md §2 P3）。
// 两个职责：
//   1. 同步 raw 读取器（readUserMcpServersRawSync / readProjectMcpServersRawSync）——
//      供 sdk-mcp.ts 注入链（P5 mergeMcpServersIntoSettings 的默认 io）使用，返回**未脱敏**
//      的 ParsedMcpEntry 表（注入 SDK 需要真值；渲染层值走 collectMcpSnapshot 的脱敏视图）。
//   2. 视图收集（collectMcpSnapshot）——设置页 MCP Tab 的用户级/项目级只读展示数据源，
//      env/headers 只回 key 列表（§1.3 脱敏：值绝不进视图/渲染层）。
//
// 纯 node 模块红线（P9 selftest 直接 import 本文件跑在纯 node 下）：
//   不 import electron、不 import sdk-backend、不 import 数据库 repo；heavy 依赖一律经
//   CollectMcpSnapshotDeps 注入（用户根、默认目录判定、recent 工作区、会话计数
//   sessionRepo.listWorkingDirCounts、坏目录负缓存 badDirCacheHas/badDirCacheMark——
//   与 Skill 共用同一缓存实例，语义同「目录不可达 60s 负缓存」）。
// 同步 raw 读取器的失败路径（文件不存在/损坏/无 mcpServers 键/读取异常）一律静默返回
// 空表（不抛错）——raw 读取器本身不区分失败形态；视图层才需要 userScopeError（collectMcpSnapshot
// 自行 async 读 + 分类，不经 raw 读取器）。B-1（2026-10-16）起另有 detail 包装导出
//（readProjectMcpServersDetailSync / readUserMcpServersDetailSync）向注入链暴露 readFailed
// 三态分类（ENOENT/损坏≠失败、其他读异常=失败），供默认 io 落坏目录负缓存。

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { basenameOfDir, mergeProjectDirs, normalizeDirKey, sortProjectDirs } from '../../../shared/project-skills';
import { withTimeout } from '../project-skills';
import { normalizeMcpEntry, type ParsedMcpEntry } from './mcp-config';

/** 项目级收集整体预算（与 Skill 项目目录装载同款 3s：不可达 UNC 单次 fs 调用可占线程数十秒）。 */
const PROJECT_COLLECT_BUDGET_MS = 3000;

/** 用户级 .claude.json 解析失败的提示（§3.5：空列表 + 一句话中文提示，不抛错不写文件）。 */
const USER_SCOPE_PARSE_ERROR =
  '用户级配置文件解析失败（~/.claude.json），已按空列表展示；请检查该文件是否为合法 JSON。';
/** 用户级文件读取失败（ENOENT 之外，如权限）——同样空列表 + 提示，与「不存在=正常空态」区分。 */
const USER_SCOPE_READ_ERROR = '用户级配置文件读取失败（~/.claude.json），已按空列表展示。';

// ── 视图类型（§2 P3）────────────────────────────────────────────────────────

/** 作用域条目视图：继承 ParsedMcpEntry 形状，但构造时【不携带 env/headers 值】（§1.3），只带 key 列表。 */
export interface McpScopedServerView extends ParsedMcpEntry {
  scope: 'user' | 'project';
  maskedEnvKeys?: string[];
  maskedHeaderKeys?: string[];
}

/** 项目目录视图（Skill ProjectDirEntry 同构：path/name/isDefault/sessionCount + 本目录服务器）。 */
export interface McpProjectDirView {
  path: string;
  name: string;
  isDefault: boolean;
  sessionCount: number;
  servers: McpScopedServerView[];
}

/** MCP Tab 快照：用户级列表 + 项目目录列表（+ 可选用户级错误提示）。 */
export interface McpSnapshot {
  userServers: McpScopedServerView[];
  projectDirs: McpProjectDirView[];
  userScopeError?: string;
}

/** collectMcpSnapshot 的 heavy 依赖注入（ipc-handlers 调用点负责装配，本模块零单例耦合）。 */
export interface CollectMcpSnapshotDeps {
  /** 用户根（调用点传 effectiveUserHome() ?? os.homedir()）；null → 用户级按空列表处理。 */
  userHome: string | null;
  /** 默认目录判定注入（与 defaultWorkingDir/mergeProjectDirs 的 isDefault 取或）。 */
  isDefaultDir: (dir: string) => boolean;
  /** 最近工作区列表（调用点传 listRecentWorkspaces()）。 */
  recentWorkspaces: string[];
  /** 默认工作目录（调用点传 getConfig().workingDirectory ?? null）。 */
  defaultWorkingDir: string | null;
  /** 会话计数来源（sessionRepo.listWorkingDirCounts——working_dir 原文分组，归一匹配在本模块做）。 */
  listWorkingDirCounts: () => Map<string, number>;
  /** 坏目录负缓存查询（project-skills.badDirCacheHas 同实例注入）。 */
  badDirHas: (dir: string) => boolean;
  /** 坏目录负缓存标记（project-skills.badDirCacheMark 同实例注入；非 ENOENT 读异常时调用）。 */
  badDirMark: (dir: string) => void;
}

// ── 同步 raw 读取器（sdk-mcp 注入链用；未脱敏）──────────────────────────────

/** 顶层 mcpServers 表提取：根非对象 / 表缺失 / 表非普通对象 → null。 */
function extractMcpServersTable(root: unknown): Record<string, unknown> | null {
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return null;
  const table = (root as Record<string, unknown>).mcpServers;
  if (typeof table !== 'object' || table === null || Array.isArray(table)) return null;
  return table as Record<string, unknown>;
}

/**
 * 单文件直读归一（详细态）：readFileSync → JSON.parse → 顶层 mcpServers → 逐条 normalizeMcpEntry。
 * 返回 data（归一表；文件不存在/损坏/无键/读取异常 → 空表，不抛错）、unreadable 标记
 * （true = 读取异常或 JSON 损坏，即「未读到有效内容」——该形态的结果不落 mtime 缓存，
 * 下次仍重试；合法 JSON 但无 mcpServers 键属有效内容，可缓存）与 readFailed 标记
 * （B-1，2026-10-16：true = readFileSync 抛错且【非 ENOENT】——注入链据此落坏目录负缓存。
 * 三态分类与视图链 collectProjectDirsInto 口径一致：ENOENT=正常空态≠失败、JSON 损坏=空表≠失败
 * （视图链损坏亦不 badDir）、其他读异常（权限/被占用等）=失败可负缓存。
 * isEnoent 为 function 声明（提升），先于其定义行使用无碍。）
 * 载体用 Object.create(null)：磁盘 JSON 的 map 键不可信（可能恰为 __proto__），普通对象载体
 * 赋值走原型 setter（静默 no-op / 污染面），null 原型载体下写入只是普通自有属性
 * （sanitizeMcpOverridesConfig 同款手法）。
 */
function readMcpServersFileSyncDetail(file: string): { data: Record<string, ParsedMcpEntry>; unreadable: boolean; readFailed: boolean } {
  const out = Object.create(null) as Record<string, ParsedMcpEntry>;
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    // ENOENT（不存在）= 正常空态不置 readFailed；其他读异常 → readFailed（注入链落负缓存）
    return { data: out, unreadable: true, readFailed: !isEnoent(e) }; // 不存在/不可读 → 空表（§3.5/§3.6：不抛错不写文件）
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { data: out, unreadable: true, readFailed: false }; // 损坏 → 空表且不缓存（是否提示由视图层 collectMcpSnapshot 分类）
  }
  const table = extractMcpServersTable(root);
  if (!table) return { data: out, unreadable: false, readFailed: false };
  for (const [name, rawCfg] of Object.entries(table)) {
    const entry = normalizeMcpEntry(name, rawCfg);
    if (entry) out[name] = entry;
  }
  return { data: out, unreadable: false, readFailed: false };
}

/** 单文件直读归一（薄壳：丢弃 unreadable 标记；行为与拆分前逐字节等价——项目级读取器沿用现状不缓存）。 */
function readMcpServersFileSync(file: string): Record<string, ParsedMcpEntry> {
  return readMcpServersFileSyncDetail(file).data;
}

// ── 用户级 raw 读取 mtime 缓存（R2）────────────────────────────────────────
// 边界声明（docs/plans/2026-10-13-mcp-followup-plan.md R2 / §75）：
//   1. mtime 相同内容变（同毫秒写回）→ 允许陈旧一拍（mtimeMs 粒度所限，接受）；
//   2. 并发读同文件 → 同步函数在事件循环内天然串行，无需加锁。

/** 用户级 .claude.json raw 读取缓存：key = 文件绝对路径 → { statSync mtimeMs, 归一结果 }。 */
const mcpRawCache = new Map<string, { mtimeMs: number; data: Record<string, ParsedMcpEntry> }>();

/** 清空用户级 raw 读取缓存（供测试与外部失效用；项目级 .mcp.json 本就不缓存）。 */
export function clearMcpRawCache(): void {
  mcpRawCache.clear();
}

/**
 * 用户级 ~/.claude.json 顶层 mcpServers 原样读取（同步；不存在/损坏/无键 → {}）。
 * R2 mtime 缓存：先 statSync 取 mtimeMs → 缓存命中且未变 → 缓存直出（会话启动链频繁调用
 * 省去重复 IO）；未命中/变化 → 直读+归一后写缓存再返回。缓存 key 用 path.resolve 绝对路径
 * （相对/绝对混用不串味）；文件不存在/不可 stat → 走直读现状路径且不缓存；损坏（parse 失败）
 * → 静默 {} 且不缓存（下次仍重试，selftest G5 以同 mtime 钉回断言钉死）。
 */
export function readUserMcpServersRawSync(userHome: string): Record<string, ParsedMcpEntry> {
  const file = path.resolve(userHome, '.claude.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return readMcpServersFileSync(file); // 不可 stat（不存在/权限）→ 现状直读路径，不缓存
  }
  const hit = mcpRawCache.get(file);
  // 缓存直出为共享引用：调用方不得变异返回表（当前全链只读；变异会污染缓存）。
  if (hit && hit.mtimeMs === mtimeMs) return hit.data;
  const { data, unreadable } = readMcpServersFileSyncDetail(file);
  if (!unreadable) mcpRawCache.set(file, { mtimeMs, data });
  return data;
}

/** 项目级 <dir>/.mcp.json 顶层 mcpServers 原样直读（同步；不存在/损坏/无键 → {}）。 */
export function readProjectMcpServersRawSync(dir: string): Record<string, ParsedMcpEntry> {
  return readMcpServersFileSync(path.join(dir, '.mcp.json'));
}

// ── detail 包装导出（B-1，2026-10-16；sdk-mcp 注入链默认 io 的坏目录负缓存用）──────

/**
 * 项目级 <dir>/.mcp.json 直读详细态包装：servers（归一表，同 readProjectMcpServersRawSync）
 * + readFailed（readFileSync 抛错且非 ENOENT；ENOENT=正常空态 false、JSON 损坏=false，
 * 与视图链 badDir 判定口径一致——调用方仅在 readFailed 时落坏目录负缓存）。
 * 纯增量包装（B-1）：内部即 readMcpServersFileSyncDetail，不改变既有 raw 读取器行为；
 * 项目级本就不走 mtime 缓存（每次直读），与 readProjectMcpServersRawSync 语义一致。
 */
export function readProjectMcpServersDetailSync(dir: string): {
  servers: Record<string, ParsedMcpEntry>;
  readFailed: boolean;
} {
  const { data, readFailed } = readMcpServersFileSyncDetail(path.join(dir, '.mcp.json'));
  return { servers: data, readFailed };
}

/**
 * 用户级 <userHome>/.claude.json 直读详细态包装：servers + readFailed（同上三态分类）。
 * D2（2026-10-16）起走 R2 mtime 缓存 read-through（与 readUserMcpServersRawSync 共享同一
 * mcpRawCache 实例）：先 statSync 取 mtimeMs → 命中且未变 → 缓存直出（缓存只存成功读
 * !unreadable，mtime 未变 ⇒ 再读也会成功，readFailed=false 成立）；未命中/变化 → 直读，
 * unreadable/readFailed 形态不落缓存——失败重试语义保留，坏目录由调用方（sdk-mcp 默认 io）
 * 的负缓存兜底（60s 内 badDirCacheHas 前置短路，不再触盘）；不可 stat（不存在/权限）→
 * 走直读 detail 现状路径且不缓存。路径解析与 readUserMcpServersRawSync 同款 path.resolve，
 * 两读取器对同一文件口径一致（同 file 同 mtime 直出同一 data 共享引用，调用方不得变异）。
 */
export function readUserMcpServersDetailSync(userHome: string): {
  servers: Record<string, ParsedMcpEntry>;
  readFailed: boolean;
} {
  const file = path.resolve(userHome, '.claude.json');
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    // 不可 stat（不存在/权限）→ 直读 detail 现状路径（三态分类照旧），不缓存
    const miss = readMcpServersFileSyncDetail(file);
    return { servers: miss.data, readFailed: miss.readFailed };
  }
  const hit = mcpRawCache.get(file);
  // 缓存直出为共享引用：调用方不得变异返回表（当前全链只读；变异会污染缓存）。
  if (hit && hit.mtimeMs === mtimeMs) return { servers: hit.data, readFailed: false };
  const d = readMcpServersFileSyncDetail(file);
  if (!d.unreadable) mcpRawCache.set(file, { mtimeMs, data: d.data });
  return { servers: d.data, readFailed: d.readFailed };
}

// ── 视图收集（collectMcpSnapshot；脱敏）────────────────────────────────────

/**
 * ParsedMcpEntry → 脱敏视图：显式重建输出对象（不透传 env/headers 值——§1.3「渲染层永不
 * 接触明文」），值侧仅保留 key 列表（maskedEnvKeys/maskedHeaderKeys；无 env/headers 时键省略）。
 */
function toMaskedView(entry: ParsedMcpEntry, scope: 'user' | 'project'): McpScopedServerView {
  const view: McpScopedServerView = { scope, name: entry.name, transport: entry.transport };
  if (entry.command !== undefined) view.command = entry.command;
  if (entry.args !== undefined) view.args = entry.args;
  if (entry.url !== undefined) view.url = entry.url;
  if (entry.env !== undefined) view.maskedEnvKeys = Object.keys(entry.env);
  if (entry.headers !== undefined) view.maskedHeaderKeys = Object.keys(entry.headers);
  return view;
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * 用户级收集（async 直读 + 失败分类——不经同步 raw 读取器，因为视图层需要区分
 * 「不存在=正常空态（无 error）」与「损坏/读失败=空列表 + userScopeError」；§3.5）。
 * mcpServers 键缺失 → 空列表无 error（合法文件只是没配 MCP）；表存在但非对象 → 同损坏处理。
 */
async function collectUserServers(
  userHome: string | null,
): Promise<{ servers: McpScopedServerView[]; error?: string }> {
  if (!userHome) return { servers: [] };
  let text: string;
  try {
    text = await fsp.readFile(path.join(userHome, '.claude.json'), 'utf8');
  } catch (e) {
    if (isEnoent(e)) return { servers: [] }; // 尚未生成 = 正常态（无 error 字段）
    return { servers: [], error: USER_SCOPE_READ_ERROR };
  }
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return { servers: [], error: USER_SCOPE_PARSE_ERROR };
  }
  const table = extractMcpServersTable(root);
  if (table) {
    const servers: McpScopedServerView[] = [];
    for (const [name, rawCfg] of Object.entries(table)) {
      const entry = normalizeMcpEntry(name, rawCfg);
      if (entry) servers.push(toMaskedView(entry, 'user'));
    }
    return { servers };
  }
  // table === null 的形态分类：根非对象（如数组/标量）、mcpServers 键存在但非对象（如 "oops"）
  // → 与损坏同级的异常形态 → 提示；根为对象但【无】mcpServers 键 → 合法空态（无 error，§3.5）。
  const abnormal =
    !(typeof root === 'object' && root !== null && !Array.isArray(root)) ||
    Object.prototype.hasOwnProperty.call(root, 'mcpServers');
  return abnormal ? { servers: [], error: USER_SCOPE_PARSE_ERROR } : { servers: [] };
}

/**
 * 项目级收集主体：目录集 = mergeProjectDirs(recentWorkspaces, defaultWorkingDir) → sortProjectDirs
 * （同 Skill 口径：默认置顶 + basename 字典序；大小写/斜杠变体归一去重）；逐目录直读 .mcp.json：
 *   - badDirHas 命中 → 跳过读（servers=[]，不标记不报错）；
 *   - .mcp.json 不存在（ENOENT）→ servers=[]（正常态，§3.6）；
 *   - 读异常（非 ENOENT，如权限/被占用）→ badDirMark(dir) 负缓存 60s + servers=[]；
 *   - 读悬挂（逐目录 withTimeout 超时归 null，如不可达 UNC）→ badDirMark(dir) 负缓存 60s + servers=[]；
 *   - JSON 损坏 / 无 mcpServers 键 / 单条非法 → servers=[]（单条非法仅跳过该条，不炸整个 snapshot）；
 *   - 合法 → 脱敏视图（scope:'project'）。
 * 结果持续 push 进调用方传入的 out（超时部分返回语义的数据通道）；isAborted 置真后不再
 * 产出新目录/新条目（withTimeout 超时后冻结已收集部分，弃飞的循环不再改写快照）。
 */
async function collectProjectDirsInto(
  out: McpProjectDirView[],
  deps: CollectMcpSnapshotDeps,
  countsByKey: Map<string, number>,
  isAborted: () => boolean,
): Promise<McpProjectDirView[]> {
  for (const d of sortProjectDirs(
    // 注入的默认目录判定在排序【前】并入（isDefault 参与置顶排序）——否则注入判真的目录
    // 会出现在视图 isDefault=true 却排在尾部的不一致形态。
    mergeProjectDirs(deps.recentWorkspaces, deps.defaultWorkingDir).map((e) =>
      deps.isDefaultDir(e.path) ? { ...e, isDefault: true } : e,
    ),
  )) {
    if (isAborted()) return out;
    const view: McpProjectDirView = {
      path: d.path,
      name: basenameOfDir(d.path),
      isDefault: d.isDefault,
      sessionCount: countsByKey.get(normalizeDirKey(d.path)) ?? 0, // 缺=0
      servers: [],
    };
    out.push(view);
    if (deps.badDirHas(d.path)) continue; // 负缓存命中：跳过读（servers=[]，不标记错误）
    // 逐目录 withTimeout 包读（默认 3s）：悬挂型不可达目录（如 UNC 网络路径）读既不 resolve
    // 也不 reject，原先只能靠外层整体预算弃飞整轮——该目录不落负缓存，下次进 Tab 重新悬挂
    // 且饿死排其后的目录。超时（归 null）形态与 Skill 链同款（project-skills.ts stat 超时归
    // null → badDirCacheMark）：落 60s 负缓存，期内重复进 Tab 直跳。
    let text: string | null;
    try {
      text = await withTimeout(fsp.readFile(path.join(d.path, '.mcp.json'), 'utf8'));
    } catch (e) {
      if (!isEnoent(e)) deps.badDirMark(d.path); // 非 ENOENT 访问异常 → 60s 负缓存
      continue; // ENOENT=正常空态 / 其他异常=servers=[]（§3.6）
    }
    if (text === null) {
      deps.badDirMark(d.path); // 读悬挂超时 → 60s 负缓存（同 Skill 链 stat 超时语义）
      continue;
    }
    if (isAborted()) return out;
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      continue; // 损坏 → servers=[]，不炸整个 snapshot（§3.6）
    }
    const table = extractMcpServersTable(root);
    if (!table) continue; // 无 mcpServers 键（或表非对象）→ servers=[]（正常态）
    for (const [name, rawCfg] of Object.entries(table)) {
      const entry = normalizeMcpEntry(name, rawCfg);
      if (entry) view.servers.push(toMaskedView(entry, 'project'));
    }
  }
  return out;
}

/**
 * MCP 快照收集入口（P4 IPC MCP_SNAPSHOT_GET 的数据源；只读无副作用——唯一「写」是经注入的
 * badDirMark 落 60s 负缓存，与 Skill 同实例同语义）。
 * 会话计数：listWorkingDirCounts() 返回 working_dir **原文**分组 Map（repo 不归一），此处先把
 * Map 键 normalizeDirKey 归一聚合，再按 normalizeDirKey(dir) 查（sessions 表原文与目录集写法
 * 可能大小写/斜杠不同，同 collectSkillProjectDirs 消费端口径）。
 * 预算：项目级收集整体包 withTimeout(…, 3000)；超时 → 已收集到的部分目录照常返回、不抛错
 * （简化申报：超时即返回当前已得，未收集目录本拍缺席，下次进 Tab 重查）。
 */
export async function collectMcpSnapshot(deps: CollectMcpSnapshotDeps): Promise<McpSnapshot> {
  const user = await collectUserServers(deps.userHome);
  const countsByKey = new Map<string, number>();
  for (const [rawDir, count] of deps.listWorkingDirCounts()) {
    const key = normalizeDirKey(rawDir);
    countsByKey.set(key, (countsByKey.get(key) ?? 0) + count);
  }
  const partial: McpProjectDirView[] = [];
  let aborted = false;
  const done = await withTimeout(collectProjectDirsInto(partial, deps, countsByKey, () => aborted), PROJECT_COLLECT_BUDGET_MS);
  if (done === null) aborted = true; // 超时 → 冻结部分结果（弃飞循环不再产出）
  const snapshot: McpSnapshot = { userServers: user.servers, projectDirs: done ?? partial };
  if (user.error !== undefined) snapshot.userScopeError = user.error;
  return snapshot;
}
