// interaction-cancel.ts
// 交互取消相关的共享纯函数。

// 判定「系统取消未答复权限弹窗」是否需要落库可见反馈。
//
// 背景：killProcess（watchdog 硬杀 / upstream_fatal / 队列取消）会静默 cancel 该会话
// 全部 pending 交互弹窗——用户侧表现为弹窗凭空消失，无任何解释（排查文档遗留项 1）。
// user（用户主动中断，弹窗消失符合预期）与 session_cleanup（会话已删，落库必失败）
// 不在此列；api_retry_exhausted 属网络重试语义，也不发。
//
// 纯函数，被 sdk-backend.ts killProcess 调用，由 regression-tests 覆盖行为契约。
export function shouldNotifyInteractionCancelled(reason: string, hadPending: boolean): boolean {
  return (reason === 'watchdog' || reason === 'upstream_fatal' || reason === 'queue') && hadPending;
}

// AskUserQuestion 取消文案映射（P2-7）：与权限的 mapPermissionInteractionResponse 同一来源
// 区分——cancel 的 reason 透传到 deny 文案：用户主动取消保留归因文案；系统取消（signal abort/
// 窗口关闭/会话删除/IPC 失败）用中性文案，防止 CLI 把指控性 tool_result(is_error) 记入
// transcript，resume 时让模型误读「用户拒绝过提问」。缺省按中性处理（宁可不指控用户）。
export function mapAskUserQuestionCancel(reason?: string | null): { behavior: 'deny'; message: string } {
  if (reason === 'user') {
    return { behavior: 'deny', message: '用户取消了选择题交互' };
  }
  return { behavior: 'deny', message: '提问交互已取消' };
}
