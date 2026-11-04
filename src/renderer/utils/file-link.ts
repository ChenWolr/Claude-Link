// file-link.ts
// markdown 正文文件链接解析（2026-11-04 文件预览计划 p3/W2）：把 <a href> 的原始 href 解析为
// 「绝对路径 + 展示 label」，供 markdown.ts link_open 规则按钮化（.md-file-link）与 MessageBubble
// 点击委托（useFilePreview().open）使用；未命中返回 null，链接走既有渲染路径、输出零变化。
// 零框架依赖（禁 import vue）：渲染层单例与 scripts tsx 验证脚本共用本模块，测试不引 Vue 运行时。

export interface ResolvedFileLink {
  path: string;
  label: string;
}

export function resolveFileLinkHref(rawHref: string, workspaceRoot: string | null): ResolvedFileLink | null {
  // a. trim 后空 → null。
  const href = rawHref.trim();
  if (!href) return null;
  // b. 页内锚点不是文件链接。
  if (href.startsWith('#')) return null;
  // c. 带 scheme 的 href（mailto:/tel:/http:/https:/javascript: 等）一律拒绝；'file:' 例外，
  //    走下方本地路径解析。中间段用 + 而非 *：scheme 须 ≥2 字符，单字母盘符（'D:\x'）才
  //    不会被判成 scheme——若允许零字符（*），'D:' 命中 scheme 形态，全部盘符路径会被误拒
  //    （与下方 e 步盘符绝对路径分支及测试矩阵的绝对命中组直接矛盾）。scheme 判定发生在
  //    百分号解码之前：markdown-it normalizeLink 产出的编码态 href 中 ':' 不被编码，编码态
  //    即可识别（mailto:/https: 等无需先解码）。
  if (/^[a-zA-Z][a-zA-Z0-9+.-]+:/.test(href) && !/^file:/i.test(href)) return null;

  let candidate = href;
  // d. file:// 协议：只去前缀，解码统一走下方唯一一次 decodeURIComponent（fix-2 F1：此前仅
  //    file:// 分支解码，而 normalizeLink 对一切 href 做 percent-encode（中文→%E4…、空格→%20），
  //    相对/绝对路径不解码即死链——「file: 去前缀」提取后，两条路径统一走恰好一次解码）。
  if (/^file:\/\//i.test(candidate)) {
    candidate = candidate.slice('file://'.length);
  }
  // d2. 恰好一次百分号解码（try/catch → null：非法编码如 %ZZ 拒绝）。
  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    return null;
  }
  // d3. Windows 盘符修正：'/D:/x' → 'D:/x'（file:///D:/x 去前缀后形如 '/D:/x'）。
  if (/^\/[A-Za-z]:/.test(candidate)) candidate = candidate.slice(1);
  // d4. 尾缀剥离（fix-2 F4）：#frag / ?query 不是文件路径的一部分（mdurl.encode 对 # ? 保持
  //    字面）；解码后、绝对性判定前剥掉。剥完为空 → null。
  candidate = candidate.replace(/[#?].*$/, '');
  if (!candidate) return null;

  // e/f 公用：正斜杠归一为反斜杠（Windows 工作区约定）。
  const normalized = candidate.replace(/\//g, '\\');
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(candidate) || /^\\\\/.test(candidate);
  let full: string;
  if (isAbsolute) {
    // e. 绝对路径（盘符或 UNC）：归一后直接用，workspaceRoot 无关。
    full = normalized;
  } else {
    // f. 相对路径：workspaceRoot 缺失/空白 → null（导出窗口未 set 时相对链接天然不可点）；
    //    join = 去尾分隔符的 root + '\\' + 解码后的相对路径 candidate（去 './' 前缀、归一反斜杠）。
    //    fix-2 F1 起必须用 candidate 而非原始 href：candidate 已解码（%5C→'\'、%2e%2e→'..'），
    //    用编码态 href 拼 join 会让 '..' 逃过下方词法检查、中文路径拼成死链。
    if (!workspaceRoot || !workspaceRoot.trim()) return null;
    let rel = candidate;
    if (rel.startsWith('./')) rel = rel.slice(2);
    rel = rel.replace(/\//g, '\\').replace(/^\\+/, '');
    full = workspaceRoot.replace(/[\\/]+$/, '') + '\\' + rel;
  }

  // g. '..' 词法拒绝（对含绝对路径在内的一切路径生效；位于解码之后——%2e%2e / %5C 解码出的
  //    '..' 与反斜杠分隔同样命中本检查，B7 越界写法一律 null）；'.' 段直接丢弃后反斜杠重拼
  //    （保持归一形态）。
  const segments = full.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === '..') return null;
  }
  const joined = segments.filter((seg) => seg !== '.').join('\\');

  // h. label = 归一后路径 basename；空（'docs/' 目录形态等）→ null。
  const parts = joined.split('\\');
  const label = parts[parts.length - 1] ?? '';
  if (!label) return null;
  return { path: joined, label };
}
