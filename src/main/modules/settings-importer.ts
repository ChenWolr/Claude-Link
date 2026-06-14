export interface ImportedSettings {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  advancedJson: string;
}

export function parseClaudeSettings(content: string): ImportedSettings {
  const settings = JSON.parse(content) as Record<string, unknown>;

  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('settings.json must contain a JSON object');
  }

  const remaining: Record<string, unknown> = { ...settings };
  const result: ImportedSettings = { advancedJson: '{}' };

  if (typeof remaining.apiKey === 'string') {
    result.apiKey = remaining.apiKey;
    delete remaining.apiKey;
  }

  if (typeof remaining.apiBaseUrl === 'string') {
    result.apiBaseUrl = remaining.apiBaseUrl;
    delete remaining.apiBaseUrl;
  } else if (typeof remaining.baseUrl === 'string') {
    result.apiBaseUrl = remaining.baseUrl;
    delete remaining.baseUrl;
  }

  if (typeof remaining.model === 'string') {
    result.defaultModel = remaining.model;
    delete remaining.model;
  }

  if (Object.keys(remaining).length > 0) {
    result.advancedJson = JSON.stringify(remaining, null, 2);
  }

  return result;
}
