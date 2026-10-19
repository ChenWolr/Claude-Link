// selftest-mcp-export.ts
// 作用域导出 JSON（mcp:exportScoped，2026-10-18）契约测试。断言组：
//   A 组（行为直测 src/main/modules/mcp/mcp-config.ts:buildMcpServersExportJson）：
//     ①stdio 条目形状（type/command/args/env；空 args/env 省略）②http/sse 条目形状
//     （type/url/headers；空 headers 省略）③整体 {"mcpServers":{…}} 形态 + 2 空格缩进 +
//     尾换行（与 mcp-writer 落盘格式同款）④空表 → 空 mcpServers 形态（合法、可再导入）
//     ⑤__proto__ 键防污染（null 载体，键按自有属性进导出、Object.prototype 不受影响）
//     ⑥管理库附加字段（id/description/createdAt）不进导出 ⑦同名后写覆盖 ⑧必填缺失抛
//     中文错（toSdkMcpServerConfig 防御兜底）。
//   B 组（静态接线钉，先例 selftest-mcp-settings.ts H 组读源码静态钉；只读仓库内源文件，
//     绝不触真实磁盘/剪贴板/配置）：
//     ①shared/types/ipc.ts 含 MCP_EXPORT_SCOPED 通道常量 ②ipc-handlers.ts 含 handler +
//     clipboard.writeText(buildMcpServersExportJson( 主进程剪贴板链 + project dir 白名单
//     （'已拒绝导出'）③preload/api.ts 含 exportMcpScoped 桥 + McpExportScopedPayload
//     ④McpSettings.vue 含「导出 JSON」按钮 + exportScopeJson + 空表禁用 ⑤标题行 ⓘ 气泡
//     右缘锚定 CSS 钉（tip--head 变体——2026-10-18 截断回归的防线）。
// 运行：npx tsx scripts/selftest-mcp-export.ts

import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildMcpServersExportJson } from '../src/main/modules/mcp/mcp-config';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

