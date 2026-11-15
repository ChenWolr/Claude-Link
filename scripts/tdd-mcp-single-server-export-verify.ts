// tdd-mcp-single-server-export-verify.ts
// UI13 批次 P10「MCP 单服务器可导入 JSON 导出」（2026-11-14 计划，用例正本 03-test-cases.md §P10）。
// TDD 验证脚本：T10-A~J 十条用例，行为直测 src/shared/mcp-json.ts:buildSingleServerExportJson
// （纯 TS 共享模块，selftest-mcp-settings.ts K 组既有先例）与
// src/main/modules/export-web-tickets.ts 票据纯函数（selftest-mcp-export.ts C 组既有先例）
// + ipc-handlers.ts / McpSettings.vue 结构钉：
//   T10-A  单服务器导出形态：产物 JSON.parse 后根 {"mcpServers":{"<name>":{…}}}，mcpServers
//          恰含单键=服务器名，条目字段完整（stdio: type/command/args/env；remote: type/url/headers）；
//   T10-B  往返成立含密钥：env K='secret-value-123' → 导出文本含明文（非 •••••••• 哨兵），
//          包裹形产物携带明文；回喂 parseMcpServersJson → ok:true 且恰含该服务器、密钥完整回读；
//   T10-C  handler 单服务器分支结构钉：载荷 name 校验（目标服务器不存在）+ servers 收窄 +
//          count 恒 1 + 桌面分支 clipboard.writeText(json)（selftest-mcp-export B 组同款口径）；
//   T10-D  网页一次性票据下载结构钉：handler createTicketForContent（event===null 早于剪贴板）
//          + 渲染层 exportSingleServer 的 downloadUrl → a[download] 点击分支；
//   T10-E  三作用域卡片导出钮：row__acts 共用区（managed 门之前）每卡一枚「导出此服务器」
//          （aria/title=`导出 ${card.name} 可导入 JSON`，@click.stop=exportSingleServer(card)）；
//   T10-F  编辑器 JSON 模式两钉：①序列化产物恒 mcpServers 包裹形且 env/headers 值维持
//          MCP_VALUE_MASK 哨兵（哨兵字面全仓唯一定义钉 + 编辑器序列化走哨兵链）；
//          ②footer 说明「完整可导入 JSON 请用列表卡片「导出此服务器」」（文案字面钉）；
//   T10-G  哨兵回导不入库回归门：spawn npx tsx scripts/selftest-mcp-writer.ts 退出码 0；
//   T10-H  作用域级导出回归门：spawn npx tsx scripts/selftest-mcp-export.ts 退出码 0；
//   T10-I  保留键名服务器（mcpServers/servers）与普通名同形（恒包裹形）+ 回喂解析仍得该服务器；
//   T10-J  票据单次消费拒止：createTicketForContent → consumeTicket 命中一次 → 同票立即再消费
//          返回 null（行为直测；票据「即删」属 P11 范围，本用例按现状 used 标记语义判定）；
//   T10-K  managed 成表载体（2026-11-14 UI13 评审 P3-4 / S3 点追加）：managed 作用域成表必须
//          null 原型载体——名为 __proto__ 的服务器成表结果含该 own 键、不落原型槽位（抽取
//          handler 内真实成表块 + 桩 getConfig 行为直测，附载体结构钉；与 raw 读取器
//          mcp-scanner.ts:104 / 导出投影 mcp-config.ts:433 同款口径）。
// 并发向不适用（03 §P10 已注明）：导出为用户单击动作 + 票据单次消费无共享竞态面，重复消费由
// T10-J 覆盖。RED 预期：T10-A/B/C/D/E/I 先红（未实现树上无 name 分支/导出钮/恒包裹形）；
// T10-G/H 回归钉现状即绿；T10-J 现状 used 标记已满足二次消费 null——绿属预期。
// 运行：npx tsx scripts/tdd-mcp-single-server-export-verify.ts（登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { buildSingleServerExportJson, MCP_VALUE_MASK } from '../src/shared/mcp-json';
import { parseMcpServersJson } from '../src/main/modules/mcp/mcp-config';
import { createTicketForContent, consumeTicket, reset } from '../src/main/modules/export-web-tickets';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const readSrc = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const handlersSrc = readSrc('src/main/ipc-handlers.ts');
const settingsSrc = readSrc('src/renderer/components/config/McpSettings.vue');
const tplStart = settingsSrc.indexOf('<template>');
const tplEnd = settingsSrc.lastIndexOf('</template>');
const settingsTpl = tplStart >= 0 && tplEnd > tplStart ? settingsSrc.slice(tplStart, tplEnd) : '';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

