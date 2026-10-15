// fs-name-rules.ts
// 文件/文件夹名称规则单源：渲染层（FilePickerDialog 的 save/重命名提示）与主进程
// （fs-picker.renamePath 的入参校验）共用同一份判定与错误文案。
// 纯模块零依赖：整个文件不含任何 import/require——两侧共用 + 契约脚本 tsx 直测的前提。

/** Windows 文件/文件夹名单个名称长度上限（NTFS 硬限制）。 */
export const FS_ITEM_NAME_MAX = 255;

/** 文件/文件夹名合法性（Windows）：非空、非 . ..、无 \ / : * ? " < > |、不以点/空格结尾、≤255。 */
export function isValidFsItemName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0 || name.length > FS_ITEM_NAME_MAX) return false;
  if (/[\\/:*?"<>|]/.test(name)) return false;
  if (name.endsWith('.') || name.endsWith(' ')) return false;
  return true;
}

/** 返回错误文案（与现状 save-file confirmSave 文案逐字一致）或 null（合法）。文案单源，渲染层与主进程共用。
 *  非 string 入参为防御路径，与非法字符同文案（与 isValidFsItemName 的非 string→false 对齐）；
 *  唯一例外：空名由调用方自己提示（「请输入文件名」），本函数对空名返回 null。 */
export function describeInvalidFsItemName(name: string): string | null {
  if (typeof name !== 'string') return '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾';
  if (name.length === 0) return null;             // 空名由调用方自己提示（契约既有行为不变）
  // 判定顺序对齐 confirmSave 现状：先字符集/尾点尾空格、后超长——两类问题并存时文案与旧行为一致。
  if (/[\\/:*?"<>|]/.test(name) || name.endsWith('.') || name.endsWith(' ')) {
    return '名称含非法字符（\\ / : * ? " < > |），或以点/空格结尾';
  }
  if (name.length > FS_ITEM_NAME_MAX) return '名称过长（上限 255 字符）';
  return null;
}
