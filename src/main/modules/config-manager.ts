// config-manager.ts
// 配置存储（electron-store）+ apiKey 加密（safeStorage）+ 多供应商模型库。
//
// AppConfig 落盘到 claude-link-config.json；apiKey（全局 + 每档案）单独用 safeStorage 加密存储。
// saveConfig 末尾触发 writeClaudeSettings，把配置投影成 <工作目录>/.claude/settings.local.json
// （让 permissions 等顶层字段也生效，对标 CC GUI；env 注入仍由 buildSpawnEnv 负责）。
//
// 多供应商库（r3-r9）：设置页只维护可选的供应商与模型，无「使用中/默认」选用语义；
// AppConfig.lastUsedProviderId/lastUsedModelId 是「最近一次会话选用」的记忆性字段（新会话初始值）。
// 档案密钥（明文/密文）只在本模块与主进程内存中；renderer 经 config:listProviders
//（getLibrarySnapshot → ProviderProfileView）只拿掩码视图。
// 老字段（providerName/apiKey/apiBaseUrl/defaultModel…）= lastUsed 档案的投影；
// 当前唯一消费点是 buildSpawnEnv 无会话 override 时的兜底（settings-writer 已不投影端点凭据、
// connection-tester 行内测试直读档案）。

import ElectronStoreModule from 'electron-store';
import { safeStorage } from 'electron';
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
import { DEFAULT_THEME_PALETTE_ID, DEFAULT_FONT_SCALE } from '../../shared/constants';
import { sanitizeTaskDelayMinutes, DEFAULT_TASK_DELAY_MINUTES } from '../../shared/queue-config';
import { sanitizeMaxTurns } from '../../shared/max-turns';
import { sanitizeSkillOverridesConfig } from './sdk-skill-overrides';
import { clearProviderModelsCache } from './model-resolver';
import { resetCliDetectionCache } from './cli-detector';
import * as path from 'path';
import { clearProjectionSnapshot } from './settings-projection-merge';
import { buildLegacyProviderProfile, maskApiKey, sanitizeProviderModels } from '../../shared/provider-library';
import { logger } from '../utils/logger';
import { createSafeStore } from '../utils/safe-store';
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
  // hb10-CFG-10：显式删除键（clear 后免 set(defaultConfig) 逐键重写）。
  delete(key: keyof StoredConfig): void;
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
  queueEnabled: false,
  taskDelayMinutes: DEFAULT_TASK_DELAY_MINUTES,
  themePaletteId: DEFAULT_THEME_PALETTE_ID,
  fontScale: DEFAULT_FONT_SCALE,
  contextWindowByAlias: {},
  // 默认思考强度：medium 是五级中位，最接近原硬编码 adaptive 的「平衡」档，
  // 避免默认开高带来成本/延迟意外。投影层对 medium 不投影以尊重 ~/.claude 配置。
  defaultThinkingLevel: 'medium',
  // 引擎后台请求六开关默认全开（用户定案 09-05：UI 已隐藏，默认注入全部六键——
  // 关闭引擎记忆/后台任务/定时/问卷/遥测/非必要联网；存量配置显式 false 仍优先）。
  disableAutoMemory: true,
  disableBackgroundTasks: true,
  disableCron: true,
  disableFeedbackSurvey: true,
  disableTelemetry: true,
  disableNonessentialTraffic: true,
  // 失焦系统通知默认开（保留既有「完成/中断时弹通知」行为）；后台运行默认关（保持「关闭即退出」）。
  notifyOnLeave: true,
  minimizeToTray: false,
  // reasoning_replay 自动重试默认开（韧性层：同形状重放大概率通过，单次重试覆盖间歇性命中）。
  autoRetryReasoningReplay: true,
  // 全局 skill 禁用开关默认空（全部启用）；脏值兜底只在读路径（getConfig → sanitizeConfig
  // 清洗为 {}），saveConfig/CONFIG_SAVE 写路径无 skillOverrides 专项清洗、原样落盘
  //（S2 review 核实更正：原「写路径读路径各有一道」与事实不符；现状判定无害，不新增写清洗）。
  skillOverrides: {},
  // ⚠️ providerProfiles / lastUsedProviderId / lastUsedModelId 故意不设默认值：
  // electron-store 的 defaults 会并入 store 视图参与 has() 判定，一旦给了默认值
  // （哪怕是 []），「键是否存在」永远是 true，ensureProviderMigration 的迁移守卫
  // 就永远跳过——老用户升级路径会静默断裂（CDP 冒烟实测抓到）。所有读点用 ?? 兜底。
};

