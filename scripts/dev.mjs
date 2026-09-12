#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  printInstanceCollisionWarning,
  printInstanceLaunchBanner,
  resetTerminalBackground,
  setTerminalBackground,
  setTerminalWindowTitle,
} from './instance-color.mjs'
import {
  clearStaleLock,
  devUserDataDir,
  displayPath,
  generateAutoInstanceId,
  validateInstanceId,
} from './instance-shared.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const desktopRoot = path.join(root, 'apps', 'desktop')

function resolveBin(name) {
  const exe = process.platform === 'win32' ? `${name}.cmd` : name
  for (let dir = root; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', '.bin', exe)
    if (existsSync(candidate)) return candidate
    if (dir === path.dirname(dir)) break
  }
  return exe
}

function requestedInstanceFromArgv() {
  const args = process.argv.slice(2).filter((a) => a !== '--')
  if (args.length === 0) return null
  if (args.length > 1) {
    console.error('Use a single instance ID: npm run dev -- feat-chat')
    process.exit(1)
  }
  return args[0]
}

function resolveInstance(requested) {
  const noArgAtStart = requested == null
  if (requested) {
    try {
      validateInstanceId(requested)
    } catch (err) {
      console.error(err.message)
      process.exit(1)
    }
  }

  let instance = requested ?? generateAutoInstanceId()
  let emphasis = noArgAtStart

  for (let attempt = 0; attempt < 32; attempt++) {
    const dir = devUserDataDir(instance)
    const lock = clearStaleLock(dir)
    if (!lock) {
      return { instance, emphasis, userDataPath: displayPath(dir) }
    }
    if (requested) {
      const prev = instance
      instance = generateAutoInstanceId()
      printInstanceCollisionWarning(prev, lock.pid, instance)
      requested = null
      emphasis = true
      continue
    }
    instance = generateAutoInstanceId()
  }

  console.error('Could not find an available instance ID after repeated attempts.')
  process.exit(1)
}

const requested = requestedInstanceFromArgv()
const { instance, emphasis, userDataPath } = resolveInstance(requested)

setTerminalWindowTitle(instance)
const tintHex = setTerminalBackground(instance)
printInstanceLaunchBanner(instance, { emphasis, userDataPath, tintHex })

const electronVite = resolveBin('electron-vite')
const env = {
  ...process.env,
  AGENTS_CHANNEL: 'dev',
  AGENTS_INSTANCE: instance,
}

const child = spawn(electronVite, ['dev'], {
  cwd: desktopRoot,
  env,
  stdio: 'inherit',
  shell: process.platform === 'win32',
})

const reinforce = setTimeout(() => {
  setTerminalBackground(instance)
  setTerminalWindowTitle(instance)
}, 1200)

let cleanedUp = false
function cleanup() {
  if (cleanedUp) return
  cleanedUp = true
  clearTimeout(reinforce)
  resetTerminalBackground()
}

child.on('exit', (code, signal) => {
  cleanup()

  process.exit(signal ? 1 : (code ?? 0))
})

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    cleanup()
    child.kill(sig)
  })
}

process.on('exit', cleanup)
