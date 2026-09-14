import type { BotEvent, BotResult } from '@maestrly/host-protocol'

export type BotEventState = { events: BotEvent[]; cursor: number }
export function mergeBotEvents(previous: BotEventState, page: BotResult<'bot.events.list'>): BotEventState {
  const bySequence = new Map(previous.events.map((event) => [event.seq, event]))
  for (const event of page.events) bySequence.set(event.seq, event)
  const events = [...bySequence.values()].sort((a, b) => a.seq - b.seq).slice(-500)
  return {
    events,
    cursor: Math.max(previous.cursor, page.cursor, ...events.map((event) => event.seq)),
  }
}
