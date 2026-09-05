// 「上回合实际生效思考强度」提取（纯函数，供 sdk-backend 与契约测试共用）。
//
// 数据源：CLI 会话 JSONL（~/.claude/projects/<munged(cwd)>/<cliSessionId>.jsonl）中 assistant 事件的
// 顶层 effort 字段。该字段是 CLI 记录的「静默降级后实际生效档」（SDK 文档：after any silent
// downgrade for the selected model），比注入值（Options.effort）更真。
// 值域：'low' | 'medium' | 'high' | 'xhigh' | 'max'（ultracode 档在 JSONL 记为 xhigh）。

/** 从 JSONL 全文提取最后一条含 effort 的 assistant 事件 effort 值；无命中返回 null。 */
export function extractLastEffortFromJsonl(text: string): string | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line.includes('"effort"')) continue;
    try {
      const ev = JSON.parse(line) as { type?: unknown; effort?: unknown };
      if (ev && ev.type === 'assistant' && typeof ev.effort === 'string' && ev.effort) {
        return ev.effort;
      }
    } catch {
      // 行级容错：跳过半写入行
    }
  }
  return null;
}

/**
 * CLI 会话项目目录名 munge：cwd 逐字符把非 [A-Za-z0-9] 替换为 '-'（与 Claude Code 落盘一致，
 * 实测：D:\software\code\claude-link → D--software-code-claude-link；
 *       C:\Users\...\Temp\claude-probe-cwd → C--Users-...-Temp-claude-probe-cwd）。
 */
export function mungeProjectDirName(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}