/** handler 切片：MCP_EXPORT_SCOPED 注册行起 → MCP_PARSE_JSON 注册行止（单服务器导出分支所在）。 */
function exportHandlerSlice(): string {
  const start = handlersSrc.indexOf('IPC_CHANNELS.MCP_EXPORT_SCOPED');
  const end = handlersSrc.indexOf('IPC_CHANNELS.MCP_PARSE_JSON', start);
  assert.ok(start > -1 && end > start, 'MCP_EXPORT_SCOPED handler 切片定位失败');
  return handlersSrc.slice(start, end);
}

/** spawn 既有契约脚本（退出码 0 = 绿；失败 tail 供定位）。 */
function spawnAssert(script: string): void {
  const r = spawnSync('npx', ['tsx', script], { cwd: repoRoot, encoding: 'utf8', shell: process.platform === 'win32' });
  const tail = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.trim().split(/\r?\n/).slice(-6).join('\n');
  assert.equal(r.status, 0, `${script} 退出码 ${r.status}（连带契约被波及）\n${tail}`);
}

/** record 深相等（原型无关：JSON.parse 产物与字面值比对；数组/嵌套对象按值比，非引用）。 */
function recEq(a: Record<string, unknown> | undefined, b: Record<string, unknown>): boolean {
  if (a === undefined) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && JSON.stringify(a[k]) === JSON.stringify(b[k]));
}

console.log('\n=== T10-A 单服务器导出形态（包裹形、mcpServers 恰单键、条目字段完整） ===');
check('T10-A-1 stdio 形：产物根 {"mcpServers":{"<name>":{…}}}，恰单键，type/command/args/env 完整', () => {
  const text = buildSingleServerExportJson({ name: 'context7', transport: 'stdio', command: 'npx', args: ['-y', 'ctx'], env: { K: 'v' } });
  let root: { mcpServers?: Record<string, Record<string, unknown>> } | null = null;
  try { root = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> }; }
  catch (e) { throw new Error(`产物应可 JSON.parse：${(e as Error).message}`); }
  assert.ok(root !== null && root.mcpServers !== undefined && typeof root.mcpServers === 'object',
    `导出裸形（无 mcpServers 包裹）——条目 10 缺陷形态之一：${text.slice(0, 80)}`);
  assert.ok(Object.keys(root.mcpServers!).length === 1,
    `mcpServers 应恰含单键（单服务器导出），实际 ${Object.keys(root.mcpServers!).length} 键：${Object.keys(root.mcpServers!).join(',')}`);
  const entry = root.mcpServers!['context7'];
  assert.ok(entry !== undefined, `mcpServers 应恰含键 context7，实际 ${Object.keys(root.mcpServers!).join(',')}`);
  assert.ok(recEq(entry, { type: 'stdio', command: 'npx', args: ['-y', 'ctx'], env: { K: 'v' } }),
    `条目字段应完整：${JSON.stringify(entry)}`);
});
check('T10-A-2 remote（http）形：产物根包裹形恰单键，type/url/headers 完整、无 command/args/env 键', () => {
  const text = buildSingleServerExportJson({ name: 'remote-1', transport: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } });
  const root = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> };
  assert.ok(root.mcpServers !== undefined, `导出裸形（无 mcpServers 包裹）：${text.slice(0, 80)}`);
  assert.ok(Object.keys(root.mcpServers!).length === 1 && root.mcpServers!['remote-1'] !== undefined,
    `mcpServers 应恰含单键 remote-1，实际 ${Object.keys(root.mcpServers!).join(',')}`);
  const entry = root.mcpServers!['remote-1'];
  assert.ok(recEq(entry, { type: 'http', url: 'https://x.test/mcp', headers: { Authorization: 'Bearer t' } }),
    `http 条目字段应完整（互斥键不含 command/args/env）：${JSON.stringify(entry)}`);
});
check('T10-A-3 空容器省略 + timeoutMs：args:[]/env:{} 不出键，合法 timeoutMs 随包裹形输出', () => {
  const text = buildSingleServerExportJson({ name: 'bare-s', transport: 'stdio', command: 'node', args: [], env: {}, timeoutMs: 30000 });
  const root = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> };
  assert.ok(root.mcpServers !== undefined, `导出裸形（无 mcpServers 包裹）：${text.slice(0, 80)}`);
  const entry = root.mcpServers!['bare-s'];
  assert.ok(entry !== undefined, 'mcpServers 应含 bare-s');
  for (const absent of ['args', 'env']) assert.ok(!(absent in entry), `空 ${absent} 应省略键：${JSON.stringify(entry)}`);
  assert.strictEqual(entry.timeoutMs, 30000, `合法 timeoutMs 应输出：${JSON.stringify(entry)}`);
});

