import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    plugins: [vue()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared'),
        '@': resolve('src/renderer')
      }
    },
    build: {
      rollupOptions: {
        // 双 renderer HTML 入口：主窗口 index.html + 隐藏导出窗口 export.html。
        // preload 仍为单入口（见 preload 配置），在两种 surface 下自包含加载。
        input: {
          index: resolve('src/renderer/index.html'),
          export: resolve('src/renderer/export.html')
        }
      }
    }
  }
})
