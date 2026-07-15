import MarkdownIt from 'markdown-it';
import hljs from 'highlight.js';
import { html as diff2htmlHtml } from 'diff2html';

const md = new MarkdownIt({
  html: false,
  linkify: true,
  typographer: false,
  highlight(code: string, language: string): string {
    if (language === 'diff' || language === 'patch') {
      return renderDiffBlock(code, language || 'diff');
    }

    const normalizedLanguage = language && hljs.getLanguage(language) ? language : 'plaintext';
    const highlighted =
      normalizedLanguage === 'plaintext'
        ? escapeHtml(code)
        : hljs.highlight(code, { language: normalizedLanguage }).value;

    return wrapCodeBlock(highlighted, normalizedLanguage, code);
  },
});
applyExternalLinkTarget(md);

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

export function renderMarkdown(text: string): string {
  return md.render(text);
}

export function isDiffContent(text: string): boolean {
  if (!text) return false;

  // 不再只看前 12 行：说明文本可能在 diff 之前，超出窗口就会漏判。
  // 全文扫描结构标记，要求出现 diff --git 文件头，或至少 2 个结构标记，
  // 既覆盖“前文 + diff”的场景，又避免普通文本误判。
  const marker = /^(diff --git |--- |\+\+\+ |@@ )/;
  let hasFileHeader = false;
  let markers = 0;

  for (const line of text.split('\n')) {
    if (!marker.test(line)) continue;
    if (line.startsWith('diff --git ')) hasFileHeader = true;
    markers += 1;
    if (hasFileHeader || markers >= 2) return true;
  }

  return false;
}

export function renderDiffHtml(diffText: string): string {
  try {
    return diff2htmlHtml(diffText, {
      drawFileList: false,
      outputFormat: 'line-by-line',
      matching: 'none',
    });
  } catch {
    return `<pre><code>${escapeHtml(diffText)}</code></pre>`;
  }
}

function renderDiffBlock(code: string, language: string): string {
  return [
    '<div class="code-block code-block--diff">',
    renderCodeBlockHeader(language, code),
    `<div class="d2h-wrapper">${renderDiffHtml(code)}</div>`,
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
