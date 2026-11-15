// tdd-mcp-import-skip-visible-verify.ts
// UI13 批次 P9「MCP 导入跳过原因可见」（2026-11-14 计划，用例正本 03-test-cases.md §P9）。
// TDD 验证脚本：T9-A~I 九条用例，行为直测 src/main/modules/mcp/mcp-config.ts:parseMcpServersJson
// 纯函数（纯 node 模块：仅 import shared 类型与 shared/mcp-json 常量，无 electron/数据库依赖，
// selftest-mcp-settings.ts 既有先例）+ McpSettings.vue 渲染层结构钉。
//   T9-A  跳过条目随载荷可见：混合 JSON → ok:true、servers 仅合法条目、skipped 含 name+中文原因；
//   T9-B  四类原因对号入座（条目非对象/无法识别传输类型/stdio 缺 command/remote 缺 url）；
//   T9-C  名称非法并入同一机制（解析级 skipped 含名称非法原因 + 渲染层 skipReason 单一消费点钉）；
//   T9-D  预览逐行「将跳过：name — 原因」（渲染层 skip 行与同名/名称非法行同一列表机制钉）；
//   T9-E  全部条目被跳过 → 不静默成功，首要跳过原因可见（主进程返回形态 + 渲染层报错行钉）；
//   T9-F  形态级错误文案逐字节钉（JSON 解析失败前缀/根非对象/找不到服务器表，现状即绿）；
//   T9-G  合法条目导入逐字节不变（混合 JSON 中合法条目形状与键集精确比对，回归钉）；
//   T9-H  args/env 字段级非法 ≠ 跳过：条目仍导入丢非法字段，fieldNotes 提示级可见；
//   T9-I  空 mcpServers:{} 边界：0 条目 0 跳过，ok:true 不误报。
// 并发向不适用（03 §P9 已注明）：单次同步纯函数解析，无共享状态竞态面。
// 载荷读取用容忍锚（skipped/fieldNotes 缺失按空处理）以支撑 RED 阶段真实跑通——
// 新增断言面（skipped/fieldNotes/渲染层钉）在未实现树上红，回归面（T9-F/G/I）现状绿。
// 运行：npx tsx scripts/tdd-mcp-import-skip-visible-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { parseMcpServersJson } from '../src/main/modules/mcp/mcp-config';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

type SkipItem = { name: string; reason: string };
type ParseOkShape = { ok: true; servers: Array<Record<string, unknown>>; skipped?: SkipItem[]; fieldNotes?: SkipItem[] };

/** 容忍锚：读 ok 分支的 skipped 载荷（未实现树缺失 → []，新实现后读真值）。 */
function skippedOf(r: ParseOkShape): SkipItem[] {
  return Array.isArray(r.skipped) ? r.skipped : [];
}
/** 容忍锚：读 ok 分支的 fieldNotes 载荷（未实现树缺失 → []）。 */
function fieldNotesOf(r: ParseOkShape): SkipItem[] {
  return Array.isArray(r.fieldNotes) ? r.fieldNotes : [];
}
function parse(text: string): ParseOkShape | { ok: false; error: string } {
  return parseMcpServersJson(text) as ParseOkShape | { ok: false; error: string };
}
/** record 相等（原型无关：主进程 env/headers 载体是 Object.create(null)）。 */
function recEq(a: Record<string, unknown> | undefined, b: Record<string, unknown> | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && a[k] === b[k]);
}

// 渲染层结构钉源（McpSettings.vue 模板区）。
const settingsSrc = readFileSync(new URL('../src/renderer/components/config/McpSettings.vue', import.meta.url), 'utf8');
const tplStart = settingsSrc.indexOf('<template>');
const tplEnd = settingsSrc.lastIndexOf('</template>');
const settingsTpl = tplStart >= 0 && tplEnd > tplStart ? settingsSrc.slice(tplStart, tplEnd) : '';

console.log('\n=== T9-A 跳过条目随载荷可见（混合 JSON） ===');
check('T9-A 混合 JSON → servers 仅合法条目 + skipped 携带 name 与中文原因（含「对象」字样）', () => {
  const r = parse(JSON.stringify({ mcpServers: { good: { command: 'npx', args: ['-y', 'mcp-fs'] }, bad: 'scalar-string' } }));
  assert.ok(r.ok, `应 ok:true，得到 ${r.ok ? '' : (r as { error: string }).error}`);
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 1, `servers 应仅含合法条目 1 条，实际 ${r.servers.length}`);
  assert.strictEqual((r.servers[0] as { name: string }).name, 'good');
  const skipped = skippedOf(r);
  assert.ok(Array.isArray(skipped), 'skipped 载荷缺失（回到静默跳过——条目 8 缺陷原样：少了一条不知为何）');
  assert.strictEqual(skipped.length, 1, `skipped 应恰含 1 条，实际 ${skipped.length}`);
  assert.strictEqual(skipped[0].name, 'bad', `skipped[0].name 应为 map 键 bad，实际 ${skipped[0]?.name}`);
  assert.ok(typeof skipped[0].reason === 'string' && skipped[0].reason.includes('对象'), `skipped[0].reason 应含「对象」义中文原因，实际 ${skipped[0]?.reason}`);
});

