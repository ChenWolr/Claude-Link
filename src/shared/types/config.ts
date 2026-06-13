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
