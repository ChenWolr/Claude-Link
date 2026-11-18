// win-tree-kill.ts —— best-effort：按会话 CLI resume sessionId（UUID）匹配进程命令行，
// 对命中者 taskkill /PID <pid> /T /F（含子孙进程 = 进程内 subagent loop 起的孙进程）。
// UI13-P7：SDK 无公开 pid API，但 CLI 进程命令行含 --resume <uuid>（3825 行 sdkOptions.resume
// 同源）；detached 等不在 Electron 子进程表的进程也按命令行命中。匹配失败 / PowerShell
// 不可用 / 非 win32 / 无 resumeId 均静默放弃，不影响主链路与终态上报。
// B2（2026-11-15 eight-issues）：探针形态进程（--no-session-persistence 持有者）经 WMIQL
// 排除子句豁免，不再被同链树杀误杀——中断兜底探针先于本树杀调度（finishKill 内）且命令行
// 同含 --resume <uuid>，无排除子句时必被自己链条的树杀击杀（13-21s 地板前死，自残缺陷）。
import { spawn } from 'node:child_process';

export function scheduleWindowsTreeKill(resumeSessionId: string | null): void {
  if (process.platform !== 'win32' || !resumeSessionId) return;
  // UUID 精确匹配命令行 --resume <uuid>（不匹配进程名——兼容 node/cli.js 包装形态）。
  // B2（2026-11-15 eight-issues）机制裁定：以「树杀目标集最终判定」兑现行为契约 #1「任何路径
  // 探针不被同链树杀击杀」——契约原文按字面读需同步等树杀完成再调度探针，但本函数是
  // spawn+unref 的 fire-and-forget（PS 枚举 1-3s 无完成回调可接），且探针调度点在 finishKill
  // 内部（被接管路径 spawnForChat forceKill 复用），迁出超最小影响面；故在目标集构造时按
  // 探针唯一持有参数 --no-session-persistence（src/shared/post-turn-probe.ts:18 全仓唯一代码
  // 字面）排除探针进程——无论探针已 spawn/在 spawn 异步 env 构造窗/尚未调度，均不入目标集
  //（按参数特征而非 pid，无时序依赖）。本进程自身命令行含 LIKE 字面与排除参数字面，子句
  // 同时防树杀 PS 进程自匹配自杀。备选已否决：探针 --resume 改等号形态（破坏
  // tdd-effort-truth-verify:86-90 与 tdd-code-inline-fileref-verify:151-153 两份探针 args 契约，
  // 且 CLI 等号解析未实证）、探针 spawn 延迟 8s 等树杀窗过（PS 枚举时长无上界，启发式不可靠）。
  // 【指令字面修正，申报留痕】排除子句写作「AND NOT CommandLine LIKE '…'」而非指令原文
  // 「AND CommandLine NOT LIKE '…'」：本机（win32 19045 生产目标）WQL 实测不支持二元
  // 「field NOT LIKE」语法——两种 NOT LIKE 形态 Get-CimInstance 均报「无效查询」（HRESULT
  // 0x80041017，树杀整体 no-op），而「AND NOT <field> LIKE」形态查询有效（2026-11-15 四形态
  // 隔离探针实证，见点报告 B2-W1）。语义与指令完全一致（同一排除目标集），仅词序合 WQL 文法。
  const script =
    `Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%--resume ${resumeSessionId}%'` +
    ` AND NOT CommandLine LIKE '%--no-session-persistence%'" | ` +
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
