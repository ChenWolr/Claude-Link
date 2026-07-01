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
//   1. lastContextWindow —— 该会话从 SDK result.modelUsage 拿到的真实值（已持久化）
//   2. model 查表        —— 内置表按当前模型查（解决「未连接时初始化」显示）
//   3. override          —— 用户在配置页填的全局覆盖（env.CLAUDE_LINK_CONTEXT_WINDOW）
//   4. DEFAULT_CONTEXT_WINDOW（200000）
export function resolveContextWindow(opts: {
  lastContextWindow?: number | null;
  model?: string | null;
  override?: number | null;
}): number {
  const { lastContextWindow, model, override } = opts;
  if (typeof lastContextWindow === 'number' && lastContextWindow > 0) return lastContextWindow;
  const fromModel = lookupModelWindow(model);
  if (fromModel !== null && fromModel > 0) return fromModel;
  if (typeof override === 'number' && override > 0) return override;
  return DEFAULT_CONTEXT_WINDOW;
}
