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
