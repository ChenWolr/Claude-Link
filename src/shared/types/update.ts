// src/shared/types/update.ts
// 应用内检查更新的主↔渲染共享形状（modules/app-updater ↔ preload ↔ 设置页关于 tab）。
export type AppUpdateStatus =
  | 'unavailable' // 开发模式（!app.isPackaged）：更新链路不接入
  | 'idle'        // 初始
  | 'checking'    // 检查中
  | 'available'   // 发现新版本（即将自动开始下载）
  | 'downloading' // 下载中
  | 'downloaded'  // 已就绪，等待用户点「重启更新」
  | 'installing'  // quitAndInstall 进行中
  | 'error'       // 检查/下载/安装失败
  | 'latest';     // 已是最新

export interface AppUpdateProgress {
  percent: number; // 0-100 整数
  bytesPerSecond: number;
  transferred: number;
  total: number;
}

export interface AppUpdateState {
  status: AppUpdateStatus;
  newVersion: string | null;
  releaseNotes: string | null; // GitHub Release body 原文（Markdown 源码，关于 tab 纯文本展示）
  progress: AppUpdateProgress | null;
  error: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  state: AppUpdateState;
}
