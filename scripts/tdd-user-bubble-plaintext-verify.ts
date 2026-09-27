// tdd-user-bubble-plaintext-verify.ts
// 问题②（2026-09-27 六使用问题）第五轮方案「用户气泡纯文本回显」TDD 验证脚本：
//   L1–L5   行为用例——markdown.ts 回归保真（node 直调项目 renderMarkdown）：rich/static/export
//           三态渲染零变化、防污染迁移、默认 profile 签名回归；
//   C1–C5   MessageBubble.vue 源码契约——renderedContent 收敛二态、user 内容元素纯文本插值
//           （无 v-html/v-enrich/markdown-body）、assistant 分支回归钉、pre-wrap CSS、p+p 死规则删除；
//   C6–C8   markdown.ts 源码契约——MarkdownProfile 还原三态、user/user-export 字面零残留、
//           breaks 临时切换零残留。
// 事实（第五轮定案）：数据层无损（发送链仅剥首尾空白、内部 \n 逐字保留、引擎 transcript 原样）；
// 不一致全在显示层——CommonMark 把 ≥2 连续空行折叠成一个段距，且用户消息中的 markdown 语法
// （粗体/行内 code/围栏/图片）被渲染成样式，均与输入字面不符。修法：user 气泡（含导出态）不再走
// markdown 渲染，纯文本插值（自动 HTML 转义防 XSS）+ white-space: pre-wrap 逐字回显——
// 气泡显示文本 === 实际发送文本 === 落库文本。assistant/思考/工具/流式渲染保持 markdown 不变。
// 本脚本取代 tdd-user-bubble-breaks-verify.ts（第四轮 breaks:true markdown 方案，已废弃删除）。
// 运行：npx tsx scripts/tdd-user-bubble-plaintext-verify.ts（已登记 scripts/selftest-static-list.txt）
import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderMarkdown } from '../src/renderer/utils/markdown';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

console.log('\n=== L1–L5 · markdown.ts 回归保真（node 实测） ===');

check('L1 rich：单 \\n 不产 <br>（行为零变化）', () => {
  const html = renderMarkdown('第一行\n第二行', 'rich');
  assert.ok(!html.includes('<br>'), `rich 单换行不应产 <br>：${html}`);
  const htmlDefault = renderMarkdown('第一行\n第二行');
  assert.ok(!htmlDefault.includes('<br>'), '默认 profile 行为应与 rich 一致');
});
check('L2 static/export：单 \\n 不产 <br>（行为零变化）', () => {
  assert.ok(!renderMarkdown('第一行\n第二行', 'static').includes('<br>'), 'static 不应产 <br>');
  assert.ok(!renderMarkdown('第一行\n第二行', 'export').includes('<br>'), 'export 不应产 <br>');
});
check('L3 rich：围栏仍 code-block 容器；行内 code/KaTeX 正常（抽查）', () => {
  const fenced = renderMarkdown('```js\nlet x = 1\n```', 'rich');
  assert.ok(fenced.includes('class="code-block"'), `rich 围栏未走统一容器：${fenced.slice(0, 160)}`);
  const inline = renderMarkdown('用 `x` 命令', 'rich');
  assert.ok(inline.includes('<code>'), `rich 行内 code 失效：${inline}`);
  const katex = renderMarkdown('公式 $E=mc^2$ 在文中', 'rich');
  assert.ok(katex.includes('katex'), `rich KaTeX 失效：${katex.slice(0, 200)}`);
});
check('L4 防污染迁移：连续多 profile 调用后 rich 输出稳定', () => {
  renderMarkdown('a\nb', 'export');
  renderMarkdown('c\nd', 'static');
  const after = renderMarkdown('e\nf', 'rich');
  assert.ok(!after.includes('<br>'), '多 profile 连续调用后 rich 产出 <br>（渲染器状态被污染）');
});
check('L5 renderMarkdown 签名与默认 profile 回归（默认=rich）', () => {
  assert.equal(typeof renderMarkdown, 'function', 'renderMarkdown 导出缺失');
  const def = renderMarkdown('a\nb');
  const rich = renderMarkdown('a\nb', 'rich');
  assert.equal(def, rich, '默认 profile 输出应与 rich 完全一致');
});

// ── C1–C5 · MessageBubble.vue 源码契约 ──

const bubbleSrc = readFileSync(join(__dirname, '../src/renderer/components/chat/MessageBubble.vue'), 'utf8');

console.log('\n=== C1–C5 · MessageBubble.vue 源码契约 ===');

