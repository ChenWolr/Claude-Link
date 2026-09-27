// tdd-markdown-indented-code-off-verify.ts
// 问题③（2026-09-27 六使用问题）贴 Java 报错字体变样 TDD 验证脚本：
//   L1–L8  行为用例——项目 renderMarkdown 实测缩进代码块关闭后的 6 类样例 + 围栏/行内不变；
//   C1–C3  源码契约——markdown.ts 消息路径 disable('code') + 注释适用范围 + main.css 等宽字体栈。
// 根因：CommonMark 缩进代码块——空行后 ≥4 空格或 tab 缩进行（Java 堆栈 "\tat ..." 最常见）
// 被渲染成 .code-block 等宽块；用户回显也走 markdown 放大观感。
// 撞钉申报：regression-tests.ts testMarkdownIndentedCodeUsesContainer 钉旧行为，随本改动最小同步。
// 运行：npx tsx scripts/tdd-markdown-indented-code-off-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPreviewMarkdownRenderer, renderMarkdown } from '../src/renderer/utils/markdown';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

const javaStack4Space = '段落\n\n    at com.foo.Bar.baz(Bar.java:1)\n    at com.foo.Qux.quux(Qux.java:9)\n\n后文';
const javaStackTab = '段落\n\n\tat com.foo.Bar.baz(Bar.java:1)\n\n后文';

console.log('\n=== L1–L8 · 缩进代码块关闭行为（node 实测） ===');

check('L1 空行 + 4 空格缩进 at 行：不再产 .code-block，按普通段落渲染', () => {
  const html = renderMarkdown(javaStack4Space);
  assert.ok(!html.includes('code-block'), `4 空格缩进仍产代码块：${html}`);
  assert.ok(html.includes('at com.foo.Bar.baz'), '缩进内容丢失');
});
check('L2 空行 + tab 缩进 at 行：不再产 .code-block', () => {
  const html = renderMarkdown(javaStackTab);
  assert.ok(!html.includes('code-block'), `tab 缩进仍产代码块：${html}`);
});
check('L3 3 空格缩进：本就不触发代码块（守卫：不因关闭而变段）', () => {
  const html = renderMarkdown('段落\n\n   at x\n\n后文');
  assert.ok(!html.includes('code-block'), '3 空格不应触发代码块');
  assert.ok(html.includes('at x'), '内容丢失');
});
check('L4 无空行紧跟正文：4 空格续行属段落延续（行为不变）', () => {
  const html = renderMarkdown('段落\n    at x');
  assert.ok(!html.includes('code-block'), '无空行续行不应触发代码块');
});
check('L5 消息开头即缩进：不再产 .code-block', () => {
  const html = renderMarkdown('    at com.foo.Bar(Bar.java:1)\n后文');
  assert.ok(!html.includes('code-block'), `消息开头缩进仍产代码块：${html}`);
  assert.ok(html.includes('at com.foo.Bar'), '内容丢失');
});
check('L6 ``` 围栏：仍是统一 code-block 容器（fence 不受影响）', () => {
  const html = renderMarkdown('```js\nlet x = 1\n```');
  assert.ok(html.includes('class="code-block"'), `围栏代码块丢失：${html}`);
  assert.ok(html.includes('code-block__copy'), '围栏代码块缺复制按钮');
});
check('L7 行内 code 与行内 KaTeX 行为不变', () => {
  assert.ok(renderMarkdown('用 `x` 命令').includes('<code>'), '行内 code 丢失');
  assert.ok(renderMarkdown('公式 $E=mc^2$ 在文中').includes('katex'), '行内 KaTeX 丢失');
});
check('L8 预览渲染器保留缩进代码块行为（预览不受影响）', () => {
  const html = createPreviewMarkdownRenderer().render('段落\n\n    let x = 1\n\n后文');
  assert.ok(html.includes('<pre>'), `预览渲染器缩进代码块回退：${html}`);
});

// ── C1–C3 · 源码契约 ──

const markdownSrc = readFileSync(join(__dirname, '../src/renderer/utils/markdown.ts'), 'utf8');
const mainCssSrc = readFileSync(join(__dirname, '../src/renderer/assets/styles/main.css'), 'utf8');

console.log('\n=== C1–C3 · markdown.ts / main.css 源码契约 ===');

check('C1 markdown.ts：消息路径主渲染实例 md.disable(\'code\')（预览工厂不含）', () => {
  assert.ok(markdownSrc.includes("md.disable('code')"), "主渲染实例缺 md.disable('code')");
  const factory = markdownSrc.match(/export function createPreviewMarkdownRenderer\(\): MarkdownIt \{[\s\S]*?\n\}/)?.[0] ?? '';
  assert.ok(factory && !factory.includes("disable('code')"), '预览渲染工厂不应关闭缩进代码块');
});

check('C2 code_block 规则注释更新：说明消息路径已关闭、规则兜底适用范围', () => {
  const block = markdownSrc.match(/md\.renderer\.rules\.code_block[\s\S]*?\n\};/)?.[0] ?? '';
  assert.ok(block, '未找到 code_block renderer 规则');
  // 注释关键句直接钉（位于 md.disable('code') 与规则之间的说明块）：
  assert.ok(markdownSrc.includes("缩进代码块（CommonMark 'code' 规则）对消息路径关闭"), '注释未说明消息路径已关闭缩进代码块');
  assert.ok(markdownSrc.includes('仅当该规则被重新启用时兜底统一容器'), '注释未说明 code_block 规则的兜底适用范围');
  assert.ok(markdownSrc.includes('保留缩进代码块行为'), '注释未说明预览渲染器保留缩进代码块');
});

check('C3 main.css：.code-block code 补 font-family var(--font-mono)（与行内 code 同栈）', () => {
  const rule = mainCssSrc.match(/\.markdown-body \.code-block code\s*\{[^}]*\}/)?.[0] ?? '';
  assert.ok(rule, '未找到 .markdown-body .code-block code 规则');
  assert.ok(rule.includes('font-family: var(--font-mono);'), `code-block code 缺等宽字体栈：${rule}`);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
