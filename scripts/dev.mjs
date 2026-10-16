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
  removeDeadAutoProfiles,
  removeOwnAutoProfile,
  validateInstanceId,
  writeLauncherLock,
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

/** `--local`: run as a desktop app even from a shell inside a Maestrly bot or workspaces host container. */
const local = process.argv.includes('--local')

function requestedInstanceFromArgv() {
  const args = process.argv.slice(2).filter((a) => a !== '--' && a !== '--local')
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
      // A generated profile is this run's own: the lock names it as owner from the start.
      const generated = requested == null
      if (generated) writeLauncherLock(dir)
      return { instance, emphasis, userDataPath: displayPath(dir), generated }
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

// Profiles earlier unnamed runs left behind, once their launcher and app are gone.
for (const dir of removeDeadAutoProfiles()) console.log(`Removed the unused development profile ${displayPath(dir)}.`)

const requested = requestedInstanceFromArgv()
const { instance, emphasis, userDataPath, generated } = resolveInstance(requested)

setTerminalWindowTitle(instance)
const tintHex = setTerminalBackground(instance)
printInstanceLaunchBanner(instance, { emphasis, userDataPath, tintHex })

const electronVite = resolveBin('electron-vite')
const env = {
  ...process.env,
  AGENTS_CHANNEL: 'dev',
  AGENTS_INSTANCE: instance,
}
if (local) {
  // The container's variables would start a second host on its control port, which the running one already holds.
  const { FLEET_BOT_ENV, FLEET_CONVERSATION_COMPUTER_LIMITS } = await import('@maestrly/bot-fleet-protocol')
  const removed = Object.values(FLEET_BOT_ENV).filter((name) => name in env)
  for (const name of removed) delete env[name]
  if (removed.length > 0) console.log(`Running as a desktop app; ignoring ${removed.join(', ')}.`)
  const display = Number(/^:(\d+)/.exec(env.DISPLAY ?? '')?.[1])
  if (removed.includes(FLEET_BOT_ENV.serverMode) && !(display >= FLEET_CONVERSATION_COMPUTER_LIMITS.firstDisplay)) {
    console.log(
      "The window opens on the environment's own display, which no one sees. To see it, open this conversation's " +
        'Computer tab, then run this command in a terminal opened after it.'
    )
  }
}

// The app asks before quitting, and in a container it may ask where no one sees it. So that stopping never leaves it
// running, it gets a process group of its own, and whatever is left of that group shortly after a stop is ended.
const ownGroup = local && process.platform !== 'win32'
const STOP_GRACE_MS = 5_000

const child = spawn(electronVite, ['dev'], {
  cwd: desktopRoot,
  env,
  // Outside the terminal's foreground group a read from it would stop the process; nothing here needs input.
  stdio: ownGroup ? ['ignore', 'inherit', 'inherit'] : 'inherit',
  shell: process.platform === 'win32',
  detached: ownGroup,
})

function groupAlive() {
  try {
    process.kill(-child.pid, 0)
    return true
  } catch (error) {
    return error.code === 'EPERM'
  }
}

function signalGroup(signal) {
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is gone.
  }
}

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
  const exit = () => process.exit(signal ? 1 : (code ?? 0))
  if (!ownGroup || !groupAlive()) return exit()
  // electron-vite is gone but the app is not: it may be waiting on its quit confirmation.
  signalGroup('SIGTERM')
  const deadline = Date.now() + STOP_GRACE_MS
  const timer = setInterval(() => {
    if (groupAlive() && Date.now() < deadline) return
    clearInterval(timer)
    if (groupAlive()) {
      signalGroup('SIGKILL')
      console.log('The development app did not close, so it was stopped.')
    }
    exit()
  }, 200)
})

if (ownGroup) {
  // A closed terminal must not end this script before it stopped the app.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {})
}

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    // Signal first: once the terminal is gone, writing to it can fail.
    if (ownGroup) signalGroup(sig)
    else child.kill(sig)
    cleanup()
  })
}

process.on('exit', cleanup)

// A generated profile is not meant to be reopened, so it goes with this run; if the app is still running, the next run
// removes it once the app is gone.
if (generated) process.on('exit', () => removeOwnAutoProfile(devUserDataDir(instance)))
