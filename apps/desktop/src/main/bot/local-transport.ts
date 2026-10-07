import type { BotClaim, BotCompletion, BotControls, BotEventUpload, BotInventory } from '@maestrly/protocol'
import type { BotLeaseHold, LocalBotService } from './local-service'
import type { BotWorkerClient } from './worker'

/**
 * In-process transport for the conversation worker.
 *
 * It answers the same client contract the relayed transport answered, so the worker keeps its journal,
 * its fencing and its recovery untouched, while no request ever leaves this computer. Commands of other
 * bot connections are not visible here: each worker claims only the work of its own connection.
 */
export class LocalBotTransport implements BotWorkerClient {
  constructor(
    private readonly service: LocalBotService,
    private readonly connectionId: string
  ) {}

  async claim(signal?: AbortSignal): Promise<BotClaim | null> {
    if (signal?.aborted) return null
    return this.service.claim(this.connectionId)
  }

  async lease(claim: BotClaim): Promise<BotControls> {
    return this.service.renewLease(this.hold(claim))
  }

  async controls(claim: BotClaim): Promise<BotControls> {
    return this.service.controls(this.hold(claim))
  }

  async upload(claim: BotClaim, events: BotEventUpload[]): Promise<void> {
    this.service.uploadEvents(this.hold(claim), events)
  }

  async complete(claim: BotClaim, result: BotCompletion): Promise<void> {
    // The outcome carries its own token and fence: a stale holder cannot close someone else's command.
    this.service.complete({
      commandId: claim.command.id,
      leaseToken: result.leaseToken,
      fence: result.fence,
      status: result.status,
      error: result.error ?? null,
    })
  }

  async inventory(value: BotInventory): Promise<void> {
    this.service.saveInventory(this.connectionId, value)
  }

  private hold(claim: BotClaim): BotLeaseHold {
    const leaseToken = claim.command.leaseToken
    if (!leaseToken) throw new Error('The claimed bot command carries no lease token.')
    return { commandId: claim.command.id, leaseToken, fence: claim.fence }
  }
}
