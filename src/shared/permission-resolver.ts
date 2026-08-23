// permission-resolver.ts
// 权限模式（Permission Mode）类型 + 运行时守卫 + 全局默认回落解析。
//
// 权限模式 = Claude Code 的四档权限旋钮（default/acceptEdits/plan/bypassPermissions）。
// 与思考强度（thinking-resolver）同构的「全局默认 + 会话级覆盖」语义：
//   - AppConfig.permissionMode 是全局默认（新会话与未单独设权限的会话回落到此值）；
//   - Session.permissionMode 为 null = 跟随全局默认，非 null = 该会话显式选定档。
//
// 与 SDK PermissionMode（含 'dontAsk'/'auto'）刻意不同：claude-link 只暴露四档 UI，
// 'dontAsk'/'auto' 属于 SDK/CLI 内部语义，不进会话持久化层（避免与 settings.defaultMode
// 的持久化联合混淆）。

export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';

/** 全部四档，供 UI 渲染与校验共用，顺序即 UI 展示顺序。 */
export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
];

/** 运行时脏值清洗守卫：字符串且属于四档之一才算合法。 */
export function isValidPermissionMode(v: unknown): v is PermissionMode {
  return typeof v === 'string' && (PERMISSION_MODES as readonly string[]).includes(v);
}

/**
 * 解析「实际生效」的权限档：
 * - sessionLevel 为 null → 回落全局默认；
 * - 否则用 sessionLevel（必为合法四档之一，调用方已过守卫）。
 */
export function resolveEffectivePermissionMode(
  sessionLevel: PermissionMode | null,
  globalDefault: PermissionMode,
): PermissionMode {
  if (sessionLevel === null) return globalDefault;
  return sessionLevel;
}