console.log('\n=== T9-B 四类原因对号入座 ===');
check('T9-B-1 条目非对象（标量/数组）→「条目不是对象」义', () => {
  for (const raw of [42, [1, 2], 'oops', null]) {
    const r = parse(JSON.stringify({ mcpServers: { a: raw } }));
    assert.ok(r.ok, `raw=${JSON.stringify(raw)} 应 ok:true`);
    if (!r.ok) continue;
    const skipped = skippedOf(r);
    assert.strictEqual(skipped.length, 1, `raw=${JSON.stringify(raw)} skipped 应 1 条（条目被跳过）`);
    assert.ok(skipped[0].reason.includes('条目不是对象'), `raw=${JSON.stringify(raw)} reason 应含「条目不是对象」，实际「${skipped[0].reason}」`);
  }
});
check('T9-B-2 无 type 且无 command/url 线索（或 type 无法识别）→「无法识别传输类型」义', () => {
  for (const cfg of [{}, { type: 'mystery-transport' }]) {
    const r = parse(JSON.stringify({ mcpServers: { a: cfg } }));
    assert.ok(r.ok, `cfg=${JSON.stringify(cfg)} 应 ok:true`);
    if (!r.ok) continue;
    const skipped = skippedOf(r);
    assert.strictEqual(skipped.length, 1, `cfg=${JSON.stringify(cfg)} skipped 应 1 条`);
    assert.ok(skipped[0].reason.includes('无法识别传输类型'), `cfg=${JSON.stringify(cfg)} reason 应含「无法识别传输类型」，实际「${skipped[0].reason}」`);
  }
});
check('T9-B-3 type stdio 无 command（含空串）→ 原因含 command 关键字', () => {
  for (const cfg of [{ type: 'stdio' }, { type: 'stdio', command: '' }]) {
    const r = parse(JSON.stringify({ mcpServers: { a: cfg } }));
    assert.ok(r.ok, `cfg=${JSON.stringify(cfg)} 应 ok:true`);
    if (!r.ok) continue;
    const skipped = skippedOf(r);
    assert.strictEqual(skipped.length, 1, `cfg=${JSON.stringify(cfg)} skipped 应 1 条`);
    assert.ok(skipped[0].reason.includes('command'), `cfg=${JSON.stringify(cfg)} reason 应含 command 关键字，实际「${skipped[0].reason}」`);
  }
});
check('T9-B-4 type http/sse 无 url（含空串）→ 原因含 url 关键字', () => {
  for (const cfg of [{ type: 'http' }, { type: 'http', url: '' }, { type: 'sse' }, { type: 'sse', url: '' }]) {
    const r = parse(JSON.stringify({ mcpServers: { a: cfg } }));
    assert.ok(r.ok, `cfg=${JSON.stringify(cfg)} 应 ok:true`);
    if (!r.ok) continue;
    const skipped = skippedOf(r);
    assert.strictEqual(skipped.length, 1, `cfg=${JSON.stringify(cfg)} skipped 应 1 条`);
    assert.ok(skipped[0].reason.includes('url'), `cfg=${JSON.stringify(cfg)} reason 应含 url 关键字，实际「${skipped[0].reason}」`);
  }
});

console.log('\n=== T9-C 名称非法并入同一机制 ===');
check('T9-C-1 名称非法条目进 skipped（解析级），与名称非法预览标注同义', () => {
  const r = parse(JSON.stringify({ mcpServers: { 'bad name!!': { command: 'x' } } }));
  assert.ok(r.ok, '应 ok:true');
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 0, '名称非法条目不得进 servers');
  const skipped = skippedOf(r);
  assert.ok(skipped.length === 1 && skipped[0].name === 'bad name!!', `skipped 应含 bad name!!，实际 ${JSON.stringify(skipped)}`);
  assert.ok(skipped[0].reason.includes('名称非法'), `reason 应含「名称非法」，实际「${skipped[0].reason}」`);
});
check('T9-C-2 渲染层 skipReason 单一消费点钉（mcp-off-badge 只绑一次 e.skipReason，解析级跳过行走同一机制）', () => {
  const hits = settingsTpl.split('class="mcp-off-badge">{{ e.skipReason }}').length - 1;
  assert.strictEqual(hits, 1, `模板中 mcp-off-badge 绑 e.skipReason 应恰 1 处（单一消费点），实际 ${hits}`);
  assert.ok(settingsTpl.includes('v-for="s in importPreview.skippedRows"'), '模板缺解析级跳过行 v-for（importPreview.skippedRows）——解析级跳过未与 skipReason 展示机制合流');
});

