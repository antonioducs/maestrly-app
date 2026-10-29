import { spawn } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  JobProcesses,
  type ProcessInfo,
  parseProcStat,
  parsePsLine,
  parsePsTime,
} from '../../src/main/runner/process-tree'
const JOB = 'job_ProcessTreeTest01'
const MiB = 1024 * 1024

function row(pid: number, ppid: number, pgid: number, extra: Partial<ProcessInfo> = {}): ProcessInfo {
  return { pid, ppid, pgid, start: `s${pid}`, rssBytes: MiB, cpuSeconds: 0, zombie: false, ...extra }
}

/** A tracker over a process table the test edits, with a clock it moves and the signals it was asked to send. */
function setup(initial: ProcessInfo[], options: Partial<ConstructorParameters<typeof JobProcesses>[0]> = {}) {
  const state = {
    table: initial,
    environ: new Map<number, string | null>(),
    environReads: [] as number[],
    now: 1_000_000,
    kills: [] as Array<[number, string]>,
    killError: null as null | NodeJS.ErrnoException,
    onKill: null as null | (() => void),
  }
  const tree = new JobProcesses({
    rootPid: 100,
    jobId: JOB,
    platform: 'linux',
    readTable: async () => state.table.map((item) => ({ ...item })),
    readEnviron: async (pid) => {
      state.environReads.push(pid)
      return state.environ.get(pid) ?? ''
    },
    kill: (pid, signal) => {
      state.kills.push([pid, signal])
      state.onKill?.()
      if (state.killError) throw state.killError
    },
    now: () => state.now,
    ...options,
  })
  return { tree, state }
}
const marker = `MAESTRLY_JOB_ID=${JOB}`

describe('job processes: membership', () => {
  it('holds the root, the processes it started, and theirs', async () => {
    const { tree } = setup([
      row(1, 0, 1),
      row(100, 1, 100, { rssBytes: 4 * MiB }),
      row(101, 100, 100, { rssBytes: 2 * MiB }),
      row(102, 101, 102, { rssBytes: 3 * MiB }),
      row(200, 1, 200, { rssBytes: 50 * MiB }),
    ])
    const usage = await tree.sample()
    expect(usage.processes).toBe(3)
    expect(usage.memoryBytes).toBe(9 * MiB)
  })

  it('knows a grandchild that its parent left behind, which init adopted', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(101, 100, 100), row(102, 101, 102)])
    expect((await tree.sample()).processes).toBe(3)
    // 101 ends; 102 has its own session and init as its parent now.
    state.table = [row(1, 0, 1), row(100, 1, 100), row(102, 1, 102)]
    expect((await tree.sample()).processes).toBe(2)
    state.table = [row(1, 0, 1), row(102, 1, 102)]
    expect((await tree.sample()).processes).toBe(1)
  })

  it('holds the processes in the root’s group, whoever their parent is', async () => {
    const { tree } = setup([row(1, 0, 1), row(100, 1, 100), row(105, 1, 100), row(300, 1, 300)])
    expect((await tree.sample()).processes).toBe(2)
  })

  it('takes what the root left running in its group when it ended', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100)])
    await tree.sample()
    // The root ended; its background job, handed to init, is still in the group.
    state.table = [row(1, 0, 1), row(105, 1, 100)]
    expect((await tree.sample()).processes).toBe(1)
  })

  it('finds a daemon by the job variable in its environment, on Linux', async () => {
    const { tree, state } = setup([
      row(1, 0, 1),
      row(100, 1, 100),
      row(300, 1, 300),
      row(301, 1, 301),
      row(302, 1, 302),
    ])
    state.environ.set(300, `HOME=/home/a\0${marker}\0LANG=C\0`)
    // Another job's marker, the same variable as part of a longer value or name, and no marker at all.
    state.environ.set(301, `${marker}9\0`)
    state.environ.set(302, `NOT_${marker}\0`)
    expect((await tree.sample()).processes).toBe(2)
    // The daemon's own children belong too.
    state.table.push(row(303, 300, 300))
    expect((await tree.sample()).processes).toBe(3)
  })

  it('finds a marked process whose environment ends without a separator', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(300, 1, 300)])
    state.environ.set(300, `A=1\0${marker}`)
    expect((await tree.sample()).processes).toBe(2)
  })

  it('reads the environment of a process once, and not those of the members', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(101, 100, 100), row(300, 1, 300)])
    await tree.sample()
    await tree.sample()
    await tree.sample()
    expect(state.environReads.filter((pid) => pid === 300)).toHaveLength(1)
    expect(state.environReads).not.toContain(100)
    expect(state.environReads).not.toContain(101)
    // A process that appears later is read once more.
    state.table.push(row(301, 1, 301))
    await tree.sample()
    expect(state.environReads.filter((pid) => pid === 301)).toHaveLength(1)
  })

  it('has no environment to look at off Linux: a daemon handed to init is not found there', async () => {
    const tree = new JobProcesses({
      rootPid: 100,
      jobId: JOB,
      platform: 'darwin',
      readTable: async () => [row(1, 0, 1), row(100, 1, 100), row(300, 1, 300)],
    })
    expect((await tree.sample()).processes).toBe(1)
  })

  it('ignores zombies: they hold no memory and are not counted', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(101, 100, 100, { zombie: true, rssBytes: 0 })])
    expect((await tree.sample()).processes).toBe(1)
    await tree.signal('SIGTERM')
    expect(state.kills).toEqual([[-100, 'SIGTERM']])
  })

  it('takes the root only while its parent is the one that started it', async () => {
    const { tree } = setup([row(1, 0, 1), row(100, 777, 100)], { parentPid: 42 })
    expect((await tree.sample()).processes).toBe(0)
    const own = setup([row(1, 0, 1), row(100, 42, 100)], { parentPid: 42 })
    expect((await own.tree.sample()).processes).toBe(1)
  })

  it('never takes the process that tracks for a member', async () => {
    const { tree } = setup([row(100, 1, 100), row(process.pid, 100, 100)])
    expect((await tree.sample()).processes).toBe(1)
  })
})

