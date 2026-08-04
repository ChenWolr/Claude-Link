// api-retry-state.ts
// 单次 Query 的上游 API 连续重试状态机。纯逻辑模块，不依赖 Electron、Vue、数据库或计时器。

export type ApiRetryTerminalKind = 'recovered' | 'user_stopped' | 'exhausted';

export interface ApiRetryState {
  phase: 'idle' | 'retrying' | 'terminal';
  retryCount: number;
  retryLimit: number;
  startedAt: number | null;
  lastRetryAt: number | null;
  nextRetryAt: number | null;
  accumulatedDelayMs: number;
  lastError: string | null;
  lastErrorStatus: number | null;
  terminalKind: ApiRetryTerminalKind | null;
  endedAt: number | null;
}

export interface ApiRetryInput {
  now: number;
  retryAttempt?: number;
  retryLimit?: number;
  retryDelayMs?: number;
  error?: string;
  errorStatus?: number | null;
}

export interface ApiRetryTerminalDetailsV1 {
  version: 1;
  kind: ApiRetryTerminalKind;
  retryCount: number;
  retryLimit: number;
  startedAt: number;
  endedAt: number;
  elapsedMs: number;
  accumulatedDelayMs: number;
  lastError?: string;
  lastErrorStatus?: number | null;
  currentReplyOnly: true;
}

export function createApiRetryState(retryLimit: number): ApiRetryState {
  return {
    phase: 'idle',
    retryCount: 0,
    retryLimit,
    startedAt: null,
    lastRetryAt: null,
    nextRetryAt: null,
    accumulatedDelayMs: 0,
    lastError: null,
    lastErrorStatus: null,
    terminalKind: null,
    endedAt: null,
  };
}

export function recordApiRetry(
  state: ApiRetryState,
  input: ApiRetryInput,
): { state: ApiRetryState; becameExhausted: boolean } {
  if (state.phase === 'terminal') return { state, becameExhausted: false };

  const retryDelayMs =
    typeof input.retryDelayMs === 'number' && Number.isFinite(input.retryDelayMs) && input.retryDelayMs >= 0
      ? input.retryDelayMs
      : 0;
  const retryAttempt =
    typeof input.retryAttempt === 'number' && Number.isInteger(input.retryAttempt) && input.retryAttempt > 0
      ? input.retryAttempt
      : state.retryCount + 1;
  const retryLimit =
    typeof input.retryLimit === 'number' && Number.isInteger(input.retryLimit) && input.retryLimit > 0
      ? input.retryLimit
      : state.retryLimit;
  const retryCount = Math.min(retryAttempt, retryLimit);

  return {
    state: {
      ...state,
      phase: 'retrying',
      retryCount,
      retryLimit,
      startedAt: state.startedAt ?? input.now,
      lastRetryAt: input.now,
      nextRetryAt: retryDelayMs > 0 ? input.now + retryDelayMs : null,
      accumulatedDelayMs: state.accumulatedDelayMs + retryDelayMs,
      lastError: input.error ?? state.lastError,
      lastErrorStatus: input.errorStatus !== undefined ? input.errorStatus : state.lastErrorStatus,
      terminalKind: null,
      endedAt: null,
    },
    becameExhausted: false,
  };
}

export function recordApiRetryExhausted(
  state: ApiRetryState,
  now: number,
): { state: ApiRetryState; becameExhausted: boolean } {
  if (state.phase !== 'retrying' || state.retryCount < state.retryLimit) {
    return { state, becameExhausted: false };
  }
  return {
    state: {
      ...state,
      phase: 'terminal',
      nextRetryAt: null,
      terminalKind: 'exhausted',
      endedAt: now,
    },
    becameExhausted: true,
  };
}

function toTerminal(
  state: ApiRetryState,
  kind: Exclude<ApiRetryTerminalKind, 'exhausted'>,
  now: number,
): { state: ApiRetryState; changed: boolean } {
  if (state.phase !== 'retrying') return { state, changed: false };
  return {
    state: {
      ...state,
      phase: 'terminal',
      nextRetryAt: null,
      terminalKind: kind,
      endedAt: now,
    },
    changed: true,
  };
}

export function recordApiRetryRecovery(
  state: ApiRetryState,
  now: number,
): { state: ApiRetryState; terminalState: ApiRetryState | null; becameRecovered: boolean } {
  const result = toTerminal(state, 'recovered', now);
  if (!result.changed) {
    return { state, terminalState: null, becameRecovered: false };
  }
  // 保留 terminalState 供持久化，同时把活动状态复位为空闲，允许同一 Query
  // 后续新的模型请求开启独立 retry episode。
  return {
    state: createApiRetryState(state.retryLimit),
    terminalState: result.state,
    becameRecovered: true,
  };
}

export function recordApiRetryUserStop(
  state: ApiRetryState,
  now: number,
): { state: ApiRetryState; becameStopped: boolean } {
  const result = toTerminal(state, 'user_stopped', now);
  return { state: result.state, becameStopped: result.changed };
}

export function toApiRetryTerminalDetails(state: ApiRetryState): ApiRetryTerminalDetailsV1 | null {
  if (state.phase !== 'terminal' || !state.terminalKind || state.startedAt === null || state.endedAt === null) {
    return null;
  }
  return {
    version: 1,
    kind: state.terminalKind,
    retryCount: state.retryCount,
    retryLimit: state.retryLimit,
    startedAt: state.startedAt,
    endedAt: state.endedAt,
    elapsedMs: Math.max(0, state.endedAt - state.startedAt),
    accumulatedDelayMs: state.accumulatedDelayMs,
    ...(state.lastError ? { lastError: state.lastError } : {}),
    ...(state.lastErrorStatus !== null ? { lastErrorStatus: state.lastErrorStatus } : {}),
    currentReplyOnly: true,
  };
}

export function apiRetrySummary(kind: ApiRetryTerminalKind, retryCount: number): string {
  if (kind === 'recovered') return `上游服务已恢复，共自动重试 ${retryCount} 次，正在继续生成回复。`;
  if (kind === 'user_stopped') return `上游服务连接异常，用户在第 ${retryCount} 次重试后停止了本次回复。`;
  return `上游服务连续重试 ${retryCount} 次仍不可用，本次回复已停止。`;
}

const ERROR_LABELS: Record<string, string> = {
  rate_limit: '请求受限',
  overloaded: '服务过载',
  server_error: '服务端错误',
  authentication_failed: '鉴权失败',
  oauth_org_not_allowed: '组织未获授权',
  billing_error: '账户计费异常',
  invalid_request: '请求无效',
  model_not_found: '模型不可用',
  max_output_tokens: '输出上限异常',
};

export function apiRetryErrorLabel(error: string | null | undefined): string {
  if (!error) return '连接异常';
  return ERROR_LABELS[error] ?? '连接异常';
}
