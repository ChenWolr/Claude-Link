// session-completion-notifier.ts
// 主进程失焦完成通知：成功完成的会话在 Electron 主窗口未聚焦时发送 Windows 系统通知。
//
// 设计约束（与实施计划一致）：
//  - 完全由主进程触发，不新增 IPC 暴露面（焦点状态主进程直接读取，renderer 不参与）。
//  - 标题用会话标题，正文固定「任务已完成」，不拼接用户输入原文。
//  - 通知失败只记录日志，绝不阻断 SDK result 持久化、前端事件或 query 清理。
//  - 依赖 runQuery 每个 query 只转发一次 result 的终态收口保证单次调用，不额外去重。

import { Notification } from 'electron';
import type { BrowserWindow } from 'electron';
import * as sessionRepo from '../database/repositories/session-repo';
import { logger } from '../utils/logger';

/**
 * 会话成功完成且主窗口未聚焦时，发送 Windows 系统通知。
 *
 * 顺序固定：① 平台支持性检查 → ② 窗口存活/聚焦检查 → ③ 读最新标题（不存在则跳过，
 * 避免已删除会话弹陈旧通知）→ ④ 构造并 show。整个函数同步快速返回、不 await、
 * 不触碰 activeSessions 生命周期；任何异常只记录日志。
 */
export function notifySessionCompleted(mainWindow: BrowserWindow, sessionId: string): void {
  try {
    if (!Notification.isSupported()) return;
    if (mainWindow.isDestroyed() || mainWindow.isFocused()) return;
    const session = sessionRepo.getSession(sessionId);
    if (!session) return;
    const notification = new Notification({ title: session.name, body: '任务已完成' });
    notification.show();
  } catch (err) {
    logger.warn(`[notify] 会话完成通知失败 [${sessionId}] ${err instanceof Error ? err.message : String(err)}`);
  }
}
