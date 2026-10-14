// selftest-mcp-settings.ts
// MCP 管理契约 selftest 断言集（docs/plans/2026-10-12-mcp-management-plan.md §2 P9 / §5 T1）。
// 纯函数断言：不依赖 Electron runtime、不读任何磁盘配置（绝不触碰真实 ~/.claude.json），
// 直接 import src/main/modules/mcp/mcp-config.ts 与 sdk-mcp.ts（两文件均不得 import electron）。
//
// 断言集分五组（§5 T1 全集）：
//   A sanitize 组：sanitizeMcpServersConfig / sanitizeMcpOverridesConfig——P1 已实现，
//     RED 阶段本组应【全 PASS】（作为断言集自身的基线自证）。
//   B parseMcpServersJson 组：三形态 / transport 判定 / 坏 JSON·坏根 → ok:false 中文 error。
//   C toSdkMcpServerConfig 组：stdio（env 空对象省略）/ http / sse 三形。
//   D mergeMcpServersForSession 组：三层合并同名覆盖顺序 managed > project > user；
//     override 禁用 user:/project:<dirKey>:/managed: 前缀键；projectDirKey=null 项目级不参与；
//     全空 → {}；项目级 override 仅同目录键生效。
//   E sdk-mcp 组：buildSessionMcpOverridesForPin / parseSessionMcpOverrides /
//     mergeMcpServersIntoSettings（空配置字节级一致 / 会话钉住优先 / 存量 null 回退全局 /
//     幽灵键跳过不崩；io 注入内存 stub，默认实现暂缺不在此路径）。
//   F §1.3 脱敏闭环组（r3 修复 F2 新增）：maskMcpServersForRenderer（值全变哨兵/键保留/
//     入参不被变异/无该字段不添加）+ restoreMaskedMcpServers（同键哨兵还原/改名 hint/无 hint
//     丢键/非哨兵透传/id 对位优先 name 兜底/瞬态字段剥离）+ mask→restore 往返 deepEqual。
//   G R2 mtime 缓存组（2026-10-13 mcp-followup R2 新增）：readUserMcpServersRawSync 的
//     用户级 ~/.claude.json 读取 mtime 缓存（初读/改写失效/clearMcpRawCache 后等价/同 mtime
//     重复读稳定/损坏不缓存）；临时目录 os.tmpdir() 下自建跑完清理，绝不触真实 ~/.claude.json。
//     （注：P8a mcp-writer 未来落地时，writer 组顺延命名——原预留 H 已被 R5 三态文案组占用。）
//   H R5 三态文案组（2026-10-13 mcp-followup R5 新增）：McpSettings.vue 项目作用域空列表
//     三态互斥的静态源码钉（渲染层组件无纯函数可行为级断言，沿 tdd-bridge-ui-static-verify
//     先例读源码断言）：消失态文案逐字存在、isProjectDirGone 判定含 project 作用域守卫
//    （消失态不得误报管理库/user/未选目录态）、p4 快照失败占位先于空态块、分支嵌套顺序。
//   I D-V1-1 注入挂载组（2026-10-13 mcp-followup R4 修复新增）：buildNativeSdkOptionsCore 在
//     settings.mcpServers 非空时把同一归一 map 挂到顶层 Options.mcpServers（strictMcpConfig=true
//     下 SDK 只认顶层 mcpServers，settings 块内键被忽略——D-V1-1 根因）；空配置（三层全空/全禁用/
//     空对象防御边界）零挂载；挂载载体（null 原型）可被 JSON 无损序列化（SDK --mcp-config 走
//     JSON.stringify）。全链真实构造：mergeMcpServersIntoSettings 产 settings 块 → 核心工厂产 options。
//     （sdk-command-options.ts 仅类型 import，纯 node 可直接 import。）
//
// RED 阶段预期（p9a，B/C/D 组函数为 P2 桩、E 组函数为 P5 桩，桩体一律 throw
// not implemented）：A 组全 PASS，B/C/D/E 组全 FAIL（失败详情为「调用抛错：not
// implemented: …」）。P2/P5 实现后应全 PASS（GREEN）。R2 RED：G 组因
// clearMcpRawCache 未导出而 FAIL（调用抛错），实现后转 GREEN。
//
// 退出码约定：任一断言 FAIL → 1；全 PASS → 末行打印 `selftest-mcp-settings: OK`，退出码 0。
// 运行：npx tsx scripts/selftest-mcp-settings.ts
// 清单注意：p9a（RED）阶段本文件【不】追加进 scripts/selftest-static-list.txt（避免红脚本
// 进入 T2 链）；p9b 转绿验收后由 p9b 追加。

import {
  sanitizeMcpServersConfig,
  sanitizeMcpOverridesConfig,
  parseMcpServersJson,
  toSdkMcpServerConfig,
  mergeMcpServersForSession,
  MCP_MASK_SENTINEL,
  maskMcpServersForRenderer,
  restoreMaskedMcpServers,
  type McpManagedSaveEntry,
  type ParsedMcpEntry,
} from '../src/main/modules/mcp/mcp-config';
import {
  buildSessionMcpOverridesForPin,
  parseSessionMcpOverrides,
  mergeMcpServersIntoSettings,
} from '../src/main/modules/mcp/sdk-mcp';
import { clearMcpRawCache, readUserMcpServersRawSync } from '../src/main/modules/mcp/mcp-scanner';
// D-V1-1 注入挂载组（I 组）被测函数：核心 options 工厂（仅类型 import，纯 node 可直接 import）。
import { buildNativeSdkOptionsCore } from '../src/main/modules/sdk-command-options';
import type { AppConfig, McpManagedServer } from '../src/shared/types/config';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let pass = 0;
let fail = 0;
function check(no: string, name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${no} ${name}`); }
  else { fail += 1; console.log(`  ❌ ${no} ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** 键序不敏感的结构相等（canonical 序列化：对象键排序后比较；数组保序）。 */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const obj = v as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canon(obj[k])}`).join(',')}}`;
}
function eq(a: unknown, b: unknown): boolean {
  return canon(a) === canon(b);
}
function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

type CallResult<T> = { ok: true; value: T } | { ok: false; error: Error };
/** 安全调用：桩 throw not implemented（或 GREEN 阶段的任何异常）→ 记为该子断言失败而非脚本崩溃。 */
function call<T>(fn: () => T): CallResult<T> {
  try { return { ok: true, value: fn() }; }
  catch (e) { return { ok: false, error: e instanceof Error ? e : new Error(String(e)) }; }
}
/** call 失败分支的详情文案（RED 阶段即「not implemented: …」证据行）。 */
function throwDetail(r: { ok: false; error: Error }): string {
  return `调用抛错：${r.error.message}（桩未实现，RED 预期）`;
}

/** 构造合法 McpManagedServer（sanitize/merge 输入用）。 */
let managedSeq = 0;
function mkManaged(name: string, transport: 'stdio' | 'http' | 'sse', extra: Partial<McpManagedServer> = {}): McpManagedServer {
  managedSeq += 1;
  return { id: `id-${managedSeq}`, name, description: '', transport, createdAt: 1700000000000, updatedAt: 1700000000000, ...extra };
}

/** mergeMcpServersIntoSettings 的 io 注入 stub（内存表，确定性；绝不读真实 ~/.claude.json）。 */
type MergeIo = {
  readUser: () => Record<string, ParsedMcpEntry>;
  readProject: (dir: string) => Record<string, ParsedMcpEntry>;
};
const ioOf = (user: Record<string, ParsedMcpEntry>): MergeIo => ({
  readUser: () => user,
  readProject: () => ({}),
});
const EMPTY_PROJECT: Record<string, ParsedMcpEntry> = {};
/** 以空 out（或 seed 播种的副本）调 mergeMcpServersIntoSettings，返回调用后的 out（或抛错）。 */
function mergeCall(
  config: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  sessionRow: { mcpOverrides: Record<string, 'off'> | null; workingDir?: string | null } | null,
  io: MergeIo,
  seed?: Record<string, unknown>,
): CallResult<Record<string, unknown>> {
  const out: Record<string, unknown> = seed ? { ...seed } : {};
  try {
    mergeMcpServersIntoSettings(out, config, sessionRow, null, io);
    return { ok: true, value: out };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e : new Error(String(e)) };
  }
}

// ── A. sanitize 组（P1 已实现——RED 阶段基线，应全 PASS）─────────────────────

console.log('\n=== A. sanitize 组（sanitizeMcpServersConfig / sanitizeMcpOverridesConfig） ===');

