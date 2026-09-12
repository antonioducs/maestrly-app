import os from 'node:os'
import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import { freeTerminalShell } from './platform'
import { getFreeTerminalShell } from './store'
import { incrementPerformanceCounter, recordIpcSend } from './performance/metrics'
import { registerOwnedProcess, unregisterOwnedProcess } from './performance/owned-processes'
import type { PtyOutputSnapshot, PtyOutputStats, PtyStreamMeta } from '../shared/pty'

interface ShellSession {
  proc: pty.IPty
  generation: number
}

interface OutputState {
  data: string
  generation: number
  sequence: number
  totalChars: number
}

const sessions = new Map<string, ShellSession>()
const generations = new Map<string, number>()
const outputs = new Map<string, OutputState>()
const expectedExits = new Set<string>()
const exitWaiters = new Map<string, Set<() => void>>()
const subscribers = new Map<string, Set<WebContents>>()
const subscribedIdsByWebContents = new Map<WebContents, Set<string>>()
const subscriberCleanup = new Map<WebContents, () => void>()
const MAX_OUTPUT = 256 * 1024

export interface CreateShellPtyArgs {
  id: string
  cwd: string
  cols: number
  rows: number
  onData: (data: string, meta?: PtyStreamMeta) => void
  onExit: (exitCode: number, isCurrent: boolean, generation?: number) => void
}

function nextGeneration(id: string): number {
  const generation = (generations.get(id) ?? 0) + 1
  generations.set(id, generation)
  outputs.set(id, { data: '', generation, sequence: 0, totalChars: 0 })
  return generation
}

function appendOutput(id: string, data: string, generation: number): PtyStreamMeta {
  const current = outputs.get(id)
  const output = current?.generation === generation ? current : { data: '', generation, sequence: 0, totalChars: 0 }
  output.sequence += 1
  output.totalChars += data.length
  output.data = `${output.data}${data}`.slice(-MAX_OUTPUT)
  outputs.set(id, output)
  return { generation, sequence: output.sequence }
}

function rememberOwnedPty(id: string): void {
  registerOwnedProcess({
    key: `pty:${id}`,
    kind: 'pty',
    owner: id,
    pid: () => sessions.get(id)?.proc.pid ?? null,
    state: () => (sessions.has(id) ? 'busy' : 'idle'),
    includeDescendants: true,
    extra: () => ({ ringBytes: outputs.get(id)?.data.length ?? 0 }),
  })
}

