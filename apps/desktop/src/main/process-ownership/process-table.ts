import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'

/**
 * One row of the operating system's process table. A pid alone can name another process once the first one is gone;
 * `(pid, startTime)` names one process for good, so every signal Maestrly sends to a process it did not just spawn is
 * checked against both.
 */
export interface ProcessInfo {
  pid: number
  ppid: number
  pgid: number
  /** Session id; null where the platform does not report it (macOS `ps`). */
  sid: number | null
  /** As the platform reports it: clock ticks after boot on Linux, `lstart` on macOS. Only compared for equality. */
  startTime: string
  /** Executable name only. The command line can carry secrets and is never read. */
  name: string
  zombie: boolean
}

export interface ProcessIdentity {
  pid: number
  startTime: string
}

export interface ProcessTable {
  /** Whether rows carry a session id. */
  readonly sessions: boolean
  /** Every process, or null where the table cannot be read (Windows, or a failed read). */
  list(): Promise<ProcessInfo[] | null>
  /** The given pids that still have a row (zombies included); null when the table cannot be read. */
  get(pids: readonly number[]): Promise<Map<number, ProcessInfo> | null>
}

/** The process still runs and is the one that was captured. */
export function isSameLiveProcess(info: ProcessInfo | undefined, identity: ProcessIdentity): info is ProcessInfo {
  return !!info && !info.zombie && info.pid === identity.pid && info.startTime === identity.startTime
}

export function identityOf(info: ProcessInfo): ProcessIdentity {
  return { pid: info.pid, startTime: info.startTime }
}

/**
 * Parses `/proc/<pid>/stat`. The name sits in parentheses and may itself contain spaces and parentheses, so the
 * fields are counted from the last closing parenthesis: state, ppid, pgrp, session, ... starttime (the 22nd field).
 */
export function parseProcStat(text: string): ProcessInfo | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open <= 0 || close < open) return null
  const pid = Number(text.slice(0, open).trim())
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const [state, ppid, pgid, sid] = [fields[0], Number(fields[1]), Number(fields[2]), Number(fields[3])]
  const startTime = fields[19]
  if (!Number.isInteger(pid) || pid <= 0 || !state || !startTime || !/^\d+$/.test(startTime)) return null
  if (![ppid, pgid, sid].every((value) => Number.isInteger(value) && value >= 0)) return null
  return {
    pid,
    ppid,
    pgid,
    sid,
    startTime,
    name: text.slice(open + 1, close),
    // Z: zombie, X: dead. Neither runs any more; only its parent can make it go away.
    zombie: state === 'Z' || state === 'X',
  }
}

const PS_FIELDS = 'pid=,ppid=,pgid=,stat=,lstart=,comm='
const PS_LINE =
  /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/

/** Parses `ps -o pid=,ppid=,pgid=,stat=,lstart=,comm=` run with LC_ALL=C; malformed rows are skipped. */
export function parsePsProcessLines(stdout: string): ProcessInfo[] {
  const out: ProcessInfo[] = []
  for (const line of stdout.split('\n')) {
    const match = PS_LINE.exec(line)
    if (!match) continue
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      pgid: Number(match[3]),
      sid: null,
      startTime: match[5].replace(/\s+/g, ' '),
      name: match[6].trim(),
      zombie: match[4].startsWith('Z'),
    })
  }
  return out
}

/** Reads one process synchronously on Linux; null elsewhere or when it is gone. */
export function readProcessSync(pid: number, platform: NodeJS.Platform = process.platform): ProcessInfo | null {
  if (platform !== 'linux' || !Number.isInteger(pid) || pid <= 0) return null
  try {
    return parseProcStat(readFileSync(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    return null
  }
}

async function readProcStat(pid: number): Promise<ProcessInfo | null> {
  try {
    return parseProcStat(await readFile(`/proc/${pid}/stat`, 'utf8'))
  } catch {
    // The process ended between the directory listing and the read.
    return null
  }
}

/** Reads in small batches: a whole table at once would open one file per process at the same time. */
async function readProcStats(pids: readonly number[]): Promise<ProcessInfo[]> {
  const out: ProcessInfo[] = []
  for (let index = 0; index < pids.length; index += 64) {
    const batch = await Promise.all(pids.slice(index, index + 64).map(readProcStat))
    for (const info of batch) if (info) out.push(info)
  }
  return out
}

const linuxTable: ProcessTable = {
  sessions: true,
  async list() {
    try {
      const names = await readdir('/proc')
      return await readProcStats(names.filter((name) => /^\d+$/.test(name)).map(Number))
    } catch {
      return null
    }
  },
  async get(pids) {
    const rows = await readProcStats([...new Set(pids)])
    return new Map(rows.map((row) => [row.pid, row]))
  },
}

function runPs(args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      args,
      { env: { ...process.env, LC_ALL: 'C' }, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        // `ps -p` exits 1 when none of the pids exists; that is an empty answer, not a failure.
        if (error && !(typeof error.code === 'number' && error.code === 1 && !String(stdout).trim())) {
          resolve(null)
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

const psTable: ProcessTable = {
  sessions: false,
  async list() {
    const stdout = await runPs(['-axo', PS_FIELDS])
    return stdout === null ? null : parsePsProcessLines(stdout)
  },
  async get(pids) {
    const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0)
    if (unique.length === 0) return new Map()
    const stdout = await runPs(['-o', PS_FIELDS, '-p', unique.join(',')])
    return stdout === null ? null : new Map(parsePsProcessLines(stdout).map((row) => [row.pid, row]))
  },
}

const unsupportedTable: ProcessTable = {
  sessions: false,
  list: async () => null,
  get: async () => null,
}

export function processTableFor(platform: NodeJS.Platform = process.platform): ProcessTable {
  if (platform === 'linux') return linuxTable
  if (platform === 'win32') return unsupportedTable
  return psTable
}
