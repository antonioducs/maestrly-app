import { createHash, randomBytes } from 'node:crypto'
import { DESKTOP_LIMITS } from '@maestrly/host-protocol'

export type MediaGrant = {
  viewId: string
  botId: string
  sessionId: string
  sessionGeneration: number
  grantId: string
  hostGeneration: number
  expiresAt: number
}
const hash = (ticket: string) => createHash('sha256').update(ticket).digest('hex')
/**
 * Single-use media tickets: 256 random bits, 30 seconds, memory only. Only a hash is
 * kept, so the ticket cannot be read back from Host memory or logs.
 */
export class MediaTickets {
  private tickets = new Map<string, MediaGrant>()
  constructor(private readonly clock: () => number = () => performance.now()) {}
  issue(grant: Omit<MediaGrant, 'expiresAt'>) {
    this.sweep()
    const ticket = randomBytes(32).toString('hex')
    const expiresAt = this.clock() + DESKTOP_LIMITS.ticketMs
    this.tickets.set(hash(ticket), { ...grant, expiresAt })
    return { ticket, expiresAt: new Date(Date.now() + DESKTOP_LIMITS.ticketMs).toISOString() }
  }
  consume(ticket: string): MediaGrant | undefined {
    if (!/^[a-f0-9]{64}$/.test(ticket)) return undefined
    const key = hash(ticket)
    const grant = this.tickets.get(key)
    this.tickets.delete(key)
    return grant && grant.expiresAt > this.clock() ? grant : undefined
  }
  revokeView(viewId: string) {
    for (const [key, grant] of this.tickets) if (grant.viewId === viewId) this.tickets.delete(key)
  }
  sweep() {
    const now = this.clock()
    for (const [key, grant] of this.tickets) if (grant.expiresAt <= now) this.tickets.delete(key)
  }
  get size() {
    return this.tickets.size
  }
}
