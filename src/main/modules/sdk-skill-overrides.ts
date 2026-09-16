// sdk-skill-overrides.ts
// Skill 管理纯函数工具集（docs/plans/2026-09-15-skill-management-plan.md）：
// 会话级 skill 禁用快照的清洗/钉住/合并语义单源。不依赖 electron/DB——
// session-repo（DB 解析）、ipc-handlers（SESSION_CREATE 钉住）、config-manager（配置 sanitize）、
// sdk-backend（settings 块注入）共用同一实现。v1 只有二值：键存在且值 === 'off' = 禁用；
// 其他档位（name-only / user-invocable-only）留作后续扩展，清洗时直接丢弃。

/** 核心清洗：只保留 string 键且值 === 'off' 的条目（新对象输出，不原地改输入）。 */
function cleanSkillOverridesEntries(value: unknown): [string, 'off'][] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const entries: [string, 'off'][] = [];
  for (const [key, val] of Object.entries(value)) {
    if (val === 'off') entries.push([key, 'off']);
  }
  return entries;
}

/**
 * 解析 sessions.skill_overrides 列（JSON 序列化的 Record<string,'off'>）。
 * null/空串/JSON.parse 失败/非对象/数组/过滤后无合法条目 → null（= 全启用，不炸）。
 * session-repo.toSession 脏值兜底专用。
 */
export function parseSessionSkillOverrides(raw: string | null): Record<string, 'off'> | null {
  if (raw === null || raw === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const entries = cleanSkillOverridesEntries(parsed);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * 把会话钉住的 skillOverrides 并入显式 settings 块（flag 层顶层键）。
 * overrides 为 null 或空对象 → 原样返回引用（不加键）：空配置下 settings 块与
 * 不注入时字节级一致（生产 query / probe 零影响）。非空 → 返回浅拷贝并入顶层 skillOverrides。
 */
export function mergeSkillOverridesIntoSettings(
  settings: Record<string, unknown>,
  overrides: Record<string, 'off'> | null,
): Record<string, unknown> {
  if (!overrides || Object.keys(overrides).length === 0) return settings;
  return { ...settings, skillOverrides: overrides };
}

/**
 * SESSION_CREATE 钉住用：对 getConfig().skillOverrides 做同款清洗（脏值防御）。
 * 空/脏 → null 表示「无需落库」（与建行默认 NULL 一致）；非空 → 返回清洗后的副本。
 * 与 sanitizeSkillOverridesConfig 共用核心清洗逻辑，仅空值形态不同（null vs {}）。
 */
export function buildSessionSkillOverridesForPin(configValue: unknown): Record<string, 'off'> | null {
  const entries = cleanSkillOverridesEntries(configValue);
  return entries.length > 0 ? Object.fromEntries(entries) : null;
}

/**
 * 配置读路径 sanitize（config-manager.getConfig）：非对象 → {}；只保留值 === 'off' 的条目。
 * 空值形态为 {}（与 buildSessionSkillOverridesForPin 的 null 相区别：AppConfig 该字段非可空）。
 */
export function sanitizeSkillOverridesConfig(configValue: unknown): Record<string, 'off'> {
  return Object.fromEntries(cleanSkillOverridesEntries(configValue));
}
