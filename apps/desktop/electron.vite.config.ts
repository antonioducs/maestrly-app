import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // Keep ML inference in utility processes so it does not block the main process.

        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'ml-worker': resolve(__dirname, 'src/main/ml-worker.ts'),
          'asr-worker': resolve(__dirname, 'src/main/asr-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
      },
    },
    build: {
      rollupOptions: {
        // The panel entry serves drawer tabs hosted in a WebContentsView.

        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          panel: resolve(__dirname, 'src/renderer/panel.html'),
        },
      },
    },
  },
})
