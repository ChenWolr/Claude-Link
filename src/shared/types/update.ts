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
  latestVersion: string | null; // 最近一次检查从 GitHub 获知的最新版本号，available/not-available 均写入；检查中/失败不清空——「永久显示」语义
  releaseNotes: string | null; // 更新说明：GitHub 源 latest.yml 未内嵌时由 electron-updater 取 releases.atom 的 HTML 渲染补齐，主进程经 normalizeReleaseNotes 归一为可读文本后入态；关于 tab/更新弹窗纯文本展示
  progress: AppUpdateProgress | null;
  error: string | null;
}

export interface AppUpdateInfo {
  currentVersion: string;
  state: AppUpdateState;
}
