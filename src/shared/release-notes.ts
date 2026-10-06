// src/shared/release-notes.ts
// 更新说明归一化：GitHub 源下 latest.yml 未内嵌 releaseNotes 时，electron-updater 会用
// releases.atom 的 <content type="html">（body 的 HTML 渲染）补齐（GitHubProvider.js :139
// computeReleaseNotes → getNoteValue）——并非 update.ts 早前注释假设的「Markdown 原文」。
// 这里在主进程唯一摄入点（app-updater update-available）归一为可读纯文本；
// 看起来不是 HTML 的字符串一律直通，Markdown 原文不受影响。

/** 是否像 Atom 补链来的 HTML（< 后紧跟字母的已知标签名才认，纯文本 a < b 不误伤）。 */
export function looksLikeHtmlNotes(s: string): boolean {
  return /<(?:h[1-6]|ul|ol|li|p|div|blockquote|table|br|pre|hr|strong|em|code|a)\b/i.test(s);
}

/** 数字实体解码：NaN / 控制字符（<0x20，含 \r 与 NUL）/ DEL(0x7f) / 越界 0x10FFFF+ / 孤立代理（引擎不抛错，显式判）→ 原样保留整段实体。 */
function decodeNumericEntity(n: number, entity: string): string {
  if (Number.isNaN(n) || n < 0x20 || n === 0x7f || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return entity;
  try {
    return String.fromCodePoint(n);
  } catch {
    return entity; // 越界抛错形态兜底
  }
}

/** HTML 渲染结果 → 可读纯文本（标题→井号行、li→- 项、内联标记→**、*、反引号、实体解码）。 */
export function htmlReleaseNotesToText(html: string): string {
  // 1 CRLF 归一
  let s = html.replace(/\r\n?/g, '\n');
  // 2 剥 script/style 整块（防御，正常 notes 不会出现）
  s = s.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  // 3 br/hr → 换行
  s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<hr\s*\/?>/gi, '\n');
  // 4 标题 → 井号行（inner 里若还有内联标签交给后续步骤）
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, lvl: string, inner: string) =>
    '\n' + '#'.repeat(Number(lvl)) + ' ' + inner.trim() + '\n');
  // 5 列表：li → '- ' 项、</li> → 换行
  s = s.replace(/<li[^>]*>/gi, '- ').replace(/<\/li\s*>/gi, '\n');
  // 6 块级闭合 → 换行
  s = s.replace(/<\/(p|div|blockquote|ul|ol|table|tr|pre|h[1-6])\s*>/gi, '\n');
  // 6.5 表格单元格 → 空格竖线分隔：仅当后随另一 th/td 才插入（\s* 跨标签吞源换行，
  //     真实 atom 分行排版亦生效）；行尾不再产生悬挂分隔，步骤 12 无需剥尾。
  //     顺序须保持在步骤 6 之后、步骤 7 之前——6.5 时 <tr> 仍在位保护行边界，跨行不误插。
  s = s.replace(/<\/(th|td)\s*>\s*(?=<(?:th|td)\b)/gi, ' | ');
  // 7 块级开标签：ul/ol → 换行（嵌套列表各行独立；副作用：标题与紧随列表间出一个空行，更利阅读），其余剥除
  s = s.replace(/<(ul|ol)\b[^>]*>/gi, '\n');
  s = s.replace(/<(p|div|blockquote|table|thead|tbody|tr|th|td|pre)\b[^>]*>/gi, '');
  // 8 链接 → text (href)（href 非空且 ≠ text 时；text 先 trim）
  s = s.replace(/<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (_m, href: string, text: string) => {
    const t = text.trim();
    return href && href !== t ? `${t} (${href})` : t;
  });
  // 9 内联成对标记：strong/b → **、em/i → *、code → `
  s = s.replace(/<(?:strong|b)\b[^>]*>/gi, '**').replace(/<\/(?:strong|b)\s*>/gi, '**');
  s = s.replace(/<(?:em|i)\b[^>]*>/gi, '*').replace(/<\/(?:em|i)\s*>/gi, '*');
  s = s.replace(/<code\b[^>]*>/gi, '`').replace(/<\/code\s*>/gi, '`');
  // 10 通用剥残标签（无 href 的 <a>、未知标签都在这里兜底）
  s = s.replace(/<\/?[a-zA-Z][^>]*>/g, '');
  // 11 实体解码（必须在剥标签之后，防 &lt;strong&gt; 解码后复活成标签）
  s = s.replace(/&#[xX]([0-9a-fA-F]+);/g, (m, hex: string) => decodeNumericEntity(Number.parseInt(hex, 16), m));
  s = s.replace(/&#(\d+);/g, (m, dec: string) => decodeNumericEntity(Number.parseInt(dec, 10), m));
  s = s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ');
  // 常用符号/排版实体扩表（review RF5）
  s = s
    .replace(/&copy;/g, '©')
    .replace(/&reg;/g, '®')
    .replace(/&trade;/g, '™')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&hellip;/g, '…')
    .replace(/&ldquo;/g, '“')
    .replace(/&rdquo;/g, '”')
    .replace(/&lsquo;/g, '‘')
    .replace(/&rsquo;/g, '’')
    .replace(/&bull;/g, '•')
    .replace(/&middot;/g, '·');
  s = s.replace(/&amp;/g, '&'); // &amp; 必须最后（防 &amp;gt; 被二次解成 >）
  // 12 行清理：逐行 trimEnd、3+ 连续换行折叠为 \n\n、整体 trim
  return s
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** 归一收口：像 HTML 才转换，否则（Markdown 原文等）直通；空串 → null。 */
function finalize(text: string): string | null {
  const out = (looksLikeHtmlNotes(text) ? htmlReleaseNotesToText(text) : text).trim();
  return out.length > 0 ? out : null;
}

/** electron-updater info.releaseNotes（string | {note}[] | 其他）→ 归一后文本；空→null。
 *  数组分支对应 fullChangelog=true 的形态（本项目未开启、实际不可达，纯防御保留）。 */
export function normalizeReleaseNotes(raw: unknown): string | null {
  if (typeof raw === 'string') return finalize(raw);
  if (Array.isArray(raw)) {
    return finalize(
      raw
        .map((n) => {
          if (typeof n === 'string') return n;
          if (n && typeof n === 'object' && typeof (n as { note?: unknown }).note === 'string') {
            return (n as { note: string }).note;
          }
          return '';
        })
        .join('\n'),
    );
  }
  return null;
}
