// 会话当前实际模型的统一解析（doc：session-model-selector-design §4.3/§5.1/§5.3）。
// 单一真相源：渲染层触发器显示与主进程 spawn 注入共用同一函数，避免两端不一致。
//
// 唯一实际模型原则：会话只有一个当前实际模型（如 glm-4.6）；主流程与全部普通
// subagent 都用它。haiku/opus/sonnet/fable 只作为 Claude Code 内部兼容层存在——
// 每次 query 把 ANTHROPIC_DEFAULT_<ALIAS>_MODEL 全部映射到当前实际模型。

// 解析输入：主进程持解密 key；渲染层持 ProviderProfileView（无 key）。apiKey 为空串即无 key。
export interface ProviderModelSource {
  id: string;
  name: string;
  apiBaseUrl: string;
  apiKey: string;
  models: Array<{ id: string }>;
}

export interface SessionModelSelection {
  providerOverride: string | null;
  modelOverride: string | null;
}

export interface LastUsedModel {
  providerId: string | null;
  modelId: string | null;
}

export interface ResolvedSessionModel {
  provider: { id: string; name: string; apiBaseUrl: string; apiKey: string } | null;
  modelId: string | null;
  /** 会话 override 指向的供应商/模型已不在库中（发生了回退）——渲染层一次性 toast 用。 */
  invalidOverride: boolean;
}

// 解析顺序（文档 §4.3）：
//   provider = session.providerOverride（库中存在才有效）
//              ?? config.lastUsedProviderId（库中存在才有效）
//              ?? 库内第一个供应商
//   model    = session.modelOverride（必须 ∈ 该 provider.models，否则作废）
//              ?? lastUsedModelId（∈ 该 provider.models 才有效）
//              ?? 该 provider.models[0]
export function resolveSessionModel(
  session: SessionModelSelection,
  lastUsed: LastUsedModel | null,
  providers: ProviderModelSource[],
): ResolvedSessionModel {
  let invalidOverride = false;

  let provider =
    (session.providerOverride ? providers.find((p) => p.id === session.providerOverride) : undefined) ?? null;
  if (session.providerOverride && !provider) invalidOverride = true;
  if (!provider) provider = (lastUsed?.providerId ? providers.find((p) => p.id === lastUsed.providerId) : undefined) ?? null;
  if (!provider) provider = providers[0] ?? null;

  let modelId: string | null = null;
  if (provider) {
    if (session.modelOverride) {
      if (provider.models.some((m) => m.id === session.modelOverride)) {
        modelId = session.modelOverride;
      } else {
        invalidOverride = true;
      }
    }
    if (!modelId && lastUsed?.modelId && provider.models.some((m) => m.id === lastUsed.modelId)) {
      modelId = lastUsed.modelId;
    }
    modelId ??= provider.models[0]?.id ?? null;
  }

  return {
    provider: provider
      ? { id: provider.id, name: provider.name, apiBaseUrl: provider.apiBaseUrl, apiKey: provider.apiKey }
      : null,
    modelId,
    invalidOverride,
  };
}

// 四别名统一映射 env（双保险第一层）：每次 query 把全部 ANTHROPIC_DEFAULT_*_MODEL
// 与 ANTHROPIC_MODEL 都钉到当前实际模型。别名仅作 Claude Code 内部兼容，用户侧不可见。
export function buildUnifiedModelEnv(modelId: string): Record<string, string> {
  return {
    ANTHROPIC_MODEL: modelId,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelId,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: modelId,
    ANTHROPIC_DEFAULT_OPUS_MODEL: modelId,
    ANTHROPIC_DEFAULT_FABLE_MODEL: modelId,
  };
}

// Agent/Task 工具调用级 model 改写判定（双保险第二层，纯函数供 canUseTool 与 selftest 共用）。
// 依据：调用级 model 优先于 agent 定义 frontmatter（sdk-tools.d.ts AgentInput.model），
// fork 天然继承 parent 不改。返回需要改写成的模型 ID；null = 无需改写。
const AGENT_MODEL_TOOL_NAMES = new Set(['Task', 'Agent']);

export function decideAgentModelOverride(
  toolName: string,
  input: Record<string, unknown>,
  currentModel: string | null,
): string | null {
  if (!currentModel || !AGENT_MODEL_TOOL_NAMES.has(toolName)) return null;
  if (input.subagent_type === 'fork') return null;
  return input.model === currentModel ? null : currentModel;
}
