// thinking-resolver.ts
// 思考强度档位 → SDK 注入参数的纯函数映射。
//
// resolveEffectiveThinkingLevel：会话级 override（null/auto）回落到全局默认。
// resolveThinkingConfig：把档位转成 { thinking, effort, settingsPatch }——
//   thinking → SDK Options.thinking（adaptive + 摘要展示）；
//   effort → SDK Options.effort（五档含 max）；
//   settingsPatch → 合并进 Options.settings，覆盖 advancedJson 同名字段（selector > advancedJson）。
//
// MVP 映射：所有模型统一走 adaptive，不传 budgetTokens（旧模型 budgetTokens 路径需先建能力表，批次 C）。
// 详见 thinking-budget-design-final.md §2.3 / §1.4 / §1.5。
//
// 这里用本地定义的结果类型，不直接 import SDK 类型——shared 层被 renderer 复用，
// renderer 侧无 SDK 运行时依赖；结构字段与 SDK 的 ThinkingAdaptive / EffortLevel / Settings 子集对齐。

import type { NonAutoThinkingLevel, ThinkingLevel } from './types/thinking';

/** adaptive 思考 + 摘要展示，结构对齐 SDK ThinkingAdaptive。 */
export interface ThinkingAdaptiveConfig {
  type: 'adaptive';
  display: 'summarized';
}

/** effort 枚举，对齐 SDK EffortLevel（含 max）。 */
export type ThinkingEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** resolveThinkingConfig 的返回：分别注入 SDK Options 的 thinking / effort / settings。 */
export interface ThinkingConfigResult {
  thinking: ThinkingAdaptiveConfig;
  effort?: ThinkingEffort;
  settingsPatch?: Record<string, unknown>;
}

const ADAPTIVE_SUMMARIZED: ThinkingAdaptiveConfig = { type: 'adaptive', display: 'summarized' };

/**
 * 解析「实际生效」的档位：
 * - sessionLevel 为 null 或 'auto' → 回落全局默认；
 * - 否则用 sessionLevel（必为非 auto 档）。
 */
export function resolveEffectiveThinkingLevel(
  sessionLevel: ThinkingLevel | null,
  globalDefault: NonAutoThinkingLevel,
): NonAutoThinkingLevel {
  if (sessionLevel === null || sessionLevel === 'auto') return globalDefault;
  return sessionLevel;
}

/**
 * 档位 → SDK 注入参数。MVP 所有模型统一 adaptive，不传 budgetTokens。
 *
 * 非中等档：显式开思考摘要 + 常驻思考，并关闭 prompt 关键字触发器
 *   （防 "ultracode" 关键字把普通回合误转成 Workflow）。
 * 中等档：只关关键字触发器，不投影思考字段——尊重用户 ~/.claude 配置，避免默认开高带来成本/延迟意外。
 * ultracode：xhigh effort + ultracode/enableWorkflows，保留关键字触发器（用 SDK 默认 true）。
 *
 * effort='max' 在运行时经 Options.effort 注入（SDK Options.effort 含 max）；
 * 但 Settings.effortLevel 不含 max，持久化投影层会把 max 降级为 xhigh（持久化降级 + 运行时补偿）。
 */
export function resolveThinkingConfig(level: NonAutoThinkingLevel): ThinkingConfigResult {
  const thinking = ADAPTIVE_SUMMARIZED;
  // 非 ultracode 档的通用 settingsPatch：开思考摘要 + 常驻思考 + 关关键字触发器。
  const baseSettings: Record<string, unknown> = {
    showThinkingSummaries: true,
    alwaysThinkingEnabled: true,
    workflowKeywordTriggerEnabled: false,
  };

  switch (level) {
    case 'low':
      return { thinking, effort: 'low', settingsPatch: { ...baseSettings } };
    case 'medium':
      // 中等档：只关关键字触发器，不投影思考字段（尊重 ~/.claude）。
      return { thinking, effort: 'medium', settingsPatch: { workflowKeywordTriggerEnabled: false } };
    case 'high':
      return { thinking, effort: 'high', settingsPatch: { ...baseSettings } };
    case 'xhigh':
      return { thinking, effort: 'xhigh', settingsPatch: { ...baseSettings } };
    case 'max':
      return { thinking, effort: 'max', settingsPatch: { ...baseSettings } };
    case 'ultracode':
      return {
        thinking,
        effort: 'xhigh',
        settingsPatch: {
          ultracode: true,
          enableWorkflows: true,
          alwaysThinkingEnabled: true,
          showThinkingSummaries: true,
          // ultracode 档保留关键字触发器（不设 workflowKeywordTriggerEnabled，用 SDK 默认 true）。
        },
      };
  }
}
