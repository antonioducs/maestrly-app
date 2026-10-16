import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import {
  parseProcStat,
  parsePsProcessLines,
  type ProcessInfo,
  type ProcessTable,
} from '../../src/main/process-ownership/process-table'
import { terminateOwnedProcesses } from '../../src/main/process-ownership/terminate'
import {
  __resetOwnedGroupsForTests,
  __setOwnedGroupsTableForTests,
  adoptSessionRemnants,
  hasOwnedGroups,
  stopOwnedGroups,
  trackCommandGroup,
} from '../../src/main/process-ownership/owned-groups'

/** A /proc/<pid>/stat line: the 20 fields between the session and the start time are not read. */
function statLine(pid: number, name: string, state: string, ppid: number, pgid: number, sid: number, start: number) {
  return `${pid} (${name}) ${state} ${ppid} ${pgid} ${sid} ${Array(15).fill('0').join(' ')} ${start} 1234 56 18446744073709551615`
}

describe('parseProcStat', () => {
  it('reads the fields after the last parenthesis of the name', () => {
    expect(parseProcStat(statLine(4401, 'sleep', 'S', 4400, 4401, 4400, 987654))).toEqual({
      pid: 4401,
      ppid: 4400,
      pgid: 4401,
      sid: 4400,
      startTime: '987654',
      name: 'sleep',
      zombie: false,
    })
    // A name may hold spaces and parentheses; only the last closing one ends it.
    expect(parseProcStat(statLine(12, 'a) Z 1 (b', 'S', 1, 12, 12, 5))).toMatchObject({
      pid: 12,
      name: 'a) Z 1 (b',
      ppid: 1,
      zombie: false,
    })
  })

  it('counts zombie and dead processes as not running and skips malformed text', () => {
    expect(parseProcStat(statLine(7, 'x', 'Z', 1, 7, 7, 3))?.zombie).toBe(true)
    expect(parseProcStat(statLine(7, 'x', 'X', 1, 7, 7, 3))?.zombie).toBe(true)
    expect(parseProcStat('')).toBeNull()
    expect(parseProcStat('12 sleep S 1 2 3')).toBeNull()
    expect(parseProcStat('12 (sleep) S 1 2')).toBeNull()
  })
})

describe('parsePsProcessLines', () => {
  it('reads ps rows run with LC_ALL=C and skips malformed ones', () => {
    const rows = parsePsProcessLines(
      [
        '  501     1   501 Ss   Thu Oct 16 00:15:41 2026     /bin/zsh',
        '  777   501   777 Z+   Thu Oct  6 09:05:01 2026     (sleep)',
        '  junk',
        '',
      ].join('\n')
    )
    expect(rows).toEqual([
      {
        pid: 501,
        ppid: 1,
        pgid: 501,
        sid: null,
        startTime: 'Thu Oct 16 00:15:41 2026',
        name: '/bin/zsh',
        zombie: false,
      },
      {
        pid: 777,
        ppid: 501,
        pgid: 777,
        sid: null,
        startTime: 'Thu Oct 6 09:05:01 2026',
        name: '(sleep)',
        zombie: true,
      },
    ])
  })
})

interface FakeProcess extends ProcessInfo {
  /** Signals the process ignores. */
  ignores?: NodeJS.Signals[]
}

/** An in-memory process table; a signal the process does not ignore ends it. */
function fakeSystem(initial: FakeProcess[]) {
  const processes = new Map(initial.map((row) => [row.pid, { ...row }]))
  const signals: Array<[number, NodeJS.Signals]> = []
  let readable = true
  const table: ProcessTable = {
    sessions: true,
    list: async () => (readable ? [...processes.values()].map((row) => ({ ...row })) : null),
    get: async (pids) =>
      readable ? new Map(pids.flatMap((pid) => (processes.has(pid) ? [[pid, { ...processes.get(pid)! }]] : []))) : null,
  }
  const signal = (pid: number, sig: NodeJS.Signals) => {
    signals.push([pid, sig])
    const row = processes.get(pid)
    if (!row) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    if (!row.ignores?.includes(sig)) processes.delete(pid)
  }
  return {
    table,
    signal,
    signals,
    processes,
    add: (row: FakeProcess) => processes.set(row.pid, { ...row }),
    setReadable: (value: boolean) => (readable = value),
  }
}

