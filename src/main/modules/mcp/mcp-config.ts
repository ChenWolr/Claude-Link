// mcp/mcp-config.ts
// MCP 配置纯函数集合（docs/plans/2026-10-12-mcp-management-plan.md P2）。
// 纯 node 模块：不 import electron（P9 契约 selftest 直接 import 本文件跑在纯 node 下），
// 仅允许 import ../../../shared/types/config 的类型与 node 内置。
//
// 本文件最终导出清单（标注实现点；未列出的后续点追加）：
//   - sanitizeMcpServersConfig(input: unknown): McpManagedServer[]        【P1 本点已实现】
//       配置读路径 sanitize（config-manager.getConfig）：非数组 → []；逐条校验 + 字段互斥归一
//      （R1：env/headers 值级清洗——仅保留 string 值条目，pickStringRecord 与 normalizeMcpEntry 共用）。
//   - sanitizeMcpOverridesConfig(input: unknown): Record<string, 'off'>   【P1 本点已实现】
//       配置读路径 sanitize：只保留 string 键且值 === 'off'，null 原型载体防 __proto__/constructor。
//   - ParsedMcpEntry（type）                                               【P2 p9a 已导出】
//   - parseMcpServersJson(text: string)                                    【P2 本点已实现】
//       兼容 {"mcpServers":{...}} / 裸 map / {"servers":{...}} 三种导入形态。
//   - toSdkMcpServerConfig(s)                                              【P2 本点已实现】
//       McpManagedServer 形状 → SDK Settings.mcpServers 条目（stdio/http/sse 三形）。
//   - mergeMcpServersForSession(input)                                     【P2 本点已实现】
//       user → project → managed 三层合并 + override 过滤（同名优先级 managed > project > user）。
//   - normalizeMcpEntry(name, rawCfg)                                      【P3 本点提炼导出】
//       单条磁盘/导入条目 unknown → ParsedMcpEntry | null（parseMcpServersJson 内部逻辑提炼，
//       mcp-scanner 的 raw 读取器复用同一归一；行为与提炼前逐条一致）。
//   - MCP_MASK_SENTINEL / maskMcpServersForRenderer / McpManagedSaveEntry /
//     restoreMaskedMcpServers                                                【r3 修复 F2 已实现】
//       §1.3 渲染层脱敏闭环：renderer 出口掩码（config:get/save 回包 env/headers 值 → 哨兵）
//       + mcp:managedSave 提交哨兵还原（含键改名 hint，还原后剥离瞬态字段）。

import type { McpManagedServer } from '../../../shared/types/config';

// name 是工具名 mcp__<name>__<tool> 的中段：仅限字母/数字/下划线/连字符，1-64 字符。
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * env/headers 值级清洗（R1，sanitizeMcpServersConfig 与 normalizeMcpEntry 共用同一口径）：
 * 入参非普通对象（null/数组/标量）→ undefined（调用方不输出该字段，沿用既有「删字段」语义）；
 * 普通对象 → 仅保留值 typeof === 'string' 的条目（键序保持原序；空串是合法 string，保留），
 * 清洗后为空 → undefined（字段整体消失，不输出空对象）。值非 string（number/boolean/null/
 * 对象/数组）整键丢弃，绝不放行进 SDK 与磁盘管理库。
 * 输出载体用 Object.create(null)：键来自磁盘/导入 JSON（不可信，可含 '__proto__' 自有键），
 * 逐键写入时 null 原型载体不触发 Object.prototype setter（sanitizeMcpOverridesConfig 同款手法）。
 */
