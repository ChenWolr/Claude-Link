// context-window-override.ts
// A7（D04-F5）：设置页「上下文窗口覆盖」编辑区的表单↔config 投影纯函数。
// config.contextWindowByAlias 是顶层持久化字段（AppConfig，非 advancedJson 投影域——D04 复核
// 确认），消费链在 model-context-windows.ts（lookupUserContextWindow / resolveContextWindow，
// 分母最高优先级源）与主进程 spawn/探针注入；本模块只负责「本地行态 → 合法映射表」的单向
// 投影与逐行校验文案，不触碰分母解析与圆环渲染。

export interface ContextWindowOverrideRow {
  alias: string;
  value: string;
}

export interface ContextWindowOverrideProjection {
  /** 合法行投影出的映射（非法/不完整行不写入——「非法输入被拦截」语义）。 */
  map: Record<string, number>;
  /** 与输入同序的逐行错误文案；空串 = 该行合法或为待填写的空行。 */
  errors: string[];
}

export const CONTEXT_WINDOW_MIN = 1000;
export const CONTEXT_WINDOW_MAX = 2_000_000;
// 与供应商模型 ID 同一白名单口径（ProviderManager handleModelAdd 前置拦截同款）。
const ALIAS_RE = /^[\w.\-:/]+$/;

/** 逐行校验文案（与行序无关的单行判定 + 跨行重复检测）。空串 = 合法或待填写空行。 */
export function contextWindowOverrideRowError(rows: ContextWindowOverrideRow[], index: number): string {
  const row = rows[index];
  if (!row) return '行不存在';
  const alias = row.alias.trim();
  const value = row.value.trim();
  if (!alias && !value) return '';
  if (!alias) return '缺少别名';
  if (!ALIAS_RE.test(alias)) return '别名仅允许字母/数字/下划线/点/连字符/冒号/斜杠';
  if (rows.some((r, i) => i !== index && r.alias.trim() === alias)) return '别名重复';
  if (!value) return '缺少 token 数';
  const n = Number(value);
  if (!Number.isInteger(n) || n < CONTEXT_WINDOW_MIN || n > CONTEXT_WINDOW_MAX) {
    return 'token 数须为 1,000–2,000,000 的整数';
  }
  return '';
}

/** 本地行态 → 合法映射表投影：非法/不完整行不写入（自动保存快照不受污染）。 */
export function projectContextWindowOverrides(rows: ContextWindowOverrideRow[]): ContextWindowOverrideProjection {
  const errors = rows.map((_, i) => contextWindowOverrideRowError(rows, i));
  const map: Record<string, number> = {};
  rows.forEach((row, i) => {
    if (errors[i]) return;
    const alias = row.alias.trim();
    if (!alias) return;
    map[alias] = Number(row.value.trim());
  });
  return { map, errors };
}
