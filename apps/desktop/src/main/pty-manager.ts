import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import * as pty from 'node-pty'
import type { WebContents } from 'electron'
import { descendantsOf, freeTerminalShell } from './platform'
import { getFreeTerminalShell } from './store'
import { incrementPerformanceCounter, recordIpcSend } from './performance/metrics'
import { registerOwnedProcess, unregisterOwnedProcess } from './performance/owned-processes'
import { adoptSessionRemnants } from './process-ownership/owned-groups'
import { identityOf, processTableFor, readProcessSync, type ProcessInfo } from './process-ownership/process-table'
import {
  TERMINATE_GRACE_MS,
  TERMINATE_KILL_MS,
  terminateOwnedProcesses,
  type ProcessSurvivor,
  type TerminateOptions,
} from './process-ownership/terminate'
import type { PtyOutputSnapshot, PtyOutputStats, PtyStreamMeta } from '../shared/pty'

interface ShellSession {
  proc: pty.IPty
  generation: number
  /**
   * Start time of the shell, read right after spawn and only when it is our direct child (Linux). With it a later read
   * tells the shell from a process reusing its pid, and its session can be followed after it exits.
   */
  startTime: string | null
}

/** The shell's identity when it is provably our child: node-pty forks it straight from this process. */
function ownShellStartTime(pid: number): string | null {
  const row = readProcessSync(pid)
  return row && !row.zombie && row.ppid === process.pid ? row.startTime : null
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
const outputListeners = new Map<string, Set<PtyOutputListener>>()
const exitListeners = new Map<string, Set<PtyExitListener>>()
/** Shells whose whole tree is being ended; what they leave is not adopted, it is already being stopped. */
const treeKills = new WeakSet<pty.IPty>()
const MAX_OUTPUT = 256 * 1024

/** Receives the output of a PTY in the main process, with the position the snapshot reports for it. */
export type PtyOutputListener = (data: string, meta: PtyStreamMeta) => void
/** Receives the exit code of a PTY's current process. */
export type PtyExitListener = (code: number) => void

export interface CreateShellPtyArgs {
  id: string
  cwd: string
  cols: number
  rows: number
  /** Extra variables over the process environment, e.g. the display of the conversation's bot. */
  env?: Readonly<Record<string, string>>
  /** Conversation that owns what the shell leaves running when it exits (`nohup`, `disown`), until it is stopped. */
  owner?: string
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

function addListener<T>(registry: Map<string, Set<T>>, id: string, listener: T): () => void {
  const listeners = registry.get(id) ?? new Set<T>()
  listeners.add(listener)
  registry.set(id, listeners)
  return () => {
    const current = registry.get(id)
    if (!current?.delete(listener)) return
    if (current.size === 0) registry.delete(id)
  }
}

/** Runs the listeners of `id` over a copy, so one may cancel itself and none may break the PTY or the others. */
function notify<T>(registry: Map<string, Set<T>>, id: string, call: (listener: T) => void): void {
  for (const listener of [...(registry.get(id) ?? [])]) {
    try {
      call(listener)
    } catch (error) {
      console.error('[pty] Listener failed', error)
    }
  }
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
        ...args.env,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        LANG: process.env.LANG || 'en_US.UTF-8',
      },
    })
  } catch (error) {
    outputs.delete(args.id)
    args.onData(`\r\n\x1b[31m[terminal startup failed: ${(error as Error).message}]\x1b[0m\r\n`)
    args.onExit(1, true, generation)
    notify(exitListeners, args.id, (listener) => listener(1))
    return
  }

  const startTime = ownShellStartTime(proc.pid)
  sessions.set(args.id, { proc, generation, startTime })
  rememberOwnedPty(args.id)
  proc.onData((data) => {
    const current = sessions.get(args.id)
    if (current?.proc !== proc || current.generation !== generation) return
    incrementPerformanceCounter('ptyChunks')
    const meta = appendOutput(args.id, data, generation)
    args.onData(data, meta)
    notify(outputListeners, args.id, (listener) => listener(data, meta))
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
    // Closing one terminal keeps what was started with nohup or disown; the conversation stops it later.
    if (args.owner && startTime !== null && !treeKills.has(proc)) adoptSessionRemnants(args.owner, proc.pid)
    args.onExit(exitCode, isCurrent, generation)
    if (isCurrent) notify(exitListeners, args.id, (listener) => listener(exitCode))
  })
}

/**
 * Listens to the output of a PTY in the main process. A listener hears each chunk after the ring buffer took it, so
 * a snapshot read at subscription time and the chunks whose sequence is greater join without a gap. Returns the
 * function that cancels the subscription.
 */
