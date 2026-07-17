import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import router from './router';
import './assets/styles/main.css';
// KaTeX 渲染所需的样式与 woff2 字体（随包打包，无外联）。
import 'katex/dist/katex.min.css';

createApp(App).use(createPinia()).use(router).mount('#app');
