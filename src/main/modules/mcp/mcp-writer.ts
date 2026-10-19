// mcp/mcp-writer.ts
// P8 双向写入器：用户级 ~/.claude.json / 项目级 <dir>/.mcp.json 的顶层 mcpServers 条目
// upsert/remove（docs/plans/2026-10-17-ux-fixes-mcp-bg-p8-plan-1017-1215 原计划 §E1，8 处补漏 E0）。
// 纯 node 模块红线（契约 selftest 直接 import 本文件跑在纯 node 下）：
//   不 import electron、不 import sdk-backend；io 注入面（WriterIo）供 selftest 用内存 stub，
//   生产走 node:fs/promises + node:os 默认实现；绝不 import config-store（外部文件，与
//   PERSISTED_FIELDS 零交集，不走自动保存链）。
//
// 语义（逐条）：
//   - 目标文件：user → <userHome>/.claude.json（userHome 缺省 io.homedir()；生产调用方
//     ipc-handlers 传 effectiveUserHome() ?? os.homedir()，与 sdk-mcp.ts 注入链同口径）；
//     project → <dir>/.mcp.json（dir 必填，缺失抛错）。dir 白名单（须属已知项目目录集）
//     由调用方 ipc-handlers 负责，本模块不做目录集校验。
//   - 读：文件不存在 → 基 {}（新建）；存在但 JSON 损坏（parse 失败 / 根非对象）→
//     抛中文错误「文件损坏，已中止写入」（UI toast 直显）。
//   - 改：顶层 mcpServers（无则建；键存在但非对象 → 重建为空表后写入，坏类型键不可承载条目）
//     中 upsert/remove 条目。条目形态仅 Claude Code 认识的键：stdio → {type,command,args?,env?}；
//     http/sse → {type,url,headers?}（空数组/空表省略）；timeoutMs 合法才写键（2026-10-19 点1，
//     isValidMcpTimeoutMs 口径）。瞬态改名 hint（envRenameFrom/
//     headersRenameFrom）按构造不进输出（剥离）。哨兵还原：entry.env/headers 中值 ===
//     MCP_MASK_SENTINEL 的键，按 renameFrom 映射或同名键从原文件 mcpServers[同名].env/headers
//     取原值回填；原文件无原值 → 丢该键（不把哨兵字面量落盘）。
//   - 写：整树 parse/stringify 保留一切未知字段与键序（JSON.stringify 对「整数样键」会前移——
//     JS 引擎规范行为，服务器名含纯数字形态时键序有此已知边界），2 空格缩进 + 尾换行；
//     tmp 文件 + rename 原子写（Windows rename EPERM/EBUSY 失败 retry 100ms×3）；
//     写前 stat mtime 与读时比对，不一致 → 重读重试整个流程一次，仍冲突 → 抛
//     「文件已被其他程序修改，请重试」。
//   - remove 缺名 → no-op 等价：不触盘（零写入零 tmp），返回成功 overwrote=false。
//   - 返回 overwrote = upsert 命中现有同名（remove 恒 false）；「覆盖确认」由 UI 侧保存前
//     snapshot 预查 + requestConfirm 完成，本返回值仅作日志用途。
//
// 载体纪律（sanitizeMcpOverridesConfig / scanner 同款手法）：mcpServers 表与还原产物用
// Object.create(null) 作载体——磁盘 JSON 的 map 键不可信（可含 __proto__ 自有键），null 原型
// 载体下赋值/删除只是普通自有属性操作（原型污染防线）；JSON.stringify 对 null 原型对象按
// 自有可枚举键正常序列化，落盘字节不受载体影响。

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { isValidMcpTimeoutMs, MCP_MASK_SENTINEL } from './mcp-config';

/** 提交条目（mcp:writeScoped payload entry；渲染层 McpScopedWriteEntry 同构镜像）。 */
export interface ScopedMcpEntry {
  name: string; // 同时是目标文件 mcpServers map 键
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  /** 探活超时覆盖（毫秒，2026-10-19 点1）：合法（1..120000 整数，isValidMcpTimeoutMs 口径）
   *  才写键，非法/缺省不写（与 sanitize 同口径；remove 路径与本字段无关）。 */
  timeoutMs?: number;
  /** 瞬态 hint（提交键 → 原文件已存键）：哨兵值还原定位用，还原后按构造剥离、绝不落盘。 */
  envRenameFrom?: Record<string, string>;
  headersRenameFrom?: Record<string, string>;
}