export function onPtyOutput(id: string, listener: PtyOutputListener): () => void {
  return addListener(outputListeners, id, listener)
}

/** Listens to the end of the current process of a PTY; stays subscribed across a restart under the same id. */
export function onPtyExit(id: string, listener: PtyExitListener): () => void {
  return addListener(exitListeners, id, listener)
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

/** Resolves once the given shell process of `id` is gone, or with false after `timeoutMs`. */
async function waitShellExit(id: string, proc: pty.IPty, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (sessions.get(id)?.proc === proc) {
    if (Date.now() >= deadline) return false
    await delay(25)
  }
  return true
}

/**
 * What the shell started, read while it still runs: its descendants and, on Linux, every process of its session.
 * Once the shell is gone, `nohup`, `disown` and `(cmd &)` processes are reparented and only the session still ties them
 * to it. A pid alone proves nothing, so the shell must be our child with the start time read at spawn.
 */
function shellTree(
  session: ShellSession,
  rows: readonly ProcessInfo[],
  sessionsReported: boolean
): { members: ProcessInfo[]; followSession: boolean } {
  const shellPid = session.proc.pid
  const row = rows.find((candidate) => candidate.pid === shellPid)
  const sameShell = !!row && session.startTime !== null && row.startTime === session.startTime
  const liveShell = !!row && !row.zombie && row.ppid === process.pid && (session.startTime === null || sameShell)
  // A gone shell's session id stays reserved while one of its processes lives, so it cannot name another session; a
  // different process holding the pid means the session emptied first.
  const followSession = sessionsReported && session.startTime !== null && (!row || sameShell)
  const members = new Map<number, ProcessInfo>()
  const byPid = new Map(rows.map((candidate) => [candidate.pid, candidate]))
  if (liveShell) {
    const parents = new Map(rows.map((candidate) => [candidate.pid, candidate.ppid]))
    for (const pid of descendantsOf(parents, [shellPid]).get(shellPid) ?? []) {
      const descendant = byPid.get(pid)
      if (descendant) members.set(pid, descendant)
    }
  }
  if (followSession) {
    for (const candidate of rows) if (candidate.sid === shellPid) members.set(candidate.pid, candidate)
  }
  members.delete(shellPid)
  members.delete(process.pid)
  return { members: [...members.values()].filter((member) => !member.zombie), followSession }
}

/**
 * Ends a shell together with what it started, including what `nohup`, `disown` or `trap '' HUP` keep from its hangup:
 * the tree is read before the shell gets SIGHUP, the rest gets SIGTERM, and SIGKILL follows for what is still there.
 * Only `setsid` and daemons that double-fork out of the session escape. Windows ends the console as before.
 */
export async function killPtyTree(
  id: string,
  options: TerminateOptions = {}
): Promise<{ exited: boolean; survivors: ProcessSurvivor[] }> {
  const session = sessions.get(id)
  if (!session) return { exited: true, survivors: [] }
  const { proc } = session
  treeKills.add(proc)
  expectedExits.add(`${id}:${session.generation}`)
  const table = options.table ?? processTableFor()
  const rows = process.platform === 'win32' ? null : await table.list()
  const tree = rows ? shellTree(session, rows, table.sessions) : { members: [], followSession: false }
  const graceMs = options.graceMs ?? TERMINATE_GRACE_MS
  const killMs = options.killMs ?? TERMINATE_KILL_MS

  const stopShell = async (): Promise<boolean> => {
    try {
      proc.kill()
    } catch {
      // Already exited.
    }
    if (await waitShellExit(id, proc, graceMs)) return true
    // Where its start time is known, the pid must still be this shell.
    const sameShell = session.startTime === null || readProcessSync(proc.pid)?.startTime === session.startTime
    if (process.platform !== 'win32' && sameShell) {
      try {
        proc.kill('SIGKILL')
      } catch {
        // Already exited.
      }
    }
    return waitShellExit(id, proc, killMs)
  }

  const [exited, result] = await Promise.all([
    stopShell(),
    terminateOwnedProcesses(
      [
        {
          members: tree.members.map(identityOf),
          ...(tree.followSession ? { collective: { kind: 'sid' as const, id: proc.pid } } : {}),
        },
      ],
      { ...options, table, graceMs, killMs }
    ),
  ])
  return { exited, survivors: result.survivors }
}

/** killPtyTree for every shell, used when the app quits. */
export async function killAllPtyTrees(
  options: TerminateOptions = {}
): Promise<{ exited: boolean; survivors: ProcessSurvivor[] }> {
  const results = await Promise.all([...sessions.keys()].map((id) => killPtyTree(id, options)))
  return {
    exited: results.every((result) => result.exited),
    survivors: results.flatMap((result) => result.survivors),
  }
}
