/**
 * Artifacts that earlier versions published on this computer. They no longer open here: the owner moves them to the
 * bot server or deletes them. The local host is opened only for that, and stopped again once idle. When nothing is
 * left, the local artifact folder is removed.
 */
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { type ArtifactAdmin, ArtifactHostError } from '@maestrly/artifact-host'
import type { LegacyArtifactView, LegacyMoveError, LegacyMoveState } from '../../shared/artifacts'
import type { ArtifactHostProcess } from './host-process'
import { transferArtifact } from './transfer'

const IDLE_STOP_MS = 60_000
/** Progress is reported at most this often within a step. */
const PROGRESS_INTERVAL_MS = 150

export interface LegacyArtifactsDeps {
  dataDir: () => string
  host: Pick<ArtifactHostProcess, 'ensureStarted' | 'stop'>
  /** Forgets the personal-link tokens of the people a deleted or moved artifact was shared with. */
  forgetPeople?: (principalIds: string[]) => void
  onState?: (state: LegacyMoveState) => void
  /** The set of artifacts on this computer changed. */
  onChanged?: () => void
  idleStopMs?: number
  removeDir?: (dir: string) => Promise<void>
}

const idleState = (): LegacyMoveState => ({
  phase: 'idle',
  items: [],
  moved: [],
  current: null,
  stopping: false,
  error: null,
})

const busy = () => new ArtifactHostError('invalid_input', 'Artifacts are being moved from this computer')

export function moveErrorOf(error: unknown): LegacyMoveError {
  if (error instanceof ArtifactHostError) {
    const reason = error.details?.reason
    return { code: error.code, ...(typeof reason === 'string' ? { reason } : {}) }
  }
  return { code: 'internal' }
}

export class LegacyArtifacts {
  private current: LegacyMoveState = idleState()
  private users = 0
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private abort: AbortController | null = null
  private lastProgress = 0
  private starting: Promise<LegacyMoveState> | null = null
  private clearing: Promise<void> | null = null
  private drained: (() => void) | null = null

  constructor(private readonly deps: LegacyArtifactsDeps) {}

  private get databaseFile(): string {
    return path.join(this.deps.dataDir(), 'artifacts.sqlite')
  }

  /** Whether anything was ever published on this computer and not cleared away yet. */
  exists(): boolean {
    return existsSync(this.databaseFile)
  }

  state(): LegacyMoveState {
    return {
      ...this.current,
      items: [...this.current.items],
      moved: [...this.current.moved],
      current: this.current.current ? { ...this.current.current } : null,
    }
  }

  private emit(): void {
    this.deps.onState?.(this.state())
  }

  /** Runs with the local host started, and stops it a while after the last use. */
  private async use<T>(action: (admin: ArtifactAdmin) => Promise<T>): Promise<T> {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    this.users++
    try {
      return await action(await this.deps.host.ensureStarted())
    } finally {
      this.users--
      if (this.users === 0) {
        this.drained?.()
        this.drained = null
        if (!this.clearing) {
          this.idleTimer = setTimeout(() => {
            this.idleTimer = null
            if (this.users === 0) void this.deps.host.stop()
          }, this.deps.idleStopMs ?? IDLE_STOP_MS)
          this.idleTimer.unref?.()
        }
      }
    }
  }

  private async view(admin: ArtifactAdmin): Promise<LegacyArtifactView[]> {
    const items = await admin.list()
    return Promise.all(
      items.map(async (item) => ({
        id: item.id,
        title: item.title,
        versionCount: item.versionCount,
        commentCount: (await admin.exportArtifact(item.id)).comments.length,
        storageBytes: item.storageBytes,
        shared: item.visibility !== 'private',
      }))
    )
  }

  async list(): Promise<LegacyArtifactView[]> {
    await this.clearing
    if (!this.exists()) return []
    const items = await this.use((admin) => this.view(admin))
    if (!items.length && this.current.phase !== 'running') await this.clear()
    return items
  }

  /** Whether an artifact is among those on this computer; false when it cannot tell. */
  async has(id: string): Promise<boolean> {
    await this.clearing
    if (!this.exists()) return false
    try {
      return await this.use(async (admin) => (await admin.get(id)) !== null)
    } catch {
      return false
    }
  }

  /** Deletes the given artifacts, or all of them, with every version and comment. */
  async remove(ids?: readonly string[]): Promise<void> {
    await this.clearing
    if (this.current.phase === 'running') throw busy()
    if (!this.exists()) return
    const empty = await this.use(async (admin) => {
      const targets = ids ?? (await admin.list()).map((item) => item.id)
      for (const id of targets) {
        const people = await admin.getSharing(id).then(
          (sharing) => sharing.people.map((person) => person.id),
          () => []
        )
        if (await admin.delete(id)) this.deps.forgetPeople?.(people)
      }
      return (await admin.list()).length === 0
    })
    if (empty) await this.clear()
    this.deps.onChanged?.()
  }

