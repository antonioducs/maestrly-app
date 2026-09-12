import { expect, it, vi } from 'vitest'
import { HttpTransport } from '../src/transport.js'
import { applyProjectChatEvent, ProjectChatClient, readProjectChatEvents } from '../src/project-chat.js'
import type { ProjectChatSnapshot, ProjectChatEvent } from '@maestrly/protocol'
it('binds the browser fetch receiver when using the default transport', async () => {
  vi.stubGlobal('fetch', function(this:unknown) { expect(this).toBe(globalThis); return Promise.resolve(new Response('{"ok":true}')) })
  try { expect(await new HttpTransport({baseUrl:'https://fixture.test'}).request('GET','/test')).toEqual({ok:true}) }
  finally { vi.unstubAllGlobals() }
})
it('deduplicates deltas, detects gaps and isolates sessions', () => {
  const sessionId = crypto.randomUUID(),
    messageId = crypto.randomUUID()
  const state = {
    session: { id: sessionId },
    cursor: 0,
    messages: [{ id: messageId, parts: [] }],
    interactions: [],
    turn: null,
  } as unknown as ProjectChatSnapshot
  const event = {
    version: 1,
    sessionId,
    sequence: 1,
    eventId: 'one',
    payload: { type: 'delta', messageId, partId: 'text', kind: 'text', delta: 'Olá' },
  } as ProjectChatEvent
  const next = applyProjectChatEvent(state, event)
  expect(applyProjectChatEvent(next, event)).toBe(next)
  expect(next.messages[0].parts[0]).toMatchObject({ text: 'Olá' })
  expect(applyProjectChatEvent(next, { ...event, sessionId: crypto.randomUUID() })).toBe(next)
  expect(() => applyProjectChatEvent(next, { ...event, sequence: 3 })).toThrow(/gap/)
})
it('decodes UTF-8 split across network chunks and CRLF SSE frames', async () => {
  const event = {
    version: 1,
    sessionId: crypto.randomUUID(),
    sequence: 1,
    eventId: 'one',
    payload: { type: 'delta', messageId: crypto.randomUUID(), partId: 'text', kind: 'text', delta: 'Olá 🚀' },
  }
  const bytes = new TextEncoder().encode(': ready\r\n\r\ndata: ' + JSON.stringify(event) + '\r\n\r\n')
  const stream = new ReadableStream({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]))
      c.close()
    },
  })
  const received = []
  for await (const value of readProjectChatEvents(new Response(stream))) received.push(value)
  expect(received).toEqual([event])
})

it('updates all conversation settings atomically with optimistic versioning', async () => {
  const request = vi.fn(async () => ({ id: 'session' }))
  const chat = new ProjectChatClient({ request } as never, 'organization', 'project')
  const body = {
    expectedVersion: 4,
    model: 'codex-work',
    mode: 'design' as const,
    reasoning: 'high',
    fastMode: true,
    permMode: 'full' as const,
  }
  await chat.update('session', body, 'settings-4')
  expect(request).toHaveBeenCalledWith(
    'PATCH',
    '/api/v1/organizations/organization/projects/project/chat/sessions/session',
    { body, idempotencyKey: 'settings-4' }
  )
})