/** Create interactive shells only; agent runtimes do not use PTYs. */
export function createShellPty(args: CreateShellPtyArgs): void {
  if (sessions.has(args.id)) return
  const generation = nextGeneration(args.id)
  const shell = freeTerminalShell(getFreeTerminalShell())
  let proc: pty.IPty
  try {
    proc = pty.spawn(shell.file, shell.args, {
      name: 'xterm-256color',
      cols: args.cols > 0 ? args.cols : 80,
      rows: args.rows > 0 ? args.rows : 24,
      cwd: args.cwd || os.homedir(),
      env: {
        ...process.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    })
  } catch (error) {
    outputs.delete(args.id)
    args.onData(`\r\n\x1b[31m[terminal startup failed: ${(error as Error).message}]\x1b[0m\r\n`)
    args.onExit(1, true, generation)
    return
  }

  sessions.set(args.id, { proc, generation })
  rememberOwnedPty(args.id)
  proc.onData((data) => {
    const current = sessions.get(args.id)
    if (current?.proc !== proc || current.generation !== generation) return
    incrementPerformanceCounter('ptyChunks')
    args.onData(data, appendOutput(args.id, data, generation))
  })
  proc.onExit(({ exitCode, signal }) => {
    const current = sessions.get(args.id)
    const isCurrent = current?.proc === proc && current.generation === generation
    const intentional = expectedExits.delete(`${args.id}:${generation}`)
    if (isCurrent) {
      sessions.delete(args.id)
      unregisterOwnedProcess(`pty:${args.id}`)
    }
    const waiters = exitWaiters.get(args.id)
    if (waiters) {
      for (const resolve of waiters) resolve()
      exitWaiters.delete(args.id)
    }
    if (isCurrent && !intentional && (exitCode !== 0 || signal != null)) {
      console.error('[pty] Shell exited unexpectedly', { exitCode, signal })
    }
    args.onExit(exitCode, isCurrent, generation)
  })
}

export function subscribePtyData(contents: WebContents, id: string): void {
  if (!id || contents.isDestroyed()) return

  let ids = subscribedIdsByWebContents.get(contents)
  if (!ids) {
    ids = new Set<string>()
    subscribedIdsByWebContents.set(contents, ids)
    if (typeof contents.once === 'function') {
      const onDestroyed = () => unsubscribeAllPtyData(contents)
      contents.once('destroyed', onDestroyed)
      subscriberCleanup.set(contents, () => contents.removeListener?.('destroyed', onDestroyed))
    }
  }
  if (ids.has(id)) return

  ids.add(id)
  const set = subscribers.get(id) ?? new Set<WebContents>()
  set.add(contents)
  subscribers.set(id, set)
}

export function unsubscribePtyData(contents: WebContents, id: string): void {
  const ids = subscribedIdsByWebContents.get(contents)
  if (!ids?.delete(id)) return

  const set = subscribers.get(id)
  set?.delete(contents)
  if (set?.size === 0) subscribers.delete(id)

  if (ids.size === 0) {
    subscribedIdsByWebContents.delete(contents)
    subscriberCleanup.get(contents)?.()
    subscriberCleanup.delete(contents)
  }
}

function unsubscribeAllPtyData(contents: WebContents): void {
  const ids = subscribedIdsByWebContents.get(contents)
  if (!ids) return

  for (const id of ids) {
    const set = subscribers.get(id)
    set?.delete(contents)
    if (set?.size === 0) subscribers.delete(id)
  }
  subscribedIdsByWebContents.delete(contents)
  subscriberCleanup.get(contents)?.()
  subscriberCleanup.delete(contents)
}

function publish(id: string, channel: string, payload: unknown): void {
  for (const contents of [...(subscribers.get(id) ?? [])]) {
    if (contents.isDestroyed()) {
      unsubscribePtyData(contents, id)
      continue
    }
    try {
      contents.send(channel, payload)
      recordIpcSend()
    } catch {
      // A WebContents can be destroyed between the check and send.
      unsubscribePtyData(contents, id)
    }
  }
}

export function sendPtyData(id: string, data: string, meta?: PtyStreamMeta): void {
  publish(id, `pty:data:${id}`, { data, generation: meta?.generation ?? 0, sequence: meta?.sequence ?? 0 })
}
export function sendPtyExit(id: string, code: number, generation?: number): void {
  publish(id, `pty:exit:${id}`, { code, generation })
}

export function readPtyOutput(id: string, maxChars?: number): string {
  const data = outputs.get(id)?.data ?? ''
  return maxChars && maxChars > 0 ? data.slice(-maxChars) : data
}

export function readPtyOutputStats(id: string): PtyOutputStats {
  const output = outputs.get(id)
  return {
    generation: output?.generation ?? generations.get(id) ?? 0,
    sequence: output?.sequence ?? 0,
    bufferedLength: output?.data.length ?? 0,
    totalChars: output?.totalChars ?? 0,
  }
}

export function readPtyOutputSnapshot(id: string): PtyOutputSnapshot {
  return { data: outputs.get(id)?.data ?? '', ...readPtyOutputStats(id) }
}

export function clearPtyOutput(id: string): void {
  const output = outputs.get(id)
  if (output) output.data = ''
}

export function forgetPty(id: string): void {
  if (sessions.has(id)) return
  outputs.delete(id)
  generations.delete(id)
}

export function ptyExists(id: string): boolean {
  return sessions.has(id)
}

export function getPtyInfo(id: string): { pid: number; process: string } | null {
  const proc = sessions.get(id)?.proc
  return proc ? { pid: proc.pid, process: proc.process } : null
}

export function signalPty(id: string, signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
  const session = sessions.get(id)
  if (!session) return
  expectedExits.add(`${id}:${session.generation}`)
  try {
    session.proc.kill(signal)
  } catch {
    // Process already exited.
  }
}

export function writePty(id: string, data: string): void {
  try {
    sessions.get(id)?.proc.write(data)
  } catch {
    // Process already exited.
  }
}

export function resizePty(id: string, cols: number, rows: number): void {
  if (cols <= 0 || rows <= 0) return
  try {
    sessions.get(id)?.proc.resize(cols, rows)
  } catch {
    // Process already exited.
  }
}

export function killPty(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  expectedExits.add(`${id}:${session.generation}`)
  try {
    session.proc.kill()
  } catch {
    sessions.delete(id)
    unregisterOwnedProcess(`pty:${id}`)
  }
}

export async function killPtyAndWait(id: string, timeoutMs = 10_000): Promise<boolean> {
  if (!sessions.has(id)) return true
  return new Promise<boolean>((resolve) => {
    const waiters = exitWaiters.get(id) ?? new Set<() => void>()
    const done = () => {
      clearTimeout(timer)
      resolve(true)
    }
    waiters.add(done)
    exitWaiters.set(id, waiters)
    const timer = setTimeout(() => {
      waiters.delete(done)
      resolve(!sessions.has(id))
    }, timeoutMs)
    killPty(id)
  })
}

export function killAllPtys(): void {
  for (const id of [...sessions.keys()]) killPty(id)
}