function pickStringRecord(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) return undefined;
  const out = Object.create(null) as Record<string, string>;
  for (const [key, v] of Object.entries(value)) {
    if (typeof v === 'string') out[key] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 配置读路径 sanitize（config-manager.getConfig）：非数组 → []；逐条校验，任一硬性条件
 * 不过 → 丢弃整条（不部分修复身份字段）：
 *   - 条目非普通对象（null/数组/标量）；
 *   - id/name 非非空字符串；name 不匹配 ^[A-Za-z0-9_-]{1,64}$；
 *   - transport 不属于 'stdio'|'http'|'sse'；
 *   - transport 与必填不匹配（stdio 无 command / remote 无 url，空串同「无」）。
 * 通过校验的条目做字段互斥归一（显式重建输出，不透传输入多余键，杜绝原型面）：
 *   - stdio 丢 url/headers；remote（http/sse）丢 command/args/env；
 *   - args 非字符串数组 → 删除该字段；env/headers 值级清洗（pickStringRecord）：非普通对象，
 *     或清洗后无合法 string 值 → 删除该字段（值全非法时字段消失，非空对象）；
 *   - description 非字符串 → ''；createdAt/updatedAt 非有限数字 → Date.now() 兜底
 *    （NaN/Infinity 不是合法时间戳，按「非数字」处理）。
 * name 重复 → 保留第一条。undefined/null/空数组 → []（旧配置缺键不报错）。
 */
export function sanitizeMcpServersConfig(input: unknown): McpManagedServer[] {
  if (!Array.isArray(input)) return [];
  const now = Date.now();
  const seenNames = new Set<string>();
  const out: McpManagedServer[] = [];
  for (const raw of input) {
    if (!isPlainObject(raw)) continue;
    const id = raw.id;
    const name = raw.name;
    const transport = raw.transport;
    if (typeof id !== 'string' || id === '') continue;
    if (typeof name !== 'string' || !MCP_SERVER_NAME_PATTERN.test(name)) continue;
    if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') continue;

    const createdAt = typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : now;
    const updatedAt = typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now;
    const description = typeof raw.description === 'string' ? raw.description : '';

    // 字段互斥归一：按 transport 只拷贝所属侧字段（错误侧字段直接不进输出）。
    const server: McpManagedServer = { id, name, description, transport, createdAt, updatedAt };
    if (transport === 'stdio') {
      if (typeof raw.command !== 'string' || raw.command === '') continue; // stdio 必填
      server.command = raw.command;
      if (Array.isArray(raw.args) && raw.args.every((a) => typeof a === 'string')) {
        server.args = raw.args;
      }
      const env = pickStringRecord(raw.env);
      if (env !== undefined) {
        server.env = env;
      }
    } else {
      if (typeof raw.url !== 'string' || raw.url === '') continue; // http/sse 必填
      server.url = raw.url;
      const headers = pickStringRecord(raw.headers);
      if (headers !== undefined) {
        server.headers = headers;
      }
    }

    if (seenNames.has(name)) continue; // 重名保留第一条
    seenNames.add(name);
    out.push(server);
  }
  return out;
}

/**
 * 配置读路径 sanitize（config-manager.getConfig）：只保留 string 键且值 === 'off' 的条目。
 * 与 sanitizeSkillOverridesConfig（sdk-skill-overrides.ts）同款语义，区别仅在载体：
 * 用 Object.create(null) 作输出载体——即便输入带 '__proto__'/'constructor' 自有键
 *（JSON.parse 可产出），写入 null 原型对象也只是普通自有属性，不触发/不污染
 * Object.prototype（原型污染防线，project-skills.ts 同款手法）。
 * 非对象（含 null/数组）→ 空载体 {}（AppConfig 该字段非可空，空值形态与
 * buildSessionMcpOverridesForPin（P5，null=无需落库）相区别）。
 */
export function sanitizeMcpOverridesConfig(input: unknown): Record<string, 'off'> {
  const out = Object.create(null) as Record<string, 'off'>;
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    if (value === 'off') out[key] = 'off';
  }
  return out;
}

// ── P2 契约类型与实现（docs/plans/2026-10-12-mcp-management-plan.md §2 P2）────
// 断言集见 scripts/selftest-mcp-settings.ts（B/C/D 组逐条钉住本节行为）。

/** 导入 JSON / 磁盘直读的单条 MCP 服务器解析产物（name 来自 map 键，非条目内字段）。 */
export type ParsedMcpEntry = {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
};

