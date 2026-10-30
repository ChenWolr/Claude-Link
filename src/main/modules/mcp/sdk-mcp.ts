// mcp/sdk-mcp.ts
// MCP 会话钉住 + SDK 注入纯函数集合（docs/plans/2026-10-12-mcp-management-plan.md §2 P5）。
// 纯 node 模块：不 import electron、不 import sdk-backend（P9 契约 selftest 直接 import 本文件
// 跑在纯 node 下）；仅允许 node 内置 + 类型 import（shared/types/config、./mcp-config）与
// mcp-scanner 的同步 raw 读取器。语义与 sdk-skill-overrides.ts 同构。
//
// 导出清单（P5 已全部实现）：
//   - buildSessionMcpOverridesForPin(input)
//       SESSION_CREATE 钉住：空/脏 → null（无需落库，同建行默认 NULL）；非空 → 清洗副本
//      （null 原型载体，sanitizeMcpOverridesConfig 同款手法）。
//   - parseSessionMcpOverrides(raw)
//       sessions.mcp_overrides 脏值兜底（session-repo.toSession 专用）：null/undefined/JSON 字符串
//       解析失败/非对象/无合法条目 → null；合法 → 清洗副本（Object.create(null) 载体）。
//   - mergeMcpServersIntoSettings(out, config, sessionRow, workingDir, io?) → MergeMcpResult
//       会话启动注入：user/project/managed 三层合并（mergeMcpServersForSession），结果非空才写
//       out.mcpServers（§3.1：空配置下 settings 块与不注入时 JSON.stringify 字节级一致）。
//       返回值 overridesHitExisting（H2 收紧，2026-10-29）：effective overrides 中至少一个
//       值==='off' 的键命中三层现存定义才 true——sdk-backend 两处 core input 构造点据此算
//       strictMcpConfig 门控信号（孤儿键不再触发 strict）。
//       B-M1 加固（2026-10-29）：默认 io 读失败（readFailed）/ 坏目录负缓存短路层视为「定义
//       不可观测」，此时只要 effective overrides 存在任意值==='off' 的键也保守置 true（宁可
//       短暂 strict，不放行引擎原生拉起破坏用户显式禁用语义）；ENOENT / JSON 损坏两条正常空态
//       不保守（层可观测即「确实无定义」）。
//       io 参数（可选注入，selftest 用内存 stub 保证确定性——绝不读真实 ~/.claude.json）：
//       默认实现走 mcp-scanner 的同步 detail 读取器（未脱敏，注入 SDK 需要真值）+ 坏目录负缓存
//       前置/标记（B-1，与 Skill/快照链同实例，60s TTL）；
//       userHome 默认 os.homedir()，真正的 userHome 由调用方 sdk-backend 显式传
//       effectiveUserHome() ?? os.homedir()（与 SDK 子进程 env 同口径，见 effectiveUserHome）。
//
// override 键空间（AppConfig.mcpOverrides / sessions.mcp_overrides 共用）：
//   'managed:<name>' | 'user:<name>' | 'project:<normalizeDirKey(dir)>:<name>'
//   键存在且值 === 'off' = 禁用；键缺失 = 启用。

import * as os from 'node:os';
import type { AppConfig } from '../../../shared/types/config';
import { normalizeDirKey } from '../../../shared/project-skills';
import { badDirCacheHas, badDirCacheMark } from '../project-skills';
import { mergeMcpServersForSession, type ParsedMcpEntry } from './mcp-config';
import { readProjectMcpServersDetailSync, readUserMcpServersDetailSync } from './mcp-scanner';

