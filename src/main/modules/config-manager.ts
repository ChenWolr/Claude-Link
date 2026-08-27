// config-manager.ts
// 配置存储（electron-store）+ apiKey 加密（safeStorage）+ 多供应商模型库。
//
// AppConfig 落盘到 claude-link-config.json；apiKey（全局 + 每档案）单独用 safeStorage 加密存储。
// saveConfig 末尾触发 writeClaudeSettings，把配置投影成 <工作目录>/.claude/settings.local.json
// （让 permissions 等顶层字段也生效，对标 CC GUI；env 注入仍由 buildSpawnEnv 负责）。
//
// 多供应商库（r3-r9）：设置页只维护可选的供应商与模型，无「使用中/默认」选用语义；
// AppConfig.lastUsedProviderId/lastUsedModelId 是「最近一次会话选用」的记忆性字段（新会话初始值）。
// 档案密钥（明文/密文）只在本模块与主进程内存中；renderer 经 listProviderProfiles 只拿掩码视图。
// 老字段（providerName/apiKey/apiBaseUrl/defaultModel…）= lastUsed 档案的投影，
// buildSpawnEnv / settings-writer / connection-tester 继续读老字段，主链路零改动。

import ElectronStoreModule from 'electron-store';
import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import * as fs from 'fs';
import type {
  AppConfig,
  ModelAlias,
  ProviderProfileView,
  ProviderSaveInput,
  ProviderLibrarySnapshot,
  StoredProviderProfile,
} from '../../shared/types/config';
import type { ProviderModelSource } from '../../shared/session-model';
import { isValidThinkingLevel } from '../../shared/types/thinking';
import { isValidPermissionMode } from '../../shared/permission-resolver';
import { DEFAULT_TASK_DELAY_SECONDS, DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import { buildLegacyProviderProfile, maskApiKey, sanitizeProviderModels } from '../../shared/provider-library';
import { logger } from '../utils/logger';
import { parseClaudeSettings } from './settings-importer';
import { writeClaudeSettings, SKIP_NO_WORKDIR } from './settings-writer';

interface StoredConfig
  extends Omit<
    AppConfig,
    'apiKey' | 'advancedJson' | 'providerProfiles' | 'lastUsedProviderId' | 'lastUsedModelId'
  > {
  encryptedApiKey: string | null;
  apiKeyEncoding: 'safeStorage' | 'plain' | null;
  advancedJson: string;
  // 注意：这三项**不进 defaults**（见 defaultConfig 注释），迁移守卫靠 has() 判「键是否已落盘」。
  providerProfiles?: StoredProviderProfile[];
  lastUsedProviderId?: string | null;
  lastUsedModelId?: string | null;
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
  has(key: keyof StoredConfig): boolean;
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
  // 失焦系统通知默认开（保留既有「完成/中断时弹通知」行为）；后台运行默认关（保持「关闭即退出」）。
  notifyOnLeave: true,
  minimizeToTray: false,
  // reasoning_replay 自动重试默认开（韧性层：同形状重放大概率通过，单次重试覆盖间歇性命中）。
  autoRetryReasoningReplay: true,
  // ⚠️ providerProfiles / lastUsedProviderId / lastUsedModelId 故意不设默认值：
  // electron-store 的 defaults 会并入 store 视图参与 has() 判定，一旦给了默认值
  // （哪怕是 []），「键是否存在」永远是 true，ensureProviderMigration 的迁移守卫
  // 就永远跳过——老用户升级路径会静默断裂（CDP 冒烟实测抓到）。所有读点用 ?? 兜底。
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

// 档案密钥解密（connection-tester 行内测试用；只在主进程内流转）。
export function decryptProviderApiKey(profile: StoredProviderProfile): string {
  if (!profile.encryptedApiKey) return '';
  if (profile.apiKeyEncoding === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(profile.encryptedApiKey, 'base64'));
    } catch (error) {
      logger.error(`Failed to decrypt API key for provider ${profile.id}`, error);
      return '';
    }
  }
  return profile.encryptedApiKey;
}