/** SDK Settings.mcpServers 条目（@anthropic-ai/claude-agent-sdk Settings.mcpServers 三形）。 */
export type SdkMcpServerConfig =
  | { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers?: Record<string, string> }
  | { type: 'sse'; url: string; headers?: Record<string, string> };

/** URL 路径以 /sse 结尾判定：优先解析 URL 取 pathname（容忍 ?query/#hash），解析失败回退原串后缀。 */
function urlPathEndsWithSse(url: string): boolean {
  try {
    return new URL(url).pathname.endsWith('/sse');
  } catch {
    return url.endsWith('/sse');
  }
}

/**
 * 单条条目归一（P3 从 parseMcpServersJson 的条目循环原样提炼，供 mcp-scanner 的 raw 读取器
 * 与本函数共用同一归一口径；行为与提炼前逐条一致，null 即「跳过该条目」）：
 *   - rawCfg 非普通对象（标量/null/数组）→ null；
 *   - transport 判定：显式 type 优先（'stdio'→stdio；'http'|'streamable-http'→http；'sse'→sse）；
 *     type 缺失或无法识别 → command/url 启发式（有 command→stdio；否则有 url→路径 /sse 结尾→sse
 *     否则 http；两无线索 → null）；
 *   - 字段互斥归一（与 sanitizeMcpServersConfig 同款）：按 transport 只拷贝所属侧字段——stdio 只留
 *     command/args/env、remote 只留 url/headers；args 非全字符串数组→丢字段；env/headers 值级清洗
 *    （pickStringRecord）：非普通对象或清洗后无合法 string 值→丢字段；command/url 空串同「缺失」
 *    （必填缺失 → null）。name 取 map 键原样透传。
 */
export function normalizeMcpEntry(name: string, rawCfg: unknown): ParsedMcpEntry | null {
  if (!isPlainObject(rawCfg)) return null;
  const cfg = rawCfg as Record<string, unknown>;
  // transport 判定：显式 type 优先；缺失或无法识别 → command/url 启发式。
  let transport: 'stdio' | 'http' | 'sse' | null = null;
  if (cfg.type === 'stdio') transport = 'stdio';
  else if (cfg.type === 'http' || cfg.type === 'streamable-http') transport = 'http';
  else if (cfg.type === 'sse') transport = 'sse';
  if (transport === null) {
    const command = typeof cfg.command === 'string' && cfg.command !== '' ? cfg.command : null;
    const url = typeof cfg.url === 'string' && cfg.url !== '' ? cfg.url : null;
    if (command !== null) transport = 'stdio';
    else if (url !== null) transport = urlPathEndsWithSse(url) ? 'sse' : 'http';
    else return null; // 无 type 且 command/url 两无线索 → 跳过该条目（不报错）
  }
  // 字段互斥归一（与 sanitizeMcpServersConfig 同款）：按 transport 只拷贝所属侧字段。
  if (transport === 'stdio') {
    const command = typeof cfg.command === 'string' && cfg.command !== '' ? cfg.command : null;
    if (command === null) return null; // stdio 必填 command 缺失/空串 → 跳过该条目
    const entry: ParsedMcpEntry = { name, transport, command };
    if (Array.isArray(cfg.args) && cfg.args.every((a) => typeof a === 'string')) entry.args = cfg.args;
    const env = pickStringRecord(cfg.env);
    if (env !== undefined) entry.env = env;
    return entry;
  }
  const url = typeof cfg.url === 'string' && cfg.url !== '' ? cfg.url : null;
  if (url === null) return null; // http/sse 必填 url 缺失/空串 → 跳过该条目
  const entry: ParsedMcpEntry = { name, transport, url };
  const headers = pickStringRecord(cfg.headers);
  if (headers !== undefined) entry.headers = headers;
  return entry;
}

