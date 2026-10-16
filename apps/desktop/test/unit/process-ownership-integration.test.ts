import { spawn } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Real processes on Linux: a node-pty shell and the bash tool. Every process here carries a marker of this run in its
 * environment, and cleanup signals only those, checked against their start time: the host may be shared.
 */

vi.mock('node-pty', async () => {
  const { createRequire: requireFrom } = await import('node:module')
  try {
    return requireFrom(import.meta.url)('node-pty')
  } catch {
    return { spawn: () => Promise.reject(new Error('node-pty is unavailable')) }
  }
})
vi.mock('../../src/main/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/platform')>()),
  freeTerminalShell: () => ({ file: '/bin/bash', args: ['--norc', '--noprofile'] }),
}))
vi.mock('../../src/main/store', () => ({ getFreeTerminalShell: () => null }))
vi.mock('../../src/main/window-ipc', () => ({
  broadcast: vi.fn(),
  sendToPanel: vi.fn(),
  sendToConversation: vi.fn(),
}))
vi.mock('../../src/main/performance/metrics', () => ({
  incrementPerformanceCounter: vi.fn(),
  recordIpcSend: vi.fn(),
}))

import { createShellPty, killPtyTree, writePty } from '../../src/main/pty-manager'
import { bashTool } from '../../src/main/chat/tools/bash'
import type { ToolContext } from '../../src/main/chat/tools/util'
import { stopConversationProcesses } from '../../src/main/process-ownership/conversation-processes'
import { hasOwnedGroups, stopOwnedGroups } from '../../src/main/process-ownership/owned-groups'
import { parseProcStat } from '../../src/main/process-ownership/process-table'

const ptyAvailable = (() => {
  try {
    createRequire(import.meta.url)('node-pty')
    return true
  } catch {
    return false
  }
})()

const MARKER_KEY = 'PROCESS_OWNERSHIP_TEST_MARKER'
const marker = randomUUID()

interface Marked {
  pid: number
  startTime: string
  command: string
}

/** Processes of this run only: the marker sits in their environment. */
function marked(): Marked[] {
  const out: Marked[] = []
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue
    try {
      if (!readFileSync(`/proc/${name}/environ`, 'utf8').split('\0').includes(`${MARKER_KEY}=${marker}`)) continue
      const stat = parseProcStat(readFileSync(`/proc/${name}/stat`, 'utf8'))
      if (!stat || stat.zombie) continue
      const command = readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').filter(Boolean).join(' ')
      out.push({ pid: stat.pid, startTime: stat.startTime, command })
    } catch {
      // Ended, or not ours to read.
    }
  }
  return out
}

const sleeps = (): string[] =>
  marked()
    .map((process) => process.command)
    .filter((command) => /^sleep \d+$/.test(command))
    .sort()

