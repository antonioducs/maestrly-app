import { setTimeout as delay } from 'node:timers/promises'
import {
  identityOf,
  isSameLiveProcess,
  processTableFor,
  type ProcessIdentity,
  type ProcessInfo,
  type ProcessTable,
} from './process-table'

/** Default wait after SIGTERM before SIGKILL, and after SIGKILL before reporting survivors. */
export const TERMINATE_GRACE_MS = 3_000
export const TERMINATE_KILL_MS = 1_000

/**
 * Processes whose owner was proven when they were captured. A collective id (process group or session) every member
 * shared at that moment also reaches processes started later, but only while one captured member still runs in it:
 * an id stays reserved while anything uses it, so the group or session is then still the captured one.
 */
export interface OwnedProcessSet {
  members: ProcessIdentity[]
  collective?: { kind: 'pgid' | 'sid'; id: number }
}

export interface ProcessSurvivor extends ProcessIdentity {
  name: string
}

export interface TerminateOptions {
  graceMs?: number
  killMs?: number
  pollMs?: number
  table?: ProcessTable
  signal?: (pid: number, signal: NodeJS.Signals) => void
}

function collectiveOf(info: ProcessInfo, kind: 'pgid' | 'sid'): number | null {
  return kind === 'pgid' ? info.pgid : info.sid
}

/**
 * Sends SIGTERM to every owned process, waits, sends SIGKILL to those still there, and reports the ones that outlived
 * both. Before each signal the process is read again and must still be the captured one. When the table cannot be
 * read nothing is signalled: ownership can no longer be shown, and the members are reported as survivors.
 */
export async function terminateOwnedProcesses(
  sets: readonly OwnedProcessSet[],
  options: TerminateOptions = {}
): Promise<{ survivors: ProcessSurvivor[] }> {
  const table = options.table ?? processTableFor()
  const send = options.signal ?? ((pid: number, signal: NodeJS.Signals) => process.kill(pid, signal))
  const pollMs = options.pollMs ?? (process.platform === 'linux' ? 50 : 100)
  const targets = new Map<string, ProcessIdentity & { name: string }>()
  const groups = sets.map((set) => ({ set, members: [...set.members] }))
  const remember = (identity: ProcessIdentity, name = ''): void => {
    const key = `${identity.pid}:${identity.startTime}`
    if (!targets.has(key)) targets.set(key, { ...identity, name })
  }
  for (const set of sets) for (const member of set.members) remember(member)
  // A collective is only ever proven through a captured member.
  if (targets.size === 0) return { survivors: [] }

  const signalRound = async (signal: NodeJS.Signals): Promise<boolean> => {
    const rows = await table.list()
    if (!rows) return false
    const byPid = new Map(rows.map((row) => [row.pid, row]))
    for (const group of groups) {
      const collective = group.set.collective
      if (!collective) continue
      const inside = (row: ProcessInfo | undefined): row is ProcessInfo =>
        !!row && collectiveOf(row, collective.kind) === collective.id
      if (
        !group.members.some(
          (member) => isSameLiveProcess(byPid.get(member.pid), member) && inside(byPid.get(member.pid))
        )
      )
        continue
      for (const row of rows) {
        // The id's own number is a process named after it: our leader was reaped, so a process with that pid is not ours.
        if (row.zombie || row.pid === collective.id || row.pid === process.pid || !inside(row)) continue
        const identity = identityOf(row)
        group.members.push(identity)
        remember(identity, row.name)
      }
    }
    for (const target of targets.values()) {
      const row = byPid.get(target.pid)
      if (!isSameLiveProcess(row, target)) continue
      target.name ||= row.name
      try {
        send(target.pid, signal)
      } catch {
        // Gone between the read and the signal.
      }
    }
    return true
  }

  const alive = async (): Promise<ProcessSurvivor[] | null> => {
    const rows = await table.get([...targets.values()].map((target) => target.pid))
    if (!rows) return null
    return [...targets.values()].filter((target) => isSameLiveProcess(rows.get(target.pid), target))
  }

  const waitGone = async (timeoutMs: number): Promise<ProcessSurvivor[] | null> => {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const left = await alive()
      if (!left || left.length === 0 || Date.now() >= deadline) return left
      await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    }
  }

  if (!(await signalRound('SIGTERM'))) return { survivors: [...targets.values()] }
  const afterTerm = await waitGone(options.graceMs ?? TERMINATE_GRACE_MS)
  if (afterTerm && afterTerm.length === 0) return { survivors: [] }
  if (!(await signalRound('SIGKILL'))) return { survivors: [...targets.values()] }
  const afterKill = await waitGone(options.killMs ?? TERMINATE_KILL_MS)
  return { survivors: afterKill ?? [...targets.values()] }
}
