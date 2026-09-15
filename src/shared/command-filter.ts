// command-filter.ts
// 渲染层菜单命令按「全局 skill 禁用配置」过滤的纯函数（shared：渲染层 command-store 与
// tdd 脚本共用；不引 electron，无可副作用——只读入参、返回新数组或原引用）。
//
// 与主进程引擎级剔除（sdk-skill-overrides 经 settings 注入）分层：本函数只管 Claude Link
// 暂态会话 `/` 菜单的即时展示；物化会话由引擎 per-session probe 接管（引擎级剔除为准）。

/**
 * 按 skillOverrides 过滤命令列表。
 * - overrides 为空（null/undefined/空对象）→ 原数组引用返回（零开销快路径）；
 * - 否则剔除 `overrides[c.name] === 'off'` 的条目。键为 skill canonical 名，
 *   区分大小写；别名不参与匹配（override 只钉 canonical 名）。
 */
export function filterCommandsBySkillOverrides<T extends { name: string }>(
  commands: T[],
  overrides: Record<string, 'off'> | null | undefined,
): T[] {
  if (!overrides || Object.keys(overrides).length === 0) return commands;
  return commands.filter((c) => overrides[c.name] !== 'off');
}