check('C1 renderedContent 收敛二态：exportMode ? export : rich，不再按 role 分流、无 user profile 字面', () => {
  // 块提取对单行/多行形态皆稳健：从 computed( 起切到下一个 const hasContent 为止。
  const start = bubbleSrc.indexOf('const renderedContent = computed(');
  assert.ok(start >= 0, 'renderedContent 计算属性未找到');
  const end = bubbleSrc.indexOf('const hasContent', start);
  const block = end > start ? bubbleSrc.slice(start, end) : '';
  assert.ok(block, 'renderedContent 块提取失败');
  assert.ok(
    block.includes("props.exportMode ? 'export' : 'rich'"),
    'renderedContent 未收敛为二态字面 props.exportMode ? \'export\' : \'rich\'',
  );
  assert.ok(!block.includes("'user'"), 'renderedContent 仍含 user profile 字面（第五轮应删除）');
  assert.ok(!block.includes('props.message.role'), 'renderedContent 不应再按 message.role 分流（user 气泡不走 markdown）');
});

check('C2 user 内容元素为纯文本插值（{{ message.content }}），开标签无 v-html/v-enrich/markdown-body', () => {
  const el = bubbleSrc.match(/<div\b[^>]*>\s*\{\{ message\.content \}\}\s*<\/div>/)?.[0] ?? '';
  assert.ok(el, '模板缺 user 纯文本内容元素（{{ message.content }} 插值）');
  const openTag = el.match(/^<[^>]+>/)?.[0] ?? '';
  assert.ok(openTag.includes("message.role === 'user'"), 'user 内容元素未按 message.role === \'user\' 分支');
  assert.ok(!openTag.includes('v-html'), 'user 内容元素不得 v-html（纯文本插值自动转义防 XSS）');
  assert.ok(!openTag.includes('v-enrich'), 'user 内容元素不得挂 v-enrich（mermaid/灯箱增强仅适用 markdown HTML）');
  assert.ok(!openTag.includes('markdown-body'), 'user 内容元素不得挂 markdown-body（纯文本无子元素，其语义失效）');
});

check('C3 assistant 系 markdown 渲染分支保留（markdown-body + v-html + v-enrich，回归钉）', () => {
  assert.ok(
    /<div\b[^>]*class="bubble__content markdown-body"[^>]*v-html="renderedContent"[^>]*v-enrich/.test(bubbleSrc),
    'assistant 系 markdown 渲染分支缺失（markdown-body + v-html="renderedContent" + v-enrich 应原样保留）',
  );
});

check('C4 user 气泡 pre-wrap：.bubble--user .bubble__content 规则含 white-space: pre-wrap', () => {
  assert.ok(
    /\.bubble--user \.bubble__content\s*\{[^}]*white-space:\s*pre-wrap;/.test(bubbleSrc),
    '缺 .bubble--user .bubble__content { white-space: pre-wrap } 规则（纯文本逐字回显）',
  );
});

check('C5 p+p 段距死规则已删（.bubble--user .bubble__content :deep(p + p) 全文不存在）', () => {
  assert.ok(
    !bubbleSrc.includes('.bubble--user .bubble__content :deep(p + p)'),
    '.bubble--user p+p 段距规则应已删除（纯文本无 <p>，成死代码）',
  );
});

// ── C6–C8 · markdown.ts 源码契约 ──

const markdownSrc = readFileSync(join(__dirname, '../src/renderer/utils/markdown.ts'), 'utf8');

console.log('\n=== C6–C8 · markdown.ts 源码契约 ===');

check('C6 MarkdownProfile 还原三态：\'rich\' | \'static\' | \'export\'', () => {
  assert.ok(
    markdownSrc.includes("export type MarkdownProfile = 'rich' | 'static' | 'export';"),
    "MarkdownProfile 联合类型应还原为 'rich' | 'static' | 'export'（单行原文）",
  );
});

check("C7 markdown.ts 无 'user-export'/'user' profile 字面残留（renderMarkdown 无 role/user 分支）", () => {
  assert.ok(!markdownSrc.includes("'user-export'"), "markdown.ts 仍残留 'user-export' 字面");
  assert.ok(!markdownSrc.includes("'user'"), "markdown.ts 仍残留 'user' 字面（user profile 分支应整体删除）");
  assert.ok(!markdownSrc.includes("profile === 'user"), "markdown.ts 仍残留 profile === 'user…' 分支判定");
});

check('C8 markdown.ts 无 breaks 临时切换残留（md.options.breaks 字面不存在）', () => {
  assert.ok(!markdownSrc.includes('md.options.breaks'), 'markdown.ts 仍残留 md.options.breaks（breaks 临时切换应删除）');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