const proc = (pid: number, extra: Partial<FakeProcess> = {}): FakeProcess => ({
  pid,
  ppid: 1,
  pgid: pid,
  sid: pid,
  startTime: `t${pid}`,
  name: `p${pid}`,
  zombie: false,
  ...extra,
})

const fast = { graceMs: 40, killMs: 40, pollMs: 5 }

/** Every call gets the fake signal: the real one would reach whatever process holds these pids on the host. */
const on = (system: ReturnType<typeof fakeSystem>) => ({ ...fast, table: system.table, signal: system.signal })

describe('terminateOwnedProcesses', () => {
  it('sends SIGTERM, then SIGKILL to what is left, and reports what outlived both', async () => {
    const system = fakeSystem([
      proc(10),
      proc(11, { ignores: ['SIGTERM'] }),
      proc(12, { ignores: ['SIGTERM', 'SIGKILL'], name: 'stuck' }),
    ])
    const result = await terminateOwnedProcesses(
      [{ members: [10, 11, 12].map((pid) => ({ pid, startTime: `t${pid}` })) }],
      on(system)
    )
    expect(result.survivors).toEqual([{ pid: 12, startTime: 't12', name: 'stuck' }])
    expect(system.signals).toEqual([
      [10, 'SIGTERM'],
      [11, 'SIGTERM'],
      [12, 'SIGTERM'],
      [11, 'SIGKILL'],
      [12, 'SIGKILL'],
    ])
  })

  it('never signals a pid that now names another process', async () => {
    const system = fakeSystem([proc(20, { startTime: 'reused' })])
    const result = await terminateOwnedProcesses([{ members: [{ pid: 20, startTime: 'captured' }] }], {
      ...fast,
      table: system.table,
      signal: system.signal,
    })
    expect(system.signals).toEqual([])
    expect(result.survivors).toEqual([])
    expect(system.processes.has(20)).toBe(true)
  })

  it('reaches later members of a session only while a captured one still runs in it', async () => {
    const system = fakeSystem([
      proc(31, { sid: 500 }),
      proc(32, { sid: 500 }), // forked after the capture
      proc(500, { sid: 500 }), // a process holding the session's number is not the reaped leader
      proc(33, { sid: 600 }),
    ])
    await terminateOwnedProcesses(
      [{ members: [{ pid: 31, startTime: 't31' }], collective: { kind: 'sid', id: 500 } }],
      on(system)
    )
    expect(system.signals.map(([pid]) => pid).sort()).toEqual([31, 32])
    expect([...system.processes.keys()].sort()).toEqual([33, 500])

    // Without a captured member in it, the same session number proves nothing.
    const unproven = fakeSystem([proc(41, { sid: 500 })])
    await terminateOwnedProcesses(
      [{ members: [{ pid: 31, startTime: 't31' }], collective: { kind: 'sid', id: 500 } }],
      on(unproven)
    )
    expect(unproven.signals).toEqual([])
  })

  it('signals nothing when the table cannot be read, and reports the members', async () => {
    const system = fakeSystem([proc(50)])
    system.setReadable(false)
    const result = await terminateOwnedProcesses([{ members: [{ pid: 50, startTime: 't50' }] }], {
      ...fast,
      table: system.table,
      signal: system.signal,
    })
    expect(system.signals).toEqual([])
    expect(result.survivors).toEqual([{ pid: 50, startTime: 't50', name: '' }])
  })

  it('does not read the table for an empty set', async () => {
    const system = fakeSystem([])
    let reads = 0
    const table = {
      ...system.table,
      list: async () => {
        reads++
        return []
      },
    }
    await expect(terminateOwnedProcesses([{ members: [] }], { ...on(system), table })).resolves.toEqual({
      survivors: [],
    })
    expect(reads).toBe(0)
  })
})

class FakeChild extends EventEmitter {
  exitCode: number | null = null
  signalCode: NodeJS.Signals | null = null
  constructor(readonly pid: number) {
    super()
  }
  exit(code = 0): void {
    this.exitCode = code
    this.emit('exit', code, null)
  }
}

