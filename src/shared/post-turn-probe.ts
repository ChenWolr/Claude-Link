// 回合后 /context 探针的 CLI 参数构造（纯函数，供 sdk-backend 与契约测试共用）。
//
// --setting-sources ''：不加载任何 settings 文件（user/project/local）——connection-tester 同款防御
// （见 connection-tester.ts:99-105 注释）。原因：CLI 启动时 ~/.claude/settings.json 的 env 块会压过
// 继承的进程 env（2026-09-04 受控 A/B 探针定案），其 ANTHROPIC_DEFAULT_*_MODEL / SMALL_FAST /
// SUBAGENT 槽位钉死值会把探针进程的后台辅助请求劫持到别的模型。
// 探针只跑本地 /context 命令：不依赖 hooks/permissions（不加载 settings 无副作用）；--resume 读的
// 会话文件存储位置由 HOME/CLAUDE_CONFIG_DIR 决定，不受 setting-sources 影响。
// 注意：connection-tester 因 spawn 走 shell:true 需传 '""'（防 cmd 吞空参数）；此处 spawn 无 shell，
// 直接传空字符串。
export function buildPostTurnProbeArgs(cliSessionId: string): string[] {
  return [
    '--setting-sources', '',
    '-p', '/context',
    '--resume', cliSessionId,
    '--output-format', 'stream-json',
    '--verbose',
    '--no-session-persistence',
  ];
}