// A1 合法条目逐字段保留（stdio 全字段 / http 带 headers / sse 无 headers）。
{
  const sub: string[] = [];
  const input = [
    { id: 'id-1', name: 'alpha', description: '第一台', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, createdAt: 100, updatedAt: 200 },
    { id: 'id-2', name: 'beta', description: '', transport: 'http', url: 'https://e/mcp', headers: { 'X-A': '1' }, createdAt: 100, updatedAt: 200 },
    { id: 'id-3', name: 'gamma', description: '', transport: 'sse', url: 'https://e/sse', createdAt: 100, updatedAt: 200 },
  ];
  const out = sanitizeMcpServersConfig(input);
  if (out.length !== 3) sub.push(`应保留 3 条，得到 ${out.length}`);
  if (!eq(out[0], { id: 'id-1', name: 'alpha', description: '第一台', transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { A: '1' }, createdAt: 100, updatedAt: 200 })) sub.push(`alpha 应逐字段保留：${canon(out[0])}`);
  if (!eq(out[1], { id: 'id-2', name: 'beta', description: '', transport: 'http', url: 'https://e/mcp', headers: { 'X-A': '1' }, createdAt: 100, updatedAt: 200 })) sub.push(`beta 应逐字段保留：${canon(out[1])}`);
  if (!eq(out[2], { id: 'id-3', name: 'gamma', description: '', transport: 'sse', url: 'https://e/sse', createdAt: 100, updatedAt: 200 })) sub.push(`gamma 应逐字段保留：${canon(out[2])}`);
  check('A1', 'sanitize：合法 stdio/http/sse 条目逐字段保留', sub.length === 0, sub.join('; '));
}

// A2 非法 name（中文/空格/斜杠/超 64/空）丢弃；64 字符合法边界保留。
{
  const sub: string[] = [];
  const badNames = ['服务器', 'my server', 'a/b', 'a'.repeat(65), ''];
  const badInput = badNames.map((n, i) => ({ id: `id-${i}`, name: n, transport: 'stdio', command: 'c' }));
  if (sanitizeMcpServersConfig(badInput).length !== 0) sub.push('中文/空格/斜杠/超64/空 name 均应丢弃');
  const edge = sanitizeMcpServersConfig([{ id: 'id-e', name: 'a'.repeat(64), transport: 'stdio', command: 'c' }]);
  if (edge.length !== 1) sub.push('64 字符 name（合法上界）应保留');
  check('A2', 'sanitize：非法 name（中文/空格/斜杠/超64/空）丢弃；64 字符边界保留', sub.length === 0, sub.join('; '));
}

// A3 重名保留第一条。
{
  const sub: string[] = [];
  const out = sanitizeMcpServersConfig([
    { id: 'first', name: 'dup', transport: 'stdio', command: 'c1' },
    { id: 'second', name: 'dup', transport: 'stdio', command: 'c2' },
  ]);
  if (out.length !== 1) sub.push(`重名应只保留 1 条，得到 ${out.length}`);
  else if (out[0].id !== 'first' || out[0].command !== 'c1') sub.push(`应保留第一条（id=first, command=c1）：${canon(out[0])}`);
  check('A3', 'sanitize：name 重复 → 保留第一条', sub.length === 0, sub.join('; '));
}

// A4 字段互斥归一（stdio 带 url/headers → 丢；http/sse 带 command/args/env → 丢）。
{
  const sub: string[] = [];
  const stdio = sanitizeMcpServersConfig([{ id: 's', name: 's1', transport: 'stdio', command: 'c', url: 'https://x', headers: { H: '1' } }])[0];
  if (!stdio || !('command' in stdio) || 'url' in stdio || 'headers' in stdio) sub.push('stdio 带 url/headers → url/headers 应被丢、command 保留');
  const http = sanitizeMcpServersConfig([{ id: 'h', name: 'h1', transport: 'http', url: 'https://x', command: 'c', args: ['a'], env: { E: '1' } }])[0];
  if (!http || !('url' in http) || 'command' in http || 'args' in http || 'env' in http) sub.push('http 带 command/args/env → command/args/env 应被丢、url 保留');
  check('A4', 'sanitize：字段互斥归一（stdio 丢 url/headers；http/sse 丢 command/args/env）', sub.length === 0, sub.join('; '));
}

// A5 transport 与必填不匹配 → 整条丢弃（空串同「无」）。
{
  const sub: string[] = [];
  const out = sanitizeMcpServersConfig([
    { id: 'a', name: 'n1', transport: 'stdio' },
    { id: 'b', name: 'n2', transport: 'stdio', command: '' },
    { id: 'c', name: 'n3', transport: 'http' },
    { id: 'd', name: 'n4', transport: 'sse', url: '' },
  ]);
  if (out.length !== 0) sub.push(`stdio 无 command / http·sse 无 url 均应丢弃，得到 ${out.length} 条`);
  check('A5', 'sanitize：transport 与必填不匹配（含空串）→ 整条丢弃', sub.length === 0, sub.join('; '));
}

// A6 时间戳非数字/缺失 → Date.now() 兜底。
{
  const sub: string[] = [];
  const before = Date.now();
  const out = sanitizeMcpServersConfig([
    { id: 'a', name: 't1', transport: 'stdio', command: 'c', createdAt: 'x', updatedAt: Number.NaN },
    { id: 'b', name: 't2', transport: 'http', url: 'https://u' },
  ]);
  const after = Date.now();
  for (const s of out) {
    for (const key of ['createdAt', 'updatedAt'] as const) {
      const v = s[key];
      if (!(typeof v === 'number' && Number.isFinite(v) && v >= before && v <= after)) sub.push(`${s.name}.${key} 应兜底为调用时刻 Date.now()：${String(v)}`);
    }
  }
  check('A6', 'sanitize：时间戳非数字（\'x\'/NaN/缺失）→ Date.now() 兜底', sub.length === 0, sub.join('; '));
}

// A7 非数组输入（undefined/null/标量/对象）→ []。
{
  const sub: string[] = [];
  for (const dirty of [undefined, null, 'x', 42, { a: 1 }] as unknown[]) {
    if (sanitizeMcpServersConfig(dirty).length !== 0) sub.push(`sanitize(${String(dirty)}) → 应为 []`);
  }
  check('A7', 'sanitize：undefined/null/标量/对象 → []（旧配置缺键不报错）', sub.length === 0, sub.join('; '));
}

// A8 override 脏值清洗 + Object.create(null) 载体（__proto__ 原型安全）。
{
  const sub: string[] = [];
  for (const dirty of [null, undefined, 'x', 42, [1]] as unknown[]) {
    if (!eq(sanitizeMcpOverridesConfig(dirty), {})) sub.push(`sanitizeMcpOverridesConfig(${String(dirty)}) → 应为 {}`);
  }
  if (!eq(sanitizeMcpOverridesConfig({ a: 'off', b: 'on', c: 1, d: null, e: { f: 'off' } }), { a: 'off' })) sub.push('仅值==="off" 的 string 键条目应保留');
  const plain = sanitizeMcpOverridesConfig({ a: 'off' });
  if (Object.getPrototypeOf(plain) !== null) sub.push('输出载体应为 Object.create(null)（null 原型，防 __proto__/constructor 污染）');
  // __proto__ 自有键输入（JSON.parse 可产出）：不抛错、载体仍 null 原型、合法键保留、不污染 Object.prototype。
  const dirty = JSON.parse('{"__proto__":"off","k":"off"}') as Record<string, unknown>;
  const pollutedProbe = {} as Record<string, unknown>;
  let out2: Record<string, 'off'> | null = null;
  try { out2 = sanitizeMcpOverridesConfig(dirty); } catch (e) { sub.push(`__proto__ 键输入抛错：${errMsg(e)}`); }
  if (out2) {
    if (Object.getPrototypeOf(out2) !== null) sub.push('__proto__ 键输入：输出载体仍应为 null 原型');
    if (!Object.prototype.hasOwnProperty.call(out2, 'k') || out2.k !== 'off') sub.push('__proto__ 键输入：合法键 k 应保留为 "off"');
  }
  if (pollutedProbe.k !== undefined) sub.push('Object.prototype 被污染（不应发生）');
  check('A8', 'sanitizeOverrides：非对象→{}；值非 "off" 丢弃；null 原型载体 + __proto__ 键不污染', sub.length === 0, sub.join('; '));
}

