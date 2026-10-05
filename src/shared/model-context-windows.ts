// 上下文窗口「按供应商模型」覆盖的共享纯逻辑（主进程与渲染层共用，不依赖 electron）。
//
// 分母优先级（从高到低）：
//   1. 供应商库内模型条目 contextWindow —— 用户按模型手动设置（本模块
//      lookupProviderModelContextWindow 查询；同 ID 模型在不同供应商下互不影响）
//   2. SDK 上报真实窗口 —— result.modelUsage.contextWindow（会话 lastContextWindow 持久化）
//   3. DEFAULT_CONTEXT_WINDOW（200k）
//
// 历史「全局按别名覆盖」链（按别名的窗口覆盖配置表 + 对应 legacy env 键 + 内置模型静态
// 查表）已删除；存量 legacy env 值由 migrateLegacyContextWindowOverrides（provider-library）
// 在启动时一次性移植到对应模型条目或废弃（仅删键）。

export const DEFAULT_CONTEXT_WINDOW = 200_000;

// 手动设置上下文窗口的合法区间（自 context-window-override.ts 迁来，该文件已删除）。
export const CONTEXT_WINDOW_MIN = 1_000;
export const CONTEXT_WINDOW_MAX = 2_000_000;

// 在供应商模型列表里按精确 id 查手动覆盖窗口。
// contextWindow > 0 才视为已设置（undefined/null/0 = 未设置）；其余情况一律 undefined
// （交给下游链回落 SDK 上报/默认 200k）。精确匹配不做大小写/前缀归一。
export function lookupProviderModelContextWindow(
  models: Array<{ id: string; contextWindow?: number | null }> | null | undefined,
  modelId: string | null | undefined,
): number | undefined {
  if (!models || !modelId) return undefined;
  for (const m of models) {
    if (m.id === modelId && typeof m.contextWindow === 'number' && m.contextWindow > 0) {
      return m.contextWindow;
    }
  }
  return undefined;
}

// UI 输入校验：'' → null（=清除意图）；非十进制数字串/越界（1,000–2,000,000）→ 错误文案。
// 合法输入返回 null。文案为产品内单源（ProviderModelList 浮层卡就近错误提示同款）。
export function providerModelWindowInputError(raw: string): string | null {
  if (raw === '') return null;
  if (!/^\d+$/.test(raw)) return 'token 数须为 1,000 – 2,000,000 的整数';
  const n = Number(raw);
  if (!Number.isInteger(n) || n < CONTEXT_WINDOW_MIN || n > CONTEXT_WINDOW_MAX) {
    return 'token 数须为 1,000 – 2,000,000 的整数';
  }
  return null;
}
