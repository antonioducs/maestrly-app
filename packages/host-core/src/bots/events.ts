import { EVENTS_PAGE_BUDGET, type BotEvent } from '@maestrly/host-protocol'
import { type BotRepository, now } from './repository.js'

/** Sequenced, deduplicated bot event log with byte-budgeted pages for the 1 MiB wire. */
export class BotEvents {
  constructor(private readonly repo: BotRepository) {}
  record(
    botId: string,
    kind: BotEvent['kind'],
    summary: string,
    extra: Partial<Pick<BotEvent, 'conversationId' | 'turnId' | 'detail' | 'runtimeEventId' | 'generation'>> = {}
  ): BotEvent | undefined {
    return this.repo.appendEvent({
      botId,
      kind,
      summary: summary.slice(0, 400),
      ...extra,
      ...(extra.detail ? { detail: boundDetail(extra.detail) } : {}),
      createdAt: now(),
    })
  }
  page(botId: string, after: number, limit: number) {
    const { events, hasMore } = this.repo.events(botId, after, limit, EVENTS_PAGE_BUDGET)
    return { events, cursor: events.at(-1)?.seq ?? after, hasMore }
  }
}
/** One oversized event must never break the stream: detail is bounded, content stays retrievable by reference. */
export function boundDetail(detail: Record<string, unknown>, maxBytes = 32 * 1024): Record<string, unknown> {
  const text = JSON.stringify(detail)
  if (Buffer.byteLength(text) <= maxBytes) return detail
  const bounded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (typeof value === 'string' && Buffer.byteLength(value) > 4096) bounded[key] = `${value.slice(0, 4096)}… [truncated ${Buffer.byteLength(value)} bytes; full content available by reference]`
    else bounded[key] = value
  }
  const retry = JSON.stringify(bounded)
  return Buffer.byteLength(retry) <= maxBytes ? bounded : { truncated: true, keys: Object.keys(detail).slice(0, 32) }
}
