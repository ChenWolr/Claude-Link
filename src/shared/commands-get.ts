// commands-get.ts
// COMMANDS_GET 主进程分流纯函数（计划 D1/D5）：决定「返回什么快照 + handler 需要执行哪些副作用」。
// 放 shared 便于 tsx 行为测试（与 stall-watchdog 同模式）；主进程 ipc-handlers 是唯一调用方。
//
// 背景铁律：无 DB 行的会话（暂态）读取命令是「只读分流」——不 throw、不 markSessionActive、
// 不 startCommandProbe、不 schedulePostTurnProbe，维持「不把任意 renderer 输入当作会话生命周期
// 事实」的安全初衷，只是不再拒绝读取全局兜底快照（暂态斜杠菜单因此可用，B10 反转的主进程侧）。

import type { SessionCommandSnapshot } from './types/command';

/** COMMANDS_GET 分流输入：handler 从 sessionRepo / sdkCommandRegistry / watcher 取现值传入。 */
export interface CommandsGetInput {
  /** DB 中存在该会话行（暂态/renderer 任意 id 为 false）。 */
  sessionExists: boolean;
  /** registry 已有该会话 per-session 快照（区分「从未探测」与「loading 占位」）。 */
  hasSnapshot: boolean;
  /** registry.get(sessionId) 现值（无快照时为默认 loading 快照，sessionId 已是请求 id）。 */
  snapshot: SessionCommandSnapshot;
  /** 全局兜底快照（未探测为 null）。 */
  fallback: SessionCommandSnapshot | null;
  /** watcher 当前用户级指纹（D5）；undefined = watcher 未启动/未算出，不比对不误标。 */
  currentUserFingerprint?: string;
  /** P2-14：当前项目级指纹（per-session cwd 两根现算）；undefined = 无 cwd/快照无出生指纹，不比对。 */
  currentProjectFingerprint?: string;
  /** P3-4：全局 CLI 缺失（runGlobalCommandProbe 无 exe）。暂态只读分流据此返回 degraded 而非永久 loading。 */
  cliMissing?: boolean;
}

/** COMMANDS_GET 分流决策：返回给 renderer 的快照 + handler 需要执行的副作用档位。 */
export interface CommandsGetDecision {
  /** true = 无 DB 行只读分流：禁止一切会话生命周期副作用，只允许节流全局兜底探测（D6）。 */
  readOnly: boolean;
  /** true = 有 DB 行且无 per-session 快照：markSessionActive + startCommandProbe + post-turn 调度（N6 原链）。 */
  needsFullProbeSideEffects: boolean;
  /** true = 有 DB 行且快照用户级或项目级出生指纹过期（D5 / P2-14）：只 startCommandProbe（免费重探，不 markSessionActive）。 */
  needsRefreshProbeOnly: boolean;
  /** 返回给 renderer 的快照（按需克隆覆写 sessionId/source/status，不回写 registry）。 */
  snapshot: SessionCommandSnapshot;
}

/**
 * 兜底副本：复制全局兜底并覆写 sessionId + source:'cache'。
 * 「cache」标记与既有 COMMANDS_GET 兜底返回、N7 回填一致——它不是 per-session 精确结果。
 */
function fallbackCopy(fallback: SessionCommandSnapshot, sessionId: string): SessionCommandSnapshot {
  return { ...fallback, sessionId, source: 'cache' };
}

/**
 * D5：per-session 快照的用户级出生指纹与当前指纹是否不一致（应标 stale + 重探）。
 * P2-14：增加项目级比对（snapshot.projectOriginFingerprint vs currentProjectFingerprint）——
 * 已物化会话的项目级命令文件变更后，重开菜单即可判 stale 免费重探。
 * 双端缺省（旧快照无指纹 / watcher 未启动 / 会话无 cwd）一律 false——绝不因缺数据误标。
 */
export function isSnapshotOriginStale(
  snapshot: SessionCommandSnapshot,
  currentUserFingerprint: string | undefined,
  currentProjectFingerprint?: string,
): boolean {
  const userStale = Boolean(
    snapshot.originFingerprint &&
      currentUserFingerprint &&
      snapshot.originFingerprint !== currentUserFingerprint,
  );
  const projectStale = Boolean(
    snapshot.projectOriginFingerprint &&
      currentProjectFingerprint &&
      snapshot.projectOriginFingerprint !== currentProjectFingerprint,
  );
  return userStale || projectStale;
}

/**
 * COMMANDS_GET 分流唯一决策点（D1）。
 * - 无 DB 行（暂态）：返回兜底副本；兜底为 null 时返回入参 snapshot（默认 loading 快照）。
 * - 有 DB 行 + 有快照：原样返回；指纹不一致时克隆标 status:'stale'（UI 已有「可能不是最新」渲染）。
 * - 有 DB 行 + 无快照：markSessionActive/probe/post-turn 副作用由 handler 执行，返回兜底副本或
 *   loading 快照（与改动前同语义：fallback 有 → cache 副本；无 → registry.get 的 loading 默认）。
 */
export function resolveCommandsGetResult(input: CommandsGetInput): CommandsGetDecision {
  if (!input.sessionExists) {
    let snapshot = input.fallback ? fallbackCopy(input.fallback, input.snapshot.sessionId) : input.snapshot;
    // P3-4：无兜底且 CLI 缺失 → degraded 快照（显式失败出口），菜单显示「未检测到本地
    // Claude Code」而非永久「正在读取」。重试动作：再次打开菜单经 D6 节流重探。
    if (!input.fallback && input.cliMissing) {
      snapshot = { ...snapshot, status: 'degraded', error: '未检测到本地 Claude Code，无法发现 Slash 命令' };
    }
    return {
      readOnly: true,
      needsFullProbeSideEffects: false,
      needsRefreshProbeOnly: false,
      snapshot,
    };
  }
  if (input.hasSnapshot) {
    const stale = isSnapshotOriginStale(input.snapshot, input.currentUserFingerprint, input.currentProjectFingerprint);
    return {
      readOnly: false,
      needsFullProbeSideEffects: false,
      needsRefreshProbeOnly: stale,
      snapshot: stale ? { ...input.snapshot, status: 'stale' } : input.snapshot,
    };
  }
  return {
    readOnly: false,
    needsFullProbeSideEffects: true,
    needsRefreshProbeOnly: false,
    snapshot: input.fallback ? fallbackCopy(input.fallback, input.snapshot.sessionId) : input.snapshot,
  };
}