  /**
   * Starts moving the given artifacts, or all of them, to `target`, one at a time; returns at once with the state.
   * Calling it while a move runs returns that move's state.
   */
  move(target: () => ArtifactAdmin, ids?: readonly string[]): Promise<LegacyMoveState> {
    if (this.current.phase === 'running') return Promise.resolve(this.state())
    // Two quick requests start one move.
    this.starting ??= this.start(target, ids).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async start(target: () => ArtifactAdmin, ids?: readonly string[]): Promise<LegacyMoveState> {
    const all = await this.list()
    const present = new Set(all.map((item) => item.id))
    // Trying again after a failure continues the same move, so what already moved still counts.
    const resumed = !ids && this.current.phase === 'failed' ? this.current : null
    const moved = resumed ? resumed.moved.filter((id) => !present.has(id)) : []
    const items = resumed
      ? [
          ...resumed.items.filter((item) => present.has(item.id) || moved.includes(item.id)),
          ...all.filter((item) => !resumed.items.some((known) => known.id === item.id)),
        ]
      : ids
        ? all.filter((item) => ids.includes(item.id))
        : all
    const pending = items.filter((item) => !moved.includes(item.id))
    this.current = {
      phase: pending.length ? 'running' : 'done',
      items,
      moved,
      current: null,
      stopping: false,
      error: null,
    }
    this.emit()
    if (pending.length) void this.run(target, pending)
    return this.state()
  }

  /** Lets the artifact being moved finish, then stops. */
  stopAfterCurrent(): LegacyMoveState {
    if (this.current.phase === 'running' && !this.current.stopping) {
      this.current.stopping = true
      this.emit()
    }
    return this.state()
  }

  private progress(id: string, step: 'upload' | 'verify' | 'remove', progress: number): void {
    const changed = this.current.current?.step !== step || this.current.current?.id !== id
    this.current.current = { id, step, progress }
    const now = Date.now()
    if (changed || progress >= 1 || now - this.lastProgress >= PROGRESS_INTERVAL_MS) {
      this.lastProgress = now
      this.emit()
    }
  }

  private async run(target: () => ArtifactAdmin, items: LegacyArtifactView[]): Promise<void> {
    const abort = new AbortController()
    this.abort = abort
    let empty = false
    let outcome: Pick<LegacyMoveState, 'phase' | 'error'> = { phase: 'done', error: null }
    try {
      empty = await this.use(async (source) => {
        const remote = target()
        const status = await remote.status()
        const neededBytes = items.reduce((sum, item) => sum + item.storageBytes, 0)
        const freeBytes = Math.max(0, status.quotaBytes - status.storageBytes)
        if (neededBytes > freeBytes)
          throw Object.assign(new ArtifactHostError('quota_exceeded', 'Not enough space on the bot server'), {
            space: { neededBytes, freeBytes },
          })
        for (const item of items) {
          if (this.current.stopping) break
          const people = await source.getSharing(item.id).then(
            (sharing) => sharing.people.map((person) => person.id),
            () => []
          )
          this.progress(item.id, 'upload', 0)
          try {
            await transferArtifact(
              source,
              remote,
              item.id,
              (step, value) => this.progress(item.id, step, value),
              abort.signal
            )
          } catch (error) {
            if (error instanceof ArtifactHostError && error.code === 'quota_exceeded') {
              const now = await remote.status().catch(() => null)
              const left = items.filter((other) => !this.current.moved.includes(other.id))
              throw Object.assign(error, {
                space: {
                  neededBytes: left.reduce((sum, other) => sum + other.storageBytes, 0),
                  freeBytes: now ? Math.max(0, now.quotaBytes - now.storageBytes) : 0,
                },
              })
            }
            throw error
          }
          this.deps.forgetPeople?.(people)
          this.current.moved.push(item.id)
          this.current.current = null
          this.emit()
        }
        return (await source.list()).length === 0
      })
    } catch (error) {
      const space = (error as { space?: { neededBytes: number; freeBytes: number } }).space
      outcome = { phase: 'failed', error: { ...moveErrorOf(error), ...(space ?? {}) } }
    }
    this.abort = null
    if (empty) await this.clear().catch(() => {})
    // The move ends only once the folder is gone, so a new one never starts on it meanwhile.
    this.current = { ...this.current, ...outcome, current: null, stopping: false }
    this.emit()
    this.deps.onChanged?.()
  }

  /** A consistent copy of the local database, for a data export; false when there is nothing here. */
  async snapshot(targetFile: string): Promise<boolean> {
    await this.clearing
    if (!this.exists()) return false
    await this.use((admin) => admin.snapshot(targetFile))
    return true
  }

  /** Stops the host and removes the local artifact folder: nothing is left in it. */
  private clear(): Promise<void> {
    if (this.clearing) return this.clearing
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    // Close and remove storage once, after existing readers finish. New readers wait and recheck its presence.
    const clearing = Promise.resolve()
      .then(async () => {
        if (this.users > 0)
          await new Promise<void>((resolve) => {
            this.drained = resolve
          })
        await this.deps.host.stop()
        await (this.deps.removeDir ?? ((dir) => rm(dir, { recursive: true, force: true })))(this.deps.dataDir())
      })
      .finally(() => {
        if (this.clearing === clearing) this.clearing = null
      })
    this.clearing = clearing
    return clearing
  }

  async dispose(): Promise<void> {
    this.abort?.abort()
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    await this.clearing?.catch(() => {})
    await this.deps.host.stop()
  }
}
