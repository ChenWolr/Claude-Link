// chat-backend.ts
// 聊天/任务后端统一入口。
//
// 走 Claude Agent SDK 适配器（sdk-backend）——这是 claude-link 唯一的运行后端。
// ipc-handlers / task-queue-engine 统一从这里 import。
export * from './sdk-backend';
