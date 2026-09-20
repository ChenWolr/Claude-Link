// 模型查询：按供应商档案拉取端点支持的全部模型（doc1 §4）。
// 任何档案都先尝试 Anthropic 风格 GET {base}/v1/models（x-api-key + anthropic-version）；
// 404/401 时自动回退 OpenAI 风格（Authorization: Bearer，同 path），两种响应都归一化为 ModelInfo[]。
// 缓存 key = profile.id，TTL 1h；「查询」按钮带强制刷新语义（forceRefresh 绕过缓存）。
// 【连接面声明】本模块是主进程 HTTP 直连白名单成员（契约：scripts/regression-tests.ts 连接面白名单）；
// SDK 无 /v1/models 查询能力故直连属设计内，凭据/端点经供应商档案解密与生产同源。
import type { ModelInfo, ProviderProfile } from '../../shared/types/config';
import { buildAnthropicApiUrl } from './api-url';

interface CacheEntry {
  expiresAt: number;
  models: ModelInfo[];
}

const cache = new Map<string, CacheEntry>();
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export function clearProviderModelsCache(providerId?: string): void {
  if (providerId === undefined) cache.clear();
  else cache.delete(providerId);
}

// Anthropic /v1/models 响应归一化（纯函数，selftest 行为测试用）。
export function normalizeAnthropicModelsPayload(
  payload: unknown,
): ModelInfo[] {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model) => {
      const m = model as { id?: unknown; display_name?: unknown; max_output_tokens?: unknown; max_tokens?: unknown; context_length?: unknown };
      if (typeof m.id !== 'string' || !m.id.trim()) return null;
      return {
        id: m.id,
        name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : m.id,
        maxTokens:
          (typeof m.max_output_tokens === 'number' ? m.max_output_tokens : undefined) ??
          (typeof m.max_tokens === 'number' ? m.max_tokens : undefined) ??
          // hb13-v B5（hb12-PRV-04）：条目级形状探测——接受 x-api-key 却返回 OpenAI 形状条目
          // 的网关（new-api/one-api 常见）缺 max_output_tokens/max_tokens，按 context_length
          // 兜底；不再产出 0（显示「—/空」丢输出上限），Anthropic 先归一化也不再短路 OpenAI 端点信息。
          (typeof m.context_length === 'number' ? m.context_length : 0),
      } satisfies ModelInfo;
    })
    .filter((m): m is ModelInfo => m !== null);
}

// OpenAI /v1/models 响应归一化：{object:"list", data:[{id, ...}]} 标准形状无 display_name/max_output_tokens；
// 此处宽容兼容中转端点扩展——读 display_name 兜名、context_length 作 maxTokens，均缺省归 0/回退 id。
export function normalizeOpenAiModelsPayload(payload: unknown): ModelInfo[] {
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];
  return data
    .map((model) => {
      const m = model as { id?: unknown; display_name?: unknown; context_length?: unknown };
      if (typeof m.id !== 'string' || !m.id.trim()) return null;
      return {
        id: m.id,
        name: typeof m.display_name === 'string' && m.display_name.trim() ? m.display_name : m.id,
        maxTokens: typeof m.context_length === 'number' ? m.context_length : 0,
      } satisfies ModelInfo;
    })
    .filter((m): m is ModelInfo => m !== null);
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    const text = (await response.text()).trim();
    return text.slice(0, 200);
  } catch {
    return '';
  }
}

async function fetchModelsOnce(
  url: URL,
  headers: Record<string, string>,
  normalize: (payload: unknown) => ModelInfo[],
): Promise<ModelInfo[]> {
  // hb10-PRV-07：15s 超时——挂起端点不再让查询按钮无限 loading（AbortSignal.timeout）。
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    const err = new Error(`HTTP ${response.status} ${response.statusText}`) as Error & { status?: number; body?: string };
    err.status = response.status;
    err.body = await readErrorBody(response);
    throw err;
  }
  const payload = (await response.json()) as unknown;
  // 双形状兼容：同一端点两种布局（Anthropic data[{id,display_name,max_output_tokens}] 与
  // OpenAI data[{id}]）都试，先按主风格归一化，空结果再用另一风格兜底（不额外发请求）。
  const primary = normalize(payload);
  if (primary.length > 0) return primary;
  return normalize === normalizeAnthropicModelsPayload
    ? normalizeOpenAiModelsPayload(payload)
    : normalizeAnthropicModelsPayload(payload);
}

// hb10-PRV-07：同供应商 in-flight 查询表（Promise 共享；完成后清除）。
const inflightFetches = new Map<string, Promise<ModelInfo[]>>();

export function fetchAvailableModels(
  profile: Pick<ProviderProfile, 'id' | 'apiBaseUrl'>,
  apiKey: string,
  forceRefresh = false,
): Promise<ModelInfo[]> {
  // hb10-PRV-07：双击/并发单请求（复用在途 Promise；结束后清除）。
  const existing = inflightFetches.get(profile.id);
  if (existing) return existing;
  const p = fetchAvailableModelsImpl(profile, apiKey, forceRefresh).finally(() => inflightFetches.delete(profile.id));
  inflightFetches.set(profile.id, p);
  return p;
}

async function fetchAvailableModelsImpl(
  profile: Pick<ProviderProfile, 'id' | 'apiBaseUrl'>,
  apiKey: string,
  forceRefresh = false,
): Promise<ModelInfo[]> {
  const key = profile.id;
  if (!forceRefresh) {
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.models;
    }
  } else {
    cache.delete(key);
  }

  const url = buildAnthropicApiUrl(profile.apiBaseUrl, 'models');

  let models: ModelInfo[];
  try {
    // 先 Anthropic 风格（官方与大多数中转/网关兼容层）。
    models = await fetchModelsOnce(url, {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    }, normalizeAnthropicModelsPayload);
  } catch (error) {
    const status = (error as { status?: number }).status;
    // 404（端点无 /models）或 401（只认 Bearer）→ 回退 OpenAI 风格；其余错误直接抛。
    if (status !== 404 && status !== 401) throw error;
    try {
      models = await fetchModelsOnce(url, { Authorization: `Bearer ${apiKey}` }, normalizeOpenAiModelsPayload);
    } catch (fallbackError) {
      const f = fallbackError as { status?: number; body?: string; message?: string };
      const primary = error as { message?: string; body?: string };
      throw new Error(
        `查询失败：Anthropic 风格 ${primary.message ?? '错误'}${primary.body ? `（${primary.body}）` : ''}；` +
          `OpenAI 回退 ${f.message ?? '错误'}${f.body ? `（${f.body}）` : ''}`,
      );
    }
  }

  cache.set(key, {
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    models,
  });
  return models;
}
