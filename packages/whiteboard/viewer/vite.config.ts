import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const outDir = path.resolve(__dirname, '../build/viewer')
const excalidrawDist = path.resolve(__dirname, 'node_modules/@excalidraw/excalidraw/dist/prod')

/**
 * Excalidraw loads its fonts at run time from EXCALIDRAW_ASSET_PATH; they ship next to the bundle, never from a CDN.
 * Their licenses ship with them: the npm package carries none, so `licenses/` holds the upstream texts.
 */
function excalidrawFonts(): Plugin {
  return {
    name: 'excalidraw-fonts',
    writeBundle() {
      cpSync(path.join(excalidrawDist, 'fonts'), path.join(outDir, 'fonts'), { recursive: true })
      cpSync(path.resolve(__dirname, 'licenses'), path.join(outDir, 'licenses'), { recursive: true })
      for (const file of readdirSync(path.join(excalidrawDist, 'fonts'), { recursive: true }) as string[]) {
        if (!/^(?:LICENSE|OFL)/i.test(path.basename(file))) continue
        const target = path.join(outDir, 'licenses/fonts', file)
        mkdirSync(path.dirname(target), { recursive: true })
        cpSync(path.join(excalidrawDist, 'fonts', file), target)
      }
    },
  }
}

// The URL is a template with a nested template inside its `${…}`, so the match spans one level of braces.
const FALLBACK = /"ASSETS_FALLBACK_URL",`https:\/\/esm\.sh\/\$\{(?:[^{}]|\{[^{}]*\})*\}\/dist\/prod\/`/g

/**
 * Excalidraw adds esm.sh as a second source of every font face, which the content CSP blocks with one console error
 * per face. The fallback becomes the local asset path, which `asset-path.ts` sets before Excalidraw loads. The build
 * fails if the pattern is not found exactly once, so a new Excalidraw version cannot bring the CDN back unnoticed.
 */
function excalidrawOffline(): Plugin {
  let replaced = 0
  return {
    name: 'excalidraw-offline',
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw/dist/prod/')) return null
      const next = code.replace(FALLBACK, () => {
        replaced++
        return '"ASSETS_FALLBACK_URL",window.EXCALIDRAW_ASSET_PATH'
      })
      return next === code ? null : { code: next, map: null }
    },
    buildEnd() {
      if (replaced !== 1)
        this.error(`Expected one Excalidraw font fallback, patched ${replaced}: re-check the pinned version`)
    },
    writeBundle() {
      if (!existsSync(outDir)) return
      for (const file of readdirSync(outDir, { recursive: true }) as string[])
        if (/\.(?:js|css|html)$/.test(file) && readFileSync(path.join(outDir, file), 'utf8').includes('esm.sh'))
          this.error(`${file} still references esm.sh`)
    },
  }
}

export default defineConfig({
  // Served under a capability path that changes per session: every URL in the bundle must be relative.
  base: './',
  plugins: [react(), excalidrawFonts(), excalidrawOffline()],
  define: { 'process.env.IS_PREACT': JSON.stringify('false') },
  build: { outDir, emptyOutDir: true, target: 'es2022', assetsInlineLimit: 0, chunkSizeWarningLimit: 4096 },
})