// A9 env/headers 值级清洗（R1）：值非 string（number/boolean/null/对象/数组）→ 仅丢该键；
// string 值保留（键序保持）；空串 '' 是合法 string 保留；全合法 env/headers 原样保留不回归。
{
  const sub: string[] = [];
  // a+c（混合法与非法）：env {A:'x',N:123,B:null,C:{}} → 仅 {A:'x'}；headers 同款 → 仅留 string。
  const mixedStdio = sanitizeMcpServersConfig([{ id: 'v1', name: 'v1', transport: 'stdio', command: 'c', env: { A: 'x', N: 123, B: null, C: {} } }])[0];
  if (!mixedStdio) sub.push('env 混合法/非法：stdio 条目本身不应被丢弃');
  else if (!eq(mixedStdio.env, { A: 'x' })) sub.push(`env 应仅保留 string 值 {A:'x'}：${canon(mixedStdio.env)}`);
  const mixedHttp = sanitizeMcpServersConfig([{ id: 'v2', name: 'v2', transport: 'http', url: 'https://x/mcp', headers: { H: 'v', N: 123, B: null, C: {} } }])[0];
  if (!mixedHttp) sub.push('headers 混合法/非法：http 条目本身不应被丢弃');
  else if (!eq(mixedHttp.headers, { H: 'v' })) sub.push(`headers 应仅保留 string 值 {H:'v'}：${canon(mixedHttp.headers)}`);
  // d（合法条目不回归）：env:{A:'x',B:'y'} / headers:{h:'v'} 原样保留。
  const legalStdio = sanitizeMcpServersConfig([{ id: 'v3', name: 'v3', transport: 'stdio', command: 'c', env: { A: 'x', B: 'y' } }])[0];
  if (!legalStdio || !eq(legalStdio.env, { A: 'x', B: 'y' })) sub.push(`全合法 env 应原样保留 {A:'x',B:'y'}：${legalStdio ? canon(legalStdio.env) : '条目丢失'}`);
  const legalHttp = sanitizeMcpServersConfig([{ id: 'v4', name: 'v4', transport: 'http', url: 'https://x/mcp', headers: { h: 'v' } }])[0];
  if (!legalHttp || !eq(legalHttp.headers, { h: 'v' })) sub.push(`全合法 headers 应原样保留 {h:'v'}：${legalHttp ? canon(legalHttp.headers) : '条目丢失'}`);
  // e（空串值边界）：'' 是合法 string，保留。
  const emptyStr = sanitizeMcpServersConfig([{ id: 'v5', name: 'v5', transport: 'stdio', command: 'c', env: { E: '', A: 'x' } }])[0];
  if (!emptyStr || !eq(emptyStr.env, { E: '', A: 'x' })) sub.push(`空串值 '' 是合法 string 应保留：${emptyStr ? canon(emptyStr.env) : '条目丢失'}`);
  check('A9', 'sanitize：env/headers 值级清洗——非 string 值仅丢该键，string（含空串）保留，全合法原样', sub.length === 0, sub.join('; '));
}

// A10 env/headers 值全部非法 → 该字段整体消失（不输出空对象）；条目本身不丢。
{
  const sub: string[] = [];
  const stdio = sanitizeMcpServersConfig([{ id: 'v6', name: 'v6', transport: 'stdio', command: 'c', env: { N: 1, B: null } }])[0];
  if (!stdio) sub.push('env 全非法：stdio 条目本身应保留');
  else if ('env' in stdio) sub.push(`env 全非法值 → env 字段应消失（不得是空对象）：${canon(stdio.env)}`);
  const http = sanitizeMcpServersConfig([{ id: 'v7', name: 'v7', transport: 'http', url: 'https://x/mcp', headers: { N: 1, B: null } }])[0];
  if (!http) sub.push('headers 全非法：http 条目本身应保留');
  else if ('headers' in http) sub.push(`headers 全非法值 → headers 字段应消失（不得是空对象）：${canon(http.headers)}`);
  check('A10', 'sanitize：env/headers 全部值非法 → 字段消失（非空对象），条目保留', sub.length === 0, sub.join('; '));
}

// ── B. parseMcpServersJson 组（P2 桩——RED 阶段按 not implemented 转 FAIL）──

console.log('\n=== B. parseMcpServersJson 组（三形态 / transport 判定 / 失败形态） ===');

// B1 三种导入形态。
{
  const sub: string[] = [];
  const r1 = call(() => parseMcpServersJson(JSON.stringify({ mcpServers: { fs: { command: 'npx', args: ['-y', 'mcp-fs'] } } })));
  if (!r1.ok) sub.push(`形态① {"mcpServers":{...}}：${throwDetail(r1)}`);
  else if (!r1.value.ok) sub.push(`形态① 应 ok:true：${r1.value.error}`);
  else {
    const e = r1.value.servers[0];
    if (r1.value.servers.length !== 1 || !e || e.name !== 'fs' || e.transport !== 'stdio' || e.command !== 'npx' || !eq(e.args, ['-y', 'mcp-fs'])) sub.push(`形态① 条目不符：${canon(r1.value.servers)}`);
  }
  const r2 = call(() => parseMcpServersJson(JSON.stringify({ git: { url: 'https://x/mcp' } })));
  if (!r2.ok) sub.push(`形态② 裸 map：${throwDetail(r2)}`);
  else if (!r2.value.ok) sub.push(`形态② 应 ok:true：${r2.value.error}`);
  else {
    const e = r2.value.servers[0];
    if (r2.value.servers.length !== 1 || !e || e.name !== 'git' || e.transport !== 'http' || e.url !== 'https://x/mcp') sub.push(`形态② 条目不符：${canon(r2.value.servers)}`);
  }
  const r3 = call(() => parseMcpServersJson(JSON.stringify({ servers: { vs: { url: 'https://x/sse' } } })));
  if (!r3.ok) sub.push(`形态③ {"servers":{...}}：${throwDetail(r3)}`);
  else if (!r3.value.ok) sub.push(`形态③ 应 ok:true：${r3.value.error}`);
  else {
    const e = r3.value.servers[0];
    if (r3.value.servers.length !== 1 || !e || e.name !== 'vs' || e.transport !== 'sse') sub.push(`形态③ 条目不符：${canon(r3.value.servers)}`);
  }
  check('B1', '三形态：{"mcpServers"} / 裸 map / {"servers"} 均可解析且 name 取 map 键', sub.length === 0, sub.join('; '));
}

// B2 transport 判定（显式 type 优先，streamable-http→http；无 type：command→stdio，url /sse 后缀→sse 否则 http）。
{
  const sub: string[] = [];
  const cases: Array<{ label: string; key: string; cfg: Record<string, unknown>; want: 'stdio' | 'http' | 'sse' }> = [
    { label: '显式 type streamable-http → http（优先于 /sse 后缀）', key: 't1', cfg: { type: 'streamable-http', url: 'https://x/sse' }, want: 'http' },
    { label: '显式 type sse', key: 't2', cfg: { type: 'sse', url: 'https://x/rpc' }, want: 'sse' },
    { label: '显式 type http', key: 't3', cfg: { type: 'http', url: 'https://x/mcp' }, want: 'http' },
    { label: '显式 type stdio 优先（带 url 也判 stdio）', key: 't4', cfg: { type: 'stdio', command: 'npx', url: 'https://x/sse' }, want: 'stdio' },
    { label: '无 type 有 command → stdio（优先于 url）', key: 't5', cfg: { command: 'uvx', url: 'https://x/sse' }, want: 'stdio' },
    { label: '无 type url 以 /sse 结尾 → sse', key: 't6', cfg: { url: 'https://x/sse' }, want: 'sse' },
    { label: '无 type url 非 /sse → http', key: 't7', cfg: { url: 'https://x/mcp' }, want: 'http' },
  ];
  for (const c of cases) {
    const r = call(() => parseMcpServersJson(JSON.stringify({ [c.key]: c.cfg })));
    if (!r.ok) { sub.push(`${c.label}：${throwDetail(r)}`); continue; }
    if (!r.value.ok) { sub.push(`${c.label}：应 ok:true，得到 ok:false（${r.value.error}）`); continue; }
    const e = r.value.servers[0];
    if (!e || e.name !== c.key || e.transport !== c.want) sub.push(`${c.label}：实际 ${e ? `${e.name}/${e.transport}` : '空'}`);
  }
  check('B2', 'transport 判定：显式 type 优先（streamable-http→http）；command→stdio；url /sse 后缀→sse 否则 http', sub.length === 0, sub.join('; '));
}