/**
 * 导入 JSON / 磁盘直读解析（P7 导入弹窗、P3 扫描器的数据源侧归一）。
 * 兼容三种形态（依次尝试）：① {"mcpServers":{…}}（Claude Desktop/Cursor/Windsurf）
 * ② 裸 {名称:配置} map ③ {"servers":{…}}（VS Code）。
 * 失败形态（JSON.parse 失败 / 根非对象 / 三形态都取不到合法 map）→ {ok:false, error:中文消息}。
 * 条目级容错：单条 transport 判不出 / 必填缺失 → 仅跳过该条目，不整体失败（name 取 map 键；
 * 单条归一逻辑见 normalizeMcpEntry——本函数只负责形态识别与条目循环）。
 */
export function parseMcpServersJson(text: string): { ok: true; servers: ParsedMcpEntry[] } | { ok: false; error: string } {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (!isPlainObject(root)) {
    return { ok: false, error: '导入内容根节点必须是 JSON 对象（收到数组/标量/null）' };
  }
  const record = root as Record<string, unknown>;
  // 裸 map 形态仅在其【不含】保留键 mcpServers/servers 时参与：否则 {"servers":{…}} 会被误当
  // 裸 map（得到名为 "servers" 的坏条目→空结果），而 {"mcpServers":"oops"}（保留键存在但值坏）
  // 会被误判为合法空解析——两者都必须落到 ok:false。
  const hasReservedKey =
    Object.prototype.hasOwnProperty.call(record, 'mcpServers') ||
    Object.prototype.hasOwnProperty.call(record, 'servers');
  let map: Record<string, unknown> | null = null;
  if (isPlainObject(record.mcpServers)) map = record.mcpServers;
  else if (!hasReservedKey) map = record;
  else if (isPlainObject(record.servers)) map = record.servers;
  if (!map) {
    return {
      ok: false,
      error: '未找到有效的 MCP 服务器表（支持 {"mcpServers":{…}}、{"servers":{…}} 或裸 {名称:配置} 三种形态）',
    };
  }

  const servers: ParsedMcpEntry[] = [];
  for (const [name, rawCfg] of Object.entries(map)) {
    const entry = normalizeMcpEntry(name, rawCfg);
    if (entry) servers.push(entry);
  }
  return { ok: true, servers };
}

/**
 * McpManagedServer / ParsedMcpEntry 形状 → SDK Settings.mcpServers 条目（纯转换，不改 3 形语义）：
 * stdio→{type,command,args?,env?}（args 空数组、env 空对象省略）；
 * http/sse→{type,url,headers?}（headers 空对象省略）；headers key 不做大小写变换（SDK 自处理）。
 * 必填缺失（stdio 无 command / remote 无 url）抛 Error：调用方（sanitize/parse/merge 链）已保证
 * 不会发生，此处为防御性兜底。
 */
export function toSdkMcpServerConfig(s: {
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}): SdkMcpServerConfig {
  if (s.transport === 'stdio') {
    if (typeof s.command !== 'string' || s.command === '') throw new Error('stdio 服务器缺少必填 command');
    const out: { type: 'stdio'; command: string; args?: string[]; env?: Record<string, string> } = {
      type: 'stdio',
      command: s.command,
    };
    if (Array.isArray(s.args) && s.args.length > 0) out.args = s.args;
    if (s.env && Object.keys(s.env).length > 0) out.env = s.env;
    return out;
  }
  if (typeof s.url !== 'string' || s.url === '') throw new Error(`${s.transport} 服务器缺少必填 url`);
  const out: { type: 'http' | 'sse'; url: string; headers?: Record<string, string> } = {
    type: s.transport,
    url: s.url,
  };
  if (s.headers && Object.keys(s.headers).length > 0) out.headers = s.headers;
  return out;
}

