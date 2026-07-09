// 内置「模型 → 上下文窗口」静态表 + fallback 解析（主进程与渲染层共享纯逻辑）。
//
// 背景：Anthropic /v1/models 不返回 context_window，model-resolver 只能拿到
// max_output_tokens；而真实窗口（SDK result.modelUsage.contextWindow）要等连通
// Claude 后才到达。本表用于「未连接时」按当前模型给出合理窗口，避免一律显示 200k。
//
// 命中规则：标准化（小写 + trim）后按「最长前缀」匹配——避免 'glm-5.2' 被更短的
// 别名抢匹配，也兼容带后缀的变体（glm-5.2-1m、claude-sonnet-4-6 等）。
// 未命中返回 null，由调用方走 fallback 链（持久化真实值 → 用户覆盖 → 200000）。
//
// 数值按各家官方文档；新模型按需补充。宁可少放，不要放错——命中错误的窗口比
// 落到 fallback 更误导。

import { extractModelMappings } from './settings-parser';
import type { ModelAlias } from './types/config';

export const DEFAULT_CONTEXT_WINDOW = 200_000;

// [前缀, 窗口大小]。前缀已小写；匹配时对模型名做 toLowerCase + trim。
export const MODEL_CONTEXT_WINDOWS: ReadonlyArray<readonly [prefix: string, window: number]> = [
  // Claude 官方（Anthropic）。Fable 5 是 1M 长上下文模型；4.x opus/sonnet/haiku 为 200k。
  ['claude-fable-5', 1_000_000],
  ['claude-opus-4', 200_000],
  ['claude-sonnet-4', 200_000],
  ['claude-haiku-4', 200_000],
  // 兜底前缀：覆盖 3.x 及未来未列版本（同族默认仍 200k；fable 族默认 1M）。
  ['claude-fable', 1_000_000],
  ['claude-opus', 200_000],
  ['claude-sonnet', 200_000],
  ['claude-haiku', 200_000],

  // 智谱 GLM。glm-5.2 为 1M 上下文（用户环境确认 [1m]）。其它版本暂不入表，落到 fallback。
  ['glm-5.2', 1_000_000],

  // DeepSeek。V3 / R1 均为 64k。
  ['deepseek-chat', 64_000],
  ['deepseek-reasoner', 64_000],
];

// 标准化模型名后按最长前缀匹配。返回 null 表示未知，交给 fallback 链。
export function lookupModelWindow(model: string | null | undefined): number | null {
  if (!model) return null;
  const m = model.trim().toLowerCase();
  if (!m) return null;
  let best: number | null = null;
  let bestLen = -1;
  for (const [prefix, win] of MODEL_CONTEXT_WINDOWS) {
    if (m.startsWith(prefix) && prefix.length > bestLen) {
      best = win;
      bestLen = prefix.length;
    }
  }
  return best;
}

// 上下文窗口 fallback 链（优先级从高到低）：
//   1. lastContextWindow           —— 该会话从 SDK result.modelUsage 拿到的真实值（已持久化）
//   2. contextWindowByAlias[alias] —— 用户在配置页按当前别名设的覆盖（env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>）
//   3. DEFAULT_CONTEXT_WINDOW（200000）
// 注：内置 MODEL_CONTEXT_WINDOWS 表不再参与 fallback（用户要求「未设置严格默认 200k」），
//     lookupModelWindow 仅保留为查表工具，供 selftest 与未来可能的复用。
export function resolveContextWindow(opts: {
  lastContextWindow?: number | null;
  alias?: string | null;
  contextWindowByAlias?: Partial<Record<string, number>> | null;
}): number {
  const { lastContextWindow, alias, contextWindowByAlias } = opts;
  // 1. 用户按别名显式设置（最高优先级，「以设置为准」）——即使 SDK 上报了真实窗口，
  //    用户强制设置的值也覆盖之（解决端点误报 200k、但用户已知模型实际为 1M 的场景）。
  const byAlias = alias ? contextWindowByAlias?.[alias] : undefined;
  if (typeof byAlias === 'number' && byAlias > 0) return byAlias;
  // 2. SDK 真实上报（连通后）
  if (typeof lastContextWindow === 'number' && lastContextWindow > 0) return lastContextWindow;
  // 3. 默认 200k
  return DEFAULT_CONTEXT_WINDOW;
}

// 主进程用：会话启动时（SDK 尚未上报真实窗口）按当前别名/真实模型名解析初始窗口。
// aliasOrModel 可能是别名(sonnet)或真实模型名(glm-5.2)；真实模型名时按 modelMappings
// 反查别名再查 contextWindowByAlias。命中用户按别名设的覆盖则返回，否则 200k。
// 与渲染层 resolveContextWindow 共享优先级语义（用户设置 > 200k），避免主进程推送的初始
// windowSize 覆盖前端 switchSession 已算出的正确分母。
export function resolveContextWindowForSession(opts: {
  aliasOrModel?: string | null;
  advancedJson: string;
  contextWindowByAlias?: Partial<Record<ModelAlias, number>> | null;
}): number {
  const { aliasOrModel, advancedJson, contextWindowByAlias } = opts;
  const byAlias = contextWindowByAlias ?? {};
  if (aliasOrModel) {
    const direct = byAlias[aliasOrModel as ModelAlias];
    if (typeof direct === 'number' && direct > 0) return direct;
    const mappings = extractModelMappings(advancedJson);
    const target = aliasOrModel.toLowerCase();
    for (const [alias, mapped] of Object.entries(mappings)) {
      if (mapped && mapped.toLowerCase() === target) {
        const v = byAlias[alias as ModelAlias];
        if (typeof v === 'number' && v > 0) return v;
      }
    }
  }
  return DEFAULT_CONTEXT_WINDOW;
}

// 与 resolveContextWindowForSession 同样的反查逻辑（别名直查 → 真实模型名反查别名），
// 但未命中用户配置时返回 undefined（而非 200k 默认）。供 buildSdkOptions 注入
// CLAUDE_CODE_MAX_CONTEXT_TOKENS 用：仅当用户显式配置了该别名的窗口才注入，没配则不注入
// （让 CC 自决），避免把未配置的官方模型（如 fable 5 的 1M）误降级到 200k。
export function lookupUserContextWindow(opts: {
  aliasOrModel?: string | null;
  advancedJson: string;
  contextWindowByAlias?: Partial<Record<ModelAlias, number>> | null;
}): number | undefined {
  const { aliasOrModel, advancedJson, contextWindowByAlias } = opts;
  const byAlias = contextWindowByAlias ?? {};
  if (aliasOrModel) {
    const direct = byAlias[aliasOrModel as ModelAlias];
    if (typeof direct === 'number' && direct > 0) return direct;
    const mappings = extractModelMappings(advancedJson);
    const target = aliasOrModel.toLowerCase();
    for (const [alias, mapped] of Object.entries(mappings)) {
      if (mapped && mapped.toLowerCase() === target) {
        const v = byAlias[alias as ModelAlias];
        if (typeof v === 'number' && v > 0) return v;
      }
    }
  }
  return undefined;
}
