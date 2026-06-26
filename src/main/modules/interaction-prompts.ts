import type { BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/constants';
import type { InteractionPromptCancelPayload, InteractionPromptPayload, InteractionPromptResponsePayload } from '../../shared/types/ipc';
import { logger } from '../utils/logger';

interface PendingInteraction {
  sessionId: string;
  payload: InteractionPromptPayload;
  resolve: (response: InteractionPromptResponsePayload) => void;
  abortCleanup?: () => void;
  windowCleanup?: () => void;
  notifyCancel?: (payload: InteractionPromptCancelPayload) => void;
}

const pendingInteractionRequests = new Map<string, PendingInteraction>();

export function requestInteraction(
  mainWindow: BrowserWindow,
  payload: InteractionPromptPayload,
  signal?: AbortSignal,
): Promise<InteractionPromptResponsePayload> {
  if (signal?.aborted) {
    return Promise.resolve({ id: payload.id, action: 'cancel' });
  }

  return new Promise((resolve) => {
    const cleanup = (): void => {
      const pending = pendingInteractionRequests.get(payload.id);
      pending?.abortCleanup?.();
      pending?.windowCleanup?.();
      pendingInteractionRequests.delete(payload.id);
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
        finish({ id: payload.id, action: 'cancel' });
      };
      signal.addEventListener('abort', onAbort, { once: true });
      abortCleanup = () => signal.removeEventListener('abort', onAbort);
    }

    const onWindowClosed = (): void => finish({ id: payload.id, action: 'cancel' });
    mainWindow.once('closed', onWindowClosed);
    const windowCleanup = (): void => mainWindow.off('closed', onWindowClosed);

    pendingInteractionRequests.set(payload.id, {
      sessionId: payload.sessionId,
      payload,
      resolve: finish,
      abortCleanup,
      windowCleanup,
      notifyCancel,
    });

    try {
      mainWindow.webContents.send(IPC_CHANNELS.INTERACTION_REQUEST, payload);
    } catch (err) {
      logger.warn(`Interaction request send failed: ${err instanceof Error ? err.message : String(err)}`);
      finish({ id: payload.id, action: 'cancel' });
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

export function cancelInteractionsForSession(sessionId: string): void {
  for (const [id, pending] of pendingInteractionRequests) {
    if (pending.sessionId === sessionId) {
      pending.notifyCancel?.({ id, sessionId });
      pending.resolve({ id, action: 'cancel' });
    }
  }
}