export function getConfig(): AppConfig {
  const config = getStore().store;
  const advancedJsonRaw = typeof config.advancedJson === 'string' && config.advancedJson ? config.advancedJson : '{}';
  // 脏值清洗：老版本无 defaultThinkingLevel 字段、或脏值/误存 'auto' 时回落 medium。
  // 存储层类型把该字段声明为非空非 auto，但运行时（旧库/手改 JSON）可能任意，故按 unknown 读取再校验。
  const rawThinkingLevel = config.defaultThinkingLevel as unknown;
  const defaultThinkingLevel =
    isValidThinkingLevel(rawThinkingLevel) && rawThinkingLevel !== 'auto' ? rawThinkingLevel : 'medium';
  // 脏值清洗：老版本/手改 JSON 可能给 permissionMode 存非法值，回落 'default'。
  const rawPermissionMode = config.permissionMode as unknown;
  const permissionMode = isValidPermissionMode(rawPermissionMode) ? rawPermissionMode : 'default';
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
    permissionMode,
    maxTurns: config.maxTurns,
    taskDelaySeconds: config.taskDelaySeconds,
    themePaletteId: config.themePaletteId ?? DEFAULT_THEME_PALETTE_ID,
    fontScale: config.fontScale ?? DEFAULT_FONT_SCALE,
    contextWindowByAlias: config.contextWindowByAlias ?? {},
    defaultThinkingLevel,
    lastUsedProviderId: config.lastUsedProviderId ?? null,
    lastUsedModelId: config.lastUsedModelId ?? null,
    notifyOnLeave: config.notifyOnLeave ?? true,
    minimizeToTray: config.minimizeToTray ?? false,
    // 老配置无此键时默认开（electron-store defaults 兜底，?? true 双保险）。
    autoRetryReasoningReplay: config.autoRetryReasoningReplay ?? true,
  };
}

// 把 lastUsed 档案投影回 AppConfig 老字段（providerName/apiKey/apiBaseUrl/defaultModel），
// 并写 settings.local.json。任何供应商库变更（增删改/换 lastUsed/saveConfig）后调用，
// 保证老链路（buildSpawnEnv 兜底 / settings-writer / connection-tester 兜底）看到一致的投影。
function projectLegacyFields(): void {
  const s = getStore();
  const profiles = s.store.providerProfiles ?? [];
  let lastUsedProviderId = s.store.lastUsedProviderId ?? null;
  let lastUsedModelId = s.store.lastUsedModelId ?? null;

  let profile = profiles.find((p) => p.id === lastUsedProviderId) ?? null;
  if (!profile && profiles.length > 0) {
    profile = profiles[0];
    lastUsedProviderId = profile.id;
  }
  if (!profile) {
    lastUsedProviderId = null;
    lastUsedModelId = null;
  } else if (!lastUsedModelId || !profile.models.some((m) => m.id === lastUsedModelId)) {
    lastUsedModelId = profile.models[0]?.id ?? null;
  }

  const patch: Partial<StoredConfig> = { lastUsedProviderId, lastUsedModelId };
  if (profile) {
    patch.providerName = profile.name;
    patch.providerNote = profile.note;
    patch.apiBaseUrl = profile.apiBaseUrl;
    patch.encryptedApiKey = profile.encryptedApiKey;
    patch.apiKeyEncoding = profile.apiKeyEncoding;
    patch.defaultModel = lastUsedModelId ?? '';
  }
  s.set(patch);

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
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const { apiKey, ...rest } = partial;
  const storage = { ...rest } as Partial<StoredConfig>;
  delete (storage as Partial<StoredConfig>).providerProfiles; // 档案只经 saveProviderProfile 变更
  getStore().set(storage);

  if (apiKey !== undefined) {
    const encrypted = encryptApiKey(apiKey);
    getStore().set(encrypted);
  }

  // 老字段是库的投影：渲染层整份 saveConfig（自动保存）可能带回陈旧的投影字段，
  // 这里重新断言库的权威值，再统一写 settings.local.json。
  projectLegacyFields();
  return getConfig();
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

// ── 多供应商库：迁移 + CRUD ────────────────────────────────────────────

// 一次性迁移（启动时检测，幂等）：无 providerProfiles 键 且老单供应商配置非空 →
// 生成一个档案（models 含现 defaultModel 一条），lastUsed 指向它。老字段保留为投影源。
export function ensureProviderMigration(): void {
  const s = getStore();
  if (s.has('providerProfiles')) return; // 键已存在（含空数组）即已迁移过

  const current = s.store;
  const legacyApiKey = decryptApiKey(current);
  const migrated = buildLegacyProviderProfile(
    {
      providerName: current.providerName ?? '',
      providerNote: current.providerNote ?? '',
      apiBaseUrl: current.apiBaseUrl ?? '',
      defaultModel: current.defaultModel ?? '',
      hasApiKey: Boolean(legacyApiKey),
    },
    randomUUID(),
    Date.now(),
  );

  const profiles: StoredProviderProfile[] = [];
  if (migrated) {
    profiles.push({ ...migrated, ...encryptApiKey(legacyApiKey) });
    logger.info(
      `已迁移老单供应商配置为档案「${migrated.name}」（${migrated.models.length} 个模型）`,
    );
  }
  s.set({
    providerProfiles: profiles,
    lastUsedProviderId: migrated?.id ?? null,
    lastUsedModelId: migrated?.models[0]?.id ?? null,
  });
  projectLegacyFields();
}

function toProviderView(profile: StoredProviderProfile): ProviderProfileView {
  const apiKey = decryptProviderApiKey(profile);
  return {
    id: profile.id,
    name: profile.name,
    note: profile.note,
    apiBaseUrl: profile.apiBaseUrl,
    models: profile.models,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    apiKeyMasked: maskApiKey(apiKey),
    hasApiKey: Boolean(apiKey),
  };
}

export function getLibrarySnapshot(): ProviderLibrarySnapshot {
  const s = getStore();
  return {
    providers: (s.store.providerProfiles ?? []).map(toProviderView),
    lastUsedProviderId: s.store.lastUsedProviderId ?? null,
    lastUsedModelId: s.store.lastUsedModelId ?? null,
  };
}

// spawn 链的解析输入：档案 + 解密 key（只在主进程内流转）。
export function getProviderModelSources(): ProviderModelSource[] {
  const s = getStore();
  return (s.store.providerProfiles ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    apiBaseUrl: p.apiBaseUrl,
    apiKey: decryptProviderApiKey(p),
    models: p.models,
  }));
}

