// 自绘 FilePickerDialog（替换 Windows 原生文件/目录选择弹窗）的共享类型：
// 只读文件系统元数据（列根/列目录/新建文件夹/查存在）+ 导出目标协商。
// 本文件只放类型，无运行时逻辑、无 Electron/Node/Vue 副作用，契约脚本可直接导入。

export interface FsDirEntry { name: string; isDir: boolean; size: number; mtimeMs: number; hidden: boolean; }
export type FsListError = 'access-denied' | 'not-found' | 'timeout';
export type FsListResult =
  | { ok: true; path: string; entries: FsDirEntry[] }
  | { ok: false; path: string; error: FsListError };
export interface FsDriveInfo { letter: string; path: string; }   // 如 { letter: 'C', path: 'C:\\' }
export interface FsQuickLocation { id: string; label: string; path: string; }
export interface FsRootsResult { ok: true; cwdHome: string; quick: FsQuickLocation[]; drives: FsDriveInfo[]; }
export type FsMkdirResult = { ok: true; path: string } | { ok: false; error: 'invalid-name' | 'exists' | 'denied' | 'not-found' };
export type FsStatResult = { exists: boolean; isDir: boolean; size: number };
// 导出目标协商（后续 Task 用，本 Task 只落类型）
export interface ExportTargetRequest { jobId: string; multi: boolean; format: 'jpeg' | 'png'; suggestedName: string; sessionName: string; }
export type ExportTargetResponse =
  | { kind: 'directory'; dir: string }
  | { kind: 'save'; dir: string; filename: string }
  | { kind: 'cancel'; reason: 'user' | 'timeout' | 'window-closed' };
