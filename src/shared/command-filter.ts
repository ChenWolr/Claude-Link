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

/**
 * B-5（review 2026-09-18 §3-2）：'/' 菜单命令按 skill 禁用配置过滤——仅 user-skill 来源参与
 * （skillOverrides 键空间是 skill 目录名，builtin/project/plugin 命令不受其约束，同名碰撞时
 * 非 user-skill 条目保留）。overrides 空 → 原数组引用返回（零开销快路径）。
 * R-1（2026-09-19）：开关键统一为目录名（引擎口径）——user-skill 条目经开关键解析
 * `nameToDir?.[c.name] ?? c.name`（fm 名→目录名映射，同源 SKILL_PROJECT_DIRS_GET 载荷；
 * hasOwnProperty 防原型链误取）；映射缺省/无命中回退 slash 名（fm==dir 公共形态同键；
 * fm≠dir 且映射不可得时维持旧行为，残面由引擎键入本地拦截兜底）。
 */
export function filterMenuCommandsBySkillOverrides<T extends { name: string; origin?: string }>(
  commands: T[],
  overrides: Record<string, 'off'> | null | undefined,
  nameToDir?: Record<string, string> | null,
): T[] {
  if (!overrides || Object.keys(overrides).length === 0) return commands;
  return commands.filter((c) => {
    if (c.origin !== 'user-skill') return true;
    const key =
      nameToDir && Object.prototype.hasOwnProperty.call(nameToDir, c.name) ? nameToDir[c.name] : c.name;
    return overrides[key] !== 'off';
  });
}
