import { contextBridge } from 'electron';
import { createApi, createExportApi, type ClaudeLinkAPI, type ExportLinkAPI } from './api';

// 单一 preload 入口，按主进程注入的 additionalArguments 分流 surface：
// - 主窗口（不带 surface 参数）→ 只暴露 window.claudeLink（完整 API）。
// - 隐藏导出窗口（--claude-link-surface=export）→ 只暴露 window.exportLink（最小 API）。
// surface 参数不是唯一授权条件；主进程仍按 sender（webContents 同一性）/frame（顶层 frame）/job（jobId 匹配）校验每次调用；URL 防护由导出窗口创建时的 link-guard（导航拦截）承担，不在每次 IPC 调用中校验。
const EXPORT_SURFACE_ARG = '--claude-link-surface=export';
const isExportSurface = process.argv.includes(EXPORT_SURFACE_ARG);

if (isExportSurface) {
  contextBridge.exposeInMainWorld('exportLink', createExportApi());
} else {
  contextBridge.exposeInMainWorld('claudeLink', createApi());
}

declare global {
  interface Window {
    claudeLink: ClaudeLinkAPI;
    exportLink: ExportLinkAPI;
  }
}
