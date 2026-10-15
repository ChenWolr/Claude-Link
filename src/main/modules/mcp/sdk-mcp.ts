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
//   - mergeMcpServersIntoSettings(out, config, sessionRow, workingDir, io?)
//       会话启动注入：user/project/managed 三层合并（mergeMcpServersForSession），结果非空才写
//       out.mcpServers（§3.1：空配置下 settings 块与不注入时 JSON.stringify 字节级一致）。
//       io 参数（可选注入，selftest 用内存 stub 保证确定性——绝不读真实 ~/.claude.json）：
//       默认实现走 mcp-scanner 的同步 raw 读取器（未脱敏，注入 SDK 需要真值）；
//       userHome 默认 os.homedir()，真正的 userHome 由调用方 sdk-backend 显式传
//       effectiveUserHome() ?? os.homedir()（与 SDK 子进程 env 同口径，见 effectiveUserHome）。
//
// override 键空间（AppConfig.mcpOverrides / sessions.mcp_overrides 共用）：
//   'managed:<name>' | 'user:<name>' | 'project:<normalizeDirKey(dir)>:<name>'
//   键存在且值 === 'off' = 禁用；键缺失 = 启用。

import * as os from 'node:os';
import type { AppConfig } from '../../../shared/types/config';
import { normalizeDirKey } from '../../../shared/project-skills';
import { mergeMcpServersForSession, type ParsedMcpEntry } from './mcp-config';
import { readProjectMcpServersRawSync, readUserMcpServersRawSync } from './mcp-scanner';

/** mergeMcpServersIntoSettings 的可选 io 注入面（selftest 用内存 stub；生产走默认实现）。 */
export interface MergeMcpServersIo {
  /** 用户级 ~/.claude.json 顶层 mcpServers 读取（未脱敏）。缺省 → readUserMcpServersRawSync(userHome)。 */
  readUser?: () => Record<string, ParsedMcpEntry>;
  /** 项目级 <dir>/.mcp.json 顶层 mcpServers 读取（未脱敏）。缺省 → readProjectMcpServersRawSync(dir)。 */
  readProject?: (dir: string) => Record<string, ParsedMcpEntry>;
  /** 用户根目录（~/.claude.json 定位用）。缺省 → os.homedir()；生产调用方传 effectiveUserHome() ?? os.homedir()。 */
  userHome?: string;
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
 * 概念；目录不存在/不可读 → raw 读取器返回 {} → 项目级自然不参与）。workingDir 空 → 项目级不参与。
 * 合并结果非空才写 out.mcpServers（§3.1：空 MCP 配置下 settings 块与改动前 JSON.stringify
 * 逐字节相同——生产 query / probe 零影响，T1/E3a 断言钉死）。
 * 管理库删除同名服务器后，钉住的孤儿 override 键因 merge 只遍历现存定义而自然无效（§3.8，不崩）。
 */
export function mergeMcpServersIntoSettings(
  out: Record<string, unknown>,
  config: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null,
  workingDir: string | null | undefined,
  io?: MergeMcpServersIo,
): void {
  const overrides = sessionRow?.mcpOverrides ?? config.mcpOverrides;
  const projectDirKey = workingDir ? normalizeDirKey(workingDir) : null;
  const readUser = io?.readUser ?? (() => readUserMcpServersRawSync(io?.userHome ?? os.homedir()));
  const readProject = io?.readProject ?? ((dir: string) => readProjectMcpServersRawSync(dir));
  const userServers = readUser() ?? {};
  const projectServers = projectDirKey !== null ? (readProject(workingDir as string) ?? {}) : {};
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
}
