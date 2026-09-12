import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { searchChatMessages, upsertChatMessage } from '../../src/main/chat/chat-store'
import type { MessagePart } from '../../src/shared/chat'

beforeEach(freshDb)
afterEach(closeDb)

function chatConv() {
  const ws = makeWorkspace()
  return makeConversation(ws.id, { mode: 'local' })
}

function add(
  conversationId: string,
  id: string,
  parts: MessagePart[],
  role: 'user' | 'assistant' = 'user',
  internal = false
) {
  upsertChatMessage({
    id,
    conversationId,
    role,
    parts,
    ...(internal ? { internal: true } : {}),
    createdAt: 1000 + Number(id.replace(/\D/g, '') || 0),
  })
}

describe('searchChatMessages (chat search, #559)', () => {
  it('returns text matches in sequence order', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'falando sobre banana madura' }])
    add(conv.id, 'm1', [{ type: 'text', id: 't1', text: 'nothing here' }])
    add(conv.id, 'm2', [{ type: 'text', id: 't2', text: 'other BANANA verde' }])
    const hits = searchChatMessages(conv.id, 'banana')
    expect(hits.map((h) => h.messageId)).toEqual(['m0', 'm2'])
    expect(hits[0].seq).toBeLessThan(hits[1].seq)
  })

  it('matches case-insensitively', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'Texto com MaIúScUlA' }])
    expect(searchChatMessages(conv.id, 'maiúscula')).toHaveLength(1)
  })

  it('returns no hits for blank queries', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'anything' }])
    expect(searchChatMessages(conv.id, '')).toEqual([])
    expect(searchChatMessages(conv.id, '   ')).toEqual([])
  })

  it('hides internal messages from history', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'secret operational handoff' }], 'user', true)
    add(conv.id, 'm1', [{ type: 'text', id: 't1', text: 'visible handoff response' }])

    expect(searchChatMessages(conv.id, 'operacional')).toEqual([])
    expect(searchChatMessages(conv.id, 'visible').map((h) => h.messageId)).toEqual(['m1'])
  })

  it('searches only visible text without structural IDs or base64', () => {
    const conv = chatConv()
    // The term exists only in part IDs and base64, not visible text.
    add(conv.id, 'm0', [
      { type: 'text', id: 'secret-t0', text: 'ordinary message' },
      {
        type: 'file',
        id: 'f0',
        name: 'foto.png',
        mediaType: 'image/png',
        kind: 'image',
        data: 'data:image/png;base64,SEGREDOdados==',
      },
    ])
    expect(searchChatMessages(conv.id, 'secret')).toEqual([])
    // Visible attachment names remain searchable.
    expect(searchChatMessages(conv.id, 'foto.png').map((h) => h.messageId)).toEqual(['m0'])
  })

  it('treats percent and underscore as literal search characters', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'progress 50% complete' }])
    add(conv.id, 'm1', [{ type: 'text', id: 't1', text: 'fifty percent' }])
    // Percent signs match literally instead of acting as SQL wildcards.
    expect(searchChatMessages(conv.id, '50%').map((h) => h.messageId)).toEqual(['m0'])
  })

  it('builds snippets around matches', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'text', id: 't0', text: 'a'.repeat(80) + 'TARGET' + 'b'.repeat(80) }])
    const [hit] = searchChatMessages(conv.id, 'target')
    expect(hit.snippet).toContain('TARGET')
    expect(hit.snippet.startsWith('…')).toBe(true)
    expect(hit.snippet.endsWith('…')).toBe(true)
  })

  it('searches visible reasoning, compaction and context text', () => {
    const conv = chatConv()
    add(conv.id, 'm0', [{ type: 'reasoning', id: 'r0', text: 'thinking about the GUESS' }], 'assistant')
    expect(searchChatMessages(conv.id, 'guess').map((h) => h.messageId)).toEqual(['m0'])
  })
})
