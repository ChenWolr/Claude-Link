// chat-backend.ts
// 聊天/任务后端统一入口。
//
// 走 Claude Agent SDK 适配器（sdk-backend）——这是 claude-link 唯一的运行后端。
// ipc-handlers / task-queue-engine 统一从这里 import。
export * from './sdk-backend';

// hb12-P2-11：直发在飞锁查询（队列出队谓词 isUserTurnInFlight 消费；无环）。
export { isChatSendLocked } from './chat-send-locks';