export function getStoredProviderProfile(id: string): StoredProviderProfile | undefined {
  return (getStore().store.providerProfiles ?? []).find((p) => p.id === id);
}

function validateProviderInput(input: ProviderSaveInput): { name: string; note: string; apiBaseUrl: string } {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const apiBaseUrl = typeof input.apiBaseUrl === 'string' ? input.apiBaseUrl.trim() : '';
  if (!name) throw new Error('供应商名称为必填');
  if (!apiBaseUrl) throw new Error('请求地址（API Base URL）为必填');
  try {
    const url = new URL(apiBaseUrl);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    throw new Error('请求地址必须是合法的 http(s) URL');
  }
  return { name, note: typeof input.note === 'string' ? input.note.trim() : '', apiBaseUrl };
}

// 新增/更新档案。apiKey 明文只在此刻进入主进程，落盘前加密；编辑时省略 = 保留原密钥。
export function saveProviderProfile(input: ProviderSaveInput): ProviderProfileView {
  const s = getStore();
  const fields = validateProviderInput(input);
  const models = sanitizeProviderModels(input.models);
  const now = Date.now();
  const existing = input.id ? getStoredProviderProfile(input.id) : undefined;
  if (input.id && !existing) throw new Error(`供应商 ${input.id} 不存在`);

  let saved: StoredProviderProfile;
  if (existing) {
    saved = {
      ...existing,
      ...fields,
      models: input.models === undefined ? existing.models : models,
      updatedAt: now,
    };
    if (input.apiKey !== undefined && input.apiKey !== null) {
      const plain = input.apiKey.trim();
      saved = { ...saved, ...encryptApiKey(plain) };
    }
  } else {
    const plain = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    saved = {
      id: randomUUID(),
      ...fields,
      ...encryptApiKey(plain),
      models,
      createdAt: now,
      updatedAt: now,
    };
  }

  const profiles = (s.store.providerProfiles ?? []).filter((p) => p.id !== saved.id);
  // 新建即成为最近选用（库的第一个用户动作）；编辑保持 lastUsed 不动。
  const wasEmpty = profiles.length === 0;
  profiles.push(saved);
  s.set({ providerProfiles: profiles });
  if (wasEmpty) {
    s.set({ lastUsedProviderId: saved.id, lastUsedModelId: saved.models[0]?.id ?? null });
  }
  projectLegacyFields();
  return toProviderView(saved);
}

// 删除档案。删除的完整档案（含加密 key）暂存内存，供「撤销」恢复；再删下一个会覆盖上一个。
let lastDeletedProvider: StoredProviderProfile | null = null;

export function deleteProviderProfile(id: string): void {
  const s = getStore();
  const profiles = s.store.providerProfiles ?? [];
  const index = profiles.findIndex((p) => p.id === id);
  if (index < 0) throw new Error(`供应商 ${id} 不存在`);
  lastDeletedProvider = profiles[index];
  profiles.splice(index, 1);
  s.set({ providerProfiles: [...profiles] });
  projectLegacyFields();
}

// 撤销最近一次删除（恢复原 id/模型/密钥，回到列表尾部）。无暂存或 id 已被占用时报错。
export function restoreDeletedProvider(): ProviderProfileView {
  if (!lastDeletedProvider) throw new Error('没有可撤销的供应商删除');
  const s = getStore();
  const profiles = s.store.providerProfiles ?? [];
  if (profiles.some((p) => p.id === lastDeletedProvider!.id)) {
    throw new Error('撤销失败：同名 ID 已存在');
  }
  const restored = lastDeletedProvider;
  lastDeletedProvider = null;
  s.set({ providerProfiles: [...profiles, restored] });
  projectLegacyFields();
  return toProviderView(restored);
}

// 会话选用成功后更新「最近使用」记忆 + 重投影老字段。
// 供应商/模型不存在时静默跳过（解析层会走回退链，不在此抛错）。
export function recordLastUsedProviderModel(providerId: string, modelId: string): void {
  const s = getStore();
  const profile = getStoredProviderProfile(providerId);
  if (!profile || !profile.models.some((m) => m.id === modelId)) return;
  s.set({ lastUsedProviderId: providerId, lastUsedModelId: modelId });
  projectLegacyFields();
}
