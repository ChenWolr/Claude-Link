// file-link.ts
// markdown 正文文件链接解析（2026-11-04 文件预览计划 p3/W2）：把 <a href> 的原始 href 解析为
// 「绝对路径 + 展示 label」，供 markdown.ts link_open 规则按钮化（.md-file-link）与 MessageBubble
// 点击委托（useFilePreview().open）使用；未命中返回 null，链接走既有渲染路径、输出零变化。
// 零框架依赖（禁 import vue）：渲染层单例与 scripts tsx 验证脚本共用本模块，测试不引 Vue 运行时。

export interface ResolvedFileLink {
  path: string;
  label: string;
}

export function resolveFileLinkHref(
  rawHref: string,
  workspaceRoot: string | null,
  opts?: { skipPercentDecode?: boolean },
): ResolvedFileLink | null {
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
  //     A2（2026-11-06 计划）：opts.skipPercentDecode 时跳过——反引号 code_inline 内容是模型
  //     原文而非 normalizeLink 编码态，不跳过会把 '50%off.md' 的字面 % 当非法编码整条拒绝。
  if (!opts?.skipPercentDecode) {
    try {
      candidate = decodeURIComponent(candidate);
    } catch {
      return null;
    }
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
    // P6-A：'...' 省略段 = 模型转述路径（D:\a\...\b.md、src/.../foo.vue）——非真实可定位路径，
    // 整条拒绝链接化（按普通文本渲染）。
    if (seg === '...') return null;
  }
  const joined = segments.filter((seg) => seg !== '.').join('\\');

  // h. label = 归一后路径 basename；空（'docs/' 目录形态等）→ null。
  const parts = joined.split('\\');
  const label = parts[parts.length - 1] ?? '';
  if (!label) return null;
  return { path: joined, label };
}

// ── A2（2026-11-06 文件点击打开链路计划）：反引号 code_inline 路径解析 ─────────────────────
// 可预览扩展名白名单：裸文件名（无路径分隔符）仅当扩展名命中本表才链接化；含分隔符的相对
// 路径不看扩展名（目录段已提供定位信息）。查表时统一小写比较（Windows 扩展名大小写不敏感）。
export const PREVIEWABLE_EXTS: ReadonlySet<string> = new Set([
  'md', 'html', 'htm', 'txt', 'log', 'csv', 'json', 'xml', 'yml', 'yaml', 'toml', 'ini', 'cfg', 'conf', 'svg', 'mmd',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'svelte', 'py', 'rs', 'go', 'java', 'kt', 'swift', 'c', 'h', 'cpp',
  'hpp', 'cc', 'cs', 'php', 'rb', 'sh', 'bash', 'zsh', 'bat', 'cmd', 'ps1', 'sql', 'lua', 'r',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
  'mp4', 'webm', 'mov', 'mp3', 'wav', 'flac', 'ogg', 'm4a', 'weba',
  'pdf', 'docx', 'xlsx', 'xls', 'pptx',
]);

// S4 端点垃圾字符集：尾部无条件剥（引号/常见中英标点/尾点）；头部剥（引号/反引号/开括号）。
// 闭括号 )]}> 不在无条件集——先统计配平，仅未配平时剥（见 closerUnbalanced 与配对表；> 为 A2-1e 补入的尖括号闭端）。
const CODE_INLINE_TAIL_GARBAGE = new Set(['"', "'", '`', ',', ';', ':', '!', '?', '，', '。', '；', '：', '！', '？', '.']);
const CODE_INLINE_HEAD_GARBAGE = new Set(['"', "'", '`', '(', '[', '{', '<']);
const CODE_INLINE_BRACKET_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ['(', ')'], ['[', ']'], ['{', '}'], ['<', '>'],
];

// 闭括号是否未配平：全文统计同型开/闭数量，闭 > 开才算未配平（'foo()' 配平不剥、'见 x.md)' 剥）。
function closerUnbalanced(s: string, closer: string): boolean {
  const pair = CODE_INLINE_BRACKET_PAIRS.find((p) => p[1] === closer);
  if (!pair) return false;
  let open = 0;
  let close = 0;
  for (const ch of s) {
    if (ch === pair[0]) open++;
    else if (ch === pair[1]) close++;
  }
  return close > open;
}

// S4 端点垃圾剥离：尾→头各走一遍，共 2 轮——第 1 轮头部开括号剥除后，原配平尾闭括号转为
// 未配平（'(C:\x.md)' → 'C:\x.md)'），第 2 轮尾部把它剥掉。每轮收尾重 trim。
function stripCodeInlineEdges(input: string): string {
  let s = input;
  for (let round = 0; round < 2; round++) {
    for (;;) {
      const last = s[s.length - 1];
      if (last === undefined) break;
      if (CODE_INLINE_TAIL_GARBAGE.has(last)) {
        s = s.slice(0, -1);
        continue;
      }
      if (')]}>'.includes(last) && closerUnbalanced(s, last)) {
        s = s.slice(0, -1);
        continue;
      }
      break;
    }
    for (;;) {
      const first = s[0];
      if (first === undefined) break;
      if (CODE_INLINE_HEAD_GARBAGE.has(first)) {
        s = s.slice(1);
        continue;
      }
      break;
    }
    s = s.trim();
    if (!s) break;
  }
  return s;
}

