import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
// diff2html 结构与配色基础样式：两栏 side-by-side 布局、+/- 红绿行底色全靠它。
// 必须在 main.css 之前引入——main.css 用 .markdown-body .d2h-* 高特异性选择器做主题覆盖。
import 'diff2html/bundles/css/diff2html.min.css';
import './assets/styles/main.css';
// KaTeX 渲染所需的样式与 woff2 字体（随包打包，无外联）。
import 'katex/dist/katex.min.css';

createApp(App).use(createPinia()).use(router).mount('#app');
