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

export function renderMarkdown(text: string): string {
  return md.render(text);
}

export function isDiffContent(text: string): boolean {
  const lines = text.split('\n').slice(0, 12);
  return lines.some((line) => /^(diff --git|--- |\+\+\+ |@@ )/.test(line));
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
