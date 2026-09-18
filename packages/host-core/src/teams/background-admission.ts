import { ROUTINE_LIMITS, TEAM_LIMITS } from '@maestrly/host-protocol'

/**
 * One pool of background slots for every kind of work a person is not watching: team tasks
 * and scheduled routine occurrences. Giving each scheduler its own two slots would silently
 * double what the Host runs at once, which is exactly the kind of drift nobody notices until
 * a laptop starts swapping.
 *
 * Counting is derived from durable state, never from an in-memory counter that a restart
 * would reset. A team run is counted through the member tasks that actually occupy bots, so
 * a routine that drives a team is not counted twice on top of them. The private chat is
 * deliberately outside this pool: a person typing to their bot is not background work, and
 * the "one turn per bot" rule already governs it.
 */
export interface BackgroundUsage {
  /** Team tasks currently occupying a bot, across every team. */
  teamTasks: number
  /** Routine occurrences driving an individual bot right now. */
  routineOccurrences: number
}

export class BackgroundAdmission {
  constructor(
    private readonly usage: () => BackgroundUsage,
    private readonly limit: number = Math.max(TEAM_LIMITS.globalConcurrency, ROUTINE_LIMITS.backgroundConcurrency)
  ) {}
  get capacity() {
    return this.limit
  }
  used() {
    const value = this.usage()
    return value.teamTasks + value.routineOccurrences
  }
  /** True when one more piece of background work may be admitted right now. */
  available() {
    return this.used() < this.limit
  }
  remaining() {
    return Math.max(0, this.limit - this.used())
  }
}
