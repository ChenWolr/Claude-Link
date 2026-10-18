// selftest-mcp-writer.ts
// P8 双向写入器契约测试（src/main/modules/mcp/mcp-writer.ts）：内存 io stub，绝不触真实磁盘
//（绝不读/写真实 ~/.claude.json 或任何 .mcp.json）。断言组（原 P8 计划 E4 全集）：
//   ①upsert 新键（文件不存在 → 创建）②upsert 覆盖同名（overwrote=true）
//   ③remove 缺名 no-op 等价（文件字节不变返回成功，无 tmp 残留）④未知字段与键序保留
//   ⑤损坏 JSON 抛「文件损坏，已中止写入」⑥mtime 冲突 → 重读重试成功 ⑦再冲突抛
//   「文件已被其他程序修改，请重试」⑧2 空格缩进 + 尾换行 ⑨哨兵还原（同名 + rename hint
//   两种 + 原文件无原值丢键）⑩stdio|http|sse 三形态条目键正确 ⑪project dir 缺失抛错。
// mtime 冲突经 stub 的 mtimeQueue 精确编排：writer 每次调 stat 时按序弹出一项并视为
// 「外部程序刚改写了文件」（更新 stub 内文件 mtime），队列耗尽后回落稳定值。
// 运行：npx tsx scripts/selftest-mcp-writer.ts

import * as path from 'node:path';
import {
  writeScopedMcpServer,
  type ScopedMcpEntry,
  type WriterIo,
} from '../src/main/modules/mcp/mcp-writer';

