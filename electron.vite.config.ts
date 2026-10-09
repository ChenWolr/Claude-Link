import { resolve } from 'path'
import { spawnSync } from 'node:child_process'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// 构建指纹：git short rev（+脏标记）与 UTC 构建时刻，经 define 注入 main/renderer，
// 供关于页展示与主进程启动日志比对——「装到的二进制≠刚改的源码」从此可被发现。
// git 不可用/非 git 目录 → 'nogit'，不抛错；脏工作树 → '-dirty' 后缀。
function computeBuildRev(): string {
  try {
    const rev = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim();
    if (!rev) return 'nogit';
    // vite 加载配置时会先在项目根写临时文件 electron.vite.config.<timestamp>.mjs（加载结束即删），
    // 而 computeBuildRev 恰在该文件存续窗口内执行——不剔除则干净树恒判 -dirty（指纹自测量干扰）。
    const dirty = (spawnSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).stdout || '')
      .split('\n')
      .some((line) => line.trim() && !/^\?\?\s+electron\.vite\.config\.\d+\.mjs$/.test(line.trim()))
      ? '-dirty'
      : '';
    return rev + dirty;
  } catch {
    return 'nogit';
  }
}
const buildDefine = {
  __CL_BUILD_REV__: JSON.stringify(computeBuildRev()),
  __CL_BUILD_TIME__: JSON.stringify(new Date().toISOString()),
}

export default defineConfig({
  main: {
    define: buildDefine,
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['better-sqlite3'],
        // v4.1 PNG codec worker：作为独立 rollup input 产出单独文件，供主进程 new Worker(path) 加载。
        // packaged 内 worker 无法从 asar 加载（electron#18540）→ electron-builder.json5 asarUnpack 解包。
        input: {
          index: resolve('src/main/index.ts'),
          exportImageCodecWorker: resolve('src/main/modules/export-image-codec-worker.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    root: resolve('src/renderer'),
    define: buildDefine,
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
