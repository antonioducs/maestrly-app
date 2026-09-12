export type SubagentCoordinatorEvent =
  | { type: 'acquired'; agent: string; active: number }
  | { type: 'released'; agent: string; active: number }

export interface SubagentLease {
  release: () => void
}

/**
 * Lifecycle-event coordinator only. It deliberately has no queue, semaphore,
 * per-turn cap, or aggregate cap: every admitted child starts immediately and the
 * parent AbortSignal remains the shared kill switch.
 */
export class SubagentCoordinator {
  private readonly onEvent?: (event: SubagentCoordinatorEvent) => void
  private active = 0

  constructor(options: { onEvent?: (event: SubagentCoordinatorEvent) => void } = {}) {
    this.onEvent = options.onEvent
  }

  acquire(args: { agent: string; signal: AbortSignal }): Promise<SubagentLease> {
    if (args.signal.aborted) return Promise.reject(new Error('Subagent coordination aborted'))
    this.active += 1
    this.onEvent?.({ type: 'acquired', agent: args.agent, active: this.active })
    let released = false
    return Promise.resolve({
      release: () => {
        if (released) return
        released = true
        this.active = Math.max(0, this.active - 1)
        this.onEvent?.({ type: 'released', agent: args.agent, active: this.active })
      },
    })
  }
}
