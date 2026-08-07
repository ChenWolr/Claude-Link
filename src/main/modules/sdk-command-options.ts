// sdk-command-options.ts
// 纯函数：把会话配置与增量 SpawnOptions 合并为完整 probe/query options（review-v2 N1 修复）。
//
// 背景：SESSION_UPDATE 重新探测时只传本次 IPC 的增量 patch（如仅 { workingDir }），若直接当完整
// probe options 使用，会丢失 modelOverride / model / permissionMode / maxTurns / thinkingLevel，
// 导致探测上下文与会话真实上下文漂移（N1）。本函数用 sessionRepo 读出的完整 Session 补全 opts
// 缺失字段（增量优先）。
//
// Task 3：新增 buildNativeSdkOptionsCore——统一生产 query / 全局 probe / per-session probe 的
// 核心 SDK options 组装。保证两类调用走同一构造逻辑，避免 probe 与真实回合配置漂移；且绝不传
// settingSources（原生 user/project/local 来源恢复，见计划 Task 3 Step 3）。
//
// review-v1 F6：工厂也接收「claude-link 显式 settings 块」与 additionalDirectories——显式 settings
// 由 sdk-backend 的 buildClaudeLinkSettingsBlock 单一构造后传入（query/probe 共用同一块），本工厂
// 负责把它放进 Options.settings 与 Options.additionalDirectories，杜绝 probe 与真实回合配置漂移。
// 不依赖 electron / DB——session 由调用方（sdk-backend）读取后传入，便于 tsx 行为测试。
import type { Options as SdkOptions, PermissionMode } from '@anthropic-ai/claude-agent-sdk';
import type { SpawnOptions } from './cli-shared';
import type { Session } from '../../shared/types/session';

export function mergeSpawnOptions(session: Session | null, opts: SpawnOptions): SpawnOptions {
  if (!session) return opts;
  const merged: SpawnOptions = { ...opts };
  if (merged.model === undefined || merged.model === null) merged.model = session.model;
  if (merged.modelOverride === undefined || merged.modelOverride === null) merged.modelOverride = session.modelOverride;
  if (merged.workingDir === undefined || merged.workingDir === null) merged.workingDir = session.workingDir;
  if (merged.maxTurns === undefined || merged.maxTurns === null) merged.maxTurns = session.maxTurns;
  if (merged.permissionMode === undefined || merged.permissionMode === null) merged.permissionMode = session.permissionMode;
  if (merged.thinkingLevel === undefined || merged.thinkingLevel === null) merged.thinkingLevel = session.thinkingLevel;
  return merged;
}

/** buildNativeSdkOptionsCore 的输入：由调用方解析好的核心配置字段（env/exe/model 等）。 */
export type NativeSdkOptionsCoreInput = Pick<
  SdkOptions,
  'env' | 'pathToClaudeCodeExecutable' | 'model' | 'thinking' | 'effort' | 'cwd' | 'maxTurns' | 'permissionMode'
> & {
  /** cliPath 已解析后的 exe；使用 exe 别名兼容现有调用方。 */
  exe?: string;
  /**
   * claude-link 显式 settings 块（review-v1 F6）。由 sdk-backend 的 buildClaudeLinkSettingsBlock
   * 单一构造（projection 顶层 + 会话级 permissions + 动态注入 env + thinking patch），query 与 probe
   * 共用同一块，放进 Options.settings（优先级高于原生 user/project/local 文件来源）。
   */
  settings?: Record<string, unknown>;
  /** 用户配置与附件目录并集；非空时需同时写顶层 Options 与 settings.permissions（调用方已写后者）。 */
  additionalDirectories?: string[];
};

/**
 * Task 3：统一核心 SDK options 组装（原生 settings 来源）。
 * - 不传 `settingSources` → SDK 默认加载 user/project/local 文件来源（原生 settings 语义恢复）。
 * - env / exe / model / thinking / effort / cwd / maxTurns / permissionMode 一律经此组装，
 *   生产 query 与 probe 共用同一逻辑，杜绝两者配置漂移（计划 Task 3 Step 3）。
 * - review-v1 F6：显式 settings 块与 additionalDirectories 也经此统一放入 Options，query/probe
 *   不得各自另起一份 settings 构造。
 * - 交互 hook（canUseTool / onElicitation / onUserDialog）由调用方在核心外追加（probe 无交互不注入）。
 */
export function buildNativeSdkOptionsCore(input: NativeSdkOptionsCoreInput): Pick<
  SdkOptions,
  | 'env'
  | 'pathToClaudeCodeExecutable'
  | 'model'
  | 'thinking'
  | 'effort'
  | 'cwd'
  | 'maxTurns'
  | 'permissionMode'
  | 'allowDangerouslySkipPermissions'
  | 'settings'
  | 'additionalDirectories'
> {
  const options: Pick<
    SdkOptions,
    | 'env'
    | 'pathToClaudeCodeExecutable'
    | 'model'
    | 'thinking'
    | 'effort'
    | 'cwd'
    | 'maxTurns'
    | 'permissionMode'
    | 'allowDangerouslySkipPermissions'
    | 'settings'
    | 'additionalDirectories'
  > = {
    env: input.env,
  };
  const exe = input.exe ?? input.pathToClaudeCodeExecutable;
  if (exe !== undefined) options.pathToClaudeCodeExecutable = exe;
  if (input.model !== undefined) options.model = input.model;
  if (input.thinking !== undefined) options.thinking = input.thinking;
  if (input.effort !== undefined) options.effort = input.effort;
  if (input.cwd !== undefined) options.cwd = input.cwd;
  if (input.maxTurns !== undefined && input.maxTurns > 0) options.maxTurns = input.maxTurns;
  if (input.permissionMode !== undefined) {
    options.permissionMode = input.permissionMode as PermissionMode;
    if (input.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
  }
  if (input.settings !== undefined) options.settings = input.settings;
  if (input.additionalDirectories !== undefined) options.additionalDirectories = input.additionalDirectories;
  return options;
}
