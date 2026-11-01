import { spawn } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import type { FleetInstanceStorage } from '@maestrly/bot-fleet-protocol'

/** The space `paths` take on disk together, in bytes; a path that does not exist takes none. */
export type DiskUsage = (paths: readonly string[], signal: AbortSignal) => Promise<number>

/** Figures older than this are measured again when the gateway next asks for them. */
export const STORAGE_MAX_AGE_MS = 10 * 60_000
/** How long one `du` may run; one that takes longer leaves the measurement failed. */
export const STORAGE_DU_TIMEOUT_MS = 5 * 60_000

/** The KiB `du -sk` printed, one line per path, summed; null when it printed none. */
export function parseDuOutput(text: string): number | null {
  let total: number | null = null
  for (const line of text.split('\n')) {
    const match = /^(\d+)\t/.exec(line)
    if (match) total = (total ?? 0) + Number(match[1])
  }
  return total
}

/**
 * `du -skx` at the lowest CPU priority (which also lowers its disk priority): the blocks the files take, on each
 * folder's own file system, so a mount inside the home folder is left out. An unreadable subfolder makes `du` exit
 * with 1 after printing the rest, which still counts.
 */
export const duDiskUsage: DiskUsage = async (paths, signal) => {
  const present = (
    await Promise.all(paths.map(async (item) => ((await lstat(item).catch(() => null)) ? item : null)))
  ).filter((item): item is string => item !== null)
  if (!present.length) return 0
  return new Promise<number>((resolve, reject) => {
    const child = spawn('nice', ['-n', '19', 'du', '-skx', '--', ...present], {
      stdio: ['ignore', 'pipe', 'ignore'],
      signal: AbortSignal.any([signal, AbortSignal.timeout(STORAGE_DU_TIMEOUT_MS)]),
    })
    let out = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      out += chunk
    })
    child.once('error', reject)
    child.once('close', (code) => {
      const kib = parseDuOutput(out)
      if (kib === null) reject(new Error(`du printed no size (exit ${code})`))
      else resolve(kib * 1024)
    })
  })
}

/** What one measurement sizes. */
export interface StorageTargets {
  home: string
  downloads: string
  /** A workspaces host's own server folder, outside the home folder; null otherwise. */
  folder: string | null
  bots: Array<{ botId: string; browser: string; others: string[] }>
}

const NO_FIGURES: FleetInstanceStorage = { environment: null, bots: [] }

/**
 * An environment's latest disk figures, measured again in the background when they are asked for and older than
 * `maxAgeMs`. Sizing large browser profiles and repositories is slow, so a read never waits: the first one answers no
 * figures and starts the first measurement. A failed measurement keeps the previous figures and is tried again only
 * once `maxAgeMs` passed.
 */
export class StorageMeter {
  private figures: FleetInstanceStorage = NO_FIGURES
  private attemptedAt: number | null = null
  private folder: string | null = null
  private running: Promise<void> | null = null
  private readonly controller = new AbortController()

  constructor(
    private readonly options: {
      targets(folder: string | null): Promise<StorageTargets>
      usage?: DiskUsage
      now?: () => number
      maxAgeMs?: number
      onError?: (error: unknown) => void
    }
  ) {}

  read(folder: string | null): FleetInstanceStorage {
    const now = this.now()
    const stale =
      this.attemptedAt === null ||
      now - this.attemptedAt >= (this.options.maxAgeMs ?? STORAGE_MAX_AGE_MS) ||
      folder !== this.folder
    if (stale && !this.running && !this.controller.signal.aborted) {
      this.attemptedAt = now
      this.folder = folder
      this.running = this.measure(folder).finally(() => {
        this.running = null
      })
    }
    return this.figures
  }
  /** The measurement in progress, if any, settled. */
  settled(): Promise<void> {
    return this.running ?? Promise.resolve()
  }
  /** Stops a measurement in progress; nothing is measured afterwards. */
  dispose(): void {
    this.controller.abort()
  }

  private now(): number {
    return (this.options.now ?? Date.now)()
  }
  private async measure(folder: string | null): Promise<void> {
    const usage = this.options.usage ?? duDiskUsage
    const signal = this.controller.signal
    try {
      const targets = await this.options.targets(folder)
      // One folder at a time: measuring must not compete with the bots' own work for the disk.
      const homeBytes = await usage([targets.home], signal)
      const downloadsBytes = await usage([targets.downloads], signal)
      const folderBytes = targets.folder ? await usage([targets.folder], signal) : null
      const bots: Array<{ botId: string; usedBytes: number; browserBytes: number }> = []
      for (const bot of targets.bots) {
        const browserBytes = await usage([bot.browser], signal)
        bots.push({ botId: bot.botId, browserBytes, usedBytes: browserBytes + (await usage(bot.others, signal)) })
      }
      const measuredAt = new Date(this.now()).toISOString()
      this.figures = {
        environment: { homeBytes, downloadsBytes, folderBytes, measuredAt },
        bots: bots.map((bot) => ({ ...bot, measuredAt })),
      }
    } catch (error) {
      if (!signal.aborted) this.options.onError?.(error)
    }
  }
}
