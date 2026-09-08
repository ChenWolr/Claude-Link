import type {
  PermissionBehavior as SdkPermissionBehavior,
  PermissionRuleValue as SdkPermissionRuleValue,
  PermissionUpdate as SdkPermissionUpdate,
  PermissionUpdateDestination as SdkPermissionUpdateDestination,
} from '@anthropic-ai/claude-agent-sdk';

export type PermissionBehavior = SdkPermissionBehavior;
export type PermissionUpdateDestination = SdkPermissionUpdateDestination;
export type PermissionRuleValue = SdkPermissionRuleValue;
export type PermissionUpdate = SdkPermissionUpdate;

export type PermissionRuleBucket = 'allow' | 'deny' | 'ask';

export type SdkPermissionSettings = {
  defaultMode?: string;
  allow?: string[];
  deny?: string[];
  ask?: string[];
  additionalDirectories?: string[];
  [key: string]: unknown;
};

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string');
  return items.length ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isRule(value: unknown): value is PermissionRuleValue {
  return isRecord(value)
    && typeof value.toolName === 'string'
    && (value.ruleContent === undefined || typeof value.ruleContent === 'string');
}

function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return value === 'allow' || value === 'deny' || value === 'ask';
}

function isPermissionUpdate(value: unknown): value is PermissionUpdate {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  if (value.type === 'setMode') return typeof value.mode === 'string';
  if (value.type === 'addDirectories' || value.type === 'removeDirectories') {
    return Array.isArray(value.directories) && value.directories.every((directory) => typeof directory === 'string');
  }
  if (value.type === 'addRules' || value.type === 'replaceRules' || value.type === 'removeRules') {
    return isPermissionBehavior(value.behavior) && Array.isArray(value.rules) && value.rules.every(isRule);
  }
  return false;
}

function permissionRuleToString(rule: PermissionRuleValue): string {
  return rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName;
}

// 会话级放行匹配用的 toolName 归一化：CLI 发来的 toolName 大小写/首尾空白不保证稳定
//（排查文档遗留项 3：写入与判定两处严格相等，任一侧大小写漂移就漏弹/过度弹）。
// withToolSessionAllow 查重与 isToolSessionAllowed 判定必须共用本函数，保证对称。
export function normalizeToolNameForMatch(toolName: string): string {
  return toolName.trim().toLowerCase();
}

function uniquePush(target: string[], values: string[]): void {
  for (const value of values) {
    if (!target.includes(value)) target.push(value);
  }
}

function removeValues(target: string[] | undefined, values: string[]): string[] | undefined {
  if (!target) return undefined;
  const removeSet = new Set(values);
  const next = target.filter((value) => !removeSet.has(value));
  return next.length ? next : undefined;
}

export function buildPermissionSettings(input: { permissionMode: string; advancedJson?: string | null }): SdkPermissionSettings {
  let fromJson: SdkPermissionSettings = {};
  try {
    const adv = JSON.parse(input.advancedJson || '{}') as unknown;
    const permissions = isRecord(adv) && isRecord(adv.permissions) ? adv.permissions : null;
    if (permissions) {
      fromJson = { ...permissions } as SdkPermissionSettings;
      const allow = stringArray(permissions.allow);
      const deny = stringArray(permissions.deny);
      const ask = stringArray(permissions.ask);
      const additionalDirectories = stringArray(permissions.additionalDirectories);
      if (allow) fromJson.allow = allow;
      else delete fromJson.allow;
      if (deny) fromJson.deny = deny;
      else delete fromJson.deny;
      if (ask) fromJson.ask = ask;
      else delete fromJson.ask;
      if (additionalDirectories) fromJson.additionalDirectories = additionalDirectories;
      else delete fromJson.additionalDirectories;
    }
  } catch {
    fromJson = {};
  }

  // Task 3 Step 4：用户未显式选择非默认 mode（= 'default'）时，不强制写 permissions.defaultMode，
  // 避免用一份全量 JSON 把未设字段写成默认值去覆盖原生 user/project/local 设置文件的权限默认模式。
  // 只叠加 Claude Link 显式配置的字段；用户已写入 advancedJson.permissions 的 defaultMode 保留在 fromJson。
  const mode = input.permissionMode;
  if (!mode || mode === 'default') return fromJson;
  return {
    ...fromJson,
    defaultMode: mode,
  };
}

export function coercePermissionUpdatesToSession(updates: unknown[] | undefined): PermissionUpdate[] {
  if (!updates?.length) return [];
  return updates
    .filter(isPermissionUpdate)
    .map((update) => ({ ...update, destination: 'session' as const }));
}

export function buildToolSessionAllowUpdate(toolName: string): PermissionUpdate {
  return { type: 'addRules', rules: [{ toolName }], behavior: 'allow', destination: 'session' };
}

