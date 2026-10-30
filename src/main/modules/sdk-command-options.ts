// sdk-command-options.ts
// 纯函数：把会话配置与增量 SpawnOptions 合并为完整 probe/query options（review-v2 N1 修复）。
//
// 背景：SESSION_UPDATE 重新探测时只传本次 IPC 的增量 patch（如仅 { workingDir }），若直接当完整
// probe options 使用，会丢失 modelOverride / model / providerOverride / workingDir /
// permissionMode / maxTurns / thinkingLevel，导致探测上下文与会话真实上下文漂移（N1）。
// 本函数用 sessionRepo 读出的完整 Session 补全 opts 缺失字段（增量优先）。
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
  if (merged.providerOverride === undefined || merged.providerOverride === null) merged.providerOverride = session.providerOverride;
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
  /**
   * strictMcpConfig 门控信号（B-2，2026-10-29 H2 收紧口径）：effective overrides 中至少一键命中
   * 三层现存定义（孤儿键不算；B-M1 加固同轮：读失败/负缓存短路层不可观测且存在 'off' 键时
   * 上游亦保守置 true），由上游 mergeMcpServersIntoSettings.overridesHitExisting 计算、
   * 经调用方（sdk-backend 两处 core input 构造点：buildSdkOptions / buildProbeSdkOptions，注释
   * 互指）传入。true 时必须保持 strict 压制引擎原生加载（project .mcp.json/user settings/插件/
   * frontmatter MCP），否则「禁用」与 UI 禁用键失效；未传/false 且未挂载顶层 mcpServers（未接管
   * 态）→ strict=false，恢复引擎原生加载（与 Claude Code 终端行为一致）。
   */
  mcpOverridesActive?: boolean;
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
  | 'strictMcpConfig'
  | 'mcpServers'
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
    | 'strictMcpConfig'
    | 'mcpServers'
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
  // P2-5：有效档为 'default' 时**不设置** options.permissionMode——SDK 层 'default' 是 truthy，
  // 必发 `--permission-mode default` 旗标，而旗标优先于原生 settings.permissions.defaultMode，
  // 会把用户 settings 级联钉死在默认档。不传 = 让原生 settings 自决，与 sdk-permissions
  // 「default 不写 settings 层」的意图贯通。非 default 档照传。
  if (input.permissionMode !== undefined && input.permissionMode !== 'default') {
    options.permissionMode = input.permissionMode as PermissionMode;
    if (input.permissionMode === 'bypassPermissions') {
      options.allowDangerouslySkipPermissions = true;
    }
  }
  if (input.settings !== undefined) {
    options.settings = input.settings;
    // D-V1-1 修复（MCP 会话注入通道错配）：strictMcpConfig=true 下引擎只认顶层 Options.mcpServers
    //（运行时等价 --mcp-config 旗标，sdk.mjs：`Object.keys(mcpServers).length > 0` 才推旗标并经
    // JSON.stringify 序列化），settings 块内的 mcpServers 键会被忽略——故把 settings.mcpServers
    // 非空时的归一 map 同步挂到顶层。挂载值为同一引用（mergeMcpServersForSession 归一产物，
    // 与 settings.mcpServers 同源同值，不另起合并逻辑）；载体为 null 原型对象，Object.keys 计数
    // 与 JSON 序列化对 null 原型均正常（selftest-mcp-settings I 组钉住）。空配置（三层全空/全被
    // 禁用）时 merge 链不写 settings.mcpServers 键 → 此处不挂载，保持「空 MCP 配置零注入」
    // （settings 块空态字节级一致的行为约束不变）。settings 块内 mcpServers 键保留不动（SDK
    // strict 下忽略它，无害）。
    const sessionMcpServers = input.settings.mcpServers;
    if (
      sessionMcpServers !== undefined &&
      sessionMcpServers !== null &&
      typeof sessionMcpServers === 'object' &&
      !Array.isArray(sessionMcpServers) &&
      Object.keys(sessionMcpServers as Record<string, unknown>).length > 0
    ) {
      options.mcpServers = sessionMcpServers as SdkOptions['mcpServers'];
    }
  }
  if (input.additionalDirectories !== undefined) options.additionalDirectories = input.additionalDirectories;
  // MCP 管理（P5，D-V1-1 修正口径 + B-2 门控化）：strict 取「已挂载 ∨ overrides 激活」——
  // - 接管态 A（挂载）：三层合并产物非空、经上方挂载进顶层 Options.mcpServers（strict=true 下
  //   引擎【只】认该顶层键，settings 块内 mcpServers 键被忽略；会话钉住 overrides 见
  //   buildClaudeLinkSettingsBlock 的 mergeMcpServersIntoSettings）。
  // - 接管态 B（overrides 激活，input.mcpOverridesActive=true）：effective overrides 中至少一键
  //   命中现存定义（孤儿键不算——H2 收紧，2026-10-29，由上游 mergeMcpServersIntoSettings 的
  //   overridesHitExisting 计算）但 merged 可能为空（钉住禁用+其余全空）——必须仍 strict=true
  //   压制引擎原生拉起，否则「禁用」失效（UI 禁用键失真，selftest-mcp-settings I5 钉死该保底
  //   分支）。孤儿键（外部删除后残留的纯 'off' 键）不命中现存定义 → 不触发 strict（H2：引擎
  //   原生来源恢复加载，不再被静默丢弃）。
  // - 未接管态（两者皆无 = 用户完全未接管 MCP）：strict=false，恢复引擎原生加载（project
  //   .mcp.json/user settings/插件/frontmatter MCP），与 Claude Code 终端行为一致——strict=true
  //   会把这些原生来源全部静默丢弃（selftest-mcp-settings I4 钉死）。
  // strict=true 副作用（§3.13，UI note 由 P7 呈现）：claude.ai 云端 connectors 与插件 MCP 不再
  // 自动加载——这是「禁用必须生效」的必要代价。
  options.strictMcpConfig = options.mcpServers !== undefined || input.mcpOverridesActive === true;
  return options;
}