type ConfigStore = InstanceType<typeof ElectronStoreCtor>;
let store: ConfigStore | null = null;

// 配置落盘回调：主进程消费方（如托盘随 minimizeToTray 开关增删）在 saveConfig/clearConfig
// 完成后联动。用回调而非让 index.ts 直接监听 IPC，避免 ipc-handlers ↔ index 循环依赖。
type ConfigSavedListener = () => void;
const configSavedListeners = new Set<ConfigSavedListener>();

export function onConfigSaved(listener: ConfigSavedListener): () => void {
  configSavedListeners.add(listener);
  return () => configSavedListeners.delete(listener);
}

function emitConfigSaved(): void {
  for (const listener of configSavedListeners) {
    try {
      listener();
    } catch (e) {
      logger.error('onConfigSaved listener failed', e);
    }
  }
}

function getStore(): ConfigStore {
  // hb10-CFG-V01：坏 JSON 自愈（safe-store helper 统一实现——启动初始化链不再全跳）。
  store ??= createSafeStore<ConfigStore>({
    name: 'claude-link-config',
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

// hb10 P2-4：safeStorage 解密失败哨兵——解密失败（换机/重装后系统凭据库无对应条目）与
// 未配置必须可区分：spawn 注入按空处理（行为不变），面板显示损坏态而非「未设置」。
export const DECRYPT_FAILED = '__claude_link_decrypt_failed__';

function decryptApiKey(config: StoredConfig): string {
  if (!config.encryptedApiKey) {
    return '';
  }

  if (config.apiKeyEncoding === 'safeStorage') {
    try {
      return safeStorage.decryptString(Buffer.from(config.encryptedApiKey, 'base64'));
    } catch (error) {
      logger.error('Failed to decrypt API key', error);
      return DECRYPT_FAILED;
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
      return DECRYPT_FAILED;
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
  // hb10 P2-4：解密失败以哨兵向上传递——spawn 消费点判哨兵按空处理；面板路径据此显示损坏态。
  // apiKeyBroken 是派生标记（非存储字段）：仅损坏态存在该键，未损坏不产出 undefined 键
  //（避免渲染层整份回显把 undefined 送进 conf.set 抛错）。
  const rawApiKey = decryptApiKey(config);
  return {
    provider: config.provider,
    providerName: config.providerName ?? 'Anthropic',
    providerNote: config.providerNote ?? '',
    apiKey: rawApiKey,
    ...(rawApiKey === DECRYPT_FAILED ? { apiKeyBroken: true as const } : {}),
    apiBaseUrl: config.apiBaseUrl ?? 'https://api.anthropic.com',
    defaultModel: config.defaultModel,
    advancedJson: advancedJsonRaw,
    cliPath: config.cliPath,
    cliVersion: config.cliVersion,
    workingDirectory: config.workingDirectory,
    permissionMode,
    maxTurns: sanitizeMaxTurns(config.maxTurns),
    queueEnabled: config.queueEnabled ?? false,
    taskDelayMinutes: sanitizeTaskDelayMinutes(config.taskDelayMinutes),
    themePaletteId: config.themePaletteId ?? DEFAULT_THEME_PALETTE_ID,
    fontScale: config.fontScale ?? DEFAULT_FONT_SCALE,
    contextWindowByAlias: config.contextWindowByAlias ?? {},
    defaultThinkingLevel,
    // 引擎后台请求六开关收敛：默认全开（?? true 兜底，UI 已隐藏）；存量配置显式 false 优先。
    // disableNonessentialTraffic 字段名沿用旧单开关，存量配置免费迁移到第 6 开关
    //（旧值 false 会压住默认 true，用户配置文件已同步翻转为 true）。
    disableAutoMemory: config.disableAutoMemory ?? true,
    disableBackgroundTasks: config.disableBackgroundTasks ?? true,
    disableCron: config.disableCron ?? true,
    disableFeedbackSurvey: config.disableFeedbackSurvey ?? true,
    disableTelemetry: config.disableTelemetry ?? true,
    disableNonessentialTraffic: config.disableNonessentialTraffic ?? true,
    lastUsedProviderId: config.lastUsedProviderId ?? null,
    lastUsedModelId: config.lastUsedModelId ?? null,
    notifyOnLeave: config.notifyOnLeave ?? true,
    minimizeToTray: config.minimizeToTray ?? false,
    // 老配置无此键时默认开（electron-store defaults 兜底，?? true 双保险）。
    autoRetryReasoningReplay: config.autoRetryReasoningReplay ?? true,
    // 全局 skill 禁用开关：脏值（非对象/非法档位）清洗为 {}（= 全启用），存量配置无此键时同样兜底。
    skillOverrides: sanitizeSkillOverridesConfig(config.skillOverrides),
  };
}

// R2（复查 2026-09-08）：「删光供应商」删除事件置位（本进程内）。projectLegacyFields 的补清
// 分支只在此旗标已置位时触发——P2-4 补清的目标仅是「库从非空变空」后 saveConfig 带回的陈旧
// 回声；库**从未非空**的老字段直配用户（库一直为空 + 无全局 Key + 自定义端点/模型）不得被
// saveConfig 重置到官方默认。不用「被动观测库长度」：重启后已有库的进程里
// ensureProviderMigration 对已存在键早退、无观测机会，删光后的补清会漏。
let libraryEmptiedByDeletion = false;

// 把 lastUsed 档案投影回 AppConfig 老字段（providerName/apiKey/apiBaseUrl/defaultModel），
// 并写 settings.local.json。任何供应商库变更（增删改/换 lastUsed/saveConfig）后调用，
// 保证老链路（buildSpawnEnv 无会话 override 时的兜底）看到一致的投影
//（settings-writer 已不投影端点凭据、connection-tester 行内测试直读档案）。
// hb10-CFG-04：返回投影结果（projectionOk）——saveConfig 据此透出投影失败可见性。
function projectLegacyFields(): boolean {
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
  } else if (!s.store.encryptedApiKey && libraryEmptiedByDeletion) {
    // P2-4 补口（审计「陈旧快照复活链」）+ R2 收窄（复查 2026-09-08）：只在「库从非空变空」
    // （libraryEmptiedByDeletion 由 deleteProviderProfile 删光分支置位）后触发——saveConfig
    // 带回的已删供应商陈旧 apiBaseUrl/defaultModel 不得复活，回落官方默认（对齐删光分支清空集）。
    // R2：库从未非空的老字段直配用户不进此分支，saveConfig 刚写入的自定义端点/模型原样保留。
    // 保护路径（P3-6 先例）：库空+全局 apiKey 时 encryptedApiKey 非空，同样不触发。
    patch.providerName = 'Anthropic';
    patch.providerNote = '';
    patch.apiBaseUrl = 'https://api.anthropic.com';
    patch.defaultModel = 'claude-sonnet-4-6';
  }
  // P2-4/R2 注：「库空→清投影老字段」有两处触发点，且都以「库曾非空」为前提——
  // ① deleteProviderProfile 删光分支的显式清空（删除当场）；② 本函数上方补清分支
  // （libraryEmptiedByDeletion 已置位，拦删光后 saveConfig 的陈旧回声）。都不是「库空」的
  // 无条件分支：否则库空+全局 apiKey 用户每次 saveConfig 会把刚存的真实 Key 抹掉（saveConfig
  // 先写 key 再调投影，投影会覆盖）、库从未非空的老字段直配用户会被覆盖自定义端点。
  // 老字段链「库空回落全局」保留。
  s.set(patch);

  const config = getConfig();
  // 投影成 Claude Code settings.local.json（对标 CC GUI），让 permissions 等顶层字段生效。
  // workingDirectory 为 null 时静默跳过（env 注入仍走 buildSpawnEnv）。
  // hb10-CFG-04：投影失败可见——保存返回 projectionOk:false，ConfigPage 徽标显示「已保存（投影失败）」。
  let projectionOk = true;
  try {
    const result = writeClaudeSettings(config.workingDirectory, config);
    if (!result.ok && result.error !== SKIP_NO_WORKDIR) {
      logger.warn(`settings.local.json 写入跳过：${result.error}`);
      projectionOk = false;
    }
  } catch (e) {
    logger.warn(`settings.local.json 写入跳过：${e instanceof Error ? e.message : String(e)}`);
    projectionOk = false;
  }
  return projectionOk;
}

export function saveConfig(partial: Partial<AppConfig>): AppConfig {
  const { apiKey, ...rest } = partial;
  const storage = { ...rest } as Partial<StoredConfig>;
  delete (storage as Partial<StoredConfig>).providerProfiles; // 档案只经 saveProviderProfile 变更
  // hb10 P2-4：apiKeyBroken 是 getConfig 的派生标记（解密失败态），不是存储字段——
  // 渲染层整份回显带回时必须剥离，防派生态落盘。
  delete (storage as Partial<StoredConfig>).apiKeyBroken;
  // hb12-P2-6：CONFIG_SAVE 回显的 lastUsed 两键一律剥离（合法直写点全在主进程内部：
  // recordLastUsedProviderModel、saveProviderProfile 首档创建、projectLegacyFields/迁移投影）——
  // 渲染层整份回显（H1 失败重存等）不得把陈旧内存 lastUsed 回写主进程（全局「最近使用」静默回退）。
  delete (storage as Partial<StoredConfig>).lastUsedProviderId;
  delete (storage as Partial<StoredConfig>).lastUsedModelId;
  // F2：maxTurns 落盘前兜底清洗（非有限/≤0/清空串 → 默认 200）——渲染层 v-model.number 的
  // 空串/0 不得透传入库，否则 sdk-command-options 的 >0 守卫会静默丢旗标=队列任务无轮次上限。
  if (storage.maxTurns !== undefined) {
    storage.maxTurns = sanitizeMaxTurns(storage.maxTurns);
  }
  getStore().set(storage);

  if (apiKey !== undefined) {
    // P3-6：空串或掩码形态 = 不改动（保留旧加密值）。CONFIG_GET/SAVE 的 renderer 出口现在
    // 只下发掩码（sk-…****xxxx），渲染层自动保存整份 config 会把掩码原样带回——重新加密
    // 掩码会污染真实 Key。仅非掩码明文才重新加密；清空 Key 走 deleteProviderProfile/clearConfig。
    const trimmedKey = apiKey.trim();
    if (trimmedKey !== '' && !trimmedKey.includes('…****')) {
      const encrypted = encryptApiKey(apiKey);
      getStore().set(encrypted);
    }
  }

  // 老字段是库的投影：渲染层整份 saveConfig（自动保存）可能带回陈旧的投影字段，
  // 这里重新断言库的权威值，再统一写 settings.local.json。
  const projectionOk = projectLegacyFields();
  emitConfigSaved();
  // hb10-CFG-04：投影结果随保存返回（派生标记，不入库不回写）。
  return { ...getConfig(), projectionOk };
}

export function getDecryptedApiKey(): string | null {
  const apiKey = decryptApiKey(getStore().store);
  return apiKey || null;
}

/** P3-6：renderer 出口专用——apiKey 掩码（sk-…****xxxx），主进程内部消费一律走 getConfig()。
 *  渲染层 UI 本就不显示明文 Key；下发掩码配合 saveConfig 的「掩码=不改动」语义防回写污染。 */
export function getConfigForRenderer(): AppConfig {
  const config = getConfig();
  // hb10 P2-4：损坏态掩码不伪造（哨兵串掩码是垃圾值）——apiKey 置空串，损坏可见性走 apiKeyBroken。
  if (config.apiKeyBroken) {
    return { ...config, apiKey: '' };
  }
  return { ...config, apiKey: maskApiKey(config.apiKey) };
}

export function hasApiKey(): boolean {
  return Boolean(getDecryptedApiKey());
}

export function clearConfig(): AppConfig {
  // hb10-CFG-10：恢复出厂单次写——clear() 后 set(defaultConfig) 会逐键落盘（约 25 次重写）。
  // 改为 clear 后仅显式 delete 三键（defaults 已兜底其余键），消除重写风暴。
  // hb13-v B4（F-05）：clear() 前先捕获旧 workingDirectory——clear 后该键已复位 null，旧实现
  // 的快照清理与旧目录重投影恒被空值/SKIP_NO_WORKDIR 守卫跳过（hb10-P2-6 净残留不生效）。
  const previousWorkingDir = getConfig().workingDirectory;
  getStore().clear();
  const s = getStore();
  s.delete('providerProfiles');
  s.delete('lastUsedProviderId');
  s.delete('lastUsedModelId');
  // R2：恢复出厂=库从未非空，删除事件旗标一并复位（老字段直配重新可用，不受补清影响）。
  libraryEmptiedByDeletion = false;
  // hb10 P2-6（收 PRV-08）：重投影 default 清净 settings.local.json 残留；撤销栈跨复位清空。
  lastDeletedProvider = null;
  // hb12-CFG-05：跨复位清缓存——模型查询缓存 / CLI 检测缓存 / 投影快照，
  // 恢复出厂后不复位会让旧缓存继续生效（防御性：当前 UI 无恢复出厂入口）。
  clearProviderModelsCache();
  resetCliDetectionCache();
  try {
    if (previousWorkingDir) {
      // hb13-v B4（F-05）：旧目录重投影 default（快照仍在 → diff 模式按可撤销性清 CL 残留），
      // 之后再清快照归位首跑态——顺序颠倒会退化成保守合并、清不掉旧投影。
      writeClaudeSettings(previousWorkingDir, getConfig());
      clearProjectionSnapshot(path.join(previousWorkingDir, '.claude'));
    }
  } catch {
    /* ignore */
  }
  projectLegacyFields();
  emitConfigSaved();
  return getConfig();
}

export function importSettingsFile(filePath: string): {
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  contextWindowByAlias?: Partial<Record<ModelAlias, number>>;
  advancedJson: string;
} {
  // hb10-CFG-05：入口三项加固（与 IPC 层 CONFIG_IMPORT_SETTINGS 死通道收窄对齐——
  // 直调本函数也受保护）：① 仅 .json 后缀；② ≤1MB；③ 返回 apiKey 经 maskApiKey 掩码不泄露明文。
  if (typeof filePath !== 'string' || !filePath.toLowerCase().endsWith('.json')) {
    throw new Error('仅支持 .json 设置文件');
  }
  const st = fs.statSync(filePath);
  if (st.size > 1024 * 1024) throw new Error('设置文件超过 1MB 上限');
  const parsed = parseClaudeSettings(fs.readFileSync(filePath, 'utf-8'));
  return { ...parsed, apiKey: parsed.apiKey ? maskApiKey(parsed.apiKey) : parsed.apiKey };
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
    // hb10 P2-4：legacyApiKey 为解密失败哨兵时保留原 blob 原样迁移（不 encrypt）——
    // 保留物证，档案行经 toProviderView 显示损坏态；用户重新保存 Key 时正常覆盖。
    if (legacyApiKey === DECRYPT_FAILED) {
      profiles.push({
        ...migrated,
        encryptedApiKey: current.encryptedApiKey,
        apiKeyEncoding: current.apiKeyEncoding,
      });
    } else {
      profiles.push({ ...migrated, ...encryptApiKey(legacyApiKey) });
    }
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
  // hb10 P2-4：解密失败=损坏态——hasApiKey 仍 true（blob 存在），apiKeyBroken 供前端显示
  // 「密钥损坏，请重新输入」徽标；掩码不伪造（空串），不再伪装成「未设置」。
  const broken = apiKey === DECRYPT_FAILED;
  return {
    id: profile.id,
    name: profile.name,
    note: profile.note,
    apiBaseUrl: profile.apiBaseUrl,
    models: profile.models,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    apiKeyMasked: broken ? '' : maskApiKey(apiKey),
    hasApiKey: Boolean(apiKey),
    apiKeyBroken: broken || undefined,
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
  return (s.store.providerProfiles ?? []).map((p) => {
    const key = decryptProviderApiKey(p);
    // hb10 P2-4：解密失败按空处理（注入行为与损坏前一致），哨兵串不得流进 env。
    return {
      id: p.id,
      name: p.name,
      apiBaseUrl: p.apiBaseUrl,
      apiKey: key === DECRYPT_FAILED ? '' : key,
      models: p.models,
    };
  });
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

  // hb10-CFG-07：掩码守卫（与 saveConfig 同语义）——渲染层整份回显带回掩码形态时
  // 当作「不改动」保留原加密值；仅非掩码明文才重新加密。
  const rawKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const effectiveKey = rawKey.includes('…****') ? '' : rawKey;
  let saved: StoredProviderProfile;
  if (existing) {
    saved = {
      ...existing,
      ...fields,
      models: input.models === undefined ? existing.models : models,
      updatedAt: now,
    };
    // hb12-CFG-02：空串=不改动（对齐 saveConfig「空串/掩码=不改动」语义）；
    // encrypt('') 会产出 {null,null} 抹掉密钥——与「清空」意图混淆，清除走显式机制。
    // hb13-v B4（F-06）：显式清除通道已补——clearApiKey:true 抹掉已存密文（encrypt('') 同形态），
    // 优先于掩码/空串守卫；省略=false=不触碰。
    if (input.clearApiKey === true) {
      saved = { ...saved, encryptedApiKey: null, apiKeyEncoding: null };
    } else if (input.apiKey !== undefined && input.apiKey !== null && effectiveKey !== '') {
      saved = { ...saved, ...encryptApiKey(effectiveKey) };
    } else if (input.apiKey === '' || input.apiKey === null) {
      logger.info(`[provider] apiKey 空串/掩码视为不改动（${input.id}）`);
    }
  } else {
    // hb10-CFG-07：新建同样吃掩码守卫（掩码串不成密文）。
    const plain = effectiveKey;
    saved = {
      id: randomUUID(),
      ...fields,
      ...encryptApiKey(plain),
      models,
      createdAt: now,
      updatedAt: now,
    };
  }

  const previousProfiles = s.store.providerProfiles ?? [];
  // hb10-PRV-04（hb13-v A10 补实施）：编辑按原 index 原位替换——旧 filter+push 把被编辑档案
  // 移到库尾，列表顺序漂移。wasEmpty 仍按过滤/替换前的库长度判定（P1-14）。
  const wasEmpty = previousProfiles.length === 0;
  const profiles = [...previousProfiles];
  const editIdx = profiles.findIndex((p) => p.id === saved.id);
  if (editIdx >= 0) profiles[editIdx] = saved;
  else profiles.push(saved);
  s.set({ providerProfiles: profiles });
  if (wasEmpty && !existing) {
    s.set({ lastUsedProviderId: saved.id, lastUsedModelId: saved.models[0]?.id ?? null });
  }
  // N6：模型查询缓存（缓存键仅 profile.id，TTL 1h）随档案编辑失效——否则改 Base URL/Key
  // 后「查询模型」1 小时内仍返回旧端点列表，与行内测试（不走缓存）自相矛盾。
  clearProviderModelsCache(saved.id);
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
  // P2-4：删光后显式清投影老字段（官方默认端点/无凭据，与首次安装行为一致）——防已删档案
  // 的 Base URL/加密 Key 残留在老字段被会话继续静默使用。仅在「删光」这一删除动作时执行，
  // 不放进 projectLegacyFields（否则库空+全局 apiKey 用户每次 saveConfig 都会抹掉真实 Key）。
  if (profiles.length === 0) {
    // R2：置位「库从非空变空」删除事件——此后 projectLegacyFields 的补清分支才允许触发
    // （拦删光后 saveConfig 带回的陈旧回声；库从未非空的用户不受补清影响）。
    libraryEmptiedByDeletion = true;
    s.set({
      providerName: 'Anthropic',
      providerNote: '',
      apiBaseUrl: 'https://api.anthropic.com',
      encryptedApiKey: null,
      apiKeyEncoding: null,
      defaultModel: 'claude-sonnet-4-6',
    });
  }
  // N6：删除档案同步失效其模型查询缓存（同 id 档案未来重建时也不会命中旧数据）。
  clearProviderModelsCache(id);
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
