#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const desktopRoot = path.join(root, 'apps', 'desktop')
const electronDir = path.join(root, 'node_modules', 'electron')
const pathFile = path.join(electronDir, 'path.txt')
const installScript = path.join(electronDir, 'install.js')

function electronReady() {
  if (!fs.existsSync(pathFile)) return false
  const rel = fs.readFileSync(pathFile, 'utf8').trim()
  return rel.length > 0 && fs.existsSync(path.join(electronDir, 'dist', rel))
}

function ensureElectron() {
  if (!fs.existsSync(installScript)) {
    console.warn('[postinstall] electron package not found — skipping binary download')
    return
  }
  if (electronReady()) return

  const distDir = path.join(electronDir, 'dist')
  if (fs.existsSync(distDir)) {
    console.log('[postinstall] Electron binary incomplete — clearing dist/ and reinstalling')
    fs.rmSync(distDir, { recursive: true, force: true })
  }
  try {
    fs.unlinkSync(pathFile)
  } catch {
    /* ok */
  }

  console.log('[postinstall] downloading Electron binary…')
  const result = spawnSync(process.execPath, [installScript], { stdio: 'inherit', cwd: root })
  if (result.status !== 0 || !electronReady()) {
    throw new Error('Failed to install Electron binary. Try: rm -rf node_modules/electron/dist && npm run postinstall')
  }
}

function runNodeScript(script, args) {
  const result = spawnSync(process.execPath, [path.join(root, script), ...args], {
    stdio: 'inherit',
    cwd: desktopRoot,
    shell: false,
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
}

ensureElectron()
runNodeScript('node_modules/electron-builder/install-app-deps.js', [])
