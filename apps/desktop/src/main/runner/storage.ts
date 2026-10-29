import { createHash } from 'node:crypto'
import { chmod, lstat, mkdir, open, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { realFs } from '../real-fs'
import { errnoOf } from './errors'

/**
 * Where a runner keeps its files. Everything of one bot lives under a scope, a file-system-safe key made of the
 * server and the bot, so one bot's blobs and caches are never another's:
 *
 *   blobs/<scope>/<aa>/<digest>        the blob cache, content-addressed
 *   caches/<scope>/<cacheName>/        named caches, kept across jobs
 *   jobs/<key>/work/                   a job's assembled folder (job.log and outputs.tar.zst sit beside it)
 *   scopes/<scope>.json                which server and bot a scope is, for listing
 *   state.json                         the jobs the worker holds
 *   history.json                       the jobs that ended here lately
 *   history/<jobKey>.log               the end of the log of each of them
 */

const CACHE_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/
const JOB_ID = /^job_[A-Za-z0-9_-]{16,64}$/
const sha256Hex = (text: string): string => createHash('sha256').update(text).digest('hex')

export interface RunnerScopeUsage {
  scope: string
  /** The bot, when this computer remembers whose scope it is. */
  serverId: string | null
  botId: string | null
  blobBytes: number
  cacheBytes: number
  caches: Array<{ name: string; bytes: number }>
}
export interface RunnerStorageUsage {
  scopes: RunnerScopeUsage[]
  blobBytes: number
  cacheBytes: number
}

/** Bytes of every file under `directory`, links not followed. */
export async function directoryBytes(directory: string): Promise<number> {
  let names: import('node:fs').Dirent[]
  try {
    names = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    if (errnoOf(error) === 'ENOENT' || errnoOf(error) === 'ENOTDIR') return 0
    throw error
  }
  let total = 0
  for (const entry of names) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directoryBytes(absolute)
    else if (entry.isFile()) total += (await lstat(absolute).catch(() => null))?.size ?? 0
  }
  return total
}

export class RunnerStorage {
  constructor(readonly root: string) {}

  /** The scope of one bot of one server. */
  scope(serverId: string, botId: string): string {
    return sha256Hex(`${serverId}\n${botId}`).slice(0, 32)
  }
  /** The name of a job's folder on this computer; unique across the servers this computer is paired with. */
  jobKey(serverId: string, jobId: string): string {
    if (!JOB_ID.test(jobId)) throw new Error('Invalid job id')
    return `${sha256Hex(serverId).slice(0, 8)}-${jobId}`
  }

  blobsRoot(): string {
    return path.join(this.root, 'blobs')
  }
  blobsDir(scope: string): string {
    return path.join(this.blobsRoot(), this.safe(scope))
  }
  cachesRoot(): string {
    return path.join(this.root, 'caches')
  }
  /** The folder of a named cache; the name has the shape the protocol allows. */
  cacheDir(scope: string, cacheName: string): string {
    if (!CACHE_NAME.test(cacheName)) throw new Error('Invalid cache name')
    return path.join(this.cachesRoot(), this.safe(scope), cacheName)
  }
  jobsRoot(): string {
    return path.join(this.root, 'jobs')
  }
  jobDir(key: string): string {
    return path.join(this.jobsRoot(), this.safe(key))
  }
  workDir(key: string): string {
    return path.join(this.jobDir(key), 'work')
  }
  logFile(key: string): string {
    return path.join(this.jobDir(key), 'job.log')
  }
  outputsFile(key: string): string {
    return path.join(this.jobDir(key), 'outputs.tar.zst')
  }
  stateFile(): string {
    return path.join(this.root, 'state.json')
  }
  historyFile(): string {
    return path.join(this.root, 'history.json')
  }
  historyDir(): string {
    return path.join(this.root, 'history')
  }
  /** Where the end of an ended job's log is kept. */
  historyLog(key: string): string {
    return path.join(this.historyDir(), `${this.safe(key)}.log`)
  }

  private safe(name: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('Invalid storage name')
    return name
  }

