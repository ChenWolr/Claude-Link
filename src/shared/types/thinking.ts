// 思考强度（Thinking Level）类型定义。
//
// 思考强度 = Claude Code 的 effort 旋钮（low/medium/high/xhigh/max）+ 一个 workflow
// 开关档（ultracode = xhigh effort + 动态工作流编排）+ 一个 auto 回落（仅会话级用）。
// 与模型别名正交：思考强度不改变用哪个模型，只改变模型投入多少「思考/响应」力度。
//
// 详见 thinking-budget-design-final.md §2.1。

/**
 * 思考强度档位。
 * - 'auto'：回落全局默认（仅用于 Session 级别，全局默认本身不允许 auto）。
 * - 'low'/'medium'/'high'/'xhigh'/'max'：对应 SDK EffortLevel 五档。
 * - 'ultracode'：xhigh effort + 动态工作流编排（SDK 定义，锁死 effort=xhigh，
 *   不可与其他 effort 组合；实际效果待批次 B 实测）。
 */
export type ThinkingLevel = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultracode';

/** 全部档位（含 auto），供 UI 渲染与校验共用，顺序即 UI 展示顺序。 */
export const THINKING_LEVELS: readonly ThinkingLevel[] = [
  'auto',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultracode',
];

/**
 * 非自动档位（全局默认层用：全局默认本身是 auto 的回落目标，不允许再设 auto）。
 * 注意：ThinkingLevel 是字符串字面量联合，去 'auto' 必须用 Exclude（Omit 仅适用于对象类型）。
 */
export type NonAutoThinkingLevel = Exclude<ThinkingLevel, 'auto'>;

/** 运行时脏值清洗守卫：字符串且属于七档之一才算合法。 */
export function isValidThinkingLevel(v: unknown): v is ThinkingLevel {
  return typeof v === 'string' && (THINKING_LEVELS as readonly string[]).includes(v);
}
