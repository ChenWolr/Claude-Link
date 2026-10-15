// fs-path-utils.ts —— 文件选择弹窗路径小工具（渲染层无 node:path，Windows 盘符/UNC 路径手写；
// 主进程 listDir 会 resolve 归一）。零框架依赖（不得 import vue）——契约脚本 tsx 直测的前提。
// 自 FilePickerDialog.vue 原样迁出（P3 单源维护），parentDir 增强 UNC，另新增地址栏两个纯函数。

/** 拼接子项；dir 已带尾分隔符（含盘根）时不重复补。 */
export function joinPath(dir: string, name: string): string {
  return /[\\/]$/.test(dir) ? dir + name : dir + '\\' + name;
}

/** 上级目录；盘根（C:\）或剥到 \\server（无 share 段）返回 null（「上一级」置灰依据）。 */
export function parentDir(p: string): string | null {
  // UNC：\\server\share\a → \\server\share；\\server\share 再剥就到 \\server → null。
  if (p.startsWith('\\\\')) {
    const body = p.slice(2).replace(/[\\/]+$/, '');
    if (!body) return null;                                 // 纯 `\\`
    const cut = Math.max(body.lastIndexOf('\\'), body.lastIndexOf('/'));
    if (cut <= 0) return null;                              // `\\server` 本身无 share 段
    const parentBody = body.slice(0, cut);                  // `srv\sh\a` → `srv\sh`；`srv\sh` → `srv`
    if (!/[\\/]/.test(parentBody)) return null;             // 上级只剩 server 段（无 share）→ 不可再上
    return '\\\\' + parentBody;
  }
  // 盘符路径（与迁出前逻辑等价；唯一定点修正：原实现模板再补一个 `\` 与 body 自带的前导
  // 分隔符叠成 `D:\\work`，此前靠主进程 path.resolve 归一兜住——本函数作为纯函数输出单分隔符，
  // 组件侧唯一消费口 loadDir 的归一语义不变，端到端行为等价）。
  const m = /^([a-zA-Z]:)([\\/].*)?$/.exec(p);
  if (!m || !m[2] || m[2] === '\\' || m[2] === '/') return null;
  const body = m[2].replace(/[\\/]+$/, '');
  const cut = Math.max(body.lastIndexOf('\\'), body.lastIndexOf('/'));
  if (cut <= 0) return `${m[1]}\\`;             // 一级子目录 → 盘根 `D:\`
  return m[1] + body.slice(0, cut);             // body 自带前导分隔符：`\work\sub` → `D:\work`
}

/** 取末段名（目录名/文件名）；尾分隔符与盘根归空串。 */
export function baseName(p: string): string {
  const i = Math.max(p.lastIndexOf('\\'), p.lastIndexOf('/'));
  return i === -1 ? p : p.slice(i + 1);
}

/** 路径等值（尾分隔符与大小写不敏感——Windows 盘符路径语义）。 */
export function samePath(a: string, b: string): boolean {
  return a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();
}

/** 绝对路径判定：盘符绝对路径（`D:\` `D:/`）或 UNC（前导 `\\`）。 */
export function isAbsolutePath(p: string): boolean {
  return /^([a-zA-Z]:[\\/]|\\\\)/.test(p);
}

/** 地址栏输入归一；不可用输入（空/相对/超长）返回 null 交由调用方报 inline 错误。 */
export function normalizeAddressInput(p: string): string | null {
  const t = p.trim();
  if (!t || t.length > 4096) return null;
  if (!isAbsolutePath(t)) return null;
  if (t.startsWith('\\\\')) {
    // UNC：前导 \\ 原样保留，仅去尾分隔符（`\\srv\sh\` → `\\srv\sh`）；剥空（纯 `\\`）视同无效输入 → null。
    const stripped = t.replace(/[\\/]+$/, '');
    return stripped || null;
  }
  // 盘符路径：正斜杠归一为反斜杠，去尾分隔符；剥空后只剩盘符说明是盘根 → 保留单尾斜杠（`D:\`）。
  const unified = t.replace(/\//g, '\\');
  const noTail = unified.replace(/[\\/]+$/, '');
  return noTail.length === 2 ? `${noTail}\\` : noTail;
}
