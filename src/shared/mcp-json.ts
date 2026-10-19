// shared/mcp-json.ts
// MCP 单服务器导出 JSON 序列化（2026-10-19 mcp-settings-plan-a 点2）。
// 纯 TS 共享模块：renderer / main 两用——严禁 import electron 与 node 内置模块。
// 供点 5 表单⇄JSON 双模式的「表单 → JSON」方向供料；「JSON → 表单」反方向走主进程
// parseMcpServersJson（mcp-config.ts，经 mcp:parseMcpJson 通道暴露），两侧口径互为往返。
//
// 断言集见 scripts/selftest-mcp-settings.ts K 组（K1 字面比对为准绳）。

/**
 * env/headers 值脱敏哨兵：8 个 U+2022（•）——src 域唯一字面定义（mcp-settings-plan-a 点6；
 * scripts/ 测试经 import 引用不持字面副本）。
 * 主进程 src/main/modules/mcp/mcp-config.ts:MCP_MASK_SENTINEL 为本常量的 re-export（两名字
 * 一常量、同值同源）；渲染层 McpSettings.vue 经本模块 import 引用（点6 删除其本地字面量副本，
 * selftest O2/O3 钉渲染层零残留）。消费方：§1.3 编辑回显脱敏（maskMcpServersForRenderer）、
 * 哨兵还原（restoreMaskedMcpServers / mcp-writer 写入侧还原）、表单⇄JSON 序列化原样输出。
 */
export const MCP_VALUE_MASK = '••••••••';

/** 单服务器导出输入（点 5 表单态投影；description 仅入库展示，一律不进导出 JSON）。 */
export interface SingleServerExportInput {
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  description?: string;
}

/**
 * timeoutMs 字段合法性：与配置侧口径一致（mcp-config.ts isValidMcpTimeoutMs 同一判定式——
 * shared 模块不得反向 import 主进程，故此处镜像同一表达式；两侧如需调整必须同步改）。
 * 非法值静默丢字段（不报错），与 env/headers 值级清洗容错口径一致。
 */
function isValidTimeoutMs(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 120000;
}

/**
 * 单值紧凑序列化：数组与（嵌套）对象一律单行——", " 分隔、括号内带空格（`["-y", "x"]` /
 * `{ "K": "v" }`，K1 字面形态），标量走 JSON.stringify；空容器为 `[]` / `{}`（调用侧本就
 * 省略空键，此处仅为防御形态）。递归深度受输入类型约束（env/headers 值均为 string），无失控面。
 */
function serializeCompact(value: unknown): string {
  if (Array.isArray(value)) {
    return value.length === 0 ? '[]' : `[${value.map(serializeCompact).join(', ')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${serializeCompact(v)}`).join(', ')} }`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * 单服务器导出 JSON 文本（点 5「切到 JSON」方向的数据源）：顶层形如
 * `{"<name>": { …单条… }}`，对象层级（根 + 条目两级）2 空格缩进 + 末尾换行；字段序固定
 * `type, command, args, env, url, headers, timeoutMs`，按 transport 互斥取侧（stdio 形无
 * url/headers 键；http/sse 形无 command/args/env 键）；空 args([])/env({})/headers({})
 * 省略键；description 一律不导出（对齐 ZCode：仅连接语义字段）；env/headers 值原样输出
 *（哨兵 •••••••• 即字面输出）；timeoutMs 仅合法值（isValidTimeoutMs 口径）输出。
 * 数组与嵌套对象（args/env/headers）呈单行紧凑形态（JSON.stringify(…, null, 2) 会把数组
 * 逐行展开，与字面期望不符——故自拼序列化，K1 字面比对为准绳）。输出为合法 JSON，可被
 * parseMcpServersJson 的裸 map 形态回读（K5 往返一致）。
 * 例外（P3 跟进 R4）：name 恰为保留键 'mcpServers'/'servers' 时改用
 * `{"mcpServers":{"<name>":{…}}}` 包裹形（缩进层级随之递增 2 空格：root 0 / "mcpServers" 2 /
 * "<name>" 4 / 字段 6）——否则裸 map 顶层键会被 parseMcpServersJson 的保留键分支吞掉
 *（ok:true, servers:[] →「未找到有效的服务器配置」）；包裹形经三形态解析的 mcpServers 分支
 * 回读同名条目（K7 往返断言）。其余名字维持裸 map 逐字节不变。
 */
export function buildSingleServerExportJson(input: SingleServerExportInput): string {
  const entry: Record<string, unknown> = { type: input.transport };
  if (input.transport === 'stdio') {
    if (typeof input.command === 'string' && input.command !== '') entry.command = input.command;
    if (Array.isArray(input.args) && input.args.length > 0) entry.args = input.args;
    if (input.env && Object.keys(input.env).length > 0) entry.env = input.env;
  } else {
    if (typeof input.url === 'string' && input.url !== '') entry.url = input.url;
    if (input.headers && Object.keys(input.headers).length > 0) entry.headers = input.headers;
  }
  if (isValidTimeoutMs(input.timeoutMs)) entry.timeoutMs = input.timeoutMs;

  const fields = Object.entries(entry);
  // 字段行拼装两形态共享：缩进随包裹层级传参（裸形 4 空格 / 包裹形 6 空格），末字段无逗号。
  const fieldLines = (indent: string): string[] =>
    fields.map(([key, value], i) => `${indent}${JSON.stringify(key)}: ${serializeCompact(value)}${i < fields.length - 1 ? ',' : ''}`);
  // P3 跟进 R4：保留键名的裸 map 顶层键会被 parseMcpServersJson 保留键分支吞掉 →
  // 改用 mcpServers 包裹形（回读走三形态解析的 mcpServers 分支，K7 往返断言）。
  if (input.name === 'mcpServers' || input.name === 'servers') {
    const inner = [`    ${JSON.stringify(input.name)}: {`, ...fieldLines('      '), '    }'];
    return ['{', '  "mcpServers": {', ...inner, '  }', '}'].join('\n') + '\n';
  }
  return ['{', `  ${JSON.stringify(input.name)}: {`, ...fieldLines('    '), '  }', '}'].join('\n') + '\n';
}