describe('job processes: identity', () => {
  it('does not signal a pid that someone else reused, nor take it for a member', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(150, 100, 150)])
    expect((await tree.sample()).processes).toBe(2)
    // 150 ended and the same number went to an unrelated process with another start time.
    state.table = [row(1, 0, 1), row(100, 1, 100), row(150, 1, 150, { start: 'reused' })]
    expect((await tree.sample()).processes).toBe(1)
    await tree.signal('SIGTERM')
    expect(state.kills).toEqual([[-100, 'SIGTERM']])
  })

  it('does not signal the root’s group once nothing of the job holds it, nor adopt what took its number', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100)])
    await tree.sample()
    // The job is gone; an unrelated process now has pid 100 and leads a group of its own.
    state.table = [row(1, 0, 1), row(100, 1, 100, { start: 'reused' }), row(101, 100, 100, { start: 'reused' })]
    expect((await tree.sample()).processes).toBe(0)
    expect(await tree.signal('SIGKILL')).toBe(0)
    expect(state.kills).toEqual([])
  })

  it('signals the group while a process of it is alive, and the members outside the group one by one', async () => {
    const { tree, state } = setup([
      row(1, 0, 1),
      row(100, 1, 100),
      row(101, 100, 100),
      row(200, 100, 200),
      row(201, 200, 200),
    ])
    expect(await tree.signal('SIGTERM')).toBe(4)
    expect(state.kills).toEqual([
      [-100, 'SIGTERM'],
      [200, 'SIGTERM'],
      [201, 'SIGTERM'],
    ])
  })

  it('tolerates a process that is gone or that it may not signal', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(200, 100, 200)])
    for (const code of ['ESRCH', 'EPERM']) {
      state.killError = Object.assign(new Error(code), { code })
      await expect(tree.signal('SIGKILL')).resolves.toBe(2)
    }
    expect(state.kills).toHaveLength(4)
  })

  it('signals the group alone while members are alive when the process table cannot be read', async () => {
    const kills: Array<[number, string]> = []
    let broken = false
    const tree = new JobProcesses({
      rootPid: 100,
      jobId: JOB,
      platform: 'linux',
      readTable: async () => {
        if (broken) throw new Error('no /proc')
        return [row(100, 1, 100)]
      },
      readEnviron: async () => '',
      kill: (pid, signal) => void kills.push([pid, signal]),
    })
    await tree.sample()
    broken = true
    await tree.signal('SIGTERM')
    expect(kills).toEqual([[-100, 'SIGTERM']])
    await expect(tree.sample()).rejects.toThrow('no /proc')
  })

  it('kills until none is left, and says so', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100), row(200, 100, 200)])
    // The processes survive the first round of SIGKILL and are gone after the second.
    state.onKill = () => {
      if (state.kills.length >= 4) state.table = [row(1, 0, 1)]
    }
    expect(await tree.killUntilGone(2_000)).toBe(true)
    expect(state.kills).toHaveLength(4)
    expect(state.kills.every(([, signal]) => signal === 'SIGKILL')).toBe(true)
  })

  it('gives up on a process that does not die', async () => {
    const { tree } = setup([row(1, 0, 1), row(100, 1, 100)])
    expect(await tree.killUntilGone(80)).toBe(false)
  })
})

