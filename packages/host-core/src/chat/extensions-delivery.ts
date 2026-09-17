import { EXTENSIONS_CAPABILITY, type Bot } from '@maestrly/host-protocol'
import { HostError } from '../errors.js'
import type { GuestSession } from '../guest/session.js'
import type { BotEvents } from '../bots/events.js'
import type { ExtensionsService } from './extensions-service.js'

/**
 * Delivers a bot's extensions to its guest right before a turn starts — beside the account
 * preparation, before the wire write of `turn.start`. Idempotent per (session, revision): the
 * same configuration is not re-sent for every turn, a new session gets it again.
 *
 * Compatibility is decided against the live session: a guest that never announced the
 * capability receives nothing, and the person is told once per turn why the extensions did
 * not apply, instead of a turn that fails or, worse, quietly runs without them.
 */
export class ExtensionsDelivery {
  private applied = new Map<string, number>()
  constructor(
    private readonly extensions: ExtensionsService,
    private readonly events: BotEvents
  ) {}
  async prepare(bot: Bot, session: GuestSession, turnId: string): Promise<void> {
    if (!session.capabilities.includes(EXTENSIONS_CAPABILITY)) {
      if (this.extensions.hasEnabled(bot.id))
        this.events.record(bot.id, 'diagnostic', 'Extensões não aplicadas: atualize o ambiente deste bot', { turnId, detail: { code: 'EXTENSIONS_UPDATE_REQUIRED' } })
      return
    }
    const payload = await this.extensions.payload(bot.id)
    if (!payload) return
    if (this.applied.get(session.sessionId) === payload.revision) return
    const result = (await session.request('extensions.apply', payload as never, 60_000)) as { applied?: number }
    if (result?.applied !== payload.revision) throw new HostError('EXTENSIONS_UNAVAILABLE', 'O computador do bot não confirmou as extensões')
    this.applied.set(session.sessionId, payload.revision)
  }
  forget(sessionId: string) {
    this.applied.delete(sessionId)
  }
}