console.log('\n=== T9-D 预览逐行「将跳过：name — 原因」（渲染层结构钉） ===');
check('T9-D 解析级跳过行与同名/名称非法行同一列表（同 ul 内第二 v-for + mcp-off-badge + 将跳过字样）', () => {
  const ulStart = settingsTpl.indexOf('<ul class="mcp-imp__list">');
  assert.ok(ulStart >= 0, '预览列表 ul.mcp-imp__list 缺失');
  const ulEnd = settingsTpl.indexOf('</ul>', ulStart);
  assert.ok(ulEnd > ulStart, '预览列表 ul 未闭合');
  const listBlock = settingsTpl.slice(ulStart, ulEnd);
  assert.ok(listBlock.includes('v-for="e in importPreview.entries"'), '列表缺既有条目 v-for（锚漂移）');
  assert.ok(listBlock.includes('v-for="s in importPreview.skippedRows"'), '列表缺解析级跳过行 v-for——预览条数与导入条数不一致且无解释');
  assert.ok(listBlock.includes('将跳过：{{ s.reason }}'), '解析级跳过行缺「将跳过：原因」字样（与既有「将跳过」文案机制不统一）');
  assert.ok(listBlock.includes('{{ s.name }}'), '解析级跳过行缺条目名展示');
  assert.ok(listBlock.includes('class="mcp-off-badge"'), '解析级跳过行未复用 mcp-off-badge（跳过展示机制分裂）');
});

console.log('\n=== T9-E 全部条目被跳过 ===');
check('T9-E-1 全非法 JSON → ok:true、servers 空、skipped 携带首要（第一个）原因', () => {
  const r = parse(JSON.stringify({ mcpServers: { bad: 42, worse: { type: 'stdio' } } }));
  assert.ok(r.ok, '全跳过应仍 ok:true（主进程不造新错误分支）');
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 0, 'servers 应为空');
  const skipped = skippedOf(r);
  assert.strictEqual(skipped.length, 2, `skipped 应 2 条，实际 ${skipped.length}`);
  assert.ok(skipped[0].reason.includes('条目不是对象'), `首要原因应为第一条（条目不是对象），实际「${skipped[0].reason}」`);
});
check('T9-E-2 渲染层全跳过报错行钉（entries 空且 skippedCount>0 → 文案含首要原因）', () => {
  assert.ok(settingsTpl.includes('首要原因：{{ firstSkipReason }}'), '渲染层缺全跳过报错行（首要原因未展示）');
  assert.ok(settingsTpl.includes('skippedCount > 0'), '报错行条件缺 skippedCount > 0（空表可能被误报为全跳过）');
});

console.log('\n=== T9-F 形态级错误文案逐字节钉（回归钉，现状即绿） ===');
check('T9-F 三条形态级错误文案逐字不变', () => {
  const bad = parse('{not-json');
  assert.ok(!bad.ok && bad.error.startsWith('JSON 解析失败：'), `坏 JSON 文案前缀漂移：${bad.ok ? '' : bad.error}`);
  const root = parse('[1,2]');
  assert.ok(!root.ok && root.error === '导入内容根节点必须是 JSON 对象（收到数组/标量/null）', `根非对象文案漂移：${root.ok ? '' : root.error}`);
  const nomap = parse(JSON.stringify({ mcpServers: 'oops' }));
  assert.ok(!nomap.ok && nomap.error === '未找到有效的 MCP 服务器表（支持 {"mcpServers":{…}}、{"servers":{…}} 或裸 {名称:配置} 三种形态）', `找不到服务器表文案漂移：${nomap.ok ? '' : nomap.error}`);
});

