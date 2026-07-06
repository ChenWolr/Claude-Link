import type { AppConfig } from '../../shared/types/config';
import { buildPermissionSettings } from './sdk-permissions';

function recordFromJson(json: string | null | undefined): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json || '{}') as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
  } catch {
    return {};
  }
}

function stringEnvFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const env: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === 'string') env[key] = item;
  }
  return env;
}

export function buildClaudeSettingsProjection(config: AppConfig): Record<string, unknown> {
  const advanced = recordFromJson(config.advancedJson);
  const env = stringEnvFrom(advanced.env);

  if (config.apiKey) env.ANTHROPIC_API_KEY = config.apiKey;
  const baseUrl = config.apiBaseUrl?.trim();
  if (baseUrl && baseUrl !== 'https://api.anthropic.com') env.ANTHROPIC_BASE_URL = baseUrl;

  return {
    ...advanced,
    permissions: buildPermissionSettings({
      permissionMode: config.permissionMode,
      advancedJson: config.advancedJson,
    }),
    env,
  };
}