function main(): void {
  // ── A 组：buildMcpServersExportJson 行为直测 ─────────────────────────────
  console.log('[A] buildMcpServersExportJson 行为直测');

  // A1 stdio 条目形状 + 空字段省略
  {
    const text = buildMcpServersExportJson({
      full: { transport: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'V' } },
      bare: { transport: 'stdio', command: 'node', args: [], env: {} },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    check('A1 stdio 条目形状（type/command/args/env 全保留）',
      JSON.stringify(parsed.mcpServers.full) === JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'srv'], env: { K: 'V' } }),
      JSON.stringify(parsed.mcpServers.full));
    check('A1 空 args/env 省略（bare 仅 type/command）',
      JSON.stringify(parsed.mcpServers.bare) === JSON.stringify({ type: 'stdio', command: 'node' }),
      JSON.stringify(parsed.mcpServers.bare));
  }

  // A2 http/sse 条目形状 + 空 headers 省略
  {
    const text = buildMcpServersExportJson({
      h: { transport: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } },
      s: { transport: 'sse', url: 'https://x.test/sse' },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    check('A2 http 条目形状（type/url/headers）',
      JSON.stringify(parsed.mcpServers.h) === JSON.stringify({ type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } }),
      JSON.stringify(parsed.mcpServers.h));
    check('A2 sse 空条目形状（type/url，无 headers 键）',
      JSON.stringify(parsed.mcpServers.s) === JSON.stringify({ type: 'sse', url: 'https://x.test/sse' }),
      JSON.stringify(parsed.mcpServers.s));
  }

  // A3 整体形态：根 mcpServers + 2 空格缩进 + 尾换行
  {
    const text = buildMcpServersExportJson({ a: { transport: 'stdio', command: 'c' } });
    check('A3 根形态 {"mcpServers":{…}}', text.startsWith('{\n  "mcpServers": {\n'));
    check('A3 2 空格缩进（条目行 4 空格起）', text.includes('    "a": {\n      "type": "stdio"'));
    check('A3 尾换行', text.endsWith('}\n'));
  }

  // A4 空表 → 空 mcpServers 形态
  {
    const text = buildMcpServersExportJson({});
    check('A4 空表 → {"mcpServers": {}}（合法、可再导入）',
      JSON.parse(text) !== null && Object.keys((JSON.parse(text) as { mcpServers: unknown }).mcpServers).length === 0,
      text);
  }

  // A5 __proto__ 键防污染：null 载体入参 → 自有键照常导出、Object.prototype 不受影响
  {
    const servers = Object.create(null) as Record<string, { transport: 'stdio'; command: string }>;
    servers['__proto__'] = { transport: 'stdio', command: 'evil' };
    const text = buildMcpServersExportJson(servers);
    const parsed = JSON.parse(text) as { mcpServers: Record<string, unknown> };
    check('A5 __proto__ 键作为自有键进导出', Object.keys(parsed.mcpServers).includes('__proto__'), text);
    check('A5 Object.prototype 未被污染', ({} as Record<string, unknown>).transport === undefined);
  }

  // A6 管理库附加字段（id/description/createdAt/updatedAt）不进导出
  {
    const text = buildMcpServersExportJson({
      m: { id: 'u1', description: '描述', createdAt: 1, updatedAt: 2, name: 'm', transport: 'stdio', command: 'c' },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    check('A6 附加字段剥离（仅 type/command）',
      JSON.stringify(parsed.mcpServers.m) === JSON.stringify({ type: 'stdio', command: 'c' }),
      JSON.stringify(parsed.mcpServers.m));
  }

  // A7 同名后写覆盖（防御性：正常调用方键唯一）
  {
    const text = buildMcpServersExportJson({
      // 对象字面量同键后者覆盖前者——等价于「后写覆盖」路径
      ...{ dup: { transport: 'stdio', command: 'first' } },
      ...{ dup: { transport: 'stdio', command: 'second' } },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, { command: string }> };
    check('A7 同名后写覆盖', parsed.mcpServers.dup.command === 'second');
  }

  // A8 必填缺失抛中文错（toSdkMcpServerConfig 防御兜底直通）
  {
    let threw = false;
    let msg = '';
    try {
      buildMcpServersExportJson({ bad: { transport: 'stdio', command: '' } });
    } catch (e) {
      threw = true;
      msg = e instanceof Error ? e.message : String(e);
    }
    check('A8 stdio 必填缺失 → 抛中文错', threw && msg === 'stdio 服务器缺少必填 command', msg);
  }

  // A9 timeoutMs 导出（2026-10-19 mcp-settings-plan-a 点1 J4 镜像补条）：含合法 timeoutMs →
  // 导出条目含 "timeoutMs": 30000（其余字段完好）；无值 → 无该键。
  {
    const text = buildMcpServersExportJson({
      t: { transport: 'stdio', command: 'npx', timeoutMs: 30000 },
      bare: { transport: 'http', url: 'https://x.test/mcp' },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    check('A9 含合法 timeoutMs → 导出条目含 "timeoutMs": 30000',
      parsed.mcpServers.t?.timeoutMs === 30000 && parsed.mcpServers.t?.command === 'npx',
      JSON.stringify(parsed.mcpServers.t));
    check('A9 无 timeoutMs → 导出条目无该键',
      parsed.mcpServers.bare !== undefined && !('timeoutMs' in parsed.mcpServers.bare),
      JSON.stringify(parsed.mcpServers.bare));
  }

  // A10（P3 跟进 R6）timeoutMs 负向：非法值（120001 / 1.5）→ 导出条目无该键
  //（mcp-config 写出口 isValidMcpTimeoutMs 静默丢字段，此前零断言）。
  {
    const text = buildMcpServersExportJson({
      over: { transport: 'stdio', command: 'npx', timeoutMs: 120001 },
      frac: { transport: 'http', url: 'https://x', timeoutMs: 1.5 },
    });
    const parsed = JSON.parse(text) as { mcpServers: Record<string, Record<string, unknown>> };
    check('A10 非法 timeoutMs（120001/1.5）→ 导出条目无该键',
      parsed.mcpServers.over !== undefined && !('timeoutMs' in parsed.mcpServers.over)
        && parsed.mcpServers.frac !== undefined && !('timeoutMs' in parsed.mcpServers.frac)
        && parsed.mcpServers.over?.command === 'npx' && parsed.mcpServers.frac?.url === 'https://x',
      JSON.stringify(parsed.mcpServers));
  }

  // ── B 组：静态接线钉（读源码；绝不触真实磁盘配置/剪贴板）──────────────────
  console.log('[B] 静态接线钉（导出 IPC 全链 + 标题行气泡截断修复 CSS）');
  const read = (rel: string): string => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');
  const ipc = read('src/shared/types/ipc.ts');
  const handlers = read('src/main/ipc-handlers.ts');
  const preload = read('src/preload/api.ts');
  const vue = read('src/renderer/components/config/McpSettings.vue');

  check('B1 ipc.ts 含 MCP_EXPORT_SCOPED 通道常量', ipc.includes("MCP_EXPORT_SCOPED: 'mcp:exportScoped'"));
  check('B2 ipc-handlers.ts 注册 handler', handlers.includes('ipcMain.handle(IPC_CHANNELS.MCP_EXPORT_SCOPED'));
  check('B2 剪贴板链：主进程 clipboard.writeText(buildMcpServersExportJson(…))',
    handlers.includes('clipboard.writeText(buildMcpServersExportJson(servers))'));
  check('B2 明文数据源三作用域（raw 读取器接线）',
    handlers.includes('readUserMcpServersRawSync(effectiveUserHome() ?? os.homedir())') && handlers.includes('readProjectMcpServersRawSync(dir as string)'));
  check('B2 project dir 白名单（已拒绝导出）', handlers.includes('已拒绝导出'));
  check('B2 count=0 不动剪贴板（空表短路）', handlers.includes('if (count === 0) return { ok: true, count: 0 }'));
  check('B3 preload 桥 exportMcpScoped', preload.includes('exportMcpScoped: (payload) => ipcRenderer.invoke(IPC_CHANNELS.MCP_EXPORT_SCOPED, payload)'));
  check('B3 preload 载荷类型 McpExportScopedPayload', preload.includes('export interface McpExportScopedPayload'));
  check('B4 McpSettings.vue「导出 JSON」按钮', vue.includes('导出 JSON'));
  check('B4 exportScopeJson 处理器 + IPC 调用', vue.includes('async function exportScopeJson') && vue.includes('claude.exportMcpScoped(payload)'));
  check('B4 空表禁用（scopeCards.length === 0）', vue.includes(':disabled="exporting || scopeCards.length === 0"'));
  check('B5 标题行 ⓘ 气泡右缘锚定变体（tip--head）', vue.includes('tip tip--head'));
  check('B5 tip--head 静态让位 + 气泡右锚定（left:auto/right:0）',
    /\.tip--head \{\r?\n  position: static;/.test(vue) && /\.tip--head \.bubble \{\r?\n  left: auto;\r?\n  right: 0;/.test(vue));
  check('B5 标题行 relative 锚（.mcp-title-row position:relative）',
    /\.mcp-title-row \{\r?\n  position: relative;/.test(vue));

  console.log(`\nselftest-mcp-export: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
  console.log('selftest-mcp-export: OK');
}

main();