console.log('\n=== T10-B 往返成立含密钥（明文非哨兵） ===');
check('T10-B 导出文本含明文 secret-value-123（非 •••••••• 哨兵）；包裹形产物携带明文；回喂 parseMcpServersJson 恰得该服务器且密钥完整回读', () => {
  const text = buildSingleServerExportJson({ name: 'sec-srv', transport: 'stdio', command: 'npx', env: { K: 'secret-value-123' } });
  assert.ok(text.includes('secret-value-123'), '导出文本应含明文密钥（导出构造走主进程明文源）');
  assert.ok(!text.includes(MCP_VALUE_MASK), '导出文本不得含脱敏哨兵（走脱敏快照=条目 10 缺陷原样：粘回导入丢密钥）');
  const root = JSON.parse(text) as { mcpServers?: Record<string, Record<string, unknown>> };
  assert.ok(root.mcpServers !== undefined && root.mcpServers!['sec-srv'] !== undefined,
    `导出产物应为 mcpServers 包裹形且含 sec-srv：${text.slice(0, 80)}`);
  assert.strictEqual((root.mcpServers!['sec-srv'].env as Record<string, string>).K, 'secret-value-123',
    '包裹形产物 env 应携带明文值');
  const back = parseMcpServersJson(text);
  assert.ok(back.ok, `回喂 parseMcpServersJson 应 ok:true，实际 ${back.ok ? '' : back.error}`);
  if (!back.ok) return;
  assert.strictEqual(back.servers.length, 1, `应恰解析出 1 条，实际 ${back.servers.length}`);
  const srv = back.servers[0];
  assert.strictEqual(srv.name, 'sec-srv', `条目名应 sec-srv，实际 ${srv.name}`);
  assert.ok(recEq(srv.env as Record<string, string>, { K: 'secret-value-123' }), `密钥应完整回读：${JSON.stringify(srv.env)}`);
});

console.log('\n=== T10-C handler 单服务器分支 + 桌面剪贴板（结构钉） ===');
check('T10-C handler：载荷 name 校验（非空 + 键集内，否则「目标服务器不存在」）+ servers 收窄 + count 恒 1 + 桌面分支 clipboard.writeText(json)', () => {
  const slice = exportHandlerSlice();
  assert.ok(slice.includes("typeof reqName !== 'string'"), '缺 name 非空字符串校验');
  assert.ok(slice.includes('目标服务器不存在'), '缺「目标服务器不存在」中文错误（陈旧卡片名/非法 name 须可 toast）');
  assert.ok(/servers\[reqName\]/.test(slice), '缺按 name 收窄取源（servers[reqName]）——单服务器导出走主进程明文真值');
  assert.ok(slice.includes('count = 1'), '缺 count 恒 1（单服务器导出回包 count 不得报作用域总数）');
  const jsonAt = slice.indexOf('const json = buildMcpServersExportJson(servers);');
  const clipAt = slice.indexOf('clipboard.writeText(json)');
  assert.ok(jsonAt > -1 && clipAt > jsonAt,
    '桌面剪贴板链断裂：应先 buildMcpServersExportJson(servers) 构建 JSON 再 clipboard.writeText(json)（selftest-mcp-export B 组同款口径）');
});

