// win-tree-kill.ts —— best-effort：按会话 CLI resume sessionId（UUID）匹配进程命令行，
// 对命中者 taskkill /PID <pid> /T /F（含子孙进程 = 进程内 subagent loop 起的孙进程）。
// UI13-P7：SDK 无公开 pid API，但 CLI 进程命令行含 --resume <uuid>（3825 行 sdkOptions.resume
// 同源）；detached/探针等不在 Electron 子进程表的进程也按命令行命中。匹配失败 / PowerShell
// 不可用 / 非 win32 / 无 resumeId 均静默放弃，不影响主链路与终态上报。
import { spawn } from 'node:child_process';

export function scheduleWindowsTreeKill(resumeSessionId: string | null): void {
  if (process.platform !== 'win32' || !resumeSessionId) return;
  // UUID 精确匹配命令行 --resume <uuid>（不匹配进程名——兼容 node/cli.js 包装形态与探针进程）。
  const script =
    `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%--resume ${resumeSessionId}%'" | ` +
    `ForEach-Object { taskkill /PID $_.ProcessId /T /F }`;
  try {
    // 编排裁定（2026-11-14，P7 点报告「冲突申报」#1，证据 P7-treekill-live.log）：
    // 不用 detached —— 本机（win32 19045 + PowerShell 5.1）实测 detached 形态下 PowerShell
    // 无控制台启动即静默退出（-Command 不执行，树杀系统性 no-op）；Windows 父进程退出不级联
    // 杀子进程（无 kill-on-close Job object），stdio:'ignore' + windowsHide + unref 已达成
    // 「fire-and-forget 且 Electron 退出后树杀仍收尾」的契约意图。
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore', windowsHide: true,
    });
    child.unref(); // 防 Electron 退出后中断树杀（unref 即解绑事件循环引用，父退出不阻塞）
  } catch { /* 静默：PowerShell 不可用/被策略禁等，放弃兜底不影响主链路 */ }
}
