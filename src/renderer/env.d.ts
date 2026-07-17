import type { ClaudeLinkAPI } from '../preload/api';

declare global {
  interface Window {
    claudeLink: ClaudeLinkAPI;
  }
}

// 无类型声明的 markdown-it 插件垫片（CJS 默认导出 = markdown-it 插件函数）。
declare module 'markdown-it-task-lists';

export {};
