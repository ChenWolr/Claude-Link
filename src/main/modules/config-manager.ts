import Store from 'electron-store';
import { safeStorage } from 'electron';
import type { AppConfig } from '../../shared/types/config';
import { DEFAULT_TASK_DELAY_SECONDS } from '../../shared/constants';
import { logger } from '../utils/logger';

interface StoredConfig extends Omit<AppConfig, 'apiKey'> {
  encryptedApiKey: string | null;
  apiKeyEncoding: 'safeStorage' | 'plain' | null;
}

const defaultConfig: StoredConfig = {
  provider: 'anthropic',
  encryptedApiKey: null,
  apiKeyEncoding: null,
  defaultModel: 'claude-sonnet-4-6',
  cliPath: null,
  cliVersion: null,
  workingDirectory: null,
  permissionMode: 'default',
  maxTurns: 200,
  taskDelaySeconds: DEFAULT_TASK_DELAY_SECONDS,
};

const store = new Store<StoredConfig>({
  name: 'claude-link-config',
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
  return {
    provider: config.provider,
    apiKey: decryptApiKey(config),
    defaultModel: config.defaultModel,
    cliPath: config.cliPath,
    cliVersion: config.cliVersion,
    workingDirectory: config.workingDirectory,
    permissionMode: config.permissionMode,
    maxTurns: config.maxTurns,
    taskDelaySeconds: config.taskDelaySeconds,
  };
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const { apiKey, ...rest } = partial;

  store.set(rest as Partial<StoredConfig>);

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
