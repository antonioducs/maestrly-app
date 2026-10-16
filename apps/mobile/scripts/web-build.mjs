// The app's web build, for the scripts that drive it in Chromium through the demo server.
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const dist = path.join(root, 'web-dist')

/** Exports the web build to `web-dist/`, unless the command line asks to reuse the last one with `--no-export`. */
export function exportWebBuild(argv = process.argv) {
  if (argv.includes('--no-export')) return
  const result = spawnSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['expo', 'export', '--platform', 'web', '--output-dir', 'web-dist', '--clear'],
    { cwd: root, stdio: 'inherit', shell: process.platform === 'win32', env: { ...process.env, EXPO_NO_TELEMETRY: '1', CI: '1' } }
  )
  if (result.status !== 0) process.exit(result.status ?? 1)
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.css': 'text/css',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

/** Serves the build as a single-page app: a known file, else the app's page for every route. */
export async function serveWebBuild() {
  const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    let file = path.join(dist, path.normalize(pathname).replace(/^([/\\])+/, ''))
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = path.join(dist, 'index.html')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    res.end(readFileSync(file))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }
}
