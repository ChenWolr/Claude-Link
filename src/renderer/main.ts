import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
// diff2html 结构与配色基础样式：两栏 side-by-side 布局、+/- 行底色全靠它。
// 先于 main.css 引入；后者用 .markdown-body .d2h-*（特异性 0,2,0 高于 diff2html 的 0,1,0）
// 覆盖其中需主题化的部分——靠特异性取胜，与加载顺序无关，先引仅为可读惯例。
import 'diff2html/bundles/css/diff2html.min.css';
// hljs 语法高亮主题：diff 弹窗逐行高亮（diff-highlight.ts）、聊天 Markdown 代码块（markdown.ts
// 输出 .hljs 类）与交互预览共用。随后引入的 main.css 以同特异性（0,1,0）源序覆盖 .hljs 底色与
// 多数常用 token 类，未覆盖的 token 类沿用本主题配色。atom-one-light 与 contrast 的 Atom 主题血统同源。
import 'highlight.js/styles/atom-one-light.css';
import './assets/styles/main.css';
// KaTeX 渲染所需的样式与 woff2 字体（随包打包，无外联）。
import 'katex/dist/katex.min.css';

createApp(App).use(createPinia()).use(router).mount('#app');
