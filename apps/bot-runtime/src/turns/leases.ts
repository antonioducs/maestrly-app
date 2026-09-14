export class LeaseTracker {
  private timers = new Map<string, NodeJS.Timeout>()
  renew(turnId: string, leaseMs: number, expire: () => void) {
    this.clear(turnId)
    this.timers.set(
      turnId,
      setTimeout(
        () => {
          this.timers.delete(turnId)
          expire()
        },
        Math.min(leaseMs, 2_147_483_647)
      )
    )
  }
  clear(turnId: string) {
    clearTimeout(this.timers.get(turnId))
    this.timers.delete(turnId)
  }
  close() {
    for (const id of this.timers.keys()) this.clear(id)
  }
}
/** Extension point for later shell/computer tools. Register detached process groups only. */
export class ProcessRegistry {
  private groups = new Map<string, Set<number>>()
  register(turnId: string, pgid: number) {
    if (!Number.isInteger(pgid) || pgid <= 1 || pgid === process.pid) throw new Error('Invalid process group')
    const groups = this.groups.get(turnId) ?? new Set<number>()
    groups.add(pgid)
    this.groups.set(turnId, groups)
    return () => groups.delete(pgid)
  }
  async stop(turnId: string) {
    const groups = this.groups.get(turnId)
    if (!groups?.size) return
    const signal = (pgid: number, value: NodeJS.Signals) => {
      try {
        process.kill(-pgid, value)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
    for (const pgid of groups) signal(pgid, 'SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 2000))
    for (const pgid of groups) signal(pgid, 'SIGKILL')
    this.groups.delete(turnId)
  }
}
