// 静态资产导入垫片（未启用 vite/client types）：.png 以默认导出 URL 字符串消费（关于 tab 扉页图标）。
// 必须保持脚本形 .d.ts（顶层不得出现 import/export）——模块形 d.ts 内的通配符 declare module
// 不被相对导入解析采用（探针实证：同一声明在 env.d.ts 模块形态下 TS2307，独立脚本形通过）。
declare module '*.png' {
  const src: string;
  export default src;
}