// B3 失败形态 → ok:false + 非空中文 error。
{
  const sub: string[] = [];
  const badCases: Array<{ label: string; text: string }> = [
    { label: '坏 JSON', text: '{not-json' },
    { label: '根为数组', text: '[1,2]' },
    { label: '根为字符串', text: '"str"' },
    { label: '根为 null', text: 'null' },
    { label: 'servers 非对象', text: JSON.stringify({ mcpServers: 'oops' }) },
  ];
  for (const c of badCases) {
    const r = call(() => parseMcpServersJson(c.text));
    if (!r.ok) { sub.push(`${c.label}：${throwDetail(r)}`); continue; }
    if (r.value.ok) { sub.push(`${c.label}：应 ok:false`); continue; }
    if (typeof r.value.error !== 'string' || r.value.error.length === 0 || !/[\u4e00-\u9fff]/.test(r.value.error)) sub.push(`${c.label}：error 应为非空中文消息：${canon(r.value.error)}`);
  }
  check('B3', '失败形态（坏 JSON/根非对象/servers 非对象）→ ok:false 且中文 error', sub.length === 0, sub.join('; '));
}

// ── C. toSdkMcpServerConfig 组（P2 桩——RED 阶段同上）────────────────────────

console.log('\n=== C. toSdkMcpServerConfig 组（stdio/http/sse 三形） ===');

// C1 stdio 全字段透传。
{
  const r = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } }));
  const sub: string[] = [];
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, { type: 'stdio', command: 'npx', args: ['-y', 'x'], env: { A: '1' } })) sub.push(`stdio 形不符：${canon(r.value)}`);
  check('C1', 'stdio 形：type/command/args/env 透传', sub.length === 0, sub.join('; '));
}

// C2 stdio：env 未提供/空对象 → env 键省略。
{
  const sub: string[] = [];
  const r1 = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx' }));
  if (!r1.ok) sub.push(`env 未提供：${throwDetail(r1)}`);
  else if (!eq(r1.value, { type: 'stdio', command: 'npx' }) || 'env' in r1.value) sub.push(`env 未提供时应省略 env 键：${canon(r1.value)}`);
  const r2 = call(() => toSdkMcpServerConfig({ transport: 'stdio', command: 'npx', env: {} }));
  if (!r2.ok) sub.push(`env 为 {}：${throwDetail(r2)}`);
  else if (!eq(r2.value, { type: 'stdio', command: 'npx' }) || 'env' in r2.value) sub.push(`env 为空对象时应省略 env 键：${canon(r2.value)}`);
  check('C2', 'stdio 形：env 未提供/空对象 → env 键省略', sub.length === 0, sub.join('; '));
}

// C3 http 形。
{
  const r = call(() => toSdkMcpServerConfig({ transport: 'http', url: 'https://e/mcp', headers: { Authorization: 'Bearer t' } }));
  const sub: string[] = [];
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, { type: 'http', url: 'https://e/mcp', headers: { Authorization: 'Bearer t' } })) sub.push(`http 形不符：${canon(r.value)}`);
  check('C3', 'http 形：type/url/headers 透传（headers key 不做大小写变换）', sub.length === 0, sub.join('; '));
}

// C4 sse 形：headers 未提供 → 键省略；提供 → 透传。
{
  const sub: string[] = [];
  const r1 = call(() => toSdkMcpServerConfig({ transport: 'sse', url: 'https://e/sse' }));
  if (!r1.ok) sub.push(`sse 无 headers：${throwDetail(r1)}`);
  else if (!eq(r1.value, { type: 'sse', url: 'https://e/sse' }) || 'headers' in r1.value) sub.push(`sse 无 headers 时应省略 headers 键：${canon(r1.value)}`);
  const r2 = call(() => toSdkMcpServerConfig({ transport: 'sse', url: 'https://e/sse2', headers: { H: 'v' } }));
  if (!r2.ok) sub.push(`sse 带 headers：${throwDetail(r2)}`);
  else if (!eq(r2.value, { type: 'sse', url: 'https://e/sse2', headers: { H: 'v' } })) sub.push(`sse 带 headers 应透传：${canon(r2.value)}`);
  check('C4', 'sse 形：headers 未提供 → 键省略；提供 → 透传', sub.length === 0, sub.join('; '));
}

// ── D. mergeMcpServersForSession 组（P2 桩——RED 阶段同上）───────────────────

console.log('\n=== D. mergeMcpServersForSession 组（三层合并 / override 禁用 / projectDirKey） ===');

// D1 同名覆盖顺序 managed > project > user（先放 user，再 project 覆盖，最后 managed 覆盖）。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('srv', 'stdio', { command: 'managed-cmd' })],
    userServers: { srv: { name: 'srv', transport: 'http', url: 'https://user' }, u2: { name: 'u2', transport: 'http', url: 'https://user-u2' } },
    projectServers: { srv: { name: 'srv', transport: 'sse', url: 'https://project/sse' } },
    overrides: {},
    projectDirKey: 'd1',
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if (!eq(r.value.srv, { type: 'stdio', command: 'managed-cmd' })) sub.push(`同名 srv 应取 managed 定义：${canon(r.value.srv)}`);
    if (!eq(r.value.u2, { type: 'http', url: 'https://user-u2' })) sub.push(`无同名 user 条目应保留：${canon(r.value.u2)}`);
  }
  check('D1', '三层合并同名覆盖顺序：managed > project > user', sub.length === 0, sub.join('; '));
}

// D2 override 禁用 user:/project:<dirKey>:/managed: 前缀键各自生效；值非 'off' 不禁用。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('m1', 'stdio', { command: 'mc1' }), mkManaged('m2', 'stdio', { command: 'mc2' })],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' }, u2: { name: 'u2', transport: 'sse', url: 'https://user-u2/sse' } },
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'user:u1': 'off', 'project:d1:p1': 'off', 'managed:m1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(Object.keys(r.value).sort(), ['m2', 'u2'])) sub.push(`被禁用的 u1/p1/m1 应缺席，仅剩 m2/u2：${canon(Object.keys(r.value).sort())}`);
  const r2 = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' } },
    projectServers: {},
    overrides: { 'user:u1': 'on' } as unknown as Record<string, 'off'>,
    projectDirKey: 'd1',
  }));
  if (!r2.ok) sub.push(`值非 'off'：${throwDetail(r2)}`);
  else if (!eq(Object.keys(r2.value), ['u1'])) sub.push(`override 值非 'off'（'on'）不应禁用：${canon(Object.keys(r2.value))}`);
  check('D2', 'override 禁用：user:/project:<dirKey>:/managed: 前缀键各自生效；值非 "off" 不禁用', sub.length === 0, sub.join('; '));
}

// D3 projectDirKey=null → 项目级整体不参与（user/managed 照常）。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({
    managed: [mkManaged('m1', 'stdio', { command: 'mc1' })],
    userServers: { u1: { name: 'u1', transport: 'http', url: 'https://user-u1' } },
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: {},
    projectDirKey: null,
  }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(Object.keys(r.value).sort(), ['m1', 'u1'])) sub.push(`projectDirKey=null 时项目级 p1 应缺席，仅剩 m1/u1：${canon(Object.keys(r.value).sort())}`);
  check('D3', 'projectDirKey=null → 项目级整体不参与', sub.length === 0, sub.join('; '));
}

// D4 三层全空 → 结果 {}。
{
  const sub: string[] = [];
  const r = call(() => mergeMcpServersForSession({ managed: [], userServers: {}, projectServers: {}, overrides: {}, projectDirKey: 'd1' }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, {}) || Object.keys(r.value).length !== 0) sub.push(`全空输入应得 {}：${canon(r.value)}`);
  check('D4', '三层全空 → 结果 {}（空配置不注入的源头）', sub.length === 0, sub.join('; '));
}

// D5 项目级 override 仅与 projectDirKey 一致的目录键生效（跨目录 override 不误伤）。
{
  const sub: string[] = [];
  const rKeep = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: {},
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'project:d2:p1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!rKeep.ok) sub.push(`跨目录键：${throwDetail(rKeep)}`);
  else if (!eq(Object.keys(rKeep.value), ['p1'])) sub.push(`project:d2:p1（目录键 d2≠d1）不应禁用 p1：${canon(Object.keys(rKeep.value))}`);
  const rOff = call(() => mergeMcpServersForSession({
    managed: [],
    userServers: {},
    projectServers: { p1: { name: 'p1', transport: 'sse', url: 'https://proj/sse' } },
    overrides: { 'project:d1:p1': 'off' },
    projectDirKey: 'd1',
  }));
  if (!rOff.ok) sub.push(`同目录键：${throwDetail(rOff)}`);
  else if (Object.keys(rOff.value).length !== 0) sub.push(`project:d1:p1（目录键一致）应禁用 p1：${canon(Object.keys(rOff.value))}`);
  check('D5', '项目级 override 仅 projectDirKey 与来源目录键一致时生效（跨目录不误伤）', sub.length === 0, sub.join('; '));
}

