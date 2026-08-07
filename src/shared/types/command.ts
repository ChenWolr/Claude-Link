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
 * 单命令来源（Task 2：区分 builtin / 用户 Skill / 插件 / 项目 / 内部 / 已移除 / 未知）。
 * - 这是单命令的 provenance，不是快照发现链路（CommandSnapshotSource）。
 * - `unknown` 只允许作为显式差异状态（待后续分类任务），不得当作已完成来源。
 */
export type CommandOrigin =
  | 'builtin'
  | 'user-skill'
  | 'project'
  | 'plugin'
  | 'internal'
  | 'removed'
  | 'unknown';

/** 命令可渲染状态：available=菜单可用；hidden=removed/internal 不展示；unknown=来源未知（非完成态）。 */
export type CommandAvailability = 'available' | 'hidden' | 'unknown';

/**
 * 来源分类所需上下文（来自 system.init 的 skills / plugins / slash_commands）。
 * `project 文件来源`（项目内 .claude/commands 等）尚无 SDK 数据通道，预留为分类顺序中的一环。
 */
export interface CommandOriginContext {
  skills: string[];
  plugins: string[];
  slashCommands: string[];
  /** 文件/插件元数据建立的可验证命令来源与 canonical name 映射。 */
  evidence?: {
    origins: Record<string, CommandOrigin>;
    canonicalNames: Record<string, string>;
  };
}

/** 空上下文：无 skills/plugins 时，命令只能靠 removed/internal 描述与已知 builtin 名称分类。 */
export const EMPTY_COMMAND_ORIGIN_CONTEXT: CommandOriginContext = {
  skills: [],
  plugins: [],
  slashCommands: [],
};

/**
 * SDK SlashCommand 经主进程 toSdkCommand 清洗后的可序列化形态。
 * 仅保留 UI 需要的字符串字段；aliases 缺省为 []。source 固定 'sdk'（Workflow/Agent Teams/
 * sub-agent 不伪造为 slash command，见计划 §0.3）。
 * origin / availability 由 toSdkCommand 依 CommandOriginContext 分类得出；SDK 当前没有结构化
 * provenance 字段，故这两项是 Claude Link 侧的可验证分类，不表示 SDK 官方来源标注。
 */
export interface SdkCommand {
  name: string;
  description: string;
  argumentHint: string;
  aliases: string[];
  source: 'sdk';
  /** 单命令来源分类（unknown 只作显式差异，不作完成）。 */
  origin: CommandOrigin;
  /** 可渲染状态：removed/internal → hidden；来源无法判断 → unknown；其余 available。 */
  availability: CommandAvailability;
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
