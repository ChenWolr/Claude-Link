// session-notification.ts
// 失焦系统通知的判定与载荷构造。纯逻辑模块，不依赖 Electron——
// 主进程 notifier 调用它决策，Node selftest 直接行为验证（焦点守卫、会话存在、
// 通知种类与标题正文），避免只靠源码字符串契约兜底。

export interface SessionNotificationPayload {
  title: string;
  body: string;
}

export interface SessionNotificationContext {
  /** 用户配置「离开会话后通知」开关（notifyOnLeave）；false 时一律不弹系统通知。 */
  notifyEnabled: boolean;
  /** Notification.isSupported() 的平台支持性。 */
  notificationSupported: boolean;
  /** 主窗口已销毁。 */
  windowDestroyed: boolean;
  /** 主窗口处于焦点（聚焦时不打扰，不发系统通知）。 */
  windowFocused: boolean;
  /** 最新会话标题；null 表示会话不存在/已删除（不弹陈旧通知）。 */
  sessionName: string | null;
}

// 守卫顺序与主进程 notifier 一致：① 配置开关 → ② 平台支持性 → ③ 窗口存活且未聚焦 → ④ 会话存在。
// 返回 null 表示不发送（调用方静默跳过）；否则返回精确的 { title, body } 载荷。
export function buildSessionNotification(
  ctx: SessionNotificationContext,
  body: string,
): SessionNotificationPayload | null {
  if (!ctx.notifyEnabled) return null;
  if (!ctx.notificationSupported) return null;
  if (ctx.windowDestroyed || ctx.windowFocused) return null;
  if (!ctx.sessionName) return null;
  return { title: ctx.sessionName, body };
}
