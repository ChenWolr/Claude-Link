// sdk-command-options.ts
// 纯函数：把会话配置与增量 SpawnOptions 合并为完整 probe/query options（review-v2 N1 修复）。
//
// 背景：SESSION_UPDATE 重新探测时只传本次 IPC 的增量 patch（如仅 { workingDir }），若直接当完整
// probe options 使用，会丢失 modelOverride / model / permissionMode / maxTurns / thinkingLevel，
// 导致探测上下文与会话真实上下文漂移（N1）。本函数用 sessionRepo 读出的完整 Session 补全 opts
// 缺失字段（增量优先）。
// 不依赖 electron / DB——session 由调用方（sdk-backend）读取后传入，便于 tsx 行为测试。
import type { SpawnOptions } from './cli-shared';
import type { Session } from '../../shared/types/session';

export function mergeSpawnOptions(session: Session | null, opts: SpawnOptions): SpawnOptions {
  if (!session) return opts;
  const merged: SpawnOptions = { ...opts };
  if (merged.model === undefined || merged.model === null) merged.model = session.model;
  if (merged.modelOverride === undefined || merged.modelOverride === null) merged.modelOverride = session.modelOverride;
  if (merged.workingDir === undefined || merged.workingDir === null) merged.workingDir = session.workingDir;
  if (merged.maxTurns === undefined || merged.maxTurns === null) merged.maxTurns = session.maxTurns;
  if (merged.permissionMode === undefined || merged.permissionMode === null) merged.permissionMode = session.permissionMode;
  if (merged.thinkingLevel === undefined || merged.thinkingLevel === null) merged.thinkingLevel = session.thinkingLevel;
  return merged;
}
