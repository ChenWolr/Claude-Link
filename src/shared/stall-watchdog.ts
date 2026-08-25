// stall-watchdog.ts
// 卡死检测的纯逻辑层（不依赖 Electron / Vue / SDK，可单测、可复用）。
//
// 背景：SDK query 的 for-await 是唯一咽喉，主+子所有事件都过这一条。
// 当 API/模型服务挂掉（死 socket）或子 Agent 内部报错不回 tool_result 时，
// 该咽喉既不 throw 也不返回 → sending 永真、计时器永远跳。本模块提供「双区
// 空闲判定」：等模型首字节用短阈值，有待决工具用长阈值（长工具合法），纯模型
// 空隙累计极久才允许硬中断。判定结果驱动主进程看门狗 tick。

/** 一次卡死的诊断信息（随 stalled 事件下发，渲染层原样展示）。 */
export interface StallInfo {
  /** 自首次判定卡死至今的毫秒数（用于横幅「已 Ns 无响应」）。 */
  sinceMs: number;
  /** 本次 tick 测得的、距上次活动的毫秒数。 */
  gapMs: number;
  /** 最后一次活动的事件类型（stream_event / message / tool_progress / keep_alive …），诊断用。 */
  lastKind: string;
  /** 最后一条带 parentToolUseId 的消息所属子 Agent（定位「哪个子 Agent 卡住」），无则 null。 */
  pendingAgentId: string | null;
  /** 卡死区域：model=等模型首字节/回合间；tool=有待决 tool_use。 */
  zone: 'model' | 'tool';
  /** 本回合连续卡死次数（>1 时横幅标注「第 N 次」）。 */
  stallCount: number;
}

/** 双区阈值（毫秒）。主进程可用环境变量覆盖默认值。 */
export interface StallThresholds {
  /** MODEL 区阈值：无待决工具时，距上次活动超过此值判卡死。默认 120s。 */
  modelGapMs: number;
  /** TOOL 区阈值：有待决 tool_use 时（长工具合法），用更长阈值。默认 300s。 */
  toolPendingMs: number;
  /** MODEL 区硬中断阈值：纯模型空隙累计超过此值，看门狗自动 killProcess。默认 600s。 */
  hardAutoAbortMs: number;
  /** TOOL 区硬中断阈值（绝对上限）：有待决工具且持续静默超过此值也自动 killProcess。
   *  长工具合法，故比 model 区更长；但子 Agent 死锁/死连接/api_retry 风暴不能无限等，
   *  到此绝对上限即硬杀。默认 900s。合法长工具会持续发 tool_progress 刷新计时，不会误触。 */
  toolHardAbortMs: number;
}

export const DEFAULT_STALL_THRESHOLDS: StallThresholds = {
  modelGapMs: 120_000,
  toolPendingMs: 300_000,
  hardAutoAbortMs: 600_000,
  toolHardAbortMs: 900_000,
};

/**
 * 判断某类事件是否应重置「业务静默」计时。
 * keep_alive 只证明 SDK/子进程还活着，不代表模型/API/工具有真实进展；若把它当活动，
 * 代理网关死等但仍心跳时会永远不触发 stalled。
 * api_retry 同理：它证明 SDK 正在重试一次失败的 API 调用（如空/畸形响应），是失败信号而非
 * 进展；若当活动，重试风暴会持续刷新计时，永远判不出卡死（子 agent 卡死不退、计时器不关）。
 * 注意：此处 kind 由调用方传入事件 type（如 'system'）；api_retry 是 system 的子类型，
 * 主进程 touchActivityFromEvent 需在 system 事件里按子类型识别并提前 return，不走到本函数。
 */
export function isBusinessStallActivityKind(kind: string): boolean {
  return (
    kind !== 'keep_alive' &&
    kind !== 'stalled' &&
    kind !== 'error' &&
    kind !== 'aborted' &&
    kind !== 'result' &&
    kind !== 'api_retry'
  );
}

/**
 * 纯函数：根据「最后活动时间 + 当前时间 + 是否有待决工具 + 阈值」判定卡死状态。
 *
 * 返回：
 *  - stalled：是否达到卡死阈值。
 *  - zone：卡死区域（决定阈值与是否允许硬中断）。
 *  - gapMs：距上次活动的毫秒数（≥0）。
 *  - hardAbort：是否达到硬中断条件（仅 model 区且超 hardAutoAbortMs；tool 区长工具合法，永不硬中断）。
 */
export function classifyStall(
  lastActivityAt: number,
  now: number,
  pendingToolUse: boolean,
  thresholds: StallThresholds = DEFAULT_STALL_THRESHOLDS,
): { stalled: boolean; zone: 'model' | 'tool'; gapMs: number; hardAbort: boolean } {
  const gapMs = Math.max(0, now - lastActivityAt);
  const zone: 'model' | 'tool' = pendingToolUse ? 'tool' : 'model';
  const threshold = zone === 'tool' ? thresholds.toolPendingMs : thresholds.modelGapMs;
  const stalled = gapMs >= threshold;
  // 硬中断分 zone：model 区纯静默到 hardAutoAbortMs 即杀；tool 区到 toolHardAbortMs 绝对上限才杀
  //（长工具会持续发 tool_progress 刷新计时，正常不会触；只兜子 Agent 死锁/死连接/重试风暴）。
  const hardAbort =
    stalled &&
    (zone === 'model'
      ? gapMs >= thresholds.hardAutoAbortMs
      : gapMs >= thresholds.toolHardAbortMs);
  return { stalled, zone, gapMs, hardAbort };
}

/** 重试排期后的宽限：排期时刻（或最后一次重试事件）过后这么久仍无任何事件
 *  （无恢复、无新重试通知、无终态），视为真卡死，恢复看门狗管辖。 */
export const RETRY_PAUSE_GRACE_MS = 120_000;

/** shouldPauseStallWatchdog 的探测输入（ApiRetryState 的子集，便于纯函数测试）。 */
export interface RetryPauseProbe {
  phase: 'idle' | 'retrying' | 'terminal';
  nextRetryAt: number | null;
  lastRetryAt: number | null;
}

/**
 * 有排期中的 API 重试时暂停 stall 判定（不横幅、不硬杀）：Claude Code 内部按退避
 * 重试期间静默是预期行为，把它算进「距上次业务活动的间隔」会把正常重试误判成卡死
 * （120s 横幅 / 600s 硬杀）。暂停条件收紧为「排期尚未过期 + 宽限」：nextRetryAt 已过
 * 且超过宽限仍无任何事件 → 重试机制自身挂死，恢复看门狗管辖，保证 sending 不会永久卡住。
 */
export function shouldPauseStallWatchdog(probe: RetryPauseProbe | undefined, now: number): boolean {
  if (!probe || probe.phase !== 'retrying') return false;
  if (probe.nextRetryAt !== null) return probe.nextRetryAt + RETRY_PAUSE_GRACE_MS > now;
  return probe.lastRetryAt !== null && probe.lastRetryAt + RETRY_PAUSE_GRACE_MS > now;
}
