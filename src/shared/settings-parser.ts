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