/** mergeMcpServersIntoSettings 的可选 io 注入面（selftest 用内存 stub；生产走默认实现）。 */
export interface MergeMcpServersIo {
  /** 用户级 ~/.claude.json 顶层 mcpServers 读取（未脱敏）。缺省 → detail 直读 + 坏目录负缓存（B-1）。 */
  readUser?: () => Record<string, ParsedMcpEntry>;
  /** 项目级 <dir>/.mcp.json 顶层 mcpServers 读取（未脱敏）。缺省 → detail 直读 + 坏目录负缓存（B-1）。 */
  readProject?: (dir: string) => Record<string, ParsedMcpEntry>;
  /** 用户根目录（~/.claude.json 定位用）。缺省 → os.homedir()；生产调用方传 effectiveUserHome() ?? os.homedir()。 */
  userHome?: string;
}

/** mergeMcpServersIntoSettings 的返回值（H2 收紧口径的 strict 门控信号）。 */
export interface MergeMcpResult {
  /** effective overrides 中至少一个值==='off' 的键命中三层现存定义（键构造与
   *  mergeMcpServersForSession 应用侧同口径：managed:<name>/user:<name>/project:<dirKey>:<name>，
   *  project 仅会话目录键）。纯孤儿键/跨目录键/非 'off' 脏值键不算——merged 空且无命中键时
   *  strictMcpConfig=false，引擎原生来源（云端 connectors/插件 MCP）恢复加载。
   *
   *  B-M1（2026-10-29）保守分支：默认 io 的读失败层（readFailed=true）与坏目录负缓存短路层
   *  视为「定义不可观测」（该层真实被禁用的键唯一定义恰在其中，definitionKeys 无法覆盖）；
   *  存在任意值==='off' 的键时保守置 true（宁可短暂 strict，不放行引擎原生拉起破坏禁用语义）。
   *  overrides 无 'off' 键时仍 false（H2：未接管 → 恢复引擎原生加载）；ENOENT / JSON 损坏
   *  两条路径不置保守标志（层可观测 = 确实无定义，mcp-scanner 三态分类口径不变）。 */
  overridesHitExisting: boolean;
}

/** 核心清洗：只保留 string 键且值 === 'off' 的条目（Object.entries 只产 string 键，值需显式判）。 */
function cleanMcpOverrideEntries(value: unknown): [string, 'off'][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const entries: [string, 'off'][] = [];
  for (const [key, val] of Object.entries(value)) {
    if (val === 'off') entries.push([key, 'off']);
  }
  return entries;
}

/** 清洗条目 → null 原型载体副本（__proto__/constructor 自有键只作普通属性，不触原型面）。 */
function toNullProtoOverrides(entries: [string, 'off'][]): Record<string, 'off'> {
  const out = Object.create(null) as Record<string, 'off'>;
  for (const [key, val] of entries) out[key] = val;
  return out;
}

/**
 * SESSION_CREATE 钉住用：对 getConfig().mcpOverrides 做同款清洗（脏值防御）。
 * 空/无键 → null 表示「无需落库」（与建行默认 NULL 一致）；非空 → 清洗副本。
 * 与 buildSessionSkillOverridesForPin 同构（仅空值形态与载体差异：本函数输出 null 原型载体，
 * 与 sanitizeMcpOverridesConfig / parseSessionMcpOverrides 同款）。
 */
export function buildSessionMcpOverridesForPin(input: Record<string, 'off'>): Record<string, 'off'> | null {
  const entries = cleanMcpOverrideEntries(input);
  return entries.length > 0 ? toNullProtoOverrides(entries) : null;
}

/**
 * 解析 sessions.mcp_overrides 列（session-repo.toSession 脏值兜底专用）。
 * 接受两种形态：JSON 序列化字符串（DB 列原文）与已反序列化对象（防御性兼容）。
 * null/undefined/空串/JSON.parse 失败/非对象/数组/过滤后无合法条目（值非 'off'）→ null
 * （= 未钉住/功能前存量，注入链回退当前全局 mcpOverrides，§3.14）；有效 → 清洗副本
 *（Object.create(null) 载体，§3.10 原型污染防线）。
 */