console.log('\n=== T10-D 网页一次性票据下载（结构钉） ===');
check('T10-D-1 handler web 分支：createTicketForContent（event===null 早于剪贴板写入；正文走票据、URL 不含内容）', () => {
  const slice = exportHandlerSlice();
  const webAt = slice.indexOf('if (event === null) {');
  const clipAt = slice.indexOf('clipboard.writeText(json)');
  assert.ok(slice.includes('createTicketForContent('), 'web 分支缺 createTicketForContent（一次性票据签发）');
  assert.ok(/createTicketForContent\([^)]*json/.test(slice), 'createTicketForContent 应以 json 变量为正文（URL 不含内容）');
  assert.ok(slice.includes('downloadUrl?: string'), '回包类型缺 downloadUrl?: string');
  assert.ok(webAt > -1 && clipAt > -1 && webAt < clipAt, 'event===null 网页分支应早于 clipboard.writeText(json)（网页路径绝不写桌面剪贴板）');
});
check('T10-D-2 渲染层 exportSingleServer 下载消费分支：r.downloadUrl → a[download] 点击', () => {
  const fnAt = settingsSrc.indexOf('async function exportSingleServer');
  assert.ok(fnAt > -1, '渲染层缺 exportSingleServer（单服务器导出入口未接线）');
  const body = settingsSrc.slice(fnAt, settingsSrc.indexOf('}', fnAt) + 2000).split(/\nasync function |\nfunction /)[0] ?? '';
  assert.ok(body.includes('claude.exportMcpScoped'), 'exportSingleServer 应复用 MCP_EXPORT_SCOPED 通道（claude.exportMcpScoped）');
  assert.ok(body.includes('r.downloadUrl'), 'exportSingleServer 缺 r.downloadUrl 分支（网页票据下载未接线）');
  assert.ok(body.includes("document.createElement('a')"), 'downloadUrl 分支缺 a[download] 创建');
  assert.ok(body.includes('a.download'), 'a 元素缺 download 属性（触发下载语义）');
  assert.ok(body.includes('a.click()'), 'downloadUrl 分支缺 a.click() 触发');
  assert.ok(!body.includes('clipboard.writeText'), '渲染层不得自持明文写剪贴板（剪贴板写入在主进程桌面分支）');
});

console.log('\n=== T10-E 三作用域卡片导出按钮（结构钉） ===');
check('T10-E row__acts 共用区（managed 门之前=三作用域逐一渲染）每卡一枚「导出此服务器」（aria/title=导出 <name> 可导入 JSON + @click.stop=exportSingleServer(card)）', () => {
  assert.ok(settingsTpl !== '', 'McpSettings.vue 模板切片失败');
  const actsStart = settingsTpl.indexOf('class="row__acts"');
  assert.ok(actsStart > -1, '卡片操作区 class="row__acts" 缺失');
  const gateIdx = settingsTpl.indexOf('<template v-if="activeScope.kind === \'managed\'">', actsStart);
  assert.ok(gateIdx > actsStart, 'managed 门锚漂移（操作区共用区结构变化）');
  const sharedActs = settingsTpl.slice(actsStart, gateIdx);
  const ariaLit = '导出 ${card.name} 可导入 JSON';
  assert.ok(sharedActs.includes(ariaLit), '卡片操作区共用区缺「导出 ${card.name} 可导入 JSON」按钮（三作用域卡片均有=门之前渲染）');
  assert.ok(sharedActs.split(ariaLit).length - 1 >= 2, 'aria-label 与 title 应同义绑定「导出 <name> 可导入 JSON」');
  assert.ok(sharedActs.includes(':aria-label="`导出 ${card.name} 可导入 JSON`"'), 'aria-label 应绑定「导出 <name> 可导入 JSON」');
  assert.ok(sharedActs.includes(':title="`导出 ${card.name} 可导入 JSON`"'), 'title 应绑定「导出 <name> 可导入 JSON」');
  const hits = settingsTpl.split('@click.stop="exportSingleServer(card)"').length - 1;
  assert.strictEqual(hits, 1, `exportSingleServer(card) 点击绑定应恰 1 处（共用区单枚按钮），实际 ${hits}`);
});