// ── E. sdk-mcp 组（P5 桩——RED 阶段同上）─────────────────────────────────────

console.log('\n=== E. sdk-mcp 组（buildSessionMcpOverridesForPin / parseSessionMcpOverrides / mergeMcpServersIntoSettings） ===');

const M1_MANAGED = mkManaged('m1', 'stdio', { command: 'managed-m1-cmd' });
const M1_SDK = { type: 'stdio', command: 'managed-m1-cmd' };
const U1_ENTRY: ParsedMcpEntry = { name: 'u1', transport: 'http', url: 'https://user-u1' };
const U2_ENTRY: ParsedMcpEntry = { name: 'u2', transport: 'sse', url: 'https://user-u2/sse' };
const U1_SDK = { type: 'http', url: 'https://user-u1' };
const U2_SDK = { type: 'sse', url: 'https://user-u2/sse' };

// E1 buildSessionMcpOverridesForPin：空 → null（无需落库）；非空 → 原样。
{
  const sub: string[] = [];
  const r1 = call(() => buildSessionMcpOverridesForPin({}));
  if (!r1.ok) sub.push(`pin({})：${throwDetail(r1)}`);
  else if (r1.value !== null) sub.push(`pin({}) 应为 null：${canon(r1.value)}`);
  const r2 = call(() => buildSessionMcpOverridesForPin({ a: 'off' }));
  if (!r2.ok) sub.push(`pin({a:off})：${throwDetail(r2)}`);
  else if (!eq(r2.value, { a: 'off' })) sub.push(`pin({a:off}) 应原样：${canon(r2.value)}`);
  const r3 = call(() => buildSessionMcpOverridesForPin({ a: 'off', b: 'off' }));
  if (!r3.ok) sub.push(`pin({a,b})：${throwDetail(r3)}`);
  else if (!eq(r3.value, { a: 'off', b: 'off' })) sub.push(`pin({a:off,b:off}) 应原样：${canon(r3.value)}`);
  check('E1', 'buildSessionMcpOverridesForPin：{} → null；非空 → 原样返回', sub.length === 0, sub.join('; '));
}

// E2 parseSessionMcpOverrides：null/undefined/非对象/无合法条目 → null；合法 → 清洗副本。
// （注：raw 为 JSON 字符串时的行为此处不钉——p5 实现取「对象入参」或「string 兼容」皆可，
//   若做 string 兼容需回补本组断言。）
{
  const sub: string[] = [];
  const dirtyRaws: unknown[] = [null, undefined, 'x', 42, true, [1], { a: 'on' }, { a: 1 }, { a: null }, {}];
  for (const raw of dirtyRaws) {
    const r = call(() => parseSessionMcpOverrides(raw));
    if (!r.ok) { sub.push(`parse(${canon(raw)})：${throwDetail(r)}`); continue; }
    if (r.value !== null) sub.push(`parse(${canon(raw)}) 应为 null：${canon(r.value)}`);
  }
  const ok1 = call(() => parseSessionMcpOverrides({ a: 'off' }));
  if (!ok1.ok) sub.push(`parse({a:off})：${throwDetail(ok1)}`);
  else if (!eq(ok1.value, { a: 'off' })) sub.push(`parse({a:off}) 应等值：${canon(ok1.value)}`);
  const ok2 = call(() => parseSessionMcpOverrides({ a: 'off', b: 'on' }));
  if (!ok2.ok) sub.push(`parse({a:off,b:on})：${throwDetail(ok2)}`);
  else if (!eq(ok2.value, { a: 'off' })) sub.push(`parse({a:off,b:on}) 应仅保留合法键：${canon(ok2.value)}`);
  check('E2', 'parseSessionMcpOverrides：null/undefined/非对象/无合法条目 → null；合法 → 清洗副本', sub.length === 0, sub.join('; '));
}

// E3a 空配置 + io 返回空 → out 无 mcpServers 键且 JSON.stringify 逐字节相等。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [], mcpOverrides: {} };
  const out: Record<string, unknown> = { model: 'claude-x', permissions: { allow: ['Bash'] } };
  const before = JSON.stringify(out);
  // p5 申报修复：p9a 原稿 mergeCall 恒传全新空 out，本断言的播种 out（before 的来源）从未进
  // 被测函数，「字节级一致」子断言对任何合规实现恒假（'{}' ≠ before）。按计划 §5 T1 语义
  //（「输出对象无 mcpServers 键，字节级断言 JSON.stringify 相等」——输出对象=传入的 settings 块）
  // 经 mergeCall 新增可选 seed 参把播种 out 传入；断言本身一字未改。
  const r = mergeCall(cfg, null, ioOf(EMPTY_PROJECT), out);
  if (!r.ok) sub.push(throwDetail(r));
  else {
    if ('mcpServers' in r.value) sub.push('空配置不应写入 mcpServers 键');
    if (JSON.stringify(r.value) !== before) sub.push(`空配置 settings 块应字节级一致：${before} → ${JSON.stringify(r.value)}`);
  }
  check('E3a', '空配置 + io 空 → out 无 mcpServers 键且 JSON.stringify 逐字节相等', sub.length === 0, sub.join('; '));
}

// E3b 非空配置 → out.mcpServers 为预期合并结果（user + managed；io.readProject 空）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = mergeCall(cfg, null, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('非空合并结果应写入 out.mcpServers');
  else if (!eq(r.value.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`合并结果不符：${canon(r.value.mcpServers)}`);
  check('E3b', '非空配置 → out.mcpServers 含 user+managed 预期合并结果', sub.length === 0, sub.join('; '));
}

// E3c 会话钉住优先：sessionRow.mcpOverrides 非空时【取代】config.mcpOverrides（非并集）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u2': 'off' } };
  const row = { mcpOverrides: { 'user:u1': 'off' } as Record<string, 'off'> | null };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`会话钉住应取代全局（u1 禁用、全局对 u2 的 off 被忽略）：${canon(r.value.mcpServers)}`);
  check('E3c', 'sessionRow.mcpOverrides 非空 → 取代 config.mcpOverrides（钉住值优先）', sub.length === 0, sub.join('; '));
}

// E3d sessionRow=null → 用 config.mcpOverrides。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u1': 'off' } };
  const r = mergeCall(cfg, null, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`sessionRow=null 应用全局 override（u1 禁用）：${canon(r.value.mcpServers)}`);
  check('E3d', 'sessionRow=null → 用 config.mcpOverrides', sub.length === 0, sub.join('; '));
}

// E3e 存量会话（row 非 null 但 mcpOverrides=null）→ 回退当前全局 override（§3.14）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: { 'user:u1': 'off' } };
  const row = { mcpOverrides: null };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!('mcpServers' in r.value)) sub.push('应仍有存活服务器可注入');
  else if (!eq(r.value.mcpServers, { u2: U2_SDK, m1: M1_SDK })) sub.push(`mcpOverrides=null 应回退全局（u1 禁用）：${canon(r.value.mcpServers)}`);
  check('E3e', '存量会话 mcpOverrides=null → 回退当前全局 mcpOverrides', sub.length === 0, sub.join('; '));
}

