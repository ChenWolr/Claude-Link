// 多供应商模型库的共享纯逻辑（主进程 config-manager 与 selftest 共用，不依赖 electron）。
// 密钥明文/密文都不经过这里：加密在 config-manager，掩码在这里（纯字符串操作）。

import type { ProviderModel, ProviderProfile } from './types/config';
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from './model-context-windows';
import { extractModelMappings } from './settings-parser';

// apiKey 掩码：sk-…****<末4位>。空串原样返回（渲染层显示「未设置」）。
export function maskApiKey(plain: string): string {
  const trimmed = plain.trim();
  if (!trimmed) return '';
  // P3-7：≤8 字符的 key 尾部 4 位即可拼出大半原文——纯占位符防泄露。
  if (trimmed.length <= 8) return 'sk-…****';
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
    // P2-3：模型 ID 格式白名单（字母/数字/下划线/点/连字符/冒号/斜杠）——含空格或
    // shell 元字符（& | ^ % " < > ( )）的条目直接丢弃。这些 ID 会原样进 CLI
    // `--model` 参数与 env，历史上连接测试走 shell:true 时存在 cmd 元字符注入面。
    // 不抛错保持「查询列表含脏条目不阻断保存」的宽容语义；空白/重复仍按既有硬约束抛错。
    if (!/^[\w.\-:/]+$/.test(id)) continue;
    if (seen.has(id)) throw new Error(`模型「${id}」重复，同供应商内 ID 必须唯一`);
    seen.add(id);
    const maxTokens =
      typeof item.maxTokens === 'number' && Number.isFinite(item.maxTokens) && item.maxTokens > 0
        ? Math.floor(item.maxTokens)
        : 0;
    // 手动上下文窗口白名单：有限整数且在 [1,000, 2,000,000] 内才保留（Math.floor 后）；
    // 否则省略该字段（=未设置，不抛错——宽容语义与 maxTokens 一致，坏值随保存静默清理）。
    const contextWindow =
      typeof item.contextWindow === 'number' &&
      Number.isFinite(item.contextWindow) &&
      Number.isInteger(item.contextWindow) &&
      item.contextWindow >= CONTEXT_WINDOW_MIN &&
      item.contextWindow <= CONTEXT_WINDOW_MAX
        ? Math.floor(item.contextWindow)
        : undefined;
    const model: ProviderModel = {
      id,
      name: typeof item.name === 'string' && item.name.trim() ? item.name.trim() : id,
      maxTokens,
      source: item.source === 'manual' ? 'manual' : 'queried',
      addedAt:
        typeof item.addedAt === 'number' && Number.isFinite(item.addedAt) && item.addedAt > 0
          ? item.addedAt
          : Date.now(),
    };
    if (contextWindow !== undefined) model.contextWindow = contextWindow;
    out.push(model);
  }
  return out;
}

// ── 一次性迁移：legacy 全局按别名窗口覆盖（env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>）
//    → 供应商库内模型条目 contextWindow（计划 2026-10-02 §2.2）。启动时调用一次，幂等。
export interface LegacyWindowMigrationResult {
  advancedJson: string;                 // 已删 4 个 CLAUDE_LINK_CONTEXT_WINDOW_* 键
  profiles: ProviderProfile[];          // 移植成功的模型已写 contextWindow（仅原未设置时）
  migrated: Array<{ alias: string; modelId: string; window: number }>;
  dropped: Array<{ alias: string; window: number }>; // 无映射或库内无该模型 → 值废弃仅删键
}

// 迁移遍历的四别名（与 settings-parser MODEL_ALIASES 同序：sonnet>haiku>opus>fable）。
const LEGACY_WINDOW_ALIASES = ['sonnet', 'haiku', 'opus', 'fable'] as const;

export function migrateLegacyContextWindowOverrides(
  advancedJson: string,
  profiles: ProviderProfile[],
): LegacyWindowMigrationResult {
  const migrated: LegacyWindowMigrationResult['migrated'] = [];
  const dropped: LegacyWindowMigrationResult['dropped'] = [];
  // 不可变拷贝（纯函数不改入参；迁移只写 models[].contextWindow，拷到模型条目一层即可）。
  const nextProfiles: ProviderProfile[] = profiles.map((p) => ({
    ...p,
    models: p.models.map((m) => ({ ...m })),
  }));

  // 解析 advancedJson：非法 JSON / 无 env 块 → 无键可处理，原样返回（宽容语义同 parseAdvancedEnv）。
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(advancedJson || '{}');
    root = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return { advancedJson, profiles: nextProfiles, migrated, dropped };
  }
  const env =
    root.env && typeof root.env === 'object' && !Array.isArray(root.env)
      ? (root.env as Record<string, unknown>)
      : null;
  if (!env) return { advancedJson, profiles: nextProfiles, migrated, dropped };

  const mappings = extractModelMappings(advancedJson);
  let touched = false;
  for (const alias of LEGACY_WINDOW_ALIASES) {
    const key = `CLAUDE_LINK_CONTEXT_WINDOW_${alias.toUpperCase()}`;
    if (!(key in env)) continue;
    touched = true;
    const raw = env[key];
    delete env[key]; // 四种情况（可移植/已设不覆盖/无映射/库内无模型）都一律删该键
    // 正数数值才值得移植（数值判定与 settings-parser 解析回填同款宽松）。
    let v: number | null = null;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) v = raw;
    else if (typeof raw === 'string' && Number.isFinite(Number(raw)) && Number(raw) > 0) v = Number(raw);
    if (v === null) continue; // 非正数/非数值：只删键，值无移植意义
    const modelId = mappings[alias];
    if (!modelId) {
      dropped.push({ alias, window: v }); // 无 ANTHROPIC_DEFAULT_<ALIAS>_MODEL 映射
      continue;
    }
    // 按 models[].id === M 找遍历序首个命中供应商，只写首家（同模型在多家时其余不动）。
    const target = nextProfiles.find((p) => p.models.some((m) => m.id === modelId));
    const model = target?.models.find((m) => m.id === modelId);
    if (!model) {
      dropped.push({ alias, window: v }); // 库内无该模型
      continue;
    }
    // 原未设置（undefined/null/0）才写；已有正数值不覆盖（也不记 migrated/dropped）。
    const preset = model.contextWindow;
    if (typeof preset === 'number' && preset > 0) continue;
    model.contextWindow = v;
    migrated.push({ alias, modelId, window: v });
  }

  if (!touched) return { advancedJson, profiles: nextProfiles, migrated, dropped };
  if (Object.keys(env).length === 0) delete root.env; // env 删空则整块移除（同 settings-parser 语义）
  const nextJson = Object.keys(root).length === 0 ? '{}' : JSON.stringify(root, null, 2);
  return { advancedJson: nextJson, profiles: nextProfiles, migrated, dropped };
}
