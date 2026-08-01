// diff-highlight.ts
// diff 弹窗 split 模式的语法高亮 + 字符级 diff 叠加纯函数。
// 无 Vue/DOM 依赖，可被 tsx selftest 直接 import。
//
// 设计取舍：逐行 hljs.highlight（非整文件）。代价是多行语法状态（块注释/模板字面量/三引号字符串）
// 跨行时不保状态——代码 diff 场景绝大多数行独立，视觉够用；若目视发现断裂严重，再升级整段
// highlight+按行拆（见计划 §5 风险 R2）。
//
// 字符级 diff 叠加：hljs 输出 HTML → 解析成 HlToken[]（栈式，取最内层 class）；
// 与 diff-words 的 DiffSeg[] 在字符维度对齐 merge → MergedToken[]（Task 2c）。

import hljs from 'highlight.js';
import type { DiffSeg } from './diff-parser';

export interface HlToken { text: string; cls: string; }
export interface MergedToken { text: string; cls: string; diff: 'eq' | 'del' | 'ins'; }

// 扩展名 → hljs language（hljs.getLanguage 校验有效性）。未知 → plaintext。
const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyw: 'python',
  java: 'java', kt: 'kotlin', scala: 'scala', groovy: 'groovy',
  go: 'go', rs: 'rust', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', rb: 'ruby', php: 'php', swift: 'swift', m: 'objectivec',
  html: 'xml', htm: 'xml', vue: 'xml', svg: 'xml', xml: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  json: 'json', jsonc: 'json', json5: 'json',
  yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini',
  md: 'markdown', markdown: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', shell: 'bash',
  sql: 'sql', dockerfile: 'dockerfile', makefile: 'makefile',
  diff: 'diff', patch: 'diff',
};

export function extToLang(filePath: string): string {
  const base = filePath.split('/').pop() ?? filePath;
  // Dockerfile/Makefile 这类无扩展名特殊文件名
  const lower = base.toLowerCase();
  if (lower === 'dockerfile') return 'dockerfile';
  if (lower === 'makefile' || lower === 'gnumakefile') return 'makefile';
  const dot = base.lastIndexOf('.');
  if (dot < 0) return 'plaintext';
  const ext = base.slice(dot + 1).toLowerCase();
  const lang = EXT_LANG[ext];
  if (lang && hljs.getLanguage(lang)) return lang;
  return 'plaintext';
}

// hljs 输出会把 < > & " ' 转义成 HTML 实体；文本节点须反转义回真实字符，
// 否则 token.text 残留 &lt; 等字面量，渲染显示错误且破坏 mergeTokensWithDiff 的字符对齐。
// 一次正则替换所有实体，顺序无关（避免多次 replace 的链式陷阱）。
const ENTITY_RE = /&(amp|lt|gt|quot|#39|#x27);/g;
function unescapeHtml(s: string): string {
  return s.replace(ENTITY_RE, (m, code: string) => {
    switch (code) {
      case 'amp': return '&';
      case 'lt': return '<';
      case 'gt': return '>';
      case 'quot': return '"';
      case '#39':
      case '#x27': return "'";
      default: return m;
    }
  });
}

// hljs 输出 HTML → HlToken[]。hljs 只用 <span class="hljs-xxx"> 嵌套；栈取最内层 cls。
const SPAN_RE = /<span\s+class="([^"]*)">|<\/span>|[^<]+/g;
// 单行超长（minified/打包产物）直接返回纯文本，避免 hljs 正则在超长行卡顿。
// diff-words 的护栏是 1000；hljs 比 LCS 快，放宽到 2000。
const HIGHLIGHT_MAX_LINE_LENGTH = 2000;
export function highlightLineToTokens(text: string, language: string): HlToken[] {
  if (text.length > HIGHLIGHT_MAX_LINE_LENGTH) return [{ text, cls: '' }];
  const lang = hljs.getLanguage(language) ? language : 'plaintext';
  let html: string;
  try {
    html = hljs.highlight(text, { language: lang }).value;
  } catch {
    return [{ text, cls: '' }];
  }
  const tokens: HlToken[] = [];
  const stack: string[] = [];
  SPAN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = SPAN_RE.exec(html))) {
    const seg = m[0];
    if (seg.startsWith('<span')) {
      stack.push(m[1] ?? '');
    } else if (seg === '</span>') {
      stack.pop();
    } else {
      const cls = stack.length ? stack[stack.length - 1]! : '';
      const unescaped = unescapeHtml(seg);
      const last = tokens[tokens.length - 1];
      if (last && last.cls === cls) last.text += unescaped;
      else tokens.push({ text: unescaped, cls });
    }
  }
  return tokens.length ? tokens : [{ text, cls: '' }];
}

// 字符级 merge：HlToken[] × DiffSeg[]（对该行：eq+del 或 eq+ins，重组回 text）→ MergedToken[]。
// 两者都覆盖 [0, text.length)；双指针按字符推进，输出每段同时带 {cls, diff}，合并相邻同 (cls,diff)。
// segs 为空/不匹配 → 整行 eq（无词级高亮，仅行背景色）。
export function mergeTokensWithDiff(tokens: HlToken[], segs: DiffSeg[] | undefined): MergedToken[] {
  if (!segs || !segs.length) {
    return tokens.map((t) => ({ text: t.text, cls: t.cls, diff: 'eq' as const }));
  }
  // 把 tokens 展平成「字符 → cls」数组，segs 展平成「字符 → diff」数组
  const len = tokens.reduce((a, t) => a + t.text.length, 0);
  if (len === 0) return [];
  const clsOf: string[] = new Array(len);
  const diffOf: ('eq' | 'del' | 'ins')[] = new Array(len);
  let i = 0;
  for (const t of tokens) { for (let j = 0; j < t.text.length; j++) clsOf[i++] = t.cls; }
  i = 0;
  for (const s of segs) {
    for (let k = 0; k < s.x.length; k++) {
      if (i < len) diffOf[i++] = s.s === 'del' ? 'del' : s.s === 'ins' ? 'ins' : 'eq';
    }
  }
  // segs 总长可能与 len 不严格相等（理论不应），以 len 为准，未填位按 eq
  for (let k = 0; k < len; k++) if (diffOf[k] === undefined) diffOf[k] = 'eq';

  // 预拼接完整文本一次（避免逐字符 reduce 的 O(n²)），按字符索引取值。
  const fullText = tokens.reduce((a, t) => a + t.text, '');
  const out: MergedToken[] = [];
  for (let k = 0; k < len; k++) {
    const tok: MergedToken = { text: fullText[k] ?? '', cls: clsOf[k] ?? '', diff: diffOf[k]! };
    const last = out[out.length - 1];
    if (last && last.cls === tok.cls && last.diff === tok.diff) last.text += tok.text;
    else out.push(tok);
  }
  return out;
}
