// Shared parser for Claude Code settings.json content.
// Used by BOTH main process (file import) and renderer ("从 JSON 填充字段"),
// so they apply identical extraction rules.
//
// Claude Code's real settings.json keeps the API key / base URL / model mappings
// inside an `env` object (e.g. env.ANTHROPIC_API_KEY, env.ANTHROPIC_BASE_URL,
// env.ANTHROPIC_DEFAULT_SONNET_MODEL), NOT at the top level. Older/imported
// shapes may also use top-level apiKey / apiBaseUrl / baseUrl / model — we accept
// both. Everything not extracted is preserved verbatim in advancedJson.

import type { ModelAlias } from './types/config';

export interface ImportedSettings {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  apiKeyHelper?: string;
  contextWindowByAlias?: Partial<Record<ModelAlias, number>>;
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

  // Default model：顶层 model > 首个有映射的类型别名（sonnet>haiku>opus>fable）> env.ANTHROPIC_MODEL。
  // 注意与 resolveDefaultModel（纯按别名优先）不同：显式顶层 model 总是胜出。
  // (Peek only — keep the model-mapping env vars intact in advancedJson.)
  const mappedAlias = env
    ? MODEL_ALIASES.find((a) => peekString(env, [`ANTHROPIC_DEFAULT_${a.toUpperCase()}_MODEL`]))
    : undefined;
  const defaultModel =
    takeString(remaining, 'model') ??
    mappedAlias ??
    (env ? peekString(env, ['ANTHROPIC_MODEL']) : undefined);
  if (defaultModel) result.defaultModel = defaultModel;

