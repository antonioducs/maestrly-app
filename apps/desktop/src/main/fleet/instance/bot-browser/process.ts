import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Readable, Writable } from 'node:stream'
import type { ChromiumProcess } from './chromium-supervisor'

/** Opens Chromium with the bot's own profile (`MAESTRLY_BOT_BROWSER_PROFILE`): see `deploy/bot-fleet`. */
export const BOT_BROWSER_COMMAND = '/usr/local/bin/maestrly-bot-browser'
const STDERR_TAIL_BYTES = 4096

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal)
  } catch {
    /* The group already exited. */
  }
}

/**
 * Starts a bot's Chromium with its DevTools pipe on fds 3 and 4, in a process group of its own so that stopping it
 * also stops its renderers and helpers. Whatever of the group outlives the browser itself is killed once it exits.
 */
export function spawnBotChromium(args: string[], env: Record<string, string>): ChromiumProcess {
  const child = spawn(BOT_BROWSER_COMMAND, args, {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    detached: true,
  })
  let stderr = ''
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString('utf8')).slice(-STDERR_TAIL_BYTES)
  })
  const commands = child.stdio[3] as Writable
  const messages = child.stdio[4] as Readable
  const exited = new Promise<number | null>((resolve) => {
    child.once('error', (error) => {
      stderr = `${stderr}\n${error.message}`.slice(-STDERR_TAIL_BYTES)
      messages.destroy()
      resolve(127)
    })
    child.once('exit', (code) => {
      if (child.pid) signalGroup(child.pid, 'SIGKILL')
      resolve(code)
    })
  })
  return {
    pid: child.pid,
    commands,
    messages,
    exited,
    kill: (signal) => {
      if (child.pid) signalGroup(child.pid, signal)
    },
    stderrTail: () => stderr,
  }
}

/** The links by which Chromium keeps one browser per profile. */
const PROFILE_LOCKS = ['SingletonLock', 'SingletonSocket', 'SingletonCookie']

/**
 * Frees the profile from a Chromium that no longer uses it. One left behind by a Maestrly that crashed still runs and
 * holds it: Chromium keeps one browser per profile, so a new one would hand its window to that one and exit without a
 * pipe. Only a Chromium of this computer whose command line names this very profile is stopped. A lock naming another
 * computer came with the profile from another environment (a move), whose browser cannot be running here: Chromium
 * would refuse the profile, so the lock goes.
 */
export async function stopStaleChromium(profile: string, wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {
  let target: string
  try {
    target = await fs.readlink(path.join(profile, 'SingletonLock'))
  } catch {
    return
  }
  const match = /^(.*)-(\d+)$/.exec(target)
  if (!match) return
  if (match[1] !== os.hostname()) {
    await Promise.all(PROFILE_LOCKS.map((name) => fs.rm(path.join(profile, name), { force: true })))
    return
  }
  const pid = Number(match[2])
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return
  let commandLine: string
  try {
    commandLine = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0').join(' ')
  } catch {
    return
  }
  if (!commandLine.includes(`--user-data-dir=${profile}`)) return
  // The bots' Chromium leads a process group of its own: the whole group goes, its renderers with it.
  const kill = (signal: NodeJS.Signals) => {
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        /* It exited meanwhile. */
      }
    }
  }
  const alive = () => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }
  kill('SIGTERM')
  for (let tenth = 0; tenth < 50 && alive(); tenth++) await wait(100)
  if (alive()) kill('SIGKILL')
  for (let tenth = 0; tenth < 20 && alive(); tenth++) await wait(100)
}
