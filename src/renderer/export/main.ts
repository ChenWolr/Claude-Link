// 导出 renderer 入口（隐藏 export 窗口加载）。
// 阶段二：fixture 色带闭环（捕获→拼接→JPEG→分块→finish）。
// 阶段三：替换 ExportPage 为真实消息组件 + groupMessagesForRender + export profile。
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
  void runExport();
}
