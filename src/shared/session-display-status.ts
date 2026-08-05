// session-display-status.ts
// 会话侧栏展示状态解析。纯逻辑模块，不依赖 Vue、Pinia、Electron。
//
// sessionStatus 是 store 的基础终态（running/completed/network_interrupted）；
// apiRetryInfo 是主进程权威 retry 瞬态的 per-session 投影。侧栏展示状态由两者按
// 固定优先级解析：终态（completed/network_interrupted）优先于可能残留的 retry
// 瞬态，避免已完成或已中断后被迟到的 api_retry 显示成闪烁红灯。
//
// 不要把 retrying 写入 sessionStatus：apiRetryInfo 继续作为 retrying 的唯一真相源。

export type SessionStatus = 'running' | 'completed' | 'network_interrupted';

export type SessionDisplayStatus =
  | 'idle'
  | 'running'
  | 'retrying'
  | 'completed'
  | 'network_interrupted';

export interface SessionStatusMeta {
  label: string;
  blinking: boolean;
}

// 解析优先级固定：
//   1. completed            ：绿灯常亮（终态最高）；
//   2. network_interrupted  ：红灯常亮（终态第二）；
//   3. hasApiRetry          ：红灯闪烁（retry 瞬态覆盖 running 黄灯）；
//   4. running              ：黄灯闪烁；
//   5. 其它                 ：idle，无灯。
export function resolveSessionDisplayStatus(
  status: SessionStatus | undefined,
  hasApiRetry: boolean,
): SessionDisplayStatus {
  if (status === 'completed') return 'completed';
  if (status === 'network_interrupted') return 'network_interrupted';
  if (hasApiRetry) return 'retrying';
  if (status === 'running') return 'running';
  return 'idle';
}

// 展示元数据：集中返回状态文案与是否闪烁。颜色 token 仍留在 Vue/CSS 层，
// 不在共享层定义主题色。
export function sessionDisplayStatusMeta(status: SessionDisplayStatus): SessionStatusMeta {
  switch (status) {
    case 'running':
      return { label: '执行中', blinking: true };
    case 'retrying':
      return { label: '网络异常，正在重试', blinking: true };
    case 'completed':
      return { label: '任务已完成', blinking: false };
    case 'network_interrupted':
      return { label: '网络异常，已中断', blinking: false };
    default:
      return { label: '', blinking: false };
  }
}
