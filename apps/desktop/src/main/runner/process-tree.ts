import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

/** One process, as the operating system's table shows it. */
export interface ProcessInfo {
  pid: number
  ppid: number
  /** The process group. */
  pgid: number
  /** When it started, as a text that stays the same for as long as it lives: with its pid, it names that process. */
  start: string
  /** Bytes of resident memory. */
  rssBytes: number
  /** Cumulative CPU time, in seconds. */
  cpuSeconds: number
  /** Ended, and waiting for its parent to collect it: it holds no memory and cannot be signalled to any effect. */
  zombie: boolean
}

/** What a job's processes use, at one sample. */
export interface JobProcessUsage {
  /** Percent of ONE logical CPU since the sample before (400 is four CPUs busy); 0 on the first sample. */
  cpuPercent: number
  /** Resident memory of the live processes, added up. */
  memoryBytes: number
  /** Live processes. */
  processes: number
  /** CPU time of every process the job has had, those that already ended included. */
  cpuSeconds: number
}

export interface JobProcessesOptions {
  /** The command's own process: the leader of its group, started detached. */
  rootPid: number
  jobId: string
  /**
   * The process that started the root. The root is recognised only while its parent is this one, so a pid that was
   * reused before the first sample is not taken for it.
   */
  parentPid?: number
  platform?: NodeJS.Platform
  /** The process table; by default `/proc` on Linux and `ps` elsewhere. */
  readTable?: () => Promise<ProcessInfo[]>
  /** The environment of a process (`/proc/<pid>/environ`, Linux only); null when it cannot be read. */
  readEnviron?: (pid: number) => Promise<string | null>
  /** `process.kill`. */
  kill?: (pid: number, signal: NodeJS.Signals) => void
  now?: () => number
}

const READ_BATCH = 64
const PS_TIMEOUT_MS = 5_000
const PS_MAX_BUFFER = 32 * 1024 * 1024
/** Two samples closer than this keep the CPU percentage of the one before: the clock ticks are too coarse. */
const MIN_CPU_WINDOW_MS = 250
const KILL_POLL_MS = 25

/** The page size and the clock ticks per second of this computer, asked once; the usual values when it will not say. */
let systemConstants: Promise<{ pageSize: number; clockTicks: number }> | null = null
function readSystemConstants(): Promise<{ pageSize: number; clockTicks: number }> {
  const ask = (name: string, fallback: number) =>
    new Promise<number>((resolve) => {
      execFile('getconf', [name], { encoding: 'utf8', timeout: 5_000 }, (error, stdout) => {
        const value = Number.parseInt(String(stdout).trim(), 10)
        resolve(!error && value > 0 ? value : fallback)
      })
    })
  systemConstants ??= Promise.all([ask('PAGESIZE', 4096), ask('CLK_TCK', 100)]).then(([pageSize, clockTicks]) => ({
    pageSize,
    clockTicks,
  }))
  return systemConstants
}

/**
 * One process from the text of `/proc/<pid>/stat`. The command name sits in parentheses and may hold spaces and
 * parentheses, so the fields are counted from the last `)`: state, ppid, pgrp are fields 3 to 5, utime and stime 14 and
 * 15, starttime 22 (in clock ticks since boot) and rss 24 (in pages).
 */
export function parseProcStat(text: string, pageSize: number, clockTicks: number): ProcessInfo | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 1 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const fields = text.slice(close + 2).split(' ')
  const [state, ppid, pgid] = [fields[0], Number(fields[1]), Number(fields[2])]
  const [utime, stime, start, rss] = [Number(fields[11]), Number(fields[12]), fields[19], Number(fields[21])]
  if (![pid, ppid, pgid, utime, stime, rss].every(Number.isFinite) || !state || !start) return null
  return {
    pid,
    ppid,
    pgid,
    start,
    rssBytes: Math.max(0, rss) * pageSize,
    cpuSeconds: (utime + stime) / clockTicks,
    zombie: state === 'Z' || state === 'X',
  }
}

/** Seconds of a `ps` CPU time, `[[dd-]hh:]mm:ss[.cc]`; null when it is not one. */
export function parsePsTime(text: string): number | null {
  const match = /^(?:(\d+)-)?(\d+(?::\d+)?):(\d+(?:\.\d+)?)$/.exec(text)
  if (!match) return null
  const days = match[1] ? Number(match[1]) : 0
  const [first, second] = match[2].split(':').map(Number)
  const [hours, minutes] = second === undefined ? [0, first] : [first, second]
  return days * 86_400 + hours * 3_600 + minutes * 60 + Number(match[3])
}

/**
 * One line of `ps -axo pid=,ppid=,pgid=,stat=,rss=,time=,lstart=`: the first six columns are single words, and
 * `lstart` ("Thu Oct 29 10:00:00 2026") is the rest of the line. `rss` is in KiB.
 */
