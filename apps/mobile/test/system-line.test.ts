import { describe, expect, it } from 'vitest'
import { translate } from '../src/i18n/translate'
import { systemLineText } from '../src/ui/conversation/system-line'

const AT = '2026-10-18T10:00:00.000Z'
const t = (key: Parameters<typeof translate>[0], values?: Parameters<typeof translate>[2]) =>
  translate(key, 'en', values)

describe('system lines', () => {
  it('tells a message to another bot from one that opened a conversation with it', () => {
    const sent = {
      kind: 'peer_out' as const,
      id: 'p1',
      at: AT,
      to: { botId: 'nina', name: 'Nina' },
      text: 'Hi',
      delivered: true,
    }
    expect(systemLineText(sent, t)).toEqual({ text: 'Sent to Nina', detail: 'Hi' })
    // The conversation it opened goes on apart; where the phone can open it, a card leads there instead of this line.
    expect(systemLineText({ ...sent, thread: { id: 'thread-1' } }, t)).toEqual({
      text: 'Opened a conversation with Nina, apart from this one.',
      detail: 'Hi',
    })
  })

  it('names compactions and system events', () => {
    expect(systemLineText({ kind: 'compaction', id: 'c1', at: AT } as never, t)).toEqual({
      text: 'Conversation compacted',
      detail: null,
    })
    expect(systemLineText({ kind: 'system', id: 's1', at: AT, code: 'paused' } as never, t)).toEqual({
      text: 'Paused',
      detail: null,
    })
  })
})
