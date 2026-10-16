import type { ChildProcess } from 'node:child_process'
import { identityOf, processTableFor, type ProcessInfo, type ProcessTable } from './process-table'
import { terminateOwnedProcesses, type OwnedProcessSet, type ProcessSurvivor, type TerminateOptions } from './terminate'

/**
 * Process groups and sessions a conversation started, kept until the conversation is archived or deleted or the app
 * quits. Only what Maestrly can show is its own is kept:
 * - a command of the `bash` tool runs detached, so its shell leads a session and group named after its pid; while that
 *   shell is our unreaped child the id cannot belong to anyone else;
 * - when it (or a terminal's shell) exits, the processes still in its session or group are captured with their start
 *   time; they keep the id reserved, and are the proof that it is still ours.
 * Nothing is matched by name, working directory or command line.
 */
interface OwnedGroup {
  owner: string
  kind: 'pgid' | 'sid'
  id: number
  /** The live leader, until its exit. */
  leader: ChildProcess | null
  /** Members captured when the leader exited; null while it runs. */
  set: OwnedProcessSet | null
  capture: Promise<void> | null
}

const groups = new Set<OwnedGroup>()
let table: ProcessTable = processTableFor()

function leaderRunning(group: OwnedGroup): boolean {
  return !!group.leader && group.leader.exitCode === null && group.leader.signalCode === null
}

function membersOf(rows: readonly ProcessInfo[], group: Pick<OwnedGroup, 'kind' | 'id'>): ProcessInfo[] {
  return rows.filter(
    (row) =>
      !row.zombie &&
      row.pid !== group.id &&
      row.pid !== process.pid &&
      (group.kind === 'pgid' ? row.pgid : row.sid) === group.id
  )
}

/** Captures what is left of a group whose leader is gone; forgets the group when nothing is. */
function captureRemnants(group: OwnedGroup): void {
  group.capture = (async () => {
    const rows = await table.list()
    const members = rows ? membersOf(rows, group) : []
    if (members.length === 0) groups.delete(group)
    else group.set = { members: members.map(identityOf), collective: { kind: group.kind, id: group.id } }
  })()
    .catch(() => {
      groups.delete(group)
    })
    .finally(() => {
      group.capture = null
    })
}

/**
 * Keeps the process group of a command spawned with `detached: true` (POSIX). Linux follows its session, which also
 * holds the members that moved to a group of their own; macOS reports no session, so its group is followed.
 */
export function trackCommandGroup(
  owner: string,
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform
): void {
  if (platform === 'win32' || !child.pid) return
  const group: OwnedGroup = {
    owner,
    kind: platform === 'linux' ? 'sid' : 'pgid',
    id: child.pid,
    leader: child,
    set: null,
    capture: null,
  }
  groups.add(group)
  child.once('exit', () => {
    group.leader = null
    if (groups.has(group)) captureRemnants(group)
  })
}

/** Keeps what a terminal's shell left in its session when it exited (Linux; elsewhere no session is reported). */
export function adoptSessionRemnants(owner: string, sid: number, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux' || !Number.isInteger(sid) || sid <= 0) return
  const group: OwnedGroup = { owner, kind: 'sid', id: sid, leader: null, set: null, capture: null }
  groups.add(group)
  captureRemnants(group)
}

/** Ends the groups of one owner, or of every owner with `null`, and forgets them. */
export async function stopOwnedGroups(
  owner: string | null,
  options: TerminateOptions = {}
): Promise<{ survivors: ProcessSurvivor[] }> {
  const mine = [...groups].filter((group) => owner === null || group.owner === owner)
  if (mine.length === 0) return { survivors: [] }
  for (const group of mine) groups.delete(group)
  await Promise.all(mine.map((group) => group.capture))

  const processes = options.table ?? table
  const sets: OwnedProcessSet[] = []
  const running = mine.filter(leaderRunning)
  const rows = running.length > 0 ? await processes.list() : null
  for (const group of mine) {
    if (running.includes(group) && leaderRunning(group)) {
      const leader = rows?.find((row) => row.pid === group.id)
      if (!rows || !leader || leader.zombie) continue
      sets.push({
        members: [identityOf(leader), ...membersOf(rows, group).map(identityOf)],
        collective: { kind: group.kind, id: group.id },
      })
      continue
    }
    // The leader exited while the table was read: its own capture holds what is left.
    if (running.includes(group)) {
      group.leader = null
      captureRemnants(group)
      await group.capture
    }
    if (group.set) sets.push(group.set)
  }
  return terminateOwnedProcesses(sets, { ...options, table: processes })
}

export function hasOwnedGroups(owner: string): boolean {
  return [...groups].some((group) => group.owner === owner)
}

/** Test seam. */
export function __setOwnedGroupsTableForTests(next: ProcessTable | null): void {
  table = next ?? processTableFor()
}

export function __resetOwnedGroupsForTests(): void {
  groups.clear()
  table = processTableFor()
}