function killMarked(): void {
  for (const process of marked()) {
    const stat = (() => {
      try {
        return parseProcStat(readFileSync(`/proc/${process.pid}/stat`, 'utf8'))
      } catch {
        return null
      }
    })()
    if (stat?.startTime !== process.startTime) continue
    try {
      globalThis.process.kill(process.pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function context(conversationId: string, cwd: string): ToolContext {
  return {
    conversationId,
    projectId: null,
    messageId: 'message',
    toolCallId: 'call',
    cwd,
    signal: new AbortController().signal,
    ask: async () => {},
    askQuestion: async () => [],
  }
}

function startShell(id: string, owner: string, cwd: string): Promise<number> {
  let output = ''
  return new Promise<number>((resolveExit) => {
    createShellPty({
      id,
      cwd,
      cols: 120,
      rows: 40,
      env: { [MARKER_KEY]: marker },
      owner,
      onData: (data) => void (output += data),
      onExit: (code) => resolveExit(code),
    })
  })
}

describe.skipIf(process.platform !== 'linux')('conversation process ownership on a real system', () => {
  let dir = ''

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'process-ownership-'))
  })
  afterEach(() => {
    killMarked()
    vi.unstubAllEnvs()
  })
  afterAll(() => {
    killMarked()
    rmSync(dir, { recursive: true, force: true })
  })

  it.skipIf(!ptyAvailable)(
    'ends a terminal with everything its shell started except what left the session with setsid',
    async () => {
      const id = `term:conv-pty-${marker}:1`
      void startShell(id, 'conv-pty', dir)
      const patterns = [
        'sleep 4401 >/dev/null 2>&1 &',
        'nohup sleep 4402 >/dev/null 2>&1 &',
        'sleep 4403 >/dev/null 2>&1 & disown',
        'setsid sleep 4404 >/dev/null 2>&1 &',
        '(sleep 4405 >/dev/null 2>&1 &)',
        '(trap "" HUP; exec sleep 4406) >/dev/null 2>&1 &',
        'sh -c "sleep 4407 >/dev/null 2>&1 &" &',
      ]
      await new Promise((resolve) => setTimeout(resolve, 300))
      for (const pattern of patterns) writePty(id, `${pattern}\r`)
      await vi.waitFor(() => expect(sleeps()).toHaveLength(7), { timeout: 5_000, interval: 50 })

      const result = await killPtyTree(id, { graceMs: 1_500, killMs: 1_000 })

      expect(result).toEqual({ exited: true, survivors: [] })
      await vi.waitFor(() => expect(sleeps()).toEqual(['sleep 4404']), { timeout: 2_000, interval: 50 })
    },
    20_000
  )

  it.skipIf(!ptyAvailable)(
    'keeps what a closed shell left running until its conversation stops it',
    async () => {
      const id = `term:conv-exit-${marker}:1`
      const exited = startShell(id, 'conv-exit', dir)
      await new Promise((resolve) => setTimeout(resolve, 300))
      writePty(id, 'sleep 4501 >/dev/null 2>&1 &\r')
      writePty(id, 'nohup sleep 4502 >/dev/null 2>&1 &\r')
      await vi.waitFor(() => expect(sleeps()).toEqual(['sleep 4501', 'sleep 4502']), { timeout: 5_000, interval: 50 })
      writePty(id, 'exit\r')
      await exited

      // Closing the shell alone keeps them.
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(sleeps()).toEqual(['sleep 4501', 'sleep 4502'])
      expect(hasOwnedGroups('conv-exit')).toBe(true)

      await expect(stopOwnedGroups('conv-exit', { graceMs: 1_500, killMs: 1_000 })).resolves.toEqual({ survivors: [] })
      await vi.waitFor(() => expect(sleeps()).toEqual([]), { timeout: 2_000, interval: 50 })
    },
    20_000
  )

  it("ends a server the bash tool sent to the background with its conversation, and nothing that is not the conversation's", async () => {
    vi.stubEnv(MARKER_KEY, marker)
    const result = await bashTool.execute(
      { command: 'sleep 4601 >/dev/null 2>&1 & echo started' },
      context('conv-bash', dir)
    )
    expect(result.output.trim()).toBe('started')
    // Another conversation's command and a process no conversation started.
    await bashTool.execute({ command: 'nohup sleep 4602 >/dev/null 2>&1 &' }, context('conv-other', dir))
    const foreign = spawn('sleep', ['4699'], { detached: true, stdio: 'ignore', env: { ...process.env } })
    foreign.unref()
    await vi.waitFor(() => expect(sleeps()).toEqual(['sleep 4601', 'sleep 4602', 'sleep 4699']), {
      timeout: 5_000,
      interval: 50,
    })
    await vi.waitFor(() => expect(hasOwnedGroups('conv-bash')).toBe(true))

    await expect(stopConversationProcesses('conv-bash')).resolves.toEqual({
      ok: true,
      terminalsExited: true,
      survivors: [],
    })

    await vi.waitFor(() => expect(sleeps()).toEqual(['sleep 4602', 'sleep 4699']), { timeout: 2_000, interval: 50 })
    expect(hasOwnedGroups('conv-bash')).toBe(false)
    // A second stop finds nothing left.
    await expect(stopConversationProcesses('conv-bash')).resolves.toMatchObject({ ok: true, survivors: [] })
    await stopOwnedGroups('conv-other', { graceMs: 1_500, killMs: 1_000 })
    await vi.waitFor(() => expect(sleeps()).toEqual(['sleep 4699']), { timeout: 2_000, interval: 50 })
  }, 20_000)
})