const MASK = '••••••••'; // 与 mcp-config.MCP_MASK_SENTINEL 同字面量（8×U+25CF）
const HOME = '/virtual-home';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ''): void {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

interface VFile { content: string; mtimeMs: number }

/** 内存 io stub：files 为虚拟文件表；mtimeQueue 非空时 stat 逐次弹出并改写该文件 mtime（模拟外部并发写）。 */
function makeIo(files: Map<string, VFile>, mtimeQueue?: number[]): WriterIo {
  const enoent = (p: string): Error => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
  return {
    readFile: async (p) => {
      const f = files.get(p);
      if (!f) throw enoent(p);
      return f.content;
    },
    writeFile: async (p, data) => {
      files.set(p, { content: data, mtimeMs: files.get(p)?.mtimeMs ?? 1000 });
    },
    stat: async (p) => {
      const f = files.get(p);
      if (!f) throw enoent(p);
      const next = mtimeQueue?.shift();
      if (next !== undefined) f.mtimeMs = next;
      return { mtimeMs: f.mtimeMs };
    },
    rename: async (from, to) => {
      const f = files.get(from);
      if (!f) throw enoent(from);
      files.delete(from);
      files.set(to, f);
    },
    homedir: () => HOME,
  };
}

const USER_FILE = path.resolve(HOME, '.claude.json'); // 与 writer 内 path.resolve 同口径
function projectFile(dir: string): string {
  return path.join(dir, '.mcp.json');
}

function stdioEntry(overrides: Partial<ScopedMcpEntry> = {}): ScopedMcpEntry {
  return { name: 'dev', transport: 'stdio', command: 'npx', args: ['-y', 'demo'], env: { A: 'b' }, ...overrides };
}

function hasTmpLeftover(files: Map<string, VFile>): boolean {
  return [...files.keys()].some((k) => k.endsWith('.tmp'));
}

async function main(): Promise<void> {
  // ── ① upsert 新键：文件不存在 → 创建；overwrote=false；条目形态正确 ──
  console.log('\n[1] upsert 新键（user 级，文件不存在 → 创建）');
  {
    const files = new Map<string, VFile>();
    const r = await writeScopedMcpServer({ scope: 'user', entry: stdioEntry(), mode: 'upsert', io: makeIo(files) });
    check('① 返回 overwrote=false', r.overwrote === false, JSON.stringify(r));
    const f = files.get(USER_FILE);
    check('① 文件已创建', f !== undefined);
    const tree = JSON.parse(f?.content ?? '{}') as { mcpServers: Record<string, unknown> };
    const entry = tree.mcpServers?.dev as Record<string, unknown> | undefined;
    check('① dev 条目存在且形态 stdio', JSON.stringify(entry) === JSON.stringify({ type: 'stdio', command: 'npx', args: ['-y', 'demo'], env: { A: 'b' } }), JSON.stringify(entry));
    check('① 无 tmp 残留', !hasTmpLeftover(files));
  }

  // ── ② upsert 覆盖同名：overwrote=true；其他条目与未知顶层字段保留 ──
  console.log('\n[2] upsert 覆盖同名');
  {
    const files = new Map<string, VFile>();
    files.set(USER_FILE, {
      content: JSON.stringify({ other: 1, mcpServers: { dev: { type: 'stdio', command: 'old', env: { K: 'v' } }, keep: { type: 'http', url: 'https://k' } }, zzz: 'tail' }),
      mtimeMs: 1000,
    });
    const r = await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ command: 'new' }), mode: 'upsert', io: makeIo(files) });
    check('② 返回 overwrote=true', r.overwrote === true, JSON.stringify(r));
    const tree = JSON.parse(files.get(USER_FILE)?.content ?? '{}') as { other: unknown; zzz: unknown; mcpServers: Record<string, { command?: string; url?: string }> };
    check('② 同名条目被覆盖', tree.mcpServers.dev?.command === 'new');
    check('② 其他服务器条目保留', tree.mcpServers.keep?.url === 'https://k');
    check('② 未知顶层字段保留', tree.other === 1 && tree.zzz === 'tail');
  }

  // ── ③ remove 缺名 no-op：文件字节不变 + 返回成功 + 无 tmp ──
  console.log('\n[3] remove 缺名 no-op 等价');
  {
    const original = JSON.stringify({ mcpServers: { keep: { type: 'http', url: 'https://k' } } });
    const files = new Map<string, VFile>();
    files.set(USER_FILE, { content: original, mtimeMs: 1000 });
    const r = await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ name: 'ghost' }), mode: 'remove', io: makeIo(files) });
    check('③ 返回成功 overwrote=false', r.overwrote === false, JSON.stringify(r));
    check('③ 文件字节不变', files.get(USER_FILE)?.content === original);
    check('③ 无 tmp 残留（未触盘写）', !hasTmpLeftover(files));
    // remove 命名：真删。
    const files2 = new Map<string, VFile>();
    files2.set(USER_FILE, { content: JSON.stringify({ mcpServers: { dev: { type: 'stdio', command: 'x' }, keep: { type: 'http', url: 'https://k' } } }), mtimeMs: 1000 });
    const r2 = await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ name: 'dev' }), mode: 'remove', io: makeIo(files2) });
    const tree2 = JSON.parse(files2.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, unknown> };
    check('③ remove 命名删除条目且返回 false', r2.overwrote === false && tree2.mcpServers.dev === undefined && tree2.mcpServers.keep !== undefined, JSON.stringify(tree2.mcpServers));
  }

  // ── ④ 未知字段与键序保留（整树 parse/stringify）──
  console.log('\n[4] 未知字段与键序保留');
  {
    const files = new Map<string, VFile>();
    files.set(USER_FILE, {
      content: JSON.stringify({ other: 1, mcpServers: { dev: { type: 'stdio', command: 'old' }, keep: { type: 'http', url: 'https://k' } }, zzz: { nested: [1, 2] } }),
      mtimeMs: 1000,
    });
    await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ name: 'aaa', command: 'x' }), mode: 'upsert', io: makeIo(files) });
    const content = files.get(USER_FILE)?.content ?? '';
    const tree = JSON.parse(content) as { mcpServers: Record<string, unknown> };
    check('④ 顶层键序保留（other → mcpServers → zzz，新键只追加在 mcpServers 内）',
      JSON.stringify(Object.keys(tree)) === JSON.stringify(['other', 'mcpServers', 'zzz']), JSON.stringify(Object.keys(tree)));
    check('④ mcpServers 键序保留（dev → keep → aaa 追加）',
      JSON.stringify(Object.keys(tree.mcpServers)) === JSON.stringify(['dev', 'keep', 'aaa']), JSON.stringify(Object.keys(tree.mcpServers)));
    check('④ 未知嵌套字段值不变', JSON.stringify(tree.zzz) === '{"nested":[1,2]}');
  }

  // ── ⑤ 损坏 JSON 抛错 ──
  console.log('\n[5] 损坏 JSON 抛「文件损坏，已中止写入」');
  {
    const files = new Map<string, VFile>();
    files.set(USER_FILE, { content: '{oops', mtimeMs: 1000 });
    let msg = '';
    try {
      await writeScopedMcpServer({ scope: 'user', entry: stdioEntry(), mode: 'upsert', io: makeIo(files) });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check('⑤ 抛错文案逐字', msg === '文件损坏，已中止写入', msg);
    check('⑤ 损坏文件未被改写', files.get(USER_FILE)?.content === '{oops');
  }

  // ── ⑥ mtime 冲突一次 → 重读重试成功 ──
  console.log('\n[6] mtime 冲突 → 重读重试成功');
  {
    const files = new Map<string, VFile>();
    files.set(USER_FILE, { content: JSON.stringify({ mcpServers: { old: { type: 'stdio', command: 'x' } } }), mtimeMs: 10 });
    // stat 编排：读时 10 → 写前变 20（冲突）→ 重试读 20 → 写前 20（一致）→ 落盘。
    const r = await writeScopedMcpServer({ scope: 'user', entry: stdioEntry(), mode: 'upsert', io: makeIo(files, [10, 20]) });
    check('⑥ 重试后写成功', r.overwrote === false, JSON.stringify(r));
    const tree = JSON.parse(files.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, unknown> };
    check('⑥ 新条目在最终文件中', tree.mcpServers.dev !== undefined && tree.mcpServers.old !== undefined);
  }

  // ── ⑦ 两次 mtime 冲突 → 抛「文件已被其他程序修改，请重试」──
  console.log('\n[7] 再冲突抛错');
  {
    const files = new Map<string, VFile>();
    files.set(USER_FILE, { content: JSON.stringify({ mcpServers: {} }), mtimeMs: 10 });
    let msg = '';
    try {
      await writeScopedMcpServer({ scope: 'user', entry: stdioEntry(), mode: 'upsert', io: makeIo(files, [10, 20, 30, 40]) });
    } catch (e) {
      msg = e instanceof Error ? e.message : String(e);
    }
    check('⑦ 抛错文案逐字', msg === '文件已被其他程序修改，请重试', msg);
    check('⑦ 目标文件未被污染', files.get(USER_FILE)?.mtimeMs === 40 && !hasTmpLeftover(files));
  }

  // ── ⑧ 2 空格缩进 + 尾换行 ──
  console.log('\n[8] 序列化形态：2 空格缩进 + 尾换行');
  {
    const files = new Map<string, VFile>();
    await writeScopedMcpServer({ scope: 'user', entry: stdioEntry(), mode: 'upsert', io: makeIo(files) });
    const content = files.get(USER_FILE)?.content ?? '';
    check('⑧ 内容 = JSON.stringify(tree, null, 2) + "\\n"', content === JSON.stringify(JSON.parse(content), null, 2) + '\n');
    check('⑧ 尾换行在场', content.endsWith('\n'));
    check('⑧ 2 空格缩进在场', content.includes('\n  "mcpServers"'));
  }

  // ── ⑨ 哨兵还原：同名 / rename hint / 原文件无原值丢键 ──
  console.log('\n[9] 哨兵还原三形态');
  {
    // ⑨a 同名：env 值为哨兵 → 按同名键从原条目取原值。
    const files = new Map<string, VFile>();
    files.set(USER_FILE, { content: JSON.stringify({ mcpServers: { dev: { type: 'stdio', command: 'old', env: { API_KEY: 'secret-1' } } } }), mtimeMs: 1000 });
    await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ env: { API_KEY: MASK } }), mode: 'upsert', io: makeIo(files) });
    const a = JSON.parse(files.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, { env?: Record<string, string> }> };
    check('⑨a 同名哨兵还原原值', a.mcpServers.dev?.env?.API_KEY === 'secret-1', JSON.stringify(a.mcpServers.dev));

    // ⑨b rename hint：键改名 + 哨兵 → 按原键取原值，落盘键为新键。
    const files2 = new Map<string, VFile>();
    files2.set(USER_FILE, { content: JSON.stringify({ mcpServers: { dev: { type: 'stdio', command: 'old', env: { OLD: 'sv' } } } }), mtimeMs: 1000 });
    await writeScopedMcpServer({
      scope: 'user',
      entry: stdioEntry({ env: { NEW: MASK }, envRenameFrom: { NEW: 'OLD' } }),
      mode: 'upsert',
      io: makeIo(files2),
    });
    const b = JSON.parse(files2.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, { env?: Record<string, string> }> };
    check('⑨b rename hint 还原到新键', JSON.stringify(b.mcpServers.dev?.env) === JSON.stringify({ NEW: 'sv' }), JSON.stringify(b.mcpServers.dev?.env));

    // ⑨c 原文件无原值 → 丢该键（全部还原失败 → env 字段整体消失）。
    const files3 = new Map<string, VFile>();
    files3.set(USER_FILE, { content: JSON.stringify({ mcpServers: { dev: { type: 'stdio', command: 'old' } } }), mtimeMs: 1000 });
    await writeScopedMcpServer({ scope: 'user', entry: stdioEntry({ env: { X: MASK } }), mode: 'upsert', io: makeIo(files3) });
    const c = JSON.parse(files3.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, Record<string, unknown>> };
    check('⑨c 原值缺失 → 哨兵键丢弃（env 字段不出现）', c.mcpServers.dev?.env === undefined, JSON.stringify(c.mcpServers.dev));

    // ⑨d headers 哨兵（remote 条目）同语义。
    const files4 = new Map<string, VFile>();
    files4.set(USER_FILE, { content: JSON.stringify({ mcpServers: { web: { type: 'http', url: 'https://x', headers: { Authorization: 'Bearer t' } } } }), mtimeMs: 1000 });
    await writeScopedMcpServer({
      scope: 'user',
      entry: { name: 'web', transport: 'http', url: 'https://y', headers: { Authorization: MASK } },
      mode: 'upsert',
      io: makeIo(files4),
    });
    const d = JSON.parse(files4.get(USER_FILE)?.content ?? '{}') as { mcpServers: Record<string, { url?: string; headers?: Record<string, string> }> };
    check('⑨d headers 哨兵还原', d.mcpServers.web?.headers?.Authorization === 'Bearer t' && d.mcpServers.web?.url === 'https://y', JSON.stringify(d.mcpServers.web));
  }

  // ── ⑩ stdio|http|sse 三形态条目键正确（project 级 <dir>/.mcp.json）──
  console.log('\n[10] 三 transport 条目形态（project 级）');
  {
    const dir = '/virtual-proj';
    const file = projectFile(dir);
    const files = new Map<string, VFile>();
    const io = makeIo(files);
    await writeScopedMcpServer({ scope: 'project', dir, entry: stdioEntry({ name: 's1', args: ['a'], env: { K: 'v' } }), mode: 'upsert', io });
    await writeScopedMcpServer({ scope: 'project', dir, entry: { name: 'h1', transport: 'http', url: 'https://h', headers: { A: 'b' } }, mode: 'upsert', io });
    await writeScopedMcpServer({ scope: 'project', dir, entry: { name: 's2', transport: 'sse', url: 'https://s' }, mode: 'upsert', io });
    const tree = JSON.parse(files.get(file)?.content ?? '{}') as { mcpServers: Record<string, Record<string, unknown>> };
    check('⑩ stdio 键序 [type,command,args,env]', JSON.stringify(Object.keys(tree.mcpServers.s1 ?? {})) === JSON.stringify(['type', 'command', 'args', 'env']), JSON.stringify(tree.mcpServers.s1));
    check('⑩ http 键序 [type,url,headers]', JSON.stringify(Object.keys(tree.mcpServers.h1 ?? {})) === JSON.stringify(['type', 'url', 'headers']), JSON.stringify(tree.mcpServers.h1));
    check('⑩ sse 键序 [type,url]（空 headers 省略）', JSON.stringify(Object.keys(tree.mcpServers.s2 ?? {})) === JSON.stringify(['type', 'url']), JSON.stringify(tree.mcpServers.s2));
  }

  // ── ⑪ project dir 缺失抛错 ──
  console.log('\n[11] project dir 缺失抛错');
  {
    let threw = false;
    try {
      await writeScopedMcpServer({ scope: 'project', entry: stdioEntry(), mode: 'upsert', io: makeIo(new Map()) });
    } catch {
      threw = true;
    }
    check('⑪ dir 缺失 → 抛错', threw);
  }

  console.log(`\nselftest-mcp-writer: ${pass} passed, ${fail} failed`);
  if (fail > 0) {
    process.exit(1);
  }
  console.log('selftest-mcp-writer: OK');
}

main().catch((err) => {
  console.error('脚本执行异常：', err);
  process.exit(1);
});
