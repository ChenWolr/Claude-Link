// src/renderer/utils/release-notes-md.ts
// 更新说明渲染管道（2026-10-10 计划）：markdown-it 渲染 → sanitize-html 白名单消毒，双层独立可测。
// 对齐 ZCode/LobsterAI 的 marked+DOMPurify 管道（功能等价，选型差异见计划）。
// html:false——markdown 内嵌原始 HTML 转义输出；sanitize-html 为第二层防御。
// 不加载远程图片：allowedTags 无 img（归一层的 [图片：alt] 占位按普通文本渲染）。
import MarkdownIt from 'markdown-it';
import sanitizeHtml from 'sanitize-html';

const md = new MarkdownIt({ html: false, linkify: false, breaks: true });

/** 更新说明 markdown → 消毒后 HTML（a 强制 target=_blank rel=noopener noreferrer；仅 http/https）。 */
export function renderReleaseNotesToHtml(src: string): string {
  const raw = md.render(src ?? '');
  return sanitizeHtml(raw, {
    allowedTags: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'ul', 'ol', 'li', 'strong', 'em', 'del', 'code', 'pre', 'blockquote', 'a', 'span', 'br', 'hr'],
    allowedAttributes: { a: ['href', 'target', 'rel'] },
    allowedSchemes: ['http', 'https'],
    transformTags: {
      // 仅 http(s) 外链保持 <a>（强制新窗 + noopener）。allowedSchemes 只剥 scheme 不剥 <a>——
      // mailto: 会留下「带链接样式的死链」、无 scheme 的相对路径会新窗打开应用内路径
      // （review P3-1/2），在 transform 层一并堵死：非 http(s) 一律降级 <span> 纯文本，内文保留。
      a: (_tagName, attribs) =>
        attribs.href && /^https?:\/\//i.test(attribs.href)
          ? { tagName: 'a', attribs: { ...attribs, target: '_blank', rel: 'noopener noreferrer' } }
          : { tagName: 'span', attribs: {} },
    },
  });
}
