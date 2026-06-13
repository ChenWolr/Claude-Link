import type { AppConfig, ModelInfo } from '../../shared/types/config';

interface CacheEntry {
  expiresAt: number;
  models: ModelInfo[];
}

const cache = new Map<string, CacheEntry>();
const MODEL_CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchAvailableModels(
  provider: AppConfig['provider'],
  apiKey: string,
  apiBaseUrl?: string,
): Promise<ModelInfo[]> {
  const key = `${provider}:${apiKey.slice(-8)}`;
  const cached = cache.get(key);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  if (provider !== 'anthropic') {
    return [];
  }

  const baseUrl = apiBaseUrl?.trim() || 'https://api.anthropic.com';
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch models: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as {
    data?: Array<{ id: string; display_name?: string; max_output_tokens?: number }>;
  };

  const models = (payload.data ?? []).map((model) => ({
    id: model.id,
    name: model.display_name ?? model.id,
    maxTokens: model.max_output_tokens ?? 0,
  }));

  cache.set(key, {
    expiresAt: Date.now() + MODEL_CACHE_TTL_MS,
    models,
  });

  return models;
}
