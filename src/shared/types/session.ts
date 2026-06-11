export interface Session {
  id: string;
  name: string;
  cliSessionId: string | null;
  model: string;
  workingDir: string | null;
  permissionMode: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions';
  maxTurns: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  rawEvent: string | null;
  eventType: string | null;
  costUsd: number | null;
  durationMs: number | null;
  parentTaskId: string | null;
  createdAt: string;
}