export function withToolSessionAllow(toolName: string, updates: unknown[] | undefined): PermissionUpdate[] {
  const sessionUpdates = coercePermissionUpdatesToSession(updates);
  const matchTool = normalizeToolNameForMatch(toolName);
  const hasToolAllow = sessionUpdates.some((update) =>
    (update.type === 'addRules' || update.type === 'replaceRules')
    && update.behavior === 'allow'
    && update.rules.some((rule) => normalizeToolNameForMatch(rule.toolName) === matchTool && !rule.ruleContent),
  );
  return hasToolAllow ? sessionUpdates : [...sessionUpdates, buildToolSessionAllowUpdate(toolName)];
}

// 判断某工具是否已被「本会话级整工具放行」规则覆盖（裸 toolName、无 ruleContent = 整工具放行）。
// 用于 canUseTool 弹窗前的本地短路。
//
// 为什么需要本地短路：SDK 把 canUseTool 返回的 updatedPermissions(destination:'session') 透传给
// CLI，契约上 CLI 应据此在本会话内不再就同工具发起 can_use_tool。但 CLI 在 --permission-prompt-tool
// stdio（headless）模式下并不据此跳过后续 prompt，导致同一会话同一工具反复弹窗。allow-session 经
// withToolSessionAllow 保证写入一条该工具的裸 allow 规则，故这里按「裸 allow 命中 toolName」判定，
// 与 allow-session 的整工具放行语义一致；带 ruleContent 的细粒度规则不在此判定内（避免误放行）。
export function isToolSessionAllowed(updates: PermissionUpdate[] | undefined, toolName: string): boolean {
  if (!updates?.length) return false;
  const matchTool = normalizeToolNameForMatch(toolName);
  return updates.some((update) =>
    update.destination === 'session'
    && (update.type === 'addRules' || update.type === 'replaceRules')
    && update.behavior === 'allow'
    && update.rules.some((rule) => normalizeToolNameForMatch(rule.toolName) === matchTool && !rule.ruleContent),
  );
}

export function applyPermissionUpdates(permissions: SdkPermissionSettings, updates: PermissionUpdate[] | undefined): SdkPermissionSettings {
  if (!updates?.length) return permissions;

  const next: SdkPermissionSettings = { ...permissions };
  for (const update of updates) {
    if (update.destination !== 'session') continue;
    if (update.type === 'setMode') {
      next.defaultMode = update.mode;
      continue;
    }
    if (update.type === 'addDirectories') {
      const dirs = [...(next.additionalDirectories ?? [])];
      uniquePush(dirs, update.directories);
      next.additionalDirectories = dirs;
      continue;
    }
    if (update.type === 'removeDirectories') {
      next.additionalDirectories = removeValues(next.additionalDirectories, update.directories);
      continue;
    }

    const bucket = update.behavior as PermissionRuleBucket;
    const rules = update.rules.map(permissionRuleToString);
    if (update.type === 'addRules') {
      const existing = [...(next[bucket] ?? [])];
      uniquePush(existing, rules);
      next[bucket] = existing;
    } else if (update.type === 'replaceRules') {
      next[bucket] = rules;
    } else if (update.type === 'removeRules') {
      next[bucket] = removeValues(next[bucket], rules);
    }
  }
  return next;
}

/**
 * 权限通道对齐：把 settings.permissions.defaultMode 对齐到「会话有效权限档」。
 *
 * 背景：`buildPermissionSettings` 用全局 `config.permissionMode` 构造 settings.permissions.defaultMode
 *（无会话上下文），而 SDK `Options.permissionMode` 用会话有效档（resolveEffectivePermissionMode：
 * 会话 override > 全局默认）。会话显式选档（session.permissionMode 非 null）时两者可能分叉——
 * 例如全局默认=bypassPermissions、会话显式选 default：UI 显示「默认模式」，settings 块却仍注入
 * defaultMode='bypassPermissions'，若 CLI 以 settings 块为准会造成越权放行（或反之降级），使
 * 「用户所见权限档」与「真实生效权限档」不一致。
 *
 * 规则（纯函数，供行为测试）：
 *   - 有效档 === 'default' → 写 defaultMode:'default'（显式写安全档压掉低层来源——本函数仅在
 *     会话显式选档（opts.permissionMode != null）时被调用，而工作目录投影文件
 *     settings.local.json 始终按全局档写 defaultMode；若此处删除 defaultMode，CLI 层叠回落
 *     会读到投影文件里的全局档（如 bypassPermissions），UI 显示「默认模式」实际越权放行。
 *     显式选择必须以显式值表达，删除=放弃本层话语权）；
 *   - 有效档非 default → 写 defaultMode = 有效档，与 Options.permissionMode 同源。
 * 总是返回新对象，不 mutate 入参（调用方可能把 settings.permissions 原引用传入）。
 */
export function alignPermissionDefaultMode(
  permissions: SdkPermissionSettings,
  effectivePermissionMode: string,
): SdkPermissionSettings {
  const next: SdkPermissionSettings = { ...permissions };
  next.defaultMode = effectivePermissionMode;
  return next;
}