  /** Records whose scope this is, so the settings can list it by bot. */
  async remember(serverId: string, botId: string): Promise<string> {
    const scope = this.scope(serverId, botId)
    const file = path.join(this.root, 'scopes', `${scope}.json`)
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ serverId, botId }))
    return scope
  }

  /** Every scope that has blobs, caches or a record. */
  async scopes(): Promise<string[]> {
    const names = new Set<string>()
    for (const [directory, strip] of [
      [this.blobsRoot(), ''],
      [this.cachesRoot(), ''],
      [path.join(this.root, 'scopes'), '.json'],
    ] as const) {
      for (const entry of await readdir(directory).catch(() => [] as string[])) {
        const name = strip && entry.endsWith(strip) ? entry.slice(0, -strip.length) : entry
        if (/^[A-Za-z0-9_-]+$/.test(name)) names.add(name)
      }
    }
    return [...names].sort()
  }

  /** Whose scope each record says it is: what the runner keeps for a bot of a server, whichever bots exist now. */
  async records(): Promise<Array<{ scope: string; serverId: string; botId: string }>> {
    const directory = path.join(this.root, 'scopes')
    const found: Array<{ scope: string; serverId: string; botId: string }> = []
    for (const name of (await readdir(directory).catch(() => [] as string[])).sort()) {
      const scope = name.endsWith('.json') ? name.slice(0, -'.json'.length) : ''
      if (!/^[A-Za-z0-9_-]+$/.test(scope)) continue
      const record = await readFile(path.join(directory, name), 'utf8')
        .then((text) => JSON.parse(text) as { serverId?: unknown; botId?: unknown })
        .catch(() => null)
      if (typeof record?.serverId === 'string' && typeof record.botId === 'string')
        found.push({ scope, serverId: record.serverId, botId: record.botId })
    }
    return found
  }

  /** Bytes of the blobs and the named caches of every scope. */
  async usage(): Promise<RunnerStorageUsage> {
    const scopes: RunnerScopeUsage[] = []
    for (const scope of await this.scopes()) {
      const record = await readFile(path.join(this.root, 'scopes', `${scope}.json`), 'utf8')
        .then((text) => JSON.parse(text) as { serverId?: unknown; botId?: unknown })
        .catch(() => null)
      const cachesDir = path.join(this.cachesRoot(), scope)
      const caches: RunnerScopeUsage['caches'] = []
      for (const name of (await readdir(cachesDir).catch(() => [] as string[])).sort())
        caches.push({ name, bytes: await directoryBytes(path.join(cachesDir, name)) })
      scopes.push({
        scope,
        serverId: typeof record?.serverId === 'string' ? record.serverId : null,
        botId: typeof record?.botId === 'string' ? record.botId : null,
        blobBytes: await directoryBytes(this.blobsDir(scope)),
        cacheBytes: caches.reduce((sum, cache) => sum + cache.bytes, 0),
        caches,
      })
    }
    return {
      scopes,
      blobBytes: scopes.reduce((sum, scope) => sum + scope.blobBytes, 0),
      cacheBytes: scopes.reduce((sum, scope) => sum + scope.cacheBytes, 0),
    }
  }

  /** Deletes the named caches of one scope, or of every scope. */
  async clearCaches(scope?: string): Promise<void> {
    await rm(scope === undefined ? this.cachesRoot() : path.join(this.cachesRoot(), this.safe(scope)), {
      recursive: true,
      force: true,
    })
  }

  /** Deletes everything this computer keeps for one bot: its blobs, its caches and its record. */
  async clearScope(scope: string): Promise<void> {
    await Promise.all([
      rm(this.blobsDir(scope), { recursive: true, force: true }),
      rm(path.join(this.cachesRoot(), this.safe(scope)), { recursive: true, force: true }),
      rm(path.join(this.root, 'scopes', `${scope}.json`), { force: true }),
    ])
  }

  /** Deletes a job's folder, with its work folder, log and outputs. */
  async removeJob(key: string): Promise<void> {
    await removeTree(this.jobDir(key))
  }

  /** Deletes every job folder: after a restart no job runs, whatever it left. */
  async removeAllJobs(): Promise<void> {
    for (const name of await readdir(this.jobsRoot()).catch(() => [] as string[]))
      await removeTree(path.join(this.jobsRoot(), name))
  }

  /** Writes a file whole, so a crash leaves the old or the new one. Calls for one file must not overlap. */
  private async writeJson(file: string, value: unknown): Promise<void> {
    await mkdir(path.dirname(file), { recursive: true })
    const partial = `${file}.${process.pid}.tmp`
    await writeFile(partial, JSON.stringify(value), { mode: 0o600 })
    await rename(partial, file)
  }
  /** Writes `state.json` whole. */
  async writeState(value: unknown): Promise<void> {
    await this.writeJson(this.stateFile(), value)
  }
  async readState(): Promise<unknown> {
    return JSON.parse(await readFile(this.stateFile(), 'utf8').catch(() => 'null'))
  }
  /** Writes `history.json` whole. */
  async writeHistory(value: unknown): Promise<void> {
    await this.writeJson(this.historyFile(), value)
  }
  async readHistory(): Promise<unknown> {
    return JSON.parse(await readFile(this.historyFile(), 'utf8').catch(() => 'null'))
  }

  /**
   * Keeps the last `maxBytes` of a job's log under its key, starting at the start of a line when the log is cut.
   * Answers false when the job has no log to keep.
   */
  async keepLog(source: string, key: string, maxBytes: number): Promise<boolean> {
    let handle: Awaited<ReturnType<typeof open>>
    try {
      handle = await open(source, 'r')
    } catch (error) {
      if (errnoOf(error) === 'ENOENT') return false
      throw error
    }
    let bytes: Buffer
    try {
      const { size } = await handle.stat()
      const start = Math.max(0, size - maxBytes)
      bytes = Buffer.alloc(size - start)
      let read = 0
      while (read < bytes.length) {
        const { bytesRead } = await handle.read(bytes, read, bytes.length - read, start + read)
        if (!bytesRead) break
        read += bytesRead
      }
      bytes = bytes.subarray(0, read)
      if (start > 0) {
        // The cut falls inside a line: the kept log starts at the next one, or at a whole character when there is none.
        const newline = bytes.indexOf(0x0a)
        let from = newline >= 0 && newline < bytes.length - 1 ? newline + 1 : 0
        while (from < bytes.length && (bytes[from] & 0xc0) === 0x80) from++
        bytes = bytes.subarray(from)
      }
    } finally {
      await handle.close()
    }
    const file = this.historyLog(key)
    await mkdir(path.dirname(file), { recursive: true })
    const partial = `${file}.${process.pid}.tmp`
    await writeFile(partial, bytes, { mode: 0o600 })
    await rename(partial, file)
    return true
  }

  async removeHistoryLog(key: string): Promise<void> {
    await rm(this.historyLog(key), { force: true })
  }

  /** Deletes what the history folder holds besides the logs of `keep`: logs of entries that were dropped, and leftovers. */
  async pruneHistoryLogs(keep: ReadonlySet<string>): Promise<void> {
    const wanted = new Set([...keep].map((key) => `${this.safe(key)}.log`))
    for (const name of await readdir(this.historyDir()).catch(() => [] as string[]))
      if (!wanted.has(name)) await rm(path.join(this.historyDir(), name), { recursive: true, force: true })
  }
}

/**
 * Deletes a folder a job wrote in. Its modes may stop `rm` from entering a folder, so they are opened first when
 * the first try is refused. It goes through the plain file system: a job's file named `*.asar` is a file.
 */
export async function removeTree(directory: string): Promise<void> {
  try {
    await realFs.promises.rm(directory, { recursive: true, force: true })
  } catch (error) {
    if (errnoOf(error) !== 'EACCES' && errnoOf(error) !== 'EPERM') throw error
    await openModes(directory)
    await realFs.promises.rm(directory, { recursive: true, force: true })
  }
}

async function openModes(directory: string): Promise<void> {
  await chmod(directory, 0o700).catch(() => undefined)
  for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await openModes(path.join(directory, entry.name))
  }
}
