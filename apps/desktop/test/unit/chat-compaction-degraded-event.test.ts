import { describe, expect, it } from 'vitest'
import { applyChatEvent, type ChatMessage } from '../../src/shared/chat'
import { parseParts } from '../../src/main/chat/message'

describe('degraded compaction marker', () => {
  const assistant: ChatMessage = {
    id: 'a',
    conversationId: 'c',
    role: 'assistant',
    createdAt: 0,
    parts: [{ type: 'text', id: 't', text: 'Done.' }],
  }

  it('keeps the flag from the live event in the rendered part', () => {
    const [message] = applyChatEvent([assistant], {
      kind: 'compaction',
      messageId: 'a',
      afterPartId: 't',
      partId: 'k',
      text: 'Digest',
      strategy: 'summary',
      degraded: true,
    })
    expect(message.parts.at(-1)).toMatchObject({ type: 'compaction', id: 'k', degraded: true })
  })

  it('survives persistence, and older markers stay valid without it', () => {
    const [stored] = parseParts(
      JSON.stringify([{ type: 'compaction', id: 'k', text: 'Digest', strategy: 'summary', degraded: true }])
    )
    expect(stored).toMatchObject({ type: 'compaction', degraded: true })
    expect(parseParts(JSON.stringify([{ type: 'compaction', id: 'k', text: 'Summary' }]))[0]).not.toHaveProperty(
      'degraded'
    )
  })
})
