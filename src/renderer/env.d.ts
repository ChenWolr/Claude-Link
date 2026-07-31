import type { ClaudeLinkAPI, ExportLinkAPI } from '../preload/api';

declare global {
  interface Window {
    claudeLink: ClaudeLinkAPI;
    exportLink?: ExportLinkAPI;
  }
}

// 无类型声明的 markdown-it 插件垫片（CJS 默认导出 = markdown-it 插件函数）。
declare module 'markdown-it-task-lists';

export {};
