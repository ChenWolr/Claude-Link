// 多供应商模型库的共享纯逻辑（主进程 config-manager 与 selftest 共用，不依赖 electron）。
// 密钥明文/密文都不经过这里：加密在 config-manager，掩码在这里（纯字符串操作）。

import type { ProviderModel, ProviderProfile } from './types/config';

// apiKey 掩码：sk-…****<末4位>。空串原样返回（渲染层显示「未设置」）。
export function maskApiKey(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return '';
  return `sk-…****${trimmed.slice(-4)}`;
}

// 老单供应商配置 → 迁移档案的字段（不含加密字段，由 config-manager 补齐）。
// 返回 null = 无可迁移的连接配置（全新安装：无 key 且供应商名是默认值）。
export interface LegacyProviderFields {
  providerName: string;
  providerNote: string;
  apiBaseUrl: string;
  defaultModel: string;
  hasApiKey: boolean;
}

export function buildLegacyProviderProfile(
  legacy: LegacyProviderFields,
  id: string,
  now: number,
): ProviderProfile | null {
  const name = legacy.providerName.trim();
  const hasConnection = legacy.hasApiKey || (name !== '' && name !== 'Anthropic');
  if (!hasConnection) return null;

  const defaultModel = legacy.defaultModel.trim();
  const models: ProviderModel[] = defaultModel
    ? [{ id: defaultModel, name: defaultModel, maxTokens: 0, source: 'manual', addedAt: now }]
    : [];

  return {
    id,
    name: name || '默认供应商',
    note: legacy.providerNote.trim(),
    apiBaseUrl: legacy.apiBaseUrl.trim() || 'https://api.anthropic.com',
    models,
    createdAt: now,
    updatedAt: now,
  };
}

// 模型列表清洗/校验（saveProvider 入参的主进程侧防线，也是 selftest 的行为测试对象）：
// - 逐项必须是 { id: 非空字符串, name?, maxTokens?, source?, addedAt? }，缺省补默认；
// - 同供应商内 id 重复 → 抛错（唯一性是库的硬约束）。
// 返回净化后的新数组（顺序保持输入序）。
export function sanitizeProviderModels(input: unknown): ProviderModel[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('models 必须是数组');

  const out: ProviderModel[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('模型条目必须是对象');
    }
    const item = raw as Record<string, unknown>;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) throw new Error('模型 ID 不能为空');
    if (seen.has(id)) throw new Error(`模型「${id}」重复，同供应商内 ID 必须唯一`);
    seen.add(id);
    const maxTokens =
      typeof item.maxTokens === 'number' && Number.isFinite(item.maxTokens) && item.maxTokens > 0
        ? Math.floor(item.maxTokens)
        : 0;
    out.push({
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      maxTokens,
      source: item.source === 'manual' ? 'manual' : 'queried',
      addedAt:
        typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) && item.addedAt > 0
          ? item.addedAt
          : Date.now(),
    });
  }
  return out;
}
