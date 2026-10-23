import { promises as fs } from 'node:fs'
import path from 'node:path'

/**
 * Download each new VS Code server version in the background, so that opening the editor after a release does not
 * wait for it. serve-web serves the latest stable server whatever the CLI's version, and downloads it only when a
 * window asks for it (cli/src/commands/serve_web.rs): the warm-up asks for it, on a server it starts if none runs,
 * and stops that server again when nothing else uses it. It only runs for someone who opened the editor recently,
 * so that the ~230 MB of each release are the ones they would download anyway when opening it.
 */

export const WARMUP_FIRST_DELAY_MS = 2 * 60_000
export const WARMUP_INTERVAL_MS = 6 * 60 * 60_000
export const WARMUP_RECENT_USE_MS = 14 * 24 * 60 * 60_000
/** How long the download may go without progress before this run gives up (waitForEditorReady). */
export const WARMUP_READY_TIMEOUT_MS = 10 * 60_000
/** Opening the editor is noted on disk at most this often. */
const USE_WRITE_INTERVAL_MS = 60 * 60_000

export interface VSCodeWarmupState {
  /** When the editor was last opened on this computer, or for another one through this host. */
  lastUsedAt?: number
  /** The server version already downloaded by a warm-up. */
  warmedCommit?: string
}

export interface VSCodeWarmupDeps {
  stateFile(): string
  now(): number
  /** Whether the editor's CLI is installed, which only the first opening of the editor does. */
  cliReady(): boolean
  latestCommit(): Promise<string | null>
  running(): boolean
  start(): Promise<void>
  waitReady(timeoutMs: number): Promise<void>
  servedCommit(): Promise<string | null>
  /** Stops the editor server unless a window, another computer or the agent uses it. */
  stopIfIdle(): void
  log?(message: string): void
}

export type VSCodeWarmupOutcome = 'no-cli' | 'unused' | 'offline' | 'current' | 'warmed' | 'stale' | 'failed'

function parseState(text: string): VSCodeWarmupState {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    const state: VSCodeWarmupState = {}
    if (typeof value.lastUsedAt === 'number' && Number.isFinite(value.lastUsedAt)) state.lastUsedAt = value.lastUsedAt
    if (typeof value.warmedCommit === 'string' && /^[0-9a-f]{40}$/.test(value.warmedCommit)) {
      state.warmedCommit = value.warmedCommit
    }
    return state
  } catch {
    return {}
  }
}

export class VSCodeWarmup {
  private state: VSCodeWarmupState | null = null
  private writing: Promise<void> = Promise.resolve()
  private inFlight: Promise<VSCodeWarmupOutcome> | null = null
  /** In memory, unlike lastUsedAt on disk: an opening while a warm-up runs keeps its server up. */
  private lastUseMs = 0
  private lastUseSaved = Number.NEGATIVE_INFINITY

  constructor(private readonly deps: VSCodeWarmupDeps) {}

  private async load(): Promise<VSCodeWarmupState> {
    if (this.state) return this.state
    let text = ''
    try {
      text = await fs.readFile(this.deps.stateFile(), 'utf8')
    } catch {
      /* No warm-up state yet. */
    }
    this.state ??= parseState(text)
    return this.state
  }

  private save(patch: VSCodeWarmupState): Promise<void> {
    this.writing = this.writing.then(async () => {
      const next = { ...(await this.load()), ...patch }
      this.state = next
      const file = this.deps.stateFile()
      const temp = `${file}.${process.pid}.tmp`
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(temp, JSON.stringify(next), 'utf8')
        await fs.rename(temp, file)
      } catch {
        await fs.rm(temp, { force: true }).catch(() => {})
      }
    })
    return this.writing
  }

  /**
   * The editor was opened (another computer's editor calls this for each of its requests): keeps warming up the next
   * releases for the next WARMUP_RECENT_USE_MS.
   */
  noteUse(): void {
    const now = this.deps.now()
    this.lastUseMs = now
    if (now - this.lastUseSaved < USE_WRITE_INTERVAL_MS) return
    this.lastUseSaved = now
    void this.save({ lastUsedAt: now })
  }

  /** One warm-up at a time: a call while one runs gets its outcome. */
  run(): Promise<VSCodeWarmupOutcome> {
    this.inFlight ??= this.warm().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async warm(): Promise<VSCodeWarmupOutcome> {
    if (!this.deps.cliReady()) return 'no-cli'
    const state = await this.load()
    if (state.lastUsedAt === undefined || this.deps.now() - state.lastUsedAt > WARMUP_RECENT_USE_MS) return 'unused'
    const latest = await this.deps.latestCommit().catch(() => null)
    if (!latest) return 'offline'
    if (state.warmedCommit === latest) return 'current'

    const startedAt = this.deps.now()
    const startedHere = !this.deps.running()
    try {
      await this.deps.start()
      // Asking for the editor makes serve-web download the latest server; this returns once it serves it.
      await this.deps.waitReady(WARMUP_READY_TIMEOUT_MS)
      const served = await this.deps.servedCommit()
      // A server already running refreshes the latest version once an hour: the next run tries again.
      if (served !== latest) return 'stale'
      await this.save({ warmedCommit: latest })
      this.deps.log?.(`warmed VS Code server ${latest.slice(0, 7)}`)
      return 'warmed'
    } catch {
      return 'failed'
    } finally {
      if (startedHere && this.lastUseMs < startedAt) this.deps.stopIfIdle()
    }
  }

  /** Runs WARMUP_FIRST_DELAY_MS after the app starts, then every WARMUP_INTERVAL_MS; returns the cancel. */
  schedule(): () => void {
    const tick = (): void => {
      void this.run().catch(() => undefined)
    }
    const first = setTimeout(tick, WARMUP_FIRST_DELAY_MS)
    const every = setInterval(tick, WARMUP_INTERVAL_MS)
    first.unref?.()
    every.unref?.()
    return () => {
      clearTimeout(first)
      clearInterval(every)
    }
  }
}
