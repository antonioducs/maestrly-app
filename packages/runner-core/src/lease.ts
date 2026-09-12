export interface LeaseRenewal {
  leaseExpiresAt: string
  cancellationRequested: boolean
}

export class LeaseController {
  private timer?: ReturnType<typeof setInterval>
  private stopped = false
  private lastExpiry: number

  constructor(
    expiresAt: string,
    private readonly renew: () => Promise<LeaseRenewal>,
    private readonly onCancellation: (reason: string) => Promise<void>,
    private readonly options = { renewalIntervalMs: 15_000, safetyMarginMs: 10_000 },
  ) {
    this.lastExpiry = Date.parse(expiresAt)
  }

  start(): void {
    if (this.timer || this.stopped) return
    this.timer = setInterval(() => { void this.tick() }, this.options.renewalIntervalMs)
    this.timer.unref?.()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    try {
      const result = await this.renew()
      this.lastExpiry = Date.parse(result.leaseExpiresAt)
      if (result.cancellationRequested) await this.onCancellation('Cancellation requested by the server.')
    } catch {
      if (Date.now() >= this.lastExpiry - this.options.safetyMarginMs) {
        this.stop()
        await this.onCancellation('Runner could not renew the execution lease safely.')
      }
    }
  }
}
