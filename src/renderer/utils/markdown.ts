import MarkdownIt from 'markdown-it';
import type Token from 'markdown-it/lib/token.mjs';
import hljs from 'highlight.js';
import { html as diff2htmlHtml } from 'diff2html';
import taskLists from 'markdown-it-task-lists';
import markdownItKatex from '@traptitech/markdown-it-katex';
import { isAllowedMarkdownImageUrl } from '../../shared/external-links';
import { resolveFileLinkHref, resolveCodeInlinePath, isPathLikeRelativeHref } from './file-link';

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

// fix-2 F3：markdown-it 默认 validateLink 硬拦 file:（lib/index.mjs BAD_PROTO_RE 含 file），
// file:/// 文件链接根本不产出 <a>、文件预览链路死路。对 md 单例覆盖 validateLink：复制默认
// 逻辑并去掉 file 拦截——放行理由：命中 resolveFileLinkHref 的文件链接由 link_open 规则接管，
// href 置 javascript:void(0) 不产生导航；未命中时 file:/// 本就是绝对路径链接，点击经
// will-navigate 落到主进程 link-guard（file: 不属 EXTERNAL_PROTOCOLS → block）fail-closed 兜底。
// vbscript/javascript 照拦；data: 仅放行位图（GOOD_DATA_RE），与 markdown-it 默认完全一致。
// 仅覆盖 md 单例：createPreviewMarkdownRenderer 不动（预览渲染无文件链接按钮化需求）。
const FIX2_BAD_PROTO_RE = /^(vbscript|javascript|data):/;
const FIX2_GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/;
md.validateLink = (url: string): boolean => {
  const str = url.trim().toLowerCase();
  return FIX2_BAD_PROTO_RE.test(str) ? FIX2_GOOD_DATA_RE.test(str) : true;
};

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
md.renderer.rules.fence = (tokens, idx, _options, env) => {
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

// 缩进代码块（CommonMark 'code' 规则）对消息路径关闭（问题③）：空行后 ≥4 空格或 tab 缩进行
//（Java 堆栈 "\tat ..." 最常见）会被误判成等宽代码块，用户回显观感突兀。关闭后缩进行按普通
// 段落渲染；``` 围栏（fence）与行内 `code`（backticks）规则不受影响。预览渲染器
//（createPreviewMarkdownRenderer）保留缩进代码块行为。下方 code_block renderer 规则保留：
// 仅当该规则被重新启用时兜底统一容器，正常消息路径不再触达。
md.disable('code');
// 缩进代码块的 code_block 规则（markdown-it 默认输出裸 <pre><code>）：消息路径已被上方
// md.disable('code') 关闭、不再触达；规则仅预览/兜底适用——重新启用时统一复用 .code-block 容器。
md.renderer.rules.code_block = (tokens, idx) => {
  const code = tokens[idx].content;
  return wrapCodeBlock(escapeHtml(code), 'plaintext', code);
};

// 判断当前 inline token（image / code_inline）是否位于 link_open/link_close 之间：反向扫描同段
// inline children，depth 计数处理「同段已闭合链接后的元素」与嵌套链接。image 的 md-img 判定与
// code_inline 的 A2 反引号路径链接化共用本助手——链接内跳过链接化，防 <a> 嵌套 <a>。
function inLinkContext(tokens: Token[], idx: number): boolean {
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
  if (profile === 'rich' && !inLinkContext(tokens, idx)) token.attrSet('class', 'md-img');
  token.attrSet('loading', profile === 'export' ? 'eager' : 'lazy');
  return defaultImageRule
    ? defaultImageRule(tokens, idx, options, env, self)
    : self.renderToken(tokens, idx, options);
};

// 文件链接（p3/W2）：markdown 正文中的文件链接（相对/绝对/file:///）经 resolveFileLinkHref
// 解析出绝对路径后按钮化（.md-file-link + data-clip-path，href 置 javascript:void(0)）；P6-B 起
// 左键零动作，交互入口唯一化为右键——委托由 MessageBubble.vue 的 onContentContextMenu 接
// useFileLinkMenuStore 弹右键菜单（2026-11-21 P6-B 契约迁移，同 MOD-P6-1 族；原 onContentClick
// 直开抽屉链路已废弃）。
// fileLinkWorkspaceRoot 用模块级单例而非 env 传参：比计划原案的 env 更单点——活动会话唯一
// 渲染源、renderMarkdown 无需逐调用方传根；未调用 setFileLinkWorkspaceRoot 的窗口实例
// （导出窗等）保持 null，相对链接解析天然返回 null、不可点。
let fileLinkWorkspaceRoot: string | null = null;
export function setFileLinkWorkspaceRoot(root: string | null | undefined): void {
  fileLinkWorkspaceRoot = root ?? null;
}
// 只读 getter（round-002 fix-3 F5）：供抽屉预检按根状态分述相对路径错误文案（零行为变更）。
export function getFileLinkWorkspaceRoot(): string | null {
  return fileLinkWorkspaceRoot;
}

// 必须在 applyExternalLinkTarget(md)（顶部已调用，target=_blank 逻辑已挂上）与既有 image rule
// 定制之后捕获 link_open：fileLinkBaseRule 已含外链 target 逻辑。未命中文件链接时透传基础规则
//（B15：http 外链照旧 target=_blank；fence/代码块不走 inline renderer，B14 天然无影响）。
const fileLinkBaseRule = md.renderer.rules.link_open;
md.renderer.rules.link_open = (tokens, idx, options, env, renderer) => {
  const href = tokens[idx].attrGet('href') ?? '';
  const resolved = resolveFileLinkHref(href, fileLinkWorkspaceRoot);
  if (!resolved) {
    // A4（2026-11-06 file linkify 计划）：唯一静默死链 = 「相对路径 + 未设工作区根」——
    // resolveFileLinkHref 相对分支因无根返回 null，基线 <a> 保留相对 href、点击被导航守卫
    // 静默吞。此处改判死链形态：class md-file-link--dead + data-clip-path 存解码去尾 #?
    // 片段的原始相对路径 + href 置 javascript:void(0)，点击经既有委托（closest('.md-file-link')
    // 读 data-clip-path）开抽屉出「未设置工作区根」错误卡，不再静默。root 存在但解析失败
    // （含 '..'/非法 scheme——isPathLikeRelativeHref 拒绝）保持基线 <a> 原样；解码失败
    //（如 %E4%B8 不完整 UTF-8 转义）同样回退基线，不进死链通道。attrSet 值由 renderToken
    // →renderAttrs 统一 escapeHtml（同下方 fix-2 F2 注），此处不重复包 escapeAttribute。
    // 编码态 '..'（如 %2e%2e）按词面相对形态进死链通道、clip 解码还原——设计决定：可见反馈优先于通道字面分类（2026-11-06 审查裁定），真实 '..' 词面仍被 isPathLikeRelativeHref 拒绝。
    if (!fileLinkWorkspaceRoot?.trim() && isPathLikeRelativeHref(href)) {
      try {
        const clip = decodeURIComponent(href.trim()).replace(/[#?].*$/, '');
        if (clip) {
          tokens[idx].attrSet('class', 'md-file-link md-file-link--dead');
          tokens[idx].attrSet('data-clip-path', clip);
          tokens[idx].attrSet('href', 'javascript:void(0)');
        }
      } catch {
        // 解码失败：保持基线 <a>（与本分支改造前的回退输出逐字节一致）。
      }
    }
    return fileLinkBaseRule
      ? fileLinkBaseRule(tokens, idx, options, env, renderer)
      : renderer.renderToken(tokens, idx, options);
  }
  tokens[idx].attrSet('class', 'md-file-link');
  // fix-2 F2：不再包 escapeAttribute——markdown-it renderToken→renderAttrs 对属性值已做
  // escapeHtml（& < > "），此处再包一层会把 & 渲染成 &amp;amp;（双重转义，DOM 取值得到
  // a&amp;b 而非 a&b）。其余 escapeAttribute 调用点（mermaid/code-block 等）不动。
  tokens[idx].attrSet('data-clip-path', resolved.path);
  tokens[idx].attrSet('href', 'javascript:void(0)');
  return fileLinkBaseRule
    ? fileLinkBaseRule(tokens, idx, options, env, renderer)
    : renderer.renderToken(tokens, idx, options);
};

// A2（2026-11-06 文件点击打开链路计划）：反引号 code_inline 内的路径形态 → 文件链接，与
// link_open 按钮化完全同形（class="md-file-link" + data-clip-path + href=javascript:void(0)），
// 6 处既有点击委托组件零改动自动接入；可见文本保留路径原文且 <code> 包裹保留。命中判定见
// file-link.ts resolveCodeInlinePath（内容是模型原文态，skip 百分号解码）。链接内 code_inline
// 跳过（inLinkContext 与 image 共用同段反向扫描）防 <a> 嵌套；未命中回退基线规则（捕获于覆盖
// 之前，未命中路径输出与改造前逐字节一致）。fence/code_block/缩进代码块不走 inline renderer
// 天然不链接化；流式未闭合反引号整段落为 text token 同样安全；export profile 与 rich 同一
// 覆盖同形输出（无分叉）。
const codeInlineBaseRule = md.renderer.rules.code_inline;
md.renderer.rules.code_inline = (tokens, idx, options, env, renderer) => {
  const content = tokens[idx].content;
  const resolved = inLinkContext(tokens, idx)
    ? null
    : resolveCodeInlinePath(content, fileLinkWorkspaceRoot);
  if (!resolved) {
    return codeInlineBaseRule
      ? codeInlineBaseRule(tokens, idx, options, env, renderer)
      : `<code>${escapeHtml(content)}</code>`;
  }
  return `<a class="md-file-link" href="javascript:void(0)" data-clip-path="${escapeAttribute(resolved.path)}"><code>${escapeHtml(content)}</code></a>`;
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

export function renderDiffHtml(diffText: string, options?: { matching?: 'none' | 'lines'; sideBySide?: boolean }): string {
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
