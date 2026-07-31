// config-manager.ts
// 配置存储（electron-store）+ apiKey 加密（safeStorage）。
//
// AppConfig 落盘到 claude-link-config.json；apiKey 单独用 safeStorage 加密存储。
// saveConfig 末尾触发 writeClaudeSettings，把配置投影成 <工作目录>/.claude/settings.local.json
// （让 permissions 等顶层字段也生效，对标 CC GUI；env 注入仍由 buildSpawnEnv 负责）。

import ElectronStoreModule from 'electron-store';
import { app, safeStorage } from 'electron';
import * as fs from 'fs';
import type { AppConfig, ModelAlias } from '../../shared/types/config';
import { isValidThinkingLevel } from '../../shared/types/thinking';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import { logger } from '../utils/logger';
import { parseClaudeSettings } from './settings-importer';
import { writeClaudeSettings, SKIP_NO_WORKDIR } from './settings-writer';

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
  fontScale: DEFAULT_FONT_SCALE,
  contextWindowByAlias: {},
  // 默认思考强度：medium 是五级中位，最接近原硬编码 adaptive 的「平衡」档，
  // 避免默认开高带来成本/延迟意外。投影层对 medium 不投影以尊重 ~/.claude 配置。
  defaultThinkingLevel: 'medium',
};

type ConfigStore = InstanceType<typeof ElectronStoreCtor>;
let store: ConfigStore | null = null;

function getStore(): ConfigStore {
  store ??= new ElectronStoreCtor({
    name: 'claude-link-config',
    projectName: app.getName(),
    defaults: defaultConfig,
  });
  return store;
}

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
  const config = getStore().store;
  const advancedJsonRaw = typeof config.advancedJson === 'string' && config.advancedJson ? config.advancedJson : '{}';
  // 脏值清洗：老版本无 defaultThinkingLevel 字段、或脏值/误存 'auto' 时回落 medium。
  // 存储层类型把该字段声明为非空非 auto，但运行时（旧库/手改 JSON）可能任意，故按 unknown 读取再校验。
  const rawThinkingLevel = config.defaultThinkingLevel as unknown;
  const defaultThinkingLevel =
    isValidThinkingLevel(rawThinkingLevel) && rawThinkingLevel !== 'auto' ? rawThinkingLevel : 'medium';
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
    fontScale: config.fontScale ?? DEFAULT_FONT_SCALE,
    contextWindowByAlias: config.contextWindowByAlias ?? {},
    defaultThinkingLevel,
  };
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const { apiKey, ...rest } = partial;
  const storage = { ...rest } as Partial<StoredConfig>;
  getStore().set(storage);

  if (apiKey !== undefined) {
    const encrypted = encryptApiKey(apiKey);
    getStore().set(encrypted);
  }

  const config = getConfig();
  // 投影成 Claude Code settings.local.json（对标 CC GUI），让 permissions 等顶层字段生效。
  // workingDirectory 为 null 时静默跳过（env 注入仍走 buildSpawnEnv）。
  try {
    const result = writeClaudeSettings(config.workingDirectory, config);
    if (!result.ok && result.error !== SKIP_NO_WORKDIR) {
      logger.warn(`settings.local.json 写入跳过：${result.error}`);
    }
  } catch (e) {
    logger.warn(`settings.local.json 写入跳过：${e instanceof Error ? e.message : String(e)}`);
  }
  return config;
}

export function getDecryptedApiKey(): string | null {
  const apiKey = decryptApiKey(getStore().store);
  return apiKey || null;
}

export function hasApiKey(): boolean {
  return Boolean(getDecryptedApiKey());
}

export function clearConfig(): AppConfig {
  getStore().clear();
  getStore().set(defaultConfig);
  return getConfig();
}

export function importSettingsFile(filePath: string): {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  contextWindowByAlias?: Partial<Record<ModelAlias, number>>;
  advancedJson: string;
} {
  const content = fs.readFileSync(filePath, 'utf-8');
  return parseClaudeSettings(content);
}
