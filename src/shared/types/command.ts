// command.ts
// 原生 Claude Code Slash Commands 跨进程模型。
// 主进程负责从 SDK SlashCommand（sdk.d.ts:6174）清洗成可结构化克隆的 SdkCommand，
// 按 Claude Link sessionId 隔离成 SessionCommandSnapshot；renderer 只消费、不二次持久化。
//
// 这些类型同时被 main（sdk-command-registry / sdk-backend / ipc-handlers）和
// renderer（command-store / ChatInput）引用，故只含可克隆字段（无函数、无 Query 句柄）。

/** 快照来源：标记当前命令列表是从哪条链路获得的，便于 UI 区分 loading/stale/权威。 */
export type CommandSnapshotSource = 'cache' | 'init' | 'probe' | 'changed' | 'degraded' | 'reset';

/** 快照状态：驱动 ChatInput `/` 菜单的 loading / ready / stale / 降级 / 空展示。 */
export type CommandSnapshotStatus = 'loading' | 'ready' | 'stale' | 'degraded' | 'empty' | 'error';

/**
 * SDK SlashCommand 经主进程 toSdkCommand 清洗后的可序列化形态。
 * 仅保留 UI 需要的字符串字段；aliases 缺省为 []。source 固定 'sdk'（Workflow/Agent Teams/
 * sub-agent 不伪造为 slash command，见计划 §0.3）。
 */
export interface SdkCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  source: 'sdk';
}

/** 单会话命令快照：按 sessionId 隔离，commands_changed 全量替换（不 concat）。 */
export interface SessionCommandSnapshot {
  sessionId: string;
  commands: SdkCommand[];
  status: CommandSnapshotStatus;
  source: CommandSnapshotSource;
  updatedAt: string | null;
  error?: string;
}

/**
 * 主→渲染推送的命令变更 payload。
 * 独立于 ChatEventPayload——命令能力是 transient 状态，不被当成聊天消息持久化（计划 Task 2 Step 4）。
 */
export interface CommandChangedPayload {
  sessionId: string;
  snapshot: SessionCommandSnapshot;
}

/** 新会话创建 / probe 进行中 / 无数据时的初始快照：loading + 空命令。 */
export function createDefaultCommandSnapshot(sessionId: string): SessionCommandSnapshot {
  return {
    sessionId,
    commands: [],
    status: 'loading',
    source: 'cache',
    updatedAt: null,
  };
}
