import type { AppConfig } from '../../shared/types/config';
import { resolveThinkingConfig } from '../../shared/thinking-resolver';
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

  // advancedJson 先 spread（携带用户 hooks 等顶层设置，以及可能已存在的 effortLevel/ultracode）。
  const projection: Record<string, unknown> = {
    ...advanced,
    permissions: buildPermissionSettings({
      permissionMode: config.permissionMode,
      advancedJson: config.advancedJson,
    }),
    env,
  };

  // 全局默认思考强度投影：selector > advancedJson——在 ...advanced 之后覆盖 thinking 相关同名字段。
  // medium 不投影以尊重用户 ~/.claude 配置（Task 3 恢复原生 user/project/local 来源后，未显式设档时
  // 让 CC 按原生文件自决；level 显式非 medium 才投影覆盖）。
  // level 缺省/非法时（如手构的不完整 config）跳过，等同 medium，避免 resolveThinkingConfig 收到脏值。
  const level = config.defaultThinkingLevel;
  if (level && level !== 'medium') {
    const result = resolveThinkingConfig(level);
    if (result.settingsPatch) Object.assign(projection, result.settingsPatch);
    if (result.effort) {
      // Settings.effortLevel 联合不含 'max'：持久化降级为 xhigh，运行时由 Options.effort='max' 补偿。
      projection.effortLevel = result.effort === 'max' ? 'xhigh' : result.effort;
    }
  }

  return projection;
}
