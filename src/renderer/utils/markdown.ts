import MarkdownIt, { type Token } from 'markdown-it';
import hljs from 'highlight.js';
import { html as diff2htmlHtml } from 'diff2html';
import taskLists from 'markdown-it-task-lists';
import markdownItKatex from '@traptitech/markdown-it-katex';
import { isAllowedMarkdownImageUrl } from '../../shared/external-links';

export type MarkdownProfile = 'rich' | 'static' | 'export';

type MarkdownEnv = { profile?: MarkdownProfile };

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
});
// 任务列表：把 - [ ] / - [x] 渲染成只读勾选框（disabled，仅展示，不可交互勾选）。
md.use(taskLists);
// 数学公式：$...$ 行内 / $$...$$ 块级经 KaTeX 渲染（CSS 与字体在 main.ts 引入）。
md.use(markdownItKatex);
// 修正 @traptitech/markdown-it-katex 的 math_block：原实现遇到行首 $$ 即使未找到闭合 $$，
// 仍会把到消息结尾的整段正文吞成一个 math_block（KaTeX 乱码 + 控制台 unicodeTextInMathMode 警告）。
// 这里覆盖为：未找到闭合 $$ 时 return false，让该行按普通段落渲染（$$ 成为字面文本），保留合法 $$...$$。
md.block.ruler.at('math_block', (state, start, end, silent) => {
  const startPos = state.bMarks[start] + state.tShift[start];
  const startMax = state.eMarks[start];
  if (startPos + 2 > startMax) return false;
  if (state.src.slice(startPos, startPos + 2) !== '$$') return false;

  let pos = startPos + 2;
  let firstLine = state.src.slice(pos, startMax);
  let lastLine = '';
  let found = false;

  if (silent) return true;
  if (firstLine.trim().slice(-2) === '$$') {
    firstLine = firstLine.trim().slice(0, -2);
    found = true;
  }

  let next = start;
  while (!found) {
    next++;
    if (next >= end) break;
    const linePos = state.bMarks[next] + state.tShift[next];
    const lineMax = state.eMarks[next];
    if (linePos < lineMax && state.tShift[next] < state.blkIndent) break;
    if (state.src.slice(linePos, lineMax).trim().slice(-2) === '$$') {
      const lastPos = state.src.slice(0, lineMax).lastIndexOf('$$');
      lastLine = state.src.slice(linePos, lastPos);
      found = true;
    }
  }

  // 关键修正：未找到闭合 $$，回退普通文本，绝不吞正文。
  if (!found) return false;

  state.line = next + 1;
  const token = state.push('math_block', 'math', 0);
  token.block = true;
  token.content = (firstLine && firstLine.trim() ? firstLine + '\n' : '')
    + state.getLines(start + 1, next, state.tShift[start], true)
    + (lastLine && lastLine.trim() ? lastLine : '');
  token.map = [start, state.line];
  token.markup = '$$';
  return true;
}, { alt: ['paragraph', 'reference', 'blockquote', 'list'] });
applyExternalLinkTarget(md);

export function createPreviewMarkdownRenderer(): MarkdownIt {
  const previewMarkdown = new MarkdownIt({
    html: false,
    linkify: true,
    breaks: true,
    highlight(code, language) {
      const lang = language && hljs.getLanguage(language) ? language : 'plaintext';
      return hljs.highlight(code, { language: lang }).value;
    },
  });
  applyImageProtocolFilter(previewMarkdown);
  applyExternalLinkTarget(previewMarkdown);
  return previewMarkdown;
}

// 代码围栏由一个 renderer 统一决定最终 DOM，避免 markdown-it 再包一层 <pre><code>。
md.renderer.rules.fence = (tokens, idx, options, env) => {
  const token = tokens[idx];
  const language = token.info.trim().split(/\s+/)[0].toLowerCase();
  const code = token.content;
  const profile = (env as MarkdownEnv | undefined)?.profile ?? 'rich';

  if (language === 'diff' || language === 'patch') {
    return renderDiffBlock(code, language || 'diff');
  }
  if (language === 'mermaid' && profile !== 'static') {
    // rich 与 export 都渲染 Mermaid；仅 static 把它当代码块。
    return renderMermaidBlock(code);
  }

  const normalizedLanguage = language && hljs.getLanguage(language) ? language : 'plaintext';
  const highlighted =
    normalizedLanguage === 'plaintext'
      ? escapeHtml(code)
      : hljs.highlight(code, { language: normalizedLanguage }).value;
  return wrapCodeBlock(highlighted, normalizedLanguage, code);
};

// 4 空格缩进代码块走 code_block 规则（markdown-it 默认输出裸 <pre><code>），统一复用 .code-block 容器。
md.renderer.rules.code_block = (tokens, idx) => {
  const code = tokens[idx].content;
  return wrapCodeBlock(escapeHtml(code), 'plaintext', code);
};

// 判断当前 image token 是否位于 link_open/link_close 之间：反向扫描同段 inline children，depth 计数
// 处理「同段已闭合链接后的图片」与嵌套链接。
function isImageInsideLink(tokens: Token[], idx: number): boolean {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const t = tokens[i];
    if (t.type === 'link_close') depth++;
    else if (t.type === 'link_open') {
      if (depth === 0) return true;
      depth--;
    }
  }
  return false;
}