// 反引号 code_inline 内容 → 文件链接（A2）。反引号内容是模型原文而非 markdown-it
// normalizeLink 的编码态：所有 resolveFileLinkHref 调用一律 skipPercentDecode（唯一例外是
// file:// 分支——file URL 惯例为编码态，走正常解码）。返回 null 时调用方回退基线 <code> 渲染。
export function resolveCodeInlinePath(content: string, workspaceRoot: string | null): ResolvedFileLink | null {
  // S1 trim；空 → null。
  let s = content.trim();
  if (!s) return null;
  // S2 过长（>1024）不是路径——防把整段正文误判成路径。
  if (s.length > 1024) return null;
  // S3 对称引号剥离（至多 2 轮；成对同字符才剥，剥后重 trim——处理 `"C:\x.md"` 引号内带空格）。
  for (let round = 0; round < 2; round++) {
    if (s.length >= 2) {
      const first = s[0];
      const last = s[s.length - 1];
      if (first === last && (first === '"' || first === "'" || first === '`')) {
        s = s.slice(1, -1).trim();
      }
    }
  }
  // S4 端点垃圾剥离。
  s = stripCodeInlineEdges(s);
  if (!s) return null;
  // S5 分类。
  // a. file URL（编码态惯例）→ resolveFileLinkHref 正常解码。
  if (/^file:\/\//i.test(s)) {
    return resolveFileLinkHref(s, workspaceRoot);
  }
  // b. 其余 scheme（http:/https:/mailto:/data: 等）不是文件路径。scheme 须 ≥2 字符（+ 而非
  //    *）：单字母盘符 'C:\x' 不得命中本判定，否则全部盘符绝对路径在 S5d 之前被误拒（与
  //    resolveFileLinkHref 注 c 同一设计；计划文本笔误作 *，以本文件既有设计注释与实现标准①为准）。
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(s)) return null;
  // c. POSIX 绝对（含 '/D:/x' 形态）拒绝。
  if (s.startsWith('/')) return null;
  // d. 绝对形态（UNC ' \\' 开头 / 盘符）→ skip 解码解析。
  if (/^\\\\/.test(s) || /^[A-Za-z]:[\\/]/.test(s)) {
    return resolveFileLinkHref(s, workspaceRoot, { skipPercentDecode: true });
  }
  // e. 相对形态：剥尾部 #/? 片段后含路径分隔符 → 相对链接（不看扩展名）；无分隔符则扩展名
  //    命中 PREVIEWABLE_EXTS 才链接化。data-clip-path 取 resolveFileLinkHref 的归一路径
  //    （其 d4 步再剥一次 #/?，两处一致）。
  const noFrag = s.replace(/[#?].*$/, '');
  if (!/[\\/]/.test(noFrag)) {
    const dot = noFrag.lastIndexOf('.');
    if (dot < 0) return null;
    const ext = noFrag.slice(dot + 1).toLowerCase();
    if (!PREVIEWABLE_EXTS.has(ext)) return null;
  }
  return resolveFileLinkHref(s, workspaceRoot, { skipPercentDecode: true });
}

// A4（2026-11-06 计划）用：href 是否「路径形相对链接」——无 scheme、非 # 开头锚点、路径段
// 不含 '..'（含 '...' 段拒绝，2026-11-21 P6-A）。命中且未设工作区根时走死链标记分支
//（本点只落地导出，接线在 A4 点）。
export function isPathLikeRelativeHref(href: string): boolean {
  const s = href.trim();
  if (!s) return false;
  // scheme 判定 ≥2 字符（+ 而非 *）：单字母盘符 'C:\x' 是路径不是 scheme（同 resolveFileLinkHref 注 c）。
  if (/^[A-Za-z][A-Za-z0-9+.-]+:/.test(s)) return false;
  if (s.startsWith('#')) return false;
  return !s.split(/[\\/]/).some((seg) => seg === '..' || seg === '...');
}

// A4（2026-11-06 计划）用：路径是否「独立可定位」的绝对形态——盘符（C:\x / C:/x）、UNC
// （\\srv\share）、POSIX 根（/abs）。FilePreviewDrawer load() 预检用：非本形态 = 相对路径
// （两个来源，与 FilePreviewDrawer.vue 侧 fix-3 后口径一致：①markdown.ts link_open 死链分支
// ——未设根时 clip 存原始相对路径；②ToolCallBlock chip 直取 tool_use 入参的相对路径违约形态
// ——Write/Edit 契约要求绝对路径，模型违约时 root 已设仍可能传入相对路径；错误文案按根状态分述），
// 本地合成错误卡、不发 IPC（主进程无法独立定位相对路径）。'C:foo'（盘符
// 相对、冒号后无分隔）不算绝对形态——fs 解析依赖当前工作目录，同样无法独立定位。
export function isAbsolutePathForm(p: string): boolean {
  const s = p.trim();
  if (!s) return false;
  return /^[A-Za-z]:[\\/]/.test(s) || s.startsWith('\\\\') || s.startsWith('/');
}
