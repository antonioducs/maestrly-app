import type { FleetInstanceStatus } from '@maestrly/bot-fleet-protocol'

export type RecycleStatus = Pick<FleetInstanceStatus, 'turn' | 'queue' | 'pending' | 'compaction'>

export const RUNTIME_RECYCLE_INTERVAL_MS = 30_000

/** Whether restarting a runtime connection now could interrupt this bot's work. */
export function blocksRuntimeRecycle(status: RecycleStatus): boolean {
  const progress = status.compaction?.progress?.status
  return (
    status.turn.state !== 'idle' ||
    status.queue.length > 0 ||
    status.pending.length > 0 ||
    progress === 'running' ||
    progress === 'retrying' ||
    status.compaction?.background.status === 'running'
  )
}

export interface RuntimeRecycleSchedulerDependencies {
  /** Every bot of the environment, read now. */
  readonly statuses: () => Promise<readonly RecycleStatus[]>
  /** Closes idle connections so the next request starts the runtime now selected; false to try again later. */
  readonly recycle: () => Promise<boolean>
  readonly intervalMs?: number
  readonly log?: (message: string, error?: unknown) => void
}

/**
 * Recycles long-lived runtime connections (Codex app-servers) after an update, once no bot of the environment is
 * working, so an update never interrupts a turn. Checks when requested, then every interval until it succeeds.
 */
export class RuntimeRecycleScheduler {
  private readonly dependencies: RuntimeRecycleSchedulerDependencies
  private timer: ReturnType<typeof setInterval> | null = null
  private attempt: Promise<void> | null = null
  private disposed = false

  constructor(dependencies: RuntimeRecycleSchedulerDependencies) {
    this.dependencies = dependencies
  }

  request(): void {
    if (this.disposed) return
    if (!this.timer) {
      this.timer = setInterval(() => void this.check(), this.dependencies.intervalMs ?? RUNTIME_RECYCLE_INTERVAL_MS)
      this.timer.unref?.()
    }
    void this.check()
  }

  private check(): Promise<void> {
    this.attempt ??= this.runCheck().finally(() => {
      this.attempt = null
    })
    return this.attempt
  }

  private async runCheck(): Promise<void> {
    try {
      const statuses = await this.dependencies.statuses()
      if (this.disposed || statuses.some(blocksRuntimeRecycle)) return
      if (await this.dependencies.recycle()) this.stop()
    } catch (error) {
      ;(this.dependencies.log ?? ((message, cause) => console.warn(`[runtime-recycle] ${message}`, cause ?? '')))(
        'Unable to recycle runtime connections',
        error
      )
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  dispose(): void {
    this.disposed = true
    this.stop()
  }
}