/** io 注入面（selftest 用内存 stub；生产走 node:fs/promises + node:os 默认实现）。 */
export interface WriterIo {
  readFile(path: string): Promise<string>;
  writeFile(path: string, data: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  rename(from: string, to: string): Promise<void>;
  homedir(): string;
}

const defaultIo: WriterIo = {
  readFile: (p) => fsp.readFile(p, 'utf8'),
  writeFile: (p, data) => fsp.writeFile(p, data, 'utf8'),
  stat: (p) => fsp.stat(p),
  rename: (from, to) => fsp.rename(from, to),
  homedir: () => os.homedir(),
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isEnoent(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as NodeJS.ErrnoException).code === 'ENOENT';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RENAME_RETRY_DELAY_MS = 100;
const RENAME_RETRY_TIMES = 3;
let tmpSeq = 0;

/**
 * env/headers 值还原（mcp-config restoreRecordValues 同语义，存储侧形态改为 raw unknown）：
 * 值 === MCP_MASK_SENTINEL 的键 → 按 renameFrom hint（缺省同键）定位原文件已存键取原值，
 * 原值缺失/非 string → 丢该键（不把哨兵落盘）；非哨兵值原样透传（新增明文首存）；
 * 非 string 提交值防御性丢弃。载体 Object.create(null)（__proto__ 键防污染）。
 * 还原后全空 → undefined（调用方省略该字段，条目不出现空 env/headers）。
 */
function restoreRecordValues(
  submitted: Record<string, string> | undefined,
  storedRaw: unknown,
  renameFrom: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (submitted === undefined) return undefined;
  const stored = isPlainObject(storedRaw) ? storedRaw : {};
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of Object.entries(submitted)) {
    if (typeof value !== 'string') continue; // 防御：非 string 提交值不落盘
    if (value === MCP_MASK_SENTINEL) {
      const hintKey = renameFrom?.[key];
      const origKey = typeof hintKey === 'string' && hintKey !== '' ? hintKey : key;
      const original = stored[origKey];
      if (typeof original === 'string') out[key] = original; // 已存原值缺失 → 丢该键
    } else {
      out[key] = value;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * 提交条目 → Claude Code 认识的磁盘条目（键序：stdio [type,command,args,env]；
 * http/sse [type,url,headers]；args 空数组/非全字符串、env/headers 空表省略；timeoutMs 合法
 * 才写键、置于末尾（2026-10-19 点1，isValidMcpTimeoutMs 口径）。
 * 瞬态 hint 字段按构造不进输出（还原后剥离）。必填缺失（stdio 无 command / remote 无 url）
 * 抛中文错误（UI 表单校验在前，此处为防御性兜底）。
 */
function entryToFileShape(
  entry: ScopedMcpEntry,
  env: Record<string, string> | undefined,
  headers: Record<string, string> | undefined,
): Record<string, unknown> {
  if (entry.transport === 'stdio') {
    if (typeof entry.command !== 'string' || entry.command === '') throw new Error('stdio 服务器缺少必填 command');
    const out: Record<string, unknown> = { type: 'stdio', command: entry.command };
    if (Array.isArray(entry.args) && entry.args.length > 0 && entry.args.every((a) => typeof a === 'string')) {
      out.args = [...entry.args];
    }
    if (env !== undefined) out.env = env;
    if (isValidMcpTimeoutMs(entry.timeoutMs)) out.timeoutMs = entry.timeoutMs; // 点1：合法才写键
    return out;
  }
  if (typeof entry.url !== 'string' || entry.url === '') throw new Error(`${entry.transport} 服务器缺少必填 url`);
  const out: Record<string, unknown> = { type: entry.transport, url: entry.url };
  if (headers !== undefined) out.headers = headers;
  if (isValidMcpTimeoutMs(entry.timeoutMs)) out.timeoutMs = entry.timeoutMs; // 点1：合法才写键
  return out;
}

/** stat 包装：文件不存在/不可 stat → null（与「读时 mtime=null」同口径参与比对）。 */
async function statMtimeOrNull(io: WriterIo, file: string): Promise<number | null> {
  try {
    return (await io.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/** tmp + rename 原子写（Windows rename 失败 retry 100ms×3；最终失败抛中文错误，tmp 留存可查）。 */
async function atomicWrite(io: WriterIo, file: string, content: string): Promise<void> {
  const tmp = `${file}.cllink-${Date.now()}-${++tmpSeq}.tmp`;
  await io.writeFile(tmp, content);
  try {
    await io.rename(tmp, file);
  } catch {
    // 最终文案不携带底层错误与 tmp 绝对路径（node fs 错误消息内嵌完整路径，透出会向渲染层
    // 泄露用户根目录）；tmp 留存目标目录，前缀 .cllink- 可查。
    for (let i = 0; i < RENAME_RETRY_TIMES; i++) {
      await sleep(RENAME_RETRY_DELAY_MS);
      try {
        await io.rename(tmp, file);
        return;
      } catch {
        // 继续重试
      }
    }
    throw new Error('写入目标文件失败（临时文件保留在目标目录，文件名含 .cllink- 前缀）');
  }
}

/** writeScopedMcpServer 入参。 */
export interface WriteScopedMcpServerInput {
  scope: 'user' | 'project';
  /** project 必填（目标项目目录，写 <dir>/.mcp.json）；user 忽略。 */
  dir?: string;
  entry: ScopedMcpEntry;
  mode: 'upsert' | 'remove';
  /** io 注入（缺省 node:fs/promises + node:os）。 */
  io?: WriterIo;
  /** 用户根目录（user 作用域 ~/.claude.json 定位）；缺省 io.homedir()；生产调用方传
   *  effectiveUserHome() ?? os.homedir()（与 sdk-mcp.ts 注入链同口径）。 */
  userHome?: string;
}

/**
 * 用户级/项目级 mcpServers 条目写入（P8 双向写入；语义见文件头注释）。
 * 返回 { overwrote }：upsert 命中现有同名 → true（remove 恒 false）；「覆盖确认」由 UI 侧
 * snapshot 预查 + requestConfirm 前置完成，本返回值仅作日志用途。
 */
export async function writeScopedMcpServer(input: WriteScopedMcpServerInput): Promise<{ overwrote: boolean }> {
  const io = input.io ?? defaultIo;
  const { scope, entry, mode } = input;
  if (scope !== 'user' && scope !== 'project') throw new Error('非法写入作用域');
  if (mode !== 'upsert' && mode !== 'remove') throw new Error('非法写入模式');
  if (!isPlainObject(entry)) throw new Error('非法写入条目');
  if (typeof entry.name !== 'string' || entry.name === '') throw new Error('服务器名称不能为空');
  if (entry.transport !== 'stdio' && entry.transport !== 'http' && entry.transport !== 'sse') throw new Error('非法传输类型');
  const file =
    scope === 'user'
      ? path.resolve(input.userHome ?? io.homedir(), '.claude.json')
      : path.join(
          (() => {
            if (typeof input.dir !== 'string' || input.dir === '') throw new Error('项目级写入缺少目标目录');
            return input.dir;
          })(),
          '.mcp.json',
        );

  // 单次尝试：stat 记 mtime → 读 → parse → 改（哨兵还原/增删条目）→ 序列化。
  // 返回 content=null 表示「无需写入」（remove 缺名 no-op：文件字节保持不变）。
  const attempt = async (): Promise<{ mtimeAtRead: number | null; content: string | null; overwrote: boolean }> => {
    let mtimeAtRead: number | null = await statMtimeOrNull(io, file);
    let text: string | null = null;
    if (mtimeAtRead !== null) {
      try {
        text = await io.readFile(file);
      } catch (e) {
        if (isEnoent(e)) {
          mtimeAtRead = null; // stat 与 read 间隙被删 → 按「文件不存在」处理
        } else {
          // 只透出 errno code（e.message 内嵌绝对路径，不透出渲染层）
          throw new Error(`读取目标文件失败：${(e as NodeJS.ErrnoException).code ?? '未知错误'}`);
        }
      }
    }
    let tree: Record<string, unknown>;
    if (text === null) {
      tree = {};
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('文件损坏，已中止写入');
      }
      if (!isPlainObject(parsed)) throw new Error('文件损坏，已中止写入'); // 根为数组/标量同损坏
      tree = parsed;
    }
    // mcpServers 表：null 原型载体重建（键序保留；磁盘键含 __proto__ 时作普通自有键搬运）。
    // 键存在但非对象（如 "oops"）→ 不可承载条目，重建为空表后按模式写入。
    const rawTable = tree.mcpServers;
    const table = Object.create(null) as Record<string, unknown>;
    if (isPlainObject(rawTable)) {
      for (const [k, v] of Object.entries(rawTable)) table[k] = v;
    }
    if (mode === 'remove') {
      if (!Object.prototype.hasOwnProperty.call(table, entry.name)) {
        return { mtimeAtRead, content: null, overwrote: false }; // 缺名 no-op：不触盘
      }
      delete table[entry.name];
      tree.mcpServers = table;
      return { mtimeAtRead, content: JSON.stringify(tree, null, 2) + '\n', overwrote: false };
    }
    // upsert：哨兵还原的数据源 = 覆盖前同名条目（新键 → 无原值 → 哨兵键丢弃）。
    const storedRaw = table[entry.name];
    const env = restoreRecordValues(entry.env, isPlainObject(storedRaw) ? storedRaw.env : undefined, entry.envRenameFrom);
    const headers = restoreRecordValues(entry.headers, isPlainObject(storedRaw) ? storedRaw.headers : undefined, entry.headersRenameFrom);
    const overwrote = Object.prototype.hasOwnProperty.call(table, entry.name);
    table[entry.name] = entryToFileShape(entry, env, headers);
    tree.mcpServers = table;
    return { mtimeAtRead, content: JSON.stringify(tree, null, 2) + '\n', overwrote };
  };

  let result = await attempt();
  if (result.content === null) return { overwrote: false };
  let mtimeNow = await statMtimeOrNull(io, file);
  if (mtimeNow !== result.mtimeAtRead) {
    // 写前 mtime 与读时不一致 → 重读重试整个流程一次；仍冲突 → 抛错（不盲写）。
    result = await attempt();
    if (result.content === null) return { overwrote: false };
    mtimeNow = await statMtimeOrNull(io, file);
    if (mtimeNow !== result.mtimeAtRead) {
      throw new Error('文件已被其他程序修改，请重试');
    }
  }
  await atomicWrite(io, file, result.content);
  return { overwrote: result.overwrote };
}
