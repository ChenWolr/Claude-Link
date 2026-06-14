export function normalizeApiBaseUrl(apiBaseUrl?: string | null): string {
  const raw = apiBaseUrl?.trim() || 'https://api.anthropic.com';
  return raw.replace(/\/+$/, '');
}

export function isOfficialAnthropicBaseUrl(apiBaseUrl?: string | null): boolean {
  try {
    const url = new URL(normalizeApiBaseUrl(apiBaseUrl));
    return url.hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

export function buildAnthropicApiUrl(apiBaseUrl: string | undefined | null, resourcePath: string): URL {
  const base = normalizeApiBaseUrl(apiBaseUrl);
  const resource = resourcePath.replace(/^\/+/, '');
  const baseWithVersion = base.endsWith('/v1') ? base : `${base}/v1`;
  return new URL(`${baseWithVersion}/${resource}`);
}
