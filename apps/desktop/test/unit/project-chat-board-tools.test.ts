import { z } from 'zod'
import { linkedBoardCatalog } from '../../src/main/platform/board-tool-catalog'
import { linkedBoardToolSchemas } from '@maestrly/protocol'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { freshDb, closeDb } from '../helpers/db'
import { makeWorkspace, makeConversation } from '../helpers/factories'
import { bindChatConversation } from '../../src/main/platform/project-chat-store'
import { registerProjectChatBoardTools, registerProjectChatContext } from '../../src/main/platform/project-chat-context'
import type { McpToolContext } from '../../src/main/mcp/tools/context'
beforeEach(freshDb)
afterEach(() => {
  vi.unstubAllGlobals()
  closeDb()
})
it('never falls back to operator credentials after a remote turn ends', async () => {
  const conv = makeConversation(makeWorkspace().id),
    callbacks = new Map<string, (input: unknown, extra: unknown) => Promise<any>>()
  bindChatConversation('instance', 'session', conv.id)
  const ctx = {
    convId: conv.id,
    server: { registerTool: (name: string, _schema: unknown, fn: any) => callbacks.set(name, fn) },
  } as unknown as McpToolContext
  expect(registerProjectChatBoardTools(ctx)).toBe(true)
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ items: [] })))
  vi.stubGlobal('fetch', fetch)
  expect((await callbacks.get('board_search_cards')!({}, {})).isError).toBe(true)
  expect(fetch).not.toHaveBeenCalled()
  const release = registerProjectChatContext(conv.id, {
    url: 'https://fixture.test',
    organizationId: 'org',
    projectId: 'project',
    sessionId: 'session',
    turnId: 'turn',
    token: 'scoped-token',
  })
  await callbacks.get('board_search_cards')!({ done: true }, { requestId: 'tool-call' })
  expect(fetch.mock.calls[0]?.[1]).toMatchObject({
    headers: expect.objectContaining({ authorization: 'Chat scoped-token' }),
  })
  release()
  expect((await callbacks.get('board_search_cards')!({}, {})).isError).toBe(true)
})

it('registers the shared catalog with matching schemas and scoped credentials', async () => {
  const conv = makeConversation(makeWorkspace().id)
  bindChatConversation('instance', 'session', conv.id)
  const registered = new Map<string, any>()
  registerProjectChatBoardTools({
    convId: conv.id,
    server: {
      registerTool: (name: string, definition: any, callback: any) => registered.set(name, { definition, callback }),
    },
  } as unknown as McpToolContext)
  expect([...registered.keys()]).toEqual(Object.keys(linkedBoardToolSchemas))
  for (const tool of linkedBoardCatalog) {
    const { definition } = registered.get(tool.name)
    expect(definition.inputSchema).toBe(tool.schema.shape)
    expect(definition.annotations).toEqual({ readOnlyHint: tool.readOnly, destructiveHint: !tool.readOnly })
    if (!tool.readOnly) {
      const key = definition.inputSchema.idempotencyKey
      expect(key.safeParse('stable-change_123').success).toBe(true)
      for (const value of [undefined, '', 'short', 'has spaces', 'x'.repeat(129)]) {
        expect(key.safeParse(value).success).toBe(false)
      }
    }
  }
  const create = registered.get('board_create_card')
  const card = { boardId: crypto.randomUUID(), title: 'Authorized card', idempotencyKey: 'stable-change_123' }
  expect(z.object(create.definition.inputSchema).safeParse(card).success).toBe(true)
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ id: 'created' })))
  vi.stubGlobal('fetch', fetch)
  const release = registerProjectChatContext(conv.id, {
    url: 'https://fixture.test',
    organizationId: 'org',
    projectId: 'project',
    sessionId: 'session',
    turnId: 'turn',
    token: 'scoped-token',
  })
  try {
    await create.callback(card, { requestId: 'first' })
    await create.callback(card, { requestId: 'retry' })
    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init!.body as string))
    expect(bodies).toEqual(
      [1, 2].map(() => ({
        name: 'board_create_card',
        input: {
          boardId: card.boardId,
          title: card.title,
        },
        callId: card.idempotencyKey,
      }))
    )
    expect(fetch.mock.calls[0]?.[0]).toBe('https://fixture.test/api/v1/runners/chat/tools')
    expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: 'Chat scoped-token',
      'x-maestrly-organization-id': 'org',
    })
    await create.callback({ boardId: card.boardId, title: card.title }, { requestId: 'legacy' })
    expect(JSON.parse(fetch.mock.calls[2]![1]!.body as string).callId).toBe('turn:legacy:board_create_card')
  } finally {
    release()
  }
  expect((await create.callback(card, {})).isError).toBe(true)
  expect(fetch).toHaveBeenCalledTimes(3)
  const ended = vi.fn()
  expect(
    registerProjectChatBoardTools({ convId: conv.id, server: { registerTool: ended } } as unknown as McpToolContext)
  ).toBe(true)
  expect(ended).toHaveBeenCalledTimes(linkedBoardCatalog.length)
})
