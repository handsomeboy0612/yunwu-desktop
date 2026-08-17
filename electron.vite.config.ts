import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * 把 `.env` / `.env.local` 里的 `YUNWU_*` 灌进 `process.env`。
 *
 * electron-vite 自己只把带 `MAIN_VITE_` 等前缀的变量注入 `import.meta.env`,而主进程里那几个
 * 旋钮(`YUNWU_MARKET_BASE_URL` / `YUNWU_MARKET_TOKEN`)读的是运行时 `process.env` ——
 * 这段配置在父进程里执行,Electron 是它 spawn 出来的子进程,因此在这里设即被继承。
 *
 * 没有 `.env.local` 时什么都不做,行为与从前一致(仍可在 shell 里手动导出)。
 */
function loadYunwuEnv(): void {
  const env = loadEnv('development', __dirname, 'YUNWU_')
  for (const [key, value] of Object.entries(env)) {
    if (value && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

loadYunwuEnv()

/**
 * electron-vite 三段式配置:main(主进程)/ preload(预加载)/ renderer(渲染进程)。
 * main 与 preload 走 Node 环境,externalizeDepsPlugin 把 dependencies 外置避免打包 Node 原生模块;
 * renderer 走浏览器环境,使用 React 插件。
 */
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/main/index.ts') }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    resolve: {
      alias: {
        '@renderer': resolve(__dirname, 'src/renderer/src'),
        '@shared': resolve(__dirname, 'src/shared')
      }
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    plugins: [react()]
  }
})
