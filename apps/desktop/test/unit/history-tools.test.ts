import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { closeDb, freshDb } from '../helpers/db'
import { makeConversation, makeWorkspace } from '../helpers/factories'
import { searchConversationHistory, upsertChatMessage } from '../../src/main/chat/chat-store'
import { registerHistoryTools, renderHistoryWindow } from '../../src/main/mcp/tools/history'
import type { McpToolContext } from '../../src/main/mcp/tools/context'

beforeEach(freshDb)
afterEach(closeDb)

function say(conversationId: string, role: 'user' | 'assistant', text: string, extra: object[] = []) {
  upsertChatMessage({
    id: randomUUID(),
    conversationId,
    role,
    createdAt: Date.now(),
    parts: [{ type: 'text', id: randomUUID(), text }, ...(extra as never[])],
  })
}

describe('history tools', () => {
  it('finds every term across accents, newest first, only in this conversation', () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    const other = makeConversation(workspace.id)
    say(conversation.id, 'user', 'Compactação do bot às 09:00')
    say(conversation.id, 'assistant', 'Feito: compactacao concluída para o bot')
    say(conversation.id, 'user', 'nada a ver')
    say(other.id, 'user', 'compactação do bot em outra conversa')
    const hits = searchConversationHistory(conversation.id, 'compactação bot')
    expect(hits.map((hit) => hit.role)).toEqual(['assistant', 'user'])
    expect(hits[0].seq).toBeGreaterThan(hits[1].seq)
    expect(hits[0].snippet.length).toBeLessThanOrEqual(240)
  })

  it('renders a bounded window with tool outputs cut and memory blocks omitted', async () => {
    const workspace = makeWorkspace()
    const conversation = makeConversation(workspace.id)
    say(conversation.id, 'user', 'first')
    say(conversation.id, 'assistant', 'ran it', [
      {
        type: 'tool',
        id: 't1',
        toolCallId: 't1',
        toolName: 'terminal_run',
        input: {},
        state: { status: 'completed', output: 'x'.repeat(2_000) },
      },
    ])
    say(conversation.id, 'user', 'third', [
      {
        type: 'file',
        id: 'f1',
        name: 'maestrly-memory-recall',
        mediaType: 'text/markdown',
        kind: 'text',
        data: 'SECRET-RECALL',
        hidden: true,
      },
    ])
    const [middle] = searchConversationHistory(conversation.id, 'ran it')
    const text = renderHistoryWindow(conversation.id, middle.seq, 1, 1)
    expect(text).toContain('first')
    expect(text).toContain('[tool terminal_run · completed: ')
    expect(text).not.toContain('x'.repeat(700))
    expect(text).toContain('third')
    expect(text).not.toContain('SECRET-RECALL')
    const handlers = new Map<string, (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }>>()
    registerHistoryTools({
      convId: conversation.id,
      locale: 'en',
      t: (key: string) => key,
      server: { registerTool: (name: string, _s: unknown, handler: never) => handlers.set(name, handler) },
    } as unknown as McpToolContext)
    const out = JSON.parse((await handlers.get('history_search')!({ query: 'first' })).content[0].text)
    expect(out.results[0]).toMatchObject({ role: 'user', snippet: 'first' })
  })
})

it('counts separators and truncation markers within the history output budget', () => {
  const conversation = makeConversation(makeWorkspace().id)
  say(conversation.id, 'user', 'anchor ' + 'x'.repeat(11_948))
  say(conversation.id, 'assistant', 'y'.repeat(100))
  const [hit] = searchConversationHistory(conversation.id, 'anchor')
  expect(renderHistoryWindow(conversation.id, hit.seq, 0, 1).length).toBeLessThanOrEqual(12_000)
})

it('keeps the beginning of an oversized requested message', () => {
  const conversation = makeConversation(makeWorkspace().id)
  say(conversation.id, 'user', 'target beginning ' + 'x'.repeat(20_000))
  const [hit] = searchConversationHistory(conversation.id, 'target')
  const text = renderHistoryWindow(conversation.id, hit.seq, 0, 0)
  expect(text).toContain('target beginning ' + 'x'.repeat(100))
  expect(text).toContain('truncated')
  expect(text.length).toBeLessThanOrEqual(12_000)
})

it('omits oversized neighbours without hiding the target or closer neighbours', () => {
  const conversation = makeConversation(makeWorkspace().id)
  say(conversation.id, 'assistant', 'older neighbour')
  say(conversation.id, 'user', 'huge preceding ' + 'x'.repeat(20_000))
  say(conversation.id, 'assistant', 'requested target')
  say(conversation.id, 'user', 'next neighbour')
  const [hit] = searchConversationHistory(conversation.id, 'requested')
  const text = renderHistoryWindow(conversation.id, hit.seq, 2, 1)
  expect(text).toContain('requested target')
  expect(text).toContain('next neighbour')
  expect(text).toContain('older neighbour')
  expect(text.indexOf('older neighbour')).toBeLessThan(text.indexOf('requested target'))
  expect(text.indexOf('requested target')).toBeLessThan(text.indexOf('next neighbour'))
  expect(text).toContain('truncated')
  expect(text.length).toBeLessThanOrEqual(12_000)
})