export function parsePsLine(line: string): ProcessInfo | null {
  const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(\S.*?)\s*$/.exec(line)
  if (!match) return null
  const cpuSeconds = parsePsTime(match[6])
  if (cpuSeconds === null) return null
  return {
    pid: Number(match[1]),
    ppid: Number(match[2]),
    pgid: Number(match[3]),
    start: match[7].replace(/\s+/g, ' '),
    rssBytes: Number(match[5]) * 1024,
    cpuSeconds,
    zombie: match[4].startsWith('Z'),
  }
}

/** Every process of the computer, from `/proc`. */
async function readProc(root: string, pageSize: number, clockTicks: number): Promise<ProcessInfo[]> {
  const names = (await readdir(root)).filter((name) => /^\d+$/.test(name))
  const rows: ProcessInfo[] = []
  for (let from = 0; from < names.length; from += READ_BATCH) {
    await Promise.all(
      names.slice(from, from + READ_BATCH).map(async (name) => {
        try {
          const row = parseProcStat(await readFile(path.join(root, name, 'stat'), 'utf8'), pageSize, clockTicks)
          if (row) rows.push(row)
        } catch {
          // The process ended between the listing and the read.
        }
      })
    )
  }
  return rows
}

/** Every process of the computer, from `ps`. */
function readPs(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'ps',
      ['-axo', 'pid=,ppid=,pgid=,stat=,rss=,time=,lstart='],
      { encoding: 'utf8', timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BUFFER, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout) => {
        if (error) return reject(error)
        resolve(
          String(stdout)
            .split('\n')
            .flatMap((line) => parsePsLine(line) ?? [])
        )
      }
    )
  })
}

async function readProcEnviron(root: string, pid: number): Promise<string | null> {
  try {
    return await readFile(path.join(root, String(pid), 'environ'), 'latin1')
  } catch {
    return null
  }
}

const identity = (row: Pick<ProcessInfo, 'pid' | 'start'>): string => `${row.pid}:${row.start}`

/**
 * The processes of one native job, which the command's own process group does not hold all of: a daemon, a `setsid`
 * or a detached child of Node starts a group of its own. A process belongs to the job when it is the root, when its
 * parent belongs, when it is in the root's process group, or (on Linux) when its environment carries
 * `MAESTRLY_JOB_ID=<jobId>`, which every command of a job and its children inherit and which finds a daemon that was
 * handed to init between two samples. Members are remembered by pid and start time, so a grandchild stays known after
 * its parent ends, and a pid that someone else reused is never taken for one or signalled.
 *
 * It samples what the members use and sends a signal to all of them. The calls are queued: each reads the process
 * table and updates the membership before it acts.
 */
