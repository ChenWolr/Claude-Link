// tdd-release-notes-md-verify.ts
// 更新说明渲染预览（2026-10-10 计划）TDD 契约脚本——渲染层 release-notes-md 双层管道
//（markdown-it { html:false, linkify:false, breaks:true } 渲染 + sanitize-html 消毒并给
//  <a> 加 target="_blank" rel="noopener noreferrer"）的纯函数行为断言：
//   P1 渲染形态：井号标题→h2 / - 列表→li / **粗**→strong / `码`→code / [文](href)→受限 a；
//   P2 消毒：script/img/onerror/javascript: 注入元素与危险属性零残留（markdown-it 会把
//          javascript: scheme 链接回退为字面文本 `[x](javascript:alert(1))`——那是展示
//          文本不是 href 属性，消毒断言锚「无 javascript: 的 href 属性」而非全文字符串）；
//   P3 空/空白输入 → ''（渲染组件回退路径依据）；
//   P4 归一输出端到端：模拟真实 atom 归一产物（链接 [text](href) 新形态 + [图片：…] 占位）
//          全量渲染，md 链接符号零残留。
// 运行：npx tsx scripts/tdd-release-notes-md-verify.ts（已登记 scripts/selftest-static-list.txt）
// RED 约定（同 tdd-release-notes-verify.ts §5.7）：经受保护加载——
// src/renderer/utils/release-notes-md 尚不存在（实现未落）时各项 fail（fail>0、exit 1）
// 而非顶层 crash。
import { strict as assert } from 'node:assert';

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✅ ${name}`); }
  catch (e) { fail++; console.log(`  ❌ ${name} — ${(e as Error).message}`); }
}

type ReleaseNotesMdModule = typeof import('../src/renderer/utils/release-notes-md');
let rnm: ReleaseNotesMdModule | null = null;
try {
  // 受保护加载：模块尚不存在（RED 阶段）时置 null，逐项 fail 而非顶层 crash。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  rnm = require('../src/renderer/utils/release-notes-md') as ReleaseNotesMdModule;
} catch {
  rnm = null;
}
function rnm_(): ReleaseNotesMdModule {
  assert.ok(rnm, 'src/renderer/utils/release-notes-md 未加载（模块缺失或导出不全）');
  return rnm;
}
/** 契约入口：renderReleaseNotesToHtml(src: string): string——双层管道唯一出口。 */
function render(src: string): string {
  return rnm_().renderReleaseNotesToHtml(src);
}

console.log('\n=== P1) 渲染形态：md 结构 → 受限 HTML ===');
check('P1 h2/li/strong/code/a 全渲染；a 带 target="_blank" rel="noopener noreferrer"（href 属性在前）', () => {
  const out = render('## 标题\n\n- **粗** 与 `码`\n- b\n\n[文](https://example.com/x)');
  assert.ok(out.includes('<h2>标题</h2>'), `h2 未渲染: ${JSON.stringify(out)}`);
  assert.ok(out.includes('<li>'), `li 未渲染: ${JSON.stringify(out)}`);
  assert.ok(out.includes('<strong>粗</strong>'), `strong 未渲染: ${JSON.stringify(out)}`);
  assert.ok(out.includes('<code>码</code>'), `code 未渲染: ${JSON.stringify(out)}`);
  assert.ok(
    out.includes('<a href="https://example.com/x" target="_blank" rel="noopener noreferrer">文</a>'),
    `链接形态漂移: ${JSON.stringify(out)}`,
  );
});

console.log('\n=== P2) 消毒：script/img/onerror/javascript: 零残留 ===');
check('P2 script/img 注入剥除、无 onerror 属性、无 javascript: href 属性、a 的 href 仅 http/https（本输入不应出现任何 a）', () => {
  const out = render('前 <script>alert(1)</script> 后\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))');
  assert.ok(!out.includes('<script'), `script 元素残留: ${JSON.stringify(out)}`);
  assert.ok(!out.includes('<img'), `img 元素残留: ${JSON.stringify(out)}`);
  // markdown-it（html:false）把内嵌 HTML 转义为展示文本（&lt;img …&gt;），onerror= 会以
  // 文本形式存活——消毒锚定「无携带 onerror 属性的元素」而非全文字符串。
  assert.ok(!/<[a-z][^>]*\bonerror\s*=/i.test(out), `onerror 属性残留: ${JSON.stringify(out)}`);
  // markdown-it 拒绝 javascript: scheme 后回退为字面文本 [x](javascript:alert(1))——可接受的
  // 展示文本；消毒锚定「不存在 javascript: 的 href 属性」而非全文字符串。
  assert.ok(!/href\s*=\s*["']?\s*javascript:/i.test(out), `javascript: href 属性残留: ${JSON.stringify(out)}`);
  // <a> 若出现则 href 只能是 http/https；本输入下不应出现任何 a 元素。
  const anchors = out.match(/<a\b[^>]*>/gi) ?? [];
  for (const a of anchors) {
    const href = a.match(/href\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    assert.ok(/^https?:\/\//i.test(href), `a 元素 href 非 http/https: ${JSON.stringify(a)}`);
  }
  assert.ok(anchors.length === 0, `本输入不应渲染任何 a 元素（js scheme 被拒应回退为字面文本）: ${JSON.stringify(anchors)}`);
});

console.log('\n=== P2b) 非 http(s) 链接降级纯文本（mailto/相对路径，review P3-1/2） ===');
check('P2b [x](mailto:a@b.c) 与 [x](/rel/path) 产物均无 <a 元素（降级 span，连锚元素都不剩、内文保留）', () => {
  for (const src of ['[x](mailto:a@b.c)', '[x](/rel/path)']) {
    const out = render(src);
    assert.ok(!/<a[\s>]/i.test(out), `非 http(s) 链接未降级为纯文本（${src}）: ${JSON.stringify(out)}`);
    assert.ok(out.includes('x'), `降级后内文丢失（${src}）: ${JSON.stringify(out)}`);
  }
});

console.log('\n=== P3) 空/空白输入 → 空串（组件回退路径依据） ===');
check("P3 '' 与 '   \\n  \\n' 均输出 ''", () => {
  assert.equal(render(''), '');
  assert.equal(render('   \n  \n'), '');
});

console.log('\n=== P4) 归一输出端到端：真实 atom 归一产物全量渲染 ===');
check('P4 链接 [text](href) 新形态渲染为可点 a（_blank）、<strong> 在位、md 链接符号 ]( 零残留', () => {
  // 模拟 normalizeReleaseNotes 归一产物：井号标题 / - 列表 / **粗** / 链接 [text](href)
  //（渲染预览改造后的新链接形态）/ [图片：…] 占位文本。
  const normalized =
    '## 新增\n\n' +
    '- **上下文窗口按供应商模型配置**：DPR>1 缩放修正\n' +
    '- [Full Changelog](https://github.com/ChenWolr/Claude-Link/compare/v0.4.2...v0.4.3)\n\n' +
    '[图片：截图]\n';
  const out = render(normalized);
  assert.ok(
    out.includes('<a href="https://github.com/ChenWolr/Claude-Link/compare/v0.4.2...v0.4.3"'),
    `Changelog 链接未渲染为 a: ${JSON.stringify(out)}`,
  );
  assert.ok(out.includes('target="_blank"'), `链接未强制 _blank: ${JSON.stringify(out)}`);
  assert.ok(out.includes('<strong>'), `strong 未渲染: ${JSON.stringify(out)}`);
  assert.ok(!out.includes(']('), `md 链接符号残留: ${JSON.stringify(out)}`);
});

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
