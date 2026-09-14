import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { InteractionPromptCancelPayload, InteractionPromptPayload, InteractionPromptResponsePayload } from '../../shared/types/ipc';
import { logger } from '../utils/logger';
// hb13-v B9（F4 / hb12-PERM-05）：系统取消路径的 cancel 历史落库（与 sdk-backend killProcess
// 同款通道）。渲染崩溃（cancelAllPendingInteractions）与 10min 超时两路径不再缺历史行。
import { createInteractionHistory } from '../database/repositories/interaction-history-repo';

interface PendingInteraction {
  sessionId: string;
  payload: InteractionPromptPayload;
  resolve: (response: InteractionPromptResponsePayload) => void;
  abortCleanup?: () => void;
  windowCleanup?: () => void;
  notifyCancel?: (payload: InteractionPromptCancelPayload) => void;
  ageCleanup?: () => void;
}

const pendingInteractionRequests = new Map<string, PendingInteraction>();

// hb10-PERM-06（hb12 §1.3 加重）：pending 最大停留 10min 兜底超时——渲染层崩溃/事件丢失时
// 看门狗对 pending 让位（sdk-backend:464-471），死弹窗会无限期悬挂；到点按中性 cancel 收口。
const PENDING_MAX_AGE_MS = 10 * 60_000;
// hb10-PERM-05：pending 数量变化回调（托盘 ⏳ 提示注入用）。
let countChangedHook: ((count: number) => void) | null = null;
export function setInteractionCountChangedHook(fn: ((count: number) => void) | null): void {
  countChangedHook = fn;
}
export function pendingInteractionCount(): number {
  return pendingInteractionRequests.size;
}
function notifyCountChanged(): void {
  try { countChangedHook?.(pendingInteractionRequests.size); } catch { /* hook 异常不影响主链路 */ }
}

export function requestInteraction(
  mainWindow: BrowserWindow,
  payload: InteractionPromptPayload,
  signal?: AbortSignal,
): Promise<InteractionPromptResponsePayload> {
  if (signal?.aborted) {
    return Promise.resolve({ id: payload.id, action: 'cancel', reason: 'abort' });
  }

  return new Promise((resolve) => {
    const cleanup = (): void => {
      const pending = pendingInteractionRequests.get(payload.id);
      pending?.abortCleanup?.();
      pending?.windowCleanup?.();
      pending?.ageCleanup?.();
      pendingInteractionRequests.delete(payload.id);
      notifyCountChanged();
    };

    const finish = (response: InteractionPromptResponsePayload): void => {
      cleanup();
      resolve(response);
    };

    const notifyCancel = (cancelPayload: InteractionPromptCancelPayload): void => {
      try {
        mainWindow.webContents.send(IPC_CHANNELS.INTERACTION_CANCEL, cancelPayload);
      } catch {
        // 窗口可能已关闭；主进程 promise 已经会被 resolve，不需要再处理。
      }
    };

    let abortCleanup: (() => void) | undefined;
    if (signal) {
      const onAbort = (): void => {
        notifyCancel({ id: payload.id, sessionId: payload.sessionId });
        finish({ id: payload.id, action: 'cancel', reason: 'abort' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', onAbort);
    }

    const onWindowClosed = (): void => { finish({ id: payload.id, action: 'cancel', reason: 'abort' }); };
    mainWindow.once('closed', onWindowClosed);
    const windowCleanup = (): void => { mainWindow.off('closed', onWindowClosed); };

    // hb10-PERM-06：10min 最大停留兜底（中性 cancel，防渲染崩溃/事件丢失导致永久挂起）。
    const ageTimer = setTimeout(() => {
      logger.warn(`Interaction request expired after ${PENDING_MAX_AGE_MS}ms: ${payload.id}`);
      // hb13-v B9（F4）：超时取消同走落库通道（与 killProcess/render-crashed 同款 cancel+reason）。
      recordCancelHistory([{ sessionId: payload.sessionId, payload }], 'timeout');
      notifyCancel({ id: payload.id, sessionId: payload.sessionId });
      finish({ id: payload.id, action: 'cancel', reason: 'abort' });
    }, PENDING_MAX_AGE_MS);
    const ageCleanup = (): void => { clearTimeout(ageTimer); };

    pendingInteractionRequests.set(payload.id, {
      sessionId: payload.sessionId,
      payload,
      resolve: finish,
      abortCleanup,
      windowCleanup,
      notifyCancel,
      ageCleanup,
    });
    notifyCountChanged();

    try {
      mainWindow.webContents.send(IPC_CHANNELS.INTERACTION_REQUEST, payload);
    } catch (err) {
      logger.warn(`Interaction request send failed: ${err instanceof Error ? err.message : String(err)}`);
      finish({ id: payload.id, action: 'cancel', reason: 'abort' });
    }
  });
}

export function respondToInteractionPrompt(response: InteractionPromptResponsePayload): void {
  const pending = pendingInteractionRequests.get(response.id);
  if (!pending) {
    logger.warn(`Interaction response ignored; request not found: ${response.id}`);
    return;
  }
  pending.resolve(response);
}

export function getPendingInteractionPrompts(): InteractionPromptPayload[] {
  return Array.from(pendingInteractionRequests.values(), (pending) => pending.payload);
}

// 某会话当前是否有 pending 的交互请求（权限确认 / 选择题 / confirm）。
// 供 stall 看门狗暂停判定：权限弹窗 pending 期间模型已发 tool_use 但工具未执行，
// 无业务事件刷新 lastActivityAt，若不暂停会累积到 toolHardAbortMs 被硬杀，
// 静默 cancel 弹窗 → 中性 deny → is_error tool_result 污染 transcript。
export function hasPendingInteractionForSession(sessionId: string): boolean {
  for (const pending of pendingInteractionRequests.values()) {
    if (pending.sessionId === sessionId) return true;
  }
  return false;
}

export function cancelInteractionsForSession(sessionId: string): void {
  for (const [id, pending] of pendingInteractionRequests) {
    if (pending.sessionId === sessionId) {
      pending.notifyCancel?.({ id, sessionId });
      pending.resolve({ id, action: 'cancel', reason: 'abort' });
    }
  }
}

// hb13-v B9（F4）：cancel 前写 cancel 历史行（killProcess 同款：cancel 记录 + reason）——
// 落库失败仅记日志，不阻塞取消主流程。
function recordCancelHistory(
  entries: ReadonlyArray<{ sessionId: string; payload: InteractionPromptPayload }>,
  reason: string,
): void {
  for (const p of entries) {
    try {
      createInteractionHistory({
        sessionId: p.sessionId,
        title: p.payload.title || '权限确认',
        kind: p.payload.kind || 'permission',
        summary: `系统取消（${reason}），未答复`,
        action: 'cancel',
      });
    } catch (err) {
      logger.warn(`[${p.sessionId}] 取消弹窗落历史失败 ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// hb10-PERM-06：渲染进程崩溃兜底——枚举取消当前全部 pending（render-process-gone 时调用；
// 对不可恢复 reason（launch-failed 等）也覆盖）。hb13-v B9（F4）：取消前统一落库 cancel 历史。
export function cancelAllPendingInteractions(): void {
  recordCancelHistory([...pendingInteractionRequests.values()], 'render-crashed');
  for (const [id, pending] of pendingInteractionRequests) {
    pending.notifyCancel?.({ id, sessionId: pending.sessionId });
    pending.resolve({ id, action: 'cancel', reason: 'abort' });
  }
}
