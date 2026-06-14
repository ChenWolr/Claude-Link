import ElectronStoreModule from 'electron-store';
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import type { AppConfig } from '../../shared/types/config';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID } from '../../shared/constants';
import { logger } from '../utils/logger';
import { parseClaudeSettings } from './settings-importer';

interface StoredConfig extends Omit<AppConfig, 'apiKey' | 'advancedJson'> {
  encryptedApiKey: string | null;
  apiKeyEncoding: 'safeStorage' | 'plain' | null;
  advancedJson: string;
}

const ElectronStore =
  (ElectronStoreModule as unknown as { default?: typeof ElectronStoreModule }).default ??
  ElectronStoreModule;

const ElectronStoreCtor = ElectronStore as unknown as new (
  options?: {
    name?: string;
    projectName?: string;
    defaults?: StoredConfig;
  },
) => {
  store: StoredConfig;
  set(value: Partial<StoredConfig>): void;
  clear(): void;
};

const defaultConfig: StoredConfig = {
  provider: 'anthropic',
  providerName: 'Anthropic',
  providerNote: '',
  encryptedApiKey: null,
  apiKeyEncoding: null,
  apiBaseUrl: 'https://api.anthropic.com',
  defaultModel: 'claude-sonnet-4-6',
  advancedJson: '{}',
  cliPath: null,
  cliVersion: null,
  workingDirectory: null,
  permissionMode: 'default',
  maxTurns: 200,
  taskDelaySeconds: DEFAULT_TASK_DELAY_SECONDS,
  themePaletteId: DEFAULT_THEME_PALETTE_ID,
};

const store = new ElectronStoreCtor({
  name: 'claude-link-config',
  projectName: app.getName(),
  defaults: defaultConfig,
});

function encryptApiKey(apiKey: string): Pick<StoredConfig, 'encryptedApiKey' | 'apiKeyEncoding'> {
  if (!apiKey) {
    return { encryptedApiKey: null, apiKeyEncoding: null };
  }

  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(apiKey).toString('base64');
    return { encryptedApiKey: encrypted, apiKeyEncoding: 'safeStorage' };
  }

  logger.warn('safeStorage encryption is unavailable; storing API key without OS encryption.');
  return { encryptedApiKey: apiKey, apiKeyEncoding: 'plain' };
}

function decryptApiKey(config: StoredConfig): string {
  if (!config.encryptedApiKey) {
    return '';
  }

  if (config.apiKeyEncoding === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
    } catch (error) {
      logger.error('Failed to decrypt API key', error);
      return '';
    }
  }

  return config.encryptedApiKey;
}

export function getConfig(): AppConfig {
  const config = store.store;
  const advancedJsonRaw = typeof config.advancedJson === 'string' && config.advancedJson ? config.advancedJson : '{}';
  return {
    provider: config.provider,
    providerName: config.providerName ?? 'Anthropic',
    providerNote: config.providerNote ?? '',
    apiKey: decryptApiKey(config),
    apiBaseUrl: config.apiBaseUrl ?? 'https://api.anthropic.com',
    defaultModel: config.defaultModel,
    advancedJson: advancedJsonRaw,
    cliPath: config.cliPath,
    cliVersion: config.cliVersion,
    workingDirectory: config.workingDirectory,
    permissionMode: config.permissionMode,
    maxTurns: config.maxTurns,
    taskDelaySeconds: config.taskDelaySeconds,
    themePaletteId: config.themePaletteId ?? DEFAULT_THEME_PALETTE_ID,
  };
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const { apiKey, ...rest } = partial;
  const storage = { ...rest } as Partial<StoredConfig>;
  store.set(storage);

  if (apiKey !== undefined) {
    const encrypted = encryptApiKey(apiKey);
    store.set(encrypted);
  }

  return getConfig();
}

export function getDecryptedApiKey(): string | null {
  const apiKey = decryptApiKey(store.store);
  return apiKey || null;
}

export function hasApiKey(): boolean {
  return Boolean(getDecryptedApiKey());
}

export function clearConfig(): AppConfig {
  store.clear();
  store.set(defaultConfig);
  return getConfig();
}

export function importSettingsFile(filePath: string): {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  advancedJson: string;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseClaudeSettings(content);
}
