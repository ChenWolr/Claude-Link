// sdk-errors.ts
// SDK/Claude Code 错误分类的纯函数集合，保持无 Electron 依赖，便于脚本级回归测试。

export function isMissingConversationResumeError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID:/i.test(message);
}
