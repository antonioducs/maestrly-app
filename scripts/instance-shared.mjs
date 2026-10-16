import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const INSTANCE_LOCK_FILE = '.agents-instance.lock'
/** Written by `npm run dev` into the auto profile it picked, before the app starts: the profile then always has an owner. */
export const DEV_LAUNCHER_LOCK_FILE = '.dev-launcher.lock'
export const DEV_USER_DATA_BASE = 'maestrly-app-dev'
/** Profiles of unnamed `npm run dev` runs. Named instances and the base profile never match. */
export const AUTO_PROFILE_RE = /^maestrly-app-dev-auto-[0-9a-f]{4}$/
/** Folders whose worktrees are registered in a repository; removing them would leave its `.git/worktrees` behind. */
const REGISTERED_CHECKOUT_DIRS = ['worktrees', 'aggregators']

export const INSTANCE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,31}$/

export function appDataRoot() {
  const home = os.homedir()
  switch (process.platform) {
    case 'darwin':
      return path.join(home, 'Library/Application Support')
    case 'win32':
      return process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    default:
      return process.env.XDG_CONFIG_HOME || path.join(home, '.config')
  }
}

export function devUserDataDir(instanceId) {
  const base = DEV_USER_DATA_BASE
  const name = instanceId ? `${base}-${instanceId}` : base
  return path.join(appDataRoot(), name)
}

export function displayPath(absPath) {
  const home = os.homedir()
  return absPath.startsWith(home) ? `~${absPath.slice(home.length)}` : absPath
}

export function generateAutoInstanceId() {
  const hex = Math.floor(Math.random() * 0xffff)
    .toString(16)
    .padStart(4, '0')
  return `auto-${hex}`
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readInstanceLock(userDataDir) {
  const lockPath = path.join(userDataDir, INSTANCE_LOCK_FILE)
  if (!existsSync(lockPath)) return null
  try {
    const data = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (typeof data?.pid !== 'number' || typeof data?.instance !== 'string') return null
    return data
  } catch {
    return null
  }
}

export function clearStaleLock(userDataDir) {
  const lock = readInstanceLock(userDataDir)
  if (!lock) return null
  if (isPidAlive(lock.pid)) return lock
  try {
    unlinkSync(path.join(userDataDir, INSTANCE_LOCK_FILE))
  } catch {
    /* ignore */
  }
  return null
}

/** Like isPidAlive, but a process this user may not signal counts as running: when in doubt, keep. */
export function isPidRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export function writeLauncherLock(userDataDir, pid = process.pid) {
  mkdirSync(userDataDir, { recursive: true })
  writeFileSync(path.join(userDataDir, DEV_LAUNCHER_LOCK_FILE), JSON.stringify({ pid, startedAt: Date.now() }), 'utf8')
}

/** The pid of a lock file; null when there is none, 'unreadable' when it cannot be trusted. */
function lockPid(file) {
  if (!existsSync(file)) return null
  try {
    const pid = JSON.parse(readFileSync(file, 'utf8'))?.pid
    return Number.isInteger(pid) && pid > 0 ? pid : 'unreadable'
  } catch {
    return 'unreadable'
  }
}

/**
 * Why an auto profile must stay, or null when it can go: a real directory named like one, with at least one lock, every
 * lock readable and naming a process that is gone (`deadPids` are taken as gone), and no registered checkouts. A
 * profile without a lock stays: nothing proves its run ended, and another launcher may be creating it.
 */
export function autoProfileBlocker(dir, { isRunning = isPidRunning, deadPids = [] } = {}) {
  if (!AUTO_PROFILE_RE.test(path.basename(dir))) return 'not an auto profile'
  let stats
  try {
    stats = lstatSync(dir)
  } catch {
    return 'missing'
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) return 'not a directory'
  const pids = [DEV_LAUNCHER_LOCK_FILE, INSTANCE_LOCK_FILE]
    .map((name) => lockPid(path.join(dir, name)))
    .filter((pid) => pid !== null)
  if (pids.length === 0) return 'no lock'
  if (pids.includes('unreadable')) return 'unreadable lock'
  if (pids.some((pid) => !deadPids.includes(pid) && isRunning(pid))) return 'running'
  for (const name of REGISTERED_CHECKOUT_DIRS) {
    let entries = []
    try {
      entries = readdirSync(path.join(dir, name))
    } catch {
      // Missing: nothing registered.
    }
    if (entries.length > 0) return `has ${name}`
  }
  return null
}

function removeProfile(dir, options, warn) {
  // Checked again right before removal: another launcher may have just picked this profile.
  if (autoProfileBlocker(dir, options) !== null) return false
  try {
    rmSync(dir, { recursive: true, force: true })
    return true
  } catch (error) {
    warn(`Could not remove the development profile ${displayPath(dir)}: ${error.message}`)
    return false
  }
}

/** Removes the auto profiles under `root` whose run is over (see autoProfileBlocker); returns the removed paths. */
export function removeDeadAutoProfiles(root = appDataRoot(), { isRunning = isPidRunning, warn = console.warn } = {}) {
  let names = []
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const removed = []
  for (const name of names.filter((candidate) => AUTO_PROFILE_RE.test(candidate)).sort()) {
    const dir = path.join(root, name)
    if (removeIfOver(dir, { isRunning }, warn)) removed.push(dir)
  }
  return removed
}

function removeIfOver(dir, options, warn) {
  const blocker = autoProfileBlocker(dir, options)
  if (blocker?.startsWith('has ')) {
    warn(
      `Kept the development profile ${displayPath(dir)}: it ${blocker} of a repository. Delete its conversations first.`
    )
  }
  return blocker === null && removeProfile(dir, options, warn)
}

/** When this launcher exits: removes the auto profile it created, unless its app is still running. */
export function removeOwnAutoProfile(
  dir,
  { isRunning = isPidRunning, ownPid = process.pid, warn = console.warn } = {}
) {
  return removeIfOver(dir, { isRunning, deadPids: [ownPid] }, warn)
}

export function validateInstanceId(id) {
  if (!INSTANCE_ID_RE.test(id)) {
    throw new Error(
      `Invalid instance ID: "${id}". Use letters, numbers, and hyphens (maximum 32; do not start with a hyphen).`
    )
  }
}