export function parseSessionMcpOverrides(raw: unknown): Record<string, 'off'> | null {
  let value: unknown = raw;
  if (typeof value === 'string') {
    if (value === '') return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const entries = cleanMcpOverrideEntries(value);
  return entries.length > 0 ? toNullProtoOverrides(entries) : null;
}

/**
 * 会话启动注入（§1.2 注入链终点，buildClaudeLinkSettingsBlock 调用）：同步函数。
 * overrides 取值：sessionRow.mcpOverrides（会话钉住值）优先，null（存量会话/无行）回退当前全局
 * config.mcpOverrides（§3.14——MCP 因 strictMcpConfig 必须给值，与 skill 的 null=全启用兜底不同）。
 * 项目级：workingDir 非空 → normalizeDirKey 归一为 projectDirKey 并直读该目录 .mcp.json
 *（§3.9 注入链口径：恒取当前会话 workingDir 的 .mcp.json，不经目录集——目录集只是 scanner 视图
 * 概念；目录不存在/不可读/负缓存命中 → 默认 io 返回 {} → 项目级自然不参与）。workingDir 空 → 项目级不参与。
 * 合并结果非空才写 out.mcpServers（§3.1：空 MCP 配置下 settings 块与改动前 JSON.stringify
 * 逐字节相同——生产 query / probe 零影响，T1/E3a 断言钉死）。
 * 管理库删除同名服务器后，钉住的孤儿 override 键因 merge 只遍历现存定义而自然无效（§3.8，不崩）。
 * 返回 MergeMcpResult（H2 收紧，2026-10-29）：overridesHitExisting = effective overrides 中
 * 至少一个值==='off' 的键命中三层现存定义（键构造与 mergeMcpServersForSession 应用侧同口径：
 * managed:<name>/user:<name>/project:<projectDirKey>:<name>，project 仅会话目录键——跨目录键
 * 不进集合，D5；纯孤儿键/非 'off' 脏值键不算）。sdk-backend 两处 core input 构造点据此计算
 * strictMcpConfig 门控信号：merged 空且无命中键 → strict=false（引擎原生来源恢复加载）；
 * 命中定义的禁用键仍 strict=true（「禁用生效」保底，selftest-mcp-settings I5/I7 钉死）。
 * B-M1 加固（2026-10-29）：默认 io 的读失败层（readFailed=true）与坏目录负缓存短路层不可观测
 *（该层真实被禁用的键唯一定义恰在其中，definitionKeys 覆盖不到）——effective overrides 存在
 * 任意值==='off' 的键时保守置 true（宁可短暂 strict，不放行原生拉起破坏禁用语义）；ENOENT /
 * JSON 损坏两条路径不置（层可观测 = 确实无定义，三态分类口径不变）；overrides 无 'off' 键时
 * 仍 false（H2 未接管恢复原生加载不回归）。selftest-mcp-settings I8 钉死。
 */
export function mergeMcpServersIntoSettings(
  out: Record<string, unknown>,
  config: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null,
  workingDir: string | null | undefined,
  io?: MergeMcpServersIo,
): MergeMcpResult {
  const overrides = sessionRow?.mcpOverrides ?? config.mcpOverrides;
  const projectDirKey = workingDir ? normalizeDirKey(workingDir) : null;
  // B-1（2026-10-16）默认 io 坏目录负缓存防护：慢速/失联目录（UNC/网络盘/拔出的可移动盘）的
  // 同步读曾让注入链每次会话启动重付数十秒阻塞——前置 badDirCacheHas（与 Skill/快照链同实例的
  // 60s 共享负缓存）命中即返回 {}；readFailed（读异常且非 ENOENT/非损坏，mcp-scanner detail
  // 三态分类）时 badDirCacheMark 快速失败，60s 内不再重复付失败成本。视图链（collectMcpSnapshot
  // 逐目录 async withTimeout）写同一共享缓存实例——用户进过 MCP/Skill 设置页后，注入链即可吃到
  // 视图链的超时标记（键形态：normalizeDirKey 在 badDirCache* 内部统一做，两侧传原始串天然一致）。
  // 申报边界：同步链无法防「首次悬挂」（悬挂不返回、无从 mark）——从未打开设置页的首条消息
  // 仍可能悬挂一次。
  const userHome = io?.userHome ?? os.homedir();
  // B-M1（2026-10-29）不可观测定义层标志：仅默认 io（未注入 io.readUser / io.readProject）走进
  // ① 坏目录负缓存短路（badDirCacheHas 命中——该层本轮没有任何可观测定义，正是读失败后的 60s
  // 窗口）或 ② detail 读取器返回 readFailed=true（读异常且非 ENOENT、非 JSON 损坏）时置 true。
  // ENOENT（正常空态）/ JSON 损坏（坏内容）不置：这两态层内容是可观测的「确实无定义」，
  // mcp-scanner 的三态分类口径不变。注入式 io（selftest 内存 stub）完全不受影响。
  let unknownDefinitionLayer = false;
  const readUser =
    io?.readUser ??
    (() => {
      const key = `mcp-user:${userHome}`; // 命名空间隔离，绝不与项目目录键碰撞（绝对路径不可能以 mcp-user: 开头）
      if (badDirCacheHas(key)) {
        unknownDefinitionLayer = true;
        return {};
      }
      const d = readUserMcpServersDetailSync(userHome);
      if (d.readFailed) {
        unknownDefinitionLayer = true;
        badDirCacheMark(key);
      }
      return d.servers;
    });
  const readProject =
    io?.readProject ??
    ((dir: string) => {
      if (badDirCacheHas(dir)) {
        // 命中共享负缓存（Skill/快照链同实例写入）
        unknownDefinitionLayer = true;
        return {};
      }
      const d = readProjectMcpServersDetailSync(dir);
      if (d.readFailed) {
        unknownDefinitionLayer = true;
        badDirCacheMark(dir); // 快速失败也标记，60s 内不再重复付失败成本
      }
      return d.servers;
    });
  const userServers = readUser() ?? {};
  const projectServers = projectDirKey !== null ? (readProject(workingDir as string) ?? {}) : {};
  // H2（2026-10-29）strict 门控信号收紧：构造三层现存定义的 override 键全集，effective
  // overrides 中至少一个值==='off' 的键命中该集合才算「接管激活」——孤儿键（外部删除后残留）
  // 不再触发 strictMcpConfig、不再静默丢弃引擎原生 MCP 来源；命中定义的禁用键仍激活（禁用
  // 必须生效）。键构造与下方 mergeMcpServersForSession 应用侧逐字同口径；跨目录 project 键
  // 不进集合（D5：跨目录 override 不生效）。
  const definitionKeys = new Set<string>();
  for (const s of Array.isArray(config.mcpServers) ? config.mcpServers : []) definitionKeys.add(`managed:${s.name}`);
  for (const name of Object.keys(userServers)) definitionKeys.add(`user:${name}`);
  if (projectDirKey !== null) for (const name of Object.keys(projectServers)) definitionKeys.add(`project:${projectDirKey}:${name}`);
  let hasOffOverride = false;
  let hitExisting = false;
  for (const [key, val] of Object.entries(overrides ?? {})) {
    if (val !== 'off') continue;
    hasOffOverride = true;
    if (definitionKeys.has(key)) { hitExisting = true; break; }
  }
  // B-M1：不可观测层（读失败 / 负缓存短路）+ 存在任意 'off' 键 → 保守 true（宁可短暂 strict，
  // 不放行引擎原生拉起破坏禁用语义）；overrides 全空时保持 H2 既有语义（未接管 → strict=false，
  // 恢复引擎原生加载），避免读失败时无意义地压制原生 MCP。
  const overridesHitExisting = hitExisting || (unknownDefinitionLayer && hasOffOverride);
  const merged = mergeMcpServersForSession({
    managed: config.mcpServers,
    userServers,
    projectServers,
    overrides,
    projectDirKey,
  });
  if (Object.keys(merged).length > 0) {
    out.mcpServers = merged;
  }
  return { overridesHitExisting };
}