  // 上下文窗口按别名覆盖（env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>）：peek 转 number 回填。
  // peek 不删——保留在 env，与 apiKey/baseUrl/model-mapping 一致（advancedJson 是完整 settings.json）。
  const contextWindowByAlias: Partial<Record<ModelAlias, number>> = {};
  if (env) {
    for (const alias of MODEL_ALIASES) {
      const raw = env[`CLAUDE_LINK_CONTEXT_WINDOW_${alias.toUpperCase()}`];
      let n: number | null = null;
      if (typeof raw === 'number' && raw > 0) n = raw;
      else if (typeof raw === 'string' && Number.isFinite(Number(raw)) && Number(raw) > 0) n = Number(raw);
      if (n !== null) contextWindowByAlias[alias] = n;
    }
  }
  if (Object.keys(contextWindowByAlias).length > 0) result.contextWindowByAlias = contextWindowByAlias;

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

// 把「请求的模型」解析成传给 CLI --model 的实际值。
// 设计意图（问题 3 根因修复）：CLI 参数优先级高于 ~/.claude/settings.json，
// 所以 claude-link 自己把别名解析成实际模型名再用 --model 传入，确保 claude-link 的映射生效，
// 不再依赖会被 CC settings.json 覆盖的子进程 env。
// - requested 为已映射别名(sonnet/haiku/opus/fable) → 返回映射的实际模型名
// - requested 为空 → 取首个有映射别名的实际值（同 resolveDefaultModel 思路），都没有则 'sonnet'
// - 其它（用户填的自定义实际模型名 / 未映射别名）→ 原样返回
export function resolveAliasToActualModel(requested: string | null, advancedJson: string): string {
  const mappings = extractModelMappings(advancedJson);
  const req = requested?.trim();
  if (req && mappings[req]) return mappings[req];
  if (!req) {
    for (const alias of MODEL_ALIASES) {
      if (mappings[alias]) return mappings[alias];
    }
    return 'sonnet';
  }
  return req;
}

const STANDARD_ALIAS_MODELS: Record<string, string> = {
  sonnet: 'claude-sonnet-4-6',
  haiku: 'claude-haiku-4-5',
  opus: 'claude-opus-4-8',
  fable: 'claude-fable-5',
};

// 面向 HTTP/API 请求的实际模型解析：Messages API 不接受裸别名（sonnet/haiku/...）。
// 有映射时用映射值；无映射时用 config.defaultModel；若默认值本身仍是别名，则回落到标准 Claude 模型 ID。
export function resolveConfiguredActualModel(
  requested: string | null,
  advancedJson: string,
  fallbackModel: string,
): string {
  const resolved = resolveAliasToActualModel(requested, advancedJson).trim();
  if (resolved && !MODEL_ALIASES.includes(resolved as (typeof MODEL_ALIASES)[number])) return resolved;

  const fallback = fallbackModel.trim();
  return STANDARD_ALIAS_MODELS[fallback] || fallback || STANDARD_ALIAS_MODELS.sonnet;
}

export function resolveConfiguredDefaultModel(advancedJson: string, fallbackModel: string): string {
  return resolveConfiguredActualModel(resolveDefaultModel(advancedJson), advancedJson, fallbackModel);
}

// 从 advancedJson 的 env 块读取单个值（不修改原 JSON），用于 apiKey/baseUrl 等字段的兜底。
export function peekEnvValue(advancedJson: string, key: string): string | undefined {
  const v = parseAdvancedEnv(advancedJson)[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

// ── 表单字段 → advancedJson（纯函数）─────────────────────────────────────────────────
// 多供应商化后 UI 编辑入口已移除，现仅 selftest-settings-mapping 等脚本消费；
// 保留以保证与 parseClaudeSettings 的双向映射语义可测。
// 目的：把"输入框"（apiKey/apiBaseUrl/permissionMode/模型映射）写回 advancedJson，
// 与 parseClaudeSettings（JSON→字段）构成完整双向映射。纯函数返回新 JSON 字符串。

function cloneAdv(advancedJson: string): Record<string, unknown> {
  try {
    const adv = JSON.parse(advancedJson || '{}');
    if (adv && typeof adv === 'object' && !Array.isArray(adv)) {
      return adv as Record<string, unknown>;
    }
  } catch {
    // 非法 JSON 当作空对象，避免把用户半成品 JSON 冲掉
  }
  return {};
}

function ensureObject(adv: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = adv[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const obj: Record<string, unknown> = {};
  adv[key] = obj;
  return obj;
}

function dropEmptyEnv(adv: Record<string, unknown>): void {
  const env = adv.env;
  if (env && typeof env === 'object' && !Array.isArray(env) && Object.keys(env).length === 0) {
    delete adv.env;
  }
}

// apiKey/apiBaseUrl/permissionMode → advancedJson.env / permissions
export function syncFormToAdvancedJson(
  advancedJson: string,
  form: { apiKey: string; apiBaseUrl: string; permissionMode: string },
): string {
  const adv = cloneAdv(advancedJson);
  const env = ensureObject(adv, 'env');

  if (form.apiKey && form.apiKey.trim()) {
    env.ANTHROPIC_API_KEY = form.apiKey.trim();
  } else {
    delete env.ANTHROPIC_API_KEY;
  }

  const url = form.apiBaseUrl?.trim();
  // 官方端点不入 env（CLI 默认即官方），避免给 settings.json 留冗余键
  if (url && url !== 'https://api.anthropic.com') {
    env.ANTHROPIC_BASE_URL = url;
  } else {
    delete env.ANTHROPIC_BASE_URL;
  }

  const permissions = ensureObject(adv, 'permissions');
  // 'default' 表示 Claude Link 未显式覆盖权限模式；删除旧的 defaultMode，恢复原生
  // user/project/local settings 的优先级。只有非默认模式才写入 flag 层设置。
  if (form.permissionMode && form.permissionMode !== 'default') {
    permissions.defaultMode = form.permissionMode;
  } else {
    delete permissions.defaultMode;
    if (Object.keys(permissions).length === 0) delete adv.permissions;
  }

  dropEmptyEnv(adv);
  return JSON.stringify(adv, null, 2);
}

// 单个类型别名 → 实际模型 的映射，写入 env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL
export function setModelMappingInAdvancedJson(
  advancedJson: string,
  alias: string,
  value: string,
): string {
  const adv = cloneAdv(advancedJson);
  const env = ensureObject(adv, 'env');
  const key = `ANTHROPIC_DEFAULT_${alias.toUpperCase()}_MODEL`;
  const v = value.trim();
  if (v) {
    env[key] = v;
  } else {
    delete env[key];
  }
  dropEmptyEnv(adv);
  return JSON.stringify(adv, null, 2);
}

// 单个类型别名 → 上下文窗口（token 数）覆盖，写入 env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>。
// 与 setModelMappingInAdvancedJson 对称：表单字段即时写回 advancedJson（单一真相源；
// UI 入口已移除，仅脚本消费）。
// value 为 null/undefined/非正数时删 key（回落 200k 兜底）。
export function setContextWindowInAdvancedJson(
  advancedJson: string,
  alias: string,
  value: number | null | undefined,
): string {
  const adv = cloneAdv(advancedJson);
  const env = ensureObject(adv, 'env');
  const key = `CLAUDE_LINK_CONTEXT_WINDOW_${alias.toUpperCase()}`;
  if (typeof value === 'number' && value > 0) {
    env[key] = String(value);
  } else {
    delete env[key];
  }
  dropEmptyEnv(adv);
  return JSON.stringify(adv, null, 2);
}

// 清空"连接"相关 env：apiKey / authToken / baseUrl / 四个类型别名映射 /
// 四个 CLAUDE_LINK_CONTEXT_WINDOW_* 上下文窗口覆盖。
// 保留 env 里其它键（如 CLAUDE_CODE_*）。供"清空连接配置"使用，确保字段与 JSON 一并清空。
export function stripConnectionFromAdvancedJson(advancedJson: string): string {
  const adv = cloneAdv(advancedJson);
  const envObj =
    adv.env && typeof adv.env === 'object' && !Array.isArray(adv.env)
      ? (adv.env as Record<string, unknown>)
      : null;
  if (envObj) {
    delete envObj.ANTHROPIC_API_KEY;
    delete envObj.ANTHROPIC_AUTH_TOKEN;
    delete envObj.ANTHROPIC_BASE_URL;
    for (const alias of ['SONNET', 'HAIKU', 'OPUS', 'FABLE']) {
      delete envObj[`ANTHROPIC_DEFAULT_${alias}_MODEL`];
      delete envObj[`CLAUDE_LINK_CONTEXT_WINDOW_${alias}`];
    }
    if (Object.keys(envObj).length === 0) delete adv.env;
  }
  return JSON.stringify(adv, null, 2);
}