/**
 * 会话注入合并（§1.2 注入链）：按 user → project → managed 顺序写入结果 map（后者同名覆盖前者，
 * 最终优先级 managed > project > user）；每个候选先查 override 键，键存在且值 === 'off' → 跳过。
 * override 键空间：user 条目 'user:<name>'、project 条目 'project:<projectDirKey>:<name>'（跨目录
 * 键不误伤）、managed 条目 'managed:<name>'。projectDirKey 为 null → 项目级整体不参与
 * （projectServers 只承载当前 workingDir 一个目录的数据，由调用方保证）。
 * 全部候选被禁用/三层全空 → 返回 {}（P5 据此不写 out.mcpServers，空配置字节级一致）。
 * 结果载体用 Object.create(null)：user/project 条目名来自磁盘 JSON 的 map 键（不可信），若出现
 * 名为 __proto__ 的服务器，写普通对象会触发原型 setter（污染面）；null 原型载体下写入只是普通
 * 自有属性（sanitizeMcpOverridesConfig 同款手法）。管理库删除同名服务器后，会话钉住的孤儿
 * override 键因 merge 只遍历现存定义而自然无效（§3.8）。
 */
export function mergeMcpServersForSession(input: {
  managed: McpManagedServer[];
  userServers: Record<string, ParsedMcpEntry>;
  projectServers: Record<string, ParsedMcpEntry>;
  overrides: Record<string, 'off'>;
  projectDirKey: string | null;
}): Record<string, ReturnType<typeof toSdkMcpServerConfig>> {
  const result = Object.create(null) as Record<string, ReturnType<typeof toSdkMcpServerConfig>>;
  const overrides = input.overrides ?? {};
  for (const [name, entry] of Object.entries(input.userServers ?? {})) {
    if (overrides[`user:${name}`] === 'off') continue; // override 禁用 → 跳过
    result[name] = toSdkMcpServerConfig(entry);
  }
  const dirKey = input.projectDirKey ?? null;
  if (dirKey !== null) {
    for (const [name, entry] of Object.entries(input.projectServers ?? {})) {
      if (overrides[`project:${dirKey}:${name}`] === 'off') continue;
      result[name] = toSdkMcpServerConfig(entry);
    }
  }
  for (const server of input.managed ?? []) {
    if (overrides[`managed:${server.name}`] === 'off') continue;
    result[server.name] = toSdkMcpServerConfig(server);
  }
  return result;
}

// ── 作用域导出 JSON（2026-10-18：设置页「导出 JSON」按钮，mcp:exportScoped 数据源侧）────
// 断言集见 scripts/selftest-mcp-export.ts（A 组逐条钉住本节行为）。

/**
 * 作用域服务器表 → 导出 JSON 文本（{"mcpServers":{…}} 形态，导入弹窗三形态之一①，与
 * Claude Code / Claude Desktop / Cursor / Windsurf 配置文件同形）。逐条经 toSdkMcpServerConfig
 * 投影为 Claude Code 认识的条目形状（stdio [type,command,args?,env?] / remote [type,url,headers?]，
 * 空数组/空表省略；描述/启停等 Claude Link 专属字段不进导出）。2 空格缩进 + 尾换行（与
 * mcp-writer 落盘格式同款）。载体 Object.create(null)（键来自磁盘/config，__proto__ 键防污染）。
 * 同名键后写覆盖前写（managed 数组理论不重名，user/project 磁盘 map 键本就唯一——由调用方
 * 保证不重复，此处后写覆盖仅防御性兜底）。
 */
export function buildMcpServersExportJson(
  servers: Record<string, Parameters<typeof toSdkMcpServerConfig>[0]>,
): string {
  const out = Object.create(null) as Record<string, ReturnType<typeof toSdkMcpServerConfig>>;
  for (const [name, server] of Object.entries(servers)) {
    out[name] = toSdkMcpServerConfig(server);
  }
  return JSON.stringify({ mcpServers: out }, null, 2) + '\n';
}

// ── §1.3 渲染层脱敏闭环（r3 修复 F2）────────────────────────────────────────
// 断言集见 scripts/selftest-mcp-settings.ts（F 组逐条钉住本节行为）。

/**
 * env/headers 值的编辑回显哨兵：8 个 U+25CF（•）。与渲染层 McpSettings.vue 的 MASK_SENTINEL
 * 同字面量，两处必须同步改。
 */
