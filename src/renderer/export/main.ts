// 导出 renderer 入口（隐藏 export 窗口加载）：挂载真实 ExportPage，带 exportLink surface 时启动导出循环。
import { createApp } from 'vue';
import { createPinia } from 'pinia';
import ExportPage from './ExportPage.vue';
import { runExport } from './export-runner';
import '../assets/styles/main.css';
import 'katex/dist/katex.min.css';

const app = createApp(ExportPage);
app.use(createPinia());
app.mount('#app');

// 挂载后启动导出循环。preload 暴露的 window.exportLink 由 --claude-link-surface=export 触发。
// 若未带 surface（非导出窗口误加载），不启动。
if (typeof window !== 'undefined' && (window as { exportLink?: unknown }).exportLink) {
  // P3-12：runExport 内部已兜底 finish failed；此处 .catch 仅防兜底自身抛错成 unhandled rejection。
  runExport().catch(() => { /* 已兜底 */ });
}
