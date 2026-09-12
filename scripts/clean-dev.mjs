#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEV_USER_DATA_BASE, appDataRoot, displayPath } from './instance-shared.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = path.join(root, 'apps', 'desktop')
const devDirPrefix = DEV_USER_DATA_BASE

function listDevUserDataDirs() {
  const base = appDataRoot()
  if (!fs.existsSync(base)) return []
  return fs
    .readdirSync(base, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (e.name === devDirPrefix || e.name.startsWith(`${devDirPrefix}-`)))
    .map((e) => path.join(base, e.name))
}

function removePath(absPath, label) {
  if (!fs.existsSync(absPath)) return false
  fs.rmSync(absPath, { recursive: true, force: true })
  console.log(`  ✓ ${label}: ${displayPath(absPath)}`)
  return true
}

function warnIfDevRunning() {
  if (process.platform === 'win32') return
  const pattern = 'electron-vite|Maestrly App Dev'
  const result = spawnSync('sh', ['-c', `pgrep -fl "${pattern}" 2>/dev/null || true`], {
    encoding: 'utf8',
  })
  const lines = (result.stdout || '').trim()
  if (!lines) return
  console.warn('[clean:dev] warning: a dev process appears to be running — close the app before cleanup:')
  for (const line of lines.split('\n')) console.warn(`  ${line}`)
  console.warn('')
}

console.log('[clean:dev] cleaning dev instances…')
warnIfDevRunning()

let removed = 0
for (const dir of listDevUserDataDirs()) {
  if (removePath(dir, 'userData')) removed++
}
if (removed === 0) {
  console.log('  (no maestrly-app-dev* directories found)')
}

console.log('[clean:dev] cleaning local artifacts…')
removePath(path.join(desktopRoot, 'out'), 'apps/desktop/out/')
removePath(path.join(root, 'node_modules', '.vite'), 'node_modules/.vite')

console.log('[clean:dev] done.')