export class JobProcesses {
  private readonly rootPid: number
  private readonly marker: string
  private readonly platform: NodeJS.Platform
  private readonly readTable: () => Promise<ProcessInfo[]>
  private readonly readEnviron: ((pid: number) => Promise<string | null>) | null
  private readonly sendSignal: (pid: number, signal: NodeJS.Signals) => void
  private readonly now: () => number
  private readonly parentPid: number | undefined
  /** The live members, by pid and start time, with the CPU time they had at the last read. */
  private readonly members = new Map<string, { cpuSeconds: number }>()
  /** Processes whose environment was read and does not carry the marker. */
  private readonly unmarked = new Set<string>()
  /** CPU time of the members that ended. */
  private endedCpuSeconds = 0
  /** How many times the process table was read. */
  private reads = 0
  /** No member was alive at the last read: nothing holds the root's group id, which may be somebody else's by now. */
  private emptied = false
  private previous: { at: number; cpuSeconds: number } | null = null
  private lastCpuPercent = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: JobProcessesOptions) {
    this.rootPid = options.rootPid
    this.parentPid = options.parentPid
    this.marker = `MAESTRLY_JOB_ID=${options.jobId}`
    this.platform = options.platform ?? process.platform
    this.now = options.now ?? Date.now
    this.sendSignal = options.kill ?? ((pid, signal) => process.kill(pid, signal))
    const linux = this.platform === 'linux'
    this.readTable =
      options.readTable ??
      (linux
        ? async () => {
            const { pageSize, clockTicks } = await readSystemConstants()
            return readProc('/proc', pageSize, clockTicks)
          }
        : readPs)
    this.readEnviron = options.readEnviron ?? (linux ? (pid) => readProcEnviron('/proc', pid) : null)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  /** Reads the process table, updates the membership, and answers the live members. */
  private async refresh(): Promise<ProcessInfo[]> {
    const rows = (await this.readTable()).filter((row) => !row.zombie && row.pid !== process.pid)
    const byKey = new Map(rows.map((row) => [identity(row), row]))
    for (const [key, member] of this.members) {
      if (byKey.has(key)) continue
      this.endedCpuSeconds += member.cpuSeconds
      this.members.delete(key)
    }
    for (const key of this.unmarked) if (!byKey.has(key)) this.unmarked.delete(key)

    const children = new Map<number, ProcessInfo[]>()
    for (const row of rows) {
      const siblings = children.get(row.ppid)
      if (siblings) siblings.push(row)
      else children.set(row.ppid, [row])
    }
    const pending: ProcessInfo[] = rows.filter((row) => this.members.has(identity(row)))
    const adopt = (row: ProcessInfo) => {
      const key = identity(row)
      if (this.members.has(key)) return
      this.members.set(key, { cpuSeconds: row.cpuSeconds })
      pending.push(row)
    }
    // The children of every member belong too, those of the members found now and of those found before.
    const propagate = () => {
      for (let next = pending.pop(); next; next = pending.pop())
        for (const child of children.get(next.pid) ?? []) adopt(child)
    }

    const root = rows.find((row) => row.pid === this.rootPid)
    if (root && this.reads === 0 && (this.parentPid === undefined || root.ppid === this.parentPid)) adopt(root)
    // The group id is somebody else's once nothing of the job held it at the last read, and when a process that is not
    // the root has the root's pid. A root that ended since then leaves its group's processes to this read.
    const groupHeld = !this.emptied && !(root && !this.members.has(identity(root)))
    if (groupHeld) for (const row of rows) if (row.pgid === this.rootPid) adopt(row)
    propagate()

    const read = this.readEnviron
    if (read) {
      const candidates = rows.filter(
        (row) =>
          !this.members.has(identity(row)) &&
          !this.unmarked.has(identity(row)) &&
          // Kernel threads have no environment.
          row.pid > 2 &&
          row.ppid !== 2
      )
      for (let from = 0; from < candidates.length; from += READ_BATCH)
        await Promise.all(
          candidates.slice(from, from + READ_BATCH).map(async (row) => {
            const environ = await read(row.pid)
            if (environ !== null && this.hasMarker(environ)) adopt(row)
            else this.unmarked.add(identity(row))
          })
        )
      propagate()
    }

    const live: ProcessInfo[] = []
    for (const row of rows) {
      const member = this.members.get(identity(row))
      if (!member) continue
      member.cpuSeconds = row.cpuSeconds
      live.push(row)
    }
    this.reads++
    this.emptied = live.length === 0
    return live
  }

  /** Whether an environment (`KEY=value` entries separated by NUL) holds the job's marker as an entry of its own. */
  private hasMarker(environ: string): boolean {
    for (let at = environ.indexOf(this.marker); at >= 0; at = environ.indexOf(this.marker, at + 1)) {
      const end = at + this.marker.length
      if ((at === 0 || environ[at - 1] === '\0') && (end === environ.length || environ[end] === '\0')) return true
    }
    return false
  }

  /** Refreshes the membership and answers what the live members use. Rejects when the process table cannot be read. */
  sample(): Promise<JobProcessUsage> {
    return this.enqueue(async () => {
      const live = await this.refresh()
      const at = this.now()
      let memoryBytes = 0
      let cpuSeconds = this.endedCpuSeconds
      for (const row of live) {
        memoryBytes += row.rssBytes
        cpuSeconds += row.cpuSeconds
      }
      if (!this.previous) {
        this.previous = { at, cpuSeconds }
      } else if (at - this.previous.at >= MIN_CPU_WINDOW_MS) {
        this.lastCpuPercent = Math.max(
          0,
          ((cpuSeconds - this.previous.cpuSeconds) / ((at - this.previous.at) / 1000)) * 100
        )
        this.previous = { at, cpuSeconds }
      }
      return { cpuPercent: this.lastCpuPercent, memoryBytes, processes: live.length, cpuSeconds }
    })
  }

  /** How many members are alive now. Rejects when the process table cannot be read. */
  alive(): Promise<number> {
    return this.enqueue(async () => (await this.refresh()).length)
  }

  /**
   * Sends `signal` to the root's process group, as a command's children are reached at once, and to every live member
   * outside it. Each is checked against a fresh reading of the process table first, so a pid that was reused is left
   * alone; a process that ended or belongs to someone else is ignored. When the table cannot be read, the group alone
   * is signalled while members are known to be alive. Answers how many members were alive.
   */
  signal(signal: NodeJS.Signals): Promise<number> {
    return this.enqueue(() => this.deliver(signal))
  }

  private async deliver(signal: NodeJS.Signals): Promise<number> {
    let live: ProcessInfo[] | null = null
    try {
      live = await this.refresh()
    } catch {
      // Falls back to the group.
    }
    const group = (): void => this.send(-this.rootPid, signal)
    if (!live) {
      if (!this.emptied) group()
      return this.members.size
    }
    // A group id is signalled only while a process of the table holds it: with none, its number may be somebody else's.
    if (live.some((row) => row.pgid === this.rootPid)) group()
    for (const row of live) if (row.pgid !== this.rootPid) this.send(row.pid, signal)
    return live.length
  }

  private send(pid: number, signal: NodeJS.Signals): void {
    try {
      this.sendSignal(pid, signal)
    } catch {
      // ESRCH: it ended. EPERM: a group of zombies, or a process that is not ours to signal.
    }
  }

  /** Signals every live member with SIGKILL until none is left, for at most `timeoutMs`. Answers whether none is. */
  async killUntilGone(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      let count: number
      try {
        count = await this.signal('SIGKILL')
      } catch {
        return false
      }
      if (count === 0) return true
      if (Date.now() >= deadline) return false
      await new Promise<void>((resolve) => setTimeout(resolve, KILL_POLL_MS))
    }
  }
}