// E3f 会话钉住含已删除同名服务器键（幽灵键）→ 跳过不崩，其余照常注入（§3.8）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const row = { mcpOverrides: { 'user:ghost': 'off', 'managed:ghost': 'off', 'project:dead:ghost': 'off' } as Record<string, 'off'> };
  const r = mergeCall(cfg, row, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(`幽灵键应跳过不崩：${throwDetail(r)}`);
  else if (!('mcpServers' in r.value)) sub.push('幽灵键之外的服务器应照常注入');
  else if (!eq(r.value.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`幽灵键跳过后合并结果不符：${canon(r.value.mcpServers)}`);
  check('E3f', '会话钉住含已删除同名服务器键 → 跳过不崩，其余照常注入', sub.length === 0, sub.join('; '));
}

// ── F. §1.3 脱敏闭环组（r3 修复 F2：renderer 出口掩码 + managedSave 哨兵还原）──

console.log('\n=== F. §1.3 脱敏闭环组（maskMcpServersForRenderer / restoreMaskedMcpServers） ===');

// F1 mask：env/headers 值全变哨兵、键保留；入参不被变异（掩码产物深拷贝）；无 env/headers
// 字段的条目不添加该字段；非敏感字段原样保留。
{
  const sub: string[] = [];
  const input: McpManagedServer[] = [
    mkManaged('f1-stdio', 'stdio', { command: 'npx', args: ['-y', 'x'], env: { A: 'secret-a', B: 'secret-b' } }),
    mkManaged('f1-http', 'http', { url: 'https://e/mcp', headers: { Authorization: 'Bearer t', 'X-K': 'v' } }),
    mkManaged('f1-bare', 'sse', { url: 'https://e/sse' }),
  ];
  const snapshot = canon(input);
  const masked = call(() => maskMcpServersForRenderer(input));
  if (!masked.ok) sub.push(throwDetail(masked));
  else {
    const [m1, m2, m3] = masked.value;
    if (masked.value.length !== 3 || !m1 || !m2 || !m3) sub.push(`掩码产物应保持 3 条：${canon(masked.value)}`);
    else {
      if (!eq(m1.env, { A: MCP_MASK_SENTINEL, B: MCP_MASK_SENTINEL })) sub.push(`env 值应全变哨兵且键保留：${canon(m1.env)}`);
      if (!eq(m2.headers, { Authorization: MCP_MASK_SENTINEL, 'X-K': MCP_MASK_SENTINEL })) sub.push(`headers 值应全变哨兵且键保留：${canon(m2.headers)}`);
      if ('env' in m3 || 'headers' in m3) sub.push('无 env/headers 字段条目不应被添加该字段');
      if (m1.command !== 'npx' || !eq(m1.args, ['-y', 'x']) || m2.url !== 'https://e/mcp') sub.push('非敏感字段应原样保留');
      if (typeof m1.env?.A === 'string') m1.env.A = 'mutated';
      if (!eq(input[0].env, { A: 'secret-a', B: 'secret-b' })) sub.push('掩码产物应深拷贝（改写不波及入参）');
    }
  }
  if (canon(input) !== snapshot) sub.push('入参不可被变异');
  check('F1', 'mask：值全变哨兵且键保留；入参不变异（含深拷贝）；无该字段条目不添加', sub.length === 0, sub.join('; '));
}

// F2a restore：同键哨兵→还原原值；改名+hint→按已存原键还原；改名无 hint→丢该键；
// 非哨兵值→透传；瞬态字段不出现在输出。
{
  const sub: string[] = [];
  const stored: McpManagedServer[] = [
    mkManaged('f2-same', 'stdio', { command: 'c1', env: { A: 'orig-a', B: 'orig-b' } }),
    mkManaged('f2-rename', 'stdio', { command: 'c2', env: { OLD_K: 'orig-old' } }),
    mkManaged('f2-nohint', 'http', { url: 'https://e/no', headers: { H: 'orig-h' } }),
  ];
  const entrySame: McpManagedSaveEntry = { ...stored[0], env: { A: MCP_MASK_SENTINEL, B: MCP_MASK_SENTINEL, C: 'new-plain' } };
  const entryRename: McpManagedSaveEntry = { ...stored[1], env: { NEW_K: MCP_MASK_SENTINEL }, envRenameFrom: { NEW_K: 'OLD_K' } };
  const entryNoHint: McpManagedSaveEntry = { ...stored[2], headers: { H2: MCP_MASK_SENTINEL } }; // 键改名但无 hint
  const r = call(() => restoreMaskedMcpServers([entrySame, entryRename, entryNoHint], stored));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const [o1, o2, o3] = r.value;
    if (r.value.length !== 3 || !o1 || !o2 || !o3) sub.push(`还原产物应保持 3 条：${canon(r.value)}`);
    else {
      if (!eq(o1.env, { A: 'orig-a', B: 'orig-b', C: 'new-plain' })) sub.push(`同键哨兵应还原原值、非哨兵值应透传：${canon(o1.env)}`);
      if (!eq(o2.env, { NEW_K: 'orig-old' })) sub.push(`改名+hint 应按已存原键还原原值：${canon(o2.env)}`);
      if (!eq(o3.headers, {})) sub.push(`改名无 hint（原键不存在）应丢该键：${canon(o3.headers)}`);
      if ('envRenameFrom' in o2 || 'headersRenameFrom' in o2 || 'envRenameFrom' in o3 || 'headersRenameFrom' in o3) sub.push('瞬态字段不得出现在输出');
    }
  }
  check('F2a', 'restore：同键哨兵还原/改名 hint 还原/无 hint 丢键/非哨兵透传/瞬态字段剥离', sub.length === 0, sub.join('; '));
}

// F2b restore 对位：id 对位优先；id 缺失/对不上按 name 兜底。
{
  const sub: string[] = [];
  const stored: McpManagedServer[] = [
    mkManaged('alpha', 'stdio', { command: 'ca', env: { K: 'va' } }),
    mkManaged('beta', 'stdio', { command: 'cb', env: { K: 'vb' } }),
  ];
  // ① id 对位优先：id=alpha 条目的 id 但 name=beta → 按 id 取 alpha 的原值 va。
  const byId: McpManagedSaveEntry = { ...stored[1], id: stored[0].id, name: 'beta', env: { K: MCP_MASK_SENTINEL } };
  // ② id 对不上任何已存条目 → 按 name 兜底（beta → vb）。
  const byName: McpManagedSaveEntry = { ...stored[1], id: 'id-not-exist', env: { K: MCP_MASK_SENTINEL } };
  // ③ id 缺失 → 按 name 兜底（beta → vb）。
  const noId = { name: 'beta', env: { K: MCP_MASK_SENTINEL } } as unknown as McpManagedSaveEntry;
  const r = call(() => restoreMaskedMcpServers([byId, byName, noId], stored));
  if (!r.ok) sub.push(throwDetail(r));
  else {
    const [o1, o2, o3] = r.value;
    if (!o1 || !o2 || !o3) sub.push(`还原产物应保持 3 条：${canon(r.value)}`);
    else {
      if (!eq(o1.env, { K: 'va' })) sub.push(`id 对位应优先于 name（按 id=alpha 还原 va）：${canon(o1.env)}`);
      if (!eq(o2.env, { K: 'vb' })) sub.push(`id 对不上应按 name 兜底（beta→vb）：${canon(o2.env)}`);
      if (!eq(o3.env, { K: 'vb' })) sub.push(`id 缺失应按 name 兜底（beta→vb）：${canon(o3.env)}`);
    }
  }
  check('F2b', '对位：id 对位优先；id 缺失/对不上按 name 兜底', sub.length === 0, sub.join('; '));
}

// F3 端到端：mask→restore 往返后与原值 deepEqual（§1.3 编辑保存闭环等价性；空串值边界在内）。
{
  const sub: string[] = [];
  const original: McpManagedServer[] = [
    mkManaged('f3-stdio', 'stdio', { command: 'npx', args: ['-y', 'srv'], env: { A: 's3cret', EMPTY: '' } }),
    mkManaged('f3-http', 'http', { url: 'https://e/mcp', headers: { Authorization: 'Bearer tok', 'X-Empty': '' } }),
    mkManaged('f3-bare', 'sse', { url: 'https://e/sse' }),
  ];
  const masked = maskMcpServersForRenderer(original);
  const submitted: McpManagedSaveEntry[] = masked.map((s) => ({ ...s })); // 渲染层原样回传掩码产物
  const r = call(() => restoreMaskedMcpServers(submitted, original));
  if (!r.ok) sub.push(throwDetail(r));
  else if (!eq(r.value, original)) sub.push(`mask→restore 往返应与原值 deepEqual：${canon(r.value)}`);
  check('F3', '端到端：mask→restore 往返后与原值 deepEqual（含空串值边界）', sub.length === 0, sub.join('; '));
}

// ── G. R2 mtime 缓存组（readUserMcpServersRawSync 缓存 / clearMcpRawCache）──
// （P8a mcp-writer 未来落地时，writer 组从 H 顺延命名。）

console.log('\n=== G. R2 mtime 缓存组（readUserMcpServersRawSync mtime 缓存 / clearMcpRawCache） ===');

/** 同步忙等（selftest 为同步脚本无事件循环依赖；用于拉开两次写盘的 mtime 间隔——Windows mtime 粒度粗）。 */
function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* busy-wait */ }
}

