// Shared parser for Claude Code settings.json content.
// Used by BOTH main process (file import) and renderer ("从 JSON 填充字段"),
// so they apply identical extraction rules.
//
// Claude Code's real settings.json keeps the API key / base URL / model mappings
// inside an `env` object (e.g. env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL,
// env.ANTHROPIC_DEFAULT_SONNET_MODEL), NOT at the top level. Older/imported
// shapes may also use top-level apiKey / apiBaseUrl / baseUrl / model — we accept
// both. Everything not extracted is preserved verbatim in advancedJson.

export interface ImportedSettings {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  apiKeyHelper?: string;
  advancedJson: string;
}

function asObject(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
}

// If obj[key] is a non-empty string, remove and return it.
function takeString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  if (typeof v === 'string' && v.trim()) {
    delete obj[key];
    return v;
  }
  return undefined;
}

// Read (without removing) the first non-empty string among keys.
function peekString(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return undefined;
}

export function parseClaudeSettings(content: string): ImportedSettings {
  let settings: unknown;
  try {
    settings = JSON.parse(content);
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : 'JSON 格式错误');
  }

  const root = asObject(settings);
  if (!root) {
    throw new Error('settings.json 必须是一个 JSON 对象');
  }

  const remaining: Record<string, unknown> = { ...root };
  const result: ImportedSettings = { advancedJson: '{}' };

  const envOriginal = asObject(remaining.env);
  // env is mutated to drop extracted apiKey/baseUrl (they have dedicated fields
  // and are injected explicitly when spawning the CLI); model env keys are kept.
  const env = envOriginal ? { ...envOriginal } : undefined;

  // API key: top-level > env.ANTHROPIC_API_KEY > env.ANTHROPIC_AUTH_TOKEN
  // peek（不删）：保留在 env，让 advancedJson 是完整 settings.json
  // （输入框↔JSON 双向一致；syncFormToAdvanced 改 env 不会因 parse 移除而循环）
  const apiKey =
    takeString(remaining, 'apiKey') ??
    (env ? peekString(env, ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']) : undefined);
  if (apiKey) result.apiKey = apiKey;

  // apiKeyHelper: 顶层命令字符串，用于动态获取 key（Claude Code 特有）。
  // 单独提取出来，避免残留在 advancedJson 被运行时当普通字段注入。
  // Claude Link 本身不执行它——只用于 UI 提示用户改用静态 API Key。
  const apiKeyHelper = takeString(remaining, 'apiKeyHelper');
  if (apiKeyHelper) result.apiKeyHelper = apiKeyHelper;

  // Base URL: top-level apiBaseUrl > baseUrl > env.ANTHROPIC_BASE_URL
  // peek（不删）：同 apiKey，保留在 env
  const apiBaseUrl =
    takeString(remaining, 'apiBaseUrl') ??
    takeString(remaining, 'baseUrl') ??
    (env ? peekString(env, ['ANTHROPIC_BASE_URL']) : undefined);
  if (apiBaseUrl) result.apiBaseUrl = apiBaseUrl;

  // Default model：优先用 Claude Code 的【类型别名】（sonnet/haiku/opus），
  // 让 CLI 通过 env 映射（ANTHROPIC_DEFAULT_SONNET_MODEL 等）转到实际模型。
  // 会话里选的是"类型"，CLI 自动映射到国产模型（如 glm-5.2）——这是官方机制
  // （aliases + ANTHROPIC_DEFAULT_*_MODEL）。仅当没有任何映射时，才 fallback
  // 到顶层 model / ANTHROPIC_MODEL 的实际值。
  // (Peek only — keep the model-mapping env vars intact in advancedJson.)
  const hasSonnetMapping = env ? peekString(env, ['ANTHROPIC_DEFAULT_SONNET_MODEL']) : undefined;
  const defaultModel =
    takeString(remaining, 'model') ??
    (hasSonnetMapping ? 'sonnet' : (env ? peekString(env, ['ANTHROPIC_MODEL']) : undefined));
  if (defaultModel) result.defaultModel = defaultModel;

  if (envOriginal) {
    if (env && Object.keys(env).length > 0) {
      remaining.env = env;
    } else {
      delete remaining.env;
    }
  }

  if (Object.keys(remaining).length > 0) {
    result.advancedJson = JSON.stringify(remaining, null, 2);
  }

  return result;
}

// Claude Code 的模型类型别名（CLI 通过 env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL 映射到实际模型）。
// 顺序即"默认优先级"：sonnet 最常用，作为兜底默认。
const MODEL_ALIASES = ['sonnet', 'haiku', 'opus', 'fable'] as const;

function parseAdvancedEnv(advancedJson: string): Record<string, unknown> {
  try {
    const adv = JSON.parse(advancedJson || '{}');
    if (adv && adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)) {
      return adv.env as Record<string, unknown>;
    }
  } catch {
    // ignore malformed JSON
  }
  return {};
}

// 从 advancedJson 的 env 块提取「类型别名 → 实际模型」映射，供 UI 显示与默认模型推导复用。
export function extractModelMappings(advancedJson: string): Record<string, string> {
  const env = parseAdvancedEnv(advancedJson);
  const out: Record<string, string> = {};
  for (const alias of MODEL_ALIASES) {
    const v = env[`ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`];
    if (typeof v === 'string' && v.trim()) out[alias] = v.trim();
  }
  return out;
}

// 默认模型别名：取映射里第一个配好的（按 sonnet>haiku>opus>fable 优先级），都没有则 'sonnet'。
// 设计意图：用户只需配映射（或贴 settings.json），claude-link 自动决定默认用哪个去连 CLI，
// 不再需要单独的"模型"输入框。
export function resolveDefaultModel(advancedJson: string): string {
  const mappings = extractModelMappings(advancedJson);
  for (const alias of MODEL_ALIASES) {
    if (mappings[alias]) return alias;
  }
  return 'sonnet';
}

// 从 advancedJson 的 env 块读取单个值（不修改原 JSON），用于 apiKey/baseUrl 等字段的兜底。
export function peekEnvValue(advancedJson: string, key: string): string | undefined {
  const v = parseAdvancedEnv(advancedJson)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
