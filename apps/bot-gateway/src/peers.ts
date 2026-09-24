import { createHash, randomUUID } from 'node:crypto'
import {
  FLEET_PEER_BUDGETS,
  type FleetInternalPeerMessageRequest,
  type FleetPeerMessage,
} from '@maestrly/bot-fleet-protocol'
import { GatewayError } from './errors.js'
import type { Lifecycle } from './lifecycle.js'
import type { Store } from './store.js'

export class Peers {
  private readonly delivering = new Set<string>()
  private readonly inFlight = new Map<
    string,
    { hash: string; promise: Promise<{ messageId: string; delivered: boolean }> }
  >()
  constructor(
    readonly store: Store,
    readonly lifecycle: Lifecycle,
    readonly now: () => number = Date.now
  ) {}
  list(from: string) {
    const bot = this.lifecycle.get(from)
    if (!bot) throw new GatewayError('NOT_FOUND', 'Bot not found')
    return {
      peers: bot.talksTo.flatMap((id) => {
        const peer = this.lifecycle.get(id)
        return peer ? [{ botId: id, name: peer.name, role: peer.role, status: peer.status }] : []
      }),
    }
  }
  async send(from: string, request: FleetInternalPeerMessageRequest) {
    const sender = this.lifecycle.get(from)
    const target = this.lifecycle.get(request.to)
    if (!sender || !target || !sender.talksTo.includes(request.to))
      throw new GatewayError('FORBIDDEN', 'Peer is not allowed')
    const scope = 'peer:' + from
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex')
    const prior = this.store.priorIdempotency<{ messageId: string; delivered: boolean }>(
      scope,
      request.idempotencyKey,
      hash
    )
    if (prior) return prior.response
    const key = scope + ':' + request.idempotencyKey
    const existing = this.inFlight.get(key)
    if (existing) {
      if (existing.hash !== hash) throw new GatewayError('CONFLICT', 'Idempotency key used with different request')
      return existing.promise
    }
    const promise = this.sendFresh(from, request, scope, hash)
    this.inFlight.set(key, { hash, promise })
    try {
      return await promise
    } finally {
      this.inFlight.delete(key)
    }
  }
  private async sendFresh(from: string, request: FleetInternalPeerMessageRequest, scope: string, hash: string) {
    const now = this.now()
    if (this.store.countPeerMessages(from, new Date(now - 3600000).toISOString()) >= FLEET_PEER_BUDGETS.messagesPerHour)
      throw new GatewayError('RATE_LIMITED', 'Peer message budget exhausted')
    const since = new Date(now - FLEET_PEER_BUDGETS.pairWindowMinutes * 60000).toISOString()
    const lastOwner = this.store.pairLastOwner(from, request.to)
    const count = this.store.countPairMessages(from, request.to, lastOwner && lastOwner > since ? lastOwner : since)
    const blocked = this.store.pairBlockedUntil(from, request.to)
    if (blocked && blocked > new Date(now).toISOString())
      throw new GatewayError('RATE_LIMITED', 'Peer conversation temporarily blocked')
    if (count >= FLEET_PEER_BUDGETS.pairMessages) {
      this.store.blockPair(
        from,
        request.to,
        new Date(now + FLEET_PEER_BUDGETS.pairBlockedMinutes * 60000).toISOString()
      )
      this.lifecycle.recordActivity(from, 'needs_you', 'Peer conversation needs your attention')
      throw new GatewayError('RATE_LIMITED', 'Peer conversation temporarily blocked')
    }
    const message: FleetPeerMessage = {
      id: randomUUID(),
      at: new Date(now).toISOString(),
      from,
      to: request.to,
      text: request.text,
      delivered: false,
    }
    this.store.insertPeerMessage(message)
    const delivered = await this.deliver(message)
    const response = { messageId: message.id, delivered }
    this.store.saveIdempotency(scope, request.idempotencyKey, hash, response, 201)
    this.lifecycle.onEvent({ type: 'peer.message', at: message.at, message: { ...message, delivered } })
    this.lifecycle.recordActivity(from, 'peer_message')
    return response
  }
  private async deliver(message: FleetPeerMessage): Promise<boolean> {
    const target = this.lifecycle.get(message.to)
    if (target?.lifecycle !== 'running' || !this.lifecycle.statuses.get(message.to)?.ready) return false
    try {
      await this.lifecycle.instanceFor(message.to).postInput({
        source: 'peer',
        peer: { botId: message.from, name: this.lifecycle.get(message.from)?.name ?? message.from },
        text: message.text,
        idempotencyKey: message.id,
      })
      this.store.markPeerDelivered(message.id)
      return true
    } catch {
      return false
    }
  }
  async retry(to?: string) {
    for (const message of this.store.pendingPeers(to)) {
      if (this.delivering.has(message.id)) continue
      this.delivering.add(message.id)
      try {
        if (await this.deliver(message))
          this.lifecycle.onEvent({
            type: 'peer.message',
            at: new Date(this.now()).toISOString(),
            message: { ...message, delivered: true },
          })
      } finally {
        this.delivering.delete(message.id)
      }
    }
  }
}