console.log('\n=== T10-F 编辑器 JSON 模式两钉 ===');
check('T10-F-1 编辑器序列化恒 mcpServers 包裹形且 env/headers 值维持哨兵；哨兵字面全仓唯一定义（src/ 仅 shared/mcp-json.ts）+ McpSettings 序列化走 buildSingleServerExportJson', () => {
  const text = buildSingleServerExportJson({ name: 'mask-s', transport: 'stdio', command: 'npx', env: { K: MCP_VALUE_MASK } });
  assert.ok(text.includes('"mcpServers"'), `编辑器 JSON 展示应恒为 mcpServers 包裹形（与导入格式对齐），实际裸形：${text.slice(0, 60)}`);
  assert.ok(text.includes(MCP_VALUE_MASK), '编辑器序列化应维持哨兵值原样输出（明文不出渲染层）');
  const masked = JSON.parse(text) as { mcpServers: Record<string, { env?: Record<string, string> }> };
  assert.strictEqual(masked.mcpServers['mask-s']?.env?.K, MCP_VALUE_MASK, '包裹形产物 env 值应为哨兵');
  // remote 形 headers 哨兵同钉（stdio/remote 互斥取侧，headers 走 http 形单独构一条）。
  const textRemote = buildSingleServerExportJson({ name: 'mask-h', transport: 'http', url: 'https://x.test/mcp', headers: { Authorization: MCP_VALUE_MASK } });
  const maskedRemote = JSON.parse(textRemote) as { mcpServers: Record<string, { headers?: Record<string, string> }> };
  assert.strictEqual(maskedRemote.mcpServers['mask-h']?.headers?.Authorization, MCP_VALUE_MASK, 'remote 包裹形产物 headers 值应为哨兵');
  // 哨兵字面全仓唯一定义钉：src/ 下 .ts/.vue/.tsx 文本文件中含字面 •••••••• 的文件仅 shared/mcp-json.ts。
  const offenders: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) { walk(p); continue; }
      if (!/\.(ts|tsx|vue)$/.test(name)) continue;
      let content = '';
      try { content = readFileSync(p, 'utf8'); } catch { continue; }
      if (content.includes(MCP_VALUE_MASK)) offenders.push(p);
    }
  };
  walk(join(repoRoot, 'src'));
  assert.deepStrictEqual(offenders, [join(repoRoot, 'src', 'shared', 'mcp-json.ts')],
    `哨兵字面应唯一定义于 src/shared/mcp-json.ts，实际出现于：${offenders.join(' ; ')}`);
  assert.ok(settingsSrc.includes('jsonText.value = buildSingleServerExportJson(formDraftToExportInput())'),
    '编辑器 JSON 文本应源自 buildSingleServerExportJson（表单 → JSON 方向单一供料点，编辑器序列化走哨兵链）');
});
check('T10-F-2 编辑器区说明文案钉：「完整可导入 JSON 请用列表卡片「导出此服务器」」（footer 注释行扩写）', () => {
  assert.ok(settingsTpl.includes('完整可导入 JSON 请用列表卡片「导出此服务器」'),
    '编辑器 JSON footer 缺「完整可导入 JSON 请用列表卡片「导出此服务器」」说明行');
});

console.log('\n=== T10-G 哨兵回导不入库（回归门：selftest-mcp-writer） ===');
check('T10-G selftest-mcp-writer 全绿（哨兵回导不入库语义保留）', () => {
  spawnAssert('scripts/selftest-mcp-writer.ts');
});

console.log('\n=== T10-H 作用域级导出回归门（selftest-mcp-export） ===');
check('T10-H selftest-mcp-export 全绿（多键 {"mcpServers":{…}} 作用域导出 A/B/C 组回归不变）', () => {
  spawnAssert('scripts/selftest-mcp-export.ts');
});

console.log('\n=== T10-I 保留键名服务器：与普通名同形 + 往返 ===');
check('T10-I name=mcpServers/servers 的导出与普通名导出同形（恒包裹形），回喂 parseMcpServersJson 仍得该服务器', () => {
  const refText = buildSingleServerExportJson({ name: 'ref-name', transport: 'stdio', command: 'npx' });
  assert.ok(refText.includes('"mcpServers"'), '参照（普通名）导出应为包裹形——保留名同形断言的基准失效');
  for (const reserved of ['mcpServers', 'servers'] as const) {
    const text = buildSingleServerExportJson({ name: reserved, transport: 'stdio', command: 'npx' });
    const refSameShape = refText.replace('"ref-name"', JSON.stringify(reserved));
    assert.strictEqual(text, refSameShape,
      `${reserved}：应与普通名同形（恒包裹形、缩进层级一致），实际与参照不符——\n得到 ${JSON.stringify(text.slice(0, 90))}\n参照 ${JSON.stringify(refSameShape.slice(0, 90))}`);
    const back = parseMcpServersJson(text);
    assert.ok(back.ok, `${reserved}：回读应 ok:true，实际 ${back.ok ? '' : back.error}`);
    if (!back.ok) continue;
    assert.strictEqual(back.servers.length, 1, `${reserved}：应恰回读 1 条，实际 ${back.servers.length}（条目被形态识别吞掉）`);
    assert.strictEqual(back.servers[0]?.name, reserved, `${reserved}：回读条目名不符，实际 ${back.servers[0]?.name}`);
  }
});

