import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stopStaleChromium } from '../../src/main/fleet/instance/bot-browser/process'

const roots: string[] = []
const children: Array<ReturnType<typeof spawn>> = []

/** A process whose command line names a profile, as a Chromium left behind would. */
function holder(profileArg: string) {
  const child = spawn('/bin/sh', ['-c', 'sleep 30', 'chromium', `--user-data-dir=${profileArg}`], {
    detached: true,
    stdio: 'ignore',
  })
  children.push(child)
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  return { child, exited }
}

function newProfile(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'stale-chromium-'))
  roots.push(root)
  const profile = path.join(root, 'chromium')
  mkdirSync(profile)
  return profile
}

/** Chromium's lock: a link to `<host>-<pid>` of the browser using the profile. */
function lock(profile: string, pid: number, host = os.hostname()): string {
  symlinkSync(`${host}-${pid}`, path.join(profile, 'SingletonLock'))
  return profile
}

afterEach(() => {
  for (const child of children.splice(0)) {
    try {
      process.kill(-child.pid!, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe.skipIf(process.platform !== 'linux')('stopStaleChromium', () => {
  it('stops the browser left holding this very profile', async () => {
    const profile = newProfile()
    const left = holder(profile)
    lock(profile, left.child.pid!)
    await stopStaleChromium(profile, (ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    await left.exited
    expect(left.child.signalCode).toBe('SIGTERM')
  })

  it('leaves alone a process of another profile or another computer, and a profile without a lock', async () => {
    const other = holder('/somewhere/else')
    await stopStaleChromium(lock(newProfile(), other.child.pid!))
    await stopStaleChromium(lock(newProfile(), other.child.pid!, 'another-host'))
    await stopStaleChromium(path.join(os.tmpdir(), 'no-such-profile'))
    expect(other.child.exitCode).toBeNull()
    expect(other.child.signalCode).toBeNull()
  })

  it('removes the locks a profile brought from another computer', async () => {
    const moved = lock(newProfile(), 4242, 'old-environment')
    symlinkSync('old-environment-socket', path.join(moved, 'SingletonSocket'))
    writeFileSync(path.join(moved, 'Cookies'), 'kept')
    await stopStaleChromium(moved)
    expect(readdirSync(moved)).toEqual(['Cookies'])
  })
})