describe('job processes: usage', () => {
  it('measures CPU as a percentage of one CPU over the time between samples, 0 on the first', async () => {
    const { tree, state } = setup([
      row(1, 0, 1),
      row(100, 1, 100, { cpuSeconds: 10 }),
      row(101, 100, 100, { cpuSeconds: 5 }),
    ])
    expect((await tree.sample()).cpuPercent).toBe(0)
    state.now += 2_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 11 }), row(101, 100, 100, { cpuSeconds: 8 })]
    // Four CPU-seconds in two seconds: two CPUs.
    expect((await tree.sample()).cpuPercent).toBeCloseTo(200, 5)
    state.now += 4_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 11 }), row(101, 100, 100, { cpuSeconds: 8 })]
    expect((await tree.sample()).cpuPercent).toBe(0)
  })

  it('keeps the CPU time of members that ended', async () => {
    const { tree, state } = setup([
      row(1, 0, 1),
      row(100, 1, 100, { cpuSeconds: 1 }),
      row(101, 100, 100, { cpuSeconds: 3 }),
    ])
    expect((await tree.sample()).cpuSeconds).toBe(4)
    state.now += 1_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 2 })]
    const usage = await tree.sample()
    expect(usage.processes).toBe(1)
    expect(usage.cpuSeconds).toBe(5)
    // The ended member's time is not a burst of CPU in the interval.
    expect(usage.cpuPercent).toBeCloseTo(100, 5)
    state.now += 1_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 2.5 })]
    expect((await tree.sample()).cpuSeconds).toBe(5.5)
  })

  it('never answers a negative percentage, and keeps the last one for samples taken too close together', async () => {
    const { tree, state } = setup([row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 5 })])
    await tree.sample()
    state.now += 1_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 4 })]
    expect((await tree.sample()).cpuPercent).toBe(0)
    state.now += 1_000
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 5 })]
    expect((await tree.sample()).cpuPercent).toBeCloseTo(100, 5)
    state.now += 10
    state.table = [row(1, 0, 1), row(100, 1, 100, { cpuSeconds: 5.5 })]
    expect((await tree.sample()).cpuPercent).toBeCloseTo(100, 5)
  })

  it('runs calls one at a time', async () => {
    let reading = 0
    let overlapped = false
    const slow = new JobProcesses({
      rootPid: 100,
      jobId: JOB,
      platform: 'darwin',
      readTable: async () => {
        if (reading++) overlapped = true
        await new Promise((resolve) => setTimeout(resolve, 10))
        reading--
        return [row(100, 1, 100)]
      },
      kill: () => undefined,
    })
    await Promise.all([slow.sample(), slow.sample(), slow.alive(), slow.signal('SIGTERM')])
    expect(overlapped).toBe(false)
  })
})

