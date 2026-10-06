// tdd-release-notes-verify.ts
// 更新说明 HTML 直出修复（2026-10-05 计划 §2.4）TDD 验证脚本：
//   P1-P9  release-notes 纯函数行为断言（直接加载真跑）：真实 atom 样本转换 / 标题分级 /
//          链接 text (href) / 结构换行与空行折叠 / 实体安全（解码后置 + &amp; 最后解）/
//          script-style 整块剥除 / looksLikeHtmlNotes 词边界 / normalizeReleaseNotes 全形态 / CRLF；
//   W1-W4  接线字面钉：app-updater import+归一化调用+旧三元移除净 / update.ts 注释修正
//          （releases.atom）/ selftest 清单登记 / 渲染层零改动（UpdateDialog 与 ConfigPage
//          仍各含 <pre>{{ updateStore.state.releaseNotes }}</pre> 纯文本直出）。
//          P10/W5/W6 review 尾款：pre/嵌套列表/表格分隔、控制实体与大写 hex 守卫、命名实体扩表、
//          ConfigPage 注释同步、app-updater 嵌式 // 清除。
// 运行：npx tsx scripts/tdd-release-notes-verify.ts（已登记 scripts/selftest-static-list.txt）
// RED 约定（计划 §5.7）：P 组经受保护加载——模块缺失时逐项 fail（fail>0）而非顶层 crash。
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}
function readRel(p: string): string {
  return readFileSync(resolve(__dirname, '..', p), 'utf8');
}

type ReleaseNotesModule = typeof import('../src/shared/release-notes');
let rel: ReleaseNotesModule | null = null;
try {
  // 受保护加载：模块尚不存在（RED 阶段）时置 null，逐项 fail 而非顶层 crash。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  rel = require('../src/shared/release-notes') as ReleaseNotesModule;
} catch {
  rel = null;
}
function rel_(): ReleaseNotesModule {
  assert.ok(rel, 'src/shared/release-notes 未加载（模块缺失或导出不全）');
  return rel;
}

