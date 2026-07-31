// Claude Code 的模型类型别名（CLI 通过 env.ANTHROPIC_DEFAULT_<ALIAS>_MODEL 映射到实际模型）。
export type ModelAlias = 'sonnet' | 'haiku' | 'opus' | 'fable';
import type { NonAutoThinkingLevel } from './thinking';

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
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns: number;
  taskDelaySeconds: number;
  themePaletteId: string;
  fontScale: 'small' | 'medium' | 'large';
  // 按模型类型别名单独设置的上下文窗口（token 数）。写入 env.CLAUDE_LINK_CONTEXT_WINDOW_<ALIAS>。
  // 未列出的别名 = 未设置，圆环分母回落 DEFAULT_CONTEXT_WINDOW（200k）。仅 claude-link 内部
  // 用于 ContextButton 占比分母；CC 自身不消费此 env。连通后仍以 SDK 上报的真实窗口为准。
  contextWindowByAlias: Partial<Record<ModelAlias, number>>;
  // 默认思考强度档位（新会话与未单独设档的会话回落到此值）。
  // 'auto' 在全局层无意义（全局默认本身就是 auto 的回落目标），用 NonAutoThinkingLevel 编译期拦截。
  defaultThinkingLevel: NonAutoThinkingLevel;
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