console.log('\n=== T9-G 合法条目导入逐字节不变（回归钉） ===');
check('T9-G 混合 JSON 中合法条目照常进 servers 且形状/键集不变；跳过不误伤合法条目', () => {
  const r = parse(JSON.stringify({
    mcpServers: {
      s1: { type: 'stdio', command: 'npx', args: ['-y', 'fs'], env: { K: 'v', V: 'w' } },
      r1: { type: 'http', url: 'https://x/mcp', headers: { Auth: 'Bearer t' } },
      bad: 'oops',
    },
  }));
  assert.ok(r.ok, '应 ok:true');
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 2, `合法条目应 2 条，实际 ${r.servers.length}`);
  const s1 = r.servers.find((e) => e.name === 's1') as Record<string, unknown> | undefined;
  const r1 = r.servers.find((e) => e.name === 'r1') as Record<string, unknown> | undefined;
  assert.ok(s1 && r1, '合法条目丢失（跳过逻辑误伤）');
  assert.deepStrictEqual(
    Object.keys(s1).sort(),
    ['args', 'command', 'env', 'name', 'transport'],
    `stdio 条目键集漂移：${Object.keys(s1).sort().join(',')}`,
  );
  assert.strictEqual(s1.transport, 'stdio');
  assert.strictEqual(s1.command, 'npx');
  assert.deepStrictEqual(s1.args, ['-y', 'fs']);
  assert.ok(recEq(s1.env as Record<string, string>, { K: 'v', V: 'w' }), `env 值漂移：${JSON.stringify(s1.env)}`);
  assert.deepStrictEqual(Object.keys(r1).sort(), ['headers', 'name', 'transport', 'url'], `http 条目键集漂移：${Object.keys(r1).sort().join(',')}`);
  assert.strictEqual(r1.transport, 'http');
  assert.strictEqual(r1.url, 'https://x/mcp');
  assert.ok(recEq(r1.headers as Record<string, string>, { Auth: 'Bearer t' }), `headers 值漂移：${JSON.stringify(r1.headers)}`);
  const badSkipped = skippedOf(r).some((s) => s.name === 's1' || s.name === 'r1');
  assert.ok(!badSkipped, '合法条目被误列入 skipped（跳过误伤）');
});

console.log('\n=== T9-H args/env 字段级非法 ≠ 跳过 ===');
check('T9-H 字段级非法条目仍导入（丢非法字段），skipped 不含该条目、fieldNotes 提示级可见', () => {
  const r = parse(JSON.stringify({ mcpServers: { a: { type: 'stdio', command: 'x', args: [1, 2], env: { K: 1, OK: 'v' } } } }));
  assert.ok(r.ok, '应 ok:true');
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 1, 'args/env 字段级非法不得跳过整条（契约第 5 条反面）');
  const entry = r.servers[0] as Record<string, unknown>;
  assert.strictEqual(entry.name, 'a');
  assert.strictEqual(entry.command, 'x', '合法 command 不得被字段级非法波及');
  assert.ok(!Object.prototype.hasOwnProperty.call(entry, 'args'), '非法 args 应被丢弃（现状语义：丢字段不跳条目）');
  assert.ok(recEq(entry.env as Record<string, string>, { OK: 'v' }), 'env 应仅保留合法字符串键 OK');
  assert.ok(!skippedOf(r).some((s) => s.name === 'a'), '字段级非法条目被误判成跳过（整条丢失）');
  const notes = fieldNotesOf(r);
  const argsNote = notes.find((n) => n.name === 'a' && n.reason.includes('args') && n.reason.includes('忽略'));
  const envNote = notes.find((n) => n.name === 'a' && n.reason.includes('env') && n.reason.includes('忽略'));
  assert.ok(argsNote, `缺 args 字段忽略提示（fieldNotes），实际 ${JSON.stringify(notes)}`);
  assert.ok(envNote, `缺 env 字段忽略提示（fieldNotes），实际 ${JSON.stringify(notes)}`);
});
check('T9-H-2 渲染层字段忽略提示钉（importFieldNotes 逐条 name — reason）', () => {
  assert.ok(settingsTpl.includes('v-for="n in importFieldNotes"'), '渲染层缺字段忽略提示列表（importFieldNotes）');
  assert.ok(settingsTpl.includes('{{ n.name }} — {{ n.reason }}'), '字段忽略提示缺「name — reason」形态');
});

console.log('\n=== T9-I 空 mcpServers:{} 边界 ===');
check('T9-I 空表 → ok:true、servers 空、skipped 空（不误报全跳过）', () => {
  const r = parse(JSON.stringify({ mcpServers: {} }));
  assert.ok(r.ok, '空表应 ok:true（既有 A4 空表可再导入语义）');
  if (!r.ok) return;
  assert.strictEqual(r.servers.length, 0, '空表 servers 应为空');
  assert.strictEqual(skippedOf(r).length, 0, '空表不得产生 skipped（会被误报为「全部跳过」错误）');
});

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
