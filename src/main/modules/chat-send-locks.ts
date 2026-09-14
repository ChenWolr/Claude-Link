// chat-send-locks.ts
// hb12-P2-11：CHAT_SEND 会话级发送互斥锁的下沉模块（原在 ipc-handlers 模块内，引擎不可见）。
// 队列出队谓词 isUserTurnInFlight 需要读「直发在飞」状态；ipc-handlers → 引擎 → ipc-handlers
// 会成环，故锁本体放独立模块，双方都 import 它（无环）。
//
// 生命周期：CHAT_SEND 入口 add（落库前）、finally delete（成功/失败都释放）。

const chatSendLocks = new Set<string>();

/** 谓词：该会话是否有在飞的直发（CHAT_SEND prepare 窗口内）。 */
export function isChatSendLocked(sessionId: string): boolean {
  return chatSendLocks.has(sessionId);
}

/** CHAT_SEND 入口加锁（ipc-handlers 专用语义；重复加锁由调用方守卫先行拒绝）。 */
export function acquireChatSendLock(sessionId: string): void {
  chatSendLocks.add(sessionId);
}

/** CHAT_SEND finally 释放。 */
export function releaseChatSendLock(sessionId: string): void {
  chatSendLocks.delete(sessionId);
}