export function applyImageProtocolFilter(instance: MarkdownIt): void {
  const defaultImageRule = instance.renderer.rules.image;
  instance.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    if (!isAllowedMarkdownImageUrl(token.attrGet('src') ?? '')) {
      return escapeHtml(token.content || token.attrGet('src') || '');
    }
    return defaultImageRule
      ? defaultImageRule(tokens, idx, options, env, self)
      : self.renderToken(tokens, idx, options);
  };
}

applyImageProtocolFilter(md);
// 图片：md-img 钩子（供灯箱点击放大）+ 懒加载。
const defaultImageRule = md.renderer.rules.image;
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  const profile = (env as MarkdownEnv | undefined)?.profile ?? 'rich';
  // 链接内图片不加 md-img：避免 <a> 内嵌按钮化（role=button）+ 点击 preventDefault 劫持链接导航。
  // export profile 不加 md-img（导出窗口无灯箱），并 eager 加载保证捕获前就绪。
  if (profile === 'rich' && !isImageInsideLink(tokens, idx)) token.attrSet('class', 'md-img');
  token.attrSet('loading', profile === 'export' ? 'eager' : 'lazy');
  return defaultImageRule
    ? defaultImageRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

export function applyExternalLinkTarget(instance: MarkdownIt): void {
  const defaultLinkOpen = instance.renderer.rules.link_open;

  instance.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    // 仅对 http(s) 网页链接加 target=_blank：这些才会走 setWindowOpenHandler → 系统浏览器。
    // 页内锚点(#)、mailto/tel、相对路径不加，避免锚点被静默 deny、协议链接走 window.open。
    if (token.attrIndex('target') < 0 && /^https?:/i.test(token.attrGet('href') ?? '')) {
      token.attrSet('target', '_blank');
    }

    const relValues = new Set((token.attrGet('rel') ?? '').split(/\s+/).filter(Boolean));
    relValues.add('noopener');
    relValues.add('noreferrer');
    token.attrSet('rel', Array.from(relValues).join(' '));

    return defaultLinkOpen
      ? defaultLinkOpen(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
}

export function renderMarkdown(text: string, profile: MarkdownProfile = 'rich'): string {
  return md.render(text, { profile } satisfies MarkdownEnv);
}

export function isDiffContent(text: string): boolean {
  if (!text) return false;
  const lines = text.split('\n');
  if (lines.some((line) => line.startsWith('diff --git '))) return true;
  let hasOldHeader = false;
  let hasNewHeader = false;
  let hasHunk = false;
  for (const line of lines) {
    if (line.startsWith('--- ') && line.slice(4).trim()) hasOldHeader = true;
    if (line.startsWith('+++ ') && line.slice(4).trim()) hasNewHeader = true;
    if (/^@@\s+[-+\d, ]+@@/.test(line)) hasHunk = true;
  }
  return hasOldHeader && hasNewHeader && hasHunk;
}

export type DiffHtmlRenderer = typeof diff2htmlHtml;

export function renderDiffHtmlWithRenderer(
  diffText: string,
  renderer: DiffHtmlRenderer,
  options?: { matching?: 'none' | 'lines'; sideBySide?: boolean },
): string {
  try {
    const rendered = renderer(diffText, {
      drawFileList: false,
      outputFormat: options?.sideBySide ? 'side-by-side' : 'line-by-line',
      matching: options?.matching ?? 'none',
    });
    return rendered.includes('d2h-file-wrapper')
      ? rendered
      : `<pre><code>${escapeHtml(diffText)}</code></pre>`;
  } catch {
    return `<pre><code>${escapeHtml(diffText)}</code></pre>`;
  }
}

export function renderDiffHtml(diffText: string, options?: { matching?: 'none' | 'lines' }): string {
  return renderDiffHtmlWithRenderer(diffText, diff2htmlHtml, options);
}

function renderDiffBlock(code: string, language: string): string {
  return [
    '<div class="code-block code-block--diff">',
    renderCodeBlockHeader(language, code),
    renderDiffHtml(code),
    '</div>',
  ].join('');
}

// mermaid 占位容器：源码同时放 data-mermaid 属性（供前端读取渲染）与可见文本（渲染前/失败时的回退）。
function renderMermaidBlock(code: string): string {
  return [
    '<div class="mermaid-block">',
    `<div class="mermaid-block__source" data-mermaid="${escapeAttribute(code)}">`,
    escapeHtml(code),
    '</div>',
    '</div>',
  ].join('');
}

function wrapCodeBlock(highlightedCode: string, language: string, rawCode: string): string {
  return [
    '<div class="code-block">',
    renderCodeBlockHeader(language, rawCode),
    `<pre><code class="hljs language-${escapeAttribute(language)}">${highlightedCode}</code></pre>`,
    '</div>',
  ].join('');
}

function renderCodeBlockHeader(language: string, rawCode: string): string {
  return [
    '<div class="code-block__header">',
    `<span class="code-block__lang">${escapeHtml(language || 'text')}</span>`,
    `<button class="code-block__copy" data-code="${escapeAttribute(rawCode)}" type="button">复制</button>`,
    '</div>',
  ].join('');
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttribute(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\n/g, '&#10;');
}
