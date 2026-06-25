// chat-backend.ts
// 聊天/任务后端统一入口。
//
// 默认走 Claude Agent SDK 适配器（sdk-backend）——这是 claude-link 当前唯一的运行后端。
// ipc-handlers / task-queue-engine 统一从这里 import，不直连 process-manager / sdk-backend。
//
// 代码级回退：process-manager.ts（旧的自建 spawn CLI 路径）作为文件保留。
// 若 SDK 路径上线后出现严重问题需应急切回，把下面这行的 './sdk-backend' 改成
// './process-manager' 即可全量切回旧的 spawn 路径（接口同形，一行改动）。
export * from './sdk-backend';
