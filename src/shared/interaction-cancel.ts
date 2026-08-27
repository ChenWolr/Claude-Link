// interaction-cancel.ts
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
