// session-completion-notifier.ts
// 主进程失焦系统通知：会话成功完成或网络中断（retry 真正耗尽）时，
// 在 Electron 主窗口未聚焦的前提下发送 Windows 系统通知。
//
// 设计约束（与实施计划一致）：
//  - 完全由主进程触发，不新增 IPC 暴露面（焦点状态主进程直接读取，renderer 不参与）。
//  - 标题用会话标题，正文固定（「任务已完成」/「网络异常，已中断」），不拼接用户输入原文。
//  - 判定与载荷构造在 src/shared/session-notification.ts 的纯函数 buildSessionNotification，
//    Node selftest 可行为验证；此处只负责读取真实环境输入并构造 Notification。
//  - 通知失败只记录日志，绝不阻断 SDK result 持久化、前端事件或 query 清理。
//  - 完成通知依赖 runQuery 每个 query 只转发一次 result 的终态收口保证单次调用；
//    网络中断通知只能从 finishApiRetryExhausted 的 becameExhausted 唯一边沿触发
//    （assistant error 后再到 error result 的第二次耗尽调用返回 false，不重复通知）。

import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import * as sessionRepo from '../database/repositories/session-repo';
import { buildSessionNotification } from '../../shared/session-notification';
import { logger } from '../utils/logger';

/**
 * 公共内部实现：主窗口未聚焦时发送系统通知。
 *
 * 守卫顺序固定：① 平台支持性 → ② 窗口存活/未聚焦 → ③ 读最新标题（会话不存在则
 * 跳过，避免已删除会话弹陈旧通知）→ ④ 构造并 show。判定由共享纯函数完成；
 * 整个函数同步快速返回、不 await、不触碰 activeSessions 生命周期；
 * 任何异常（含 Notification 构造/show 抛错）只记录日志，不中断业务。
 */
function notifySession(mainWindow: BrowserWindow, sessionId: string, body: string): void {
  try {
    const session = sessionRepo.getSession(sessionId);
    const payload = buildSessionNotification(
      {
        notificationSupported: Notification.isSupported(),
        windowDestroyed: mainWindow.isDestroyed(),
        windowFocused: mainWindow.isFocused(),
        sessionName: session ? session.name : null,
      },
      body,
    );
    if (!payload) return;
    const notification = new Notification({ title: payload.title, body: payload.body });
    notification.show();
  } catch (err) {
    logger.warn(`[notify] 会话系统通知失败 [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 会话成功完成且主窗口未聚焦时，发送「任务已完成」系统通知。
 */
export function notifySessionCompleted(mainWindow: BrowserWindow, sessionId: string): void {
  notifySession(mainWindow, sessionId, '任务已完成');
}

/**
 * 会话 retry 真正耗尽（网络中断）且主窗口未聚焦时，发送「网络异常，已中断」系统通知。
 * 只允许从 finishApiRetryExhausted 的 becameExhausted === true 唯一边沿调用；
 * 普通 error、用户停止、aborted、watchdog 中断均不得走此函数。
 */
export function notifySessionNetworkInterrupted(mainWindow: BrowserWindow, sessionId: string): void {
  notifySession(mainWindow, sessionId, '网络异常，已中断');
}