describe('owned process groups', () => {
  afterEach(() => __resetOwnedGroupsForTests())

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

  it('forgets a command that left nothing behind', async () => {
    const system = fakeSystem([proc(700, { sid: 700 })])
    __setOwnedGroupsTableForTests(system.table)
    const child = new FakeChild(700)
    trackCommandGroup('conv', child as unknown as ChildProcess, 'linux')
    expect(hasOwnedGroups('conv')).toBe(true)
    system.processes.delete(700)
    child.exit()
    await settle()
    await settle()
    expect(hasOwnedGroups('conv')).toBe(false)
  })

  it('keeps what a command sent to the background and ends it with its conversation only', async () => {
    const system = fakeSystem([proc(700, { sid: 700 }), proc(701, { ppid: 1, pgid: 700, sid: 700, name: 'server' })])
    __setOwnedGroupsTableForTests(system.table)
    const mine = new FakeChild(700)
    trackCommandGroup('conv', mine as unknown as ChildProcess, 'linux')
    // Another conversation's command, and a process no conversation started.
    system.add(proc(800, { sid: 800 }))
    system.add(proc(801, { pgid: 800, sid: 800 }))
    system.add(proc(900, { sid: 900 }))
    const other = new FakeChild(800)
    trackCommandGroup('other', other as unknown as ChildProcess, 'linux')

    system.processes.delete(700)
    mine.exit()
    await settle()

    const result = await stopOwnedGroups('conv', on(system))
    expect(result.survivors).toEqual([])
    expect(system.signals).toEqual([[701, 'SIGTERM']])
    expect(hasOwnedGroups('conv')).toBe(false)
    expect(hasOwnedGroups('other')).toBe(true)
    expect([...system.processes.keys()].sort()).toEqual([800, 801, 900])
  })

  it('ends a running command with its whole group, the leader included', async () => {
    const system = fakeSystem([proc(710, { sid: 710 }), proc(711, { pgid: 710, sid: 710 })])
    __setOwnedGroupsTableForTests(system.table)
    trackCommandGroup('conv', new FakeChild(710) as unknown as ChildProcess, 'linux')

    await stopOwnedGroups('conv', on(system))

    expect(system.signals.map(([pid]) => pid).sort()).toEqual([710, 711])
  })

  it('leaves a group alone once everything it captured is gone', async () => {
    const system = fakeSystem([proc(720, { sid: 720 }), proc(721, { pgid: 720, sid: 720 })])
    __setOwnedGroupsTableForTests(system.table)
    const child = new FakeChild(720)
    trackCommandGroup('conv', child as unknown as ChildProcess, 'linux')
    system.processes.delete(720)
    child.exit()
    await settle()
    // The captured member ended on its own; whatever holds the number now belongs to someone else.
    system.processes.delete(721)
    system.add(proc(722, { pgid: 720, sid: 720 }))

    await stopOwnedGroups('conv', on(system))

    expect(system.signals).toEqual([])
    expect(system.processes.has(722)).toBe(true)
  })

  it('follows the process group on macOS and tracks nothing on Windows', async () => {
    const system = fakeSystem([proc(730, { pgid: 730, sid: null }), proc(731, { pgid: 730, sid: null })])
    __setOwnedGroupsTableForTests(system.table)
    trackCommandGroup('mac', new FakeChild(730) as unknown as ChildProcess, 'darwin')
    trackCommandGroup('win', new FakeChild(740) as unknown as ChildProcess, 'win32')
    adoptSessionRemnants('mac', 730, 'darwin')
    expect(hasOwnedGroups('win')).toBe(false)

    await stopOwnedGroups('mac', on(system))
    expect(system.signals.map(([pid]) => pid).sort()).toEqual([730, 731])
  })

  it("adopts what a terminal's shell left in its session (Linux)", async () => {
    const system = fakeSystem([proc(751, { ppid: 1, pgid: 751, sid: 750, name: 'nohup-job' }), proc(752, { sid: 752 })])
    __setOwnedGroupsTableForTests(system.table)
    adoptSessionRemnants('conv', 750, 'linux')
    await settle()

    const result = await stopOwnedGroups(null, on(system))

    expect(result.survivors).toEqual([])
    expect(system.signals).toEqual([[751, 'SIGTERM']])
    expect(system.processes.has(752)).toBe(true)
  })
})