console.log('\n=== P1) 真实 atom 样本：HTML 渲染 → 可读纯文本 ===');
check('P1 v0.4.2 atom 片段 → 井号标题/- 列表/内联标记/实体解码，零残留标签', () => {
  const { htmlReleaseNotesToText } = rel_();
  const sample = '<h2>新增</h2><ul><li><strong>上下文窗口按供应商模型配置</strong>：DPR&gt;1 缩放修正</li><li>修复 A &amp; B 的冲突</li></ul>';
  const out = htmlReleaseNotesToText(sample);
  assert.ok(out.includes('## 新增'), `标题未转换: ${JSON.stringify(out)}`);
  assert.ok(out.includes('- **上下文窗口按供应商模型配置**：'), `li/strong 未转换: ${JSON.stringify(out)}`);
  assert.ok(out.includes('DPR>1'), `&gt; 未解码: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('&gt;'), `&gt; 残留: ${JSON.stringify(out)}`);
  assert.ok(!/<\/?[a-zA-Z][^>]*>/.test(out), `残留标签: ${JSON.stringify(out)}`);
});

console.log('\n=== P2) 标题分级 ===');
check('P2 h3→### x、h1→# y', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('<h3>x</h3>'), '### x');
  assert.equal(htmlReleaseNotesToText('<h1>y</h1>'), '# y');
});

console.log('\n=== P3) 链接 ===');
check('P3 href 非空且≠text → text (href)；无 href <a> → 纯文本直出', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('<a href="https://example.com">仓库</a>'), '仓库 (https://example.com)');
  assert.equal(htmlReleaseNotesToText('<a>纯文本</a>'), '纯文本');
});

console.log('\n=== P4) 结构：换行与空行折叠 ===');
check('P4 br→两行；p×2→两行；3+ 连续空行折叠为一个空行；行尾空白剥除', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('a<br>b'), 'a\nb');
  assert.equal(htmlReleaseNotesToText('<p>x</p><p>y</p>'), 'x\ny');
  assert.equal(htmlReleaseNotesToText('<p>a</p>\n\n\n\n<p>b</p>'), 'a\n\nb');
  assert.equal(htmlReleaseNotesToText('<p>a  </p>'), 'a');
});

console.log('\n=== P5) 实体安全（解码后置 + &amp; 最后解）===');
check('P5 &lt;tag&gt;→<tag> 不再被剥；&amp;amp; 只解一层；数字实体 hex/dec；孤立代理与越界原样保留', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('&lt;tag&gt;'), '<tag>');
  assert.equal(htmlReleaseNotesToText('&amp;amp;'), '&amp;');
  // 0x4e2d 的十进制恰为 20013：hex 与 dec 两条路径解码同一码点「中」。
  assert.equal(htmlReleaseNotesToText('&#x4e2d;&#20013;'), '中中');
  assert.equal(htmlReleaseNotesToText('&#x6587;'), '文');
  assert.equal(htmlReleaseNotesToText('&#xD800;'), '&#xD800;');
  assert.equal(htmlReleaseNotesToText('&#x110000;'), '&#x110000;');
});

console.log('\n=== P6) script/style 整块剥除 ===');
check('P6 script/style 整块剥除（内含尖括号不泄漏）', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('<style>a{color:b}</style><p>ok</p>'), 'ok');
  assert.equal(htmlReleaseNotesToText('<script>var s = "<b>x</b>"</script><p>ok</p>'), 'ok');
});

console.log('\n=== P7) looksLikeHtmlNotes 词边界 ===');
check('P7 纯文本 a<b 不误伤 / Markdown→false / 已知标签→true / <abbr 词边界不命中', () => {
  const { looksLikeHtmlNotes } = rel_();
  assert.equal(looksLikeHtmlNotes('a < b 且 c > d'), false);
  assert.equal(looksLikeHtmlNotes('## 新增\n- x'), false);
  assert.equal(looksLikeHtmlNotes('<h2>x</h2>'), true);
  assert.equal(looksLikeHtmlNotes('<li>x'), true);
  assert.equal(looksLikeHtmlNotes('<a href="u">t</a>'), true);
  assert.equal(looksLikeHtmlNotes('<abbr>x</abbr>'), false);
});

console.log('\n=== P8) normalizeReleaseNotes 全形态 ===');
check('P8 Markdown 直通 / HTML 转换 / 空白→null / 数组各形态 / 非法→null', () => {
  const { normalizeReleaseNotes } = rel_();
  assert.equal(normalizeReleaseNotes('## 新增\n- x'), '## 新增\n- x');
  assert.equal(normalizeReleaseNotes('<h2>新增</h2>'), '## 新增');
  assert.equal(normalizeReleaseNotes(''), null);
  assert.equal(normalizeReleaseNotes('   '), null);
  // 注：§2.1 步骤4 标题替换自带尾 \n，与 join('\n') 叠加 → 标题后空一行（算法忠实输出）。
  assert.equal(normalizeReleaseNotes([{ note: '<h2>a</h2>' }, { note: 'b' }]), '## a\n\nb');
  assert.equal(normalizeReleaseNotes([{ version: '1.0.0', note: 'x' }]), 'x');
  assert.equal(normalizeReleaseNotes([1, null, { note: 'y' }]), 'y');
  assert.equal(normalizeReleaseNotes(123), null);
  assert.equal(normalizeReleaseNotes({}), null);
  assert.equal(normalizeReleaseNotes(null), null);
  assert.equal(normalizeReleaseNotes(undefined), null);
});

console.log('\n=== P9) CRLF 归一 ===');
check('P9 CRLF 输入输出零 \\r 残留', () => {
  const { htmlReleaseNotesToText, normalizeReleaseNotes } = rel_();
  assert.ok(!htmlReleaseNotesToText('<h2>a</h2>\r\n<p>b</p>').includes('\r'));
  const viaNormalize = normalizeReleaseNotes('<h2>a</h2>\r\n<p>b</p>');
  assert.ok(viaNormalize !== null && !viaNormalize.includes('\r'));
});

console.log('\n=== P10) review 尾款：pre/嵌套列表/表格/实体守卫与扩表 ===');
check('P10 RF1 </pre> 换行；RF2 嵌套/平铺列表；RF3 表格分隔；RF4 控制实体与大写 hex；RF5 命名实体', () => {
  const { htmlReleaseNotesToText } = rel_();
  assert.equal(htmlReleaseNotesToText('<p>a</p><pre><code>x</code></pre>b'), 'a\n`x`\nb');
  assert.equal(htmlReleaseNotesToText('<ul><li>a<ul><li>b</li></ul></li></ul>'), '- a\n- b');
  assert.equal(htmlReleaseNotesToText('<h2>t</h2><ul><li>a</li><li>b</li></ul>'), '## t\n\n- a\n- b');
  assert.equal(htmlReleaseNotesToText('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>'), 'A | B\n1 | 2');
  assert.equal(htmlReleaseNotesToText('<table>\n<thead>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n</thead>\n<tbody>\n<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>'), 'A | B\n\n1 | 2'); // 分行排版：分隔生效，行间空行为算法忠实输出
  assert.equal(htmlReleaseNotesToText('<p>列表 a | b | </p>'), '列表 a | b |'); // 正当行尾管道不再被剥
  assert.equal(htmlReleaseNotesToText('a&#xD;b'), 'a&#xD;b');
  assert.equal(htmlReleaseNotesToText('a&#x0;b'), 'a&#x0;b');
  assert.equal(htmlReleaseNotesToText('&#X4e2d;'), '中');
  assert.equal(htmlReleaseNotesToText('A &copy; 2026'), 'A © 2026');
  assert.equal(htmlReleaseNotesToText('x &mdash; y'), 'x — y');
});

console.log('\n=== W) 接线字面钉 ===');
const appUpdater = readRel('src/main/modules/app-updater.ts');
const updateTypes = readRel('src/shared/types/update.ts');
const selftestList = readRel('scripts/selftest-static-list.txt');
const updateDialogVue = readRel('src/renderer/components/layout/UpdateDialog.vue');
const configPage = readRel('src/renderer/pages/ConfigPage.vue');

check('W1 app-updater：import 归一化模块 + releaseNotes 归一化调用 + 旧三元移除净', () => {
  assert.ok(appUpdater.includes("import { normalizeReleaseNotes } from '../../shared/release-notes'"), 'import 缺失');
  assert.ok(appUpdater.includes('releaseNotes: normalizeReleaseNotes(info.releaseNotes)'), '归一化调用缺失');
  assert.ok(!appUpdater.includes("typeof info.releaseNotes === 'string'"), '旧三元残留');
});
check('W2 update.ts：注释含 releases.atom 且旧「Markdown 源码」注释清除', () => {
  assert.ok(updateTypes.includes('releases.atom'), '新注释缺失');
  assert.ok(!updateTypes.includes('Markdown 源码'), '旧注释残留');
});
check('W3 selftest-static-list.txt 已登记本脚本', () => {
  assert.ok(selftestList.includes('scripts/tdd-release-notes-verify.ts'), '清单未登记');
});
check('W4 渲染层 <pre> 形态：UpdateDialog 与 ConfigPage 仍各含 <pre> 纯文本直出', () => {
  assert.ok(updateDialogVue.includes('<pre>{{ updateStore.state.releaseNotes }}</pre>'), 'UpdateDialog <pre> 形态漂移');
  assert.ok(configPage.includes('<pre>{{ updateStore.state.releaseNotes }}</pre>'), 'ConfigPage <pre> 形态漂移');
});
check('W5 ConfigPage：注释同步为「主进程已归一」口径，旧「Markdown 源码」清除', () => {
  assert.ok(configPage.includes('<pre>{{ updateStore.state.releaseNotes }}</pre>'), 'ConfigPage <pre> 形态漂移');
  assert.ok(!configPage.includes('Markdown 源码'), 'ConfigPage 旧注释残留');
});
check('W6 app-updater：嵌式 // 笔误清除净（不含 "，//"）', () => {
  assert.ok(!appUpdater.includes('，//'), '嵌式 // 残留');
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
