// session-completion.ts
// 跨进程共享的成功/失败终态纯函数：判定一次 CliEvent 是否为「成功完成」或「错误完成」。
// 渲染层侧栏绿灯、错误展示、落库跳过与主进程失焦完成通知共用同一判定（F1 统一四套
// 略有差异的 isErrResult/成功判定）；纯函数不 import Electron，可被 selftest 直接行为测试。

import type { CliEvent } from './types/cli';

/**
 * 判断一次会话终态事件是否为「成功完成」。
 *
 * 规则（与 isErrorCliResult 对普通成功/失败/缺 subtype 的 result 互补）：
 *  - 非 result 事件（error / aborted / stream_event 等）一律 false；
 *  - `error_during_execution`（用户 SIGINT/abort 的正常收尾）不是成功完成；
 *  - `is_error` 的 result 必须显式 success subtype 才算成功；
 *  - `is_error=true` 且缺失成功 subtype（含 undefined）一律判失败——防止第三方端点把
 *    错误结果伪装成成功（配合 result-converter 保留真实 subtype，不再提前补 success）。
 */
export function isSuccessfulCliResult(event: CliEvent): boolean {
  if (event.type !== 'result') return false;
  if (event.subtype === 'error_during_execution') return false;
  return !event.is_error || event.subtype === 'success';
}

/**
 * 判断一次会话终态事件是否为「错误完成」（供错误展示 / 落库跳过使用）。
 *
 * 与 isSuccessfulCliResult 的唯一差异在 error_during_execution：用户中断既不是成功
 * 也不是错误（不亮绿灯、不弹错误横幅），故两个函数对它都返回 false。
 * 旧 isErrResult（use-chat / cli-shared）对 `is_error=true + subtype=undefined` 判「非错误」，
 * 此处收紧：缺失 subtype 的错误 result 一律判失败，避免错误文本被当正常回答展示/落库。
 */
export function isErrorCliResult(event: CliEvent): boolean {
  if (event.type !== 'result') return false;
  if (event.subtype === 'error_during_execution') return false;
  return !!event.is_error && event.subtype !== 'success';
}

/**
 * 判断一次会话终态事件是否为「被中断」（用户 abort / SIGINT 收尾）。
 *
 * 仓库实证的 aborted 形态（grep src/shared/types/cli.ts 与 use-chat）：
 *  - `type==='aborted'`：sdk-backend 在「用户中断（interruptedQueries / killProcess user·watchdog
 *   补发）或流末未收到 result（不问退出码，第三方端点丢 result 也触发）」时合成的本地事件；
 *  - `type==='result' && subtype==='error_during_execution'`：用户 SIGINT/abort 的正常 result 收尾
 *   （CC 真实 subtype 集内唯一的中断值；不存在 abort_no_wait/abort_cv 之类的 result subtype）。
 * 与 isSuccessfulCliResult/isErrorCliResult 对 error_during_execution 的「双 false」互补：
 * 中断既不是成功也不是错误，是第三态。
 */
export function isAbortedCliResult(event: CliEvent): boolean {
  if (event.type === 'aborted') return true;
  if (event.type !== 'result') return false;
  return event.subtype === 'error_during_execution';
}