// 临时 home：os.tmpdir() 下自建唯一目录模拟 userHome，finally 清理——绝不触真实 ~/.claude.json。
const gHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-link-mcp-selftest-g-'));
const gClaudeJson = path.join(gHome, '.claude.json');
/** 读临时 home 的用户级 mcpServers（call 包裹：R2 RED 阶段缺失导出/任何异常 → 断言 FAIL 而非脚本崩溃）。 */
const gRead = (): CallResult<Record<string, ParsedMcpEntry>> => call(() => readUserMcpServersRawSync(gHome));

try {
  // G1 (a) 初读：写含 1 个合法 stdio 条目的 .claude.json → raw 读取返回该条目（未脱敏归一表）。
  {
    const sub: string[] = [];
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g1srv: { command: 'npx', args: ['-y', 'g-one'] } } }), 'utf8');
    const r = gRead();
    if (!r.ok) sub.push(`初读抛错：${r.error.message}`);
    else if (!eq(r.value, { g1srv: { name: 'g1srv', transport: 'stdio', command: 'npx', args: ['-y', 'g-one'] } })) sub.push(`初读应返回 g1srv 条目：${canon(r.value)}`);
    check('G1', '初读：合法 .claude.json → readUserMcpServersRawSync 返回该条目', sub.length === 0, sub.join('; '));
  }

  // G2 (b) mtime 失效：改写内容（换 server 名、字节数不同 + 30ms 写间隔）→ 再读反映新内容
  //     （缓存因 mtime 变化失效；两次内容字节数不同是对粗粒度 mtime 的双保险）。
  {
    const sub: string[] = [];
    sleepSync(30);
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g2renamed: { command: 'node' } } }), 'utf8');
    const r = gRead();
    if (!r.ok) sub.push(`改写后重读抛错：${r.error.message}`);
    else if (!eq(r.value, { g2renamed: { name: 'g2renamed', transport: 'stdio', command: 'node' } })) sub.push(`mtime 变化后应读到新内容 g2renamed：${canon(r.value)}`);
    check('G2', '改写内容（mtime 变化）→ 再读反映新内容（缓存失效）', sub.length === 0, sub.join('; '));
  }

  // G3 (c) clearMcpRawCache() 后重读：结果与直读等价（清缓存是纯失效动作，不改变可观察结果）。
  {
    const sub: string[] = [];
    const c = call(() => clearMcpRawCache());
    if (!c.ok) sub.push(`clearMcpRawCache 抛错：${c.error.message}`);
    const r = gRead();
    if (!r.ok) sub.push(`清缓存后重读抛错：${r.error.message}`);
    else if (!eq(r.value, { g2renamed: { name: 'g2renamed', transport: 'stdio', command: 'node' } })) sub.push(`清缓存后重读应与直读等价：${canon(r.value)}`);
    check('G3', 'clearMcpRawCache() 后重读，结果与直读等价', sub.length === 0, sub.join('; '));
  }

  // G4 (d) 同 mtime 重复读两次：无异常且结果一致（缓存命中路径稳定）。
  {
    const sub: string[] = [];
    const r1 = gRead();
    const r2 = gRead();
    if (!r1.ok || !r2.ok) sub.push(`重复读抛错：${!r1.ok ? r1.error.message : r2.error.message}`);
    else if (!eq(r1.value, r2.value)) sub.push(`同 mtime 两次读结果应一致：${canon(r1.value)} vs ${canon(r2.value)}`);
    check('G4', '同 mtime 重复读两次：无异常且结果一致', sub.length === 0, sub.join('; '));
  }

  // G5 (e) 损坏不缓存：非法 JSON → 静默 {}（语义保持）；写回合法内容并把 mtime 钉回损坏时
  //     的同一值（整 2 秒对齐，规避 fs 粒度/浮点精度）后能读到新条目——若损坏 {} 被缓存
  //    （key=文件+mtime），此处同 mtime 重读必命中陈旧 {}，断言即抓出。
  {
    const sub: string[] = [];
    sleepSync(30);
    fs.writeFileSync(gClaudeJson, '{not-json', 'utf8');
    const pinned = new Date(Math.floor(Date.now() / 2000) * 2000); // 整 2 秒对齐：任何 fs mtime 粒度下均无损
    fs.utimesSync(gClaudeJson, pinned, pinned);
    const rBad = gRead();
    if (!rBad.ok) sub.push(`损坏读抛错：${rBad.error.message}`);
    else if (Object.keys(rBad.value).length !== 0) sub.push(`非法 JSON 应静默 {}：${canon(rBad.value)}`);
    fs.writeFileSync(gClaudeJson, JSON.stringify({ mcpServers: { g5back: { command: 'echo' } } }), 'utf8');
    fs.utimesSync(gClaudeJson, pinned, pinned); // 钉回同一 mtime：专测「损坏结果是否被缓存」
    const rBack = gRead();
    if (!rBack.ok) sub.push(`写回后重读抛错：${rBack.error.message}`);
    else if (!eq(rBack.value, { g5back: { name: 'g5back', transport: 'stdio', command: 'echo' } })) sub.push(`写回合法内容（同 mtime）应能读到（证明损坏 {} 未被缓存）：${canon(rBack.value)}`);
    check('G5', '损坏（非法 JSON）→ 静默 {}；写回合法内容能读到（损坏结果未被缓存）', sub.length === 0, sub.join('; '));
  }
} finally {
  fs.rmSync(gHome, { recursive: true, force: true });
}

// ── H. R5 三态文案组（McpSettings.vue 项目作用域空列表：正常空态/目录消失/快照失败占位）──
// 渲染层组件无纯函数可行为级断言（selftest 不依赖 Electron runtime），沿 tdd-bridge-ui-static-verify
// 先例读源码做静态钉；只读仓库内源文件，绝不触碰磁盘配置。

console.log('\n=== H. R5 三态文案组（McpSettings.vue 项目空态三态互斥） ===');

{
  const vueRel = path.join('src', 'renderer', 'components', 'config', 'McpSettings.vue');
  let src = '';
  try {
    src = fs.readFileSync(path.resolve(__dirname, '..', vueRel), 'utf8');
  } catch {
    // 缺文件/不可读：src 保持空串，下列断言全部走 FAIL 分支（不抛错、不崩脚本）。
  }
  const DISAPPEARED_TEXT = '该目录已不在最近工作区列表（可在聊天侧切换工作区后回到此处），其 .mcp.json 若仍存在仍会对指向该目录的会话生效';
  const NORMAL_TEXT = '该项目目录暂无 .mcp.json 或其中无 mcpServers';
  const GUARD = 'v-if="isProjectDirGone"';
  const GUARD_DEF = "activeScope.value.kind === 'project' && activeProjectDir.value === null";
  const LOADERROR_BRANCH = `v-else-if="loadError && activeScope.kind !== 'managed'"`;
  check('H1', '消失态文案逐字存在（该目录已不在最近工作区列表…仍会对指向该目录的会话生效）',
    src.includes(DISAPPEARED_TEXT), src === '' ? 'McpSettings.vue 不可读' : '文案缺失');
  check('H2', '正常空态文案保留（目录存在且无 .mcp.json 态不回归）', src.includes(NORMAL_TEXT), '文案缺失');
  check('H3', '消失态判定收敛 script 侧且含 project 作用域守卫（防误报管理库/user/未选目录态）',
    src.includes(GUARD_DEF), 'isProjectDirGone 判定缺失或缺 project 作用域守卫');
  check('H4', 'p4 快照失败占位分支先于空态块（三态互斥的 v-if 链序）',
    src.includes(LOADERROR_BRANCH) && src.indexOf(LOADERROR_BRANCH) < src.indexOf('v-if="visibleCards.length === 0"'),
    '占位分支缺失或顺序不对');
  // r2-F1 增补：正常空态分支钉为 <template v-else> 形态 + 空态文案前缀（防 v-if 链重排/文案换标签回归）。
  const NORMAL_VELSE = '<template v-else>该项目目录暂无 .mcp.json 或其中无 mcpServers';
  check('H5', '项目空态分支嵌套顺序：isProjectDirGone 守卫 → 消失态文案 → 正常空态文案（互斥呈现）；含 v-else 形态子断言（正常空态须为 <template v-else> 起始 + 文案前缀）',
    src.includes(GUARD) && src.includes(NORMAL_VELSE) && src.indexOf(GUARD) < src.indexOf(DISAPPEARED_TEXT) && src.indexOf(DISAPPEARED_TEXT) < src.indexOf(NORMAL_TEXT),
    '守卫/文案顺序不对，或正常空态非 v-else 形态');
}