describe('process tables', () => {
  it('reads /proc/<pid>/stat, whatever the command is called', () => {
    // utime 250 and stime 50 ticks at 100 per second, starttime 98765, rss 300 pages.
    const line =
      '123 (weird (name) x) S 1 123 123 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 1 0 98765 1000000 300 18446744073709551615 0 0 0'
    expect(parseProcStat(line, 4096, 100)).toEqual({
      pid: 123,
      ppid: 1,
      pgid: 123,
      start: '98765',
      rssBytes: 300 * 4096,
      cpuSeconds: 3,
      zombie: false,
    })
    expect(parseProcStat(line.replace(') S ', ') Z '), 4096, 100)?.zombie).toBe(true)
    expect(parseProcStat('not a stat line', 4096, 100)).toBeNull()
    expect(parseProcStat('1 (short) S 1', 4096, 100)).toBeNull()
  })

  it('reads the real /proc: a process this test started is a job of one', async () => {
    if (process.platform !== 'linux') return
    const child = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' })
    try {
      const tree = new JobProcesses({ rootPid: child.pid ?? 0, jobId: JOB, parentPid: process.pid })
      const usage = await tree.sample()
      expect(usage.processes).toBe(1)
      expect(usage.memoryBytes).toBeGreaterThan(0)
      expect(await tree.killUntilGone(3_000)).toBe(true)
    } finally {
      child.kill('SIGKILL')
    }
  })

  it('parses the CPU time of ps in each of its forms', () => {
    expect(parsePsTime('0:01.23')).toBeCloseTo(1.23)
    expect(parsePsTime('12:34.50')).toBeCloseTo(754.5)
    expect(parsePsTime('1:02:03.45')).toBeCloseTo(3723.45)
    expect(parsePsTime('2-01:02:03')).toBe(2 * 86_400 + 3_723)
    expect(parsePsTime('0:00')).toBe(0)
    expect(parsePsTime('12')).toBeNull()
    expect(parsePsTime('abc')).toBeNull()
    expect(parsePsTime('')).toBeNull()
  })

  it('parses a line of ps: the start time has spaces and is the rest of the line', () => {
    expect(parsePsLine('  501     1   501 Ss    12345   0:01.23 Thu Oct 29 10:00:00 2026')).toEqual({
      pid: 501,
      ppid: 1,
      pgid: 501,
      start: 'Thu Oct 29 10:00:00 2026',
      rssBytes: 12_345 * 1024,
      cpuSeconds: 1.23,
      zombie: false,
    })
    const hours = parsePsLine('99999 88888 77777 R+ 2048 1:02:03.45 Fri Nov  7 01:02:03 2026')
    expect(hours).toMatchObject({ pid: 99_999, ppid: 88_888, pgid: 77_777, cpuSeconds: 3723.45 })
    // The double space of a one-digit day does not make two processes of one.
    expect(hours?.start).toBe('Fri Nov 7 01:02:03 2026')
    expect(parsePsLine('  42  1  42 Z 0 2-01:02:03 Mon Jan  5 00:00:00 2026')).toMatchObject({
      zombie: true,
      cpuSeconds: 2 * 86_400 + 3_723,
    })
    expect(parsePsLine('PID PPID PGID STAT RSS TIME STARTED')).toBeNull()
    expect(parsePsLine('')).toBeNull()
  })

  it('follows a job through the rows of ps on macOS', async () => {
    const lines = [
      '    1     0     1 Ss     1000   0:10.00 Mon Oct 27 08:00:00 2026',
      '  500     1   500 Ss      900   0:00.10 Thu Oct 29 10:00:00 2026',
      '  501   500   500 S      2000   0:02.00 Thu Oct 29 10:00:01 2026',
      '  502   501   502 S      3000   0:03.00 Thu Oct 29 10:00:02 2026',
      '  600     1   600 S      5000   9:00.00 Thu Oct 29 09:00:00 2026',
    ]
    const tree = new JobProcesses({
      rootPid: 500,
      jobId: JOB,
      platform: 'darwin',
      readTable: async () => lines.flatMap((line) => parsePsLine(line) ?? []),
    })
    const usage = await tree.sample()
    expect(usage.processes).toBe(3)
    expect(usage.memoryBytes).toBe((900 + 2000 + 3000) * 1024)
    expect(usage.cpuSeconds).toBeCloseTo(5.1)
  })
})