console.log('\n=== T10-J 票据单次消费拒止（行为直测） ===');
check('T10-J createTicketForContent → consumeTicket 命中一次（content/mime/filename 还原）→ 同票立即再消费返回 null；URL 不含内容', () => {
  reset();
  const body = '{"mcpServers":{"one":{"type":"stdio","command":"npx"}}}';
  const issued = createTicketForContent('mcp-servers-user.json', body, 'application/json');
  assert.ok(/^\/api\/export-download\?ticket=[A-Za-z0-9_-]+$/.test(issued.url), `票据 URL 形态异常：${issued.url}`);
  assert.ok(!issued.url.includes('mcpServers'), 'URL 不得含内容（泄露面）');
  assert.strictEqual(issued.filename, 'mcp-servers-user.json', 'filename 应原样');
  const ticket = issued.url.split('ticket=')[1] ?? '';
  const first = consumeTicket(ticket);
  assert.ok(first !== null, '首次消费应命中');
  assert.strictEqual(first?.content, body, '首次消费应还原 content');
  assert.strictEqual(first?.mime, 'application/json', '首次消费应还原 mime');
  const second = consumeTicket(ticket);
  assert.strictEqual(second, null, `同票立即再消费应返回 null（一次性拒止），实际 ${JSON.stringify(second)}`);
});

console.log('\n=== T10-K managed __proto__ 成表载体（UI13 评审 P3-4 / S3：null 原型载体） ===');
check('T10-K managed 成表 null 原型载体：__proto__ 名服务器成表含 own 键、不落原型槽位（抽取真实成表块行为直测 + 载体结构钉）', () => {
  const slice = exportHandlerSlice();
  const head = "if (req.scope === 'managed') {";
  const mAt = slice.indexOf(head);
  const uAt = slice.indexOf("} else if (req.scope === 'user')");
  assert.ok(mAt > -1 && uAt > mAt, 'managed 成表分支定位失败（handler 切片结构漂移）');
  const block = slice.slice(mAt + head.length, uAt);
  // 行为直测：执行抽取的真实成表源码（桩 getConfig 供 __proto__ 名服务器）。{} 字面量载体下
  // servers['__proto__']=server 触发 Object.prototype 的 __proto__ setter——键落原型槽位（载体
  // 原型被改写、不成 own 属性）：count=Object.keys 漏计、单服务器导出 hasOwnProperty 误报
  // 「目标服务器不存在」（评审 P3-4 机制）。
  const entry = { name: '__proto__', transport: 'stdio', command: 'npx', args: ['-y', 'x'] };
  const build = new Function('getConfig', `"use strict"; let servers;\n${block}\nreturn servers;`) as
    (g: () => { mcpServers: unknown[] }) => Record<string, unknown>;
  const table = build(() => ({ mcpServers: [entry] }));
  assert.ok(Object.prototype.hasOwnProperty.call(table, '__proto__'),
    `成表结果应含 own 键 __proto__（不落原型槽位），实际 own keys=[${Object.keys(table).join(',')}]——键被 __proto__ setter 吞入原型链`);
  assert.strictEqual(Object.getPrototypeOf(table), null,
    `载体应保持 null 原型（__proto__ 名不得经 setter 改写载体原型链），实际原型=${String(Object.getPrototypeOf(table))}`);
  assert.strictEqual(table['__proto__'], entry, '成表结果 __proto__ 键值应为该服务器条目（完整保留）');
  // 结构钉：载体必须 Object.create(null)（raw 读取器 mcp-scanner.ts:104 / 导出投影
  // mcp-config.ts:433 同款口径），且保持 servers[server.name]=server 计算键成表形态。
  assert.ok(!/\bservers\s*=\s*\{\s*\}/.test(block), 'managed 成表不得用普通对象字面量载体（__proto__ 名落原型槽位）');
  assert.ok(block.includes('Object.create(null)'), 'managed 成表载体应为 Object.create(null)（null 原型，全 MCP 链同款口径）');
  assert.ok(/servers\[server\.name\]\s*=\s*server\s*;/.test(block), '成表应保持 servers[server.name]=server 计算键形态（载体 null 原型后 __proto__ 名即 own 键）');
});

console.log(`\n=== 结果：${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