// ── I. D-V1-1 注入挂载组（options.mcpServers 顶层挂载 / 空配置零挂载 / strict 恒 true）──
// 缺陷语义（D-V1-1）：strictMcpConfig=true 下 SDK 只认顶层 Options.mcpServers（运行时等价
// --mcp-config 旗标），settings 块内 mcpServers 键被忽略——若核心工厂只把 settings 块放进
// Options.settings，所有会话 MCP 注入恒失效（会话内 /mcp 答「No MCP servers are configured」）。
// 断言全链真实构造：mergeMcpServersIntoSettings（io 内存 stub）产 settings 块 →
// buildNativeSdkOptionsCore 产 options——能抓住「只挂 settings 不挂顶层」的回归。

console.log('\n=== I. D-V1-1 注入挂载组（buildNativeSdkOptionsCore 顶层 mcpServers 挂载） ===');

/** 走真实 merge 链构造 settings 块（返回调用后的块），再经核心工厂产 options（call 包裹不崩脚本）。 */
function optionsFromMergedSettings(
  cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>,
  io: MergeIo,
  seed: Record<string, unknown> = { model: 'claude-x', permissions: { allow: ['Bash'] } },
): CallResult<{ settings: Record<string, unknown>; options: ReturnType<typeof buildNativeSdkOptionsCore> }> {
  const out: Record<string, unknown> = { ...seed };
  const r = mergeCall(cfg, null, io, out);
  if (!r.ok) return { ok: false, error: r.error };
  const r2 = call(() => buildNativeSdkOptionsCore({ env: {}, settings: r.value }));
  if (!r2.ok) return { ok: false, error: r2.error };
  return { ok: true, value: { settings: r.value, options: r2.value } };
}

// I1 非空配置全链：settings.mcpServers 非空 → options.mcpServers 必须挂载，且为同一归一 map
//    （同源同值同引用——不得另起合并/拷贝）；settings 块内 mcpServers 键保留不动（SDK strict 下
//    忽略它，无害）；strictMcpConfig 恒 true。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = optionsFromMergedSettings(cfg, ioOf({ u1: U1_ENTRY }));
  if (!r.ok) sub.push(`全链构造失败：${r.error.message}`);
  else {
    const { settings, options } = r.value;
    if (!('mcpServers' in settings)) sub.push('前置失败：settings 块应含非空 mcpServers（merge 未注入）');
    if (!('mcpServers' in options)) sub.push('D-V1-1 回归：settings.mcpServers 非空时 options.mcpServers 未挂载（仍只挂 settings 块，SDK strict 下注入恒失效）');
    if ('mcpServers' in options && 'mcpServers' in settings) {
      if (options.mcpServers !== settings.mcpServers) sub.push('挂载值应为 settings.mcpServers 同一引用（同源同值，不得另起合并/拷贝）');
      if (!eq(options.mcpServers, { u1: U1_SDK, m1: M1_SDK })) sub.push(`挂载 map 应为三层归一产物（user+managed）：${canon(options.mcpServers)}`);
    }
    if (options.strictMcpConfig !== true) sub.push(`strictMcpConfig 应恒 true：${canon(options.strictMcpConfig)}`);
  }
  check('I1', '非空配置：options.mcpServers 挂载同一归一 map（同源同值）；settings 块键保留；strictMcpConfig 恒 true', sub.length === 0, sub.join('; '));
}

// I2 空配置零挂载：三层全空 / 全部被 override 禁用 / settings.mcpServers 为空对象（防御边界，
//    真实 merge 链不产出该形态）→ options 均不得出现 mcpServers 键（与「空 MCP 配置零注入」
//    及 SDK 空集不推 --mcp-config 的行为约束同口径）。
{
  const sub: string[] = [];
  const emptyCases: Array<{ label: string; cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'>; io: MergeIo }> = [
    { label: '三层全空', cfg: { mcpServers: [], mcpOverrides: {} }, io: ioOf(EMPTY_PROJECT) },
    {
      label: '全部被禁用',
      cfg: { mcpServers: [M1_MANAGED], mcpOverrides: { 'managed:m1': 'off', 'user:u1': 'off' } },
      io: ioOf({ u1: U1_ENTRY }),
    },
  ];
  for (const c of emptyCases) {
    const r = optionsFromMergedSettings(c.cfg, c.io);
    if (!r.ok) { sub.push(`${c.label}：全链构造失败：${r.error.message}`); continue; }
    if ('mcpServers' in r.value.settings) sub.push(`${c.label}：settings 块不应写入 mcpServers 键（空态字节级一致约束回归）`);
    if ('mcpServers' in r.value.options) sub.push(`${c.label}：options.mcpServers 应缺席（空配置零注入）`);
  }
  // 防御边界：settings.mcpServers 为空对象 → 不挂载（真实链不产出，工厂仍须守住）。
  const rEmptyObj = call(() => buildNativeSdkOptionsCore({ env: {}, settings: { mcpServers: {} } }));
  if (!rEmptyObj.ok) sub.push(`空对象防御边界：构造抛错：${rEmptyObj.error.message}`);
  else if ('mcpServers' in rEmptyObj.value) sub.push('settings.mcpServers 为空对象时 options.mcpServers 应缺席');
  check('I2', '空配置（三层全空/全禁用）与空对象边界：settings 与 options 均零挂载', sub.length === 0, sub.join('; '));
}

// I2b 数组形态防御边界（2026-10-13 mcp-followup round-005 M1 修复新增）：settings.mcpServers
//    为数组（如 ['a','b']）→ options 不得出现 mcpServers 键。真实 merge 链不产出该形态，工厂
//    仍须守住——数组 typeof==='object' 且 Object.keys 非零，旧守卫会放行挂载数组（与「空对象
//    防御边界」同口径，check 描述注明「空对象/数组防御边界」）。
{
  const sub: string[] = [];
  const rArray = call(() => buildNativeSdkOptionsCore({ env: {}, settings: { mcpServers: ['a', 'b'] } }));
  if (!rArray.ok) sub.push(`数组形态防御边界：构造抛错：${rArray.error.message}`);
  else if ('mcpServers' in rArray.value) sub.push('settings.mcpServers 为数组时 options.mcpServers 应缺席（空对象/数组防御边界）');
  check('I2b', '空对象/数组防御边界（数组形态）：settings.mcpServers 为数组 → options.mcpServers 缺席', sub.length === 0, sub.join('; '));
}

// I3 序列化兼容：挂载载体为 merge 产出的 null 原型对象，SDK 侧 --mcp-config 走 JSON.stringify
//    序列化——挂载 map 经 JSON 往返后必须与 settings.mcpServers deepEqual（无损）。
{
  const sub: string[] = [];
  const cfg: Pick<AppConfig, 'mcpServers' | 'mcpOverrides'> = { mcpServers: [M1_MANAGED], mcpOverrides: {} };
  const r = optionsFromMergedSettings(cfg, ioOf({ u1: U1_ENTRY, u2: U2_ENTRY }));
  if (!r.ok) sub.push(`全链构造失败：${r.error.message}`);
  else {
    const { settings, options } = r.value;
    if (!('mcpServers' in options)) sub.push('前置失败：options.mcpServers 未挂载');
    else {
      if (Object.getPrototypeOf(options.mcpServers) !== null) sub.push('挂载载体应为 merge 产出的 null 原型对象（不得中途换普通对象载体）');
      let round = '';
      try { round = JSON.stringify(options.mcpServers) ?? ''; } catch (e) { sub.push(`挂载 map JSON 序列化抛错：${errMsg(e)}`); }
      try {
        if (!eq(JSON.parse(round), settings.mcpServers)) sub.push(`JSON 往返后应与 settings.mcpServers deepEqual：${round.slice(0, 200)}`);
      } catch (e) {
        sub.push(`JSON 往返 parse 抛错：${errMsg(e)}`);
      }
    }
  }
  check('I3', '挂载载体（null 原型）可被 JSON 无损序列化（SDK --mcp-config 兼容）', sub.length === 0, sub.join('; '));
}

// ── 汇总与退出码 ─────────────────────────────────────────────────────────────

console.log(`\n===== selftest-mcp-settings: ${pass} pass / ${fail} fail =====`);
if (fail > 0) {
  console.log('（RED 阶段：FAIL 项均为尚未实现的桩（throw not implemented: …）——P2/P5 实现后应全 PASS；A 组为 P1 已实现基线，应保持全 PASS）');
  process.exit(1);
}
console.log('selftest-mcp-settings: OK');
process.exit(0);