export const MCP_MASK_SENTINEL = '••••••••';

/** env/headers 值掩码（键保留、新载体输出；undefined 透传 = 无该字段，不添加）。 */
function maskRecordValues(record: Record<string, string> | undefined): Record<string, string> | undefined {
  if (record === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const key of Object.keys(record)) {
    out[key] = MCP_MASK_SENTINEL;
  }
  return out;
}

/**
 * renderer 出口掩码（§1.3，apiKey 的 getConfigForRenderer 掩码同款语义扩展到 mcpServers）：
 * 深拷贝后把每条 env/headers 的【值】替换为 MCP_MASK_SENTINEL——键保留；无该字段不添加；
 * 入参不可被变异。config:get / config:save 回包经 getConfigForRenderer 调用，渲染层永不接触
 * 明文；主进程内部 getConfig() 保持明文（会话注入与 probe all 依赖）。
 */
export function maskMcpServersForRenderer(servers: McpManagedServer[]): McpManagedServer[] {
  return (servers ?? []).map((server) => {
    const masked: McpManagedServer = { ...server };
    if (server.args !== undefined) masked.args = [...server.args];
    if (server.env !== undefined) masked.env = maskRecordValues(server.env);
    if (server.headers !== undefined) masked.headers = maskRecordValues(server.headers);
    return masked;
  });
}

/**
 * 仅 mcp:managedSave 提交方向的瞬态传输字段——payload 键 → 已存原键，供键改名时定位原值；
 * 主进程还原哨兵后剥离，绝不落盘、绝不出现在 getConfig/渲染层类型面。
 */
export interface McpManagedSaveEntry extends McpManagedServer {
  envRenameFrom?: Record<string, string>;
  headersRenameFrom?: Record<string, string>;
}

/**
 * env/headers 值还原：哨兵值按已存条目取原值（键改名经 renameFrom hint 定位已存原键，
 * 缺省同键），取不到 → 丢该键（不把哨兵落库）；非哨兵值原样透传（新增服务器的明文首存）。
 */
function restoreRecordValues(
  submitted: Record<string, string> | undefined,
  stored: Record<string, string> | undefined,
  renameFrom: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (submitted === undefined) return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(submitted)) {
    if (value === MCP_MASK_SENTINEL) {
      const original = stored?.[renameFrom?.[key] ?? key];
      if (typeof original === 'string') out[key] = original; // 已存原值缺失 → 丢该键
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * managedSave 提交哨兵还原（§1.3 闭环的落盘侧）：逐条按 id 对位（id 缺失/对不上时按 name 兜底）
 * 取已存条目，把提交条目 env/headers 中值 === MCP_MASK_SENTINEL 的键还原为已存原值（见
 * restoreRecordValues），返回剥离瞬态字段后的 McpManagedServer[]——不 sanitize，调用方随后走
 * sanitizeMcpServersConfig（哨兵还原必须在 sanitize 前，防哨兵字面量落库）。
 */
export function restoreMaskedMcpServers(
  submitted: McpManagedSaveEntry[],
  stored: McpManagedServer[],
): McpManagedServer[] {
  const byId = new Map((stored ?? []).map((s) => [s.id, s]));
  const byName = new Map((stored ?? []).map((s) => [s.name, s]));
  return (submitted ?? []).map((entry) => {
    const s = byId.get(entry.id) ?? byName.get(entry.name);
    // 剥离瞬态字段：显式解构丢弃，绝不进输出（不落盘、不回显）。
    const { envRenameFrom, headersRenameFrom, ...rest } = entry;
    const out: McpManagedServer = { ...rest };
    const env = restoreRecordValues(entry.env, s?.env, envRenameFrom);
    if (env !== undefined) out.env = env;
    const headers = restoreRecordValues(entry.headers, s?.headers, headersRenameFrom);
    if (headers !== undefined) out.headers = headers;
    return out;
  });
}
