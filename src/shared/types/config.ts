// Claude Code 的模型类型别名（CLI 通过 env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL 映射到实际模型）。
export type ModelAlias = 'sonnet' | 'haiku' | 'opus' | 'fable';
import type { NonAutoThinkingLevel } from './thinking';
import type { PermissionMode } from '../permission-resolver';

export interface AppConfig {
  provider: 'anthropic' | 'openrouter' | 'bedrock' | 'vertex';
  providerName: string;
  providerNote: string;
  apiKey: string;
  apiBaseUrl: string;
  defaultModel: string;
  advancedJson: string;
  cliPath: string | null;
  cliVersion: string | null;
  workingDirectory: string | null;
  // 全局默认权限档（新会话与未单独设权限的会话回落到此值）。会话级 Session.permissionMode
  // 为 null = 跟随此全局默认，非 null = 该会话显式选定档（见 permission-resolver）。
  permissionMode: PermissionMode;
  maxTurns: number;
  // 队列任务总开关（默认关）。开：回复生成中会话框可继续输入发送并入队 + 回合结束后按间隔自动
  // 执行队列；关：回复生成中禁止发送（旧行为），队列不自动执行（面板手动「开始」仍可用）。
  queueEnabled: boolean;
  // 队列任务间隔（分钟，1-60，默认 5）。
  taskDelayMinutes: number;
  themePaletteId: string;
  fontScale: 'small' | 'medium' | 'large';
  // 按模型类型别名单独设置的上下文窗口（token 数）。写入 env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>。
  // 未列出的别名 = 未设置，圆环分母回落 DEFAULT_CONTEXT_WINDOW（200k）。仅 claude-link 内部
  // 用于 ContextButton 占比分母；CC 自身不消费此 env。连通后仍以 SDK 上报的真实窗口为准。
  contextWindowByAlias: Partial<Record<ModelAlias, number>>;
  // 默认思考强度档位（新会话与未单独设档的会话回落到此值）。
  // 'auto' 在全局层无意义（全局默认本身就是 auto 的回落目标），用 NonAutoThinkingLevel 编译期拦截。
  defaultThinkingLevel: NonAutoThinkingLevel;
  // 多供应商库（r3-r9）：「最近一次会话选用」的记忆性字段，只作新会话初始值，不是选用语义。
  // 供应商档案本体（含加密 key）只在主进程 config-manager 内部，经 config:listProviders 以
  // ProviderProfileView（掩码）出主进程，故不进 AppConfig 公开形状。
  lastUsedProviderId: string | null;
  lastUsedModelId: string | null;
  // 失焦系统通知开关：主窗口未聚焦时，会话完成 / 网络异常中断是否弹桌面右下角系统通知。
  // 仅控制「离开会话后」的通知；窗口聚焦时本就静默（见 session-completion-notifier 守卫）。
  notifyOnLeave: boolean;
  // 后台运行开关：为 true 时托盘图标常驻（启动即创建，运行中右下角可见），点击窗口关闭
  // 按钮只把主窗口隐藏到系统托盘，而非退出进程；需在托盘图标右键「退出」才真正结束程序。
  // 为 false 时无托盘，关闭窗口直接退出（现状行为）。
  minimizeToTray: boolean;
  // reasoning_replay（DeepSeek thinking 回传 400）自动重试开关：回合结束后主进程以相同
  // 用户文本自动重发一次（单次、~2s 延迟、同文本防重入）。默认开（同形状重放大概率通过）。
  autoRetryReasoningReplay: boolean;
}

// ── 多供应商 × 无限模型库（设置页 = 可选项库，会话内选用）────────────────
// 公开形状不含任何密钥材料：明文只在主进程内存，密文只在 electron-store 落盘。
export interface ProviderProfile {
  id: string; // uuid
  name: string; // 显示名（必填）
  note: string; // 备注（可选）
  apiBaseUrl: string; // 必填
  models: ProviderModel[]; // 无限，顺序即展示序
  createdAt: number;
  updatedAt: number;
}

export interface ProviderModel {
  id: string; // 模型 ID（同供应商内唯一，重复添加报错）
  name: string; // display_name，手动添加时 = id
  maxTokens: number; // 端点返回的 max_output_tokens，未知为 0
  source: 'queried' | 'manual';
  addedAt: number;
}

// 落盘形状：encryptedApiKey 与全局 apiKey 同机制（safeStorage 优先，不可用时明文降级）。
export interface StoredProviderProfile extends ProviderProfile {
  encryptedApiKey: string | null;
  apiKeyEncoding: 'safeStorage' | 'plain' | null;
}

// 渲染层视图：apiKey 只剩掩码（sk-…****xxxx）。
export interface ProviderProfileView extends ProviderProfile {
  apiKeyMasked: string;
  hasApiKey: boolean;
}

// 保存档案的输入：apiKey 仅在创建/修改时以明文进入主进程，落盘前加密；
// 编辑时省略（undefined/null）= 保留原密钥，显式空串 = 清除。
// models 提供时整体替换（增删模型走此路径；renderer 持有完整无密钥列表）。
export interface ProviderSaveInput {
  id?: string | null;
  name: string;
  note?: string;
  apiBaseUrl: string;
  apiKey?: string | null;
  models?: ProviderModel[];
}

// config:listProviders 的返回：档案视图 + 最近选用记忆（会话选择器解析显示用）。
export interface ProviderLibrarySnapshot {
  providers: ProviderProfileView[];
  lastUsedProviderId: string | null;
  lastUsedModelId: string | null;
}

export interface ProviderInfo {
  id: string;
  name: string;
  apiBaseUrl: string;
  modelsEndpoint: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  maxTokens: number;
}

// 自动检测 Claude Code 系统配置的结果。OAuth token 绝不读取内容，只判断存在性；
// apiKey 来自 settings.json 的 env.*，最终经 safeStorage 加密入库。
export interface DetectedOauthAccount {
  email?: string;
  accountUuid?: string;
  organizationType?: string;
}

export interface DetectedClaudeConfig {
  found: boolean;
  sources: Array<'settings.json' | '.claude.json' | '.credentials.json'>;
  apiKey?: string;
  apiBaseUrl?: string;
  defaultModel?: string;
  apiKeyHelper?: string;
  oauthAccount?: DetectedOauthAccount;
  hasOAuthCredentials: boolean;
  advancedJson: string;
  errors: string[];
}

// 测试连接结果：用当前配置调 Claude Code CLI 发送一条简单消息，
// 有正常响应文本代表配置（URL/Key/模型）可用。
export interface ConnectionTestResult {
  success: boolean;
  message: string;
  responsePreview?: string;
  durationMs?: number;
}
