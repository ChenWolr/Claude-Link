// reasoning-replay-auto-retry.ts
// reasoning_replay（DeepSeek thinking 回传 400）韧性层：回合结束后主进程以相同用户文本
// 自动重发一次。依据：同形状重放大概率通过（排查报告 §2.4 非确定性结论），单次重试即可
// 覆盖绝大多数间歇性命中；同一用户消息只重试一次（防重入守卫）。
//
// 依赖倒置：本模块只持有状态/守卫/延时，全部副作用（查询是否空闲、事件转发、重发）
// 由 sdk-backend 在调度点以回调注入 —— 避免与 chat-backend 的 re-export 形成环导入。
//
// 接线点：
//   · noteReasoningReplayError  ← cli-shared.persistMessageParts（assistant 正文命中共享谓词）
//   · recordOutgoingUserText    ← sdk-backend.spawnForChat（opts.userCommandText）
//   · maybeScheduleReasoningReplayRetry ← sdk-backend.runQuery 两个回合终态出口（result / 流丢 result）
//
// 不做的事（边界）：不动 thinking-resolver 的 adaptive 行为；不修改 CC transcript；
// 不重试命令消息（'/' 前缀）；不重试带附件回合（当前记录的是纯文本 prompt）。

import { getConfig } from './config-manager';
import { logger } from '../utils/logger';
import type { CliSystemInfoEvent } from '../../shared/types/cli';

/** 本回合出现过 reasoning_replay 错误正文的会话（回合终态消费后清除）。 */
const turnHasReasoningReplayError = new Set<string>();
/** 最近一次发出的用户文本（自动重试的原样载体）。 */
const lastUserTextBySession = new Map<string, string>();
/** 防重入：同一会话内同一文本只自动重试一次。 */
const retriedTextBySession = new Map<string, string>();
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const REASONING_REPLAY_RETRY_DELAY_MS = 2000;

/** cli-shared 落库 assistant 正文命中 isReasoningReplayApiError 时标记本回合。 */
export function noteReasoningReplayError(sessionId: string): void {
  turnHasReasoningReplayError.add(sessionId);
}

/** spawnForChat 发起回合时记录原样用户文本（命令消息不记录，重试层跳过）。 */
export function recordOutgoingUserText(sessionId: string, text: string | undefined): void {
  const trimmed = (text ?? '').trim();
  if (!trimmed || trimmed.startsWith('/')) return;
  lastUserTextBySession.set(sessionId, trimmed);
}

export interface ReasoningReplayRetryCtx {
  sessionId: string;
  mainWindow: Electron.BrowserWindow;
  /** 该会话当前是否有运行中的 query（空闲才允许重发）。 */
  hasRunningQuery: () => boolean;
  /** 会话是否仍存在（删除/清理后不再重发）。 */
  isSessionAlive: () => boolean;
  /** 转发一条 CliEvent（系统提示）：主进程落库 + 推 renderer。 */
  forwardSystemNotice: (subtype: CliSystemInfoEvent['subtype'], text: string) => void;
  /** 以相同用户文本重发一次（复用 CHAT_SEND 纯文本核心：落库 user 行 + spawn + send）。 */
  resendUserText: (text: string) => void;
}

/**
 * 回合终态出口调用（result / 流丢 result 两处）。命中全部条件时延时 ~2s 自动重发一次：
 * 设置开启（默认开）→ 本回合出现过 reasoning_replay 错误 → 有可重发的用户文本 →
 * 该文本未重试过 → 调度时会话空闲。
 */
export function maybeScheduleReasoningReplayRetry(ctx: ReasoningReplayRetryCtx): void {
  const { sessionId } = ctx;
  if (!turnHasReasoningReplayError.delete(sessionId)) return;
  // 设置项默认开：undefined（老配置）视为开启，只有显式 false 才关闭。
  if (getConfig().autoRetryReasoningReplay === false) return;

  const text = lastUserTextBySession.get(sessionId);
  if (!text) return;
  if (retriedTextBySession.get(sessionId) === text) return;
  if (ctx.hasRunningQuery()) return;
  retriedTextBySession.set(sessionId, text);

  const timer = setTimeout(() => {
    pendingTimers.delete(sessionId);
    try {
      // 二次守卫：延迟窗口内用户可能已手动重发/切会话/删会话。
      if (ctx.hasRunningQuery() || !ctx.isSessionAlive()) return;
      ctx.forwardSystemNotice(
        'auto_retry',
        '检测到上游思考回传不兼容（网关桥接缺陷，reasoning_content 未回传），已自动重试一次。',
      );
      ctx.resendUserText(text);
      logger.info(`[reasoning-replay] session ${sessionId} auto-retried once with identical user text`);
    } catch (err) {
      logger.warn(`[reasoning-replay] auto-retry failed for session ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }, REASONING_REPLAY_RETRY_DELAY_MS);
  pendingTimers.set(sessionId, timer);
}

/** 会话删除/清理时释放全部状态（防泄漏）。 */
export function clearReasoningReplayState(sessionId: string): void {
  turnHasReasoningReplayError.delete(sessionId);
  lastUserTextBySession.delete(sessionId);
  retriedTextBySession.delete(sessionId);
  const timer = pendingTimers.get(sessionId);
  if (timer) {
    clearTimeout(timer);
    pendingTimers.delete(sessionId);
  }
}

/** 测试钩子：直接注入回合错误标记（regression/selftest 构造场景用）。 */
export function _testonlyInjectTurnError(sessionId: string): void {
  turnHasReasoningReplayError.add(sessionId);
}
