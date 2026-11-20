#!/usr/bin/env node
// Captures every state of the prototype into reference/: 1440×900 for all of them, 390×844 for the panel states.
// Usage, from the repository root after `npm ci`: node prototypes/artifact-design-viewer/capture.mjs [state ...]
// It serves this folder on loopback, waits for each state to report it is ready, and fails on console errors.
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const { chromium } = createRequire(import.meta.url)('playwright')

export const DESKTOP = [
  'page',
  'inspect-hover',
  'inspect-instance',
  'inspect-nested',
  'inspect-main',
  'inspect-main-counting',
  'inspect-uses',
  'inspect-plain',
  'screens',
  'screens-focus',
  'screens-loading',
  'tokens',
  'tokens-loading',
  'tokens-error',
  'tokens-changes',
  'tokens-theme',
  'tokens-screens',
  'tokens-save',
  'tokens-saving',
  'tokens-saved',
  'tokens-conflict',
  'tokens-guest',
  'tokens-suggest',
  'tokens-suggest-sent',
  'tokens-readonly',
  'thread-suggestion',
  'thread-preview',
  'thread-apply',
  'thread-applied',
  'thread-summary',
  'thread-stale',
  'thread-apply-stale',
]
export const PHONE = [
  'page',
  'inspect-instance',
  'inspect-main',
  'inspect-plain',
  'screens',
  'screens-focus',
  'tokens',
  'tokens-changes',
  'tokens-theme',
  'tokens-save',
  'tokens-suggest',
  'thread-suggestion',
]

const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' }
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const file = path.join(here, decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname))
  if (!file.startsWith(here)) return res.writeHead(403).end()
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file')
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' })
    createReadStream(file).pipe(res)
  } catch {
    res.writeHead(404).end()
  }
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const origin = `http://127.0.0.1:${server.address().port}`

const only = new Set(process.argv.slice(2))
const pick = (list) => (only.size ? list.filter((state) => only.has(state)) : list)
const browser = await chromium.launch()
const problems = []

// One folder per window size, since artifact file names allow only letters, digits, ".", "_" and "-".
async function shoot(state, width, height) {
  const name = `${width}x${height}/${state}.png`
  await mkdir(path.join(here, 'reference', `${width}x${height}`), { recursive: true })
  const page = await browser.newPage({ viewport: { width, height }, locale: 'en-US', reducedMotion: 'reduce' })
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`${name}: ${message.text()}`)
  })
  page.on('pageerror', (error) => problems.push(`${name}: ${error.message}`))
  await page.goto(`${origin}/index.html?capture#${state}`)
  await page.waitForFunction((id) => document.documentElement.dataset.ready === id, state, { timeout: 30_000 })
  await page.waitForTimeout(250)
  await page.screenshot({ path: path.join(here, 'reference', name) })
  await page.close()
  console.log(`captured ${name}`)
}

try {
  for (const state of pick(DESKTOP)) await shoot(state, 1440, 900)
  for (const state of pick(PHONE)) await shoot(state, 390, 844)
} finally {
  await browser.close()
  server.close()
}
if (problems.length) {
  console.error(problems.join('\n'))
  process.exitCode = 1
}
